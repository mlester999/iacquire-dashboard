// The first portal health check of a freshly provisioned profile (src/server/workforce/first-health-check.ts), run by the platform with no person involved. The main block runs
// the REAL health check against the Hermes test double, so "online and job succeeded" is the real code's doing; a second block uses a stand-in for who is, and is not, asked.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { HEALTH_FAILURE_THRESHOLD } from "@/lib/workforce-readiness";
import { runAwaitingHealthChecks, runPostProvisionCheck } from "@/server/workforce/first-health-check";
import { connectHermesProfile, createConfigVersion, type HealthResult } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { addMember, agentId, createOrg, createUser } from "./support/fixtures";
import { startMockHermes, type MockHermes } from "./support/mock-hermes";

const KEY = "f".repeat(40);
const PROFILES = Array.from({ length: 28 }, (_, i) => `c-first-check-${i}`);
const q = async <T extends Record<string, unknown>>(text: string, params: unknown[] = []) => (await withSystem((db) => db.query<T>(text, params))).rows;

let mock: MockHermes;
let admin: { id: string };
let next = 0;

interface Provisioned { org: { id: string }; owner: { id: string }; agent: string; profile: string; jobId: string }

/** An employee in the state the worker's completion leaves it: profile mapped, credential stored, status provisioning, job waiting for its check. */
async function provisioned(role = "crm_manager"): Promise<Provisioned> {
  const profile = PROFILES[next++];
  const org = await createOrg({ name: `First Check Co ${next}` });
  const owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  const agent = await agentId(org.id, role);
  await withSystem((db) => createConfigVersion(db, { orgId: org.id, agentId: agent, settings: defaultSettings(role as never), source: "onboarding", userId: owner.id, apply: true }));
  await connectHermesProfile({ agentId: agent, baseUrl: mock.url, profile, apiKey: KEY, agencyUserId: admin.id });
  const jobs = await q<{ id: string }>("insert into agent_provisioning_jobs (org_id, agent_instance_id, kind, status, attempt_count) values ($1, $2, 'provision', 'awaiting_health_check', 1) returning id", [org.id, agent]);
  return { org, owner, agent, profile, jobId: jobs[0].id };
}

const state = async (p: Provisioned) => (await q<{ status: string; last_health_ok: boolean | null; health_consecutive_failures: number; health_alerted_at: Date | null; job_status: string }>(
  `select a.status, a.last_health_ok, a.health_consecutive_failures, a.health_alerted_at, j.status as job_status
     from agent_instances a join agent_provisioning_jobs j on j.agent_instance_id = a.id where a.id = $1`, [p.agent]))[0];
const clientNotices = (orgId: string) => q<{ kind: string; user_id: string }>("select kind, user_id from notifications where org_id = $1 and audience = 'client' and kind = 'integration_disconnected'", [orgId]);

beforeAll(async () => {
  mock = await startMockHermes(Object.fromEntries(PROFILES.map((name) => [name, { key: KEY }])));
  admin = await createUser({ platformRole: "agency_super_admin" });
});
afterAll(() => mock.close());

describe("the real first check, with no person", () => {
  it("takes a waiting employee online and closes its job in one run, as the system, reading only", async () => {
    const p = await provisioned();
    expect(await state(p)).toMatchObject({ status: "provisioning", last_health_ok: null, job_status: "awaiting_health_check" });
    const before = mock.requests.length;
    const summary = await runPostProvisionCheck(p.jobId);
    expect(summary).toMatchObject({ due: 1, checked: ["crm_manager"], failed: [], deferred: 0 });
    expect(await state(p)).toMatchObject({ status: "online", last_health_ok: true, health_consecutive_failures: 0, job_status: "succeeded" });
    const methods = mock.requests.slice(before).filter((r) => r.profile === p.profile).map((r) => r.method);
    expect(methods.length).toBeGreaterThan(0);
    expect(methods.every((m) => m === "GET")).toBe(true);
    const audits = await q<{ actor_kind: string; actor_user_id: string | null; result: string }>("select actor_kind, actor_user_id, result from audit_logs where agent_instance_id = $1 and action = 'agent.health_check'", [p.agent]);
    expect(audits).toEqual([{ actor_kind: "system", actor_user_id: null, result: "success" }]);
    // The employee is not announced to anyone as "online": a first check is quiet.
    expect(await q("select 1 from notifications where org_id = $1 and kind = 'agent_status'", [p.org.id])).toEqual([]);
  });

  it("runs only once for a job: once it has succeeded there is nothing left to check", async () => {
    const p = await provisioned();
    await runPostProvisionCheck(p.jobId);
    const before = mock.requests.length;
    expect(await runPostProvisionCheck(p.jobId)).toMatchObject({ due: 0, checked: [] });
    expect((await runAwaitingHealthChecks(p.org.id)).due).toBe(0);
    expect(mock.requests.length).toBe(before);
  });

  it("keeps the job open when the check fails, counts every failure, raises ONE alert at the threshold, and closes the job on the first pass after the fix", async () => {
    const p = await provisioned();
    mock.setInventory(p.profile, { status: 503 });
    for (let n = 1; n <= HEALTH_FAILURE_THRESHOLD + 1; n += 1) {
      const summary = await runAwaitingHealthChecks(p.org.id);
      expect(summary).toMatchObject({ due: 1, checked: ["crm_manager"], failed: ["crm_manager"] });
      const s = await state(p);
      expect(s.job_status, `after ${n}`).toBe("awaiting_health_check");
      expect(s.health_consecutive_failures, `after ${n}`).toBe(n);
      expect(s.last_health_ok).toBe(false);
      if (n < HEALTH_FAILURE_THRESHOLD) expect(s.health_alerted_at).toBeNull();
      else expect(s.health_alerted_at).not.toBeNull();
      // The owner is told once, at the threshold, and not again by the failures after it.
      expect((await clientNotices(p.org.id)).length, `after ${n}`).toBe(n < HEALTH_FAILURE_THRESHOLD ? 0 : 1);
    }
    expect(await q("select 1 from agent_provisioning_jobs where id = $1 and status in ('failed', 'cancelled')", [p.jobId])).toEqual([]);
    mock.setInventory(p.profile, {});
    const fixed = await runAwaitingHealthChecks(p.org.id);
    expect(fixed).toMatchObject({ checked: ["crm_manager"], failed: [] });
    expect(await state(p)).toMatchObject({ status: "online", health_consecutive_failures: 0, job_status: "succeeded", health_alerted_at: null });
  });

  it("is limited to the workspace asked for: another workspace's waiting job is not checked", async () => {
    const mine = await provisioned();
    const theirs = await provisioned();
    const summary = await runAwaitingHealthChecks(mine.org.id);
    expect(summary.due).toBe(1);
    expect(summary.outcomes[0]).toMatchObject({ orgId: mine.org.id, agentId: mine.agent });
    expect((await state(theirs)).job_status).toBe("awaiting_health_check");
    expect(await state(theirs)).toMatchObject({ status: "provisioning", last_health_ok: null });
  });
});

describe("who is asked, and who never is", () => {
  // Every check below is a stand-in that changes nothing, so the jobs of earlier tests would still be waiting and crowd a batch of twelve.
  beforeEach(async () => { await q("update agent_provisioning_jobs set status = 'cancelled' where status = 'awaiting_health_check'"); });
  const PASS: HealthResult = { ok: true, status: "online", detail: "fine" };
  const scripted = (answer: HealthResult | Error = PASS) => {
    const asked: string[] = [];
    return { asked, deps: { check: async (id: string) => { asked.push(id); if (answer instanceof Error) throw answer; return answer; } } };
  };

  it("never checks a disabled employee or an employee of a suspended workspace, nor one with no profile or credential", async () => {
    const disabled = await provisioned();
    const suspended = await provisioned();
    const noProfile = await provisioned();
    const noCredential = await provisioned();
    const healthy = await provisioned();
    await withSystem(async (db) => {
      await db.query("update agent_instances set enabled = false where id = $1", [disabled.agent]);
      await db.query("update organizations set status = 'suspended' where id = $1", [suspended.org.id]);
      await db.query("update agent_instances set hermes_profile = null where id = $1", [noProfile.agent]);
      await db.query("update agent_instances set credential_id = null where id = $1", [noCredential.agent]);
    });
    const before = mock.requests.length;
    for (const p of [disabled, suspended, noProfile, noCredential]) {
      const { asked, deps } = scripted();
      expect((await runPostProvisionCheck(p.jobId, { deps })).due).toBe(0);
      expect(asked).toEqual([]);
    }
    // The real check is never started for them either: nothing reached the gateway.
    for (const p of [disabled, suspended, noProfile, noCredential]) await runPostProvisionCheck(p.jobId);
    expect(mock.requests.length).toBe(before);
    const { asked, deps } = scripted();
    expect((await runAwaitingHealthChecks(undefined, { deps })).outcomes.map((o) => o.agentId)).toContain(healthy.agent);
    for (const p of [disabled, suspended, noProfile, noCredential]) expect(asked).not.toContain(p.agent);
    for (const p of [disabled, suspended, noProfile, noCredential]) expect((await state(p)).job_status).toBe("awaiting_health_check");
  });

  it("checks a waiting configuration sync as well, and leaves a job that is not waiting alone", async () => {
    const sync = await provisioned();
    await q("update agent_provisioning_jobs set kind = 'sync' where id = $1", [sync.jobId]);
    const closed = await provisioned();
    await q("update agent_provisioning_jobs set status = 'succeeded' where id = $1", [closed.jobId]);
    const requested = await provisioned();
    await q("update agent_provisioning_jobs set status = 'requested' where id = $1", [requested.jobId]);
    const { asked, deps } = scripted();
    await runAwaitingHealthChecks(undefined, { deps });
    expect(asked).toContain(sync.agent);
    expect(asked).not.toContain(closed.agent);
    expect(asked).not.toContain(requested.agent);
  });

  it("honours the age the watchdog asks for, on both the job and the last check", async () => {
    const fresh = await provisioned();
    const settled = await provisioned();
    const justChecked = await provisioned();
    await withSystem(async (db) => {
      await db.query("alter table agent_provisioning_jobs disable trigger provisioning_jobs_touch");
      await db.query("update agent_provisioning_jobs set updated_at = now() - interval '10 minutes' where id = any($1::uuid[])", [[settled.jobId, justChecked.jobId]]);
      await db.query("alter table agent_provisioning_jobs enable trigger provisioning_jobs_touch");
      await db.query("update agent_instances set last_health_check_at = now() - interval '30 seconds' where id = $1", [justChecked.agent]);
    });
    const { asked, deps } = scripted();
    await runAwaitingHealthChecks(undefined, { minAgeMinutes: 2, deps });
    expect(asked).toContain(settled.agent);
    expect(asked).not.toContain(fresh.agent);
    expect(asked).not.toContain(justChecked.agent);
    const everyone = scripted();
    await runAwaitingHealthChecks(undefined, { deps: everyone.deps });
    expect(everyone.asked).toContain(fresh.agent);
  });

  it("reports a check that could not run as failed, never throws, and leaves the job open", async () => {
    const p = await provisioned();
    const { asked, deps } = scripted(new Error("database connection reset https://secret.example/token=abcdefghijklmnopqrstuvwxyz0123456789"));
    const summary = await runPostProvisionCheck(p.jobId, { deps });
    expect(asked).toEqual([p.agent]);
    expect(summary).toMatchObject({ checked: ["crm_manager"], failed: ["crm_manager"] });
    expect(summary.outcomes[0].detail).toMatch(/could not run/);
    expect(summary.outcomes[0].detail).not.toMatch(/secret\.example|abcdefghijklmnop/);
    expect((await state(p)).job_status).toBe("awaiting_health_check");
  });

  it("is bounded: a batch checks at most the limit and reports the rest as deferred only when the budget runs out", async () => {
    await provisioned();
    await provisioned();
    await provisioned();
    const limited = scripted();
    expect((await runAwaitingHealthChecks(undefined, { limit: 2, deps: limited.deps })).due).toBe(2);
    expect(limited.asked).toHaveLength(2);
    const noBudget = scripted();
    const out = await runAwaitingHealthChecks(undefined, { budgetMs: 0, deps: noBudget.deps });
    expect(out).toMatchObject({ due: 3, checked: [], deferred: 3 });
    expect(noBudget.asked).toEqual([]);
  });
});
