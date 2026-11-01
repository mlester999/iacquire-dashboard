import "server-only";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import type { OrgContext } from "@/server/tenancy/context";
import { signalWorkJobCancellation } from "@/server/workforce/work-cancel";
import { capabilityDefinition } from "@/lib/workforce-capabilities";
import { classifyCapability, type EvidenceClass, type EvidenceMarker } from "@/lib/evidence-class";

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

/** Where one drafted message stands right now, from the message's own status (the job's result only holds what was true when the job finished). */
export type DraftLiveStatus = "waiting" | "approved_queued" | "sent" | "blocked" | "discarded" | "unknown";

export function draftLiveStatus(messageStatus: string | null | undefined, blockedReason?: string | null): DraftLiveStatus {
  switch (messageStatus) {
    case "draft":
      return "waiting";
    case "queued":
    case "sending":
      return "approved_queued";
    case "sent":
    case "delivered":
    case "read":
      return "sent";
    case "blocked":
      return blockedReason === "discarded" ? "discarded" : "blocked";
    case "failed":
      return "blocked";
    default:
      return "unknown";
  }
}

/**
 * How many of a job's drafts are in each state. `waiting` is not decided yet, `queued` and `sent` were approved by a person, `blocked` could not go out (blocked, failed, or a
 * message that cannot be found, which is never guessed to be fine), and a draft a person discarded is none of them.
 */
export interface DraftCounts {
  total: number;
  waiting: number;
  queued: number;
  sent: number;
  blocked: number;
}

/** Counts one job's drafts from where each one stands now. */
export function countDraftStatuses(statuses: readonly DraftLiveStatus[]): DraftCounts {
  const count = (status: DraftLiveStatus) => statuses.filter((s) => s === status).length;
  return { total: statuses.length, waiting: count("waiting"), queued: count("approved_queued"), sent: count("sent"), blocked: count("blocked") + count("unknown") };
}

/**
 * What kind of thing a job's result is, computed from its own row and nothing stored. A job that has not finished has produced nothing yet, so it has no class (the panel shows
 * no chip) except one waiting for a decision, which is a proposal. A finished read-only review retrieved records. A finished proposal job (follow-up drafts) stays a proposal until a
 * person has decided its drafts: approved drafts that are only queued are an approved write, and it is a confirmed action only when every approved draft has really been sent.
 */
export function workJobEvidence(job: { id: string; capability: string; status: WorkJobStatus }, drafts?: DraftCounts | null): EvidenceMarker | null {
  const definition = capabilityDefinition(job.capability);
  if (!definition) return null;
  const marker = (cls: EvidenceClass): EvidenceMarker => ({ v: 1, class: cls, ledger: { kind: "work_job", id: job.id } });
  if (job.status === "waiting_for_approval") return marker("proposed_change");
  if (job.status !== "completed") return null;
  const base = classifyCapability(definition.risk);
  if (base !== "proposed_change" || !drafts) return marker(base);
  const approved = drafts.queued + drafts.sent;
  if (drafts.waiting > 0 || approved === 0) return marker("proposed_change");
  // A draft that could not go out (or cannot be found) keeps the job from reading as confirmed, whatever else was sent.
  return marker(drafts.sent === approved && drafts.blocked === 0 ? "completed_action" : "approved_write");
}

/**
 * The status words for a job. A finished review keeps "Completed" (it ran to the end and read what it read), but finished work that only prepared something must not say it was
 * done: a draft job reads "Ready for review" until a person decides the drafts, and "Completed" is kept for work whose effect is confirmed.
 */
export function workJobStatusLabel(job: { status: WorkJobStatus; recoveryPending: boolean }, evidence: EvidenceMarker | null, drafts?: DraftCounts | null): string {
  if (job.recoveryPending) return "Recovery pending";
  if (job.status === "completed" && evidence) {
    if (evidence.class === "proposed_change") return "Ready for review";
    if (evidence.class === "approved_write") return drafts && drafts.blocked > 0 ? "Some drafts not sent" : "Approved, not yet sent";
  }
  return WORK_JOB_STATUS_LABELS[job.status];
}

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
  lease_owner?: string | null;
  lease_expires_at?: Date | string | null;
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
  input: { jobId: string; orgId: string; kind: WorkJobEventRow["kind"]; stage?: WorkJobStage | null; message: string; data?: Record<string, unknown>; workerId?: string },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into ai_work_events (job_id, org_id, kind, stage, message, data)
     select j.id, j.org_id, $3, $4, $5, $6::jsonb
       from ai_work_jobs j
      where j.id = $1 and j.org_id = $2
        and ((j.status = 'running' and $7::text is not null and j.lease_owner = $7 and j.lease_expires_at > now())
          or (j.status <> 'running' and $7::text is null))
      for update of j
     returning id::text as id`,
    [input.jobId, input.orgId, input.kind, input.stage ?? null, input.message.slice(0, 500), JSON.stringify(input.data ?? {}), input.workerId ?? null],
  );
  if (!rows[0]) throw new AppError("conflict", "The work changed or its worker lease expired before this update was recorded.");
  return rows[0].id;
}

/** Records a real stage transition and its human-readable event in one transaction. */
export async function recordWorkStage(
  db: Queryable,
  input: {
    jobId: string;
    orgId: string;
    workerId: string;
    stage: WorkJobStage;
    message: string;
    progress?: Record<string, unknown>;
    data?: Record<string, unknown>;
    kind?: WorkJobEventRow["kind"];
  },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `with updated as (
       update ai_work_jobs set stage = $3, progress = progress || $4::jsonb
        where id = $1 and org_id = $2 and status = 'running'
          and lease_owner = $5 and lease_expires_at > now()
        returning id, org_id
     )
     insert into ai_work_events (job_id, org_id, kind, stage, message, data)
     select updated.id, updated.org_id, $6, $3, $7, $8::jsonb from updated
     returning id::text as id`,
    [
      input.jobId,
      input.orgId,
      input.stage,
      JSON.stringify(input.progress ?? {}),
      input.workerId,
      input.kind ?? "stage",
      input.message.slice(0, 500),
      JSON.stringify(input.data ?? {}),
    ],
  );
  if (!rows[0]) throw new AppError("conflict", "This work job is no longer running.");
  return rows[0].id;
}

export async function recordWorkProgress(
  db: Queryable,
  input: { jobId: string; orgId: string; workerId: string; message: string; progress: Record<string, unknown>; data?: Record<string, unknown> },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `with updated as (
       update ai_work_jobs set progress = progress || $3::jsonb
        where id = $1 and org_id = $2 and status = 'running'
          and lease_owner = $4 and lease_expires_at > now()
        returning id, org_id
     )
     insert into ai_work_events (job_id, org_id, kind, message, data)
     select updated.id, updated.org_id, 'progress', $5, $6::jsonb from updated
     returning id::text as id`,
    [
      input.jobId,
      input.orgId,
      JSON.stringify(input.progress),
      input.workerId,
      input.message.slice(0, 500),
      JSON.stringify({ ...(input.data ?? {}), progress: input.progress }),
    ],
  );
  if (!rows[0]) throw new AppError("conflict", "This work job is no longer running.");
  return rows[0].id;
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
      where id = $1 and lease_owner = $2 and status = 'running' and lease_expires_at > now()`,
    [input.jobId, input.workerId, lease, JSON.stringify(input.progress ?? {})],
  );
  return rowCount > 0;
}

export interface FinishWorkJobInput {
  jobId: string;
  orgId: string;
  workerId: string;
  status: Extract<WorkJobStatus, "completed" | "failed" | "cancelled" | "blocked" | "waiting_for_approval">;
  stage: WorkJobStage;
  result?: Record<string, unknown>;
  resultSummary?: string | null;
  resultCount?: number;
  failureCode?: string | null;
  failureMessage?: string | null;
  event?: { kind: WorkJobEventRow["kind"]; stage?: WorkJobStage | null; message: string; data?: Record<string, unknown> };
}

/** Sets a terminal (or approval-waiting) state. Idempotent: a second finish returns false. */
export async function finishWorkJob(db: Queryable, input: FinishWorkJobInput): Promise<boolean> {
  const { rows } = await db.query<{ id: string }>(
    `with finished as (
       update ai_work_jobs
          set status = $3, stage = $4, result = $5::jsonb, result_summary = $6, result_count = $7,
              failure_code = $8, failure_message = $9,
              lease_owner = null, lease_expires_at = null, finished_at = now()
        where id = $1 and org_id = $2 and status in ('running', 'waiting_for_approval', 'blocked')
          and lease_owner = $10 and lease_expires_at > now()
        returning id, org_id
     ),
     finished_event as (
       insert into ai_work_events (job_id, org_id, kind, stage, message, data)
       select f.id, f.org_id, $11::text, $12::text, left($13::text, 500), $14::jsonb
         from finished f
        where $13::text is not null
       returning id
     )
     select f.id from finished f cross join (select count(*) from finished_event) event_count`,
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
      input.workerId,
      input.event?.kind ?? null,
      input.event?.stage ?? null,
      input.event?.message ?? null,
      JSON.stringify(input.event?.data ?? {}),
    ],
  );
  return rows.length > 0;
}

/** Locks a live lease while a worker persists a capability-specific side effect. */
export async function lockActiveWorkJobLease(
  db: Queryable,
  input: { jobId: string; orgId: string; workerId: string },
): Promise<boolean> {
  const { rows } = await db.query<{ id: string }>(
    `select id from ai_work_jobs
      where id = $1 and org_id = $2 and status = 'running'
        and lease_owner = $3 and lease_expires_at > now()
      for update`,
    [input.jobId, input.orgId, input.workerId],
  );
  return rows.length > 0;
}

/** Requests cancellation. A queued job is cancelled immediately; a running job is signalled. */
export async function requestWorkJobCancel(db: Queryable, input: { jobId: string; orgId: string }): Promise<"cancelled" | "cancel_requested"> {
  const { rows } = await db.query<{ status: WorkJobStatus; lease_owner: string | null; lease_active: boolean }>(
    `select status, lease_owner,
            (lease_owner is not null and lease_expires_at is not null and lease_expires_at > now()) as lease_active
       from ai_work_jobs where id = $1 and org_id = $2 for update`,
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
  if (row.status === "running" && row.lease_active && row.lease_owner) {
    await appendWorkEvent(db, {
      jobId: input.jobId,
      orgId: input.orgId,
      workerId: row.lease_owner,
      kind: "notice",
      message: "Stop requested. The employee will stop at the next safe point.",
    });
  }
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
  /** What kind of thing this work produced (computed on read, never stored). Null until it has produced something. */
  evidence: EvidenceMarker | null;
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

const MESSAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A follow-up draft job's result lists the drafts as they were when the job finished, all "draft". This reads each draft's message now (its status and the reason it was blocked,
 * never its body, and only messages of this workspace) and adds `liveStatus` and `liveDetail` to each, so the panel never keeps saying "draft" after a person approved, sent or
 * discarded it. Any other job's result is returned as it is. A draft whose message cannot be found is "unknown", not guessed.
 */
async function withLiveDraftStatus(orgId: string, job: WorkJobRow): Promise<{ value: Record<string, unknown>; counts: DraftCounts | null }> {
  const base = job.result ?? {};
  if (job.capability !== "pipeline_followup_drafts" || !Array.isArray(base.drafts)) return { value: base, counts: null };
  const drafts = (base.drafts as unknown[]).filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item));
  const ids = [...new Set(drafts.map((draft) => draft.messageId).filter((id): id is string => typeof id === "string" && MESSAGE_ID.test(id)))];
  const live = await readLiveDrafts(orgId, ids);
  const statuses: DraftLiveStatus[] = [];
  const withStatus = drafts.map((draft) => {
    const message = typeof draft.messageId === "string" ? live.get(draft.messageId) : undefined;
    const status = draftLiveStatus(message?.status, message?.reason);
    statuses.push(status);
    return { ...draft, liveStatus: status, liveDetail: status === "blocked" ? (message?.detail ?? message?.reason ?? null)?.slice(0, 200) ?? null : null };
  });
  return { value: { ...base, drafts: withStatus }, counts: countDraftStatuses(statuses) };
}

interface LiveDraft {
  status: string;
  reason: string | null;
  detail: string | null;
}

/** The current status (and the recorded reason, never the body) of drafted messages of this workspace. An id from another workspace finds nothing. */
async function readLiveDrafts(orgId: string, ids: readonly string[]): Promise<Map<string, LiveDraft>> {
  const live = new Map<string, LiveDraft>();
  if (!ids.length) return live;
  const { rows } = await withSystem((db) =>
    db.query<{ id: string; status: string; blocked_reason: string | null; status_detail: string | null }>(
      "select id, status, blocked_reason, status_detail from conversation_messages where org_id = $1 and id = any($2::uuid[])",
      [orgId, ids],
    ),
  );
  for (const row of rows) live.set(row.id, { status: row.status, reason: row.blocked_reason, detail: row.status_detail });
  return live;
}

/**
 * Draft counts for a list of finished follow-up jobs, for the screens that list many jobs (the work board, the calendar). `draftMessageIds` is each job's drafts' message ids in
 * order (null for a draft with no usable id). The statuses are read once with trusted access to this workspace's messages, status only, so a person who cannot open a draft's
 * conversation still sees the draft counted the way the job panel counts it; a draft that cannot be found counts as not sent, never as fine.
 */
export async function loadDraftCountsForJobs(orgId: string, jobs: ReadonlyArray<{ id: string; draftMessageIds: unknown }>): Promise<Map<string, DraftCounts>> {
  const lists = new Map<string, Array<string | null>>();
  for (const job of jobs) {
    if (!Array.isArray(job.draftMessageIds)) continue;
    lists.set(job.id, job.draftMessageIds.map((id) => (typeof id === "string" && MESSAGE_ID.test(id) ? id : null)));
  }
  const ids = [...new Set([...lists.values()].flat().filter((id): id is string => id !== null))];
  const live = await readLiveDrafts(orgId, ids);
  const out = new Map<string, DraftCounts>();
  for (const [jobId, list] of lists) {
    out.set(jobId, countDraftStatuses(list.map((id) => {
      const message = id ? live.get(id) : undefined;
      return draftLiveStatus(message?.status, message?.reason);
    })));
  }
  return out;
}

/** SQL for the column `draft_message_ids` that `loadDraftCountsForJobs` reads (the job table is aliased `j`). Null for any job that is not a finished follow-up draft job. */
export const DRAFT_MESSAGE_IDS_SQL = `case when j.capability = 'pipeline_followup_drafts' and j.status = 'completed' and jsonb_typeof(j.result -> 'drafts') = 'array'
  then (select coalesce(jsonb_agg(d ->> 'messageId'), '[]'::jsonb) from jsonb_array_elements(j.result -> 'drafts') d) end`;

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
  const result = await withLiveDraftStatus(ctx.org.orgId, job);
  const evidence = workJobEvidence(job, result.counts);
  return {
    id: job.id,
    capability: job.capability,
    title: job.title,
    status: job.status,
    statusLabel: workJobStatusLabel({ status: job.status, recoveryPending }, evidence, result.counts),
    recoveryPending,
    evidence,
    stage: job.stage,
    stageLabel: workJobStageLabel(job.stage),
    progress: job.progress ?? {},
    result: result.value,
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
