import "server-only";
import { withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { llmStream, resolveLlmConfigDetailed } from "@/server/llm/client";
import { classifyAqiError, logAqiError, providerAqiError, type AqiDiagnostic } from "@/server/aqi/errors";
import {
  AQI_MAX_MESSAGE, aqiCostMicros, effectiveAqiModel, estimateAqiTokens, getPublishedAqiConfig, recordAqiUsage, reserveAqiSpend,
  type AqiMessageView,
} from "@/server/aqi/service";
import { normalizeAqiNavigation } from "@/lib/aqi/navigation-links";
import type { AqiViewer } from "@/server/aqi/access";
import { createOpsRun, numberEvidence, OPS_LIMITS, type OpsToolOutcome } from "@/server/aqi/ops/executor";
import { findOpsTool, toolsForRole } from "@/server/aqi/ops/registry";
import { planOps, suggestOpsQuestions } from "@/server/aqi/ops/planner";
import { resolveOpsScope } from "@/server/aqi/ops/scope";
import { proposeOpsAction } from "@/server/aqi/ops/actions";
import { buildOpsSystemPrompt, evidenceOnlyAnswer } from "@/server/aqi/ops/prompt";
import { loadOpsMemory } from "@/server/aqi/ops/memory";
import { OPS_LINKS, isSafeOpsHref } from "@/lib/aqi/ops/links";
import { opsScopeKey, type OpsCard, type OpsEvidence, type OpsMessageContext, type OpsScope, type OpsScopeRequest, type OpsToolRun } from "@/lib/aqi/ops/types";

export interface OpsTurnInput {
  conversationId?: string | null;
  message: string;
  pathname?: string | null;
  scope?: OpsScopeRequest | null;
}

export type OpsDoneMessage = AqiMessageView & { ops: OpsMessageContext };

export type OpsStreamEvent =
  | { type: "meta"; conversationId: string; messageId: string; scope: OpsScope }
  | { type: "plan"; tools: Array<{ id: string; title: string }> }
  | { type: "tool"; run: OpsToolRun }
  | { type: "cards"; cards: OpsCard[] }
  | { type: "delta"; text: string }
  | { type: "done"; message: OpsDoneMessage; sources: []; guide: null; usage: { inputTokens?: number; outputTokens?: number; latencyMs: number } }
  | { type: "error"; code: string; message: string; diagnostic?: AqiDiagnostic };

const iso = (value: Date | string) => (value instanceof Date ? value : new Date(value)).toISOString();

function capabilityText(role: string): string {
  const groups = new Set(toolsForRole(role).filter((t) => t.kind === "read").map((t) => t.group));
  const label: Record<string, string> = {
    health: "platform health, incidents and scheduled jobs", workspace: "client workspaces and onboarding blockers", workforce: "Hermes AI Employee status, runs and approvals",
    support: "support tickets, duplicates and priorities", security: "audit and security events", business: "usage, cost and revenue figures",
    integrations: "integration and message-delivery failures", release: "the running release and migrations", product: "what clients request most", briefing: "operations briefings",
  };
  return [...groups].filter((g) => label[g]).map((g) => label[g]).join(", ");
}

function removeUnknownEvidence(content: string, valid: Set<string>): { content: string; cited: string[] } {
  const cited = new Set<string>();
  const cleaned = content.replace(/\[(E\d+)\]/g, (m, id: string) => {
    if (valid.has(id)) { cited.add(id); return m; }
    return "";
  }).replace(/\[K\d+\]/g, "").replace(/ {2,}/g, " ");
  return { content: cleaned.replace(/\s+—\s+/g, ", ").replace(/—/g, ", ").trim(), cited: [...cited] };
}

/** Runs one Super Admin turn: validate scope -> plan -> run read tools -> evidence -> narrative. It never executes a write. */
export async function* runOpsTurn(viewer: AqiViewer, input: OpsTurnInput, signal: AbortSignal): AsyncGenerator<OpsStreamEvent> {
  const user = viewer.user;
  if (user.platformRole !== "agency_super_admin") throw new AppError("forbidden", "AQi Operations is available to Super Admins only.");
  const text = input.message.trim();
  if (!text) throw new AppError("invalid_input", "Ask AQi Operations a question.");
  if (text.length > AQI_MAX_MESSAGE) throw new AppError("invalid_input", `Keep questions under ${AQI_MAX_MESSAGE.toLocaleString()} characters.`);

  const configPromise = getPublishedAqiConfig();
  void configPromise.catch(() => undefined);
  const limit = await consumeRateLimit(RATE_LIMITS.aqiMessageByUser, user.id);
  if (!limit.allowed) throw new AppError("rate_limited", "You're asking quickly. Please wait a moment.", { retryAfterSeconds: limit.retryAfterSeconds });
  const [configView, scope] = await Promise.all([configPromise, resolveOpsScope(user, input.scope)]);

  const requestId = crypto.randomUUID();
  const scopeKey = opsScopeKey(scope);
  // The provider lookup (database + secret store) overlaps with the tools, which are the slow part.
  const resolutionPromise = resolveLlmConfigDetailed();
  void resolutionPromise.catch(() => undefined);

  const available = new Set(toolsForRole(user.platformRole).filter((t) => t.kind === "read" && t.scopes.includes(scope.type)).map((t) => t.id));
  const plan = planOps(text, scope, available);
  const planned = plan.calls.slice(0, OPS_LIMITS.toolsPerTurn);

  // Persist the turn first so a failure still leaves an honest record. Operations chats are saved by default.
  const opsViewer: AqiViewer = { ...viewer, org: null };
  const prepared = await withUser(user.id, async (db) => {
    let conversationId = input.conversationId ?? null;
    if (!conversationId) {
      const { rows } = await db.query<{ id: string }>(
        `insert into aqi_conversations (org_id, user_id, title, config_version_id, page_route, surface, saved_at, saved_by)
         values (null, $1, 'New conversation', $2, $3, 'operations', now(), $1) returning id`,
        [user.id, configView.versionId, input.pathname?.slice(0, 300) ?? null],
      );
      conversationId = rows[0].id;
    }
    const baseContext = JSON.stringify({ scopeKey, scope });
    const { rows } = await db.query<{ conversation_id: string; user_message_id: string; assistant_message_id: string }>(
      `with target as (
         select id from aqi_conversations where id = $1 and user_id = $2 and surface = 'operations'
       ), prior as (
         select count(*)::int as n from aqi_messages where conversation_id = (select id from target) and role = 'user'
       ), user_msg as (
         insert into aqi_messages (conversation_id, org_id, user_id, role, content, status, context)
         select id, null, $2, 'user', $3, 'complete', $4::jsonb from target returning id
       ), assistant_msg as (
         insert into aqi_messages (conversation_id, org_id, user_id, role, content, status, context)
         select id, null, $2, 'assistant', '', 'streaming', $4::jsonb from target returning id
       )
       update aqi_conversations c
       set title = case when (select n from prior) + 1 = 1 and c.title = 'New conversation' then left($3, 80) else c.title end,
           last_message_at = now(), updated_at = now()
       where c.id = (select id from target)
       returning c.id as conversation_id, (select id from user_msg) as user_message_id, (select id from assistant_msg) as assistant_message_id`,
      [conversationId, user.id, text, baseContext],
    );
    const row = rows[0];
    if (!row) throw new AppError("not_found", "Conversation not found.");
    const { rows: recent } = await db.query<{ role: "user" | "assistant"; content: string }>(
      `select role, content from aqi_messages where conversation_id = $1 and status = 'complete' and context->>'scopeKey' = $2
       order by created_at desc limit 8`,
      [row.conversation_id, scopeKey],
    );
    return { conversationId: row.conversation_id, assistantMessageId: row.assistant_message_id, history: recent.reverse().map((r) => ({ role: r.role, content: r.content.slice(0, 2500) })) };
  });

  yield { type: "meta", conversationId: prepared.conversationId, messageId: prepared.assistantMessageId, scope };

  const started = Date.now();
  const run = await createOpsRun({ user, scope, signal, requestId, plannedToolIds: [...planned.map((c) => c.toolId), ...(plan.action ? [plan.action.toolId] : [])] });
  const outcomes: OpsToolOutcome[] = [];
  const cards: OpsCard[] = [];
  let actionIds: string[] = [];
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let costMicros: number | null = null;
  let reservationId: string | null = null;
  let model = effectiveAqiModel(configView.config, null);

  const finish = async (content: string, status: "complete" | "failed" | "cancelled", ops: OpsMessageContext, suggestions: string[], errorCode: string | null): Promise<OpsDoneMessage> => {
    const context = JSON.stringify({ scopeKey, scope, ops, suggestedQuestions: suggestions });
    const { rows } = await withUser(user.id, (db) => db.query<{ id: string; created_at: Date; feedback_rating: number | null; feedback_comment: string | null }>(
      `update aqi_messages m set content = $2, status = $3, error_code = $4, model = coalesce($5, model), input_tokens = $6, output_tokens = $7,
         latency_ms = $8, context = $9::jsonb
       from aqi_conversations c where m.id = $1 and c.id = m.conversation_id and c.user_id = $10
       returning m.id, m.created_at, m.feedback_rating, m.feedback_comment`,
      [prepared.assistantMessageId, content.slice(0, 20_000), status, errorCode, model, inputTokens ?? null, outputTokens ?? null, Date.now() - started, context, user.id],
    ));
    const row = rows[0];
    if (!row) throw new AppError("not_found", "Message not found.");
    return {
      id: row.id, role: "assistant", content, status, feedbackRating: row.feedback_rating, feedbackComment: row.feedback_comment, createdAt: iso(row.created_at),
      suggestedQuestions: suggestions, suggestSupport: false, ops,
    };
  };
  const contextFor = (evidence: OpsEvidence[], narrative: OpsMessageContext["narrative"]): OpsMessageContext => ({
    scope, cards, evidence, tools: outcomes.map((o) => o.run), actionIds, narrative,
  });

  try {
    // Fixed answers: nothing to investigate, so nothing is asked of the model and nothing is invented.
    const fixed = plan.clarification
      ?? (plan.intents.includes("smalltalk") ? "Hello. I'm AQi Operations. Ask me to investigate platform health, a client's setup, AI Employee runs, support tickets, security events, costs or integration failures. Select a client or record above to scope an investigation."
        : plan.intents.includes("help") || (plan.intents.includes("general") && !planned.length && !plan.action)
          ? `${plan.intents.includes("help") ? "" : "I couldn't map that to something I can check with verified data. "}I can investigate ${capabilityText(user.platformRole) || "the platform"}. Every answer is built from recorded evidence with its source and time, and any change I propose waits for your confirmation.`
          : null);
    if (fixed) {
      const suggestions = suggestOpsQuestions(scope, []);
      yield { type: "delta", text: fixed };
      const message = await finish(fixed, "complete", contextFor([], "evidence_only"), suggestions, null);
      await run.flushAudit();
      yield { type: "done", message, sources: [], guide: null, usage: { latencyMs: Date.now() - started } };
      return;
    }

    if (planned.length) yield { type: "plan", tools: planned.map((c) => ({ id: c.toolId, title: findOpsTool(c.toolId)?.title ?? c.toolId })) };
    const pending = planned.map((call) => run.runTool(call.toolId, call.args));
    for (const promise of pending) {
      const outcome = await promise;
      outcomes.push(outcome);
      yield { type: "tool", run: outcome.run };
      if (outcome.cards.length) {
        cards.push(...outcome.cards);
        yield { type: "cards", cards: outcome.cards };
      }
    }
    if (signal.aborted) throw new DOMException("aborted", "AbortError");

    if (plan.action) {
      const card = await proposeOpsAction({ run, scope, conversationId: prepared.conversationId, messageId: prepared.assistantMessageId, action: plan.action });
      cards.push(card);
      if (card.kind === "action_preview") actionIds = [card.actionId];
      yield { type: "cards", cards: [card] };
    }

    const evidence = numberEvidence(outcomes.map((o) => o.evidence));
    const withEvidence = outcomes.filter((o) => o.evidence);
    const evidenceFor = (o: OpsToolOutcome) => evidence[withEvidence.indexOf(o)];
    const failed = outcomes.filter((o) => !["ok", "partial"].includes(o.run.status));
    const unavailable = outcomes.flatMap((o) => o.unavailable);
    const suggestions = suggestOpsQuestions(scope, []);
    const actionPrepared = cards.some((c) => c.kind === "action_preview");

    // Allowed links: the fixed admin pages plus the deep links the tools returned in this turn.
    const deepLinks = new Map<string, string>();
    for (const e of evidence) if (e.href && isSafeOpsHref(e.href)) deepLinks.set(e.href, e.label);
    for (const c of cards) {
      if (c.kind === "tickets") for (const r of c.rows.slice(0, 10)) if (isSafeOpsHref(r.href)) deepLinks.set(r.href, `${r.ref}`);
      if (c.kind === "workspace") for (const l of c.links) if (isSafeOpsHref(l.href)) deepLinks.set(l.href, l.label);
    }
    const routes = [...OPS_LINKS, ...[...deepLinks].map(([path, label]) => ({ path, label }))];

    const evidenceText = (reason: string): string => evidenceOnlyAnswer(
      withEvidence.map((o) => ({ id: evidenceFor(o).id, title: o.run.title, summary: o.summary })),
      unavailable,
      reason,
    ).trim();

    const partial = [...failed.map((o) => `${o.run.title}: ${o.run.note ?? o.run.status}`)];
    const useModel = withEvidence.length > 0 || actionPrepared;
    let content = "";
    let narrative: OpsMessageContext["narrative"] = "evidence_only";
    let notice = "";

    if (useModel) {
      const resolution = await resolutionPromise;
      if (!resolution.config) {
        notice = "AQi's language model is not available right now, so there is no written analysis.";
      } else {
        model = effectiveAqiModel(configView.config, resolution.config.model);
        const memoryLines = await loadOpsMemory(user.id, scope, prepared.conversationId).catch(() => []);
        const system = buildOpsSystemPrompt({
          scope, now: new Date(), evidence: withEvidence.map((o) => ({ ...evidenceFor(o), data: o.data })), failedTools: partial, unavailable,
          intents: plan.intents, actionPrepared, memoryLines, extraLinks: [...deepLinks].map(([path, label]) => ({ path, label })),
        });
        const completionBudget = Math.min(2000, Math.max(configView.config.complexMaxTokens, 1000));
        let reservation: Awaited<ReturnType<typeof reserveAqiSpend>> | null = null;
        try {
          reservation = await reserveAqiSpend(opsViewer, { ...configView.config, model }, estimateAqiTokens(system) + estimateAqiTokens(prepared.history.map((h) => h.content).join("\n")), completionBudget, prepared.conversationId, configView.versionId, input.pathname ?? null);
          reservationId = reservation.id;
        } catch (err) {
          notice = err instanceof AppError && err.code === "budget_exhausted" ? "The AQi budget for this period is exhausted, so there is no written analysis." : "AQi could not reserve model capacity, so there is no written analysis.";
          logAqiError(err, { requestId, superAdmin: true, provider: resolution.provider, model, reason: "budget_check" });
        }
        if (!notice && reservation) {
          let streamed = "";
          try {
            for await (const event of llmStream({ ...resolution.config, model }, { system, messages: prepared.history.length ? prepared.history : [{ role: "user", content: text }], maxTokens: completionBudget, temperature: 0.2, timeoutMs: 75_000 }, signal)) {
              if (event.type === "delta") {
                streamed += event.text;
                yield { type: "delta", text: event.text.replace(/—/g, ", ") };
              } else {
                inputTokens = event.inputTokens ?? inputTokens;
                outputTokens = event.outputTokens ?? outputTokens;
              }
            }
            if (signal.aborted) throw new DOMException("aborted", "AbortError");
            const checked = removeUnknownEvidence(streamed, new Set(evidence.map((e) => e.id)));
            content = normalizeAqiNavigation(checked.content, { routes, currentPath: null, externalLinks: "strip", rawPaths: true });
            narrative = content.trim() ? "model" : "evidence_only";
            if (!content.trim()) notice = "The language model returned an empty answer.";
          } catch (err) {
            if (signal.aborted || (err instanceof DOMException && err.name === "AbortError")) throw err;
            logAqiError(err, { requestId, superAdmin: true, provider: resolution.provider, model, reason: "provider_error" });
            notice = "The language model could not be reached, so there is no written analysis.";
            content = "";
          }
          const actualInput = inputTokens ?? estimateAqiTokens(system);
          const actualOutput = outputTokens ?? estimateAqiTokens(streamed);
          costMicros = reservation.price ? aqiCostMicros(reservation.price, actualInput, actualOutput) : null;
          await recordAqiUsage(opsViewer, {
            reservationId, conversationId: prepared.conversationId, model, inputTokens: actualInput, outputTokens: actualOutput, latencyMs: Date.now() - started,
            status: narrative === "model" ? "recorded" : "failed", costMicros, costEstimated: inputTokens === undefined || outputTokens === undefined, pageRoute: input.pathname ?? null, configVersionId: configView.versionId,
          }).catch(() => undefined);
          reservationId = null;
        }
      }
    }
    if (reservationId) {
      await recordAqiUsage(opsViewer, { reservationId, conversationId: prepared.conversationId, model, inputTokens: null, outputTokens: null, latencyMs: Date.now() - started, status: "released", costMicros: 0, costEstimated: false, pageRoute: input.pathname ?? null, configVersionId: configView.versionId }).catch(() => undefined);
    }

    if (narrative !== "model") {
      content = withEvidence.length
        ? evidenceText(notice || "No written analysis was produced for this answer.")
        : actionPrepared
          ? "I prepared the change below. Nothing has happened yet: review the preview and confirm it if it is what you want."
          : `${notice || "No checks returned evidence."} ${partial.join("; ")}`.trim();
      yield { type: "delta", text: content };
    } else if (partial.length) {
      const addendum = `\n\nNot checked: ${partial.join("; ")}.`;
      content += addendum;
      yield { type: "delta", text: addendum };
    }

    await run.flushAudit();
    const message = await finish(content, "complete", contextFor(evidence, narrative), suggestions, null);
    yield { type: "done", message, sources: [], guide: null, usage: { inputTokens, outputTokens, latencyMs: Date.now() - started } };
  } catch (err) {
    const aborted = signal.aborted || (err instanceof DOMException && err.name === "AbortError");
    await run.flushAudit().catch(() => undefined);
    const evidence = numberEvidence(outcomes.map((o) => o.evidence));
    await finish("", aborted ? "cancelled" : "failed", contextFor(evidence, "evidence_only"), [], aborted ? "cancelled" : "ops_error").catch(() => undefined);
    if (!aborted) {
      const publicError = err instanceof AppError ? classifyAqiError(err, { requestId, superAdmin: true, reason: "ops_turn" }) : providerAqiError("failed", { requestId, superAdmin: true, reason: "ops_turn" });
      logAqiError(err, { requestId, superAdmin: true, reason: "ops_turn" });
      yield { type: "error", code: publicError.code, message: publicError.message, ...(publicError.diagnostic ? { diagnostic: publicError.diagnostic } : {}) };
    }
  }
}
