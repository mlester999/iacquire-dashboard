import "server-only";
import { readSystem } from "@/server/db";
import { env } from "@/server/env";
import { collectPlatformHealth } from "@/server/aqi/ops/tools/health";
import { num, plural } from "@/server/aqi/ops/tools/helpers";
import { OPS_STATE_LABEL, type OpsOverview, type OpsOverviewTile } from "@/lib/aqi/ops/types";

/**
 * The Operations Overview. Every tile is a measurement with its source; a tile with no data source
 * says so (`not_configured` / `unknown`) rather than showing a reassuring number. Platform health is
 * the same collector the investigation tool uses, so the page and the chat cannot disagree.
 *
 * Cost: one health collection (about five statements) plus a single aggregate statement. It is
 * requested once when the page opens and when an administrator presses Refresh: no timers, no polling.
 */
export async function getOpsOverview(now = new Date()): Promise<OpsOverview> {
  const started = Date.now();
  const health = await collectPlatformHealth(now);
  const { rows } = await readSystem((db) => db.query<{
    agents_enabled: number; agents_down: number; agents_setup: number; runs_failed: number; runs_running: number; approvals: number; approvals_stale: number;
    tickets_active: number; tickets_urgent: number; tickets_unassigned: number; tickets_overdue: number;
    onboarding_blocked: number; onboarding_clients: number; connections_bad: number; connections_total: number;
  }>(
    `select
       (select count(*) from agent_instances a join organizations o on o.id = a.org_id where a.enabled and o.status <> 'archived')::int as agents_enabled,
       (select count(*) from agent_instances a join organizations o on o.id = a.org_id where a.enabled and o.status <> 'archived' and a.status in ('error', 'offline'))::int as agents_down,
       (select count(*) from agent_instances a join organizations o on o.id = a.org_id where a.enabled and o.status <> 'archived' and a.status in ('setup_required', 'provisioning'))::int as agents_setup,
       (select count(*) from agent_runs where status in ('failed', 'timeout', 'interrupted') and finished_at > now() - interval '1 day' and purpose <> 'health_check')::int as runs_failed,
       (select count(*) from agent_runs where status = 'running' and started_at > now() - interval '30 minutes' and purpose <> 'health_check')::int as runs_running,
       (select count(*) from approval_requests where status = 'pending')::int as approvals,
       (select count(*) from approval_requests where status = 'pending' and created_at < now() - interval '24 hours')::int as approvals_stale,
       (select count(*) from support_tickets where status in ('new', 'open', 'in_progress', 'waiting_for_client'))::int as tickets_active,
       (select count(*) from support_tickets where status in ('new', 'open', 'in_progress', 'waiting_for_client') and priority in ('high', 'urgent'))::int as tickets_urgent,
       (select count(*) from support_tickets where status in ('new', 'open', 'in_progress') and assigned_to is null)::int as tickets_unassigned,
       (select count(*) from support_tickets t join support_ticket_ops p on p.ticket_id = t.id where t.status in ('new', 'open', 'in_progress') and p.response_due_at is not null and p.response_due_at < now())::int as tickets_overdue,
       (select count(distinct t.org_id) from client_setup_tasks t join client_setup_instances si on si.id = t.instance_id and si.state <> 'activated' join organizations o on o.id = t.org_id
         where t.status = 'blocked' and not t.hidden and not t.service_excluded and o.status <> 'archived')::int as onboarding_blocked,
       (select count(*) from client_setup_instances where state <> 'activated')::int as onboarding_clients,
       (select count(*) from integration_connections where status in ('error', 'needs_attention'))::int as connections_bad,
       (select count(*) from integration_connections)::int as connections_total`,
  ));
  const r = rows[0];
  const e = env();
  const schedulerConfigured = Boolean(e.SCHEDULER_ENABLED && e.CRON_SECRET);
  const tile = (t: OpsOverviewTile): OpsOverviewTile => t;
  const crit = health.incidents.critical;
  const warn = health.incidents.warning;

  const tiles: OpsOverviewTile[] = [
    tile({
      key: "health", label: "Platform health", state: health.overall, value: null,
      headline: OPS_STATE_LABEL[health.overall],
      detail: health.overall === "healthy" ? "Every check that can be measured here is healthy." : health.overall === "unknown" ? "Nothing is recorded as failing, but some checks could not be verified." : `${health.components.filter((c) => c.state === "degraded" || c.state === "unavailable").map((c) => c.label).join(", ")} need attention.`,
      href: "/admin/health", ask: "Investigate system health",
    }),
    tile({
      key: "incidents", label: "Open incidents", value: crit + warn,
      state: crit ? "unavailable" : warn ? "degraded" : health.collectorsRan ? "healthy" : "unknown",
      headline: crit + warn ? `${crit} critical, ${warn} warning` : health.collectorsRan ? "None open" : "None recorded",
      detail: health.collectorsRan ? "From the incident engine." : "Incident collectors are not running, so \"none\" does not prove health.",
      href: "/admin/health", ask: "Are there any production incidents right now?",
    }),
    tile({
      key: "jobs", label: "Failed jobs", value: health.collectorsRan ? health.jobsFailing : null,
      state: !health.collectorsRan ? (schedulerConfigured ? "unknown" : "not_configured") : health.jobsFailing ? "degraded" : "healthy",
      headline: !health.collectorsRan ? "No job history" : health.jobsFailing ? plural(health.jobsFailing, "job failing") : "None failing",
      detail: health.collectorsRan ? "Scheduled background jobs, last run." : schedulerConfigured ? "The scheduler is enabled but has not reported a run." : "No scheduler is configured, so background jobs only run when triggered externally.",
      href: "/admin/health", ask: "Which background jobs are failing?",
    }),
    tile({
      key: "employees", label: "AI Employees needing attention", value: num(r.agents_down),
      state: r.agents_enabled === 0 ? "not_configured" : r.agents_down || r.runs_failed ? "degraded" : "healthy",
      headline: r.agents_enabled === 0 ? "No employees" : `${r.agents_down} offline or in error`,
      detail: `${r.agents_enabled} enabled, ${r.agents_setup} still in setup, ${r.runs_failed} failed run${r.runs_failed === 1 ? "" : "s"} in 24 h, ${r.runs_running} running now.`,
      href: "/admin/employees/clients", ask: "Which AI Employees failed today?",
    }),
    tile({
      key: "approvals", label: "Pending approvals", value: num(r.approvals), state: r.approvals_stale ? "degraded" : "healthy",
      headline: r.approvals ? `${r.approvals} waiting` : "None waiting", detail: r.approvals ? `${r.approvals_stale} waiting longer than 24 hours. Clients decide these.` : "Nothing is waiting for a client decision.",
      href: "/admin/employees/clients", ask: "Show jobs waiting for approval",
    }),
    tile({
      key: "support", label: "Unresolved support tickets", value: num(r.tickets_active),
      state: r.tickets_urgent || r.tickets_overdue ? "degraded" : "healthy",
      headline: `${r.tickets_active} active`, detail: `${r.tickets_urgent} high or urgent, ${r.tickets_unassigned} unassigned, ${r.tickets_overdue} overdue for a first response.`,
      href: "/admin/support", ask: "Which support tickets are unresolved and urgent?",
    }),
    tile({
      key: "onboarding", label: "Client onboarding problems", value: num(r.onboarding_blocked),
      state: r.onboarding_clients === 0 ? "unknown" : r.onboarding_blocked ? "degraded" : "healthy",
      headline: r.onboarding_blocked ? `${plural(r.onboarding_blocked, "client")} blocked` : "No blocked clients", detail: `${r.onboarding_clients} client${r.onboarding_clients === 1 ? "" : "s"} still in setup.`,
      href: "/admin/clients", ask: "Which clients are blocked in onboarding?",
    }),
    tile({
      key: "integrations", label: "Integration failures", value: r.connections_total ? num(r.connections_bad) : null,
      state: r.connections_total === 0 ? "not_configured" : r.connections_bad ? "degraded" : "healthy",
      headline: r.connections_total === 0 ? "No connections" : r.connections_bad ? `${r.connections_bad} in error` : "None in error", detail: `${r.connections_total} connection${r.connections_total === 1 ? "" : "s"} recorded; status is the last verified result.`,
      href: "/admin/integrations", ask: "Investigate integration failures",
    }),
  ];
  const notConfigured = [
    { label: "Request error rate and application latency", needs: "An APM or request-log store (for example Vercel Observability or Sentry) connected to this application." },
    { label: "Slow-query telemetry", needs: "Read access to pg_stat_statements or the database provider's query insights." },
    { label: "Deployment and CI status", needs: "A deployment/CI API integration; today only the running commit is visible." },
    ...(schedulerConfigured ? [] : [{ label: "Scheduled jobs and incident checks", needs: "An external scheduler calling /api/internal/tick, with CRON_SECRET and SCHEDULER_ENABLED set." }]),
  ];
  return { generatedAt: now.toISOString(), tiles, notConfigured, durationMs: Date.now() - started };
}
