// A pause stops AI work jobs wherever they start: when a person asks, when a schedule or an event trigger would create one, and when a worker claims one that was queued before the
// pause. Until this gate existed only messaging and booking asked (src/server/automation/gate.ts); a paused employee, an agency pause or a suspended workspace could still run
// research and reviews. Staff chat stays outside the gate by design. Everything here is deterministic: the reviews read the database, no model is called.
import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { addMember, agentId, createOrg, createUser, ctxFor } from "./support/fixtures";
import { createConfigVersion } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { dispatchCapabilityJob } from "@/server/workforce/capability-dispatch";
import { retryWorkJob } from "@/server/workforce/jobs";
import { runWorkJob } from "@/server/workforce/work-runner";
import { listSchedules, runDueSchedules, saveSchedule } from "@/server/workforce/schedules";
import { runDueTriggers, saveTrigger } from "@/server/workforce/triggers";
import { createResearchRequest, retryResearchRequest } from "@/server/leads/service";
import { jobBlockCode, jobGate } from "@/server/automation/job-gate";

let org: Awaited<ReturnType<typeof createOrg>>;
let owner: { id: string; email: string };
const ctx = () => ctxFor(owner, org, "owner");

const setAgent = (role: string, set: string) => withSystem((db) => db.query(`update agent_instances set ${set} where org_id = $1 and role_key = $2`, [org.id, role]));
const jobCount = async () => Number((await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from ai_work_jobs where org_id = $1", [org.id]))).rows[0].n);
const jobRow = async (id: string) => (await withSystem((db) => db.query<{ status: string; failure_code: string | null; failure_message: string | null; attempts: number }>("select status, failure_code, failure_message, attempts from ai_work_jobs where id = $1", [id]))).rows[0];

async function waitForJob(jobId: string, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = await jobRow(jobId);
    if (row && ["completed", "failed", "cancelled", "blocked"].includes(row.status)) return row;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("job did not settle");
}

/** Puts the agent and workspace back to normal after a case. */
async function normal() {
  await withSystem(async (db) => {
    await db.query("update agent_instances set mode = 'autonomous', enabled = true, status = 'online' where org_id = $1", [org.id]);
    await db.query("update organizations set status = 'active' where id = $1", [org.id]);
    await db.query("delete from automation_pauses where org_id = $1", [org.id]);
  });
}

beforeAll(async () => {
  process.env.WORKFORCE_SCHEDULES_ENABLED = "true";
  process.env.WORKFORCE_TRIGGERS_ENABLED = "true";
  org = await createOrg({ name: "Job Gate Co" });
  owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  for (const role of ["operations_manager", "lead_hunter", "appointment_setter", "sales_assistant", "crm_manager", "performance_analyst"] as const) {
    const id = await agentId(org.id, role);
    await withSystem((db) => createConfigVersion(db, { orgId: org.id, agentId: id, settings: defaultSettings(role), source: "onboarding", userId: owner.id, apply: true }));
  }
  await withSystem((db) => db.query("update agent_instances set status = 'online', last_health_ok = true, last_health_check_at = now() where org_id = $1", [org.id]));
}, 60000);

beforeEach(normal);

afterAll(() => {
  delete process.env.WORKFORCE_SCHEDULES_ENABLED;
  delete process.env.WORKFORCE_TRIGGERS_ENABLED;
});

describe("the job gate's decisions", () => {
  it("allows work for a ready employee in either approval mode, and says why for every kind of pause", async () => {
    const hunter = await agentId(org.id, "crm_manager");
    const ask = () => withSystem((db) => jobGate(db, { orgId: org.id, agentId: hunter }));
    expect(await ask()).toEqual({ allowed: true });
    // Approval mode governs what an employee may do to a customer; a job here reaches no customer, so it is not held for approval.
    await setAgent("crm_manager", "mode = 'approval_required'");
    expect(await ask()).toEqual({ allowed: true });

    await setAgent("crm_manager", "mode = 'paused'");
    expect(await ask()).toMatchObject({ allowed: false, reason: "agent_paused", detail: expect.stringMatching(/paused/) });
    await normal();

    await withSystem((db) => db.query("insert into automation_pauses (org_id, scope, active) values ($1, 'agency', true)", [org.id]));
    expect(await ask()).toMatchObject({ allowed: false, reason: "agency_paused" });
    await normal();

    // Pauses that stop customer messaging or outbound outreach do not stop a read-only review.
    await withSystem((db) => db.query("insert into automation_pauses (org_id, scope, active) values ($1, 'messaging', true), ($1, 'outbound', true)", [org.id]));
    expect(await ask()).toEqual({ allowed: true });
    await normal();

    await withSystem((db) => db.query("update organizations set status = 'suspended' where id = $1", [org.id]));
    expect(await ask()).toMatchObject({ allowed: false, reason: "org_inactive" });
    await normal();

    // A workspace that does not include the employee, or whose employee is not connected, is stopped here too (the AI Workforce candidate's stricter gate), with its own reason.
    await setAgent("crm_manager", "enabled = false");
    expect(await ask()).toMatchObject({ allowed: false, reason: "agent_disabled" });
    await normal();
    await setAgent("crm_manager", "status = 'offline'");
    expect(await ask()).toMatchObject({ allowed: false });
    expect(jobBlockCode("agent_paused")).toBe("automation_agent_paused");
  });
});

describe("a person asks for work", () => {
  it("is refused with the reason while the employee is paused, creates nothing, and works again after", async () => {
    const before = await jobCount();
    await setAgent("crm_manager", "mode = 'paused'");
    await expect(dispatchCapabilityJob(ctx(), { agentRole: "crm_manager", capability: "crm_quality_review", title: "Check the CRM", deferKick: true })).rejects.toMatchObject({ code: "agent_unavailable", message: expect.stringMatching(/paused/) });
    expect(await jobCount()).toBe(before);
    await normal();
    const ok = await dispatchCapabilityJob(ctx(), { agentRole: "crm_manager", capability: "crm_quality_review", title: "Check the CRM", deferKick: true });
    expect(ok.jobId).toBeTruthy();
    await runWorkJob(ok.jobId);
    expect((await jobRow(ok.jobId)).status).toBe("completed");
  });

  it("is refused for the agency's pause and for a suspended workspace too", async () => {
    await withSystem((db) => db.query("insert into automation_pauses (org_id, scope, active) values ($1, 'agency', true)", [org.id]));
    await expect(dispatchCapabilityJob(ctx(), { agentRole: "performance_analyst", capability: "performance_snapshot", title: "Snapshot", deferKick: true })).rejects.toMatchObject({ code: "agent_unavailable", message: expect.stringMatching(/iAcquire has paused/) });
    await normal();
    await withSystem((db) => db.query("update organizations set status = 'suspended' where id = $1", [org.id]));
    await expect(dispatchCapabilityJob(ctx(), { agentRole: "performance_analyst", capability: "performance_snapshot", title: "Snapshot", deferKick: true })).rejects.toMatchObject({ code: "agent_unavailable" });
  });

  it("saves a lead research request as waiting, with the reason, instead of starting it; retrying while paused is refused", async () => {
    await setAgent("lead_hunter", "mode = 'paused'");
    const made = await createResearchRequest(ctx(), { prompt: "Find 3 independent dental clinics in Singapore", campaignType: "business" }, { deferKick: true });
    expect(made).toMatchObject({ status: "waiting_for_agent", jobId: null });
    const stored = await withSystem((db) => db.query<{ status: string; failure_reason: string }>("select status, failure_reason from lead_research_requests where id = $1", [made.requestId]));
    expect(stored.rows[0].status).toBe("waiting_for_agent");
    expect(stored.rows[0].failure_reason).toMatch(/paused/);
    await expect(retryResearchRequest(ctx(), made.requestId)).rejects.toMatchObject({ code: "agent_unavailable", message: expect.stringMatching(/paused/) });
  });
});

describe("work that was queued before the pause", () => {
  it("is blocked when a worker claims it, executes nothing, and can be run again once work resumes", async () => {
    const queued = await dispatchCapabilityJob(ctx(), { agentRole: "crm_manager", capability: "crm_quality_review", title: "Queued before the pause", deferKick: true });
    expect((await jobRow(queued.jobId)).status).toBe("queued");
    await setAgent("crm_manager", "mode = 'paused'");
    await runWorkJob(queued.jobId);
    const blocked = await jobRow(queued.jobId);
    expect(blocked).toMatchObject({ status: "blocked", failure_code: "automation_agent_paused" });
    expect(blocked.failure_message).toMatch(/paused/);
    const events = await withSystem((db) => db.query<{ message: string }>("select message from ai_work_events where job_id = $1 order by id", [queued.jobId]));
    expect(events.rows.map((e) => e.message).join(" | ")).toMatch(/Nothing was executed/);
    // Resumed: the same job is queued again and runs.
    await normal();
    await withSystem((db) => retryWorkJob(db, { jobId: queued.jobId, orgId: org.id }));
    await runWorkJob(queued.jobId);
    expect((await jobRow(queued.jobId)).status).toBe("completed");
  });

  it("puts a lead research request whose job was blocked back to waiting, so it never looks busy for ever", async () => {
    const made = await createResearchRequest(ctx(), { prompt: "Find 2 roofing contractors in Austin", campaignType: "business" }, { deferKick: true });
    expect(made).toMatchObject({ status: "queued" });
    await setAgent("lead_hunter", "mode = 'paused'");
    await runWorkJob(made.jobId as string);
    expect((await jobRow(made.jobId as string)).status).toBe("blocked");
    const request = await withSystem((db) => db.query<{ status: string; failure_reason: string }>("select status, failure_reason from lead_research_requests where id = $1", [made.requestId]));
    expect(request.rows[0].status).toBe("waiting_for_agent");
    expect(request.rows[0].failure_reason).toMatch(/paused/);
  });
});

describe("a schedule or an event trigger would create work", () => {
  it("skips the schedule with the reason written on it, creates nothing, and runs it when work resumes", async () => {
    const saved = await saveSchedule(ctx(), { capability: "proactive_review", cadence: "daily", enabled: true });
    const now = new Date("2026-10-26T10:00:00.000Z");
    const due = () => withSystem((db) => db.query("update ai_work_schedules set next_run_at = $2, last_skipped_reason = null where id = $1", [saved.id, now.toISOString()]));
    await due();
    const before = await jobCount();
    await setAgent("operations_manager", "mode = 'paused'");
    const skipped = await runDueSchedules({ now });
    expect(skipped.created).toBe(0);
    expect(skipped.skipped).toBeGreaterThanOrEqual(1);
    expect(await jobCount()).toBe(before);
    const view = (await listSchedules(ctx())).find((s) => s.id === saved.id);
    expect(view?.lastSkippedReason).toBe("automation_agent_paused");
    expect(new Date(view!.nextRunAt).getTime()).toBeGreaterThan(now.getTime());

    await normal();
    await due();
    const run = await runDueSchedules({ now });
    expect(run.created).toBe(1);
    expect((await waitForJob(run.jobIds[0])).status).toBe("completed");
    expect((await listSchedules(ctx())).find((s) => s.id === saved.id)?.lastSkippedReason).toBeNull();
  }, 30000);

  it("consumes the event without creating a job while paused", async () => {
    const trigger = await saveTrigger(ctx(), { eventType: "appointment.cancelled", enabled: true });
    expect(trigger.enabled).toBe(true);
    await withSystem((db) => db.query("insert into crm_events (org_id, type, entity_type, payload, dedupe_key, actor_kind) values ($1, 'appointment.cancelled', 'appointment', '{}'::jsonb, $2, 'system')", [org.id, `gate-${crypto.randomUUID()}`]));
    const before = await jobCount();
    await setAgent("appointment_setter", "mode = 'paused'");
    const run = await runDueTriggers({ limit: 5 });
    expect(run.created).toBe(0);
    expect(run.skipped).toBeGreaterThanOrEqual(1);
    expect(await jobCount()).toBe(before);
  }, 30000);
});
