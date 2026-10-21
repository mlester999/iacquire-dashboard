import "server-only";
import { readSystem } from "@/server/db";
import { collectPlatformHealth } from "@/server/aqi/ops/tools/health";
import { clean, iso, num, plural, usd } from "@/server/aqi/ops/tools/helpers";
import { OPS_STATE_LABEL, type OpsHealthState } from "@/lib/aqi/ops/types";

/**
 * Builds an operations briefing from recorded evidence only. The same function backs the on-demand
 * `briefing.compose` tool and the scheduled briefings, so a scheduled summary can never say something
 * a person asking the same question would not be told. It states its reporting period and sources.
 */
export interface BriefingItem { text: string; href?: string }
export interface BriefingSection { key: string; title: string; state: OpsHealthState; items: BriefingItem[] }
export interface Briefing {
  title: string;
  period: { from: string; to: string; hours: number };
  generatedAt: string;
  sections: BriefingSection[];
  recommended: BriefingItem[];
  sources: string[];
  summary: string;
  /** True when at least one section reports something that needs a person. A quiet day is still stored, but not announced. */
  noteworthy: boolean;
}

export interface ComposeBriefingInput {
  userId: string;
  now: Date;
  hours: number;
  kind: "daily" | "weekly" | "on_demand" | "critical";
}

export async function composeBriefing(input: ComposeBriefingInput): Promise<Briefing> {
  const { now } = input;
  const from = new Date(now.getTime() - input.hours * 3_600_000);
  const sections: BriefingSection[] = [];
  const recommended: BriefingItem[] = [];
  const sources = new Set<string>();

  const health = await collectPlatformHealth(now);
  sources.add("Platform health checks (database probe, migrations, scheduler, incidents, email, AI provider, Hermes, integrations, CRM delivery, payment webhooks)");
  const unhealthy = health.components.filter((c) => c.state === "degraded" || c.state === "unavailable");
  const unverified = health.components.filter((c) => c.state === "unknown" || c.state === "not_configured");
  sections.push({
    key: "health", title: "Platform health", state: health.overall,
    items: [
      { text: `Overall: ${OPS_STATE_LABEL[health.overall]}.`, href: "/admin/health" },
      ...unhealthy.map((c) => ({ text: `${c.label}: ${OPS_STATE_LABEL[c.state]}. ${c.detail}`, href: c.href })),
      ...(unverified.length ? [{ text: `Could not be verified: ${unverified.map((c) => c.label).join(", ")}.` }] : []),
    ],
  });

  const { rows } = await readSystem((db) => db.query<{ section: string; payload: Record<string, unknown> }>(
    `select u.section, u.payload from (
     (select 'incident' as section, to_jsonb(x) as payload from (select i.severity, i.title, o.name as org, i.detected_at, i.status from incidents i left join organizations o on o.id = i.org_id
        where i.status <> 'resolved' or i.detected_at >= $1 order by case i.severity when 'critical' then 0 when 'warning' then 1 else 2 end, i.detected_at desc limit 5) x)
     union all
     (select 'runs', to_jsonb(x) from (select o.name as org, count(*)::int as failed from agent_runs r join organizations o on o.id = r.org_id
        where r.status in ('failed', 'timeout', 'interrupted') and r.finished_at >= $1 and r.purpose <> 'health_check' group by o.name order by count(*) desc limit 5) x)
     union all
     (select 'agents_down', to_jsonb(x) from (select count(*)::int as n from agent_instances a join organizations o on o.id = a.org_id where a.enabled and o.status <> 'archived' and a.status in ('error', 'offline')) x)
     union all
     (select 'approvals', to_jsonb(x) from (select count(*)::int as pending, count(*) filter (where created_at < $2::timestamptz - interval '24 hours')::int as stale, min(created_at) as oldest from approval_requests where status = 'pending') x)
     union all
     (select 'onboarding', to_jsonb(x) from (select o.name as org, count(t.id) filter (where t.status = 'blocked')::int as blocked, count(t.id) filter (where t.status = 'waiting_for_client')::int as waiting
        from organizations o join client_setup_instances si on si.org_id = o.id and si.state <> 'activated' join client_setup_tasks t on t.instance_id = si.id and not t.hidden and not t.service_excluded
       where o.kind = 'client' and o.status <> 'archived' group by o.name having count(t.id) filter (where t.status = 'blocked') > 0 order by 2 desc limit 5) x)
     union all
     (select 'tickets', to_jsonb(x) from (select count(*) filter (where status in ('new', 'open', 'in_progress', 'waiting_for_client'))::int as active,
        count(*) filter (where status in ('new', 'open', 'in_progress', 'waiting_for_client') and priority in ('high', 'urgent'))::int as urgent,
        count(*) filter (where created_at >= $1)::int as new_in_period,
        count(*) filter (where status in ('new', 'open', 'in_progress') and assigned_to is null)::int as unassigned from support_tickets) x)
     union all
     (select 'escalated', to_jsonb(x) from (select count(*)::int as n from support_ticket_ops p join support_tickets t on t.id = p.ticket_id where p.escalated_at is not null and t.status in ('new', 'open', 'in_progress', 'waiting_for_client')) x)
     union all
     (select 'connections', to_jsonb(x) from (select c.provider, o.name as org from integration_connections c left join organizations o on o.id = c.org_id where c.status in ('error', 'needs_attention') order by c.last_failure_at desc nulls last limit 5) x)
     union all
     (select 'delivery', to_jsonb(x) from (select
        (select count(*) from crm_workflow_runs where status in ('failed', 'dead') and created_at >= $1)::int as workflows,
        (select count(*) from conversation_messages where direction = 'outbound' and status = 'failed' and created_at >= $1)::int as messages,
        (select count(*) from crm_webhook_deliveries where status in ('failed', 'dead') and created_at >= $1)::int as webhooks) x)
     union all
     (select 'cost', to_jsonb(x) from (select
        coalesce(sum(wholesale_micros) filter (where occurred_at >= date_trunc('day', $2::timestamptz) - interval '1 day' and occurred_at < date_trunc('day', $2::timestamptz)), 0)::text as yesterday,
        coalesce(sum(wholesale_micros) filter (where occurred_at >= date_trunc('day', $2::timestamptz) - interval '8 days' and occurred_at < date_trunc('day', $2::timestamptz) - interval '1 day'), 0)::text as prior_week
        from metered_usage_events where occurred_at >= date_trunc('day', $2::timestamptz) - interval '8 days') x)
     ) u`,
    [from.toISOString(), now.toISOString()],
  ));
  const by = <T = Record<string, unknown>>(s: string): T[] => rows.filter((r) => r.section === s).map((r) => r.payload as T);
  const one = <T = Record<string, unknown>>(s: string): T => (by<T>(s)[0] ?? ({} as T));

  const incidents = by<{ severity: string; title: string; org: string | null; detected_at: string; status: string }>("incident");
  const open = incidents.filter((i) => i.status !== "resolved");
  sources.add("Incident engine (incidents)");
  sections.push({
    key: "incidents", title: "Incidents", state: open.some((i) => i.severity === "critical") ? "unavailable" : open.length ? "degraded" : health.collectorsRan ? "healthy" : "unknown",
    items: incidents.length ? incidents.map((i) => ({ text: `${i.severity.toUpperCase()} ${i.status}: ${clean(i.title, 120)}${i.org ? ` (${clean(i.org, 40)})` : ""}, detected ${i.detected_at.slice(0, 16).replace("T", " ")} UTC`, href: "/admin/health" })) : [{ text: health.collectorsRan ? "No open incidents and none detected in the period." : "No incidents are recorded, but the incident collectors are not running, so this is not proof of health." }],
  });

  const runs = by<{ org: string; failed: number }>("runs");
  const agentsDown = num(one<{ n: number }>("agents_down").n);
  const failedRunTotal = runs.reduce((n, r) => n + num(r.failed), 0);
  sources.add("Hermes runs (agent_runs, agent_instances)");
  sections.push({
    key: "hermes", title: "Failed Hermes executions", state: failedRunTotal || agentsDown ? "degraded" : "healthy",
    items: [
      { text: failedRunTotal ? `${plural(failedRunTotal, "AI run")} failed in the period: ${runs.map((r) => `${clean(r.org, 40)} ${r.failed}`).join(", ")}.` : "No AI runs failed in the period.", href: "/admin/employees/clients" },
      ...(agentsDown ? [{ text: `${plural(agentsDown, "enabled AI Employee")} reported offline or in error at their last health check.`, href: "/admin/employees/clients" }] : []),
    ],
  });

  const approvals = one<{ pending: number; stale: number; oldest: string | null }>("approvals");
  sources.add("Approval queue (approval_requests)");
  sections.push({
    key: "approvals", title: "Pending approvals", state: num(approvals.stale) ? "degraded" : "healthy",
    items: [{ text: num(approvals.pending) ? `${plural(num(approvals.pending), "approval")} waiting for a client decision; ${num(approvals.stale)} for more than 24 hours.` : "No approvals are waiting.", href: "/admin/employees/clients" }],
  });

  const onboarding = by<{ org: string; blocked: number; waiting: number }>("onboarding");
  sources.add("Setup Center (client_setup_instances, client_setup_tasks)");
  sections.push({
    key: "onboarding", title: "Blocked client onboarding", state: onboarding.length ? "degraded" : "healthy",
    items: onboarding.length ? onboarding.map((o) => ({ text: `${clean(o.org, 50)}: ${plural(num(o.blocked), "blocked task")}${num(o.waiting) ? `, ${num(o.waiting)} waiting on the client` : ""}.`, href: "/admin/clients" })) : [{ text: "No client has blocked setup tasks." }],
  });

  const tickets = one<{ active: number; urgent: number; new_in_period: number; unassigned: number }>("tickets");
  const escalated = num(one<{ n: number }>("escalated").n);
  sources.add("Support & Requests (support_tickets)");
  sections.push({
    key: "support", title: "Support tickets", state: num(tickets.urgent) || escalated ? "degraded" : "healthy",
    items: [{ text: `${num(tickets.active)} active requests (${num(tickets.new_in_period)} new in the period, ${num(tickets.unassigned)} unassigned, ${num(tickets.urgent)} high or urgent, ${escalated} escalated).`, href: "/admin/support" }],
  });

  const connections = by<{ provider: string; org: string | null }>("connections");
  const delivery = one<{ workflows: number; messages: number; webhooks: number }>("delivery");
  const deliveryTotal = num(delivery.workflows) + num(delivery.messages) + num(delivery.webhooks);
  sources.add("Integration connections and delivery tables (integration_connections, crm_workflow_runs, conversation_messages, crm_webhook_deliveries)");
  sections.push({
    key: "integrations", title: "Integration failures", state: connections.length || deliveryTotal ? "degraded" : "healthy",
    items: [
      { text: connections.length ? `${plural(connections.length, "connection")} in error or needing attention: ${connections.map((c) => `${c.provider}${c.org ? ` (${clean(c.org, 30)})` : ""}`).join(", ")}.` : "No connection is in error.", href: "/admin/integrations" },
      { text: deliveryTotal ? `In the period: ${num(delivery.messages)} outbound messages failed, ${num(delivery.workflows)} workflow runs failed, ${num(delivery.webhooks)} webhook deliveries failed.` : "No message, workflow or webhook delivery failures in the period." },
    ],
  });

  const cost = one<{ yesterday: string; prior_week: string }>("cost");
  const yesterday = num(cost.yesterday);
  const baseline = num(cost.prior_week) / 7;
  const anomaly = yesterday > 5_000_000 && baseline > 0 && yesterday > baseline * 2;
  sources.add("Metered usage (metered_usage_events)");
  sections.push({
    key: "costs", title: "Cost anomalies", state: anomaly ? "degraded" : baseline === 0 && yesterday === 0 ? "unknown" : "healthy",
    items: [{ text: baseline === 0 && yesterday === 0 ? "No metered usage was recorded in the last 8 days, so cost anomalies cannot be assessed." : anomaly ? `Yesterday's wholesale provider cost ${usd(yesterday)} is more than twice the previous 7-day daily average ${usd(baseline)}.` : `Yesterday's wholesale provider cost ${usd(yesterday)} against a previous 7-day daily average of ${usd(baseline)}: no anomaly.`, href: "/admin/usage" }],
  });

  if (unhealthy.length) recommended.push({ text: `Review ${unhealthy.map((c) => c.label).join(", ")} on System health.`, href: "/admin/health" });
  if (open.some((i) => i.severity === "critical")) recommended.push({ text: "Acknowledge or resolve the open critical incidents.", href: "/admin/health" });
  if (num(approvals.stale)) recommended.push({ text: "Nudge clients about approvals that have waited more than 24 hours.", href: "/admin/employees/clients" });
  if (onboarding.length) recommended.push({ text: `Unblock onboarding for ${onboarding.slice(0, 3).map((o) => clean(o.org, 40)).join(", ")}.`, href: "/admin/clients" });
  if (num(tickets.unassigned)) recommended.push({ text: `Assign ${plural(num(tickets.unassigned), "unassigned request")}.`, href: "/admin/support" });
  if (connections.length) recommended.push({ text: "Re-test the failing integration connections.", href: "/admin/integrations" });
  if (anomaly) recommended.push({ text: "Check which client drove yesterday's provider cost.", href: "/admin/usage" });
  if (health.overall === "unknown" || health.overall === "degraded") {
    const sched = health.components.find((c) => c.key === "scheduler");
    if (sched && sched.state !== "healthy") recommended.push({ text: "Configure the external scheduler for /api/internal/tick so incident checks, reply checks and briefings run automatically.", href: "/admin/health" });
  }

  const noteworthy = sections.some((s) => s.state === "degraded" || s.state === "unavailable");
  const label = input.kind === "weekly" ? "Weekly operations summary" : input.kind === "critical" ? "Critical alert" : input.kind === "daily" ? "Daily operations briefing" : "Operations briefing";
  const attention = sections.filter((s) => s.state === "degraded" || s.state === "unavailable").map((s) => s.title.toLowerCase());
  return {
    title: `${label}: ${now.toISOString().slice(0, 10)}`,
    period: { from: iso(from)!, to: iso(now)!, hours: input.hours },
    generatedAt: iso(now)!,
    sections, recommended, sources: [...sources],
    summary: noteworthy ? `Needs attention: ${attention.join(", ")}. Platform health is ${OPS_STATE_LABEL[health.overall].toLowerCase()}.` : `Nothing recorded needs attention. Platform health is ${OPS_STATE_LABEL[health.overall].toLowerCase()}${unverified.length ? `, but ${unverified.map((c) => c.label.toLowerCase()).join(", ")} could not be verified` : ""}.`,
    noteworthy,
  };
}
