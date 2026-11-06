import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as claimRoute } from "@/app/api/internal/hermes-provisioner/claim/route";
import { POST as completeRoute } from "@/app/api/internal/hermes-provisioner/complete/route";
import { AGENT_ROLE_KEYS, AI_GROWTH_PARTNER_ROLE_KEY, type WorkforceRoleKey } from "@/lib/agents";
import { agentSettingsSchema } from "@/lib/agent-settings";
import { resetEnvCache } from "@/server/env";
import { createClientTenant } from "@/server/admin/tenants";
import { withSystem } from "@/server/db";
import { saveOnboardingStep, submitOnboarding } from "@/server/onboarding/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { requestProvisioning } from "@/server/workforce/provisioning";
import { createConfigVersion, decideHeldVersion } from "@/server/workforce/service";
import { addMember, agencyUser, agentId, createOrg, createUser, ctxFor } from "./support/fixtures";
import { clearSetupPayment } from "./support/billing";

const llm = vi.hoisted(() => ({
  config: null as object | null,
  reply: { ok: true, text: "{}" } as { ok: boolean; text?: string; status?: number },
  calls: 0,
}));

vi.mock("@/server/llm/client", () => ({
  resolveLlmConfig: async () => llm.config,
  llmComplete: async () => {
    llm.calls += 1;
    return llm.reply;
  },
}));

type RouteHandler = (request: Request) => Promise<Response>;

interface ClaimedJob {
  jobId: string;
  leaseToken: string;
  gatewayId: string;
  kind: "provision" | "sync";
  orgId: string;
  agentId: string;
  role: string;
  profile: string;
  configVersionId: string;
  configVersion: number;
  sourceProvisionJobId: string | null;
  soul: string;
  soulSha256: string;
  soulChallenge: string;
  policyConfigSha256: string;
  configYaml: string;
  expiresAt: string;
}

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

async function postJson(handler: RouteHandler, body: unknown, token?: string) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token) headers.set("Authorization", "Bearer " + token);
  return handler(new Request("http://iacquire.test/api/internal/hermes-provisioner", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }));
}

async function onboard(name: string, description: string, service: string, customer: string) {
  const admin = agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
  const ownerEmail = `owner-${randomUUID()}@example.test`;
  vi.stubEnv("EMAIL_PROVIDER", "capture");
  resetEnvCache();
  const created = await createClientTenant(admin, {
    name,
    ownerEmail,
    industry: "Home services",
    timezone: "America/Chicago",
    enabledRoles: [...AGENT_ROLE_KEYS],
  });
  const org = { id: created.orgId, name, slug: created.slug };
  await clearSetupPayment(org.id, "Synthetic provisioning acceptance: setup fee cleared");
  const owner = await createUser({ email: ownerEmail });
  await addMember(org.id, owner.id, "owner");
  const ctx = ctxFor(owner, org, "owner");
  const answers = {
    "a.business_name": name,
    "a.industry": "home_services",
    "a.business_model": "local",
    "a.description": description,
    "a.timezone": "America/Chicago",
    "a.hours": { mon: [["09:00", "17:00"]], tue: [["09:00", "17:00"]], wed: [["09:00", "17:00"]], thu: [["09:00", "17:00"]], fri: [["09:00", "17:00"]] },
    "a.contact_email": owner.email,
    "a.territories": "Austin, Texas",
    "a.target_customers": customer,
    "b.goals": ["more_leads", "more_appointments"],
    "b.services": service,
    "b.ideal_customer": customer,
    "b.appointments": true,
    "b.website_need": "have",
    "d.pricing_policy": "never",
    "f.review": true,
  };
  const saved = await saveOnboardingStep(ctx, {
    answers: Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, { value }])),
    currentQuestionId: "f.review",
  });
  expect(saved.rejected).toEqual({});
  const outcome = await submitOnboarding(ctx);
  expect(outcome.employees).toHaveLength(1);
  expect(outcome.employees[0].role).toBe(AI_GROWTH_PARTNER_ROLE_KEY);
  return { org, owner, ctx, outcome };
}
function successfulResult(job: ClaimedJob, apiKey?: string) {
  return {
    ok: true,
    jobId: job.jobId,
    leaseToken: job.leaseToken,
    gatewayId: job.gatewayId,
    kind: job.kind,
    orgId: job.orgId,
    agentId: job.agentId,
    profile: job.profile,
    sourceProvisionJobId: job.sourceProvisionJobId,
    configVersionId: job.configVersionId,
    configVersion: job.configVersion,
    soulSha256: job.soulSha256,
    soulChallengeSha256: sha256(job.soulChallenge),
    policyConfigSha256: job.policyConfigSha256,
    effectiveConfigSha256: sha256(job.soul + "\nverified-effective-config"),
    authenticated: true,
    identityVerified: true,
    effectiveSoulVerified: true,
    toolInventoryComplete: true,
    toolInventoryDigest: sha256(job.profile + "\ncomplete-runtime-catalog"),
    hermesVersion: "hermes v0.22.5 synthetic route acceptance",
    ...(apiKey ? { apiKey } : {}),
  };
}

describe("iAcquireOS Hermes provisioning HTTP acceptance (synthetic PGlite tenants)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvCache();
    llm.config = null;
    llm.reply = { ok: true, text: "{}" };
    llm.calls = 0;
  });

  it("runs real onboarding through authorized claim, profile callbacks, recovery, idempotency, and config sync", async () => {
    llm.config = { baseUrl: "https://llm.example.test/v1", format: "openai", model: "test-model", apiKey: "test-only", source: "portal" };
    llm.reply = { ok: true, text: "{}" };

    const gatewayId = randomUUID();
    const workerToken = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
    vi.stubEnv("HERMES_PROVISIONER_ENABLED", "true");
    vi.stubEnv("HERMES_PROVISIONER_TOKEN", workerToken);
    vi.stubEnv("HERMES_PROVISIONER_GATEWAY_ID", gatewayId);
    resetEnvCache();

    const tenantA = await onboard(
      "Juniper Roofing " + randomUUID().slice(0, 8),
      "Repairs residential roofs after local storm damage.",
      "Roof repair and inspection",
      "Austin homeowners",
    );
    const tenantB = await onboard(
      "Copper Plumbing " + randomUUID().slice(0, 8),
      "Repairs plumbing systems for homes and small businesses.",
      "Pipe repair and drain cleaning",
      "Austin property owners",
    );
    const tenants = [tenantA, tenantB];
    expect(llm.calls).toBe(0);

    const reviewer = await createUser({ platformRole: "agency_super_admin" });
    const audienceAgentId = await agentId(tenantA.org.id, AI_GROWTH_PARTNER_ROLE_KEY);
    const originalAudienceConfig = await withSystem((db) => db.query<{ settings: unknown }>(
      "select v.settings from agent_instances a join agent_config_versions v on v.id=a.active_config_version_id and v.org_id=a.org_id where a.id=$1 and a.org_id=$2",
      [audienceAgentId, tenantA.org.id],
    ));
    expect(originalAudienceConfig.rows).toHaveLength(1);
    const manualAudience = agentSettingsSchema.parse({
      ...agentSettingsSchema.parse(originalAudienceConfig.rows[0].settings),
      targetCustomers: "Owner-approved independent roof specialists",
    });
    const manualAudienceVersion = await withSystem((db) => createConfigVersion(db, {
      orgId: tenantA.org.id,
      agentId: audienceAgentId,
      settings: manualAudience,
      source: "client_edit",
      actorKind: "user",
      userId: tenantA.owner.id,
      apply: true,
    }));
    if (manualAudienceVersion.status === "pending_agency_review") {
      await withSystem((db) => decideHeldVersion(db, {
        orgId: tenantA.org.id,
        versionId: manualAudienceVersion.versionId,
        approve: true,
        agencyUserId: reviewer.id,
        decisionNote: "Reviewed the synthetic owner audience preference.",
      }));
    }

    const refreshedAnswers = await saveOnboardingStep(tenantA.ctx, {
      answers: {
        "b.ideal_customer": { value: "Austin property managers" },
        "f.review": { value: true },
      },
      currentQuestionId: "f.review",
    });
    expect(refreshedAnswers.rejected).toEqual({});
    expect((await submitOnboarding(tenantA.ctx)).employees).toHaveLength(0);
    expect(llm.calls).toBe(0);

    const latestAudienceConfig = await withSystem((db) => db.query<{ settings: unknown; source: string }>(
      "select v.settings,v.source from agent_config_versions v where v.agent_instance_id=$1 and v.org_id=$2 order by v.version desc limit 1",
      [audienceAgentId, tenantA.org.id],
    ));
    expect(latestAudienceConfig.rows).toHaveLength(1);
    expect(latestAudienceConfig.rows[0].source).toBe("client_edit");
    expect(agentSettingsSchema.parse(latestAudienceConfig.rows[0].settings).targetCustomers)
      .toBe("Owner-approved independent roof specialists");

    const pending = await withSystem((db) => db.query<{ id: string; org_id: string }>(
      "select v.id,v.org_id from agent_config_versions v " +
      "where (v.org_id=$1 or v.org_id=$2) and v.status='pending_agency_review' and v.source='onboarding'",
      [tenantA.org.id, tenantB.org.id],
    ));
    for (const version of pending.rows) {
      await withSystem((db) => decideHeldVersion(db, {
        orgId: version.org_id,
        versionId: version.id,
        approve: true,
        agencyUserId: reviewer.id,
        decisionNote: "Reviewed synthetic configuration and protected role boundaries.",
      }));
    }

    await withSystem((db) => db.query(
      "insert into hermes_gateways (id,label,environment,base_url,gateway_type,status,profile_creation_status,provisioner_isolation_verified_at) " +
      "values ($1,'Synthetic route test runtime','development',$2,'multiplexed_profiles','connected','restricted_service_verified',now())",
      [gatewayId, "https://client-" + gatewayId.replaceAll("-", "") + ".hermes.test"],
    ));

    const generatedConfigs = await withSystem((db) => db.query<{
      org_id: string;
      role_key: WorkforceRoleKey;
      settings: unknown;
      compiled_instructions: string;
    }>(
      "select a.org_id,a.role_key,v.settings,v.compiled_instructions from agent_instances a " +
      "join agent_config_versions v on v.id=a.active_config_version_id and v.org_id=a.org_id " +
      "where a.org_id=$1 or a.org_id=$2 order by a.org_id,a.role_key",
      [tenantA.org.id, tenantB.org.id],
    ));
    expect(generatedConfigs.rows).toHaveLength(2);
    for (const row of generatedConfigs.rows) {
      const settings = agentSettingsSchema.parse(row.settings);
      expect(row.role_key).toBe(AI_GROWTH_PARTNER_ROLE_KEY);
      for (const field of [
        "personality", "characterTraits", "communicationStyle", "responseBehavior", "operatingProcedures",
        "proactiveResponsibilities", "reportingBehavior", "responsibilities", "goals",
      ] as const) {
        expect(settings[field].trim().length).toBeGreaterThan(0);
      }
      expect(settings.personality).toContain("AI Growth Partner");
      expect(settings.communicationStyle).toContain("friendly");
      expect(settings.operatingProcedures).toContain("tenant-scoped");
      expect(settings.goals).toContain("more_leads");
      expect(row.compiled_instructions).toContain(settings.personality);
      expect(row.compiled_instructions).toContain(row.org_id === tenantA.org.id ? tenantA.org.name : tenantB.org.name);
      expect(settings.targetCustomers).toBe(row.org_id === tenantA.org.id ? "Owner-approved independent roof specialists" : "Austin property owners");
    }

    const unauthorized = await postJson(claimRoute, { gatewayId });
    expect(unauthorized.status).toBe(401);

    const wrongGateway = await postJson(claimRoute, { gatewayId: randomUUID() }, workerToken);
    expect(wrongGateway.status).toBe(403);

    vi.stubEnv("HERMES_PROVISIONER_ENABLED", "false");
    resetEnvCache();
    const disabled = await postJson(claimRoute, { gatewayId }, workerToken);
    expect(disabled.status).toBe(503);
    // The worker reads a switched-off portal (healthy and idle) by this phrase in the answer; reword the route and it would read the switch as an outage.
    const workerText = /PORTAL_DISABLED_TEXT\s*=\s*"([^"]+)"/.exec(readFileSync(path.join(process.cwd(), "services", "hermes-provisioner", "worker.py"), "utf8"))?.[1] ?? "";
    expect(workerText).not.toBe("");
    expect(((await disabled.json()) as { error: string }).error).toContain(workerText);
    vi.stubEnv("HERMES_PROVISIONER_ENABLED", "true");
    resetEnvCache();

    const claimed: ClaimedJob[] = [];
    const profileKeys = new Map<string, string>();
    for (let attempt = 0; attempt < 13; attempt += 1) {
      const response = await postJson(claimRoute, { gatewayId }, workerToken);
      expect(response.status).toBe(200);
      const body = await response.json() as { job: ClaimedJob | null };
      if (!body.job) break;

      const job = body.job;
      expect(job.kind).toBe("provision");
      const tenant = tenants.find((candidate) => candidate.org.id === job.orgId);
      expect(tenant).toBeDefined();
      expect(job.soul).toContain(tenant!.org.name);
      expect(job.soul).not.toContain(tenants.find((candidate) => candidate.org.id !== job.orgId)!.org.name);
      expect(job.profile).toMatch(/^c-/);
      expect(job.soul).toContain(job.soulChallenge);

      const apiKey = sha256("synthetic-profile-key:" + job.orgId + ":" + job.role);
      profileKeys.set(job.agentId, apiKey);
      const completion = successfulResult(job, apiKey);
      const completed = await postJson(completeRoute, completion, workerToken);
      expect(completed.status).toBe(200);
      expect(await completed.json()).toEqual({ accepted: true, duplicate: false, awaitingHealthCheck: true });

      if (claimed.length === 0) {
        const replay = await postJson(completeRoute, completion, workerToken);
        expect(replay.status).toBe(200);
        expect(await replay.json()).toEqual({ accepted: true, duplicate: true, awaitingHealthCheck: true });
      }
      claimed.push(job);
    }

    const queueState = await withSystem((db) => db.query<{
      org_id: string;
      role_key: string;
      config_status: string | null;
      job_status: string;
    }>(
      "select a.org_id,a.role_key,v.status as config_status,j.status as job_status " +
      "from agent_instances a join agent_provisioning_jobs j on j.agent_instance_id=a.id and j.org_id=a.org_id and j.kind='provision' " +
      "left join agent_config_versions v on v.id=a.active_config_version_id and v.org_id=a.org_id " +
      "where a.org_id=$1 or a.org_id=$2 order by a.org_id,a.role_key",
      [tenantA.org.id, tenantB.org.id],
    ));
    expect(claimed, JSON.stringify(queueState.rows)).toHaveLength(2);
    expect(new Set(claimed.map((job) => job.profile)).size).toBe(2);
    expect(new Set(claimed.map((job) => job.jobId)).size).toBe(2);
    for (const tenant of tenants) {
      const jobs = claimed.filter((job) => job.orgId === tenant.org.id);
      expect(jobs).toHaveLength(1);
      expect(jobs.map((job) => job.role)).toEqual([AI_GROWTH_PARTNER_ROLE_KEY]);
    }

    const provisionState = await withSystem((db) => db.query<{
      org_id: string;
      role_key: string;
      hermes_profile: string | null;
      status: string;
      job_status: string;
      fingerprint: string | null;
    }>(
      "select a.org_id,a.role_key,a.hermes_profile,a.status,j.status as job_status,c.fingerprint " +
      "from agent_instances a join agent_provisioning_jobs j on j.agent_instance_id=a.id and j.org_id=a.org_id and j.kind='provision' " +
      "left join integration_credentials c on c.id=a.credential_id and c.org_id=a.org_id and c.provider='hermes' " +
      "where a.org_id=$1 or a.org_id=$2 order by a.org_id,a.role_key",
      [tenantA.org.id, tenantB.org.id],
    ));
    expect(provisionState.rows).toHaveLength(2);
    expect(provisionState.rows.every((row) =>
      row.hermes_profile?.startsWith("c-") &&
      row.status === "provisioning" &&
      row.job_status === "awaiting_health_check" &&
      Boolean(row.fingerprint),
    )).toBe(true);
    expect(new Set(provisionState.rows.map((row) => row.fingerprint)).size).toBe(2);

    const firstJob = claimed[0];
    const firstTenant = tenants.find((candidate) => candidate.org.id === firstJob.orgId)!;
    const active = await withSystem((db) => db.query<{ settings: unknown }>(
      "select settings from agent_config_versions where id=$1 and org_id=$2 and agent_instance_id=$3",
      [firstJob.configVersionId, firstJob.orgId, firstJob.agentId],
    ));
    const settings = agentSettingsSchema.parse(active.rows[0].settings);
    const updated = await withSystem((db) => createConfigVersion(db, {
      orgId: firstJob.orgId,
      agentId: firstJob.agentId,
      settings: { ...settings, tone: settings.tone === "professional" ? "friendly" : "professional" },
      source: "client_edit",
      actorKind: "user",
      userId: firstTenant.owner.id,
      apply: true,
    }));
    if (updated.status === "pending_agency_review") {
      await withSystem((db) => decideHeldVersion(db, {
        orgId: firstJob.orgId,
        versionId: updated.versionId,
        approve: true,
        agencyUserId: reviewer.id,
        decisionNote: "Reviewed the synthetic tone change and employee scope.",
      }));
    } else {
      expect(updated.status).toBe("applied");
    }

    const syncResponse = await postJson(claimRoute, { gatewayId }, workerToken);
    expect(syncResponse.status).toBe(200);
    const syncBody = await syncResponse.json() as { job: ClaimedJob | null };
    expect(syncBody.job).toMatchObject({
      kind: "sync",
      orgId: firstJob.orgId,
      agentId: firstJob.agentId,
      profile: firstJob.profile,
      sourceProvisionJobId: firstJob.jobId,
      configVersion: firstJob.configVersion + 1,
    });
    const syncJob = syncBody.job!;
    expect(syncJob.soul).not.toBe(firstJob.soul);

    const failedSync = await postJson(completeRoute, {
      ok: false,
      jobId: syncJob.jobId,
      leaseToken: syncJob.leaseToken,
      gatewayId,
      code: "canary_failed_model_endpoint_unreachable",
    }, workerToken);
    expect(failedSync.status).toBe(200);
    expect(await failedSync.json()).toEqual({ accepted: true, failed: true });

    await withSystem((db) => db.query(
      "update agent_provisioning_jobs set next_retry_at=now()-interval '1 second' where id=$1",
      [syncJob.jobId],
    ));
    const retryResponse = await postJson(claimRoute, { gatewayId }, workerToken);
    expect(retryResponse.status).toBe(200);
    const retryBody = await retryResponse.json() as { job: ClaimedJob | null };
    expect(retryBody.job).toMatchObject({
      jobId: syncJob.jobId,
      kind: "sync",
      profile: firstJob.profile,
      configVersionId: updated.versionId,
    });
    const retriedSync = retryBody.job!;
    const synced = await postJson(completeRoute, successfulResult(retriedSync), workerToken);
    expect(synced.status).toBe(200);
    expect(await synced.json()).toEqual({ accepted: true, duplicate: false, awaitingHealthCheck: true });

    const syncReplay = await postJson(completeRoute, successfulResult(retriedSync), workerToken);
    expect(syncReplay.status).toBe(200);
    expect(await syncReplay.json()).toEqual({ accepted: true, duplicate: true, awaitingHealthCheck: true });

    const finalAgent = await withSystem((db) => db.query<{
      status: string;
      active_config_version_id: string;
      hermes_profile_config_version_id: string;
      profile: string;
      credentials: number;
    }>(
      "select a.status,a.active_config_version_id,a.hermes_profile_config_version_id,a.hermes_profile as profile," +
      "(select count(*)::int from integration_credentials c where c.org_id=a.org_id and c.provider='hermes' and c.label='Hermes profile ' || a.hermes_profile and c.revoked_at is null) as credentials " +
      "from agent_instances a where a.id=$1 and a.org_id=$2",
      [firstJob.agentId, firstJob.orgId],
    ));
    expect(finalAgent.rows[0]).toMatchObject({
      status: "provisioning",
      active_config_version_id: updated.versionId,
      hermes_profile_config_version_id: updated.versionId,
      profile: firstJob.profile,
      credentials: 1,
    });

    const audit = await withSystem((db) => db.query<{ metadata: string }>(
      "select metadata::text as metadata from audit_logs where org_id=$1 or org_id=$2",
      [tenantA.org.id, tenantB.org.id],
    ));
    for (const key of profileKeys.values()) {
      expect(audit.rows.every((row) => !row.metadata.includes(key))).toBe(true);
    }
    const reviewAudit = await withSystem((db) => db.query<{ count: number }>(
      "select count(*)::int as count from audit_logs where (org_id=$1 or org_id=$2) and action='agent.config_review_approved'",
      [tenantA.org.id, tenantB.org.id],
    ));
    expect(reviewAudit.rows[0].count).toBeGreaterThanOrEqual(pending.rows.length);
  });

  it("records a worker failure with any code it can raise mid-job: known, dynamic or garbage", async () => {
    const gatewayId = randomUUID();
    const workerToken = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
    vi.stubEnv("HERMES_PROVISIONER_ENABLED", "true");
    vi.stubEnv("HERMES_PROVISIONER_TOKEN", workerToken);
    vi.stubEnv("HERMES_PROVISIONER_GATEWAY_ID", gatewayId);
    resetEnvCache();
    // Jobs are not tied to a gateway until claimed: nothing an earlier test left claimable may be taken here.
    await withSystem((db) => db.query("delete from agent_provisioning_jobs"));

    const org = await createOrg({ name: "Route Codes " + randomUUID().slice(0, 8) });
    await clearSetupPayment(org.id);
    const owner = await createUser();
    await addMember(org.id, owner.id, "owner");
    const agent = await agentId(org.id, "lead_hunter");
    await withSystem(async (db) => {
      await db.query("update organizations set onboarding_completed_at=now() where id=$1", [org.id]);
      await createConfigVersion(db, { orgId: org.id, agentId: agent, settings: defaultSettings("lead_hunter"), source: "onboarding", userId: owner.id, apply: true });
      await db.query("update agent_instances set enabled=false where org_id=$1 and id<>$2", [org.id, agent]);
      await db.query(
        "insert into hermes_gateways (id,label,environment,base_url,gateway_type,status,profile_creation_status,provisioner_isolation_verified_at) " +
        "values ($1,'Synthetic code test runtime','development',$2,'multiplexed_profiles','connected','restricted_service_verified',now())",
        [gatewayId, "https://client-" + gatewayId.replaceAll("-", "") + ".hermes.test"],
      );
    });
    await withSystem((db) => requestProvisioning(db, org.id, owner.id));

    const jobState = async (jobId: string) => (await withSystem((db) => db.query<{ status: string; attempt_count: number; next_retry_at: Date | null; detail: string | null }>(
      "select status,attempt_count,next_retry_at,detail from agent_provisioning_jobs where id=$1", [jobId]))).rows[0];
    const failOnce = async (code: string) => {
      const claimed = await postJson(claimRoute, { gatewayId }, workerToken);
      expect(claimed.status).toBe(200);
      const job = (await claimed.json() as { job: ClaimedJob | null }).job;
      expect(job).not.toBeNull();
      const response = await postJson(completeRoute, { ok: false, jobId: job!.jobId, leaseToken: job!.leaseToken, gatewayId, code }, workerToken);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ accepted: true, failed: true });
      await withSystem((db) => db.query("update agent_provisioning_jobs set next_retry_at=now()-interval '1 second' where id=$1", [job!.jobId]));
      return job!.jobId;
    };

    for (const code of ["profile_gateway_discovery_timeout", "canary_submission_http_409_profile_mismatch"]) {
      const jobId = await failOnce(code);
      const state = await jobState(jobId);
      expect(state.status).toBe("failed");
      expect(state.detail).toContain(code);
      const audit = await withSystem((db) => db.query<{ metadata: { code: string; nextRetryAt: string | null } }>(
        "select metadata from audit_logs where target_id=$1 and action='agent.profile_provisioning_failed' order by id desc limit 1", [jobId]));
      expect(audit.rows[0].metadata.code).toBe(code);
      expect(audit.rows[0].metadata.nextRetryAt).toBeTruthy();
    }

    const garbage = "sk_live_not_a_real_key_but_looks_like_one";
    for (const raw of [garbage, "Not A Code, with spaces!"]) {
      const jobId = await failOnce(raw);
      const state = await jobState(jobId);
      expect(state.detail).toContain("unclassified_worker_failure");
      expect(state.detail).not.toContain(raw);
    }
    const audits = await withSystem((db) => db.query<{ metadata: string }>("select metadata::text as metadata from audit_logs where org_id=$1", [org.id]));
    expect(audits.rows.every((row) => !row.metadata.includes(garbage) && !row.metadata.includes("spaces"))).toBe(true);
    expect(audits.rows.some((row) => row.metadata.includes("unclassified_worker_failure"))).toBe(true);
    // Every one of the four failures was transient or unknown-permanent; the first two gave their attempt back, the unknown ones spent theirs.
    const finalState = await withSystem((db) => db.query<{ status: string; attempt_count: number }>("select status,attempt_count from agent_provisioning_jobs where org_id=$1", [org.id]));
    expect(finalState.rows).toEqual([{ status: "failed", attempt_count: 2 }]);
    await withSystem((db) => db.query("delete from agent_provisioning_jobs where org_id=$1", [org.id]));
  });
});
