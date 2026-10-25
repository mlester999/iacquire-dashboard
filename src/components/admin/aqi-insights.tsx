"use client";

import * as React from "react";
import Link from "next/link";
import { Activity, ArrowLeft, BarChart3, BookOpen, Brain, CheckCircle2, Clock, Gauge, GraduationCap, Info, LifeBuoy, MessageSquare, RefreshCw, ShieldCheck, Sparkles, TriangleAlert, Users, Zap } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/status";
import { cn, formatDateTime } from "@/lib/utils";
import type { AqiInsights } from "@/server/aqi/insights";

const DAY_OPTIONS = [7, 30, 90] as const;

type InsightsRange = { kind: "preset"; days: number } | { kind: "custom"; from: string; to: string };

export function AqiInsightsDashboard() {
  const [range, setRange] = React.useState<InsightsRange>({ kind: "preset", days: 30 });
  const [customFrom, setCustomFrom] = React.useState("");
  const [customTo, setCustomTo] = React.useState("");
  const [rangeError, setRangeError] = React.useState<string | null>(null);
  const [orgId, setOrgId] = React.useState("");
  const [role, setRole] = React.useState("");
  const [data, setData] = React.useState<AqiInsights | null>(null);
  const [status, setStatus] = React.useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);

  const load = React.useCallback(async (signal?: AbortSignal, soft = false) => {
    if (!soft) setStatus("loading");
    setRefreshing(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (range.kind === "preset") params.set("days", String(range.days));
      else {
        params.set("from", range.from);
        params.set("to", range.to);
      }
      if (orgId) params.set("orgId", orgId);
      if (role) params.set("role", role);
      const res = await fetch(`/api/aqi/insights?${params.toString()}`, { cache: "no-store", signal });
      const body = (await res.json().catch(() => ({}))) as AqiInsights & { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Insights could not be loaded.");
      setData(body);
      setStatus("ready");
    } catch (err) {
      if (signal?.aborted) return;
      setError(err instanceof Error ? err.message : "Insights could not be loaded.");
      setStatus("error");
    } finally {
      setRefreshing(false);
    }
  }, [range, orgId, role]);

  function applyCustomRange() {
    setRangeError(null);
    if (!customFrom || !customTo) {
      setRangeError("Choose both a start and an end date.");
      return;
    }
    const from = new Date(`${customFrom}T00:00:00.000Z`);
    const to = new Date(`${customTo}T00:00:00.000Z`);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      setRangeError("Those dates are not valid.");
      return;
    }
    if (from.getTime() > to.getTime()) {
      setRangeError("The start date must be before the end date.");
      return;
    }
    const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
    if (days > 366) {
      setRangeError("Choose a period of 366 days or less.");
      return;
    }
    setRange({ kind: "custom", from: customFrom, to: customTo });
  }

  function resetRange() {
    setCustomFrom("");
    setCustomTo("");
    setRangeError(null);
    setRange({ kind: "preset", days: 30 });
  }

  React.useEffect(() => {
    const controller = new AbortController();
    // Deferred so the first render paints its skeleton before the request starts.
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [load]);

  return (
    <div className="module-stack space-y-6">
      <div className="flex flex-col justify-between gap-4 border-b border-line pb-5 sm:flex-row sm:items-end">
        <div>
          <p className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-[.16em] text-primary-ink"><BarChart3 className="size-3" /> AQi Insights</p>
          <h1 className="text-[27px] font-semibold tracking-[-0.045em] text-ink">How AQi is actually used</h1>
          <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-muted">Real event and usage records only. A section with no reliable source is labelled unavailable rather than estimated. Conversation text is never displayed here.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/admin/aqi" className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-line bg-surface px-3 text-[12px] font-medium text-ink-2 shadow-soft hover:bg-surface-2"><ArrowLeft className="size-3.5" /> AQi Management</Link>
          <Button size="sm" variant="secondary" loading={refreshing} onClick={() => void load(undefined, true)}><RefreshCw className="size-3.5" /> Refresh</Button>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-line bg-surface p-3" data-aqi-target="admin.aqi.insights.filters">
        <div>
          <p className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-muted">Period</p>
          <div className="flex gap-1" role="group" aria-label="Date range">
            {DAY_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={range.kind === "preset" && range.days === option}
                onClick={() => { setRangeError(null); setRange({ kind: "preset", days: option }); }}
                className={cn("h-9 rounded-xl border px-3 text-[12px] font-medium transition", range.kind === "preset" && range.days === option ? "border-primary/30 bg-primary-soft text-primary-ink" : "border-line text-muted hover:bg-surface-2 hover:text-ink")}
              >
                {option} days
              </button>
            ))}
          </div>
        </div>
        <div className="min-w-[280px] flex-1">
          <p className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-muted">Custom range <span className="font-normal normal-case tracking-normal text-faint">(UTC calendar dates)</span></p>
          <div className="flex flex-wrap items-end gap-1.5">
            <label className="min-w-[128px]">
              <span className="sr-only">From date</span>
              <input type="date" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} aria-label="From date" className="h-9 w-full rounded-xl border border-line bg-surface px-2 text-[12px] text-ink" />
            </label>
            <span className="pb-2 text-[12px] text-muted">to</span>
            <label className="min-w-[128px]">
              <span className="sr-only">To date</span>
              <input type="date" value={customTo} onChange={(event) => setCustomTo(event.target.value)} aria-label="To date" className="h-9 w-full rounded-xl border border-line bg-surface px-2 text-[12px] text-ink" />
            </label>
            <Button size="sm" variant="secondary" onClick={applyCustomRange}>Apply</Button>
            <Button size="sm" variant="ghost" onClick={resetRange}>Reset</Button>
          </div>
          {rangeError && <p role="alert" className="mt-1 text-[12px] font-medium text-danger-ink">{rangeError}</p>}
          {range.kind === "custom" && !rangeError && <p className="mt-1 text-[12px] text-muted">Showing {range.from} to {range.to} (UTC).</p>}
        </div>
        <label className="min-w-[180px] flex-1">
          <span className="mb-1 block text-[12px] font-semibold uppercase tracking-wide text-muted">Organization</span>
          <select value={orgId} onChange={(event) => setOrgId(event.target.value)} className="h-9 w-full rounded-xl border border-line bg-surface px-2 text-[12px] text-ink">
            <option value="">All organizations</option>
            {data?.filters.organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}
          </select>
        </label>
        <label className="min-w-[150px] flex-1">
          <span className="mb-1 block text-[12px] font-semibold uppercase tracking-wide text-muted">Role</span>
          <select value={role} onChange={(event) => setRole(event.target.value)} className="h-9 w-full rounded-xl border border-line bg-surface px-2 text-[12px] text-ink">
            <option value="">All roles</option>
            {(data?.filters.roles ?? ["owner", "admin", "member", "sales_rep", "support", "viewer", "appointment_setter"]).map((option) => <option key={option} value={option}>{option.replaceAll("_", " ")}</option>)}
          </select>
        </label>
        {data && <p className="ml-auto text-[12px] text-muted">Showing {data.range.label} · generated {formatDateTime(data.generatedAt)}</p>}
      </div>

      {status === "loading" && <InsightsSkeleton />}
      {status === "error" && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <span className="flex size-10 items-center justify-center rounded-xl bg-danger-soft text-danger-ink"><TriangleAlert className="size-5" /></span>
            <p className="text-[14px] font-semibold">Insights could not be loaded</p>
            <p className="max-w-md text-[12.5px] text-muted">{error ?? "The analytics request failed. No estimate has been substituted."}</p>
            <Button size="sm" variant="secondary" onClick={() => void load()}><RefreshCw className="size-3.5" /> Try again</Button>
          </CardContent>
        </Card>
      )}

      {status === "ready" && data && (
        <div className="space-y-4" data-aqi-target="admin.aqi.insights.cards">
          <section aria-labelledby="insights-usage">
            <SectionHead id="insights-usage" title="Usage" description="Conversations, messages and the people behind them." icon={<MessageSquare className="size-4" />} />
            {!data.usage.available ? <Unavailable note={data.usage.note} /> : (
              <>
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  <Metric label="Conversations" value={data.usage.conversations.toLocaleString()} detail={`${data.usage.savedConversations.toLocaleString()} explicitly saved`} icon={<MessageSquare />} definition={data.definitions.conversations} />
                  <Metric label="Messages" value={data.usage.messages.toLocaleString()} detail={`${data.usage.userMessages.toLocaleString()} asked · ${data.usage.assistantMessages.toLocaleString()} answered`} icon={<Activity />} definition={data.definitions.messages} />
                  <Metric label="Active people" value={data.usage.activeUsers.toLocaleString()} detail={`${data.usage.newUsers.toLocaleString()} new · ${data.usage.returningUsers.toLocaleString()} returning`} icon={<Users />} definition={data.definitions.activeUsers} />
                  <Metric label="Avg messages / person" value={data.usage.activeUsers ? (data.usage.messages / data.usage.activeUsers).toFixed(1) : "—"} detail="Derived from the two real counts above" icon={<Gauge />} definition="Total messages divided by distinct active people in the period." />
                </div>
                {data.usage.daily.length > 0 && <Trend points={data.usage.daily.map((point) => ({ label: point.date, value: point.messages }))} title="Messages per day" description="Recorded turns in the selected period." />}
                {data.usage.daily.length === 0 && <p className="mt-2 text-[12px] text-muted">No daily activity was recorded in this period.</p>}
              </>
            )}
          </section>

          <section aria-labelledby="insights-performance">
            <SectionHead id="insights-performance" title="AI performance" description="Answers, failures, latency and configured-provider health." icon={<Zap className="size-4" />} />
            {!data.performance.available ? <Unavailable note={data.performance.note} /> : (
              <div className="grid gap-3 lg:grid-cols-4">
                <Metric label="Successful answers" value={data.performance.successful.toLocaleString()} detail={data.performance.successRate === null ? "Rate unavailable" : `${data.performance.successRate}% of terminal answers`} icon={<CheckCircle2 />} definition={data.definitions.successRate} />
                <Metric label="Failed" value={data.performance.failed.toLocaleString()} detail={`${data.performance.cancelled.toLocaleString()} cancelled by the person`} icon={<TriangleAlert />} definition="Assistant turns that ended failed or cancelled. A cancellation is not a provider failure." />
                <Metric label="Latency p50 / p95" value={data.performance.latencyP50 === null ? "Not reported" : `${data.performance.latencyP50} / ${data.performance.latencyP95 ?? "—"} ms`} detail="Recorded response time, not a synthetic benchmark" icon={<Clock />} definition={data.definitions.latency} />
                <Metric label="Cost" value={`$${(data.performance.costMicros / 1_000_000).toFixed(4)}`} detail={`${data.performance.estimatedCosts.toLocaleString()} turns used estimated token counts`} icon={<Sparkles />} definition={data.definitions.cost} />
                <Metric label="Input tokens" value={data.performance.inputTokens.toLocaleString()} detail="Provider-reported or estimated" icon={<Brain />} definition="Sum of recorded input tokens." />
                <Metric label="Output tokens" value={data.performance.outputTokens.toLocaleString()} detail="Provider-reported or estimated" icon={<Brain />} definition="Sum of recorded output tokens." />
                <Metric label="Rate-limited requests" value={data.performance.rateLimits.toLocaleString()} detail="Rejected before the provider call" icon={<ShieldCheck />} definition="Requests refused by the AQi per-person rate limit." />
                <div className="rounded-2xl border border-line bg-surface p-4">
                  <p className="text-[12px] font-semibold uppercase tracking-wide text-muted">Provider</p>
                  <p className="mt-1 flex items-center gap-2 text-[13px] font-semibold"><StatusPill size="sm" tone={data.performance.provider.available ? "success" : "warning"}>{data.performance.provider.available ? "Connected" : "Unavailable"}</StatusPill></p>
                  <p className="mt-1 text-[12px] leading-relaxed text-muted">{data.performance.provider.detail}</p>
                  <p className="mt-1 truncate text-[12px] text-faint">{data.performance.provider.model ?? "No model resolved"}{data.performance.provider.connectionStatus ? ` · ${data.performance.provider.connectionStatus}` : ""}</p>
                </div>
                {data.performance.errors.length > 0 && (
                  <div className="rounded-2xl border border-line bg-surface p-4 lg:col-span-4">
                    <p className="text-[12px] font-semibold uppercase tracking-wide text-muted">Provider error breakdown</p>
                    <ul className="mt-2 flex flex-wrap gap-2">{data.performance.errors.map((row) => <li key={row.code} className="rounded-full border border-line bg-surface-2 px-2.5 py-1 text-[12px]"><span className="font-mono text-[12px] text-muted">{row.code}</span> <strong className="ml-1 tabular-nums">{row.count}</strong></li>)}</ul>
                  </div>
                )}
              </div>
            )}
          </section>

          <section aria-labelledby="insights-knowledge">
            <SectionHead id="insights-knowledge" title="Knowledge performance" description="What AQi matched, what it missed and what needs review." icon={<BookOpen className="size-4" />} />
            {!data.knowledge.available ? <Unavailable note={data.knowledge.note} /> : (
              <div className="grid gap-3 lg:grid-cols-3">
                <Metric label="Knowledge retrievals" value={data.knowledge.retrievals.toLocaleString()} detail="Turns with at least one approved match" icon={<BookOpen />} definition={data.definitions.knowledgeRetrievals} />
                <Metric label="Unanswered / no match" value={data.knowledge.misses.toLocaleString()} detail="How-to turns with no approved knowledge" icon={<LifeBuoy />} definition={data.definitions.knowledgeMisses} />
                <Metric label="Stale published entries" value={data.knowledge.staleCount.toLocaleString()} detail="Review date passed; listed below" icon={<Clock />} definition={data.definitions.staleKnowledge} />
                <Card className="lg:col-span-2">
                  <CardHeader><div><CardTitle>Matched knowledge categories</CardTitle><CardDescription>Only categories are recorded, never question text.</CardDescription></div></CardHeader>
                  <CardContent>{data.knowledge.topCategories.length ? <CountList rows={data.knowledge.topCategories.map((row) => ({ label: row.category, count: row.count }))} empty="No category was matched in this period." /> : <p className="text-[12px] text-muted">No category was matched in this period.</p>}</CardContent>
                </Card>
                <Card>
                  <CardHeader><div><CardTitle>Pages with unanswered questions</CardTitle><CardDescription>Where documentation may be missing.</CardDescription></div></CardHeader>
                  <CardContent>{data.knowledge.unansweredByPage.length ? <CountList rows={data.knowledge.unansweredByPage.map((row) => ({ label: row.page, count: row.count }))} empty="No unanswered page recorded." /> : <p className="text-[12px] text-muted">No unanswered page recorded in this period.</p>}</CardContent>
                </Card>
                {data.knowledge.stale.length > 0 && (
                  <div className="rounded-2xl border border-warning/30 bg-warning-soft/40 p-4 lg:col-span-3">
                    <p className="flex items-center gap-1.5 text-[12px] font-semibold text-warning-ink"><TriangleAlert className="size-3.5" /> Published entries due for review</p>
                    <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">{data.knowledge.stale.slice(0, 12).map((entry) => <li key={entry.id} className="rounded-lg bg-surface px-2.5 py-1.5 text-[12px]"><span className="font-medium">{entry.title}</span><span className="text-muted"> · {entry.category} · due {formatDateTime(entry.reviewDueAt ?? entry.updatedAt)}</span></li>)}</ul>
                  </div>
                )}
              </div>
            )}
          </section>

          <section aria-labelledby="insights-tutorials">
            <SectionHead id="insights-tutorials" title="Tutorial analytics" description="Starts, verified completions and where people stop." icon={<GraduationCap className="size-4" />} />
            {!data.tutorials.available ? <Unavailable note={data.tutorials.note} /> : (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
                  <Metric label="Starts" value={data.tutorials.starts.toLocaleString()} detail={`${data.tutorials.uniqueUsers.toLocaleString()} people`} icon={<GraduationCap />} definition={data.definitions.tutorials} />
                  <Metric label="Completions" value={data.tutorials.completions.toLocaleString()} detail="Finished or verified" icon={<CheckCircle2 />} definition="Tutorial attempts explicitly finished or verified by the real page." />
                  <Metric label="Completion rate" value={data.tutorials.completionRate === null ? "—" : `${data.tutorials.completionRate}%`} detail={data.tutorials.abandonmentRate === null ? "No starts" : `${data.tutorials.abandonmentRate}% did not complete`} icon={<Gauge />} definition={data.definitions.completionRate} />
                  <Metric label="Average time" value={data.tutorials.averageSeconds === null ? "Not recorded" : formatDuration(data.tutorials.averageSeconds)} detail="Completed attempts only" icon={<Clock />} definition="Mean elapsed time between start and completion for completed attempts." />
                  <Metric label="Resumes / missing targets" value={`${data.tutorials.resumes} / ${data.tutorials.targetMissing}`} detail="Resume activity · broken steps" icon={<RefreshCw />} definition="Resume events and steps whose approved target was not found on the page." />
                </div>
                <Card>
                  <CardHeader><div><CardTitle>Per tutorial</CardTitle><CardDescription>Most and least used walkthroughs, with completion rate and recorded time.</CardDescription></div></CardHeader>
                  <CardContent className="overflow-x-auto">
                    {data.tutorials.perTutorial.length === 0 ? <p className="text-[12px] text-muted">No tutorial activity was recorded in this period.</p> : (
                      <table className="w-full min-w-[540px] text-left text-[12px]">
                        <thead><tr className="border-b border-line text-[12px] uppercase tracking-wide text-muted"><th className="py-1.5 pr-2 font-semibold">Tutorial</th><th className="px-2 py-1.5 text-right font-semibold">Starts</th><th className="px-2 py-1.5 text-right font-semibold">Completions</th><th className="px-2 py-1.5 text-right font-semibold">Rate</th><th className="px-2 py-1.5 text-right font-semibold">Avg time</th><th className="px-2 py-1.5 text-right font-semibold">In progress</th></tr></thead>
                        <tbody>{data.tutorials.perTutorial.map((tutorial) => <tr key={tutorial.slug} className="border-b border-line/70"><td className="max-w-[280px] truncate py-1.5 pr-2 font-medium">{tutorial.title}</td><td className="px-2 py-1.5 text-right tabular-nums">{tutorial.starts}</td><td className="px-2 py-1.5 text-right tabular-nums">{tutorial.completions}</td><td className="px-2 py-1.5 text-right tabular-nums">{tutorial.completionRate === null ? "—" : `${tutorial.completionRate}%`}</td><td className="px-2 py-1.5 text-right tabular-nums">{tutorial.averageSeconds ? formatDuration(tutorial.averageSeconds) : "—"}</td><td className="px-2 py-1.5 text-right tabular-nums">{tutorial.inProgress}</td></tr>)}</tbody>
                      </table>
                    )}
                  </CardContent>
                </Card>
                {data.tutorials.stops.length > 0 && (
                  <Card>
                    <CardHeader><div><CardTitle>Where people stopped</CardTitle><CardDescription>Exit and missing-target events, by tutorial and step.</CardDescription></div></CardHeader>
                    <CardContent><CountList rows={data.tutorials.stops.map((row) => ({ label: `${row.tutorialSlug} · ${row.stepKey}`, count: row.count }))} empty="No exit was recorded." /></CardContent>
                  </Card>
                )}
              </div>
            )}
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <section aria-labelledby="insights-feedback">
              <SectionHead id="insights-feedback" title="User feedback" description="Thumbs up/down on real answers." icon={<LifeBuoy className="size-4" />} />
              {!data.feedback.available ? <Unavailable note={data.feedback.note} /> : (
                <Card>
                  <CardContent className="space-y-3 pt-5">
                    <div className="grid grid-cols-3 gap-2">
                      <Metric label="Helpful" value={data.feedback.helpful.toLocaleString()} detail="Thumbs up" icon={<CheckCircle2 />} definition="Persisted positive feedback on an assistant answer." compact />
                      <Metric label="Not helpful" value={data.feedback.notHelpful.toLocaleString()} detail="Thumbs down" icon={<TriangleAlert />} definition="Persisted negative feedback. Free-text comments are not shown here." compact />
                      <Metric label="Positive share" value={data.feedback.total ? `${Math.round((data.feedback.helpful / data.feedback.total) * 100)}%` : "—"} detail="Of recorded feedback" icon={<Gauge />} definition="Helpful divided by all recorded feedback in the period." compact />
                    </div>
                    {data.feedback.trend.length > 0 && <StackedTrend points={data.feedback.trend.map((point) => ({ label: point.date, good: point.helpful, bad: point.notHelpful }))} title="Feedback per day" />}
                    {data.feedback.byPage.length > 0 && <div><p className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-muted">Not helpful by page</p><CountList rows={data.feedback.byPage.map((row) => ({ label: row.page, count: row.notHelpful }))} empty="No page recorded." /></div>}
                    <p className="text-[12px] leading-relaxed text-muted">Comments are deliberately not displayed in analytics. Use the knowledge review area or Support to investigate a specific report.</p>
                  </CardContent>
                </Card>
              )}
            </section>

            <section aria-labelledby="insights-guidance">
              <SectionHead id="insights-guidance" title="Guidance and contextual tips" description="Offers, acceptance and configured tips." icon={<Sparkles className="size-4" />} />
              {!data.guidance.available ? <Unavailable note={data.guidance.note} /> : (
                <Card>
                  <CardContent className="space-y-3 pt-5">
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                      <Metric label="Offers" value={data.guidance.offers.toLocaleString()} detail="Chat guidance offered" icon={<Sparkles />} definition={data.definitions.guidance} compact />
                      <Metric label="Accepted" value={data.guidance.accepted.toLocaleString()} detail="Walkthrough started" icon={<CheckCircle2 />} definition="Explicit acceptance of a guide offer." compact />
                      <Metric label="Acceptance" value={data.guidance.acceptanceRate === null ? "—" : `${data.guidance.acceptanceRate}%`} detail="Accepted / offered" icon={<Gauge />} definition="Accepted offers divided by offers in the period." compact />
                      <Metric label="Tips shown / clicked" value={`${data.guidance.tipsShown} / ${data.guidance.tipsClicked}`} detail="Configured tips" icon={<Info />} definition={data.definitions.tips} compact />
                    </div>
                    {data.guidance.requestsByPage.length > 0 && <div><p className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-muted">Pages where users were offered guidance</p><CountList rows={data.guidance.requestsByPage.map((row) => ({ label: row.page, count: row.count }))} empty="No page recorded." /></div>}
                    {data.guidance.topTips.length > 0 && <div><p className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-muted">Tips by impressions</p><CountList rows={data.guidance.topTips.map((row) => ({ label: row.tipSlug, count: row.views }))} empty="No tip recorded." /></div>}
                  </CardContent>
                </Card>
              )}
            </section>
          </div>

          <Card>
            <details>
              <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-3 text-[12px] font-semibold text-ink"><Info className="size-3.5 text-primary" /> Metric definitions and privacy</summary>
              <CardContent className="grid gap-2 border-t border-line text-[12px] leading-relaxed text-muted sm:grid-cols-2">
                {Object.entries(data.definitions).map(([key, definition]) => <p key={key}><strong className="text-ink-2">{key.replaceAll(/([A-Z])/g, " $1").replace(/^./, (letter) => letter.toUpperCase())}:</strong> {definition}</p>)}
                <p className="sm:col-span-2 rounded-xl bg-surface-2 p-2.5"><strong className="text-ink-2">Privacy:</strong> analytics never displays a conversation, message body or feedback comment. Only counts, categories, routes and tutorial step identifiers are queried. Super Admin access is required and checked on the server for every request.</p>
              </CardContent>
            </details>
          </Card>
        </div>
      )}
    </div>
  );
}

function SectionHead({ id, title, description, icon }: { id: string; title: string; description: string; icon: React.ReactNode }) {
  return <div className="mb-2 flex items-center gap-2"><span className="flex size-7 items-center justify-center rounded-lg bg-primary-soft text-primary">{icon}</span><div><h2 id={id} className="text-[15px] font-semibold tracking-tight text-ink">{title}</h2><p className="text-[12px] text-muted">{description}</p></div></div>;
}

function Metric({ label, value, detail, icon, definition, compact = false }: { label: string; value: string; detail: string; icon: React.ReactNode; definition: string; compact?: boolean }) {
  return (
    <Card title={definition}>
      <CardContent className={cn("pt-4", compact && "pb-3")}>
        <span className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-ink-2">{icon}{label}</span>
        <p className={cn("mt-1 font-semibold tracking-tight text-ink", compact ? "text-[19px]" : "text-[25px]")}>{value}</p>
        <p className="mt-0.5 text-[12px] leading-relaxed text-ink-2">{detail}</p>
      </CardContent>
    </Card>
  );
}

function Unavailable({ note }: { note: string | null }) {
  return (
    <div className="rounded-2xl border border-dashed border-line-strong bg-surface px-4 py-6 text-center">
      <p className="text-[12.5px] font-medium text-ink-2">No reliable data for this period</p>
      <p className="mx-auto mt-1 max-w-lg text-[12px] leading-relaxed text-muted">{note ?? "This metric has no recorded event source in the selected period. It is left empty rather than estimated."}</p>
    </div>
  );
}

function CountList({ rows, empty }: { rows: Array<{ label: string; count: number }>; empty: string }) {
  if (!rows.length) return <p className="text-[12px] text-muted">{empty}</p>;
  const max = Math.max(...rows.map((row) => row.count), 1);
  return (
    <ul className="space-y-1.5">
      {rows.map((row) => (
        <li key={row.label} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 text-[12px]">
          <span className="min-w-0"><span className="block truncate text-ink-2">{row.label}</span><span className="mt-0.5 block h-1 overflow-hidden rounded-full bg-surface-3" aria-hidden><span className="block h-full rounded-full bg-primary" style={{ width: `${(row.count / max) * 100}%` }} /></span></span>
          <strong className="tabular-nums text-ink">{row.count.toLocaleString()}</strong>
        </li>
      ))}
    </ul>
  );
}

function Trend({ points, title, description }: { points: Array<{ label: string; value: number }>; title: string; description: string }) {
  const max = Math.max(...points.map((point) => point.value), 1);
  return (
    <Card className="mt-3">
      <CardHeader><div><CardTitle>{title}</CardTitle><CardDescription>{description}</CardDescription></div></CardHeader>
      <CardContent>
        <div className="relative flex h-32 items-end gap-1 overflow-x-auto pb-1" role="img" aria-label={`${title}. Highest ${max}. ${points.length} days.`}>
          {points.map((point) => (
            <div key={point.label} className="group flex min-w-[6px] flex-1 flex-col items-center justify-end" title={`${point.label}: ${point.value}`}>
              <span className="w-full rounded-t bg-primary/70 transition group-hover:bg-primary" style={{ height: `${Math.max(2, (point.value / max) * 112)}px` }} />
            </div>
          ))}
        </div>
        <div className="mt-1 flex justify-between text-[12px] text-faint"><span>{points[0]?.label}</span><span>{points[points.length - 1]?.label}</span></div>
        <table className="sr-only"><caption>{title}</caption><thead><tr><th>Date</th><th>Count</th></tr></thead><tbody>{points.map((point) => <tr key={point.label}><td>{point.label}</td><td>{point.value}</td></tr>)}</tbody></table>
      </CardContent>
    </Card>
  );
}

function StackedTrend({ points, title }: { points: Array<{ label: string; good: number; bad: number }>; title: string }) {
  const max = Math.max(...points.map((point) => point.good + point.bad), 1);
  return (
    <div>
      <p className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-muted">{title}</p>
      <div className="relative flex h-16 items-end gap-1 overflow-x-auto" role="img" aria-label={`${title}: helpful and not helpful feedback per day.`}>
        {points.map((point) => (
          <div key={point.label} className="flex min-w-[8px] flex-1 flex-col justify-end" title={`${point.label}: ${point.good} helpful, ${point.bad} not helpful`}>
            <span className="w-full rounded-t bg-danger/60" style={{ height: `${Math.max(1, (point.bad / max) * 56)}px` }} />
            <span className="w-full bg-success/70" style={{ height: `${Math.max(1, (point.good / max) * 56)}px` }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex items-center gap-3 text-[12px] text-muted"><span className="inline-flex items-center gap-1"><i className="size-2 rounded-sm bg-success/70" /> Helpful</span><span className="inline-flex items-center gap-1"><i className="size-2 rounded-sm bg-danger/60" /> Not helpful</span></div>
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function InsightsSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <p className="sr-only">Loading AQi Insights</p>
      {[0, 1, 2].map((section) => (
        <div key={section} className="space-y-2">
          <div className="skeleton h-6 w-48 rounded-lg" />
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map((card) => <div key={card} className="skeleton h-24 rounded-2xl" />)}</div>
        </div>
      ))}
    </div>
  );
}
