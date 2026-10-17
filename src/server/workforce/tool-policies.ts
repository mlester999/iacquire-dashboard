import "server-only";
import { AGENT_BY_KEY, AGENT_ROLE_KEYS, AGENCY_HERMES_PROFILE_IDS, type AgentRoleKey } from "@/lib/agents";
import { type SessionUser } from "@/server/auth/service";
import { withSystem } from "@/server/db";
import { recordAudit } from "@/server/audit";
import { AppError } from "@/server/errors";

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
] as const;
export type HermesBlockableToolset = (typeof HERMES_BLOCKABLE_TOOLSETS)[number]["key"];

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
    profile: string | null; expectedProfile: string | null; identityMapped: boolean; lastProfileCheck: string | null;
    lastProfileCheckAt: string | null; toolPermissionsStatus: string | null; fullCapabilitiesAcknowledged: boolean;
    acknowledgedBy: string | null; acknowledgedAt: string | null; policy: HermesPolicyRecord | null;
  }>;
  history: Array<{ scopeKind: HermesPolicyScope; action: string; actorName: string; occurredAt: string; policyName: string }>;
  capabilityOptions: typeof HERMES_POLICY_CAPABILITIES;
  blockableToolsets: typeof HERMES_BLOCKABLE_TOOLSETS;
  roleMatrix: typeof CLIENT_ROLE_CAPABILITY_MATRIX;
  inventoryComplete: false;
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
      hermes_profile: string | null; check_status: string | null; check_profile: string | null; api_contract_verified: boolean; tool_permissions_status: string | null; checked_at: Date | null;
      acknowledged_profile: string | null; acknowledged_by_name: string | null; acknowledged_at: Date | null;
    }>(
      `select a.id,a.org_id,o.name as org_name,o.kind as org_kind,a.role_key,a.display_name,a.enabled,a.hermes_profile,
         c.status as check_status,c.profile_id as check_profile,c.api_contract_verified,c.tool_permissions_status,c.checked_at,
         ack.verified_profile as acknowledged_profile,coalesce(nullif(ack_user.full_name,''),ack_user.email::text) as acknowledged_by_name,ack.acknowledged_at
       from agent_instances a join organizations o on o.id=a.org_id
       left join agency_hermes_profile_checks c on c.agent_instance_id=a.id
       left join hermes_tool_policy_acknowledgements ack on ack.agent_id=a.id
       left join users ack_user on ack_user.id=ack.acknowledged_by
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
    const agentView = agents.map((agent) => {
      const expectedProfile = agent.org_kind === "agency" ? AGENCY_HERMES_PROFILE_IDS[agent.role_key] : null;
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
        identityMapped: Boolean(expectedProfile && agent.hermes_profile === expectedProfile && agent.check_profile === expectedProfile && agent.check_status === "verified" && agent.api_contract_verified),
        lastProfileCheck: agent.check_status,
        lastProfileCheckAt: agent.checked_at ? new Date(agent.checked_at).toISOString() : null,
        toolPermissionsStatus: agent.tool_permissions_status,
        fullCapabilitiesAcknowledged: Boolean(expectedProfile && agent.acknowledged_profile === expectedProfile),
        acknowledgedBy: agent.acknowledged_by_name,
        acknowledgedAt: agent.acknowledged_at ? new Date(agent.acknowledged_at).toISOString() : null,
        policy: agentOverrides.get(agent.id) ?? null,
      };
    });
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
      internalDefault,
      clients: clientsView,
      agents: agentView,
      history: history.map((event) => ({ scopeKind: event.scope_kind, action: event.action, actorName: event.actor_name, occurredAt: new Date(event.occurred_at).toISOString(), policyName: event.policy_name })),
      capabilityOptions: HERMES_POLICY_CAPABILITIES,
      blockableToolsets: HERMES_BLOCKABLE_TOOLSETS,
      roleMatrix: CLIENT_ROLE_CAPABILITY_MATRIX,
      // No completed inventory endpoint exists in the installed Hermes v0.21.5 API contract.
      inventoryComplete: false,
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

export async function acknowledgeInternalFullCapabilities(admin: SessionUser, agentIds: string[]) {
  requireSuperAdmin(admin);
  const ids = [...new Set(agentIds)];
  if (!ids.length || ids.length > AGENT_ROLE_KEYS.length) throw new AppError("invalid_input", "Select at least one internal profile to acknowledge.");
  await withSystem(async (db) => {
    const policy = await db.query<{ id: string }>("select id from hermes_tool_policies where scope_kind='internal_agency' and name='Full Hermes Capabilities' for update");
    if (!policy.rows[0]) throw new AppError("internal", "The internal Full Hermes Capabilities policy is unavailable.");
    const { rows } = await db.query<{
      id: string; org_id: string; role_key: AgentRoleKey; enabled: boolean; hermes_profile: string | null; hermes_gateway_id: string | null;
      check_profile: string | null; check_gateway_id: string | null; check_status: string | null;
      identity_verified: boolean; api_contract_verified: boolean; credential_ready: boolean;
    }>(
      `select a.id,a.org_id,a.role_key,a.enabled,a.hermes_profile,a.hermes_gateway_id,c.profile_id as check_profile,c.gateway_id as check_gateway_id,
         c.status as check_status,c.identity_verified,c.api_contract_verified,
         (a.credential_id is not null and cred.revoked_at is null) as credential_ready
       from agent_instances a join organizations o on o.id=a.org_id and o.kind='agency'
       left join integration_credentials cred on cred.id=a.credential_id
       left join agency_hermes_profile_checks c on c.agent_instance_id=a.id and c.org_id=a.org_id
       where a.id=any($1::uuid[])`,
      [ids],
    );
    if (rows.length !== ids.length || rows.some((agent) =>
      !agent.enabled
      || agent.hermes_profile !== AGENCY_HERMES_PROFILE_IDS[agent.role_key]
      || agent.check_profile !== AGENCY_HERMES_PROFILE_IDS[agent.role_key]
      || agent.hermes_gateway_id !== agent.check_gateway_id
      || agent.check_status !== "verified" || !agent.identity_verified || !agent.api_contract_verified || !agent.credential_ready
    )) {
      throw new AppError("conflict", "Enable each profile and complete a verified, authenticated identity check before acknowledging Full Hermes Capabilities.");
    }
    const agencyOrgId = rows[0].org_id;
    if (rows.some((agent) => agent.org_id !== agencyOrgId) || new Set(rows.map((agent) => agent.role_key)).size !== rows.length) {
      throw new AppError("invalid_input", "Select each internal employee only once from the same iAcquire workforce.");
    }
    for (const agent of rows) {
      const profile = AGENCY_HERMES_PROFILE_IDS[agent.role_key];
      await db.query(
        `insert into hermes_tool_policy_acknowledgements(agent_id,policy_id,verified_profile,acknowledged_by)
         values($1,$2,$3,$4) on conflict(agent_id) do update
         set policy_id=excluded.policy_id,verified_profile=excluded.verified_profile,acknowledged_by=excluded.acknowledged_by,acknowledged_at=now()`,
        [agent.id, policy.rows[0].id, profile, admin.id],
      );
      const snapshot = { name: "Full Hermes Capabilities", profile, acknowledgedBy: admin.id, enforcementStatus: "not_enforced", inventoryCompleteness: "unverified" };
      await db.query(
        `insert into hermes_tool_policy_history(policy_id,scope_kind,org_id,agent_id,action,policy_snapshot,actor_user_id)
         select $1,'internal_agency',a.org_id,a.id,'full_capabilities_acknowledged',$2::jsonb,$3 from agent_instances a where a.id=$4`,
        [policy.rows[0].id, JSON.stringify(snapshot), admin.id, agent.id],
      );
      await recordAudit({ actorUserId: admin.id, actorKind: "agency", agentInstanceId: agent.id, action: "workforce.full_capabilities_acknowledged", targetType: "agent_instance", targetId: agent.id, result: "success", metadata: { roleKey: agent.role_key, profile, inventoryCompleteness: "unverified", enforcement: "existing_profile_capabilities_only" } }, db);
    }
    const allProfilesAck = await db.query<{ count: number }>(
      `select count(*)::int as count from agent_instances a join organizations o on o.id=a.org_id and o.kind='agency'
       join hermes_tool_policy_acknowledgements ack on ack.agent_id=a.id
       where a.org_id=$2 and a.role_key=any($1::text[])`,
      [AGENT_ROLE_KEYS, agencyOrgId],
    );
    const complete = allProfilesAck.rows[0]?.count === AGENT_ROLE_KEYS.length;
    await db.query(
      `update hermes_tool_policies set acknowledged_full_capabilities=$2,acknowledged_by=$3,acknowledged_at=case when $2 then now() else null end,updated_by=$3
       where id=$1`,
      [policy.rows[0].id, complete, admin.id],
    );
  });
}
