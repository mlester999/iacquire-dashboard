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
  helpAiAvailable: boolean;
  /** Custom projects needing the client's attention: a quote to decide, a deliverable to approve, or a question to answer. */
  projectsAttention: number;
  /** Conversations with unread customer messages, plus escalations waiting for this person. */
  inboxAttention: number;
  /** Which CRM the workspace runs on, so navigation shows the native CRM or the GoHighLevel views (or both while migrating). */
  crmMode: "native" | "ghl" | "hybrid" | null;
}

export async function getShellData(ctx: OrgContext, helpAiAvailable: boolean): Promise<ShellData> {
  const { agents, unread, approvals, setup, projectsAttention, inboxAttention, crmMode } = await withUser(ctx.user.id, async (db) => {
    const a = await db.query<{ role_key: string; display_name: string; status: AgentStatus; enabled: boolean }>(
      `select a.role_key, a.display_name, a.status, a.enabled from agent_instances a
       join agent_roles r on r.key = a.role_key where a.org_id = $1 order by r.sort_order`,
      [ctx.org.orgId],
    );
    const prefs = await db.query<{ prefs: Record<string, boolean> }>("select prefs from notification_preferences where user_id = $1 and org_id = $2", [ctx.user.id, ctx.org.orgId]);
    const pf = prefs.rows[0]?.prefs ?? {};
    const hidden = [
      ...(pf.approvals === false ? ["approval_requested", "approval_decided"] : []),
      ...(pf.leads === false ? ["lead_awaiting_approval"] : []),
      ...(pf.workforce === false ? ["agent_status", "agent_task_completed"] : []),
      ...(pf.support === false ? ["support_reply"] : []),
      ...(pf.knowledge === false ? ["knowledge_update_ready"] : []),
      ...(pf.usage === false ? ["usage_limit_approaching"] : []),
      ...(pf.calendar === false ? ["booking_confirmed"] : []),
      ...(pf.projects === false ? ["project_update", "project_message", "maintenance_update"] : []),
    ];
    const n = await db.query<{ n: number }>(
      "select count(*)::int as n from notifications where read_at is null and (kind <> all($1::text[]) or severity = 'critical')",
      [hidden],
    );
    const p = await db.query<{ n: number }>(
      "select count(*)::int as n from approval_requests where org_id = $1 and status = 'pending' and (expires_at is null or expires_at > now())",
      [ctx.org.orgId],
    );
    // Read under row-level security with the client-safe columns only.
    const inst = ctx.can("setup.view") && ctx.org.kind === "client"
      ? await db.query<{ state: string }>("select state from client_setup_instances where org_id = $1", [ctx.org.orgId])
      : { rows: [] as Array<{ state: string }> };
    let setup = { visible: false, percent: null as number | null, needsAttention: 0 };
    if (inst.rows[0]) {
      const s = await db.query<{ total: number; completed: number; waiting: number }>(
        `select count(*) filter (where required and completion_mode <> 'activation')::int as total,
                count(*) filter (where required and completion_mode <> 'activation' and status = 'completed')::int as completed,
                count(*) filter (where status = 'waiting_for_client' and client_action is not null)::int as waiting
         from client_setup_tasks where org_id = $1 and not hidden and not service_excluded`,
        [ctx.org.orgId],
      );
      const r = s.rows[0];
      setup = {
        visible: inst.rows[0].state !== "activated",
        percent: r && r.total ? Math.round((r.completed / r.total) * 100) : null,
        needsAttention: r?.waiting ?? 0,
      };
    }
    const pa = ctx.can("projects.view")
      ? await db.query<{ n: number }>(
          `select (
             (select count(*) from project_quotes q where q.org_id = $1 and q.status = 'sent') +
             (select count(*) from project_milestones m where m.org_id = $1 and m.status = 'awaiting_approval') +
             (select count(*) from client_project_requests r where r.org_id = $1 and r.status = 'discovery_needed')
           )::int as n`,
          [ctx.org.orgId],
        )
      : { rows: [{ n: 0 }] };
    // Counted under row-level security, so each person only counts conversations they are allowed to see.
    const ib = ctx.can("inbox.view")
      ? await db.query<{ n: number }>(
          `select ((select count(*) from conversations c where c.org_id = $1 and c.status = 'open' and c.unread_count > 0) +
                   (select count(*) from human_escalations e where e.org_id = $1 and e.status in ('awaiting_owner', 'open')))::int as n`,
          [ctx.org.orgId],
        )
      : { rows: [{ n: 0 }] };
    const ws = ctx.org.kind === "client" && ctx.can("crm.view")
      ? await db.query<{ mode: "native" | "ghl" | "hybrid" }>("select mode from crm_workspaces where org_id = $1", [ctx.org.orgId])
      : { rows: [] as Array<{ mode: "native" | "ghl" | "hybrid" }> };
    return {
      agents: a.rows, unread: n.rows[0]?.n ?? 0, approvals: p.rows[0]?.n ?? 0, setup, projectsAttention: pa.rows[0]?.n ?? 0, inboxAttention: ib.rows[0]?.n ?? 0,
      crmMode: ws.rows[0]?.mode ?? (ctx.org.kind === "client" && ctx.can("crm.view") ? ("native" as const) : null),
    };
  });
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
    helpAiAvailable,
    projectsAttention,
    inboxAttention,
    crmMode,
  };
}
