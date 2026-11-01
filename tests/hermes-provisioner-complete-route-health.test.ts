// The complete route starts the portal's first health check by itself, after the response, and only for a first accepted success. next/server's after() is replaced by a recorder so
// the test decides when the work runs; everything behind it (claim, completion, the real health check against the Hermes test double, the watchdog's fall-back) is real code.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as completeRoute } from "@/app/api/internal/hermes-provisioner/complete/route";
import { resetEnvCache } from "@/server/env";
import { withSystem } from "@/server/db";
import { compileAgentConfig, defaultSettings } from "@/server/workforce/compiler";
import { requestProvisioning } from "@/server/workforce/provisioning";
import { runProvisioningWatchdog } from "@/server/workforce/provisioning-watchdog";
import { suggestedProfileName } from "@/server/workforce/service";
import { addMember, createOrg, createUser } from "./support/fixtures";
import { clearSetupPayment } from "./support/billing";
import { startMockHermes, type MockHermes } from "./support/mock-hermes";

const scheduled = vi.hoisted(() => ({ callbacks: [] as Array<() => unknown>, unavailable: false }));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: (work: () => unknown) => {
      if (scheduled.unavailable) throw new Error("`after` was called outside a request scope.");
      scheduled.callbacks.push(work);
    },
  };
});

const TOKEN = "r".repeat(40);
const q = async <T extends Record<string, unknown>>(text: string, params: unknown[] = []) => (await withSystem((db) => db.query<T>(text, params))).rows;
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const mocks: MockHermes[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  resetEnvCache();
  scheduled.callbacks = [];
  scheduled.unavailable = false;
  await Promise.all(mocks.splice(0).map((m) => m.close().catch(() => undefined)));
});

interface Claimed { jobId: string; leaseToken: string; gatewayId: string; kind: "provision" | "sync"; orgId: string; agentId: string; profile: string; configVersionId: string; configVersion: number; sourceProvisionJobId: string | null; soul: string; soulSha256: string; soulChallenge: string; policyConfigSha256: string }

const post = (handler: (r: Request) => Promise<Response>, body: unknown, token: string | null = TOKEN) =>
  handler(new Request("http://iacquire.test/api/internal/hermes-provisioner", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }));

/** A client that finished onboarding with one Lead Hunter job waiting for the worker, a verified client-only gateway pointing at the Hermes test double, and the worker's env. */
async function readyClient() {
  const gatewayId = randomUUID();
  const org = await createOrg({ name: "Route Health Co " + randomUUID().slice(0, 8) });
  await clearSetupPayment(org.id);
  const owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  const profile = suggestedProfileName(org.slug, "lead_hunter");
  // Each profile has its own key: the portal refuses a key another employee already holds.
  const apiKey = randomBytes(32).toString("hex");
  const mock = await startMockHermes({ [profile]: { key: apiKey } });
  mocks.push(mock);
  await withSystem(async (db) => {
    await db.query("update organizations set onboarding_completed_at = now() where id = $1", [org.id]);
    await db.query("update users set email_verified_at = now() where id = $1", [owner.id]);
  });
  const agent = (await q<{ id: string }>("select id from agent_instances where org_id = $1 and role_key = 'lead_hunter'", [org.id]))[0].id;
  const settings = defaultSettings("lead_hunter");
  const compiled = compileAgentConfig({ role: "lead_hunter", settings, company: { companyName: org.name, orgKind: "client" }, version: 1, allowedTools: ["web_search"] });
  let configVersionId = "";
  await withSystem(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      "insert into agent_config_versions (org_id, agent_instance_id, version, settings, summary, compiled_instructions, policy_version, source, status, created_by, applied_at) " +
      "values ($1, $2, 1, $3::jsonb, $4, $5, $6, 'onboarding', 'applied', $7, now()) returning id",
      [org.id, agent, JSON.stringify(settings), compiled.summary, compiled.instructions, compiled.policyVersion, owner.id],
    );
    configVersionId = rows[0].id;
    await db.query("update agent_instances set active_config_version_id = $2 where id = $1", [agent, rows[0].id]);
    await db.query(
      "insert into hermes_gateways (id, label, environment, base_url, gateway_type, status, profile_creation_status, provisioner_isolation_verified_at) " +
      "values ($1, 'Client-only route test runtime', 'development', $2, 'multiplexed_profiles', 'connected', 'restricted_service_verified', now())",
      [gatewayId, mock.url],
    );
    await requestProvisioning(db, org.id, owner.id);
    await db.query("delete from agent_provisioning_jobs where org_id = $1 and agent_instance_id <> $2", [org.id, agent]);
  });
  vi.stubEnv("HERMES_PROVISIONER_ENABLED", "true");
  vi.stubEnv("HERMES_PROVISIONER_TOKEN", TOKEN);
  vi.stubEnv("HERMES_PROVISIONER_GATEWAY_ID", gatewayId);
  resetEnvCache();
  return { org, owner, agent, gatewayId, mock, profile, configVersionId, apiKey };
}

/**
 * The worker's claim, written the way the claim leaves the job (leased, attempt 1, the digests of the manifest it was handed). The claim itself is not what this file is about, so the
 * state is set directly; the completion below is the real route and the real validation of those digests, lease and tenant.
 */
async function claim(c: Awaited<ReturnType<typeof readyClient>>): Promise<Claimed> {
  const soul = `reviewed role template for ${c.profile}`;
  const soulChallenge = randomUUID().replaceAll("-", "");
  const soulSha256 = sha256(soul);
  const policyConfigSha256 = sha256("platform_toolsets: [memory]");
  const rows = await q<{ id: string; lease_token: string }>(
    `update agent_provisioning_jobs set status = 'in_progress', attempt_count = 1, lease_token = gen_random_uuid(), lease_expires_at = now() + interval '10 minutes',
       config_version_id = $2, manifest_soul_sha256 = $3, manifest_policy_config_sha256 = $4, manifest_challenge_sha256 = $5
     where agent_instance_id = $1 and kind = 'provision' returning id, lease_token::text`,
    [c.agent, c.configVersionId, soulSha256, policyConfigSha256, sha256(soulChallenge)],
  );
  return {
    jobId: rows[0].id, leaseToken: rows[0].lease_token, gatewayId: c.gatewayId, kind: "provision", orgId: c.org.id, agentId: c.agent, profile: c.profile, configVersionId: c.configVersionId,
    configVersion: 1, sourceProvisionJobId: null, soul, soulSha256, soulChallenge, policyConfigSha256,
  };
}

const success = (job: Claimed, apiKey: string) => ({
  ok: true, jobId: job.jobId, leaseToken: job.leaseToken, gatewayId: job.gatewayId, kind: job.kind, orgId: job.orgId, agentId: job.agentId, profile: job.profile,
  sourceProvisionJobId: job.sourceProvisionJobId, configVersionId: job.configVersionId, configVersion: job.configVersion, soulSha256: job.soulSha256,
  soulChallengeSha256: sha256(job.soulChallenge), policyConfigSha256: job.policyConfigSha256, effectiveConfigSha256: sha256(job.soul + "\nverified"), authenticated: true,
  identityVerified: true, effectiveSoulVerified: true, toolInventoryComplete: true, toolInventoryDigest: sha256(job.profile + "\ncatalog"), hermesVersion: "hermes route test double",
  apiKey,
});

const employee = async (agent: string) => (await q<{ status: string; last_health_ok: boolean | null; health_consecutive_failures: number; job_status: string }>(
  `select a.status, a.last_health_ok, a.health_consecutive_failures, j.status as job_status
     from agent_instances a join agent_provisioning_jobs j on j.agent_instance_id = a.id and j.kind = 'provision' where a.id = $1`, [agent]))[0];
const runScheduled = async () => { for (const work of scheduled.callbacks.splice(0)) await work(); };

describe("the complete route and the first health check", () => {
  it("answers first, then checks the employee: it goes online and the job succeeds with no person involved", async () => {
    const c = await readyClient();
    const job = await claim(c);
    const response = await post(completeRoute, success(job, c.apiKey));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: true, duplicate: false, awaitingHealthCheck: true });
    // The response has gone and the check has not run yet: the worker never waits for it, and nothing is claimed as ready.
    expect(scheduled.callbacks).toHaveLength(1);
    expect(await employee(c.agent)).toMatchObject({ status: "provisioning", last_health_ok: null, job_status: "awaiting_health_check" });
    const before = c.mock.requests.length;
    await runScheduled();
    expect(await employee(c.agent)).toMatchObject({ status: "online", last_health_ok: true, health_consecutive_failures: 0, job_status: "succeeded" });
    const reads = c.mock.requests.slice(before).filter((r) => r.profile === c.profile);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((r) => r.method === "GET")).toBe(true);
    expect(await q("select 1 from audit_logs where agent_instance_id = $1 and action = 'agent.health_check' and actor_kind = 'system' and actor_user_id is null", [c.agent])).toHaveLength(1);
  });

  it("starts no second check for a replayed completion", async () => {
    const c = await readyClient();
    const job = await claim(c);
    expect((await post(completeRoute, success(job, c.apiKey))).status).toBe(200);
    expect(scheduled.callbacks).toHaveLength(1);
    await runScheduled();
    const requestsAfterFirst = c.mock.requests.length;
    const replay = await post(completeRoute, success(job, c.apiKey));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ accepted: true, duplicate: true });
    expect(scheduled.callbacks).toHaveLength(0);
    await runScheduled();
    expect(c.mock.requests.length).toBe(requestsAfterFirst);
  });

  it("starts nothing for a reported failure, a stale lease, or a request without the worker's token", async () => {
    const c = await readyClient();
    const job = await claim(c);
    const stale = await post(completeRoute, { ...success(job, c.apiKey), leaseToken: randomUUID() });
    expect(stale.status).toBe(409);
    const unauthorized = await post(completeRoute, success(job, c.apiKey), "x".repeat(40));
    expect(unauthorized.status).toBe(401);
    const none = await post(completeRoute, success(job, c.apiKey), null);
    expect(none.status).toBe(401);
    expect(scheduled.callbacks).toHaveLength(0);
    const failure = await post(completeRoute, { ok: false, jobId: job.jobId, leaseToken: job.leaseToken, gatewayId: job.gatewayId, code: "canary_failed" });
    expect(failure.status).toBe(200);
    expect(await failure.json()).toEqual({ accepted: true, failed: true });
    expect(scheduled.callbacks).toHaveLength(0);
    expect(await employee(c.agent)).toMatchObject({ status: "setup_required", job_status: "failed" });
  });

  it("still answers the worker normally when after() cannot be used, and the watchdog's follow-up then does the check", async () => {
    const c = await readyClient();
    const job = await claim(c);
    scheduled.unavailable = true;
    const response = await post(completeRoute, success(job, c.apiKey));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: true, duplicate: false, awaitingHealthCheck: true });
    expect(scheduled.callbacks).toHaveLength(0);
    expect(await employee(c.agent)).toMatchObject({ status: "provisioning", job_status: "awaiting_health_check" });
    // Two minutes on, the watchdog picks it up (the same check, the same result).
    const summary = await runProvisioningWatchdog({ now: new Date(Date.now() + 3 * 60_000) });
    expect(summary.checked).toBeGreaterThanOrEqual(1);
    expect(await employee(c.agent)).toMatchObject({ status: "online", job_status: "succeeded" });
  });

  it("does not let a down gateway break the callback: the failure is recorded, the job stays open, and the next pass can still close it", async () => {
    const c = await readyClient();
    const job = await claim(c);
    expect((await post(completeRoute, success(job, c.apiKey))).status).toBe(200);
    await c.mock.close();
    await expect(runScheduled()).resolves.toBeUndefined();
    expect(await employee(c.agent)).toMatchObject({ status: "offline", last_health_ok: false, health_consecutive_failures: 1, job_status: "awaiting_health_check" });
  });
});
