import "server-only";
import { withServiceRole, withSystem, withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { resolveCredential, saveCredential } from "@/server/security/credentials";
import { validateIntegrationEndpoint } from "@/server/integrations/safety";
import { loadHermesAccessCredentials } from "@/server/integrations/hermes/gateways";
import { AGENT_BY_KEY, AGENT_ROLE_KEYS, AGENCY_HERMES_PROFILE_IDS, isAgentRoleKey, type AgentRoleKey, type AgentStatus } from "@/lib/agents";
import { agentSettingsSchema, aiPreferencesSchema, type AgentSettings } from "@/lib/agent-settings";
import { compileAgentConfig, defaultSettings, type CompanyContext } from "@/server/workforce/compiler";
import { getCapabilities, getToolsets, getProfileModels, HermesError, restrictedToolsIn, hasVerifiedCompleteToolInventory, type HermesConnection } from "@/server/integrations/hermes/client";
import { notifyOrgRoles } from "@/server/notifications";
import { employeeKnowledgeContext } from "@/server/workforce/knowledge";

export interface AgentInstanceRow {
  id: string;
  org_id: string;
  role_key: AgentRoleKey;
  display_name: string;
  enabled: boolean;
  status: AgentStatus;
  mode: "autonomous" | "approval_required" | "paused";
  active_config_version_id: string | null;
  last_health_check_at: Date | null;
  last_health_ok: boolean | null;
  last_health_detail: string | null;
  default_tools: string[];
  summary: string | null;
  config_version: number | null;
  config_applied_at: Date | null;
  hermes_profile: string | null;
  hermes_base_url: string | null;
}

const RESERVED_PROFILES = new Set([
  "default",
  "iacquire-operations-manager",
  "iacquire-lead-hunter",
  "iacquire-appointment-setter",
  "iacquire-sales-assistant",
  "iacquire-crm-manager",
  "iacquire-analyst",
]);

export function isReservedProfile(profile: string) {
  return RESERVED_PROFILES.has(profile) || profile.startsWith("iacquire-");
}

/** Suggested per-tenant profile name, e.g. "c-acme-dental-lead-hunter". */
export function suggestedProfileName(orgSlug: string, role: AgentRoleKey) {
  return `c-${orgSlug}-${role.replace(/_/g, "-")}`.slice(0, 63).replace(/-+$/, "");
}

export async function ensureAgentInstances(orgId: string, db: Queryable) {
  for (const key of AGENT_ROLE_KEYS) {
    await db.query(
      `insert into agent_instances (org_id, role_key, display_name) values ($1, $2, $3)
       on conflict (org_id, role_key) do nothing`,
      [orgId, key, AGENT_BY_KEY[key].shortName],
    );
  }
}

const AGENT_SELECT = `
  select a.id, a.org_id, a.role_key, a.display_name, a.enabled, a.status, a.mode, a.active_config_version_id,
         a.last_health_check_at, a.last_health_ok, a.last_health_detail, a.hermes_profile, a.hermes_base_url, r.default_tools,
         v.summary, v.version as config_version, v.applied_at as config_applied_at
  from agent_instances a
  join agent_roles r on r.key = a.role_key
  left join agent_config_versions v on v.id = a.active_config_version_id`;

export async function listAgents(userId: string, orgId: string): Promise<AgentInstanceRow[]> {
  return withUser(userId, async (db) => {
    const { rows } = await db.query<AgentInstanceRow>(`${AGENT_SELECT} where a.org_id = $1 order by r.sort_order`, [orgId]);
    return rows;
  });
}

export async function getAgentByRole(userId: string, orgId: string, role: AgentRoleKey): Promise<AgentInstanceRow | null> {
  return withUser(userId, async (db) => {
    const { rows } = await db.query<AgentInstanceRow>(`${AGENT_SELECT} where a.org_id = $1 and a.role_key = $2`, [orgId, role]);
    return rows[0] ?? null;
  });
}

export async function listConfigVersions(userId: string, agentId: string) {
  return withUser(userId, async (db) => {
    const { rows } = await db.query<{
      id: string;
      version: number;
      summary: string;
      status: string;
      source: string;
      change_request: string | null;
      risk_flags: string[];
      created_at: Date;
      applied_at: Date | null;
      settings: AgentSettings;
      created_by_name: string | null;
    }>(
      `select v.id, v.version, v.summary, v.status, v.source, v.change_request, v.risk_flags, v.created_at,
              v.applied_at, v.settings, u.full_name as created_by_name
       from agent_config_versions v left join users u on u.id = v.created_by
       where v.agent_instance_id = $1 order by v.version desc limit 50`,
      [agentId],
    );
    return rows;
  });
}

// ---------------------------------------------------------------------------
// Configuration versions
// ---------------------------------------------------------------------------

export async function loadCompanyContext(db: Queryable, orgId: string): Promise<CompanyContext> {
  const { rows } = await db.query<{
    name: string;
    industry: string | null;
    website: string | null;
    description: string | null;
    services: string | null;
    ideal_customers: string | null;
    operating_area: string | null;
    goals: string[] | null;
  }>(
    `select o.name, o.industry, o.website, p.description, p.services, p.ideal_customers, p.operating_area, p.goals
     from organizations o left join company_profiles p on p.org_id = o.id where o.id = $1`,
    [orgId],
  );
  const r = rows[0];
  if (!r) throw new AppError("not_found", "Workspace not found.");
  return {
    companyName: r.name,
    industry: r.industry ?? "",
    website: r.website ?? "",
    description: r.description ?? "",
    services: r.services ?? "",
    idealCustomers: r.ideal_customers ?? "",
    operatingArea: r.operating_area ?? "",
    goals: r.goals ?? [],
  };
}

export async function currentSettings(db: Queryable, agentId: string, orgId: string): Promise<{ role: AgentRoleKey; settings: AgentSettings; tools: string[] }> {
  const { rows } = await db.query<{ role_key: AgentRoleKey; settings: AgentSettings | null; default_tools: string[]; ai_preferences: unknown }>(
    `select a.role_key, v.settings, r.default_tools, p.ai_preferences
     from agent_instances a join agent_roles r on r.key = a.role_key
     left join agent_config_versions v on v.id = a.active_config_version_id
     left join company_profiles p on p.org_id = a.org_id
     where a.id = $1 and a.org_id = $2`,
    [agentId, orgId],
  );
  const r = rows[0];
  if (!r) throw new AppError("not_found", "AI employee not found.");
  const prefs = aiPreferencesSchema.safeParse(r.ai_preferences ?? {});
  const settings = r.settings ? agentSettingsSchema.parse(r.settings) : defaultSettings(r.role_key, prefs.success ? prefs.data : undefined);
  return { role: r.role_key, settings, tools: r.default_tools };
}

/**
 * Creates a new configuration version. Versions whose client text looks like an attempt to
 * override policy are held for agency review instead of being applied.
 */
export async function createConfigVersion(
  db: Queryable,
  input: {
    orgId: string;
    agentId: string;
    settings: AgentSettings;
    source: "onboarding" | "client_edit" | "change_request" | "rollback" | "agency";
    changeRequest?: string;
    userId: string | null;
    apply: boolean;
  },
) {
  const { rows: agentRows } = await db.query<{ role_key: string; default_tools: string[] }>(
    "select a.role_key, r.default_tools from agent_instances a join agent_roles r on r.key = a.role_key where a.id = $1 and a.org_id = $2",
    [input.agentId, input.orgId],
  );
  const agent = agentRows[0];
  if (!agent || !isAgentRoleKey(agent.role_key)) throw new AppError("not_found", "AI employee not found.");
  // Clients may only disable tools from their role's default set.
  const settings = agentSettingsSchema.parse({
    ...input.settings,
    disabledTools: input.settings.disabledTools.filter((t) => agent.default_tools.includes(t)),
  });
  const { rows: vrows } = await db.query<{ next: number }>(
    "select coalesce(max(version), 0) + 1 as next from agent_config_versions where agent_instance_id = $1",
    [input.agentId],
  );
  const version = Number(vrows[0].next);
  const compiled = compileAgentConfig({
    role: agent.role_key,
    settings,
    company: await loadCompanyContext(db, input.orgId),
    version,
    allowedTools: agent.default_tools,
  });
  const held = compiled.riskFlags.length > 0;
  const status = held ? "pending_agency_review" : input.apply ? "applied" : "draft";
  const { rows } = await db.query<{ id: string }>(
    `insert into agent_config_versions (org_id, agent_instance_id, version, settings, summary, compiled_instructions,
       policy_version, risk_flags, source, change_request, status, created_by, applied_at, decided_by, decided_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
       case when $11 = 'applied' then now() end, case when $11 = 'applied' then $12::uuid end, case when $11 = 'applied' then now() end)
     returning id`,
    [
      input.orgId, input.agentId, version, JSON.stringify(compiled.settings), compiled.summary, compiled.instructions,
      compiled.policyVersion, compiled.riskFlags, input.source, input.changeRequest ?? null, status, input.userId,
    ],
  );
  const versionId = rows[0].id;
  if (status === "applied") await activateVersion(db, input.orgId, input.agentId, versionId, compiled.settings.displayName);
  await recordAudit(
    {
      orgId: input.orgId,
      actorUserId: input.userId,
      actorKind: input.source === "agency" ? "agency" : "user",
      agentInstanceId: input.agentId,
      action: "agent.config_version_created",
      targetType: "agent_config_version",
      targetId: versionId,
      result: "success",
      metadata: { version, status, source: input.source, riskFlags: compiled.riskFlags },
    },
    db,
  );
  if (held) {
    await notifyOrgRoles(db, input.orgId, ["owner", "admin"], {
      kind: "agent_status",
      severity: "warning",
      title: `${AGENT_BY_KEY[agent.role_key].shortName} update is waiting for iAcquire review`,
      body: "Part of the new instructions looked like it could change safety rules, so our team will review it before it's applied.",
      link: `/workforce/${AGENT_BY_KEY[agent.role_key].slug}`,
    });
  }
  return { versionId, version, status, summary: compiled.summary, riskFlags: compiled.riskFlags };
}

async function activateVersion(db: Queryable, orgId: string, agentId: string, versionId: string, displayName: string) {
  await db.query(
    `update agent_config_versions set status = 'superseded'
     where agent_instance_id = $1 and status = 'applied' and id <> $2`,
    [agentId, versionId],
  );
  await db.query(
    "update agent_config_versions set status = 'applied', applied_at = coalesce(applied_at, now()) where id = $1 and org_id = $2",
    [versionId, orgId],
  );
  await db.query("update agent_instances set active_config_version_id = $2, display_name = $3 where id = $1 and org_id = $4", [
    agentId,
    versionId,
    displayName,
    orgId,
  ]);
}

/** Applies a draft version after its approval was granted. */
export async function applyDraftVersion(db: Queryable, orgId: string, versionId: string, userId: string) {
  const { rows } = await db.query<{ agent_instance_id: string; settings: AgentSettings }>(
    `update agent_config_versions set decided_by = $3, decided_at = now()
     where id = $1 and org_id = $2 and status in ('draft', 'pending_approval')
     returning agent_instance_id, settings`,
    [versionId, orgId, userId],
  );
  const v = rows[0];
  if (!v) throw new AppError("conflict", "This configuration was already applied or replaced.");
  await activateVersion(db, orgId, v.agent_instance_id, versionId, agentSettingsSchema.parse(v.settings).displayName);
}

/** Agency review of a held version. */
export async function decideHeldVersion(db: Queryable, input: { orgId: string; versionId: string; approve: boolean; agencyUserId: string }) {
  const { rows } = await db.query<{ id: string; org_id: string; agent_instance_id: string; settings: AgentSettings }>(
    `update agent_config_versions set status = $2, decided_by = $3, decided_at = now()
     where id = $1 and org_id = $4 and status = 'pending_agency_review' returning id, org_id, agent_instance_id, settings`,
    [input.versionId, input.approve ? "applied" : "rejected", input.agencyUserId, input.orgId],
  );
  const v = rows[0];
  if (!v) throw new AppError("conflict", "This version has already been reviewed.");
  if (input.approve) await activateVersion(db, v.org_id, v.agent_instance_id, v.id, agentSettingsSchema.parse(v.settings).displayName);
  await recordAudit(
    {
      orgId: v.org_id,
      actorUserId: input.agencyUserId,
      actorKind: "agency",
      agentInstanceId: v.agent_instance_id,
      action: input.approve ? "agent.config_review_approved" : "agent.config_review_rejected",
      targetType: "agent_config_version",
      targetId: v.id,
      result: "success",
    },
    db,
  );
}

export async function rollbackToVersion(db: Queryable, input: { orgId: string; agentId: string; versionId: string; userId: string }) {
  const { rows } = await db.query<{ settings: AgentSettings; version: number; status: string }>(
    "select settings, version, status from agent_config_versions where id = $1 and agent_instance_id = $2 and org_id = $3",
    [input.versionId, input.agentId, input.orgId],
  );
  const target = rows[0];
  if (!target) throw new AppError("not_found", "That version wasn't found.");
  if (target.status === "rejected" || target.status === "pending_agency_review") {
    throw new AppError("invalid_input", "Only previously applied versions can be restored.");
  }
  return createConfigVersion(db, {
    orgId: input.orgId,
    agentId: input.agentId,
    settings: agentSettingsSchema.parse(target.settings),
    source: "rollback",
    changeRequest: `Restore version ${target.version}`,
    userId: input.userId,
    apply: true,
  });
}

export interface RunInstructions {
  instructions: string;
  versionId: string | null;
  knowledgeEntryIds: string[];
  knowledgeDocumentIds: string[];
  knowledgeTruncated: boolean;
}

/**
 * Layered run instructions: the employee configuration, then approved company and employee knowledge, then the
 * immutable agency policy last so later context can never overshadow it.
 */
export async function composeRunInstructions(
  db: Queryable,
  orgId: string,
  agentId: string,
  compiledInstructions: string,
  versionId: string | null,
): Promise<RunInstructions> {
  const knowledge = await employeeKnowledgeContext(db, orgId, agentId);
  // The agency policy must stay last so it is never overshadowed by later context.
  const [head, policy] = splitPolicy(compiledInstructions);
  return {
    instructions: [head, knowledge.block, policy].filter(Boolean).join("\n\n"),
    versionId,
    knowledgeEntryIds: knowledge.entryIds,
    knowledgeDocumentIds: knowledge.documentIds,
    knowledgeTruncated: knowledge.truncated,
  };
}

/** Run-time instructions for the employee's currently applied configuration. */
export async function buildRunInstructions(db: Queryable, orgId: string, agentId: string): Promise<RunInstructions> {
  const { rows } = await db.query<{ compiled_instructions: string | null; id: string | null }>(
    `select v.compiled_instructions, v.id from agent_instances a
     left join agent_config_versions v on v.id = a.active_config_version_id
     where a.id = $1 and a.org_id = $2`,
    [agentId, orgId],
  );
  const base = rows[0];
  if (!base?.compiled_instructions) throw new AppError("agent_unavailable", "This employee hasn't been configured yet.");
  return composeRunInstructions(db, orgId, agentId, base.compiled_instructions, base.id);
}

/**
 * Compiles a candidate configuration without storing or applying it. Used by the draft test environment, so testing a
 * change can never modify the live employee.
 */
export async function compileDraftConfig(
  db: Queryable,
  orgId: string,
  agentId: string,
  settings: AgentSettings,
): Promise<{ compiled: ReturnType<typeof compileAgentConfig>; version: number }> {
  const { rows } = await db.query<{ role_key: string; default_tools: string[] }>(
    "select a.role_key, r.default_tools from agent_instances a join agent_roles r on r.key = a.role_key where a.id = $1 and a.org_id = $2",
    [agentId, orgId],
  );
  const agent = rows[0];
  if (!agent || !isAgentRoleKey(agent.role_key)) throw new AppError("not_found", "AI employee not found.");
  const { rows: versionRows } = await db.query<{ next: number }>(
    "select coalesce(max(version), 0) + 1 as next from agent_config_versions where agent_instance_id = $1",
    [agentId],
  );
  const version = Number(versionRows[0]?.next ?? 1);
  const compiled = compileAgentConfig({
    role: agent.role_key,
    settings,
    company: await loadCompanyContext(db, orgId),
    version,
    allowedTools: agent.default_tools,
  });
  return { compiled, version };
}

function splitPolicy(compiled: string): [string, string] {
  const marker = "## Agency policy";
  const idx = compiled.indexOf(marker);
  return idx === -1 ? [compiled, ""] : [compiled.slice(0, idx).trimEnd(), compiled.slice(idx)];
}

// ---------------------------------------------------------------------------
// Hermes connection and health
// ---------------------------------------------------------------------------

export function validateHermesBaseUrl(raw: string): string {
  return validateIntegrationEndpoint(raw, ["hermes-api.iacquire.online"]);
}

export async function loadConnection(db: Queryable, agentId: string): Promise<HermesConnection | null> {
  const { rows } = await db.query<{ org_id:string; credential_id:string|null; hermes_gateway_id:string|null; hermes_base_url: string | null; hermes_profile: string | null; ciphertext: string | null; revoked_at: Date | null }>(
    `select a.org_id,a.credential_id,a.hermes_gateway_id,a.hermes_base_url,a.hermes_profile,c.ciphertext,c.revoked_at
     from agent_instances a left join integration_credentials c on c.id = a.credential_id
     where a.id = $1`,
    [agentId],
  );
  const r = rows[0];
  if (!r?.hermes_base_url || !r.ciphertext || r.revoked_at) return null;
  if (!r.credential_id) return null;
  const apiKey = await resolveCredential(db,r.credential_id,r.org_id,"hermes");
  if (!apiKey) return null;
  const access = await loadHermesAccessCredentials(db, r.hermes_gateway_id);
  return { baseUrl: r.hermes_base_url, profile: r.hermes_profile, apiKey, ...(access ?? {}) };
}

/** Server-only profile connection for a trusted service check. Credentials are never serialized to a client. */
export async function loadHermesConnectionForAgent(agentId: string): Promise<HermesConnection | null> {
  return withServiceRole((db) => loadConnection(db, agentId));
}

/** Agency-only: attach a Hermes profile endpoint and its per-profile API key to a tenant employee. */
export async function connectHermesProfile(input: {
  agentId: string;
  baseUrl?: string;
  profile: string;
  apiKey: string;
  agencyUserId: string;
  gatewayId?: string;
}) {
  let baseUrl = input.baseUrl ? validateHermesBaseUrl(input.baseUrl) : "";
  const profile = input.profile.trim();
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(profile)) throw new AppError("invalid_input", "Profile names use lowercase letters, numbers, dashes and underscores.");
  const apiKey = input.apiKey.trim();
  if (apiKey.length < 24) throw new AppError("invalid_input", "The profile API key looks too short. Use the profile's own API_SERVER_KEY.");
  return withServiceRole(async (db) => {
    const { rows } = await db.query<{ org_id: string; kind: string; role_key: string }>(
      "select a.org_id, o.kind, a.role_key from agent_instances a join organizations o on o.id = a.org_id where a.id = $1",
      [input.agentId],
    );
    const agent = rows[0];
    if (!agent) throw new AppError("not_found", "AI employee not found.");
    if (agent.kind === "agency" && AGENCY_HERMES_PROFILE_IDS[agent.role_key as AgentRoleKey] !== profile) {
      throw new AppError("invalid_input", "Internal iAcquire employees must use their existing role-specific Hermes profile.");
    }
    let gatewayId: string | null = null;
    if (input.gatewayId) {
      const { rows: gatewayRows } = await db.query<{ id: string; base_url: string; gateway_type: string }>(
        "select id,base_url,gateway_type from hermes_gateways where id=$1 and status <> 'disconnected'",
        [input.gatewayId],
      );
      const gateway = gatewayRows[0];
      if (!gateway) throw new AppError("not_found", "Approved Hermes gateway not found.");
      const registeredBaseUrl = validateHermesBaseUrl(gateway.base_url);
      if (baseUrl && registeredBaseUrl !== baseUrl) throw new AppError("invalid_input", "The profile URL must match its selected gateway.");
      baseUrl = registeredBaseUrl;
      gatewayId = gateway.id;
      if (gateway.gateway_type === "single_profile") {
        const { rows: mapped } = await db.query<{ count: number }>(
          "select count(*)::int as count from agent_instances where hermes_gateway_id=$1 and id<>$2 and hermes_profile is not null",
          [gateway.id, input.agentId],
        );
        if (mapped[0]?.count) throw new AppError("conflict", "This gateway is registered for one profile and cannot serve another workforce employee.");
      }
    } else {
      if (!baseUrl) throw new AppError("invalid_input", "Choose an approved Hermes gateway.");
      const { rows: gatewayRows } = await db.query<{ id: string }>(
        "select id from hermes_gateways where rtrim(base_url,'/')=rtrim($1,'/') and status <> 'disconnected'",
        [baseUrl],
      );
      gatewayId = gatewayRows[0]?.id ?? null;
      if (!gatewayId && process.env.NODE_ENV !== "test") throw new AppError("invalid_input", "Select an iAcquire-registered Hermes gateway before mapping this profile.");
    }
    if (agent.kind === "client" && isReservedProfile(profile)) {
      throw new AppError("invalid_input", "Internal iAcquire profiles can't be assigned to client workspaces. Provision a dedicated profile.");
    }
    const { rows: dupe } = await db.query("select 1 from agent_instances where hermes_base_url = $1 and hermes_profile = $2 and id <> $3", [
      baseUrl,
      profile,
      input.agentId,
    ]);
    if (dupe.length) throw new AppError("conflict", "That Hermes profile already backs another employee. Each employee needs its own profile.");
    const {rows:old}=await db.query<{credential_id:string|null}>("select credential_id from agent_instances where id=$1",[input.agentId]);
    const cred = await saveCredential(db,{orgId:agent.org_id,provider:"hermes",label:`Hermes profile ${profile}`,secret:apiKey,actorId:input.agencyUserId,replaces:old[0]?.credential_id});
    await db.query(
      `update agent_instances set hermes_base_url = $2, hermes_profile = $3, credential_id = $4, hermes_gateway_id = $5,
         status = 'provisioning', last_health_ok = null, last_health_detail = 'Awaiting first health check'
       where id = $1`,
      [input.agentId, baseUrl, profile, cred.id, gatewayId],
    );
    await db.query(
      `update agent_provisioning_jobs set status = 'awaiting_health_check', handled_by = $2
       where agent_instance_id = $1 and status in ('requested', 'in_progress')`,
      [input.agentId, input.agencyUserId],
    );
    await recordAudit(
      {
        orgId: agent.org_id,
        actorUserId: input.agencyUserId,
        actorKind: "agency",
        agentInstanceId: input.agentId,
        action: "agent.hermes_connected",
        targetType: "agent_instance",
        targetId: input.agentId,
        result: "success",
        metadata: { profile, host: new URL(baseUrl).host, gatewayId },
      },
      db,
    );
  });
}

export interface HealthResult {
  ok: boolean;
  status: AgentStatus;
  detail: string;
}

const HEALTH_DETAIL: Record<string, string> = {
  unreachable: "Hermes could not be reached.",
  auth_failed: "Hermes rejected this profile's API key.",
  not_found: "The profile route wasn't found. Check the profile name and multiplex gateway.",
  timeout: "Hermes did not respond in time.",
  rate_limited: "Hermes is busy (concurrent-run limit reached).",
  bad_response: "Hermes returned an unexpected response.",
  upstream: "Hermes reported a server error.",
};

/** Performs a real authenticated capabilities check and records the outcome. */
export async function runHealthCheck(
  agentId: string,
  actor: { userId: string | null; kind: "agency" | "system" | "user" },
  opts: { skipSetupSync?: boolean } = {},
): Promise<HealthResult> {
  const { orgId, orgKind, roleKey, enabled, hasConfig } = await withSystem(async (db) => {
    const { rows } = await db.query<{ org_id: string; org_kind: "agency" | "client"; role_key: AgentRoleKey; enabled: boolean; active_config_version_id: string | null }>(
      "select a.org_id, o.kind as org_kind, a.role_key, a.enabled, a.active_config_version_id from agent_instances a join organizations o on o.id=a.org_id where a.id = $1",
      [agentId],
    );
    if (!rows[0]) throw new AppError("not_found", "AI employee not found.");
    return { orgId: rows[0].org_id, orgKind: rows[0].org_kind, roleKey: rows[0].role_key, enabled: rows[0].enabled, hasConfig: Boolean(rows[0].active_config_version_id) };
  });
  const conn = await loadHermesConnectionForAgent(agentId);

  let result: HealthResult;
  if (!enabled) result = { ok: false, status: "disabled", detail: "This employee isn't enabled for the workspace." };
  else if (!conn) result = { ok: false, status: "setup_required", detail: "No dedicated Hermes profile is connected yet." };
  else if (orgKind === "agency" && conn.profile !== AGENCY_HERMES_PROFILE_IDS[roleKey]) {
    result = { ok: false, status: "error", detail: "The saved Hermes profile does not match this employee's verified iAcquire identity." };
  }
  else {
    try {
      const caps = await getCapabilities(conn);
      const identity=await getProfileModels(conn);
      // Fail closed: an employee only goes online when its tool exposure can be verified as safe.
      let restricted: string[] | null = null;
      try {
        restricted = restrictedToolsIn(await getToolsets(conn));
      } catch {
        restricted = null;
      }
      if (!conn.profile || !identity.includes(conn.profile) || caps.contract !== "hermes.api_server.capabilities" || !caps.authenticated) {
        result = { ok:false,status:"error",detail:"The gateway did not verify the intended profile identity and authenticated Hermes API contract." };
      } else if (!caps.supportsRuns) {
        result = { ok: false, status: "error", detail: "This Hermes version doesn't advertise run submission." };
      } else if (!caps.supportsEvents && !caps.supportsStatus) {
        result = { ok: false, status: "error", detail: "This Hermes version doesn't advertise run events or a run-status endpoint." };
      } else if (restricted === null) {
        result = { ok: false, status: "error", detail: "Couldn't verify the profile's tool restrictions (GET /v1/toolsets)." };
      } else if (restricted.length) {
        const sample = restricted.slice(0, 8).join(", ");
        result = {
          ok: false,
          status: "error",
          detail: `Profile exposes ${restricted.length} restricted or unreviewed tool${restricted.length === 1 ? "" : "s"}: ${sample}${restricted.length > 8 ? ", …" : ""}. Disable them in the Hermes profile before going live.`,
        };
      } else if (!hasVerifiedCompleteToolInventory(conn)) {
        result = { ok:false,status:"setup_required",detail:"Profile API access verified, but the public toolset API cannot prove complete plugin/MCP permissions. Live employee use stays blocked pending a supported complete-inventory security check by the gateway administrator." };
      } else if (!hasConfig) {
        result = { ok: false, status: "setup_required", detail: "Connected to Hermes, but the employee configuration hasn't been applied yet." };
      } else {
        result = {
          ok: true,
          status: "online",
          detail: `Profile identity, API capabilities and tool restrictions verified${
            caps.supportsEvents ? "" : " · streaming not supported; the full response arrives when complete"
          }${caps.supportsStop ? "" : " · stop not supported"}`,
        };
      }
    } catch (err) {
      const kind = err instanceof HermesError ? err.kind : "unreachable";
      result = { ok: false, status: kind === "auth_failed" || kind === "not_found" ? "error" : "offline", detail: HEALTH_DETAIL[kind] ?? "Health check failed." };
    }
  }

  await withSystem(async (db) => {
    const { rows } = await db.query<{ status: AgentStatus }>("select status from agent_instances where id = $1", [agentId]);
    const previous = rows[0]?.status;
    await db.query(
      "update agent_instances set status = $2, last_health_check_at = now(), last_health_ok = $3, last_health_detail = $4 where id = $1",
      [agentId, result.status, result.ok, result.detail],
    );
    if (result.ok) {
      await db.query(
        "update agent_provisioning_jobs set status = 'succeeded' where agent_instance_id = $1 and status = 'awaiting_health_check'",
        [agentId],
      );
    }
    await db.query(
      `insert into integration_status (org_id, provider, status, detail, last_checked_at)
       values ($1, 'hermes', $2, $3, now())
       on conflict (coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), provider)
       do update set status = excluded.status, detail = excluded.detail, last_checked_at = now(), updated_at = now()`,
      [orgId, result.ok ? "connected" : conn ? "error" : "not_configured", result.detail],
    );
    if (previous && previous !== result.status && (previous === "online" || result.status === "online")) {
      const { rows: a } = await db.query<{ role_key: AgentRoleKey }>("select role_key from agent_instances where id = $1", [agentId]);
      const meta = a[0] ? AGENT_BY_KEY[a[0].role_key] : null;
      if (meta) {
        await notifyOrgRoles(db, orgId, ["owner", "admin"], {
          kind: result.ok ? "agent_status" : "integration_disconnected",
          severity: result.ok ? "success" : "warning",
          title: result.ok ? `${meta.shortName} is online` : `${meta.shortName} is ${result.status === "offline" ? "offline" : "unavailable"}`,
          body: result.detail,
          link: `/workforce/${meta.slug}`,
        });
      }
    }
    await recordAudit(
      {
        orgId,
        actorUserId: actor.userId,
        actorKind: actor.kind,
        agentInstanceId: agentId,
        action: "agent.health_check",
        targetType: "agent_instance",
        targetId: agentId,
        result: result.ok ? "success" : "failure",
        metadata: { status: result.status },
      },
      db,
    );
  });
  // Let the client's setup checklist react to the recorded outcome (it never contacts Hermes itself).
  if (!opts.skipSetupSync) {
    try {
      const { reconcileSetupAutomation } = await import("@/server/setup/automation");
      await reconcileSetupAutomation(orgId);
    } catch {
      if (process.env.NODE_ENV !== "test") console.error("[iacquire] setup sync after health check failed");
    }
  }
  return result;
}

/** Marks an employee offline after a live failure, without waiting for the next health check. */
export async function markAgentDegraded(agentId: string, detail: string) {
  await withSystem((db) =>
    db.query(
      "update agent_instances set status = 'offline', last_health_ok = false, last_health_detail = $2, last_health_check_at = now() where id = $1 and status in ('online', 'busy')",
      [agentId, detail.slice(0, 500)],
    ),
  );
}
