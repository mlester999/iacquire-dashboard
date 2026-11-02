// What closing a client does about the runtime profiles of its AI employees. A profile (its key and its tools on the client runtime) is not a row in this database, so the purge can never
// reach it. With containment switched on in the deployment (HERMES_PROVISIONER_DEPROVISION_ENABLED, off by default) a shutdown asks for every provisioned employee's profile to be
// contained; with it off nothing is asked. Deleting the workspace's data waits until every profile is contained, or until the agency writes down why one is being left, and that
// statement goes into the audit trail the purge keeps. Synthetic workspaces only; nothing here talks to Hermes.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { closeBilling, executeDeletion, requestOffboardingAsAgency, shutdownClient } from "@/server/offboarding/service";
import { claimHermesProvisionerWork, completeHermesProvisionerJob } from "@/server/workforce/hermes-provisioner";
import { agencyPeople } from "./support/crm";
import { provisionedClient, sharedGateway, type ClientTenant } from "./support/client-business-mcp";

let gateway: { id: string; baseUrl: string };
let superAdmin: Awaited<ReturnType<typeof agencyPeople>>["superAdmin"];
let counter = 0;

const rows = async <T>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;
const stub = (containment: boolean, purge = false) => {
  vi.stubEnv("HERMES_PROVISIONER_GATEWAY_ID", gateway.id);
  vi.stubEnv("HERMES_PROVISIONER_DEPROVISION_ENABLED", containment ? "true" : "false");
  vi.stubEnv("OFFBOARDING_PURGE_ENABLED", purge ? "true" : "false");
  resetEnvCache();
};
async function tenant(): Promise<ClientTenant> {
  counter += 1;
  return provisionedClient({ name: `Leaving Runtime Client ${counter}`, timezone: "America/Chicago", tag: `Leaver${counter}`, phone: `+1312555${String(3000 + counter)}`, crm: false });
}
const profilesOf = (orgId: string) => rows<{ hermes_profile: string | null }>("select hermes_profile from agent_instances where org_id = $1 and hermes_profile is not null order by hermes_profile", [orgId]);
const containmentJobs = (orgId: string) => rows<{ status: string; requested_by: string | null }>("select status, requested_by from agent_provisioning_jobs where org_id = $1 and kind = 'deprovision'", [orgId]);

/** A workspace taken through the request and the shutdown, with billing closed and the data downloaded, so only the runtime profiles stand between it and deletion. */
async function shutDown(t: ClientTenant) {
  const request = await requestOffboardingAsAgency(superAdmin, t.org.id, "The client asked to close their account.");
  const view = await shutdownClient(superAdmin, request.id, { websitePlan: "keep_until_deletion", retentionDays: 30 });
  await closeBilling(superAdmin, request.id, "Nothing is owed and no prepaid credit remains.");
  await withSystem((db) => db.query("update offboarding_requests set delete_after = now() - interval '1 day', export_downloaded_at = now() where id = $1", [request.id]));
  return { request, view };
}
const purge = (t: ClientTenant, requestId: string, over: Partial<Parameters<typeof executeDeletion>[2]> = {}) => executeDeletion(superAdmin, requestId, { confirmName: t.org.name, ...over });

beforeAll(async () => {
  gateway = await sharedGateway();
  superAdmin = (await agencyPeople()).superAdmin;
});
beforeEach(() => stub(false));
afterEach(async () => {
  vi.unstubAllEnvs();
  resetEnvCache();
  await withSystem((db) => db.query("update agent_provisioning_jobs set status = 'cancelled', lease_token = null, lease_expires_at = null where status in ('requested', 'in_progress', 'failed', 'awaiting_health_check')"));
});
afterAll(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("shutting a workspace down", () => {
  it("asks for nothing and says nothing about profiles while containment is switched off", async () => {
    const t = await tenant();
    const request = await requestOffboardingAsAgency(superAdmin, t.org.id, "The client asked to close their account.");
    const view = await shutdownClient(superAdmin, request.id, { websitePlan: "keep_until_deletion", retentionDays: 30 });
    expect(view.steps.map((s) => s.key)).not.toContain("runtime_profiles");
    expect(await containmentJobs(t.org.id)).toHaveLength(0);
    expect(await profilesOf(t.org.id)).toHaveLength(6);
  });

  it("with containment on, asks for every provisioned employee's profile to be contained, once each, and says so", async () => {
    stub(true);
    const t = await tenant();
    const bystander = await tenant();
    const request = await requestOffboardingAsAgency(superAdmin, t.org.id, "The client asked to close their account.");
    const view = await shutdownClient(superAdmin, request.id, { websitePlan: "keep_until_deletion", retentionDays: 30 });
    expect(view.steps.find((s) => s.key === "runtime_profiles")).toMatchObject({ ok: true, text: expect.stringMatching(/Asked the client runtime to contain 6 AI employee profiles.*Nothing is deleted\./) });
    expect(await containmentJobs(t.org.id)).toEqual(Array.from({ length: 6 }, () => ({ status: "requested", requested_by: superAdmin.id })));
    const audit = await rows<{ metadata: { reason: string } }>("select metadata from audit_logs where org_id = $1 and action = 'agent.profile_deprovision_requested'", [t.org.id]);
    expect(audit).toHaveLength(6);
    expect(audit.every((row) => row.metadata.reason.includes(request.id))).toBe(true);
    // Nothing was deleted, and no other workspace was touched.
    expect(await profilesOf(t.org.id)).toHaveLength(6);
    expect(await containmentJobs(bystander.org.id)).toHaveLength(0);
  });
});

describe("deleting a workspace's data", () => {
  it("refuses while a profile is still set up, and until the agency writes down why, and deletes nothing meanwhile", async () => {
    stub(false, true);
    const t = await tenant();
    const { request } = await shutDown(t);
    await expect(purge(t, request.id)).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/6 AI employee runtime profiles are still set up/) });
    await expect(purge(t, request.id, { acknowledgeRuntimeProfiles: "later" })).rejects.toMatchObject({ code: "conflict" });
    expect((await rows("select 1 from agent_instances where org_id = $1", [t.org.id])).length).toBe(6);
    expect(await rows("select 1 from audit_logs where org_id = $1 and action = 'offboarding.runtime_profiles_left'", [t.org.id])).toHaveLength(0);
  });

  it("goes ahead with a written reason, and records which profiles were left in the audit trail the purge keeps", async () => {
    stub(false, true);
    const t = await tenant();
    const { request } = await shutDown(t);
    const profiles = (await profilesOf(t.org.id)).map((p) => p.hermes_profile).sort();
    const reason = "Containment is not switched on in this deployment yet; the profiles are removed by hand.";
    await expect(purge(t, request.id, { acknowledgeRuntimeProfiles: reason })).resolves.toMatchObject({ purgedRows: expect.any(Number) });
    const left = await rows<{ metadata: { count: number; profiles: string[]; gatewayIds: string[]; acknowledgement: string }; actor_user_id: string | null }>(
      "select metadata, actor_user_id from audit_logs where org_id = $1 and action = 'offboarding.runtime_profiles_left'", [t.org.id]);
    expect(left).toHaveLength(1);
    expect(left[0].metadata.count).toBe(6);
    expect([...left[0].metadata.profiles].sort()).toEqual(profiles);
    expect(left[0].metadata.gatewayIds).toEqual([gateway.id]);
    expect(left[0].metadata.acknowledgement).toBe(reason);
    expect(left[0].actor_user_id).toBe(superAdmin.id);
    // The workspace's own rows are gone, the audit row is not.
    expect(await rows("select 1 from agent_instances where org_id = $1", [t.org.id])).toHaveLength(0);
  });

  it("needs no acknowledgement once every profile has really been contained, and writes no 'left' row", async () => {
    stub(true, true);
    const t = await tenant();
    const { request } = await shutDown(t);
    expect(await containmentJobs(t.org.id)).toHaveLength(6);
    // The worker proves each containment, as it would; the portal then clears each employee's mapping.
    for (let i = 0; i < 6; i += 1) {
      const job = await claimHermesProvisionerWork(gateway.id);
      if (!job) throw new Error("expected a containment job to claim");
      await completeHermesProvisionerJob({
        ok: true, jobId: job.jobId, leaseToken: job.leaseToken, gatewayId: job.gatewayId, kind: "deprovision", orgId: job.orgId, agentId: job.agentId, profile: job.profile,
        revoked: true, oldKeyRejected: true, toolsetsEmpty: true, retiredAt: Math.floor(Date.now() / 1000), hermesVersion: "hermes v0.21.5-test",
      }, gateway.id);
    }
    expect(await profilesOf(t.org.id)).toHaveLength(0);
    await expect(purge(t, request.id)).resolves.toMatchObject({ purgedRows: expect.any(Number) });
    expect(await rows("select 1 from audit_logs where org_id = $1 and action = 'offboarding.runtime_profiles_left'", [t.org.id])).toHaveLength(0);
  });

  it("is unchanged for a workspace that never had a runtime profile", async () => {
    stub(false, true);
    const t = await tenant();
    await withSystem((db) => db.query("update agent_instances set hermes_profile = null, hermes_gateway_id = null, hermes_base_url = null where org_id = $1", [t.org.id]));
    const { request } = await shutDown(t);
    await expect(purge(t, request.id)).resolves.toMatchObject({ purgedRows: expect.any(Number) });
    expect(await rows("select 1 from audit_logs where org_id = $1 and action = 'offboarding.runtime_profiles_left'", [t.org.id])).toHaveLength(0);
  });
});
