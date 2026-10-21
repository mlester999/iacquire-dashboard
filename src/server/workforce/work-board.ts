import "server-only";
import { withUser } from "@/server/db";
import { workJobStageLabel, WORK_JOB_STATUS_LABELS, type WorkJobStatus } from "@/server/workforce/jobs";
import type { OrgContext } from "@/server/tenancy/context";

export type WorkBoardFilter = "all" | "active" | "attention" | "completed";

export interface WorkBoardJob {
  id: string;
  capability: string;
  title: string;
  status: WorkJobStatus;
  statusLabel: string;
  stage: string | null;
  stageLabel: string | null;
  resultSummary: string | null;
  resultCount: number;
  failureMessage: string | null;
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
  failed: number;
  completedToday: number;
}

function iso(value: Date | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

/**
 * Tenant-scoped work board read. Row-level security limits a regular member to work they
 * requested; an owner or admin with `activity.view` sees the workspace's queue. No event payload
 * beyond the persisted human-readable message is returned.
 */
export async function listWorkBoardJobs(ctx: OrgContext, filter: WorkBoardFilter = "all"): Promise<WorkBoardJob[]> {
  if (!ctx.can("agents.use") && !ctx.can("activity.view")) return [];
  const scopeAll = ctx.can("activity.view");
  const statuses: string[] | null =
    filter === "active" ? ["queued", "running", "waiting_for_approval"]
      : filter === "attention" ? ["failed", "blocked", "waiting_for_approval"]
        : filter === "completed" ? ["completed"]
          : null;
  return withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<{
      id: string; capability: string; title: string; status: WorkJobStatus; stage: string | null;
      result_summary: string | null; result_count: number; failure_message: string | null;
      conversation_id: string | null; created_at: Date; started_at: Date | null; finished_at: Date | null;
      employee_name: string; employee_role: string;
      event_message: string | null; event_kind: string | null; event_at: Date | null;
    }>(
      `select j.id, j.capability, j.title, j.status, j.stage, j.result_summary, j.result_count, j.failure_message,
              j.conversation_id, j.created_at, j.started_at, j.finished_at,
              a.display_name as employee_name, a.role_key as employee_role,
              e.message as event_message, e.kind as event_kind, e.created_at as event_at
         from ai_work_jobs j
         join agent_instances a on a.id = j.agent_instance_id and a.org_id = j.org_id
         left join lateral (
           select kind, message, created_at from ai_work_events
            where job_id = j.id order by id desc limit 1
         ) e on true
        where j.org_id = $1
          and ($2::boolean or j.requested_by = $3)
          and ($4::text[] is null or j.status = any($4::text[]))
        order by
          case j.status when 'running' then 0 when 'waiting_for_approval' then 1 when 'queued' then 2 when 'blocked' then 3 when 'failed' then 4 else 5 end,
          coalesce(j.finished_at, j.started_at, j.created_at) desc
        limit 100`,
      [ctx.org.orgId, scopeAll, ctx.user.id, statuses],
    );
    return rows.map((row) => ({
      id: row.id,
      capability: row.capability,
      title: row.title,
      status: row.status,
      statusLabel: WORK_JOB_STATUS_LABELS[row.status],
      stage: row.stage,
      stageLabel: workJobStageLabel(row.stage),
      resultSummary: row.result_summary,
      resultCount: row.result_count,
      failureMessage: row.failure_message,
      employeeName: row.employee_name,
      employeeRole: row.employee_role,
      conversationId: row.conversation_id,
      createdAt: new Date(row.created_at).toISOString(),
      startedAt: iso(row.started_at),
      finishedAt: iso(row.finished_at),
      latestEvent: row.event_message
        ? { message: row.event_message, kind: row.event_kind ?? "notice", createdAt: iso(row.event_at) ?? new Date(row.created_at).toISOString() }
        : null,
    }));
  });
}

export async function workBoardSummary(ctx: OrgContext): Promise<WorkBoardSummary> {
  if (!ctx.can("agents.use") && !ctx.can("activity.view")) return { active: 0, waiting: 0, failed: 0, completedToday: 0 };
  const scopeAll = ctx.can("activity.view");
  return withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<{ active: number; waiting: number; failed: number; completed_today: number }>(
      `select
         count(*) filter (where status = 'running')::int as active,
         count(*) filter (where status = 'waiting_for_approval')::int as waiting,
         count(*) filter (where status = 'failed')::int as failed,
         count(*) filter (
           where status = 'completed'
             and finished_at >= (date_trunc('day', now() at time zone $4) at time zone $4)
         )::int as completed_today
       from ai_work_jobs
       where org_id = $1 and ($2::boolean or requested_by = $3)`,
      [ctx.org.orgId, scopeAll, ctx.user.id, ctx.org.timezone],
    );
    const row = rows[0];
    return {
      active: row?.active ?? 0,
      waiting: row?.waiting ?? 0,
      failed: row?.failed ?? 0,
      completedToday: row?.completed_today ?? 0,
    };
  });
}
