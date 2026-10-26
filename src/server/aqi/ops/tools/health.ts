import "server-only";
import { z } from "zod";
import { listMigrationFiles, pingDb, readSystem } from "@/server/db";
import { env } from "@/server/env";
import { crmDeliveryHealth } from "@/server/admin/health";
import { defineReadTool } from "@/server/aqi/ops/tool";
import { ageHours, clean, iso, metric, minutesBetween, newCardId, num, plural, worstState } from "@/server/aqi/ops/tools/helpers";
import {
  OPS_STATE_LABEL,
  type OpsHealthCard,
  type OpsHealthState,
  type OpsIncidentRow,
  type OpsIncidentsCard,
  type OpsMetricsCard,
  type OpsTimelineCard,
} from "@/lib/aqi/ops/types";
import { runtimeReadySql } from "@/lib/employee-runtime";

const SUPER = ["agency_super_admin"] as const;

/** What this deployment cannot measure. Reported on every health answer so silence is never mistaken for health. */
export const UNMEASURED = [
  "API request error rates and application latency: no APM or request-log store is integrated, so these cannot be determined.",
  "Slow-query telemetry: pg_stat_statements and the database provider's query insights are not read by the application.",
  "Host resource usage (CPU, memory, connections): not exposed to the application.",
  "Deployment and CI status: no deployment or CI API is integrated; only variables the host injects at runtime are available.",
] as const;

interface HealthRow {
  crit: number; warn: number; tick_at: Date | null; jobs_failing: number; jobs_known: number;
  email_queued: number; email_failed: number; agents_total: number; agents_down: number; agents_online: number;
  integrations_bad: number; integrations_total: number; llm_status: string | null;
  pay_err: number; pay_stuck: number; applied: string[]; cli_table: string | null;
}

export interface PlatformHealthResult {
  overall: OpsHealthState;
  components: OpsHealthCard["components"];
  pending: string[];
  crm: Awaited<ReturnType<typeof crmDeliveryHealth>>;
  summary: string;
  jobsFailing: number;
  incidents: { critical: number; warning: number };
  collectorsRan: boolean;
}

/**
 * The one place platform health is computed. The AQi Operations overview and the investigation tool
 * both call it, so the page and the chat can never disagree. Read-only: it never writes an incident.
 */
export async function collectPlatformHealth(now: Date): Promise<PlatformHealthResult> {
    const e = env();
    const ctx = { now };
    const [ping, snapshot, crm] = await (async () => {
      const probe = await pingDb();
      const { rows } = await readSystem((db) => db.query<HealthRow>(
        `select
           (select count(*) from incidents where status <> 'resolved' and severity = 'critical')::int as crit,
           (select count(*) from incidents where status <> 'resolved' and severity = 'warning')::int as warn,
           (select max(last_finished_at) from worker_job_runs where job_name = 'tick') as tick_at,
           (select count(*) from worker_job_runs where job_name <> 'tick' and consecutive_failures >= 1)::int as jobs_failing,
           (select count(*) from worker_job_runs where job_name <> 'tick')::int as jobs_known,
           (select count(*) from email_outbox where status = 'queued')::int as email_queued,
           (select count(*) from email_outbox where status = 'failed' and created_at > now() - interval '1 day')::int as email_failed,
           (select count(*) from agent_instances a join organizations o on o.id = a.org_id where a.enabled and o.status <> 'archived')::int as agents_total,
           (select count(*) from agent_instances a join organizations o on o.id = a.org_id where a.enabled and o.status <> 'archived' and a.status in ('error', 'offline'))::int as agents_down,
           (select count(*) from agent_instances a join organizations o on o.id = a.org_id where a.enabled and o.status <> 'archived' and ${runtimeReadySql("a")})::int as agents_online,
           (select count(*) from integration_connections where status in ('error', 'needs_attention'))::int as integrations_bad,
           (select count(*) from integration_connections)::int as integrations_total,
           (select status from integration_connections where org_id is null and provider = 'llm' order by updated_at desc limit 1) as llm_status,
           (select count(*) from payment_webhook_events where outcome = 'error' and received_at > now() - interval '1 day')::int as pay_err,
           (select count(*) from payment_webhook_events where outcome = 'received' and received_at < now() - interval '10 minutes')::int as pay_stuck,
           coalesce((select array_agg(version) from schema_migrations), '{}'::text[]) as applied,
           to_regclass('supabase_migrations.schema_migrations')::text as cli_table`,
      ));
      const row = rows[0];
      const crmHealth = await readSystem((db) => crmDeliveryHealth(db, ctx.now));
      return [probe, row, crmHealth] as const;
    })();

    let applied = new Set(snapshot.applied);
    if (snapshot.cli_table) {
      const { rows } = await readSystem((db) => db.query<{ version: string }>("select version from supabase_migrations.schema_migrations"));
      const prefixes = new Set(rows.map((r) => r.version));
      applied = new Set([...applied, ...listMigrationFiles().filter((f) => prefixes.has(f.slice(0, f.indexOf("_")))).map((f) => f.replace(/\.sql$/, ""))]);
    }
    const pending = listMigrationFiles().map((f) => f.replace(/\.sql$/, "")).filter((v) => !applied.has(v));

    const components: OpsHealthCard["components"] = [];
    const add = (key: string, label: string, state: OpsHealthState, detail: string, href?: string) => components.push({ key, label, state, detail, ...(href ? { href } : {}) });

    add("database", "Database", !ping.ok ? "unavailable" : ping.latencyMs >= 1500 ? "degraded" : "healthy",
      ping.ok ? `One connectivity probe answered in ${ping.latencyMs} ms. Latency history is not recorded, so this cannot show whether the database was slow earlier.` : "The connectivity probe failed.");
    add("migrations", "Schema migrations", pending.length ? "degraded" : "healthy",
      pending.length ? `${plural(pending.length, "migration")} not recorded as applied: ${pending.slice(0, 4).join(", ")}${pending.length > 4 ? "…" : ""}.` : "Every migration in this release is recorded as applied.");

    const schedulerConfigured = Boolean(e.SCHEDULER_ENABLED && e.CRON_SECRET);
    const tickMinutes = minutesBetween(snapshot.tick_at, ctx.now);
    let scheduler: OpsHealthState;
    let schedulerDetail: string;
    if (!schedulerConfigured) {
      scheduler = "not_configured";
      schedulerDetail = "The scheduled-worker endpoint is disabled by configuration, so reply checks, follow-ups, incident collectors and briefings only run when someone triggers them.";
    } else if (tickMinutes === null) {
      scheduler = "unknown";
      schedulerDetail = "The endpoint is enabled, but no scheduler run has ever been recorded.";
    } else if (tickMinutes > e.SCHEDULER_STALE_MINUTES) {
      scheduler = "unavailable";
      schedulerDetail = `The last completed run was ${tickMinutes} minutes ago (expected within ${e.SCHEDULER_STALE_MINUTES}).`;
    } else {
      scheduler = "healthy";
      schedulerDetail = `Last completed run ${tickMinutes} minutes ago.`;
    }
    add("scheduler", "Scheduler", scheduler, schedulerDetail, "/admin/health");

    const collectorsRan = scheduler === "healthy";
    const jobsState: OpsHealthState = !collectorsRan ? (scheduler === "not_configured" ? "not_configured" : "unknown") : snapshot.jobs_failing > 0 ? "degraded" : "healthy";
    add("jobs", "Scheduled jobs", jobsState,
      !collectorsRan ? "No job history can be trusted while the scheduler is not running." : snapshot.jobs_failing > 0 ? `${plural(snapshot.jobs_failing, "job")} failed their last run.` : `${plural(snapshot.jobs_known, "job")} reporting, none failing.`, "/admin/health");

    const openIncidents = snapshot.crit + snapshot.warn;
    const incidentState: OpsHealthState = snapshot.crit > 0 ? "unavailable" : snapshot.warn > 0 ? "degraded" : collectorsRan ? "healthy" : "unknown";
    add("incidents", "Incidents", incidentState,
      openIncidents
        ? `${snapshot.crit} critical and ${snapshot.warn} warning incident${openIncidents === 1 ? "" : "s"} open.`
        : collectorsRan ? "No open incidents." : "No open incidents are recorded, but the incident collectors are not running, so this does not prove the platform is healthy.", "/admin/health");

    const emailLive = e.EMAIL_PROVIDER === "resend";
    add("email", "Email delivery", !emailLive ? "not_configured" : snapshot.email_failed > 0 ? "degraded" : "healthy",
      !emailLive ? "The email provider is set to capture mode: messages are recorded, not delivered." : `${snapshot.email_failed} failed in the last 24 hours; ${snapshot.email_queued} queued.`);

    const llm = snapshot.llm_status;
    add("ai_provider", "AI provider", !llm ? "not_configured" : llm === "connected" ? "healthy" : llm === "error" ? "unavailable" : "degraded",
      !llm ? "No platform AI provider connection is recorded." : `Last verified connection status: ${clean(llm, 40)} (a recorded status, not a live probe).`, "/admin/integrations");

    // "Healthy" needs employees that actually passed a health check: employees still in setup are neither up nor down.
    add("hermes", "Hermes AI workforce", snapshot.agents_total === 0 ? "not_configured" : snapshot.agents_down > 0 ? "degraded" : snapshot.agents_online === 0 ? "unknown" : "healthy",
      snapshot.agents_total === 0
        ? "No enabled AI employees are recorded."
        : snapshot.agents_down > 0
          ? `${snapshot.agents_down} of ${snapshot.agents_total} enabled employees reported offline or in error at their last health check.`
          : snapshot.agents_online === 0
            ? `${snapshot.agents_total} enabled employees, but none has passed a health check yet (they are still in setup), so nothing can be said about their availability.`
            : `${snapshot.agents_online} of ${snapshot.agents_total} enabled employees online at their last health check; none reported down.`, "/admin/employees/clients");

    add("integrations", "Integrations", snapshot.integrations_total === 0 ? "not_configured" : snapshot.integrations_bad > 0 ? "degraded" : "healthy",
      snapshot.integrations_total === 0 ? "No integration connections are recorded." : snapshot.integrations_bad > 0 ? `${snapshot.integrations_bad} of ${snapshot.integrations_total} connections are in error or need attention.` : `${snapshot.integrations_total} connections, none in error.`, "/admin/integrations");

    const crmBad = (crm.events.oldestPendingMinutes ?? 0) > 15 || crm.events.deadLetters24h > 0 || crm.workflows.failed24h + crm.workflows.dead24h > 0 || crm.webhooks.dead24h > 0 || crm.forms.failed24h > 0;
    add("crm", "Native CRM delivery", crmBad ? "degraded" : "healthy",
      `Event backlog ${crm.events.backlog}${crm.events.oldestPendingMinutes !== null ? ` (oldest ${crm.events.oldestPendingMinutes} min)` : ""}; workflow failures ${crm.workflows.failed24h + crm.workflows.dead24h}, webhook dead letters ${crm.webhooks.dead24h}, form failures ${crm.forms.failed24h} in 24 h.`, "/admin/crm/reports");

    add("payments", "Payment webhooks", snapshot.pay_err + snapshot.pay_stuck > 0 ? "degraded" : "healthy",
      snapshot.pay_err + snapshot.pay_stuck > 0 ? `${snapshot.pay_err} failed and ${snapshot.pay_stuck} unprocessed in the last 24 hours.` : "No failed or unprocessed payment events in the last 24 hours.", "/admin/billing");

    const core = components.filter((c) => ["database", "migrations", "scheduler", "incidents"].includes(c.key));
    const hard = components.filter((c) => c.state === "unavailable" || c.state === "degraded");
    const overall: OpsHealthState = hard.length
      ? (components.find((c) => c.key === "database")?.state === "unavailable" ? "unavailable" : "degraded")
      : core.some((c) => c.state === "unknown" || c.state === "not_configured") ? "unknown" : worstState(components.map((c) => c.state));

    const unverified = components.filter((c) => c.state === "unknown" || c.state === "not_configured").map((c) => c.label);
    const summary = `Overall: ${OPS_STATE_LABEL[overall]}. ${components.map((c) => `${c.label}: ${OPS_STATE_LABEL[c.state]}`).join("; ")}.${
      overall === "unknown" ? ` Nothing is recorded as failing, but ${unverified.join(", ")} could not be verified, so the platform cannot be called healthy.` : ""}`;

    return { overall, components, pending, crm, summary, jobsFailing: snapshot.jobs_failing, incidents: { critical: snapshot.crit, warning: snapshot.warn }, collectorsRan };
}

export const platformHealth = defineReadTool({
  id: "platform.health",
  title: "Platform health snapshot",
  description: "Current state of the database, migrations, scheduler, incidents, email, AI provider, Hermes workforce, integrations, CRM delivery and payment webhooks, from recorded evidence.",
  group: "health",
  roles: SUPER,
  permission: "agency.security.manage",
  scopes: ["platform"],
  input: z.object({}).strict(),
  idempotent: true,
  audit: { action: "aqi.ops_tool_run", sensitive: false },
  timeoutMs: 12_000,
  async run(ctx) {
    const { overall, components, pending, crm, summary } = await collectPlatformHealth(ctx.now);
    const card: OpsHealthCard = {
      id: newCardId(), kind: "health", title: "Platform health", asOf: new Date().toISOString(), source: "Application checks and recorded system state",
      refresh: { toolId: "platform.health", args: {} }, state: overall,
      summary: overall === "unknown" ? "Nothing is recorded as failing, but some checks could not be verified." : overall === "healthy" ? "Every check that can be measured here is healthy." : "At least one check is degraded or unavailable.",
      components, unavailable: [...UNMEASURED],
      links: [{ label: "System health", href: "/admin/health" }, { label: "Integrations", href: "/admin/integrations" }],
    };
    return {
      summary,
      data: { overall, components: components.map((c) => ({ key: c.key, state: c.state, detail: c.detail })), pendingMigrations: pending.slice(0, 10), crm, unmeasured: UNMEASURED },
      cards: [card],
      evidence: { label: "Platform health snapshot", source: "Database probe, incidents, worker_job_runs, email_outbox, agent_instances, integration_connections, payment_webhook_events, CRM delivery tables", href: "/admin/health" },
      unavailable: [...UNMEASURED],
    };
  },
});

// ---------------------------------------------------------------------------

interface IncidentDbRow {
  id: string; severity: "info" | "warning" | "critical"; status: string; title: string; org: string | null; source: string; detected_at: Date; last_seen_at: Date;
  occurrences: number; detail: string | null; org_id: string | null; total: string;
}

export const platformIncidents = defineReadTool({
  id: "platform.incidents",
  title: "Incidents",
  description: "Open and recently resolved incidents from the incident engine, optionally for the selected client or a single incident, with its timeline.",
  group: "health",
  roles: SUPER,
  permission: "agency.security.manage",
  scopes: ["platform", "tenant", "incident", "employee", "workflow", "ticket"],
  input: z.object({
    includeResolved: z.boolean().default(false),
    days: z.number().int().min(1).max(30).default(7),
    limit: z.number().int().min(1).max(15).default(10),
  }).strict(),
  idempotent: true,
  audit: { action: "aqi.ops_tool_run", sensitive: false },
  timeoutMs: 8_000,
  async run(ctx, args) {
    const incidentId = ctx.scope.type === "incident" ? ctx.scope.id : null;
    const orgId = ctx.scope.type === "platform" || ctx.scope.type === "incident" ? null : ctx.scope.orgId;
    const { rows } = await readSystem((db) => db.query<IncidentDbRow>(
      `select i.id, i.severity, i.status, i.title, o.name as org, i.source, i.detected_at, i.last_seen_at, i.occurrences, i.detail, i.org_id,
              count(*) over ()::text as total
         from incidents i left join organizations o on o.id = i.org_id
        where ($1::boolean or i.status <> 'resolved')
          and (i.status <> 'resolved' or i.resolved_at > now() - make_interval(days => $2))
          and ($3::uuid is null or i.org_id = $3)
          and ($4::uuid is null or i.id = $4)
        order by (i.status = 'resolved'), case i.severity when 'critical' then 0 when 'warning' then 1 else 2 end, i.detected_at desc
        limit $5`,
      [args.includeResolved, args.days, orgId, incidentId, args.limit],
    ));
    if (incidentId && rows[0]?.org_id) await ctx.authorizeOrg(rows[0].org_id, "incident");
    const total = rows[0] ? Number(rows[0].total) : 0;
    const mapped: OpsIncidentRow[] = rows.map((r) => ({
      id: r.id, severity: r.severity, status: r.status, title: clean(r.title, 140), org: r.org ? clean(r.org, 80) : null, source: r.source,
      detectedAt: iso(r.detected_at)!, lastSeenAt: iso(r.last_seen_at)!, occurrences: r.occurrences, href: "/admin/health",
    }));
    const open = rows.filter((r) => r.status !== "resolved");
    const cards: Array<OpsIncidentsCard | OpsTimelineCard> = [{
      id: newCardId(), kind: "incidents", title: orgId ? "Incidents for this client" : incidentId ? "Incident" : "Incidents", asOf: new Date().toISOString(),
      source: "Incident engine (incidents table)", refresh: { toolId: "platform.incidents", args }, open: open.length, critical: open.filter((r) => r.severity === "critical").length, rows: mapped, truncated: total > rows.length,
    }];
    if (incidentId) {
      const { rows: events } = await readSystem((db) => db.query<{ at: Date; kind: string; detail: string | null }>(
        "select created_at as at, kind, detail from incident_events where incident_id = $1 order by created_at desc limit 12", [incidentId],
      ));
      cards.push({
        id: newCardId(), kind: "timeline", title: "Incident timeline", asOf: new Date().toISOString(), source: "Incident events (incident_events table)",
        events: events.reverse().map((ev) => ({ at: iso(ev.at)!, label: clean(ev.kind, 40), detail: ev.detail ? clean(ev.detail, 200) : undefined })),
      });
    }
    const summary = rows.length
      ? `${plural(open.length, "open incident")} (${open.filter((r) => r.severity === "critical").length} critical). ${rows.slice(0, 5).map((r) => `${r.severity.toUpperCase()}: ${clean(r.title, 100)}${r.org ? ` (${clean(r.org, 40)})` : ""}, first detected ${iso(r.detected_at)}, seen ${r.occurrences}×`).join("; ")}.`
      : "No incidents matched. This only means none are recorded: incident collectors run from the scheduler.";
    return {
      summary,
      data: { total, incidents: rows.slice(0, args.limit).map((r) => ({ id: r.id, severity: r.severity, status: r.status, title: r.title, org: r.org, source: r.source, detectedAt: iso(r.detected_at), lastSeenAt: iso(r.last_seen_at), occurrences: r.occurrences, detail: r.detail, ageHours: ageHours(r.detected_at, ctx.now) })) },
      cards,
      evidence: { label: "Incidents", source: "Incident engine (incidents, incident_events)", href: "/admin/health" },
    };
  },
});

// ---------------------------------------------------------------------------

export const platformJobs = defineReadTool({
  id: "platform.jobs",
  title: "Scheduled job history",
  description: "Last run, last success and consecutive failures of each scheduled background job, from the worker heartbeat table.",
  group: "health",
  roles: SUPER,
  permission: "agency.security.manage",
  scopes: ["platform"],
  input: z.object({ failingOnly: z.boolean().default(false), limit: z.number().int().min(1).max(40).default(20) }).strict(),
  idempotent: true,
  audit: { action: "aqi.ops_tool_run", sensitive: false },
  timeoutMs: 6_000,
  async run(ctx, args) {
    const { rows } = await readSystem((db) => db.query<{ job_name: string; last_finished_at: Date | null; last_success_at: Date | null; last_failure_at: Date | null; consecutive_failures: number; last_error: string | null; last_duration_ms: number | null; runs_total: string }>(
      `select job_name, last_finished_at, last_success_at, last_failure_at, consecutive_failures, last_error, last_duration_ms, runs_total::text
         from worker_job_runs where job_name <> 'tick' and ($1::boolean = false or consecutive_failures >= 1)
        order by consecutive_failures desc, last_failure_at desc nulls last, job_name limit $2`,
      [args.failingOnly, args.limit],
    ));
    const tick = await readSystem((db) => db.query<{ last: Date | null }>("select max(last_finished_at) as last from worker_job_runs where job_name = 'tick'"));
    const tickAt = tick.rows[0]?.last ?? null;
    const failing = rows.filter((r) => r.consecutive_failures > 0);
    const card: OpsMetricsCard = {
      id: newCardId(), kind: "metrics", title: "Scheduled jobs", asOf: new Date().toISOString(), source: "Worker heartbeats (worker_job_runs table)",
      refresh: { toolId: "platform.jobs", args },
      metrics: [
        metric("Scheduler last completed", tickAt ? `${minutesBetween(tickAt, ctx.now)} min ago` : "Never recorded", undefined, tickAt ? undefined : "not_configured"),
        metric("Jobs reporting", rows.length),
        metric("Jobs failing now", failing.length, failing.length ? failing.slice(0, 3).map((r) => r.job_name).join(", ") : undefined, failing.length ? "degraded" : undefined),
      ],
      caveats: tickAt ? undefined : ["No scheduler run has ever been recorded here, so job history is empty rather than healthy."],
    };
    return {
      summary: tickAt
        ? `${plural(rows.length, "job")} reporting; ${failing.length} failing. ${failing.slice(0, 5).map((r) => `${r.job_name} failed ${r.consecutive_failures} runs in a row (last error: ${clean(r.last_error, 100) || "not recorded"})`).join("; ")}`
        : "No scheduler heartbeat has ever been recorded, so there is no job history to report.",
      data: { schedulerLastCompletedAt: iso(tickAt), jobs: rows.map((r) => ({ job: r.job_name, lastFinishedAt: iso(r.last_finished_at), lastSuccessAt: iso(r.last_success_at), consecutiveFailures: r.consecutive_failures, lastError: r.last_error, lastDurationMs: r.last_duration_ms, runsTotal: num(r.runs_total) })) },
      cards: [card],
      evidence: { label: "Scheduled job heartbeats", source: "worker_job_runs", href: "/admin/health" },
      unavailable: tickAt ? undefined : ["Scheduler: no run has ever been recorded. Configure an external scheduler for /api/internal/tick (CRON_SECRET and SCHEDULER_ENABLED) to get job history."],
    };
  },
});

export const HEALTH_TOOLS = [platformHealth, platformIncidents, platformJobs];
