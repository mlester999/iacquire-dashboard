// Containment of a client employee's runtime profile. The portal asks (requestDeprovision), the restricted worker proves the profile's key was replaced and its tools are off, and only
// then does the portal revoke the employee's credentials and mark it not set up. Nothing is deleted. Handing the job to the worker is behind the default-off switch
// HERMES_PROVISIONER_DEPROVISION_ENABLED. The worker's own key names are read from services/hermes-provisioner/worker.py, so the two sides cannot drift apart without this failing.
// Synthetic workspaces and a synthetic gateway only; nothing here talks to Hermes.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRoleKey } from "@/lib/agents";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { claimHermesProvisionerJob, claimHermesProvisionerWork, completeHermesProvisionerJob } from "@/server/workforce/hermes-provisioner";
import { requestDeprovision } from "@/server/workforce/provisioning";
import { suggestedProfileName } from "@/server/workforce/service";
import { agencyPeople } from "./support/crm";
import { createOrg } from "./support/fixtures";
import { provisionedClient, sharedGateway, type ClientTenant } from "./support/client-business-mcp";

const worker = readFileSync(path.join(process.cwd(), "services", "hermes-provisioner", "worker.py"), "utf8");
const manifestKeys = (): string[] => [...(/REVOKE_MANIFEST_KEYS = \{([^}]*)\}/.exec(worker)?.[1] ?? "").matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]).sort();
const resultKeys = (): string[] => {
  const body = /def _revoke_result\([^]*?(?=\n    def )/.exec(worker)?.[0] ?? "";
  return [...body.matchAll(/^\s+"([A-Za-z]+)":/gm)].map((m) => m[1]).sort();
};

let gateway: { id: string; baseUrl: string };
let superAdmin: { id: string };
let counter = 0;

const rows = async <T>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;
const one = async <T>(sql: string, params: unknown[] = []) => (await rows<T>(sql, params))[0];
const stub = (switchOn: boolean) => {
  vi.stubEnv("HERMES_PROVISIONER_GATEWAY_ID", gateway.id);
  vi.stubEnv("HERMES_PROVISIONER_DEPROVISION_ENABLED", switchOn ? "true" : "false");
  resetEnvCache();
};

/** A client with six provisioned employees, each with a profile, a Hermes credential and a business-tool credential. */
async function tenant(): Promise<ClientTenant> {
  counter += 1;
  return provisionedClient({ name: `Containment Client ${counter}`, timezone: "America/Chicago", tag: `Contained${counter}`, phone: `+1312555${String(2000 + counter)}`, crm: false });
}
const ask = (t: ClientTenant, role: AgentRoleKey, reason = "The client left and its AI team must stop working.") =>
  withSystem((db) => requestDeprovision(db, { orgId: t.org.id, agentId: t.agents[role], actorUserId: superAdmin.id, reason }));
const jobsOf = (t: ClientTenant, role: AgentRoleKey) => rows<{ id: string; kind: string; status: string; requested_by: string | null; attempt_count: number; detail: string | null; next_retry_at: Date | null }>(
  "select id, kind, status, requested_by, attempt_count, detail, next_retry_at from agent_provisioning_jobs where agent_instance_id = $1 order by created_at", [t.agents[role]]);
const auditOf = (orgId: string, action: string) => rows<{ metadata: Record<string, unknown>; agent_instance_id: string | null }>("select metadata, agent_instance_id from audit_logs where org_id = $1 and action = $2 order by created_at", [orgId, action]);

type Claimed = NonNullable<Awaited<ReturnType<typeof claimHermesProvisionerWork>>>;
async function claim(): Promise<Claimed> {
  const job = await claimHermesProvisionerWork(gateway.id);
  if (!job) throw new Error("no job was claimed");
  return job;
}
/** What the Python worker sends back after a proven containment, built from the keys its own code uses. */
function workerResult(job: Claimed, over: Record<string, unknown> = {}, retiredAt = Math.floor(Date.now() / 1000)) {
  const values: Record<string, unknown> = {
    ok: true, jobId: job.jobId, leaseToken: job.leaseToken, gatewayId: job.gatewayId, kind: "deprovision", orgId: job.orgId, agentId: job.agentId, profile: job.profile,
    revoked: true, oldKeyRejected: true, toolsetsEmpty: true, retiredAt, hermesVersion: "hermes v0.21.5-test",
  };
  const body = Object.fromEntries(resultKeys().map((key) => [key, values[key]]));
  expect(Object.values(body).every((v) => v !== undefined), "the worker sends a key the portal does not know").toBe(true);
  return { ...body, ...over };
}

beforeAll(async () => {
  gateway = await sharedGateway();
  superAdmin = (await agencyPeople()).superAdmin;
});
beforeEach(() => stub(false));
afterEach(async () => {
  vi.unstubAllEnvs();
  resetEnvCache();
  // A job left open by one test must never be picked up by the next one.
  await withSystem((db) => db.query("update agent_provisioning_jobs set status = 'cancelled', lease_token = null, lease_expires_at = null where status in ('requested', 'in_progress', 'failed', 'awaiting_health_check')"));
});

describe("the worker and the portal agree on the contract", () => {
  it("finds the worker's key names (so the checks below are not vacuous)", () => {
    expect(manifestKeys()).toEqual(["agentId", "expiresAt", "gatewayId", "jobId", "kind", "leaseToken", "orgId", "profile"]);
    expect(resultKeys()).toEqual(["agentId", "gatewayId", "hermesVersion", "jobId", "kind", "leaseToken", "ok", "oldKeyRejected", "orgId", "profile", "retiredAt", "revoked", "toolsetsEmpty"]);
  });
});

describe("asking for containment", () => {
  it("writes one job and one audit row for the person who asked, and a repeat returns the same open job", async () => {
    const t = await tenant();
    const first = await ask(t, "lead_hunter");
    expect(first).toMatchObject({ alreadyOpen: false, replaced: 0 });
    const job = (await jobsOf(t, "lead_hunter"))[0];
    expect(job).toMatchObject({ id: first.jobId, kind: "deprovision", status: "requested", requested_by: superAdmin.id });
    const audit = await auditOf(t.org.id, "agent.profile_deprovision_requested");
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({ jobId: first.jobId, reason: "The client left and its AI team must stop working.", gatewayId: gateway.id });
    const again = await ask(t, "lead_hunter");
    expect(again).toMatchObject({ jobId: first.jobId, alreadyOpen: true, replaced: 0 });
    expect(await jobsOf(t, "lead_hunter")).toHaveLength(1);
    expect(await auditOf(t.org.id, "agent.profile_deprovision_requested")).toHaveLength(1);
    // The employee itself is untouched until the worker proves the containment.
    expect(await one<{ hermes_profile: string | null }>("select hermes_profile from agent_instances where id = $1", [t.agents.lead_hunter])).toMatchObject({ hermes_profile: expect.stringMatching(/^c-/) });
  });

  it("replaces a setup or synchronization request that is still open", async () => {
    const t = await tenant();
    await withSystem((db) => db.query("insert into agent_provisioning_jobs (org_id, agent_instance_id, kind, status) values ($1, $2, 'sync', 'requested')", [t.org.id, t.agents.crm_manager]));
    const result = await ask(t, "crm_manager");
    expect(result.replaced).toBe(1);
    const jobs = await jobsOf(t, "crm_manager");
    expect(jobs.map((j) => [j.kind, j.status])).toEqual([["sync", "cancelled"], ["deprovision", "requested"]]);
  });

  it("refuses with a plain reason and writes nothing: a short reason, a stranger, an unknown employee, no profile, an internal-tier profile, another gateway", async () => {
    const t = await tenant();
    const writes = async () => (await jobsOf(t, "sales_assistant")).length + (await auditOf(t.org.id, "agent.profile_deprovision_requested")).length;
    const run = (over: Partial<{ orgId: string; agentId: string; actorUserId: string; reason: string }>) =>
      withSystem((db) => requestDeprovision(db, { orgId: t.org.id, agentId: t.agents.sales_assistant, actorUserId: superAdmin.id, reason: "A proper reason for this.", ...over }));
    await expect(run({ reason: "no" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(run({ actorUserId: t.owner.id })).rejects.toMatchObject({ code: "forbidden" });
    await expect(run({ agentId: "00000000-0000-4000-8000-000000000000" })).rejects.toMatchObject({ code: "not_found" });
    // The database itself will not map an internal-tier profile onto a client's employee, so there is no such employee to contain; that is the first of two guards (the second is in requestDeprovision).
    await expect(withSystem((db) => db.query("update agent_instances set hermes_profile = 'iacquire-sales-assistant' where id = $1", [t.agents.sales_assistant]))).rejects.toThrow(/reserved_hermes_profile/);
    await withSystem((db) => db.query("update agent_instances set hermes_profile = null, hermes_gateway_id = null where id = $1", [t.agents.sales_assistant]));
    await expect(run({})).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/no client runtime profile/) });
    const other = await withSystem(async (db) => {
      const id = crypto.randomUUID();
      const baseUrl = `https://other-${id.slice(0, 8)}.hermes.test`;
      await db.query("insert into hermes_gateways (id, label, environment, base_url, gateway_type, status, profile_creation_status) values ($1, 'Another', 'development', $2, 'multiplexed_profiles', 'connected', 'restricted_service_verified')", [id, baseUrl]);
      return { id, baseUrl };
    });
    await withSystem((db) => db.query("update agent_instances set hermes_base_url = $2, hermes_profile = $3, hermes_gateway_id = $4 where id = $1", [t.agents.sales_assistant, other.baseUrl, suggestedProfileName(t.slug, "sales_assistant"), other.id]));
    await expect(run({})).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/not on the client runtime/) });
    expect(await writes()).toBe(0);
  });

  it("never acts on a demo workspace or on the agency's own employees, and writes nothing", async () => {
    const demo = await tenant();
    await withSystem((db) => db.query("update organizations set is_demo = true where id = $1", [demo.org.id]));
    await expect(ask(demo, "lead_hunter")).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/never an agency's or a demo's/) });
    expect(await jobsOf(demo, "lead_hunter")).toHaveLength(0);
    const found = await rows<{ id: string }>("select id from organizations where kind = 'agency' limit 1");
    const agencyId = found[0]?.id ?? (await createOrg({ name: "Agency Containment Test", kind: "agency" })).id;
    const employee = (await rows<{ id: string }>("select id from agent_instances where org_id = $1 limit 1", [agencyId]))[0];
    expect(employee, "the agency workspace has employees").toBeTruthy();
    await withSystem((db) => db.query("update agent_instances set hermes_profile = 'iacquire-test-profile' where id = $1", [employee.id]));
    await expect(withSystem((db) => requestDeprovision(db, { orgId: agencyId, agentId: employee.id, actorUserId: superAdmin.id, reason: "Trying the agency's own employee." }))).rejects.toMatchObject({ code: "conflict" });
    expect(await rows("select 1 from agent_provisioning_jobs where agent_instance_id = $1", [employee.id])).toHaveLength(0);
    await withSystem((db) => db.query("update agent_instances set hermes_profile = null where id = $1", [employee.id]));
  });
});

describe("handing the job to the worker", () => {
  it("is never done while the deployment switch is off, and a setup claim is not disturbed", async () => {
    const t = await tenant();
    await ask(t, "lead_hunter");
    expect(await claimHermesProvisionerWork(gateway.id)).toBeNull();
    expect(await claimHermesProvisionerJob(gateway.id)).toBeNull();
    expect((await jobsOf(t, "lead_hunter"))[0]).toMatchObject({ status: "requested", attempt_count: 0 });
  });

  it("with the switch on, hands out exactly the eight facts the worker expects and nothing else", async () => {
    stub(true);
    const t = await tenant();
    const asked = await ask(t, "lead_hunter");
    const job = await claim();
    expect(Object.keys(job).sort()).toEqual(manifestKeys());
    expect(job).toMatchObject({ jobId: asked.jobId, kind: "deprovision", orgId: t.org.id, agentId: t.agents.lead_hunter, gatewayId: gateway.id });
    expect(job.profile).toMatch(/^c-/);
    expect(JSON.stringify(job)).not.toMatch(/soul|configYaml|apiKey|secret/i);
    expect((await jobsOf(t, "lead_hunter"))[0]).toMatchObject({ status: "in_progress", attempt_count: 1 });
    const started = await auditOf(t.org.id, "agent.profile_provisioning_started");
    expect(started.at(-1)?.metadata).toMatchObject({ jobId: asked.jobId, kind: "deprovision", attempt: 1 });
    // A second claim has nothing to hand out while the lease is held.
    expect(await claimHermesProvisionerWork(gateway.id)).toBeNull();
  });

  it("does not claim for a demo workspace, an unverified gateway, or a job out of attempts", async () => {
    stub(true);
    const t = await tenant();
    await ask(t, "lead_hunter");
    await withSystem((db) => db.query("update organizations set is_demo = true where id = $1", [t.org.id]));
    expect(await claimHermesProvisionerWork(gateway.id)).toBeNull();
    await withSystem((db) => db.query("update organizations set is_demo = false where id = $1", [t.org.id]));
    await withSystem((db) => db.query("update hermes_gateways set provisioner_isolation_verified_at = null where id = $1", [gateway.id]));
    try {
      expect(await claimHermesProvisionerWork(gateway.id)).toBeNull();
    } finally {
      await withSystem((db) => db.query("update hermes_gateways set provisioner_isolation_verified_at = now() where id = $1", [gateway.id]));
    }
    await withSystem((db) => db.query("update agent_provisioning_jobs set attempt_count = 3 where agent_instance_id = $1", [t.agents.lead_hunter]));
    expect(await claimHermesProvisionerWork(gateway.id)).toBeNull();
  });

  it("claims a containment job even when the client has been suspended, the employee switched off and the payment refunded: those are reasons to hurry", async () => {
    stub(true);
    const t = await tenant();
    await ask(t, "crm_manager");
    await withSystem(async (db) => {
      await db.query("update organizations set status = 'suspended' where id = $1", [t.org.id]);
      await db.query("update agent_instances set enabled = false where id = $1", [t.agents.crm_manager]);
      await db.query("update billing_accounts set setup_payment_status = 'refunded' where org_id = $1", [t.org.id]);
    });
    expect(await claim()).toMatchObject({ agentId: t.agents.crm_manager });
  });
});

describe("completing a containment", () => {
  it("revokes exactly that employee's credentials, clears its profile, and says it is not set up", async () => {
    stub(true);
    const t = await tenant();
    const before = await one<{ credential_id: string }>("select credential_id from agent_instances where id = $1", [t.agents.lead_hunter]);
    const sibling = await one<{ credential_id: string; hermes_profile: string }>("select credential_id, hermes_profile from agent_instances where id = $1", [t.agents.sales_assistant]);
    await ask(t, "lead_hunter");
    const job = await claim();
    const retiredAt = Math.floor(Date.now() / 1000);
    await expect(completeHermesProvisionerJob(workerResult(job, {}, retiredAt), gateway.id)).resolves.toMatchObject({ accepted: true, duplicate: false, contained: true });

    const agent = await one<Record<string, unknown>>("select hermes_profile, hermes_gateway_id, credential_id, hermes_base_url, hermes_profile_config_version_id, status, last_health_ok, tool_inventory_digest from agent_instances where id = $1", [t.agents.lead_hunter]);
    expect(agent).toMatchObject({ hermes_profile: null, hermes_gateway_id: null, credential_id: null, hermes_base_url: null, hermes_profile_config_version_id: null, status: "setup_required", last_health_ok: null, tool_inventory_digest: null });
    const credential = await one<{ revoked_at: Date | null; credential_reference_id: string }>("select revoked_at, credential_reference_id from integration_credentials where id = $1", [before.credential_id]);
    expect(credential.revoked_at).not.toBeNull();
    expect((await one<{ revoked_at: Date | null }>("select revoked_at from credential_references where id = $1", [credential.credential_reference_id])).revoked_at).not.toBeNull();
    expect(await rows<{ status: string; revoked_reason: string }>("select status, revoked_reason from agent_business_credentials where agent_instance_id = $1", [t.agents.lead_hunter])).toEqual([{ status: "revoked", revoked_reason: "profile_contained" }]);
    expect(await one<{ status: string; result_reference: string }>("select status, result_reference from agent_provisioning_jobs where id = $1", [job.jobId])).toMatchObject({ status: "succeeded", result_reference: `deprovisioned:v1:${job.jobId}:${retiredAt}` });
    // Exactly one employee: its siblings and every other workspace still hold their profiles and live credentials.
    expect(await one("select hermes_profile, credential_id from agent_instances where id = $1", [t.agents.sales_assistant])).toMatchObject(sibling);
    expect((await one<{ revoked_at: Date | null }>("select revoked_at from integration_credentials where id = $1", [sibling.credential_id])).revoked_at).toBeNull();
    expect(await rows("select 1 from agent_business_credentials where agent_instance_id = $1 and status <> 'revoked'", [t.agents.sales_assistant])).toHaveLength(1);
    const done = await auditOf(t.org.id, "agent.profile_deprovisioned");
    expect(done).toHaveLength(1);
    expect(done[0].metadata).toMatchObject({ gatewayId: gateway.id, retiredAt, oldKeyRejected: true, toolsetsEmpty: true, hermesAccessRevoked: true, businessToolAccessEnded: 1 });
    expect(JSON.stringify(done[0].metadata)).not.toMatch(/secret|token|apiKey|[0-9a-f]{32,}/i);
    expect(await auditOf(t.org.id, "credential.revoked")).toHaveLength(1);
  });

  it("reads disabled afterwards when the employee was already switched off", async () => {
    stub(true);
    const t = await tenant();
    await ask(t, "performance_analyst");
    await withSystem((db) => db.query("update agent_instances set enabled = false, status = 'disabled' where id = $1", [t.agents.performance_analyst]));
    await completeHermesProvisionerJob(workerResult(await claim()), gateway.id);
    expect((await one<{ status: string }>("select status from agent_instances where id = $1", [t.agents.performance_analyst])).status).toBe("disabled");
  });

  it("accepts a replay of the same result as a duplicate and refuses a different one", async () => {
    stub(true);
    const t = await tenant();
    await ask(t, "lead_hunter");
    const job = await claim();
    const retiredAt = 1_790_000_000;
    await completeHermesProvisionerJob(workerResult(job, {}, retiredAt), gateway.id);
    await expect(completeHermesProvisionerJob(workerResult(job, {}, retiredAt), gateway.id)).resolves.toMatchObject({ accepted: true, duplicate: true, awaitingHealthCheck: false });
    await expect(completeHermesProvisionerJob(workerResult(job, {}, retiredAt + 1), gateway.id)).rejects.toMatchObject({ code: "conflict" });
    expect(await auditOf(t.org.id, "agent.profile_deprovisioned")).toHaveLength(1);
  });

  it("refuses a result whose lease is not the current one, and changes nothing", async () => {
    stub(true);
    const t = await tenant();
    await ask(t, "lead_hunter");
    const job = await claim();
    await expect(completeHermesProvisionerJob(workerResult(job, { leaseToken: crypto.randomUUID() }), gateway.id)).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/lease is no longer current/) });
    await withSystem((db) => db.query("update agent_provisioning_jobs set lease_expires_at = now() - interval '1 minute' where id = $1", [job.jobId]));
    await expect(completeHermesProvisionerJob(workerResult(job), gateway.id)).rejects.toMatchObject({ code: "conflict" });
    expect((await one<{ hermes_profile: string | null }>("select hermes_profile from agent_instances where id = $1", [t.agents.lead_hunter])).hermes_profile).toMatch(/^c-/);
  });

  it("fails the job and changes nothing when the result names another profile, workspace or employee", async () => {
    stub(true);
    const t = await tenant();
    const other = await tenant();
    await ask(t, "lead_hunter");
    const job = await claim();
    await expect(completeHermesProvisionerJob(workerResult(job, { profile: "c-someone-else-0123456789ab-lead-hunter" }), gateway.id)).resolves.toMatchObject({ failed: true });
    expect((await jobsOf(t, "lead_hunter"))[0]).toMatchObject({ status: "failed", detail: expect.stringContaining("identity_mismatch") });
    expect((await one<{ hermes_profile: string | null }>("select hermes_profile from agent_instances where id = $1", [t.agents.lead_hunter])).hermes_profile).toMatch(/^c-/);
    expect(await auditOf(t.org.id, "agent.profile_deprovisioned")).toHaveLength(0);
    // And a result that points at somebody else's workspace is refused outright.
    await ask(other, "lead_hunter");
    const otherJob = await claim();
    await expect(completeHermesProvisionerJob(workerResult(otherJob, { orgId: t.org.id }), gateway.id)).resolves.toMatchObject({ failed: true });
    expect((await one<{ hermes_profile: string | null }>("select hermes_profile from agent_instances where id = $1", [other.agents.lead_hunter])).hermes_profile).toMatch(/^c-/);
  });

  it("accepts nothing that is not exactly the worker's contract", async () => {
    stub(true);
    const t = await tenant();
    await ask(t, "lead_hunter");
    const job = await claim();
    for (const bad of [
      workerResult(job, { apiKey: "a".repeat(64) }),
      workerResult(job, { oldKeyRejected: false }),
      workerResult(job, { toolsetsEmpty: false }),
      workerResult(job, { revoked: false }),
      workerResult(job, { kind: "sync" }),
      workerResult(job, { retiredAt: "yesterday" }),
      workerResult(job, { gatewayId: crypto.randomUUID() }),
    ]) {
      await expect(completeHermesProvisionerJob(bad, gateway.id)).rejects.toThrow();
    }
    expect((await one<{ hermes_profile: string | null }>("select hermes_profile from agent_instances where id = $1", [t.agents.lead_hunter])).hermes_profile).toMatch(/^c-/);
    expect((await jobsOf(t, "lead_hunter"))[0].status).toBe("in_progress");
  });

  it("records a reported failure with a safe code: a slow gateway is retried later and a tool that stays on is not", async () => {
    stub(true);
    const t = await tenant();
    await ask(t, "lead_hunter");
    let job = await claim();
    await completeHermesProvisionerJob({ ok: false, jobId: job.jobId, leaseToken: job.leaseToken, gatewayId: gateway.id, code: "revoke_not_applied" }, gateway.id);
    let current = (await jobsOf(t, "lead_hunter"))[0];
    expect(current).toMatchObject({ status: "failed", attempt_count: 0, detail: expect.stringContaining("revoke_not_applied") });
    expect(current.next_retry_at).not.toBeNull();
    await withSystem((db) => db.query("update agent_provisioning_jobs set next_retry_at = now() - interval '1 second' where id = $1", [job.jobId]));
    job = await claim();
    await completeHermesProvisionerJob({ ok: false, jobId: job.jobId, leaseToken: job.leaseToken, gatewayId: gateway.id, code: "revoke_tool_isolation_failed" }, gateway.id);
    current = (await jobsOf(t, "lead_hunter"))[0];
    expect(current).toMatchObject({ status: "failed", attempt_count: 1, detail: expect.stringContaining("revoke_tool_isolation_failed") });
    // Whatever else a worker says is stored only as the single unclassified code, never repeated.
    await withSystem((db) => db.query("update agent_provisioning_jobs set next_retry_at = now() - interval '1 second' where id = $1", [job.jobId]));
    job = await claim();
    await completeHermesProvisionerJob({ ok: false, jobId: job.jobId, leaseToken: job.leaseToken, gatewayId: gateway.id, code: "the key was ABC-SECRET-123" }, gateway.id);
    expect((await jobsOf(t, "lead_hunter"))[0].detail).not.toContain("ABC-SECRET-123");
  });
});
