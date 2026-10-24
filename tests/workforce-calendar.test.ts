import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { getWorkforceCalendarData } from "@/server/workforce/calendar";
import { addMember, agentId, createOrg, createUser, ctxFor } from "./support/fixtures";

const RANGE = {
  from: new Date("2027-03-14T00:00:00.000Z"),
  to: new Date("2027-03-21T00:00:00.000Z"),
};

let org: Awaited<ReturnType<typeof createOrg>>;
let owner: { id: string; email: string };
let member: { id: string; email: string };
let operationsManagerId: string;
let leadHunterId: string;

async function insertJob(input: Record<string, unknown>, options: {
  orgId?: string;
  requestedBy?: string | null;
  createdAt?: string;
  capability?: string;
  agentId?: string;
} = {}) {
  return withSystem(async (db) => {
    const jobOrgId = options.orgId ?? org.id;
    const agent = options.agentId
      ? { rows: [{ id: options.agentId }] }
      : await db.query<{ id: string }>(
          "select id from agent_instances where org_id = $1 and role_key = 'operations_manager'",
          [jobOrgId],
        );
    const { rows } = await db.query<{ id: string }>(
      `insert into ai_work_jobs
         (org_id, agent_instance_id, requested_by, capability, title, status, idempotency_key, input, created_at)
       values ($1, $2, $3, $4, 'Calendar review', 'queued', $5, $6::jsonb, $7::timestamptz)
       returning id`,
      [
        jobOrgId,
        agent.rows[0].id,
        options.requestedBy === undefined ? owner.id : options.requestedBy,
        options.capability ?? "crm_quality_review",
        `calendar-${crypto.randomUUID()}`,
        JSON.stringify(input),
        options.createdAt ?? "2027-03-15T08:30:00.000Z",
      ],
    );
    return rows[0].id;
  });
}

async function insertSchedule() {
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `insert into ai_work_schedules
         (org_id, agent_instance_id, created_by, capability, cadence, interval_minutes, timezone,
          recurrence_rule, business_hours, enabled, next_run_at)
       values ($1, $2, $3, 'crm_quality_review', 'daily', 1440, 'America/New_York',
               $4::jsonb, '{}'::jsonb, false, '2027-03-14T00:00:00Z'::timestamptz)
       on conflict (agent_instance_id, capability) do update set
         recurrence_rule = excluded.recurrence_rule, timezone = excluded.timezone,
         enabled = excluded.enabled, next_run_at = excluded.next_run_at
       returning id`,
      [
        org.id,
        operationsManagerId,
        owner.id,
        JSON.stringify({ kind: "daily", localTime: "09:00" }),
      ],
    );
    return rows[0].id;
  });
}

beforeAll(async () => {
  org = await createOrg({ name: "Workforce Calendar Co" });
  owner = await createUser();
  member = await createUser();
  await addMember(org.id, owner.id, "owner");
  await addMember(org.id, member.id, "member");
  operationsManagerId = await agentId(org.id, "operations_manager");
  leadHunterId = await agentId(org.id, "lead_hunter");
}, 60000);

beforeEach(() => {
  delete process.env.WORKFORCE_SCHEDULES_ENABLED;
});

afterAll(() => {
  delete process.env.WORKFORCE_SCHEDULES_ENABLED;
});

describe("workforce calendar data", () => {
  it("returns persisted jobs and sanitized schedule definitions separately", async () => {
    const scheduleId = await insertSchedule();
    const scheduledAt = "2027-03-14T13:00:00.000Z";
    const jobId = await insertJob({
      scheduled: true,
      scheduleId,
      scheduledAt,
      prompt: "Private approved research assignment must not be returned",
    }, { createdAt: "2027-03-14T13:00:07.000Z" });
    const boundaryJobId = await insertJob({
      scheduled: true,
      scheduleId,
      scheduledAt: "2027-03-21T00:00:00.000Z",
    }, { createdAt: "2027-03-20T23:59:00.000Z" });

    const data = await getWorkforceCalendarData(ctxFor(owner, org, "owner"), RANGE);
    expect(data).toMatchObject({ timezone: "UTC", operatorEnabled: false, jobsTruncated: false });
    expect(data.jobs).toHaveLength(1);
    expect(data.jobs[0]).toMatchObject({
      id: jobId,
      kind: "job",
      startsAt: scheduledAt,
      source: "schedule",
      scheduleId,
      status: "queued",
      employeeRole: "operations_manager",
    });
    expect(data.jobs.map((job) => job.id)).not.toContain(boundaryJobId);
    expect(data.jobs[0]).not.toHaveProperty("prompt");
    expect(data.jobs[0]).not.toHaveProperty("input");
    expect(data.schedules).toHaveLength(1);
    expect(data.schedules[0]).toMatchObject({
      id: scheduleId,
      kind: "schedule",
      enabled: false,
      timezone: "America/New_York",
      timezoneValid: true,
      recurrenceRule: { kind: "daily", localTime: "09:00" },
      operatorEnabled: false,
    });
    expect(data.schedules[0]).not.toHaveProperty("payload");
  });

  it("uses the scheduled UTC slot for Lead Hunter jobs without exposing assignment criteria", async () => {
    const slot = "2027-03-15T09:30";
    const jobId = await insertJob({
      origin: "schedule",
      criteria: { scheduled: true, scheduleId: crypto.randomUUID(), scheduleSlot: slot, target: "private target" },
    }, { createdAt: "2027-03-15T10:00:00.000Z", capability: "lead_research", agentId: leadHunterId });
    const data = await getWorkforceCalendarData(ctxFor(owner, org, "owner"), RANGE);
    const job = data.jobs.find((item) => item.id === jobId);
    expect(job).toMatchObject({ startsAt: "2027-03-15T09:30:00.000Z", source: "schedule" });
    expect(job).not.toHaveProperty("criteria");
  });

  it("keeps member jobs and schedule definitions within their permission scope", async () => {
    const scheduleId = await insertSchedule();
    const ownerJob = await insertJob({ prompt: "owner-only" });
    const memberJob = await insertJob({ prompt: "member-owned" }, { requestedBy: member.id });

    const memberData = await getWorkforceCalendarData(ctxFor(member, org, "member"), RANGE);
    expect(memberData.jobs.map((job) => job.id)).toEqual([memberJob]);
    expect(memberData.schedules).toEqual([]);

    const otherOrg = await createOrg({ name: "Separate Calendar Co" });
    const otherJob = await insertJob({ prompt: "other tenant" }, { orgId: otherOrg.id });
    const ownerData = await getWorkforceCalendarData(ctxFor(owner, org, "owner"), RANGE);
    expect(ownerData.jobs.map((job) => job.id)).toContain(ownerJob);
    expect(ownerData.jobs.map((job) => job.id)).not.toContain(otherJob);
    expect(ownerData.schedules.map((schedule) => schedule.id)).toContain(scheduleId);
  });

  it("returns an empty view without workforce permissions and rejects invalid or oversized ranges", async () => {
    const viewer = await createUser();
    await addMember(org.id, viewer.id, "viewer");
    const empty = await getWorkforceCalendarData(ctxFor(viewer, org, "viewer"), RANGE);
    expect(empty).toMatchObject({ jobs: [], schedules: [], jobsTruncated: false });

    await expect(getWorkforceCalendarData(ctxFor(owner, org, "owner"), {
      from: new Date("invalid"),
      to: RANGE.to,
    })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(getWorkforceCalendarData(ctxFor(owner, org, "owner"), {
      from: new Date("2027-01-01T00:00:00.000Z"),
      to: new Date("2027-04-01T00:00:00.000Z"),
    })).rejects.toMatchObject({ code: "invalid_input" });
  });
});
