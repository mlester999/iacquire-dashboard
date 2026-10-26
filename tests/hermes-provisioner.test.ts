import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "@/server/workforce/compiler";
import { compileAgentConfig } from "@/server/workforce/compiler";
import { resetEnvCache } from "@/server/env";
import { withSystem } from "@/server/db";
import { claimHermesProvisionerJob, completeHermesProvisionerJob } from "@/server/workforce/hermes-provisioner";
import { createConfigVersion } from "@/server/workforce/service";
import { requestProvisioning } from "@/server/workforce/provisioning";
import { addMember, createOrg, createUser } from "./support/fixtures";
import { clearSetupPayment } from "./support/billing";

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
      "values ($1,'Client-only test runtime','development',$2,'multiplexed_profiles','connected','restricted_service_verified',$3)",
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
