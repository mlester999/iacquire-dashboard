import "server-only";
import { withUser, type Queryable } from "@/server/db";
import type { OrgContext } from "@/server/tenancy/context";
import { AGENT_BY_KEY, isAgentRoleKey } from "@/lib/agents";
import { resolveCapabilities } from "@/server/crm/workspace";
import type { CapabilityProvider, CrmMode } from "@/lib/crm/types";

export type Metric = { value: number; available: true } | { value: null; available: false; reason: string };

const avail = (value: number): Metric => ({ value, available: true });
const unavailable = (reason: string): Metric => ({ value: null, available: false, reason });

export interface SourceAvailability {
  crm: boolean;
  calendar: boolean;
  crmDetail: string;
  /**
   * Which of the dashboard's deal and appointment numbers come from iAcquire's own CRM. When true the counts use native records only
   * (provider 'native', won by the date a deal closed); when false they come from the GoHighLevel copies exactly as before.
   */
  native: NativeCrmOwners;
}

export interface NativeCrmOwners {
  opportunities: boolean;
  appointments: boolean;
}

/**
 * Whether iAcquire's own CRM owns deals and appointments for a workspace (its mode, or in hybrid mode the explicit owner). Under row-level
 * security this needs crm.view; without it, or for a workspace that has no CRM settings yet, the answer is the GoHighLevel-era one (false).
 */
export async function nativeCrmOwners(db: Queryable, orgId: string): Promise<NativeCrmOwners> {
  const { rows } = await db.query<{ mode: CrmMode; capability: string | null; provider: CapabilityProvider | null }>(
    `select w.mode, p.capability, p.provider from crm_workspaces w
     left join crm_capability_providers p on p.org_id = w.org_id and p.capability in ('opportunities', 'appointments') where w.org_id = $1`,
    [orgId],
  );
  if (!rows[0]) return { opportunities: false, appointments: false };
  const owners = resolveCapabilities(rows[0].mode, rows.flatMap((r) => (r.capability && r.provider ? [{ capability: r.capability, provider: r.provider }] : [])));
  return { opportunities: owners.opportunities === "native", appointments: owners.appointments === "native" };
}

export async function sourceAvailability(db: Queryable, orgId: string, isDemo: boolean): Promise<SourceAvailability> {
  // Three former round trips are one statement: the connection statuses, the cached-row counts and
  // the CRM capability owners are independent reads on the same tenant.
  const { rows } = await db.query<{
    integrations: Array<{ provider: string; status: string; detail: string | null }>;
    opp: number;
    appt: number;
    mode: CrmMode | null;
    capabilities: Array<{ capability: string; provider: CapabilityProvider }>;
  }>(
    `select
       coalesce((select json_agg(json_build_object('provider', provider, 'status', status, 'detail', detail))
                 from integration_status where org_id = $1 and provider in ('ghl', 'ghl_calendar')), '[]'::json) as integrations,
       (select count(*)::int from crm_opportunities where org_id = $1) as opp,
       (select count(*)::int from appointment_refs where org_id = $1) as appt,
       (select mode from crm_workspaces where org_id = $1) as mode,
       coalesce((select json_agg(json_build_object('capability', capability, 'provider', provider))
                 from crm_capability_providers where org_id = $1 and capability in ('opportunities', 'appointments')), '[]'::json) as capabilities`,
    [orgId],
  );
  const row = rows[0];
  const status = (p: string) => row.integrations.find((r) => r.provider === p)?.status;
  const native: NativeCrmOwners = row.mode
    ? (() => {
        const owners = resolveCapabilities(row.mode, row.capabilities);
        return { opportunities: owners.opportunities === "native", appointments: owners.appointments === "native" };
      })()
    : { opportunities: false, appointments: false };
  // Demo workspaces show their seeded sample records; real tenants need a verified connection, or iAcquire's own CRM owning the records
  // (there is nothing to connect: deals and appointments are kept here).
  const crm = status("ghl") === "connected" || (isDemo && row.opp > 0) || native.opportunities;
  const calendar = status("ghl_calendar") === "connected" || (isDemo && row.appt > 0) || native.appointments;
  return { crm, calendar, crmDetail: native.opportunities ? "iAcquire CRM" : (row.integrations.find((r) => r.provider === "ghl")?.detail ?? "Not connected"), native };
}

export interface DashboardData {
  sources: SourceAvailability;
  kpis: Record<
    | "newLeads"
    | "qualifiedLeads"
    | "appointmentsBooked"
    | "upcomingMeetings"
    | "activeOpportunities"
    | "wonDeals"
    | "followUps"
    | "customerIssues"
    | "aiActivity"
    | "pendingApprovals",
    Metric
  >;
  activity: Array<{ day: string; messages: number }>;
  funnel: Array<{ label: string; value: number | null; source: "portal" | "crm" }>;
  tasks: Array<{ id: string; title: string; due_at: string | null; category: string; overdue: boolean }>;
  alerts: Array<{ tone: "warning" | "critical" | "info"; title: string; body: string; href: string }>;
  recent: Array<{ id: string; action: string; at: string; actor: string | null; result: string; agent: string | null }>;
  setup: Array<{ key: string; label: string; done: boolean; href: string }>;
  nextActions: Array<{ title: string; body: string; href: string; cta: string }>;
}


interface DashboardRow {
  new_leads: number;
  qualified_leads: number;
  follow_ups: number;
  open_issues: number;
  runs: number;
  approvals: number;
  appointments_booked: number;
  appointments_native_booked: number;
  upcoming_meetings: number;
  upcoming_native: number;
  opportunities_open: number;
  opportunities_native_open: number;
  deals_won: number;
  deals_native_won: number;
  expiring_approvals: number;
  held_knowledge: number;
  pending_leads: number;
  members: number;
  knowledge_sections: number;
  conversations: number;
  activity: Array<{ day: string; n: number }>;
  tasks: Array<{ id: string; title: string; due_at: string | null; category: string }>;
  agents: Array<{ role_key: string; status: string; enabled: boolean }>;
  integration_errors: Array<{ provider: string; detail: string | null }>;
  recent: Array<{ id: string; action: string; created_at: string; actor: string | null; result: string; agent: string | null }>;
}

/**
 * The dashboard used to send 23 independent statements one after another. On a hosted database
 * (iad1 functions, Tokyo database) every statement is another ~150 ms round trip, so the page could
 * spend more than three seconds waiting after the shell had already streamed. These are independent
 * reads, so they are collected into one statement and one round trip. `sourceAvailability` stays a
 * separate call because it is shared with the reports and scheduling surfaces, but it too is now one
 * statement instead of three.
 */
export async function getDashboard(ctx: OrgContext): Promise<DashboardData> {
  const orgId = ctx.org.orgId;
  const includeRetention = ctx.can("retention.view");
  const includeActivity = ctx.can("activity.view");
  const includeIntegrations = ctx.can("integrations.view");
  return withUser(ctx.user.id, async (db) => {
    const sources = await sourceAvailability(db, orgId, ctx.org.isDemo);
    const { rows } = await db.query<DashboardRow>(
      `select
         (select count(*)::int from leads where org_id = $1 and created_at > now() - interval '30 days') as new_leads,
         (select count(*)::int from leads where org_id = $1 and review_status = 'approved' and created_at > now() - interval '30 days') as qualified_leads,
         (select count(*)::int from tasks where org_id = $1 and status in ('open', 'in_progress') and (due_at is null or due_at < now() + interval '1 day')) as follow_ups,
         (select case when $2::boolean then coalesce(sum(open_issues), 0)::int else 0 end from retention_accounts where org_id = $1 and status <> 'churned') as open_issues,
         (select count(*)::int from agent_runs where org_id = $1 and status = 'completed' and started_at > now() - interval '30 days') as runs,
         (select count(*)::int from approval_requests where org_id = $1 and status = 'pending' and (expires_at is null or expires_at > now())) as approvals,
         (select count(*)::int from appointment_refs where org_id = $1 and status in ('new', 'confirmed', 'showed') and start_at > now() - interval '30 days') as appointments_booked,
         (select count(*)::int from appointment_refs where org_id = $1 and provider = 'native' and status in ('new', 'confirmed', 'showed') and start_at > now() - interval '30 days') as appointments_native_booked,
         (select count(*)::int from appointment_refs where org_id = $1 and status in ('new', 'confirmed') and start_at > now()) as upcoming_meetings,
         (select count(*)::int from appointment_refs where org_id = $1 and provider = 'native' and status in ('new', 'confirmed') and start_at > now()) as upcoming_native,
         (select count(*)::int from crm_opportunities where org_id = $1 and status = 'open') as opportunities_open,
         (select count(*)::int from crm_opportunities where org_id = $1 and provider = 'native' and archived_at is null and status = 'open') as opportunities_native_open,
         (select count(*)::int from crm_opportunities where org_id = $1 and status = 'won' and coalesce(remote_updated_at, synced_at) > now() - interval '30 days') as deals_won,
         (select count(*)::int from crm_opportunities where org_id = $1 and provider = 'native' and archived_at is null and status = 'won' and closed_at > now() - interval '30 days') as deals_native_won,
         (select count(*)::int from approval_requests where org_id = $1 and status = 'pending' and expires_at between now() and now() + interval '24 hours') as expiring_approvals,
         (select count(*)::int from company_knowledge where org_id = $1 and review_status = 'pending_agency_review') as held_knowledge,
         (select count(*)::int from leads where org_id = $1 and review_status = 'pending') as pending_leads,
         (select count(*)::int from organization_memberships where org_id = $1 and status = 'active') as members,
         (select count(*)::int from company_knowledge where org_id = $1 and content <> '') as knowledge_sections,
         (select count(*)::int from agent_runs where org_id = $1 and purpose = 'chat') as conversations,
         (select coalesce(json_agg(json_build_object('day', day, 'n', n) order by day), '[]'::json) from (
            select to_char(d::date, 'YYYY-MM-DD') as day,
                   (select count(*)::int from usage_events u where u.org_id = $1 and u.kind = 'agent_message' and u.created_at >= d and u.created_at < d + interval '1 day') as n
            from generate_series(date_trunc('day', now()) - interval '13 days', date_trunc('day', now()), interval '1 day') d
         ) a) as activity,
         (select coalesce(json_agg(json_build_object('id', id, 'title', title, 'due_at', due_at, 'category', category) order by due_at nulls last, created_at), '[]'::json) from (
            select id, title, due_at, category, created_at from tasks where org_id = $1 and status in ('open', 'in_progress')
            order by due_at nulls last, created_at limit 6
         ) t) as tasks,
         (select coalesce(json_agg(json_build_object('role_key', role_key, 'status', status, 'enabled', enabled)), '[]'::json)
            from agent_instances where org_id = $1) as agents,
         (select case when $3::boolean then
            (select coalesce(json_agg(json_build_object('provider', provider, 'detail', detail)), '[]'::json)
               from integration_status where org_id = $1 and status = 'error')
          else '[]'::json end) as integration_errors,
         (select case when $4::boolean then
            (select coalesce(json_agg(json_build_object('id', id, 'action', action, 'created_at', created_at, 'actor', actor, 'result', result, 'agent', agent) order by created_at desc), '[]'::json)
               from (
                 select a.id::text as id, a.action, a.created_at, coalesce(u.full_name, a.actor_kind) as actor, a.result, ro.short_name as agent
                 from audit_logs a left join users u on u.id = a.actor_user_id
                 left join agent_instances ai on ai.id = a.agent_instance_id left join agent_roles ro on ro.key = ai.role_key
                 where a.org_id = $1 and a.action not like 'auth.%' and a.action <> 'agent.health_check'
                 order by a.created_at desc limit 8
               ) r)
          else '[]'::json end) as recent`,
      [orgId, includeRetention, includeIntegrations, includeActivity],
    );
    const data = rows[0];
    const agents = data.agents ?? [];

    let appointmentsBooked: Metric = unavailable("Calendar not connected");
    let upcoming: Metric = unavailable("Calendar not connected");
    if (sources.calendar) {
      appointmentsBooked = avail(sources.native.appointments ? data.appointments_native_booked : data.appointments_booked);
      upcoming = avail(sources.native.appointments ? data.upcoming_native : data.upcoming_meetings);
    }
    let activeOpps: Metric = unavailable("CRM not connected");
    let won: Metric = unavailable("CRM not connected");
    if (sources.crm) {
      activeOpps = avail(sources.native.opportunities ? data.opportunities_native_open : data.opportunities_open);
      won = avail(sources.native.opportunities ? data.deals_native_won : data.deals_won);
    }

    const funnel: DashboardData["funnel"] = [
      // Lead stages come from iAcquire research; opportunity stages come from the CRM. Step
      // conversion is only shown within one source, because CRM deals aren't all from research.
      { label: "Researched leads", value: data.new_leads, source: "portal" },
      { label: "Approved leads", value: data.qualified_leads, source: "portal" },
      { label: "Active opportunities", value: activeOpps.available ? activeOpps.value : null, source: "crm" },
      { label: "Won deals", value: won.available ? won.value : null, source: "crm" },
    ];

    const alerts: DashboardData["alerts"] = [];
    for (const a of agents) {
      if (!a.enabled || !isAgentRoleKey(a.role_key)) continue;
      if (a.status === "offline" || a.status === "error") {
        alerts.push({ tone: "critical", title: `${AGENT_BY_KEY[a.role_key].shortName} is unavailable`, body: "The last connection check failed. iAcquire has been notified.", href: `/workforce/${AGENT_BY_KEY[a.role_key].slug}` });
      }
    }
    for (const i of data.integration_errors ?? []) {
      alerts.push({ tone: "warning", title: `${i.provider === "ghl" ? "CRM" : i.provider === "ghl_calendar" ? "Calendar" : "Integration"} connection problem`, body: i.detail ?? "Check integration status.", href: "/settings/integrations" });
    }
    if (data.expiring_approvals) alerts.push({ tone: "warning", title: `${data.expiring_approvals} approval${data.expiring_approvals === 1 ? "" : "s"} expiring within 24 hours`, body: "Expired requests never run.", href: "/approvals" });
    if (data.held_knowledge) alerts.push({ tone: "info", title: "Knowledge update awaiting iAcquire review", body: "Some content was held because it could conflict with AI safety rules.", href: "/knowledge" });

    const recent = (data.recent ?? []).map((r) => ({ id: r.id, action: r.action, at: new Date(r.created_at).toISOString(), actor: r.actor, result: r.result, agent: r.agent }));
    const online = agents.filter((a) => a.enabled && (a.status === "online" || a.status === "busy")).length;
    const setup = [
      { key: "profile", label: "Company setup completed", done: Boolean(ctx.org.onboardingCompletedAt), href: "/onboarding" },
      { key: "knowledge", label: "Knowledge Center has 3+ sections", done: data.knowledge_sections >= 3, href: "/knowledge" },
      { key: "team", label: "Invite a teammate", done: data.members >= 2, href: "/settings/team" },
      sources.native.opportunities
        ? { key: "crm", label: "iAcquire CRM ready", done: true, href: "/crm" }
        : { key: "crm", label: "CRM connected by iAcquire", done: sources.crm, href: "/settings/integrations" },
      { key: "agent", label: "First AI employee online", done: online > 0, href: "/workforce" },
      { key: "chat", label: "First conversation with your AI team", done: data.conversations > 0, href: "/workforce" },
    ];

    const nextActions: DashboardData["nextActions"] = [];
    if (!ctx.org.onboardingCompletedAt) nextActions.push({ title: "Finish company setup", body: "Answer a few short questions so your AI team understands your business.", href: "/onboarding", cta: "Continue setup" });
    if (data.approvals) nextActions.push({ title: `Review ${data.approvals} pending approval${data.approvals === 1 ? "" : "s"}`, body: "Your AI team is waiting on your decision.", href: "/approvals", cta: "Open approvals" });
    if (data.pending_leads) nextActions.push({ title: `${data.pending_leads} lead${data.pending_leads === 1 ? "" : "s"} to review`, body: "Approve the businesses that fit before anything goes to your CRM.", href: "/leads?tab=review", cta: "Review leads" });
    if (online > 0 && data.conversations === 0) nextActions.push({ title: "Say hello to your AI team", body: "Ask your Operations Manager what needs attention today.", href: "/chat/operations-manager", cta: "Start a chat" });
    if (data.knowledge_sections < 3 && ctx.can("knowledge.edit")) nextActions.push({ title: "Teach your AI team the basics", body: "Add your FAQs, hours and policies to the Knowledge Center.", href: "/knowledge", cta: "Add knowledge" });
    if (online === 0 && ctx.org.onboardingCompletedAt) nextActions.push({ title: "Your AI team is being set up", body: "iAcquire is preparing each employee's private environment. You'll be notified when they're online.", href: "/workforce", cta: "View status" });

    return {
      sources,
      kpis: {
        newLeads: avail(data.new_leads),
        qualifiedLeads: avail(data.qualified_leads),
        appointmentsBooked,
        upcomingMeetings: upcoming,
        activeOpportunities: activeOpps,
        wonDeals: won,
        followUps: avail(data.follow_ups),
        customerIssues: includeRetention ? avail(data.open_issues) : unavailable("Not available for your role"),
        aiActivity: avail(data.runs),
        pendingApprovals: avail(data.approvals),
      },
      activity: (data.activity ?? []).map((r) => ({ day: r.day, messages: Number(r.n) })),
      funnel,
      tasks: (data.tasks ?? []).map((t) => ({ id: t.id, title: t.title, category: t.category, due_at: t.due_at ? new Date(t.due_at).toISOString() : null, overdue: Boolean(t.due_at && new Date(t.due_at).getTime() < Date.now()) })),
      alerts,
      recent,
      setup,
      nextActions: nextActions.slice(0, 3),
    };
  });
}
