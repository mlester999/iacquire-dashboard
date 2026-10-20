import "server-only";
import { z } from "zod";
import { readSystem } from "@/server/db";
import { defineReadTool } from "@/server/aqi/ops/tool";
import { clean, metric, newCardId, num, plural, usd } from "@/server/aqi/ops/tools/helpers";
import type { OpsMetricsCard, OpsTableCard } from "@/lib/aqi/ops/types";

const SUPER = ["agency_super_admin"] as const;

/**
 * AQi's own instrumentation, derived from rows it already writes: one audit row per tool run (latency, outcome) and the usage
 * events of its model calls. Nothing extra is stored for this, and nothing is estimated: a tool that has not run has no row.
 */
export const aqiTelemetry = defineReadTool({
  id: "aqi.telemetry",
  title: "AQi Operations performance and usage",
  description: "How AQi Operations' own checks are performing (runs, failures, median and 95th-percentile latency per tool), its model usage and cost, and how many actions were proposed, confirmed and failed.",
  group: "health",
  roles: SUPER,
  permission: "agency.audit.view",
  scopes: ["platform"],
  input: z.object({ days: z.number().int().min(1).max(30).default(7) }).strict(),
  idempotent: true,
  audit: { action: "aqi.ops_tool_run", sensitive: false },
  timeoutMs: 12_000,
  async run(ctx, args) {
    const since = new Date(ctx.now.getTime() - args.days * 86_400_000).toISOString();
    const [tools, usage, actions] = await Promise.all([
      readSystem((db) => db.query<{ tool: string; n: number; failures: number; denied: number; p50: string | null; p95: string | null }>(
        `select target_id as tool, count(*)::int as n, count(*) filter (where result = 'failure')::int as failures, count(*) filter (where result = 'denied')::int as denied,
                percentile_cont(0.5) within group (order by (metadata->>'durationMs')::numeric) filter (where result = 'success')::text as p50,
                percentile_cont(0.95) within group (order by (metadata->>'durationMs')::numeric) filter (where result = 'success')::text as p95
           from audit_logs where action = 'aqi.ops_tool_run' and created_at >= $1 group by target_id order by n desc limit 25`,
        [since],
      )),
      readSystem((db) => db.query<{ messages: number; failed: number; tokens_in: string; tokens_out: string; cost: string; latency: string | null; estimated: number }>(
        `select count(*) filter (where e.kind = 'message')::int as messages, count(*) filter (where e.kind = 'message' and e.status = 'failed')::int as failed,
                coalesce(sum(e.input_tokens), 0)::text as tokens_in, coalesce(sum(e.output_tokens), 0)::text as tokens_out,
                coalesce(sum(e.cost_micros), 0)::text as cost, avg(e.latency_ms) filter (where e.kind = 'message')::text as latency,
                count(*) filter (where e.cost_estimated)::int as estimated
           from aqi_usage_events e join users u on u.id = e.user_id and u.platform_role = 'agency_super_admin'
          where e.org_id is null and e.created_at >= $1 and e.kind = 'message'`,
        [since],
      )),
      readSystem((db) => db.query<{ status: string; n: number }>("select status, count(*)::int as n from aqi_ops_actions where created_at >= $1 group by status", [since])),
    ]);
    const u = usage.rows[0];
    const byStatus = Object.fromEntries(actions.rows.map((a) => [a.status, a.n])) as Record<string, number>;
    const totalRuns = tools.rows.reduce((n, t) => n + t.n, 0);
    const totalFailures = tools.rows.reduce((n, t) => n + t.failures, 0);
    const table: OpsTableCard = {
      id: newCardId(), kind: "table", title: `Tool runs, last ${args.days} days`, asOf: new Date().toISOString(), source: "Audit log: one row per AQi Operations tool run",
      refresh: { toolId: "aqi.telemetry", args }, caption: totalRuns ? `${plural(totalRuns, "run")}, ${totalFailures} failed. Latency is measured on successful runs.` : "No tool runs were recorded in this window.",
      columns: [{ key: "tool", label: "Tool" }, { key: "runs", label: "Runs", align: "right" }, { key: "failed", label: "Failed", align: "right" }, { key: "denied", label: "Denied", align: "right" }, { key: "p50", label: "Median ms", align: "right" }, { key: "p95", label: "p95 ms", align: "right" }],
      rows: tools.rows.map((t) => ({ tool: clean(t.tool, 40), runs: t.n, failed: t.failures, denied: t.denied, p50: t.p50 === null ? "—" : Math.round(num(t.p50)), p95: t.p95 === null ? "—" : Math.round(num(t.p95)) })),
    };
    const metrics: OpsMetricsCard = {
      id: newCardId(), kind: "metrics", title: "Model usage and actions", asOf: new Date().toISOString(), source: "aqi_usage_events and aqi_ops_actions", period: `Last ${args.days} days`,
      metrics: [
        metric("Model answers", u.messages, `${u.failed} failed`, u.failed ? "degraded" : undefined),
        metric("Tokens", `${num(u.tokens_in).toLocaleString("en-US")} in / ${num(u.tokens_out).toLocaleString("en-US")} out`),
        metric("Model cost", usd(u.cost), u.estimated ? `${u.estimated} answer${u.estimated === 1 ? "" : "s"} estimated from text length` : "Priced from the configured model rates"),
        metric("Average answer time", u.latency === null ? "—" : `${Math.round(num(u.latency))} ms`),
        metric("Actions proposed", Object.values(byStatus).reduce((a, b) => a + b, 0), `${byStatus.succeeded ?? 0} verified, ${byStatus.failed ?? 0} failed, ${byStatus.verification_failed ?? 0} unverified`),
      ],
      caveats: ["Cost uses the model prices configured in AQi Management; a missing price means no cost is shown, never a guess."],
    };
    return {
      summary: `Last ${args.days} days: ${plural(totalRuns, "tool run")} (${totalFailures} failed); ${u.messages} model answers costing ${usd(u.cost)}; ${Object.values(byStatus).reduce((a, b) => a + b, 0)} actions proposed (${byStatus.succeeded ?? 0} verified, ${byStatus.failed ?? 0} failed). ${tools.rows.slice(0, 3).map((t) => `${t.tool}: ${t.n} runs, median ${t.p50 === null ? "n/a" : `${Math.round(num(t.p50))} ms`}`).join("; ")}.`,
      data: {
        windowDays: args.days,
        tools: tools.rows.map((t) => ({ tool: t.tool, runs: t.n, failures: t.failures, denied: t.denied, medianMs: t.p50 === null ? null : Math.round(num(t.p50)), p95Ms: t.p95 === null ? null : Math.round(num(t.p95)) })),
        model: { answers: u.messages, failed: u.failed, inputTokens: num(u.tokens_in), outputTokens: num(u.tokens_out), costUsd: num(u.cost) / 1e6, estimatedAnswers: u.estimated },
        actions: byStatus,
      },
      cards: [metrics, table],
      evidence: { label: "AQi Operations telemetry", source: "audit_logs (aqi.ops_tool_run), aqi_usage_events, aqi_ops_actions", href: "/admin/aqi/insights" },
      unavailable: ["Hosted database latency per query is not recorded; these figures are the tools' end-to-end durations as seen by the application."],
    };
  },
});

export const TELEMETRY_TOOLS = [aqiTelemetry];
