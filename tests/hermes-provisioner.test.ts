import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "@/server/workforce/compiler";
import { compileAgentConfig } from "@/server/workforce/compiler";
import { resetEnvCache } from "@/server/env";
import { withSystem } from "@/server/db";
import { claimHermesProvisionerJob, completeHermesProvisionerJob } from "@/server/workforce/hermes-provisioner";
import { createConfigVersion } from "@/server/workforce/service";
import { requestProvisioning } from "@/server/workforce/provisioning";
import { addMember, createOrg, createUser } from "./support/fixtures";
import { clearSetupPayment } from "./support/billing";

// Jobs are not tied to a gateway until they are claimed, so a job an earlier test left claimable would be taken by the next test's claim.
beforeEach(async () => {
  await withSystem((db) => db.query("delete from agent_provisioning_jobs"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

async function clientWithReadyProfile(gatewayId: string, isolationVerified: boolean) {
  const org = await createOrg({ name: "Northwind Test " + randomUUID().slice(0, 8) });
  // Provisioning spends money for the client, so it waits for the setup fee (src/server/billing/clearance.ts). These tests are about the worker, not the fee.
  await clearSetupPayment(org.id);
  const owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  await withSystem(async (db) => {
    await db.query("update organizations set onboarding_completed_at=now() where id=$1", [org.id]);
    await db.query("update users set email_verified_at=now() where id=$1", [owner.id]);
  });
  const agent = await withSystem(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      "select id from agent_instances where org_id=$1 and role_key='lead_hunter'",
      [org.id],
    );
    return rows[0].id;
  });
  const settings = defaultSettings("lead_hunter");
  const compiled = compileAgentConfig({
    role: "lead_hunter",
    settings,
    company: { companyName: org.name, orgKind: "client" },
    version: 1,
    allowedTools: ["web_search"],
  });
  await withSystem(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      "insert into agent_config_versions (org_id,agent_instance_id,version,settings,summary,compiled_instructions,policy_version,source,status,created_by,applied_at) " +
      "values ($1,$2,1,$3::jsonb,$4,$5,$6,'onboarding','applied',$7,now()) returning id",
      [org.id, agent, JSON.stringify(settings), compiled.summary, compiled.instructions, compiled.policyVersion, owner.id],
    );
    await db.query("update agent_instances set active_config_version_id=$2 where id=$1", [agent, rows[0].id]);
    await db.query(
      "insert into hermes_gateways (id,label,environment,base_url,gateway_type,status,profile_creation_status,provisioner_isolation_verified_at) " +
      "values ($1,'Client-only test runtime','development',$2,'multiplexed_profiles','connected','restricted_service_verified',$3) on conflict (id) do nothing",
      [
        gatewayId,
        "https://client-" + gatewayId.replace(/-/g, "") + ".hermes.test",
        isolationVerified ? new Date().toISOString() : null,
      ],
    );
  });
  await withSystem((db) => requestProvisioning(db, org.id, owner.id));
  await withSystem((db) => db.query(
    "delete from agent_provisioning_jobs where org_id=$1 and agent_instance_id<>$2",
    [org.id, agent],
  ));
  return { org, owner, agent, settings };
}

function validResult(manifest: NonNullable<Awaited<ReturnType<typeof claimHermesProvisionerJob>>>, apiKey?: string) {
  return {
    ok: true,
    jobId: manifest.jobId,
    leaseToken: manifest.leaseToken,
    gatewayId: manifest.gatewayId,
    kind: manifest.kind,
    orgId: manifest.orgId,
    agentId: manifest.agentId,
    profile: manifest.profile,
    sourceProvisionJobId: manifest.sourceProvisionJobId,
    configVersionId: manifest.configVersionId,
    configVersion: manifest.configVersion,
    soulSha256: manifest.soulSha256,
    soulChallengeSha256: createHash("sha256").update(manifest.soulChallenge).digest("hex"),
    policyConfigSha256: manifest.policyConfigSha256,
    effectiveConfigSha256: "b".repeat(64),
    authenticated: true,
    identityVerified: true,
    effectiveSoulVerified: true,
    toolInventoryComplete: true,
    toolInventoryDigest: "c".repeat(64),
    hermesVersion: "hermes v0.21.5-test",
    ...(apiKey ? { apiKey } : {}),
  };
}

describe("restricted Hermes provisioner queue", () => {
  it("requires a pinned, isolated client-only gateway before claiming", async () => {
    const gatewayId = randomUUID();
    vi.stubEnv("HERMES_PROVISIONER_GATEWAY_ID", gatewayId);
    resetEnvCache();
    const { org } = await clientWithReadyProfile(gatewayId, false);
    await expect(claimHermesProvisionerJob(gatewayId)).resolves.toBeNull();
    await withSystem((db) => db.query("delete from agent_provisioning_jobs where org_id=$1", [org.id]));
  });

  it("claims one approved version, stores the key once, and accepts a safe callback replay", async () => {
    const gatewayId = randomUUID();
    vi.stubEnv("HERMES_PROVISIONER_GATEWAY_ID", gatewayId);
    resetEnvCache();
    const { agent, org } = await clientWithReadyProfile(gatewayId, true);
    const manifest = await claimHermesProvisionerJob(gatewayId);
    expect(manifest).toMatchObject({ kind: "provision", gatewayId, orgId: org.id, agentId: agent });
    expect(manifest?.profile).toMatch(/^c-/);
    expect(manifest?.soul).toContain(manifest?.soulChallenge);
    const apiKey = "a".repeat(64);
    const completion = validResult(manifest!, apiKey);
    await expect(completeHermesProvisionerJob(completion, gatewayId)).resolves.toEqual({
      accepted: true, duplicate: false, awaitingHealthCheck: true,
    });
    await expect(completeHermesProvisionerJob(completion, gatewayId)).resolves.toEqual({
      accepted: true, duplicate: true, awaitingHealthCheck: true,
    });
    const { rows } = await withSystem((db) => db.query<{
      hermes_profile: string | null;
      hermes_profile_config_version_id: string | null;
      status: string;
      credentials: number;
      job_status: string;
      reference: string | null;
    }>(
      "select a.hermes_profile,a.hermes_profile_config_version_id,a.status," +
      "(select count(*)::int from integration_credentials c where c.org_id=a.org_id and c.provider='hermes') as credentials," +
      "j.status as job_status,j.result_reference as reference " +
      "from agent_instances a join agent_provisioning_jobs j on j.agent_instance_id=a.id " +
      "where a.id=$1 and j.kind='provision'",
      [agent],
    ));
    expect(rows[0]).toMatchObject({
      hermes_profile: manifest!.profile,
      hermes_profile_config_version_id: manifest!.configVersionId,
      status: "provisioning",
      credentials: 1,
      job_status: "awaiting_health_check",
    });
    expect(rows[0].reference).toMatch(/^provisioner:v1:/);
    expect(rows[0].reference!.length).toBeLessThan(300);
  });

  it("queues and verifies a versioned sync for an already provisioned profile", async () => {
    const gatewayId = randomUUID();
    vi.stubEnv("HERMES_PROVISIONER_GATEWAY_ID", gatewayId);
    resetEnvCache();
    const { agent, owner, settings, org } = await clientWithReadyProfile(gatewayId, true);
    const manifest = await claimHermesProvisionerJob(gatewayId);
    expect(manifest).toMatchObject({ orgId: org.id, agentId: agent });
    const apiKey = "d".repeat(64);
    await expect(completeHermesProvisionerJob(validResult(manifest!, apiKey), gatewayId)).resolves.toEqual({
      accepted: true, duplicate: false, awaitingHealthCheck: true,
    });

    const changed = { ...settings, tone: "professional" as const };
    const updatedConfig = await withSystem((db) => createConfigVersion(db, {
      orgId: manifest!.orgId,
      agentId: agent,
      settings: changed,
      source: "client_edit",
      actorKind: "user",
      userId: owner.id,
      apply: true,
    }));
    expect(updatedConfig.status).toBe("applied");
    const sync = await claimHermesProvisionerJob(gatewayId);
    const syncState = await withSystem((db) => db.query(
      "select a.hermes_profile,a.hermes_gateway_id,a.hermes_profile_config_version_id,a.active_config_version_id," +
      "g.profile_creation_status,g.provisioner_isolation_verified_at,j.kind,j.status,j.source_job_id,p.result_reference " +
      "from agent_instances a join organizations o on o.id=a.org_id left join hermes_gateways g on g.id=a.hermes_gateway_id " +
      "left join agent_provisioning_jobs j on j.agent_instance_id=a.id and j.kind='sync' " +
      "left join agent_provisioning_jobs p on p.agent_instance_id=a.id and p.kind='provision' " +
      "where a.id=$1",
      [agent],
    ));
    expect(sync, JSON.stringify(syncState.rows)).toMatchObject({
      kind: "sync",
      profile: manifest!.profile,
      sourceProvisionJobId: manifest!.jobId,
      configVersion: 2,
    });
    await expect(completeHermesProvisionerJob(validResult(sync!), gatewayId)).resolves.toEqual({
      accepted: true, duplicate: false, awaitingHealthCheck: true,
    });
    const { rows } = await withSystem((db) => db.query<{ active_config_version_id: string; hermes_profile_config_version_id: string; status: string }>(
      "select active_config_version_id,hermes_profile_config_version_id,status from agent_instances where id=$1",
      [agent],
    ));
    expect(rows[0].hermes_profile_config_version_id).toBe(rows[0].active_config_version_id);
    expect(rows[0].status).toBe("provisioning");
  });

  it("rejects stale leases and unreviewed host evidence without mapping a profile", async () => {
    const gatewayId = randomUUID();
    vi.stubEnv("HERMES_PROVISIONER_GATEWAY_ID", gatewayId);
    resetEnvCache();
    const { agent } = await clientWithReadyProfile(gatewayId, true);
    const manifest = await claimHermesProvisionerJob(gatewayId);
    await expect(completeHermesProvisionerJob({
      ...validResult(manifest!, "e".repeat(64)),
      leaseToken: randomUUID(),
      toolInventoryComplete: false,
    }, gatewayId)).rejects.toThrow(/supported contract/);
    const { rows } = await withSystem((db) => db.query<{ hermes_profile: string | null; status: string }>(
      "select hermes_profile,status from agent_instances where id=$1",
      [agent],
    ));
    expect(rows[0].hermes_profile).toBeNull();
    expect(rows[0].status).toBe("setup_required");
  });
});

describe("failure budget: what a failed attempt costs", () => {
  const fail = (manifest: NonNullable<Awaited<ReturnType<typeof claimHermesProvisionerJob>>>, code: string) =>
    completeHermesProvisionerJob({ ok: false, jobId: manifest.jobId, leaseToken: manifest.leaseToken, gatewayId: manifest.gatewayId, code }, manifest.gatewayId);
  const jobRow = async (jobId: string) => (await withSystem((db) => db.query<{ status: string; attempt_count: number; retry_in: number | null; detail: string | null }>(
    "select status,attempt_count,extract(epoch from (next_retry_at-now()))::float8 as retry_in,detail from agent_provisioning_jobs where id=$1", [jobId]))).rows[0];
  const retryNow = (jobId: string) => withSystem((db) => db.query("update agent_provisioning_jobs set next_retry_at=now()-interval '1 second' where id=$1", [jobId]));

  async function setup() {
    const gatewayId = randomUUID();
    vi.stubEnv("HERMES_PROVISIONER_GATEWAY_ID", gatewayId);
    resetEnvCache();
    const ready = await clientWithReadyProfile(gatewayId, true);
    return { gatewayId, ...ready };
  }

  it("gives a transient attempt back every time, waits five minutes, and the job is claimable after the wait", async () => {
    const { gatewayId } = await setup();
    let jobId = "";
    for (let round = 1; round <= 3; round += 1) {
      const manifest = await claimHermesProvisionerJob(gatewayId);
      expect(manifest, "round " + round).not.toBeNull();
      jobId = manifest!.jobId;
      expect(await jobRow(jobId)).toMatchObject({ status: "in_progress", attempt_count: 1 });
      await expect(fail(manifest!, "canary_failed_model_endpoint_unreachable")).resolves.toEqual({ accepted: true, failed: true });
      const after = await jobRow(jobId);
      expect(after).toMatchObject({ status: "failed", attempt_count: 0 });
      expect(after.retry_in).toBeGreaterThan(290);
      expect(after.retry_in).toBeLessThanOrEqual(300);
      // Not before the five minutes are up...
      await expect(claimHermesProvisionerJob(gatewayId)).resolves.toBeNull();
      // ...and after them.
      await retryNow(jobId);
    }
    const again = await claimHermesProvisionerJob(gatewayId);
    expect(again?.jobId).toBe(jobId);
    expect((await jobRow(jobId)).attempt_count).toBe(1);
    const audit = await withSystem((db) => db.query<{ metadata: { code: string; failureClass: string; attemptGivenBack: boolean; nextRetryAt: string | null } }>(
      "select metadata from audit_logs where target_id=$1 and action='agent.profile_provisioning_failed' order by id", [jobId]));
    expect(audit.rows).toHaveLength(3);
    expect(audit.rows.every((row) => row.metadata.code === "canary_failed_model_endpoint_unreachable" && row.metadata.failureClass === "transient" && row.metadata.attemptGivenBack && row.metadata.nextRetryAt)).toBe(true);
  });

  it("keeps the three-attempt budget for a permanent failure and ends the job after the third", async () => {
    const { gatewayId } = await setup();
    const waits: Array<number | null> = [];
    let jobId = "";
    for (let round = 1; round <= 3; round += 1) {
      const manifest = await claimHermesProvisionerJob(gatewayId);
      jobId = manifest!.jobId;
      await fail(manifest!, "profile_ownership_conflict");
      const after = await jobRow(jobId);
      expect(after).toMatchObject({ status: "failed", attempt_count: round });
      waits.push(after.retry_in === null ? null : Math.round(after.retry_in / 10) * 10);
      if (round < 3) await retryNow(jobId);
    }
    expect(waits).toEqual([30, 60, null]);
    await expect(claimHermesProvisionerJob(gatewayId)).resolves.toBeNull();
    expect((await jobRow(jobId)).detail).toContain("profile_ownership_conflict");
  });

  it("leaves the budget alone when the approved configuration changed while the job ran, and the next claim carries the new version", async () => {
    const { gatewayId, agent, owner, settings, org } = await setup();
    const first = await claimHermesProvisionerJob(gatewayId);
    const edited = await withSystem((db) => createConfigVersion(db, {
      orgId: org.id, agentId: agent, settings: { ...settings, tone: "professional" as const }, source: "client_edit", actorKind: "user", userId: owner.id, apply: true,
    }));
    expect(edited.status).toBe("applied");
    // The worker finishes the old version: the portal sees the drift and records a stale failure, not a spent attempt.
    await expect(completeHermesProvisionerJob(validResult(first!, randomBytes(32).toString("hex")), gatewayId)).resolves.toEqual({ accepted: true, failed: true });
    const after = await jobRow(first!.jobId);
    expect(after).toMatchObject({ status: "failed", attempt_count: 0 });
    expect(after.retry_in).toBeGreaterThan(20);
    expect(after.retry_in).toBeLessThanOrEqual(30);
    expect(after.detail).toContain("stale_configuration");
    await retryNow(first!.jobId);
    const second = await claimHermesProvisionerJob(gatewayId);
    expect(second).toMatchObject({ jobId: first!.jobId, configVersionId: edited.versionId });
    expect(second!.configVersionId).not.toBe(first!.configVersionId);
  });

  it("stops giving attempts back when the job is more than a day old", async () => {
    const { gatewayId } = await setup();
    const manifest = await claimHermesProvisionerJob(gatewayId);
    await withSystem((db) => db.query("update agent_provisioning_jobs set created_at=now()-interval '23 hours' where id=$1", [manifest!.jobId]));
    await fail(manifest!, "http_unavailable");
    expect(await jobRow(manifest!.jobId)).toMatchObject({ status: "failed", attempt_count: 0 });
    await retryNow(manifest!.jobId);

    const old = await claimHermesProvisionerJob(gatewayId);
    await withSystem((db) => db.query("update agent_provisioning_jobs set created_at=now()-interval '25 hours' where id=$1", [old!.jobId]));
    await fail(old!, "http_unavailable");
    const spent = await jobRow(old!.jobId);
    expect(spent).toMatchObject({ status: "failed", attempt_count: 1 });
    expect(spent.retry_in).toBeLessThanOrEqual(30);
    const audit = await withSystem((db) => db.query<{ metadata: { ageBoundReached?: boolean; attemptGivenBack: boolean } }>(
      "select metadata from audit_logs where target_id=$1 and action='agent.profile_provisioning_failed' order by id desc limit 1", [old!.jobId]));
    expect(audit.rows[0].metadata).toMatchObject({ ageBoundReached: true, attemptGivenBack: false });
  });

  it("stores a code the portal does not know as one fixed code and never echoes the raw text", async () => {
    const { gatewayId, org } = await setup();
    const manifest = await claimHermesProvisionerJob(gatewayId);
    const raw = "Bearer sk_live_NOT_A_REAL_KEY and more";
    await expect(fail(manifest!, raw)).resolves.toEqual({ accepted: true, failed: true });
    const state = await jobRow(manifest!.jobId);
    expect(state.detail).toContain("unclassified_worker_failure");
    expect(state.detail).not.toContain("sk_live");
    const audit = await withSystem((db) => db.query<{ text: string }>("select metadata::text as text from audit_logs where org_id=$1 and action='agent.profile_provisioning_failed'", [org.id]));
    expect(audit.rows.every((row) => !row.text.includes("sk_live") && !row.text.includes("Bearer"))).toBe(true);
    expect(audit.rows.some((row) => row.text.includes("unclassified_worker_failure"))).toBe(true);
  });
});

describe("what the claim and the completion record", () => {
  it("writes one started audit row per claim, scoped to the tenant, with no key, SOUL or challenge", async () => {
    const gatewayId = randomUUID();
    vi.stubEnv("HERMES_PROVISIONER_GATEWAY_ID", gatewayId);
    resetEnvCache();
    const mine = await clientWithReadyProfile(gatewayId, true);
    const theirs = await clientWithReadyProfile(gatewayId, true);
    const fail = (manifest: NonNullable<Awaited<ReturnType<typeof claimHermesProvisionerJob>>>) =>
      completeHermesProvisionerJob({ ok: false, jobId: manifest.jobId, leaseToken: manifest.leaseToken, gatewayId, code: "profile_ownership_conflict" }, gatewayId);
    const started = (orgId: string) => withSystem((db) => db.query<{ target_id: string; text: string; metadata: Record<string, unknown>; actor_kind: string }>(
      "select target_id,metadata::text as text,metadata,actor_kind from audit_logs where org_id=$1 and action='agent.profile_provisioning_started' order by id", [orgId]));

    const first = await claimHermesProvisionerJob(gatewayId);
    expect(first?.orgId).toBe(mine.org.id);
    await fail(first!);
    await withSystem((db) => db.query("update agent_provisioning_jobs set next_retry_at=now()-interval '1 second' where id=$1", [first!.jobId]));
    const second = await claimHermesProvisionerJob(gatewayId);
    expect(second?.jobId).toBe(first!.jobId);

    const rows = await started(mine.org.id);
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.map((row) => row.metadata.attempt)).toEqual([1, 2]);
    for (const row of rows.rows) {
      expect(row.actor_kind).toBe("system");
      expect(row.target_id).toBe(first!.jobId);
      expect(row.metadata).toMatchObject({ jobId: first!.jobId, kind: "provision", gatewayId, configVersionId: first!.configVersionId, configVersion: first!.configVersion });
      expect(row.text).not.toContain(second!.soulChallenge);
      expect(row.text).not.toContain(second!.soulSha256);
      expect(row.text).not.toMatch(/[0-9a-f]{64}/);
      expect(row.text).not.toMatch(/lease|secret|soul|challenge|token/i);
    }
    // The other tenant has been claimed by nobody yet: no row, and the rows above never mention it.
    expect((await started(theirs.org.id)).rows).toHaveLength(0);
    expect(rows.rows.every((row) => !row.text.includes(theirs.org.id))).toBe(true);
    await withSystem((db) => db.query("delete from agent_provisioning_jobs where org_id=$1 or org_id=$2", [mine.org.id, theirs.org.id]));
  });

  it("refuses a returned key another live profile already holds, and maps nothing for the second employee", async () => {
    const gatewayId = randomUUID();
    vi.stubEnv("HERMES_PROVISIONER_GATEWAY_ID", gatewayId);
    resetEnvCache();
    const one = await clientWithReadyProfile(gatewayId, true);
    const two = await clientWithReadyProfile(gatewayId, true);
    const shared = randomBytes(32).toString("hex");

    const first = await claimHermesProvisionerJob(gatewayId);
    expect(first?.agentId).toBe(one.agent);
    await expect(completeHermesProvisionerJob(validResult(first!, shared), gatewayId)).resolves.toMatchObject({ accepted: true, duplicate: false });
    const second = await claimHermesProvisionerJob(gatewayId);
    expect(second?.agentId).toBe(two.agent);
    await expect(completeHermesProvisionerJob(validResult(second!, shared), gatewayId)).resolves.toEqual({ accepted: true, failed: true });

    const state = await withSystem((db) => db.query<{ hermes_profile: string | null; hermes_gateway_id: string | null; credential_id: string | null; status: string; credentials: number }>(
      "select a.hermes_profile,a.hermes_gateway_id,a.credential_id,a.status," +
      "(select count(*)::int from integration_credentials c where c.org_id=a.org_id and c.provider='hermes') as credentials from agent_instances a where a.id=$1", [two.agent]));
    expect(state.rows[0]).toMatchObject({ hermes_profile: null, hermes_gateway_id: null, credential_id: null, status: "setup_required", credentials: 0 });
    const job = await withSystem((db) => db.query<{ status: string; detail: string }>("select status,detail from agent_provisioning_jobs where id=$1", [second!.jobId]));
    expect(job.rows[0].status).toBe("failed");
    expect(job.rows[0].detail).toContain("profile_key_reused");
    // The first employee is untouched, and the key is in no audit row.
    const holder = await withSystem((db) => db.query<{ hermes_profile: string | null }>("select hermes_profile from agent_instances where id=$1", [one.agent]));
    expect(holder.rows[0].hermes_profile).toBe(first!.profile);
    const audit = await withSystem((db) => db.query<{ text: string }>("select metadata::text as text from audit_logs where org_id=$1 or org_id=$2", [one.org.id, two.org.id]));
    expect(audit.rows.every((row) => !row.text.includes(shared))).toBe(true);
    await withSystem((db) => db.query("delete from agent_provisioning_jobs where org_id=$1 or org_id=$2", [one.org.id, two.org.id]));
  });

  it("returns nothing when an agency employee is mapped to the client-only gateway", async () => {
    const gatewayId = randomUUID();
    vi.stubEnv("HERMES_PROVISIONER_GATEWAY_ID", gatewayId);
    resetEnvCache();
    const { org } = await clientWithReadyProfile(gatewayId, true);
    const agency = await createOrg({ name: "Agency on the wrong gateway", kind: "agency" });
    await withSystem((db) => db.query(
      "update agent_instances set hermes_gateway_id=$2,hermes_base_url=(select base_url from hermes_gateways where id=$2),hermes_profile='iacquire-gateway-mixup-test' where org_id=$1 and role_key='lead_hunter'", [agency.id, gatewayId]));
    await expect(claimHermesProvisionerJob(gatewayId)).resolves.toBeNull();
    await withSystem((db) => db.query("update agent_instances set hermes_gateway_id=null,hermes_base_url=null,hermes_profile=null where org_id=$1", [agency.id]));
    await expect(claimHermesProvisionerJob(gatewayId)).resolves.toMatchObject({ orgId: org.id });
    await withSystem((db) => db.query("delete from agent_provisioning_jobs where org_id=$1", [org.id]));
  });
});
