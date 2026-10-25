import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as claimRoute } from "@/app/api/internal/hermes-provisioner/claim/route";
import { POST as completeRoute } from "@/app/api/internal/hermes-provisioner/complete/route";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { agentSettingsSchema } from "@/lib/agent-settings";
import { resetEnvCache } from "@/server/env";
import { withSystem } from "@/server/db";
import { saveOnboardingStep, submitOnboarding } from "@/server/onboarding/service";
import { createConfigVersion, decideHeldVersion } from "@/server/workforce/service";
import { addMember, agentId, createOrg, createUser, ctxFor } from "./support/fixtures";

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

function generatedPreferences(role: AgentRoleKey) {
  return {
    personality: `Synthetic AI-personalized ${role} employee who works carefully and reliably.`,
    characterTraits: `Careful, accurate, and focused on ${role} responsibilities.`,
    communicationStyle: `Use clear, calm language suited to the ${role} role.`,
    responseBehavior: "Separate confirmed details from uncertainty and ask when facts are missing.",
    operatingProcedures: "Follow confirmed business details and protected role procedures before acting.",
    proactiveResponsibilities: "Surface work only when an authorized request, schedule, or trigger exists.",
    reportingBehavior: "Report verified findings, limitations, and a useful next step.",
    responsibilities: `Support the ${role} function using only approved company context.`,
    goals: `Help the owner reach selected goals through accurate ${role} work.`,
  };
}

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
  const org = await createOrg({ name });
  const owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  const ctx = ctxFor(owner, org, "owner");
  const answers = {
    "a.business_name": name,
    "a.industry": "home_services",
    "a.business_model": "local",
    "a.description": description,
    "a.timezone": "America/Chicago",
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
  expect(outcome.employees).toHaveLength(6);
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
    hermesVersion: "hermes v0.22.3 synthetic route acceptance",
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
    llm.reply = { ok: true, text: JSON.stringify(Object.fromEntries(AGENT_ROLE_KEYS.map((role) => [role, generatedPreferences(role)]))) };

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
    expect(llm.calls).toBe(2);

    const reviewer = await createUser({ platformRole: "agency_super_admin" });
    const audienceAgentId = await agentId(tenantA.org.id, "lead_hunter");
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
    expect((await submitOnboarding(tenantA.ctx)).employees).toHaveLength(6);
    expect(llm.calls).toBe(2);

    const latestAudienceConfig = await withSystem((db) => db.query<{ settings: unknown; source: string }>(
      "select v.settings,v.source from agent_config_versions v where v.agent_instance_id=$1 and v.org_id=$2 order by v.version desc limit 1",
      [audienceAgentId, tenantA.org.id],
    ));
    expect(latestAudienceConfig.rows).toHaveLength(1);
    expect(latestAudienceConfig.rows[0].source).toBe("onboarding");
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
      role_key: AgentRoleKey;
      settings: unknown;
      compiled_instructions: string;
    }>(
      "select a.org_id,a.role_key,v.settings,v.compiled_instructions from agent_instances a " +
      "join agent_config_versions v on v.id=a.active_config_version_id and v.org_id=a.org_id " +
      "where a.org_id=$1 or a.org_id=$2 order by a.org_id,a.role_key",
      [tenantA.org.id, tenantB.org.id],
    ));
    expect(generatedConfigs.rows).toHaveLength(12);
    for (const row of generatedConfigs.rows) {
      const settings = agentSettingsSchema.parse(row.settings);
      const expected = generatedPreferences(row.role_key);
      for (const field of [
        "personality", "characterTraits", "communicationStyle", "responseBehavior", "operatingProcedures",
        "proactiveResponsibilities", "reportingBehavior", "responsibilities", "goals",
      ] as const) {
        expect(settings[field]).toBe(expected[field]);
      }
      expect(row.compiled_instructions).toContain(settings.personality);
      expect(row.compiled_instructions).toContain(row.org_id === tenantA.org.id ? tenantA.org.name : tenantB.org.name);
      if (row.org_id === tenantA.org.id && row.role_key === "lead_hunter") {
        expect(settings.targetCustomers).toBe("Owner-approved independent roof specialists");
      }
    }

    const unauthorized = await postJson(claimRoute, { gatewayId });
    expect(unauthorized.status).toBe(401);

    const wrongGateway = await postJson(claimRoute, { gatewayId: randomUUID() }, workerToken);
    expect(wrongGateway.status).toBe(403);

    vi.stubEnv("HERMES_PROVISIONER_ENABLED", "false");
    resetEnvCache();
    const disabled = await postJson(claimRoute, { gatewayId }, workerToken);
    expect(disabled.status).toBe(503);
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
    expect(claimed, JSON.stringify(queueState.rows)).toHaveLength(12);
    expect(new Set(claimed.map((job) => job.profile)).size).toBe(12);
    expect(new Set(claimed.map((job) => job.jobId)).size).toBe(12);
    for (const tenant of tenants) {
      const jobs = claimed.filter((job) => job.orgId === tenant.org.id);
      expect(jobs).toHaveLength(6);
      expect(jobs.map((job) => job.role).sort()).toEqual([...AGENT_ROLE_KEYS].sort());
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
    expect(provisionState.rows).toHaveLength(12);
    expect(provisionState.rows.every((row) =>
      row.hermes_profile?.startsWith("c-") &&
      row.status === "provisioning" &&
      row.job_status === "awaiting_health_check" &&
      Boolean(row.fingerprint),
    )).toBe(true);
    expect(new Set(provisionState.rows.map((row) => row.fingerprint)).size).toBe(12);

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
});
