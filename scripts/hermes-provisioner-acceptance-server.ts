import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import {
  safeAcceptanceSeedErrorCode,
  safeAcceptanceSeedStage,
  safeStartupFailureCode,
} from "./hermes-provisioner-acceptance-diagnostics";

const reportStartupFailure = (reason: unknown): never => {
  process.stderr.write(`PORTAL_ACCEPTANCE_STARTUP_FAILURE=${safeStartupFailureCode(reason)}\n`);
  process.exit(1);
};

process.once("uncaughtException", reportStartupFailure);
process.once("unhandledRejection", reportStartupFailure);

const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("acceptance_fixture_missing");
  return value;
};

const readSecret = (name: string) => readFileSync(required(name), "utf8").trim();
const gatewayId = required("HERMES_PROVISIONER_GATEWAY_ID");
const provisionerToken = readSecret("HERMES_PROVISIONER_TOKEN_FILE");
const adminToken = readSecret("PORTAL_ACCEPTANCE_ADMIN_TOKEN_FILE");
process.env.HERMES_PROVISIONER_ENABLED = "true";
process.env.HERMES_PROVISIONER_TOKEN = provisionerToken;
if (process.env.NODE_ENV !== "test") throw new Error("acceptance_test_environment_required");
process.env.AUTH_PROVIDER = "local";
process.env.SECRET_STORE = "test-memory";
process.env.DATABASE_DRIVER = "pglite-memory";

const [
  claimRouteModule,
  completeRouteModule,
  dbModule,
  onboardingModule,
  workforceModule,
  credentialsModule,
  fixtureModule,
  settingsModule,
] = await Promise.all([
  import("@/app/api/internal/hermes-provisioner/claim/route"),
  import("@/app/api/internal/hermes-provisioner/complete/route"),
  import("@/server/db"),
  import("@/server/onboarding/service"),
  import("@/server/workforce/service"),
  import("@/server/security/credentials"),
  import("../tests/support/fixtures"),
  import("@/lib/agent-settings"),
]);

type RouteHandler = (request: Request) => Promise<Response>;
type Tenant = {
  orgId: string;
  name: string;
  ownerId: string;
  ownerEmail: string;
};

const claimRoute: RouteHandler = claimRouteModule.POST;
const completeRoute: RouteHandler = completeRouteModule.POST;
const state: {
  tenants: Tenant[];
  reviewerId: string | null;
  duplicateReplayDone: boolean;
  duplicateCallbackReplays: number;
  syncVersionId: string | null;
  syncAgentId: string | null;
} = {
  tenants: [],
  reviewerId: null,
  duplicateReplayDone: false,
  duplicateCallbackReplays: 0,
  syncVersionId: null,
  syncAgentId: null,
};

class AcceptanceSeedError extends Error {
  constructor(readonly stage: string, readonly code: string) {
    super("acceptance_seed_failed");
  }
}

async function inSeedStage<T>(stage: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (reason) {
    throw new AcceptanceSeedError(safeAcceptanceSeedStage(stage), safeAcceptanceSeedErrorCode(reason));
  }
}

const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    Pragma: "no-cache",
  });
  res.end(text);
};

function secureMatch(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from("Bearer " + expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req: import("node:http").IncomingMessage, maxBytes = 256_000): Promise<Buffer> {
  const length = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(length) && length > maxBytes) throw new Error("acceptance_body_too_large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > maxBytes) throw new Error("acceptance_body_too_large");
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function requestHeaders(req: import("node:http").IncomingMessage): Headers {
  const headers = new Headers();
  for (const name of ["authorization", "content-type"]) {
    const value = req.headers[name];
    if (typeof value === "string") headers.set(name, value);
  }
  return headers;
}

function webRequest(req: import("node:http").IncomingMessage, path: string, body: Buffer): Request {
  const method = req.method ?? "GET";
  const init: RequestInit = {
    method,
    headers: requestHeaders(req),
  };
  if (method !== "GET" && method !== "HEAD") init.body = new Uint8Array(body) as unknown as BodyInit;
  return new Request("https://portal-acceptance" + path, init);
}

async function copyWebResponse(response: Response, res: import("node:http").ServerResponse) {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    if (!["connection", "content-length", "transfer-encoding"].includes(key.toLowerCase())) headers[key] = value;
  });
  const body = Buffer.from(await response.arrayBuffer());
  res.writeHead(response.status, { ...headers, "Content-Length": body.length });
  res.end(body);
}

async function approveHeldConfigs(orgIds: string[], reviewerId: string) {
  const { rows } = await dbModule.withSystem((db) => db.query<{ id: string; org_id: string }>(
    "select id,org_id from agent_config_versions " +
    "where (org_id=$1 or org_id=$2) and status='pending_agency_review' and source='onboarding'",
    orgIds,
  ));
  for (const version of rows) {
    await dbModule.withSystem((db) => workforceModule.decideHeldVersion(db, {
      orgId: version.org_id,
      versionId: version.id,
      approve: true,
      agencyUserId: reviewerId,
      decisionNote: "Reviewed synthetic configuration and protected role boundaries.",
    }));
  }
  return rows.length;
}

async function onboardSyntheticClient(name: string, description: string, service: string, customers: string) {
  const org = await fixtureModule.createOrg({ name });
  const owner = await fixtureModule.createUser();
  await fixtureModule.addMember(org.id, owner.id, "owner");
  const ctx = fixtureModule.ctxFor(owner, org, "owner");
  const answers = {
    "a.business_name": name,
    "a.industry": "home_services",
    "a.business_model": "local",
    "a.description": description,
    "a.timezone": "America/Chicago",
    "a.contact_email": owner.email,
    "a.territories": "Austin, Texas",
    "a.target_customers": customers,
    "b.goals": ["more_leads", "more_appointments"],
    "b.services": service,
    "b.ideal_customer": customers,
    "b.appointments": true,
    "b.website_need": "have",
    "d.pricing_policy": "never",
    "f.review": true,
  };
  const saved = await onboardingModule.saveOnboardingStep(ctx, {
    answers: Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, { value }])),
    currentQuestionId: "f.review",
  });
  if (Object.keys(saved.rejected).length) throw new Error("acceptance_onboarding_answers_rejected");
  const outcome = await onboardingModule.submitOnboarding(ctx);
  if (outcome.employees.length !== 6) throw new Error("acceptance_employee_count_mismatch");
  return { org, owner };
}

function safeGatewayUrl(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("acceptance_gateway_url_invalid");
  const url = new URL(raw);
  if (url.protocol !== "http:" || url.hostname !== "hermes-client" || url.port !== "8642" ||
      url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("acceptance_gateway_url_invalid");
  }
  return url.origin;
}

async function seed(body: unknown) {
  const { gatewayBaseUrl } = await inSeedStage("seed_validation", async () => {
    if (state.tenants.length) throw new Error("acceptance_already_seeded");
    if (!body || typeof body !== "object" || !("gatewayBaseUrl" in body)) throw new Error("acceptance_seed_invalid");
    return { gatewayBaseUrl: safeGatewayUrl((body as { gatewayBaseUrl: unknown }).gatewayBaseUrl) };
  });
  const tenantOne = await inSeedStage("tenant_one_onboarding", () => onboardSyntheticClient(
    "Stonepath Roofing " + cryptoLabel(),
    "Repairs residential roofs after local storm damage.",
    "Roof repair and inspection",
    "Austin homeowners",
  ));
  const tenantTwo = await inSeedStage("tenant_two_onboarding", () => onboardSyntheticClient(
    "Lakeview Plumbing " + cryptoLabel(),
    "Repairs plumbing systems for homes and small businesses.",
    "Pipe repair and drain cleaning",
    "Austin property owners",
  ));
  const reviewer = await inSeedStage("reviewer_creation", () => fixtureModule.createUser({ platformRole: "agency_super_admin" }));
  const orgIds = [tenantOne.org.id, tenantTwo.org.id];
  await inSeedStage("gateway_registration", () => dbModule.withSystem((db) => db.query(
    "insert into hermes_gateways (id,label,environment,base_url,gateway_type,status,profile_creation_status,provisioner_isolation_verified_at) " +
    "values ($1,'Synthetic client-only acceptance runtime','development',$2,'multiplexed_profiles','connected','restricted_service_verified',now())",
    [gatewayId, gatewayBaseUrl],
  )));
  const heldReviewsApproved = await inSeedStage("held_config_review", () => approveHeldConfigs(orgIds, reviewer.id));
  const requestedJobs = await inSeedStage("provisioning_validation", async () => {
    const readyConfigs = await dbModule.withSystem((db) => db.query<{ count: number }>(
      "select count(*)::int as count from agent_instances a " +
      "join agent_config_versions v on v.id=a.active_config_version_id and v.org_id=a.org_id and v.agent_instance_id=a.id " +
      "where (a.org_id=$1 or a.org_id=$2) and a.enabled and v.status='applied' and v.applied_at is not null",
      orgIds,
    ));
    const requestedJobs = await dbModule.withSystem((db) => db.query<{ count: number }>(
      "select count(*)::int as count from agent_provisioning_jobs where (org_id=$1 or org_id=$2) and kind='provision' and status='requested'",
      orgIds,
    ));
    if (readyConfigs.rows[0]?.count !== 12 || requestedJobs.rows[0]?.count !== 12) {
      throw new Error("acceptance_onboarding_not_provisionable");
    }
    return requestedJobs;
  });
  state.tenants = [
    { orgId: tenantOne.org.id, name: tenantOne.org.name, ownerId: tenantOne.owner.id, ownerEmail: tenantOne.owner.email },
    { orgId: tenantTwo.org.id, name: tenantTwo.org.name, ownerId: tenantTwo.owner.id, ownerEmail: tenantTwo.owner.email },
  ];
  state.reviewerId = reviewer.id;
  return { createdTenants: 2, rolesPerTenant: 6, requestedProvisionJobs: requestedJobs.rows[0].count, heldReviewsApproved };
}

function cryptoLabel() {
  return createHash("sha256").update(String(Date.now()) + Math.random()).digest("hex").slice(0, 8);
}

async function readStatus() {
  if (!state.tenants.length) return { seeded: false };
  const orgIds = state.tenants.map((tenant) => tenant.orgId);
  const { rows: agents } = await dbModule.withSystem((db) => db.query<{
    id: string;
    org_id: string;
    role_key: string;
    status: string;
    hermes_profile: string | null;
    active_config_version_id: string | null;
    hermes_profile_config_version_id: string | null;
    provision_status: string | null;
    sync_status: string | null;
  }>(
    "select a.id,a.org_id,a.role_key,a.status,a.hermes_profile,a.active_config_version_id,a.hermes_profile_config_version_id," +
    "(select j.status from agent_provisioning_jobs j where j.agent_instance_id=a.id and j.org_id=a.org_id and j.kind='provision' order by j.created_at desc limit 1) as provision_status," +
    "(select j.status from agent_provisioning_jobs j where j.agent_instance_id=a.id and j.org_id=a.org_id and j.kind='sync' order by j.created_at desc limit 1) as sync_status " +
    "from agent_instances a where a.org_id=$1 or a.org_id=$2 order by a.org_id,a.role_key",
    orgIds,
  ));
  const mappedProfiles = agents.filter((agent) => Boolean(agent.hermes_profile)).length;
  const latestJobs = await dbModule.withSystem((db) => db.query<{ kind: string; status: string }>(
    "select kind,status from agent_provisioning_jobs where org_id=$1 or org_id=$2",
    orgIds,
  ));
  const jobs = latestJobs.rows;
  return {
    seeded: true,
    tenants: 2,
    employees: agents.length,
    mappedProfiles,
    onlineEmployees: agents.filter((agent) => agent.status === "online").length,
    provisioningEmployees: agents.filter((agent) => agent.status === "provisioning").length,
    provisionRequested: jobs.filter((job) => job.kind === "provision" && job.status === "requested").length,
    provisionInProgress: jobs.filter((job) => job.kind === "provision" && job.status === "in_progress").length,
    provisionAwaitingHealthCheck: jobs.filter((job) => job.kind === "provision" && job.status === "awaiting_health_check").length,
    provisionSucceeded: jobs.filter((job) => job.kind === "provision" && job.status === "succeeded").length,
    syncRequested: jobs.filter((job) => job.kind === "sync" && job.status === "requested").length,
    syncInProgress: jobs.filter((job) => job.kind === "sync" && job.status === "in_progress").length,
    syncAwaitingHealthCheck: jobs.filter((job) => job.kind === "sync" && job.status === "awaiting_health_check").length,
    syncSucceeded: jobs.filter((job) => job.kind === "sync" && job.status === "succeeded").length,
    failedJobs: jobs.filter((job) => job.status === "failed").length,
    profileVersionsMatch: agents.filter((agent) => agent.hermes_profile_config_version_id === agent.active_config_version_id).length,
    duplicateCallbackReplays: state.duplicateCallbackReplays,
    syncVersionCreated: Boolean(state.syncVersionId),
  };
}

async function runHealthChecks() {
  if (!state.reviewerId) throw new Error("acceptance_not_seeded");
  const orgIds = state.tenants.map((tenant) => tenant.orgId);
  const { rows: agents } = await dbModule.withSystem((db) => db.query<{ id: string }>(
    "select id from agent_instances where org_id=$1 or org_id=$2 order by org_id,role_key",
    orgIds,
  ));
  const results: Array<{ ok: boolean; status: string }> = [];
  for (const agent of agents) {
    try {
      const result = await workforceModule.runHealthCheck(agent.id, { userId: state.reviewerId, kind: "agency" });
      results.push({ ok: result.ok, status: result.status });
    } catch {
      results.push({ ok: false, status: "check_failed" });
    }
  }
  const counts = results.reduce<Record<string, number>>((out, item) => {
    out[item.status] = (out[item.status] ?? 0) + 1;
    return out;
  }, {});
  return { checked: results.length, online: counts.online ?? 0, statusCounts: counts };
}

async function createSync() {
  if (!state.reviewerId || state.syncVersionId) throw new Error("acceptance_sync_state_invalid");
  const online = await readStatus();
  if (online.onlineEmployees !== 12) throw new Error("acceptance_health_gate_not_met");
  const tenant = state.tenants[0];
  const { rows } = await dbModule.withSystem((db) => db.query<{ id: string; settings: unknown; role_key: string }>(
    "select a.id,v.settings,a.role_key from agent_instances a " +
    "join agent_config_versions v on v.id=a.active_config_version_id and v.org_id=a.org_id and v.agent_instance_id=a.id " +
    "where a.org_id=$1 and a.hermes_profile is not null order by a.role_key limit 1",
    [tenant.orgId],
  ));
  const agent = rows[0];
  if (!agent) throw new Error("acceptance_sync_agent_missing");
  const settings = settingsModule.agentSettingsSchema.parse(agent.settings);
  const update = await dbModule.withSystem((db) => workforceModule.createConfigVersion(db, {
    orgId: tenant.orgId,
    agentId: agent.id,
    settings: { ...settings, tone: settings.tone === "professional" ? "friendly" : "professional" },
    source: "client_edit",
    actorKind: "user",
    userId: tenant.ownerId,
    apply: true,
  }));
  if (update.status === "pending_agency_review") {
    await dbModule.withSystem((db) => workforceModule.decideHeldVersion(db, {
      orgId: tenant.orgId,
      versionId: update.versionId,
      approve: true,
      agencyUserId: state.reviewerId!,
      decisionNote: "Reviewed the synthetic tone change and employee scope.",
    }));
  } else if (update.status !== "applied") {
    throw new Error("acceptance_sync_config_not_applied");
  }
  state.syncVersionId = update.versionId;
  state.syncAgentId = agent.id;
  return { accepted: true, syncQueued: true, configVersion: update.version };
}

async function runtimeEvidence() {
  if (!state.tenants.length) throw new Error("acceptance_not_seeded");
  const tenants = new Map(state.tenants.map((tenant) => [tenant.orgId, tenant]));
  const { rows } = await dbModule.withSystem((db) => db.query<{
    id: string;
    org_id: string;
    org_name: string;
    role_key: string;
    status: string;
    profile: string;
    credential_id: string | null;
    active_config_version_id: string | null;
    hermes_profile_config_version_id: string | null;
    job_id: string;
    job_kind: string;
    source_job_id: string | null;
    config_version_id: string | null;
    manifest_soul_sha256: string | null;
    manifest_policy_config_sha256: string | null;
    result_reference: string | null;
  }>(
    "select a.id,a.org_id,o.name as org_name,a.role_key,a.status,a.hermes_profile as profile,a.credential_id," +
    "a.active_config_version_id,a.hermes_profile_config_version_id,j.id as job_id,j.kind as job_kind," +
    "j.source_job_id,j.config_version_id,j.manifest_soul_sha256,j.manifest_policy_config_sha256,j.result_reference " +
    "from agent_instances a join organizations o on o.id=a.org_id " +
    "join lateral (select p.id,p.kind,p.source_job_id,p.config_version_id,p.manifest_soul_sha256,p.manifest_policy_config_sha256,p.result_reference " +
    "from agent_provisioning_jobs p where p.agent_instance_id=a.id and p.org_id=a.org_id and p.kind in ('provision','sync') " +
    "order by case when p.kind='sync' then 0 else 1 end,p.created_at desc limit 1) j on true " +
    "where a.org_id=$1 or a.org_id=$2 order by a.org_id,a.role_key",
    [state.tenants[0].orgId, state.tenants[1].orgId],
  ));
  const evidence = [];
  for (const row of rows) {
    const tenant = tenants.get(row.org_id);
    const other = state.tenants.find((candidate) => candidate.orgId !== row.org_id);
    const secret = row.credential_id
      ? await dbModule.withSystem((db) => credentialsModule.resolveCredential(db, row.credential_id!, row.org_id, "hermes"))
      : null;
    const reference = row.result_reference?.split(":") ?? [];
    evidence.push({
      orgId: row.org_id,
      orgName: tenant?.name ?? row.org_name,
      otherOrgName: other?.name ?? "",
      agentId: row.id,
      role: row.role_key,
      profile: row.profile,
      status: row.status,
      gatewayId,
      credentialIdPresent: Boolean(row.credential_id),
      apiKeySha256: secret ? createHash("sha256").update(secret, "utf8").digest("hex") : null,
      activeConfigVersionId: row.active_config_version_id,
      profileConfigVersionId: row.hermes_profile_config_version_id,
      jobId: row.job_id,
      jobKind: row.job_kind,
      sourceProvisionJobId: row.source_job_id ?? row.job_id,
      configVersionId: row.config_version_id,
      soulSha256: row.manifest_soul_sha256,
      policyConfigSha256: row.manifest_policy_config_sha256,
      effectiveConfigSha256: reference.length === 7 && reference[0] === "provisioner" && reference[1] === "v1"
        ? reference[5]
        : null,
    });
  }
  return { profiles: evidence, duplicateCallbackReplays: state.duplicateCallbackReplays };
}

async function requestBody(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
  try {
    return await readBody(req);
  } catch {
    json(res, 413, { error: "invalid_body" });
    return null;
  }
}

const cert = readFileSync(required("PORTAL_ACCEPTANCE_CERT_FILE"));
const key = readFileSync(required("PORTAL_ACCEPTANCE_KEY_FILE"));
const port = Number(process.env.PORTAL_ACCEPTANCE_PORT ?? "18444");
const host = process.env.PORTAL_ACCEPTANCE_HOST ?? "0.0.0.0";

const server = createServer({ cert, key }, async (req, res) => {
  try {
    const path = new URL(req.url ?? "/", "https://portal-acceptance").pathname;
    if (req.method === "GET" && path === "/healthz") return json(res, 200, { ok: true });

    const isAcceptanceRoute = path.startsWith("/__acceptance/");
    if (isAcceptanceRoute && !secureMatch(req.headers.authorization, adminToken)) {
      return json(res, 401, { error: "unauthorized" });
    }
    if (req.method === "GET" && path === "/__acceptance/status") return json(res, 200, await readStatus());
    if (req.method === "GET" && path === "/__acceptance/runtime-evidence") return json(res, 200, await runtimeEvidence());

    if (req.method === "POST") {
      const body = await requestBody(req, res);
      if (!body) return;
      if (path === "/__acceptance/seed") {
        let parsed: unknown;
        try { parsed = JSON.parse(body.toString("utf8")); } catch { return json(res, 400, { error: "invalid_json" }); }
        try {
          return json(res, 200, await seed(parsed));
        } catch (reason) {
          if (reason instanceof AcceptanceSeedError) {
            return json(res, 500, { error: "acceptance_seed_failed", stage: reason.stage, code: reason.code });
          }
          throw reason;
        }
      }
      if (path === "/__acceptance/health-check") return json(res, 200, await runHealthChecks());
      if (path === "/__acceptance/sync") return json(res, 200, await createSync());

      if (path === "/api/internal/hermes-provisioner/claim") {
        return copyWebResponse(await claimRoute(webRequest(req, path, body)), res);
      }
      if (path === "/api/internal/hermes-provisioner/complete") {
        const request = webRequest(req, path, body);
        const response = await completeRoute(request);
        if (!state.duplicateReplayDone && response.status === 200) {
          const result = await response.clone().json().catch(() => null) as { accepted?: boolean; duplicate?: boolean } | null;
          let successBody: unknown = null;
          try { successBody = JSON.parse(body.toString("utf8")); } catch { /* route already returned a safe response */ }
          if (result?.accepted === true && result.duplicate === false &&
              successBody && typeof successBody === "object" && (successBody as { ok?: unknown }).ok === true) {
            state.duplicateReplayDone = true;
            const headers = requestHeaders(req);
            const replayRequest = new Request("https://portal-acceptance" + path, {
              method: "POST",
              headers,
              body: new Uint8Array(body) as unknown as BodyInit,
            });
            const replay = await completeRoute(replayRequest);
            const replayResult = await replay.json().catch(() => null) as { duplicate?: boolean } | null;
            if (replay.status === 200 && replayResult?.duplicate === true) state.duplicateCallbackReplays += 1;
          }
        }
        return copyWebResponse(response, res);
      }
    }
    return json(res, 404, { error: "not_found" });
  } catch {
    return json(res, 500, { error: "acceptance_request_failed" });
  }
});

server.requestTimeout = 0;
server.headersTimeout = 30_000;
server.listen(port, host, () => {
  process.stdout.write("PORTAL_ACCEPTANCE_READY\n");
});

server.on("clientError", (_error, socket) => {
  socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
});
