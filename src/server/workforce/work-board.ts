import "server-only";
import { withUser } from "@/server/db";
import { DRAFT_MESSAGE_IDS_SQL, loadDraftCountsForJobs, workJobEvidence, workJobStageLabel, workJobStatusLabel, type WorkJobStatus } from "@/server/workforce/jobs";
import type { EvidenceMarker } from "@/lib/evidence-class";
import { isCompletedWork, isPreparedOnlyWork } from "@/lib/work-board-status";
import type { OrgContext } from "@/server/tenancy/context";

export type WorkBoardFilter = "all" | "active" | "attention" | "completed";

export interface WorkBoardJob {
  id: string;
  capability: string;
  title: string;
  status: WorkJobStatus;
  statusLabel: string;
  /** What kind of thing this work produced, computed on read (nothing is stored). Null until it has produced something; optional so a board built from older data still types. */
  evidence?: EvidenceMarker | null;
  /** True when the persisted running state has no unexpired worker lease. */
  recoveryPending: boolean;
  stage: string | null;
  stageLabel: string | null;
  resultSummary: string | null;
  resultCount: number;
  failureMessage: string | null;
  failureCode?: string | null;
  failureHref?: string | null;
  employeeName: string;
  employeeRole: string;
  conversationId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  latestEvent: { message: string; kind: string; createdAt: string } | null;
}

export interface WorkBoardSummary {
  active: number;
  waiting: number;
  needsAttention: number;
  completedToday: number;
}

function iso(value: Date | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

/**
 * Tenant-scoped work board read. Row-level security limits a regular member to work they
 * requested; an owner or admin with `activity.view` sees the workspace's queue. Event payloads stay
 * private; only the persisted message and a safe internal fix route are returned.
 */
export async function listWorkBoardJobs(ctx: OrgContext, filter: WorkBoardFilter = "all"): Promise<WorkBoardJob[]> {
  if (!ctx.can("agents.use") && !ctx.can("activity.view")) return [];
  const scopeAll = ctx.can("activity.view");
  const rows = await withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<{
      id: string; capability: string; title: string; status: WorkJobStatus; stage: string | null;
      result_summary: string | null; result_count: number; failure_message: string | null;
      conversation_id: string | null; created_at: Date; started_at: Date | null; finished_at: Date | null;
      employee_name: string; employee_role: string;
      event_message: string | null; event_kind: string | null; event_href: string | null; event_at: Date | null;
      failure_code: string | null;
      recovery_pending: boolean;
      draft_message_ids: unknown;
    }>(
      `select j.id, j.capability, j.title, j.status, j.stage, j.result_summary, j.result_count, j.failure_code, j.failure_message,
              j.conversation_id, j.created_at, j.started_at, j.finished_at,
              a.display_name as employee_name, a.role_key as employee_role,
              e.message as event_message, e.kind as event_kind, e.href as event_href, e.created_at as event_at,
              (j.status = 'running' and not (j.lease_owner is not null and j.lease_expires_at is not null and j.lease_expires_at > now())) as recovery_pending,
              -- A finished follow-up draft job lists its drafts as they were when it finished; the ids are looked up below, because a viewer may not be allowed to open every
              -- conversation a draft sits in and the board must count them the way the job panel does.
              ${DRAFT_MESSAGE_IDS_SQL} as draft_message_ids
         from ai_work_jobs j
         join agent_instances a on a.id = j.agent_instance_id and a.org_id = j.org_id
         left join lateral (
           select kind, message, data->>'href' as href, created_at from ai_work_events
            where job_id = j.id order by id desc limit 1
         ) e on true
        where j.org_id = $1
          and ($2::boolean or j.requested_by = $3)
          and (
            $4::text = 'all'
            or ($4 = 'active' and (j.status in ('queued', 'waiting_for_approval') or (j.status = 'running' and j.lease_owner is not null and j.lease_expires_at is not null and j.lease_expires_at > now())))
            or ($4 = 'attention' and (j.status in ('failed', 'blocked', 'waiting_for_approval') or (j.status = 'running' and not (j.lease_owner is not null and j.lease_expires_at is not null and j.lease_expires_at > now()))))
            or ($4 = 'completed' and j.status = 'completed')
          )
        order by
          case j.status when 'running' then 0 when 'waiting_for_approval' then 1 when 'queued' then 2 when 'blocked' then 3 when 'failed' then 4 else 5 end,
          coalesce(j.finished_at, j.started_at, j.created_at) desc
        limit 100`,
      [ctx.org.orgId, scopeAll, ctx.user.id, filter],
    );
    return rows;
  });
  const draftCounts = await loadDraftCountsForJobs(ctx.org.orgId, rows.map((row) => ({ id: row.id, draftMessageIds: row.draft_message_ids })));
  const jobs = rows.map((row) => {
    const drafts = draftCounts.get(row.id) ?? null;
    const evidence = workJobEvidence(row, drafts);
    return {
      id: row.id,
      capability: row.capability,
      title: row.title,
      status: row.status,
      statusLabel: row.failure_code === "awaiting_connection"
        ? "Waiting for connection"
        : workJobStatusLabel({ status: row.status, recoveryPending: row.recovery_pending, capability: row.capability }, evidence, drafts),
      evidence,
      recoveryPending: row.recovery_pending,
      stage: row.stage,
      stageLabel: workJobStageLabel(row.stage),
      resultSummary: row.result_summary,
      resultCount: row.result_count,
      failureMessage: row.failure_message,
      failureCode: row.failure_code,
      failureHref: row.event_href?.startsWith("/") && !row.event_href.startsWith("//") && !row.event_href.includes("\\") ? row.event_href : null,
      employeeName: row.employee_name,
      employeeRole: row.employee_role,
      conversationId: row.conversation_id,
      createdAt: new Date(row.created_at).toISOString(),
      startedAt: iso(row.started_at),
      finishedAt: iso(row.finished_at),
      latestEvent: row.event_message
        ? { message: row.event_message, kind: row.event_kind ?? "notice", createdAt: iso(row.event_at) ?? new Date(row.created_at).toISOString() }
        : null,
    };
  });
  return filter === "completed"
    ? jobs.filter((job) => isCompletedWork(job.status, job.evidence, job.capability))
    : jobs;
}

export async function workBoardSummary(ctx: OrgContext): Promise<WorkBoardSummary> {
  if (!ctx.can("agents.use") && !ctx.can("activity.view")) return { active: 0, waiting: 0, needsAttention: 0, completedToday: 0 };
  const scopeAll = ctx.can("activity.view");
  const data = await withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<{ active: number; waiting: number; needs_attention: number }>(
      `select
         count(*) filter (where status = 'running' and lease_owner is not null and lease_expires_at is not null and lease_expires_at > now())::int as active,
         count(*) filter (where status = 'waiting_for_approval')::int as waiting,
         count(*) filter (where status in ('failed', 'blocked', 'waiting_for_approval') or (status = 'running' and not (lease_owner is not null and lease_expires_at is not null and lease_expires_at > now())))::int as needs_attention
       from ai_work_jobs
       where org_id = $1 and ($2::boolean or requested_by = $3)`,
      [ctx.org.orgId, scopeAll, ctx.user.id],
    );
    const completed = await db.query<{ id: string; capability: string; status: WorkJobStatus; draft_message_ids: unknown }>(
      `select j.id, j.capability, j.status, ${DRAFT_MESSAGE_IDS_SQL} as draft_message_ids
         from ai_work_jobs j
        where j.org_id = $1 and ($2::boolean or j.requested_by = $3)
          and j.status = 'completed'
          and j.finished_at >= (date_trunc('day', now() at time zone $4) at time zone $4)`,
      [ctx.org.orgId, scopeAll, ctx.user.id, ctx.org.timezone],
    );
    return { counts: rows[0], completedJobs: completed.rows };
  });
  const draftCounts = await loadDraftCountsForJobs(ctx.org.orgId, data.completedJobs.map((job) => ({ id: job.id, draftMessageIds: job.draft_message_ids })));
  const completedToday = data.completedJobs.reduce((count, job) => {
    const evidence = workJobEvidence(job, draftCounts.get(job.id) ?? null);
    return count + (isPreparedOnlyWork(job.status, evidence, job.capability) ? 0 : 1);
  }, 0);
  return {
    active: data.counts?.active ?? 0,
    waiting: data.counts?.waiting ?? 0,
    needsAttention: data.counts?.needs_attention ?? 0,
    completedToday,
  };
}
