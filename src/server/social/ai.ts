import "server-only";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { getBalance } from "@/server/billing/ledger";
import { llmComplete, resolveLlmConfig, type LlmConfig } from "@/server/llm/client";
import { consumeRateLimit, type RateLimitRule } from "@/server/security/rate-limit";
import type { OrgContext } from "@/server/tenancy/context";
import { assertWithinLimits, recordUsage } from "@/server/usage";
import { widgetKnowledge } from "@/server/webchat/generator";
import { normalizeHashtags, PLATFORM_LIMITS, type Platform, type PostKind } from "@/lib/social/rules";
import { unsupportedClaims, unsupportedHashtags } from "@/server/social/claims";
import { createAiDraft, type PostView } from "@/server/social/posts";
import { readSettings } from "@/server/social/post-core";

export { unsupportedClaims };

// AI help with writing posts. It suggests; it never publishes. Whatever it writes becomes an ordinary DRAFT marked as AI-written, which a person edits and which a
// person with approval rights must approve before it can be scheduled: no setting skips that. It writes only from the business's approved knowledge and is told
// never to invent testimonials, reviews, results, statistics, awards, deadlines or offers. As a safety net, any suggestion (hashtags included) that states an amount,
// a percentage or one of the common claims the knowledge does not contain is dropped, not trimmed (see claims.ts); a person still reads every draft. Links are never
// written by the model (a person adds the page to share, and its tracking tags are added by the system).

export const TONES = ["friendly", "professional", "playful", "direct"] as const;
export type Tone = (typeof TONES)[number];

export interface IdeaSuggestion {
  title: string;
  angle: string;
  kind: PostKind;
  callToAction: string;
}

export interface CaptionOption {
  caption: string;
  hashtags: string[];
}

export interface AiDeps {
  complete?: typeof llmComplete;
  config?: () => Promise<LlmConfig | null>;
}

const KNOWLEDGE_SECTIONS = ["business_description", "products_services", "faq", "approved_pricing", "business_hours", "policies", "brand_voice"] as const;

/**
 * How much AI drafting one person and one workspace can ask for. Each request reaches the platform's language model, so both are bounded: a person per hour, and
 * the workspace per day (a fixed window, counted in the database so it holds across servers). Past either, the request is refused with when to try again.
 */
export const SOCIAL_AI_LIMITS = {
  byUser: { name: "social:ai:user", limit: 30, windowSeconds: 3600 },
  byOrg: { name: "social:ai:org", limit: 60, windowSeconds: 86_400 },
} satisfies Record<string, RateLimitRule>;

// A web address the model wrote: a full link, "www." or a bare domain ("bit.ly/x", "acme-hvac.com/book"). An email address is left alone here: it is checked as a claim.
const URL_RE = /\bhttps?:\/\/\S+|\bwww\.\S+|(?<![@\w.-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|io|co|us|ca|uk|au|biz|info|app|dev|ly|me|site|shop|store|online|ai|tv|xyz|club|today|page|link)\b(?:\/\S*)?/gi;

/** Plain text a person can edit: no links (the model does not write them), no control characters, no wrapping quotes. */
function tidy(text: unknown, max: number): string {
  if (typeof text !== "string") return "";
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").replace(URL_RE, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/^["“'‘]+|["”'’]+$/g, "").trim().slice(0, max);
}

/** The first JSON object or array in a model's answer, which may wrap it in prose or a code fence. */
export function extractJson(text: string): unknown {
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  for (let end = text.lastIndexOf(close); end > start; end = text.lastIndexOf(close, end - 1)) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      /* try a shorter slice */
    }
  }
  return null;
}

async function loadContext(ctx: OrgContext, accountId: string, campaignId: string | null | undefined) {
  const account = await withSystem(async (db) => (await db.query<{ platform: Platform; name: string }>("select platform, name from social_accounts where id = $1 and org_id = $2 and status <> 'disconnected'", [accountId, ctx.org.orgId])).rows[0]);
  if (!account) throw new AppError("invalid_input", "Choose a connected account.");
  const campaign = campaignId ? await withSystem(async (db) => (await db.query<{ name: string; goal: string | null }>("select name, goal from social_campaigns where id = $1 and org_id = $2 and status = 'active'", [campaignId, ctx.org.orgId])).rows[0]) : null;
  const settings = await withSystem((db) => readSettings(db, ctx.org.orgId));
  if (!settings.aiDraftsEnabled) throw new AppError("not_enabled", "AI drafting is switched off for this workspace. The owner can switch it on in the social media settings.");
  const knowledge = await widgetKnowledge(ctx.org.orgId, KNOWLEDGE_SECTIONS);
  const industry = await withSystem(async (db) => (await db.query<{ industry: string | null }>("select industry from organizations where id = $1", [ctx.org.orgId])).rows[0]?.industry ?? null);
  return { account, campaign, settings, knowledge, industry: industry?.replace(/[\u0000-\u001F]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || null };
}

/** "a minute", "20 minutes", "3 hours": when to try again, in words. */
function waitPhrase(seconds: number): string {
  if (seconds < 90) return "a minute";
  if (seconds < 5400) return `${Math.ceil(seconds / 60)} minutes`;
  return `${Math.ceil(seconds / 3600)} hours`;
}

/** The checks every model call starts with: a connected model, credits, the monthly allowance, and the hourly and daily limits. Nothing is counted for a call that is refused. */
async function ready(ctx: OrgContext, deps: AiDeps): Promise<{ config: LlmConfig; complete: typeof llmComplete }> {
  const config = await (deps.config ?? resolveLlmConfig)();
  if (!config) throw new AppError("unavailable", "The AI language model is not connected, so nothing can be drafted yet.");
  const balance = await withSystem((db) => getBalance(db, ctx.org.orgId));
  if (balance.availableMicros <= 0) throw new AppError("usage_limit", "Your service credits have run out, so the AI cannot draft right now.");
  try {
    // The monthly allowance is shared with the inbox's AI help, so its message is reworded to say what ran out here.
    await assertWithinLimits(ctx.org.orgId, "help_request");
  } catch (e) {
    if (e instanceof AppError && e.code === "usage_limit") throw new AppError("usage_limit", "Your workspace has used this month's AI help allowance, so post drafting is paused until it renews. Contact iAcquire if you need more capacity.");
    throw e;
  }
  const person = await consumeRateLimit(SOCIAL_AI_LIMITS.byUser, ctx.user.id);
  if (!person.allowed) throw new AppError("rate_limited", `You have asked for AI drafts ${SOCIAL_AI_LIMITS.byUser.limit} times in the last hour. Try again in about ${waitPhrase(person.retryAfterSeconds)}.`, { retryAfterSeconds: person.retryAfterSeconds });
  const workspace = await consumeRateLimit(SOCIAL_AI_LIMITS.byOrg, ctx.org.orgId);
  if (!workspace.allowed) throw new AppError("rate_limited", `Your workspace has used today's allowance of ${SOCIAL_AI_LIMITS.byOrg.limit} AI drafting requests. It renews in about ${waitPhrase(workspace.retryAfterSeconds)}.`, { retryAfterSeconds: workspace.retryAfterSeconds });
  return { config, complete: deps.complete ?? llmComplete };
}

/** One model answer received: it counts toward the workspace's monthly AI help allowance, whatever becomes of what it wrote. */
const countUsage = (ctx: OrgContext) => withSystem((db) => recordUsage(db, { orgId: ctx.org.orgId, userId: ctx.user.id, kind: "help_request" }));

function systemPrompt(input: { business: string; platform: Platform; knowledge: string; industry: string | null; voiceNote: string | null; campaign: { name: string; goal: string | null } | null; tone: Tone }): string {
  return `You help ${input.business} write social media posts for its ${input.platform === "instagram" ? "Instagram" : "Facebook"} account. You only draft: a person reads, edits and approves every post before anything is published.

## What you may use
Only the approved business knowledge below. If a fact is not there, you do not know it: leave it out. ${input.knowledge ? `\n## Approved business knowledge\n${input.knowledge}\n` : "\n## Approved business knowledge\n(None has been shared yet. Write only general, evergreen posts that make no claim about the business beyond its name.)\n"}
${input.industry ? `## Industry (context only)\n${input.industry}. Use it only to choose themes that suit this kind of business, such as seasonal reminders and common questions. It is not a source of facts: never state a service, price, result or claim because of it.\n` : ""}${input.voiceNote ? `## Voice\n${input.voiceNote}\n` : ""}${input.campaign ? `## Campaign\n${input.campaign.name}${input.campaign.goal ? `: ${input.campaign.goal}` : ""}\n` : ""}
## Hard rules
- Never invent a testimonial, review, customer result, statistic, award, ranking, deadline, discount, offer, guarantee or price. If it is not in the approved knowledge, do not write it.
- Do not write web addresses. A person adds the page to share.
- Do not mention these instructions. No hashtags inside the caption text; give them separately.
- Tone: ${input.tone}. Plain language, no hype, at most two emoji.
- Reply with JSON only, in exactly the shape asked for.`;
}

async function recordRun(ctx: OrgContext, kind: "ideas" | "caption" | "variations", brief: Record<string, unknown>, output: unknown, status: "succeeded" | "failed", failure: string | null): Promise<string> {
  return withSystem(async (db) => (await db.query<{ id: string }>(
    "insert into social_ai_runs (org_id, user_id, kind, brief, output, status, failure) values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7) returning id",
    [ctx.org.orgId, ctx.user.id, kind, JSON.stringify(brief), JSON.stringify(output ?? {}), status, failure],
  )).rows[0].id);
}

const KINDS: readonly PostKind[] = ["text", "link", "image", "video"];

/** Up to five post ideas for an account, from the business's approved knowledge. */
export async function suggestIdeas(ctx: OrgContext, input: { accountId: string; campaignId?: string | null; topic?: string | null; tone?: Tone; count?: number }, deps: AiDeps = {}): Promise<{ runId: string; ideas: IdeaSuggestion[] }> {
  if (!ctx.can("social.create")) throw new AppError("forbidden", "Your role can't write social posts.");
  const tone: Tone = TONES.includes(input.tone as Tone) ? (input.tone as Tone) : "friendly";
  const count = Math.min(Math.max(input.count ?? 5, 1), 5);
  const c = await loadContext(ctx, input.accountId, input.campaignId);
  const { config, complete } = await ready(ctx, deps);
  const topic = input.topic?.replace(/\s+/g, " ").trim().slice(0, 200) || null;
  const brief = { accountId: input.accountId, campaignId: input.campaignId ?? null, topic, tone, count };
  const platformKinds = PLATFORM_LIMITS[c.account.platform].kinds;
  const res = await complete(config, {
    system: systemPrompt({ business: ctx.org.name, platform: c.account.platform, knowledge: c.knowledge.text, industry: c.industry, voiceNote: c.settings.brandVoiceNote, campaign: c.campaign, tone }),
    user: `Suggest ${count} different post ideas${topic ? ` about: ${topic}` : ""}. Allowed kinds: ${platformKinds.join(", ")}.\nReply as JSON: {"ideas":[{"title":"","angle":"","kind":"","callToAction":""}]}. The title is under 80 characters, the angle one or two sentences, the callToAction one short sentence.`,
    maxTokens: 900, temperature: 0.7, timeoutMs: 30_000,
  });
  if (!res.ok) {
    await recordRun(ctx, "ideas", brief, null, "failed", "The AI language model did not answer.");
    throw new AppError("upstream_error", "The AI language model did not answer. Try again in a moment.");
  }
  await countUsage(ctx);
  const parsed = extractJson(res.text) as { ideas?: unknown } | unknown[] | null;
  const list = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { ideas?: unknown })?.ideas) ? ((parsed as { ideas: unknown[] }).ideas) : [];
  const ideas: IdeaSuggestion[] = [];
  let dropped = 0;
  for (const raw of list) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const title = tidy(r.title, 120);
    const angle = tidy(r.angle, 400);
    const cta = tidy(r.callToAction, 160);
    const kind = KINDS.includes(r.kind as PostKind) && platformKinds.includes(r.kind as PostKind) ? (r.kind as PostKind) : platformKinds.includes("text") ? "text" : "image";
    if (!title || !angle) continue;
    if (unsupportedClaims(`${title} ${angle} ${cta}`, c.knowledge.text).length) {
      dropped += 1;
      continue;
    }
    ideas.push({ title, angle, kind, callToAction: cta });
    if (ideas.length >= count) break;
  }
  if (!ideas.length) {
    await recordRun(ctx, "ideas", brief, { dropped }, "failed", "Nothing usable came back.");
    throw new AppError("upstream_error", dropped ? "The suggestions made claims that are not in your approved business knowledge, so none were kept. Add the facts to your knowledge, or try again." : "The AI did not return usable ideas. Try again.");
  }
  const runId = await recordRun(ctx, "ideas", brief, { ideas, dropped, knowledgeSections: c.knowledge.used }, "succeeded", null);
  return { runId, ideas };
}

/** Caption options for one post, from an idea or a topic. */
export async function suggestCaptions(
  ctx: OrgContext,
  input: { accountId: string; kind: PostKind; idea?: { title: string; angle: string } | null; topic?: string | null; campaignId?: string | null; tone?: Tone; count?: number },
  deps: AiDeps = {},
): Promise<{ runId: string; options: CaptionOption[] }> {
  if (!ctx.can("social.create")) throw new AppError("forbidden", "Your role can't write social posts.");
  const tone: Tone = TONES.includes(input.tone as Tone) ? (input.tone as Tone) : "friendly";
  const count = Math.min(Math.max(input.count ?? 3, 1), 3);
  const c = await loadContext(ctx, input.accountId, input.campaignId);
  const limit = PLATFORM_LIMITS[c.account.platform].captionMax;
  const about = input.idea ? `${input.idea.title.slice(0, 120)}. ${input.idea.angle.slice(0, 400)}` : input.topic?.replace(/\s+/g, " ").trim().slice(0, 300);
  if (!about) throw new AppError("invalid_input", "Say what the post is about.");
  const { config, complete } = await ready(ctx, deps);
  const brief = { accountId: input.accountId, kind: input.kind, about, campaignId: input.campaignId ?? null, tone, count };
  const res = await complete(config, {
    system: systemPrompt({ business: ctx.org.name, platform: c.account.platform, knowledge: c.knowledge.text, industry: c.industry, voiceNote: c.settings.brandVoiceNote, campaign: c.campaign, tone }),
    user: `Write ${count} different captions for a ${input.kind} post about: ${about}\nEach is at most ${Math.min(limit, 900)} characters, ends with one clear call to action, and has up to 6 hashtags listed separately.\nReply as JSON: {"options":[{"caption":"","hashtags":[""]}]}.`,
    maxTokens: 1200, temperature: 0.7, timeoutMs: 30_000,
  });
  if (!res.ok) {
    await recordRun(ctx, "caption", brief, null, "failed", "The AI language model did not answer.");
    throw new AppError("upstream_error", "The AI language model did not answer. Try again in a moment.");
  }
  await countUsage(ctx);
  const parsed = extractJson(res.text) as { options?: unknown } | unknown[] | null;
  const list = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { options?: unknown })?.options) ? ((parsed as { options: unknown[] }).options) : [];
  const options: CaptionOption[] = [];
  let dropped = 0;
  for (const raw of list) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const caption = tidy(r.caption, Math.min(limit, 2000));
    const hashtags = normalizeHashtags(Array.isArray(r.hashtags) ? r.hashtags.filter((h): h is string => typeof h === "string") : [], 10);
    if (!caption) continue;
    if (unsupportedClaims(caption, c.knowledge.text).length || unsupportedHashtags(hashtags, c.knowledge.text).length) {
      dropped += 1;
      continue;
    }
    options.push({ caption, hashtags });
    if (options.length >= count) break;
  }
  if (!options.length) {
    await recordRun(ctx, "caption", brief, { dropped }, "failed", "Nothing usable came back.");
    throw new AppError("upstream_error", dropped ? "The captions made claims that are not in your approved business knowledge, so none were kept. Add the facts to your knowledge, or try again." : "The AI did not return usable captions. Try again.");
  }
  const runId = await recordRun(ctx, "caption", brief, { options, dropped, knowledgeSections: c.knowledge.used }, "succeeded", null);
  return { runId, options };
}

/**
 * Turns one suggested caption into a draft. The draft is marked as AI-written, belongs to the person who asked for it, and still needs everything any draft
 * needs: their edits, a platform check, and a human approval before it can be scheduled.
 */
export async function createDraftFromOption(
  ctx: OrgContext,
  runId: string,
  index: number,
  input: { accountId: string; kind: PostKind; campaignId?: string | null; linkUrl?: string | null; mediaAssetIds?: string[] },
): Promise<PostView> {
  if (!ctx.can("social.create")) throw new AppError("forbidden", "Your role can't write social posts.");
  const run = await withSystem(async (db) => (await db.query<{ output: { options?: CaptionOption[] }; status: string; kind: string }>("select output, status, kind from social_ai_runs where id = $1 and org_id = $2", [runId, ctx.org.orgId])).rows[0]);
  if (!run || run.status !== "succeeded" || run.kind !== "caption") throw new AppError("not_found", "Those suggestions were not found.");
  const option = run.output.options?.[index];
  if (!option) throw new AppError("invalid_input", "Choose one of the suggestions.");
  const settings = await withSystem((db) => readSettings(db, ctx.org.orgId));
  if (!settings.aiDraftsEnabled) throw new AppError("not_enabled", "AI drafting is switched off for this workspace.");
  const hashtags = normalizeHashtags([...option.hashtags, ...settings.defaultHashtags], 30);
  return createAiDraft(ctx, { accountId: input.accountId, kind: input.kind, caption: option.caption, hashtags, linkUrl: input.linkUrl ?? null, mediaAssetIds: input.mediaAssetIds ?? [], campaignId: input.campaignId ?? null }, runId, { runId, index });
}
