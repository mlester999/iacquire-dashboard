// How the client business tool credential gets into a profile, from the portal's side. A SYNCHRONIZATION in the tier is handed an id the portal allocated (no secret) and the role's reviewed
// tool names; a first provision never is (an id belongs to an employee's existing profile). The restricted worker generates the credential on its own host and reports only the sha256 of
// its secret; the portal completes the id it allocated from that hash alone, refuses a hash for an id that is no longer waiting, and accepts a replay only with the same hash. The worker's
// own key names are read from services/hermes-provisioner/worker.py, so the two sides cannot drift apart without this failing. Synthetic workspaces and gateway; no Hermes, no provider.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { saveProvisionedHermesCredential } from "@/server/security/credentials";
import { claimHermesProvisionerJob, completeHermesProvisionerJob } from "@/server/workforce/hermes-provisioner";
import { formatClientCredential, verifyClientCredential } from "@/server/workforce/hermes-client-business-credential";
import { CLIENT_BUSINESS_TOOLS_FEATURE, clientBusinessMcpRuntimeNamesForRole } from "@/server/workforce/hermes-client-business-mcp-policy";
import { requestBusinessToolSync, requestProvisioning } from "@/server/workforce/provisioning";
import { suggestedProfileName } from "@/server/workforce/service";
import { addMember, agentId, createOrg, createUser, uid } from "./support/fixtures";
import { readyToRequeue } from "./support/requeue";

const worker = readFileSync(path.join(process.cwd(), "services", "hermes-provisioner", "worker.py"), "utf8");
const keysOf = (text: string | undefined) => [...(text ?? "").matchAll(/"([A-Za-z0-9]+)"/g)].map((m) => m[1]);
const afterDef = worker.slice(worker.indexOf("def parse_manifest"));
const REQUIRED_KEYS = keysOf(/required = \{([^}]*)\}/.exec(afterDef)?.[1]).sort();
const OPTIONAL_KEYS = keysOf(/OPTIONAL_MANIFEST_KEYS = \{([^}]*)\}/.exec(worker)?.[1]).sort();

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T>(sql, params))).rows;
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
function flags(tier: boolean) {
  vi.stubEnv("HERMES_PROVISIONER_GATEWAY_ID", gatewayId);
  vi.stubEnv("HERMES_CLIENT_BUSINESS_MCP_ENABLED", tier ? "true" : "false");
  vi.stubEnv("HERMES_CLIENT_BUSINESS_MCP_PROPOSALS_ENABLED", "false");
  resetEnvCache();
}
const setSwitch = (orgId: string, feature: string, on: boolean) => q("insert into org_features (org_id, feature, enabled) values ($1, $2, $3) on conflict (org_id, feature) do update set enabled = $3", [orgId, feature, on]);

let gatewayId = "";
beforeAll(async () => {
  gatewayId = crypto.randomUUID();
  await q(
    `insert into hermes_gateways (id, label, environment, base_url, gateway_type, status, profile_creation_status, provisioner_isolation_verified_at)
     values ($1, 'Synthetic client-only runtime', 'development', $2, 'multiplexed_profiles', 'connected', 'restricted_service_verified', now())`,
    [gatewayId, `https://client-${gatewayId.replaceAll("-", "").slice(0, 16)}.hermes.test`],
  );
});
beforeEach(async () => {
  flags(false);
  await q("delete from agent_provisioning_jobs");
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

interface World {
  org: { id: string; name: string; slug: string };
  owner: { id: string };
  agents: Record<AgentRoleKey, string>;
}

/** A paid, onboarded workspace: the Lead Hunter and the Appointment Setter are provisioned (a c- profile on the verified gateway, a Hermes credential, the provision job that made them); the CRM Manager has an applied configuration and no profile. */
async function world(): Promise<World> {
  const org = await createOrg({ name: `Business delivery ${uid()}` });
  const owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  await q("update users set email_verified_at = now() where id = $1", [owner.id]);
  const agents = {} as Record<AgentRoleKey, string>;
  for (const role of AGENT_ROLE_KEYS) agents[role] = await agentId(org.id, role);
  await readyToRequeue(org, owner.id, [agents.lead_hunter, agents.appointment_setter, agents.crm_manager]);
  for (const role of ["lead_hunter", "appointment_setter"] as const) {
    const profile = suggestedProfileName(org.slug, role);
    await withSystem(async (db) => {
      const credential = await saveProvisionedHermesCredential(db, { orgId: org.id, agentId: agents[role], secret: randomBytes(32).toString("hex"), profile });
      await db.query(
        `update agent_instances set hermes_base_url = $2, hermes_profile = $3, hermes_gateway_id = $4, credential_id = $5, hermes_profile_config_version_id = active_config_version_id,
           status = 'online', last_health_ok = true, last_health_check_at = now() where id = $1`,
        [agents[role], `https://client-${gatewayId.replaceAll("-", "").slice(0, 16)}.hermes.test`, profile, gatewayId, credential.id],
      );
      await db.query("insert into agent_provisioning_jobs (org_id, agent_instance_id, kind, status, result_reference, attempt_count) values ($1, $2, 'provision', 'succeeded', $3, 1)", [org.id, agents[role], `provisioner:v1:${uid()}`]);
    });
  }
  return { org, owner, agents };
}

type Claimed = NonNullable<Awaited<ReturnType<typeof claimHermesProvisionerJob>>>;
async function claim(): Promise<Claimed> {
  const job = await claimHermesProvisionerJob(gatewayId);
  if (!job) throw new Error("no job was claimed");
  return job;
}
/** What the worker sends back after a verified job (its own key names are what the schema accepts). */
function resultOf(job: Claimed, over: Record<string, unknown> = {}) {
  return {
    ok: true, jobId: job.jobId, leaseToken: job.leaseToken, gatewayId: job.gatewayId, kind: job.kind, orgId: job.orgId, agentId: job.agentId, profile: job.profile,
    sourceProvisionJobId: job.sourceProvisionJobId, configVersionId: job.configVersionId, configVersion: job.configVersion, soulSha256: job.soulSha256,
    soulChallengeSha256: sha256(job.soulChallenge), policyConfigSha256: job.policyConfigSha256, effectiveConfigSha256: "b".repeat(64), authenticated: true, identityVerified: true,
    effectiveSoulVerified: true, toolInventoryComplete: true, toolInventoryDigest: "c".repeat(64), hermesVersion: "hermes v0.21.5-test", ...over,
  };
}
const ledger = (id: string) => q<{ status: string; secret_sha256: string | null; profile: string }>("select status, secret_sha256, profile from agent_business_credentials where id = $1", [id]);
/** A fresh credential as the worker would make it: a secret only this test holds, and its hash. */
const newSecret = () => {
  const secret = randomBytes(32).toString("base64url");
  return { secret, hash: sha256(secret) };
};
async function syncInTier(w: World, role: AgentRoleKey = "lead_hunter") {
  flags(true);
  await setSwitch(w.org.id, CLIENT_BUSINESS_TOOLS_FEATURE, true);
  const asked = await withSystem((db) => requestBusinessToolSync(db, w.org.id, [w.agents[role]]));
  expect(asked.queued).toHaveLength(1);
  return claim();
}

describe("the contract's key names are the worker's", () => {
  it("finds them in worker.py (so the checks below are not vacuous)", () => {
    expect(REQUIRED_KEYS).toHaveLength(17);
    expect(OPTIONAL_KEYS).toEqual(["businessCredentialId", "businessTools"]);
  });
});

describe("what the worker is handed", () => {
  it("gives a synchronization in the tier the credential id and the role's reviewed tools, with exactly the keys the worker accepts", async () => {
    const w = await world();
    const job = await syncInTier(w);
    expect(job).toMatchObject({ kind: "sync", agentId: w.agents.lead_hunter });
    expect(Object.keys(job).sort()).toEqual([...REQUIRED_KEYS, ...OPTIONAL_KEYS].sort());
    expect(job.businessTools).toEqual(clientBusinessMcpRuntimeNamesForRole("lead_hunter"));
    expect(job.configYaml).toContain("mcp_servers:");
    // The id is a waiting ledger row that cannot authenticate (it has no hash yet), for this employee's own profile.
    expect(await ledger(job.businessCredentialId as string)).toEqual([{ status: "pending", secret_sha256: null, profile: job.profile }]);
    // No credential value is in the manifest (only the id, and the NAME of the environment variable the worker fills): nothing in the shape of a credential.
    expect(JSON.stringify(job)).not.toContain("iamcpc1.");
  });

  it("hands out the same id again if the job is claimed again, so a retry never leaves two behind", async () => {
    const w = await world();
    const job = await syncInTier(w);
    await q("update agent_provisioning_jobs set lease_expires_at = now() - interval '1 minute' where id = $1", [job.jobId]);
    const again = await claim();
    expect(again.jobId).toBe(job.jobId);
    expect(again.businessCredentialId).toBe(job.businessCredentialId);
    expect(await q("select 1 from agent_business_credentials where agent_instance_id = $1 and status = 'pending'", [w.agents.lead_hunter])).toHaveLength(1);
  });

  it("gives a synchronization with the tier off exactly the keys it always had", async () => {
    const w = await world();
    flags(false);
    await withSystem((db) => requestBusinessToolSync(db, w.org.id, [w.agents.lead_hunter]));
    const job = await claim();
    expect(Object.keys(job).sort()).toEqual(REQUIRED_KEYS);
    expect(job.configYaml).not.toContain("mcp_servers");
  });

  it("never gives a first provision the tier, even for a workspace that is in it", async () => {
    const w = await world();
    flags(true);
    await setSwitch(w.org.id, CLIENT_BUSINESS_TOOLS_FEATURE, true);
    await withSystem((db) => requestProvisioning(db, w.org.id, w.owner.id));
    const job = await claim();
    expect(job.kind).toBe("provision");
    expect(Object.keys(job).sort()).toEqual(REQUIRED_KEYS);
    expect(job.configYaml).not.toContain("mcp_servers");
    expect(job.configYaml).toContain("no_mcp");
    expect(await q("select 1 from agent_business_credentials where org_id = $1 and status = 'pending'", [w.org.id])).toHaveLength(0);
  });
});

describe("what the portal does with the worker's result", () => {
  it("completes the allocated id from the hash alone, never learns the secret, and accepts a replay only with the same hash", async () => {
    const w = await world();
    const job = await syncInTier(w);
    const { secret, hash } = newSecret();
    await expect(completeHermesProvisionerJob(resultOf(job, { businessCredentialSha256: hash }), gatewayId)).resolves.toMatchObject({ accepted: true, duplicate: false });
    expect(await ledger(job.businessCredentialId as string)).toEqual([{ status: "active", secret_sha256: hash, profile: job.profile }]);
    await expect(completeHermesProvisionerJob(resultOf(job, { businessCredentialSha256: hash }), gatewayId)).resolves.toMatchObject({ accepted: true, duplicate: true });
    await expect(completeHermesProvisionerJob(resultOf(job, { businessCredentialSha256: newSecret().hash }), gatewayId)).rejects.toMatchObject({ code: "conflict" });
    expect(await q("select 1 from agent_business_credentials where agent_instance_id = $1 and status = 'active'", [w.agents.lead_hunter])).toHaveLength(1);
    const everywhere = JSON.stringify([
      await q("select metadata from audit_logs where org_id = $1", [w.org.id]),
      await q("select detail, result_reference from agent_provisioning_jobs where org_id = $1", [w.org.id]),
    ]);
    expect(everywhere).not.toContain(secret);
  });

  it("makes the token the worker wrote usable exactly when the completion registers its hash, for that employee alone, and never with another secret", async () => {
    const w = await world();
    const job = await syncInTier(w);
    const { secret, hash } = newSecret();
    // The worker reports the sha256 of the secret part of the token it wrote (the third dotted segment), which is what the portal's own verification hashes.
    const token = formatClientCredential(job.businessCredentialId as string, secret);
    expect(token.split(".")[2]).toBe(secret);
    expect(await withSystem((db) => verifyClientCredential(db, token))).toMatchObject({ ok: false });
    await completeHermesProvisionerJob(resultOf(job, { businessCredentialSha256: hash }), gatewayId);
    expect(await withSystem((db) => verifyClientCredential(db, token))).toMatchObject({
      ok: true, claims: { credentialId: job.businessCredentialId, orgId: w.org.id, agentId: w.agents.lead_hunter, role: "lead_hunter", profile: job.profile, status: "active" },
    });
    expect(await withSystem((db) => verifyClientCredential(db, formatClientCredential(job.businessCredentialId as string, newSecret().secret)))).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("moves the employee's earlier credential aside for the overlap, so the profile can be re-keyed without a gap", async () => {
    const w = await world();
    const first = await syncInTier(w);
    await completeHermesProvisionerJob(resultOf(first, { businessCredentialSha256: newSecret().hash }), gatewayId);
    await q("update agent_provisioning_jobs set status = 'succeeded' where org_id = $1", [w.org.id]);
    const second = await syncInTier(w);
    expect(second.businessCredentialId).not.toBe(first.businessCredentialId);
    await completeHermesProvisionerJob(resultOf(second, { businessCredentialSha256: newSecret().hash }), gatewayId);
    expect((await ledger(first.businessCredentialId as string))[0].status).toBe("rotating_out");
    expect((await ledger(second.businessCredentialId as string))[0].status).toBe("active");
  });

  it("fails the job and registers nothing when the id it was given is no longer waiting", async () => {
    const w = await world();
    const job = await syncInTier(w);
    await q("update agent_business_credentials set status = 'revoked', revoked_at = now(), revoked_reason = 'test_revoked' where id = $1", [job.businessCredentialId]);
    await expect(completeHermesProvisionerJob(resultOf(job, { businessCredentialSha256: newSecret().hash }), gatewayId)).resolves.toMatchObject({ failed: true });
    expect((await q<{ status: string; detail: string }>("select status, detail from agent_provisioning_jobs where id = $1", [job.jobId]))[0]).toMatchObject({ status: "failed", detail: expect.stringContaining("stale_configuration") });
    expect(await q("select 1 from agent_business_credentials where agent_instance_id = $1 and status = 'active'", [w.agents.lead_hunter])).toHaveLength(0);
  });

  it("refuses a business credential hash on a first provision, and any hash that is not 64 hex characters", async () => {
    const w = await world();
    flags(true);
    await withSystem((db) => requestProvisioning(db, w.org.id, w.owner.id));
    const provision = await claim();
    expect(provision.kind).toBe("provision");
    await expect(completeHermesProvisionerJob(resultOf(provision, { apiKey: "a".repeat(64), businessCredentialSha256: newSecret().hash }), gatewayId)).resolves.toMatchObject({ failed: true });
    expect((await q<{ detail: string }>("select detail from agent_provisioning_jobs where id = $1", [provision.jobId]))[0].detail).toContain("profile_ownership_conflict");
    expect((await q<{ hermes_profile: string | null }>("select hermes_profile from agent_instances where id = $1", [provision.agentId]))[0].hermes_profile).toBeNull();
    const sync = await syncInTier(w);
    for (const bad of ["not-a-hash", "A".repeat(64), "0".repeat(63)]) {
      await expect(completeHermesProvisionerJob(resultOf(sync, { businessCredentialSha256: bad }), gatewayId)).rejects.toMatchObject({ code: "invalid_input" });
    }
  });

  it("accepts a synchronization with the tier off exactly as before, with no credential in it", async () => {
    const w = await world();
    flags(false);
    await withSystem((db) => requestBusinessToolSync(db, w.org.id, [w.agents.lead_hunter]));
    const job = await claim();
    await expect(completeHermesProvisionerJob(resultOf(job), gatewayId)).resolves.toMatchObject({ accepted: true, duplicate: false });
    expect(await q("select 1 from agent_business_credentials where agent_instance_id = $1", [w.agents.lead_hunter])).toHaveLength(0);
  });
});
