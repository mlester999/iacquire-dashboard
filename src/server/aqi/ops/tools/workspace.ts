import "server-only";
import { z } from "zod";
import { readSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { defineReadTool } from "@/server/aqi/ops/tool";
import { ageHours, clean, iso, metric, newCardId, num, plural } from "@/server/aqi/ops/tools/helpers";
import type { OpsHealthState, OpsTableCard, OpsWorkspaceCard, OpsScopePickerCard } from "@/lib/aqi/ops/types";
import { isRuntimeOnline } from "@/lib/employee-runtime";

const SUPER = ["agency_super_admin"] as const;

interface DirectoryRow {
  id: string; name: string; status: string; created_at: Date; setup_state: string | null; blocked: number; waiting_client: number;
  open_required: number; required_total: number; last_activity: Date | null; total: string;
}

/** Cross-client onboarding overview: counts and names of workspaces, no records, contacts or conversations. */
export const workspaceDirectory = defineReadTool({
  id: "workspace.directory",
  title: "Client onboarding overview",
  description: "Which client workspaces are in setup, blocked or waiting on the client, from the Setup Center records.",
  group: "workspace",
  roles: SUPER,
  permission: "agency.workforce.view",
  scopes: ["platform"],
  input: z.object({ limit: z.number().int().min(1).max(25).default(15), onlyAttention: z.boolean().default(false) }).strict(),
  idempotent: true,
  audit: { action: "aqi.ops_tool_run", sensitive: true },
  timeoutMs: 10_000,
  async run(ctx, args) {
    const { rows } = await readSystem((db) => db.query<DirectoryRow>(
      `select o.id, o.name, o.status, o.created_at, si.state as setup_state,
              count(t.id) filter (where t.status = 'blocked')::int as blocked,
              count(t.id) filter (where t.status = 'waiting_for_client')::int as waiting_client,
              count(t.id) filter (where t.status <> 'completed' and t.required)::int as open_required,
              count(t.id) filter (where t.required)::int as required_total,
              max(t.updated_at) as last_activity,
              count(*) over ()::text as total
         from organizations o
         left join client_setup_instances si on si.org_id = o.id
         left join client_setup_tasks t on t.instance_id = si.id and not t.hidden and not t.service_excluded
        where o.kind = 'client' and o.status <> 'archived' and app.user_can_access_org($1, o.id)
        group by o.id, si.state
       having ($2::boolean = false or count(t.id) filter (where t.status in ('blocked', 'waiting_for_client')) > 0 or o.status in ('onboarding', 'invited', 'suspended'))
        order by count(t.id) filter (where t.status = 'blocked') desc, count(t.id) filter (where t.status = 'waiting_for_client') desc, o.created_at desc
        limit $3`,
      [ctx.user.id, args.onlyAttention, args.limit],
    ));
    const total = rows[0] ? Number(rows[0].total) : 0;
    const blockedClients = rows.filter((r) => r.blocked > 0);
    const waiting = rows.filter((r) => r.waiting_client > 0);
    const table: OpsTableCard = {
      id: newCardId(), kind: "table", title: "Client onboarding", asOf: new Date().toISOString(), source: "Setup Center (client_setup_instances, client_setup_tasks)",
      refresh: { toolId: "workspace.directory", args }, caption: `${rows.length} of ${total} client workspaces, most blocked first.`, truncated: total > rows.length,
      columns: [
        { key: "client", label: "Client" }, { key: "status", label: "Status" }, { key: "setup", label: "Setup" },
        { key: "blocked", label: "Blocked", align: "right" }, { key: "waiting", label: "Waiting on client", align: "right" }, { key: "open", label: "Open required", align: "right" },
      ],
      rows: rows.map((r) => ({
        client: clean(r.name, 60), status: r.status, setup: r.setup_state ?? "not started", blocked: r.blocked, waiting: r.waiting_client,
        open: r.required_total ? `${r.open_required} of ${r.required_total}` : "—", _href: `/admin/clients/${r.id}/setup`,
      })),
    };
    return {
      summary: rows.length
        ? `${total} client workspaces; ${blockedClients.length} with blocked setup tasks and ${waiting.length} waiting on the client in the first ${rows.length}. ${blockedClients.slice(0, 4).map((r) => `${clean(r.name, 50)} has ${plural(r.blocked, "blocked task")}`).join("; ")}.`
        : "No client workspaces matched.",
      data: { total, clients: rows.map((r) => ({ id: r.id, name: r.name, status: r.status, setupState: r.setup_state, blocked: r.blocked, waitingOnClient: r.waiting_client, openRequired: r.open_required, requiredTotal: r.required_total, lastSetupActivity: iso(r.last_activity), createdAt: iso(r.created_at) })) },
      cards: [table],
      evidence: { label: "Client onboarding overview", source: "Setup Center records (client_setup_instances, client_setup_tasks)", href: "/admin/clients" },
    };
  },
});

/** Finds client workspaces by name so the administrator can select one. Selecting is explicit and server-validated. */
export const workspaceFind = defineReadTool({
  id: "workspace.find",
  title: "Find client workspace",
  description: "Searches client workspace names so one can be selected as the investigation context.",
  group: "workspace",
  roles: SUPER,
  permission: "agency.workforce.view",
  scopes: ["platform"],
  input: z.object({ names: z.array(z.string().trim().min(2).max(60)).min(1).max(4) }).strict(),
  idempotent: true,
  audit: { action: "aqi.ops_tool_run", sensitive: false },
  timeoutMs: 6_000,
  async run(ctx, args) {
    const patterns = args.names.map((n) => `%${n.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const { rows } = await readSystem((db) => db.query<{ id: string; name: string; status: string }>(
      `select o.id, o.name, o.status from organizations o
        where o.kind = 'client' and o.status <> 'archived' and app.user_can_access_org($1, o.id) and (o.name ilike any($2::text[]) or o.slug ilike any($2::text[]))
        order by o.name limit 8`,
      [ctx.user.id, patterns],
    ));
    const card: OpsScopePickerCard = {
      id: newCardId(), kind: "scope_picker", title: rows.length ? "Select a client to investigate" : "No matching client", asOf: new Date().toISOString(), source: "Client workspaces (organizations)",
      options: rows.map((r) => ({ type: "tenant", id: r.id, label: clean(r.name, 80), detail: r.status })),
      body: rows.length ? "Choose the client so AQi can inspect that workspace. The selection is checked and recorded as an audited access." : `No client workspace matches “${args.names.map((n) => clean(n, 40)).join("”, “")}”.`,
    };
    return {
      summary: rows.length ? `${plural(rows.length, "client workspace")} match: ${rows.map((r) => clean(r.name, 50)).join(", ")}. A client must be selected before its workspace can be inspected.` : "No client workspace matched the name that was mentioned.",
      data: { matches: rows.map((r) => ({ id: r.id, name: r.name, status: r.status })) },
      cards: [card],
      evidence: { label: "Client workspace search", source: "organizations", href: "/admin/clients" },
    };
  },
});

// ---------------------------------------------------------------------------

interface SummaryOrg { id: string; name: string; status: string; kind: string; created_at: Date; onboarding_completed_at: Date | null; timezone: string; is_demo: boolean }
interface SetupTask { title: string; status: string; section: string; service: string | null; blocked_reason: string | null; updated_at: Date; required: boolean }
interface ConnectionRow { provider: string; status: string; last_error: string | null; last_success_at: Date | null; last_failure_at: Date | null }
interface AgentRow { id: string; display_name: string; role_key: string; status: string; mode: string; enabled: boolean; last_health_ok: boolean | null; last_health_check_at: Date | null }
interface ChannelRow { channel: string; enabled: boolean; registration_status: string; sender_verified_at: Date | null }

/** One tenant's operational readiness. Operational metadata only: no contacts, messages, conversations or CRM records. */
export const workspaceSummary = defineReadTool({
  id: "workspace.summary",
  title: "Client workspace readiness",
  description: "Onboarding progress, blockers, integration status, messaging channels and AI Employee setup for the selected client.",
  group: "workspace",
  roles: SUPER,
  permission: "agency.workforce.view",
  scopes: ["tenant", "employee", "workflow", "ticket"],
  input: z.object({}).strict(),
  idempotent: true,
  audit: { action: "aqi.ops_tool_run", sensitive: true },
  timeoutMs: 12_000,
  async run(ctx) {
    const orgId = ctx.scope.orgId;
    if (!orgId) throw new AppError("invalid_input", "Select a client workspace first.");
    await ctx.authorizeOrg(orgId, "workspace.summary");

    const { rows: orgRows } = await readSystem((db) => db.query<SummaryOrg>(
      "select id, name, status, kind, created_at, onboarding_completed_at, timezone, is_demo from organizations where id = $1", [orgId],
    ));
    const org = orgRows[0];
    if (!org) throw new AppError("not_found", "Workspace not found.");

    const facts = await readSystem((db) => db.query<{
      setup_state: string | null; setup_revision: string | null; responsible: string | null;
      tasks: SetupTask[]; connections: ConnectionRow[]; agents: AgentRow[]; channels: ChannelRow[];
      incidents_open: number; tickets_open: number; agency_pause: boolean | null; client_pauses: string[];
      approvals_pending: number; calendars_attention: number;
    }>(
      `select
         (select state from client_setup_instances where org_id = $1) as setup_state,
         (select revision::text from client_setup_instances where org_id = $1) as setup_revision,
         (select coalesce(nullif(u.full_name, ''), 'a team member') from client_setup_instances si join users u on u.id = si.responsible_user_id where si.org_id = $1) as responsible,
         coalesce((select json_agg(x) from (select title, status, section, service, blocked_reason, updated_at, required from client_setup_tasks
                    where org_id = $1 and not hidden and not service_excluded and status <> 'completed' and required
                    order by (status = 'blocked') desc, (status = 'waiting_for_client') desc, updated_at desc limit 12) x), '[]'::json) as tasks,
         coalesce((select json_agg(x) from (select provider, status, last_error, last_success_at, last_failure_at from integration_connections where org_id = $1 order by provider) x), '[]'::json) as connections,
         coalesce((select json_agg(x) from (select a.id, a.display_name, a.role_key, a.status, a.mode, a.enabled, a.last_health_ok, a.last_health_check_at
                    from agent_instances a join agent_roles r on r.key = a.role_key where a.org_id = $1 order by r.sort_order) x), '[]'::json) as agents,
         coalesce((select json_agg(x) from (select channel, enabled, registration_status, sender_verified_at from messaging_channels where org_id = $1 order by channel) x), '[]'::json) as channels,
         (select count(*) from incidents where org_id = $1 and status <> 'resolved')::int as incidents_open,
         (select count(*) from support_tickets where org_id = $1 and status in ('new', 'open', 'in_progress', 'waiting_for_client'))::int as tickets_open,
         (select active from automation_pauses where org_id = $1 and scope = 'agency') as agency_pause,
         coalesce((select array_agg(scope) from automation_pauses where org_id = $1 and active and scope <> 'agency'), '{}') as client_pauses,
         (select count(*) from approval_requests where org_id = $1 and status = 'pending')::int as approvals_pending,
         (select count(*) from crm_calendar_connections where org_id = $1 and status in ('error', 'needs_reauth'))::int as calendars_attention`,
      [orgId],
    ));
    const f = facts.rows[0];
    const tasks: SetupTask[] = f.tasks ?? [];
    const connections: ConnectionRow[] = f.connections ?? [];
    const agents: AgentRow[] = f.agents ?? [];
    const channels: ChannelRow[] = f.channels ?? [];
    const base = `/admin/clients/${orgId}`;

    const blockers: OpsWorkspaceCard["blockers"] = [];
    for (const t of tasks.filter((x) => x.status === "blocked").slice(0, 4)) blockers.push({ title: `Blocked setup task: ${clean(t.title, 90)}`, detail: clean(t.blocked_reason, 220) || "No reason recorded.", href: `${base}/setup` });
    const waiting = tasks.filter((x) => x.status === "waiting_for_client");
    for (const t of waiting.slice(0, 3)) blockers.push({ title: `Waiting on the client: ${clean(t.title, 90)}`, detail: `Last updated ${ageHours(t.updated_at, ctx.now)} hours ago.`, href: `${base}/setup` });
    for (const c of connections.filter((x) => ["error", "needs_attention", "disconnected"].includes(x.status))) blockers.push({ title: `${c.provider} connection is ${c.status.replace("_", " ")}`, detail: clean(c.last_error, 200) || "The last check did not succeed.", href: `${base}/integrations` });
    for (const a of agents.filter((x) => x.enabled && ["error", "offline", "setup_required"].includes(x.status))) blockers.push({ title: `${clean(a.display_name, 40)} (${a.role_key.replace(/_/g, " ")}) is ${a.status.replace("_", " ")}`, detail: a.last_health_check_at ? `Last health check ${ageHours(a.last_health_check_at, ctx.now)} hours ago.` : "No health check has been recorded.", href: `${base}/provisioning` });
    if (f.agency_pause) blockers.push({ title: "Agency emergency pause is active", detail: "Customer-facing automation is held for this workspace until a Super Admin resumes it.", href: base });
    if (f.calendars_attention) blockers.push({ title: `${plural(f.calendars_attention, "calendar connection")} need attention`, detail: "Calendar sync failed or needs the client to reconnect.", href: `${base}/integrations` });
    if (org.status === "suspended") blockers.unshift({ title: "Workspace is suspended", detail: "A suspended workspace cannot be used by its team.", href: base });

    const required = tasks.length;
    const metrics: OpsWorkspaceCard["metrics"] = [
      metric("Workspace status", org.status, `Created ${ageHours(org.created_at, ctx.now)} hours ago`),
      metric("Setup state", f.setup_state ? f.setup_state.replace(/_/g, " ") : "Not started", f.setup_state ? `${required} open required task${required === 1 ? "" : "s"} shown` : "No Setup Center record", f.setup_state ? undefined : "unknown"),
      metric("Integrations", `${connections.filter((c) => ["connected", "permission_limited"].includes(c.status)).length} of ${connections.length} healthy`, connections.length ? undefined : "No connections recorded", connections.length ? undefined : "not_configured"),
      metric("AI Employees", `${agents.filter((a) => isRuntimeOnline(a.status)).length} of ${agents.filter((a) => a.enabled).length} online`, "From their last health check"),
      metric("Pending approvals", f.approvals_pending),
      metric("Open incidents", f.incidents_open, undefined, f.incidents_open ? "degraded" : undefined),
      metric("Open support requests", f.tickets_open),
    ];
    const state: OpsHealthState = !f.setup_state && !connections.length ? "unknown" : blockers.length ? "degraded" : "healthy";
    const card: OpsWorkspaceCard = {
      id: newCardId(), kind: "workspace", title: clean(org.name, 80), asOf: new Date().toISOString(), source: "Setup Center, integrations, AI Employees, messaging channels",
      refresh: { toolId: "workspace.summary", args: {} }, orgId, name: clean(org.name, 80), status: org.status, state, metrics, blockers,
      links: [
        { label: "Open client", href: base }, { label: "Setup Center", href: `${base}/setup` }, { label: "Integrations", href: `${base}/integrations` },
        { label: "Client requests", href: `/admin/support?org=${orgId}` },
      ],
    };
    const channelText = channels.length
      ? channels.map((c) => `${c.channel}: ${c.enabled ? "enabled" : "off"} (${c.registration_status.replace("_", " ")})`).join(", ")
      : "no messaging channels recorded";
    return {
      summary: `${clean(org.name, 60)} is ${org.status}${org.onboarding_completed_at ? " and completed onboarding" : " and has not completed onboarding"}. ${blockers.length ? `${plural(blockers.length, "blocker")}: ${blockers.slice(0, 4).map((b) => `${b.title} (${b.detail})`).join("; ")}.` : "No blockers are recorded."} Channels: ${channelText}.`,
      data: {
        workspace: { name: org.name, status: org.status, onboardingCompletedAt: iso(org.onboarding_completed_at), isDemo: org.is_demo, timezone: org.timezone },
        setup: { state: f.setup_state, responsible: f.responsible, openRequiredTasks: tasks.map((t) => ({ title: t.title, status: t.status, section: t.section, service: t.service, blockedReason: t.blocked_reason, updatedHoursAgo: ageHours(t.updated_at, ctx.now) })) },
        integrations: connections.map((c) => ({ provider: c.provider, status: c.status, lastError: c.last_error, lastSuccessAt: iso(c.last_success_at), lastFailureAt: iso(c.last_failure_at) })),
        aiEmployees: agents.map((a) => ({ name: a.display_name, role: a.role_key, status: a.status, mode: a.mode, enabled: a.enabled, lastHealthOk: a.last_health_ok, lastHealthCheckAt: iso(a.last_health_check_at) })),
        messagingChannels: channels.map((c) => ({ channel: c.channel, enabled: c.enabled, registration: c.registration_status, senderVerified: Boolean(c.sender_verified_at) })),
        counts: { pendingApprovals: num(f.approvals_pending), openIncidents: num(f.incidents_open), openSupportRequests: num(f.tickets_open), calendarConnectionsNeedingAttention: num(f.calendars_attention) },
        automationPaused: { agency: f.agency_pause === true, client: f.client_pauses },
        blockers: blockers.map((b) => ({ title: b.title, detail: b.detail })),
        notIncluded: "Contacts, conversations, message content and CRM records are deliberately not read.",
      },
      cards: [card],
      evidence: { label: `Workspace readiness: ${clean(org.name, 50)}`, source: "Setup Center, integration connections, AI Employees, messaging channels, incidents, support tickets (metadata only)", href: base },
      unavailable: ["Private client conversations and CRM record contents are not read by AQi Operations. Use the audited support session in the client's CRM when a record must be inspected."],
    };
  },
});

export const WORKSPACE_TOOLS = [workspaceDirectory, workspaceFind, workspaceSummary];
