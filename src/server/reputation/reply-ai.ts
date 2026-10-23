import "server-only";
import crypto from "node:crypto";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { getBalance } from "@/server/billing/ledger";
import { auditActor, type CrmActor } from "@/server/crm/actor";
import { llmComplete, resolveLlmConfig, type LlmUsage } from "@/server/llm/client";
import { meterModelUse, modelCallKey } from "@/server/llm/meter";
import { consumeRateLimit, type RateLimitRule } from "@/server/security/rate-limit";
import { assertWithinLimits, recordUsage } from "@/server/usage";
import { unsupportedClaims } from "@/server/social/claims";
import { widgetKnowledge } from "@/server/webchat/generator";
import { assertExternalReviewsEnabled } from "@/server/reputation/entitlement";
import { insertReply } from "@/server/reputation/replies";
import { loadSettings } from "@/server/reputation/settings";
import { REPLY_AI_MAX_TOKENS, REPLY_AI_PROMPT_VERSION, REPLY_KNOWLEDGE_SECTIONS, cleanAiReply, fencedReview, replySystemPrompt } from "@/lib/reputation/reply-draft";
import { replyProblems, replyWarnings } from "@/lib/reputation/reply-rules";

// AI help with writing a reply to a public review. It is a person-started assist: nothing runs by itself, and what it writes is an ordinary DRAFT, labelled AI-drafted, that a
// person reads and edits and that the client's owner or a manager must approve before it can be posted. It never submits, approves or posts anything, and no setting changes that.
//
//  * Off until an owner or manager switches it on (reputation settings), and honest when no AI model is connected or the workspace has no credits left.
//  * Bounded: a limit per person per hour and per workspace per day (its own, not the Social media one), the workspace's monthly help allowance, a short output, a timeout.
//  * Every model call is metered (src/server/llm/meter.ts), whatever becomes of what it wrote.
//  * The review is data: fenced, with the reviewer's name left out and emails, phone numbers and secrets removed first. Only approved, unflagged company knowledge about how the
//    business speaks and serves is given to the model. What comes back is held to the same rules a person's reply is, plus the claim check against that knowledge: a draft that
//    breaks a rule is not saved, and the person is told which rule and left to write it themselves or ask again.

export const REPLY_AI_LIMITS = {
  byUser: { name: "reviews:reply_ai:user", limit: 20, windowSeconds: 3600 },
  byOrg: { name: "reviews:reply_ai:org", limit: 50, windowSeconds: 86_400 },
} satisfies Record<string, RateLimitRule>;

export const AI_REPLIES_OFF = "AI reply drafts are switched off for this workspace. An owner or manager can switch them on in the Reviews settings.";
export const AI_NOT_CONNECTED = "The AI language model isn't connected for this workspace, so nothing can be drafted. You can write the reply yourself.";

export type ReplyComplete = (input: { system: string; user: string; maxTokens: number }) => Promise<{ ok: true; text: string; usage?: LlmUsage } | { ok: false; usage?: LlmUsage }>;

export interface ReplyAiDeps {
  /** Tests supply the model's answer; everything else (limits, credits, metering, the rules) runs as it does for real. */
  complete?: ReplyComplete;
}

const waitPhrase = (seconds: number) => (seconds < 90 ? "a minute" : seconds < 5400 ? `${Math.ceil(seconds / 60)} minutes` : `${Math.ceil(seconds / 3600)} hours`);

export interface AiReplyDraft {
  replyId: string;
  /** Things in the draft worth a second look that do not stop it. */
  warnings: string[];
  knowledgeSections: string[];
}

/**
 * Drafts a reply to one review for the person who asked. Returns the saved draft; throws a plain-words AppError when the assist is off, not connected, rate-limited or when the
 * draft broke a rule. The draft belongs to the person who asked, and is not sent for approval.
 */
export async function draftReplyWithAi(actor: CrmActor, reviewId: string, deps: ReplyAiDeps = {}): Promise<AiReplyDraft> {
  if (actor.kind !== "member" || !actor.userId || !actor.can("reviews.respond")) {
    throw new AppError("forbidden", actor.kind === "agency" ? "AI reply drafts are started by the client's own team. iAcquire support can write a reply by hand in a write session." : "Your role can't write replies to reviews.");
  }
  const userId = actor.userId;
  const review = await withSystem(async (db) => {
    await assertExternalReviewsEnabled(db, actor.orgId);
    const settings = await loadSettings(db, actor.orgId);
    if (!settings.aiRepliesEnabled) throw new AppError("not_enabled", AI_REPLIES_OFF);
    const { rows } = await db.query<{ rating: number | null; recommends: boolean | null; comment: string | null; removed_at: Date | null; status: string; org_name: string }>(
      `select r.rating, r.recommends, r.comment, r.removed_at, c.status, o.name as org_name
       from external_reviews r join review_connections c on c.id = r.connection_id and c.org_id = r.org_id join organizations o on o.id = r.org_id
       where r.id = $1 and r.org_id = $2`,
      [reviewId, actor.orgId],
    );
    const r = rows[0];
    if (!r) throw new AppError("not_found", "That review was not found.");
    if (r.removed_at) throw new AppError("conflict", "This review is no longer on the review site, so it can't be answered.");
    if (r.status !== "connected") throw new AppError("conflict", "The connection to the review site needs attention, so reviews can't be answered until it is fixed.");
    const open = await db.query("select 1 from review_replies where review_id = $1 and org_id = $2 and status in ('draft', 'pending_approval', 'changes_requested', 'approved', 'posting', 'failed', 'needs_reconciliation')", [reviewId, actor.orgId]);
    if (open.rows[0]) throw new AppError("conflict", "This review already has a reply in progress. Open it, or cancel it to ask for a new draft.");
    return { rating: r.rating, recommends: r.recommends, comment: r.comment, business: r.org_name, styleNote: settings.replyStyleNote };
  });

  // Checked before anything is counted: a refused request uses up nothing.
  const complete: ReplyComplete | null = deps.complete ?? (await defaultComplete());
  if (!complete) throw new AppError("integration_unavailable", AI_NOT_CONNECTED);
  const balance = await withSystem((db) => getBalance(db, actor.orgId));
  if (balance.availableMicros <= 0) throw new AppError("usage_limit", "Your service credits have run out, so the AI can't draft right now. You can write the reply yourself.");
  const person = await consumeRateLimit(REPLY_AI_LIMITS.byUser, userId);
  if (!person.allowed) throw new AppError("rate_limited", `You have asked for reply drafts ${REPLY_AI_LIMITS.byUser.limit} times in the last hour. Try again in about ${waitPhrase(person.retryAfterSeconds)}.`, { retryAfterSeconds: person.retryAfterSeconds });
  const workspace = await consumeRateLimit(REPLY_AI_LIMITS.byOrg, actor.orgId);
  if (!workspace.allowed) throw new AppError("rate_limited", `Your workspace has used today's allowance of ${REPLY_AI_LIMITS.byOrg.limit} reply drafts. It renews in about ${waitPhrase(workspace.retryAfterSeconds)}.`, { retryAfterSeconds: workspace.retryAfterSeconds });
  await assertWithinLimits(actor.orgId, "help_request");

  const knowledge = await widgetKnowledge(actor.orgId, REPLY_KNOWLEDGE_SECTIONS);
  const nonce = crypto.randomBytes(8).toString("hex");
  const answer = await complete({
    maxTokens: REPLY_AI_MAX_TOKENS,
    system: replySystemPrompt({ business: review.business, nonce, knowledge: knowledge.text, styleNote: review.styleNote }),
    user: fencedReview(review, nonce),
  });
  // The call was made, so it is counted, whatever the answer turns out to be.
  await meterModelUse({ orgId: actor.orgId, feature: "review_reply_ai", key: modelCallKey(userId), usage: answer.usage });
  await withSystem((db) => recordUsage(db, { orgId: actor.orgId, userId, kind: "help_request" }));
  if (!answer.ok) throw new AppError("upstream_error", "The AI service couldn't answer just now. Try again in a moment, or write the reply yourself.");

  const text = cleanAiReply(answer.text);
  const claims = unsupportedClaims(text, knowledge.text);
  const problems = replyProblems(text, { claims });
  if (problems.length) {
    await withSystem((db) => recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "reputation.reply_ai_refused", targetType: "external_review", targetId: reviewId, result: "denied", metadata: { rules: problems.map((p) => p.code) } }, db));
    throw new AppError("invalid_input", `The AI's draft broke the rules for public replies, so it wasn't saved: ${problems.slice(0, 3).map((p) => p.message).join(" ")} You can write the reply yourself, or ask for another draft.`);
  }
  const warnings = replyWarnings(text);
  const replyId = await withSystem(async (db) => {
    await assertExternalReviewsEnabled(db, actor.orgId);
    const id = await insertReply(db, {
      orgId: actor.orgId, reviewId, body: text, origin: "ai", authorId: userId,
      aiMeta: { promptVersion: REPLY_AI_PROMPT_VERSION, knowledgeSections: knowledge.used, warnings, checks: ["rules", "claims"] },
    });
    await db.query("insert into review_reply_events (org_id, reply_id, kind, actor_id, actor_kind, detail) values ($1, $2, 'ai_drafted', null, 'ai', $3::jsonb)", [actor.orgId, id, JSON.stringify({ requestedBy: userId, promptVersion: REPLY_AI_PROMPT_VERSION })]);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "reputation.reply_ai_drafted", targetType: "review_reply", targetId: id, result: "success", metadata: { promptVersion: REPLY_AI_PROMPT_VERSION } }, db);
    return id;
  });
  return { replyId, warnings, knowledgeSections: knowledge.used };
}

/** The portal's one AI connection, or null when there is none. */
async function defaultComplete(): Promise<ReplyComplete | null> {
  const config = await resolveLlmConfig();
  if (!config) return null;
  return async (input) => {
    const r = await llmComplete(config, { ...input, temperature: 0.3, timeoutMs: 25_000 });
    return r.ok ? { ok: true, text: r.text, usage: r.usage } : { ok: false, usage: r.usage };
  };
}
