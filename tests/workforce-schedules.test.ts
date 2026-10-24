import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { addMember, agentId, createOrg, createUser, ctxFor } from "./support/fixtures";
import { createConfigVersion } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import type { Permission } from "@/lib/permissions";
import { deleteSchedule, listSchedules, runDueSchedules, saveSchedule, setScheduleEnabled, schedulesOperatorEnabled } from "@/server/workforce/schedules";
import { getWorkforceCalendarData } from "@/server/workforce/calendar";
import { listWorkBoardJobs } from "@/server/workforce/work-board";
import { resetEnvCache } from "@/server/env";
import { POST as schedulerTick } from "@/app/api/internal/tick/route";

let org: Awaited<ReturnType<typeof createOrg>>;
let owner: { id: string; email: string };
let member: { id: string; email: string };
let operationsManagerId: string;

async function waitForJob(jobId: string, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { rows } = await withSystem((db) => db.query<{ status: string }>("select status from ai_work_jobs where id = $1", [jobId]));
    if (rows[0] && ["completed", "failed", "cancelled", "blocked"].includes(rows[0].status)) return rows[0];
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("scheduled job did not settle");
}

beforeAll(async () => {
  org = await createOrg({ name: "Schedule Co" });
  owner = await createUser();
  member = await createUser();
  await addMember(org.id, owner.id, "owner");
  await addMember(org.id, member.id, "member");
  operationsManagerId = await agentId(org.id, "operations_manager");
  await withSystem((db) =>
    createConfigVersion(db, {
      orgId: org.id,
      agentId: operationsManagerId,
      settings: defaultSettings("operations_manager"),
      source: "onboarding",
      userId: owner.id,
      apply: true,
    }),
  );
  await withSystem((db) => db.query("update agent_instances set status = 'online', last_health_ok = true, last_health_check_at = now() where org_id = $1", [org.id]));
}, 60000);

beforeEach(() => {
  delete process.env.WORKFORCE_SCHEDULES_ENABLED;
});

afterAll(() => {
  delete process.env.WORKFORCE_SCHEDULES_ENABLED;
});

describe("tenant AI workforce schedules", () => {
  it("saves a schedule disabled by default and does not run it without the operator switch", async () => {
    const saved = await saveSchedule(ctxFor(owner, org, "owner"), { capability: "proactive_review", cadence: "daily", enabled: false });
    expect(saved.enabled).toBe(false);
    const schedules = await listSchedules(ctxFor(owner, org, "owner"));
    expect(schedules.find((schedule) => schedule.id === saved.id)).toMatchObject({ enabled: false, cadence: "daily", operatorEnabled: false });
    expect(schedulesOperatorEnabled()).toBe(false);
    const run = await runDueSchedules();
    expect(run).toMatchObject({ operatorEnabled: false, created: 0 });
  });

  it("keeps core employee schedules available without Automation Studio access or a maintenance plan", async () => {
    const base = ctxFor(owner, org, "owner");
    const withoutStudio = {
      ...base,
      permissions: base.permissions.filter((permission) => permission !== "workflows.view"),
      can: (permission: Permission) => permission === "workflows.view" ? false : base.can(permission),
    };
    expect(withoutStudio.can("workflows.view")).toBe(false);
    await withSystem((db) => db.query(
      "delete from ai_work_schedules where org_id = $1 and agent_instance_id = $2 and capability = 'proactive_review'",
      [org.id, operationsManagerId],
    ));
    expect((await withSystem((db) => db.query(
      "select id from maintenance_subscriptions where org_id = $1 and status = 'active'",
      [org.id],
    ))).rows).toHaveLength(0);

    const saved = await saveSchedule(withoutStudio, {
      capability: "proactive_review",
      cadence: "daily",
      enabled: false,
    });
    expect(saved.enabled).toBe(false);
    expect((await listSchedules(withoutStudio)).find((schedule) => schedule.id === saved.id)).toMatchObject({
      capability: "proactive_review",
      enabled: false,
      operatorEnabled: false,
    });
  });

  it("persists a paused weekday rule and creates only the next local-time occurrence", async () => {
    process.env.WORKFORCE_SCHEDULES_ENABLED = "true";
    const recurrenceRule = { kind: "weekly", localTime: "09:00", weekdays: ["mon", "tue", "wed", "thu", "fri"] };
    const saved = await saveSchedule(ctxFor(owner, org, "owner"), {
      capability: "proactive_review",
      cadence: "weekly",
      enabled: false,
      recurrenceRule,
    });
    expect(saved.enabled).toBe(false);
    await setScheduleEnabled(ctxFor(owner, org, "owner"), saved.id, true);

    await withSystem((db) => db.query("update ai_work_schedules set next_run_at = now() - interval '1 minute' where id = $1", [saved.id]));
    const run = await runDueSchedules({ now: new Date() });
    expect(run.created).toBe(1);
    await waitForJob(run.jobIds[0]);

    const schedule = (await listSchedules(ctxFor(owner, org, "owner"))).find((row) => row.id === saved.id);
    expect(schedule?.recurrenceRule).toEqual(recurrenceRule);
    const local = new Intl.DateTimeFormat("en-US", {
      timeZone: schedule!.timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(schedule!.nextRunAt));
    expect(local).toMatch(/^(Mon|Tue|Wed|Thu|Fri) 09:00$/);
  }, 30000);

  it("creates a real durable job for a due enabled schedule only when the operator switch is on", async () => {
    process.env.WORKFORCE_SCHEDULES_ENABLED = "true";
    const saved = await saveSchedule(ctxFor(owner, org, "owner"), { capability: "proactive_review", cadence: "daily", enabled: true });
    await withSystem((db) => db.query("update ai_work_schedules set next_run_at = now() - interval '1 minute' where id = $1", [saved.id]));
    const run = await runDueSchedules({ now: new Date() });
    expect(run.operatorEnabled).toBe(true);
    expect(run.created).toBe(1);
    expect(run.jobIds).toHaveLength(1);

    const { rows: jobRows } = await withSystem((db) =>
      db.query<{ status: string; capability: string; input: { scheduled?: boolean; scheduleId?: string }; title: string }>(
        "select status, capability, input, title from ai_work_jobs where id = $1",
        [run.jobIds[0]],
      ),
    );
    expect(jobRows[0]).toMatchObject({ capability: "proactive_review", title: "On-demand operations review (scheduled)" });
    expect(jobRows[0].input).toMatchObject({ scheduled: true, scheduleId: saved.id });
    await waitForJob(run.jobIds[0]);

    const [schedule] = (await listSchedules(ctxFor(owner, org, "owner"))).filter((row) => row.id === saved.id);
    expect(schedule.lastJobId).toBe(run.jobIds[0]);
    expect(schedule.lastRunAt).toBeTruthy();
    expect(new Date(schedule.nextRunAt).getTime()).toBeGreaterThan(Date.now());

    // A second tick is not due yet, so it must not duplicate the job.
    const again = await runDueSchedules({ now: new Date() });
    expect(again.created).toBe(0);
  }, 30000);

  it("runs the real cron tick through durable tenant-scoped jobs, Work Board and Calendar history", { timeout: 30000 }, async () => {
    const otherOrg = await createOrg({ name: "Schedule Isolation Co" });
    const otherOwner = await createUser();
    await addMember(otherOrg.id, otherOwner.id, "owner");
    const crmManagerId = await agentId(otherOrg.id, "crm_manager");
    await withSystem((db) => createConfigVersion(db, {
      orgId: otherOrg.id,
      agentId: crmManagerId,
      settings: defaultSettings("crm_manager"),
      source: "onboarding",
      userId: otherOwner.id,
      apply: true,
    }));
    await withSystem((db) => db.query(
      "update agent_instances set status = 'online', last_health_ok = true, last_health_check_at = now() where id = $1 and org_id = $2",
      [crmManagerId, otherOrg.id],
    ));

    const context = ctxFor(owner, org, "owner");
    const otherContext = ctxFor(otherOwner, otherOrg, "owner");
    const operationsSchedule = await saveSchedule(context, {
      capability: "proactive_review",
      cadence: "daily",
      enabled: true,
    });
    const crmSchedule = await saveSchedule(otherContext, {
      capability: "crm_quality_review",
      cadence: "daily",
      enabled: true,
    });
    const operationSlot = (await withSystem((db) => db.query<{ next_run_at: Date }>(
      "update ai_work_schedules set next_run_at = date_trunc('minute', now()) - interval '5 minutes' where id = $1 returning next_run_at",
      [operationsSchedule.id],
    ))).rows[0].next_run_at;
    const crmSlot = (await withSystem((db) => db.query<{ next_run_at: Date }>(
      "update ai_work_schedules set next_run_at = date_trunc('minute', now()) - interval '5 minutes' where id = $1 returning next_run_at",
      [crmSchedule.id],
    ))).rows[0].next_run_at;

    const envKeys = ["CRON_SECRET", "SCHEDULER_ENABLED", "SCHEDULER_JOBS_ONLY", "WORKFORCE_SCHEDULES_ENABLED"] as const;
    const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]])) as Record<typeof envKeys[number], string | undefined>;
    const testSecret = "local-workforce-cron-test-secret-2026";
    try {
      process.env.CRON_SECRET = testSecret;
      process.env.SCHEDULER_ENABLED = "true";
      process.env.SCHEDULER_JOBS_ONLY = "aiWorkSchedules";
      process.env.WORKFORCE_SCHEDULES_ENABLED = "true";
      resetEnvCache();
      await withSystem((db) => db.query(
        "update worker_job_runs set last_started_at = now() - interval '5 minutes', last_finished_at = now() - interval '5 minutes' where job_name = any($1::text[])",
        [["scheduler_tick", "aiWorkSchedules"]],
      ));

      const response = await schedulerTick(new Request("http://localhost/api/internal/tick", {
        method: "POST",
        headers: { authorization: `Bearer ${testSecret}` },
      }));
      expect(response.status).toBe(200);
      const body = await response.json() as { ok: boolean; ran: Record<string, number | string> };
      expect(body).toMatchObject({ ok: true, ran: { aiWorkSchedules: 2 } });

      const [operationScheduleRow, crmScheduleRow] = await Promise.all([
        withSystem((db) => db.query<{ last_job_id: string; next_run_at: Date }>(
          "select last_job_id, next_run_at from ai_work_schedules where id = $1 and org_id = $2",
          [operationsSchedule.id, org.id],
        )),
        withSystem((db) => db.query<{ last_job_id: string; next_run_at: Date }>(
          "select last_job_id, next_run_at from ai_work_schedules where id = $1 and org_id = $2",
          [crmSchedule.id, otherOrg.id],
        )),
      ]);
      const operationJobId = operationScheduleRow.rows[0].last_job_id;
      const crmJobId = crmScheduleRow.rows[0].last_job_id;
      expect(operationJobId).toBeTruthy();
      expect(crmJobId).toBeTruthy();
      expect(operationJobId).not.toBe(crmJobId);
      expect(new Date(operationScheduleRow.rows[0].next_run_at).getTime()).toBeGreaterThan(Date.now());
      expect(new Date(crmScheduleRow.rows[0].next_run_at).getTime()).toBeGreaterThan(Date.now());

      expect(await waitForJob(operationJobId)).toMatchObject({ status: "completed" });
      expect(await waitForJob(crmJobId)).toMatchObject({ status: "completed" });
      const storedJobs = await withSystem((db) => db.query<{ id: string; org_id: string; capability: string; input: Record<string, unknown>; result_summary: string | null }>(
        "select id, org_id, capability, input, result_summary from ai_work_jobs where id = any($1::uuid[]) order by id",
        [[operationJobId, crmJobId]],
      ));
      expect(storedJobs.rows).toHaveLength(2);
      expect(storedJobs.rows.find((job) => job.id === operationJobId)).toMatchObject({
        org_id: org.id,
        capability: "proactive_review",
        input: { scheduled: true, scheduleId: operationsSchedule.id, scheduledAt: operationSlot.toISOString() },
      });
      expect(storedJobs.rows.find((job) => job.id === crmJobId)).toMatchObject({
        org_id: otherOrg.id,
        capability: "crm_quality_review",
        input: { scheduled: true, scheduleId: crmSchedule.id, scheduledAt: crmSlot.toISOString() },
      });
      expect(storedJobs.rows.every((job) => job.result_summary?.trim().length)).toBe(true);

      const operationBoard = await listWorkBoardJobs(context, "completed");
      const otherBoard = await listWorkBoardJobs(otherContext, "completed");
      expect(operationBoard.map((job) => job.id)).toContain(operationJobId);
      expect(operationBoard.map((job) => job.id)).not.toContain(crmJobId);
      expect(otherBoard.map((job) => job.id)).toContain(crmJobId);
      expect(otherBoard.map((job) => job.id)).not.toContain(operationJobId);

      const calendarRange = (slot: Date) => ({
        from: new Date(slot.getTime() - 1000),
        to: new Date(slot.getTime() + 60_000),
      });
      const [operationCalendar, crmCalendar] = await Promise.all([
        getWorkforceCalendarData(context, calendarRange(operationSlot)),
        getWorkforceCalendarData(otherContext, calendarRange(crmSlot)),
      ]);
      expect(operationCalendar.jobs).toMatchObject([{
        id: operationJobId,
        source: "schedule",
        scheduleId: operationsSchedule.id,
        status: "completed",
        employeeRole: "operations_manager",
      }]);
      expect(operationCalendar.jobs.map((job) => job.id)).not.toContain(crmJobId);
      expect(operationCalendar.schedules.find((schedule) => schedule.id === operationsSchedule.id)).toMatchObject({
        lastJobId: operationJobId,
        lastRunAt: expect.any(String),
        operatorEnabled: true,
      });
      expect(crmCalendar.jobs).toMatchObject([{
        id: crmJobId,
        source: "schedule",
        scheduleId: crmSchedule.id,
        status: "completed",
        employeeRole: "crm_manager",
      }]);
      expect(crmCalendar.jobs.map((job) => job.id)).not.toContain(operationJobId);

      await withSystem((db) => db.query(
        "update worker_job_runs set last_started_at = now() - interval '5 minutes', last_finished_at = now() - interval '5 minutes' where job_name = 'scheduler_tick'",
      ));
      const repeat = await schedulerTick(new Request("http://localhost/api/internal/tick", {
        method: "POST",
        headers: { authorization: `Bearer ${testSecret}` },
      }));
      expect(repeat.status).toBe(200);
      expect((await repeat.json() as { ran: Record<string, number | string> }).ran.aiWorkSchedules).toBe(0);
      const repeatedJobs = await withSystem((db) => db.query<{ count: number }>(
        "select count(*)::int as count from ai_work_jobs where org_id = any($1::uuid[]) and input->>'scheduleId' = any($2::text[]) and input->>'scheduledAt' = any($3::text[])",
        [[org.id, otherOrg.id], [operationsSchedule.id, crmSchedule.id], [operationSlot.toISOString(), crmSlot.toISOString()]],
      ));
      expect(repeatedJobs.rows[0].count).toBe(2);
    } finally {
      for (const key of envKeys) {
        const value = previousEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      resetEnvCache();
    }
  });

  it("does not create a second job while the previous scheduled job is still active", async () => {
    process.env.WORKFORCE_SCHEDULES_ENABLED = "true";
    const saved = await saveSchedule(ctxFor(owner, org, "owner"), { capability: "proactive_review", cadence: "hourly", enabled: true });
    const active = await withSystem((db) =>
      db.query<{ id: string }>(
        `insert into ai_work_jobs (org_id, agent_instance_id, requested_by, capability, title, status, idempotency_key)
         values ($1, $2, $3, 'proactive_review', 'Still running scheduled review', 'running', $4) returning id`,
        [org.id, operationsManagerId, owner.id, `active-schedule-${crypto.randomUUID()}`],
      ),
    );
    await withSystem((db) => db.query("update ai_work_schedules set last_job_id = $2, next_run_at = now() - interval '1 minute' where id = $1", [saved.id, active.rows[0].id]));
    const run = await runDueSchedules({ now: new Date() });
    expect(run.created).toBe(0);
    expect(run.skipped).toBeGreaterThanOrEqual(1);
    await withSystem((db) => db.query("update ai_work_jobs set status = 'cancelled', finished_at = now() where id = $1", [active.rows[0].id]));
  }, 30000);

  it("refuses schedule management to a member and refuses non-review capabilities", async () => {
    await expect(
      saveSchedule(ctxFor(member, org, "member"), { capability: "proactive_review", cadence: "daily", enabled: false }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      saveSchedule(ctxFor(owner, org, "owner"), { capability: "lead_research", cadence: "daily", enabled: false }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      saveSchedule(ctxFor(owner, org, "owner"), { capability: "pipeline_followup_drafts", cadence: "daily", enabled: false }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("only updates the schedule version shown in an explicit preview", async () => {
    await withSystem((db) => db.query(
      "delete from ai_work_schedules where org_id = $1 and agent_instance_id = $2 and capability = 'proactive_review'",
      [org.id, operationsManagerId],
    ));
    try {
      const initial = await saveSchedule(ctxFor(owner, org, "owner"), {
        capability: "proactive_review", cadence: "daily", enabled: false,
      });
      const original = (await listSchedules(ctxFor(owner, org, "owner"))).find((schedule) => schedule.id === initial.id)?.updatedAt;
      expect(original).toBeTruthy();
      const updated = await saveSchedule(ctxFor(owner, org, "owner"), {
        capability: "proactive_review",
        cadence: "weekly",
        enabled: false,
        recurrenceRule: { kind: "weekly", localTime: "09:00", weekdays: ["mon"] },
        expectedExistingSchedule: { id: initial.id, updatedAt: original! },
      });
      expect(updated).toEqual({ id: initial.id, enabled: false });

      await expect(saveSchedule(ctxFor(owner, org, "owner"), {
        capability: "proactive_review",
        cadence: "daily",
        enabled: false,
        expectedExistingSchedule: { id: initial.id, updatedAt: original! },
      })).rejects.toMatchObject({ code: "conflict" });
      await expect(saveSchedule(ctxFor(owner, org, "owner"), {
        capability: "proactive_review",
        cadence: "daily",
        enabled: false,
        expectedExistingSchedule: null,
      })).rejects.toMatchObject({ code: "conflict" });

      const updatedVersion = (await listSchedules(ctxFor(owner, org, "owner"))).find((schedule) => schedule.id === initial.id)?.updatedAt;
      expect(updatedVersion).toBeTruthy();
      await withSystem((db) => db.query("delete from ai_work_schedules where id = $1", [initial.id]));
      await expect(saveSchedule(ctxFor(owner, org, "owner"), {
        capability: "proactive_review",
        cadence: "daily",
        enabled: false,
        expectedExistingSchedule: { id: initial.id, updatedAt: updatedVersion! },
      })).rejects.toMatchObject({ code: "conflict" });
      expect((await listSchedules(ctxFor(owner, org, "owner"))).some((schedule) => schedule.id === initial.id)).toBe(false);
    } finally {
      await withSystem((db) => db.query(
        "delete from ai_work_schedules where org_id = $1 and agent_instance_id = $2 and capability = 'proactive_review'",
        [org.id, operationsManagerId],
      ));
    }
  });

  it("enables, disables and deletes a schedule with audit evidence", async () => {
    const saved = await saveSchedule(ctxFor(owner, org, "owner"), { capability: "proactive_review", cadence: "weekly", enabled: false });
    await setScheduleEnabled(ctxFor(owner, org, "owner"), saved.id, true);
    let schedule = (await listSchedules(ctxFor(owner, org, "owner"))).find((row) => row.id === saved.id);
    expect(schedule?.enabled).toBe(true);
    await setScheduleEnabled(ctxFor(owner, org, "owner"), saved.id, false);
    schedule = (await listSchedules(ctxFor(owner, org, "owner"))).find((row) => row.id === saved.id);
    expect(schedule?.enabled).toBe(false);
    await deleteSchedule(ctxFor(owner, org, "owner"), saved.id);
    expect((await listSchedules(ctxFor(owner, org, "owner"))).some((row) => row.id === saved.id)).toBe(false);
    const { rows } = await withSystem((db) =>
      db.query<{ action: string }>("select action from audit_logs where org_id = $1 and target_id = $2 order by created_at asc", [org.id, saved.id]),
    );
    expect(rows.map((row) => row.action)).toEqual(expect.arrayContaining([
      "workforce.schedule_saved", "workforce.schedule_enabled", "workforce.schedule_disabled", "workforce.schedule_deleted",
    ]));
  });
});
