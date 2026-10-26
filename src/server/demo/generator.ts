import "server-only";
import { withSystem } from "@/server/db";
import { llmComplete, resolveLlmConfig, type LlmConfig } from "@/server/llm/client";
import { modelGate } from "@/server/llm/gate";
import { meterModelUse, modelCallKey } from "@/server/llm/meter";
import { getPublicMaintenancePlan, listPublicServices } from "@/server/catalog/service";
import { demoIndustryLabel } from "@/lib/demo/industries";
import { HOLD_COPY, type HoldReason } from "@/lib/demo/outcomes";
import { reserveDemoMessage, completeDemoMessage, releaseDemoMessage, type ReserveInput, type ReserveRefused, type ReleaseReason } from "@/server/demo/chat";
import { transcriptOf, type DemoContext, type TranscriptLine } from "@/server/demo/public";
import { buildDemoPrompt, messageLooksLikeInjection, type PromptCatalog } from "@/server/demo/prompt";
import { checkDemoReply } from "@/server/demo/reply-check";
import { loadProspect } from "@/server/demo/core";

// The demo chat's model call, and the only place it happens. A prospect's message goes through these steps, in this order:
//
//   1. Is there a model to ask? The platform's AI connection and the agency workspace the platform's own usage is recorded against. Checked BEFORE the message is reserved, so a demo
//      with no model connected counts nothing and takes none of the day's budget: the prospect is told the chat is not available and the tour is what they get.
//   2. reserveDemoMessage (chat.ts): the prospect's allowance, the window, the pace and the platform's daily budget, atomically. A repeated message returns what was stored.
//   3. The message itself is looked at: text that tries to change the assistant's rules is not sent to it (the message is given back, nothing was spent).
//   4. modelGate: the agency workspace must be active. (No credit check: the platform pays for the demo, and its limits are the prospect's allowance and the daily budget.)
//   5. The model is asked, with a fixed prompt, no tools, no workspace data and no Hermes (prompt.ts). Metered as the feature demo_chat, whatever becomes of the answer.
//   6. The answer is checked (reply-check.ts). One that states a price other than the two published ones, an amount in words, a percentage, a promise, a claim the facts do not back or
//      an action it did not take is held back: the message is given back, and the day's budget unit stays spent because the model was asked.
//   7. completeDemoMessage stores the answer.
//
// Nothing here knows who the prospect is beyond their business name and industry, which are fenced as untrusted data. No tenant data, no tool and no Hermes profile is reachable
// from this file (tests/demo-isolation.test.ts reads its imports).

export interface DemoModelDeps {
  /** Tests replace the model call; nothing real is ever reached from a test. */
  complete?: typeof llmComplete;
  config?: () => Promise<LlmConfig | null>;
  /** The workspace the platform's own AI usage is recorded against. */
  agencyOrg?: () => Promise<string | null>;
  /** The published catalog, by name. */
  catalog?: () => Promise<PromptCatalog>;
}

export type ModelState = { ready: true; config: LlmConfig; orgId: string } | { ready: false; reason: "no_llm" | "no_agency" };

async function agencyOrgId(): Promise<string | null> {
  const { rows } = await withSystem((db) => db.query<{ id: string }>("select id from organizations where kind = 'agency' and status = 'active' order by created_at limit 1"));
  return rows[0]?.id ?? null;
}

/** Whether the demo chat has a model to ask. The credential is resolved, never returned to a browser. */
export async function demoModelState(deps: DemoModelDeps = {}): Promise<ModelState> {
  let config: LlmConfig | null = null;
  try {
    config = await (deps.config ?? resolveLlmConfig)();
  } catch {
    config = null;
  }
  if (!config) return { ready: false, reason: "no_llm" };
  const orgId = await (deps.agencyOrg ?? agencyOrgId)();
  if (!orgId) return { ready: false, reason: "no_agency" };
  return { ready: true, config, orgId };
}

async function publishedCatalog(): Promise<PromptCatalog> {
  try {
    const [services, plan] = await Promise.all([listPublicServices(), getPublicMaintenancePlan()]);
    return { services: services.filter((s) => s.kind !== "maintenance_plan").map((s) => s.name), plan: plan ? { name: plan.name, included: plan.included } : null };
  } catch {
    // The facts the chat needs most are constants; a catalog that cannot be read only makes the answer less complete.
    return { services: [], plan: null };
  }
}

export type SendOutcome =
  | { ok: true; kind: "answered"; reply: TranscriptLine; messagesLeft: number }
  | { ok: true; kind: "duplicate"; message: TranscriptLine; reply: TranscriptLine | null }
  /** The message was given back (not counted); `why` is the fixed word and `message` the sentence to show. */
  | { ok: true; kind: "held"; why: HoldReason; message: string; messagesLeft: number }
  | ReserveRefused;

const held = (why: ReleaseReason, messagesLeft: number): SendOutcome => ({ ok: true, kind: "held", why, message: HOLD_COPY[why], messagesLeft });

/** Sends a prospect's message to the end: reserved, answered by the model, checked, stored; or given back with the reason. Never throws for something a prospect can cause. */
export async function sendDemoMessage(input: ReserveInput, ctx: DemoContext, deps: DemoModelDeps = {}): Promise<SendOutcome> {
  const model = await demoModelState(deps);
  const reserved = await reserveDemoMessage(input, ctx, { modelReady: model.ready });
  if (!reserved.ok) return reserved;
  if (reserved.kind === "duplicate") return reserved;
  const now = ctx.now ?? new Date();
  const give = async (why: ReleaseReason, spent: boolean): Promise<SendOutcome> => {
    const r = await releaseDemoMessage({ prospectId: reserved.prospectId, messageId: reserved.messageId, reason: why, spent, now });
    return held(why, r.ok ? r.messagesLeft : reserved.messagesLeft);
  };
  // A model state that was ready a moment ago and is not now cannot happen between the two calls above in one request; the guard keeps the types honest.
  if (!model.ready) return give("no_model", false);
  if (messageLooksLikeInjection(reserved.text)) return give("input_blocked", false);

  try {
    const gate = await modelGate(model.orgId, { credit: false });
    if (!gate.allowed) return give("no_model", false);

    const prospect = await withSystem((db) => loadProspect(db, reserved.prospectId));
    const lines = await withSystem((db) => transcriptOf(db, reserved.prospectId));
    // Earlier turns that were answered, oldest first; the pending message itself and anything given back are left out.
    const history = lines
      .filter((l) => l.id !== reserved.messageId && ((l.role === "user" && l.state === "answered") || l.role === "assistant"))
      .map((l) => ({ role: l.role, text: l.body }));
    const catalog = await (deps.catalog ?? publishedCatalog)();
    const prompt = buildDemoPrompt({
      persona: reserved.employeeRole,
      business: prospect?.business_name ?? null,
      industryLabel: demoIndustryLabel(prospect?.industry),
      history,
      message: reserved.text,
      catalog,
    });

    const res = await (deps.complete ?? llmComplete)(model.config, { system: prompt.system, user: prompt.user, maxTokens: 400, temperature: 0.3, timeoutMs: 20_000 });
    // Metered whatever becomes of the answer: a reply the checks refuse still cost what the provider says. Never fails the prospect's message.
    await meterModelUse({ orgId: model.orgId, feature: "demo_chat", key: modelCallKey(`demo:${reserved.messageId}`), usage: res.usage });
    if (!res.ok) return give("provider_failed", true);

    const checked = checkDemoReply(res.text, prompt.grounding);
    if (!checked.ok) return give("reply_blocked", true);
    const stored = await completeDemoMessage({ prospectId: reserved.prospectId, messageId: reserved.messageId, reply: checked.text, now });
    if (!stored.ok) return give("internal", true);
    return { ok: true, kind: "answered", reply: stored.reply, messagesLeft: reserved.messagesLeft };
  } catch {
    // Whatever went wrong, the prospect is not charged a message for it. The model may or may not have been asked, so the day's unit stays spent. If even giving it back fails,
    // the message stays pending and the expiry job gives it back after a few minutes (chat.ts releaseStaleReservations).
    try {
      return await give("internal", true);
    } catch {
      return held("internal", reserved.messagesLeft);
    }
  }
}
