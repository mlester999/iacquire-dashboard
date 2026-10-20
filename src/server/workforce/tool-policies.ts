import "server-only";
import { AGENT_BY_KEY, AGENT_ROLE_KEYS, AGENCY_HERMES_PROFILE_IDS, type AgentRoleKey } from "@/lib/agents";
import { type SessionUser } from "@/server/auth/service";
import { withSystem } from "@/server/db";
import { recordAudit } from "@/server/audit";
import { AppError } from "@/server/errors";
import { internalAcknowledgementIsCurrent, internalIdentityIsCurrent } from "@/lib/workforce-readiness";
import { TOOL_INVENTORY_CONTRACT, toolInventoryReady } from "@/lib/hermes-tool-inventory";
import { refreshExistingAgencyProfileEvidence } from "@/server/workforce/agency";
import { runHealthCheck } from "@/server/workforce/service";
import type { ToolInventorySnapshot } from "@/server/integrations/hermes/inventory";

export const HERMES_POLICY_CAPABILITIES = [
  { key: "web_search", label: "Web search" },
  { key: "web_research", label: "Public web research" },
  { key: "web_extract", label: "Web extraction" },
  { key: "approved_read_only_browsing", label: "Approved read-only browsing" },
  { key: "client_knowledge", label: "Client business knowledge" },
  { key: "client_memory", label: "Client-specific memory" },
  { key: "approved_tasks", label: "Approved task lists" },
  { key: "client_crm_read", label: "Read client CRM data" },
  { key: "client_crm_write", label: "Update client CRM records" },
  { key: "calendar_availability", label: "Read connected calendar availability" },
  { key: "authorized_booking", label: "Book authorized appointments" },
  { key: "draft_customer_replies", label: "Draft customer replies" },
  { key: "authorized_messages", label: "Send messages under client rules" },
  { key: "client_reporting", label: "Client reporting and analysis" },
  { key: "approved_employee_collaboration", label: "Approved employee collaboration" },
  { key: "image_analysis", label: "Image analysis (optional)" },
  { key: "image_generation", label: "Image generation" },
  { key: "video_generation", label: "Video generation" },
] as const;
export type HermesPolicyCapability = (typeof HERMES_POLICY_CAPABILITIES)[number]["key"];

export const HERMES_BLOCKABLE_TOOLSETS = [
  { key: "terminal", label: "Terminal and shell" },
  { key: "file", label: "Host file access" },
  { key: "code_execution", label: "Code execution" },
  { key: "browser", label: "Browser automation" },
  { key: "computer_use", label: "Desktop control" },
  { key: "cronjob", label: "Arbitrary scheduled jobs" },
  { key: "delegation", label: "Agent delegation" },
  { key: "connections", label: "Connection management" },
  { key: "catalog", label: "Tool catalog installation" },
  { key: "kanban", label: "Kanban and project tools" },
  { key: "image_gen", label: "Image generation" },
  { key: "skills", label: "Skill installation and management" },
] as const;
export type HermesBlockableToolset = (typeof HERMES_BLOCKABLE_TOOLSETS)[number]["key"];

/** Toolsets the portal has reviewed as read-only enough for an AI employee. */
export const PORTAL_SAFE_TOOLSETS = ["memory", "session_search", "todo", "vision", "web"] as const;

/** Enabled toolset names outside the reviewed set. Unknown future names fail closed. */
export function unauthorizedToolsets(enabled: readonly string[]): string[] {
  const safe = new Set<string>(PORTAL_SAFE_TOOLSETS);
  return [...new Set(enabled.filter((name) => !safe.has(name)))].sort();
}

export const CLIENT_ROLE_CAPABILITY_MATRIX: Record<AgentRoleKey, { label: string; capabilities: HermesPolicyCapability[] }> = {
  operations_manager: { label: AGENT_BY_KEY.operations_manager.shortName, capabilities: ["client_knowledge", "client_memory", "approved_tasks", "client_reporting", "approved_employee_collaboration"] },
  lead_hunter: { label: AGENT_BY_KEY.lead_hunter.shortName, capabilities: ["web_search", "web_research", "web_extract", "client_knowledge", "client_crm_read", "client_crm_write"] },
  appointment_setter: { label: AGENT_BY_KEY.appointment_setter.shortName, capabilities: ["client_knowledge", "client_memory", "calendar_availability", "authorized_booking", "authorized_messages"] },
  sales_assistant: { label: AGENT_BY_KEY.sales_assistant.shortName, capabilities: ["client_knowledge", "client_memory", "draft_customer_replies", "authorized_messages", "approved_tasks"] },
  crm_manager: { label: AGENT_BY_KEY.crm_manager.shortName, capabilities: ["client_knowledge", "client_crm_read", "client_crm_write", "approved_tasks"] },
  performance_analyst: { label: AGENT_BY_KEY.performance_analyst.shortName, capabilities: ["client_knowledge", "client_memory", "client_reporting"] },
};

export const DEFAULT_CLIENT_CAPABILITIES: HermesPolicyCapability[] = [
  "web_search", "web_research", "web_extract", "approved_read_only_browsing", "client_knowledge", "client_memory",
  "approved_tasks", "client_crm_read", "client_crm_write", "calendar_availability", "authorized_booking",
  "draft_customer_replies", "authorized_messages", "client_reporting", "approved_employee_collaboration",
];
export const DEFAULT_BLOCKED_TOOLSETS: HermesBlockableToolset[] = HERMES_BLOCKABLE_TOOLSETS.map((toolset) => toolset.key);

export type HermesPolicyScope = "internal_agency" | "client_default" | "client" | "agent";
export type HermesApprovalMode = "client_rules" | "approval_required" | "read_only";

export interface HermesPolicyRecord {
  id: string;
  scopeKind: HermesPolicyScope;
  orgId: string | null;
  agentId: string | null;
  name: string;
  allowedCapabilities: Array<HermesPolicyCapability | "full_hermes_capabilities">;
  blockedToolsets: HermesBlockableToolset[];
  approvalMode: HermesApprovalMode;
  acknowledgedFullCapabilities: boolean;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  enforcementStatus: "not_enforced";
  updatedBy: string | null;
  updatedAt: string;
}

export interface HermesToolPolicyView {
  editable: boolean;
  clientDefault: HermesPolicyRecord;
  internalDefault: HermesPolicyRecord;
  clients: Array<{ id: string; name: string; policy: HermesPolicyRecord | null; agentIds: string[] }>;
  agents: Array<{
    id: string; orgId: string; orgName: string; orgKind: string; roleKey: AgentRoleKey; displayName: string; enabled: boolean;
    profile: string | null; expectedProfile: string | null; activeConfigVersionId: string | null; configVersion: number | null;
    identityMapped: boolean; inventoryCurrent: boolean; inventoryDigest: string | null; inventoryExpiresAt: string | null; inventoryToolCount: number | null;
    canAcknowledgeFullCapabilities: boolean; lastProfileCheck: string | null;
    lastProfileCheckAt: string | null; toolPermissionsStatus: string | null; fullCapabilitiesAcknowledged: boolean;
    acknowledgedBy: string | null; acknowledgedAt: string | null; policy: HermesPolicyRecord | null;
  }>;
  history: Array<{ scopeKind: HermesPolicyScope; action: string; actorName: string; occurredAt: string; policyName: string }>;
  capabilityOptions: typeof HERMES_POLICY_CAPABILITIES;
  blockableToolsets: typeof HERMES_BLOCKABLE_TOOLSETS;
  roleMatrix: typeof CLIENT_ROLE_CAPABILITY_MATRIX;
  inventoryComplete: boolean;
  gatewayPolicyWriteSupported: false;
}

type PolicyRow = {
  id: string; scope_kind: HermesPolicyScope; org_id: string | null; agent_id: string | null; name: string;
  allowed_capabilities: string[]; blocked_toolsets: string[]; approval_mode: HermesApprovalMode;
  acknowledged_full_capabilities: boolean; acknowledged_by: string | null; acknowledged_at: Date | null;
  enforcement_status: "not_enforced"; updated_by: string | null; updated_at: Date;
};

function policyRecord(row: PolicyRow): HermesPolicyRecord {
  const allowed = new Set(HERMES_POLICY_CAPABILITIES.map((option) => option.key));
  const blocked = new Set(HERMES_BLOCKABLE_TOOLSETS.map((option) => option.key));
  return {
    id: row.id,
    scopeKind: row.scope_kind,
    orgId: row.org_id,
    agentId: row.agent_id,
    name: row.name,
    allowedCapabilities: row.scope_kind === "internal_agency" && row.allowed_capabilities.includes("full_hermes_capabilities")
      ? ["full_hermes_capabilities"]
      : row.allowed_capabilities.filter((key): key is HermesPolicyCapability => allowed.has(key as HermesPolicyCapability)),
    blockedToolsets: row.blocked_toolsets.filter((key): key is HermesBlockableToolset => blocked.has(key as HermesBlockableToolset)),
    approvalMode: row.approval_mode,
    acknowledgedFullCapabilities: row.acknowledged_full_capabilities,
    acknowledgedBy: row.acknowledged_by,
    acknowledgedAt: row.acknowledged_at ? new Date(row.acknowledged_at).toISOString() : null,
    enforcementStatus: "not_enforced",
    updatedBy: row.updated_by,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function requirePolicyViewer(user: SessionUser) {
  if (user.platformRole !== "agency_super_admin" && user.platformRole !== "agency_manager") {
    throw new AppError("forbidden", "Only Agency Managers and Super Admins can view Hermes tool policies.");
  }
}

function requireSuperAdmin(user: SessionUser) {
  if (user.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only a Super Admin can edit Hermes tool policies.");
}

export async function getHermesToolPolicyView(user: SessionUser): Promise<HermesToolPolicyView> {
  requirePolicyViewer(user);
  return withSystem(async (db) => {
    const { rows: clients } = await db.query<{ id: string; name: string }>(
      `select o.id,o.name from organizations o where o.kind='client' and o.status<>'archived'
       and app.user_can_access_org($1,o.id) order by o.name limit 500`,
      [user.id],
    );
    const clientIds = clients.map((client) => client.id);
    const { rows: agents } = await db.query<{
      id: string; org_id: string; org_name: string; org_kind: string; role_key: AgentRoleKey; display_name: string; enabled: boolean;
      status: string; active_run: boolean; last_health_ok: boolean | null; active_config_version_id: string | null; config_version: number | null; config_applied_at: Date | null;
      tool_inventory_contract: string | null; tool_inventory_digest: string | null; tool_inventory_verified_at: Date | null; tool_inventory_expires_at: Date | null;
      tool_inventory_tool_count: number | null;
      hermes_profile: string | null; hermes_gateway_id: string | null; check_status: string | null; check_profile: string | null; check_gateway_id: string | null;
      identity_verified: boolean | null; api_contract_verified: boolean | null; credential_ready: boolean; tool_permissions_status: string | null; checked_at: Date | null;
      acknowledged_profile: string | null; acknowledged_policy_id: string | null; acknowledged_by_name: string | null; acknowledged_at: Date | null;
      acknowledged_config_version_id: string | null; acknowledged_inventory_digest: string | null; has_agent_policy_override: boolean;
    }>(
      `select a.id,a.org_id,o.name as org_name,o.kind as org_kind,a.role_key,a.display_name,a.enabled,a.status,a.last_health_ok,
         exists(select 1 from agent_runs r where r.agent_instance_id=a.id and r.status in ('queued','running')) as active_run,
         a.active_config_version_id,v.version as config_version,v.applied_at as config_applied_at,
         a.tool_inventory_contract,a.tool_inventory_digest,a.tool_inventory_verified_at,a.tool_inventory_expires_at,a.tool_inventory_tool_count,
         a.hermes_profile,a.hermes_gateway_id,
         c.status as check_status,c.profile_id as check_profile,c.gateway_id as check_gateway_id,c.identity_verified,c.api_contract_verified,c.tool_permissions_status,c.checked_at,
         (a.credential_id is not null and cred.revoked_at is null and cred.credential_reference_id is not null and cred_ref.revoked_at is null) as credential_ready,
         ack.verified_profile as acknowledged_profile,ack.policy_id as acknowledged_policy_id,
         coalesce(nullif(ack_user.full_name,''),ack_user.email::text) as acknowledged_by_name,ack.acknowledged_at,
         ack_history.policy_snapshot->>'activeConfigVersionId' as acknowledged_config_version_id,
         ack_history.policy_snapshot->>'inventoryDigest' as acknowledged_inventory_digest,
         (agent_policy.id is not null) as has_agent_policy_override
       from agent_instances a join organizations o on o.id=a.org_id
       left join agent_config_versions v on v.id=a.active_config_version_id
       left join agency_hermes_profile_checks c on c.agent_instance_id=a.id and c.org_id=a.org_id
       left join integration_credentials cred on cred.id=a.credential_id
       left join credential_references cred_ref on cred_ref.id=cred.credential_reference_id and cred_ref.org_id=a.org_id and cred_ref.provider='hermes'
       left join hermes_tool_policy_acknowledgements ack on ack.agent_id=a.id
       left join users ack_user on ack_user.id=ack.acknowledged_by
       left join lateral (
         select h.policy_snapshot from hermes_tool_policy_history h
         where h.agent_id=a.id and h.action='full_capabilities_acknowledged'
         order by h.occurred_at desc,h.id desc limit 1
       ) ack_history on true
       left join hermes_tool_policies agent_policy on agent_policy.scope_kind='agent' and agent_policy.agent_id=a.id
       where (o.kind='agency' and $2::boolean) or (o.kind='client' and a.org_id=any($1::uuid[]))
       order by o.name,a.role_key`,
      [clientIds, user.platformRole === "agency_super_admin"],
    );
    const agentIds = agents.map((agent) => agent.id);
    const { rows: policies } = await db.query<PolicyRow>(
      `select * from hermes_tool_policies where scope_kind in ('internal_agency','client_default')
       or (scope_kind='client' and org_id=any($1::uuid[])) or (scope_kind='agent' and agent_id=any($2::uuid[]))`,
      [clientIds, agentIds],
    );
    const records = policies.map(policyRecord);
    const internalDefault = records.find((policy) => policy.scopeKind === "internal_agency");
    const clientDefault = records.find((policy) => policy.scopeKind === "client_default");
    if (!internalDefault || !clientDefault) throw new AppError("internal", "Hermes policy defaults are unavailable. Apply the agency tool-policy migration before opening this page.");
    const clientOverrides = new Map(records.filter((policy) => policy.scopeKind === "client").map((policy) => [policy.orgId!, policy]));
    const agentOverrides = new Map(records.filter((policy) => policy.scopeKind === "agent").map((policy) => [policy.agentId!, policy]));
    const now = new Date();
    const agentView = agents.map((agent) => {
      const expectedProfile = agent.org_kind === "agency" ? AGENCY_HERMES_PROFILE_IDS[agent.role_key] : null;
      const agentPolicy = agentOverrides.get(agent.id) ?? null;
      const identityEvidence = {
        expectedProfile,
        savedProfile: agent.hermes_profile,
        savedGatewayId: agent.hermes_gateway_id,
        checkedProfile: agent.check_profile,
        checkedGatewayId: agent.check_gateway_id,
        checkStatus: agent.check_status,
        identityVerified: agent.identity_verified,
        apiContractVerified: agent.api_contract_verified,
        toolPermissionsStatus: agent.tool_permissions_status,
        checkedAt: agent.checked_at,
        configAppliedAt: agent.config_applied_at,
      };
      const identityMapped = Boolean(expectedProfile && internalIdentityIsCurrent(identityEvidence));
      const inventoryCurrent = toolInventoryReady(agent, now);
      const acknowledgementIsCurrent = Boolean(expectedProfile && internalAcknowledgementIsCurrent({
        ...identityEvidence,
        acknowledgedAt: agent.acknowledged_at,
        acknowledgedProfile: agent.acknowledged_profile,
        acknowledgedPolicyId: agent.acknowledged_policy_id,
        expectedPolicyId: internalDefault.id,
        activeConfigVersionId: agent.active_config_version_id,
        acknowledgedConfigVersionId: agent.acknowledged_config_version_id,
        inventoryDigest: agent.tool_inventory_digest,
        acknowledgedInventoryDigest: agent.acknowledged_inventory_digest,
        credentialReady: agent.credential_ready,
        hasAgentPolicyOverride: Boolean(agentPolicy),
      }));
      const canAcknowledge = Boolean(expectedProfile
        && agent.enabled
        && agent.status === "online"
        && !agent.active_run
        && agent.last_health_ok === true
        && agent.active_config_version_id
        && agent.hermes_profile === expectedProfile
        && agent.hermes_gateway_id
        && agent.credential_ready
        && agent.tool_inventory_digest
        && /^[0-9a-f]{64}$/.test(agent.tool_inventory_digest)
        && !agentPolicy);
      return {
        id: agent.id,
        orgId: agent.org_id,
        orgName: agent.org_name,
        orgKind: agent.org_kind,
        roleKey: agent.role_key,
        displayName: agent.display_name,
        enabled: agent.enabled,
        profile: agent.hermes_profile,
        expectedProfile,
        activeConfigVersionId: agent.active_config_version_id,
        configVersion: agent.config_version,
        identityMapped,
        inventoryCurrent,
        inventoryDigest: agent.tool_inventory_digest,
        inventoryExpiresAt: agent.tool_inventory_expires_at ? new Date(agent.tool_inventory_expires_at).toISOString() : null,
        inventoryToolCount: agent.tool_inventory_tool_count,
        canAcknowledgeFullCapabilities: canAcknowledge,
        lastProfileCheck: agent.check_status,
        lastProfileCheckAt: agent.checked_at ? new Date(agent.checked_at).toISOString() : null,
        toolPermissionsStatus: agent.tool_permissions_status,
        fullCapabilitiesAcknowledged: acknowledgementIsCurrent,
        acknowledgedBy: agent.acknowledged_by_name,
        acknowledgedAt: agent.acknowledged_at ? new Date(agent.acknowledged_at).toISOString() : null,
        policy: agentPolicy,
      };
    });
    const currentInternalAcknowledgements = agentView.filter((agent) => agent.orgKind === "agency");
    const inventoryComplete = currentInternalAcknowledgements.length > 0 && currentInternalAcknowledgements.every((agent) => agent.inventoryCurrent);
    const currentInternalDefault = {
      ...internalDefault,
      acknowledgedFullCapabilities: currentInternalAcknowledgements.length === AGENT_ROLE_KEYS.length
        && currentInternalAcknowledgements.every((agent) => agent.fullCapabilitiesAcknowledged),
    };
    const allowedAgentIds = agentView.map((agent) => agent.id);
    const { rows: history } = await db.query<{ scope_kind: HermesPolicyScope; action: string; actor_name: string; occurred_at: Date; policy_name: string }>(
      `select h.scope_kind,h.action,coalesce(nullif(u.full_name,''),u.email::text,'System') as actor_name,h.occurred_at,
         coalesce(h.policy_snapshot->>'name','Policy') as policy_name
       from hermes_tool_policy_history h left join users u on u.id=h.actor_user_id
       where h.scope_kind in ('internal_agency','client_default')
          or (h.scope_kind='client' and h.org_id=any($1::uuid[]))
          or (h.scope_kind='agent' and h.agent_id=any($2::uuid[]))
       order by h.occurred_at desc limit 100`,
      [clientIds, allowedAgentIds],
    );
    const clientsView = clients.map((client) => ({
      id: client.id,
      name: client.name,
      policy: clientOverrides.get(client.id) ?? null,
      agentIds: agentView.filter((agent) => agent.orgId === client.id).map((agent) => agent.id),
    }));
    return {
      editable: user.platformRole === "agency_super_admin",
      clientDefault,
      internalDefault: currentInternalDefault,
      clients: clientsView,
      agents: agentView,
      history: history.map((event) => ({ scopeKind: event.scope_kind, action: event.action, actorName: event.actor_name, occurredAt: new Date(event.occurred_at).toISOString(), policyName: event.policy_name })),
      capabilityOptions: HERMES_POLICY_CAPABILITIES,
      blockableToolsets: HERMES_BLOCKABLE_TOOLSETS,
      roleMatrix: CLIENT_ROLE_CAPABILITY_MATRIX,
      inventoryComplete,
      gatewayPolicyWriteSupported: false,
    };
  });
}

export async function saveHermesToolPolicy(
  admin: SessionUser,
  input: { scopeKind: "client_default" | "client" | "agent"; orgId?: string; agentId?: string; name: string; allowedCapabilities: HermesPolicyCapability[]; blockedToolsets: HermesBlockableToolset[]; approvalMode: HermesApprovalMode },
) {
  requireSuperAdmin(admin);
  const capabilities = [...new Set(input.allowedCapabilities)];
  const blocked = [...new Set(input.blockedToolsets)];
  const allowedCapabilityKeys = new Set(HERMES_POLICY_CAPABILITIES.map((option) => option.key));
  const allowedToolsets = new Set(HERMES_BLOCKABLE_TOOLSETS.map((option) => option.key));
  if (capabilities.some((key) => !allowedCapabilityKeys.has(key)) || blocked.some((key) => !allowedToolsets.has(key))) {
    throw new AppError("invalid_input", "The selected policy includes an unsupported capability or toolset.");
  }
  const name = input.name.trim().replace(/\s+/g, " ").slice(0, 80);
  if (!name) throw new AppError("invalid_input", "Enter a name for this policy.");
  if ((input.scopeKind === "client" && !input.orgId) || (input.scopeKind === "agent" && !input.agentId)) throw new AppError("invalid_input", "Choose the client or employee for this override.");

  await withSystem(async (db) => {
    let orgId: string | null = null;
    let agentId: string | null = null;
    if (input.scopeKind === "client") {
      const target = await db.query<{ kind: string }>("select kind from organizations where id=$1", [input.orgId]);
      if (target.rows[0]?.kind !== "client") throw new AppError("not_found", "Client workspace not found.");
      orgId = input.orgId!;
    } else if (input.scopeKind === "agent") {
      await db.query("select id from agent_instances where id=$1 for update", [input.agentId]);
      const target = await db.query<{ org_id: string; org_kind: string }>("select a.org_id,o.kind as org_kind from agent_instances a join organizations o on o.id=a.org_id where a.id=$1", [input.agentId]);
      if (!target.rows[0]) throw new AppError("not_found", "AI employee not found.");
      orgId = target.rows[0].org_id;
      agentId = input.agentId!;
    }
    const snapshot = { scopeKind: input.scopeKind, orgId, agentId, name, allowedCapabilities: capabilities, blockedToolsets: blocked, approvalMode: input.approvalMode, enforcementStatus: "not_enforced" };
    let result: { rows: Array<{ id: string }> };
    if (input.scopeKind === "client_default") {
      result = await db.query<{ id: string }>(
        `insert into hermes_tool_policies(scope_kind,name,allowed_capabilities,blocked_toolsets,approval_mode,updated_by)
         values('client_default',$1,$2::text[],$3::text[],$4,$5)
         on conflict(scope_kind) where scope_kind='client_default' do update
         set name=excluded.name,allowed_capabilities=excluded.allowed_capabilities,blocked_toolsets=excluded.blocked_toolsets,approval_mode=excluded.approval_mode,updated_by=excluded.updated_by
         returning id`,
        [name, capabilities, blocked, input.approvalMode, admin.id],
      );
    } else if (input.scopeKind === "client") {
      result = await db.query<{ id: string }>(
        `insert into hermes_tool_policies(scope_kind,org_id,name,allowed_capabilities,blocked_toolsets,approval_mode,updated_by)
         values('client',$1,$2,$3::text[],$4::text[],$5,$6)
         on conflict(org_id) where scope_kind='client' do update
         set name=excluded.name,allowed_capabilities=excluded.allowed_capabilities,blocked_toolsets=excluded.blocked_toolsets,approval_mode=excluded.approval_mode,updated_by=excluded.updated_by
         returning id`,
        [orgId, name, capabilities, blocked, input.approvalMode, admin.id],
      );
    } else {
      result = await db.query<{ id: string }>(
        `insert into hermes_tool_policies(scope_kind,org_id,agent_id,name,allowed_capabilities,blocked_toolsets,approval_mode,updated_by)
         values('agent',$1,$2,$3,$4::text[],$5::text[],$6,$7)
         on conflict(agent_id) where scope_kind='agent' do update
         set org_id=excluded.org_id,name=excluded.name,allowed_capabilities=excluded.allowed_capabilities,blocked_toolsets=excluded.blocked_toolsets,approval_mode=excluded.approval_mode,updated_by=excluded.updated_by
         returning id`,
        [orgId, agentId, name, capabilities, blocked, input.approvalMode, admin.id],
      );
    }
    const id = result.rows[0].id;
    await db.query(
      `insert into hermes_tool_policy_history(policy_id,scope_kind,org_id,agent_id,action,policy_snapshot,actor_user_id)
       values($1,$2,$3,$4,'updated',$5::jsonb,$6)`,
      [id, input.scopeKind, orgId, agentId, JSON.stringify(snapshot), admin.id],
    );
    await recordAudit({ orgId, actorUserId: admin.id, actorKind: "agency", action: "workforce.tool_policy_updated", targetType: "hermes_tool_policy", targetId: id, result: "success", metadata: { scopeKind: input.scopeKind, agentId, name, enforcement: "not_enforced" } }, db);
  });
}

export async function resetHermesToolPolicy(admin: SessionUser, target: { scopeKind: "client" | "agent"; orgId?: string; agentId?: string }) {
  requireSuperAdmin(admin);
  if ((target.scopeKind === "client" && !target.orgId) || (target.scopeKind === "agent" && !target.agentId)) throw new AppError("invalid_input", "Choose the client or employee whose policy should reset.");
  await withSystem(async (db) => {
    if (target.scopeKind === "agent") await db.query("select id from agent_instances where id=$1 for update", [target.agentId]);
    const select = target.scopeKind === "client"
      ? await db.query<PolicyRow>("select * from hermes_tool_policies where scope_kind='client' and org_id=$1 for update", [target.orgId])
      : await db.query<PolicyRow>("select * from hermes_tool_policies where scope_kind='agent' and agent_id=$1 for update", [target.agentId]);
    const policy = select.rows[0];
    if (!policy) return;
    await db.query("delete from hermes_tool_policies where id=$1", [policy.id]);
    await db.query(
      `insert into hermes_tool_policy_history(policy_id,scope_kind,org_id,agent_id,action,policy_snapshot,actor_user_id)
       values($1,$2,$3,$4,'reset',$5::jsonb,$6)`,
      [null, target.scopeKind, policy.org_id, policy.agent_id, JSON.stringify({ ...policyRecord(policy), resetToDefault: true }), admin.id],
    );
    await recordAudit({ orgId: policy.org_id, actorUserId: admin.id, actorKind: "agency", action: "workforce.tool_policy_reset", targetType: "hermes_tool_policy", targetId: policy.id, result: "success", metadata: { scopeKind: target.scopeKind, agentId: policy.agent_id } }, db);
  });
}

export interface InternalCapabilitiesAcknowledgementTarget {
  agentId: string;
  expectedActiveConfigVersionId: string;
}

interface InternalAcknowledgementSnapshot {
  id: string;
  org_id: string;
  role_key: AgentRoleKey;
  enabled: boolean;
  status: string;
  active_run: boolean;
  last_health_ok: boolean | null;
  active_config_version_id: string | null;
  config_version: number | null;
  hermes_profile: string | null;
  hermes_gateway_id: string | null;
  credential_id: string;
  credential_fingerprint: string;
  credential_reference_id: string;
  credential_reference_fingerprint: string;
  credential_reference_version: number;
  credential_ready: boolean;
  gateway_revision: number | null;
  tool_inventory_contract: string | null;
  tool_inventory_digest: string | null;
  tool_inventory_verified_at: Date | null;
  tool_inventory_expires_at: Date | null;
  tool_inventory_tool_count: number | null;
  agent_policy_override_id: string | null;
}

function parseInventorySnapshot(value: ToolInventorySnapshot | string | null): ToolInventorySnapshot | null {
  if (!value) return null;
  try {
    return typeof value === "string" ? JSON.parse(value) as ToolInventorySnapshot : value;
  } catch {
    return null;
  }
}

function baselineIsAcknowledgementEligible(agent: InternalAcknowledgementSnapshot, target: InternalCapabilitiesAcknowledgementTarget): boolean {
  return Boolean(
    agent.enabled
    && agent.status === "online"
    && !agent.active_run
    && agent.last_health_ok === true
    && agent.active_config_version_id === target.expectedActiveConfigVersionId
    && agent.hermes_profile === AGENCY_HERMES_PROFILE_IDS[agent.role_key]
    && agent.hermes_gateway_id
    && agent.credential_ready
    && agent.tool_inventory_contract === TOOL_INVENTORY_CONTRACT
    && agent.tool_inventory_digest
    && /^[0-9a-f]{64}$/.test(agent.tool_inventory_digest)
    && agent.tool_inventory_verified_at
    && agent.tool_inventory_expires_at
    && (agent.tool_inventory_tool_count ?? 0) > 0
    && !agent.agent_policy_override_id,
  );
}

/**
 * Acknowledge only after refreshing one existing saved-profile identity check and the persisted complete
 * inventory for every selected internal employee. These diagnostics use read-only Hermes endpoints and never
 * submit a run. The final transaction binds the acknowledgement to the exact config, identity and inventory.
 */
export async function acknowledgeInternalFullCapabilities(admin: SessionUser, targets: InternalCapabilitiesAcknowledgementTarget[]) {
  requireSuperAdmin(admin);
  const targetById = new Map(targets.map((target) => [target.agentId, target]));
  if (!targets.length || targets.length > AGENT_ROLE_KEYS.length || targetById.size !== targets.length) {
    throw new AppError("invalid_input", "Select one or more distinct internal profiles to acknowledge.");
  }
  if (targets.some((target) => !target.expectedActiveConfigVersionId)) {
    throw new AppError("invalid_input", "Reload the page and select an employee with an applied configuration.");
  }

  const baseline = await withSystem(async (db) => {
    const { rows: agencyRows } = await db.query<{ id: string }>("select id from organizations where kind='agency' order by created_at limit 1");
    const agencyOrgId = agencyRows[0]?.id;
    if (!agencyOrgId) throw new AppError("not_found", "The iAcquire internal workforce is unavailable.");
    const { rows } = await db.query<InternalAcknowledgementSnapshot>(
      `select a.id,a.org_id,a.role_key,a.enabled,a.status,a.last_health_ok,
         exists(select 1 from agent_runs r where r.agent_instance_id=a.id and r.status in ('queued','running')) as active_run,
         a.active_config_version_id,v.version as config_version,a.hermes_profile,a.hermes_gateway_id,
         a.credential_id,cred.fingerprint as credential_fingerprint,cred_ref.id as credential_reference_id,
         cred_ref.fingerprint as credential_reference_fingerprint,cred_ref.version as credential_reference_version,
         (cred.id is not null and cred.revoked_at is null and cred.credential_reference_id is not null and cred_ref.revoked_at is null) as credential_ready,
         g.revision as gateway_revision,a.tool_inventory_contract,a.tool_inventory_digest,a.tool_inventory_verified_at,a.tool_inventory_expires_at,
         a.tool_inventory_tool_count,agent_policy.id as agent_policy_override_id
       from agent_instances a join organizations o on o.id=a.org_id and o.kind='agency'
       left join agent_config_versions v on v.id=a.active_config_version_id
       left join hermes_gateways g on g.id=a.hermes_gateway_id
       left join integration_credentials cred on cred.id=a.credential_id and cred.org_id=a.org_id and cred.provider='hermes'
       left join credential_references cred_ref on cred_ref.id=cred.credential_reference_id and cred_ref.org_id=a.org_id and cred_ref.provider='hermes'
       left join hermes_tool_policies agent_policy on agent_policy.scope_kind='agent' and agent_policy.agent_id=a.id
       where a.id=any($1::uuid[]) and a.org_id=$2`,
      [[...targetById.keys()], agencyOrgId],
    );
    if (rows.length !== targets.length) throw new AppError("not_found", "One or more selected employees are not in the internal iAcquire workforce.");
    const byId = new Map(rows.map((row) => [row.id, row]));
    const ordered = targets.map((target) => byId.get(target.agentId)!);
    if (ordered.some((row, index) => !baselineIsAcknowledgementEligible(row, targets[index]))) {
      throw new AppError("conflict", "The selected employee must be enabled with an applied configuration, a passing health check, an existing verified inventory, an active saved profile credential, and no employee-specific override.");
    }
    if (new Set(ordered.map((row) => row.role_key)).size !== ordered.length) {
      throw new AppError("invalid_input", "Select each internal employee only once from the same iAcquire workforce.");
    }
    return { agencyOrgId, agents: ordered };
  });

  const refreshed = new Map<string, { identityCheckedAt: string }>();
  for (const agent of baseline.agents) {
    const identity = await refreshExistingAgencyProfileEvidence(admin, agent.id);
    if (!identity.ok || identity.status !== "verified" || !identity.identityVerified || !identity.apiContractVerified || identity.toolPermissionsStatus !== "verified") {
      throw new AppError("conflict", `${AGENT_BY_KEY[agent.role_key].shortName} identity or tool-permission verification failed: ${identity.detail}`);
    }
    const health = await runHealthCheck(agent.id, { userId: admin.id, kind: "agency" }, { skipSetupSync: true });
    if (!health.ok || health.status !== "online") {
      throw new AppError("conflict", `${AGENT_BY_KEY[agent.role_key].shortName} inventory refresh did not pass: ${health.detail}`);
    }
    refreshed.set(agent.id, { identityCheckedAt: identity.checkedAt! });
  }

  await withSystem(async (db) => {
    const policy = await db.query<{ id: string }>(
      "select id from hermes_tool_policies where scope_kind='internal_agency' and name='Full Hermes Capabilities' for update",
    );
    const policyId = policy.rows[0]?.id;
    if (!policyId) throw new AppError("internal", "The internal Full Hermes Capabilities policy is unavailable.");

    const finalRows: Array<{
      agent: InternalAcknowledgementSnapshot & {
        checked_profile: string | null; checked_gateway_id: string | null; check_status: string | null;
        identity_verified: boolean | null; api_contract_verified: boolean | null; tool_permissions_status: string | null; checked_at: Date;
        config_applied_at: Date; tool_inventory_snapshot: ToolInventorySnapshot | string | null;
      };
      target: InternalCapabilitiesAcknowledgementTarget;
      evidence: { identityCheckedAt: string };
      inventorySnapshot: ToolInventorySnapshot;
    }> = [];

    for (let index = 0; index < baseline.agents.length; index += 1) {
      const before = baseline.agents[index];
      const target = targets[index];
      const evidence = refreshed.get(before.id)!;
      const locked = await db.query<InternalAcknowledgementSnapshot & {
        checked_profile: string | null; checked_gateway_id: string | null; check_status: string | null;
        identity_verified: boolean | null; api_contract_verified: boolean | null; tool_permissions_status: string | null; checked_at: Date;
        config_applied_at: Date; tool_inventory_snapshot: ToolInventorySnapshot | string | null;
      }>(
        `select a.id,a.org_id,a.role_key,a.enabled,a.status,a.last_health_ok,
           exists(select 1 from agent_runs r where r.agent_instance_id=a.id and r.status in ('queued','running')) as active_run,
           a.active_config_version_id,v.version as config_version,a.hermes_profile,a.hermes_gateway_id,
           a.credential_id,cred.fingerprint as credential_fingerprint,cred_ref.id as credential_reference_id,
           cred_ref.fingerprint as credential_reference_fingerprint,cred_ref.version as credential_reference_version,
           (cred.id is not null and cred.revoked_at is null and cred.credential_reference_id is not null and cred_ref.revoked_at is null) as credential_ready,
           g.revision as gateway_revision,a.tool_inventory_contract,a.tool_inventory_digest,a.tool_inventory_verified_at,a.tool_inventory_expires_at,
           a.tool_inventory_tool_count,agent_policy.id as agent_policy_override_id,
           c.profile_id as checked_profile,c.gateway_id as checked_gateway_id,c.status as check_status,c.identity_verified,c.api_contract_verified,
           c.tool_permissions_status,c.checked_at,v.applied_at as config_applied_at,a.tool_inventory_snapshot
         from agent_instances a join organizations o on o.id=a.org_id and o.kind='agency'
         join hermes_gateways g on g.id=a.hermes_gateway_id
         join agent_config_versions v on v.id=a.active_config_version_id
         join agency_hermes_profile_checks c on c.agent_instance_id=a.id and c.org_id=a.org_id
         join integration_credentials cred on cred.id=a.credential_id and cred.org_id=a.org_id and cred.provider='hermes'
         join credential_references cred_ref on cred_ref.id=cred.credential_reference_id and cred_ref.org_id=a.org_id and cred_ref.provider='hermes'
         left join hermes_tool_policies agent_policy on agent_policy.scope_kind='agent' and agent_policy.agent_id=a.id
         where a.id=$1 and a.org_id=$2
         for update of a,c,cred,cred_ref,g`,
        [before.id, baseline.agencyOrgId],
      );
      const current = locked.rows[0];
      const override = await db.query<{ id: string }>("select id from hermes_tool_policies where scope_kind='agent' and agent_id=$1", [before.id]);
      const inventorySnapshot = parseInventorySnapshot(current?.tool_inventory_snapshot ?? null);
      const expectedProfile = current ? AGENCY_HERMES_PROFILE_IDS[current.role_key] : null;
      const inventorySnapshotCurrent = Boolean(inventorySnapshot
        && expectedProfile
        && inventorySnapshot.contract === TOOL_INVENTORY_CONTRACT
        && inventorySnapshot.profile === expectedProfile
        && inventorySnapshot.digest === current?.tool_inventory_digest
        && inventorySnapshot.toolCount === current?.tool_inventory_tool_count
        && Array.isArray(inventorySnapshot.tools)
        && inventorySnapshot.tools.length === current?.tool_inventory_tool_count
        && Array.isArray(inventorySnapshot.enabledToolsets));
      if (!current
        || !baselineIsAcknowledgementEligible(current, target)
        || current.org_id !== before.org_id
        || current.role_key !== before.role_key
        || current.active_config_version_id !== before.active_config_version_id
        || current.hermes_profile !== before.hermes_profile
        || current.hermes_gateway_id !== before.hermes_gateway_id
        || current.credential_id !== before.credential_id
        || current.credential_fingerprint !== before.credential_fingerprint
        || current.credential_reference_id !== before.credential_reference_id
        || current.credential_reference_fingerprint !== before.credential_reference_fingerprint
        || current.credential_reference_version !== before.credential_reference_version
        || current.gateway_revision !== before.gateway_revision
        || current.tool_inventory_digest !== before.tool_inventory_digest
        || current.agent_policy_override_id
        || override.rows.length
        || !internalIdentityIsCurrent({
          expectedProfile: AGENCY_HERMES_PROFILE_IDS[current.role_key],
          savedProfile: current.hermes_profile,
          savedGatewayId: current.hermes_gateway_id,
          checkedProfile: current.checked_profile,
          checkedGatewayId: current.checked_gateway_id,
          checkStatus: current.check_status,
          identityVerified: current.identity_verified,
          apiContractVerified: current.api_contract_verified,
          toolPermissionsStatus: current.tool_permissions_status,
          checkedAt: current.checked_at,
          configAppliedAt: current.config_applied_at,
        })
        || current.checked_at.toISOString() !== evidence.identityCheckedAt
        || !toolInventoryReady(current)
        || !inventorySnapshotCurrent
        || current.last_health_ok !== true
        || current.status !== "online") {
        throw new AppError("conflict", `${AGENT_BY_KEY[before.role_key].shortName} changed during verification or no longer has a current, approved configuration, identity, credential and inventory. No acknowledgement was recorded.`);
      }
      finalRows.push({ agent: current, target, evidence, inventorySnapshot: inventorySnapshot! });
    }

    for (const { agent, evidence, inventorySnapshot } of finalRows) {
      const profile = AGENCY_HERMES_PROFILE_IDS[agent.role_key];
      const policySnapshot = {
        name: "Full Hermes Capabilities",
        profile,
        acknowledgedBy: admin.id,
        enforcementStatus: "not_enforced",
        activeConfigVersionId: agent.active_config_version_id,
        configVersion: agent.config_version,
        configAppliedAt: agent.config_applied_at.toISOString(),
        inventoryContract: agent.tool_inventory_contract,
        inventoryDigest: agent.tool_inventory_digest,
        inventoryToolCount: agent.tool_inventory_tool_count,
        inventoryToolsets: inventorySnapshot.enabledToolsets,
        inventoryTools: inventorySnapshot.tools.map((tool) => ({ name: tool.name, toolset: tool.toolset, source: tool.source, sourceServer: tool.sourceServer, available: tool.available })),
        inventoryVerifiedAt: agent.tool_inventory_verified_at?.toISOString() ?? null,
        inventoryExpiresAt: agent.tool_inventory_expires_at?.toISOString() ?? null,
        identityCheckedAt: evidence.identityCheckedAt,
        inventoryCheckedAt: agent.tool_inventory_verified_at?.toISOString() ?? null,
      };
      await db.query(
        `insert into hermes_tool_policy_acknowledgements(agent_id,policy_id,verified_profile,acknowledged_by)
         values($1,$2,$3,$4) on conflict(agent_id) do update
         set policy_id=excluded.policy_id,verified_profile=excluded.verified_profile,acknowledged_by=excluded.acknowledged_by,acknowledged_at=now()`,
        [agent.id, policyId, profile, admin.id],
      );
      await db.query(
        `insert into hermes_tool_policy_history(policy_id,scope_kind,org_id,agent_id,action,policy_snapshot,actor_user_id)
         values($1,'internal_agency',$2,$3,'full_capabilities_acknowledged',$4::jsonb,$5)`,
        [policyId, agent.org_id, agent.id, JSON.stringify(policySnapshot), admin.id],
      );
      await recordAudit({
        orgId: agent.org_id,
        actorUserId: admin.id,
        actorKind: "agency",
        agentInstanceId: agent.id,
        action: "workforce.full_capabilities_acknowledged",
        targetType: "agent_instance",
        targetId: agent.id,
        result: "success",
        metadata: {
          roleKey: agent.role_key,
          profile,
          activeConfigVersionId: agent.active_config_version_id,
          inventoryDigest: agent.tool_inventory_digest,
          inventoryToolCount: agent.tool_inventory_tool_count,
          inventoryVerifiedAt: agent.tool_inventory_verified_at?.toISOString() ?? null,
          identityCheckedAt: evidence.identityCheckedAt,
          enforcement: "existing_profile_capabilities_only",
          modelRunSubmitted: false,
        },
      }, db);
    }

    const currentAcknowledgements = await db.query<{ count: number }>(
      `select count(*)::int as count
       from agent_instances a join organizations o on o.id=a.org_id and o.kind='agency'
       join agent_config_versions v on v.id=a.active_config_version_id
       join agency_hermes_profile_checks c on c.agent_instance_id=a.id and c.org_id=a.org_id
       join hermes_tool_policy_acknowledgements ack on ack.agent_id=a.id
       join lateral (
         select h.policy_snapshot from hermes_tool_policy_history h
         where h.agent_id=a.id and h.action='full_capabilities_acknowledged'
         order by h.occurred_at desc,h.id desc limit 1
       ) h on true
       where a.org_id=$1 and a.role_key=any($2::text[]) and a.enabled
         and ack.policy_id=$3 and ack.verified_profile=a.hermes_profile
         and ack.acknowledged_at>=c.checked_at and c.status='verified' and c.identity_verified and c.api_contract_verified and c.tool_permissions_status='verified'
         and c.profile_id=a.hermes_profile and c.gateway_id=a.hermes_gateway_id and c.checked_at>=v.applied_at
         and h.policy_snapshot->>'activeConfigVersionId'=a.active_config_version_id::text
         and h.policy_snapshot->>'inventoryDigest'=a.tool_inventory_digest
         and a.last_health_ok and a.tool_inventory_contract=$4 and a.tool_inventory_digest ~ '^[0-9a-f]{64}$'
         and not exists(select 1 from hermes_tool_policies p where p.scope_kind='agent' and p.agent_id=a.id)`,
      [baseline.agencyOrgId, AGENT_ROLE_KEYS, policyId, TOOL_INVENTORY_CONTRACT],
    );
    const complete = currentAcknowledgements.rows[0]?.count === AGENT_ROLE_KEYS.length;
    await db.query(
      `update hermes_tool_policies set acknowledged_full_capabilities=$2,acknowledged_by=$3,
         acknowledged_at=case when $2 then now() else null end,updated_by=$3 where id=$1`,
      [policyId, complete, complete ? admin.id : null],
    );
  });
}
