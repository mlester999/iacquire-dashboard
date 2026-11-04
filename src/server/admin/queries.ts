import "server-only";
import { withServiceRole, withSystem, withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import { agencyCanAccessOrg } from "@/server/tenancy/context";
import { usageSummary, type UsageSummary } from "@/server/usage";
import type { SessionUser } from "@/server/auth/service";
import { AGENCY_HERMES_PROFILE_IDS, AGENT_ROLE_KEYS, type AgentRoleKey, type AgentStatus } from "@/lib/agents";
import { internalAcknowledgementIsCurrent, internalIdentityIsCurrent } from "@/lib/workforce-readiness";
import { redactReviewText, type ReviewVersionView } from "@/lib/config-review";
import { ensureAgencyWorkforceRegistry } from "@/server/workforce/agency-registry";
import { listHeldConfigReviewsForOrg } from "@/server/workforce/reviews";
import { listClientPayments, type AgencyPaymentView } from "@/server/billing/payments-view";
import { runtimeReadySql } from "@/lib/employee-runtime";
import { clientContentAccess } from "@/server/admin/client-content-policy";
import { readinessExtrasFor } from "@/server/workforce/readiness-facts";
import { loadCapabilityActivity } from "@/server/workforce/capability-status";
import type { CapabilityActivity } from "@/lib/employee-capability-status";

/** One recorded step of a provisioning request, read from its audit rows. */
export interface ProvisioningEvent {
  action: string;
  result: string;
  attempt: number | null;
  /** The normalised failure code of a failed attempt; never raw worker text. */
  code: string | null;
  at: Date;
}

export interface TenantDetail {
  access: {
    team: boolean;
    workforce: boolean;
    workforceManage: boolean;
    integrations: boolean;
    setup: boolean;
  };
  /** billing.agency_view: sees the payments recorded for this client (the bank reference and the checking note are agency-only). */
  canViewPayments: boolean;
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
    tool_inventory_contract: string | null;
    tool_inventory_digest: string | null;
    tool_inventory_verified_at: Date | null;
    tool_inventory_expires_at: Date | null;
    tool_inventory_tool_count: number | null;
    tool_inventory_detail: string | null;
    config_version: number | null;
    config_summary: string | null;
    held_versions: number;
    runs_30d: number;
    failed_30d: number;
  }>;
  growthPartner: {
    id: string;
    status: "setup_required" | "provisioning" | "configured" | "paused" | "migration_required";
    runtime_agent_instance_id: string | null;
    enabled: boolean | null;
    runtime_status: AgentStatus | null;
    hermes_profile: string | null;
    last_health_check_at: Date | null;
    last_health_detail: string | null;
    current_version: number | null;
    latest_version: number | null;
    last_message_at: Date | null;
    runs_30d: number;
    failed_30d: number;
  } | null;
  heldVersions: ReviewVersionView[];
  /** A waiting section edit (content is the waiting text; the approved text is untouched and still in use) or text held by the older code. */
  heldKnowledge: Array<{ section: string; content: string; risk_flags: string[]; updated_at: Date }>;
  /** Employee notes held for review, and flagged documents with the text that is held out of every prompt. Both are content, so the D70 rule hides them too. */
  heldNotes: Array<{ id: string; agent_id: string; agent_role: AgentRoleKey; title: string; content: string; risk_flags: string[]; updated_at: Date }>;
  heldDocuments: Array<{ id: string; filename: string; scope: "shared" | "assigned"; agent_role: AgentRoleKey | null; held_text: string | null; risk_flags: string[]; created_at: Date }>;
  /**
   * Whether this reader may see the four kinds of content the founder's D70 rule guards, and how much of it was withheld for that reason. The screens read with
   * trusted server access, so row-level security cannot answer for them; this is the same question asked directly (see docs/staff-access-privacy.md).
   */
  contentAccess: { sessionRequired: boolean; hasSession: boolean; permitted: boolean; heldKnowledgeHidden: number; runDetailsHidden: number };
  provisioning: Array<{
    id: string; agent_id: string; agent_role: AgentRoleKey; kind: string; config_version: number | null; status: string; detail: string | null; created_at: Date; attempt_count: number;
    next_retry_at: Date | null; lease_expires_at: Date | null;
    /** True for the newest request of its employee: the only one that can be requeued. */
    is_latest: boolean;
    /** The last five recorded events of this request (an attempt starting, a failure with its code, a completion, a requeue), newest first. Identifiers and codes only. */
    history: ProvisioningEvent[];
  }>;
  ghl: { location_id: string; location_name: string | null; pipeline_id: string | null; calendar_ids: string[]; status: string; verified_at: Date | null; has_credential: boolean } | null;
  integrations: Array<{ provider: string; status: string; detail: string | null; last_checked_at: Date | null }>;
  billing: {
    setup_fee_cents: number; currency: string; setup_payment_status: string; activation_status: string; invoice_url: string | null; receipt_url: string | null; paid_at: Date | null; service_terms: string | null;
    /** Why the fee was waived, by whom and when; only for a waived fee, and only agency staff ever see it. */
    waiver_reason: string | null; waived_at: Date | null; waived_by_name: string | null;
    /** The payment that cleared the fee, when one did. A fee marked paid before payments were recorded has none. */
    verified_payment_id: string | null;
    cleared: boolean;
  } | null;
  /** iAcquire's own payments for this client (not the invoices it sends its customers). */
  payments: AgencyPaymentView[];
  usage: UsageSummary;
  staff: Array<{ user_id: string; full_name: string; email: string; assigned: boolean }>;
  failedRuns: Array<{ id: string; agent_role: AgentRoleKey; error_code: string | null; error_message: string | null; finished_at: Date | null }>;
}

export async function getTenantDetail(user: SessionUser, orgId: string): Promise<TenantDetail> {
  // This is an agency-only read. A client membership alone must never be able to call it even if a
  // future route or action forgets the page-level requireAgency() guard.
  if (user.platformRole === "none") throw new AppError("not_found", "Client not found.");
  if (!(await agencyCanAccessOrg(user, orgId))) throw new AppError("not_found", "Client not found.");
  return withSystem(async (db) => {
    const accessResult = await db.query<{ team: boolean; workforce: boolean; workforce_manage: boolean; integrations: boolean; setup: boolean; billing: boolean }>(
      `select coalesce(app.user_has_agency_permission($1,'agency.clients.invite_users'),false) as team,
              coalesce(app.user_has_agency_permission($1,'agency.workforce.view'),false) as workforce,
              coalesce(app.user_has_agency_permission($1,'agency.workforce.manage'),false) as workforce_manage,
              coalesce(app.user_has_agency_permission($1,'agency.integrations.health'),false) as integrations,
              coalesce(app.user_has_agency_permission($1,'setup.manage'),false) as setup,
              coalesce(app.user_has_agency_permission($1,'billing.agency_view'),false) as billing`,
      [user.id],
    );
    const accessRow = accessResult.rows[0];
    const access = {
      team: accessRow?.team === true,
      workforce: accessRow?.workforce === true,
      workforceManage: accessRow?.workforce_manage === true,
      integrations: accessRow?.integrations === true,
      setup: accessRow?.setup === true,
    };
    const canViewPayments = accessRow?.billing === true;
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
              a.tool_inventory_contract, a.tool_inventory_digest, a.tool_inventory_verified_at,
              a.tool_inventory_expires_at, a.tool_inventory_tool_count, a.tool_inventory_detail,
              v.version as config_version, v.summary as config_summary,
              (select count(*)::int from agent_config_versions h where h.agent_instance_id = a.id and h.status = 'pending_agency_review') as held_versions,
              (select count(*)::int from agent_runs r where r.agent_instance_id = a.id and r.started_at > now() - interval '30 days') as runs_30d,
              (select count(*)::int from agent_runs r where r.agent_instance_id = a.id and r.status in ('failed','timeout','interrupted') and r.started_at > now() - interval '30 days') as failed_30d
       from agent_instances a join agent_roles ro on ro.key = a.role_key
       left join agent_config_versions v on v.id = a.active_config_version_id
       where a.org_id = $1 and a.role_key = any($2::text[]) order by ro.sort_order`,
      [orgId, AGENT_ROLE_KEYS],
    );
    const growthPartner = await db.query<NonNullable<TenantDetail["growthPartner"]>>(
      `select p.id,
              case when p.status in ('paused','migration_required') then p.status
                   when p.current_version is not null and ${runtimeReadySql("a", { credentialRevocation: true })} then 'configured'
                   when a.status = 'provisioning' or p.status = 'provisioning' then 'provisioning'
                   else 'setup_required' end as status,
              p.runtime_agent_instance_id, a.enabled, a.status as runtime_status,
              a.hermes_profile, a.last_health_check_at, a.last_health_detail,
              p.current_version,
              (select max(v.version)::int from ai_growth_partner_versions v where v.org_id = p.org_id and v.partner_id = p.id) as latest_version,
              (select max(c.last_message_at) from chat_conversations c where c.org_id = p.org_id and c.growth_partner_id = p.id and c.deleted_at is null) as last_message_at,
              (select count(*)::int from agent_runs r where r.agent_instance_id = a.id and r.started_at > now() - interval '30 days') as runs_30d,
              (select count(*)::int from agent_runs r where r.agent_instance_id = a.id and r.status in ('failed','timeout','interrupted') and r.started_at > now() - interval '30 days') as failed_30d
       from ai_growth_partners p
       left join agent_instances a on a.id = p.runtime_agent_instance_id and a.org_id = p.org_id and a.role_key = 'growth_partner'
       where p.org_id = $1`,
      [orgId],
    );
    const heldKnowledge = await db.query<TenantDetail["heldKnowledge"][number]>(
      `select section, coalesce(pending_content, content) as content,
              case when pending_content is not null then pending_flags else risk_flags end as risk_flags, updated_at
       from company_knowledge where org_id = $1 and (pending_content is not null or review_status = 'pending_agency_review') order by section`,
      [orgId],
    );
    const heldNotes = await db.query<TenantDetail["heldNotes"][number]>(
      `select e.id, e.agent_instance_id as agent_id, a.role_key as agent_role, e.title, e.content, e.risk_flags, e.updated_at
       from employee_knowledge_entries e join agent_instances a on a.id = e.agent_instance_id
       where e.org_id = $1 and e.status = 'pending_agency_review' order by e.updated_at`,
      [orgId],
    );
    // A held document has a reason and no released text; the held text is shown capped, since a review needs the start of it and not 200 KB in a browser.
    const heldDocuments = await db.query<TenantDetail["heldDocuments"][number]>(
      `select d.id, d.filename, case when d.agent_instance_id is null then 'shared' else 'assigned' end as scope, a.role_key as agent_role,
              left(d.held_text, 6000) as held_text, d.risk_flags, d.created_at
       from knowledge_documents d left join agent_instances a on a.id = d.agent_instance_id
       where d.org_id = $1 and d.status = 'ready' and d.extracted_text is null and d.applied_at is null and cardinality(d.risk_flags) > 0 order by d.created_at`,
      [orgId],
    );
    const heldVersions = access.workforce
      ? (await listHeldConfigReviewsForOrg(db, orgId)).map((item) =>
          // Compiled instruction evidence is reviewer-only. A view-only agency teammate can see the
          // review request and diff, but not the full compiled prompt.
          access.workforceManage ? item : { ...item, compiledInstructions: null, compiledInstructionsTruncated: false },
        )
      : [];
    const provisioningRows = await db.query<Omit<TenantDetail["provisioning"][number], "history">>(
      `select j.id, j.agent_instance_id as agent_id, a.role_key as agent_role, j.kind, v.version as config_version, j.status, j.detail, j.created_at, j.attempt_count, j.next_retry_at, j.lease_expires_at,
              j.id = (select l.id from agent_provisioning_jobs l where l.agent_instance_id = j.agent_instance_id and l.org_id = j.org_id order by l.created_at desc, l.id desc limit 1) as is_latest
       from agent_provisioning_jobs j join agent_instances a on a.id = j.agent_instance_id
       left join agent_config_versions v on v.id=j.config_version_id
       where j.org_id = $1 and a.role_key = any($2::text[]) order by j.created_at desc limit 30`,
      [orgId, AGENT_ROLE_KEYS],
    );
    // The last five audit rows of each listed request, for this workspace only.
    const provisioningEvents = provisioningRows.rows.length
      ? await db.query<{ job_id: string } & ProvisioningEvent>(
          `select e.job_id, e.action, e.result, e.attempt, e.code, e.at from (
             select l.target_id as job_id, l.action, l.result, l.created_at as at,
                    case when l.metadata->>'attempt' ~ '^[0-9]{1,2}$' then (l.metadata->>'attempt')::int end as attempt,
                    l.metadata->>'code' as code,
                    row_number() over (partition by l.target_id order by l.created_at desc, l.id desc) as rn
             from audit_logs l
             where l.org_id = $1 and l.target_type = 'agent_provisioning_job' and l.target_id = any($2::text[])
               and l.action in ('agent.profile_provisioning_started','agent.profile_provisioning_failed','agent.profile_provisioned','agent.profile_configuration_synchronized','agent.provisioning_requeued')
           ) e where e.rn <= 5 order by e.at desc`,
          [orgId, provisioningRows.rows.map((r) => r.id)],
        )
      : { rows: [] as Array<{ job_id: string } & ProvisioningEvent> };
    const provisioning = {
      rows: provisioningRows.rows.map((job) => ({
        ...job,
        history: provisioningEvents.rows.filter((e) => e.job_id === job.id).map(({ job_id: _jobId, ...event }) => event),
      })),
    };
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
      `select b.setup_fee_cents, b.currency, b.setup_payment_status, b.activation_status, b.invoice_url, b.receipt_url, b.paid_at, b.service_terms,
              b.waiver_reason, b.waived_at, (select coalesce(nullif(u.full_name, ''), u.email::text) from users u where u.id = b.waived_by) as waived_by_name,
              b.verified_payment_id, app.setup_payment_cleared(b.org_id) as cleared
       from billing_accounts b where b.org_id = $1`,
      [orgId],
    );
    const clientPayments = canViewPayments ? await listClientPayments(db, orgId) : [];
    const staff = await db.query<TenantDetail["staff"][number]>(
      `select u.id as user_id, u.full_name, u.email, exists (select 1 from staff_assignments s where s.org_id = $1 and s.user_id = u.id) as assigned
       from users u where u.platform_role = 'agency_staff' and u.status = 'active' order by u.full_name`,
      [orgId],
    );
    const failedRuns = await db.query<TenantDetail["failedRuns"][number]>(
      `select r.id, a.role_key as agent_role, r.error_code, r.error_message, r.finished_at
       from agent_runs r join agent_instances a on a.id = r.agent_instance_id
       where r.org_id = $1 and a.role_key = any($2::text[]) and r.status in ('failed', 'timeout', 'interrupted') order by r.finished_at desc nulls last limit 10`,
      [orgId, AGENT_ROLE_KEYS],
    );
    // Founder decision D70: while the stricter rule is on, a held knowledge entry's text and a failed run's error text are content, and this reader bypasses
    // row-level security. It withholds them unless the person has an active support session on this client (the same condition the database applies), and keeps
    // the counts so the screen can say what it is not showing instead of looking empty.
    const contentAccess = access.workforce ? await clientContentAccess(db, user.id, orgId) : { sessionRequired: false, hasSession: false, permitted: true };
    const heldKnowledgeHidden = !contentAccess.permitted ? heldKnowledge.rows.length + heldNotes.rows.length + heldDocuments.rows.length : 0;
    const hiddenRunDetails = !contentAccess.permitted ? failedRuns.rows.filter((r) => r.error_message).length : 0;
    return {
      access,
      org: org[0],
      members: access.team ? members.rows : [],
      invitations: access.team ? invitations.rows : [],
      agents: access.workforce ? agents.rows : [],
      growthPartner: access.workforce ? growthPartner.rows[0] ?? null : null,
      heldVersions,
      heldKnowledge: access.workforce && contentAccess.permitted
        ? heldKnowledge.rows.map((item) => ({ ...item, content: redactReviewText(item.content) }))
        : [],
      heldNotes: access.workforce && contentAccess.permitted
        ? heldNotes.rows.map((item) => ({ ...item, content: redactReviewText(item.content) }))
        : [],
      heldDocuments: access.workforce && contentAccess.permitted
        ? heldDocuments.rows.map((item) => ({ ...item, held_text: item.held_text === null ? null : redactReviewText(item.held_text) }))
        : [],
      contentAccess: { ...contentAccess, heldKnowledgeHidden, runDetailsHidden: hiddenRunDetails },
      provisioning: access.workforce ? provisioning.rows : [],
      ghl: access.integrations ? ghl.rows[0] ?? null : null,
      integrations: access.integrations ? integrations.rows : [],
      billing: access.setup ? billing.rows[0] ?? null : null,
      canViewPayments,
      payments: clientPayments,
      usage: await usageSummary(db, orgId),
      staff: access.team ? staff.rows : [],
      failedRuns: access.workforce
        ? failedRuns.rows.map((r) => (contentAccess.permitted ? r : { ...r, error_message: r.error_message ? "Hidden until you open a support session on this client." : null }))
        : [],
    };
  });
}

export interface AdminOverview {
  clients: number;
  activeClients: number;
  agentsOnline: number;
  agentsEnabled: number;
  agentsPreparing: number;
  agentsNeedsAttention: number;
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
      agentsOnline: canViewWorkforce ? await n(`select count(*)::int as n from agent_instances a join organizations o on o.id = a.org_id where ${scope} and ${runtimeReadySql("a")}`) : 0,
      agentsEnabled: canViewWorkforce ? await n(`select count(*)::int as n from agent_instances a join organizations o on o.id = a.org_id where ${scope} and a.enabled`) : 0,
      agentsPreparing: canViewWorkforce ? await n(`select count(*)::int as n from agent_instances a join organizations o on o.id = a.org_id where ${scope} and a.enabled and a.status in ('provisioning','setup_required')`) : 0,
      agentsNeedsAttention: canViewWorkforce ? await n(`select count(*)::int as n from agent_instances a join organizations o on o.id = a.org_id where ${scope} and a.enabled and a.status in ('error','offline')`) : 0,
      openTickets: canViewSupport ? await n("select count(*)::int as n from support_tickets where status in ('new','open','in_progress','waiting_for_client')") : 0,
      urgentTickets: canViewSupport ? await n("select count(*)::int as n from support_tickets where status in ('new','open','in_progress') and priority in ('high','urgent')") : 0,
      provisioningOpen: canViewWorkforce ? await n(`select count(*)::int as n from agent_provisioning_jobs j join organizations o on o.id = j.org_id where ${scope} and j.status in ('requested','in_progress','awaiting_health_check')`) : 0,
      heldReviews: canViewWorkforce ? await n(`select count(*)::int as n from agent_config_versions v join organizations o on o.id = v.org_id where ${scope} and v.status = 'pending_agency_review'`)
        + await n(`select count(*)::int as n from company_knowledge k join organizations o on o.id = k.org_id where ${scope} and (k.pending_content is not null or k.review_status = 'pending_agency_review')`)
        + await n(`select count(*)::int as n from employee_knowledge_entries e join organizations o on o.id = e.org_id where ${scope} and e.status = 'pending_agency_review'`)
        + await n(`select count(*)::int as n from knowledge_documents d join organizations o on o.id = d.org_id where ${scope} and d.status = 'ready' and d.extracted_text is null and d.applied_at is null and cardinality(d.risk_flags) > 0`)
        : 0,
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
       where o.kind = 'client' and a.role_key = any($1::text[]) order by o.name, ro.sort_order`,
      [AGENT_ROLE_KEYS],
    );
    return rows;
  });
}

/** Tenant-scoped operational status for the unified partner. Conversation content is never selected here. */
export async function listGrowthPartners(user: SessionUser) {
  return withUser(user.id, async (db) => {
    const access = await db.query<{ allowed: boolean }>(
      "select coalesce(app.user_has_agency_permission($1,'agency.workforce.view'),false) as allowed",
      [user.id],
    );
    if (access.rows[0]?.allowed !== true) throw new AppError("forbidden", "Your agency role does not allow viewing client workforce status.");
    const { rows } = await db.query<{
      id: string;
      org_id: string;
      org_name: string;
      status: "setup_required" | "provisioning" | "configured" | "paused" | "migration_required";
      runtime_agent_instance_id: string | null;
      enabled: boolean | null;
      runtime_status: AgentStatus | null;
      hermes_profile: string | null;
      last_health_check_at: Date | null;
      last_health_detail: string | null;
      current_version: number | null;
      latest_version: number | null;
      last_message_at: Date | null;
      active_run: boolean;
      runs_30d: number;
      failed_30d: number;
    }>(
      `select p.id, p.org_id, o.name as org_name,
              case when p.status in ('paused','migration_required') then p.status
                   when p.current_version is not null and ${runtimeReadySql("a", { credentialRevocation: true })} then 'configured'
                   when a.status = 'provisioning' or p.status = 'provisioning' then 'provisioning'
                   else 'setup_required' end as status,
              p.runtime_agent_instance_id,
              a.enabled, a.status as runtime_status, a.hermes_profile, a.last_health_check_at, a.last_health_detail,
              p.current_version,
              (select max(v.version)::int from ai_growth_partner_versions v where v.org_id = p.org_id and v.partner_id = p.id) as latest_version,
              (select max(c.last_message_at) from chat_conversations c where c.org_id = p.org_id and c.growth_partner_id = p.id and c.deleted_at is null) as last_message_at,
              exists(select 1 from agent_runs running where running.agent_instance_id = a.id and running.status = 'running') as active_run,
              (select count(*)::int from agent_runs r where r.agent_instance_id = a.id and r.started_at > now() - interval '30 days') as runs_30d,
              (select count(*)::int from agent_runs r where r.agent_instance_id = a.id and r.status in ('failed','timeout','interrupted') and r.started_at > now() - interval '30 days') as failed_30d
       from ai_growth_partners p
       join organizations o on o.id = p.org_id
       left join agent_instances a on a.id = p.runtime_agent_instance_id and a.org_id = p.org_id and a.role_key = 'growth_partner'
       where o.kind = 'client' order by o.name`,
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
      enabled: boolean; status: AgentStatus; mode: "paused" | "approval_required" | "autonomous"; hermes_profile: string | null;
      last_health_check_at: Date | null; last_health_detail: string | null;
      last_health_ok: boolean | null; hermes_gateway_id: string | null; gateway_status: string | null;
      credential_id: string | null; has_config: boolean; pending_approvals: number; runs_30d: number;
      last_activity_at: Date | null;
      active_run: boolean; active_config_version_id: string | null; config_version: number | null; config_applied_at: Date | null;
      profile_check_status: string | null; profile_check_profile_id: string | null; profile_check_gateway_id: string | null;
      profile_check_detail: string | null; profile_check_at: Date | null;
      profile_verified_at: Date | null; profile_identity_verified: boolean | null; tool_permissions_status: string | null;
      api_contract_verified: boolean | null; acknowledged_profile: string | null; acknowledged_policy_id: string | null;
      acknowledged_at: Date | null; internal_policy_id: string | null; acknowledged_config_version_id: string | null;
      acknowledged_inventory_digest: string | null; agent_policy_override_id: string | null;
      tool_inventory_contract: string | null; tool_inventory_digest: string | null;
      tool_inventory_verified_at: Date | null; tool_inventory_expires_at: Date | null;
      tool_inventory_tool_count: number | null; tool_inventory_detail: string | null;
    }>(
      `select a.id,a.org_id,o.name as org_name,a.role_key,a.display_name,a.enabled,a.status,a.mode,a.hermes_profile,
              a.last_health_check_at,a.last_health_detail,a.last_health_ok,a.hermes_gateway_id,g.status as gateway_status,
              a.credential_id,
              (a.active_config_version_id is not null) as has_config,a.active_config_version_id,v.version as config_version,v.applied_at as config_applied_at,
              (select count(*)::int from approval_requests p where p.agent_instance_id=a.id and p.status='pending') as pending_approvals,
              (select count(*)::int from agent_runs r where r.agent_instance_id=a.id and r.started_at > now() - interval '30 days') as runs_30d,
              (select max(r.started_at) from agent_runs r where r.agent_instance_id=a.id) as last_activity_at,
              exists(select 1 from agent_runs running where running.agent_instance_id=a.id and running.status='running') as active_run,
              pc.status as profile_check_status,pc.profile_id as profile_check_profile_id,pc.gateway_id as profile_check_gateway_id,
              pc.detail as profile_check_detail,pc.checked_at as profile_check_at,
              pc.verified_at as profile_verified_at,pc.identity_verified as profile_identity_verified,
              pc.api_contract_verified,pc.tool_permissions_status,ack.verified_profile as acknowledged_profile,ack.policy_id as acknowledged_policy_id,
              ack.acknowledged_at,ack_policy.id as internal_policy_id,
              ack_history.policy_snapshot->>'activeConfigVersionId' as acknowledged_config_version_id,
              ack_history.policy_snapshot->>'inventoryDigest' as acknowledged_inventory_digest,
              agent_policy.id as agent_policy_override_id,
              a.tool_inventory_contract,a.tool_inventory_digest,a.tool_inventory_verified_at,a.tool_inventory_expires_at,
              a.tool_inventory_tool_count,a.tool_inventory_detail
       from agent_instances a join organizations o on o.id=a.org_id join agent_roles ro on ro.key=a.role_key
       left join agent_config_versions v on v.id=a.active_config_version_id
       left join hermes_gateways g on g.id=a.hermes_gateway_id
       left join agency_hermes_profile_checks pc on pc.agent_instance_id=a.id and pc.org_id=a.org_id
       left join hermes_tool_policy_acknowledgements ack on ack.agent_id=a.id
       left join hermes_tool_policies ack_policy on ack_policy.id=ack.policy_id and ack_policy.scope_kind='internal_agency' and ack_policy.name='Full Hermes Capabilities'
       left join hermes_tool_policies agent_policy on agent_policy.scope_kind='agent' and agent_policy.agent_id=a.id
       left join lateral (
         select h.policy_snapshot from hermes_tool_policy_history h
         where h.agent_id=a.id and h.action='full_capabilities_acknowledged'
         order by h.occurred_at desc,h.id desc limit 1
       ) ack_history on true
       where o.kind='agency' and o.id=$1 order by ro.sort_order`,
      [agencyId],
    );
  });
  const credentialIds = rows.flatMap((agent) => agent.credential_id ? [agent.credential_id] : []);
  const activeCredentialIds = new Set((await withServiceRole((db) => db.query<{ id: string }>(
    `select c.id from integration_credentials c
      left join credential_references r on r.id=c.credential_reference_id and r.org_id=c.org_id and r.provider='hermes'
      where c.id = any($1::uuid[]) and c.revoked_at is null
        and (c.credential_reference_id is null or (r.id is not null and r.revoked_at is null))`,
    [credentialIds],
  ))).rows.map((credential) => credential.id));
  const extras = await readinessExtrasFor(agencyId, rows);
  const activity = await loadCapabilityActivity(agencyId, rows.map((agent) => agent.id)).catch(() => new Map<string, CapabilityActivity>());
  return rows.map(({ credential_id, ...agent }) => {
    const credentialReady = credential_id !== null && activeCredentialIds.has(credential_id);
    const identityEvidence = {
      expectedProfile: AGENCY_HERMES_PROFILE_IDS[agent.role_key],
      savedProfile: agent.hermes_profile,
      savedGatewayId: agent.hermes_gateway_id,
      checkedProfile: agent.profile_check_profile_id,
      checkedGatewayId: agent.profile_check_gateway_id,
      checkStatus: agent.profile_check_status,
      identityVerified: agent.profile_identity_verified,
      apiContractVerified: agent.api_contract_verified,
      toolPermissionsStatus: agent.tool_permissions_status,
      checkedAt: agent.profile_check_at,
      configAppliedAt: agent.config_applied_at,
    };
    const identity_current = internalIdentityIsCurrent(identityEvidence);
    const full_capabilities_acknowledged = internalAcknowledgementIsCurrent({
      ...identityEvidence,
      acknowledgedAt: agent.acknowledged_at,
      acknowledgedProfile: agent.acknowledged_profile,
      acknowledgedPolicyId: agent.acknowledged_policy_id,
      expectedPolicyId: agent.internal_policy_id,
      activeConfigVersionId: agent.active_config_version_id,
      acknowledgedConfigVersionId: agent.acknowledged_config_version_id,
      inventoryDigest: agent.tool_inventory_digest,
      acknowledgedInventoryDigest: agent.acknowledged_inventory_digest,
      credentialReady,
      hasAgentPolicyOverride: Boolean(agent.agent_policy_override_id),
    });
    return {
      ...agent,
      identity_current,
      full_capabilities_acknowledged,
      has_credential: credentialReady,
      readiness_extras: extras.get(agent.id),
      capability_activity: activity.get(agent.id),
    };
  });
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
      replies: number;
      limit_messages: number | null;
      hard_stop: boolean | null;
    }>(
      `select o.id as org_id, o.name as org_name,
         coalesce((select sum(quantity) from usage_events u where u.org_id = o.id and u.kind = 'agent_message' and u.created_at >= date_trunc('month', now())), 0)::int as messages,
         coalesce((select sum(coalesce(input_tokens,0)+coalesce(output_tokens,0)) from usage_events u where u.org_id = o.id and u.created_at >= date_trunc('month', now())), 0)::int as tokens,
         coalesce((select sum(quantity) from usage_events u where u.org_id = o.id and u.kind = 'lead_research' and u.created_at >= date_trunc('month', now())), 0)::int as research,
         coalesce((select sum(quantity) from usage_events u where u.org_id = o.id and u.kind = 'agent_run_failed' and u.created_at >= date_trunc('month', now())), 0)::int as failed,
         coalesce((select sum(quantity) from usage_events u where u.org_id = o.id and u.kind = 'customer_reply' and u.created_at >= date_trunc('month', now())), 0)::int as replies,
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
