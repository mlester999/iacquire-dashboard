import "server-only";
import type { Queryable } from "@/server/db";
import { env } from "@/server/env";
import { capabilityDefinition } from "@/lib/workforce-capabilities";
import { workforceScheduleSkipReasonLabel } from "@/lib/workforce-schedule-copy";
import { workJobStatusLabel, type WorkJobStatus } from "@/server/workforce/jobs";
import { schedulesOperatorEnabled } from "@/server/workforce/schedules";

const SCHEDULE_LIMIT = 10;
const JOB_LIMIT = 8;
const PENDING: WorkJobStatus[] = ["queued", "running", "waiting_for_approval"];
const TERMINAL: WorkJobStatus[] = ["blocked", "failed", "cancelled", "completed"];

const iso = (date: Date | null) => date ? new Date(date).toISOString() : null;
const capabilityLabel = (key: string) => capabilityDefinition(key)?.label ?? "Unrecognized capability";

export interface PartnerOperationsJob {
  id: string;
  capability: string;
  status: WorkJobStatus;
  label: string;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

function jobLabel(status: WorkJobStatus, recoveryPending = false) {
  // This panel reports the job state, without inferring a delivery or other customer outcome.
  return status === "completed" ? "Job finished" : workJobStatusLabel({ status, recoveryPending }, null);
}

async function readJobs(
  db: Queryable, orgId: string, agentId: string, statuses: WorkJobStatus[], latestOutcomeFirst: boolean,
): Promise<PartnerOperationsJob[]> {
  const { rows } = await db.query<{
    id: string; capability: string; status: WorkJobStatus; attempts: number; max_attempts: number;
    created_at: Date; started_at: Date | null; finished_at: Date | null;
    recovery_pending: boolean; awaiting_connection: boolean | null;
  }>(
    `select j.id, j.capability, j.status, j.attempts, j.max_attempts, j.created_at, j.started_at, j.finished_at,
            (j.status = 'running' and not (
              j.lease_owner is not null and j.lease_expires_at is not null and j.lease_expires_at > now()
            )) as recovery_pending,
            (j.status = 'queued' and j.failure_code = 'awaiting_connection') as awaiting_connection
       from ai_work_jobs j
      where j.org_id = $1 and j.agent_instance_id = $2 and j.status = any($3::text[])
      order by case when $4::boolean then coalesce(j.finished_at, j.updated_at) end desc nulls last,
               j.created_at, j.id
      limit $5`,
    [orgId, agentId, statuses, latestOutcomeFirst, JOB_LIMIT],
  );
  return rows.map((r) => ({
    id: r.id,
    capability: capabilityLabel(r.capability),
    status: r.status,
    label: r.awaiting_connection ? "Waiting for connection" : jobLabel(r.status, r.recovery_pending),
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    createdAt: new Date(r.created_at).toISOString(),
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
  }));
}

/** Read only for getTenantDetail after its Super Admin, workforce permission and tenant scope checks. */
export async function readGrowthPartnerOperations(db: Queryable, orgId: string, identityExists: boolean, runtimeId: string | null) {
  if (!runtimeId) return { state: identityExists ? "runtime_unbound" : "identity_missing" } as const;

  const [schedules, pending, outcomes] = await Promise.all([
    db.query<{
      id: string; capability: string; enabled: boolean; next_run_at: Date; last_run_at: Date | null;
      last_skipped_reason: string | null; last_skipped_at: Date | null; last_job_status: WorkJobStatus | null;
    }>(
      `select s.id, s.capability, s.enabled, s.next_run_at, s.last_run_at, s.last_skipped_reason,
              s.last_skipped_at, j.status as last_job_status
         from ai_work_schedules s
         left join ai_work_jobs j on j.id = s.last_job_id and j.org_id = s.org_id and j.agent_instance_id = s.agent_instance_id
        where s.org_id = $1 and s.agent_instance_id = $2
        order by s.enabled desc, s.next_run_at, s.id
        limit $3`,
      [orgId, runtimeId, SCHEDULE_LIMIT],
    ),
    readJobs(db, orgId, runtimeId, PENDING, false),
    readJobs(db, orgId, runtimeId, TERMINAL, true),
  ]);
  const config = env();
  const tickIncludesSchedules = config.SCHEDULER_JOBS_ONLY === undefined
    || config.SCHEDULER_JOBS_ONLY.split(",").some((jobName) => jobName.trim() === "aiWorkSchedules");
  return {
    state: "runtime_bound" as const,
    tickEnabled: config.SCHEDULER_ENABLED,
    schedulesEnabled: schedulesOperatorEnabled(),
    tickIncludesSchedules,
    schedules: schedules.rows.map((r) => {
      const skipLabel = workforceScheduleSkipReasonLabel(r.last_skipped_reason);
      return {
        id: r.id,
        capability: capabilityLabel(r.capability),
        enabled: r.enabled,
        nextRunAt: new Date(r.next_run_at).toISOString(),
        lastQueuedAt: iso(r.last_run_at),
        lastJob: r.last_job_status ? jobLabel(r.last_job_status) : null,
        lastSkip: typeof skipLabel === "string" ? skipLabel : null,
        lastSkipAt: iso(r.last_skipped_at),
      };
    }),
    pending,
    outcomes,
    scheduleLimit: SCHEDULE_LIMIT,
    jobLimit: JOB_LIMIT,
  };
}

export type GrowthPartnerOperations = Awaited<ReturnType<typeof readGrowthPartnerOperations>>;
