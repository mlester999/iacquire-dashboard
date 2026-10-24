"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Activity, AlertTriangle, ArrowRight, CalendarClock, CheckCircle2, Clock3, List, Search, ShieldCheck } from "lucide-react";
import { AgentAvatar } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/primitives";
import { StatusPill } from "@/components/ui/status";
import { WorkJobPanel } from "@/components/work/job-progress";
import { AGENT_BY_KEY, AGENT_ROLES, isAgentRoleKey, type AgentRoleKey } from "@/lib/agents";
import {
  addCalendarDays,
  calendarDateKeyAt,
  calendarTimestampLabel,
} from "@/lib/workforce-calendar-view";
import { projectWorkforceScheduleOccurrences } from "@/lib/workforce-schedule-recurrence";
import { cn, relativeTime } from "@/lib/utils";
import type { ScheduleView } from "@/server/workforce/schedules";
import type { WorkBoardJob, WorkBoardFilter } from "@/server/workforce/work-board";

type BoardView = "kanban" | "list";
type DateScope = "any" | "today" | "next7" | "past30";

interface PlannedWork {
  key: string;
  schedule: ScheduleView;
  startsAt: string;
}

const FILTERS: Array<{ key: WorkBoardFilter; label: string }> = [
  { key: "all", label: "All work" },
  { key: "active", label: "Active" },
  { key: "attention", label: "Needs attention" },
  { key: "completed", label: "Completed" },
];

const LANE_DEFS = [
  { key: "planned", label: "Planned", hint: "Future occurrences · not jobs" },
  { key: "queued", label: "Queued", hint: "Persisted jobs" },
  { key: "working", label: "Working", hint: "Active worker lease" },
  { key: "recovery", label: "Recovery pending", hint: "No active worker lease" },
  { key: "waiting", label: "Waiting for approval", hint: "A person must decide" },
  { key: "blocked", label: "Blocked", hint: "Needs a person" },
  { key: "completed", label: "Completed", hint: "Saved execution evidence" },
  { key: "failed", label: "Failed", hint: "Execution did not complete" },
  { key: "cancelled", label: "Cancelled", hint: "Stop request recorded" },
] as const;

type LaneKey = (typeof LANE_DEFS)[number]["key"];

const JOB_TONE: Record<WorkBoardJob["status"], "primary" | "success" | "warning" | "danger" | "neutral" | "violet"> = {
  queued: "neutral",
  running: "primary",
  waiting_for_approval: "violet",
  blocked: "warning",
  failed: "danger",
  cancelled: "neutral",
  completed: "success",
};

function jobLane(job: WorkBoardJob): Exclude<LaneKey, "planned"> {
  if (job.recoveryPending) return "recovery";
  if (job.status === "running") return "working";
  if (job.status === "waiting_for_approval") return "waiting";
  return job.status;
}

function roleKey(value: string): AgentRoleKey | null {
  return isAgentRoleKey(value) ? value : null;
}

function jobHref(job: WorkBoardJob): string | null {
  const key = roleKey(job.employeeRole);
  if (!key) return null;
  const meta = AGENT_BY_KEY[key];
  if (job.conversationId) return `/chat/${meta.slug}?c=${job.conversationId}`;
  if (job.capability === "lead_research") return "/leads?tab=review";
  return `/employees/${meta.slug}`;
}

function buildPlannedWork(schedules: ScheduleView[], referenceTime: string): PlannedWork[] {
  const now = new Date(referenceTime);
  const from = new Date(now.getTime() - 60_000);
  const to = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  return schedules.flatMap((schedule) => {
    if (schedule.recurrenceInvalid) return [];
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: schedule.timezone }).format(now);
      const projection = projectWorkforceScheduleOccurrences({
        cadence: schedule.cadence,
        intervalMinutes: schedule.intervalMinutes,
        recurrenceRule: schedule.recurrenceRule,
        timezone: schedule.timezone,
        nextRunAt: schedule.nextRunAt,
        from,
        to,
        maxOccurrences: 40,
      });
      return projection.occurrences.map((occurrence) => ({
        key: `${schedule.id}:${occurrence.toISOString()}`,
        schedule,
        startsAt: occurrence.toISOString(),
      }));
    } catch {
      return [];
    }
  }).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

function matchesDateScope(
  scope: DateScope,
  kind: "job" | "planned",
  timestamp: string,
  today: string,
  timeZone: string,
): boolean {
  if (scope === "any") return true;
  const date = calendarDateKeyAt(new Date(timestamp), timeZone);
  if (scope === "today") return date === today;
  if (scope === "next7") return kind === "planned" && date >= today && date < addCalendarDays(today, 8);
  return kind === "job" && date >= addCalendarDays(today, -29) && date <= today;
}

function JobCard({
  job,
  timeZone,
  expanded,
  onToggle,
}: {
  job: WorkBoardJob;
  timeZone: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const meta = roleKey(job.employeeRole) ? AGENT_BY_KEY[job.employeeRole as keyof typeof AGENT_BY_KEY] : null;
  const href = jobHref(job);
  const tone = job.recoveryPending ? "warning" : JOB_TONE[job.status];
  const detail = job.recoveryPending
    ? "No active worker lease is recorded. Recovery is pending."
    : job.status === "running"
      ? job.stageLabel ?? "Working on the next recorded step."
      : job.resultSummary ?? job.failureMessage ?? job.stageLabel ?? "No further detail has been recorded.";

  return (
    <article className="rounded-xl border border-line bg-surface p-3 shadow-soft transition hover:border-line-strong">
      <div className="flex items-start gap-2.5">
        {meta ? <AgentAvatar role={meta} size="sm" /> : <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-violet-soft text-violet-ink"><Activity className="size-4" aria-hidden /></div>}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusPill tone={tone} size="sm" dot={job.status === "running" && !job.recoveryPending}>{job.statusLabel}</StatusPill>
            <span className="truncate text-[11px] text-muted">{job.employeeName}</span>
          </div>
          <button type="button" onClick={onToggle} aria-expanded={expanded} className="mt-2 block w-full text-left">
            <span className="block text-[13px] font-semibold leading-snug text-ink">{job.title}</span>
            <span className="mt-1 line-clamp-3 block text-[11.5px] leading-relaxed text-muted">{detail}</span>
          </button>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line/70 pt-2.5 text-[10.5px] text-muted">
        <span className="inline-flex items-center gap-1"><Clock3 className="size-3" aria-hidden /><time dateTime={job.createdAt}>{calendarTimestampLabel(job.createdAt, timeZone)}</time></span>
        {job.resultCount > 0 && <span className="inline-flex items-center gap-1"><CheckCircle2 className="size-3 text-success" aria-hidden />{job.resultCount} result{job.resultCount === 1 ? "" : "s"}</span>}
      </div>
      {job.latestEvent && <p className="mt-2 line-clamp-2 text-[10.5px] leading-relaxed text-faint">Latest: {job.latestEvent.message} <span suppressHydrationWarning>· {relativeTime(job.latestEvent.createdAt)}</span></p>}
      <div className="mt-2.5 flex items-center justify-between gap-2">
        <button type="button" onClick={onToggle} aria-expanded={expanded} className="inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2 text-[11px] font-semibold text-ink-2 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Activity className="size-3.5" aria-hidden />{expanded ? "Hide activity" : "Activity"}
        </button>
        {href && <Link href={href} className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-[11px] font-semibold text-primary hover:bg-primary-soft/60">{job.capability === "lead_research" ? "Review" : "Open employee"}<ArrowRight className="size-3.5" aria-hidden /></Link>}
      </div>
      {expanded && <WorkJobPanel jobId={job.id} className="mt-3" />}
    </article>
  );
}

function PlannedCard({ item, operatorEnabled, timeZone }: { item: PlannedWork; operatorEnabled: boolean; timeZone: string }) {
  const { schedule } = item;
  const mayCreateJob = schedule.enabled && operatorEnabled;
  const scheduleState = !schedule.enabled ? "Schedule paused" : operatorEnabled ? "Enabled" : "Operator off";
  return (
    <article className="rounded-xl border border-line bg-surface p-3 shadow-soft">
      <div className="flex items-start gap-2.5">
        <AgentAvatar role={AGENT_BY_KEY[schedule.employeeRole]} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex h-5 items-center gap-1 rounded-full border border-primary/15 bg-primary-soft px-2 text-[9px] font-semibold uppercase tracking-wide text-primary-ink"><CalendarClock className="size-3" aria-hidden />Scheduled · not a job</span>
            <span className={cn("rounded-full px-2 py-0.5 text-[9px] font-semibold", mayCreateJob ? "bg-success-soft text-success-ink" : "bg-warning-soft text-warning-ink")}>{scheduleState}</span>
          </div>
          <h3 className="mt-2 text-[13px] font-semibold leading-snug text-ink">{schedule.capabilityLabel}</h3>
          <p className="mt-1 text-[11px] text-muted">{schedule.employeeName} · <time dateTime={item.startsAt}>{calendarTimestampLabel(item.startsAt, timeZone)}</time></p>
        </div>
      </div>
      <p className="mt-2 text-[10.5px] leading-relaxed text-muted">
        {mayCreateJob
          ? "An occurrence is planned. The operator, employee readiness and safety checks still apply before a job can be created."
          : !schedule.enabled
            ? "This schedule is paused. The occurrence is not a job."
            : "The operator switch is off, so this occurrence will not create a job."}
      </p>
      <Link href="/work/calendar" className="mt-2 inline-flex min-h-7 items-center gap-1 rounded-lg px-1.5 text-[10.5px] font-semibold text-primary hover:bg-primary-soft/60">View calendar<ArrowRight className="size-3" aria-hidden /></Link>
    </article>
  );
}

export function WorkBoardKanban({
  jobs,
  schedules,
  filter,
  scheduleOperatorEnabled,
  timeZone,
  focusJobId,
  employeeNames,
  referenceTime,
}: {
  jobs: WorkBoardJob[];
  schedules: ScheduleView[];
  filter: WorkBoardFilter;
  scheduleOperatorEnabled: boolean;
  timeZone: string;
  focusJobId: string | null;
  employeeNames?: Partial<Record<AgentRoleKey, string>>;
  referenceTime: string;
}) {
  const router = useRouter();
  const [view, setView] = React.useState<BoardView>("kanban");
  const [query, setQuery] = React.useState("");
  const [employeeFilter, setEmployeeFilter] = React.useState("all");
  const [dateScope, setDateScope] = React.useState<DateScope>("any");
  const [expanded, setExpanded] = React.useState<string | null>(focusJobId);
  const today = calendarDateKeyAt(new Date(referenceTime), timeZone);
  const planned = React.useMemo(() => buildPlannedWork(schedules, referenceTime), [schedules, referenceTime]);
  const cleanQuery = query.trim().toLocaleLowerCase();

  const filteredJobs = React.useMemo(() => jobs.filter((job) => {
    if (employeeFilter !== "all" && job.employeeRole !== employeeFilter) return false;
    if (!matchesDateScope(dateScope, "job", job.createdAt, today, timeZone)) return false;
    if (!cleanQuery) return true;
    return [job.title, job.employeeName, job.statusLabel, job.stageLabel, job.resultSummary, job.latestEvent?.message]
      .some((value) => value?.toLocaleLowerCase().includes(cleanQuery));
  }), [jobs, employeeFilter, dateScope, today, timeZone, cleanQuery]);

  const filteredPlanned = React.useMemo(() => planned.filter((item) => {
    if (employeeFilter !== "all" && item.schedule.employeeRole !== employeeFilter) return false;
    if (!matchesDateScope(dateScope, "planned", item.startsAt, today, timeZone)) return false;
    if (!cleanQuery) return true;
    return [item.schedule.capabilityLabel, item.schedule.employeeName, "scheduled occurrence", "not a job"]
      .some((value) => value.toLocaleLowerCase().includes(cleanQuery));
  }), [planned, employeeFilter, dateScope, today, timeZone, cleanQuery]);

  const jobsByLane = React.useMemo(() => {
    const grouped = new Map<Exclude<LaneKey, "planned">, WorkBoardJob[]>();
    for (const lane of LANE_DEFS) if (lane.key !== "planned") grouped.set(lane.key, []);
    for (const job of filteredJobs) grouped.get(jobLane(job))?.push(job);
    return grouped;
  }, [filteredJobs]);

  const workItemsExist = jobs.length > 0 || planned.length > 0;

  return (
    <section aria-labelledby="work-status-board-heading" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="work-status-board-heading" className="text-[17px] font-semibold tracking-[-0.025em] text-ink">Status board</h2>
            <span className="rounded-md bg-surface-3 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-ink-2">{filteredJobs.length + filteredPlanned.length}</span>
          </div>
          <p className="mt-1 text-[12px] text-muted">Work is grouped by persisted status. A future schedule occurrence stays separate from a job.</p>
        </div>
        <div className="flex items-center gap-1 rounded-xl border border-line bg-surface-2 p-1" role="group" aria-label="Work board view">
          <button type="button" aria-pressed={view === "kanban"} onClick={() => setView("kanban")} className={cn("inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[11.5px] font-medium", view === "kanban" ? "bg-surface text-primary-ink shadow-soft" : "text-muted hover:text-ink")}><CalendarClock className="size-3.5" aria-hidden />Kanban</button>
          <button type="button" aria-pressed={view === "list"} onClick={() => setView("list")} className={cn("inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[11.5px] font-medium", view === "list" ? "bg-surface text-primary-ink shadow-soft" : "text-muted hover:text-ink")}><List className="size-3.5" aria-hidden />Compact list</button>
        </div>
      </div>

      <div className={cn("flex flex-wrap items-center gap-2 rounded-xl border px-3.5 py-2.5", scheduleOperatorEnabled ? "border-success/20 bg-success-soft/60" : "border-warning/30 bg-warning-soft/70")} role="status">
        <AlertTriangle className={cn("size-4 shrink-0", scheduleOperatorEnabled ? "text-success-ink" : "text-warning-ink")} aria-hidden />
        <p className={cn("text-[11px] leading-relaxed", scheduleOperatorEnabled ? "text-success-ink" : "text-warning-ink")}>
          <strong>{scheduleOperatorEnabled ? "Operator switch on." : "Operator switch off."}</strong>{" "}
          {scheduleOperatorEnabled ? "Enabled schedules may create jobs only after employee readiness and safety checks." : "Schedules will not create jobs while off. Planned cards are future occurrences only, not jobs."}
        </p>
      </div>

      <nav className="flex flex-wrap items-center gap-1.5" aria-label="Filter AI work">
        {FILTERS.map((item) => <Link key={item.key} href={item.key === "all" ? "/work" : `/work?status=${item.key}`} aria-current={filter === item.key ? "page" : undefined} className={cn("inline-flex min-h-8 items-center rounded-xl px-3 text-[11.5px] font-medium", filter === item.key ? "bg-primary-soft text-primary-ink ring-1 ring-inset ring-primary/20" : "text-muted hover:bg-surface-2 hover:text-ink")}>{item.label}</Link>)}
        <span className="ml-auto text-[10.5px] text-muted">Workspace time zone · {timeZone}</span>
      </nav>

      <div className="rounded-2xl border border-line bg-surface p-3 shadow-soft sm:p-4">
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-[14rem] flex-1">
            <span className="sr-only">Search work</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search task, stage, event or result" className="h-10 w-full rounded-xl border border-line-strong bg-surface px-3 pl-9 text-[12px] text-ink placeholder:text-faint focus:border-primary focus:outline-none focus:ring-4 focus:ring-primary/10" />
          </label>
          <label className="sr-only" htmlFor="work-date-filter">Filter by date</label>
          <select id="work-date-filter" value={dateScope} onChange={(event) => setDateScope(event.target.value as DateScope)} className="h-10 rounded-xl border border-line-strong bg-surface px-3 text-[11.5px] text-ink-2 focus:border-primary focus:outline-none focus:ring-4 focus:ring-primary/10">
            <option value="any">Any date</option>
            <option value="today">Today</option>
            <option value="next7">Next 7 days (scheduled)</option>
            <option value="past30">Past 30 days (created)</option>
          </select>
          <Button variant="secondary" size="sm" onClick={() => router.refresh()} className="h-10">Refresh</Button>
        </div>
        <div className="mt-3 flex gap-1.5 overflow-x-auto pb-1" role="group" aria-label="Filter by AI employee">
          <button type="button" aria-pressed={employeeFilter === "all"} onClick={() => setEmployeeFilter("all")} className={cn("h-8 shrink-0 rounded-full border px-3 text-[10.5px] font-semibold", employeeFilter === "all" ? "border-primary/20 bg-primary-soft text-primary-ink" : "border-line bg-surface text-muted hover:bg-surface-2")}>All six</button>
          {AGENT_ROLES.map((role) => <button key={role.key} type="button" aria-pressed={employeeFilter === role.key} onClick={() => setEmployeeFilter(role.key)} className={cn("inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[10.5px] font-medium", employeeFilter === role.key ? "border-primary/20 bg-primary-soft text-primary-ink" : "border-line bg-surface text-muted hover:bg-surface-2")}><AgentAvatar role={role} size="xs" />{employeeNames?.[role.key] ?? role.shortName}</button>)}
        </div>
      </div>

      {!workItemsExist ? (
        <div className="rounded-2xl border border-line bg-surface">
          <EmptyState icon={<Activity className="size-5" />} title={filter === "all" ? "No AI work yet" : "Nothing in this view"} description={filter === "all" ? "Start an on-demand review from the page header. Persisted work will appear here with its real status and recorded activity." : "Try another status filter, or start an on-demand review if your role allows it."} />
        </div>
      ) : filteredJobs.length === 0 && filteredPlanned.length === 0 ? (
        <div className="rounded-2xl border border-line bg-surface">
          <EmptyState icon={<Search className="size-5" />} title="No work matches these filters" description="Clear the search or choose another employee, date or status." compact />
        </div>
      ) : view === "kanban" ? (
        <div className="scrollbar-thin -mx-1 overflow-x-auto px-1 pb-2" tabIndex={0} aria-label="Work status columns; scroll horizontally to see every status">
          <div className="flex min-w-max items-start gap-3">
            {LANE_DEFS.map((lane) => {
              const laneJobs = lane.key === "planned" ? [] : jobsByLane.get(lane.key) ?? [];
              const lanePlanned = lane.key === "planned" ? filteredPlanned : [];
              const count = laneJobs.length + lanePlanned.length;
              return (
                <section key={lane.key} aria-labelledby={`work-lane-${lane.key}`} className="w-[min(82vw,290px)] shrink-0 rounded-2xl border border-line bg-surface-2/60 p-2.5 sm:w-[290px]">
                  <header className="mb-2 flex items-start justify-between gap-2 px-1 py-1">
                    <div className="min-w-0"><h3 id={`work-lane-${lane.key}`} className="truncate text-[12px] font-semibold text-ink">{lane.label}</h3><p className="mt-0.5 text-[9.5px] leading-snug text-muted">{lane.hint}</p></div>
                    <span className="inline-flex min-w-6 justify-center rounded-md bg-surface px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-ink-2">{count}</span>
                  </header>
                  <div className="space-y-2">
                    {lanePlanned.map((item) => <PlannedCard key={item.key} item={item} operatorEnabled={scheduleOperatorEnabled} timeZone={timeZone} />)}
                    {laneJobs.map((job) => <JobCard key={job.id} job={job} timeZone={timeZone} expanded={expanded === job.id} onToggle={() => setExpanded(expanded === job.id ? null : job.id)} />)}
                    {count === 0 && <p className="rounded-xl border border-dashed border-line px-3 py-5 text-center text-[10.5px] text-faint">No items in this status.</p>}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-line bg-surface">
          <ul className="divide-y divide-line">
            {filteredPlanned.map((item) => <li key={item.key} className="p-3 sm:p-4"><PlannedCard item={item} operatorEnabled={scheduleOperatorEnabled} timeZone={timeZone} /></li>)}
            {filteredJobs.map((job) => <li key={job.id} className="p-3 sm:p-4"><JobCard job={job} timeZone={timeZone} expanded={expanded === job.id} onToggle={() => setExpanded(expanded === job.id ? null : job.id)} /></li>)}
          </ul>
        </div>
      )}

      <p className="flex items-start gap-2 text-[10.5px] leading-relaxed text-muted"><ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />Status changes come from recorded execution. Moving around this board never completes work; planned occurrences are future schedule projections, not jobs.</p>
    </section>
  );
}

