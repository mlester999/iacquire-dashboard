import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { checkOrgAutomation } from "@/server/automation/gate";
import { createApproval } from "@/server/approvals/service";
import { notifyOrgRoles } from "@/server/notifications";
import { isSwitching, assertNativeOwner } from "@/server/crm/workspace";
import { MAX_EVENT_DEPTH } from "@/server/crm/events";
import { callN8nWorkflow, type N8nCallResult } from "@/server/integrations/n8n-actions";
import { performOutbound } from "@/server/automation-studio/outbound";
import { executeStep, stepLabel, type ExternalCall, type StepContext, type StepOutcome } from "@/server/crm/workflows/executors";
import {
  RUN_COLUMNS, StepFailure, VERSION_COLUMNS, attemptKeyFor, backoffMs, effectKeyFor, iso, isPremiumVersion, isRetryable, loadApprovalState, notifyWorkflowProblem, publicMessage, versionAuthorized,
  workflowActor, type RunContextData, type RunRow, type VersionRow,
} from "@/server/crm/workflows/engine";
import { studioEntitlement } from "@/server/automation-studio/entitlement";
import { addStudioUsage } from "@/server/automation-studio/usage";
import { createRun } from "@/server/crm/workflows/triggers";
import { latestScheduleSlot } from "@/lib/crm/workflow/time";
import { STEP_KINDS, WORKFLOW_LIMITS, type WorkflowStep } from "@/lib/crm/workflow/spec";

/**
 * The workflow runner, driven by the scheduler tick (job "crmWorkflowRuns"): no timers, no long-running process.
 *
 *  - Due runs are leased with `for update skip locked`; a lease older than two minutes counts as abandoned and is taken over.
 *  - Each step runs in its own transaction: the step's effect and its log row commit together, so a retry never repeats an effect.
 *  - Every step is gated when it runs: the workspace's status, its "workflows" pause, the agency pause, a provider switch in progress,
 *    and (for steps that leave iAcquire) the "outbound" pause, plus for n8n steps the "messaging" pause n8n's own gate applies. A gated run
 *    is held, not failed, and continues when the pause lifts; so is a run whose n8n call was refused, unsent, for a reason that passes.
 *  - n8n calls follow the three-phase pattern: claim (a "running" step row) in one transaction, call outside any transaction with the
 *    step's idempotency key, record the answer in another. A call whose outcome can't be confirmed is never retried automatically.
 *  - Failures retry with backoff (1, 2, 4, 8 minutes) up to five attempts, then the run is dead and owners and managers are told.
 */

const LEASE_MS = 2 * 60_000;
const MAX_STEPS_PER_CLAIM = 10;
const HOLD_PAUSED_MS = 15 * 60_000;
const HOLD_SWITCHING_MS = 10 * 60_000;
const HOLD_PROVIDER_MS = 60 * 60_000;
/** A run of an Automation Studio workflow whose workspace has no active plan: held (never failed), looked at again every hour. */
const HOLD_PLAN_MS = 60 * 60_000;
const SCHEDULE_CATCH_UP_MS = 12 * 3_600_000;
/** How long one claim keeps working through steps before giving the run back (well inside the two-minute lease). */
const CLAIM_WORK_MS = 60_000;

export interface RunnerResult {
  scheduled: number;
  claimed: number;
  steps: number;
  completed: number;
  failed: number;
}

type Advance = { kind: "continue" | "stop" | "lost"; executed: number; finished?: "completed" | "failed" | "dead" | "cancelled" };

interface ExternalPlan {
  runId: string;
  rowId: number;
  stepKey: string;
  attempt: number;
  call: ExternalCall;
}

interface State {
  run: RunRow;
  version: VersionRow;
  workflow: { id: string; name: string; status: string };
  org: { id: string; name: string; timezone: string };
}

async function loadState(db: Queryable, runId: string): Promise<State | null> {
  const run = (await db.query<RunRow>(`select ${RUN_COLUMNS} from crm_workflow_runs r where r.id = $1 for update`, [runId])).rows[0];
  if (!run) return null;
  const version = (await db.query<VersionRow>(`select ${VERSION_COLUMNS} from crm_workflow_versions v where v.id = $1 and v.org_id = $2`, [run.version_id, run.org_id])).rows[0];
  const workflow = (await db.query<{ id: string; name: string; status: string }>("select id, name, status from crm_workflows where id = $1 and org_id = $2", [run.workflow_id, run.org_id])).rows[0];
  const org = (await db.query<{ id: string; name: string; timezone: string }>("select id, name, timezone from organizations where id = $1", [run.org_id])).rows[0];
  if (!version || !workflow || !org) return null;
  return { run: { ...run, context: run.context ?? {} }, version, workflow, org };
}

const ctxJson = (c: RunContextData) => JSON.stringify(c);

async function insertStepRow(db: Queryable, run: RunRow, step: WorkflowStep, r: { attempt: number; effectKey: string; status: string; result?: Record<string, unknown>; error?: string | null; approvalId?: string | null; messageId?: string | null; finished: boolean; now: Date }): Promise<number> {
  // Each attempt of a step visit has its own row; numbering continues after whatever is already logged, so a retry by a person (or a
  // takeover after a crash) never collides with an earlier attempt's row. The effect key itself stays the same.
  const prev = await db.query<{ n: number }>(
    "select coalesce(max(attempt), 0)::int as n from crm_workflow_run_steps where run_id = $1 and org_id = $2 and split_part(idempotency_key, '#', 1) = $3",
    [run.id, run.org_id, r.effectKey],
  );
  r = { ...r, attempt: Math.max(r.attempt, prev.rows[0].n + 1) };
  const { rows } = await db.query<{ id: string }>(
    `insert into crm_workflow_run_steps (org_id, run_id, step_key, kind, attempt, status, idempotency_key, approval_id, message_id, result, error, started_at, finished_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, case when $13::boolean then $12::timestamptz end) returning id`,
    [run.org_id, run.id, step.key, step.kind, Math.min(20, r.attempt), r.status, attemptKeyFor(r.effectKey, r.attempt), r.approvalId ?? null, r.messageId ?? null, JSON.stringify(r.result ?? {}),
      r.error?.slice(0, 500) ?? null, r.now.toISOString(), r.finished],
  );
  return Number(rows[0].id);
}

async function settleStepRow(db: Queryable, rowId: number, r: { status: string; result?: Record<string, unknown>; error?: string | null; messageId?: string | null; now: Date }) {
  await db.query(
    "update crm_workflow_run_steps set status = $2, result = result || $3::jsonb, error = $4, message_id = coalesce($5, message_id), finished_at = $6 where id = $1",
    [rowId, r.status, JSON.stringify(r.result ?? {}), r.error?.slice(0, 500) ?? null, r.messageId ?? null, r.now.toISOString()],
  );
}

/** Parks a run without failing it (a pause, a provider switch); it is due again at `until`. */
async function hold(db: Queryable, run: RunRow, ctx: RunContextData, until: Date, reason: string): Promise<Advance> {
  await db.query(
    "update crm_workflow_runs set status = $2, next_run_at = $3, claimed_at = null, last_error = $4, context = $5 where id = $1",
    [run.id, ctx.wait ? "waiting" : "queued", until.toISOString(), `On hold: ${reason}`.slice(0, 500), ctxJson(ctx)],
  );
  return { kind: "stop", executed: 0 };
}

async function complete(db: Queryable, run: RunRow, ctx: RunContextData, now: Date, executed: number): Promise<Advance> {
  await db.query(
    "update crm_workflow_runs set status = 'completed', current_step = null, finished_at = $2, claimed_at = null, attempts = 0, last_error = null, context = $3 where id = $1",
    [run.id, now.toISOString(), ctxJson(ctx)],
  );
  return { kind: "stop", executed, finished: "completed" };
}

/**
 * What to do about an outside call whose outcome is unknown. Retrying can't help: the same request key only ever gets the same unknown answer
 * (so nothing runs twice), which is why such a run can be skipped but not retried.
 */
const UNKNOWN_NEXT = "It isn't sent again, so it can't run twice. Check whether it ran there (or ask your agency): if it did, skip this step; if it didn't, have it run there, then skip this step.";

async function endRun(db: Queryable, st: State, ctx: RunContextData, status: "failed" | "dead" | "cancelled", message: string, now: Date, executed: number, notify: boolean): Promise<Advance> {
  await db.query(
    "update crm_workflow_runs set status = $2, finished_at = $3, claimed_at = null, last_error = $4, context = $5 where id = $1",
    [st.run.id, status, now.toISOString(), message.slice(0, 500), ctxJson(ctx)],
  );
  if (notify) {
    await notifyWorkflowProblem(db, {
      orgId: st.org.id, workflowId: st.workflow.id, workflowName: st.workflow.name, runId: st.run.id, now,
      title: status === "dead" ? `Workflow "${st.workflow.name}" gave up on a step` : `Workflow "${st.workflow.name}" stopped`,
      body: message,
    });
  }
  return { kind: "stop", executed, finished: status };
}

/** Moves the run on to `next` (or completes it), counting the visit. */
async function advanceTo(db: Queryable, st: State, ctx: RunContextData, next: string | null, now: Date, executed: number, extra: { opportunityId?: string | null } = {}): Promise<Advance> {
  if (extra.opportunityId && extra.opportunityId !== st.run.opportunity_id) {
    await db.query("update crm_workflow_runs set opportunity_id = $2 where id = $1", [st.run.id, extra.opportunityId]);
  }
  delete ctx.wait;
  delete ctx.approval;
  delete ctx.inflight;
  if (!next) return complete(db, st.run, ctx, now, executed);
  const visits = { ...(ctx.visits ?? {}) };
  visits[next] = (visits[next] ?? 0) + 1;
  ctx.visits = visits;
  ctx.visit = { key: next, n: visits[next] };
  if (visits[next] > WORKFLOW_LIMITS.maxVisitsPerStep) {
    ctx.outcome = "visit_limit";
    const label = stepLabel(st.version.steps.find((s) => s.key === next));
    return endRun(db, st, ctx, "failed", `Stopped: this run reached "${label}" ${WORKFLOW_LIMITS.maxVisitsPerStep} times. Check the loop in this workflow.`, now, executed, true);
  }
  await db.query("update crm_workflow_runs set current_step = $2, attempts = 0, last_error = null, context = $3 where id = $1", [st.run.id, next, ctxJson(ctx)]);
  return { kind: "continue", executed };
}

/** Records what a step did and moves the run on. */
async function applyOutcome(db: Queryable, st: State, ctx: RunContextData, step: WorkflowStep, out: Exclude<StepOutcome, { type: "external" }>, rec: { attempt: number; effectKey: string; approvalRowId: number | null; now: Date }): Promise<Advance> {
  const write = async (status: string, result: Record<string, unknown>, messageId?: string | null) => {
    if (rec.approvalRowId) {
      await settleStepRow(db, rec.approvalRowId, { status, result, messageId, now: rec.now });
      return rec.approvalRowId;
    }
    return insertStepRow(db, st.run, step, { attempt: rec.attempt, effectKey: rec.effectKey, status, result, messageId, finished: status !== "waiting", now: rec.now });
  };
  if (out.type === "wait") {
    const rowId = await write("waiting", out.result);
    // Settle a waiting row's finish time later; for now it is open.
    await db.query("update crm_workflow_run_steps set finished_at = null where id = $1", [rowId]);
    delete ctx.approval;
    ctx.wait = { key: step.key, rowId, until: out.until.toISOString() };
    await db.query(
      "update crm_workflow_runs set status = 'waiting', next_run_at = $2, claimed_at = null, attempts = 0, last_error = null, context = $3 where id = $1",
      [st.run.id, out.until.toISOString(), ctxJson(ctx)],
    );
    return { kind: "stop", executed: 1 };
  }
  if (out.type === "end") {
    await write("completed", out.result);
    delete ctx.approval;
    return complete(db, st.run, ctx, rec.now, 1);
  }
  await write(out.status, out.result, out.messageId);
  const next = out.next !== undefined ? out.next : (step.next ?? null);
  return advanceTo(db, st, ctx, next, rec.now, 1, { opportunityId: out.opportunityId });
}

/** One step of one run (or the bookkeeping that resumes it). Returns whether the run can go straight on to its next step. */
async function advance(runId: string, token: string, now: Date): Promise<Advance> {
  let plan = null as ExternalPlan | null;
  let outcome: Advance;
  try {
    outcome = await withSystem(async (db): Promise<Advance> => {
      const st = await loadState(db, runId);
      if (!st || st.run.status !== "running" || iso(st.run.claimed_at) !== token) return { kind: "lost", executed: 0 };
      const { run, version, workflow, org } = st;
      const ctx: RunContextData = { ...run.context };

      if (workflow.status !== "active") return hold(db, run, ctx, new Date(run.next_run_at), "the workflow is paused.");
      // Automation Studio workflows advance only while the workspace has the plan. A lapse pauses the workflows (so this normally never
      // fires), and this is the second layer for the minutes between a lapse and that pause. Held, not failed: nothing is lost.
      const premium = isPremiumVersion(version);
      if (premium) {
        const plan = await studioEntitlement(db, org.id, now);
        if (!plan.entitled) return hold(db, run, ctx, new Date(now.getTime() + HOLD_PLAN_MS), `Automation Studio isn't active for this workspace. ${plan.reason}`);
      }
      if (run.contact_id) {
        const c = await db.query("select 1 from contacts where id = $1 and org_id = $2 and deleted_at is null and archived_at is null", [run.contact_id, org.id]);
        if (!c.rows[0]) return cancelInTx(db, st, ctx, "The contact was archived or deleted, so the workflow stopped for them.", now);
      }
      const gate = await checkOrgAutomation(db, org.id, "workflows");
      if (!gate.allowed) return hold(db, run, ctx, new Date(now.getTime() + HOLD_PAUSED_MS), gate.detail);
      if (await isSwitching(db, org.id)) return hold(db, run, ctx, new Date(now.getTime() + HOLD_SWITCHING_MS), "this workspace is switching CRM providers.");
      try {
        await assertNativeOwner(db, org.id, "workflows");
      } catch (err) {
        if (err instanceof AppError) return hold(db, run, ctx, new Date(now.getTime() + HOLD_PROVIDER_MS), "automations are managed in GoHighLevel for this workspace.");
        throw err;
      }
      if (!run.current_step) return complete(db, run, ctx, now, 0);
      const step = version.steps.find((s) => s.key === run.current_step);
      if (!step) return endRun(db, st, ctx, "failed", "The step this run was on is not part of its version.", now, 0, true);
      const visit = ctx.visit?.key === step.key ? ctx.visit.n : 1;
      const effectKey = effectKeyFor(run.id, step.key, visit);
      const attempt = run.attempts + 1;

      // A wait in progress: wake up, or go back to sleep until its time.
      if (ctx.wait && ctx.wait.key === step.key) {
        const until = new Date(ctx.wait.until);
        if (until.getTime() > now.getTime()) {
          await db.query("update crm_workflow_runs set status = 'waiting', next_run_at = $2, claimed_at = null, context = $3 where id = $1", [run.id, until.toISOString(), ctxJson(ctx)]);
          return { kind: "stop", executed: 0 };
        }
        await settleStepRow(db, ctx.wait.rowId, { status: "completed", result: { wokeAt: now.toISOString() }, now });
        return advanceTo(db, st, ctx, step.next ?? null, now, 0);
      }

      // A claimed external call that is still marked running: its outcome is unknown, and it is never repeated blindly.
      if (ctx.inflight && ctx.inflight.key === step.key) {
        const row = (await db.query<{ status: string }>("select status from crm_workflow_run_steps where id = $1", [ctx.inflight.rowId])).rows[0];
        delete ctx.inflight;
        if (row?.status === "running") {
          const message = `We couldn't confirm whether "${stepLabel(step)}" reached the other system (the worker stopped mid-call). ${UNKNOWN_NEXT}`;
          await settleStepRow(db, Number(run.context.inflight!.rowId), { status: "failed", result: { outcome: "unknown" }, error: message, now });
          await db.query("update crm_workflow_runs set attempts = $2 where id = $1", [run.id, Math.min(50, attempt)]);
          // Retrying would send the same request key, which only ever gets the same unknown answer, so the run offers skipping instead.
          ctx.outcome = "external_unknown";
          return endRun(db, st, ctx, "failed", message, now, 0, true);
        }
      }

      // A step that waits for a person's approval.
      let approvalGranted = false;
      let approvalRowId: number | null = null;
      if (ctx.approval && ctx.approval.key === step.key) {
        const a = await loadApprovalState(db, org.id, ctx.approval.approvalId);
        if (a?.status === "approved") {
          approvalGranted = true;
          const row = (await db.query<{ status: string }>("select status from crm_workflow_run_steps where id = $1", [ctx.approval.rowId])).rows[0];
          approvalRowId = row?.status === "awaiting_approval" ? ctx.approval.rowId : null;
        } else if (a?.status === "pending" && (!a.expires_at || new Date(a.expires_at).getTime() > now.getTime())) {
          await db.query("update crm_workflow_runs set status = 'awaiting_approval', claimed_at = null, context = $2 where id = $1", [run.id, ctxJson(ctx)]);
          return { kind: "stop", executed: 0 };
        } else {
          await settleStepRow(db, ctx.approval.rowId, { status: "cancelled", error: "The approval wasn't given.", now });
          return cancelInTx(db, st, ctx, `"${stepLabel(step)}" needed a person's approval, which was ${a?.status === "rejected" ? "rejected" : "not given in time"}, so the run stopped.`, now);
        }
      }

      if ((ctx.executed ?? 0) >= WORKFLOW_LIMITS.maxStepsPerRun) {
        ctx.outcome = "step_limit";
        return endRun(db, st, ctx, "failed", `Stopped: this run executed ${WORKFLOW_LIMITS.maxStepsPerRun} steps. Check the loops in this workflow.`, now, 0, true);
      }

      if (step.requireApproval && !approvalGranted) {
        const contact = run.contact_id ? (await db.query<{ n: string }>("select display_name as n from contacts where id = $1", [run.contact_id])).rows[0]?.n ?? null : null;
        const approvalId = await createApproval(db, {
          orgId: org.id, kind: "workflow_action", title: `Workflow "${workflow.name}": ${stepLabel(step)}${contact ? ` for ${contact}` : ""}`.slice(0, 200),
          action: { runId: run.id, stepKey: step.key, visit, workflowId: workflow.id }, targetType: "crm_workflow_run", targetId: run.id, targetLabel: contact ?? workflow.name,
          reason: `The workflow "${workflow.name}" is set to ask before this step runs.`, expectedEffect: `${STEP_KINDS[step.kind].description} Rejecting it stops this run.`,
          risk: "medium", idempotencyKey: `wf-step:${effectKey}`, actorKind: "system",
        });
        const id = approvalId ?? (await db.query<{ id: string }>("select id from approval_requests where idempotency_key = $1", [`wf-step:${effectKey}`])).rows[0]?.id;
        if (!id) throw new StepFailure("The approval request couldn't be created.", { retryable: true });
        const rowId = await insertStepRow(db, run, step, { attempt, effectKey, status: "awaiting_approval", approvalId: id, result: { detail: "Waiting for a person's approval in the Approval Center." }, finished: false, now });
        ctx.approval = { key: step.key, rowId, approvalId: id };
        await db.query("update crm_workflow_runs set status = 'awaiting_approval', claimed_at = null, context = $2 where id = $1", [run.id, ctxJson(ctx)]);
        await notifyOrgRoles(db, org.id, ["owner", "admin"], { kind: "approval_requested", severity: "info", title: `A workflow step is waiting for your approval`, body: `${workflow.name}: ${stepLabel(step)}${contact ? ` for ${contact}` : ""}.`, link: "/approvals", dedupeKey: `wf-step-approval:${id}` });
        return { kind: "stop", executed: 0 };
      }

      const causedBy = run.trigger_event_id ? { eventId: Number(run.trigger_event_id), depth: run.depth } : null;
      // Loop limit: a change here would record an event deeper than the outbox accepts, so it would be invisible to the automations it
      // feeds. The chain stops here instead.
      if (STEP_KINDS[step.kind].emitsEvents && causedBy && causedBy.depth >= MAX_EVENT_DEPTH) {
        ctx.outcome = "loop_limit";
        const message = `Stopped at "${stepLabel(step)}": ${MAX_EVENT_DEPTH} automated steps in a row reacted to each other's changes, which looks like a loop. Nothing was changed by this step.`;
        await insertStepRow(db, run, step, { attempt, effectKey, status: "skipped", result: { outcome: "loop_limit", depth: run.depth }, error: message, finished: true, now });
        await db.query("update crm_workflow_runs set attempts = $2 where id = $1", [run.id, Math.min(50, attempt)]);
        return endRun(db, st, ctx, "failed", message, now, 0, true);
      }
      if (STEP_KINDS[step.kind].external || step.kind === "webhook") {
        const out = await checkOrgAutomation(db, org.id, "outbound");
        if (!out.allowed) return hold(db, run, ctx, new Date(now.getTime() + HOLD_PAUSED_MS), out.detail);
        // n8n's own gate also refuses while customer messaging is paused: hold here instead of calling it to be refused.
        if (step.kind === "n8n") {
          const messaging = await checkOrgAutomation(db, org.id, "messaging");
          if (!messaging.allowed) return hold(db, run, ctx, new Date(now.getTime() + HOLD_PAUSED_MS), messaging.detail);
        }
      }

      const approval = await loadApprovalState(db, org.id, version.approval_id);
      const sc: StepContext = {
        db, org, workflow: { id: workflow.id, name: workflow.name },
        version: { id: version.id, version: version.version, approvalId: version.approval_id, authorized: versionAuthorized(version, approval, now) },
        run: { id: run.id, startedVia: run.started_via, contactId: run.contact_id, opportunityId: run.opportunity_id, createdAt: new Date(run.created_at), context: ctx, triggerEventId: run.trigger_event_id ? Number(run.trigger_event_id) : null, depth: run.depth },
        actor: workflowActor(org, workflow.name), causedBy, effectKey, visit, now, dryRun: false,
      };
      const out = await executeStep(sc, step);
      ctx.executed = (ctx.executed ?? 0) + 1;
      if (premium) {
        // Counted in the step's own transaction, so a step that rolls back is not counted.
        await addStudioUsage(db, org.id, "steps_executed", 1, { at: now });
        if (step.kind === "ai_task" && out.type === "done" && out.result.status === "queued") await addStudioUsage(db, org.id, "employee_invocations", 1, { at: now });
        if (out.type === "external" || (step.kind === "webhook" && out.type === "done" && out.result.deliveryId)) await addStudioUsage(db, org.id, "integration_calls", 1, { at: now });
      }
      if (out.type === "external") {
        // Phase one: the claim. The step row says "running" until the answer is recorded.
        const rowId = approvalRowId ?? (await insertStepRow(db, run, step, { attempt, effectKey, status: "running", result: out.result, finished: false, now }));
        if (approvalRowId) await db.query("update crm_workflow_run_steps set status = 'running' where id = $1", [approvalRowId]);
        delete ctx.approval;
        ctx.inflight = { key: step.key, rowId };
        await db.query("update crm_workflow_runs set context = $2 where id = $1", [run.id, ctxJson(ctx)]);
        plan = { runId: run.id, rowId, stepKey: step.key, attempt, call: out.call };
        return { kind: "stop", executed: 0 };
      }
      return applyOutcome(db, st, ctx, step, out, { attempt, effectKey, approvalRowId, now });
    });
  } catch (err) {
    return recordFailure(runId, token, now, err);
  }
  if (plan) return finishExternal(plan, token, now);
  return outcome;
}

async function cancelInTx(db: Queryable, st: State, ctx: RunContextData, message: string, now: Date): Promise<Advance> {
  await db.query("update crm_workflow_run_steps set status = 'cancelled', finished_at = $2 where run_id = $1 and status in ('waiting', 'awaiting_approval')", [st.run.id, now.toISOString()]);
  return endRun(db, st, ctx, "cancelled", message, now, 0, false);
}

/** A step threw: log the attempt, then retry with backoff, or give the run up. Runs in its own transaction (the step's rolled back). */
async function recordFailure(runId: string, token: string, now: Date, err: unknown): Promise<Advance> {
  return withSystem(async (db) => {
    const st = await loadState(db, runId);
    if (!st || st.run.status !== "running" || iso(st.run.claimed_at) !== token) return { kind: "lost", executed: 0 };
    const { run, version } = st;
    const ctx: RunContextData = { ...run.context };
    const step = version.steps.find((s) => s.key === run.current_step);
    const attempt = run.attempts + 1;
    const retryable = isRetryable(err);
    const message = publicMessage(err);
    if (!(err instanceof AppError) && !(err instanceof StepFailure) && process.env.NODE_ENV !== "test") {
      console.error("[iacquire] workflow step failed", { type: err instanceof Error ? err.name : "unknown", code: (err as { code?: string })?.code ?? null });
    }
    if (step) {
      const visit = ctx.visit?.key === step.key ? ctx.visit.n : 1;
      const effectKey = effectKeyFor(run.id, step.key, visit);
      const pendingApprovalRow = ctx.approval?.key === step.key ? ctx.approval.rowId : null;
      const awaiting = pendingApprovalRow ? (await db.query<{ status: string }>("select status from crm_workflow_run_steps where id = $1", [pendingApprovalRow])).rows[0]?.status === "awaiting_approval" : false;
      if (awaiting) await settleStepRow(db, pendingApprovalRow!, { status: "failed", error: message, now });
      else await insertStepRow(db, run, step, { attempt, effectKey, status: "failed", error: message, result: { retryable }, finished: true, now });
    }
    const premium = isPremiumVersion(version);
    if (premium) await addStudioUsage(db, run.org_id, "step_failures", 1, { at: now });
    if (!retryable || attempt >= WORKFLOW_LIMITS.maxAttempts) {
      await db.query("update crm_workflow_runs set attempts = $2 where id = $1", [run.id, Math.min(50, attempt)]);
      const label = stepLabel(step);
      return endRun(db, st, ctx, retryable ? "dead" : "failed", retryable ? `"${label}" failed ${attempt} times and was given up: ${message}` : `"${label}" failed: ${message}`, now, 0, true);
    }
    if (premium) await addStudioUsage(db, run.org_id, "step_retries", 1, { at: now });
    await db.query(
      "update crm_workflow_runs set status = 'queued', attempts = $2, next_run_at = $3, claimed_at = null, last_error = $4, context = $5 where id = $1",
      [run.id, attempt, new Date(now.getTime() + backoffMs(attempt)).toISOString(), message.slice(0, 500), ctxJson(ctx)],
    );
    return { kind: "stop", executed: 0 };
  });
}

/** Phases two and three of an n8n step: the call (outside any transaction), then recording its answer. */
async function finishExternal(plan: ExternalPlan, token: string, now: Date): Promise<Advance> {
  let result: N8nCallResult | null = null;
  let extra: Record<string, unknown> = {};
  let retryAfterMs = 0;
  let thrown: unknown = null;
  const where = plan.call.kind === "n8n" ? "n8n" : "the other system";
  try {
    if (plan.call.kind === "n8n") result = await callN8nWorkflow(plan.call.input);
    else {
      const out = await performOutbound(plan.call.input);
      result = { status: out.status, retryable: out.retryable, detail: out.detail, httpStatus: out.httpStatus };
      extra = out.record;
      retryAfterMs = Math.min(3_600_000, (out.retryAfterSeconds ?? 0) * 1000);
    }
  } catch (err) {
    thrown = err;
  }
  return withSystem(async (db) => {
    // A refusal before anything was sent (bad input) is definite; any other error could have happened after sending.
    const status = result?.status ?? (thrown instanceof AppError ? "blocked" : "unknown");
    const detail = result?.detail ?? (thrown instanceof AppError ? thrown.message : "The call ended without a clear answer.");
    const sent = status === "sent";
    const retryable = !sent && (status === "not_sent" || status === "rejected") && result?.retryable === true;
    // Refused before anything was sent, for a reason that passes (a pause, a connection that needs attention, a trigger not set up yet):
    // the run is held like under a workspace pause and the step is tried again later, without using up an attempt.
    const held = status === "blocked" && result?.retryable === true;
    await settleStepRow(db, plan.rowId, {
      status: sent ? "completed" : held ? "cancelled" : "failed",
      result: { status, detail, httpStatus: result?.httpStatus ?? null, duplicate: result?.duplicate ?? false, ...extra },
      error: sent ? null : held ? `Not started: ${detail} The run is on hold and tries this step again later.` : detail,
      now,
    });
    const st = await loadState(db, plan.runId);
    // Cancelled (or taken over) while the call was out: the answer is recorded on the step, and the run is left as it is.
    if (!st || st.run.status !== "running" || iso(st.run.claimed_at) !== token) return { kind: "lost", executed: 1 };
    const ctx: RunContextData = { ...st.run.context };
    delete ctx.inflight;
    if (held) {
      ctx.executed = Math.max(0, (ctx.executed ?? 1) - 1);
      return hold(db, st.run, ctx, new Date(now.getTime() + HOLD_PAUSED_MS), detail);
    }
    if (!sent) await db.query("update crm_workflow_runs set attempts = greatest(attempts, $2) where id = $1", [st.run.id, Math.min(50, plan.attempt)]);
    const step = st.version.steps.find((s) => s.key === plan.stepKey);
    if (sent) return advanceTo(db, st, ctx, step?.next ?? null, now, 1);
    const label = stepLabel(step);
    if (status === "unknown") {
      ctx.outcome = "external_unknown";
      return endRun(db, st, ctx, "failed", `We couldn't confirm whether ${where} ran "${label}" (${detail}). ${UNKNOWN_NEXT}`, now, 1, true);
    }
    if (retryable && plan.attempt < WORKFLOW_LIMITS.maxAttempts) {
      await db.query(
        "update crm_workflow_runs set status = 'queued', attempts = $2, next_run_at = $3, claimed_at = null, last_error = $4, context = $5 where id = $1",
        [st.run.id, plan.attempt, new Date(now.getTime() + Math.max(backoffMs(plan.attempt), retryAfterMs)).toISOString(), detail.slice(0, 500), ctxJson(ctx)],
      );
      return { kind: "stop", executed: 1 };
    }
    await db.query("update crm_workflow_runs set attempts = $2 where id = $1", [st.run.id, plan.attempt]);
    return endRun(db, st, ctx, retryable ? "dead" : "failed", `"${label}" didn't run in ${where}: ${detail}`, now, 1, true);
  });
}

// ---------------------------------------------------------------------------
// Schedules and housekeeping
// ---------------------------------------------------------------------------

interface ScheduledWorkflow {
  id: string;
  org_id: string;
  name: string;
  hourly_run_limit: number;
  version_id: string;
  trigger_config: { schedule?: { frequency: "daily" | "weekly"; time: string; weekdays?: number[] } };
  steps: WorkflowStep[];
  published_at: Date;
  approved_at: Date | null;
  effects: string[];
  premium_features: string[];
  content_hash: string;
  approved_hash: string | null;
  approval_id: string | null;
  timezone: string;
}

/**
 * Starts scheduled workflows whose latest slot has come: once per slot, in the workspace's time zone. A slot from before the version was
 * published (or approved), or more than 12 hours old, is not caught up. Which slots already ran is read in one query, so a tick only opens
 * a transaction for a workflow that is actually due.
 */
export async function fireSchedules(now = new Date(), limit = 50): Promise<number> {
  const all = await withSystem((db) =>
    db.query<ScheduledWorkflow>(
      `select w.id, w.org_id, w.name, w.hourly_run_limit, v.id as version_id, v.trigger_config, v.steps, v.published_at, v.approved_at, v.effects, v.premium_features, v.content_hash, v.approved_hash, v.approval_id, o.timezone
       from crm_workflows w join crm_workflow_versions v on v.id = w.published_version_id and v.org_id = w.org_id join organizations o on o.id = w.org_id
       where w.status = 'active' and v.trigger_config->>'type' = 'schedule' and o.status not in ('suspended', 'archived') order by w.id limit 5000`,
    ),
  );
  const candidates: Array<{ w: ScheduledWorkflow; slot: Date }> = [];
  for (const w of all.rows) {
    const schedule = w.trigger_config.schedule;
    if (!schedule) continue;
    const slot = latestScheduleSlot(now, schedule, w.timezone || "UTC");
    if (!slot) continue;
    const since = Math.max(new Date(w.published_at).getTime(), w.approved_at ? new Date(w.approved_at).getTime() : 0);
    if (slot.getTime() <= since || now.getTime() - slot.getTime() > SCHEDULE_CATCH_UP_MS) continue;
    candidates.push({ w, slot });
  }
  if (!candidates.length) return 0;
  const fired = await withSystem((db) =>
    db.query<{ workflow_id: string; slot: string }>(
      `select r.workflow_id, r.context->>'slot' as slot from crm_workflow_runs r
       join unnest($1::uuid[], $2::uuid[]) as k(org_id, workflow_id) on r.org_id = k.org_id and r.workflow_id = k.workflow_id
       where r.started_via = 'schedule' and r.created_at > $3::timestamptz - interval '13 hours'`,
      [candidates.map((c) => c.w.org_id), candidates.map((c) => c.w.id), now.toISOString()],
    ),
  );
  const done = new Set(fired.rows.map((r) => `${r.workflow_id}|${r.slot}`));
  let started = 0;
  for (const { w, slot } of candidates.filter((c) => !done.has(`${c.w.id}|${c.slot.toISOString()}`)).slice(0, limit)) {
    started += await withSystem(async (db) => {
      await db.query("select 1 from crm_workflows where id = $1 for update", [w.id]);
      const approval = await loadApprovalState(db, w.org_id, w.approval_id);
      if (!versionAuthorized(w, approval, now)) return 0;
      // Checked again under the workflow's lock, so two ticks can't both start the same slot.
      const exists = await db.query("select 1 from crm_workflow_runs where org_id = $1 and workflow_id = $2 and started_via = 'schedule' and context->>'slot' = $3", [w.org_id, w.id, slot.toISOString()]);
      if (exists.rows[0]) return 0;
      const r = await createRun(db, { orgId: w.org_id, workflowId: w.id, workflowName: w.name, hourlyRunLimit: w.hourly_run_limit, versionId: w.version_id, steps: w.steps, startedVia: "schedule", premium: isPremiumVersion(w), now, context: { slot: slot.toISOString(), trigger: { type: "schedule", payload: { slot: slot.toISOString() } } } });
      return r.status === "created" ? 1 : 0;
    });
  }
  return started;
}

/**
 * Housekeeping (tick job "crmWorkflowRecovery", every few minutes): runs a worker stopped working on (a lease older than two minutes) go
 * back to the queue, where the next pass picks them up (an n8n call that was in flight is then recorded as unknown, never repeated); and
 * runs waiting for a step approval that expired or was withdrawn are cancelled (a rejection is handled when it is decided).
 */
export async function recoverAbandonedRuns(now = new Date()): Promise<{ recovered: number; lapsed: number }> {
  return withSystem(async (db) => {
    const recovered = await db.query(
      `update crm_workflow_runs set status = case when context ? 'wait' then 'waiting' else 'queued' end, claimed_at = null, next_run_at = least(next_run_at, $1)
       where id in (select id from crm_workflow_runs where status = 'running' and claimed_at < $1::timestamptz - make_interval(secs => $2) limit 500 for update skip locked)`,
      [now.toISOString(), LEASE_MS / 1000],
    );
    const { rows } = await db.query<{ run_id: string; step_id: string }>(
      `select r.id as run_id, s.id as step_id from crm_workflow_runs r
       join crm_workflow_run_steps s on s.run_id = r.id and s.org_id = r.org_id and s.status = 'awaiting_approval'
       join approval_requests a on a.id = s.approval_id and a.org_id = r.org_id
       where r.status = 'awaiting_approval' and (a.status in ('expired', 'cancelled', 'rejected', 'changes_requested') or (a.status = 'pending' and a.expires_at <= $1))
       limit 200`,
      [now.toISOString()],
    );
    for (const r of rows) {
      await db.query("update crm_workflow_run_steps set status = 'cancelled', error = 'The approval wasn''t given in time.', finished_at = $2 where id = $1 and status = 'awaiting_approval'", [r.step_id, now.toISOString()]);
      await db.query(
        "update crm_workflow_runs set status = 'cancelled', finished_at = $2, claimed_at = null, last_error = 'A step needed a person''s approval, which wasn''t given in time, so the run stopped.' where id = $1 and status = 'awaiting_approval'",
        [r.run_id, now.toISOString()],
      );
    }
    return { recovered: recovered.rowCount, lapsed: rows.length };
  });
}

/**
 * Leases due runs, fairly across workspaces. A workspace's due runs are ranked oldest first (1, 2, 3…) and the tick takes them rank by
 * rank across all workspaces, so one workspace with a large backlog cannot use every slot while another's single run waits. A workspace
 * that is alone still gets the whole tick: the fill is round-robin, not a per-workspace cap. A run whose workflow is paused or archived is
 * not taken (it holds), and rows another worker already holds are skipped.
 *
 * The ranking reads the due rows through the partial index on next_run_at; the rows chosen are then locked with `for update skip locked`
 * and re-checked, so two overlapping ticks can never lease the same run.
 */
async function claimRuns(now: Date, limit: number): Promise<Array<{ id: string; token: string; orgId: string }>> {
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; org_id: string; claimed_at: Date; next_run_at: Date }>(
      `update crm_workflow_runs r set status = 'running', claimed_at = $1 where r.id in (
         select z.id from crm_workflow_runs z
         where z.status in ('queued', 'waiting') and z.next_run_at <= $1 and z.id in (
           select ranked.id from (
             select y.id, y.next_run_at, row_number() over (partition by y.org_id order by y.next_run_at, y.id) as rank
             from crm_workflow_runs y join crm_workflows w on w.id = y.workflow_id and w.org_id = y.org_id
             where y.status in ('queued', 'waiting') and y.next_run_at <= $1 and w.status = 'active'
           ) ranked order by ranked.rank, ranked.next_run_at, ranked.id limit $2)
         for update of z skip locked)
       returning r.id, r.org_id, r.claimed_at, r.next_run_at`,
      [now.toISOString(), limit],
    );
    // Work through them in the same fair order: oldest first within a workspace, one workspace after another, so a tick that runs out of time
    // gives back the tail of every workspace's share rather than all of one's.
    const byOrg = new Map<string, typeof rows>();
    for (const r of rows) byOrg.set(r.org_id, [...(byOrg.get(r.org_id) ?? []), r]);
    for (const list of byOrg.values()) list.sort((a, b) => new Date(a.next_run_at).getTime() - new Date(b.next_run_at).getTime() || a.id.localeCompare(b.id));
    const ordered: Array<{ id: string; token: string; orgId: string }> = [];
    for (let round = 0; ordered.length < rows.length; round++) {
      for (const list of byOrg.values()) if (list[round]) ordered.push({ id: list[round].id, token: iso(list[round].claimed_at)!, orgId: list[round].org_id });
    }
    return ordered;
  });
}

async function release(runId: string, token: string, now: Date) {
  await withSystem((db) =>
    db.query(
      "update crm_workflow_runs set status = case when context ? 'wait' then 'waiting' else 'queued' end, claimed_at = null, next_run_at = least(next_run_at, $3) where id = $1 and status = 'running' and claimed_at = $2",
      [runId, token, now.toISOString()],
    ),
  );
}

/**
 * The tick job: starts due schedules, then advances due runs a few steps each. Small batches; it stops taking new runs when its share of
 * the tick's time is used, and gives a run back before its lease could look abandoned.
 */
export async function processWorkflowRuns(opts: { limit?: number; now?: Date; budgetMs?: number } = {}): Promise<RunnerResult> {
  const started = Date.now();
  const budget = opts.budgetMs ?? 25_000;
  const clock = () => opts.now ?? new Date();
  const out: RunnerResult = { scheduled: 0, claimed: 0, steps: 0, completed: 0, failed: 0 };
  out.scheduled = await fireSchedules(clock());
  const claimed = await claimRuns(clock(), Math.min(100, opts.limit ?? 25));
  out.claimed = claimed.length;
  for (const c of claimed) {
    if (Date.now() - started > budget) {
      await release(c.id, c.token, clock());
      continue;
    }
    const claimStarted = Date.now();
    let last: Advance = { kind: "continue", executed: 0 };
    for (let i = 0; i < MAX_STEPS_PER_CLAIM && last.kind === "continue" && Date.now() - claimStarted < CLAIM_WORK_MS; i++) {
      last = await advance(c.id, c.token, clock());
      out.steps += last.executed;
    }
    if (last.finished === "completed") out.completed += 1;
    if (last.finished === "failed" || last.finished === "dead") out.failed += 1;
    if (last.kind === "continue") await release(c.id, c.token, clock());
  }
  return out;
}
