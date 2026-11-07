// The provisioning watchdog (src/server/workforce/provisioning-watchdog.ts): what notices a client profile job nobody is working on. Real rows in the embedded database; the only
// stand-in is the health check the follow-up step is handed (the real check is proved in tests/first-health-check.test.ts).
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import type { HealthResult } from "@/server/workforce/service";
import { provisionerWorkerSilence, recordProvisionerClaimSeen, runProvisioningWatchdog, PROVISIONER_LIVENESS_JOB } from "@/server/workforce/provisioning-watchdog";
import { addMember, agentId, createOrg, createUser } from "./support/fixtures";
import { readyToRequeue, requeueAs } from "./support/requeue";
import { ensureGrowthPartnerRuntime } from "@/server/workforce/service";

type JobStatus = "requested" | "in_progress" | "awaiting_health_check" | "succeeded" | "failed" | "cancelled";

const q = async <T extends Record<string, unknown>>(text: string, params: unknown[] = []) => (await withSystem((db) => db.query<T>(text, params))).rows;
const ONE_MINUTE = 60_000;
const GATEWAY_ID = randomUUID();
const TOKEN = "w".repeat(40);

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

/** A job in the state the claim and the worker callback leave it in. `leaseMinutes` is relative to now (negative: the lease ran out that long ago). */
async function addJob(w: World, role: string, o: { status: JobStatus; attempts?: number; leaseMinutes?: number; detail?: string; kind?: "provision" | "sync" }): Promise<string> {
  const rows = await q<{ id: string }>(
    `insert into agent_provisioning_jobs (org_id, agent_instance_id, kind, status, attempt_count, lease_token, lease_expires_at, detail)
     values ($1, $2, $3, $4, $5, case when $4 = 'in_progress' then gen_random_uuid() end,
             case when $4 = 'in_progress' then now() + make_interval(mins => $6::int) end, $7) returning id`,
    [w.org.id, w.ids[role], o.kind ?? "provision", o.status, o.attempts ?? 0, o.leaseMinutes ?? 0, o.detail ?? null],
  );
  return rows[0].id;
}

/** Moves a job's "since" back, which is what updated_at means for an open job (the touch trigger would otherwise reset it). */
async function ageJob(id: string, minutes: number) {
  await withSystem(async (db) => {
    await db.query("alter table agent_provisioning_jobs disable trigger provisioning_jobs_touch");
    await db.query("update agent_provisioning_jobs set updated_at = now() - make_interval(mins => $2::int) where id = $1", [id, minutes]);
    await db.query("alter table agent_provisioning_jobs enable trigger provisioning_jobs_touch");
  });
}

const job = async (id: string) => (await q<{ status: string; detail: string | null; attempt_count: number; lease_token: string | null; lease_expires_at: Date | null; next_retry_at: Date | null }>(
  "select status, detail, attempt_count, lease_token, lease_expires_at, next_retry_at from agent_provisioning_jobs where id = $1", [id]))[0];
const notices = (orgId: string, like = "provisioning-%") => q<{ audience: string; kind: string; severity: string; title: string; body: string | null; link: string | null; dedupe_key: string; user_id: string; org_id: string }>(
  "select audience, kind, severity, title, body, link, dedupe_key, user_id, org_id from notifications where org_id = $1 and dedupe_key like $2 order by created_at, id", [orgId, like]);
const audit = (jobId: string, action: string) => q<{ metadata: Record<string, unknown>; actor_kind: string }>(
  "select metadata, actor_kind from audit_logs where target_id = $1 and action = $2", [jobId, action]);

function enableProvisioner() {
  vi.stubEnv("HERMES_PROVISIONER_ENABLED", "true");
  vi.stubEnv("HERMES_PROVISIONER_TOKEN", TOKEN);
  vi.stubEnv("HERMES_PROVISIONER_GATEWAY_ID", GATEWAY_ID);
  resetEnvCache();
}
const verifiedGateway = () => withSystem((db) => db.query(
  `insert into hermes_gateways (id, label, environment, base_url, gateway_type, status, profile_creation_status, provisioner_isolation_verified_at)
   values ($1, 'Watchdog test runtime', 'development', 'http://127.0.0.1:9', 'multiplexed_profiles', 'connected', 'restricted_service_verified', now())
   on conflict (id) do update set status = 'connected', profile_creation_status = 'restricted_service_verified', provisioner_isolation_verified_at = now()`, [GATEWAY_ID]));
const dropLiveness = () => withSystem((db) => db.query("delete from worker_job_runs where job_name = $1", [PROVISIONER_LIVENESS_JOB]));
const setLiveness = (minutesAgo: number) => withSystem((db) => db.query(
  `insert into worker_job_runs (job_name, last_started_at, last_finished_at, last_success_at) values ($1, now() - make_interval(mins => $2::int), now() - make_interval(mins => $2::int), now() - make_interval(mins => $2::int))
   on conflict (job_name) do update set last_started_at = excluded.last_started_at, last_finished_at = excluded.last_finished_at, last_success_at = excluded.last_success_at`,
  [PROVISIONER_LIVENESS_JOB, minutesAgo]));

let staff: { id: string };
beforeAll(async () => { staff = await createUser({ platformRole: "agency_super_admin" }); });
afterEach(() => { vi.unstubAllEnvs(); resetEnvCache(); });

describe("when there is nothing to do", () => {
  it("changes nothing: no job, no notice, no check", async () => {
    await withSystem((db) => db.query("delete from agent_provisioning_jobs"));
    const before = (await q<{ n: number }>("select count(*)::int as n from notifications"))[0].n;
    const asked: string[] = [];
    const summary = await runProvisioningWatchdog({ now: new Date(), deps: { check: async (id) => { asked.push(id); return { ok: true, status: "online", detail: "" }; } } });
    expect(summary).toEqual({ settled: 0, announced: 0, stalled: 0, checked: 0, failedChecks: 0 });
    expect(asked).toEqual([]);
    expect((await q<{ n: number }>("select count(*)::int as n from notifications"))[0].n).toBe(before);
  });
});

describe("a job whose last attempt's lease ran out", () => {
  it("is closed as failed once, with an audit row and one notice to the agency and one to the owner, and a second pass does nothing", async () => {
    const w = await world("Lease Co");
    const id = await addJob(w, "lead_hunter", { status: "in_progress", attempts: 3, leaseMinutes: -1 });
    const first = await runProvisioningWatchdog({ now: new Date() });
    expect(first).toMatchObject({ settled: 1, announced: 1 });
    expect(await job(id)).toMatchObject({ status: "failed", lease_token: null, lease_expires_at: null, next_retry_at: null, attempt_count: 3 });
    expect((await job(id)).detail).toBe("Restricted Hermes profile setup failed (lease_expired). Review the isolated host result before retrying.");
    expect(await audit(id, "agent.profile_provisioning_failed")).toEqual([{ metadata: { code: "lease_expired", attempt: 3 }, actor_kind: "system" }]);
    expect(await audit(id, "agent.provisioning_failure_announced")).toHaveLength(1);
    const sent = await notices(w.org.id);
    expect(sent.filter((n) => n.audience === "agency" && n.user_id === staff.id)).toHaveLength(1);
    expect(sent.filter((n) => n.audience === "client" && n.user_id === w.owner.id)).toHaveLength(1);
    expect(sent).toHaveLength(2);
    expect(sent.find((n) => n.audience === "agency")).toMatchObject({ kind: "setup_issue", link: `/admin/clients/${w.org.id}` });
    expect(sent.find((n) => n.audience === "agency")?.body).toContain("lease_expired");

    const second = await runProvisioningWatchdog({ now: new Date() });
    expect(second).toMatchObject({ settled: 0, announced: 0 });
    expect(await notices(w.org.id)).toHaveLength(2);
    expect(await audit(id, "agent.profile_provisioning_failed")).toHaveLength(1);
    expect(await audit(id, "agent.provisioning_failure_announced")).toHaveLength(1);
  });

  it("is never touched while the lease is still live", async () => {
    const w = await world("Live Lease Co");
    const id = await addJob(w, "lead_hunter", { status: "in_progress", attempts: 3, leaseMinutes: 8 });
    const summary = await runProvisioningWatchdog({ now: new Date() });
    expect(summary.settled).toBe(0);
    expect(await job(id)).toMatchObject({ status: "in_progress", attempt_count: 3 });
    expect((await job(id)).lease_token).not.toBeNull();
    expect(await notices(w.org.id)).toEqual([]);
  });

  it("is not failed while it has attempts left: the claim retries an expired lease", async () => {
    const w = await world("Retry Co");
    const id = await addJob(w, "lead_hunter", { status: "in_progress", attempts: 2, leaseMinutes: -30 });
    await runProvisioningWatchdog({ now: new Date() });
    expect(await job(id)).toMatchObject({ status: "in_progress", attempt_count: 2 });
    expect(await notices(w.org.id)).toEqual([]);
  });

  it("is closed for the right workspace only, and the counts are per workspace", async () => {
    const a = await world("Count Co A", ["lead_hunter", "crm_manager"]);
    const b = await world("Count Co B");
    const idA1 = await addJob(a, "lead_hunter", { status: "in_progress", attempts: 3, leaseMinutes: -2 });
    const idA2 = await addJob(a, "crm_manager", { status: "in_progress", attempts: 3, leaseMinutes: -2 });
    const idB = await addJob(b, "lead_hunter", { status: "in_progress", attempts: 3, leaseMinutes: 5 });
    const summary = await runProvisioningWatchdog({ now: new Date() });
    expect(summary.settled).toBe(2);
    expect((await job(idA1)).status).toBe("failed");
    expect((await job(idA2)).status).toBe("failed");
    expect((await job(idB)).status).toBe("in_progress");
    expect((await notices(a.org.id)).filter((n) => n.audience === "agency")).toHaveLength(2);
    expect((await notices(a.org.id)).filter((n) => n.audience === "client" && n.user_id === a.owner.id)).toHaveLength(2);
    expect(await notices(b.org.id)).toEqual([]);
  });
});

describe("a failure that arrived from the worker", () => {
  it("is announced once when it used all three attempts, and a failure with retries left is not", async () => {
    const w = await world("Callback Co", ["lead_hunter", "crm_manager", "sales_assistant"]);
    const terminal = await addJob(w, "lead_hunter", { status: "failed", attempts: 3, detail: "Restricted Hermes profile setup failed (canary_failed). Review the isolated host result before retrying." });
    const retrying = await addJob(w, "crm_manager", { status: "failed", attempts: 1, detail: "Restricted Hermes profile setup failed (http_unavailable). Review the isolated host result before retrying." });
    const sync = await addJob(w, "sales_assistant", { status: "failed", attempts: 3, kind: "sync", detail: "Restricted Hermes profile setup failed (stale_configuration). Review the isolated host result before retrying." });
    const first = await runProvisioningWatchdog({ now: new Date() });
    expect(first).toMatchObject({ settled: 0, announced: 2 });
    expect(await audit(terminal, "agent.provisioning_failure_announced")).toHaveLength(1);
    expect(await audit(sync, "agent.provisioning_failure_announced")).toHaveLength(1);
    expect(await audit(retrying, "agent.provisioning_failure_announced")).toEqual([]);
    const agency = (await notices(w.org.id)).filter((n) => n.audience === "agency");
    expect(agency).toHaveLength(2);
    expect(agency.map((n) => n.title).sort()).toEqual([
      "Callback Co: Previous profile · Lead Hunter setup failed after 3 attempts",
      "Callback Co: Previous profile · Sales Assistant configuration update failed after 3 attempts",
    ]);
    expect(agency.find((n) => n.title.includes("Lead Hunter"))?.body).toContain("canary_failed");
    expect((await job(terminal)).status).toBe("failed"); // announcing changes no state

    const second = await runProvisioningWatchdog({ now: new Date() });
    expect(second.announced).toBe(0);
    expect(await notices(w.org.id)).toHaveLength(4);
  });

  it("uses the single Growth Partner identity in owner failure notices and stalled setup alerts", async () => {
    const failedWorld = await world("Growth Partner Failure Co", ["growth_partner"]);
    await addJob(failedWorld, "growth_partner", {
      status: "failed",
      attempts: 3,
      detail: "Restricted Hermes profile setup failed (canary_failed). Review the isolated host result before retrying.",
    });
    await runProvisioningWatchdog({ now: new Date() });
    const failedNotices = await notices(failedWorld.org.id);
    expect(failedNotices.find((notice) => notice.audience === "agency")?.title).toBe("Growth Partner Failure Co: AI Growth Partner setup failed after 3 attempts");
    expect(failedNotices.find((notice) => notice.audience === "client")?.title).toBe("AI Growth Partner is taking longer to set up than expected");
    expect(JSON.stringify(failedNotices)).not.toMatch(/AI employee|Lead Hunter/);

    const queuedWorld = await world("Growth Partner Queue Co", ["growth_partner"]);
    const queuedId = await addJob(queuedWorld, "growth_partner", { status: "requested" });
    await ageJob(queuedId, 40);
    enableProvisioner();
    await dropLiveness();
    await runProvisioningWatchdog({ now: new Date() });
    expect((await notices(queuedWorld.org.id, "provisioning-stalled:%")).find((notice) => notice.audience === "agency")?.title)
      .toBe("Growth Partner Queue Co: AI Growth Partner setup is stalled");
    await withSystem((db) => db.query("update agent_provisioning_jobs set status = 'succeeded' where org_id = $1 and id = $2", [queuedWorld.org.id, queuedId]));
  });

  it("carries no profile name, key or free text from an agency note into any notice", async () => {
    const w = await world("Secret Co");
    await withSystem((db) => db.query("update agent_instances set hermes_profile = 'c-secret-profile-name' where id = $1", [w.ids.lead_hunter]));
    const id = await addJob(w, "lead_hunter", { status: "failed", attempts: 3, detail: `Agency note: key ${["sk", "live", "ABCDEFGHIJKLMNOP1234"].join("_")} and profile c-secret-profile-name leaked` });
    await runProvisioningWatchdog({ now: new Date() });
    const sent = await notices(w.org.id);
    expect(sent).toHaveLength(2);
    const text = JSON.stringify(sent);
    for (const secret of ["c-secret-profile-name", "sk_live_", "ABCDEFGH", "leaked"]) expect(text, secret).not.toContain(secret);
    expect(JSON.stringify(await audit(id, "agent.provisioning_failure_announced"))).not.toMatch(/secret|sk_live|leaked/);
  });

  it("is announced again when the agency requeues it and the new job fails for good too", async () => {
    const w = await world("Again Co");
    const id = await addJob(w, "lead_hunter", { status: "failed", attempts: 3, detail: "Restricted Hermes profile setup failed (canary_failed). Review the isolated host result before retrying." });
    await ageJob(id, 60);
    await runProvisioningWatchdog({ now: new Date() });
    expect((await notices(w.org.id, "provisioning-failed:%")).filter((n) => n.audience === "agency")).toHaveLength(1);
    // The real requeue opens a NEW job beside the old one; that job then fails for good as well, later than the first announcement.
    const { adminId } = await readyToRequeue(w.org, w.owner.id, [w.ids.lead_hunter], staff.id);
    const { jobId } = await requeueAs(adminId, w.org.id, w.ids.lead_hunter);
    expect(jobId).not.toBe(id);
    expect((await runProvisioningWatchdog({ now: new Date() })).announced).toBe(0); // the new job is open: nothing to announce
    await withSystem((db) => db.query("update agent_provisioning_jobs set status = 'failed', attempt_count = 3, detail = 'Restricted Hermes profile setup failed (canary_failed). Review the isolated host result before retrying.' where id = $1", [jobId]));
    const again = await runProvisioningWatchdog({ now: new Date() });
    expect(again.announced).toBe(1);
    expect((await notices(w.org.id, "provisioning-failed:%")).filter((n) => n.audience === "agency")).toHaveLength(2);
    expect((await audit(jobId, "agent.provisioning_failure_announced"))).toHaveLength(1);
    expect((await runProvisioningWatchdog({ now: new Date() })).announced).toBe(0);
  });

  it("says nothing about a failed job that was requeued before the watchdog ran, or that a later job already replaced", async () => {
    const w = await world("Replaced Co", ["lead_hunter", "crm_manager"]);
    // Both employees' first jobs failed for good and nobody was told yet (the first pass after release looks like this for every old failure).
    const oldLead = await addJob(w, "lead_hunter", { status: "failed", attempts: 3, detail: "Restricted Hermes profile setup failed (canary_failed). Review the isolated host result before retrying." });
    const oldCrm = await addJob(w, "crm_manager", { status: "failed", attempts: 3, detail: "Restricted Hermes profile setup failed (canary_failed). Review the isolated host result before retrying." });
    const { adminId } = await readyToRequeue(w.org, w.owner.id, [w.ids.lead_hunter, w.ids.crm_manager], staff.id);
    // Lead Hunter: requeued, and the new job is still waiting. Customer Relationship Manager: requeued, and the new job already succeeded.
    const lead = await requeueAs(adminId, w.org.id, w.ids.lead_hunter);
    const crm = await requeueAs(adminId, w.org.id, w.ids.crm_manager);
    await withSystem((db) => db.query("update agent_provisioning_jobs set status = 'succeeded', attempt_count = 1 where id = $1", [crm.jobId]));
    const summary = await runProvisioningWatchdog({ now: new Date() });
    expect(summary.announced).toBe(0);
    // Nothing about a failure (the requeue's own "being retried" note to the owner is a different notice).
    expect(await notices(w.org.id, "provisioning-failed:%")).toEqual([]);
    expect(await audit(oldLead, "agent.provisioning_failure_announced")).toEqual([]);
    expect(await audit(oldCrm, "agent.provisioning_failure_announced")).toEqual([]);
    expect((await job(oldLead)).status).toBe("failed"); // announcing or not never changes a job
    expect((await job(lead.jobId)).status).toBe("requested");
    // A job that is the employee's newest and failed for good is still announced, once.
    const lone = await world("Lone Failure Co");
    const loneId = await addJob(lone, "lead_hunter", { status: "failed", attempts: 3, detail: "Restricted Hermes profile setup failed (canary_failed). Review the isolated host result before retrying." });
    expect((await runProvisioningWatchdog({ now: new Date() })).announced).toBe(1);
    expect(await audit(loneId, "agent.provisioning_failure_announced")).toHaveLength(1);
  });
});

describe("a stalled queue", () => {
  it("raises one notice per workspace per day when a request has waited past the threshold and the worker is silent", async () => {
    enableProvisioner();
    await verifiedGateway();
    await dropLiveness();
    const w = await world("Stalled Co");
    const other = await world("Quick Co");
    const id = await addJob(w, "lead_hunter", { status: "requested" });
    await ageJob(id, 45);
    await addJob(other, "lead_hunter", { status: "requested" }); // only just requested: not stalled
    const now = new Date();
    const first = await runProvisioningWatchdog({ now });
    expect(first.stalled).toBe(1);
    let sent = (await notices(w.org.id, "provisioning-stalled:%")).filter((n) => n.audience === "agency");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "setup_issue", severity: "warning", link: `/admin/clients/${w.org.id}` });
    expect(sent[0].body).toMatch(/never asked for work/);
    expect(sent[0].body).toContain("Nothing was changed");
    expect(await notices(other.org.id, "provisioning-stalled:%")).toEqual([]);
    expect((await job(id)).status).toBe("requested"); // no state change

    await runProvisioningWatchdog({ now: new Date(now.getTime() + 20 * ONE_MINUTE) });
    sent = (await notices(w.org.id, "provisioning-stalled:%")).filter((n) => n.audience === "agency");
    expect(sent).toHaveLength(1);
    await runProvisioningWatchdog({ now: new Date(now.getTime() + 25 * 60 * ONE_MINUTE) });
    expect((await notices(w.org.id, "provisioning-stalled:%")).filter((n) => n.audience === "agency")).toHaveLength(2);
  });

  it("treats a stale liveness row as a silent worker, and says since when", async () => {
    enableProvisioner();
    await verifiedGateway();
    const w = await world("Stale Row Co");
    await setLiveness(10);
    const id = await addJob(w, "lead_hunter", { status: "requested" });
    await ageJob(id, 40);
    await runProvisioningWatchdog({ now: new Date() });
    const sent = (await notices(w.org.id, "provisioning-stalled:%")).filter((n) => n.audience === "agency");
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toMatch(/has not asked for work since \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
  });

  it("says nothing while the worker is alive and the gateway is verified (the job is waiting on something in its own workspace)", async () => {
    enableProvisioner();
    await verifiedGateway();
    const w = await world("Healthy Queue Co");
    await setLiveness(1);
    const id = await addJob(w, "lead_hunter", { status: "requested" });
    await ageJob(id, 90);
    const summary = await runProvisioningWatchdog({ now: new Date() });
    expect(summary.stalled).toBe(0);
    expect(await notices(w.org.id)).toEqual([]);
  });

  it("raises it when the worker is alive but the pinned gateway is not verified", async () => {
    enableProvisioner();
    await verifiedGateway();
    await withSystem((db) => db.query("update hermes_gateways set provisioner_isolation_verified_at = null where id = $1", [GATEWAY_ID]));
    const w = await world("Unverified Gateway Co");
    await setLiveness(1);
    const id = await addJob(w, "lead_hunter", { status: "requested" });
    await ageJob(id, 90);
    await runProvisioningWatchdog({ now: new Date() });
    const sent = (await notices(w.org.id, "provisioning-stalled:%")).filter((n) => n.audience === "agency");
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toMatch(/gateway is not connected and verified/);
    expect(sent[0].body).not.toMatch(/has not asked for work/);
  });

  it("says nothing while the provisioner is switched off: waiting is then the intended state", async () => {
    resetEnvCache();
    await dropLiveness();
    const w = await world("Off Co");
    const id = await addJob(w, "lead_hunter", { status: "requested" });
    await ageJob(id, 600);
    const summary = await runProvisioningWatchdog({ now: new Date() });
    expect(summary.stalled).toBe(0);
    expect(await notices(w.org.id)).toEqual([]);
  });
});

describe("the follow-up on the first health check", () => {
  /** An employee that the worker handed over: profile, credential, job waiting for its check since `minutes` minutes. */
  async function awaiting(w: World, role: string, minutes: number): Promise<string> {
    await withSystem(async (db) => {
      const cred = await db.query<{ id: string }>("insert into integration_credentials (org_id, provider, label, ciphertext, fingerprint) values ($1, 'hermes', 'watchdog fixture', 'x', 'f') returning id", [w.org.id]);
      await db.query("update agent_instances set status = 'provisioning', enabled = true, hermes_profile = $2, credential_id = $3 where id = $1", [w.ids[role], `c-wd-${w.ids[role].slice(0, 8)}`, cred.rows[0].id]);
    });
    const id = await addJob(w, role, { status: "awaiting_health_check", attempts: 1 });
    await ageJob(id, minutes);
    return id;
  }
  const scripted = (answer: HealthResult) => {
    const asked: string[] = [];
    return { asked, check: async (id: string) => { asked.push(id); return answer; } };
  };

  it("checks only an employee that has waited two minutes, and a failed check never fails the job", async () => {
    const w = await world("Follow Co", ["lead_hunter", "crm_manager"]);
    const old = await awaiting(w, "lead_hunter", 6);
    const young = await awaiting(w, "crm_manager", 0);
    const { asked, check } = scripted({ ok: false, status: "offline", detail: "Hermes could not be reached." });
    const summary = await runProvisioningWatchdog({ now: new Date(), deps: { check } });
    expect(asked).toEqual([w.ids.lead_hunter]);
    expect(summary).toMatchObject({ checked: 1, failedChecks: 1 });
    expect((await job(old)).status).toBe("awaiting_health_check");
    expect((await job(young)).status).toBe("awaiting_health_check");
    expect(await q("select 1 from agent_provisioning_jobs where id = any($1::uuid[]) and status = 'failed'", [[old, young]])).toEqual([]);
  });

  it("never asks about a disabled employee or an employee of a suspended workspace, and never about another job kind's state", async () => {
    const off = await world("Disabled Co");
    await awaiting(off, "lead_hunter", 10);
    await withSystem((db) => db.query("update agent_instances set enabled = false where id = $1", [off.ids.lead_hunter]));
    const suspended = await world("Suspended Co");
    await awaiting(suspended, "lead_hunter", 10);
    await withSystem((db) => db.query("update organizations set status = 'suspended' where id = $1", [suspended.org.id]));
    const done = await world("Done Co");
    const finished = await awaiting(done, "lead_hunter", 10);
    await withSystem((db) => db.query("update agent_provisioning_jobs set status = 'succeeded' where id = $1", [finished]));
    const { asked, check } = scripted({ ok: true, status: "online", detail: "fine" });
    await runProvisioningWatchdog({ now: new Date(), deps: { check } });
    expect(asked).not.toContain(off.ids.lead_hunter);
    expect(asked).not.toContain(suspended.ids.lead_hunter);
    expect(asked).not.toContain(done.ids.lead_hunter);
  });
});

describe("the liveness row", () => {
  it("is written at most once a minute and read as silent once it is older than five minutes", async () => {
    await dropLiveness();
    expect(await recordProvisionerClaimSeen()).toBe(true);
    expect(await recordProvisionerClaimSeen()).toBe(false);
    const rows = await q<{ last_success_at: Date; consecutive_failures: number }>("select last_success_at, consecutive_failures from worker_job_runs where job_name = $1", [PROVISIONER_LIVENESS_JOB]);
    expect(rows).toHaveLength(1);
    expect(rows[0].consecutive_failures).toBe(0);
    await setLiveness(2);
    expect(await recordProvisionerClaimSeen()).toBe(true); // older than a minute: written again
    await setLiveness(6);
    const silence = await withSystem((db) => provisionerWorkerSilence(db, new Date()));
    expect(silence.silent).toBe(true);
    expect(silence.lastSeenAt).not.toBeNull();
    await recordProvisionerClaimSeen();
    expect((await withSystem((db) => provisionerWorkerSilence(db, new Date()))).silent).toBe(false);
    await dropLiveness();
    expect((await withSystem((db) => provisionerWorkerSilence(db, new Date()))).silent).toBe(true);
  });
});
