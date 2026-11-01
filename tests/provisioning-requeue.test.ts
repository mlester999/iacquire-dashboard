import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRoleKey } from "@/lib/agents";
import { agentSettingsSchema } from "@/lib/agent-settings";
import { defaultSettings } from "@/server/workforce/compiler";
import { resetEnvCache } from "@/server/env";
import { withSystem } from "@/server/db";
import { claimHermesProvisionerJob, completeHermesProvisionerJob } from "@/server/workforce/hermes-provisioner";
import { requeueProvisioningJob, requestProvisioning, updateProvisioningJob } from "@/server/workforce/provisioning";
import { createConfigVersion } from "@/server/workforce/service";
import { addMember, createOrg, createUser } from "./support/fixtures";
import { clearSetupPayment } from "./support/billing";

type Manifest = NonNullable<Awaited<ReturnType<typeof claimHermesProvisionerJob>>>;

let gatewayId = randomUUID();

beforeEach(async () => {
  gatewayId = randomUUID();
  vi.stubEnv("HERMES_PROVISIONER_GATEWAY_ID", gatewayId);
  resetEnvCache();
  await withSystem(async (db) => {
    await db.query("delete from agent_provisioning_jobs");
    await db.query(
      "insert into hermes_gateways (id,label,environment,base_url,gateway_type,status,profile_creation_status,provisioner_isolation_verified_at) " +
      "values ($1,'Requeue test runtime','development',$2,'multiplexed_profiles','connected','restricted_service_verified',now())",
      [gatewayId, "https://client-" + gatewayId.replaceAll("-", "") + ".hermes.test"],
    );
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

/** A paid, onboarded client with one enabled employee (the Lead Hunter) that has an approved configuration and a queued provision job. */
async function client(label = "Requeue Roofing") {
  const org = await createOrg({ name: `${label} ${randomUUID().slice(0, 8)}` });
  await clearSetupPayment(org.id);
  const owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  await withSystem((db) => db.query("update organizations set onboarding_completed_at=now() where id=$1", [org.id]));
  const agents = (await withSystem((db) => db.query<{ id: string; role_key: AgentRoleKey }>("select id,role_key from agent_instances where org_id=$1 and role_key='lead_hunter'", [org.id]))).rows;
  const agent = agents[0];
  await withSystem(async (db) => {
    await createConfigVersion(db, { orgId: org.id, agentId: agent.id, settings: defaultSettings(agent.role_key), source: "onboarding", userId: owner.id, apply: true });
    await db.query("update agent_instances set enabled=false where org_id=$1 and id<>$2", [org.id, agent.id]);
  });
  await withSystem((db) => requestProvisioning(db, org.id, owner.id));
  return { org, owner, agentId: agent.id };
}

function successful(manifest: Manifest, apiKey?: string) {
  return {
    ok: true, jobId: manifest.jobId, leaseToken: manifest.leaseToken, gatewayId: manifest.gatewayId, kind: manifest.kind, orgId: manifest.orgId, agentId: manifest.agentId,
    profile: manifest.profile, sourceProvisionJobId: manifest.sourceProvisionJobId, configVersionId: manifest.configVersionId, configVersion: manifest.configVersion,
    soulSha256: manifest.soulSha256, soulChallengeSha256: createHash("sha256").update(manifest.soulChallenge).digest("hex"), policyConfigSha256: manifest.policyConfigSha256,
    effectiveConfigSha256: "b".repeat(64), authenticated: true, identityVerified: true, effectiveSoulVerified: true, toolInventoryComplete: true,
    toolInventoryDigest: "c".repeat(64), hermesVersion: "hermes v0.22.5 requeue test", ...(apiKey ? { apiKey } : {}),
  };
}

const failed = (manifest: Manifest, code: string) => completeHermesProvisionerJob({ ok: false, jobId: manifest.jobId, leaseToken: manifest.leaseToken, gatewayId, code }, gatewayId);
const forceRetryNow = (jobId: string) => withSystem((db) => db.query("update agent_provisioning_jobs set next_retry_at=now()-interval '1 second' where id=$1 and next_retry_at is not null", [jobId]));

/** Three claims that each fail for a reason that spends the budget: the job ends failed at attempt 3 with no retry time. */
async function exhaust(agentId: string) {
  let last: Manifest | null = null;
  for (let i = 0; i < 3; i += 1) {
    const manifest = await claimHermesProvisionerJob(gatewayId);
    expect(manifest?.agentId).toBe(agentId);
    await failed(manifest!, "soul_digest_mismatch");
    await forceRetryNow(manifest!.jobId);
    last = manifest;
  }
  return last!;
}

const openJobs = async (agentId: string) => (await withSystem((db) => db.query<{ id: string; kind: string; status: string }>(
  "select id,kind,status from agent_provisioning_jobs where agent_instance_id=$1 and status in ('requested','in_progress','awaiting_health_check')", [agentId]))).rows;
const allJobs = async (agentId: string) => (await withSystem((db) => db.query<{ id: string; kind: string; status: string; attempt_count: number; next_retry_at: Date | null }>(
  "select id,kind,status,attempt_count,next_retry_at from agent_provisioning_jobs where agent_instance_id=$1 order by created_at,id", [agentId]))).rows;
const auditRows = async (orgId: string, action: string) => (await withSystem((db) => db.query<{ metadata: Record<string, unknown>; actor_user_id: string | null; target_id: string | null; text: string }>(
  "select metadata,actor_user_id,target_id,metadata::text as text from audit_logs where org_id=$1 and action=$2 order by id", [orgId, action]))).rows;

describe("requeueProvisioningJob", () => {
  it("opens exactly one new provision job after an exhausted failure, and the worker can claim it", async () => {
    const c = await client();
    const admin = await createUser({ platformRole: "agency_super_admin" });
    const lastFailed = await exhaust(c.agentId);
    expect(await openJobs(c.agentId)).toHaveLength(0);
    expect((await allJobs(c.agentId))[0]).toMatchObject({ status: "failed", attempt_count: 3, next_retry_at: null });
    // The recovery path the old dead end did not have: the normal request still refuses (the employee already had a provision job), the requeue does not.
    expect(await withSystem((db) => requestProvisioning(db, c.org.id, c.owner.id))).toBe(0);
    await expect(claimHermesProvisionerJob(gatewayId)).resolves.toBeNull();

    const out = await requeueProvisioningJob(admin.id, c.org.id, c.agentId, "Host profile watcher fixed after review");
    expect(out).toMatchObject({ kind: "provision", previousJobId: lastFailed.jobId });
    expect(await openJobs(c.agentId)).toEqual([{ id: out.jobId, kind: "provision", status: "requested" }]);
    expect(await allJobs(c.agentId)).toHaveLength(2);
    await expect(requeueProvisioningJob(admin.id, c.org.id, c.agentId, "A second click on the same button")).rejects.toThrow(/already open/i);
    expect(await openJobs(c.agentId)).toHaveLength(1);

    const next = await claimHermesProvisionerJob(gatewayId);
    expect(next).toMatchObject({ jobId: out.jobId, kind: "provision", orgId: c.org.id, agentId: c.agentId });
    const attemptCount = (await allJobs(c.agentId)).find((job) => job.id === out.jobId)!.attempt_count;
    expect(attemptCount).toBe(1);
    await expect(completeHermesProvisionerJob(successful(next!, randomBytes(32).toString("hex")), gatewayId)).resolves.toMatchObject({ accepted: true, duplicate: false });
  });

  it("treats a job whose last attempt ran out of time as exhausted and closes it first", async () => {
    const c = await client();
    const admin = await createUser({ platformRole: "agency_super_admin" });
    for (let i = 0; i < 2; i += 1) {
      const manifest = await claimHermesProvisionerJob(gatewayId);
      await failed(manifest!, "soul_digest_mismatch");
      await forceRetryNow(manifest!.jobId);
    }
    const stuck = await claimHermesProvisionerJob(gatewayId);
    expect((await allJobs(c.agentId))[0]).toMatchObject({ status: "in_progress", attempt_count: 3 });
    // The attempt is still running, so there is nothing to requeue yet.
    await expect(requeueProvisioningJob(admin.id, c.org.id, c.agentId, "Trying too early to restart")).rejects.toThrow(/already open/i);
    await withSystem((db) => db.query("update agent_provisioning_jobs set lease_expires_at=now()-interval '1 minute' where id=$1", [stuck!.jobId]));

    const out = await requeueProvisioningJob(admin.id, c.org.id, c.agentId, "Worker died on its last attempt");
    const jobs = await allJobs(c.agentId);
    expect(jobs.find((job) => job.id === stuck!.jobId)).toMatchObject({ status: "failed", next_retry_at: null });
    expect(await openJobs(c.agentId)).toEqual([{ id: out.jobId, kind: "provision", status: "requested" }]);
    const closed = await auditRows(c.org.id, "agent.profile_provisioning_failed");
    expect(closed.some((row) => row.target_id === stuck!.jobId && row.metadata.code === "lease_expired")).toBe(true);
  });

  it("queues a synchronization for the current version after a failed sync at three attempts", async () => {
    const c = await client();
    const admin = await createUser({ platformRole: "agency_super_admin" });
    const provision = await claimHermesProvisionerJob(gatewayId);
    await completeHermesProvisionerJob(successful(provision!, randomBytes(32).toString("hex")), gatewayId);
    const row = (await withSystem((db) => db.query<{ settings: unknown }>("select v.settings from agent_instances a join agent_config_versions v on v.id=a.active_config_version_id where a.id=$1", [c.agentId]))).rows[0];
    const settings = agentSettingsSchema.parse(row.settings);
    const edit = await withSystem((db) => createConfigVersion(db, { orgId: c.org.id, agentId: c.agentId, settings: { ...settings, tone: settings.tone === "professional" ? "friendly" : "professional" }, source: "client_edit", actorKind: "user", userId: c.owner.id, apply: true }));
    expect(edit.status).toBe("applied");

    const lastSync = await exhaust(c.agentId);
    expect(lastSync.kind).toBe("sync");
    expect((await allJobs(c.agentId)).at(-1)).toMatchObject({ kind: "sync", status: "failed", attempt_count: 3, next_retry_at: null });

    const out = await requeueProvisioningJob(admin.id, c.org.id, c.agentId, "Gateway restarted, synchronise again");
    expect(out.kind).toBe("sync");
    expect(await openJobs(c.agentId)).toEqual([{ id: out.jobId, kind: "sync", status: "requested" }]);
    await expect(requeueProvisioningJob(admin.id, c.org.id, c.agentId, "Second click on the same button")).rejects.toThrow(/already open/i);
    const claimed = await claimHermesProvisionerJob(gatewayId);
    expect(claimed).toMatchObject({ jobId: out.jobId, kind: "sync", configVersionId: edit.versionId, sourceProvisionJobId: provision!.jobId });
  });

  it("reopens a cancelled request, and lets the agency cancel a synchronization first", async () => {
    const c = await client();
    const admin = await createUser({ platformRole: "agency_super_admin" });
    const first = (await allJobs(c.agentId))[0];
    await updateProvisioningJob(admin.id, c.org.id, first.id, "cancelled", "Cancelled while the host is repaired.");
    expect((await allJobs(c.agentId))[0].status).toBe("cancelled");
    const out = await requeueProvisioningJob(admin.id, c.org.id, c.agentId, "Host repaired, start again");
    expect(out.kind).toBe("provision");

    const provision = await claimHermesProvisionerJob(gatewayId);
    await completeHermesProvisionerJob(successful(provision!, randomBytes(32).toString("hex")), gatewayId);
    const row = (await withSystem((db) => db.query<{ settings: unknown }>("select v.settings from agent_instances a join agent_config_versions v on v.id=a.active_config_version_id where a.id=$1", [c.agentId]))).rows[0];
    const settings = agentSettingsSchema.parse(row.settings);
    await withSystem((db) => createConfigVersion(db, { orgId: c.org.id, agentId: c.agentId, settings: { ...settings, tone: settings.tone === "professional" ? "friendly" : "professional" }, source: "client_edit", actorKind: "user", userId: c.owner.id, apply: true }));
    const sync = (await openJobs(c.agentId))[0];
    expect(sync.kind).toBe("sync");
    // A synchronization cannot be driven by hand, only stopped.
    await expect(updateProvisioningJob(admin.id, c.org.id, sync.id, "in_progress")).rejects.toThrow(/restricted Hermes worker/i);
    await updateProvisioningJob(admin.id, c.org.id, sync.id, "cancelled");
    const again = await requeueProvisioningJob(admin.id, c.org.id, c.agentId, "Stopped by mistake, queue it again");
    expect(again.kind).toBe("sync");
  });

  it("refuses a client owner, another tenant, an unpaid workspace, a disabled employee and a reason that is too short", async () => {
    const c = await client();
    const other = await client("Other Plumbing");
    const admin = await createUser({ platformRole: "agency_super_admin" });
    const staff = await createUser({ platformRole: "agency_staff" });
    await exhaust(c.agentId);

    await expect(requeueProvisioningJob(c.owner.id, c.org.id, c.agentId, "The owner wants another go")).rejects.toThrow(/workforce management/i);
    await expect(requeueProvisioningJob(staff.id, c.org.id, c.agentId, "Staff who is not assigned here")).rejects.toThrow(/workforce management/i);
    // The employee belongs to another workspace than the one named.
    await expect(requeueProvisioningJob(admin.id, other.org.id, c.agentId, "Wrong workspace on purpose")).rejects.toThrow(/not found/i);
    await expect(requeueProvisioningJob(admin.id, c.org.id, c.agentId, "no")).rejects.toThrow(/at least 5/i);
    await expect(requeueProvisioningJob(admin.id, c.org.id, c.agentId, "     ")).rejects.toThrow(/at least 5/i);
    expect(await openJobs(c.agentId)).toHaveLength(0);

    await withSystem((db) => db.query("update billing_accounts set setup_payment_status='refunded' where org_id=$1", [c.org.id]));
    await expect(requeueProvisioningJob(admin.id, c.org.id, c.agentId, "Refunded workspace should refuse")).rejects.toThrow(/payment/i);
    await withSystem((db) => db.query("update billing_accounts set setup_payment_status='not_invoiced' where org_id=$1", [c.org.id]));
    await expect(requeueProvisioningJob(admin.id, c.org.id, c.agentId, "Unpaid workspace should refuse")).rejects.toThrow(/payment/i);
    await clearSetupPayment(c.org.id);

    await withSystem((db) => db.query("update agent_instances set enabled=false where id=$1", [c.agentId]));
    await expect(requeueProvisioningJob(admin.id, c.org.id, c.agentId, "Disabled employee should refuse")).rejects.toThrow(/not included/i);
    await withSystem((db) => db.query("update agent_instances set enabled=true where id=$1", [c.agentId]));
    await withSystem((db) => db.query("update organizations set status='suspended' where id=$1", [c.org.id]));
    await expect(requeueProvisioningJob(admin.id, c.org.id, c.agentId, "Suspended workspace should refuse")).rejects.toThrow(/active client workspace/i);
    await withSystem((db) => db.query("update organizations set status='active' where id=$1", [c.org.id]));
    expect(await openJobs(c.agentId)).toHaveLength(0);

    // Nothing above changed anything; the same call now works, and only for the named employee.
    await expect(requeueProvisioningJob(admin.id, c.org.id, c.agentId, "Everything is in order now")).resolves.toMatchObject({ kind: "provision" });
    expect(await openJobs(other.agentId)).toHaveLength(1);
    expect(await allJobs(other.agentId)).toHaveLength(1);
  });

  it("does not touch a job that is open, will retry by itself, or already completed", async () => {
    const c = await client();
    const admin = await createUser({ platformRole: "agency_super_admin" });
    await expect(requeueProvisioningJob(admin.id, c.org.id, c.agentId, "Still requested, nothing to do")).rejects.toThrow(/already open/i);
    const manifest = await claimHermesProvisionerJob(gatewayId);
    await failed(manifest!, "soul_digest_mismatch");
    await expect(requeueProvisioningJob(admin.id, c.org.id, c.agentId, "Retry is already scheduled")).rejects.toThrow(/retry by itself/i);
    await forceRetryNow(manifest!.jobId);
    const second = await claimHermesProvisionerJob(gatewayId);
    await completeHermesProvisionerJob(successful(second!, randomBytes(32).toString("hex")), gatewayId);
    await expect(requeueProvisioningJob(admin.id, c.org.id, c.agentId, "Waiting for the health check")).rejects.toThrow(/already open/i);
    await withSystem((db) => db.query("update agent_provisioning_jobs set status='succeeded' where id=$1", [second!.jobId]));
    await expect(requeueProvisioningJob(admin.id, c.org.id, c.agentId, "It already completed")).rejects.toThrow(/already completed/i);
    expect(await allJobs(c.agentId)).toHaveLength(1);
  });

  it("refuses to queue a synchronization for a profile the restricted worker did not create", async () => {
    const c = await client();
    const admin = await createUser({ platformRole: "agency_super_admin" });
    const first = (await allJobs(c.agentId))[0];
    await updateProvisioningJob(admin.id, c.org.id, first.id, "cancelled");
    await withSystem((db) => db.query(
      "update agent_instances set hermes_profile='c-manual-profile',hermes_base_url=(select base_url from hermes_gateways where id=$2),hermes_gateway_id=$2,hermes_profile_config_version_id=active_config_version_id where id=$1", [c.agentId, gatewayId]));
    await expect(requeueProvisioningJob(admin.id, c.org.id, c.agentId, "Manual profile from the runbook")).rejects.toThrow(/runbook/i);
    expect(await openJobs(c.agentId)).toHaveLength(0);
  });

  it("gives two concurrent requeues one open job", async () => {
    const c = await client();
    const admin = await createUser({ platformRole: "agency_super_admin" });
    await exhaust(c.agentId);
    const settled = await Promise.allSettled([
      requeueProvisioningJob(admin.id, c.org.id, c.agentId, "First of two simultaneous clicks"),
      requeueProvisioningJob(admin.id, c.org.id, c.agentId, "Second of two simultaneous clicks"),
    ]);
    expect(settled.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(await openJobs(c.agentId)).toHaveLength(1);
    expect(await allJobs(c.agentId)).toHaveLength(2);
    expect(await auditRows(c.org.id, "agent.provisioning_requeued")).toHaveLength(1);
  });

  it("audits the requeue with its reason and no secret, and tells the owner once", async () => {
    const c = await client();
    const admin = await createUser({ platformRole: "agency_super_admin" });
    await exhaust(c.agentId);

    const reason = "Provider outage confirmed over, retrying";
    const out = await requeueProvisioningJob(admin.id, c.org.id, c.agentId, reason);
    const rows = await auditRows(c.org.id, "agent.provisioning_requeued");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_user_id: admin.id, target_id: out.jobId });
    expect(rows[0].metadata).toMatchObject({ kind: "provision", reason, previousStatus: "failed", previousAttempts: 3 });
    expect(rows[0].text).not.toMatch(/[0-9a-f]{64}/);
    expect(rows[0].text).not.toMatch(/lease|token|secret|soul|challenge/i);

    const notices = await withSystem((db) => db.query<{ user_id: string; body: string | null }>(
      "select user_id,body from notifications where org_id=$1 and dedupe_key=$2", [c.org.id, `provisioning-requeued:${out.jobId}`]));
    expect(notices.rows.map((row) => row.user_id)).toEqual([c.owner.id]);
    expect(notices.rows[0].body).not.toContain(reason);
  });
});
