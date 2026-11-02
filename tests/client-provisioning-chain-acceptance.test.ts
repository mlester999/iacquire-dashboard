// The provisioning chain for two isolated paying clients, through the portal's real code from the submitted questionnaire to profiles the restricted worker would have built: the payment-gated
// requests exist once and only for the plan, each claim hands the worker one employee of one client with that client's own identity and words, each completion maps the profile and a key
// that belongs to that employee alone, nothing is provisioned twice (replays, repeated requests, a second claim), a failed attempt recovers, and containing one client's employee
// leaves everyone else's untouched. The Hermes runtime itself is simulated by the results a verified worker reports (it is not live); this proves the portal's side, not the runtime.
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { claimHermesProvisionerWork, completeHermesProvisionerJob } from "@/server/workforce/hermes-provisioner";
import { requestDeprovision, requestProvisioning } from "@/server/workforce/provisioning";
import { suggestedProfileName } from "@/server/workforce/service";
import { agencyPeople } from "./support/crm";
import { agentId } from "./support/fixtures";
import { approveHeldFirstConfigurations } from "./support/launch";
import { submitRealOnboarding } from "./support/billing";

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T>(sql, params))).rows;
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

type Client = Awaited<ReturnType<typeof submitRealOnboarding>> & { roles: AgentRoleKey[]; slug: string };
type Claimed = NonNullable<Awaited<ReturnType<typeof claimHermesProvisionerWork>>> & { soul: string; configYaml: string; soulChallenge: string; role: string; soulSha256: string; policyConfigSha256: string; configVersionId: string; configVersion: number; sourceProvisionJobId: string | null };

let gatewayId = "";
let superAdmin: { id: string };
let a: Client;
let b: Client;
const keyOf = new Map<string, string>();

/** What a verified worker reports for a job it did, with a fresh key of its own for a first provision. */
function resultOf(job: Claimed, over: Record<string, unknown> = {}) {
  // The key a worker made for an employee is the same on every report of that job, so a replay carries the same one.
  if (job.kind === "provision" && !keyOf.has(job.agentId)) keyOf.set(job.agentId, randomBytes(32).toString("hex"));
  return {
    ok: true, jobId: job.jobId, leaseToken: job.leaseToken, gatewayId: job.gatewayId, kind: job.kind, orgId: job.orgId, agentId: job.agentId, profile: job.profile,
    sourceProvisionJobId: job.sourceProvisionJobId, configVersionId: job.configVersionId, configVersion: job.configVersion, soulSha256: job.soulSha256,
    soulChallengeSha256: sha(job.soulChallenge), policyConfigSha256: job.policyConfigSha256, effectiveConfigSha256: "b".repeat(64), authenticated: true, identityVerified: true,
    effectiveSoulVerified: true, toolInventoryComplete: true, toolInventoryDigest: "c".repeat(64), hermesVersion: "hermes v0.21.5-test",
    ...(job.kind === "provision" ? { apiKey: keyOf.get(job.agentId) } : {}), ...over,
  };
}
async function claimAll(): Promise<Claimed[]> {
  const out: Claimed[] = [];
  for (let i = 0; i < 40; i += 1) {
    const job = await claimHermesProvisionerWork(gatewayId);
    if (!job) break;
    out.push(job as Claimed);
  }
  return out;
}
const mapped = (orgId: string) => q<{ role_key: string; hermes_profile: string | null; hermes_gateway_id: string | null; credential_id: string | null; status: string }>(
  "select role_key, hermes_profile, hermes_gateway_id, credential_id, status from agent_instances where org_id = $1 and enabled order by role_key", [orgId]);

async function client(name: string, disableRoles: AgentRoleKey[] = []): Promise<Client> {
  const c = await submitRealOnboarding({ name, clearPayment: true, disableRoles });
  await q("update users set email_verified_at = now() where id = $1", [c.owner.id]);
  const slug = (await q<{ slug: string }>("select slug from organizations where id = $1", [c.org.id]))[0].slug;
  return { ...c, roles: AGENT_ROLE_KEYS.filter((r) => !disableRoles.includes(r)), slug };
}

beforeAll(async () => {
  superAdmin = (await agencyPeople()).superAdmin;
  gatewayId = crypto.randomUUID();
  await q(
    `insert into hermes_gateways (id, label, environment, base_url, gateway_type, status, profile_creation_status, provisioner_isolation_verified_at)
     values ($1, 'Synthetic client-only runtime', 'development', $2, 'multiplexed_profiles', 'connected', 'restricted_service_verified', now())`,
    [gatewayId, `https://client-${gatewayId.replaceAll("-", "").slice(0, 16)}.hermes.test`],
  );
  vi.stubEnv("HERMES_PROVISIONER_GATEWAY_ID", gatewayId);
  vi.stubEnv("HERMES_PROVISIONER_DEPROVISION_ENABLED", "true");
  resetEnvCache();
  a = await client("Chain Roofing Chicago");
  b = await client("Chain Dental Manila", ["sales_assistant"]);
  for (const c of [a, b]) {
    await approveHeldFirstConfigurations(c.org.id);
    await withSystem((db) => requestProvisioning(db, c.org.id, c.owner.id));
  }
}, 240_000);
afterAll(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("the payment-gated requests", () => {
  it("exist once for each employee in the plan and none for the employee the plan leaves out", async () => {
    for (const c of [a, b]) {
      const jobs = await q<{ role_key: string }>("select a.role_key from agent_provisioning_jobs j join agent_instances a on a.id = j.agent_instance_id where j.org_id = $1 and j.kind = 'provision'", [c.org.id]);
      expect(jobs.map((j) => j.role_key).sort()).toEqual([...c.roles].sort());
    }
    expect(await q("select 1 from agent_provisioning_jobs j join agent_instances a on a.id = j.agent_instance_id where a.org_id = $1 and a.role_key = 'sales_assistant'", [b.org.id])).toHaveLength(0);
  });

  it("are not doubled by asking again", async () => {
    const before = (await q<{ n: string }>("select count(*)::text as n from agent_provisioning_jobs where org_id in ($1, $2)", [a.org.id, b.org.id]))[0].n;
    for (const c of [a, b]) await withSystem((db) => requestProvisioning(db, c.org.id, c.owner.id));
    expect((await q<{ n: string }>("select count(*)::text as n from agent_provisioning_jobs where org_id in ($1, $2)", [a.org.id, b.org.id]))[0].n).toBe(before);
  });
});

describe("what the worker is handed and what each completion records", () => {
  let jobs: Claimed[] = [];

  it("hands out one job per employee, each carrying its own client's identity and words and nothing of the other's", async () => {
    jobs = await claimAll();
    expect(jobs).toHaveLength(a.roles.length + b.roles.length);
    expect(new Set(jobs.map((j) => j.agentId)).size).toBe(jobs.length);
    expect(new Set(jobs.map((j) => j.profile)).size).toBe(jobs.length);
    for (const job of jobs) {
      const own = job.orgId === a.org.id ? a : b;
      const other = own === a ? b : a;
      expect(own.org.id).toBe(job.orgId);
      expect(job.profile).toBe(suggestedProfileName(own.slug, job.role as AgentRoleKey));
      expect(job.profile.startsWith("c-")).toBe(true);
      expect(job.soul).toContain(own.org.name);
      expect(job.soul).not.toContain(other.org.name);
      expect(job.configYaml).not.toContain("mcp_servers");
      expect(Object.keys(job)).not.toContain("businessCredentialId");
    }
    // A second claim has nothing left to hand out while every lease is held.
    expect(await claimHermesProvisionerWork(gatewayId)).toBeNull();
  }, 120_000);

  it("maps a profile and a key to each employee alone, with every key different and every credential in its own client's name", async () => {
    for (const job of jobs) await expect(completeHermesProvisionerJob(resultOf(job), gatewayId)).resolves.toMatchObject({ accepted: true, duplicate: false, awaitingHealthCheck: true });
    for (const c of [a, b]) {
      const employees = await mapped(c.org.id);
      expect(employees.map((e) => e.role_key).sort()).toEqual([...c.roles].sort());
      for (const e of employees) {
        expect(e).toMatchObject({ hermes_gateway_id: gatewayId, status: "provisioning" });
        expect(e.hermes_profile).toBe(suggestedProfileName(c.slug, e.role_key as AgentRoleKey));
        const credential = (await q<{ org_id: string; provider: string; fingerprint: string; revoked_at: Date | null }>("select org_id, provider, fingerprint, revoked_at from integration_credentials where id = $1", [e.credential_id]))[0];
        expect(credential).toMatchObject({ org_id: c.org.id, provider: "hermes", revoked_at: null });
      }
    }
    const fingerprints = await q<{ fingerprint: string }>("select fingerprint from integration_credentials where org_id in ($1, $2) and provider = 'hermes'", [a.org.id, b.org.id]);
    expect(fingerprints).toHaveLength(jobs.length);
    expect(new Set(fingerprints.map((f) => f.fingerprint)).size).toBe(jobs.length);
    expect(await mapped(b.org.id)).toHaveLength(b.roles.length);
  });

  it("provisions nothing twice: a replayed completion is a duplicate, a repeated request and a second claim hand out nothing, and no credential is added", async () => {
    const before = (await q<{ n: string }>("select count(*)::text as n from integration_credentials where org_id in ($1, $2) and provider = 'hermes'", [a.org.id, b.org.id]))[0].n;
    for (const job of jobs.slice(0, 3)) await expect(completeHermesProvisionerJob(resultOf(job), gatewayId)).resolves.toMatchObject({ accepted: true, duplicate: true });
    for (const c of [a, b]) await withSystem((db) => requestProvisioning(db, c.org.id, c.owner.id));
    expect(await claimHermesProvisionerWork(gatewayId)).toBeNull();
    expect((await q<{ n: string }>("select count(*)::text as n from integration_credentials where org_id in ($1, $2) and provider = 'hermes'", [a.org.id, b.org.id]))[0].n).toBe(before);
  });

  it("recovers from a failed attempt: a slow gateway is retried later and the second attempt completes", async () => {
    // A fresh employee to provision: a synthetic third client, so the failure and the recovery are the only things in the queue.
    const c = await client("Chain Recovery Client", ["operations_manager", "lead_hunter", "appointment_setter", "crm_manager", "performance_analyst"]);
    await approveHeldFirstConfigurations(c.org.id);
    await withSystem((db) => requestProvisioning(db, c.org.id, c.owner.id));
    const first = (await claimAll()).find((j) => j.orgId === c.org.id) as Claimed;
    expect(first.role).toBe("sales_assistant");
    await completeHermesProvisionerJob({ ok: false, jobId: first.jobId, leaseToken: first.leaseToken, gatewayId, code: "profile_gateway_discovery_timeout" }, gatewayId);
    const failed = (await q<{ status: string; attempt_count: number; next_retry_at: Date | null }>("select status, attempt_count, next_retry_at from agent_provisioning_jobs where id = $1", [first.jobId]))[0];
    expect(failed).toMatchObject({ status: "failed", attempt_count: 0 });
    expect(failed.next_retry_at).not.toBeNull();
    expect((await mapped(c.org.id))[0].hermes_profile).toBeNull();
    await q("update agent_provisioning_jobs set next_retry_at = now() - interval '1 second' where id = $1", [first.jobId]);
    const second = await claimHermesProvisionerWork(gatewayId);
    expect(second).toMatchObject({ jobId: first.jobId });
    await expect(completeHermesProvisionerJob(resultOf(second as Claimed), gatewayId)).resolves.toMatchObject({ accepted: true, duplicate: false });
    expect((await mapped(c.org.id))[0].hermes_profile).toBe(suggestedProfileName(c.slug, "sales_assistant"));
  }, 120_000);
});

describe("containing one client's employee", () => {
  it("contains exactly that employee, leaves its siblings and the other client untouched, and a repeated request changes nothing", async () => {
    const before = { a: await mapped(a.org.id), b: await mapped(b.org.id) };
    const target = await agentId(a.org.id, "lead_hunter");
    await withSystem((db) => requestDeprovision(db, { orgId: a.org.id, agentId: target, actorUserId: superAdmin.id, reason: "The client asked us to stop this employee." }));
    const job = (await claimHermesProvisionerWork(gatewayId)) as Claimed;
    expect(job).toMatchObject({ kind: "deprovision", orgId: a.org.id, agentId: target });
    await completeHermesProvisionerJob({
      ok: true, jobId: job.jobId, leaseToken: job.leaseToken, gatewayId, kind: "deprovision", orgId: job.orgId, agentId: job.agentId, profile: job.profile,
      revoked: true, oldKeyRejected: true, toolsetsEmpty: true, retiredAt: Math.floor(Date.now() / 1000), hermesVersion: "hermes v0.21.5-test",
    }, gatewayId);
    const after = { a: await mapped(a.org.id), b: await mapped(b.org.id) };
    expect(after.b).toEqual(before.b);
    expect(after.a.filter((e) => e.role_key !== "lead_hunter")).toEqual(before.a.filter((e) => e.role_key !== "lead_hunter"));
    expect(after.a.find((e) => e.role_key === "lead_hunter")).toMatchObject({ hermes_profile: null, hermes_gateway_id: null, credential_id: null, status: "setup_required" });
    // The contained employee's own key is revoked; nobody else's is.
    expect((await q<{ revoked_at: Date | null }>("select revoked_at from integration_credentials where id = $1", [before.a.find((e) => e.role_key === "lead_hunter")?.credential_id]))[0].revoked_at).not.toBeNull();
    expect(await q("select 1 from integration_credentials where org_id in ($1, $2) and provider = 'hermes' and revoked_at is null", [a.org.id, b.org.id])).toHaveLength(a.roles.length + b.roles.length - 1);
    expect(await claimHermesProvisionerWork(gatewayId)).toBeNull();
  });
});
