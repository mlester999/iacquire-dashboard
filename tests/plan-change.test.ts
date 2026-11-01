// A plan change that does real work: an employee added to a client's plan after onboarding is configured from the client's confirmed answers and has its setup requested (still
// waiting for the setup payment), one removed has its not-yet-started setup cancelled, and every refusal writes nothing. Embedded Postgres on the real migrations; the Hermes worker
// is not live, so a provisioned profile is the recorded state it would leave.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { agentSettingsSchema } from "@/lib/agent-settings";
import { afterSetupCleared } from "@/server/billing/after-clearing";
import { applyRolePlanChange, PLAN_REMOVED_DETAIL } from "@/server/onboarding/employee-sync";
import { setAgentEnabled, setTenantStatus } from "@/server/admin/tenants";
import { allocateClientCredentialId, registerClientBusinessCredential, verifyClientCredential, formatClientCredential, hashClientSecret, generateClientCredentialSecret } from "@/server/workforce/hermes-client-business-credential";
import { createConfigVersion } from "@/server/workforce/service";
import { agencyUser, agentId, createOrg, createUser, addMember } from "./support/fixtures";
import { clearSetupPayment, submitRealOnboarding } from "./support/billing";

type SessionAdmin = ReturnType<typeof agencyUser>;
let admin: SessionAdmin;
let manager: SessionAdmin;

beforeAll(async () => {
  admin = agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
  manager = agencyUser(await createUser({ platformRole: "agency_manager" }), "agency_manager");
});

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;
const REASON = "Upgraded to the full plan";

/** A client that finished the real questionnaire without a Sales Assistant in its plan. */
async function clientWithoutSales(name: string, paid = true) {
  const c = await submitRealOnboarding({ name, clearPayment: paid, disableRoles: ["sales_assistant"] });
  return { ...c, sales: await agentId(c.org.id, "sales_assistant") };
}
const jobsOf = (orgId: string, agentInstanceId: string, kind = "provision") => rows<{ id: string; status: string; detail: string | null; requested_by: string | null; config_version_id: string | null; kind: string }>(
  "select id, status, detail, requested_by, config_version_id, kind from agent_provisioning_jobs where org_id = $1 and agent_instance_id = $2 and kind = $3 order by created_at, id", [orgId, agentInstanceId, kind]);
const otherJobs = (orgId: string, except: string) => rows<{ id: string; status: string; attempt_count: number; detail: string | null; requested_by: string | null }>(
  "select id, status, attempt_count, detail, requested_by from agent_provisioning_jobs where org_id = $1 and agent_instance_id <> $2 order by id", [orgId, except]);
const versionsOf = (orgId: string, agent: string) => rows<{ version: number; source: string; status: string; change_request: string | null; compiled_instructions: string }>(
  "select version, source, status, change_request, compiled_instructions from agent_config_versions where org_id = $1 and agent_instance_id = $2 order by version", [orgId, agent]);
const audits = (orgId: string, action: string) => rows<{ metadata: Record<string, unknown>; actor_user_id: string | null; result: string }>("select metadata, actor_user_id, result from audit_logs where org_id = $1 and action = $2", [orgId, action]);
const agentRow = async (id: string) => (await rows<{ enabled: boolean; status: string }>("select enabled, status from agent_instances where id = $1", [id]))[0];
const notices = (userId: string, like: string) => rows("select 1 from notifications where user_id = $1 and title like $2", [userId, like]);

describe("adding an employee to a client's plan after onboarding", () => {
  it("configures it from the confirmed answers and requests its setup once, leaving the other employees' requests alone", async () => {
    const c = await clientWithoutSales("Add Roofing Co");
    expect(await versionsOf(c.org.id, c.sales)).toHaveLength(0);
    expect(await jobsOf(c.org.id, c.sales)).toHaveLength(0);
    const othersBefore = await otherJobs(c.org.id, c.sales);
    expect(othersBefore).toHaveLength(5);

    const first = await setAgentEnabled(admin, c.org.id, c.sales, true, REASON);
    expect(first).toMatchObject({ changed: true, enabled: true, configuration: "built", provisioning: "requested", syncQueued: false });
    // One configuration, from the client's own answers, recorded as onboarding's work and applied.
    const versions = await versionsOf(c.org.id, c.sales);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ version: 1, source: "onboarding", status: "applied" });
    expect(versions[0].change_request).toMatch(/Added to the plan after onboarding/);
    expect(versions[0].compiled_instructions).toContain("Add Roofing Co");
    // One setup request, with the workspace's owner as the accountable person; nothing else was touched.
    const jobs = await jobsOf(c.org.id, c.sales);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: "requested", requested_by: c.owner.id });
    expect(await otherJobs(c.org.id, c.sales)).toEqual(othersBefore);
    expect(await agentRow(c.sales)).toEqual({ enabled: true, status: "setup_required" });
    expect((await audits(c.org.id, "agent.enabled")).filter((a) => a.actor_user_id === admin.id)).toHaveLength(1);
    expect((await audits(c.org.id, "agent.enabled"))[0].metadata).toMatchObject({ reason: REASON, planChange: true, configuration: "built", provisioning: "requested" });
    expect(await notices(c.owner.id, "Sales Assistant was added to your plan")).toHaveLength(1);

    // Doing it again changes nothing: no second version, no second request, no second audit row or notice.
    const second = await setAgentEnabled(admin, c.org.id, c.sales, true, REASON);
    expect(second).toMatchObject({ changed: false, configuration: "existing", provisioning: "already_open" });
    expect(await versionsOf(c.org.id, c.sales)).toHaveLength(1);
    expect(await jobsOf(c.org.id, c.sales)).toHaveLength(1);
    expect((await audits(c.org.id, "agent.enabled")).filter((a) => a.actor_user_id === admin.id)).toHaveLength(1);
    expect(await notices(c.owner.id, "Sales Assistant was added to your plan")).toHaveLength(1);
  }, 120_000);

  it("honours the payment gate: the employee is configured, nothing is requested until the payment clears, and then exactly one request opens", async () => {
    const c = await clientWithoutSales("Unpaid Add Roofing", false);
    const result = await setAgentEnabled(admin, c.org.id, c.sales, true, REASON);
    expect(result).toMatchObject({ changed: true, configuration: "built", provisioning: "waiting_for_payment" });
    expect(await versionsOf(c.org.id, c.sales)).toHaveLength(1);
    expect(await jobsOf(c.org.id, c.sales)).toHaveLength(0);
    expect(Number((await rows<{ n: string }>("select count(*) as n from agent_provisioning_jobs where org_id = $1", [c.org.id]))[0].n)).toBe(0);
    // The client is told once that setup waits for the payment (the same notice onboarding gives).
    expect(await rows("select 1 from notifications where user_id = $1 and kind = 'billing_setup_payment_required'", [c.owner.id])).toHaveLength(1);

    await clearSetupPayment(c.org.id);
    await withSystem((db) => afterSetupCleared(db, c.org.id, { actorUserId: null, how: "waiver", eventKey: `plan-change-${c.org.id}` }));
    expect(await jobsOf(c.org.id, c.sales)).toHaveLength(1);
    // Doing the plan change again after that is still the same single request.
    expect(await setAgentEnabled(admin, c.org.id, c.sales, true, REASON)).toMatchObject({ changed: false, provisioning: "already_open" });
    expect(await jobsOf(c.org.id, c.sales)).toHaveLength(1);
  }, 120_000);

  it("waits for the client to approve answers they changed instead of building from them", async () => {
    const c = await clientWithoutSales("Pending Add Roofing");
    const { saveOnboardingStep } = await import("@/server/onboarding/service");
    await saveOnboardingStep(c.ctx, { answers: { "b.services": { value: "Services the client changed and has not approved" } } });
    const result = await setAgentEnabled(admin, c.org.id, c.sales, true, REASON);
    expect(result).toMatchObject({ enabled: true, configuration: "waiting_for_client", provisioning: "not_applicable" });
    expect(await versionsOf(c.org.id, c.sales)).toHaveLength(0);
    expect(await jobsOf(c.org.id, c.sales)).toHaveLength(0);
    // After the client approves and submits, the same submission builds it (a submission no longer treats an unconfigured employee as unchanged).
    await saveOnboardingStep(c.ctx, { answers: { "f.review": { value: true } } });
    const { submitOnboarding } = await import("@/server/onboarding/service");
    await submitOnboarding(c.ctx);
    const versions = await versionsOf(c.org.id, c.sales);
    expect(versions).toHaveLength(1);
    expect(versions[0].compiled_instructions).toContain("Services the client changed and has not approved");
  }, 120_000);

  it("only flips the switch for a client that has not finished the questionnaire: its submission configures everything", async () => {
    const org = await createOrg({ name: "Not Onboarded Co" });
    const owner = await createUser();
    await addMember(org.id, owner.id, "owner");
    const sales = await agentId(org.id, "sales_assistant");
    await withSystem((db) => db.query("update agent_instances set enabled = false, status = 'disabled' where id = $1", [sales]));
    const result = await setAgentEnabled(admin, org.id, sales, true, REASON);
    expect(result).toMatchObject({ changed: true, enabled: true, configuration: "not_needed", provisioning: "not_applicable" });
    expect(await versionsOf(org.id, sales)).toHaveLength(0);
    expect(await jobsOf(org.id, sales)).toHaveLength(0);
  }, 120_000);
});

describe("removing an employee from the plan", () => {
  it("cancels the setup request with a recorded reason, tells the client, and changes nothing the second time", async () => {
    const c = await clientWithoutSales("Remove Roofing Co");
    await setAgentEnabled(admin, c.org.id, c.sales, true, REASON);
    const requested = (await jobsOf(c.org.id, c.sales))[0];
    const result = await setAgentEnabled(admin, c.org.id, c.sales, false, "Downgraded at the client's request");
    expect(result).toMatchObject({ changed: true, enabled: false, configuration: "removed", cancelledJobs: 1, runningJobs: 0 });
    expect((await jobsOf(c.org.id, c.sales))[0]).toMatchObject({ id: requested.id, status: "cancelled", detail: PLAN_REMOVED_DETAIL });
    expect(await agentRow(c.sales)).toEqual({ enabled: false, status: "disabled" });
    expect((await audits(c.org.id, "agent.disabled"))[0]).toMatchObject({ metadata: { reason: "Downgraded at the client's request", planChange: true, cancelledJobs: 1 } });
    expect(await notices(c.owner.id, "Sales Assistant is no longer part of your plan")).toHaveLength(1);
    // Its configuration and history are kept.
    expect(await versionsOf(c.org.id, c.sales)).toHaveLength(1);

    const again = await setAgentEnabled(admin, c.org.id, c.sales, false, "Downgraded at the client's request");
    expect(again).toMatchObject({ changed: false, cancelledJobs: 0 });
    expect(await audits(c.org.id, "agent.disabled")).toHaveLength(1);
    expect(await notices(c.owner.id, "Sales Assistant is no longer part of your plan")).toHaveLength(1);
  }, 120_000);

  it("lets a request the worker already started run to its lease, cancels a failed one, and never touches another employee's", async () => {
    const c = await clientWithoutSales("Running Roofing Co");
    await setAgentEnabled(admin, c.org.id, c.sales, true, REASON);
    await withSystem((db) => db.query("update agent_provisioning_jobs set status = 'in_progress', attempt_count = 1, lease_token = gen_random_uuid(), lease_expires_at = now() + interval '5 minutes' where agent_instance_id = $1", [c.sales]));
    const othersBefore = await otherJobs(c.org.id, c.sales);
    const running = await setAgentEnabled(admin, c.org.id, c.sales, false, "Removed while it was starting");
    expect(running).toMatchObject({ changed: true, cancelledJobs: 0, runningJobs: 1 });
    expect((await jobsOf(c.org.id, c.sales))[0].status).toBe("in_progress");
    expect(await otherJobs(c.org.id, c.sales)).toEqual(othersBefore);

    const f = await clientWithoutSales("Failed Roofing Co");
    await setAgentEnabled(admin, f.org.id, f.sales, true, REASON);
    await withSystem((db) => db.query("update agent_provisioning_jobs set status = 'failed', attempt_count = 1, detail = 'The host did not answer', next_retry_at = now() + interval '5 minutes' where agent_instance_id = $1", [f.sales]));
    expect(await setAgentEnabled(admin, f.org.id, f.sales, false, "Removed after a failed start")).toMatchObject({ cancelledJobs: 1 });
    expect((await jobsOf(f.org.id, f.sales))[0]).toMatchObject({ status: "cancelled", detail: PLAN_REMOVED_DETAIL });
  }, 120_000);

  it("ends the employee's business-tool credential with its place in the plan", async () => {
    const c = await clientWithoutSales("Credential Roofing Co");
    await setAgentEnabled(admin, c.org.id, c.sales, true, REASON);
    const profile = `c-${randomUUID().slice(0, 8)}-sales`;
    await withSystem((db) => db.query("update agent_instances set hermes_base_url = 'http://client-gateway.test', hermes_profile = $2 where id = $1", [c.sales, profile]));
    const secret = generateClientCredentialSecret();
    const issued = await withSystem(async (db) => {
      const id = await allocateClientCredentialId(db, { orgId: c.org.id, agentId: c.sales });
      return registerClientBusinessCredential(db, { orgId: c.org.id, agentId: c.sales, profile, secretSha256: hashClientSecret(secret), credentialId: id });
    });
    const credential = formatClientCredential(issued.id, secret);
    expect((await withSystem((db) => verifyClientCredential(db, credential))).ok).toBe(true);
    await setAgentEnabled(admin, c.org.id, c.sales, false, "Removed from the plan");
    expect(await withSystem((db) => verifyClientCredential(db, credential))).toMatchObject({ ok: false, reason: "revoked" });
  }, 120_000);
});

describe("adding an employee back", () => {
  it("can open a new setup request after the plan's own cancellation, but never reopens one an agency person cancelled", async () => {
    const c = await clientWithoutSales("Again Roofing Co");
    await setAgentEnabled(admin, c.org.id, c.sales, true, REASON);
    await setAgentEnabled(admin, c.org.id, c.sales, false, "Paused for the quarter");
    const back = await setAgentEnabled(admin, c.org.id, c.sales, true, "Back on the plan for the next quarter");
    expect(back).toMatchObject({ changed: true, configuration: "existing", provisioning: "requested" });
    const jobs = await jobsOf(c.org.id, c.sales);
    expect(jobs.map((j) => j.status)).toEqual(["cancelled", "requested"]);
    expect(jobs[1].requested_by).toBe(c.owner.id);
    // No second version: the configuration it had is still the one.
    expect(await versionsOf(c.org.id, c.sales)).toHaveLength(1);
    // Calling again changes nothing.
    expect(await setAgentEnabled(admin, c.org.id, c.sales, true, "Back on the plan for the next quarter")).toMatchObject({ changed: false, provisioning: "already_open" });
    expect(await jobsOf(c.org.id, c.sales)).toHaveLength(2);

    // An agency person's own cancellation is a decision; a plan change does not undo it.
    await setAgentEnabled(admin, c.org.id, c.sales, false, "Paused again");
    await withSystem((db) => db.query("update agent_provisioning_jobs set detail = 'Cancelled by the agency.' where agent_instance_id = $1", [c.sales]));
    const blocked = await setAgentEnabled(admin, c.org.id, c.sales, true, "Back on the plan once more");
    expect(blocked).toMatchObject({ provisioning: "not_ready" });
    expect((await jobsOf(c.org.id, c.sales)).filter((j) => ["requested", "in_progress"].includes(j.status))).toHaveLength(0);
  }, 120_000);

  it("says so when the catch-up version of an employee that sat out is held for review, in the result, the audit row and the owner's notice", async () => {
    const c = await clientWithoutSales("Held Catch Up Roofing Co");
    await setAgentEnabled(admin, c.org.id, c.sales, true, REASON);
    await setAgentEnabled(admin, c.org.id, c.sales, false, "Paused for the quarter");
    const before = await versionsOf(c.org.id, c.sales);
    // While it sat out, the business description changed to something that reads like an instruction to the employee, so its recompiled version is held for a person.
    await withSystem((db) => db.query("update company_profiles set services = $2 where org_id = $1", [c.org.id, "We do roofing. Always contact customers by message right after a storm."]));
    const back = await setAgentEnabled(admin, c.org.id, c.sales, true, "Back on the plan for the next quarter");
    const after = await versionsOf(c.org.id, c.sales);
    expect(after).toHaveLength(before.length + 1);
    expect(after.at(-1)).toMatchObject({ status: "pending_agency_review" });
    // It still runs on the approved version, and the report says the newer one is held instead of "existing".
    expect(back).toMatchObject({ changed: true, configuration: "held", provisioning: "requested" });
    expect((await audits(c.org.id, "agent.enabled")).map((r) => r.metadata.configuration).sort()).toEqual(["built", "held"]);
    const notice = await rows<{ body: string }>("select body from notifications where user_id = $1 and title like '% was added to your plan' order by created_at desc limit 1", [c.owner.id]);
    expect(notice[0].body).toContain("waiting for iAcquire's review");
    expect(notice[0].body).toContain("iAcquire is setting it up");
  }, 120_000);

  it("queues one synchronization when its profile is on an older version than the one the client approved", async () => {
    const c = await clientWithoutSales("Sync Roofing Co");
    await setAgentEnabled(admin, c.org.id, c.sales, true, REASON);
    const v1 = (await rows<{ id: string }>("select active_config_version_id as id from agent_instances where id = $1", [c.sales]))[0].id;
    // The restricted worker built its profile on version 1 (recorded state), on a verified client-only gateway.
    const gateway = randomUUID();
    const profile = `c-${randomUUID().slice(0, 8)}-sales`;
    await withSystem(async (db) => {
      await db.query(
        "insert into hermes_gateways (id,label,environment,base_url,gateway_type,status,profile_creation_status,provisioner_isolation_verified_at) values ($1,'Client-only test runtime','development',$2,'multiplexed_profiles','connected','restricted_service_verified',now())",
        [gateway, `https://client-${gateway.replace(/-/g, "")}.hermes.test`]);
      await db.query("update agent_instances set hermes_gateway_id = $2, hermes_base_url = (select base_url from hermes_gateways where id = $2), hermes_profile = $3, hermes_profile_config_version_id = $4, status = 'online' where id = $1", [c.sales, gateway, profile, v1]);
      await db.query("update agent_provisioning_jobs set status = 'succeeded', result_reference = 'provisioner:v1:test-profile' where agent_instance_id = $1 and kind = 'provision'", [c.sales]);
    });
    await setAgentEnabled(admin, c.org.id, c.sales, false, "Paused while we talk");
    // While it is off, the client changes its employee: version 2 is applied, and no synchronization is queued for a paused employee.
    const active = (await rows<{ settings: unknown }>("select settings from agent_config_versions where id = $1", [v1]))[0].settings;
    await withSystem((db) => createConfigVersion(db, { orgId: c.org.id, agentId: c.sales, settings: agentSettingsSchema.parse({ ...(active as object), personality: "A personality the client wrote while it was paused." }), source: "client_edit", userId: c.owner.id, apply: true }));
    expect(await jobsOf(c.org.id, c.sales, "sync")).toHaveLength(0);

    const back = await setAgentEnabled(admin, c.org.id, c.sales, true, "Back on the plan");
    expect(back).toMatchObject({ changed: true, provisioning: "not_applicable", syncQueued: true });
    const syncs = await jobsOf(c.org.id, c.sales, "sync");
    expect(syncs).toHaveLength(1);
    expect(syncs[0]).toMatchObject({ status: "requested", kind: "sync" });
    const v2 = (await rows<{ id: string }>("select active_config_version_id as id from agent_instances where id = $1", [c.sales]))[0].id;
    expect(syncs[0].config_version_id).toBe(v2);
    expect(v2).not.toBe(v1);
    // No new provisioning request for a profile that already exists, and a second call queues nothing more.
    expect(await jobsOf(c.org.id, c.sales)).toHaveLength(1);
    expect(await setAgentEnabled(admin, c.org.id, c.sales, true, "Back on the plan")).toMatchObject({ changed: false, syncQueued: true });
    expect(await jobsOf(c.org.id, c.sales, "sync")).toHaveLength(1);
  }, 120_000);
});

describe("what a plan change refuses, and writes nothing for", () => {
  /** Everything a refused call could have left behind in the workspace. */
  async function snapshot(orgId: string) {
    const get = async (sql: string) => (await rows<{ n: string }>(sql, [orgId]))[0].n;
    return {
      agents: await rows("select id, enabled, status, active_config_version_id from agent_instances where org_id = $1 order by id", [orgId]),
      versions: await get("select count(*) as n from agent_config_versions where org_id = $1"),
      jobs: await get("select count(*) as n from agent_provisioning_jobs where org_id = $1"),
      audits: await get("select count(*) as n from audit_logs where org_id = $1"),
      notifications: await get("select count(*) as n from notifications where org_id = $1"),
    };
  }

  it("refuses a missing or short reason, a wrong workspace and anyone who is not a super admin", async () => {
    const c = await clientWithoutSales("Refusal Roofing Co");
    const other = await clientWithoutSales("Other Refusal Roofing Co");
    const before = await snapshot(c.org.id);
    const otherBefore = await snapshot(other.org.id);
    await expect(setAgentEnabled(admin, c.org.id, c.sales, true, "")).rejects.toThrow(/at least 5/);
    await expect(setAgentEnabled(admin, c.org.id, c.sales, true, "abc")).rejects.toThrow(/at least 5/);
    await expect(setAgentEnabled(admin, c.org.id, c.sales, true, "x".repeat(501))).rejects.toThrow(/500/);
    await expect(setAgentEnabled(manager, c.org.id, c.sales, true, REASON)).rejects.toThrow(/super admins/i);
    await expect(setAgentEnabled({ ...admin, platformRole: "none" }, c.org.id, c.sales, true, REASON)).rejects.toThrow(/super admins/i);
    // An employee id from another workspace is simply not found.
    await expect(setAgentEnabled(admin, other.org.id, c.sales, true, REASON)).rejects.toThrow(/not found/i);
    await expect(setAgentEnabled(admin, c.org.id, other.sales, true, REASON)).rejects.toThrow(/not found/i);
    // The plan-change function itself holds the same lines when called directly.
    await expect(withSystem((db) => applyRolePlanChange(db, { orgId: c.org.id, agentId: c.sales, enabled: true, actor: { id: manager.id, platformRole: "agency_manager" }, reason: REASON }))).rejects.toThrow(/super admins/i);
    expect(await snapshot(c.org.id)).toEqual(before);
    expect(await snapshot(other.org.id)).toEqual(otherBefore);
  }, 120_000);

  it("refuses the internal agency workspace's plan change to the plan-change path and a demo workspace's, which keep their plain switch", async () => {
    const agencyOrg = await createOrg({ name: "Internal Plan Workspace", kind: "agency" });
    const lead = await agentId(agencyOrg.id, "lead_hunter");
    const before = await snapshot(agencyOrg.id);
    await expect(withSystem((db) => applyRolePlanChange(db, { orgId: agencyOrg.id, agentId: lead, enabled: false, actor: { id: admin.id, platformRole: "agency_super_admin" }, reason: REASON }))).rejects.toThrow(/client workspaces/i);
    expect(await snapshot(agencyOrg.id)).toEqual(before);
    // The public entry point still switches the internal employee, exactly as before: no configuration, no request, no client notice.
    expect(await setAgentEnabled(admin, agencyOrg.id, lead, false, REASON)).toBeNull();
    expect(await agentRow(lead)).toEqual({ enabled: false, status: "disabled" });
    expect(await setAgentEnabled(admin, agencyOrg.id, lead, true, REASON)).toBeNull();
    expect(await agentRow(lead)).toEqual({ enabled: true, status: "setup_required" });
    expect(Number((await rows<{ n: string }>("select count(*) as n from agent_config_versions where org_id = $1", [agencyOrg.id]))[0].n)).toBe(0);
    expect(Number((await rows<{ n: string }>("select count(*) as n from agent_provisioning_jobs where org_id = $1", [agencyOrg.id]))[0].n)).toBe(0);
    expect((await audits(agencyOrg.id, "agent.disabled"))[0].metadata).toMatchObject({ reason: REASON });

    const demo = await clientWithoutSales("Demo Plan Roofing Co");
    await withSystem((db) => db.query("update organizations set is_demo = true where id = $1", [demo.org.id]));
    const demoBefore = await snapshot(demo.org.id);
    await expect(withSystem((db) => applyRolePlanChange(db, { orgId: demo.org.id, agentId: demo.sales, enabled: true, actor: { id: admin.id, platformRole: "agency_super_admin" }, reason: REASON }))).rejects.toThrow(/client workspaces/i);
    expect(await snapshot(demo.org.id)).toEqual(demoBefore);
    expect(await setAgentEnabled(admin, demo.org.id, demo.sales, true, REASON)).toBeNull();
    expect(await versionsOf(demo.org.id, demo.sales)).toHaveLength(0);
    expect(await jobsOf(demo.org.id, demo.sales)).toHaveLength(0);
  }, 120_000);

  it("refuses an employee mapped from the internal tier", async () => {
    const c = await clientWithoutSales("Mapped Roofing Co");
    // The database refuses to map a client employee to an internal profile; the guard here is the second line, so the trigger is stepped around for the fixture.
    await withSystem(async (db) => {
      await db.query("alter table agent_instances disable trigger agent_instances_guard");
      await db.query("update agent_instances set hermes_base_url = 'http://mapped-gateway.test', hermes_profile = 'iacquire-sales-assistant' where id = $1", [c.sales]);
      await db.query("alter table agent_instances enable trigger agent_instances_guard");
    });
    const before = await snapshot(c.org.id);
    await expect(setAgentEnabled(admin, c.org.id, c.sales, true, REASON)).rejects.toThrow(/iAcquire's own profiles/);
    expect(await snapshot(c.org.id)).toEqual(before);
    await withSystem((db) => db.query("update agent_instances set hermes_profile = null, hermes_base_url = null where id = $1", [c.sales]));
  }, 120_000);
});

describe("suspending a client workspace", () => {
  it("ends its employees' business-tool credentials, and only its own", async () => {
    const a = await clientWithoutSales("Suspend A Roofing");
    const b = await clientWithoutSales("Suspend B Roofing");
    const issue = async (c: typeof a) => {
      const profile = `c-${randomUUID().slice(0, 8)}-lead`;
      const lead = await agentId(c.org.id, "lead_hunter");
      await withSystem((db) => db.query("update agent_instances set hermes_base_url = 'http://client-gateway.test', hermes_profile = $2 where id = $1", [lead, profile]));
      const secret = generateClientCredentialSecret();
      const out = await withSystem((db) => registerClientBusinessCredential(db, { orgId: c.org.id, agentId: lead, profile, secretSha256: hashClientSecret(secret) }));
      return formatClientCredential(out.id, secret);
    };
    const [ca, cb] = [await issue(a), await issue(b)];
    expect((await withSystem((db) => verifyClientCredential(db, ca))).ok).toBe(true);
    await setTenantStatus(admin, a.org.id, "suspended", "Unpaid invoice outside the portal");
    expect(await withSystem((db) => verifyClientCredential(db, ca))).toMatchObject({ ok: false, reason: "revoked" });
    expect((await withSystem((db) => verifyClientCredential(db, cb))).ok).toBe(true);
    const revoked = await rows<{ metadata: { reason?: string } }>("select metadata from audit_logs where org_id = $1 and action = 'hermes.client_business_mcp.credential_revoked'", [a.org.id]);
    expect(revoked).toHaveLength(1);
    expect(revoked[0].metadata.reason).toBe("workspace_suspended");
    // Reactivating does not bring a credential back: it is issued again when the profile is synchronized.
    await setTenantStatus(admin, a.org.id, "active");
    expect(await withSystem((db) => verifyClientCredential(db, ca))).toMatchObject({ ok: false, reason: "revoked" });
  }, 120_000);
});
