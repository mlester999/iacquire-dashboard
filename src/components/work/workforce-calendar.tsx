"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, ArrowRight, CalendarDays, CalendarRange, Clock3, ExternalLink, List, Plus, RefreshCw, ShieldCheck } from "lucide-react";
import { AgentAvatar } from "@/components/brand";
import { Button, ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/primitives";
import { PageHero } from "@/components/ui/workspace";
import { StatusPill } from "@/components/ui/status";
import { AGENT_BY_KEY, AGENT_ROLES, type AgentRoleKey } from "@/lib/agents";
import {
  addCalendarDays,
  calendarDateKeyAt,
  calendarDateKeys,
  calendarMonthLabel,
  calendarTimeLabel,
  calendarTimestampLabel,
  formatCalendarDateKey,
  getWorkforceCalendarRange,
  shiftCalendarMonth,
  type WorkforceCalendarView,
} from "@/lib/workforce-calendar-view";
import { projectWorkforceScheduleOccurrences } from "@/lib/workforce-schedule-recurrence";
import { cn } from "@/lib/utils";
import type { WorkforceCalendarData, WorkforceCalendarJob, WorkforceCalendarSchedule } from "@/server/workforce/calendar";

type CalendarItem =
  | { kind: "job"; key: string; startsAt: string; job: WorkforceCalendarJob }
  | { kind: "schedule"; key: string; startsAt: string; schedule: WorkforceCalendarSchedule };

const VIEWS: Array<{ key: WorkforceCalendarView; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { key: "month", label: "Month", icon: CalendarDays },
  { key: "week", label: "Week", icon: CalendarRange },
  { key: "day", label: "Day", icon: Clock3 },
  { key: "agenda", label: "Agenda", icon: List },
];

const JOB_TONE: Record<WorkforceCalendarJob["status"], "primary" | "success" | "warning" | "danger" | "neutral" | "violet"> = {
  queued: "neutral",
  running: "primary",
  waiting_for_approval: "violet",
  blocked: "warning",
  failed: "danger",
  cancelled: "neutral",
  completed: "success",
};

function itemDate(item: CalendarItem, timeZone: string): string {
  return calendarDateKeyAt(new Date(item.startsAt), timeZone);
}

function makeItems(data: WorkforceCalendarData, visibleFrom: string, visibleTo: string): CalendarItem[] {
  const inView = (instant: string) => {
    const key = calendarDateKeyAt(new Date(instant), data.timezone);
    return key >= visibleFrom && key < visibleTo;
  };
  const jobs: CalendarItem[] = data.jobs
    .filter((job) => inView(job.startsAt))
    .map((job) => ({ kind: "job", key: `job:${job.id}`, startsAt: job.startsAt, job }));
  const schedules: CalendarItem[] = data.schedules.flatMap((schedule) => {
    if (schedule.recurrenceInvalid || !schedule.timezoneValid) return [];
    try {
      const projection = projectWorkforceScheduleOccurrences({
        cadence: schedule.cadence,
        intervalMinutes: schedule.intervalMinutes,
        recurrenceRule: schedule.recurrenceRule,
        timezone: schedule.timezone,
        nextRunAt: schedule.nextRunAt,
        from: new Date(data.from),
        to: new Date(data.to),
        maxOccurrences: 1000,
      });
      return projection.occurrences.flatMap((occurrence) => {
        const startsAt = occurrence.toISOString();
        if (!inView(startsAt)) return [];
        return [{ kind: "schedule" as const, key: `schedule:${schedule.id}:${startsAt}`, startsAt, schedule }];
      });
    } catch {
      return [];
    }
  });
  return [...jobs, ...schedules].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

function dateHeading(key: string): string {
  return formatCalendarDateKey(key, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

function navigationLabel(view: WorkforceCalendarView, dateKey: string, visibleDays: string[]): string {
  if (view === "month") return calendarMonthLabel(dateKey);
  if (view === "day") return dateHeading(dateKey);
  if (view === "week") {
    const first = visibleDays[0];
    const last = visibleDays.at(-1) ?? first;
    return `${formatCalendarDateKey(first, { month: "short", day: "numeric" })} – ${formatCalendarDateKey(last, { month: "short", day: "numeric", year: "numeric" })}`;
  }
  const last = visibleDays.at(-1) ?? dateKey;
  return `${formatCalendarDateKey(dateKey, { month: "short", day: "numeric" })} – ${formatCalendarDateKey(last, { month: "short", day: "numeric", year: "numeric" })}`;
}

function employeeOf(item: CalendarItem): string {
  return item.kind === "job" ? item.job.employeeName : item.schedule.employeeName;
}

function roleOf(item: CalendarItem): AgentRoleKey {
  return item.kind === "job" ? item.job.employeeRole : item.schedule.employeeRole;
}

function titleOf(item: CalendarItem): string {
  return item.kind === "job" ? item.job.title : item.schedule.capabilityLabel;
}

function EventButton({
  item,
  timeZone,
  selected,
  onClick,
  compact = false,
}: {
  item: CalendarItem;
  timeZone: string;
  selected: boolean;
  onClick: () => void;
  compact?: boolean;
}) {
  const scheduled = item.kind === "schedule";
  const tone = scheduled
    ? "border-l-primary bg-primary-soft/70 text-primary-ink"
    : item.job.status === "completed"
      ? "border-l-success bg-success-soft/70 text-success-ink"
      : item.job.status === "failed" || item.job.status === "blocked"
        ? "border-l-warning bg-warning-soft/80 text-warning-ink"
        : item.job.status === "waiting_for_approval"
          ? "border-l-violet bg-violet-soft/80 text-violet-ink"
          : "border-l-primary bg-primary-soft/70 text-primary-ink";
  const status = scheduled ? "scheduled occurrence, not a job" : item.job.statusLabel;
  const label = `${titleOf(item)}, ${employeeOf(item)}, ${status}, ${calendarTimestampLabel(item.startsAt, timeZone)}`;
  return (
    <button type="button" onClick={onClick} aria-label={label} aria-pressed={selected} title={label} className={cn("block w-full min-w-0 truncate rounded-md border-l-2 px-1.5 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", tone, selected && "ring-1 ring-primary/35", compact ? "text-[10px]" : "text-[9px]")}>
      <span className="font-semibold">{calendarTimeLabel(item.startsAt, timeZone)}</span>
      <span className="ml-1">{titleOf(item)}</span>
      {scheduled && <span className="ml-1 font-medium opacity-80">· not a job</span>}
    </button>
  );
}

function SelectedItem({ item, data, timeZone }: { item: CalendarItem | null; data: WorkforceCalendarData; timeZone: string }) {
  if (!item) return null;
  if (item.kind === "job") {
    const { job } = item;
    return (
      <section className="rounded-2xl border border-line bg-surface p-4 shadow-soft" aria-labelledby="calendar-selected-title">
        <div className="flex items-start justify-between gap-3">
          <div><p className="text-[9.5px] font-semibold uppercase tracking-[.12em] text-primary">Recorded job</p><p className="mt-1 text-[10.5px] text-muted">{calendarTimestampLabel(job.startsAt, timeZone)}</p></div>
          <StatusPill tone={JOB_TONE[job.status]} size="sm">{job.statusLabel}</StatusPill>
        </div>
        <div className="mt-3 flex items-center gap-2.5"><AgentAvatar role={AGENT_BY_KEY[job.employeeRole]} size="sm" /><div className="min-w-0"><h2 id="calendar-selected-title" className="truncate text-[14px] font-semibold text-ink">{job.title}</h2><p className="mt-0.5 text-[11px] text-muted">{job.employeeName} · {job.source === "schedule" ? "Created from a schedule" : "Requested work"}</p></div></div>
        <p className="mt-3 rounded-xl bg-surface-2 px-3 py-2.5 text-[11.5px] leading-relaxed text-ink-2">{job.failureMessage ?? job.resultSummary ?? job.stageLabel ?? "No additional execution detail is recorded."}</p>
        {job.resultCount > 0 && <p className="mt-2 text-[10.5px] text-muted">{job.resultCount} result{job.resultCount === 1 ? "" : "s"} recorded</p>}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
          <span className="text-[10px] text-muted">Created {calendarTimestampLabel(job.createdAt, timeZone)}</span>
          <Link href={`/work?job=${job.id}`} className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-[11px] font-semibold text-primary hover:bg-primary-soft/60">Open work details<ExternalLink className="size-3" aria-hidden /></Link>
        </div>
      </section>
    );
  }

  const { schedule } = item;
  const runnableGate = schedule.enabled && data.operatorEnabled;
  return (
    <section className="rounded-2xl border border-line bg-surface p-4 shadow-soft" aria-labelledby="calendar-selected-title">
      <div className="flex items-start justify-between gap-3"><div><p className="text-[9.5px] font-semibold uppercase tracking-[.12em] text-primary">Future occurrence · not a job</p><p className="mt-1 text-[10.5px] text-muted">{calendarTimestampLabel(item.startsAt, timeZone)}</p></div><span className={cn("rounded-full px-2.5 py-1 text-[9.5px] font-semibold", runnableGate ? "bg-success-soft text-success-ink" : "bg-warning-soft text-warning-ink")}>{runnableGate ? "Schedule enabled" : "Paused"}</span></div>
      <div className="mt-3 flex items-center gap-2.5"><AgentAvatar role={AGENT_BY_KEY[schedule.employeeRole]} size="sm" /><div className="min-w-0"><h2 id="calendar-selected-title" className="truncate text-[14px] font-semibold text-ink">{schedule.capabilityLabel}</h2><p className="mt-0.5 text-[11px] text-muted">{schedule.employeeName} · {schedule.cadence} · {schedule.timezone}</p></div></div>
      <div className="mt-3 rounded-xl border border-warning/25 bg-warning-soft/50 px-3 py-2.5 text-[11px] leading-relaxed text-warning-ink">
        {runnableGate
          ? "An occurrence is planned, but the calendar entry is not a job. Employee readiness, business hours and worker checks still apply when the scheduler runs."
          : !schedule.enabled
            ? "This schedule is paused. No job will be created from this occurrence."
            : "The workforce schedule operator is off. No job will be created from this occurrence."}
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-[10.5px]">
        <div className="rounded-lg border border-line p-2.5"><dt className="text-muted">Schedule time zone</dt><dd className="mt-1 font-semibold text-ink-2">{schedule.timezone}</dd></div>
        <div className="rounded-lg border border-line p-2.5"><dt className="text-muted">Workspace display</dt><dd className="mt-1 font-semibold text-ink-2">{timeZone}</dd></div>
        <div className="rounded-lg border border-line p-2.5"><dt className="text-muted">Last actual run</dt><dd className="mt-1 font-semibold text-ink-2">{schedule.lastRunAt ? calendarTimestampLabel(schedule.lastRunAt, timeZone) : "No run recorded"}</dd></div>
        <div className="rounded-lg border border-line p-2.5"><dt className="text-muted">Worker job</dt><dd className="mt-1 font-semibold text-ink-2">{schedule.lastJobId ? "Recorded separately" : "None for this occurrence"}</dd></div>
      </dl>
      {schedule.lastJobId && <Link href={`/work?job=${schedule.lastJobId}`} className="mt-3 inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-[11px] font-semibold text-primary hover:bg-primary-soft/60">Open last recorded job<ExternalLink className="size-3" aria-hidden /></Link>}
    </section>
  );
}

export function WorkforceCalendar({
  initialData,
  initialDateKey,
  canManageSchedules,
  employeeNames,
}: {
  initialData: WorkforceCalendarData;
  initialDateKey: string;
  canManageSchedules: boolean;
  employeeNames?: Partial<Record<AgentRoleKey, string>>;
}) {
  const [view, setView] = React.useState<WorkforceCalendarView>("month");
  const [dateKey, setDateKey] = React.useState(initialDateKey);
  const [employeeFilter, setEmployeeFilter] = React.useState<"all" | AgentRoleKey>("all");
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null);
  const initialRange = React.useMemo(() => getWorkforceCalendarRange(initialDateKey, "month"), [initialDateKey]);
  const initialRangeKey = `${initialRange.from.toISOString()}|${initialRange.to.toISOString()}`;
  const [loaded, setLoaded] = React.useState(() => ({ key: initialRangeKey, data: initialData }));
  const [requestError, setRequestError] = React.useState<{ key: string; retryCount: number; message: string } | null>(null);
  const [retryCount, setRetryCount] = React.useState(0);
  const range = React.useMemo(() => getWorkforceCalendarRange(dateKey, view), [dateKey, view]);
  const rangeKey = `${range.from.toISOString()}|${range.to.toISOString()}`;
  const data = loaded.data;
  const error = requestError?.key === rangeKey && requestError.retryCount === retryCount ? requestError.message : null;
  const loading = loaded.key !== rangeKey && error === null;
  const today = initialDateKey;

  React.useEffect(() => {
    if (loaded.key === rangeKey) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ from: range.from.toISOString(), to: range.to.toISOString() });
    void fetch(`/api/workforce/calendar?${params.toString()}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => null) as { calendar?: WorkforceCalendarData; error?: string } | null;
        if (!response.ok || !body?.calendar) throw new Error(body?.error ?? "The calendar could not be refreshed.");
        setLoaded({ key: rangeKey, data: body.calendar });
        setRequestError(null);
      })
      .catch((reason: unknown) => {
        if (reason instanceof Error && reason.name === "AbortError") return;
        setRequestError({ key: rangeKey, retryCount, message: reason instanceof Error ? reason.message : "The calendar could not be refreshed." });
      });
    return () => controller.abort();
  }, [rangeKey, range.from, range.to, loaded.key, retryCount]);

  const visibleDays = React.useMemo(() => calendarDateKeys(range.visibleFrom, range.visibleTo), [range.visibleFrom, range.visibleTo]);
  const allItems = React.useMemo(() => makeItems(data, range.visibleFrom, range.visibleTo), [data, range.visibleFrom, range.visibleTo]);
  const items = React.useMemo(() => employeeFilter === "all" ? allItems : allItems.filter((item) => roleOf(item) === employeeFilter), [allItems, employeeFilter]);
  const byDay = React.useMemo(() => {
    const grouped = new Map<string, CalendarItem[]>();
    for (const day of visibleDays) grouped.set(day, []);
    for (const item of items) grouped.get(itemDate(item, data.timezone))?.push(item);
    return grouped;
  }, [items, visibleDays, data.timezone]);
  const selected = items.find((item) => item.key === selectedKey) ?? null;
  const invalidSchedules = data.schedules.filter((schedule) => schedule.recurrenceInvalid || !schedule.timezoneValid);
  const currentItems = byDay.get(dateKey) ?? [];
  const selectedOrDayItem = selected ?? currentItems[0] ?? null;
  const currentMonth = dateKey.slice(0, 7);
  const label = navigationLabel(view, dateKey, visibleDays);

  const navigate = (direction: -1 | 1) => {
    if (view === "month") setDateKey(shiftCalendarMonth(dateKey, direction));
    else if (view === "week") setDateKey(addCalendarDays(dateKey, direction * 7));
    else if (view === "agenda") setDateKey(addCalendarDays(dateKey, direction * 30));
    else setDateKey(addCalendarDays(dateKey, direction));
    setSelectedKey(null);
  };

  const selectItem = (item: CalendarItem) => {
    setDateKey(itemDate(item, data.timezone));
    setSelectedKey(item.key);
  };

  const retry = () => setRetryCount((current) => current + 1);

  function renderEventList(dayItems: CalendarItem[], compact = false) {
    if (!dayItems.length) return <p className="px-1 py-2 text-[10px] text-faint">No recorded jobs or projected schedule occurrences.</p>;
    return <div className={cn("space-y-1", compact && "mt-1")}>{dayItems.map((item) => <EventButton key={item.key} item={item} timeZone={data.timezone} selected={selectedKey === item.key} onClick={() => selectItem(item)} compact={compact} />)}</div>;
  }

  return (
    <div className="space-y-4">
      <PageHero
        eyebrow="AI Workforce"
        title="Schedules & Calendar"
        description={<>See each employee&apos;s future schedule occurrences alongside persisted jobs. Times are displayed in <strong className="font-semibold text-ink-2">{data.timezone}</strong>.</>}
        icon={<CalendarDays />}
        tone="neutral"
        action={canManageSchedules ? <ButtonLink href="/work#scheduled-work" variant="brand"><Plus className="size-4" aria-hidden />New schedule</ButtonLink> : undefined}
      />

      <nav className="flex flex-wrap items-center gap-1 rounded-xl border border-primary/10 bg-primary-soft/50 p-1.5" aria-label="Workforce section">
        <Link href="/work" className="rounded-lg px-3 py-2 text-[11.5px] font-medium text-muted hover:bg-surface hover:text-ink">Work Board</Link>
        <Link href="/work/calendar" aria-current="page" className="rounded-lg bg-surface px-3 py-2 text-[11.5px] font-semibold text-primary-ink shadow-soft">Schedules &amp; Calendar</Link>
        <Link href="/activity" className="rounded-lg px-3 py-2 text-[11.5px] font-medium text-muted hover:bg-surface hover:text-ink">Activity</Link>
        <Link href="/approvals" className="rounded-lg px-3 py-2 text-[11.5px] font-medium text-muted hover:bg-surface hover:text-ink">Approvals</Link>
        <span className="ml-auto hidden px-2 text-[9.5px] font-semibold uppercase tracking-[.1em] text-muted md:block">{data.timezone}</span>
      </nav>

      <section className="space-y-3" aria-label="Workforce calendar">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface p-3 shadow-soft">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex h-9 items-center gap-1 rounded-xl border border-line bg-surface-2/60 p-1">
              <button type="button" aria-label={`Previous ${view}`} onClick={() => navigate(-1)} className="flex size-7 items-center justify-center rounded-lg text-muted hover:bg-surface hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><ArrowLeft className="size-3.5" aria-hidden /></button>
              <span className="min-w-[150px] px-1 text-center text-[12px] font-semibold text-ink">{label}</span>
              <button type="button" aria-label={`Next ${view}`} onClick={() => navigate(1)} className="flex size-7 items-center justify-center rounded-lg text-muted hover:bg-surface hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><ArrowRight className="size-3.5" aria-hidden /></button>
            </div>
            <Button variant="secondary" size="sm" className="h-9" onClick={() => { setDateKey(today); setSelectedKey(null); }}>Today</Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {loading && <span role="status" className="inline-flex items-center gap-1.5 text-[10.5px] text-muted"><RefreshCw className="size-3.5 animate-spin" aria-hidden />Updating calendar</span>}
            <div className="flex h-9 items-center rounded-xl border border-line bg-surface-2/60 p-1" role="group" aria-label="Calendar view">
              {VIEWS.map((option) => <button key={option.key} type="button" aria-label={option.label} title={option.label} aria-pressed={view === option.key} onClick={() => { setView(option.key); setSelectedKey(null); }} className={cn("inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[10.5px] font-medium", view === option.key ? "bg-surface text-primary-ink shadow-soft" : "text-muted hover:text-ink")}><option.icon className="size-3.5" aria-hidden /><span className="hidden sm:inline">{option.label}</span></button>)}
            </div>
          </div>
        </div>

        {error && <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-danger/20 bg-danger-soft px-3.5 py-2.5 text-[11.5px] text-danger-ink" role="alert"><span className="inline-flex items-center gap-2"><AlertTriangle className="size-4 shrink-0" aria-hidden />{error}</span><Button size="sm" variant="secondary" onClick={retry}>Retry</Button></div>}
        {data.jobsTruncated && <p className="rounded-xl border border-warning/25 bg-warning-soft/50 px-3.5 py-2.5 text-[10.5px] leading-relaxed text-warning-ink">More than 1,000 jobs match this period. The calendar shows the latest 1,000 matching records; use Week or Day to narrow the range.</p>}

        <div className={cn("flex flex-wrap items-center gap-2 rounded-xl border px-3.5 py-2.5", data.operatorEnabled ? "border-success/20 bg-success-soft/60" : "border-warning/30 bg-warning-soft/70")} role="status">
          <AlertTriangle className={cn("size-4 shrink-0", data.operatorEnabled ? "text-success-ink" : "text-warning-ink")} aria-hidden />
          <p className={cn("text-[11px] leading-relaxed", data.operatorEnabled ? "text-success-ink" : "text-warning-ink")}>
            <strong>{data.operatorEnabled ? "Operator switch on." : "Operator switch off."}</strong>{" "}
            {data.operatorEnabled ? "Enabled schedules may create jobs after employee readiness and safety checks; a calendar occurrence alone is never a job." : "Future occurrences are visible, but no schedule creates a job while the operator switch is off. New schedules save paused."}
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex max-w-full gap-1.5 overflow-x-auto pb-1" role="group" aria-label="Filter by employee">
            <button type="button" aria-pressed={employeeFilter === "all"} onClick={() => setEmployeeFilter("all")} className={cn("h-8 shrink-0 rounded-full border px-3 text-[10.5px] font-semibold", employeeFilter === "all" ? "border-primary/20 bg-primary-soft text-primary-ink" : "border-line bg-surface text-muted hover:bg-surface-2")}>All employees</button>
            {AGENT_ROLES.map((role) => <button key={role.key} type="button" aria-pressed={employeeFilter === role.key} onClick={() => setEmployeeFilter(role.key)} className={cn("inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[10.5px] font-medium", employeeFilter === role.key ? "border-primary/20 bg-primary-soft text-primary-ink" : "border-line bg-surface text-muted hover:bg-surface-2")}><AgentAvatar role={role} size="xs" />{employeeNames?.[role.key] ?? role.shortName}</button>)}
          </div>
          <span className="text-[10.5px] text-muted">{items.length} item{items.length === 1 ? "" : "s"} · times use {data.timezone}</span>
        </div>

        <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0">
            {view === "month" && <section aria-label={`${calendarMonthLabel(dateKey)} calendar`} className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
              <div className="grid grid-cols-7 border-b border-line bg-surface-2/40 text-center text-[9.5px] font-semibold uppercase tracking-[.08em] text-muted">{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => <div key={day} className="py-2.5">{day}</div>)}</div>
              <div className="grid grid-cols-7">
                {visibleDays.map((day, index) => {
                  const dayItems = byDay.get(day) ?? [];
                  const outside = day.slice(0, 7) !== currentMonth;
                  return <div key={day} aria-label={`${dateHeading(day)}${dayItems.length ? `, ${dayItems.length} item${dayItems.length === 1 ? "" : "s"}` : ""}`} className={cn("min-h-[104px] border-b border-r border-line p-1.5 sm:min-h-[118px] sm:p-2", index % 7 === 6 && "border-r-0", outside && "bg-surface-2/25", day === dateKey && "bg-primary-soft/30")}>
                    <button type="button" onClick={() => { setDateKey(day); setSelectedKey(null); }} aria-current={day === today ? "date" : undefined} aria-pressed={day === dateKey} className={cn("flex size-6 items-center justify-center rounded-full text-[10.5px] font-medium", outside ? "text-faint" : "text-ink-2", day === today && "bg-primary text-white", day === dateKey && day !== today && "ring-1 ring-primary/40")}>{formatCalendarDateKey(day, { day: "numeric" })}</button>
                    <div className="mt-1.5 space-y-1">{dayItems.slice(0, 3).map((item) => <EventButton key={item.key} item={item} timeZone={data.timezone} selected={selectedKey === item.key} onClick={() => selectItem(item)} />)}{dayItems.length > 3 && <button type="button" onClick={() => { setDateKey(day); setView("day"); setSelectedKey(null); }} className="px-1 text-[9px] font-semibold text-primary hover:underline">+{dayItems.length - 3} more</button>}</div>
                  </div>;
                })}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-2 border-t border-line px-4 py-3 text-[9.5px] text-muted"><span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-sm bg-primary" />Scheduled occurrence · not a job</span><span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-sm bg-success" />Recorded job result</span><span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-sm bg-warning" />Needs attention</span></div>
            </section>}

            {view === "week" && <section aria-label={`${label} calendar`} className="overflow-x-auto rounded-2xl border border-line bg-surface shadow-soft"><div className="grid min-w-[800px] grid-cols-7">{visibleDays.map((day, index) => { const dayItems = byDay.get(day) ?? []; return <div key={day} className={cn("min-h-[360px] border-r border-line p-2", index === 6 && "border-r-0", day === dateKey && "bg-primary-soft/20")}><button type="button" onClick={() => { setDateKey(day); setView("day"); setSelectedKey(null); }} className="mb-2 block w-full rounded-lg p-1.5 text-left hover:bg-surface-2"><span className="block text-[9px] font-semibold uppercase tracking-wide text-muted">{formatCalendarDateKey(day, { weekday: "short" })}</span><span className={cn("mt-1 inline-flex size-7 items-center justify-center rounded-full text-[11px] font-semibold", day === today ? "bg-primary text-white" : "text-ink")}>{formatCalendarDateKey(day, { day: "numeric" })}</span></button>{renderEventList(dayItems, true)}</div>; })}</div></section>}

            {view === "day" && <section aria-label={`${dateHeading(dateKey)} calendar`} className="rounded-2xl border border-line bg-surface p-4 shadow-soft"><div className="mb-3 flex flex-wrap items-end justify-between gap-2 border-b border-line pb-3"><div><p className="text-[9.5px] font-semibold uppercase tracking-[.12em] text-primary">Selected day</p><h2 className="mt-1 text-[16px] font-semibold text-ink">{dateHeading(dateKey)}</h2></div><span className="text-[10.5px] text-muted">{currentItems.length} item{currentItems.length === 1 ? "" : "s"}</span></div>{renderEventList(currentItems, true)}</section>}

            {view === "agenda" && <section aria-label="Calendar agenda" className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft"><div className="border-b border-line px-4 py-3"><h2 className="text-[13px] font-semibold text-ink">Agenda</h2><p className="mt-0.5 text-[10.5px] text-muted">Items are grouped by their local date in {data.timezone}.</p></div><div className="divide-y divide-line">{visibleDays.map((day) => { const dayItems = byDay.get(day) ?? []; if (!dayItems.length) return null; return <div key={day} className="grid gap-2 px-4 py-3 sm:grid-cols-[140px_minmax(0,1fr)]"><div><p className="text-[11px] font-semibold text-ink">{dateHeading(day)}</p><p className="mt-0.5 text-[9.5px] text-muted">{dayItems.length} item{dayItems.length === 1 ? "" : "s"}</p></div>{renderEventList(dayItems, true)}</div>; })}{items.length === 0 && <div className="px-4 py-8"><EmptyState icon={<CalendarDays className="size-5" />} title="Nothing in this period" description="No recorded jobs or projected schedule occurrences match this calendar view." compact /></div>}</div></section>}
          </div>

          <aside className="space-y-3">
            {selectedOrDayItem ? <SelectedItem item={selectedOrDayItem} data={data} timeZone={data.timezone} /> : <section className="rounded-2xl border border-line bg-surface p-4 shadow-soft"><p className="text-[9.5px] font-semibold uppercase tracking-[.12em] text-primary">Selected day</p><h2 className="mt-1 text-[14px] font-semibold text-ink">{dateHeading(dateKey)}</h2><p className="mt-2 text-[11.5px] leading-relaxed text-muted">Nothing is recorded or scheduled for this date.</p>{canManageSchedules && <Link href="/work#scheduled-work" className="mt-3 inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-[11px] font-semibold text-primary hover:bg-primary-soft/60">Create a schedule<ArrowRight className="size-3.5" aria-hidden /></Link>}</section>}

            <section className="rounded-2xl border border-line bg-surface p-4 shadow-soft" aria-labelledby="calendar-upcoming-heading">
              <div className="flex items-start justify-between gap-2"><div><h2 id="calendar-upcoming-heading" className="text-[13px] font-semibold text-ink">Work in this period</h2><p className="mt-0.5 text-[10px] text-muted">Projected occurrences and recorded jobs</p></div><span className="rounded-full bg-surface-2 px-2 py-1 text-[9px] font-medium text-muted">{data.timezone}</span></div>
              {items.length === 0 ? <p className="mt-3 text-[11px] leading-relaxed text-muted">No entries appear in this calendar period.</p> : <div className="mt-3 space-y-2">{items.slice(0, 5).map((item) => <button key={item.key} type="button" onClick={() => selectItem(item)} className={cn("flex w-full items-start gap-2 rounded-xl border p-2.5 text-left hover:bg-surface-2", selectedKey === item.key ? "border-primary/30 bg-primary-soft/30" : "border-line")}><AgentAvatar role={AGENT_BY_KEY[roleOf(item)]} size="xs" /><span className="min-w-0 flex-1"><span className="block text-[10.5px] font-semibold text-ink">{titleOf(item)}</span><span className="mt-0.5 block text-[9.5px] text-muted">{employeeOf(item)} · {calendarTimestampLabel(item.startsAt, data.timezone)}</span><span className={cn("mt-1 inline-block rounded-full px-1.5 py-0.5 text-[8.5px] font-semibold uppercase tracking-wide", item.kind === "schedule" ? "bg-primary-soft text-primary-ink" : "bg-surface-2 text-ink-2")}>{item.kind === "schedule" ? "Scheduled · not a job" : item.job.statusLabel}</span></span></button>)}</div>}
            </section>

            {invalidSchedules.length > 0 && <section className="rounded-2xl border border-warning/25 bg-warning-soft/50 p-3.5" role="status"><p className="flex items-center gap-2 text-[11px] font-semibold text-warning-ink"><AlertTriangle className="size-3.5" aria-hidden />{invalidSchedules.length} schedule{invalidSchedules.length === 1 ? " has" : "s have"} a recurrence or time-zone issue</p><p className="mt-1 text-[10px] leading-relaxed text-warning-ink">Those schedules are omitted from projected calendar entries until their settings are corrected.</p></section>}

            <p className="flex items-start gap-2 px-1 text-[9.5px] leading-relaxed text-muted"><ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />Calendar entries do not prove that a job ran. Actual execution is linked to a persisted job with its own status and recorded results.</p>
          </aside>
        </div>
      </section>
    </div>
  );
}

