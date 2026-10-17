import "server-only";
import { withServiceRole, withSystem, withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import { agencyCanAccessOrg } from "@/server/tenancy/context";
import { usageSummary, type UsageSummary } from "@/server/usage";
import type { SessionUser } from "@/server/auth/service";
import type { AgentRoleKey, AgentStatus } from "@/lib/agents";
import { ensureAgencyWorkforceRegistry } from "@/server/workforce/agency-registry";

export interface TenantDetail {
  access: {
    team: boolean;
    workforce: boolean;
    integrations: boolean;
    setup: boolean;
  };
  org: {
    id: string;
    name: string;
    slug: string;
    status: string;
    kind: string;
    is_demo: boolean;
    industry: string | null;
    website: string | null;
    timezone: string;
    created_at: Date;
    onboarding_completed_at: Date | null;
    suspended_reason: string | null;
  };
  members: Array<{ user_id: string; full_name: string; email: string; role: string; status: string; last_login_at: Date | null }>;
  invitations: Array<{
    id: string;
    email: string;
    role: string | null;
    expires_at: Date;
    created_at: Date;
    expired: boolean;
    /** Outcome of the most recent invitation email for this address: queued, captured (not delivered), sent or failed. */
    email_status: string | null;
    email_error: string | null;
    email_at: Date | null;
  }>;
  agents: Array<{
    id: string;
    role_key: AgentRoleKey;
    display_name: string;
    enabled: boolean;
    status: AgentStatus;
    hermes_profile: string | null;
    hermes_host: string | null;
    has_credential: boolean;
    last_health_check_at: Date | null;
    last_health_detail: string | null;
    config_version: number | null;
    config_summary: string | null;
    held_versions: number;
    runs_30d: number;
    failed_30d: number;
  }>;
  heldVersions: Array<{ id: string; agent_role: AgentRoleKey; version: number; summary: string; risk_flags: string[]; change_request: string | null; created_at: Date }>;
  heldKnowledge: Array<{ section: string; content: string; risk_flags: string[]; updated_at: Date }>;
  provisioning: Array<{ id: string; agent_role: AgentRoleKey; kind: string; status: string; detail: string | null; created_at: Date }>;
  ghl: { location_id: string; location_name: string | null; pipeline_id: string | null; calendar_ids: string[]; status: string; verified_at: Date | null; has_credential: boolean } | null;
  integrations: Array<{ provider: string; status: string; detail: string | null; last_checked_at: Date | null }>;
  billing: { setup_fee_cents: number; currency: string; setup_payment_status: string; activation_status: string; invoice_url: string | null; receipt_url: string | null; paid_at: Date | null; service_terms: string | null } | null;
  usage: UsageSummary;
  staff: Array<{ user_id: string; full_name: string; email: string; assigned: boolean }>;
  failedRuns: Array<{ id: string; agent_role: AgentRoleKey; error_code: string | null; error_message: string | null; finished_at: Date | null }>;
}

export async function getTenantDetail(user: SessionUser, orgId: string): Promise<TenantDetail> {
  if (!(await agencyCanAccessOrg(user, orgId))) throw new AppError("not_found", "Client not found.");
  return withSystem(async (db) => {
    const accessResult = await db.query<{ team: boolean; workforce: boolean; integrations: boolean; setup: boolean }>(
      `select coalesce(app.user_has_agency_permission($1,'agency.clients.invite_users'),false) as team,
              coalesce(app.user_has_agency_permission($1,'agency.workforce.view'),false) as workforce,
              coalesce(app.user_has_agency_permission($1,'agency.integrations.health'),false) as integrations,
              coalesce(app.user_has_agency_permission($1,'setup.manage'),false) as setup`,
      [user.id],
    );
    const access = accessResult.rows[0] ?? { team: false, workforce: false, integrations: false, setup: false };
    const { rows: org } = await db.query<TenantDetail["org"]>(
      "select id, name, slug, status, kind, is_demo, industry, website, timezone, created_at, onboarding_completed_at, suspended_reason from organizations where id = $1",
      [orgId],
    );
    if (!org[0]) throw new AppError("not_found", "Client not found.");
    const members = await db.query<TenantDetail["members"][number]>(
      `select u.id as user_id, u.full_name, u.email, m.role, m.status, u.last_login_at
       from organization_memberships m join users u on u.id = m.user_id where m.org_id = $1 order by m.role, u.full_name`,
      [orgId],
    );
    const invitations = await db.query<TenantDetail["invitations"][number]>(
      // Expired invitations stay listed so they can be resent; the email columns report what really happened to the message.
      `select i.id, i.email::text as email, i.role, i.expires_at, i.created_at, (i.expires_at <= now()) as expired,
              m.status as email_status, m.error as email_error, m.created_at as email_at
       from invitations i
       left join lateral (
         select o.status, o.error, o.created_at from email_outbox o
         where o.to_email = i.email and o.template = 'invitation' and o.created_at >= i.created_at
         order by o.created_at desc limit 1
       ) m on true
       where i.org_id = $1 and i.accepted_at is null and i.revoked_at is null
       order by i.created_at desc`,
      [orgId],
    );
    const agents = await db.query<TenantDetail["agents"][number]>(
      `select a.id, a.role_key, a.display_name, a.enabled, a.status, a.hermes_profile,
              substring(a.hermes_base_url from '^https?://([^/]+)') as hermes_host,
              (a.credential_id is not null) as has_credential, a.last_health_check_at, a.last_health_detail,
              v.version as config_version, v.summary as config_summary,
              (select count(*)::int from agent_config_versions h where h.agent_instance_id = a.id and h.status = 'pending_agency_review') as held_versions,
              (select count(*)::int from agent_runs r where r.agent_instance_id = a.id and r.started_at > now() - interval '30 days') as runs_30d,
              (select count(*)::int from agent_runs r where r.agent_instance_id = a.id and r.status in ('failed','timeout','interrupted') and r.started_at > now() - interval '30 days') as failed_30d
       from agent_instances a join agent_roles ro on ro.key = a.role_key
       left join agent_config_versions v on v.id = a.active_config_version_id
       where a.org_id = $1 order by ro.sort_order`,
      [orgId],
    );
    const held = await db.query<TenantDetail["heldVersions"][number]>(
      `select v.id, a.role_key as agent_role, v.version, v.summary, v.risk_flags, v.change_request, v.created_at
       from agent_config_versions v join agent_instances a on a.id = v.agent_instance_id
       where v.org_id = $1 and v.status = 'pending_agency_review' order by v.created_at`,
      [orgId],
    );
    const heldKnowledge = await db.query<TenantDetail["heldKnowledge"][number]>(
      "select section, content, risk_flags, updated_at from company_knowledge where org_id = $1 and review_status = 'pending_agency_review'",
      [orgId],
    );
    const provisioning = await db.query<TenantDetail["provisioning"][number]>(
      `select j.id, a.role_key as agent_role, j.kind, j.status, j.detail, j.created_at
       from agent_provisioning_jobs j join agent_instances a on a.id = j.agent_instance_id
       where j.org_id = $1 order by j.created_at desc limit 30`,
      [orgId],
    );
    const ghl = await db.query<NonNullable<TenantDetail["ghl"]>>(
      `select g.location_id, g.location_name, g.pipeline_id, g.calendar_ids, g.status, g.verified_at,
              (g.credential_id is not null and c.revoked_at is null) as has_credential
       from ghl_location_mappings g left join integration_credentials c on c.id = g.credential_id where g.org_id = $1`,
      [orgId],
    );
    const integrations = await db.query<TenantDetail["integrations"][number]>(
      "select provider, status, detail, last_checked_at from integration_status where org_id = $1 order by provider",
      [orgId],
    );
    const billing = await db.query<NonNullable<TenantDetail["billing"]>>(
      "select setup_fee_cents, currency, setup_payment_status, activation_status, invoice_url, receipt_url, paid_at, service_terms from billing_accounts where org_id = $1",
      [orgId],
    );
    const staff = await db.query<TenantDetail["staff"][number]>(
      `select u.id as user_id, u.full_name, u.email, exists (select 1 from staff_assignments s where s.org_id = $1 and s.user_id = u.id) as assigned
       from users u where u.platform_role = 'agency_staff' and u.status = 'active' order by u.full_name`,
      [orgId],
    );
    const failedRuns = await db.query<TenantDetail["failedRuns"][number]>(
      `select r.id, a.role_key as agent_role, r.error_code, r.error_message, r.finished_at
       from agent_runs r join agent_instances a on a.id = r.agent_instance_id
       where r.org_id = $1 and r.status in ('failed', 'timeout', 'interrupted') order by r.finished_at desc nulls last limit 10`,
      [orgId],
    );
    return {
      access,
      org: org[0],
      members: access.team ? members.rows : [],
      invitations: access.team ? invitations.rows : [],
      agents: access.workforce ? agents.rows : [],
      heldVersions: access.workforce ? held.rows : [],
      heldKnowledge: access.workforce ? heldKnowledge.rows : [],
      provisioning: access.workforce ? provisioning.rows : [],
      ghl: access.integrations ? ghl.rows[0] ?? null : null,
      integrations: access.integrations ? integrations.rows : [],
      billing: access.setup ? billing.rows[0] ?? null : null,
      usage: await usageSummary(db, orgId),
      staff: access.team ? staff.rows : [],
      failedRuns: access.workforce ? failedRuns.rows : [],
    };
  });
}

export interface AdminOverview {
  clients: number;
  activeClients: number;
  agentsOnline: number;
  agentsEnabled: number;
  openTickets: number;
  urgentTickets: number;
  provisioningOpen: number;
  heldReviews: number;
  newAccessRequests: number;
  messagesThisMonth: number;
  tokensThisMonth: number;
}

export async function getAdminOverview(user: SessionUser): Promise<AdminOverview> {
  // Access requests have no RLS grant, so they are counted in their own trusted transaction —
  // never nested inside the user transaction below (that deadlocks a single-connection database).
  const newAccessRequests =
    user.platformRole === "agency_super_admin"
      ? Number((await withSystem((s) => s.query<{ n: number }>("select count(*)::int as n from access_requests where status = 'new'"))).rows[0].n)
      : 0;
  return withUser(user.id, async (db) => {
    const permissions = await db.query<{ workforce: boolean; support: boolean }>(
      `select coalesce(app.user_has_agency_permission($1,'agency.workforce.view'),false) as workforce,
              coalesce(app.user_has_agency_permission($1,'agency.support.view'),false) as support`,
      [user.id],
    );
    const canViewWorkforce = permissions.rows[0]?.workforce === true;
    const canViewSupport = permissions.rows[0]?.support === true;
    const n = async (sql: string) => Number((await db.query<{ n: number }>(sql)).rows[0]?.n ?? 0);
    const scope = "o.kind = 'client'";
    return {
      clients: await n(`select count(*)::int as n from organizations o where ${scope}`),
      activeClients: await n(`select count(*)::int as n from organizations o where ${scope} and o.status = 'active'`),
      agentsOnline: canViewWorkforce ? await n(`select count(*)::int as n from agent_instances a join organizations o on o.id = a.org_id where ${scope} and a.enabled and a.status in ('online','busy')`) : 0,
      agentsEnabled: canViewWorkforce ? await n(`select count(*)::int as n from agent_instances a join organizations o on o.id = a.org_id where ${scope} and a.enabled`) : 0,
      openTickets: canViewSupport ? await n("select count(*)::int as n from support_tickets where status in ('open','in_progress','waiting_for_client')") : 0,
      urgentTickets: canViewSupport ? await n("select count(*)::int as n from support_tickets where status in ('open','in_progress') and priority in ('high','urgent')") : 0,
      provisioningOpen: canViewWorkforce ? await n(`select count(*)::int as n from agent_provisioning_jobs j join organizations o on o.id = j.org_id where ${scope} and j.status in ('requested','in_progress','awaiting_health_check')`) : 0,
      heldReviews: canViewWorkforce ? await n(`select count(*)::int as n from agent_config_versions v join organizations o on o.id = v.org_id where ${scope} and v.status = 'pending_agency_review'`) : 0,
      newAccessRequests,
      messagesThisMonth: await n("select coalesce(sum(quantity),0)::int as n from usage_events where kind = 'agent_message' and created_at >= date_trunc('month', now())"),
      tokensThisMonth: await n("select coalesce(sum(coalesce(input_tokens,0)+coalesce(output_tokens,0)),0)::int as n from usage_events where created_at >= date_trunc('month', now())"),
    };
  });
}

export async function listAllAgents(user: SessionUser) {
  return withUser(user.id, async (db) => {
    const access = await db.query<{ allowed: boolean }>(
      "select coalesce(app.user_has_agency_permission($1,'agency.workforce.view'),false) as allowed",
      [user.id],
    );
    if (access.rows[0]?.allowed !== true) throw new AppError("forbidden", "Your agency role does not allow viewing client workforce status.");
    const { rows } = await db.query<{
      id: string;
      org_id: string;
      org_kind: "agency" | "client";
      org_name: string;
      role_key: AgentRoleKey;
      display_name: string;
      enabled: boolean;
      status: AgentStatus;
      hermes_profile: string | null;
      last_health_check_at: Date | null;
      last_health_detail: string | null;
      runs_30d: number;
      failed_30d: number;
      tokens_30d: number;
    }>(
      `select a.id, a.org_id, o.kind as org_kind, o.name as org_name, a.role_key, a.display_name, a.enabled, a.status, a.hermes_profile,
              a.last_health_check_at, a.last_health_detail,
              (select count(*)::int from agent_runs r where r.agent_instance_id = a.id and r.started_at > now() - interval '30 days') as runs_30d,
              (select count(*)::int from agent_runs r where r.agent_instance_id = a.id and r.status in ('failed','timeout','interrupted') and r.started_at > now() - interval '30 days') as failed_30d,
              (select coalesce(sum(total_tokens),0)::int from agent_runs r where r.agent_instance_id = a.id and r.started_at > now() - interval '30 days') as tokens_30d
       from agent_instances a join organizations o on o.id = a.org_id join agent_roles ro on ro.key = a.role_key
       where o.kind = 'client' order by o.name, ro.sort_order`,
    );
    return rows;
  });
}

/** Agency-owned employee identities are returned separately from client workforce rows. */
export async function listAgencyAgents(user: SessionUser) {
  // This function is Super Admin-only: ensureAgencyWorkforceRegistry enforces that boundary and
  // returns the one agency organization to scope this trusted read to. Keep credential status
  // resolution out of iaq_app_user, which intentionally has no access to integration_credentials.
  const agencyId = await ensureAgencyWorkforceRegistry(user);
  const { rows } = await withUser(user.id, async (db) => {
    return db.query<{
      id: string; org_id: string; org_name: string; role_key: AgentRoleKey; display_name: string;
      enabled: boolean; status: AgentStatus; hermes_profile: string | null;
      last_health_check_at: Date | null; last_health_detail: string | null;
      last_health_ok: boolean | null; hermes_gateway_id: string | null; gateway_status: string | null;
      credential_id: string | null; has_config: boolean; pending_approvals: number; runs_30d: number;
      last_activity_at: Date | null;
      profile_check_status: string | null; profile_check_profile_id: string | null; profile_check_gateway_id: string | null;
      profile_check_detail: string | null; profile_check_at: Date | null;
      profile_verified_at: Date | null; profile_identity_verified: boolean | null; tool_permissions_status: string | null;
      full_capabilities_acknowledged: boolean;
    }>(
      `select a.id,a.org_id,o.name as org_name,a.role_key,a.display_name,a.enabled,a.status,a.hermes_profile,
              a.last_health_check_at,a.last_health_detail,a.last_health_ok,a.hermes_gateway_id,g.status as gateway_status,
              a.credential_id,
              (a.active_config_version_id is not null) as has_config,
              (select count(*)::int from approval_requests p where p.agent_instance_id=a.id and p.status='pending') as pending_approvals,
              (select count(*)::int from agent_runs r where r.agent_instance_id=a.id and r.started_at > now() - interval '30 days') as runs_30d,
              (select max(r.started_at) from agent_runs r where r.agent_instance_id=a.id) as last_activity_at,
              pc.status as profile_check_status,pc.profile_id as profile_check_profile_id,pc.gateway_id as profile_check_gateway_id,
              pc.detail as profile_check_detail,pc.checked_at as profile_check_at,
              pc.verified_at as profile_verified_at,pc.identity_verified as profile_identity_verified,
              pc.tool_permissions_status,
              coalesce(ack_policy.id is not null and ack.verified_profile=a.hermes_profile and agent_policy.id is null,false) as full_capabilities_acknowledged
       from agent_instances a join organizations o on o.id=a.org_id join agent_roles ro on ro.key=a.role_key
       left join hermes_gateways g on g.id=a.hermes_gateway_id
       left join agency_hermes_profile_checks pc on pc.agent_instance_id=a.id and pc.org_id=a.org_id
       left join hermes_tool_policy_acknowledgements ack on ack.agent_id=a.id
       left join hermes_tool_policies ack_policy on ack_policy.id=ack.policy_id and ack_policy.scope_kind='internal_agency' and ack_policy.name='Full Hermes Capabilities'
       left join hermes_tool_policies agent_policy on agent_policy.scope_kind='agent' and agent_policy.agent_id=a.id
       where o.kind='agency' and o.id=$1 order by ro.sort_order`,
      [agencyId],
    );
  });
  const credentialIds = rows.flatMap((agent) => agent.credential_id ? [agent.credential_id] : []);
  const activeCredentialIds = new Set((await withServiceRole((db) => db.query<{ id: string }>(
    `select id from integration_credentials where id = any($1::uuid[]) and revoked_at is null`,
    [credentialIds],
  ))).rows.map((credential) => credential.id));
  return rows.map(({ credential_id, ...agent }) => ({
    ...agent,
    has_credential: credential_id !== null && activeCredentialIds.has(credential_id),
  }));
}

export async function listUsageByTenant(user: SessionUser) {
  return withUser(user.id, async (db) => {
    const { rows } = await db.query<{
      org_id: string;
      org_name: string;
      messages: number;
      tokens: number;
      research: number;
      failed: number;
      limit_messages: number | null;
      hard_stop: boolean | null;
    }>(
      `select o.id as org_id, o.name as org_name,
         coalesce((select sum(quantity) from usage_events u where u.org_id = o.id and u.kind = 'agent_message' and u.created_at >= date_trunc('month', now())), 0)::int as messages,
         coalesce((select sum(coalesce(input_tokens,0)+coalesce(output_tokens,0)) from usage_events u where u.org_id = o.id and u.created_at >= date_trunc('month', now())), 0)::int as tokens,
         coalesce((select sum(quantity) from usage_events u where u.org_id = o.id and u.kind = 'lead_research' and u.created_at >= date_trunc('month', now())), 0)::int as research,
         coalesce((select sum(quantity) from usage_events u where u.org_id = o.id and u.kind = 'agent_run_failed' and u.created_at >= date_trunc('month', now())), 0)::int as failed,
         l.monthly_agent_messages as limit_messages, l.hard_stop
       from organizations o left join usage_limits l on l.org_id = o.id
       where o.kind = 'client' order by messages desc, o.name`,
    );
    return rows;
  });
}

export async function listAccessRequests() {
  const { rows } = await withSystem((db) =>
    db.query<{ id: string; company_name: string; contact_name: string; email: string; website: string | null; message: string | null; status: string; created_at: Date }>(
      "select id, company_name, contact_name, email, website, message, status, created_at from access_requests order by created_at desc limit 200",
    ),
  );
  return rows;
}

export async function listStaff() {
  const { rows } = await withSystem((db) =>
    db.query<{ id: string; full_name: string; email: string; platform_role: string; status: string; last_login_at: Date | null; assignments: number }>(
      `select u.id, u.full_name, u.email, u.platform_role, u.status, u.last_login_at,
              (select count(*)::int from staff_assignments s where s.user_id = u.id) as assignments
       from users u where u.platform_role <> 'none' order by u.platform_role desc, u.full_name`,
    ),
  );
  const { rows: invites } = await withSystem((db) =>
    db.query<{ id: string; email: string; platform_role: string; expires_at: Date }>(
      "select id, email, platform_role, expires_at from invitations where org_id is null and accepted_at is null and revoked_at is null and expires_at > now() order by created_at desc",
    ),
  );
  return { staff: rows, invites };
}

export async function listAuditLog(user: SessionUser, opts: { orgId?: string; limit?: number } = {}) {
  return withUser(user.id, async (db) => {
    const { rows } = await db.query<{ id: string; org_name: string | null; actor: string | null; actor_kind: string; action: string; target_type: string | null; result: string; created_at: Date; metadata: Record<string, unknown> }>(
      `select a.id::text, o.name as org_name, u.full_name as actor, a.actor_kind, a.action, a.target_type, a.result, a.created_at, a.metadata
       from audit_logs a left join organizations o on o.id = a.org_id left join users u on u.id = a.actor_user_id
       where ($1::uuid is null or a.org_id = $1::uuid) order by a.created_at desc limit $2`,
      [opts.orgId ?? null, opts.limit ?? 200],
    );
    return rows;
  });
}
