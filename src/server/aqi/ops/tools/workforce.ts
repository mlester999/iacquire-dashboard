import "server-only";
import { z } from "zod";
import { readSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { defineReadTool } from "@/server/aqi/ops/tool";
import { ageHours, clean, iso, metric, minutesBetween, newCardId, plural } from "@/server/aqi/ops/tools/helpers";
import { AGENT_ROLE_KEYS } from "@/lib/agents";
import {
  OPS_EMPLOYEE_STATE_LABEL,
  type OpsEmployeeRow,
  type OpsEmployeesCard,
  type OpsEmployeeState,
  type OpsMetricsCard,
  type OpsTableCard,
  type OpsTimelineCard,
} from "@/lib/aqi/ops/types";

const SUPER = ["agency_super_admin"] as const;

/** A run recorded as `running` this long ago without finishing is a stale record, not evidence of work. */
export const STALE_RUN_MINUTES = 30;
/** How long a last health check stays good evidence for "idle". */
export const HEALTH_FRESH_HOURS = 24;
/** A failure only defines the state while it is the latest outcome and this recent. */
export const FAILURE_WINDOW_HOURS = 72;

export interface EmployeeEvidence {
  enabled: boolean;
  status: string;
  mode: string;
  lastHealthOk: boolean | null;
  lastHealthCheckAt: Date | string | null;
  lastHealthDetail?: string | null;
  runningSince: Date | string | null;
  queuedRuns: number;
  pendingApprovals: number;
  oldestPendingAt: Date | string | null;
  blockedApprovals: number;
  latestOutcome: { status: string; at: Date | string | null } | null;
  lastSuccessAt: Date | string | null;
  agencyPause: boolean;
  orgSuspended: boolean;
}

/**
 * Maps recorded evidence to the trustworthy status vocabulary. Precedence is explicit and tested:
 * an execution that is actually running wins; then a verified condition that stops progress; then
 * waiting/queued work; then the latest real outcome; and `idle` is only claimed with a fresh,
 * successful health check and nothing in flight. `scheduled` is never produced: Hermes schedules
 * are not exposed by the verified Hermes API and there is no schedule table, so a future job
 * cannot be shown without inventing it.
 */
export function deriveEmployeeState(e: EmployeeEvidence, now: Date): { state: OpsEmployeeState; evidence: string } {
  const since = (d: Date | string | null | undefined) => minutesBetween(d, now);
  const running = since(e.runningSince);
  if (e.enabled && running !== null && running <= STALE_RUN_MINUTES) {
    return { state: "working", evidence: `A run has been executing for ${running} minute${running === 1 ? "" : "s"}.` };
  }
  const staleRun = running !== null && running > STALE_RUN_MINUTES ? ` A run recorded as running for ${Math.round(running / 60)} hours never reported completion (stale record).` : "";
  if (!e.enabled || e.status === "disabled") return { state: "blocked", evidence: `Disabled for this workspace.${staleRun}` };
  if (e.status === "setup_required" || e.status === "provisioning") {
    return { state: "setup_required", evidence: e.status === "provisioning" ? "Provisioning has not finished." : "No Hermes profile is connected yet." };
  }
  if (e.status === "offline" || e.status === "error" || e.lastHealthOk === false) {
    const checked = since(e.lastHealthCheckAt);
    return { state: "offline", evidence: `The last health check ${checked === null ? "has no timestamp" : `${Math.round(checked / 60)} h ago`} reported ${e.status === "error" ? "an error" : "it unreachable"}${e.lastHealthDetail ? `: ${clean(e.lastHealthDetail, 140)}` : "."}${staleRun}` };
  }
  if (e.orgSuspended) return { state: "blocked", evidence: `The workspace is suspended.${staleRun}` };
  if (e.agencyPause) return { state: "blocked", evidence: `The agency emergency pause is active for this workspace.${staleRun}` };
  if (e.mode === "paused") return { state: "blocked", evidence: `The employee's operating mode is paused.${staleRun}` };
  if (e.blockedApprovals > 0) return { state: "blocked", evidence: `${plural(e.blockedApprovals, "approved action")} could not execute and ${e.blockedApprovals === 1 ? "is" : "are"} marked blocked.` };
  if (e.pendingApprovals > 0) {
    const waited = ageHours(e.oldestPendingAt, now);
    return { state: "waiting_for_approval", evidence: `${plural(e.pendingApprovals, "approval")} outstanding; the oldest has waited ${waited} hour${waited === 1 ? "" : "s"}.` };
  }
  if (e.queuedRuns > 0) return { state: "queued", evidence: `${plural(e.queuedRuns, "run")} waiting to start.` };
  const outcome = e.latestOutcome;
  if (outcome && ["failed", "timeout", "interrupted"].includes(outcome.status) && ageHours(outcome.at, now) <= FAILURE_WINDOW_HOURS) {
    return { state: "failed", evidence: `The latest run ${outcome.status === "timeout" ? "timed out" : outcome.status} ${ageHours(outcome.at, now)} hours ago${e.lastSuccessAt ? `; the last success was ${ageHours(e.lastSuccessAt, now)} hours ago` : "; no successful run is recorded"}.` };
  }
  const checked = e.lastHealthCheckAt ? ageHours(e.lastHealthCheckAt, now) : null;
  if (e.lastHealthOk === true && checked !== null && checked <= HEALTH_FRESH_HOURS) {
    return { state: "idle", evidence: `Nothing is running or waiting. The last health check ${checked} hour${checked === 1 ? "" : "s"} ago succeeded.` };
  }
  return { state: "unknown", evidence: checked === null ? "No health check has been recorded, so there is not enough evidence to say." : `The last health check was ${checked} hours ago, which is too old to confirm.` };
}

const SEVERITY: OpsEmployeeState[] = ["failed", "offline", "blocked", "waiting_for_approval", "setup_required", "working", "queued", "unknown", "scheduled", "idle"];

interface AgentDbRow {
  id: string; org_id: string; org: string; org_status: string; display_name: string; role_key: string; status: string; mode: string; enabled: boolean;
  last_health_ok: boolean | null; last_health_check_at: Date | null; last_health_detail: string | null;
  running_since: Date | null; queued: number; pending: number; oldest_pending: Date | null; blocked_approvals: number;
  outcome_status: string | null; outcome_at: Date | null; last_success_at: Date | null; agency_pause: boolean | null; total: string;
}

export const workforceStatus = defineReadTool({
  id: "workforce.status",
  title: "AI Employee status",
  description: "Evidence-based status of Hermes AI Employees (working, queued, waiting for approval, blocked, idle, offline, setup required, failed or unknown) for the platform, a client or one employee.",
  group: "workforce",
  roles: SUPER,
  permission: "agency.workforce.view",
  scopes: ["platform", "tenant", "employee", "workflow", "ticket"],
  input: z.object({ limit: z.number().int().min(1).max(20).default(12), role: z.enum(AGENT_ROLE_KEYS).optional() }).strict(),
  idempotent: true,
  audit: { action: "aqi.ops_tool_run", sensitive: false },
  timeoutMs: 12_000,
  async run(ctx, args) {
    const orgId = ctx.scope.type === "platform" ? null : ctx.scope.orgId;
    const agentId = ctx.scope.type === "employee" ? ctx.scope.id : null;
    if (orgId) await ctx.authorizeOrg(orgId, "workforce.status");
    const { rows } = await readSystem((db) => db.query<AgentDbRow>(
      `select a.id, a.org_id, o.name as org, o.status as org_status, a.display_name, a.role_key, a.status, a.mode, a.enabled,
              a.last_health_ok, a.last_health_check_at, a.last_health_detail,
              r.running_since, coalesce(r.queued, 0)::int as queued,
              coalesce(ap.pending, 0)::int as pending, ap.oldest_pending, coalesce(ap.blocked, 0)::int as blocked_approvals,
              r.outcome_status, r.outcome_at, r.last_success_at,
              (select p.active from automation_pauses p where p.org_id = a.org_id and p.scope = 'agency') as agency_pause,
              count(*) over ()::text as total
         from agent_instances a
         join organizations o on o.id = a.org_id
         left join lateral (select
              (select min(x.started_at) from agent_runs x where x.agent_instance_id = a.id and x.status = 'running' and x.purpose <> 'health_check') as running_since,
              (select count(*) from agent_runs x where x.agent_instance_id = a.id and x.status = 'queued' and x.purpose <> 'health_check') as queued,
              (select x.status from agent_runs x where x.agent_instance_id = a.id and x.purpose <> 'health_check' and x.status not in ('queued', 'running') order by x.started_at desc limit 1) as outcome_status,
              (select coalesce(x.finished_at, x.started_at) from agent_runs x where x.agent_instance_id = a.id and x.purpose <> 'health_check' and x.status not in ('queued', 'running') order by x.started_at desc limit 1) as outcome_at,
              (select max(coalesce(x.finished_at, x.started_at)) from agent_runs x where x.agent_instance_id = a.id and x.purpose <> 'health_check' and x.status = 'completed') as last_success_at
           ) r on true
         left join lateral (select
              count(*) filter (where q.status = 'pending') as pending,
              min(q.created_at) filter (where q.status = 'pending') as oldest_pending,
              count(*) filter (where q.status = 'approved' and q.execution_status = 'blocked') as blocked
            from approval_requests q where q.agent_instance_id = a.id and (q.status = 'pending' or (q.status = 'approved' and q.execution_status = 'blocked'))) ap on true
        where o.status <> 'archived' and ($1::uuid is null or a.org_id = $1) and ($2::uuid is null or a.id = $2)
          and app.user_can_access_org($3, a.org_id) and ($4::text is null or a.role_key = $4)
        order by o.name, a.role_key
        limit 400`,
      [orgId, agentId, ctx.user.id, args.role ?? null],
    ));
    const derived: Array<{ row: AgentDbRow; state: OpsEmployeeState; evidence: string }> = rows.map((row) => {
      const d = deriveEmployeeState({
        enabled: row.enabled, status: row.status, mode: row.mode, lastHealthOk: row.last_health_ok, lastHealthCheckAt: row.last_health_check_at, lastHealthDetail: row.last_health_detail,
        runningSince: row.running_since, queuedRuns: row.queued, pendingApprovals: row.pending, oldestPendingAt: row.oldest_pending, blockedApprovals: row.blocked_approvals,
        latestOutcome: row.outcome_status ? { status: row.outcome_status, at: row.outcome_at } : null, lastSuccessAt: row.last_success_at,
        agencyPause: row.agency_pause === true, orgSuspended: row.org_status === "suspended",
      }, ctx.now);
      return { row, ...d };
    });
    const counts: Partial<Record<OpsEmployeeState, number>> = {};
    for (const d of derived) counts[d.state] = (counts[d.state] ?? 0) + 1;
    const ranked = [...derived].sort((a, b) => SEVERITY.indexOf(a.state) - SEVERITY.indexOf(b.state));
    const shown = ranked.slice(0, args.limit);
    const mapRow = (d: (typeof derived)[number]): OpsEmployeeRow => ({
      id: d.row.id, name: clean(d.row.display_name, 40), role: d.row.role_key.replace(/_/g, " "), org: clean(d.row.org, 60), orgId: d.row.org_id, state: d.state, evidence: d.evidence,
      lastRunAt: iso(d.row.outcome_at), lastSuccessAt: iso(d.row.last_success_at), href: `/admin/clients/${d.row.org_id}/provisioning`,
    });
    const notes = [
      "Scheduled work is not reported: the verified Hermes API exposes no schedule or cron inventory and this platform stores none, so a future job cannot be shown without inventing it.",
      "Idle means nothing is running or waiting and a recent health check succeeded. It does not mean the employee is working continuously.",
    ];
    const card: OpsEmployeesCard = {
      id: newCardId(), kind: "employees", title: agentId ? "AI Employee" : orgId ? "AI Employees for this client" : "AI Employees across clients", asOf: new Date().toISOString(),
      source: "agent_instances, agent_runs, approval_requests, automation_pauses", refresh: { toolId: "workforce.status", args }, counts, rows: shown.map(mapRow), truncated: derived.length > shown.length, notes,
    };
    const countText = SEVERITY.filter((s) => counts[s]).map((s) => `${counts[s]} ${OPS_EMPLOYEE_STATE_LABEL[s].toLowerCase()}`).join(", ");
    return {
      summary: derived.length ? `${plural(derived.length, "AI Employee")}: ${countText}. ${shown.filter((d) => !["idle"].includes(d.state)).slice(0, 5).map((d) => `${clean(d.row.display_name, 30)} (${clean(d.row.org, 40)}) is ${OPS_EMPLOYEE_STATE_LABEL[d.state].toLowerCase()}: ${d.evidence}`).join(" ")}` : "No AI Employees matched.",
      data: { total: derived.length, counts, employees: shown.map((d) => ({ id: d.row.id, name: d.row.display_name, role: d.row.role_key, client: d.row.org, state: d.state, evidence: d.evidence, mode: d.row.mode, lastRunOutcome: d.row.outcome_status, lastRunAt: iso(d.row.outcome_at), lastSuccessAt: iso(d.row.last_success_at) })), notes },
      cards: [card],
      evidence: { label: "AI Employee status", source: "Hermes workforce records (agent_instances, agent_runs, approval_requests, automation_pauses)", href: "/admin/employees/clients" },
      unavailable: [notes[0]],
    };
  },
});

// ---------------------------------------------------------------------------

export const workforceRuns = defineReadTool({
  id: "workforce.runs",
  title: "Recent AI Employee runs",
  description: "The latest runs of one AI Employee or of a client's employees, with outcome, error class, tools used and duration.",
  group: "workforce",
  roles: SUPER,
  permission: "agency.workforce.view",
  scopes: ["tenant", "employee", "workflow", "ticket"],
  input: z.object({ limit: z.number().int().min(1).max(12).default(8) }).strict(),
  idempotent: true,
  audit: { action: "aqi.ops_tool_run", sensitive: false },
  timeoutMs: 10_000,
  async run(ctx, args) {
    const orgId = ctx.scope.orgId;
    if (!orgId) throw new AppError("invalid_input", "Select a client or an AI Employee first.");
    await ctx.authorizeOrg(orgId, "workforce.runs");
    const agentId = ctx.scope.type === "employee" ? ctx.scope.id : null;
    const { rows } = await readSystem((db) => db.query<{
      id: string; status: string; purpose: string; error_code: string | null; error_message: string | null; started_at: Date; finished_at: Date | null;
      total_tokens: number | null; display_name: string; role_key: string; tools: Array<{ tool: string; status: string; ms: number | null }>;
    }>(
      `select r.id, r.status, r.purpose, r.error_code, r.error_message, r.started_at, r.finished_at, r.total_tokens, a.display_name, a.role_key,
              coalesce((select json_agg(json_build_object('tool', t.tool_name, 'status', t.status, 'ms', t.duration_ms) order by t.started_at)
                          from (select * from tool_executions x where x.run_id = r.id order by x.started_at limit 6) t), '[]'::json) as tools
         from agent_runs r join agent_instances a on a.id = r.agent_instance_id
        where r.org_id = $1 and ($2::uuid is null or r.agent_instance_id = $2) and r.purpose <> 'health_check'
        order by r.started_at desc limit $3`,
      [orgId, agentId, args.limit],
    ));
    const lastSuccess = rows.find((r) => r.status === "completed");
    const failures = rows.filter((r) => ["failed", "timeout", "interrupted"].includes(r.status));
    const card: OpsTimelineCard = {
      id: newCardId(), kind: "timeline", title: agentId ? "Recent runs" : "Recent runs for this client", asOf: new Date().toISOString(), source: "AI runs and tool executions (agent_runs, tool_executions)",
      refresh: { toolId: "workforce.runs", args },
      verdict: rows.length
        ? `${rows.length} most recent run${rows.length === 1 ? "" : "s"}: ${failures.length} failed${lastSuccess ? `, last success ${ageHours(lastSuccess.started_at, ctx.now)} hours ago` : ", none succeeded"}.`
        : "No runs are recorded.",
      events: rows.slice().reverse().map((r) => ({
        at: iso(r.started_at)!,
        label: `${clean(r.display_name, 30)} · ${r.purpose.replace("_", " ")} · ${r.status}`,
        detail: [r.error_code ? `error ${clean(r.error_code, 40)}` : null, r.error_message ? clean(r.error_message, 160) : null, r.tools.length ? `tools: ${r.tools.map((t) => `${clean(t.tool, 30)} ${t.status}`).join(", ")}` : null].filter(Boolean).join(" · ") || undefined,
        tone: r.status === "completed" ? "success" : ["failed", "timeout", "interrupted"].includes(r.status) ? "danger" : r.status === "running" || r.status === "queued" ? "warning" : "neutral",
      })),
    };
    return {
      summary: rows.length ? `${card.verdict} ${failures.slice(0, 3).map((r) => `${clean(r.display_name, 30)} ${r.status} at ${iso(r.started_at)}: ${clean(r.error_message ?? r.error_code, 140) || "no error detail recorded"}`).join("; ")}` : "No runs are recorded for this selection.",
      data: { runs: rows.map((r) => ({ id: r.id, employee: r.display_name, role: r.role_key, purpose: r.purpose, status: r.status, errorCode: r.error_code, errorMessage: r.error_message, startedAt: iso(r.started_at), finishedAt: iso(r.finished_at), tokens: r.total_tokens, tools: r.tools })) },
      cards: [card],
      evidence: { label: "Recent AI Employee runs", source: "agent_runs and tool_executions", href: `/admin/clients/${orgId}/provisioning` },
      unavailable: ["Run transcripts and message content are not read. Only run outcome, error class, tool names and timings are available."],
    };
  },
});

// ---------------------------------------------------------------------------

export const workforceApprovals = defineReadTool({
  id: "workforce.approvals",
  title: "Pending approvals",
  description: "Approval requests raised by AI Employees that are still waiting for the client's decision, oldest first.",
  group: "workforce",
  roles: SUPER,
  permission: "agency.workforce.view",
  scopes: ["platform", "tenant", "employee", "workflow", "ticket"],
  input: z.object({ limit: z.number().int().min(1).max(15).default(10) }).strict(),
  idempotent: true,
  audit: { action: "aqi.ops_tool_run", sensitive: false },
  timeoutMs: 8_000,
  async run(ctx, args) {
    const orgId = ctx.scope.type === "platform" ? null : ctx.scope.orgId;
    if (orgId) await ctx.authorizeOrg(orgId, "workforce.approvals");
    const { rows } = await readSystem((db) => db.query<{ id: string; kind: string; title: string; risk: string; created_at: Date; expires_at: Date | null; org: string; org_id: string; employee: string | null; total: string; high: string }>(
      `select q.id, q.kind, q.title, q.risk, q.created_at, q.expires_at, o.name as org, q.org_id, a.display_name as employee,
              count(*) over ()::text as total, (count(*) filter (where q.risk in ('high', 'critical')) over ())::text as high
         from approval_requests q join organizations o on o.id = q.org_id left join agent_instances a on a.id = q.agent_instance_id
        where q.status = 'pending' and ($1::uuid is null or q.org_id = $1) and app.user_can_access_org($2, q.org_id)
        order by q.created_at limit $3`,
      [orgId, ctx.user.id, args.limit],
    ));
    const total = rows[0] ? Number(rows[0].total) : 0;
    const table: OpsTableCard = {
      id: newCardId(), kind: "table", title: "Approvals waiting for a decision", asOf: new Date().toISOString(), source: "Approval queue (approval_requests)", refresh: { toolId: "workforce.approvals", args },
      caption: total ? `${rows.length} of ${total}, oldest first. The client's owners and managers decide these; AQi can only report them.` : undefined, truncated: total > rows.length,
      columns: [{ key: "client", label: "Client" }, { key: "employee", label: "Employee" }, { key: "request", label: "Request" }, { key: "risk", label: "Risk" }, { key: "waiting", label: "Waiting", align: "right" }],
      rows: rows.map((r) => ({ client: clean(r.org, 50), employee: clean(r.employee, 30) || "—", request: `${r.kind.replace(/_/g, " ")}: ${clean(r.title, 70)}`, risk: r.risk, waiting: `${ageHours(r.created_at, ctx.now)} h`, _href: `/admin/clients/${r.org_id}` })),
    };
    const metrics: OpsMetricsCard = {
      id: newCardId(), kind: "metrics", title: "Approval queue", asOf: new Date().toISOString(), source: "Approval queue (approval_requests)",
      metrics: [metric("Pending", total), metric("High or critical risk", rows[0] ? Number(rows[0].high) : 0, undefined, rows[0] && Number(rows[0].high) ? "degraded" : undefined)],
    };
    return {
      summary: total ? `${plural(total, "approval")} pending${rows[0] ? `; the oldest (${clean(rows[0].org, 40)}, ${rows[0].kind.replace(/_/g, " ")}) has waited ${ageHours(rows[0].created_at, ctx.now)} hours` : ""}.` : "No approvals are waiting.",
      data: { total, approvals: rows.map((r) => ({ client: r.org, employee: r.employee, kind: r.kind, title: r.title, risk: r.risk, waitingHours: ageHours(r.created_at, ctx.now), expiresAt: iso(r.expires_at) })) },
      cards: [metrics, table],
      evidence: { label: "Pending approvals", source: "approval_requests", href: "/admin/employees/clients" },
    };
  },
});

export const WORKFORCE_TOOLS = [workforceStatus, workforceRuns, workforceApprovals];
