import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRoleKey } from "@/lib/agents";
import { agentSettingsSchema } from "@/lib/agent-settings";
import { defaultSettings } from "@/server/workforce/compiler";
import { resetEnvCache } from "@/server/env";
import { withSystem } from "@/server/db";
import { claimHermesProvisionerJob, completeHermesProvisionerJob } from "@/server/workforce/hermes-provisioner";
import { requestProvisioning } from "@/server/workforce/provisioning";
import { createConfigVersion } from "@/server/workforce/service";
import { addMember, createOrg, createUser } from "./support/fixtures";
import { clearSetupPayment } from "./support/billing";

type Manifest = NonNullable<Awaited<ReturnType<typeof claimHermesProvisionerJob>>>;

let gatewayId = randomUUID();

beforeEach(async () => {
  gatewayId = randomUUID();
  vi.stubEnv("HERMES_PROVISIONER_GATEWAY_ID", gatewayId);
  resetEnvCache();
  // Every test starts from an empty queue: a job left open by an earlier test would be claimed by this test's gateway.
  await withSystem(async (db) => {
    await db.query("delete from agent_provisioning_jobs");
    await db.query(
      "insert into hermes_gateways (id,label,environment,base_url,gateway_type,status,profile_creation_status,provisioner_isolation_verified_at) " +
      "values ($1,'Claim gate test runtime','development',$2,'multiplexed_profiles','connected','restricted_service_verified',now())",
      [gatewayId, "https://client-" + gatewayId.replaceAll("-", "") + ".hermes.test"],
    );
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

const setMax = (max: number | null) => {
  vi.stubEnv("HERMES_PROVISIONER_MAX_PROFILES", max === null ? "" : String(max));
  resetEnvCache();
};

/** A paid, onboarded client with a verified owner whose first `roles` employees have an approved configuration and a queued provision job. */
async function client(label: string, roles = 6) {
  const org = await createOrg({ name: `${label} ${randomUUID().slice(0, 8)}` });
  await clearSetupPayment(org.id);
  const owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  await withSystem((db) => db.query("update organizations set onboarding_completed_at=now() where id=$1", [org.id]));
  const agents = (await withSystem((db) => db.query<{ id: string; role_key: AgentRoleKey }>("select id,role_key from agent_instances where org_id=$1 order by role_key", [org.id]))).rows;
  const included = agents.slice(0, roles);
  await withSystem(async (db) => {
    for (const agent of included) {
      await createConfigVersion(db, { orgId: org.id, agentId: agent.id, settings: defaultSettings(agent.role_key), source: "onboarding", userId: owner.id, apply: true });
    }
    for (const agent of agents.slice(roles)) await db.query("update agent_instances set enabled=false where id=$1", [agent.id]);
  });
  await withSystem((db) => requestProvisioning(db, org.id, owner.id));
  return { org, owner, agents: included };
}

function result(manifest: Manifest, apiKey?: string) {
  return {
    ok: true, jobId: manifest.jobId, leaseToken: manifest.leaseToken, gatewayId: manifest.gatewayId, kind: manifest.kind, orgId: manifest.orgId, agentId: manifest.agentId,
    profile: manifest.profile, sourceProvisionJobId: manifest.sourceProvisionJobId, configVersionId: manifest.configVersionId, configVersion: manifest.configVersion,
    soulSha256: manifest.soulSha256, soulChallengeSha256: createHash("sha256").update(manifest.soulChallenge).digest("hex"), policyConfigSha256: manifest.policyConfigSha256,
    effectiveConfigSha256: "b".repeat(64), authenticated: true, identityVerified: true, effectiveSoulVerified: true, toolInventoryComplete: true,
    toolInventoryDigest: "c".repeat(64), hermesVersion: "hermes v0.22.5 claim gate test", ...(apiKey ? { apiKey } : {}),
  };
}

/** Claims the next job and finishes it successfully with a key of its own (a sync returns none). Returns null when nothing is claimable. */
async function claimAndFinish() {
  const manifest = await claimHermesProvisionerJob(gatewayId);
  if (!manifest) return null;
  await completeHermesProvisionerJob(result(manifest, manifest.kind === "provision" ? randomBytes(32).toString("hex") : undefined), gatewayId);
  return manifest;
}

const attempts = async (jobId: string) => Number((await withSystem((db) => db.query<{ attempt_count: number }>("select attempt_count from agent_provisioning_jobs where id=$1", [jobId]))).rows[0].attempt_count);
const jobFor = async (agentId: string) => (await withSystem((db) => db.query<{ id: string; attempt_count: number; status: string }>("select id,attempt_count,status from agent_provisioning_jobs where agent_instance_id=$1 order by created_at desc limit 1", [agentId]))).rows[0];
const mapped = async () => Number((await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from agent_instances where hermes_gateway_id=$1 and hermes_profile is not null", [gatewayId]))).rows[0].n);

/** Gives a running employee a new approved version, which queues one synchronization job. */
async function editApproved(c: Awaited<ReturnType<typeof client>>, agentId: string) {
  const row = (await withSystem((db) => db.query<{ settings: unknown }>("select v.settings from agent_instances a join agent_config_versions v on v.id=a.active_config_version_id where a.id=$1", [agentId]))).rows[0];
  const settings = agentSettingsSchema.parse(row.settings);
  const version = await withSystem((db) => createConfigVersion(db, {
    orgId: c.org.id, agentId, settings: { ...settings, tone: settings.tone === "professional" ? "friendly" : "professional" }, source: "client_edit", actorKind: "user", userId: c.owner.id, apply: true,
  }));
  expect(version.status).toBe("applied");
}

describe("the claim holds a provision job while the agency has paused the workspace", () => {
  it("returns nothing under an active agency pause and releases the job, unchanged, when it is lifted", async () => {
    const c = await client("Pause Roofing", 1);
    const jobId = (await jobFor(c.agents[0].id)).id;
    const other = await client("Unpaused Plumbing", 1);
    await withSystem((db) => db.query("insert into automation_pauses (org_id,scope,active) values ($1,'agency',true)", [c.org.id]));

    // Another workspace is not held by this one's pause: its job is the one that comes out.
    const first = await claimHermesProvisionerJob(gatewayId);
    expect(first?.orgId).toBe(other.org.id);
    await completeHermesProvisionerJob(result(first!, randomBytes(32).toString("hex")), gatewayId);
    await expect(claimHermesProvisionerJob(gatewayId)).resolves.toBeNull();
    expect(await attempts(jobId)).toBe(0);
    expect((await jobFor(c.agents[0].id)).status).toBe("requested");

    await withSystem((db) => db.query("update automation_pauses set active=false where org_id=$1 and scope='agency'", [c.org.id]));
    const released = await claimHermesProvisionerJob(gatewayId);
    expect(released).toMatchObject({ jobId, orgId: c.org.id, kind: "provision" });
    expect(await attempts(jobId)).toBe(1);
  });

  it("is held by the platform-wide pause as well, and a synchronization is held with it", async () => {
    const c = await client("Platform Pause Plumbing", 1);
    const platform = await createOrg({ name: "Agency workspace " + randomUUID().slice(0, 6), kind: "agency" });
    await withSystem((db) => db.query("insert into automation_pauses (org_id,scope,active) values ($1,'agency',true)", [platform.id]));
    await expect(claimHermesProvisionerJob(gatewayId)).resolves.toBeNull();
    await withSystem((db) => db.query("update automation_pauses set active=false where org_id=$1", [platform.id]));
    expect((await claimAndFinish())?.kind).toBe("provision");

    await editApproved(c, c.agents[0].id);
    await withSystem((db) => db.query("insert into automation_pauses (org_id,scope,active) values ($1,'agency',true)", [c.org.id]));
    await expect(claimHermesProvisionerJob(gatewayId)).resolves.toBeNull();
    await withSystem((db) => db.query("update automation_pauses set active=false where org_id=$1", [c.org.id]));
    expect((await claimHermesProvisionerJob(gatewayId))?.kind).toBe("sync");
  });
});

describe("the claim asks again whether the setup payment is cleared", () => {
  it("does not claim a provision job after a refund, claims it again once cleared, and still syncs a running client", async () => {
    const running = await client("Running Roofing", 1);
    const waiting = await client("Refunded Plumbing", 1);
    expect((await claimAndFinish())?.orgId).toBe(running.org.id);
    await editApproved(running, running.agents[0].id);

    await withSystem((db) => db.query("update billing_accounts set setup_payment_status='refunded' where org_id=$1 or org_id=$2", [running.org.id, waiting.org.id]));
    // The refund lands after the request: the waiting client's profile is not created, the running client's synchronization still is.
    const sync = await claimHermesProvisionerJob(gatewayId);
    expect(sync).toMatchObject({ kind: "sync", orgId: running.org.id });
    await completeHermesProvisionerJob(result(sync!), gatewayId);
    await expect(claimHermesProvisionerJob(gatewayId)).resolves.toBeNull();
    const held = await jobFor(waiting.agents[0].id);
    expect(held).toMatchObject({ status: "requested", attempt_count: 0 });

    await clearSetupPayment(waiting.org.id, "Payment recorded again after the refund was reversed");
    const released = await claimHermesProvisionerJob(gatewayId);
    expect(released).toMatchObject({ jobId: held.id, orgId: waiting.org.id, kind: "provision" });
  });
});

describe("HERMES_PROVISIONER_MAX_PROFILES", () => {
  it("changes nothing while unset", async () => {
    await client("Unlimited A", 6);
    await client("Unlimited B", 6);
    let claimed = 0;
    while (await claimAndFinish()) claimed += 1;
    expect(claimed).toBe(12);
    expect(await mapped()).toBe(12);
  });

  it("admits a client's whole team or none of it, keeps a started team going, and lets a synchronization through", async () => {
    setMax(5);
    const a = await client("Capacity A", 5);
    const b = await client("Capacity B", 5);
    const admin = await createUser({ platformRole: "agency_super_admin" });

    // A fits exactly; its five profiles are created one after the other.
    for (let i = 0; i < 5; i += 1) expect((await claimAndFinish())?.orgId).toBe(a.org.id);
    expect(await mapped()).toBe(5);
    // B would be the sixth profile: it waits as a whole, nothing of it is claimed, nothing is failed.
    for (let i = 0; i < 3; i += 1) await expect(claimHermesProvisionerJob(gatewayId)).resolves.toBeNull();
    for (const agent of b.agents) expect(await jobFor(agent.id)).toMatchObject({ status: "requested", attempt_count: 0 });

    // A synchronization adds no profile, so it runs at the ceiling.
    await editApproved(a, a.agents[0].id);
    const sync = await claimHermesProvisionerJob(gatewayId);
    expect(sync).toMatchObject({ kind: "sync", orgId: a.org.id });
    await completeHermesProvisionerJob(result(sync!), gatewayId);

    // One deduplicated notice for the agency, however many claims found the queue held; it names the setting and carries no tenant data.
    const notices = await withSystem((db) => db.query<{ title: string; body: string }>("select title,body from notifications where user_id=$1 and dedupe_key like 'provisioner-capacity:%'", [admin.id]));
    expect(notices.rows).toHaveLength(1);
    expect(notices.rows[0].body).toContain("HERMES_PROVISIONER_MAX_PROFILES");
    expect(notices.rows[0].body).not.toContain(b.org.name);

    // Raising the limit releases B's team.
    setMax(10);
    for (let i = 0; i < 5; i += 1) expect((await claimAndFinish())?.orgId).toBe(b.org.id);
    expect(await mapped()).toBe(10);
  });

  it("never admits half a team: a client that does not fit waits while a smaller one that does is admitted", async () => {
    setMax(7);
    const first = await client("Fits First", 5);
    const tooBig = await client("Does Not Fit", 5);
    const small = await client("Fits Small", 2);
    for (let i = 0; i < 5; i += 1) expect((await claimAndFinish())?.orgId).toBe(first.org.id);
    // 5 held + 5 for the second client is 10 > 7, so it is skipped as a whole; 5 + 2 = 7 fits the third.
    for (let i = 0; i < 2; i += 1) expect((await claimAndFinish())?.orgId).toBe(small.org.id);
    await expect(claimHermesProvisionerJob(gatewayId)).resolves.toBeNull();
    for (const agent of tooBig.agents) expect((await jobFor(agent.id)).status).toBe("requested");
    expect(await mapped()).toBe(7);
  });

  it("holds a client whose whole team is larger than the limit, however low the limit is set", async () => {
    setMax(5);
    const six = await client("Six Roles", 6);
    await expect(claimHermesProvisionerJob(gatewayId)).resolves.toBeNull();
    for (const agent of six.agents) expect(await attempts((await jobFor(agent.id)).id)).toBe(0);
    setMax(6);
    expect((await claimAndFinish())?.orgId).toBe(six.org.id);
    // Once it has begun it keeps going with the same limit.
    for (let i = 0; i < 5; i += 1) expect((await claimAndFinish())?.orgId).toBe(six.org.id);
    expect(await mapped()).toBe(6);
  });
});
