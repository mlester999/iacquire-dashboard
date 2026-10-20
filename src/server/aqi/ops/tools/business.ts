import "server-only";
import { z } from "zod";
import { readSystem } from "@/server/db";
import { getFinancialReport } from "@/server/billing/finance";
import { defineReadTool } from "@/server/aqi/ops/tool";
import { clean, metric, newCardId, num, plural, usd } from "@/server/aqi/ops/tools/helpers";
import { PERIOD_LABEL, resolvePeriod, type PeriodKey } from "@/lib/finance";
import type { OpsChartCard, OpsMetricsCard, OpsTableCard } from "@/lib/aqi/ops/types";

const SUPER = ["agency_super_admin"] as const;
const PERIODS = Object.keys(PERIOD_LABEL) as [PeriodKey, ...PeriodKey[]];
const OPEN_PERIODS = new Set<PeriodKey>(["this_month", "last_90_days", "year_to_date", "all_time"]);

/**
 * Business figures come from the same report the Billing and finance page uses, so the copilot and
 * the page cannot disagree. Revenue here is what the platform actually records: setup, maintenance,
 * project and domain payments, prepaid credit top-ups (a liability until used) and metered usage.
 * There is no subscription model in this system, and none is assumed.
 */
export const businessSummary = defineReadTool({
  id: "business.summary",
  title: "Business summary",
  description: "Client counts, onboarding, cash received, prepaid credits, metered usage and provider cost, operating costs and a margin estimate for a reporting period, with currency, method and caveats.",
  group: "business",
  roles: SUPER,
  permission: "billing.agency_view",
  scopes: ["platform"],
  input: z.object({ period: z.enum(PERIODS).default("this_month") }).strict(),
  idempotent: true,
  audit: { action: "aqi.ops_tool_run", sensitive: true },
  timeoutMs: 25_000,
  async run(ctx, args) {
    const period = resolvePeriod(args.period, ctx.now);
    const report = await getFinancialReport(ctx.user, period);
    const { rows } = await readSystem((db) => db.query<{ active_clients: number; onboarding_clients: number; new_clients: number; activations: number; onboarding_completed: number; exits_requested: number; demo: number }>(
      `select (select count(*) from organizations where kind = 'client' and status = 'active' and not is_demo)::int as active_clients,
              (select count(*) from organizations where kind = 'client' and status in ('onboarding', 'invited'))::int as onboarding_clients,
              (select count(*) from organizations where kind = 'client' and created_at >= $1 and created_at < $2)::int as new_clients,
              (select count(*) from client_setup_instances where activated_at >= $1 and activated_at < $2)::int as activations,
              (select count(*) from organizations where kind = 'client' and onboarding_completed_at >= $1 and onboarding_completed_at < $2)::int as onboarding_completed,
              (select count(*) from offboarding_requests where requested_at >= $1 and requested_at < $2 and status <> 'cancelled')::int as exits_requested,
              (select count(*) from organizations where kind = 'client' and is_demo)::int as demo`,
      [period.from, period.to],
    ));
    const c = rows[0];
    const open = OPEN_PERIODS.has(args.period);
    const incomplete = open ? `This period is still open: figures run to ${ctx.now.toISOString().slice(0, 16).replace("T", " ")} UTC.` : null;
    const marginBase = report.usage.chargedMicros;
    const markupContribution = report.usage.grossMarkupContributionMicros;
    const metrics: OpsMetricsCard = {
      id: newCardId(), kind: "metrics", title: `Business summary: ${period.label}`, asOf: new Date().toISOString(), source: "Billing and finance report (payments, metered_usage_events, agency_finance_entries)",
      refresh: { toolId: "business.summary", args }, period: `${period.from.slice(0, 10)} to ${period.to.slice(0, 10)} (UTC), amounts in USD`,
      metrics: [
        metric("Active clients", c.active_clients, `${c.onboarding_clients} onboarding, ${c.demo} demo`), metric("New clients", c.new_clients), metric("Activations", c.activations), metric("Onboarding completed", c.onboarding_completed),
        metric("Cash received (net of refunds)", usd(report.received.netMicros), "Setup, maintenance, projects, domains, other"), metric("Credit top-ups (prepaid, not income yet)", usd(report.prepaid.topUpsMicros), `${usd(report.prepaid.heldForClientsMicros)} held for clients now`),
        metric("Usage charged to clients", usd(marginBase), `Provider cost ${usd(report.usage.providerCostMicros)}`), metric("Usage markup contribution", usd(markupContribution)),
        metric("Operating costs entered", usd(report.costs.directMicros + report.costs.overheadMicros), `Direct ${usd(report.costs.directMicros)}, overhead ${usd(report.costs.overheadMicros)}`),
        metric("Estimate before set-asides", report.distributable ? usd(report.distributable.resultBeforeSetAsidesMicros) : "Not available", report.distributable ? "A planning figure, not profit" : "Needs agency-wide access", report.distributable ? undefined : "unknown"),
      ],
      methodology: "Cash received is payments marked paid in the period, net of refunds. Usage is metered events in the period (charged versus wholesale provider cost). Operating costs are manual finance entries. The estimate before set-asides = net cash received + usage charged − provider cost − known payment fees − direct costs − overhead. Prepaid credits are excluded from income until consumed.",
      caveats: [...(incomplete ? [incomplete] : []), ...report.caveats, `Subscription revenue and retention rate cannot be computed: this platform records no subscription billing. ${c.exits_requested} offboarding request${c.exits_requested === 1 ? "" : "s"} were raised in the period.`],
    };
    const chart: OpsChartCard = {
      id: newCardId(), kind: "chart", title: "Where the money moves", asOf: new Date().toISOString(), source: "Billing and finance report", unit: "USD",
      series: [
        { label: "Cash received (net)", value: Math.round(report.received.netMicros / 10_000) / 100 }, { label: "Usage charged", value: Math.round(marginBase / 10_000) / 100 },
        { label: "Provider cost", value: Math.round(report.usage.providerCostMicros / 10_000) / 100 }, { label: "Operating costs", value: Math.round((report.costs.directMicros + report.costs.overheadMicros) / 10_000) / 100 },
      ],
      caption: "Amounts for the selected period in US dollars; prepaid top-ups are excluded.",
    };
    return {
      summary: `${period.label} (${period.from.slice(0, 10)} to ${period.to.slice(0, 10)}, USD): ${c.active_clients} active clients (${c.new_clients} new, ${c.activations} activations). Cash received net of refunds ${usd(report.received.netMicros)}; prepaid credit top-ups ${usd(report.prepaid.topUpsMicros)} (held, not income until used); usage charged ${usd(marginBase)} against provider cost ${usd(report.usage.providerCostMicros)}; operating costs entered ${usd(report.costs.directMicros + report.costs.overheadMicros)}. ${report.distributable ? `Estimate before set-asides ${usd(report.distributable.resultBeforeSetAsidesMicros)} (a planning figure).` : ""} ${incomplete ?? ""} Caveats: ${[...report.caveats].slice(0, 3).join(" ")}`,
      data: {
        period: { key: period.key, from: period.from, to: period.to, currency: "USD", open }, clients: c,
        received: report.received, prepaid: report.prepaid, usage: report.usage, fees: report.fees, costs: report.costs, estimateBeforeSetAsides: report.distributable?.resultBeforeSetAsidesMicros ?? null,
        reconciliationErrors: report.reconciliationErrors, caveats: report.caveats, incompleteReportingPeriod: incomplete,
        notModelled: "No subscription revenue, recurring plan or retention rate is stored in this system.",
      },
      cards: [metrics, chart],
      evidence: { label: `Business summary (${period.label})`, source: "Billing and finance report: payments, credit ledger, metered usage, agency finance entries, organizations", href: "/admin/billing" },
      unavailable: ["Subscription revenue and retention rate: not stored. Infrastructure costs appear only if someone entered them as finance entries."],
    };
  },
});

// ---------------------------------------------------------------------------

export const businessClientCosts = defineReadTool({
  id: "business.client_costs",
  title: "Client AI and messaging costs",
  description: "Which clients have the highest metered AI and messaging costs in a period (wholesale provider cost versus amount charged), plus AQi assistant cost and Hermes token counts.",
  group: "business",
  roles: SUPER,
  permission: "billing.agency_view",
  scopes: ["platform", "tenant"],
  input: z.object({ period: z.enum(PERIODS).default("this_month"), limit: z.number().int().min(1).max(15).default(8) }).strict(),
  idempotent: true,
  audit: { action: "aqi.ops_tool_run", sensitive: true },
  timeoutMs: 15_000,
  async run(ctx, args) {
    const period = resolvePeriod(args.period, ctx.now);
    const orgId = ctx.scope.orgId;
    if (orgId) await ctx.authorizeOrg(orgId, "business.client_costs");
    const { rows } = await readSystem((db) => db.query<{
      id: string; name: string; ai_cost: string; ai_billed: string; msg_cost: string; msg_billed: string; other_cost: string; charged: string; uncollected: string; tokens: string | null; aqi_cost: string;
    }>(
      `select o.id, o.name,
              coalesce(sum(m.wholesale_micros) filter (where m.unit_type in ('ai_tokens_in', 'ai_tokens_out', 'ai_research_call')), 0)::text as ai_cost,
              coalesce(sum(m.client_micros) filter (where m.unit_type in ('ai_tokens_in', 'ai_tokens_out', 'ai_research_call')), 0)::text as ai_billed,
              coalesce(sum(m.wholesale_micros) filter (where m.unit_type in ('sms_segment', 'whatsapp_message', 'email_send')), 0)::text as msg_cost,
              coalesce(sum(m.client_micros) filter (where m.unit_type in ('sms_segment', 'whatsapp_message', 'email_send')), 0)::text as msg_billed,
              coalesce(sum(m.wholesale_micros) filter (where m.unit_type not in ('ai_tokens_in', 'ai_tokens_out', 'ai_research_call', 'sms_segment', 'whatsapp_message', 'email_send')), 0)::text as other_cost,
              coalesce(sum(m.charged_micros), 0)::text as charged, coalesce(sum(m.uncollected_micros), 0)::text as uncollected,
              (select sum(r.total_tokens)::text from agent_runs r where r.org_id = o.id and r.started_at >= $1 and r.started_at < $2) as tokens,
              coalesce((select sum(e.cost_micros) from aqi_usage_events e where e.org_id = o.id and e.status in ('recorded', 'failed') and e.created_at >= $1 and e.created_at < $2), 0)::text as aqi_cost
         from organizations o join metered_usage_events m on m.org_id = o.id and m.occurred_at >= $1 and m.occurred_at < $2
        where o.kind = 'client' and app.user_can_access_org($3, o.id) and ($4::uuid is null or o.id = $4)
        group by o.id, o.name
        order by sum(m.wholesale_micros) filter (where m.unit_type in ('ai_tokens_in', 'ai_tokens_out', 'ai_research_call')) desc nulls last, sum(m.wholesale_micros) desc
        limit $5`,
      [period.from, period.to, ctx.user.id, orgId, args.limit],
    ));
    const table: OpsTableCard = {
      id: newCardId(), kind: "table", title: `Highest AI and messaging cost: ${period.label}`, asOf: new Date().toISOString(), source: "Metered usage (metered_usage_events), Hermes runs, AQi usage events",
      refresh: { toolId: "business.client_costs", args }, caption: `Wholesale provider cost in USD, with what was billed to the client. ${OPEN_PERIODS.has(args.period) ? "The period is still open." : ""}`.trim(),
      columns: [{ key: "client", label: "Client" }, { key: "ai", label: "AI cost", align: "right" }, { key: "aiBilled", label: "AI billed", align: "right" }, { key: "msg", label: "Messaging cost", align: "right" }, { key: "uncollected", label: "Uncollected", align: "right" }, { key: "tokens", label: "Hermes tokens", align: "right" }],
      rows: rows.map((r) => ({ client: clean(r.name, 50), ai: usd(r.ai_cost), aiBilled: usd(r.ai_billed), msg: usd(r.msg_cost), uncollected: usd(r.uncollected), tokens: r.tokens ? num(r.tokens).toLocaleString("en-US") : "—", _href: `/admin/clients/${r.id}` })),
    };
    const top = rows[0];
    return {
      summary: rows.length ? `${period.label} (USD, wholesale provider cost): ${plural(rows.length, "client")} have metered usage. Highest AI cost: ${rows.slice(0, 3).map((r) => `${clean(r.name, 40)} ${usd(r.ai_cost)} (billed ${usd(r.ai_billed)})`).join("; ")}.${top && num(top.uncollected) > 0 ? ` ${clean(top.name, 40)} has ${usd(top.uncollected)} uncollected.` : ""}` : `No metered usage was recorded in ${period.label}.`,
      data: { period: { from: period.from, to: period.to, currency: "USD", open: OPEN_PERIODS.has(args.period) }, clients: rows.map((r) => ({ client: r.name, aiCostUsd: num(r.ai_cost) / 1e6, aiBilledUsd: num(r.ai_billed) / 1e6, messagingCostUsd: num(r.msg_cost) / 1e6, otherCostUsd: num(r.other_cost) / 1e6, chargedUsd: num(r.charged) / 1e6, uncollectedUsd: num(r.uncollected) / 1e6, hermesTokens: r.tokens ? num(r.tokens) : null, aqiAssistantCostUsd: num(r.aqi_cost) / 1e6 })), method: "Sum of wholesale_micros per client by unit type over metered_usage_events in the period." },
      cards: [table],
      evidence: { label: `Client AI and messaging costs (${period.label})`, source: "metered_usage_events, agent_runs, aqi_usage_events", href: "/admin/usage" },
      unavailable: ["Voice call minutes are not a metered unit in this system, so telephony call cost is unavailable; SMS and WhatsApp segments are included under messaging.", "Hermes token counts are as reported by runs; AQi does not estimate vendor cost from them."],
    };
  },
});

export const BUSINESS_TOOLS = [businessSummary, businessClientCosts];
