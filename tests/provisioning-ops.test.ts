// What operations sees of client AI employee provisioning: the claim route's liveness row, the "provisioning:" incident collector (failed jobs, a stalled queue, a stuck first check,
// a silent worker, capacity at 80 and 100 percent), and the numbers on the health page. Recorded evidence only, embedded database, simulated clock.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as claimRoute } from "@/app/api/internal/hermes-provisioner/claim/route";
import { withSystem } from "@/server/db";
import { env, resetEnvCache } from "@/server/env";
import { runAllCollectors } from "@/server/ops/collectors";
import { JOBS } from "@/server/ops/tick";
import { getSystemHealth, provisioningHealth, provisioningSummary } from "@/server/admin/health";
import { PROVISIONER_LIVENESS_JOB, recordProvisionerClaimSeen } from "@/server/workforce/provisioning-watchdog";
import { ensureGrowthPartnerRuntime } from "@/server/workforce/service";
import { addMember, agentId, createOrg, createUser } from "./support/fixtures";
import { readyToRequeue, requeueAs } from "./support/requeue";

type JobStatus = "requested" | "in_progress" | "awaiting_health_check" | "succeeded" | "failed" | "cancelled";

const q = async <T extends Record<string, unknown>>(text: string, params: unknown[] = []) => (await withSystem((db) => db.query<T>(text, params))).rows;
const GATEWAY_ID = randomUUID();
const TOKEN = "o".repeat(40);

function stubProvisioner(extra: Record<string, string> = {}) {
  vi.stubEnv("HERMES_PROVISIONER_ENABLED", "true");
  vi.stubEnv("HERMES_PROVISIONER_TOKEN", TOKEN);
  vi.stubEnv("HERMES_PROVISIONER_GATEWAY_ID", GATEWAY_ID);
  for (const [k, v] of Object.entries(extra)) vi.stubEnv(k, v);
  resetEnvCache();
}

interface World { org: { id: string; name: string }; owner: { id: string }; ids: Record<string, string> }
async function world(name: string, roles: string[] = ["lead_hunter"]): Promise<World> {
  const org = await createOrg({ name });
  const owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  const ids: Record<string, string> = {};
  for (const role of roles) ids[role] = role === "growth_partner"
    ? await withSystem((db) => ensureGrowthPartnerRuntime(org.id, db))
    : await agentId(org.id, role);
  return { org, owner, ids };
}

/** A job in a state, `minutes` minutes into it (updated_at is the moment it entered that state, so the touch trigger is switched off while it is moved back). */
async function addJob(w: World, role: string, status: JobStatus, o: { minutes?: number; attempts?: number } = {}): Promise<string> {
  const id = (await q<{ id: string }>(
    `insert into agent_provisioning_jobs (org_id, agent_instance_id, kind, status, attempt_count, lease_token, lease_expires_at)
     values ($1, $2, 'provision', $3, $4, case when $3 = 'in_progress' then gen_random_uuid() end, case when $3 = 'in_progress' then now() - interval '1 minute' end) returning id`,
    [w.org.id, w.ids[role], status, o.attempts ?? 0],
  ))[0].id;
  if (o.minutes) {
    await withSystem(async (db) => {
      await db.query("alter table agent_provisioning_jobs disable trigger provisioning_jobs_touch");
      await db.query("update agent_provisioning_jobs set updated_at = now() - make_interval(mins => $2::int) where id = $1", [id, o.minutes]);
      await db.query("alter table agent_provisioning_jobs enable trigger provisioning_jobs_touch");
    });
  }
  return id;
}

const check = (now = new Date()) => runAllCollectors(now, ["provisioning:"]);
const incidents = () => q<{ dedupe_key: string; severity: string; status: string; org_id: string | null; client_visible: boolean; title: string; detail: string | null; occurrences: number; source: string }>(
  "select dedupe_key, severity, status, org_id, client_visible, title, detail, occurrences, source from incidents where starts_with(dedupe_key, 'provisioning:') order by dedupe_key");
const open = async () => (await incidents()).filter((i) => i.status !== "resolved");
const dropLiveness = () => withSystem((db) => db.query("delete from worker_job_runs where job_name = $1", [PROVISIONER_LIVENESS_JOB]));

beforeEach(async () => {
  vi.unstubAllEnvs();
  resetEnvCache();
  await withSystem(async (db) => {
    await db.query("delete from agent_provisioning_jobs");
    await db.query("update agent_instances set hermes_gateway_id = null, hermes_profile = null, hermes_base_url = null where hermes_gateway_id is not null");
  });
  await dropLiveness();
  await check(); // resolves what an earlier test left open
});
afterEach(() => { vi.unstubAllEnvs(); resetEnvCache(); });

describe("the claim route's liveness row", () => {
  const claim = (body: unknown, token: string | null = TOKEN) => claimRoute(new Request("http://iacquire.test/api/internal/hermes-provisioner/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }));
  const liveness = () => q<{ last_success_at: Date; last_started_at: Date; consecutive_failures: number }>("select last_success_at, last_started_at, consecutive_failures from worker_job_runs where job_name = $1", [PROVISIONER_LIVENESS_JOB]);

  it("is written by a claim with nothing to claim, and at most once a minute however often the worker asks", async () => {
    stubProvisioner();
    expect(await liveness()).toEqual([]);
    const first = await claim({ gatewayId: GATEWAY_ID });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ job: null });
    const [row] = await liveness();
    expect(row.consecutive_failures).toBe(0);
    for (let i = 0; i < 5; i += 1) expect((await claim({ gatewayId: GATEWAY_ID })).status).toBe(200);
    const [again] = await liveness();
    expect(new Date(again.last_success_at).getTime()).toBe(new Date(row.last_success_at).getTime());
    // A minute and a bit later the next claim writes it again.
    await q("update worker_job_runs set last_success_at = now() - interval '2 minutes', last_started_at = now() - interval '2 minutes' where job_name = $1", [PROVISIONER_LIVENESS_JOB]);
    expect((await claim({ gatewayId: GATEWAY_ID })).status).toBe(200);
    const [later] = await liveness();
    expect(new Date(later.last_success_at).getTime()).toBeGreaterThan(new Date(row.last_success_at).getTime() - 1000);
    expect(Date.now() - new Date(later.last_success_at).getTime()).toBeLessThan(60_000);
  });

  it("is not written for a request that is not the worker's: no token, a wrong token, a wrong gateway, or the provisioner switched off", async () => {
    stubProvisioner();
    expect((await claim({ gatewayId: GATEWAY_ID }, null)).status).toBe(401);
    expect((await claim({ gatewayId: GATEWAY_ID }, "x".repeat(40))).status).toBe(401);
    expect((await claim({ gatewayId: randomUUID() })).status).toBe(403);
    expect((await claim({ gatewayId: "not-a-uuid" })).status).toBe(400);
    expect(await liveness()).toEqual([]);
    vi.stubEnv("HERMES_PROVISIONER_ENABLED", "false");
    resetEnvCache();
    expect((await claim({ gatewayId: GATEWAY_ID })).status).toBe(503);
    expect(await liveness()).toEqual([]);
  });

  it("never touches the failure count the scheduler incident reads, and is one row, not one per claim", async () => {
    expect(await recordProvisionerClaimSeen()).toBe(true);
    expect(await recordProvisionerClaimSeen()).toBe(false);
    expect(await q("select 1 from worker_job_runs where job_name = $1", [PROVISIONER_LIVENESS_JOB])).toHaveLength(1);
    expect((await liveness())[0].consecutive_failures).toBe(0);
  });
});

describe("the provisioning collector", () => {
  it("reports jobs that used all three attempts, critical and for the agency only, once, and closes it when the job is requeued", async () => {
    const a = await world("Ops Failed Co A", ["lead_hunter", "crm_manager"]);
    const b = await world("Ops Failed Co B");
    await addJob(a, "lead_hunter", "failed", { attempts: 3 });
    await addJob(a, "crm_manager", "in_progress", { attempts: 3 }); // third attempt, lease ran out, not yet closed
    await addJob(b, "lead_hunter", "failed", { attempts: 1 }); // a retry is still pending: not reported
    const first = await check();
    expect(first).toEqual([{ prefix: "provisioning:", observed: 1, opened: 1, recovered: 0 }]);
    const rows = await open();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dedupe_key: `provisioning:failed:${a.org.id}`, severity: "critical", org_id: a.org.id, client_visible: false, source: "hermes" });
    expect(rows[0].title).toContain("2 AI runtime profile jobs have failed after 3 attempts");
    expect(rows[0].title).toContain("Ops Failed Co A");
    await check();
    expect(await open()).toHaveLength(1);
    expect((await open())[0].occurrences).toBe(2);
    expect(await q("select 1 from notifications where org_id = $1 and kind = 'incident_opened' and audience = 'client'", [a.org.id])).toEqual([]);
    // The agency does what the incident says: requeues both through the real service. That opens a NEW job for each employee and leaves the old rows failed with three attempts.
    const { adminId } = await readyToRequeue(a.org, a.owner.id, [a.ids.lead_hunter, a.ids.crm_manager]);
    await requeueAs(adminId, a.org.id, a.ids.lead_hunter);
    await requeueAs(adminId, a.org.id, a.ids.crm_manager);
    expect(await q("select 1 from agent_provisioning_jobs where org_id = $1 and status = 'failed' and attempt_count >= 3", [a.org.id])).toHaveLength(2);
    expect(await check()).toEqual([{ prefix: "provisioning:", observed: 0, opened: 0, recovered: 1 }]);
    expect(await open()).toEqual([]);
  });

  it("stays closed once the requeued job has succeeded, and opens again only for a job that is itself the employee's newest and has failed", async () => {
    const w = await world("Ops Requeue Co", ["lead_hunter"]);
    await addJob(w, "lead_hunter", "failed", { attempts: 3 });
    await check();
    expect((await open()).map((i) => i.dedupe_key)).toEqual([`provisioning:failed:${w.org.id}`]);
    const { adminId } = await readyToRequeue(w.org, w.owner.id, [w.ids.lead_hunter]);
    const { jobId } = await requeueAs(adminId, w.org.id, w.ids.lead_hunter);
    await q("update agent_provisioning_jobs set status = 'succeeded', attempt_count = 1 where id = $1", [jobId]);
    // The old failed row is still there and still has three attempts, but a newer job for the same employee succeeded.
    expect(await q("select 1 from agent_provisioning_jobs where org_id = $1 and status = 'failed' and attempt_count = 3", [w.org.id])).toHaveLength(1);
    await check();
    expect(await open()).toEqual([]);
    expect((await withSystem((db) => provisioningHealth(db))).failed).toBe(0);
    // A later job that fails for good is the newest one, so it counts again.
    await q("update agent_provisioning_jobs set status = 'failed', attempt_count = 3 where id = $1", [jobId]);
    await check();
    expect((await open()).map((i) => i.dedupe_key)).toEqual([`provisioning:failed:${w.org.id}`]);
    expect((await open())[0].title).toContain("1 AI runtime profile job has failed");
    expect((await withSystem((db) => provisioningHealth(db))).failed).toBe(1);
  });

  it("names the single Growth Partner in the Super Admin provisioning incident", async () => {
    const w = await world("Ops Growth Partner Co", ["growth_partner"]);
    await addJob(w, "growth_partner", "failed", { attempts: 3 });
    await check();

    const incident = (await open()).find((row) => row.org_id === w.org.id)!;
    expect(incident.title).toBe("AI Growth Partner setup failed after 3 attempts (Ops Growth Partner Co)");
    expect(incident.detail).toContain("AI Growth Partner remains in setup");
  });

  it("reports a request nobody has claimed, a first check that never passed, and nothing for a young job, only while the provisioner is on", async () => {
    const w = await world("Ops Queue Co", ["lead_hunter", "crm_manager", "sales_assistant"]);
    await addJob(w, "lead_hunter", "requested", { minutes: 40 });
    await addJob(w, "crm_manager", "awaiting_health_check", { minutes: 50 });
    await addJob(w, "sales_assistant", "requested", { minutes: 3 });
    expect(await check()).toEqual([{ prefix: "provisioning:", observed: 0, opened: 0, recovered: 0 }]); // switched off: waiting is intended
    stubProvisioner();
    await dropLiveness();
    await check();
    const keys = (await open()).map((i) => i.dedupe_key).sort();
    expect(keys).toEqual([`provisioning:health:${w.org.id}`, `provisioning:stalled:${w.org.id}`, "provisioning:worker-silent"].sort());
    const stalled = (await open()).find((i) => i.dedupe_key.startsWith("provisioning:stalled:"))!;
    expect(stalled).toMatchObject({ severity: "warning", org_id: w.org.id, client_visible: false });
    expect(stalled.title).toContain("1 AI runtime profile setup request has waited more than 30 minutes");
    // Put right: the request is claimed, and the first check passes.
    await q("update agent_provisioning_jobs set status = 'in_progress' where org_id = $1 and agent_instance_id = $2", [w.org.id, w.ids.lead_hunter]);
    await q("update agent_provisioning_jobs set status = 'succeeded' where org_id = $1 and agent_instance_id = $2", [w.org.id, w.ids.crm_manager]);
    await recordProvisionerClaimSeen();
    const after = await check();
    expect(after[0]).toMatchObject({ observed: 0 });
    expect(await open()).toEqual([]);
  });

  it("honours HERMES_PROVISIONER_STALL_MINUTES", async () => {
    const w = await world("Ops Threshold Co");
    await addJob(w, "lead_hunter", "requested", { minutes: 20 });
    stubProvisioner();
    await recordProvisionerClaimSeen();
    await check();
    expect(await open()).toEqual([]); // 20 minutes is under the default 30
    stubProvisioner({ HERMES_PROVISIONER_STALL_MINUTES: "10" });
    expect(env().HERMES_PROVISIONER_STALL_MINUTES).toBe(10);
    await check();
    expect((await open()).map((i) => i.dedupe_key)).toEqual([`provisioning:stalled:${w.org.id}`]);
  });

  it("reports a silent worker only while a request is waiting for it, and stops when it claims again", async () => {
    stubProvisioner();
    await check();
    expect(await open()).toEqual([]); // silent but nothing waiting
    const w = await world("Ops Worker Co");
    await addJob(w, "lead_hunter", "requested", { minutes: 10 });
    await check();
    const silent = (await open()).find((i) => i.dedupe_key === "provisioning:worker-silent")!;
    expect(silent).toMatchObject({ severity: "warning", org_id: null, client_visible: false });
    expect(silent.detail).toMatch(/no claim has ever been recorded/);
    await q(`insert into worker_job_runs (job_name, last_started_at, last_finished_at, last_success_at) values ($1, now() - interval '9 minutes', now() - interval '9 minutes', now() - interval '9 minutes')`, [PROVISIONER_LIVENESS_JOB]);
    await check();
    expect((await open()).find((i) => i.dedupe_key === "provisioning:worker-silent")?.detail).toMatch(/last claim \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
    await q("update worker_job_runs set last_success_at = now(), last_started_at = now() where job_name = $1", [PROVISIONER_LIVENESS_JOB]);
    await check();
    expect((await open()).find((i) => i.dedupe_key === "provisioning:worker-silent")).toBeUndefined();
  });

  it("reports the client runtime nearly full at 80 percent and full at 100 percent as one incident that escalates, and nothing when no limit is set", async () => {
    const w = await world("Ops Capacity Co", ["lead_hunter", "crm_manager", "sales_assistant", "appointment_setter", "performance_analyst", "operations_manager"]);
    const baseUrl = "http://127.0.0.1:9";
    await q(`insert into hermes_gateways (id, label, environment, base_url, gateway_type, status, profile_creation_status, provisioner_isolation_verified_at)
             values ($1, 'Capacity test runtime', 'development', $2, 'multiplexed_profiles', 'connected', 'restricted_service_verified', now())`, [GATEWAY_ID, baseUrl]);
    const roles = Object.keys(w.ids);
    const mapped = async (n: number) => {
      await q("update agent_instances set hermes_gateway_id = null, hermes_profile = null, hermes_base_url = null where org_id = $1", [w.org.id]);
      for (const role of roles.slice(0, n)) {
        await q("update agent_instances set hermes_base_url = $2, hermes_profile = $3, hermes_gateway_id = $4 where id = $1", [w.ids[role], baseUrl, `c-capacity-${role}`, GATEWAY_ID]);
      }
    };
    stubProvisioner();
    await mapped(6);
    await check();
    expect(await open()).toEqual([]); // no limit set: nothing to compare with
    stubProvisioner({ HERMES_PROVISIONER_MAX_PROFILES: "5" });
    await mapped(3);
    await check();
    expect(await open()).toEqual([]); // 60 percent
    await mapped(4);
    await check();
    expect(await open()).toMatchObject([{ dedupe_key: `provisioning:capacity:${GATEWAY_ID}`, severity: "warning", org_id: null, client_visible: false }]);
    expect((await open())[0].title).toBe("The client runtime is nearly full (4 of 5 profiles)");
    await mapped(5);
    await check();
    const full = await open();
    expect(full).toHaveLength(1);
    expect(full[0]).toMatchObject({ severity: "critical" });
    expect(full[0].title).toBe("The client runtime is full (5 of 5 profiles)");
    expect((await incidents()).filter((i) => i.dedupe_key.startsWith("provisioning:capacity:"))).toHaveLength(1);
    await mapped(2);
    await check();
    expect(await open()).toEqual([]);
    // Cleanup for the tests after this one.
    await q("update agent_instances set hermes_gateway_id = null, hermes_profile = null, hermes_base_url = null where org_id = $1", [w.org.id]);
  });

  it("keeps one workspace's failure out of another's incident, and never names a profile or a key", async () => {
    const a = await world("Ops Tenant Co A");
    const b = await world("Ops Tenant Co B");
    await q("update agent_instances set hermes_profile = 'c-leaky-profile-name' where id = $1", [a.ids.lead_hunter]);
    await q("update agent_instances set hermes_profile = null where id = $1", [a.ids.lead_hunter]);
    await addJob(a, "lead_hunter", "failed", { attempts: 3 });
    await addJob(b, "lead_hunter", "succeeded");
    await check();
    const rows = await open();
    expect(rows.map((r) => r.org_id)).toEqual([a.org.id]);
    expect(JSON.stringify(rows)).not.toMatch(/c-leaky|api[_ ]?key|secret/i);
    const events = await q("select org_id from incident_events where incident_id in (select id from incidents where dedupe_key = $1)", [`provisioning:failed:${a.org.id}`]);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.org_id === a.org.id)).toBe(true);
  });
});

describe("the numbers on the health page", () => {
  it("shows the failed count, the oldest open job and the worker's last claim, per the jobs that exist", async () => {
    const w = await world("Ops Health Co", ["lead_hunter", "crm_manager", "sales_assistant", "appointment_setter"]);
    expect(await withSystem((db) => provisioningHealth(db))).toEqual({ open: 0, failed: 0, oldestOpenAt: null, oldestOpenMinutes: null, workerLastClaimAt: null });
    await addJob(w, "lead_hunter", "requested", { minutes: 90 });
    await addJob(w, "crm_manager", "awaiting_health_check", { minutes: 10 });
    await addJob(w, "sales_assistant", "failed", { attempts: 3 });
    await addJob(w, "appointment_setter", "failed", { attempts: 1 }); // a retry is pending: not counted as failed
    await recordProvisionerClaimSeen();
    const now = new Date();
    const health = await withSystem((db) => provisioningHealth(db, now));
    expect(health).toMatchObject({ open: 2, failed: 1 });
    expect(health.oldestOpenMinutes).toBeGreaterThanOrEqual(89);
    expect(health.oldestOpenMinutes).toBeLessThanOrEqual(91);
    expect(health.workerLastClaimAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const system = await getSystemHealth();
    expect(system.provisioning).toMatchObject({ open: 2, failed: 1 });
    expect(system.pendingProvisioning).toBe(2);
  });

  it("does not count a failed job that a requeue replaced, and counts each employee at most once", async () => {
    const w = await world("Ops Health Requeue Co", ["lead_hunter", "crm_manager"]);
    await addJob(w, "lead_hunter", "failed", { attempts: 3 });
    await addJob(w, "crm_manager", "failed", { attempts: 3 });
    expect((await withSystem((db) => provisioningHealth(db))).failed).toBe(2);
    const { adminId } = await readyToRequeue(w.org, w.owner.id, [w.ids.lead_hunter]);
    await requeueAs(adminId, w.org.id, w.ids.lead_hunter);
    const health = await withSystem((db) => provisioningHealth(db));
    expect(health).toMatchObject({ failed: 1, open: 1 });
  });

  it("puts the failed count, the oldest open age and the worker's last claim in words for the page", async () => {
    const w = await world("Ops Words Co", ["lead_hunter", "crm_manager"]);
    const now = new Date();
    expect(provisioningSummary(await withSystem((db) => provisioningHealth(db, now)), now)).toBe("None failed · none open · worker has never asked for work");
    await addJob(w, "lead_hunter", "requested", { minutes: 135 });
    await addJob(w, "crm_manager", "failed", { attempts: 3 });
    await recordProvisionerClaimSeen();
    const words = provisioningSummary(await withSystem((db) => provisioningHealth(db, now)), now);
    expect(words).toMatch(/^1 failed after 3 attempts · oldest open 2 h \d{1,2} min · worker last asked for work /);
  });
});

describe("registration", () => {
  it("is a job on a five-minute rhythm, and the scheduler itself is off unless switched on", () => {
    expect(JOBS.find((j) => j.name === "provisioningWatchdog")?.everyMinutes).toBe(5);
    expect(JOBS.filter((j) => j.name === "provisioningWatchdog")).toHaveLength(1);
    const saved = process.env.SCHEDULER_ENABLED;
    delete process.env.SCHEDULER_ENABLED;
    resetEnvCache();
    try { expect(env().SCHEDULER_ENABLED).toBe(false); } finally { if (saved !== undefined) process.env.SCHEDULER_ENABLED = saved; resetEnvCache(); }
  });
});
