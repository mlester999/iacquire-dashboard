"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, Ban, BarChart3, CheckCircle2, Download, Info, Sparkles, XCircle } from "lucide-react";
import { AgentAvatar } from "@/components/brand";
import { AreaChart, Columns, HBarList, StatusSplit } from "@/components/charts";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Input } from "@/components/ui/primitives";
import { Segmented, Tooltip } from "@/components/ui/overlays";
import { PageHero, CoverageBar } from "@/components/ui/workspace";
import { AGENT_BY_KEY, AGENT_ROLES } from "@/lib/agents";
import { formatCurrency, formatNumber, formatPercent, timeZoneLabel } from "@/lib/utils";

interface Data {
  /** `native`: which numbers come from iAcquire's own CRM (its calendars and deals) rather than a connected GoHighLevel location. */
  sources: { crm: boolean; calendar: boolean; native?: { opportunities: boolean; appointments: boolean } };
  leads: {
    totals: { total: number; approved: number; rejected: number; reviewed: number; avg_score: string | null; with_sources: number };
    bySource: Array<{ source: string; total: number; approved: number; avg_score: string | null }>;
  };
  appointments: { booked: number; showed: number; noshow: number; cancelled: number } | null;
  sales: { stages: Array<{ stage: string; n: number; value: string | null }>; won: number; lost: number; wonValue: number; wonValues?: Array<{ currency: string; value: number }> } | null;
  workforce: { byAgent: Array<{ role_key: string; total: number; completed: number; failed: number; tokens: number }>; toolSteps: number; cancelled: number };
  execution: { succeeded: number; blocked: number; failed: number; rejected: number; expired: number };
  usage: { messages: number; tokens: number; research: number; help: number };
  retention: { total: number; active: number; at_risk: number; churned: number };
}

function Metric({ label, value, definition }: { label: string; value: React.ReactNode; definition: string }) {
  return (
    <div className="rounded-xl bg-surface-2/70 p-3.5">
      <p className="flex items-center gap-1.5 text-[12px] text-muted">
        {label}
        <Tooltip content={definition}>
          <button type="button" aria-label={`About ${label}`} className="text-faint hover:text-muted">
            <Info className="size-3" />
          </button>
        </Tooltip>
      </p>
      <p className="mt-1 text-[22px] font-semibold tracking-tight">{value}</p>
    </div>
  );
}

function AskAnalyst({ prompt, canChat }: { prompt: string; canChat: boolean }) {
  if (!canChat) return null;
  return (
    <Link href={`/chat/performance-analyst?q=${encodeURIComponent(prompt)}`} className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12.5px] font-medium text-primary transition hover:bg-primary-soft">
      <Sparkles className="size-3.5" /> Ask Performance Analyst
    </Link>
  );
}

function Unavailable({ what }: { what: string }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-dashed border-line p-4 text-[13px] text-muted">
      <Info className="mt-0.5 size-4 shrink-0" />
      <span>
        {what} is unavailable until iAcquire connects the source. We never estimate missing data. <Link href="/settings/integrations" className="text-primary hover:underline">Integration status</Link>
      </span>
    </div>
  );
}

// Day keys arrive already bucketed in the workspace timezone (YYYY-MM-DD), so format them as plain dates.
const dayFmt = () => {
  const f = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return (x: string) => f.format(new Date(`${x}T12:00:00Z`));
};

export function AnalyticsView({
  data,
  leadsByDay,
  messagesByDay,
  range,
  timeZone,
  canExport,
  canChat,
}: {
  data: Data;
  leadsByDay: Array<{ day: string; n: number }>;
  messagesByDay: Array<{ day: string; n: number }>;
  range: { key: string; from: string; to: string; days: number };
  timeZone: string;
  canExport: boolean;
  canChat: boolean;
}) {
  const router = useRouter();
  const [from, setFrom] = React.useState(range.from.slice(0, 10));
  const [to, setTo] = React.useState(range.to.slice(0, 10));
  const lt = data.leads.totals;
  const qualRate = lt.reviewed ? lt.approved / lt.reviewed : null;
  const sourcedRate = lt.total ? lt.with_sources / lt.total : null;
  const fmt = dayFmt();
  const runsTotal = data.workforce.byAgent.reduce((s, a) => s + a.total, 0);
  const completed = data.workforce.byAgent.reduce((s, a) => s + a.completed, 0);
  const failed = data.workforce.byAgent.reduce((s, a) => s + a.failed, 0);
  const query = range.key === "custom" ? `range=custom&from=${from}&to=${to}` : `range=${range.key}`;
  const nativeDeals = Boolean(data.sources.native?.opportunities);
  const nativeCalendar = Boolean(data.sources.native?.appointments);
  const calendarWord = nativeCalendar ? "on your iAcquire CRM calendars" : "in your calendar";
  const crmWord = nativeDeals ? "Deals marked {s} in your iAcquire CRM during this period." : "Opportunities marked {s} in your CRM during this period.";

  return (
    <div className="module-stack space-y-6">
      <PageHero eyebrow="Performance intelligence" title="Turn recorded results into your next decision." description={`Lead research, team execution and customer relationships over ${range.days} days. Days are grouped in ${timeZoneLabel(timeZone)}; missing provider data stays unavailable.`} icon={<BarChart3 />} tone="neutral" aside={<div className="rounded-2xl border border-line bg-surface-2 p-5"><p className="text-xs font-semibold text-ink">AI employee execution</p><p className="mt-2 text-3xl font-semibold tracking-tight">{runsTotal}<span className="ml-2 text-xs font-normal text-muted">recorded runs</span></p><div className="mt-3"><CoverageBar label="Recorded run outcomes" parts={[{label:"Completed",count:completed,color:"var(--success)"},{label:"Failed",count:failed,color:"var(--danger)"},{label:"Other",count:Math.max(0,runsTotal-completed-failed),color:"var(--primary)"}]} /></div></div>} />
      <div data-aqi-target="analytics.range" className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <h2 className="text-[17px] font-semibold tracking-tight">Reporting window</h2>
          <p className="mt-1 text-[12px] text-muted">Choose a period or export the underlying records.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            id="range"
            ariaLabel="Date range"
            size="sm"
            value={range.key}
            onChange={(v) => (v === "custom" ? router.push(`/analytics?range=custom&from=${from}&to=${to}`) : router.push(`/analytics?range=${v}`))}
            options={[
              { value: "7d", label: "7 days" },
              { value: "30d", label: "30 days" },
              { value: "90d", label: "90 days" },
              { value: "custom", label: "Custom" },
            ]}
          />
          {range.key === "custom" && (
            <form
              className="flex flex-wrap items-center gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                router.push(`/analytics?range=custom&from=${from}&to=${to}`);
              }}
            >
              <label htmlFor="from" className="sr-only">
                From
              </label>
              <Input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 w-36 text-[13px]" />
              <span className="text-muted">–</span>
              <label htmlFor="to" className="sr-only">
                To
              </label>
              <Input id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 w-36 text-[13px]" />
              <button type="submit" className="h-8 rounded-lg bg-ink px-3 text-[12.5px] font-medium text-surface">
                Apply
              </button>
            </form>
          )}
          {canExport && (
            <ButtonLink href={`/api/analytics/export?${query}`} variant="secondary" size="sm" prefetch={false}>
              <Download className="size-3.5" /> Export
            </ButtonLink>
          )}
        </div>
      </div>

      <Card data-aqi-target="analytics.report">
        <CardHeader>
          <div>
            <CardTitle>Lead generation &amp; research quality</CardTitle>
            <CardDescription>Leads researched into your review queue over {range.days} days.</CardDescription>
          </div>
          <AskAnalyst canChat={canChat} prompt={`Review my lead generation results for the last ${range.days} days: ${lt.total} researched, ${lt.approved} approved, ${lt.rejected} rejected. What should I change in my targeting?`} />
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Metric label="Leads researched" value={formatNumber(lt.total)} definition="Businesses added to your review queue by research in this period." />
            <Metric label="Qualification rate" value={formatPercent(qualRate)} definition="Approved ÷ reviewed (approved + rejected). Pending leads are excluded." />
            <Metric label="Average score" value={lt.avg_score ?? "—"} definition="Mean research-priority score (0–100) from cited evidence." />
            <Metric label="Well-sourced" value={formatPercent(sourcedRate)} definition="Share of leads with two or more cited sources." />
          </div>
          {lt.total > 0 ? (
            <Columns data={leadsByDay.map((d) => ({ x: fmt(d.day), y: d.n }))} unit="leads" label="Leads researched per day" />
          ) : (
            <p className="rounded-xl border border-dashed border-line p-6 text-center text-[13px] text-muted">No leads were researched in this period.</p>
          )}
          {data.leads.bySource.length > 0 && (
            <div className="scrollbar-thin overflow-x-auto">
              <table className="w-full min-w-[420px] text-[13px]">
                <caption className="pb-2 text-left text-[12.5px] font-semibold text-ink">Lead source performance</caption>
                <thead className="text-left text-[12px] text-muted">
                  <tr className="border-b border-line">
                    <th className="py-2 font-medium">Source</th>
                    <th className="py-2 text-right font-medium">Leads</th>
                    <th className="py-2 text-right font-medium">Approved</th>
                    <th className="py-2 text-right font-medium">Avg score</th>
                  </tr>
                </thead>
                <tbody>
                  {data.leads.bySource.map((s) => (
                    <tr key={s.source} className="border-b border-line">
                      <td className="py-2">{s.source === "lead_hunter" ? "AI Lead Hunter" : s.source.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())}</td>
                      <td className="py-2 text-right tabular-nums">{s.total}</td>
                      <td className="py-2 text-right tabular-nums">{s.approved}</td>
                      <td className="py-2 text-right tabular-nums">{s.avg_score ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Appointment conversion</CardTitle>
              <CardDescription>Meetings scheduled in this period.</CardDescription>
            </div>
            {data.appointments && <AskAnalyst canChat={canChat} prompt={`My appointments: ${data.appointments.booked} booked, ${data.appointments.showed} showed, ${data.appointments.noshow} no-shows, ${data.appointments.cancelled} cancelled. How can I improve my show-up rate?`} />}
          </CardHeader>
          <CardContent>
            {data.appointments ? (
              <div className="grid grid-cols-2 gap-3">
                <Metric label="Booked" value={formatNumber(data.appointments.booked)} definition="Appointments with status new, confirmed, showed or no-show." />
                <Metric label="Show rate" value={formatPercent(data.appointments.showed + data.appointments.noshow ? data.appointments.showed / (data.appointments.showed + data.appointments.noshow) : null)} definition="Showed ÷ (showed + no-show). Upcoming meetings are excluded." />
                <Metric label="No-shows" value={formatNumber(data.appointments.noshow)} definition={`Appointments marked no-show ${calendarWord}.`} />
                <Metric label="Cancelled" value={formatNumber(data.appointments.cancelled)} definition={`Appointments cancelled ${calendarWord}.`} />
              </div>
            ) : (
              <Unavailable what="Appointment data" />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Sales funnel</CardTitle>
              <CardDescription>Open opportunities by stage, and outcomes in this period.</CardDescription>
            </div>
            {data.sales && <AskAnalyst canChat={canChat} prompt={`My pipeline has ${data.sales.stages.reduce((s, x) => s + x.n, 0)} open opportunities. In this period I won ${data.sales.won} and lost ${data.sales.lost}. Where is my funnel leaking?`} />}
          </CardHeader>
          <CardContent className="space-y-4">
            {data.sales ? (
              <>
                <div className="grid grid-cols-3 gap-3">
                  <Metric label="Won" value={formatNumber(data.sales.won)} definition={crmWord.replace("{s}", "Won")} />
                  <Metric label="Lost" value={formatNumber(data.sales.lost)} definition={crmWord.replace("{s}", "Lost")} />
                  <Metric label="Win rate" value={formatPercent(data.sales.won + data.sales.lost ? data.sales.won / (data.sales.won + data.sales.lost) : null)} definition="Won ÷ (won + lost) in this period." />
                </div>
                <HBarList unit="opportunities" rows={data.sales.stages.map((s) => ({ key: s.stage, label: s.stage, value: s.n }))} emptyLabel="No open opportunities." />
                {data.sales.wonValues
                  ? data.sales.wonValues.length > 0 && <p className="text-[12.5px] text-muted">Won value in period: {data.sales.wonValues.map((v) => formatCurrency(v.value, v.currency)).join(" · ")}</p>
                  : data.sales.wonValue > 0 && <p className="text-[12.5px] text-muted">Won value in period: {formatCurrency(data.sales.wonValue)}</p>}
                {nativeDeals && <Link href="/crm/reports" className="inline-flex min-h-11 items-center text-[12.5px] font-medium text-primary hover:underline sm:min-h-0">Pipeline, stage and lead source detail in CRM Reports</Link>}
              </>
            ) : (
              <Unavailable what="Sales funnel data" />
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <div>
              <CardTitle>AI employee task activity</CardTitle>
              <CardDescription>Runs per employee in this period (conversations and research).</CardDescription>
            </div>
            <AskAnalyst canChat={canChat} prompt={`My AI employees completed ${completed} of ${runsTotal} runs in the last ${range.days} days with ${failed} failures. What does that tell you?`} />
          </CardHeader>
          <CardContent className="space-y-5">
            <HBarList
              unit="runs"
              rows={AGENT_ROLES.map((r) => {
                const row = data.workforce.byAgent.find((a) => a.role_key === r.key);
                return {
                  key: r.key,
                  label: (
                    <span className="flex items-center gap-2">
                      <AgentAvatar role={r} size="xs" /> {r.shortName}
                    </span>
                  ),
                  value: row?.total ?? 0,
                };
              })}
              emptyLabel="No AI runs in this period."
            />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Metric label="Runs" value={formatNumber(runsTotal)} definition="AI employee runs started in this period." />
              <Metric label="Success rate" value={formatPercent(runsTotal ? completed / runsTotal : null)} definition="Completed ÷ all runs. Stopped runs count as not completed." />
              <Metric label="Tool steps" value={formatNumber(data.workforce.toolSteps)} definition="Tool calls reported by Hermes during runs." />
              <Metric label="Tokens" value={formatNumber(data.usage.tokens, { compact: true })} definition="Tokens reported by Hermes for completed runs." />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Workflow outcomes</CardTitle>
              <CardDescription>What happened to approved actions.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <StatusSplit
              segments={[
                { label: "Completed", value: data.execution.succeeded, color: "var(--status-good)", icon: <CheckCircle2 className="size-3.5 text-success" /> },
                { label: "Held", value: data.execution.blocked, color: "var(--status-warning)", icon: <Ban className="size-3.5 text-warning" /> },
                { label: "Failed", value: data.execution.failed, color: "var(--status-critical)", icon: <XCircle className="size-3.5 text-danger" /> },
              ]}
            />
            <p className="text-[12.5px] text-muted">
              Held means the action was approved but its integration isn&apos;t enabled, so nothing ran. Rejected: {data.execution.rejected} · Expired: {data.execution.expired}.
            </p>
            <p className="flex items-start gap-2 rounded-xl bg-surface-2 p-3 text-[12px] text-muted">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              {nativeDeals ? (
                <span>Workflow runs, form submissions and campaign results from your iAcquire CRM are in <Link href="/crm/reports" className="font-medium text-primary hover:underline">CRM Reports</Link>.</span>
              ) : (
                "Automation workflow (n8n/GHL) run statistics appear once those workflows are connected and live."
              )}
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <div>
              <CardTitle>Usage &amp; consumption</CardTitle>
              <CardDescription>AI messages per day.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            {data.usage.messages > 0 ? (
              <AreaChart data={messagesByDay.map((d) => ({ x: d.day, y: d.n }))} label="AI messages per day" unit="messages" formatX={fmt} />
            ) : (
              <p className="rounded-xl border border-dashed border-line p-6 text-center text-[13px] text-muted">No AI messages in this period.</p>
            )}
            <div className="mt-4 grid grid-cols-3 gap-3">
              <Metric label="AI messages" value={formatNumber(data.usage.messages)} definition="Messages sent to AI employees in this period." />
              <Metric label="Research runs" value={formatNumber(data.usage.research)} definition="Lead research runs started." />
              <Metric label="Help answers" value={formatNumber(data.usage.help)} definition="AI-written iAcquire Assistant answers (help-center answers aren't counted)." />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Customer retention</CardTitle>
              <CardDescription>Current snapshot.</CardDescription>
            </div>
            {data.retention.total > 0 && <AskAnalyst canChat={canChat} prompt={`I have ${data.retention.total} tracked customers: ${data.retention.active} active, ${data.retention.at_risk} at risk, ${data.retention.churned} churned. How do I reduce churn?`} />}
          </CardHeader>
          <CardContent>
            {data.retention.total ? (
              <div className="grid grid-cols-2 gap-3">
                <Metric label="Tracked" value={formatNumber(data.retention.total)} definition="Customers in Customer Retention." />
                <Metric label="Active" value={formatNumber(data.retention.active)} definition="Customers with status Active." />
                <Metric label="At risk" value={formatNumber(data.retention.at_risk)} definition="Status or health marked At risk." />
                <Metric label="Churn rate" value={formatPercent(data.retention.churned / data.retention.total)} definition="Churned ÷ all tracked customers." />
              </div>
            ) : (
              <EmptyState compact icon={<BarChart3 className="size-5" />} title="No customers tracked yet" description="Add customers in Customer Retention to see retention metrics." />
            )}
          </CardContent>
        </Card>
      </div>
      <p className="text-center text-[12px] text-faint">“Ask {AGENT_BY_KEY.performance_analyst.shortName}” pre-fills a question with the numbers from that section — only what you send is shared.</p>
    </div>
  );
}
