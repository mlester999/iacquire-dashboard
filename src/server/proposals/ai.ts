import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { getBalance } from "@/server/billing/ledger";
import { llmComplete, resolveLlmConfig, type LlmConfig } from "@/server/llm/client";
import { meterModelUse, modelCallKey } from "@/server/llm/meter";
import { consumeRateLimit, type RateLimitRule } from "@/server/security/rate-limit";
import { assertCan, auditActor, crmWrite, type CrmActor } from "@/server/crm/actor";
import { widgetKnowledge } from "@/server/webchat/generator";
import { extractJson } from "@/server/social/ai";
import { unsupportedClaims } from "@/server/social/claims";
import { isCurrency, sumLines, type CurrencyCode, type LineAmounts } from "@/lib/money";
import type { Billing } from "@/lib/proposals/doc";
import { lineFigures } from "@/lib/proposals/money";
import {
  AI_KNOWLEDGE_SECTIONS, AI_LIMITS, aiSections, aiSystemPrompt, aiUserPrompt, allowedNumberSet, normalizeAiOutput, plainAmount, screenList, screenText, unbackedPromises, validQuantity,
  type Dropped, type PriceBookEntry, type TextChecks,
} from "@/lib/proposals/ai";
import { loadProposalRow, memberUserId, readSettings, type ProposalRow } from "@/server/proposals/core";
import { assertProposalsEnabled } from "@/server/proposals/features";
import { draftCurrency, insertProposalDraft, loadApprovedTemplate, resolveLinks, type CreateInput } from "@/server/proposals/proposals";
import { buildDetail, type ProposalDetail } from "@/server/proposals/view";

// AI help with writing a proposal. It drafts; it can never send, approve or price. What comes out is an ordinary DRAFT marked as AI-written: it needs a person's approval
// before it can be sent, whatever the workspace's settings (src/lib/proposals/state.ts approvalReasons). The model chooses price book items by id and writes a few paragraphs;
// every price, total and tax comes from the price book rows this file looks up. Everything the model writes passes the checks in src/lib/proposals/ai.ts first.
//
// The real language model has never been evaluated against this prompt: the tests use a stub that returns what a model could return, including hostile output.

/**
 * How much AI drafting one person and one workspace can ask for. Each request reaches a language model the platform pays for, so both are bounded: a person per hour and the
 * workspace per day (fixed windows counted in the database, so the limit holds across servers). Past either, the request is refused with when to try again.
 */
export const PROPOSAL_AI_LIMITS = {
  byUser: { name: "proposals:ai:user", limit: 20, windowSeconds: 3600 },
  byOrg: { name: "proposals:ai:org", limit: 50, windowSeconds: 86_400 },
} satisfies Record<string, RateLimitRule>;

export interface AiDraftInput {
  contactId?: string | null;
  companyId?: string | null;
  opportunityId?: string | null;
  templateId?: string | null;
  currency?: string;
  /** What the person wants the proposal to cover, in their own words. Treated as data, not instructions. */
  brief?: string | null;
}

export interface AiDeps {
  complete?: typeof llmComplete;
  config?: () => Promise<LlmConfig | null>;
  now?: Date;
}

export interface AiDraftResult {
  proposal: ProposalDetail;
  runId: string;
  /** Sentences and items the checks removed, so the person knows the draft is not everything the model wrote. */
  dropped: Dropped[];
  /** Items the model chose that could not be used (an unknown id, a quantity it may not choose, a repeat). */
  rejectedItems: number;
}

interface CatalogRow {
  id: string;
  name: string;
  description: string;
  unit_label: string;
  unit_price_minor: string;
  currency: string;
  billing: Billing;
  tax_bps: number | null;
  archived_at: Date | null;
}

const waitPhrase = (seconds: number): string => (seconds < 90 ? "a minute" : seconds < 5400 ? `${Math.ceil(seconds / 60)} minutes` : `${Math.ceil(seconds / 3600)} hours`);

/**
 * The checks every model call starts with: a connected model, credits, and the hourly and daily limits. Nothing is counted for a call that is refused. The call itself is
 * metered afterwards: its tokens are recorded and, where a rate is published, charged to the workspace's credits.
 */
async function ready(actor: CrmActor, userId: string, deps: AiDeps): Promise<{ config: LlmConfig; complete: typeof llmComplete }> {
  const config = await (deps.config ?? resolveLlmConfig)();
  if (!config) throw new AppError("unavailable", "The AI language model is not connected, so nothing can be drafted yet.");
  const balance = await withSystem((db) => getBalance(db, actor.orgId));
  if (balance.availableMicros <= 0) throw new AppError("usage_limit", "Your service credits have run out, so the AI cannot draft right now.");
  const person = await consumeRateLimit(PROPOSAL_AI_LIMITS.byUser, userId);
  if (!person.allowed) throw new AppError("rate_limited", `You have asked for AI proposal drafts ${PROPOSAL_AI_LIMITS.byUser.limit} times in the last hour. Try again in about ${waitPhrase(person.retryAfterSeconds)}.`, { retryAfterSeconds: person.retryAfterSeconds });
  const workspace = await consumeRateLimit(PROPOSAL_AI_LIMITS.byOrg, actor.orgId);
  if (!workspace.allowed) throw new AppError("rate_limited", `Your workspace has used today's allowance of ${PROPOSAL_AI_LIMITS.byOrg.limit} AI proposal drafts. It renews in about ${waitPhrase(workspace.retryAfterSeconds)}.`, { retryAfterSeconds: workspace.retryAfterSeconds });
  return { config, complete: deps.complete ?? llmComplete };
}

async function recordRun(db: Queryable, actor: CrmActor, userId: string, brief: Record<string, unknown>, output: unknown, status: "succeeded" | "failed", failure: string | null): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "insert into proposal_ai_runs (org_id, user_id, kind, brief, output, status, failure) values ($1, $2, 'draft', $3::jsonb, $4::jsonb, $5, $6) returning id",
    [actor.orgId, userId, JSON.stringify(brief), JSON.stringify(output ?? {}), status, failure?.slice(0, 400) ?? null],
  );
  return rows[0].id;
}

const cleanBrief = (b: string | null | undefined): string | null => b?.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, AI_LIMITS.brief) || null;

/** Money a model-chosen line adds up to, so the draft's own totals are among the numbers its wording may state. */
function figuresOf(lines: Array<{ unitPriceMinor: number; quantityMilli: number; taxBps: number; billing: Billing }>): number[] {
  const per = lines.map((l) => ({ billing: l.billing, a: lineFigures({ quantityMilli: l.quantityMilli, unitPriceMinor: l.unitPriceMinor, discount: null, taxBps: l.taxBps }) }));
  const out: number[] = [];
  const push = (a: LineAmounts) => out.push(a.gross, a.net, a.tax, a.total, a.exTax);
  for (const p of per) push(p.a);
  for (const b of ["one_time", "monthly", "yearly"] as const) {
    const t = sumLines(per.filter((p) => p.billing === b).map((p) => p.a));
    out.push(t.gross, t.subtotal, t.tax, t.total);
  }
  return out;
}

/**
 * Drafts a proposal with the language model. The result is saved as a draft owned by the person who asked, marked as AI-written, with the run recorded. It still has to be
 * sent for approval and approved by a person: no setting skips that.
 */
export async function draftProposalWithAi(actor: CrmActor, input: AiDraftInput = {}, deps: AiDeps = {}): Promise<AiDraftResult> {
  await assertProposalsEnabled(actor.orgId);
  assertCan(actor, "proposals.create", "Your role can't write proposals.");
  const userId = memberUserId(actor);

  // Everything the model will see is read now, from this workspace only, before any model is asked: an id from another workspace is "not found" and costs nothing.
  const ctx = await withSystem(async (db) => {
    const settings = await readSettings(db, actor.orgId);
    if (!settings.aiDraftsEnabled) throw new AppError("not_enabled", "AI drafting is switched off for this workspace. The owner can switch it on in the proposal settings.");
    const links = await resolveLinks(db, actor.orgId, input, { derive: true, nativeCheck: true });
    const currency = await draftCurrency(db, actor.orgId, input.currency, links);
    if (!isCurrency(currency)) throw new AppError("invalid_input", "Choose a currency iAcquire can total.");
    const template = input.templateId ? await loadApprovedTemplate(db, actor.orgId, input.templateId) : null;
    const templateIds = template ? [...new Set(template.doc.lines.map((l) => l.catalogItemId))] : [];
    const catalog = (await db.query<CatalogRow>(
      `select i.id, i.name, i.description, i.unit_label, i.unit_price_minor::text as unit_price_minor, i.currency, i.billing, t.rate_bps as tax_bps, i.archived_at
       from proposal_catalog_items i left join proposal_tax_rates t on t.id = i.tax_rate_id and t.org_id = i.org_id
       where i.org_id = $1 and ((i.archived_at is null and i.currency = $2) or i.id = any($3::uuid[])) order by lower(i.name) limit 250`,
      [actor.orgId, currency, templateIds],
    )).rows;
    // A template whose items are gone, archived or priced in another currency cannot be used (the same refusal the draft would raise), so it is found out before the model is paid.
    for (const id of templateIds) {
      const row = catalog.find((c) => c.id === id);
      if (!row || row.archived_at || row.currency !== currency) throw new AppError("invalid_input", "This template uses a price book item that is no longer available, or is priced in another currency. Update the template first.");
    }
    const candidates = catalog.filter((c) => !c.archived_at && c.currency === currency && !templateIds.includes(c.id));
    if (!candidates.length) throw new AppError("invalid_input", `Add items priced in ${currency} to your price book first: the AI only drafts from price book items, and never writes a price.`);
    const dealDescription = links.deal ? (await db.query<{ description: string | null }>("select description from crm_opportunities where id = $1 and org_id = $2", [links.deal.id, actor.orgId])).rows[0]?.description ?? null : null;
    return { settings, links, currency: currency as CurrencyCode, template, catalog, candidates, dealDescription };
  });

  const knowledge = await widgetKnowledge(actor.orgId, AI_KNOWLEDGE_SECTIONS);
  const pricing = await widgetKnowledge(actor.orgId, ["approved_pricing"]);
  const brief = cleanBrief(input.brief);
  const runBrief = { contactId: ctx.links.contact?.id ?? null, companyId: ctx.links.company?.id ?? null, opportunityId: ctx.links.deal?.id ?? null, templateId: ctx.template?.id ?? null, currency: ctx.currency, brief };
  const { config, complete } = await ready(actor, userId, deps);

  const priceBook: PriceBookEntry[] = ctx.candidates.map((c) => ({ id: c.id, name: c.name, description: c.description, unitLabel: c.unit_label, unitPriceMinor: Number(c.unit_price_minor), billing: c.billing }));
  const customer = [`Name: ${ctx.links.contact?.name ?? "(not chosen)"}`, ctx.links.company ? `Company: ${ctx.links.company.name}` : null].filter(Boolean).join("\n");
  const deal = ctx.links.deal ? `Name: ${ctx.links.deal.name}${ctx.dealDescription ? `\nDescription: ${ctx.dealDescription}` : ""}` : null;
  const res = await complete(config, {
    system: aiSystemPrompt({ business: actor.orgName, knowledge: knowledge.text, voiceNote: null }),
    user: aiUserPrompt({
      currency: ctx.currency, customer, deal, brief, priceBook,
      templateHeadings: ctx.template?.doc.sections.map((s) => s.heading) ?? [],
      templateItems: ctx.template ? ctx.template.doc.lines.map((l) => ctx.catalog.find((c) => c.id === l.catalogItemId)?.name ?? "").filter(Boolean) : [],
    }),
    maxTokens: 1800, temperature: 0.4, timeoutMs: 45_000,
  });
  // Metered whatever becomes of the answer: a draft the checks throw away still cost what the provider says it did. Never fails the request.
  await meterModelUse({ orgId: actor.orgId, feature: "proposal_ai", key: modelCallKey(userId), usage: res.usage });
  const fail = async (failure: string, message: string, output: unknown = {}): Promise<never> => {
    await withSystem((db) => recordRun(db, actor, userId, runBrief, output, "failed", failure));
    throw new AppError("upstream_error", message);
  };
  if (!res.ok) return fail("The AI language model did not answer.", "The AI language model did not answer. Try again in a moment.");
  const parsed = normalizeAiOutput(extractJson(res.text));
  if (!parsed) return fail("The answer was not in the expected shape.", "The AI did not return a usable draft. Try again.");

  // The price book items it chose. Only ids of this workspace's active items, in whole quantities, once each.
  const byId = new Map(ctx.candidates.map((c) => [c.id, c]));
  const chosen: Array<{ row: CatalogRow; quantity: number; note: string }> = [];
  let rejected = parsed.malformedItems;
  for (const it of parsed.items) {
    const row = byId.get(it.catalogItemId);
    if (!row || !validQuantity(it.quantity) || chosen.some((c) => c.row.id === row.id) || chosen.length >= AI_LIMITS.items) {
      rejected += 1;
      continue;
    }
    chosen.push({ row, quantity: it.quantity, note: it.note });
  }

  // The numbers the wording may state: the workspace's own (every price in the price book and in its words, approved pricing) and the draft's own figures.
  const templateLines = (ctx.template?.doc.lines ?? []).map((l) => ({ row: ctx.catalog.find((c) => c.id === l.catalogItemId) as CatalogRow, quantityMilli: l.quantityMilli }));
  const lineFacts = [...templateLines, ...chosen.map((c) => ({ row: c.row, quantityMilli: c.quantity * 1000 }))].map((l) => ({
    unitPriceMinor: Number(l.row.unit_price_minor), quantityMilli: l.quantityMilli, taxBps: l.row.tax_bps ?? 0, billing: l.row.billing,
  }));
  const figures = figuresOf(lineFacts).map((n) => plainAmount(n, ctx.currency));
  const allowed = allowedNumberSet([
    ...ctx.catalog.flatMap((c) => [plainAmount(Number(c.unit_price_minor), ctx.currency), c.name, c.description, c.unit_label]),
    pricing.text,
    ...figures,
    ...chosen.map((c) => c.quantity),
  ]);
  // The claim filter's idea of what is backed: the approved knowledge, the price book as the workspace wrote it, and the draft's own figures.
  const grounding = [knowledge.text, ...ctx.catalog.map((c) => `${c.name} ${c.description} ${ctx.currency} ${plainAmount(Number(c.unit_price_minor), ctx.currency)}`), figures.map((n) => `${ctx.currency} ${n}`).join(" ")].join("\n");
  // A length of time is also backed by a chosen item priced per day, hour, week or month ("3 day" for three days of training), which is the draft's own figure and not a promise.
  const promiseBacking = [grounding, ...templateLines.map((l) => `${l.quantityMilli / 1000} ${l.row.unit_label}`), ...chosen.map((c) => `${c.quantity} ${c.row.unit_label}`)].join("\n");
  const checks: TextChecks = { allowed, claims: (t) => [...unsupportedClaims(t, grounding), ...unbackedPromises(t, promiseBacking)] };

  const intro = screenText("intro", parsed.intro, AI_LIMITS.intro, checks);
  const scope = screenText("scope", parsed.scopeSummary, AI_LIMITS.scope, checks);
  const assumptions = screenList("assumption", parsed.assumptions, checks);
  const steps = screenList("next step", parsed.nextSteps, checks);
  const dropped: Dropped[] = [...intro.dropped, ...scope.dropped, ...assumptions.dropped, ...steps.dropped];
  const lineNotes = chosen.map((c) => {
    const n = screenText("item note", c.note, AI_LIMITS.itemNote, checks);
    dropped.push(...n.dropped);
    return n.text.replace(/\s*\n\s*/g, " ");
  });

  if (!chosen.length && !intro.text && !scope.text) {
    return fail("Nothing usable came back.", dropped.length
      ? "The draft made claims, prices or numbers that are not in your price book or approved knowledge, so none of it was kept. Add the facts to your knowledge, or try again."
      : "The AI did not return usable items or wording. Try again.", { dropped: dropped.slice(0, 30), rejectedItems: rejected });
  }

  const aiParts = aiSections({ intro: intro.text, scope: scope.text, assumptions: assumptions.items, nextSteps: steps.items });
  const out = {
    draft: { intro: intro.text, scope: scope.text, assumptions: assumptions.items, nextSteps: steps.items },
    items: chosen.map((c, i) => ({ catalogItemId: c.row.id, quantity: c.quantity, note: lineNotes[i] })),
    dropped: dropped.slice(0, 30), droppedCount: dropped.length, rejectedItems: rejected, knowledgeSections: knowledge.used,
  };
  const create: CreateInput = {
    contactId: ctx.links.contact?.id ?? null, companyId: ctx.links.company?.id ?? null, opportunityId: ctx.links.deal?.id ?? null, templateId: ctx.template?.id ?? null, currency: ctx.currency,
    doc: {
      sections: [...aiParts, ...(ctx.template?.doc.sections.map((s) => ({ heading: s.heading, body: s.body })) ?? [])],
      lines: [
        ...(ctx.template?.doc.lines.map((l) => ({ catalogItemId: l.catalogItemId, quantityMilli: l.quantityMilli, note: l.note })) ?? []),
        ...chosen.map((c, i) => ({ catalogItemId: c.row.id, quantityMilli: c.quantity * 1000, note: lineNotes[i] })),
      ],
      terms: ctx.template?.doc.terms ?? "",
    },
  };
  let row: ProposalRow;
  let runId: string;
  try {
    ({ row, runId } = await crmWrite(actor, async (db) => {
      const id = await recordRun(db, actor, userId, runBrief, out, "succeeded", null);
      const made = await insertProposalDraft(db, actor, create, "ai", id, { now: deps.now });
      await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "proposals.ai_drafted", targetType: "proposal", targetId: made.id, result: "success", metadata: { number: made.number, aiRunId: id, items: chosen.length, dropped: dropped.length } }, db);
      return { row: made, runId: id };
    }));
  } catch (e) {
    await withSystem((db) => recordRun(db, actor, userId, runBrief, { dropped: out.dropped }, "failed", e instanceof AppError ? e.message : "The draft could not be saved.")).catch(() => undefined);
    throw e;
  }
  const proposal = await crmWrite(actor, async (db) => buildDetail(db, actor, (await loadProposalRow(db, actor.orgId, row.id)) as ProposalRow, deps.now));
  return { proposal, runId, dropped, rejectedItems: rejected };
}
