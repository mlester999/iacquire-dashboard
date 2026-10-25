import Link from "next/link";
import { AlertTriangle, BarChart3, CheckCircle2, Clock3, Flame, HeartHandshake, Inbox, RotateCcw, Star, Timer, UserCheck, UserRound, Users } from "lucide-react";
import { Card, EmptyState } from "@/components/ui/primitives";
import { Columns, HBarList, StatTile } from "@/components/charts";
import { DayAreaChart } from "@/components/admin/support/day-chart";
import { SectionLabel } from "@/components/ui/workspace";
import { FEEDBACK_STAGE_LABELS, REQUEST_TYPE_LABELS, categoryLabel, featureLabel, statusLabelForAgency, type FeedbackStage, type RequestType } from "@/lib/support/lifecycle";
import { sentenceCase } from "@/lib/utils";
import type { SupportAnalytics } from "@/server/support/analytics";

const q = (params: Record<string, string | undefined>) => {
  const p = new URLSearchParams({ view: "all" });
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  return `/admin/support?${p.toString()}`;
};

function minutes(m: number | null): string {
  if (m === null) return "No data";
  if (m < 1) return "Under 1 min";
  if (m < 90) return `${Math.round(m)} min`;
  if (m < 60 * 36) return `${(m / 60).toFixed(1).replace(/\.0$/, "")} hours`;
  return `${(m / 1440).toFixed(1).replace(/\.0$/, "")} days`;
}

const DEFINITIONS: Array<[string, string]> = [
  ["Requests created", "Requests opened during the selected dates, by the clients you can reach (and, if you can't see the full queue, only those assigned to you)."],
  ["Resolved", "Requests that were marked resolved during the dates, counted once per request even if it was reopened and resolved again."],
  ["Reopened", "Times a request was reopened during the dates, by the client or the team."],
  ["Open now", "Requests that are new, open, in progress or waiting on the client at this moment, for the filters chosen. It does not depend on the dates."],
  ["Overdue now", "Requests waiting on the team whose reply is past its response target at this moment. Needs response targets to be configured; otherwise it is zero."],
  ["First response time", "Time from a request being created to the team's first public reply (elapsed time, not support hours), for requests created during the dates that have had a reply. An internal note or an automatic acknowledgement does not count."],
  ["Resolution time", "Time from a request being created to the first time it was marked resolved, for requests created during the dates that have been resolved. Requests resolved before resolution history was recorded are not included."],
  ["Reopen rate", "Requests created during the dates that have been reopened at least once, as a share of requests created."],
  ["Workload", "Active requests currently assigned to each person, and how many requests assigned to them were resolved during the dates. These are counts, not scores."],
];

/** The Super Admin support dashboard. Every number comes from the request, timeline and settings tables; a period with no data says so. */
export function AnalyticsView({ data, filterQuery }: { data: SupportAnalytics; filterQuery: { orgId?: string } }) {
  const t = data.totals;
  const none = t.createdInRange === 0 && t.openNow === 0;
  const by = (rows: Array<{ key: string; count: number }>, label: (k: string) => string, href: (k: string) => string) =>
    rows.map((r) => ({ key: r.key, label: <Link href={href(r.key)} className="hover:text-primary-ink hover:underline">{label(r.key)}</Link>, value: r.count }));
  const scope = filterQuery.orgId ? { org: filterQuery.orgId } : {};
  const dayLabel = (x: string) => {
    const d = new Date(`${x}T00:00:00Z`);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  };

  return (
    <div className="space-y-6">
      <p className="text-[12.5px] text-muted" role="note">
        {data.range.from} to {data.range.to} · {data.range.bucket === "day" ? "daily" : "weekly"} totals · time zone {data.range.timezone.replace(/_/g, " ")}.{" "}
        Every figure counts real requests; where nothing has happened, it says so instead of showing a number.
      </p>

      <section aria-label="Key numbers" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Requests created" value={t.createdInRange} icon={<Inbox className="size-4" />} definition={DEFINITIONS[0][1]} href={q({ ...scope })} />
        <StatTile label="Resolved" value={t.resolvedInRange} icon={<CheckCircle2 className="size-4" />} accent="success" definition={DEFINITIONS[1][1]} />
        <StatTile label="Open now" value={t.openNow} icon={<Clock3 className="size-4" />} accent="violet" definition={DEFINITIONS[3][1]} href={q({ view: "active", ...scope })} />
        <StatTile label="Overdue now" value={t.overdueNow} icon={<AlertTriangle className="size-4" />} accent="warning" definition={DEFINITIONS[4][1]} href={q({ view: "overdue", ...scope })} />
        <StatTile label="Unassigned now" value={t.unassignedNow} icon={<UserRound className="size-4" />} accent="violet" definition="Active requests with nobody assigned, at this moment." href={q({ view: "unassigned", ...scope })} />
        <StatTile label="Assigned now" value={t.assignedNow} icon={<UserCheck className="size-4" />} definition="Active requests with a team member assigned, at this moment." />
        <StatTile label="Escalated now" value={t.escalatedNow} icon={<Flame className="size-4" />} accent="warning" definition="Active requests flagged as escalated, by a person or automatically after a response target was missed by the configured amount." href={q({ view: "escalated", ...scope })} />
        <StatTile label="Reopened" value={t.reopenedInRange} icon={<RotateCcw className="size-4" />} definition={DEFINITIONS[2][1]} />
      </section>

      <section aria-label="Satisfaction" className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
        <Card className="p-5">
          <p className="flex items-center gap-2 text-[12.5px] font-medium text-muted"><HeartHandshake className="size-4" aria-hidden /> Satisfaction</p>
          {data.satisfaction.answered > 0 ? (
            <div className="mt-2 flex flex-wrap items-end gap-x-6 gap-y-2">
              <p className="text-[26px] font-semibold leading-none tracking-tight tabular-nums text-ink">{data.satisfaction.averageRating?.toFixed(1)}<span className="ml-1 text-[13px] font-medium text-muted">/ 5</span></p>
              <p className="text-[13px] text-ink-2">{data.satisfaction.answered} answered of {data.satisfaction.requested} asked{data.satisfaction.helpfulPercent !== null ? ` · ${data.satisfaction.helpfulPercent}% said it helped` : ""}</p>
            </div>
          ) : (
            <p className="mt-2 text-[13.5px] text-ink-2">{data.satisfaction.requested > 0 ? `${data.satisfaction.requested} asked; none answered in these dates.` : "No satisfaction survey has been asked in these dates."}</p>
          )}
          <p className="mt-2 text-[12px] text-muted">Only the person who opened a resolved request can answer, once. Comments stay with the request.</p>
        </Card>
        <Card className="flex min-w-[150px] flex-col justify-center p-5">
          <p className="flex items-center gap-1.5 text-[12.5px] font-medium text-muted"><Star className="size-4" aria-hidden /> Answered</p>
          <p className="mt-2 text-[26px] font-semibold leading-none tracking-tight tabular-nums text-ink">{data.satisfaction.answered}</p>
        </Card>
      </section>
      <section aria-label="Response and resolution times" className="grid gap-4 md:grid-cols-3">
        <Card className="p-5">
          <p className="flex items-center gap-2 text-[12.5px] font-medium text-muted"><Timer className="size-4" aria-hidden /> Average first response</p>
          <p className="mt-2 text-[26px] font-semibold tracking-tight tabular-nums text-ink">{minutes(data.firstResponse.avgMinutes)}</p>
          <p className="mt-1 text-[12.5px] text-muted">{data.firstResponse.sample === 0 ? "No replies in this period yet." : `Median ${minutes(data.firstResponse.medianMinutes)} · ${data.firstResponse.sample} request${data.firstResponse.sample === 1 ? "" : "s"}`}</p>
        </Card>
        <Card className="p-5">
          <p className="flex items-center gap-2 text-[12.5px] font-medium text-muted"><CheckCircle2 className="size-4" aria-hidden /> Average time to resolve</p>
          <p className="mt-2 text-[26px] font-semibold tracking-tight tabular-nums text-ink">{minutes(data.resolution.avgMinutes)}</p>
          <p className="mt-1 text-[12.5px] text-muted">{data.resolution.sample === 0 ? "Nothing resolved from this period yet." : `Median ${minutes(data.resolution.medianMinutes)} · ${data.resolution.sample} request${data.resolution.sample === 1 ? "" : "s"}`}</p>
        </Card>
        <Card className="p-5">
          <p className="flex items-center gap-2 text-[12.5px] font-medium text-muted"><RotateCcw className="size-4" aria-hidden /> Reopen rate</p>
          <p className="mt-2 text-[26px] font-semibold tracking-tight tabular-nums text-ink">{data.reopen.ratePercent === null ? "No data" : `${data.reopen.ratePercent}%`}</p>
          <p className="mt-1 text-[12.5px] text-muted">{data.reopen.tickets} of {t.createdInRange} request{t.createdInRange === 1 ? "" : "s"} created in this period were reopened.</p>
        </Card>
      </section>

      <section aria-label="Requests over time" className="grid gap-4 xl:grid-cols-2">
        <Card className="p-5">
          <SectionLabel title="New requests" description={`Created per ${data.range.bucket}`} />
          {data.series.length && t.createdInRange > 0 ? <Columns data={data.series.map((b) => ({ x: dayLabel(b.bucket), y: b.created }))} unit="requests" label="New requests over time" /> : <EmptyState compact icon={<BarChart3 className="size-5" />} title="No requests in this period" description="Choose a wider range or clear a filter." />}
        </Card>
        <Card className="p-5">
          <SectionLabel title="Resolved" description={`Resolved per ${data.range.bucket}`} />
          {data.series.length && t.resolvedInRange > 0 ? <DayAreaChart data={data.series.map((b) => ({ x: b.bucket, y: b.resolved }))} unit="resolved" label="Requests resolved over time" /> : <EmptyState compact icon={<CheckCircle2 className="size-5" />} title="Nothing resolved in this period" description="Resolved requests appear here as they're closed out." />}
        </Card>
      </section>

      {none ? (
        <Card><EmptyState icon={<BarChart3 className="size-5" />} title="No support activity to analyse yet" description="Once clients send requests, you'll see categories, priorities, workload, feedback trends and common issues here." /></Card>
      ) : (
        <>
          <section aria-label="Breakdowns" className="grid gap-4 xl:grid-cols-3">
            <Card className="p-5"><SectionLabel title="By topic" description="Click a topic to open those requests" /><HBarList unit="requests" emptyLabel="No requests in this period" rows={by(data.byCategory, categoryLabel, (k) => q({ category: k, ...scope }))} /></Card>
            <Card className="p-5"><SectionLabel title="By priority" /><HBarList unit="requests" emptyLabel="No requests in this period" rows={by(data.byPriority, sentenceCase, (k) => q({ priority: k, ...scope }))} /></Card>
            <Card className="p-5"><SectionLabel title="By type" /><HBarList unit="requests" emptyLabel="No requests in this period" rows={by(data.byType, (k) => REQUEST_TYPE_LABELS[k as RequestType]?.plural ?? k, (k) => q({ type: k, ...scope }))} /></Card>
          </section>

          <section aria-label="Team" className="grid gap-4 xl:grid-cols-2">
            <Card className="p-5">
              <SectionLabel title="Team workload" description="Active requests assigned to each person right now, and what they resolved in the period. These are counts, not scores." />
              {data.workload.length ? (
                <div className="overflow-x-auto"><table className="w-full min-w-[320px] text-left text-[13px]"><caption className="sr-only">Team workload</caption><thead><tr className="text-[12px] uppercase tracking-wide text-muted"><th scope="col" className="py-2 pr-3 font-medium">Person</th><th scope="col" className="py-2 pr-3 text-right font-medium">Active now</th><th scope="col" className="py-2 text-right font-medium">Resolved</th></tr></thead>
                  <tbody className="divide-y divide-line">{data.workload.map((w) => (<tr key={w.userId}><th scope="row" className="py-2.5 pr-3 font-medium text-ink"><Link href={q({ assignee: w.userId, view: "active" })} className="inline-flex items-center gap-2 hover:text-primary-ink hover:underline"><Users className="size-3.5 text-muted" aria-hidden />{w.name}</Link></th><td className="py-2.5 pr-3 text-right tabular-nums">{w.active}</td><td className="py-2.5 text-right tabular-nums">{w.resolvedInRange}</td></tr>))}</tbody></table></div>
              ) : <EmptyState compact icon={<Users className="size-5" />} title="Nobody has an assigned request" description="Assigned requests are counted here per team member." />}
            </Card>
            <Card className="p-5">
              <SectionLabel title="Status of requests created in this period" />
              <HBarList unit="requests" emptyLabel="No requests in this period" rows={data.byStatus.map((r) => ({ key: r.key, label: statusLabelForAgency(r.key), value: r.count }))} />
              <p className="mt-3 text-[12px] text-muted">Where each of those requests stands today.</p>
            </Card>
          </section>

          <section aria-label="Feedback and common issues" className="grid gap-4 xl:grid-cols-2">
            <Card className="p-5">
              <SectionLabel title="Feedback" description="Feedback created in this period, by what the team has done with it" />
              <HBarList unit="items" emptyLabel="No feedback in this period" rows={data.feedback.byStage.map((r) => ({ key: r.key, label: FEEDBACK_STAGE_LABELS[r.key as FeedbackStage]?.label ?? r.key, value: r.count }))} />
              {data.feedback.byCategory.length > 0 && <div className="mt-5"><p className="mb-2 text-[12.5px] font-medium text-ink-2">By kind</p><HBarList unit="items" rows={by(data.feedback.byCategory, categoryLabel, (k) => q({ type: "feedback", category: k, ...scope }))} /></div>}
              {data.feedback.monthly.length > 0 && <div className="mt-5"><p className="mb-2 text-[12.5px] font-medium text-ink-2">Feedback per month (last six months)</p><Columns data={data.feedback.monthly.map((m) => ({ x: m.month, y: m.count }))} unit="items" label="Feedback per month" height={150} /></div>}
            </Card>
            <Card className="p-5">
              <SectionLabel title="Most reported issues" description="Issue reports in this period, grouped by problem type and feature" />
              <HBarList unit="reports" emptyLabel="No issue reports in this period"
                rows={data.commonIssues.map((c) => ({ key: `${c.category}-${c.feature ?? "none"}`, label: <Link href={q({ type: "issue", category: c.category, ...scope })} className="hover:text-primary-ink hover:underline">{categoryLabel(c.category)}{c.feature ? ` · ${featureLabel(c.feature)}` : ""}</Link>, value: c.count }))} />
              {data.topClients.length > 0 && !filterQuery.orgId && <div className="mt-5"><p className="mb-2 text-[12.5px] font-medium text-ink-2">Clients sending the most requests</p><HBarList unit="requests" rows={data.topClients.map((c) => ({ key: c.orgId, label: <Link href={q({ org: c.orgId })} className="hover:text-primary-ink hover:underline">{c.name}</Link>, value: c.count }))} /></div>}
            </Card>
          </section>
        </>
      )}

      <Card className="p-5">
        <SectionLabel title="How these numbers are defined" />
        <dl className="grid gap-x-8 gap-y-3 md:grid-cols-2">{DEFINITIONS.map(([term, text]) => (<div key={term}><dt className="text-[13px] font-semibold text-ink">{term}</dt><dd className="mt-0.5 text-[12.5px] leading-relaxed text-muted">{text}</dd></div>))}</dl>
      </Card>
    </div>
  );
}

