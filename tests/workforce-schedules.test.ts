import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { addMember, agentId, createOrg, createUser, ctxFor } from "./support/fixtures";
import { createConfigVersion } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { deleteSchedule, listSchedules, runDueSchedules, saveSchedule, setScheduleEnabled, schedulesOperatorEnabled } from "@/server/workforce/schedules";

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
      const original = (await withSystem((db) => db.query<{ updated_at: string }>(
        "select updated_at::text as updated_at from ai_work_schedules where id = $1",
        [initial.id],
      ))).rows[0].updated_at;
      const updated = await saveSchedule(ctxFor(owner, org, "owner"), {
        capability: "proactive_review",
        cadence: "weekly",
        enabled: false,
        recurrenceRule: { kind: "weekly", localTime: "09:00", weekdays: ["mon"] },
        expectedExistingSchedule: { id: initial.id, updatedAt: original },
      });
      expect(updated).toEqual({ id: initial.id, enabled: false });

      await expect(saveSchedule(ctxFor(owner, org, "owner"), {
        capability: "proactive_review",
        cadence: "daily",
        enabled: false,
        expectedExistingSchedule: { id: initial.id, updatedAt: original },
      })).rejects.toMatchObject({ code: "conflict" });
      await expect(saveSchedule(ctxFor(owner, org, "owner"), {
        capability: "proactive_review",
        cadence: "daily",
        enabled: false,
        expectedExistingSchedule: null,
      })).rejects.toMatchObject({ code: "conflict" });
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
