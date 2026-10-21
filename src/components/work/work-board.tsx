"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Activity, AlertTriangle, ArrowRight, CalendarClock, CheckCircle2, Clock3, ListChecks, Loader2, Play, ShieldCheck, Sparkles, Trash2, XCircle } from "lucide-react";
import { AgentAvatar } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { EmptyState, Select } from "@/components/ui/primitives";
import { StatusPill, InfoChip } from "@/components/ui/status";
import { Switch } from "@/components/ui/overlays";
import { MetricCard, PageHero } from "@/components/ui/workspace";
import { IconTile, Panel } from "@/components/overview/panel";
import { WorkJobPanel } from "@/components/work/job-progress";
import { deleteScheduleAction, saveScheduleAction, setScheduleEnabledAction, startReviewAction } from "@/app/actions/work";
import { AGENT_BY_KEY, isAgentRoleKey } from "@/lib/agents";
import { formatDateTime, relativeTime, sentenceCase } from "@/lib/utils";
import type { ScheduleView } from "@/server/workforce/schedules";
import type { WorkBoardCapabilityAction } from "@/lib/workforce-capabilities";
import type { WorkBoardJob, WorkBoardSummary, WorkBoardFilter } from "@/server/workforce/work-board";

const FILTERS: Array<{ key: WorkBoardFilter; label: string }> = [
  { key: "all", label: "All work" },
  { key: "active", label: "Active" },
  { key: "attention", label: "Needs attention" },
  { key: "completed", label: "Completed" },
];

const STATUS_TONE: Record<string, "primary" | "success" | "warning" | "danger" | "neutral" | "violet"> = {
  queued: "neutral",
  running: "primary",
  waiting_for_approval: "violet",
  blocked: "warning",
  failed: "danger",
  cancelled: "neutral",
  completed: "success",
};

function roleMeta(role: string) {
  return isAgentRoleKey(role) ? AGENT_BY_KEY[role] : null;
}

function jobHref(job: WorkBoardJob): string | null {
  const meta = roleMeta(job.employeeRole);
  if (!meta) return null;
  if (job.conversationId) return `/chat/${meta.slug}?c=${job.conversationId}`;
  if (job.capability === "lead_research") return "/leads?tab=review";
  return `/employees/${meta.slug}`;
}

export function WorkBoard({
  jobs,
  summary,
  filter,
  reviewActions,
  schedules,
  canManageSchedules,
  scheduleOperatorEnabled,
  timeZone,
  focusJobId,
}: {
  jobs: WorkBoardJob[];
  summary: WorkBoardSummary;
  filter: WorkBoardFilter;
  reviewActions: WorkBoardCapabilityAction[];
  schedules: ScheduleView[];
  canManageSchedules: boolean;
  scheduleOperatorEnabled: boolean;
  timeZone: string;
  focusJobId: string | null;
}) {
  const router = useRouter();
  const [expanded, setExpanded] = React.useState<string | null>(focusJobId);
  const [starting, setStarting] = React.useState(false);
  const [selectedCapability, setSelectedCapability] = React.useState<string>(() => {
    return reviewActions.find((action) => action.available)?.capability ?? reviewActions[0]?.capability ?? "";
  });
  const selected = reviewActions.find((action) => action.capability === selectedCapability) ?? reviewActions[0] ?? null;
  const [scheduleCapability, setScheduleCapability] = React.useState<string>(() => reviewActions[0]?.capability ?? "");
  const [scheduleCadence, setScheduleCadence] = React.useState<"hourly" | "daily" | "weekly">("daily");
  const [scheduleBusy, setScheduleBusy] = React.useState<string | null>(null);

  const saveSchedule = async () => {
    if (!scheduleCapability || scheduleBusy) return;
    setScheduleBusy("save");
    const res = await saveScheduleAction(scheduleCapability, scheduleCadence);
    setScheduleBusy(null);
    if (!res.ok) return toast.error(res.error);
    toast.success("Schedule saved paused", { description: "Enable it when you are ready. It still only runs when the operator switch is on." });
    router.refresh();
  };

  const toggleSchedule = async (id: string, enabled: boolean) => {
    if (scheduleBusy) return;
    setScheduleBusy(id);
    const res = await setScheduleEnabledAction(id, enabled);
    setScheduleBusy(null);
    if (!res.ok) return toast.error(res.error);
    toast.success(enabled ? "Schedule enabled" : "Schedule paused", {
      description: enabled && !scheduleOperatorEnabled
        ? "It will not run until the operator enables AI workforce schedules."
        : "The change is recorded in the audit trail.",
    });
    router.refresh();
  };

  const removeSchedule = async (id: string) => {
    if (scheduleBusy) return;
    if (typeof window !== "undefined" && !window.confirm("Delete this schedule? It will stop creating new reviews. Existing jobs and evidence are kept.")) return;
    setScheduleBusy(id);
    const res = await deleteScheduleAction(id);
    setScheduleBusy(null);
    if (!res.ok) return toast.error(res.error);
    toast.success("Schedule deleted");
    router.refresh();
  };

  const startReview = async () => {
    if (!selected?.available || starting) return;
    setStarting(true);
    const res = await startReviewAction(selected.capability);
    setStarting(false);
    if (!res.ok) return toast.error(res.error);
    toast.success(`${selected.label} started`, { description: "The employee reads only persisted records and records its findings. No record is changed." });
    setExpanded(res.data.jobId);
    router.refresh();
  };

  return (
    <div className="module-stack space-y-6">
      <PageHero
        tone="dark"
        eyebrow="AI Work Board"
        title="See the work, not a spinner."
        description="Every item below is a persisted AI employee job with its real status, stage and recorded activity. Read-only reviews and research appear here; nothing is marked completed without execution evidence."
        icon={<ListChecks />}
        aside={
          <div className="space-y-2">
            {reviewActions.length > 0 ? (
              <>
                <label htmlFor="work-review" className="block text-[11.5px] font-semibold uppercase tracking-[.08em] text-muted">Review to run</label>
                <Select id="work-review" value={selected?.capability ?? ""} onChange={(event) => setSelectedCapability(event.target.value)} className="min-w-[16rem]">
                  {reviewActions.map((action) => (
                    <option key={action.capability} value={action.capability}>{action.label} · {action.employeeName}</option>
                  ))}
                </Select>
                <Button variant="brand" onClick={startReview} loading={starting} disabled={!selected?.available || starting}>
                  {starting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Play className="size-4" aria-hidden />}
                  Start review
                </Button>
                <p className="max-w-[28rem] text-[12px] leading-relaxed text-muted">
                  {selected?.reason ?? selected?.description ?? "Choose a read-only review to run."} It does not change records, contact a provider or create a schedule.
                </p>
              </>
            ) : (
              <p className="max-w-[28rem] text-[12px] leading-relaxed text-muted">No reviewed review capability is available for your role in this workspace.</p>
            )}
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricCard label="Running now" value={summary.active} detail="Persisted running jobs" icon={<Activity />} tone="violet" />
        <MetricCard label="Waiting for approval" value={summary.waiting} detail="A person must decide" icon={<ShieldCheck />} tone="amber" />
        <MetricCard label="Needs attention" value={summary.failed} detail="Failed jobs" icon={<AlertTriangle />} tone="amber" />
        <MetricCard label="Completed today" value={summary.completedToday} detail="In this workspace's time zone" icon={<CheckCircle2 />} tone="green" />
      </div>

      <nav className="flex flex-wrap items-center gap-1.5" aria-label="Filter AI work">
        {FILTERS.map((item) => (
          <Link
            key={item.key}
            href={item.key === "all" ? "/work" : `/work?status=${item.key}`}
            aria-current={filter === item.key ? "page" : undefined}
            className={
              filter === item.key
                ? "inline-flex min-h-9 items-center rounded-xl bg-primary-soft px-3 text-[12.5px] font-semibold text-primary-ink ring-1 ring-inset ring-primary/20"
                : "inline-flex min-h-9 items-center rounded-xl px-3 text-[12.5px] font-medium text-muted hover:bg-surface-2 hover:text-ink"
            }
          >
            {item.label}
          </Link>
        ))}
        <span className="ml-auto text-[11.5px] text-muted">{jobs.length} item{jobs.length === 1 ? "" : "s"} in this view</span>
      </nav>

      {canManageSchedules && (
        <Panel
          icon={<CalendarClock />}
          tone="neutral"
          title="Scheduled reviews"
          description="A schedule creates a durable job on its cadence. It only runs when both the row and the operator switch are enabled."
          action={
            <StatusPill tone={scheduleOperatorEnabled ? "success" : "warning"} size="sm">
              {scheduleOperatorEnabled ? "Operator switch on" : "Operator switch off"}
            </StatusPill>
          }
        >
          <div className="space-y-4">
            <div className="flex flex-wrap items-end gap-2">
              <label className="block min-w-[15rem] flex-1 text-[12px] font-medium text-ink-2">
                Review
                <Select className="mt-1" value={scheduleCapability} onChange={(event) => setScheduleCapability(event.target.value)} disabled={!reviewActions.length}>
                  {reviewActions.map((action) => (
                    <option key={action.capability} value={action.capability}>{action.label} · {action.employeeName}</option>
                  ))}
                </Select>
              </label>
              <label className="block text-[12px] font-medium text-ink-2">
                Cadence
                <Select className="mt-1" value={scheduleCadence} onChange={(event) => setScheduleCadence(event.target.value as "hourly" | "daily" | "weekly")}>
                  <option value="hourly">Hourly</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                </Select>
              </label>
              <Button variant="secondary" onClick={saveSchedule} loading={scheduleBusy === "save"} disabled={!scheduleCapability || scheduleBusy !== null}>
                Save paused schedule
              </Button>
            </div>
            {!scheduleOperatorEnabled && (
              <p role="status" className="rounded-xl border border-warning/25 bg-warning-soft/40 px-3 py-2 text-[12px] leading-relaxed text-warning-ink">
                The operator switch is off (<code className="font-mono text-[11px]">WORKFORCE_SCHEDULES_ENABLED</code>), so no schedule creates work even when its row is enabled. This is deliberate.
              </p>
            )}
            {schedules.length === 0 ? (
              <p className="text-[12.5px] text-muted">No schedules yet. Saving one is always paused first.</p>
            ) : (
              <ul className="divide-y divide-line rounded-xl border border-line">
                {schedules.map((schedule) => (
                  <li key={schedule.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                    <Switch
                      checked={schedule.enabled}
                      disabled={scheduleBusy !== null}
                      onCheckedChange={(next) => toggleSchedule(schedule.id, next)}
                      aria-label={`${schedule.enabled ? "Pause" : "Enable"} ${schedule.capabilityLabel} schedule`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12.5px] font-semibold text-ink">{schedule.capabilityLabel} · {schedule.employeeName}</p>
                      <p className="mt-0.5 text-[11.5px] text-muted" suppressHydrationWarning>
                        {sentenceCase(schedule.cadence)} · next {formatDateTime(schedule.nextRunAt, timeZone)}
                        {schedule.lastRunAt ? ` · last ran ${relativeTime(schedule.lastRunAt)}` : " · not run yet"}
                        {schedule.enabled && !scheduleOperatorEnabled ? " · paused by operator" : ""}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeSchedule(schedule.id)}
                      disabled={scheduleBusy !== null}
                      className="inline-flex size-8 items-center justify-center rounded-lg text-muted hover:bg-danger-soft hover:text-danger-ink disabled:opacity-50"
                      aria-label={`Delete ${schedule.capabilityLabel} schedule`}
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Panel>
      )}

      <Panel icon={<Sparkles />} tone="violet" title="Work queue" description="Tap an item to inspect its recorded stages and events." bodyClassName="px-0 pb-0 pt-3">
        {jobs.length === 0 ? (
          <div className="px-5 pb-5">
            <EmptyState
              icon={<ListChecks className="size-5" />}
              title={filter === "all" ? "No AI work yet" : "Nothing in this view"}
              description={
                filter === "all"
                  ? "Start a Lead Hunter research request or an on-demand operations review. Real work appears here with its persisted status."
                  : "Try another filter, or start a new review if you have access."
              }
            />
          </div>
        ) : (
          <ul className="divide-y divide-line border-t border-line">
            {jobs.map((job) => {
              const meta = roleMeta(job.employeeRole);
              const href = jobHref(job);
              const open = expanded === job.id;
              return (
                <li key={job.id}>
                  <div className="flex items-start gap-3 px-5 py-3.5 transition-colors hover:bg-surface-2/40">
                    {meta ? <AgentAvatar role={meta} size="sm" /> : <IconTile tone="violet" size="sm"><Sparkles /></IconTile>}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusPill tone={STATUS_TONE[job.status] ?? "neutral"} size="sm" dot={job.status === "running"}>
                          {job.statusLabel}
                        </StatusPill>
                        <span className="text-[11.5px] text-muted">{job.employeeName}</span>
                        {job.capability === "proactive_review" && job.status === "completed" && <InfoChip icon={<ShieldCheck />}>Read-only review</InfoChip>}
                      </div>
                      <button
                        type="button"
                        onClick={() => setExpanded(open ? null : job.id)}
                        aria-expanded={open}
                        className="mt-1 block w-full text-left"
                      >
                        <span className="block truncate text-[13.5px] font-semibold text-ink" title={job.title}>{job.title}</span>
                        <span className="mt-0.5 block text-[12px] leading-relaxed text-muted">
                          {job.status === "running" ? job.stageLabel ?? "Working…" : job.resultSummary ?? job.failureMessage ?? job.stageLabel ?? "No further detail recorded."}
                        </span>
                      </button>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <InfoChip icon={<Clock3 />}><span suppressHydrationWarning>{formatDateTime(job.createdAt, timeZone)}</span></InfoChip>
                        {job.latestEvent && <span className="text-[11.5px] text-faint" suppressHydrationWarning>Latest: {relativeTime(job.latestEvent.createdAt)}</span>}
                        {job.resultCount > 0 && <InfoChip icon={<CheckCircle2 />}>{job.resultCount} result{job.resultCount === 1 ? "" : "s"}</InfoChip>}
                        {job.failureMessage && job.status === "failed" && <InfoChip icon={<XCircle />}>Failure recorded</InfoChip>}
                      </div>
                      {job.latestEvent && (
                        <p className="mt-1 line-clamp-2 text-[11.5px] leading-relaxed text-faint" suppressHydrationWarning>
                          Latest recorded: {job.latestEvent.message} · {relativeTime(job.latestEvent.createdAt)}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {href && <Link href={href} className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-[11.5px] font-semibold text-primary hover:bg-primary-soft/50 hover:underline">{job.capability === "lead_research" ? "Review" : "Open"} <ArrowRight className="size-3.5" aria-hidden /></Link>}
                      <button
                        type="button"
                        onClick={() => setExpanded(open ? null : job.id)}
                        className="inline-flex min-h-8 items-center rounded-lg px-2 text-[11.5px] font-medium text-muted hover:bg-surface-2 hover:text-ink"
                        aria-expanded={open}
                      >
                        {open ? "Hide activity" : "Activity"}
                      </button>
                    </div>
                  </div>
                  {open && (
                    <div className="px-5 pb-4">
                      <WorkJobPanel jobId={job.id} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}
