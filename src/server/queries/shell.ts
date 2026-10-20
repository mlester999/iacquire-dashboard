import "server-only";
import { withUser } from "@/server/db";
import type { OrgContext } from "@/server/tenancy/context";
import { isAgentRoleKey, type AgentRoleKey, type AgentStatus } from "@/lib/agents";
import type { Permission } from "@/lib/permissions";

export interface ShellAgent {
  role: AgentRoleKey;
  displayName: string;
  status: AgentStatus;
  enabled: boolean;
}

export interface ShellData {
  user: { id: string; name: string; email: string; platformRole: string };
  org: { id: string; name: string; isDemo: boolean; kind: string; onboardingComplete: boolean; timezone: string; role: string };
  memberships: Array<{ id: string; name: string; role: string }>;
  permissions: Permission[];
  agents: ShellAgent[];
  unreadNotifications: number;
  pendingApprovals: number;
  /** Setup Center summary for the sidebar. Hidden once the system is activated. */
  setup: { visible: boolean; percent: number | null; needsAttention: number };
  /** Custom projects needing the client's attention: a quote to decide, a deliverable to approve, or a question to answer. */
  projectsAttention: number;
  /** Conversations with unread customer messages, plus escalations waiting for this person. */
  inboxAttention: number;
  /** The person's own support requests that have a new reply from the iAcquire team or are waiting for their answer. */
  requestsAttention: number;
  /** Which CRM the workspace runs on, so navigation shows the native CRM or the GoHighLevel views (or both while migrating). */
  crmMode: "native" | "ghl" | "hybrid" | null;
}

export async function getShellData(ctx: OrgContext): Promise<ShellData> {
  const includeSetup = ctx.org.kind === "client" && ctx.can("setup.view");
  const includeProjects = ctx.can("projects.view");
  const includeInbox = ctx.can("inbox.view");
  const includeRequests = ctx.can("support.use");
  const includeCrm = ctx.org.kind === "client" && ctx.can("crm.view");
  const setupCtes = includeSetup
    ? `, setup_instance as (
         select state from client_setup_instances where org_id=$1 limit 1
       ), setup_stats as (
         select count(*) filter (where required and completion_mode <> 'activation')::int as total,
                count(*) filter (where required and completion_mode <> 'activation' and status='completed')::int as completed,
                count(*) filter (where status='waiting_for_client' and client_action is not null)::int as waiting
         from client_setup_tasks where org_id=$1 and not hidden and not service_excluded
           and exists (select 1 from setup_instance)
       )`
    : "";
  const setupProjection = includeSetup
    ? `coalesce((select json_build_object(
           'visible',si.state <> 'activated',
           'percent',case when st.total=0 then null else round(st.completed * 100.0 / st.total)::int end,
           'needsAttention',st.waiting
         ) from setup_instance si cross join setup_stats st),
         json_build_object('visible',false,'percent',null,'needsAttention',0)) as setup`
    : `json_build_object('visible',false,'percent',null,'needsAttention',0) as setup`;
  const projectsProjection = includeProjects
    ? `((select count(*) from project_quotes q where q.org_id=$1 and q.status='sent') +
        (select count(*) from project_milestones m where m.org_id=$1 and m.status='awaiting_approval') +
        (select count(*) from client_project_requests r where r.org_id=$1 and r.status='discovery_needed'))::int as projects_attention`
    : `0::int as projects_attention`;
  const inboxProjection = includeInbox
    ? `((select count(*) from conversations c where c.org_id=$1 and c.status='open' and c.unread_count > 0) +
        (select count(*) from human_escalations e where e.org_id=$1 and e.status in ('awaiting_owner','open')))::int as inbox_attention`
    : `0::int as inbox_attention`;
  const requestsProjection = includeRequests
    ? `(select count(*)::int from support_tickets t where t.org_id=$1 and t.created_by=$2 and t.status not in ('resolved','closed') and (t.status='waiting_for_client' or exists (
         select 1 from support_messages m where m.ticket_id=t.id and m.author_kind='agency' and not m.internal and m.created_at > coalesce(t.client_last_read_at, t.created_at)))) as requests_attention`
    : `0::int as requests_attention`;
  const crmProjection = includeCrm
    ? `(select mode from crm_workspaces where org_id=$1 limit 1) as crm_mode`
    : `null::text as crm_mode`;

  // Keep the shell's RLS-protected counts and summaries in one database round trip. On a
  // high-latency deployment connection, the former sequence of up to nine queries serialized
  // these network waits before the shared portal shell could render.
  const data = await withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<{
      agents: Array<{ role_key: string; display_name: string; status: AgentStatus; enabled: boolean }>;
      unread: number;
      approvals: number;
      setup: ShellData["setup"];
      projects_attention: number;
      inbox_attention: number;
      requests_attention: number;
      crm_mode: ShellData["crmMode"];
    }>(
      `with preferences as (
         select prefs from notification_preferences where user_id=$2 and org_id=$1 limit 1
       )${setupCtes}
       select
         (select coalesce(json_agg(json_build_object(
            'role_key',a.role_key,'display_name',a.display_name,'status',a.status,'enabled',a.enabled
          ) order by r.sort_order),'[]'::json)
          from agent_instances a join agent_roles r on r.key=a.role_key where a.org_id=$1) as agents,
         (select count(*)::int from notifications n left join preferences p on true
          where n.user_id=$2 and n.audience in ('client','direct') and app.notification_visible($2,n.audience,n.org_id)
            and (n.org_id=$1 or n.org_id is null) and n.read_at is null and (n.severity='critical' or (
            (coalesce(p.prefs->>'approvals','true') <> 'false' or n.kind not in ('approval_requested','approval_decided')) and
            (coalesce(p.prefs->>'leads','true') <> 'false' or n.kind <> 'lead_awaiting_approval') and
            (coalesce(p.prefs->>'workforce','true') <> 'false' or n.kind not in ('agent_status','agent_task_completed')) and
            (coalesce(p.prefs->>'support','true') <> 'false' or n.kind not in ('support_reply','support_status')) and
            (coalesce(p.prefs->>'knowledge','true') <> 'false' or n.kind <> 'knowledge_update_ready') and
            (coalesce(p.prefs->>'usage','true') <> 'false' or n.kind <> 'usage_limit_approaching') and
            (coalesce(p.prefs->>'calendar','true') <> 'false' or n.kind <> 'booking_confirmed') and
            (coalesce(p.prefs->>'projects','true') <> 'false' or n.kind not in ('project_update','project_message','maintenance_update'))
          ))) as unread,
         (select count(*)::int from approval_requests p where p.org_id=$1 and p.status='pending' and (p.expires_at is null or p.expires_at > now())) as approvals,
         ${setupProjection},
         ${projectsProjection},
         ${inboxProjection},
         ${requestsProjection},
         ${crmProjection}`,
      [ctx.org.orgId, ctx.user.id],
    );
    return rows[0];
  });
  const agents = data?.agents ?? [];
  const unread = data?.unread ?? 0;
  const approvals = data?.approvals ?? 0;
  const setup = data?.setup ?? { visible: false, percent: null, needsAttention: 0 };
  const projectsAttention = data?.projects_attention ?? 0;
  const inboxAttention = data?.inbox_attention ?? 0;
  const requestsAttention = data?.requests_attention ?? 0;
  const crmMode = data?.crm_mode ?? (includeCrm ? "native" : null);
  return {
    user: { id: ctx.user.id, name: ctx.user.fullName || ctx.user.email, email: ctx.user.email, platformRole: ctx.user.platformRole },
    org: {
      id: ctx.org.orgId,
      name: ctx.org.name,
      isDemo: ctx.org.isDemo,
      kind: ctx.org.kind,
      onboardingComplete: Boolean(ctx.org.onboardingCompletedAt),
      timezone: ctx.org.timezone,
      role: ctx.role,
    },
    memberships: ctx.memberships.filter((m) => m.status !== "suspended").map((m) => ({ id: m.orgId, name: m.name, role: m.role })),
    permissions: ctx.permissions,
    agents: agents
      .filter((a) => isAgentRoleKey(a.role_key))
      .map((a) => ({ role: a.role_key as AgentRoleKey, displayName: a.display_name, status: a.status, enabled: a.enabled })),
    unreadNotifications: unread,
    pendingApprovals: approvals,
    setup,
    projectsAttention,
    inboxAttention,
    requestsAttention,
    crmMode,
  };
}
