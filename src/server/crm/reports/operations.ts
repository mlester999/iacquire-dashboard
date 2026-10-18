import "server-only";
import { withSystem } from "@/server/db";
import { crmRead } from "@/server/crm/actor";
import { AGENT_TOOLS } from "@/server/crm/agent-tools/catalog";
import { num, ownerNote, type ReportScope } from "@/server/crm/reports/scope";
import { UNIT_LABELS } from "@/lib/billing";
import { ROLE_LABELS, type OrgRole } from "@/lib/permissions";
import type { AiReport, IntegrationsReport, SectionResult, UsageReport, WorkflowsReport, WorkloadReport } from "@/components/crm/reports/types";

const OUTCOME_LABELS: Record<string, string> = {
  done: "Done", draft: "Draft prepared", pending_approval: "Waiting for approval", unavailable: "Not available", refused: "Refused", failed: "Failed", queued: "Queued", blocked: "Blocked",
};
const APPROVAL_KIND_LABELS: Record<string, string> = {
  lead_import: "Lead import", outreach: "Outreach", follow_up_message: "Follow-up message", crm_update: "CRM change", campaign_activation: "Campaign", knowledge_change: "Knowledge change",
  tool_action: "Tool action", config_change: "Settings change", appointment_booking: "Appointment booking", standing_authorization: "Standing permission",
  workflow_activation: "Workflow activation", workflow_action: "Workflow step",
};
const RUN_STATUS_LABELS: Record<string, string> = {
  queued: "Queued", running: "Running", waiting: "Waiting", awaiting_approval: "Waiting for approval", completed: "Completed", failed: "Failed", cancelled: "Cancelled", dead: "Gave up after retries",
};
const DAY = 86_400_000;

/**
 * Team workload: per active team member, open and overdue tasks now, tasks completed in the period, and what they currently own
 * (conversations, open deals, contacts), each shown only when the viewer may see that kind of record. The team member filter narrows the
 * table to one person.
 */
export async function workloadSection(scope: ReportScope): Promise<SectionResult<"workload">> {
  const { actor, filters: f } = scope;
  const canContacts = actor.can("contacts.view");
  const canConversations = actor.can("inbox.view_all");
  const canDeals = actor.can("sales.view");
  const data = await crmRead(actor, async (db) => {
    // Tasks about a contact are counted only for people who can see contacts (the same rule row-level security applies).
    const { rows } = await db.query<{ user_id: string; name: string | null; email: string; role: OrgRole; open: string; overdue: string; done: string; conversations: string; deals: string; contacts: string }>(
      `select m.user_id, nullif(u.full_name, '') as name, u.email::text as email, m.role,
              (select count(*) from tasks t where t.org_id = $1 and t.assigned_user_id = m.user_id and t.status in ('open', 'in_progress') and (t.contact_id is null or $5::boolean))::text as open,
              (select count(*) from tasks t where t.org_id = $1 and t.assigned_user_id = m.user_id and t.status in ('open', 'in_progress') and t.due_at < now() and (t.contact_id is null or $5::boolean))::text as overdue,
              (select count(*) from tasks t where t.org_id = $1 and t.assigned_user_id = m.user_id and t.status = 'done' and t.completed_at >= $2 and t.completed_at < $3 and (t.contact_id is null or $5::boolean))::text as done,
              case when $6::boolean then (select count(*) from conversations cv where cv.org_id = $1 and cv.owner_user_id = m.user_id and cv.status <> 'closed') end::text as conversations,
              case when $7::boolean then (select count(*) from crm_opportunities o where o.org_id = $1 and o.provider = 'native' and o.archived_at is null and o.status = 'open' and o.assigned_user_id = m.user_id) end::text as deals,
              case when $5::boolean then (select count(*) from contacts c where c.org_id = $1 and c.deleted_at is null and c.archived_at is null and c.assigned_user_id = m.user_id) end::text as contacts
       from organization_memberships m join users u on u.id = m.user_id
       where m.org_id = $1 and m.status = 'active' and ($4::uuid is null or m.user_id = $4)
       order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end, lower(coalesce(nullif(u.full_name, ''), u.email::text))`,
      [actor.orgId, scope.startsAt, scope.endsAt, f.member ?? null, canContacts, canConversations, canDeals],
    );
    const unassigned = await db.query<{ open: string; overdue: string }>(
      `select count(*) filter (where t.status in ('open', 'in_progress'))::text as open, count(*) filter (where t.status in ('open', 'in_progress') and t.due_at < now())::text as overdue
       from tasks t where t.org_id = $1 and t.assigned_user_id is null and (t.contact_id is null or $2::boolean)`,
      [actor.orgId, canContacts],
    );
    return {
      members: rows.map((r) => ({
        userId: r.user_id, name: r.name ?? r.email, role: ROLE_LABELS[r.role] ?? r.role, openTasks: num(r.open), overdueTasks: num(r.overdue), completedTasks: num(r.done),
        conversations: canConversations ? num(r.conversations) : null, openDeals: canDeals ? num(r.deals) : null, contacts: canContacts ? num(r.contacts) : null,
      })),
      unassignedOpenTasks: f.member ? 0 : num(unassigned.rows[0]?.open),
      unassignedOverdueTasks: f.member ? 0 : num(unassigned.rows[0]?.overdue),
    } satisfies WorkloadReport;
  });
  return {
    section: "workload",
    data,
    empty: data.members.every((m) => !m.openTasks && !m.completedTasks && !m.conversations && !m.openDeals && !m.contacts) && !data.unassignedOpenTasks,
    ignored: [],
    notes: [],
  };
}

/**
 * AI actions: every CRM tool call an AI employee made in the period (from the audit log), by outcome, tool and employee, and the approval
 * requests created in it. Trusted read after the activity permission check, the same rule as the AI Employee Tools screen.
 */
export async function aiSection(scope: ReportScope): Promise<SectionResult<"ai">> {
  const { actor } = scope;
  const data = await withSystem(async (db) => {
    const p = [actor.orgId, scope.startsAt, scope.endsAt];
    const calls = "from audit_logs l where l.org_id = $1 and l.action like 'crm.agent\\_tool.%' and l.created_at >= $2 and l.created_at < $3";
    const outcome = await db.query<{ k: string; n: string }>(`select coalesce(l.metadata->>'outcome', 'failed') as k, count(*)::text as n ${calls} group by 1 order by count(*) desc`, p);
    const tool = await db.query<{ k: string; n: string }>(
      `select coalesce(l.metadata->>'tool', replace(l.action, 'crm.agent_tool.', '')) as k, count(*)::text as n ${calls} group by 1 order by count(*) desc, 1 limit 15`,
      p,
    );
    const employee = await db.query<{ k: string | null; label: string | null; n: string }>(
      `select l.agent_instance_id::text as k, ai.display_name as label, count(*)::text as n ${calls.replace("from audit_logs l", "from audit_logs l left join agent_instances ai on ai.id = l.agent_instance_id")}
       group by 1, 2 order by count(*) desc limit 15`,
      p,
    );
    const approvals = await db.query<{ requested: string; approved: string; rejected: string; expired: string; pending: string; executed: string; failed: string; held: string }>(
      `select count(*)::text as requested, count(*) filter (where status = 'approved')::text as approved, count(*) filter (where status = 'rejected')::text as rejected,
              count(*) filter (where status = 'expired')::text as expired, count(*) filter (where status = 'pending')::text as pending,
              count(*) filter (where execution_status = 'succeeded')::text as executed, count(*) filter (where execution_status = 'failed')::text as failed,
              count(*) filter (where execution_status = 'blocked')::text as held
       from approval_requests where org_id = $1 and created_at >= $2 and created_at < $3`,
      p,
    );
    const kinds = await db.query<{ k: string; n: string }>("select kind as k, count(*)::text as n from approval_requests where org_id = $1 and created_at >= $2 and created_at < $3 group by 1 order by count(*) desc", p);
    const a = approvals.rows[0];
    const tools = AGENT_TOOLS as Record<string, { label: string } | undefined>;
    return {
      toolCalls: outcome.rows.reduce((n, r) => n + num(r.n), 0),
      byOutcome: outcome.rows.map((r) => ({ key: r.k, label: OUTCOME_LABELS[r.k] ?? r.k, count: num(r.n) })),
      byTool: tool.rows.map((r) => ({ key: r.k, label: tools[r.k]?.label ?? (r.k === "workflow_task" ? "Workflow task" : r.k.replace(/_/g, " ")), count: num(r.n) })),
      byEmployee: employee.rows.map((r) => ({ key: r.k ?? "none", label: r.label ?? "Removed AI employee", count: num(r.n) })),
      approvals: {
        requested: num(a?.requested), approved: num(a?.approved), rejected: num(a?.rejected), expired: num(a?.expired), pending: num(a?.pending),
        executed: num(a?.executed), failed: num(a?.failed), held: num(a?.held),
      },
      approvalsByKind: kinds.rows.map((r) => ({ key: r.k, label: APPROVAL_KIND_LABELS[r.k] ?? r.k.replace(/_/g, " "), count: num(r.n) })),
    } satisfies AiReport;
  });
  return { section: "ai", data, empty: data.toolCalls === 0 && data.approvals.requested === 0, ignored: [], notes: [] };
}

/** Workflows: runs started in the period by what happened to them, and per workflow. Test runs perform nothing and are counted apart. */
export async function workflowsSection(scope: ReportScope): Promise<SectionResult<"workflows">> {
  const { actor } = scope;
  const data = await crmRead(actor, async (db) => {
    const p = [actor.orgId, scope.startsAt, scope.endsAt];
    const status = await db.query<{ status: string; real: string; test: string }>(
      `select r.status, count(*) filter (where r.started_via <> 'test')::text as real, count(*) filter (where r.started_via = 'test')::text as test
       from crm_workflow_runs r where r.org_id = $1 and r.created_at >= $2 and r.created_at < $3 group by 1`,
      p,
    );
    const per = await db.query<{ id: string; name: string; runs: string; completed: string; failed: string; dead: string }>(
      `select w.id, w.name, count(*)::text as runs, count(*) filter (where r.status = 'completed')::text as completed,
              count(*) filter (where r.status = 'failed')::text as failed, count(*) filter (where r.status = 'dead')::text as dead
       from crm_workflow_runs r join crm_workflows w on w.id = r.workflow_id and w.org_id = r.org_id
       where r.org_id = $1 and r.created_at >= $2 and r.created_at < $3 and r.started_via <> 'test'
       group by w.id, w.name order by count(*) filter (where r.status in ('failed', 'dead')) desc, count(*) desc, w.name limit 15`,
      p,
    );
    const get = (s: string) => num(status.rows.find((r) => r.status === s)?.real);
    return {
      runs: status.rows.reduce((n, r) => n + num(r.real), 0),
      completed: get("completed"),
      failed: get("failed"),
      dead: get("dead"),
      running: get("queued") + get("running") + get("waiting") + get("awaiting_approval"),
      cancelled: get("cancelled"),
      testRuns: status.rows.reduce((n, r) => n + num(r.test), 0),
      byWorkflow: per.rows.map((r) => ({ id: r.id, name: r.name, runs: num(r.runs), completed: num(r.completed), failed: num(r.failed), dead: num(r.dead) })),
      byStatus: status.rows.filter((r) => num(r.real) > 0).map((r) => ({ key: r.status, label: RUN_STATUS_LABELS[r.status] ?? r.status, count: num(r.real) })),
    } satisfies WorkflowsReport;
  });
  return { section: "workflows", data, empty: data.runs === 0 && data.testRuns === 0, ignored: [], notes: ownerNote(scope, "workflows", "automations") };
}

/**
 * Integration health, as it is now: each messaging channel's provider and whether its latest capability test passed, connection checks
 * recorded for the workspace, calendar connections and voice providers by status, and webhooks (with failed deliveries in the last 7
 * days). Counts and states only. A saved credential alone is never presented as a working connection.
 */
export async function integrationsSection(scope: ReportScope): Promise<SectionResult<"integrations">> {
  const { actor } = scope;
  // Trusted read after the integrations permission check: connection rows are otherwise visible only to the people who own them.
  const data = await withSystem(async (db) => {
    const since = new Date(Date.now() - 7 * DAY);
    const channels = await db.query<{ channel: string; provider: string; enabled: boolean; ok: string | null; tested_at: Date | null; registration: string }>(
      "select channel, provider, enabled, capability_test->>'ok' as ok, capability_tested_at as tested_at, registration_status as registration from messaging_channels where org_id = $1 order by channel",
      [actor.orgId],
    );
    const checks = await db.query<{ provider: string; status: string; checked: Date | null }>(
      "select provider, status, last_checked_at as checked from integration_status where org_id = $1 order by provider",
      [actor.orgId],
    );
    const calendars = await db.query<{ provider: string; status: string; n: string }>(
      "select provider, status, count(*)::text as n from crm_calendar_connections where org_id = $1 group by 1, 2 order by 1, 2",
      [actor.orgId],
    );
    const voice = await db.query<{ provider: string; status: string; last: Date | null }>("select provider, status, last_event_at as last from crm_voice_connections where org_id = $1 order by provider", [actor.orgId]);
    const hooks = await db.query<{ active: string; disabled: string; failed: string; dead: string }>(
      `select (select count(*) from crm_webhook_subscriptions where org_id = $1 and active)::text as active,
              (select count(*) from crm_webhook_subscriptions where org_id = $1 and not active)::text as disabled,
              (select count(*) from crm_webhook_deliveries where org_id = $1 and status = 'failed' and created_at >= $2)::text as failed,
              (select count(*) from crm_webhook_deliveries where org_id = $1 and status = 'dead' and created_at >= $2)::text as dead`,
      [actor.orgId, since],
    );
    const sync = await db.query<{ n: string }>("select count(*)::text as n from crm_calendar_sync_runs where org_id = $1 and status = 'failed' and started_at >= $2", [actor.orgId, since]);
    const h = hooks.rows[0];
    return {
      channels: channels.rows.map((c) => ({
        channel: c.channel, provider: c.provider, enabled: c.enabled, registration: c.registration, testedAt: c.tested_at ? new Date(c.tested_at).toISOString() : null,
        state: c.enabled && (c.provider === "ghl" || c.ok === "true") ? ("ready" as const) : c.ok === "false" ? ("test_failed" as const) : !c.enabled ? ("off" as const) : ("not_tested" as const),
      })),
      calendarConnections: calendars.rows.map((r) => ({ provider: r.provider, status: r.status, count: num(r.n) })),
      voice: voice.rows.map((v) => ({ provider: v.provider, status: v.status, lastEventAt: v.last ? new Date(v.last).toISOString() : null })),
      webhooks: { active: num(h?.active), disabled: num(h?.disabled), failedDeliveries: num(h?.failed), deadDeliveries: num(h?.dead) },
      checks: checks.rows.map((c) => ({ provider: c.provider, status: c.status, checkedAt: c.checked ? new Date(c.checked).toISOString() : null })),
      calendarSyncFailures: num(sync.rows[0]?.n),
    } satisfies IntegrationsReport;
  });
  const empty = !data.channels.length && !data.calendarConnections.length && !data.voice.length && !data.checks.length && !data.webhooks.active && !data.webhooks.disabled;
  return { section: "integrations", data, empty, ignored: [], notes: [] };
}

/** Usage costs: metered usage recorded in the billing ledger during the period, by unit, with what was charged and what could not be collected. */
export async function usageSection(scope: ReportScope): Promise<SectionResult<"usage">> {
  const { actor } = scope;
  // Trusted read after the usage permission check (the report service never computes a section someone can't see): the ledger has no
  // application-role grant, the same as the billing screens.
  const data = await withSystem(async (db) => {
    const { rows } = await db.query<{ unit: string; events: string; quantity: string; charged: string; uncollected: string }>(
      `select unit_type as unit, count(*)::text as events, sum(quantity)::text as quantity, sum(charged_micros)::text as charged, sum(uncollected_micros)::text as uncollected
       from metered_usage_events where org_id = $1 and occurred_at >= $2 and occurred_at < $3 group by 1 order by sum(client_micros) desc, 1`,
      [actor.orgId, scope.startsAt, scope.endsAt],
    );
    const dollars = (micros: string | number) => Math.round(num(micros) / 10_000) / 100;
    const byUnit = rows.map((r) => ({
      key: r.unit, label: UNIT_LABELS[r.unit] ?? r.unit.replace(/_/g, " "), events: num(r.events), quantity: Math.round(num(r.quantity) * 1000) / 1000, charged: dollars(r.charged), uncollected: dollars(r.uncollected),
    }));
    return {
      currency: "USD" as const,
      charged: dollars(rows.reduce((n, r) => n + num(r.charged), 0)),
      uncollected: dollars(rows.reduce((n, r) => n + num(r.uncollected), 0)),
      events: byUnit.reduce((n, r) => n + r.events, 0),
      byUnit,
    } satisfies UsageReport;
  });
  return { section: "usage", data, empty: data.events === 0, ignored: [], notes: [] };
}
