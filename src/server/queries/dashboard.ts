import "server-only";
import { withUser, type Queryable } from "@/server/db";
import type { OrgContext } from "@/server/tenancy/context";
import { AGENT_BY_KEY, isAgentRoleKey } from "@/lib/agents";

export type Metric = { value: number; available: true } | { value: null; available: false; reason: string };

const avail = (value: number): Metric => ({ value, available: true });
const unavailable = (reason: string): Metric => ({ value: null, available: false, reason });

export interface SourceAvailability {
  crm: boolean;
  calendar: boolean;
  crmDetail: string;
}

export async function sourceAvailability(db: Queryable, orgId: string, isDemo: boolean): Promise<SourceAvailability> {
  const { rows } = await db.query<{ provider: string; status: string; detail: string | null }>(
    "select provider, status, detail from integration_status where org_id = $1 and provider in ('ghl', 'ghl_calendar')",
    [orgId],
  );
  const status = (p: string) => rows.find((r) => r.provider === p)?.status;
  const { rows: cached } = await db.query<{ opp: number; appt: number }>(
    "select (select count(*)::int from crm_opportunities where org_id = $1) as opp, (select count(*)::int from appointment_refs where org_id = $1) as appt",
    [orgId],
  );
  // Demo workspaces show their seeded sample records; real tenants need a verified connection.
  const crm = status("ghl") === "connected" || (isDemo && cached[0].opp > 0);
  const calendar = status("ghl_calendar") === "connected" || (isDemo && cached[0].appt > 0);
  return { crm, calendar, crmDetail: rows.find((r) => r.provider === "ghl")?.detail ?? "Not connected" };
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

export async function getDashboard(ctx: OrgContext): Promise<DashboardData> {
  const orgId = ctx.org.orgId;
  return withUser(ctx.user.id, async (db) => {
    const sources = await sourceAvailability(db, orgId, ctx.org.isDemo);
    const one = async (sql: string, params: unknown[] = [orgId]) => Number((await db.query<{ n: number }>(sql, params)).rows[0]?.n ?? 0);

    const newLeads = await one("select count(*)::int as n from leads where org_id = $1 and created_at > now() - interval '30 days'");
    const qualifiedLeads = await one("select count(*)::int as n from leads where org_id = $1 and review_status = 'approved' and created_at > now() - interval '30 days'");
    const followUps = await one("select count(*)::int as n from tasks where org_id = $1 and status = 'open' and (due_at is null or due_at < now() + interval '1 day')");
    const issues = ctx.can("retention.view") ? await one("select coalesce(sum(open_issues), 0)::int as n from retention_accounts where org_id = $1 and status <> 'churned'") : 0;
    const runs = await one("select count(*)::int as n from agent_runs where org_id = $1 and status = 'completed' and started_at > now() - interval '30 days'");
    const approvals = await one("select count(*)::int as n from approval_requests where org_id = $1 and status = 'pending' and (expires_at is null or expires_at > now())");

    let appointmentsBooked: Metric = unavailable("Calendar not connected");
    let upcoming: Metric = unavailable("Calendar not connected");
    if (sources.calendar) {
      appointmentsBooked = avail(await one("select count(*)::int as n from appointment_refs where org_id = $1 and status in ('new', 'confirmed', 'showed') and start_at > now() - interval '30 days'"));
      upcoming = avail(await one("select count(*)::int as n from appointment_refs where org_id = $1 and status in ('new', 'confirmed') and start_at > now()"));
    }
    let activeOpps: Metric = unavailable("CRM not connected");
    let won: Metric = unavailable("CRM not connected");
    if (sources.crm) {
      activeOpps = avail(await one("select count(*)::int as n from crm_opportunities where org_id = $1 and status = 'open'"));
      won = avail(await one("select count(*)::int as n from crm_opportunities where org_id = $1 and status = 'won' and coalesce(remote_updated_at, synced_at) > now() - interval '30 days'"));
    }

    const { rows: act } = await db.query<{ day: string; n: number }>(
      `select to_char(d::date, 'YYYY-MM-DD') as day,
              (select count(*)::int from usage_events u where u.org_id = $1 and u.kind = 'agent_message' and u.created_at >= d and u.created_at < d + interval '1 day') as n
       from generate_series(date_trunc('day', now()) - interval '13 days', date_trunc('day', now()), interval '1 day') d order by d`,
      [orgId],
    );

    const funnel: DashboardData["funnel"] = [
      // Lead stages come from iAcquire research; opportunity stages come from the CRM. Step
      // conversion is only shown within one source, because CRM deals aren't all from research.
      { label: "Researched leads", value: newLeads, source: "portal" },
      { label: "Approved leads", value: qualifiedLeads, source: "portal" },
      { label: "Active opportunities", value: activeOpps.available ? activeOpps.value : null, source: "crm" },
      { label: "Won deals", value: won.available ? won.value : null, source: "crm" },
    ];

    const { rows: tasks } = await db.query<{ id: string; title: string; due_at: Date | null; category: string }>(
      `select id, title, due_at, category from tasks where org_id = $1 and status = 'open'
       order by due_at nulls last, created_at limit 6`,
      [orgId],
    );

    const alerts: DashboardData["alerts"] = [];
    const { rows: agents } = await db.query<{ role_key: string; status: string; enabled: boolean }>(
      "select role_key, status, enabled from agent_instances where org_id = $1",
      [orgId],
    );
    for (const a of agents) {
      if (!a.enabled || !isAgentRoleKey(a.role_key)) continue;
      if (a.status === "offline" || a.status === "error") {
        alerts.push({ tone: "critical", title: `${AGENT_BY_KEY[a.role_key].shortName} is unavailable`, body: "The last connection check failed. iAcquire has been notified.", href: `/workforce/${AGENT_BY_KEY[a.role_key].slug}` });
      }
    }
    if (ctx.can("integrations.view")) {
      const { rows: integ } = await db.query<{ provider: string; detail: string | null }>(
        "select provider, detail from integration_status where org_id = $1 and status = 'error'",
        [orgId],
      );
      for (const i of integ) alerts.push({ tone: "warning", title: `${i.provider === "ghl" ? "CRM" : i.provider === "ghl_calendar" ? "Calendar" : "Integration"} connection problem`, body: i.detail ?? "Check integration status.", href: "/settings/integrations" });
    }
    const expiring = await one("select count(*)::int as n from approval_requests where org_id = $1 and status = 'pending' and expires_at between now() and now() + interval '24 hours'");
    if (expiring) alerts.push({ tone: "warning", title: `${expiring} approval${expiring === 1 ? "" : "s"} expiring within 24 hours`, body: "Expired requests never run.", href: "/approvals" });
    const held = await one("select count(*)::int as n from company_knowledge where org_id = $1 and review_status = 'pending_agency_review'");
    if (held) alerts.push({ tone: "info", title: "Knowledge update awaiting iAcquire review", body: "Some content was held because it could conflict with AI safety rules.", href: "/knowledge" });

    let recent: DashboardData["recent"] = [];
    if (ctx.can("activity.view")) {
      const { rows } = await db.query<{ id: string; action: string; created_at: Date; actor: string | null; result: string; agent: string | null }>(
        `select a.id::text, a.action, a.created_at, coalesce(u.full_name, a.actor_kind) as actor, a.result, ro.short_name as agent
         from audit_logs a left join users u on u.id = a.actor_user_id
         left join agent_instances ai on ai.id = a.agent_instance_id left join agent_roles ro on ro.key = ai.role_key
         where a.org_id = $1 and a.action not like 'auth.%' and a.action <> 'agent.health_check'
         order by a.created_at desc limit 8`,
        [orgId],
      );
      recent = rows.map((r) => ({ id: r.id, action: r.action, at: new Date(r.created_at).toISOString(), actor: r.actor, result: r.result, agent: r.agent }));
    }

    const members = await one("select count(*)::int as n from organization_memberships where org_id = $1 and status = 'active'");
    const knowledgeSections = await one("select count(*)::int as n from company_knowledge where org_id = $1 and content <> ''");
    const online = agents.filter((a) => a.enabled && (a.status === "online" || a.status === "busy")).length;
    const conversations = await one("select count(*)::int as n from agent_runs where org_id = $1 and purpose = 'chat'");
    const setup = [
      { key: "profile", label: "Company setup completed", done: Boolean(ctx.org.onboardingCompletedAt), href: "/onboarding" },
      { key: "knowledge", label: "Knowledge Center has 3+ sections", done: knowledgeSections >= 3, href: "/knowledge" },
      { key: "team", label: "Invite a teammate", done: members >= 2, href: "/settings/team" },
      { key: "crm", label: "CRM connected by iAcquire", done: sources.crm, href: "/settings/integrations" },
      { key: "agent", label: "First AI employee online", done: online > 0, href: "/workforce" },
      { key: "chat", label: "First conversation with your AI team", done: conversations > 0, href: "/workforce" },
    ];

    const nextActions: DashboardData["nextActions"] = [];
    if (!ctx.org.onboardingCompletedAt) nextActions.push({ title: "Finish company setup", body: "Answer a few short questions so your AI team understands your business.", href: "/onboarding", cta: "Continue setup" });
    if (approvals) nextActions.push({ title: `Review ${approvals} pending approval${approvals === 1 ? "" : "s"}`, body: "Your AI team is waiting on your decision.", href: "/approvals", cta: "Open approvals" });
    const pendingLeads = await one("select count(*)::int as n from leads where org_id = $1 and review_status = 'pending'");
    if (pendingLeads) nextActions.push({ title: `${pendingLeads} lead${pendingLeads === 1 ? "" : "s"} to review`, body: "Approve the businesses that fit before anything goes to your CRM.", href: "/leads?tab=review", cta: "Review leads" });
    if (online > 0 && conversations === 0) nextActions.push({ title: "Say hello to your AI team", body: "Ask your Operations Manager what needs attention today.", href: "/chat/operations-manager", cta: "Start a chat" });
    if (knowledgeSections < 3 && ctx.can("knowledge.edit")) nextActions.push({ title: "Teach your AI team the basics", body: "Add your FAQs, hours and policies to the Knowledge Center.", href: "/knowledge", cta: "Add knowledge" });
    if (online === 0 && ctx.org.onboardingCompletedAt) nextActions.push({ title: "Your AI team is being set up", body: "iAcquire is preparing each employee's private environment. You'll be notified when they're online.", href: "/workforce", cta: "View status" });

    return {
      sources,
      kpis: {
        newLeads: avail(newLeads),
        qualifiedLeads: avail(qualifiedLeads),
        appointmentsBooked,
        upcomingMeetings: upcoming,
        activeOpportunities: activeOpps,
        wonDeals: won,
        followUps: avail(followUps),
        customerIssues: ctx.can("retention.view") ? avail(issues) : unavailable("Not available for your role"),
        aiActivity: avail(runs),
        pendingApprovals: avail(approvals),
      },
      activity: act.map((r) => ({ day: r.day, messages: Number(r.n) })),
      funnel,
      tasks: tasks.map((t) => ({ id: t.id, title: t.title, category: t.category, due_at: t.due_at ? new Date(t.due_at).toISOString() : null, overdue: Boolean(t.due_at && new Date(t.due_at).getTime() < Date.now()) })),
      alerts,
      recent,
      setup,
      nextActions: nextActions.slice(0, 3),
    };
  });
}
