import "server-only";
import type { SessionUser } from "@/server/auth/service";
import { AGENT_ROLE_KEYS, AGENCY_HERMES_PROFILE_IDS, type AgentRoleKey } from "@/lib/agents";
import { AppError } from "@/server/errors";
import { withServiceRole, withSystem } from "@/server/db";
import { recordAudit } from "@/server/audit";
import { loadHermesAccessCredentials } from "@/server/integrations/hermes/gateways";
import {
  connectHermesProfile,
  loadHermesConnectionForAgent,
  validateHermesBaseUrl,
} from "@/server/workforce/service";
import { ensureAgencyWorkforceRegistry } from "@/server/workforce/agency-registry";
import {
  getCapabilities,
  getProfileModels,
  getToolsets,
  hasVerifiedCompleteToolInventory,
  HermesError,
  restrictedToolsIn,
} from "@/server/integrations/hermes/client";

export type AgencyProfileCheckStatus =
  | "not_configured"
  | "verified"
  | "cloudflare_auth_failed"
  | "hermes_auth_failed"
  | "profile_unavailable"
  | "route_not_found"
  | "gateway_timeout"
  | "gateway_offline"
  | "unexpected_response"
  | "identity_mismatch";

export type ToolPermissionsStatus = "not_checked" | "verified" | "restricted" | "incomplete" | "unavailable";

export interface AgencyProfileVerification {
  roleKey: AgentRoleKey;
  profile: string;
  status: AgencyProfileCheckStatus;
  mapped: boolean;
  checked: boolean;
  ok: boolean;
  identityVerified: boolean;
  apiContractVerified: boolean;
  toolPermissionsStatus: ToolPermissionsStatus;
  detail: string;
  checkedAt: string | null;
  verifiedAt: string | null;
}

function requireSuperAdmin(admin: SessionUser) {
  if (admin.platformRole !== "agency_super_admin") {
    throw new AppError("forbidden", "Only a Super Admin can manage the internal AI workforce.");
  }
}

async function getAgencyAgent(agentId: string) {
  const { rows } = await withServiceRole((db) => db.query<{
    id: string;
    org_id: string;
    kind: string;
    role_key: AgentRoleKey;
    hermes_profile: string | null;
    hermes_gateway_id: string | null;
    credential_ready: boolean;
  }>(
    `select a.id,a.org_id,o.kind,a.role_key,a.hermes_profile,a.hermes_gateway_id,
            (a.credential_id is not null and c.revoked_at is null) as credential_ready
     from agent_instances a join organizations o on o.id=a.org_id
     left join integration_credentials c on c.id=a.credential_id
     where a.id=$1`,
    [agentId],
  ));
  const agent = rows[0];
  if (!agent || agent.kind !== "agency") throw new AppError("not_found", "Internal AI employee not found.");
  return agent;
}

async function verifyCandidateProfileKey(gatewayId: string, profile: string, rawApiKey: string) {
  const apiKey = rawApiKey.trim();
  if (apiKey.length < 24) throw new AppError("invalid_input", "The profile API key looks too short. Use the profile's own API_SERVER_KEY.");

  const { baseUrl, access } = await withServiceRole(async (db) => {
    const { rows } = await db.query<{ id: string; base_url: string }>(
      "select id,base_url from hermes_gateways where id=$1 and status <> 'disconnected'",
      [gatewayId],
    );
    const gateway = rows[0];
    if (!gateway) throw new AppError("not_found", "Approved Hermes gateway not found.");
    return {
      baseUrl: validateHermesBaseUrl(gateway.base_url),
      access: await loadHermesAccessCredentials(db, gateway.id),
    };
  });

  const connection = { baseUrl, profile, apiKey, ...(access ?? {}) };
  try {
    const capabilities = await getCapabilities(connection);
    if (capabilities.contract !== "hermes.api_server.capabilities" || !capabilities.authenticated) {
      throw new AppError("integration_unavailable", "The approved gateway did not confirm the expected authenticated Hermes API. The saved credential was left unchanged.");
    }
    const identities = await getProfileModels(connection);
    if (!identities.includes(profile)) {
      throw new AppError("invalid_input", "The candidate key did not verify this existing Hermes profile. The saved credential was left unchanged.");
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof HermesError) {
      if (error.status === 401) throw new AppError("invalid_input", "Hermes rejected the candidate profile key. The saved credential was left unchanged.");
      if (error.status === 403) throw new AppError("integration_unavailable", "Cloudflare Access rejected the approved gateway credentials. The saved profile credential was left unchanged.");
      if (error.kind === "not_found") throw new AppError("invalid_input", "The existing Hermes profile was not found on the approved gateway. The saved credential was left unchanged.");
      throw new AppError("integration_unavailable", "The approved gateway could not verify the candidate profile key. The saved credential was left unchanged.");
    }
    throw error;
  }
}

async function saveCheck(admin: SessionUser, agent: Awaited<ReturnType<typeof getAgencyAgent>>, result: Omit<AgencyProfileVerification, "checkedAt" | "verifiedAt">) {
  const profileForCheck = agent.hermes_profile === AGENCY_HERMES_PROFILE_IDS[agent.role_key] ? agent.hermes_profile : null;
  return withSystem(async (db) => {
    const { rows } = await db.query<{ checked_at: Date; verified_at: Date | null }>(
      `insert into agency_hermes_profile_checks
         (org_id,agent_instance_id,gateway_id,profile_id,status,identity_verified,api_contract_verified,tool_permissions_status,detail,checked_by,checked_at,verified_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),case when $5='verified' then now() else null end)
       on conflict (agent_instance_id) do update set
         gateway_id=excluded.gateway_id,profile_id=excluded.profile_id,status=excluded.status,
         identity_verified=excluded.identity_verified,api_contract_verified=excluded.api_contract_verified,
         tool_permissions_status=excluded.tool_permissions_status,detail=excluded.detail,
         checked_by=excluded.checked_by,checked_at=now(),
         verified_at=case when excluded.status='verified' then now() else null end
       returning checked_at,verified_at`,
      [agent.org_id, agent.id, agent.hermes_gateway_id, profileForCheck, result.status, result.identityVerified, result.apiContractVerified, result.toolPermissionsStatus, result.detail.slice(0, 500), admin.id],
    );
    await recordAudit({
      orgId: agent.org_id,
      actorUserId: admin.id,
      actorKind: "agency",
      agentInstanceId: agent.id,
      action: "agent.hermes_profile_checked",
      targetType: "agent_instance",
      targetId: agent.id,
      result: result.ok ? "success" : "failure",
      metadata: { status: result.status, identityVerified: result.identityVerified, apiContractVerified: result.apiContractVerified, toolPermissionsStatus: result.toolPermissionsStatus },
    }, db);
    return {
      checkedAt: rows[0]?.checked_at.toISOString() ?? new Date().toISOString(),
      verifiedAt: rows[0]?.verified_at?.toISOString() ?? null,
    };
  });
}

function failResult(
  agent: Awaited<ReturnType<typeof getAgencyAgent>>,
  status: AgencyProfileCheckStatus,
  detail: string,
  checked = false,
): Omit<AgencyProfileVerification, "checkedAt" | "verifiedAt"> {
  const expectedProfile = AGENCY_HERMES_PROFILE_IDS[agent.role_key];
  return {
    roleKey: agent.role_key,
    profile: agent.hermes_profile ?? expectedProfile,
    status,
    mapped: agent.hermes_profile === expectedProfile && Boolean(agent.hermes_gateway_id),
    checked,
    ok: false,
    identityVerified: false,
    apiContractVerified: false,
    toolPermissionsStatus: "not_checked",
    detail,
  };
}

function classifyHermesFailure(error: unknown): { status: AgencyProfileCheckStatus; detail: string } {
  if (error instanceof HermesError) {
    if (error.status === 403) return { status: "cloudflare_auth_failed", detail: "Cloudflare Access rejected the gateway service credentials." };
    if (error.status === 401) return { status: "hermes_auth_failed", detail: "Hermes rejected this profile's API credential." };
    if (error.kind === "not_found") return { status: "route_not_found", detail: "The saved profile route was not found on the approved gateway." };
    if (error.kind === "timeout") return { status: "gateway_timeout", detail: "The profile check timed out while waiting for Hermes." };
    if (error.kind === "unreachable") return { status: "gateway_offline", detail: "The approved Hermes gateway could not be reached." };
    if (error.kind === "auth_failed") return { status: "hermes_auth_failed", detail: "Hermes rejected this profile's API credential." };
    return { status: "profile_unavailable", detail: "Hermes could not complete the read-only profile check." };
  }
  return { status: "unexpected_response", detail: "Hermes returned an unsupported response to the read-only profile check." };
}

async function verifyAgencyProfile(admin: SessionUser, agentId: string): Promise<AgencyProfileVerification> {
  const agent = await getAgencyAgent(agentId);
  const expectedProfile = AGENCY_HERMES_PROFILE_IDS[agent.role_key];
  let result: Omit<AgencyProfileVerification, "checkedAt" | "verifiedAt">;

  if (agent.hermes_profile && agent.hermes_profile !== expectedProfile) {
    result = failResult(agent, "identity_mismatch", "The saved profile does not match this employee's verified iAcquire identity.");
  } else if (!agent.hermes_profile || !agent.hermes_gateway_id || !agent.credential_ready) {
    const detail = !agent.hermes_profile
      ? "No existing Hermes profile has been mapped."
      : !agent.hermes_gateway_id
        ? "Choose the approved shared gateway for this existing profile."
        : "This profile's API credential is not stored or is unavailable.";
    result = failResult(agent, "not_configured", detail);
  } else {
    const connection = await loadHermesConnectionForAgent(agent.id);
    if (!connection) {
      result = failResult(agent, "not_configured", "The profile API credential or gateway credentials are unavailable.");
    } else if (connection.profile !== expectedProfile) {
      result = failResult(agent, "identity_mismatch", "The server-resolved route does not match this employee's verified iAcquire identity.");
    } else {
      try {
        const capabilities = await getCapabilities(connection);
        if (capabilities.contract !== "hermes.api_server.capabilities" || !capabilities.authenticated) {
          result = failResult(agent, "unexpected_response", "Hermes did not confirm the expected authenticated API contract.", true);
        } else {
          const identities = await getProfileModels(connection);
          if (!identities.includes(expectedProfile)) {
            result = failResult(agent, "identity_mismatch", "Hermes did not confirm the expected iAcquire profile identity.", true);
          } else {
            let toolPermissionsStatus: ToolPermissionsStatus = "unavailable";
            try {
              const restricted = restrictedToolsIn(await getToolsets(connection));
              toolPermissionsStatus = restricted.length ? "restricted" : hasVerifiedCompleteToolInventory(connection) ? "verified" : "incomplete";
            } catch {
              toolPermissionsStatus = "unavailable";
            }
            const toolDetail = toolPermissionsStatus === "restricted"
              ? " The profile exposes tools that need agency review before active use."
              : toolPermissionsStatus === "incomplete"
                ? " The installed API does not prove a complete tool inventory, so active use remains blocked pending review."
                : toolPermissionsStatus === "unavailable"
                  ? " Tool permissions could not be verified through the installed API."
                  : " Tool permissions were checked through the complete read-only inventory.";
            result = {
              roleKey: agent.role_key,
              profile: expectedProfile,
              status: "verified",
              mapped: true,
              checked: true,
              ok: true,
              identityVerified: true,
              apiContractVerified: true,
              toolPermissionsStatus,
              detail: `Profile identity, profile-specific key and read-only API checks passed.${toolDetail}`,
            };
          }
        }
      } catch (error) {
        const failure = classifyHermesFailure(error);
        result = failResult(agent, failure.status, failure.detail, true);
      }
    }
  }

  const saved = await saveCheck(admin, agent, result);
  return { ...result, ...saved };
}

export async function connectAgencyHermesProfile(
  admin: SessionUser,
  input: { agentId: string; gatewayId: string; profile: string; apiKey: string; confirmedExistingProfile: boolean },
): Promise<AgencyProfileVerification> {
  requireSuperAdmin(admin);
  const agent = await getAgencyAgent(input.agentId);
  const expectedProfile = AGENCY_HERMES_PROFILE_IDS[agent.role_key];
  if (input.confirmedExistingProfile !== true) {
    throw new AppError("invalid_input", "Confirm that this is the existing iAcquire profile verified in the Hermes inventory.");
  }
  if (input.profile.trim() !== expectedProfile) {
    throw new AppError("invalid_input", "This role can only use its existing verified iAcquire Hermes profile.");
  }
  const otherGateways = await withSystem((db) => db.query<{ hermes_gateway_id: string }>(
    `select distinct hermes_gateway_id from agent_instances
     where org_id=$1 and hermes_profile is not null and id<>$2 and hermes_gateway_id is not null`,
    [agent.org_id, agent.id],
  ));
  if (otherGateways.rows.some((row) => row.hermes_gateway_id !== input.gatewayId)) {
    throw new AppError("conflict", "All six iAcquire employees must use the same approved shared Hermes gateway.");
  }

  // Verify the candidate against the existing role-specific identity before Vault rotation can
  // revoke the currently working key. Failed checks leave the saved credential untouched.
  await verifyCandidateProfileKey(input.gatewayId, expectedProfile, input.apiKey);

  await connectHermesProfile({
    agentId: agent.id,
    gatewayId: input.gatewayId,
    profile: expectedProfile,
    apiKey: input.apiKey,
    agencyUserId: admin.id,
  });
  return verifyAgencyProfile(admin, agent.id);
}

export async function testAgencyHermesProfile(admin: SessionUser, agentId: string): Promise<AgencyProfileVerification> {
  requireSuperAdmin(admin);
  await ensureAgencyWorkforceRegistry(admin);
  return verifyAgencyProfile(admin, agentId);
}

export async function testAllAgencyHermesProfiles(admin: SessionUser): Promise<{
  mapped: number;
  checked: number;
  verified: number;
  failed: number;
  notConfigured: number;
  results: AgencyProfileVerification[];
}> {
  requireSuperAdmin(admin);
  await ensureAgencyWorkforceRegistry(admin);
  const { rows: agency } = await withSystem((db) => db.query<{ id: string }>(
    "select id from organizations where kind='agency' order by created_at limit 1",
  ));
  if (!agency[0]) throw new AppError("integration_unavailable", "The iAcquire internal workforce is unavailable.");
  const { rows: agents } = await withSystem((db) => db.query<{ id: string; role_key: AgentRoleKey }>(
    "select id,role_key from agent_instances where org_id=$1",
    [agency[0].id],
  ));
  const byRole = new Map(agents.map((agent) => [agent.role_key, agent.id]));
  const results = await Promise.all(AGENT_ROLE_KEYS.map(async (roleKey) => {
    const agentId = byRole.get(roleKey);
    if (!agentId) {
      return {
        roleKey,
        profile: AGENCY_HERMES_PROFILE_IDS[roleKey],
        status: "not_configured" as const,
        mapped: false,
        checked: false,
        ok: false,
        identityVerified: false,
        apiContractVerified: false,
        toolPermissionsStatus: "not_checked" as const,
        detail: "Internal employee identity is missing.",
        checkedAt: null,
        verifiedAt: null,
      };
    }
    try {
      return await verifyAgencyProfile(admin, agentId);
    } catch {
      return {
        roleKey,
        profile: AGENCY_HERMES_PROFILE_IDS[roleKey],
        status: "unexpected_response" as const,
        mapped: false,
        checked: false,
        ok: false,
        identityVerified: false,
        apiContractVerified: false,
        toolPermissionsStatus: "not_checked" as const,
        detail: "The profile check could not be recorded. Retry after reviewing the registry migration.",
        checkedAt: null,
        verifiedAt: null,
      };
    }
  }));

  const mapped = results.filter((item) => item.mapped).length;
  const checked = results.filter((item) => item.checked).length;
  const verified = results.filter((item) => item.ok).length;
  const notConfigured = results.filter((item) => item.status === "not_configured").length;
  const failed = results.filter((item) => item.status !== "not_configured" && !item.ok).length;
  await recordAudit({
    orgId: agency[0].id,
    actorUserId: admin.id,
    actorKind: "agency",
    action: "agency.workforce_profiles_tested",
    targetType: "agency_workforce",
    targetId: agency[0].id,
    result: failed || notConfigured ? "failure" : "success",
    metadata: { checked, verified, failed, notConfigured },
  });
  return { mapped, checked, verified, failed, notConfigured, results };
}
