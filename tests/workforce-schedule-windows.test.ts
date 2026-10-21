import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { addMember, agentId, createOrg, createUser, ctxFor } from "./support/fixtures";
import { createConfigVersion } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { listSchedules, runDueSchedules, saveSchedule } from "@/server/workforce/schedules";

let org: Awaited<ReturnType<typeof createOrg>>;
let owner: { id: string; email: string };

async function waitForJob(jobId: string, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { rows } = await withSystem((db) => db.query<{ status: string }>("select status from ai_work_jobs where id = $1", [jobId]));
    if (rows[0] && ["completed", "failed", "cancelled", "blocked"].includes(rows[0].status)) return rows[0];
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("business-hours job did not settle");
}

beforeAll(async () => {
  process.env.WORKFORCE_SCHEDULES_ENABLED = "true";
  org = await createOrg({ name: "Business Hours Co" });
  owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  const operationsManagerId = await agentId(org.id, "operations_manager");
  const leadHunterId = await agentId(org.id, "lead_hunter");
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
  await withSystem((db) =>
    createConfigVersion(db, {
      orgId: org.id,
      agentId: leadHunterId,
      settings: defaultSettings("lead_hunter"),
      source: "onboarding",
      userId: owner.id,
      apply: true,
    }),
  );
  await withSystem((db) => db.query("update agent_instances set status = 'online', last_health_ok = true, last_health_check_at = now() where org_id = $1", [org.id]));
}, 60000);

afterAll(() => {
  delete process.env.WORKFORCE_SCHEDULES_ENABLED;
});

describe("business-hours monitoring schedules", () => {
  it("postpones a due schedule outside its local business hours instead of running it", async () => {
    const saved = await saveSchedule(ctxFor(owner, org, "owner"), {
      capability: "proactive_review",
      cadence: "daily",
      enabled: true,
      businessHours: { mon: [["09:00", "17:00"]], tue: [["09:00", "17:00"]], wed: [["09:00", "17:00"]] },
    });
    const now = new Date("2026-10-19T18:00:00.000Z"); // Monday evening, UTC.
    await withSystem((db) => db.query("update ai_work_schedules set next_run_at = $2 where id = $1", [saved.id, now.toISOString()]));
    const run = await runDueSchedules({ now });
    expect(run.created).toBe(0);
    expect(run.skipped).toBeGreaterThanOrEqual(1);
    const schedule = (await listSchedules(ctxFor(owner, org, "owner"))).find((row) => row.id === saved.id);
    expect(schedule?.lastSkippedReason ?? null).toBe("outside_business_hours");
    expect(schedule?.lastSkippedAt).toBeTruthy();
    expect(new Date(schedule!.nextRunAt).getTime()).toBeGreaterThan(now.getTime());
    const { rows } = await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from ai_work_jobs where org_id = $1", [org.id]));
    expect(Number(rows[0]?.n ?? 0)).toBe(0);
  }, 30000);

  it("runs the same schedule when it becomes due inside the local window", async () => {
    const schedule = (await listSchedules(ctxFor(owner, org, "owner"))).find((row) => row.capability === "proactive_review");
    expect(schedule).toBeTruthy();
    const now = new Date("2026-10-20T10:00:00.000Z"); // Tuesday morning, UTC.
    await withSystem((db) => db.query("update ai_work_schedules set next_run_at = $2, last_skipped_reason = null where id = $1", [schedule!.id, now.toISOString()]));
    const run = await runDueSchedules({ now });
    expect(run.created).toBe(1);
    expect(run.jobIds).toHaveLength(1);
    const job = await waitForJob(run.jobIds[0]);
    expect(job.status).toBe("completed");
    const after = (await listSchedules(ctxFor(owner, org, "owner"))).find((row) => row.id === schedule!.id);
    expect(after?.lastSkippedReason).toBeNull();
    expect(after?.lastRunAt).toBeTruthy();
  }, 30000);

  it("rejects an invalid business-hours window before saving it", async () => {
    await expect(
      saveSchedule(ctxFor(owner, org, "owner"), {
        capability: "proactive_review",
        cadence: "daily",
        enabled: false,
        businessHours: { mon: [["17:00", "09:00"]] },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("creates a real, owner-approved lead research request from its saved assignment", async () => {
    const saved = await saveSchedule(ctxFor(owner, org, "owner"), {
      capability: "lead_research",
      cadence: "daily",
      enabled: true,
      payload: { prompt: "Find 3 independent dental clinics in Singapore" },
    });
    const now = new Date("2026-10-23T10:00:00.000Z");
    await withSystem((db) => db.query("update ai_work_schedules set next_run_at = $2 where id = $1", [saved.id, now.toISOString()]));
    const run = await runDueSchedules({ now });
    expect(run.created).toBe(1);
    const { rows } = await withSystem((db) =>
      db.query<{
        request_prompt: string; request_status: string; job_input: Record<string, unknown>; job_capability: string; job_title: string;
      }>(
        `select r.prompt as request_prompt, r.status as request_status, j.input as job_input, j.capability as job_capability, j.title as job_title
           from lead_research_requests r join ai_work_jobs j on j.id = r.work_job_id
          where r.org_id = $1 order by r.created_at desc limit 1`,
        [org.id],
      ),
    );
    expect(rows[0]).toMatchObject({
      request_prompt: "Find 3 dental clinics in Singapore",
      job_capability: "lead_research",
      job_title: "Find 3 dental clinics in Singapore",
    });
    expect(rows[0].request_status).toMatch(/queued|running|failed|blocked/);
    expect(rows[0].job_input).toMatchObject({ origin: "schedule", prompt: "Find 3 dental clinics in Singapore" });
    const schedule = (await listSchedules(ctxFor(owner, org, "owner"))).find((row) => row.id === saved.id);
    expect(schedule?.payload.prompt).toBe("Find 3 independent dental clinics in Singapore");
    expect(schedule?.lastRunAt).toBeTruthy();
  }, 30000);

  it("refuses a lead research schedule without a complete assignment", async () => {
    await expect(
      saveSchedule(ctxFor(owner, org, "owner"), {
        capability: "lead_research",
        cadence: "daily",
        enabled: false,
        payload: { prompt: "Find some leads" },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
