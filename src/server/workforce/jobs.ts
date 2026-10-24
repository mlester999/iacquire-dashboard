import "server-only";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import type { OrgContext } from "@/server/tenancy/context";
import { signalWorkJobCancellation } from "@/server/workforce/work-cancel";

/**
 * Shared durable work foundation for AI employees.
 *
 * `agent_runs` records one Hermes invocation. A work job records the business task around it:
 * queued -> running -> (waiting_for_approval | blocked | failed | cancelled | completed), with
 * append-only stage/progress/evidence events. The UI must render persisted rows only.
 */

export const WORK_JOB_STATUSES = [
  "queued",
  "running",
  "waiting_for_approval",
  "blocked",
  "failed",
  "cancelled",
  "completed",
] as const;
export type WorkJobStatus = (typeof WORK_JOB_STATUSES)[number];

export const WORK_JOB_STAGES = [
  "preparing",
  "scanning",
  "analyzing",
  "searching",
  "reviewing",
  "extracting",
  "verifying",
  "qualifying",
  "checking_duplicates",
  "preparing_results",
  "waiting_for_approval",
  "completed",
  "blocked",
  "failed",
  "cancelled",
] as const;
export type WorkJobStage = (typeof WORK_JOB_STAGES)[number];

export const WORK_JOB_STAGE_LABELS: Record<WorkJobStage, string> = {
  preparing: "Preparing the work",
  scanning: "Reading persisted workspace records",
  analyzing: "Assessing impact and preparing recommendations",
  searching: "Searching approved public sources",
  reviewing: "Reviewing discovered company websites",
  extracting: "Extracting prospect details and evidence",
  verifying: "Verifying information against sources",
  qualifying: "Qualifying candidates against your criteria",
  checking_duplicates: "Checking candidate companies against existing CRM records",
  preparing_results: "Research completed. Preparing qualified leads for review.",
  waiting_for_approval: "Waiting for your approval",
  completed: "Completed",
  blocked: "Blocked and needs a person",
  failed: "Failed",
  cancelled: "Stopped",
};

export const WORK_JOB_STATUS_LABELS: Record<WorkJobStatus, string> = {
  queued: "Queued",
  running: "Working",
  waiting_for_approval: "Waiting for approval",
  blocked: "Blocked",
  failed: "Failed",
  cancelled: "Stopped",
  completed: "Completed",
};

export function isTerminalWorkJobStatus(status: WorkJobStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "blocked";
}

export function workJobStageLabel(stage: string | null | undefined): string | null {
  if (!stage) return null;
  return WORK_JOB_STAGE_LABELS[stage as WorkJobStage] ?? "Working";
}

export interface WorkJobRow {
  id: string;
  org_id: string;
  agent_instance_id: string;
  requested_by: string | null;
  capability: string;
  title: string;
  status: WorkJobStatus;
  stage: string | null;
  progress: Record<string, unknown>;
  input: Record<string, unknown>;
  result: Record<string, unknown>;
  result_summary: string | null;
  result_count: number;
  failure_code: string | null;
  failure_message: string | null;
  attempts: number;
  max_attempts: number;
  idempotency_key: string;
  conversation_id: string | null;
  cancel_requested_at: Date | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

export interface WorkJobEventRow {
  id: string;
  job_id: string;
  kind: "stage" | "progress" | "notice" | "evidence" | "error" | "approval";
  stage: string | null;
  message: string;
  data: Record<string, unknown>;
  created_at: Date;
}

export interface CreateWorkJobInput {
  orgId: string;
  agentId: string;
  requestedBy: string | null;
  capability: string;
  title: string;
  idempotencyKey: string;
  input?: Record<string, unknown>;
  conversationId?: string | null;
  maxAttempts?: number;
}

/** Creates one job for an idempotency key. A duplicate request returns the existing job. */
export async function createWorkJob(db: Queryable, input: CreateWorkJobInput): Promise<{ id: string; created: boolean }> {
  if (input.conversationId) {
    const conversation = await db.query<{ id: string }>(
      "select id from chat_conversations where id = $1 and org_id = $2 and agent_instance_id = $3 and deleted_at is null",
      [input.conversationId, input.orgId, input.agentId],
    );
    if (!conversation.rows[0]) throw new AppError("not_found", "The conversation for this work was not found.");
  }
  const { rows } = await db.query<{ id: string }>(
    `insert into ai_work_jobs (org_id, agent_instance_id, requested_by, capability, title, input, idempotency_key, conversation_id, max_attempts)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
     on conflict (idempotency_key) do nothing
     returning id`,
    [
      input.orgId,
      input.agentId,
      input.requestedBy,
      input.capability,
      input.title.slice(0, 200),
      JSON.stringify(input.input ?? {}),
      input.idempotencyKey,
      input.conversationId ?? null,
      Math.min(10, Math.max(1, input.maxAttempts ?? 2)),
    ],
  );
  if (rows[0]) return { id: rows[0].id, created: true };

  const existing = await db.query<{ id: string; org_id: string; agent_instance_id: string }>(
    "select id, org_id, agent_instance_id from ai_work_jobs where idempotency_key = $1",
    [input.idempotencyKey],
  );
  const row = existing.rows[0];
  if (!row || row.org_id !== input.orgId || row.agent_instance_id !== input.agentId) {
    throw new AppError("conflict", "That work request is already attached to another employee.");
  }
  return { id: row.id, created: false };
}

export async function appendWorkEvent(
  db: Queryable,
  input: { jobId: string; orgId: string; kind: WorkJobEventRow["kind"]; stage?: WorkJobStage | null; message: string; data?: Record<string, unknown> },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into ai_work_events (job_id, org_id, kind, stage, message, data)
     values ($1, $2, $3, $4, $5, $6::jsonb) returning id::text as id`,
    [input.jobId, input.orgId, input.kind, input.stage ?? null, input.message.slice(0, 500), JSON.stringify(input.data ?? {})],
  );
  return rows[0].id;
}

/** Records a real stage transition and its human-readable event in one transaction. */
export async function recordWorkStage(
  db: Queryable,
  input: {
    jobId: string;
    orgId: string;
    stage: WorkJobStage;
    message: string;
    progress?: Record<string, unknown>;
    data?: Record<string, unknown>;
    kind?: WorkJobEventRow["kind"];
  },
): Promise<string> {
  const updated = await db.query(
    `update ai_work_jobs set stage = $3, progress = progress || $4::jsonb
     where id = $1 and org_id = $2 and status in ('running', 'waiting_for_approval', 'blocked')`,
    [input.jobId, input.orgId, input.stage, JSON.stringify(input.progress ?? {})],
  );
  if (!updated.rowCount) throw new AppError("conflict", "This work job is no longer running.");
  return appendWorkEvent(db, {
    jobId: input.jobId,
    orgId: input.orgId,
    kind: input.kind ?? "stage",
    stage: input.stage,
    message: input.message,
    data: input.data,
  });
}

export async function recordWorkProgress(
  db: Queryable,
  input: { jobId: string; orgId: string; message: string; progress: Record<string, unknown>; data?: Record<string, unknown> },
): Promise<string> {
  const updated = await db.query(
    `update ai_work_jobs set progress = progress || $3::jsonb where id = $1 and org_id = $2 and status = 'running'`,
    [input.jobId, input.orgId, JSON.stringify(input.progress)],
  );
  if (!updated.rowCount) throw new AppError("conflict", "This work job is no longer running.");
  return appendWorkEvent(db, {
    jobId: input.jobId,
    orgId: input.orgId,
    kind: "progress",
    message: input.message,
    data: { ...(input.data ?? {}), progress: input.progress },
  });
}

/** Claims a queued job. Only one worker can hold the lease. */
export async function claimWorkJob(
  db: Queryable,
  input: { jobId: string; orgId: string; workerId: string; leaseSeconds?: number },
): Promise<WorkJobRow | null> {
  const lease = Math.min(3600, Math.max(30, input.leaseSeconds ?? 120));
  const { rows } = await db.query<WorkJobRow>(
    `update ai_work_jobs
        set status = 'running', stage = 'preparing', attempts = attempts + 1,
            started_at = coalesce(started_at, now()),
            lease_owner = $3, lease_expires_at = now() + make_interval(secs => $4),
            failure_code = null, failure_message = null
      where id = $1 and org_id = $2 and status = 'queued' and cancel_requested_at is null
        and (lease_expires_at is null or lease_expires_at < now())
      returning *`,
    [input.jobId, input.orgId, input.workerId, lease],
  );
  return rows[0] ?? null;
}

/** Extends the lease and optionally merges progress counters. */
export async function heartbeatWorkJob(
  db: Queryable,
  input: { jobId: string; workerId: string; leaseSeconds?: number; progress?: Record<string, unknown> },
): Promise<boolean> {
  const lease = Math.min(3600, Math.max(30, input.leaseSeconds ?? 120));
  const { rowCount } = await db.query(
    `update ai_work_jobs
        set lease_expires_at = now() + make_interval(secs => $3),
            progress = progress || $4::jsonb
      where id = $1 and lease_owner = $2 and status = 'running'`,
    [input.jobId, input.workerId, lease, JSON.stringify(input.progress ?? {})],
  );
  return rowCount > 0;
}

export interface FinishWorkJobInput {
  jobId: string;
  orgId: string;
  status: Extract<WorkJobStatus, "completed" | "failed" | "cancelled" | "blocked" | "waiting_for_approval">;
  stage: WorkJobStage;
  result?: Record<string, unknown>;
  resultSummary?: string | null;
  resultCount?: number;
  failureCode?: string | null;
  failureMessage?: string | null;
}

/** Sets a terminal (or approval-waiting) state. Idempotent: a second finish returns false. */
export async function finishWorkJob(db: Queryable, input: FinishWorkJobInput): Promise<boolean> {
  const { rowCount } = await db.query(
    `update ai_work_jobs
        set status = $3, stage = $4, result = $5::jsonb, result_summary = $6, result_count = $7,
            failure_code = $8, failure_message = $9,
            lease_owner = null, lease_expires_at = null, finished_at = now()
      where id = $1 and org_id = $2 and status in ('running', 'waiting_for_approval', 'blocked')`,
    [
      input.jobId,
      input.orgId,
      input.status,
      input.stage,
      JSON.stringify(input.result ?? {}),
      input.resultSummary?.slice(0, 1000) ?? null,
      Math.max(0, Math.floor(input.resultCount ?? 0)),
      input.failureCode?.slice(0, 80) ?? null,
      input.failureMessage?.slice(0, 1000) ?? null,
    ],
  );
  return rowCount > 0;
}

/** Requests cancellation. A queued job is cancelled immediately; a running job is signalled. */
export async function requestWorkJobCancel(db: Queryable, input: { jobId: string; orgId: string }): Promise<"cancelled" | "cancel_requested"> {
  const { rows } = await db.query<{ status: WorkJobStatus }>(
    "select status from ai_work_jobs where id = $1 and org_id = $2",
    [input.jobId, input.orgId],
  );
  const row = rows[0];
  if (!row) throw new AppError("not_found", "Work job not found.");
  if (isTerminalWorkJobStatus(row.status)) throw new AppError("conflict", "This work has already finished.");
  if (row.status === "queued" || row.status === "waiting_for_approval") {
    const res = await db.query(
      `update ai_work_jobs set status = 'cancelled', stage = 'cancelled', cancel_requested_at = now(),
              lease_owner = null, lease_expires_at = null, finished_at = now()
        where id = $1 and org_id = $2 and status in ('queued', 'waiting_for_approval')`,
      [input.jobId, input.orgId],
    );
    if (res.rowCount) {
      await appendWorkEvent(db, { jobId: input.jobId, orgId: input.orgId, kind: "notice", stage: "cancelled", message: "Work was stopped before it continued." });
      return "cancelled";
    }
  }
  await db.query(
    "update ai_work_jobs set cancel_requested_at = coalesce(cancel_requested_at, now()) where id = $1 and org_id = $2 and status = 'running'",
    [input.jobId, input.orgId],
  );
  await appendWorkEvent(db, { jobId: input.jobId, orgId: input.orgId, kind: "notice", message: "Stop requested. The employee will stop at the next safe point." });
  return "cancel_requested";
}

/** Re-queues a finished job. The next claim increments the attempt count; the input is unchanged. */
export async function retryWorkJob(db: Queryable, input: { jobId: string; orgId: string }): Promise<boolean> {
  const { rowCount } = await db.query(
    `update ai_work_jobs
        set status = 'queued', stage = null, lease_owner = null, lease_expires_at = null,
            cancel_requested_at = null, failure_code = null, failure_message = null,
            finished_at = null, max_attempts = greatest(max_attempts, attempts + 1)
      where id = $1 and org_id = $2 and status in ('failed', 'blocked', 'cancelled')`,
    [input.jobId, input.orgId],
  );
  if (rowCount) {
    await appendWorkEvent(db, { jobId: input.jobId, orgId: input.orgId, kind: "notice", message: "Work was queued to run again." });
  }
  return rowCount > 0;
}

export async function getWorkJob(db: Queryable, orgId: string, jobId: string): Promise<WorkJobRow | null> {
  const { rows } = await db.query<WorkJobRow>("select * from ai_work_jobs where id = $1 and org_id = $2", [jobId, orgId]);
  return rows[0] ?? null;
}

export async function listWorkJobEvents(
  db: Queryable,
  input: { orgId: string; jobId: string; afterId?: string | null; limit?: number },
): Promise<WorkJobEventRow[]> {
  const after = input.afterId && /^\d+$/.test(input.afterId) ? input.afterId : null;
  const limit = Math.min(200, Math.max(1, input.limit ?? 100));
  const { rows } = await db.query<WorkJobEventRow>(
    `select id::text as id, job_id, kind, stage, message, data, created_at
       from ai_work_events
      where org_id = $1 and job_id = $2 and ($3::bigint is null or id > $3::bigint)
      order by id asc limit $4`,
    [input.orgId, input.jobId, after, limit],
  );
  return rows;
}

export async function listActiveWorkJobsForAgent(db: Queryable, orgId: string, agentId: string): Promise<WorkJobRow[]> {
  const { rows } = await db.query<WorkJobRow>(
    `select * from ai_work_jobs
      where org_id = $1 and agent_instance_id = $2 and status in ('queued', 'running', 'waiting_for_approval', 'blocked')
      order by created_at asc limit 20`,
    [orgId, agentId],
  );
  return rows;
}

/** Queued jobs the tick worker may run. */
export async function listRunnableWorkJobs(limit = 3): Promise<WorkJobRow[]> {
  const { rows } = await withSystem((db) =>
    db.query<WorkJobRow>(
      `select * from ai_work_jobs
        where status = 'queued' and cancel_requested_at is null
        order by created_at asc limit $1`,
      [Math.min(10, Math.max(1, limit))],
    ),
  );
  return rows;
}

/**
 * Recovery for a crashed or stopped worker. A lost lease is retried while attempts remain, then
 * failed with an honest reason. Cancel requests left by a dead worker are settled here. Never
 * deletes evidence and never claims the work succeeded.
 */
export async function recoverExpiredWorkJobs(): Promise<{ retried: number; failed: number; cancelled: number }> {
  return withSystem(async (db) => {
    const { rows } = await db.query<{
      id: string; org_id: string; attempts: number; max_attempts: number; cancel_requested_at: Date | null; stage: string | null; capability: string;
    }>(
      `select id, org_id, attempts, max_attempts, cancel_requested_at, stage, capability
         from ai_work_jobs
        where status = 'running'
          and (lease_owner is null or lease_expires_at is null or lease_expires_at <= now())
        order by case when lease_owner is null or lease_expires_at is null then 0 else 1 end,
                 lease_expires_at asc nulls first
        for update skip locked
        limit 20`,
    );
    const settleResearchRequest = async (job: { id: string; org_id: string; capability: string }, status: "cancelled" | "failed", reason: string) => {
      if (job.capability !== "lead_research") return;
      await db.query(
        `update lead_research_requests set status = $3, failure_reason = $4, completed_at = now()
          where org_id = $1 and work_job_id = $2 and status in ('queued', 'running', 'waiting_for_agent')`,
        [job.org_id, job.id, status, reason],
      );
    };
    let retried = 0;
    let failed = 0;
    let cancelled = 0;
    for (const job of rows) {
      if (job.cancel_requested_at) {
        await db.query(
          `update ai_work_jobs set status = 'cancelled', stage = 'cancelled', lease_owner = null, lease_expires_at = null, finished_at = now()
            where id = $1 and org_id = $2`,
          [job.id, job.org_id],
        );
        await appendWorkEvent(db, { jobId: job.id, orgId: job.org_id, kind: "notice", stage: "cancelled", message: "Work was stopped." });
        await settleResearchRequest(job, "cancelled", "The research was stopped.");
        cancelled += 1;
      } else if (job.attempts < job.max_attempts) {
        await db.query(
          `update ai_work_jobs set status = 'queued', stage = null, lease_owner = null, lease_expires_at = null
            where id = $1 and org_id = $2`,
          [job.id, job.org_id],
        );
        await appendWorkEvent(db, {
          jobId: job.id,
          orgId: job.org_id,
          kind: "notice",
          message: "The worker stopped unexpectedly. The work was queued to retry; no result was claimed.",
        });
        retried += 1;
      } else {
        await db.query(
          `update ai_work_jobs set status = 'failed', stage = 'failed', failure_code = 'worker_lost',
                  failure_message = 'The worker stopped before the work completed.', lease_owner = null, lease_expires_at = null, finished_at = now()
            where id = $1 and org_id = $2`,
          [job.id, job.org_id],
        );
        await appendWorkEvent(db, {
          jobId: job.id,
          orgId: job.org_id,
          kind: "error",
          stage: "failed",
          message: "The worker stopped before the work completed. It was not retried automatically because its attempts were exhausted.",
        });
        await settleResearchRequest(job, "failed", "The worker stopped before the research completed.");
        failed += 1;
      }
    }
    // A queued cancellation may have been written while no worker was looking.
    const queuedCancel = await db.query<{ id: string; org_id: string; capability: string }>(
      `update ai_work_jobs set status = 'cancelled', stage = 'cancelled', finished_at = now()
        where status = 'queued' and cancel_requested_at is not null
        returning id, org_id, capability`,
    );
    for (const job of queuedCancel.rows) {
      await appendWorkEvent(db, { jobId: job.id, orgId: job.org_id, kind: "notice", stage: "cancelled", message: "Work was stopped before it started." });
      await settleResearchRequest(job, "cancelled", "The research was stopped before it started.");
      cancelled += 1;
    }
    return { retried, failed, cancelled };
  });
}

// ---------------------------------------------------------------------------
// Authenticated views and actions (row-level security plus explicit checks)
// ---------------------------------------------------------------------------

export interface WorkJobView {
  id: string;
  capability: string;
  title: string;
  status: WorkJobStatus;
  statusLabel: string;
  recoveryPending: boolean;
  stage: string | null;
  stageLabel: string | null;
  progress: Record<string, unknown>;
  result: Record<string, unknown>;
  resultSummary: string | null;
  resultCount: number;
  failureCode: string | null;
  failureMessage: string | null;
  attempts: number;
  cancelRequested: boolean;
  canCancel: boolean;
  canRetry: boolean;
  /** Completed review plus tasks.manage: a finding can become an internal follow-up task. */
  canCreateTask: boolean;
  conversationId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  elapsedMs: number | null;
  events: Array<{ id: string; kind: WorkJobEventRow["kind"]; stage: string | null; stageLabel: string | null; message: string; data: Record<string, unknown>; createdAt: string }>;
}

const CAPABILITY_CANCEL_PERMISSION: Record<string, string> = {
  lead_research: "leads.research",
};

function canActOnJob(ctx: OrgContext, job: WorkJobRow, permission: string): boolean {
  if (ctx.can(permission as Parameters<OrgContext["can"]>[0])) return true;
  // The person who requested the work may stop or retry their own job when they can still see it.
  return job.requested_by === ctx.user.id && ctx.can("agents.use");
}

function canViewJob(ctx: OrgContext, job: WorkJobRow): boolean {
  if (job.requested_by === ctx.user.id) return true;
  return ctx.can("activity.view");
}

export async function getWorkJobView(ctx: OrgContext, jobId: string, options: { afterId?: string | null } = {}): Promise<WorkJobView | null> {
  if (!ctx.can("agents.use") && !ctx.can("activity.view")) throw new AppError("forbidden", "Your role can't view AI work.");
  const data = await withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<WorkJobRow & { lease_active: boolean }>(
      `select j.*,
              (j.lease_owner is not null and j.lease_expires_at is not null and j.lease_expires_at > now()) as lease_active
         from ai_work_jobs j
        where j.id = $1 and j.org_id = $2`,
      [jobId, ctx.org.orgId],
    );
    const job = rows[0];
    if (!job) return null;
    const events = await listWorkJobEvents(db, { orgId: ctx.org.orgId, jobId, afterId: options.afterId, limit: 200 });
    return { job, events };
  });
  if (!data) return null;
  if (!canViewJob(ctx, data.job)) throw new AppError("forbidden", "You don't have access to this work.");
  const job = data.job;
  const cancelPermission = CAPABILITY_CANCEL_PERMISSION[job.capability] ?? "agents.use";
  const recoveryPending = job.status === "running" && !job.lease_active;
  const elapsedEnd = job.finished_at ? new Date(job.finished_at).getTime() : Date.now();
  const started = job.started_at ? new Date(job.started_at).getTime() : null;
  return {
    id: job.id,
    capability: job.capability,
    title: job.title,
    status: job.status,
    statusLabel: recoveryPending ? "Recovery pending" : WORK_JOB_STATUS_LABELS[job.status],
    recoveryPending,
    stage: job.stage,
    stageLabel: workJobStageLabel(job.stage),
    progress: job.progress ?? {},
    result: job.result ?? {},
    resultSummary: job.result_summary,
    resultCount: job.result_count,
    failureCode: job.failure_code,
    failureMessage: job.failure_message,
    attempts: job.attempts,
    cancelRequested: Boolean(job.cancel_requested_at),
    canCancel: !isTerminalWorkJobStatus(job.status) && !job.cancel_requested_at && canActOnJob(ctx, job, cancelPermission),
    canRetry: ["failed", "blocked", "cancelled"].includes(job.status) && canActOnJob(ctx, job, cancelPermission),
    canCreateTask: job.status === "completed" && ctx.can("tasks.manage"),
    conversationId: job.conversation_id,
    createdAt: new Date(job.created_at).toISOString(),
    startedAt: job.started_at ? new Date(job.started_at).toISOString() : null,
    finishedAt: job.finished_at ? new Date(job.finished_at).toISOString() : null,
    elapsedMs: started === null ? null : Math.max(0, elapsedEnd - started),
    events: data.events.map((event) => ({
      id: event.id,
      kind: event.kind,
      stage: event.stage,
      stageLabel: workJobStageLabel(event.stage),
      message: event.message,
      data: event.data ?? {},
      createdAt: new Date(event.created_at).toISOString(),
    })),
  };
}

export async function cancelWorkJob(ctx: OrgContext, jobId: string): Promise<"cancelled" | "cancel_requested"> {
  const result = await withSystem(async (db) => {
    const job = await getWorkJob(db, ctx.org.orgId, jobId);
    if (!job) throw new AppError("not_found", "Work job not found.");
    const permission = CAPABILITY_CANCEL_PERMISSION[job.capability] ?? "agents.use";
    if (!canActOnJob(ctx, job, permission)) throw new AppError("forbidden", "You can't stop this work.");
    const outcome = await requestWorkJobCancel(db, { jobId, orgId: ctx.org.orgId });
    if (outcome === "cancelled") {
      await db.query(
        `update lead_research_requests
            set status = 'cancelled', failure_reason = 'The research was stopped before it started.', completed_at = now()
          where org_id = $1 and work_job_id = $2 and status in ('queued', 'running')`,
        [ctx.org.orgId, jobId],
      );
    }
    return outcome;
  });
  signalWorkJobCancellation(jobId);
  return result;
}

export async function retryWorkJobForUser(ctx: OrgContext, jobId: string): Promise<void> {
  await withSystem(async (db) => {
    const job = await getWorkJob(db, ctx.org.orgId, jobId);
    if (!job) throw new AppError("not_found", "Work job not found.");
    const permission = CAPABILITY_CANCEL_PERMISSION[job.capability] ?? "agents.use";
    if (!canActOnJob(ctx, job, permission)) throw new AppError("forbidden", "You can't retry this work.");
    const retried = await retryWorkJob(db, { jobId, orgId: ctx.org.orgId });
    if (!retried) throw new AppError("conflict", "This work can't be retried from its current state.");
  });
  const { kickWorkJob } = await import("@/server/workforce/work-kick");
  kickWorkJob(jobId);
}
