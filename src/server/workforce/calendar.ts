import "server-only";
import { WORK_JOB_STATUS_LABELS, workJobStageLabel, type WorkJobStatus } from "@/server/workforce/jobs";
import { capabilityDefinition } from "@/lib/workforce-capabilities";
import { validateBusinessHours, type BusinessHours } from "@/lib/messaging";
import { validateWorkforceScheduleRule, type WorkforceScheduleRule } from "@/lib/workforce-schedule-recurrence";
import { withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import type { AgentRoleKey } from "@/lib/agents";
import type { OrgContext } from "@/server/tenancy/context";
import { schedulesOperatorEnabled, type ScheduleCadence } from "@/server/workforce/schedules";

export const WORKFORCE_CALENDAR_MAX_RANGE_DAYS = 62;
const MAX_JOBS = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LOCAL_MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export interface WorkforceCalendarJob {
  id: string;
  kind: "job";
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
  employeeRole: AgentRoleKey;
  startsAt: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  source: "schedule" | "request";
  scheduleId: string | null;
}

/** Minimal schedule DTO for calendar projection; approved lead-research payloads are intentionally excluded. */
export interface WorkforceCalendarSchedule {
  id: string;
  kind: "schedule";
  capability: string;
  capabilityLabel: string;
  employeeName: string;
  employeeRole: AgentRoleKey;
  cadence: ScheduleCadence;
  intervalMinutes: number;
  recurrenceRule: WorkforceScheduleRule | null;
  recurrenceInvalid: boolean;
  timezone: string;
  timezoneValid: boolean;
  businessHours: BusinessHours;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastJobId: string | null;
  lastSkippedReason: string | null;
  lastSkippedAt: string | null;
  operatorEnabled: boolean;
}

export interface WorkforceCalendarData {
  from: string;
  to: string;
  timezone: string;
  operatorEnabled: boolean;
  jobs: WorkforceCalendarJob[];
  jobsTruncated: boolean;
  schedules: WorkforceCalendarSchedule[];
}

function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function validTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
    return true;
  } catch {
    return false;
  }
}

function scheduledJobTime(input: {
  scheduled: string | null;
  scheduled_at: string | null;
  schedule_id: string | null;
  origin: string | null;
  research_scheduled: string | null;
  research_schedule_id: string | null;
  research_schedule_slot: string | null;
}, createdAt: Date): { startsAt: Date; source: "schedule" | "request"; scheduleId: string | null } {
  if (input.scheduled === "true" && input.schedule_id && UUID.test(input.schedule_id) && input.scheduled_at && ISO_UTC_INSTANT.test(input.scheduled_at)) {
    const candidate = new Date(input.scheduled_at);
    if (Number.isFinite(candidate.getTime()) && candidate.toISOString() === input.scheduled_at) {
      return { startsAt: candidate, source: "schedule", scheduleId: input.schedule_id };
    }
  }

  // Scheduled Lead Hunter jobs persist their UTC minute in the normalized request criteria.
  if (
    input.origin === "schedule"
    && input.research_scheduled === "true"
    && input.research_schedule_id
    && UUID.test(input.research_schedule_id)
    && input.research_schedule_slot
    && LOCAL_MINUTE.test(input.research_schedule_slot)
  ) {
    const candidate = new Date(`${input.research_schedule_slot}:00.000Z`);
    if (
      Number.isFinite(candidate.getTime())
      && candidate.toISOString() === `${input.research_schedule_slot}:00.000Z`
    ) {
      return { startsAt: candidate, source: "schedule", scheduleId: input.research_schedule_id };
    }
  }

  return { startsAt: createdAt, source: "request", scheduleId: null };
}

function validateRange(from: Date, to: Date): void {
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const maxMs = WORKFORCE_CALENDAR_MAX_RANGE_DAYS * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs || toMs - fromMs > maxMs) {
    throw new AppError("invalid_input", `Choose a valid workforce calendar range of at most ${WORKFORCE_CALENDAR_MAX_RANGE_DAYS} days.`);
  }
}

/**
 * Tenant-scoped source data for the workforce calendar. Real jobs are returned as persisted
 * records; schedules are returned as sanitized recurrence definitions for future-occurrence
 * projection. Projected occurrences are never represented as jobs.
 */
export async function getWorkforceCalendarData(
  ctx: OrgContext,
  range: { from: Date; to: Date },
): Promise<WorkforceCalendarData> {
  validateRange(range.from, range.to);
  const from = range.from.toISOString();
  const to = range.to.toISOString();
  const canReadJobs = ctx.can("agents.use") || ctx.can("activity.view");
  const canReadSchedules = ctx.can("agents.configure");
  const operatorEnabled = schedulesOperatorEnabled();
  if (!canReadJobs && !canReadSchedules) {
    return { from, to, timezone: ctx.org.timezone, operatorEnabled, jobs: [], jobsTruncated: false, schedules: [] };
  }

  return withUser(ctx.user.id, async (db) => {
    let jobs: WorkforceCalendarJob[] = [];
    let jobsTruncated = false;
    if (canReadJobs) {
      const { rows } = await db.query<{
        id: string; capability: string; title: string; status: WorkJobStatus; stage: string | null;
        result_summary: string | null; result_count: number; failure_message: string | null;
        created_at: Date; started_at: Date | null; finished_at: Date | null;
        employee_name: string; employee_role: AgentRoleKey;
        scheduled: string | null; scheduled_at: string | null; schedule_id: string | null; origin: string | null;
        research_scheduled: string | null; research_schedule_id: string | null; research_schedule_slot: string | null;
      }>(
        `select j.id, j.capability, j.title, j.status, j.stage, j.result_summary, j.result_count, j.failure_message,
                j.created_at, j.started_at, j.finished_at,
                a.display_name as employee_name, a.role_key as employee_role,
                j.input->>'scheduled' as scheduled, j.input->>'scheduledAt' as scheduled_at,
                j.input->>'scheduleId' as schedule_id, j.input->>'origin' as origin,
                j.input->'criteria'->>'scheduled' as research_scheduled,
                j.input->'criteria'->>'scheduleId' as research_schedule_id,
                j.input->'criteria'->>'scheduleSlot' as research_schedule_slot
           from ai_work_jobs j
           join agent_instances a on a.id = j.agent_instance_id and a.org_id = j.org_id
          where j.org_id = $1
            and ($2::boolean or j.requested_by = $3)
            and (
              (j.created_at >= $4::timestamptz and j.created_at < $5::timestamptz)
              or (j.input->>'scheduledAt' >= $6::text and j.input->>'scheduledAt' < $7::text)
              or (j.input->'criteria'->>'scheduleSlot' >= $8::text and j.input->'criteria'->>'scheduleSlot' < $9::text)
            )
          order by j.created_at desc, j.id
          limit $10`,
        [
          ctx.org.orgId,
          ctx.can("activity.view"),
          ctx.user.id,
          from,
          to,
          from,
          to,
          from.slice(0, 16),
          to.slice(0, 16),
          MAX_JOBS + 1,
        ],
      );
      jobsTruncated = rows.length > MAX_JOBS;
      jobs = rows.slice(0, MAX_JOBS).flatMap((row) => {
        const createdAt = new Date(row.created_at);
        const timing = scheduledJobTime(row, createdAt);
        if (timing.startsAt < range.from || timing.startsAt >= range.to) return [];
        return [{
          id: row.id,
          kind: "job" as const,
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
          startsAt: timing.startsAt.toISOString(),
          createdAt: createdAt.toISOString(),
          startedAt: iso(row.started_at),
          finishedAt: iso(row.finished_at),
          source: timing.source,
          scheduleId: timing.scheduleId,
        }];
      }).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    }

    let schedules: WorkforceCalendarSchedule[] = [];
    if (canReadSchedules) {
      const { rows } = await db.query<{
        id: string; capability: string; cadence: ScheduleCadence; interval_minutes: number;
        recurrence_rule: unknown; timezone: string; business_hours: unknown; enabled: boolean;
        next_run_at: Date; last_run_at: Date | null; last_job_id: string | null;
        last_skipped_reason: string | null; last_skipped_at: Date | null;
        employee_role: AgentRoleKey; employee_name: string;
      }>(
        `select s.id, s.capability, s.cadence, s.interval_minutes, s.recurrence_rule, s.timezone,
                s.business_hours, s.enabled, s.next_run_at, s.last_run_at, s.last_job_id,
                s.last_skipped_reason, s.last_skipped_at,
                a.role_key as employee_role, a.display_name as employee_name
           from ai_work_schedules s
           join agent_instances a on a.id = s.agent_instance_id and a.org_id = s.org_id
          where s.org_id = $1
          order by s.created_at, s.id`,
        [ctx.org.orgId],
      );
      schedules = rows.map((row) => {
        const recurrenceRule = validateWorkforceScheduleRule(row.recurrence_rule);
        return {
          id: row.id,
          kind: "schedule",
          capability: row.capability,
          capabilityLabel: capabilityDefinition(row.capability)?.label ?? row.capability.replaceAll("_", " "),
          employeeName: row.employee_name,
          employeeRole: row.employee_role,
          cadence: row.cadence,
          intervalMinutes: row.interval_minutes,
          recurrenceRule,
          recurrenceInvalid: row.recurrence_rule !== null && row.recurrence_rule !== undefined && !recurrenceRule,
          timezone: row.timezone,
          timezoneValid: validTimeZone(row.timezone),
          businessHours: validateBusinessHours(row.business_hours) ?? {},
          enabled: row.enabled,
          nextRunAt: new Date(row.next_run_at).toISOString(),
          lastRunAt: iso(row.last_run_at),
          lastJobId: row.last_job_id,
          lastSkippedReason: row.last_skipped_reason,
          lastSkippedAt: iso(row.last_skipped_at),
          operatorEnabled,
        };
      });
    }

    return { from, to, timezone: ctx.org.timezone, operatorEnabled, jobs, jobsTruncated, schedules };
  });
}
