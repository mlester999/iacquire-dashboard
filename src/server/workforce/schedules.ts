import "server-only";
import { withSystem, withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { canChat, type AgentRoleKey, type AgentStatus } from "@/lib/agents";
import { capabilityDefinition } from "@/lib/workforce-capabilities";
import { appendWorkEvent, createWorkJob, type WorkJobStatus } from "@/server/workforce/jobs";
import { kickWorkJob } from "@/server/workforce/work-runner";
import type { OrgContext } from "@/server/tenancy/context";

/**
 * Tenant-scoped AI workforce schedules.
 *
 * A schedule only creates durable jobs when:
 *   1. the row is enabled;
 *   2. the operator has set WORKFORCE_SCHEDULES_ENABLED=true;
 *   3. the employee is enabled, configured and available;
 *   4. the capability is still in the reviewed, read-only allowlist.
 *
 * The tick never runs provider work itself. It creates a job and wakes the worker/recovery path.
 */

export const SCHEDULE_CADENCES = ["hourly", "daily", "weekly"] as const;
export type ScheduleCadence = (typeof SCHEDULE_CADENCES)[number];
const CADENCE_MINUTES: Record<ScheduleCadence, number> = { hourly: 60, daily: 1440, weekly: 10080 };

export function schedulesOperatorEnabled(): boolean {
  return process.env.WORKFORCE_SCHEDULES_ENABLED === "true";
}

export interface ScheduleView {
  id: string;
  capability: string;
  capabilityLabel: string;
  employeeRole: AgentRoleKey;
  employeeName: string;
  cadence: ScheduleCadence;
  intervalMinutes: number;
  timezone: string;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastJobId: string | null;
  operatorEnabled: boolean;
}

const iso = (value: Date | null | undefined) => (value ? new Date(value).toISOString() : null);

function assertSchedulableCapability(capability: string) {
  const definition = capabilityDefinition(capability);
  if (!definition || !definition.workBoardAction || definition.risk !== "read_only") {
    throw new AppError("invalid_input", "That capability cannot be scheduled. Only reviewed, read-only reviews can run on a schedule.");
  }
  return definition;
}

type AgentRow = { id: string; role_key: AgentRoleKey; display_name: string; enabled: boolean; status: AgentStatus; active_config_version_id: string | null };

async function resolveAgent(ctx: OrgContext, role: AgentRoleKey): Promise<AgentRow> {
  const agent = await withSystem(async (db) => {
    const { rows } = await db.query<AgentRow>(
      "select id, role_key, display_name, enabled, status, active_config_version_id from agent_instances where org_id = $1 and role_key = $2",
      [ctx.org.orgId, role],
    );
    return rows[0] ?? null;
  });
  if (!agent) throw new AppError("not_found", "AI employee not found.");
  if (!agent.enabled) throw new AppError("agent_unavailable", "This AI employee is paused.");
  if (!agent.active_config_version_id) throw new AppError("agent_unavailable", "This AI employee has no applied configuration yet.");
  if (!canChat(agent.status)) throw new AppError("agent_unavailable", "This AI employee is not available for scheduled work yet.");
  return agent;
}

export async function listSchedules(ctx: OrgContext): Promise<ScheduleView[]> {
  if (!ctx.can("agents.configure")) return [];
  return withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<{
      id: string; capability: string; cadence: ScheduleCadence; interval_minutes: number; timezone: string; enabled: boolean;
      next_run_at: Date; last_run_at: Date | null; last_job_id: string | null; employee_role: AgentRoleKey; employee_name: string;
    }>(
      `select s.id, s.capability, s.cadence, s.interval_minutes, s.timezone, s.enabled, s.next_run_at, s.last_run_at, s.last_job_id,
              a.role_key as employee_role, a.display_name as employee_name
         from ai_work_schedules s
         join agent_instances a on a.id = s.agent_instance_id and a.org_id = s.org_id
        where s.org_id = $1
        order by s.created_at asc`,
      [ctx.org.orgId],
    );
    return rows.map((row) => ({
      id: row.id,
      capability: row.capability,
      capabilityLabel: capabilityDefinition(row.capability)?.label ?? row.capability.replaceAll("_", " "),
      employeeRole: row.employee_role,
      employeeName: row.employee_name,
      cadence: row.cadence,
      intervalMinutes: row.interval_minutes,
      timezone: row.timezone,
      enabled: row.enabled,
      nextRunAt: new Date(row.next_run_at).toISOString(),
      lastRunAt: iso(row.last_run_at),
      lastJobId: row.last_job_id,
      operatorEnabled: schedulesOperatorEnabled(),
    }));
  });
}

export async function saveSchedule(ctx: OrgContext, input: { capability: string; cadence: string; enabled: boolean }): Promise<{ id: string; enabled: boolean }> {
  if (!ctx.can("agents.configure")) throw new AppError("forbidden", "Only owners and admins can manage AI schedules.");
  if (!ctx.can("agents.use")) throw new AppError("forbidden", "Your role can't start AI work.");
  const definition = assertSchedulableCapability(input.capability);
  if (!SCHEDULE_CADENCES.includes(input.cadence as ScheduleCadence)) throw new AppError("invalid_input", "Choose hourly, daily or weekly.");
  if (!ctx.can(definition.requiredPermission)) throw new AppError("forbidden", "Your role can't run this review.");
  const cadence = input.cadence as ScheduleCadence;
  const role = definition.allowedRoles[0];
  if (!role) throw new AppError("invalid_input", "That capability has no eligible employee role.");
  const agent = await resolveAgent(ctx, role);
  const intervalMinutes = CADENCE_MINUTES[cadence];

  const saved = await withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; enabled: boolean }>(
      `insert into ai_work_schedules (org_id, agent_instance_id, created_by, capability, cadence, interval_minutes, timezone, enabled, next_run_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, case when $8 then now() + make_interval(mins => $6) else now() end)
       on conflict (agent_instance_id, capability) do update set
         cadence = excluded.cadence,
         interval_minutes = excluded.interval_minutes,
         timezone = excluded.timezone,
         enabled = excluded.enabled,
         next_run_at = case when excluded.enabled then now() + make_interval(mins => excluded.interval_minutes) else now() end,
         updated_at = now()
       returning id, enabled`,
      [ctx.org.orgId, agent.id, ctx.user.id, definition.key, cadence, intervalMinutes, ctx.org.timezone, Boolean(input.enabled)],
    );
    await recordAudit({
      orgId: ctx.org.orgId,
      actorUserId: ctx.user.id,
      actorKind: "user",
      action: "workforce.schedule_saved",
      targetType: "ai_work_schedule",
      targetId: rows[0].id,
      result: "success",
      metadata: { capability: definition.key, cadence, enabled: Boolean(input.enabled), operatorEnabled: schedulesOperatorEnabled() },
    }, db);
    return rows[0];
  });
  return { id: saved.id, enabled: saved.enabled };
}

export async function setScheduleEnabled(ctx: OrgContext, scheduleId: string, enabled: boolean): Promise<void> {
  if (!ctx.can("agents.configure")) throw new AppError("forbidden", "Only owners and admins can manage AI schedules.");
  await withSystem(async (db) => {
    const { rowCount } = await db.query(
      `update ai_work_schedules
          set enabled = $3, next_run_at = case when $3 then now() + make_interval(mins => interval_minutes) else now() end
        where id = $1 and org_id = $2`,
      [scheduleId, ctx.org.orgId, enabled],
    );
    if (!rowCount) throw new AppError("not_found", "Schedule not found.");
    await recordAudit({
      orgId: ctx.org.orgId,
      actorUserId: ctx.user.id,
      actorKind: "user",
      action: enabled ? "workforce.schedule_enabled" : "workforce.schedule_disabled",
      targetType: "ai_work_schedule",
      targetId: scheduleId,
      result: "success",
      metadata: { operatorEnabled: schedulesOperatorEnabled() },
    }, db);
  });
}

export async function deleteSchedule(ctx: OrgContext, scheduleId: string): Promise<void> {
  if (!ctx.can("agents.configure")) throw new AppError("forbidden", "Only owners and admins can manage AI schedules.");
  await withSystem(async (db) => {
    const { rowCount } = await db.query("delete from ai_work_schedules where id = $1 and org_id = $2", [scheduleId, ctx.org.orgId]);
    if (!rowCount) throw new AppError("not_found", "Schedule not found.");
    await recordAudit({
      orgId: ctx.org.orgId,
      actorUserId: ctx.user.id,
      actorKind: "user",
      action: "workforce.schedule_deleted",
      targetType: "ai_work_schedule",
      targetId: scheduleId,
      result: "success",
    }, db);
  });
}

const ACTIVE: WorkJobStatus[] = ["queued", "running", "waiting_for_approval"];

/**
 * Creates jobs for due schedules. The operator switch is checked before any query, so deploying a
 * schedule or enabling a row cannot start autonomous work unless the operator explicitly turns it on.
 */
export async function runDueSchedules(options: { now?: Date; limit?: number } = {}): Promise<{
  operatorEnabled: boolean;
  created: number;
  skipped: number;
  jobIds: string[];
}> {
  if (!schedulesOperatorEnabled()) return { operatorEnabled: false, created: 0, skipped: 0, jobIds: [] };
  const now = options.now ?? new Date();
  const limit = Math.min(10, Math.max(1, options.limit ?? 3));
  const result = await withSystem(async (db) => {
    const { rows: due } = await db.query<{
      id: string; org_id: string; agent_instance_id: string; created_by: string | null; capability: string; interval_minutes: number;
      last_job_id: string | null;
    }>(
      `select id, org_id, agent_instance_id, created_by, capability, interval_minutes, last_job_id
         from ai_work_schedules
        where enabled and next_run_at <= $1
        order by next_run_at asc
        for update skip locked
        limit $2`,
      [now, limit],
    );

    const jobIds: string[] = [];
    let skipped = 0;
    for (const schedule of due) {
      const definition = capabilityDefinition(schedule.capability);
      const agent = await db.query<{ role_key: AgentRoleKey; enabled: boolean; status: AgentStatus; active_config_version_id: string | null }>(
        "select role_key, enabled, status, active_config_version_id from agent_instances where id = $1 and org_id = $2",
        [schedule.agent_instance_id, schedule.org_id],
      );
      const row = agent.rows[0];
      let previousActive = false;
      if (schedule.last_job_id) {
        const previous = await db.query<{ status: WorkJobStatus }>("select status from ai_work_jobs where id = $1 and org_id = $2", [schedule.last_job_id, schedule.org_id]);
        previousActive = previous.rows[0] ? ACTIVE.includes(previous.rows[0].status) : false;
      }
      const runnable = Boolean(
        definition?.workBoardAction
        && definition.risk === "read_only"
        && definition.allowedRoles[0] === row?.role_key
        && row?.enabled
        && row.active_config_version_id
        && row.status
        && canChat(row.status),
      );
      if (!runnable || previousActive) {
        await db.query("update ai_work_schedules set next_run_at = $2::timestamptz + make_interval(mins => interval_minutes) where id = $1", [schedule.id, now]);
        skipped += 1;
        continue;
      }
      const stamp = now.toISOString().slice(0, 16);
      const job = await createWorkJob(db, {
        orgId: schedule.org_id,
        agentId: schedule.agent_instance_id,
        requestedBy: schedule.created_by,
        capability: schedule.capability,
        title: `${definition!.label} (scheduled)`,
        idempotencyKey: `schedule:${schedule.id}:${stamp}`,
        input: { scheduleId: schedule.id, scheduled: true },
      });
      await db.query(
        "update ai_work_schedules set last_run_at = $2::timestamptz, last_job_id = $3, next_run_at = $2::timestamptz + make_interval(mins => interval_minutes) where id = $1",
        [schedule.id, now, job.id],
      );
      await appendWorkEvent(db, {
        jobId: job.id,
        orgId: schedule.org_id,
        kind: "notice",
        message: "Created by an enabled AI workforce schedule.",
        data: { scheduleId: schedule.id },
      });
      jobIds.push(job.id);
    }
    return { created: jobIds.length, skipped, jobIds };
  });
  for (const jobId of result.jobIds) kickWorkJob(jobId);
  return { operatorEnabled: true, ...result };
}
