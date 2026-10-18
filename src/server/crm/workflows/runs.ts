import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { assertCan, auditActor, crmRead, type CrmActor } from "@/server/crm/actor";
import { executeStep, stepLabel, type StepContext, type StepOutcome } from "@/server/crm/workflows/executors";
import {
  LIVE_RUN_STATUSES, RUN_COLUMNS, VERSION_COLUMNS, iso, loadApprovalState, publicMessage, versionAuthorized, workflowActor,
  type RunContextData, type RunRow, type RunStatus, type StartedVia, type VersionRow, type WorkflowRow,
} from "@/server/crm/workflows/engine";
import { createRun } from "@/server/crm/workflows/triggers";
import { validateForPublish } from "@/server/crm/workflows/context";
import { TRIGGERS, WORKFLOW_LIMITS, hasErrors, type ValidationIssue, type WorkflowStep } from "@/lib/crm/workflow/spec";

/** Run history, test runs, starting a run by hand, and a person's controls over a run (cancel, retry, skip). */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RunSummary {
  id: string;
  workflowId: string;
  workflowName: string;
  versionId: string;
  version: number;
  status: RunStatus;
  startedVia: StartedVia;
  triggerType: string | null;
  contact: { id: string; name: string } | null;
  opportunity: { id: string; name: string } | null;
  currentStep: { key: string; label: string } | null;
  nextRunAt: string | null;
  attempts: number;
  depth: number;
  lastError: string | null;
  /** Why it ended early, when it did: rate_limited, loop_limit, visit_limit, step_limit. */
  outcome: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface RunStepView {
  id: number;
  stepKey: string;
  kind: string;
  label: string;
  attempt: number;
  status: "running" | "completed" | "skipped" | "failed" | "waiting" | "awaiting_approval" | "cancelled";
  result: Record<string, unknown>;
  error: string | null;
  approvalId: string | null;
  messageId: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface RunDetail extends RunSummary {
  steps: RunStepView[];
  waitingUntil: string | null;
  approvalId: string | null;
  canCancel: boolean;
  canRetry: boolean;
  canSkip: boolean;
}

interface RunListRow extends RunRow {
  workflow_name: string;
  version_number: number;
  version_steps: WorkflowStep[];
  contact_name: string | null;
  opportunity_name: string | null;
}

const LIST_SQL = `
  select ${RUN_COLUMNS}, w.name as workflow_name, v.version as version_number, v.steps as version_steps, c.display_name as contact_name, o.name as opportunity_name
  from crm_workflow_runs r
  join crm_workflows w on w.id = r.workflow_id and w.org_id = r.org_id
  join crm_workflow_versions v on v.id = r.version_id and v.org_id = r.org_id
  left join contacts c on c.id = r.contact_id and c.org_id = r.org_id
  left join crm_opportunities o on o.id = r.opportunity_id and o.org_id = r.org_id`;

const UNKNOWN_OUTCOMES = new Set(["loop_limit", "visit_limit", "step_limit"]);
/**
 * Stopped on an outside call (n8n) whose outcome is unknown. A retry would send the same request key, which the other side's ledger only
 * ever answers with the same unknown result, so Retry is never offered: the person checks the other system and skips the step.
 */
const EXTERNAL_UNKNOWN = "external_unknown";

function toSummary(r: RunListRow): RunSummary {
  const ctx = r.context ?? {};
  const step = r.current_step ? r.version_steps.find((s) => s.key === r.current_step) : null;
  return {
    id: r.id, workflowId: r.workflow_id, workflowName: r.workflow_name, versionId: r.version_id, version: r.version_number, status: r.status, startedVia: r.started_via,
    triggerType: ctx.trigger?.type ?? null,
    contact: r.contact_id ? { id: r.contact_id, name: r.contact_name ?? "Contact" } : null,
    opportunity: r.opportunity_id ? { id: r.opportunity_id, name: r.opportunity_name ?? "Deal" } : null,
    currentStep: r.current_step ? { key: r.current_step, label: stepLabel(step) } : null,
    nextRunAt: LIVE_RUN_STATUSES.includes(r.status) ? iso(r.next_run_at) : null,
    attempts: r.attempts, depth: r.depth, lastError: r.last_error, outcome: ctx.outcome ?? null, createdAt: iso(r.created_at)!, finishedAt: iso(r.finished_at),
  };
}

export interface RunQuery {
  workflowId?: string;
  status?: RunStatus | "live" | "problems";
  contactId?: string;
  startedVia?: StartedVia;
  /** Runs created before this ISO time (the previous page's last createdAt). */
  before?: string | null;
  limit?: number;
}

export async function listRuns(actor: CrmActor, q: RunQuery = {}): Promise<{ items: RunSummary[]; nextBefore: string | null }> {
  assertCan(actor, "workflows.view");
  for (const id of [q.workflowId, q.contactId]) if (id && !UUID.test(id)) return { items: [], nextBefore: null };
  const limit = Math.max(1, Math.min(100, q.limit ?? 50));
  return crmRead(actor, async (db) => {
    const params: unknown[] = [actor.orgId];
    const where = ["r.org_id = $1"];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace("$?", `$${params.length}`));
    };
    if (q.workflowId) add("r.workflow_id = $?", q.workflowId);
    if (q.contactId) add("r.contact_id = $?", q.contactId);
    if (q.startedVia) add("r.started_via = $?", q.startedVia);
    if (q.status === "live") add("r.status = any($?::text[])", LIVE_RUN_STATUSES);
    else if (q.status === "problems") add("r.status = any($?::text[])", ["failed", "dead"]);
    else if (q.status) add("r.status = $?", q.status);
    if (q.before && !Number.isNaN(Date.parse(q.before))) add("r.created_at < $?", new Date(q.before).toISOString());
    params.push(limit + 1);
    const { rows } = await db.query<RunListRow>(`${LIST_SQL} where ${where.join(" and ")} order by r.created_at desc, r.id desc limit $${params.length}`, params);
    const items = rows.slice(0, limit).map(toSummary);
    return { items, nextBefore: rows.length > limit ? items[items.length - 1].createdAt : null };
  });
}

/** Result fields whose text can name the run's contact or deal, or quote its details (an address, a field's value, a message preview). */
const RECORD_TEXT_KEYS = ["detail", "note", "preview", "title", "name", "from", "to"] as const;
const HIDDEN_DETAIL = "Details are hidden: they name a contact or deal, and you don't have access to see contacts and deals.";

/** A step result without the text that names its records, for someone who may see automations but not the contacts and deals they touch. */
function withoutRecordText(result: Record<string, unknown>): Record<string, unknown> {
  const out = { ...result };
  let hidden = false;
  for (const k of RECORD_TEXT_KEYS) {
    if (k in out) {
      delete out[k];
      hidden = true;
    }
  }
  if (hidden) out.detail = HIDDEN_DETAIL;
  return out;
}

export async function getRun(actor: CrmActor, id: string): Promise<RunDetail> {
  assertCan(actor, "workflows.view");
  if (!UUID.test(id)) throw new AppError("not_found", "Run not found.");
  // Step results are written as the workflow, so their text can name records the reader may not see (row-level security only hides the
  // run's own contact and deal names): it is left out unless they can see contacts and deals.
  const seesRecords = actor.can("contacts.view") && actor.can("sales.view");
  return crmRead(actor, async (db) => {
    const r = (await db.query<RunListRow>(`${LIST_SQL} where r.id = $1 and r.org_id = $2`, [id, actor.orgId])).rows[0];
    if (!r) throw new AppError("not_found", "Run not found.");
    const steps = await db.query<{ id: string; step_key: string; kind: string; attempt: number; status: RunStepView["status"]; result: Record<string, unknown>; error: string | null; approval_id: string | null; message_id: string | null; started_at: Date; finished_at: Date | null }>(
      "select id, step_key, kind, attempt, status, result, error, approval_id, message_id, started_at, finished_at from crm_workflow_run_steps where run_id = $1 and org_id = $2 order by id",
      [id, actor.orgId],
    );
    const s = toSummary(r);
    const ctx = r.context ?? {};
    const stopped = r.status === "failed" || r.status === "dead";
    const currentKind = r.current_step ? r.version_steps.find((x) => x.key === r.current_step)?.kind : undefined;
    return {
      ...s,
      steps: steps.rows.map((x) => ({
        id: Number(x.id), stepKey: x.step_key, kind: x.kind, label: stepLabel(r.version_steps.find((v) => v.key === x.step_key) ?? { kind: x.kind as WorkflowStep["kind"] }),
        attempt: x.attempt, status: x.status, result: seesRecords ? x.result ?? {} : withoutRecordText(x.result ?? {}), error: x.error, approvalId: x.approval_id, messageId: x.message_id, startedAt: iso(x.started_at)!, finishedAt: iso(x.finished_at),
      })),
      waitingUntil: r.status === "waiting" && ctx.wait ? ctx.wait.until : null,
      approvalId: r.status === "awaiting_approval" ? ctx.approval?.approvalId ?? null : null,
      canCancel: LIVE_RUN_STATUSES.includes(r.status),
      canRetry: stopped && Boolean(r.current_step) && !UNKNOWN_OUTCOMES.has(ctx.outcome ?? "") && ctx.outcome !== EXTERNAL_UNKNOWN && r.started_via !== "test",
      canSkip: stopped && Boolean(r.current_step) && currentKind !== "branch" && !UNKNOWN_OUTCOMES.has(ctx.outcome ?? "") && r.started_via !== "test",
    };
  });
}

// ---------------------------------------------------------------------------
// Test runs
// ---------------------------------------------------------------------------

export interface TestStepTrace {
  stepKey: string;
  kind: string;
  label: string;
  /** would_run, would_skip, branch_yes, branch_no, would_end, would_fail, would_ask, would_loop */
  outcome: string;
  detail: string;
}

export interface TestRunResult {
  /** The recorded test run (published versions only; a draft's test isn't recorded because it has no version yet). */
  runId: string | null;
  source: "draft" | "published";
  contact: { id: string; name: string } | null;
  steps: TestStepTrace[];
  issues: ValidationIssue[];
}

/**
 * Walks the workflow for one contact (and deal) as it would run now, without doing anything: conditions are evaluated against the real
 * records with reads only, waits are assumed to have passed, and each step reports what it would do and why it would be skipped or
 * blocked. No record changes, no message, no webhook, no n8n call, no AI request.
 */
async function simulate(db: Queryable, input: SimulateInput): Promise<TestStepTrace[]> {
  // Belt and braces: executors only read in a dry run, and whatever they touch is rolled back anyway.
  await db.query("savepoint crm_workflow_test");
  try {
    return await walk(db, input);
  } finally {
    await db.query("rollback to savepoint crm_workflow_test");
    await db.query("release savepoint crm_workflow_test");
  }
}

interface SimulateInput {
  org: { id: string; name: string; timezone: string };
  workflow: { id: string; name: string };
  version: StepContext["version"];
  steps: WorkflowStep[];
  contactId: string | null;
  opportunityId: string | null;
  runId: string;
  now: Date;
  actor: CrmActor;
}

async function walk(db: Queryable, input: SimulateInput): Promise<TestStepTrace[]> {
  const byKey = new Map(input.steps.map((s) => [s.key, s]));
  const out: TestStepTrace[] = [];
  const seen = new Set<string>();
  const context: RunContextData = { trigger: { type: "test" } };
  let key: string | null = input.steps[0]?.key ?? null;
  while (key && out.length < WORKFLOW_LIMITS.maxSteps + 5) {
    const step = byKey.get(key);
    if (!step) break;
    const label = stepLabel(step);
    if (seen.has(key)) {
      out.push({ stepKey: key, kind: step.kind, label, outcome: "would_loop", detail: "The run would come back to this step after a wait. The test stops here." });
      break;
    }
    seen.add(key);
    const sc: StepContext = {
      db, org: input.org, workflow: input.workflow, version: input.version,
      run: { id: input.runId, startedVia: "test", contactId: input.contactId, opportunityId: input.opportunityId, createdAt: input.now, context, triggerEventId: null, depth: 0 },
      actor: input.actor, causedBy: null, effectKey: `test:${input.runId}:${key}`, visit: 1, now: input.now, dryRun: true,
    };
    let res: StepOutcome;
    try {
      res = await executeStep(sc, step);
    } catch (err) {
      out.push({ stepKey: key, kind: step.kind, label, outcome: "would_fail", detail: publicMessage(err) });
      break;
    }
    const result = (res as { result: Record<string, unknown> }).result ?? {};
    const outcome = String(result.outcome ?? (res.type === "end" ? "would_end" : "would_run"));
    const detail = String(result.detail ?? "");
    out.push({ stepKey: key, kind: step.kind, label, outcome, detail: step.requireApproval && outcome === "would_run" ? `${detail} A person would be asked to approve it first.` : detail });
    if (res.type === "end") break;
    key = res.type === "done" && res.next !== undefined ? res.next : (step.next ?? null);
  }
  return out;
}

export async function startTestRun(actor: CrmActor, workflowId: string, input: { contactId?: string | null; opportunityId?: string | null; source?: "draft" | "published" } = {}): Promise<TestRunResult> {
  assertCan(actor, "workflows.manage", "Testing workflows needs the automations permission.");
  if (!UUID.test(workflowId)) throw new AppError("not_found", "Workflow not found.");
  if (input.contactId) assertCan(actor, "contacts.view", "Testing with a contact needs access to contacts.");
  const source = input.source ?? "published";
  const now = new Date();
  return withSystem(async (db) => {
    const w = (await db.query<WorkflowRow>("select * from crm_workflows where id = $1 and org_id = $2", [workflowId, actor.orgId])).rows[0];
    if (!w) throw new AppError("not_found", "Workflow not found.");
    const org = (await db.query<{ id: string; name: string; timezone: string }>("select id, name, timezone from organizations where id = $1", [actor.orgId])).rows[0];
    let contact: { id: string; name: string } | null = null;
    if (input.contactId) {
      if (!UUID.test(input.contactId)) throw new AppError("not_found", "Contact not found.");
      const c = (await db.query<{ id: string; display_name: string }>("select id, display_name from contacts where id = $1 and org_id = $2 and deleted_at is null and archived_at is null", [input.contactId, actor.orgId])).rows[0];
      if (!c) throw new AppError("not_found", "Contact not found (archived contacts can't be tested).");
      contact = { id: c.id, name: c.display_name };
    }
    let opportunityId: string | null = null;
    if (input.opportunityId) {
      if (!UUID.test(input.opportunityId)) throw new AppError("not_found", "Deal not found.");
      const o = (await db.query<{ id: string; contact_id: string | null }>("select id, contact_id from crm_opportunities where id = $1 and org_id = $2 and provider = 'native' and archived_at is null", [input.opportunityId, actor.orgId])).rows[0];
      if (!o) throw new AppError("not_found", "Deal not found.");
      opportunityId = o.id;
    }
    const actorLabel = workflowActor(org, w.name);
    if (source === "draft") {
      const { issues, definition } = await validateForPublish(db, actor.orgId, w.draft);
      if (!definition || hasErrors(issues)) return { runId: null, source, contact, steps: [], issues };
      if (TRIGGERS[definition.trigger.type].carries.contact === "always" && !contact) throw new AppError("invalid_input", "Choose a contact to test with.");
      const steps = await simulate(db, { org, workflow: { id: w.id, name: w.name }, version: { id: "draft", version: 0, approvalId: null, authorized: false }, steps: definition.steps, contactId: contact?.id ?? null, opportunityId, runId: "draft", now, actor: actorLabel });
      return { runId: null, source, contact, steps, issues };
    }
    if (!w.published_version_id) throw new AppError("conflict", "Publish this workflow first, or test the draft.");
    const v = (await db.query<VersionRow>(`select ${VERSION_COLUMNS} from crm_workflow_versions v where v.id = $1 and v.org_id = $2`, [w.published_version_id, actor.orgId])).rows[0];
    if (TRIGGERS[v.trigger_config.type]?.carries.contact === "always" && !contact) throw new AppError("invalid_input", "Choose a contact to test with.");
    const approval = await loadApprovalState(db, actor.orgId, v.approval_id);
    const created = await db.query<{ id: string }>(
      `insert into crm_workflow_runs (org_id, workflow_id, version_id, started_via, contact_id, opportunity_id, status, current_step, context, finished_at, created_at)
       values ($1, $2, $3, 'test', $4, $5, 'completed', null, $6, $7, $7) returning id`,
      [actor.orgId, w.id, v.id, contact?.id ?? null, opportunityId, JSON.stringify({ trigger: { type: "test", payload: { by: actor.userId } } }), now.toISOString()],
    );
    const runId = created.rows[0].id;
    const steps = await simulate(db, {
      org, workflow: { id: w.id, name: w.name }, version: { id: v.id, version: v.version, approvalId: v.approval_id, authorized: versionAuthorized(v, approval, now) }, steps: v.steps,
      contactId: contact?.id ?? null, opportunityId, runId, now, actor: actorLabel,
    });
    let i = 0;
    for (const s of steps) {
      i += 1;
      await db.query(
        `insert into crm_workflow_run_steps (org_id, run_id, step_key, kind, attempt, status, idempotency_key, result, started_at, finished_at)
         values ($1, $2, $3, $4, 1, 'skipped', $5, $6, $7, $7)`,
        [actor.orgId, runId, s.stepKey, s.kind, `test:${runId}:${i}`, JSON.stringify({ dryRun: true, outcome: s.outcome, detail: s.detail.slice(0, 1000) }), now.toISOString()],
      );
    }
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.workflow_tested", targetType: "crm_workflow", targetId: w.id, result: "success", metadata: { runId, version: v.version, contactId: contact?.id ?? null } }, db);
    return { runId, source, contact, steps, issues: [] };
  });
}

// ---------------------------------------------------------------------------
// Starting and controlling runs
// ---------------------------------------------------------------------------

/** Starts the published version for one contact (and deal) now. Steps are gated as they run, like any run. */
export async function startManualRun(actor: CrmActor, workflowId: string, input: { contactId?: string | null; opportunityId?: string | null }): Promise<{ runId: string }> {
  assertCan(actor, "workflows.manage", "Starting workflows needs the automations permission.");
  if (!UUID.test(workflowId)) throw new AppError("not_found", "Workflow not found.");
  if (input.contactId) assertCan(actor, "contacts.view");
  const now = new Date();
  return withSystem(async (db) => {
    const w = (await db.query<WorkflowRow>("select * from crm_workflows where id = $1 and org_id = $2", [workflowId, actor.orgId])).rows[0];
    if (!w) throw new AppError("not_found", "Workflow not found.");
    if (w.status !== "active" || !w.published_version_id) throw new AppError("conflict", "Turn the workflow on before starting it.");
    const v = (await db.query<VersionRow>(`select ${VERSION_COLUMNS} from crm_workflow_versions v where v.id = $1 and v.org_id = $2`, [w.published_version_id, actor.orgId])).rows[0];
    if (!versionAuthorized(v, await loadApprovalState(db, actor.orgId, v.approval_id), now)) throw new AppError("conflict", "An owner must approve this version before it runs.");
    const carries = TRIGGERS[v.trigger_config.type]?.carries.contact ?? "never";
    let contactId: string | null = null;
    if (carries === "never") {
      if (input.contactId) throw new AppError("invalid_input", "This workflow doesn't work on a contact, so start it without one.");
    } else {
      if (!input.contactId || !UUID.test(input.contactId)) throw new AppError("invalid_input", "Choose the contact to start this workflow for.");
      const c = await db.query("select 1 from contacts where id = $1 and org_id = $2 and deleted_at is null and archived_at is null", [input.contactId, actor.orgId]);
      if (!c.rows[0]) throw new AppError("not_found", "Contact not found.");
      contactId = input.contactId;
    }
    let opportunityId: string | null = null;
    if (input.opportunityId) {
      if (!UUID.test(input.opportunityId)) throw new AppError("not_found", "Deal not found.");
      const o = await db.query("select 1 from crm_opportunities where id = $1 and org_id = $2 and provider = 'native' and archived_at is null", [input.opportunityId, actor.orgId]);
      if (!o.rows[0]) throw new AppError("not_found", "Deal not found.");
      opportunityId = input.opportunityId;
    }
    const r = await createRun(db, {
      orgId: actor.orgId, workflowId: w.id, workflowName: w.name, hourlyRunLimit: w.hourly_run_limit, versionId: v.id, steps: v.steps, startedVia: "manual", contactId, opportunityId,
      reentry: v.trigger_config.reentry, now, context: { trigger: { type: "manual", payload: { by: actor.userId } } },
    });
    if (r.status !== "created") throw new AppError("conflict", `${r.reason}`);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.workflow_run_started", targetType: "crm_workflow_run", targetId: r.runId, result: "success", metadata: { workflowId: w.id, contactId } }, db);
    return { runId: r.runId };
  });
}

async function lockRun(db: Queryable, actor: CrmActor, runId: string): Promise<RunRow> {
  if (!UUID.test(runId)) throw new AppError("not_found", "Run not found.");
  const r = (await db.query<RunRow>(`select ${RUN_COLUMNS} from crm_workflow_runs r where r.id = $1 and r.org_id = $2 for update`, [runId, actor.orgId])).rows[0];
  if (!r) throw new AppError("not_found", "Run not found.");
  return { ...r, context: r.context ?? {} };
}

/** Stops a run that hasn't finished. A step waiting for approval has its approval request withdrawn. */
export async function cancelRun(actor: CrmActor, runId: string): Promise<void> {
  assertCan(actor, "workflows.manage", "Stopping workflow runs needs the automations permission.");
  await withSystem(async (db) => {
    const r = await lockRun(db, actor, runId);
    if (!LIVE_RUN_STATUSES.includes(r.status)) throw new AppError("conflict", "This run has already finished.");
    const now = new Date().toISOString();
    const pending = await db.query<{ approval_id: string | null }>(
      "update crm_workflow_run_steps set status = 'cancelled', error = 'Stopped by a person.', finished_at = $2 where run_id = $1 and status in ('waiting', 'awaiting_approval') returning approval_id",
      [r.id, now],
    );
    for (const p of pending.rows) {
      if (!p.approval_id) continue;
      const res = await db.query("update approval_requests set status = 'cancelled' where id = $1 and org_id = $2 and status = 'pending'", [p.approval_id, actor.orgId]);
      if (res.rowCount) await db.query("insert into approval_events (approval_id, org_id, actor_user_id, actor_kind, event, note) values ($1, $2, $3, 'user', 'cancelled', 'The workflow run was stopped.')", [p.approval_id, actor.orgId, actor.userId]);
    }
    await db.query(
      "update crm_workflow_runs set status = 'cancelled', finished_at = $2, claimed_at = null, cancelled_by = $3, last_error = 'Stopped by a person.' where id = $1",
      [r.id, now, actor.kind === "member" || actor.kind === "agency" ? actor.userId : null],
    );
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.workflow_run_cancelled", targetType: "crm_workflow_run", targetId: r.id, result: "success", metadata: { workflowId: r.workflow_id, step: r.current_step } }, db);
  });
}

function assertResumable(r: RunRow) {
  if (r.started_via === "test") throw new AppError("conflict", "Test runs don't do anything, so there's nothing to retry.");
  if (r.status !== "failed" && r.status !== "dead") throw new AppError("conflict", "Only runs that failed can be retried or skipped forward.");
  if (!r.current_step) throw new AppError("conflict", "This run has no step to continue from.");
  const outcome = r.context.outcome ?? "";
  if (outcome === "loop_limit") throw new AppError("conflict", "This run was stopped by the loop limit; running the step again would hit the limit again.");
  if (outcome === "visit_limit" || outcome === "step_limit") throw new AppError("conflict", "This run was stopped because it looped too often. Fix the loop and start a new run.");
  if (r.attempts >= 19) throw new AppError("conflict", "This step has been tried too many times.");
}

function assertRetryable(r: RunRow) {
  assertResumable(r);
  if (r.context.outcome === EXTERNAL_UNKNOWN) {
    throw new AppError("conflict", "We couldn't confirm whether this step ran in the other system, and retrying would only get the same answer. Check there: if it ran, skip this step; if it didn't, have it run there, then skip this step.");
  }
}

/**
 * Tries the failed step again, as a new attempt with the same effect key: a message, webhook or n8n call that already happened is not
 * repeated. A run stopped on an n8n call whose outcome is unknown isn't retried at all (the same key only gets "unknown" again): it is skipped.
 */
export async function retryRunStep(actor: CrmActor, runId: string, stepKey?: string | null): Promise<void> {
  assertCan(actor, "workflows.manage", "Retrying workflow runs needs the automations permission.");
  await withSystem(async (db) => {
    const r = await lockRun(db, actor, runId);
    assertRetryable(r);
    if (stepKey && stepKey !== r.current_step) throw new AppError("conflict", "Only the step the run stopped at can be retried. Reload to see where it is.");
    const ctx: RunContextData = { ...r.context };
    delete ctx.inflight;
    delete ctx.outcome;
    await db.query(
      "update crm_workflow_runs set status = 'queued', next_run_at = now(), claimed_at = null, finished_at = null, last_error = null, context = $2 where id = $1",
      [r.id, JSON.stringify(ctx)],
    );
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.workflow_run_retried", targetType: "crm_workflow_run", targetId: r.id, result: "success", metadata: { workflowId: r.workflow_id, step: r.current_step, attempt: r.attempts + 1 } }, db);
  });
}

/** Moves a failed run past its failed step without running it (not for if / else steps, which need a path). */
export async function skipRunStep(actor: CrmActor, runId: string): Promise<void> {
  assertCan(actor, "workflows.manage", "Changing workflow runs needs the automations permission.");
  await withSystem(async (db) => {
    const r = await lockRun(db, actor, runId);
    assertResumable(r);
    const v = (await db.query<{ steps: WorkflowStep[] }>("select steps from crm_workflow_versions where id = $1 and org_id = $2", [r.version_id, actor.orgId])).rows[0];
    const step = v.steps.find((s) => s.key === r.current_step);
    if (!step) throw new AppError("conflict", "This run's step is not part of its version.");
    if (step.kind === "branch") throw new AppError("conflict", "An if / else step can't be skipped, because the run needs a path. Retry it instead.");
    const ctx: RunContextData = { ...r.context };
    const visit = ctx.visit?.key === step.key ? ctx.visit.n : 1;
    const attempt = Math.min(20, r.attempts + 1);
    await db.query(
      `insert into crm_workflow_run_steps (org_id, run_id, step_key, kind, attempt, status, idempotency_key, result, started_at, finished_at)
       values ($1, $2, $3, $4, $5, 'skipped', $6, $7, now(), now())`,
      [actor.orgId, r.id, step.key, step.kind, attempt, `wf:${r.id}:${step.key}${visit > 1 ? `:${visit}` : ""}#skip${attempt}`, JSON.stringify({ outcome: "skipped_by_person", by: actor.label })],
    );
    delete ctx.inflight;
    delete ctx.outcome;
    delete ctx.wait;
    delete ctx.approval;
    const next = step.kind === "end" ? null : (step.next ?? null);
    if (next) {
      const visits = { ...(ctx.visits ?? {}) };
      visits[next] = (visits[next] ?? 0) + 1;
      ctx.visits = visits;
      ctx.visit = { key: next, n: visits[next] };
    }
    await db.query(
      `update crm_workflow_runs set status = $2, current_step = $3, attempts = 0, next_run_at = now(), claimed_at = null, last_error = null, context = $4,
         finished_at = case when $2 = 'completed' then now() else null end where id = $1`,
      [r.id, next ? "queued" : "completed", next, JSON.stringify(ctx)],
    );
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.workflow_run_step_skipped", targetType: "crm_workflow_run", targetId: r.id, result: "success", metadata: { workflowId: r.workflow_id, step: step.key } }, db);
  });
}
