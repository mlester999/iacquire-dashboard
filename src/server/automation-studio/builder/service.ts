import "server-only";
import crypto from "node:crypto";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { assertCan, auditActor, type CrmActor } from "@/server/crm/actor";
import { loadBuilderOptions } from "@/server/crm/workflows/context";
import { saveDraftInTx } from "@/server/crm/workflows/definitions";
import { llmStream, resolveLlmConfigDetailed, type LlmConfig, type LlmResolution, type LlmStreamEvent, type LlmStreamInput } from "@/server/llm/client";
import { assertStudioEntitled } from "@/server/automation-studio/entitlement";
import { addStudioUsage, admitBuilderMessage } from "@/server/automation-studio/usage";
import { insertMessage, listMessages, recentChangeLabels, recordChange } from "@/server/automation-studio/studio";
import { countSuspicious, modelEndpointProblem, newDataNonce } from "@/server/automation-studio/builder/guard";
import { ReplyStreamer, parseOperationsJson } from "@/server/automation-studio/builder/output";
import { NO_OPERATIONS_REFUSAL, claimsChange } from "@/server/automation-studio/builder/claims";
import { buildMessages, buildSystemPrompt, definitionForModel, repairMessage, type BuilderContext, type RunProblem } from "@/server/automation-studio/builder/prompt";
import { applyOperations, parseOperations, type WorkflowChange, type WorkflowOperation } from "@/lib/crm/workflow/operations";
import { parseDefinition, validateDefinition, validationContextFrom, type ValidationIssue, type WorkflowDefinition } from "@/lib/crm/workflow/spec";
import type { BuilderAvailability, BuilderEvent, StudioMessage } from "@/lib/automation-studio/types";

/**
 * One turn with the AI Automation Builder: the person says what they want (or asks a question), the model answers and may propose operations, the
 * server validates and applies them in strict mode to the CURRENT working copy (manual edits included), saves it, and tells the canvas exactly what
 * changed. Nothing the model writes is executed; a proposal the server refuses changes nothing, and the model is shown why so it can correct itself
 * a limited number of times before the person is told honestly what happened.
 *
 * The stream only reports what really happened: "applied" is sent after the change is saved, the reply the person finally sees is the one that was
 * stored, and a refused or failed turn says so.
 */

export const MAX_REPAIRS = 2;
const MAX_MESSAGE = 4000;
const MAX_OUTPUT_TOKENS = 3500;
const PROVIDER_TIMEOUT_MS = 90_000;

export interface LlmPort {
  resolve(): Promise<LlmResolution>;
  stream(config: LlmConfig, input: LlmStreamInput, signal?: AbortSignal): AsyncGenerator<LlmStreamEvent>;
}

/** The deployment's model connection (Integrations → AI model). Tests and the isolated browser QA point it at a loopback double. */
export const realLlm: LlmPort = { resolve: resolveLlmConfigDetailed, stream: llmStream };

const UNAVAILABLE_REASON: Record<string, string> = {
  not_configured: "The AI model isn't connected for this deployment yet.",
  status_not_eligible: "The AI model connection hasn't passed its check yet.",
  missing_credential: "The AI model connection has no credential yet.",
  credential_unavailable: "The AI model connection's credential can't be read right now.",
  invalid_config: "The AI model connection is incomplete.",
  endpoint_not_allowed: "The AI model address isn't on the approved list.",
  database_unavailable: "The AI model connection can't be checked right now.",
};

/**
 * Whether the builder can answer, and if not why in words. A model connection that is not a real, public one is refused in production (a loopback or
 * private address is where a test double would listen): the builder then says it is unavailable instead of answering from it.
 */
export async function builderAvailability(llm: LlmPort = realLlm): Promise<BuilderAvailability> {
  const r = await llm.resolve();
  if (!r.config) return { available: false, reason: `${UNAVAILABLE_REASON[r.reason] ?? "The AI model isn't available right now."} You can still build by hand.` };
  const problem = modelEndpointProblem(r.config.baseUrl);
  return problem ? { available: false, reason: `${problem} You can still build by hand.` } : { available: true, reason: null };
}

async function recentProblems(db: Queryable, orgId: string, workflowId: string, def: WorkflowDefinition): Promise<RunProblem[]> {
  const { rows } = await db.query<{ status: string; current_step: string | null; last_error: string | null; at: Date }>(
    `select status, current_step, last_error, coalesce(finished_at, created_at) as at from crm_workflow_runs
      where org_id = $1 and workflow_id = $2 and status in ('failed', 'dead', 'cancelled') and started_via <> 'test' order by coalesce(finished_at, created_at) desc limit 5`,
    [orgId, workflowId],
  );
  return rows.map((r) => {
    const step = def.steps.find((s) => s.key === r.current_step);
    return { status: r.status, step: step ? step.name?.trim() || step.key : r.current_step, error: r.last_error?.slice(0, 300) ?? null, at: new Date(r.at).toISOString().slice(0, 16).replace("T", " ") };
  });
}

interface Loaded {
  name: string;
  status: string;
  revision: number;
  definition: WorkflowDefinition;
  timezone: string;
}

async function loadWorkflow(db: Queryable, actor: CrmActor, id: string, lock = false): Promise<Loaded> {
  const w = (await db.query<{ name: string; status: string; draft: unknown; draft_revision: number }>(
    `select name, status, draft, draft_revision from crm_workflows where id = $1 and org_id = $2${lock ? " for update" : ""}`,
    [id, actor.orgId],
  )).rows[0];
  if (!w) throw new AppError("not_found", "Workflow not found.");
  if (w.status === "archived") throw new AppError("conflict", "This workflow is archived. Restore it to change it.");
  const tz = (await db.query<{ timezone: string }>("select timezone from organizations where id = $1", [actor.orgId])).rows[0]?.timezone ?? "UTC";
  const raw = w.draft as { trigger?: unknown; steps?: unknown } | null;
  const definition = raw && typeof raw === "object" && raw.trigger && Array.isArray(raw.steps) ? (raw as WorkflowDefinition) : ({ trigger: { type: "contact.created" }, steps: [] } as WorkflowDefinition);
  return { name: w.name, status: w.status, revision: w.draft_revision, definition, timezone: tz };
}

type Commit =
  | { ok: true; message: StudioMessage; revision: number; definition: WorkflowDefinition; operations: WorkflowOperation[]; changes: WorkflowChange[]; summary: string[]; issues: ValidationIssue[]; rebased: boolean }
  /** `latest`: when the working copy changed while the model was answering, the copy it should correct against. */
  | { ok: false; reason: string; plain: string; latest?: string };

/**
 * An inbound-webhook trigger the model set has no address yet (it can't make one up and is never shown one): the server gives it one. The workflow's
 * existing address is kept when the trigger stays an inbound webhook, so asking again never changes the address a sender already uses. By default the
 * body is matched to a contact by email or phone and no contact is created; the person changes that in the trigger's settings.
 */
export function withInboundAddress(next: WorkflowDefinition, previous: WorkflowDefinition): WorkflowDefinition {
  if (next.trigger.type !== "inbound_webhook" || next.trigger.inbound) return next;
  const kept = previous.trigger.type === "inbound_webhook" ? previous.trigger.inbound : undefined;
  return { ...next, trigger: { ...next.trigger, inbound: kept ?? { nonce: crypto.randomBytes(18).toString("base64url"), match: "email_or_phone", createContact: false } } };
}

/**
 * Applies the model's operations to the working copy as it is right now, in one transaction: lock the workflow, apply in strict mode, save with the
 * revision check, record the change, store the assistant's message. A refusal stores nothing and returns why.
 */
async function commit(actor: CrmActor, workflowId: string, ops: WorkflowOperation[], reply: string, run: { selectedKey: string | null; userMessageId: number; tokensIn: number; tokensOut: number; readRevision: number }): Promise<Commit> {
  return withSystem(async (db) => {
    const options = await loadBuilderOptions(db, actor.orgId);
    const latest = await loadWorkflow(db, actor, workflowId, true);
    // The working copy may have changed while the model was answering (the person kept editing). The proposal is checked against the copy as it is
    // now, never the one the model read; when that makes it fail, the model is shown the current copy to correct itself against.
    const rebased = latest.revision !== run.readRevision;
    const applied = applyOperations(latest.definition, ops, { mode: "strict", context: validationContextFrom(options) });
    if (!applied.ok) {
      const forModel = `${applied.error.message}${applied.error.detail ? ` [${applied.error.detail}]` : ""}${rebased ? " (The workflow was changed while you were working; correct your changes against its current state.)" : ""}`;
      return { ok: false, reason: forModel, plain: applied.error.message, latest: rebased ? definitionForModel(latest.definition) : undefined };
    }
    if (!applied.changes.length) return { ok: false, reason: "Those changes would leave the workflow exactly as it is.", plain: "Those changes would leave the workflow exactly as it is.", latest: rebased ? definitionForModel(latest.definition) : undefined };
    const definition = withInboundAddress(applied.definition, latest.definition);
    const saved = await saveDraftInTx(db, actor, workflowId, definition, latest.revision);
    const summary = applied.summary.filter(Boolean);
    const note = rebased ? " (I applied this on top of the changes you made while I was working.)" : "";
    const content = `${reply.trim() || summary.join(" ")}${note}`.slice(0, 11_000);
    const message = await insertMessage(db, {
      orgId: actor.orgId, workflowId, role: "assistant", content, status: "applied", operations: ops, changes: applied.changes, revisionBefore: latest.revision, revisionAfter: saved.revision,
      inputTokens: run.tokensIn, outputTokens: run.tokensOut, userId: actor.userId,
    });
    await recordChange(db, { orgId: actor.orgId, workflowId, source: "ai", label: summary.join(" ").slice(0, 280) || "Changed by the AI Builder", definition, revision: saved.revision, messageId: message.id, userId: actor.userId });
    await db.query("update automation_studio_messages set status = 'answered' where id = $1 and org_id = $2 and role = 'user'", [run.userMessageId, actor.orgId]);
    await recordAudit({
      orgId: actor.orgId, ...auditActor(actor), action: "automation_studio.builder_applied", targetType: "crm_workflow", targetId: workflowId, result: "success",
      metadata: { revision: saved.revision, operations: ops.length, changes: applied.changes.length, messageId: message.id },
    }, db);
    return { ok: true, message, revision: saved.revision, definition, operations: ops, changes: applied.changes, summary, issues: saved.issues, rebased };
  });
}

const estimateTokens = (chars: number) => Math.ceil(chars / 4);

export interface BuilderTurnInput {
  message?: string;
  selectedKey?: string | null;
  /** Answer the message already stored and still waiting (the one that started the workflow) instead of sending a new one. */
  resume?: boolean;
}

export async function* runBuilderTurn(actor: CrmActor, workflowId: string, input: BuilderTurnInput, llm: LlmPort = realLlm, signal?: AbortSignal): AsyncGenerator<BuilderEvent> {
  assertCan(actor, "workflows.manage", "Building automations needs the automations permission.");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workflowId)) throw new AppError("not_found", "Workflow not found.");
  const selectedKey = input.selectedKey && /^[a-z0-9][a-z0-9_-]{0,39}$/.test(input.selectedKey) ? input.selectedKey : null;
  const typed = (input.message ?? "").trim();
  if (!input.resume && !typed) throw new AppError("invalid_input", "Write what you'd like to change first.");
  if (typed.length > MAX_MESSAGE) throw new AppError("invalid_input", `Keep your message under ${MAX_MESSAGE.toLocaleString("en-US")} characters.`);

  // The plan, the person's rate, the workspace's monthly allowance and the model connection, before anything is asked or stored.
  await withSystem(async (db) => {
    await assertStudioEntitled(db, actor.orgId, "The AI Automation Builder");
    // The workflow must be this workspace's (and open to change) before anything about it is stored.
    await loadWorkflow(db, actor, workflowId);
  });
  const limit = await consumeRateLimit(RATE_LIMITS.studioBuilderByUser, actor.userId ?? actor.orgId);
  if (!limit.allowed) throw new AppError("rate_limited", "You've sent a lot of messages in the last hour. Give it a few minutes, or keep building by hand.", { retryAfterSeconds: limit.retryAfterSeconds });
  const resolution = await llm.resolve();
  if (!resolution.config) throw new AppError("integration_unavailable", `${UNAVAILABLE_REASON[resolution.reason] ?? "The AI model isn't available right now."} Nothing was changed. You can still build by hand.`);
  const config = resolution.config;
  const endpoint = modelEndpointProblem(config.baseUrl);
  if (endpoint) throw new AppError("integration_unavailable", `${endpoint} Nothing was changed. You can still build by hand.`);

  // Store the person's message (or find the waiting one) and count the message against the month's allowance, in one step.
  const prepared = await withSystem(async (db) => {
    const admission = await admitBuilderMessage(db, actor.orgId);
    if (!admission.allowed) throw new AppError("usage_limit", admission.detail);
    let user: StudioMessage;
    if (input.resume) {
      const pending = (await db.query<{ id: string }>("select id from automation_studio_messages where org_id = $1 and workflow_id = $2 and role = 'user' and status = 'pending' order by id desc limit 1", [actor.orgId, workflowId])).rows[0];
      if (!pending) throw new AppError("conflict", "There's nothing waiting for an answer.");
      user = (await listMessages(db, actor.orgId, workflowId, 400)).find((m) => m.id === Number(pending.id))!;
    } else {
      user = await insertMessage(db, { orgId: actor.orgId, workflowId, role: "user", content: typed, nodeKey: selectedKey, status: "pending", userId: actor.userId });
    }
    await addStudioUsage(db, actor.orgId, "builder_messages", 1);
    const history = (await listMessages(db, actor.orgId, workflowId, 40)).filter((m) => m.id < user.id && m.status !== "pending");
    return { user, history };
  });
  yield { type: "start", messageId: prepared.user.id };

  let tokensIn = 0;
  let tokensOut = 0;
  /** Adds what the model used to the workspace's month, once: the stored message carries the figures, this feeds the counters. */
  const finishTokens = async () => {
    const i = tokensIn;
    const o = tokensOut;
    tokensIn = 0;
    tokensOut = 0;
    if (i <= 0 && o <= 0) return;
    await withSystem(async (db) => {
      if (i > 0) await addStudioUsage(db, actor.orgId, "builder_input_tokens", i);
      if (o > 0) await addStudioUsage(db, actor.orgId, "builder_output_tokens", o);
    });
  };
  try {
    yield { type: "status", phase: "reading", text: "Reading your workflow…" };
    const ctxData = await withSystem(async (db) => {
      const wf = await loadWorkflow(db, actor, workflowId);
      const options = await loadBuilderOptions(db, actor.orgId);
      const issues = validateDefinition(wf.definition, validationContextFrom(options));
      return { wf, options, issues, problems: await recentProblems(db, actor.orgId, workflowId, wf.definition), changes: await recentChangeLabels(db, actor.orgId, workflowId) };
    });
    const nonce = newDataNonce();
    const context: BuilderContext = {
      workflowName: ctxData.wf.name, workflowStatus: ctxData.wf.status, definition: ctxData.wf.definition, issues: ctxData.issues, options: ctxData.options,
      recentProblems: ctxData.problems, selectedKey: prepared.user.nodeKey ?? selectedKey, timezone: ctxData.wf.timezone, revision: ctxData.wf.revision, recentChanges: ctxData.changes, nonce,
    };
    // Workspace text that reads like an instruction is cleaned and fenced like all the rest; that it was there is recorded for an administrator.
    const o = ctxData.options;
    const suspicious = countSuspicious([
      ctxData.wf.name, ...o.tags.map((t) => t.name), ...o.templates.map((t) => t.name), ...o.pipelines.flatMap((p) => [p.name, ...p.stages.map((s) => s.name)]), ...o.fields.map((f) => f.label),
      ...(o.forms ?? []).map((f) => f.name), ...o.users.map((u) => u.name), ...ctxData.wf.definition.steps.map((s) => s.name ?? ""), ...ctxData.problems.map((p) => p.error ?? ""),
    ]);
    if (suspicious > 0) {
      await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "automation_studio.builder_suspicious_data", targetType: "crm_workflow", targetId: workflowId, result: "success", metadata: { pieces: suspicious } });
    }
    const system = buildSystemPrompt(context);
    const conversation = buildMessages(prepared.history, prepared.user.content, prepared.user.nodeKey ?? selectedKey);

    let lastReply = "";
    let lastRaw = "";
    let refusal: string | null = null;
    /** What to tell the person when the corrections run out: the plain reason, never the model's own account of a change that was not made. */
    let plainRefusal: string | null = null;
    let refusalLatest: string | undefined;
    for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
      const messages = refusal ? [...conversation, { role: "assistant" as const, content: lastRaw || lastReply || "(no answer)" }, { role: "user" as const, content: repairMessage(refusal, refusalLatest, nonce) }] : conversation;
      yield { type: "status", phase: attempt === 0 ? "thinking" : "checking", text: attempt === 0 ? "Working on it…" : "Checking that against your workspace…" };
      const streamer = new ReplyStreamer();
      // A reply that reads "Done, I added…" is shown only once its operations block has started: until then it is not known to be true.
      let visible = "";
      let shown = 0;
      let held = false;
      let gotUsage = false;
      let callIn = estimateTokens(system.length + messages.reduce((n, m) => n + m.content.length, 0));
      let callOut = 0;
      let writtenChars = 0;
      try {
        for await (const ev of llm.stream(config, { system, messages, maxTokens: MAX_OUTPUT_TOKENS, temperature: 0.2, timeoutMs: PROVIDER_TIMEOUT_MS }, signal)) {
          if (ev.type === "delta") {
            writtenChars += ev.text.length;
            // A repair attempt's reply is not streamed: the person sees the final, stored one.
            visible += streamer.push(ev.text);
            if (attempt === 0) {
              if (!held && claimsChange(visible)) held = true;
              if (held && streamer.hasFence()) held = false;
              // A few characters are waited for, so an opening "Done" is seen before anything is shown.
              if (!held && (visible.length >= 14 || streamer.hasFence()) && visible.length > shown) {
                yield { type: "delta", text: visible.slice(shown) };
                shown = visible.length;
              }
            }
          } else {
            if (ev.inputTokens !== undefined) callIn = ev.inputTokens;
            if (ev.outputTokens !== undefined) callOut = ev.outputTokens;
            gotUsage = true;
          }
        }
      } catch (err) {
        tokensIn += callIn;
        tokensOut += gotUsage ? callOut : estimateTokens(writtenChars);
        if (signal?.aborted) throw err;
        const detail = err instanceof Error && err.name === "LlmStreamError" ? "The AI service didn't answer." : "The AI service ran into a problem.";
        const stored = await withSystem(async (db) => {
          const m = await insertMessage(db, { orgId: actor.orgId, workflowId, role: "assistant", content: `${detail} Nothing was changed. Try again in a moment, or keep building by hand.`, status: "error", inputTokens: callIn, outputTokens: callOut, userId: null });
          await db.query("update automation_studio_messages set status = 'answered' where id = $1 and org_id = $2", [prepared.user.id, actor.orgId]);
          return m;
        });
        await finishTokens();
        yield { type: "error", code: "builder_failed", message: stored.content };
        yield { type: "done", message: stored };
        return;
      }
      tokensIn += callIn;
      tokensOut += gotUsage ? callOut : estimateTokens(writtenChars);
      const out = streamer.finish();
      lastReply = out.reply || lastReply;
      lastRaw = out.raw;

      if (out.truncated) {
        refusal = "your answer was cut off before the operations block was closed";
        plainRefusal = "the answer was cut off";
        continue;
      }
      if (out.operations === null) {
        // No change proposed: an explanation or a question.
        if (!out.reply) {
          refusal = "you wrote nothing; reply to the person";
          plainRefusal = "no answer came back";
          continue;
        }
        // "Done, I added it" with nothing behind it is not shown as an answer: it is corrected, or replaced by the truth.
        if (claimsChange(out.reply)) {
          refusal = NO_OPERATIONS_REFUSAL;
          plainRefusal = "the builder said it had made the change but didn't send it";
          lastReply = "";
          continue;
        }
        const status = /\?/.test(out.reply) ? "clarification" : "answered";
        const stored = await withSystem(async (db) => {
          const m = await insertMessage(db, { orgId: actor.orgId, workflowId, role: "assistant", content: out.reply, status, inputTokens: tokensIn, outputTokens: tokensOut, userId: null });
          await db.query("update automation_studio_messages set status = 'answered' where id = $1 and org_id = $2", [prepared.user.id, actor.orgId]);
          return m;
        });
        await finishTokens();
        yield { type: "done", message: stored };
        return;
      }

      const json = parseOperationsJson(out.operations);
      if (!json.ok) {
        refusal = json.message;
        plainRefusal = "the proposed changes couldn't be read";
        continue;
      }
      const parsed = parseOperations(json.value);
      if (!parsed.ok) {
        refusal = parsed.message;
        plainRefusal = parsed.message;
        continue;
      }
      yield { type: "status", phase: "checking", text: "Checking the changes…" };
      const result = await commit(actor, workflowId, parsed.operations, out.reply, { selectedKey, userMessageId: prepared.user.id, tokensIn, tokensOut, readRevision: ctxData.wf.revision });
      if (!result.ok) {
        refusal = result.reason;
        plainRefusal = result.plain;
        refusalLatest = result.latest;
        continue;
      }
      await finishTokens();
      yield { type: "applied", revision: result.revision, definition: result.definition, operations: result.operations, changes: result.changes, summary: result.summary, issues: result.issues, rebased: result.rebased };
      yield { type: "done", message: result.message };
      return;
    }

    // Still refused after the allowed corrections: say so, honestly, and change nothing.
    // The model's own last reply described a change that was not made, so it is not repeated here.
    const explanation = `I couldn't make that change, so nothing was changed${plainRefusal ? `: ${plainRefusal.replace(/[.!]+$/, "")}.` : "."} You can try saying it another way, or make the change by hand.`;
    const stored = await withSystem(async (db) => {
      const m = await insertMessage(db, { orgId: actor.orgId, workflowId, role: "assistant", content: explanation.slice(0, 11_000), status: "refused", inputTokens: tokensIn, outputTokens: tokensOut, userId: null });
      await db.query("update automation_studio_messages set status = 'answered' where id = $1 and org_id = $2", [prepared.user.id, actor.orgId]);
      return m;
    });
    await finishTokens();
    yield { type: "refused", message: stored.content };
    yield { type: "done", message: stored };
  } finally {
    // Counted even when the person closed the page mid-answer: the model was asked.
    if (signal?.aborted) await finishTokens().catch(() => undefined);
  }

}

/** Parse check shared with tests: does this stored definition still read? */
export const readsFine = (d: unknown) => parseDefinition(d).definition !== null;
