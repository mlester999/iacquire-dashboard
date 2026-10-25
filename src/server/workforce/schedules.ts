import "server-only";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { canChat, type AgentRoleKey, type AgentStatus } from "@/lib/agents";
import { capabilityDefinition } from "@/lib/workforce-capabilities";
import { jobBlockCode, jobGate } from "@/server/automation/job-gate";
import { appendWorkEvent, createWorkJob, type WorkJobStatus } from "@/server/workforce/jobs";
import { kickWorkJob } from "@/server/workforce/work-kick";
import { createScheduledResearchJob } from "@/server/leads/scheduled-research";
import { parseResearchAssignment } from "@/lib/research-intent";
import { isWithinBusinessHours, nextSendWindow, validateBusinessHours, type BusinessHours } from "@/lib/messaging";
import {
  nextWorkforceScheduleOccurrence,
  validateWorkforceScheduleRule,
  type WorkforceScheduleRule,
} from "@/lib/workforce-schedule-recurrence";
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
  recurrenceRule: WorkforceScheduleRule | null;
  recurrenceInvalid: boolean;
  timezone: string;
  /** Empty means any time. Windows are evaluated in the schedule's own time zone. */
  businessHours: BusinessHours;
  /** The exact owner-approved assignment for a provider-backed schedule, never inferred at run time. */
  payload: { prompt?: string; target?: string; location?: string; quantity?: number };
  enabled: boolean;
  nextRunAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  lastJobId: string | null;
  lastSkippedReason: string | null;
  lastSkippedAt: string | null;
  operatorEnabled: boolean;
}

const iso = (value: Date | null | undefined) => (value ? new Date(value).toISOString() : null);

function assertSchedulableCapability(capability: string) {
  const definition = capabilityDefinition(capability);
  if (!definition) throw new AppError("invalid_input", "That capability cannot be scheduled.");
  // Lead research is the one provider-backed capability a schedule may carry. It is accepted only
  // with an exact saved assignment and still needs both operator switches before it can run.
  if (definition.key === "lead_research") return definition;
  if (!definition.workBoardAction || definition.risk !== "read_only") {
    throw new AppError("invalid_input", "That capability cannot be scheduled. Only reviewed, read-only reviews can run on a schedule.");
  }
  return definition;
}

type AgentRow = { id: string; role_key: AgentRoleKey; display_name: string; enabled: boolean; status: AgentStatus; active_config_version_id: string | null };

async function resolveAgent(ctx: OrgContext, role: AgentRoleKey, transaction?: Queryable): Promise<AgentRow> {
  const read = async (db: Queryable) => {
    const { rows } = await db.query<AgentRow>(
      "select id, role_key, display_name, enabled, status, active_config_version_id from agent_instances where org_id = $1 and role_key = $2",
      [ctx.org.orgId, role],
    );
    return rows[0] ?? null;
  };
  const agent = transaction ? await read(transaction) : await withSystem(read);
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
      id: string; capability: string; cadence: ScheduleCadence; interval_minutes: number; timezone: string; business_hours: unknown; payload: unknown; enabled: boolean;
      recurrence_rule: unknown;
      next_run_at: Date; updated_at: string; last_run_at: Date | null; last_job_id: string | null; last_skipped_reason: string | null; last_skipped_at: Date | null;
      employee_role: AgentRoleKey; employee_name: string;
    }>(
      `select s.id, s.capability, s.cadence, s.interval_minutes, s.recurrence_rule, s.timezone, s.business_hours, s.payload, s.enabled, s.next_run_at, s.updated_at::text as updated_at, s.last_run_at, s.last_job_id,
              s.last_skipped_reason, s.last_skipped_at,
              a.role_key as employee_role, a.display_name as employee_name
         from ai_work_schedules s
         join agent_instances a on a.id = s.agent_instance_id and a.org_id = s.org_id
        where s.org_id = $1
        order by s.created_at asc`,
      [ctx.org.orgId],
    );
    return rows.map((row) => {
      const recurrenceRule = validateWorkforceScheduleRule(row.recurrence_rule);
      return {
      id: row.id,
      capability: row.capability,
      capabilityLabel: capabilityDefinition(row.capability)?.label ?? row.capability.replaceAll("_", " "),
      employeeRole: row.employee_role,
      employeeName: row.employee_name,
      cadence: row.cadence,
      intervalMinutes: row.interval_minutes,
      recurrenceRule,
      recurrenceInvalid: row.recurrence_rule !== null && row.recurrence_rule !== undefined && !recurrenceRule,
      timezone: row.timezone,
      businessHours: validateBusinessHours(row.business_hours) ?? {},
      payload: typeof row.payload === "object" && row.payload !== null && !Array.isArray(row.payload)
        ? {
            prompt: typeof (row.payload as Record<string, unknown>).prompt === "string" ? String((row.payload as Record<string, unknown>).prompt) : undefined,
            target: typeof (row.payload as Record<string, unknown>).target === "string" ? String((row.payload as Record<string, unknown>).target) : undefined,
            location: typeof (row.payload as Record<string, unknown>).location === "string" ? String((row.payload as Record<string, unknown>).location) : undefined,
            quantity: typeof (row.payload as Record<string, unknown>).quantity === "number" ? Number((row.payload as Record<string, unknown>).quantity) : undefined,
          }
        : {},
      enabled: row.enabled,
      nextRunAt: new Date(row.next_run_at).toISOString(),
      updatedAt: row.updated_at,
      lastRunAt: iso(row.last_run_at),
      lastJobId: row.last_job_id,
      lastSkippedReason: row.last_skipped_reason,
      lastSkippedAt: iso(row.last_skipped_at),
      operatorEnabled: schedulesOperatorEnabled(),
      };
    });
  });
}

export interface SaveWorkforceScheduleInput {
  capability: string;
  cadence: string;
  enabled: boolean;
  businessHours?: unknown;
  payload?: unknown;
  recurrenceRule?: unknown;
  /** When present, chat confirmation may replace only the exact schedule version shown in its preview. */
  expectedExistingSchedule?: { id: string; updatedAt: string } | null;
}

export async function saveSchedule(
  ctx: OrgContext,
  input: SaveWorkforceScheduleInput,
): Promise<{ id: string; enabled: boolean }> {
  return withSystem((db) => saveScheduleInTransaction(db, ctx, input));
}

/** Shared guarded implementation so chat confirmation can save a paused schedule atomically with its preview state. */
export async function saveScheduleInTransaction(
  db: Queryable,
  ctx: OrgContext,
  input: SaveWorkforceScheduleInput,
): Promise<{ id: string; enabled: boolean }> {
  if (!ctx.can("agents.configure")) throw new AppError("forbidden", "Only owners and admins can manage AI schedules.");
  if (!ctx.can("agents.use")) throw new AppError("forbidden", "Your role can't start AI work.");
  const definition = assertSchedulableCapability(input.capability);
  if (!SCHEDULE_CADENCES.includes(input.cadence as ScheduleCadence)) throw new AppError("invalid_input", "Choose hourly, daily or weekly.");
  if (!ctx.can(definition.requiredPermission)) throw new AppError("forbidden", "Your role can't run this work.");
  const cadence = input.cadence as ScheduleCadence;
  const recurrenceRule = input.recurrenceRule === undefined || input.recurrenceRule === null
    ? null
    : validateWorkforceScheduleRule(input.recurrenceRule);
  if (input.recurrenceRule !== undefined && input.recurrenceRule !== null && !recurrenceRule) {
    throw new AppError("invalid_input", "Choose a valid daily or weekday schedule time.");
  }
  if (recurrenceRule && ((recurrenceRule.kind === "daily" && cadence !== "daily") || (recurrenceRule.kind === "weekly" && cadence !== "weekly"))) {
    throw new AppError("invalid_input", "The recurrence rule must match the selected daily or weekly cadence.");
  }
  const role = definition.allowedRoles[0];
  if (!role) throw new AppError("invalid_input", "That capability has no eligible employee role.");
  let payload: Record<string, unknown> = {};
  if (definition.key === "lead_research") {
    const prompt = typeof input.payload === "object" && input.payload !== null && !Array.isArray(input.payload) && typeof (input.payload as Record<string, unknown>).prompt === "string"
      ? String((input.payload as Record<string, unknown>).prompt).trim()
      : "";
    const assignment = parseResearchAssignment(prompt);
    if (!assignment || assignment.missing.length || !assignment.target || !assignment.location || !assignment.quantity) {
      throw new AppError("invalid_input", "Describe the lead research completely: how many businesses, what kind, and where. The schedule will run only that approved assignment.");
    }
    payload = {
      prompt: String(assignment.prompt).slice(0, 1000),
      target: assignment.target.slice(0, 120),
      location: assignment.location.slice(0, 120),
      quantity: Math.min(50, assignment.quantity),
    };
  }
  const agent = await resolveAgent(ctx, role, db);
  const intervalMinutes = CADENCE_MINUTES[cadence];
  const businessHours = input.businessHours === undefined ? null : validateBusinessHours(input.businessHours);
  if (input.businessHours !== undefined && businessHours === null) {
    throw new AppError("invalid_input", "Check the business-hour windows. Each day needs a valid start and a later end time.");
  }
  let nextRunAt: Date | null = null;
  if (recurrenceRule && input.enabled) {
    try {
      nextRunAt = nextWorkforceScheduleOccurrence(recurrenceRule, ctx.org.timezone, new Date());
    } catch {
      throw new AppError("invalid_input", "Check the workspace timezone and schedule time.");
    }
  }

  const { rows } = await db.query<{ id: string; enabled: boolean }>(
    `with expected_schedule as materialized (
         select expected.id
           from ai_work_schedules expected
          where $13::boolean
            and $14::uuid is not null
            and expected.agent_instance_id = $2::uuid
            and expected.capability = $4::text
            and expected.id = $14::uuid
            and expected.updated_at = $15::timestamptz
          for update
       )
     insert into ai_work_schedules (org_id, agent_instance_id, created_by, capability, cadence, interval_minutes, timezone, business_hours, payload, recurrence_rule, enabled, next_run_at)
       select $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::integer, $7::text, $8::jsonb, $9::jsonb, $10::jsonb, $11::boolean,
              case when $11 then coalesce($12::timestamptz, now() + make_interval(mins => $6)) else now() end
        where not $13::boolean
           or $14::uuid is null
           or exists (
                select 1 from expected_schedule
           )
       on conflict (agent_instance_id, capability) do update set
         cadence = excluded.cadence,
         interval_minutes = excluded.interval_minutes,
         timezone = excluded.timezone,
         business_hours = excluded.business_hours,
         payload = excluded.payload,
         recurrence_rule = excluded.recurrence_rule,
         enabled = excluded.enabled,
         next_run_at = case when excluded.enabled then coalesce($12::timestamptz, now() + make_interval(mins => excluded.interval_minutes)) else now() end,
         last_skipped_reason = null,
         last_skipped_at = null,
         updated_at = now()
       where not $13::boolean
          or ($14::uuid is not null and ai_work_schedules.id = $14::uuid and ai_work_schedules.updated_at = $15::timestamptz)
       returning id, enabled`,
    [
      ctx.org.orgId, agent.id, ctx.user.id, definition.key, cadence, intervalMinutes, ctx.org.timezone,
      JSON.stringify(businessHours ?? {}), JSON.stringify(payload), recurrenceRule ? JSON.stringify(recurrenceRule) : null,
      Boolean(input.enabled), nextRunAt?.toISOString() ?? null, input.expectedExistingSchedule !== undefined,
      input.expectedExistingSchedule?.id ?? null, input.expectedExistingSchedule?.updatedAt ?? null,
    ],
  );
  if (!rows[0]) throw new AppError("conflict", "The saved schedule changed after this preview. Review the current schedule and request a fresh preview.");
  await recordAudit({
    orgId: ctx.org.orgId,
    actorUserId: ctx.user.id,
    actorKind: "user",
    action: "workforce.schedule_saved",
    targetType: "ai_work_schedule",
    targetId: rows[0].id,
    result: "success",
    metadata: {
      capability: definition.key,
      cadence,
      recurrenceRule,
      enabled: Boolean(input.enabled),
      businessHours: businessHours ?? {},
      hasAssignment: Boolean(payload.prompt),
      operatorEnabled: schedulesOperatorEnabled(),
    },
  }, db);
  return { id: rows[0].id, enabled: rows[0].enabled };
}

export async function setScheduleEnabled(ctx: OrgContext, scheduleId: string, enabled: boolean): Promise<void> {
  if (!ctx.can("agents.configure")) throw new AppError("forbidden", "Only owners and admins can manage AI schedules.");
  await withSystem(async (db) => {
    const { rows } = await db.query<{ cadence: string; interval_minutes: number; timezone: string; recurrence_rule: unknown }>(
      "select cadence, interval_minutes, timezone, recurrence_rule from ai_work_schedules where id = $1 and org_id = $2 for update",
      [scheduleId, ctx.org.orgId],
    );
    const schedule = rows[0];
    if (!schedule) throw new AppError("not_found", "Schedule not found.");
    let nextRunAt = new Date();
    if (enabled) {
      const rule = validateWorkforceScheduleRule(schedule.recurrence_rule);
      if (schedule.recurrence_rule !== null && schedule.recurrence_rule !== undefined && !rule) {
        throw new AppError("invalid_input", "This saved recurrence needs correction before it can be enabled.");
      }
      try {
        nextRunAt = rule
          ? nextWorkforceScheduleOccurrence(rule, schedule.timezone, new Date())
          : new Date(Date.now() + schedule.interval_minutes * 60_000);
      } catch {
        throw new AppError("invalid_input", "Check the saved schedule time and timezone before enabling it.");
      }
    }
    await db.query(
      `update ai_work_schedules
          set enabled = $3, next_run_at = $4::timestamptz, last_skipped_reason = null, last_skipped_at = null
        where id = $1 and org_id = $2`,
      [scheduleId, ctx.org.orgId, enabled, nextRunAt.toISOString()],
    );
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
      timezone: string; business_hours: unknown; payload: unknown; recurrence_rule: unknown; next_run_at: Date; last_job_id: string | null;
    }>(
      `select id, org_id, agent_instance_id, created_by, capability, interval_minutes, timezone, business_hours, payload, recurrence_rule, next_run_at, last_job_id
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
      const recurrenceRule = validateWorkforceScheduleRule(schedule.recurrence_rule);
      if (schedule.recurrence_rule !== null && schedule.recurrence_rule !== undefined && !recurrenceRule) {
        await db.query(
          `update ai_work_schedules
              set enabled = false, last_skipped_reason = 'invalid_recurrence_rule', last_skipped_at = $2::timestamptz
            where id = $1`,
          [schedule.id, now.toISOString()],
        );
        skipped += 1;
        continue;
      }
      let nextRunAt: Date;
      try {
        nextRunAt = recurrenceRule
          ? nextWorkforceScheduleOccurrence(recurrenceRule, schedule.timezone, now)
          : new Date(now.getTime() + schedule.interval_minutes * 60_000);
      } catch {
        await db.query(
          `update ai_work_schedules
              set enabled = false, last_skipped_reason = 'invalid_schedule_timezone', last_skipped_at = $2::timestamptz
            where id = $1`,
          [schedule.id, now.toISOString()],
        );
        skipped += 1;
        continue;
      }
      const scheduledAt = new Date(schedule.next_run_at);
      const businessHours = validateBusinessHours(schedule.business_hours) ?? {};
      if (!isWithinBusinessHours(businessHours, now, schedule.timezone)) {
        // Local-time rules skip a missed occurrence rather than silently shifting it to a
        // different wall-clock time. Legacy interval rows retain their existing postponement.
        const nextWindow = recurrenceRule
          ? nextRunAt
          : nextSendWindow({
              from: now,
              timeZone: schedule.timezone,
              quietStart: "00:00",
              quietEnd: "00:00",
              businessHours,
              businessHoursOnly: true,
            });
        await db.query(
          `update ai_work_schedules
              set next_run_at = $2::timestamptz, last_skipped_reason = 'outside_business_hours', last_skipped_at = $3::timestamptz
            where id = $1`,
          [schedule.id, nextWindow.toISOString(), now.toISOString()],
        );
        skipped += 1;
        continue;
      }
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
        definition
        && definition.risk === "read_only"
        && (definition.workBoardAction || definition.key === "lead_research")
        && definition.allowedRoles[0] === row?.role_key
        && row?.enabled
        && row.active_config_version_id
        && row.status
        && canChat(row.status),
      );
      const gate = runnable && !previousActive
        ? await jobGate(db, { orgId: schedule.org_id, agentId: schedule.agent_instance_id })
        : null;
      if (gate && !gate.allowed) {
        await db.query(
          `update ai_work_schedules
              set next_run_at = $2::timestamptz, last_skipped_reason = $3, last_skipped_at = $4::timestamptz
            where id = $1`,
          [schedule.id, nextRunAt.toISOString(), jobBlockCode(gate.reason), now.toISOString()],
        );
        skipped += 1;
        continue;
      }
      if (!runnable || previousActive) {
        await db.query(
          "update ai_work_schedules set next_run_at = $2::timestamptz, last_skipped_reason = $3, last_skipped_at = $4::timestamptz where id = $1",
          [schedule.id, nextRunAt.toISOString(), previousActive ? "previous_job_active" : "employee_unavailable", now.toISOString()],
        );
        skipped += 1;
        continue;
      }
      const stamp = scheduledAt.toISOString().slice(0, 16);
      if (schedule.capability === "lead_research") {
        const scheduled = await createScheduledResearchJob(db, {
          orgId: schedule.org_id,
          agentId: schedule.agent_instance_id,
          requestedBy: schedule.created_by,
          scheduleId: schedule.id,
          slot: stamp,
          payload: typeof schedule.payload === "object" && schedule.payload !== null && !Array.isArray(schedule.payload)
            ? schedule.payload as Record<string, unknown>
            : {},
        });
        if ("skipped" in scheduled) {
          await db.query(
            `update ai_work_schedules
                set next_run_at = $2::timestamptz,
                    last_skipped_reason = $3, last_skipped_at = $4::timestamptz
              where id = $1`,
            [schedule.id, nextRunAt.toISOString(), scheduled.skipped, now.toISOString()],
          );
          skipped += 1;
          continue;
        }
        await db.query(
          `update ai_work_schedules
              set last_run_at = $2::timestamptz, last_job_id = $3, next_run_at = $4::timestamptz,
                  last_skipped_reason = null, last_skipped_at = null
            where id = $1`,
          [schedule.id, now.toISOString(), scheduled.jobId, nextRunAt.toISOString()],
        );
        jobIds.push(scheduled.jobId);
        continue;
      }
      const job = await createWorkJob(db, {
        orgId: schedule.org_id,
        agentId: schedule.agent_instance_id,
        requestedBy: schedule.created_by,
        capability: schedule.capability,
        title: `${definition!.label} (scheduled)`,
        idempotencyKey: `schedule:${schedule.id}:${stamp}`,
        input: { scheduleId: schedule.id, scheduled: true, scheduledAt: scheduledAt.toISOString() },
      });
      await db.query(
        `update ai_work_schedules
            set last_run_at = $2::timestamptz, last_job_id = $3, next_run_at = $4::timestamptz,
                last_skipped_reason = null, last_skipped_at = null
          where id = $1`,
        [schedule.id, now.toISOString(), job.id, nextRunAt.toISOString()],
      );
      await appendWorkEvent(db, {
        jobId: job.id,
        orgId: schedule.org_id,
        kind: "notice",
        message: "Created by an enabled AI workforce schedule.",
        data: { scheduleId: schedule.id, scheduledAt: scheduledAt.toISOString() },
      });
      jobIds.push(job.id);
    }
    return { created: jobIds.length, skipped, jobIds };
  });
  for (const jobId of result.jobIds) kickWorkJob(jobId);
  return { operatorEnabled: true, ...result };
}
