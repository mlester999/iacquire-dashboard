"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { useReducedMotion } from "motion/react";
import { AlertTriangle, ArrowRight, Ban, CheckCircle2, Clock3, ListPlus, RefreshCw, Search, ShieldCheck, Square, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/status";
import { EvidenceChip } from "@/components/chat/evidence-chip";
import { formatChatTime, fullTimestamp } from "@/lib/conversation-time";
import { createFindingTaskAction } from "@/app/actions/work";
import { cn } from "@/lib/utils";

/** A day, a clock time, or a weekday and time for one instant in a named zone (the browser's own zone when none is named); the ISO instant when the zone is not one the browser knows. */
function availabilityLabel(iso: string, timeZone: string | undefined, kind: "day" | "time" | "weekday-time"): string {
  const options: Intl.DateTimeFormatOptions = kind === "day"
    ? { weekday: "short", month: "short", day: "numeric" }
    : kind === "time"
      ? { hour: "numeric", minute: "2-digit", hour12: true }
      : { weekday: "short", hour: "numeric", minute: "2-digit", hour12: true };
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, ...options }).format(new Date(iso));
  } catch {
    return new Date(iso).toISOString();
  }
}

export interface WorkJobEvent {
  id: string;
  kind: "stage" | "progress" | "notice" | "evidence" | "error" | "approval";
  stage: string | null;
  stageLabel: string | null;
  message: string;
  createdAt: string;
}

export interface WorkJob {
  id: string;
  capability: string;
  title: string;
  status: "queued" | "running" | "waiting_for_approval" | "blocked" | "failed" | "cancelled" | "completed";
  statusLabel: string;
  recoveryPending: boolean;
  /** What kind of thing this work produced, as the server computed it. Missing, null or unreadable renders no chip. */
  evidence?: unknown;
  stage: string | null;
  stageLabel: string | null;
  progress: Record<string, unknown>;
  result: Record<string, unknown>;
  resultSummary: string | null;
  resultCount: number;
  failureCode: string | null;
  failureMessage: string | null;
  attempts: number;
  cancelRequested: boolean;
  canCancel: boolean;
  canRetry: boolean;
  canCreateTask: boolean;
  conversationId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  elapsedMs: number | null;
  events: WorkJobEvent[];
}

/** What each drafted message is doing now, as the server read it from the message itself (the job's own result only holds what was true when it finished). */
const DRAFT_STATUS: Record<string, { label: string; tone: "warning" | "violet" | "success" | "danger" | "neutral" }> = {
  waiting: { label: "Draft waiting", tone: "warning" },
  approved_queued: { label: "Approved, queued", tone: "violet" },
  sent: { label: "Sent", tone: "success" },
  blocked: { label: "Blocked", tone: "danger" },
  discarded: { label: "Discarded", tone: "neutral" },
  unknown: { label: "Status unavailable", tone: "neutral" },
};

interface DraftView {
  key: string;
  name: string;
  status: keyof typeof DRAFT_STATUS;
  detail: string | null;
  conversationId: string | null;
}

/** The drafts of a follow-up job that carry a live status. Anything else in the list (an older result, a malformed item) is left out rather than guessed. */
function liveDrafts(result: Record<string, unknown>): DraftView[] {
  if (!Array.isArray(result.drafts)) return [];
  const out: DraftView[] = [];
  for (const [index, item] of (result.drafts as unknown[]).entries()) {
    if (typeof item !== "object" || item === null) continue;
    const draft = item as Record<string, unknown>;
    if (typeof draft.liveStatus !== "string" || !(draft.liveStatus in DRAFT_STATUS)) continue;
    out.push({
      key: typeof draft.messageId === "string" ? draft.messageId : String(index),
      name: typeof draft.opportunityName === "string" && draft.opportunityName.trim() ? draft.opportunityName.trim().slice(0, 120) : "Follow-up draft",
      status: draft.liveStatus,
      detail: typeof draft.liveDetail === "string" && draft.liveDetail.trim() ? draft.liveDetail.trim().slice(0, 200) : null,
      conversationId: typeof draft.conversationId === "string" ? draft.conversationId : null,
    });
  }
  return out;
}

/** What a review looked at, from `result.examined`: a list of `{ label, count }`. Absent or malformed means there is nothing to show. */
function examinedItems(result: Record<string, unknown>): Array<{ label: string; count: number }> {
  if (!Array.isArray(result.examined)) return [];
  const out: Array<{ label: string; count: number }> = [];
  for (const item of result.examined as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const { label, count } = item as { label?: unknown; count?: unknown };
    if (typeof label !== "string" || !label.trim() || label.length > 60 || typeof count !== "number" || !Number.isInteger(count) || count < 0) continue;
    out.push({ label: label.trim(), count });
  }
  return out;
}

/** "120 deals", "1 deal, 3 contacts": the labels are plural nouns and a count of one reads in the singular. */
function examinedPhrase(items: ReadonlyArray<{ label: string; count: number }>): string {
  return items
    .map(({ label, count }) => (count === 1 ? `1 ${label.replace(/ies$/, "y").replace(/([^s])s$/, "$1")}` : `${count} ${label}`))
    .join(", ");
}

const TONE: Record<WorkJob["status"], "primary" | "success" | "warning" | "danger" | "neutral" | "violet"> = {
  queued: "neutral",
  running: "primary",
  waiting_for_approval: "violet",
  blocked: "warning",
  failed: "danger",
  cancelled: "neutral",
  completed: "success",
};

const ACTIVE = new Set<WorkJob["status"]>(["queued", "running", "waiting_for_approval"]);

function browserZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

function elapsedLabel(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function count(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

const PROGRESS_ITEMS: Array<[string, string]> = [
  ["searches", "search queries"],
  ["pagesReviewed", "source pages reviewed"],
  ["candidates", "candidates extracted"],
  ["evidenceBacked", "evidence-backed"],
  ["needsEvidence", "need more evidence"],
  ["duplicates", "duplicates flagged"],
];

/**
 * A persisted work-progress panel. It only renders data returned by the server job/event API and
 * polls while the job is genuinely active. It never shows a synthetic percentage, ETA or activity
 * that the worker did not record.
 */
export function WorkJobPanel({ jobId, className, compact = false, onDone }: { jobId: string; className?: string; compact?: boolean; onDone?: () => void }) {
  const reduced = useReducedMotion();
  const [job, setJob] = React.useState<WorkJob | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<"cancel" | "retry" | null>(null);
  const [showAllEvents, setShowAllEvents] = React.useState(false);
  const [taskBusy, setTaskBusy] = React.useState<string | null>(null);
  const [taskIds, setTaskIds] = React.useState<Record<string, string>>({});
  const zone = React.useMemo(() => browserZone(), []);
  const onDoneRef = React.useRef(onDone);
  React.useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  const load = React.useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch(`/api/work/jobs/${jobId}`, { cache: "no-store", signal });
      const body = (await res.json().catch(() => null)) as { job?: WorkJob; error?: string } | null;
      if (!res.ok || !body?.job) {
        setError(body?.error ?? "This work could not be loaded.");
        return null;
      }
      setError(null);
      setJob(body.job);
      return body.job;
    } catch (err) {
      if ((err as { name?: string })?.name !== "AbortError") setError("This work could not be loaded. The connection may have dropped.");
      return null;
    }
  }, [jobId]);

  React.useEffect(() => {
    const controller = new AbortController();
    let timer: number | null = null;
    let stopped = false;
    const tick = async () => {
      const next = await load(controller.signal);
      if (!next) {
        if (!stopped) timer = window.setTimeout(tick, 5000);
        return;
      }
      if (ACTIVE.has(next.status)) {
        timer = window.setTimeout(tick, next.status === "running" ? 2500 : 4000);
      } else {
        onDoneRef.current?.();
      }
    };
    void tick();
    const onVisibility = () => {
      if (document.visibilityState === "visible" && !stopped) void load(controller.signal);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      controller.abort();
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  const act = async (action: "cancel" | "retry") => {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(`/api/work/jobs/${jobId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) setError(body?.error ?? "That action couldn't be completed.");
      else await load();
    } catch {
      setError("That action couldn't be completed. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  };

  const createTask = async (findingKey: string) => {
    if (taskBusy) return;
    setTaskBusy(findingKey);
    const res = await createFindingTaskAction(jobId, findingKey);
    setTaskBusy(null);
    if (!res.ok) return toast.error(res.error);
    setTaskIds((current) => ({ ...current, [findingKey]: res.data.taskId }));
    toast.success(res.data.created ? "Follow-up task created" : "That task already exists", {
      description: res.data.created ? "It is assigned to you in CRM Tasks." : "No duplicate was created.",
    });
  };

  if (!job) {
    return (
      <div className={cn("rounded-2xl border border-line bg-surface-2/40 px-4 py-3", className)} aria-busy={!error}>
        {error ? (
          <p className="flex items-start gap-2 text-[12.5px] text-danger-ink"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />{error}</p>
        ) : (
          <p className="flex items-center gap-2 text-[12.5px] text-muted"><Clock3 className="size-4 shrink-0" aria-hidden />Loading the recorded work status…</p>
        )}
      </div>
    );
  }

  const elapsed = elapsedLabel(job.elapsedMs);
  const counts = PROGRESS_ITEMS.map(([key, label]) => [label, count(job.progress[key])] as const).filter(([, value]) => value !== null);
  const events = showAllEvents ? job.events : job.events.slice(-5);
  const findings = Array.isArray(job.result.findings) ? (job.result.findings as Array<{
    key?: string; severity?: string; title?: string; detail?: string; count?: number; samples?: string[]; evidenceHref?: string; recommendedAction?: string;
  }>).filter((item) => typeof item.title === "string") : [];
  const metrics = Array.isArray(job.result.metrics) ? (job.result.metrics as Array<{
    key?: string; label?: string; value?: number | string; unit?: string; period?: string; definition?: string; source?: string;
    previous?: number | null; change?: number | null; changePct?: number | null; trend?: "up" | "down" | "flat";
    comparisonPeriod?: string; higherIsBetter?: boolean;
  }>).filter((item) => typeof item.label === "string") : [];
  const availability = job.result.availability && typeof job.result.availability === "object"
    ? (job.result.availability as {
        slots?: Array<{ start: string; end: string }>;
        timeZone?: string;
        /** The zone the times are read in: the calendar hosts' zone when they share one, otherwise the workspace's. Older results have only `timeZone`. */
        displayTimeZone?: string;
        total?: number;
        truncated?: boolean;
        days?: Array<{ date: string; weekday: string; count: number; firstStart: string; lastStart: string }>;
      })
    : null;
  const availableSlots = (availability?.slots ?? []).slice(0, 12);
  const availabilityDays = Array.isArray(availability?.days) ? availability.days : [];
  const availabilityZone = availability?.displayTimeZone || availability?.timeZone || zone;
  // What this kind of work does, so the footer never promises "research" or a lead list for a calendar, pipeline or CRM review.
  const leadResearch = job.capability === "lead_research";
  const drafts = liveDrafts(job.result);
  const examined = examinedItems(job.result);
  // Once a person has approved a draft the job's own "nothing was sent" is no longer something to promise; the list says where each draft stands.
  const draftsApproved = drafts.some((draft) => draft.status === "sent" || draft.status === "approved_queued");
  const footerNote = leadResearch
    ? "Read-only research. CRM imports and outreach need your approval."
    : job.capability === "pipeline_followup_drafts"
      ? draftsApproved
        ? "A draft is sent only after a person approves it. The list shows where each one stands now."
        : "Drafts stay unsent until a person reviews them. Nothing was sent."
      : "Read-only review. Nothing was changed, booked or sent.";
  const running = job.status === "running" && !job.recoveryPending;

  return (
    <section className={cn("overflow-hidden rounded-2xl border border-line bg-surface-2/40", className)} aria-label="Work progress" aria-live="polite">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line/70 px-4 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone={job.recoveryPending ? "warning" : TONE[job.status]} size="sm" dot={running}>
              {job.statusLabel}
            </StatusPill>
            <EvidenceChip evidence={job.evidence} timeZone={zone} />
            {elapsed && job.startedAt && !job.recoveryPending && <span className="text-[12px] tabular-nums text-muted">{running ? `${elapsed} elapsed` : `Finished in ${elapsed}`}</span>}
            {job.cancelRequested && job.status === "running" && <span className="text-[12px] text-warning-ink">Stop requested</span>}
          </div>
          <p className="mt-1.5 truncate text-[14px] font-semibold text-ink" title={job.title}>{job.title}</p>
          <p className="mt-0.5 text-[13px] leading-relaxed text-muted">
            {job.recoveryPending
              ? "No active worker lease is recorded. This job is waiting for recovery; no completion has been recorded."
              : running
              ? job.stageLabel ?? "Working on the next recorded step…"
              : job.status === "queued"
                ? "Queued. The worker has not started this work yet."
                : job.status === "completed"
                  ? job.resultSummary ?? "Work completed."
                  : job.status === "failed" || job.status === "blocked"
                    ? "The work did not complete. The recorded reason is shown below."
                    : job.resultSummary ?? "No further detail was recorded."}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {job.canCancel && (
            <Button size="sm" variant="secondary" onClick={() => act("cancel")} disabled={busy !== null}>
              {busy === "cancel" ? <RefreshCw className="size-3.5 animate-spin" aria-hidden /> : <Square className="size-3.5" aria-hidden />}
              Stop
            </Button>
          )}
          {job.canRetry && (
            <Button size="sm" variant="secondary" onClick={() => act("retry")} disabled={busy !== null}>
              <RefreshCw className={cn("size-3.5", busy === "retry" && "animate-spin")} aria-hidden /> Retry
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-3 px-4 py-3">
        {running && (
          <div className="flex items-center gap-2 text-[12px] text-muted" role="status">
            <span className={cn("relative flex size-2", !reduced && "motion-safe:animate-pulse")} aria-hidden>
              <span className="absolute inline-flex size-2 rounded-full bg-primary/60" />
            </span>
            Working. The completion time is uncertain until the next recorded stage.
          </div>
        )}

        {counts.length > 0 && (
          <dl className="flex flex-wrap gap-x-4 gap-y-1.5">
            {counts.map(([label, value]) => (
              <div key={label} className="flex items-baseline gap-1.5">
                <dt className="order-2 text-[12px] text-muted">{label}</dt>
                <dd className="order-1 text-[13px] font-semibold tabular-nums text-ink">{value}</dd>
              </div>
            ))}
          </dl>
        )}

        {examined.length > 0 && (
          <p className="text-[12px] text-muted" data-testid="work-examined">
            Checked {examinedPhrase(examined)}.
          </p>
        )}

        {drafts.length > 0 && (
          <div>
            <p className="mb-1.5 text-[12px] font-semibold uppercase tracking-[.08em] text-faint">Follow-up drafts</p>
            <ul className="space-y-1">
              {drafts.map((draft) => {
                const state = DRAFT_STATUS[draft.status];
                return (
                  <li key={draft.key} className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-xl border border-line bg-surface px-3 py-1.5 text-[12px] text-ink-2">
                    <span className="min-w-0 flex-1 truncate font-medium text-ink" title={draft.name}>{draft.name}</span>
                    <StatusPill tone={state.tone} size="sm">{draft.status === "blocked" && draft.detail ? `Blocked: ${draft.detail}` : state.label}</StatusPill>
                    {draft.conversationId && <Link href={`/inbox?conversation=${encodeURIComponent(draft.conversationId)}`} className="font-semibold text-primary hover:underline">Open in Inbox</Link>}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {metrics.length > 0 && (
          <div>
            <p className="mb-1.5 text-[12px] font-semibold uppercase tracking-[.08em] text-faint">Measured KPIs</p>
            <dl className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
              {metrics.map((metric, index) => (
                <div key={metric.key ?? index} className="rounded-xl border border-line bg-surface-2/40 px-3 py-2" title={[metric.definition, metric.period, metric.source ? `Source: ${metric.source}` : null].filter(Boolean).join(" · ")}>
                  <dt className="text-[12px] leading-snug text-muted">{metric.label}</dt>
                  <dd className="mt-0.5 text-[15px] font-semibold tabular-nums text-ink">
                    {typeof metric.value === "number" ? metric.value.toLocaleString() : metric.value ?? "—"}
                    {metric.unit && <span className="ml-0.5 text-[12px] font-normal text-muted">{metric.unit}</span>}
                  </dd>
                  {metric.period && <p className="mt-0.5 text-[12px] leading-snug text-faint">{metric.period}</p>}
                  {metric.trend && metric.previous !== null && metric.previous !== undefined && (
                    <p
                      className={cn(
                        "mt-0.5 text-[12px] leading-snug",
                        metric.trend === "flat"
                          ? "text-muted"
                          : (metric.trend === "up") === (metric.higherIsBetter !== false)
                            ? "text-success-ink"
                            : "text-warning-ink",
                      )}
                      title={`Previous period: ${metric.previous}${metric.comparisonPeriod ? ` (${metric.comparisonPeriod})` : ""}`}
                    >
                      {metric.trend === "up" ? "↑" : metric.trend === "down" ? "↓" : "→"}{" "}
                      {metric.changePct !== null && metric.changePct !== undefined ? `${Math.abs(metric.changePct)}%` : `${Math.abs(metric.change ?? 0)}`}
                      {metric.comparisonPeriod ? ` vs ${metric.comparisonPeriod.toLowerCase()}` : ""}
                    </p>
                  )}
                </div>
              ))}
            </dl>
          </div>
        )}

        {(availabilityDays.length > 0 || availableSlots.length > 0) && (
          <div>
            <p className="mb-1.5 text-[12px] font-semibold uppercase tracking-[.08em] text-faint">Real bookable availability</p>
            {availabilityDays.length > 0 ? (
              <ul className="space-y-1">
                {availabilityDays.map((day) => (
                  <li key={day.date} className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 rounded-xl border border-line bg-surface px-3 py-1.5 text-[12px] text-ink-2">
                    <span className="font-semibold text-ink">{availabilityLabel(day.firstStart, availabilityZone, "day")}</span>
                    <span className="tabular-nums">{day.count} open time{day.count === 1 ? "" : "s"}</span>
                    <span className="tabular-nums text-muted">first {availabilityLabel(day.firstStart, availabilityZone, "time")}, last start {availabilityLabel(day.lastStart, availabilityZone, "time")}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <ul className="flex flex-wrap gap-1.5">
                {availableSlots.map((slot) => (
                  <li key={slot.start} className="rounded-full border border-line bg-surface px-2.5 py-1 text-[12px] tabular-nums text-ink-2">
                    {availabilityLabel(slot.start, availabilityZone, "weekday-time")}
                  </li>
                ))}
              </ul>
            )}
            {availability?.truncated && <p className="mt-1 text-[12px] text-faint">The calendar holds more open times than this list can count.</p>}
            <p className="mt-1 text-[12px] text-faint">{availabilityZone ? `Times shown in ${availabilityZone}. ` : ""}Nothing has been held or booked.</p>
          </div>
        )}

        {job.capability === "appointment_availability" && job.status === "completed" && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-line bg-surface px-3 py-2.5">
            <span className="text-[12px] text-ink-2">To continue, choose a contact and time in the booking flow. Availability is checked again before any booking.</span>
            <Link href="/appointments" className="inline-flex items-center gap-1 text-[12px] font-semibold text-primary hover:underline">
              Open appointments <ArrowRight className="size-3.5" aria-hidden />
            </Link>
          </div>
        )}

        {findings.length > 0 && (
          <div className="space-y-2">
            <p className="text-[12px] font-semibold uppercase tracking-[.08em] text-faint">Findings and recommended actions</p>
            <ul className="space-y-1.5">
              {findings.map((item, index) => {
                const tone = item.severity === "critical" ? "border-danger/25 bg-danger-soft/30" : item.severity === "warning" ? "border-warning/25 bg-warning-soft/30" : "border-line bg-surface-2/40";
                return (
                  <li key={item.key ?? index} className={cn("rounded-xl border px-3 py-2.5", tone)}>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="min-w-0 flex-1 text-[12.5px] font-semibold text-ink">{item.title}</p>
                      {typeof item.count === "number" && item.count > 0 && <StatusPill tone={item.severity === "critical" ? "danger" : item.severity === "warning" ? "warning" : "neutral"} size="sm">{item.count}</StatusPill>}
                    </div>
                    {item.detail && <p className="mt-1 text-[12px] leading-relaxed text-ink-2">{item.detail}</p>}
                    {Boolean(item.samples?.length) && (
                      <p className="mt-1 text-[12px] leading-relaxed text-muted">Examples: {item.samples!.join("; ")}</p>
                    )}
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
                      {item.recommendedAction && <span className="text-ink-2"><span className="font-medium">Next:</span> {item.recommendedAction}</span>}
                      {item.evidenceHref && <Link href={item.evidenceHref} className="font-semibold text-primary hover:underline">Open evidence</Link>}
                      {job.canCreateTask && item.key && (
                        taskIds[item.key]
                          ? <Link href={`/crm/tasks?task=${taskIds[item.key]}`} className="inline-flex items-center gap-1 font-semibold text-success-ink hover:underline"><CheckCircle2 className="size-3.5" aria-hidden /> Task created</Link>
                          : (
                            <button
                              type="button"
                              onClick={() => createTask(item.key!)}
                              disabled={taskBusy !== null}
                              className="inline-flex items-center gap-1 font-semibold text-primary hover:underline disabled:opacity-50"
                            >
                              <ListPlus className="size-3.5" aria-hidden /> {taskBusy === item.key ? "Creating task…" : "Create follow-up task"}
                            </button>
                          )
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {job.failureMessage && (job.status === "failed" || job.status === "blocked") && (
          <p className="flex items-start gap-2 rounded-xl bg-danger-soft/40 px-3 py-2 text-[12.5px] leading-relaxed text-danger-ink">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            {job.failureMessage}
          </p>
        )}

        {events.length > 0 && (
          <div>
            <p className="mb-1.5 text-[12px] font-semibold uppercase tracking-[.08em] text-faint">Recorded activity</p>
            <ol className="space-y-1.5 border-l border-line pl-3">
              {events.map((event) => (
                <li key={event.id} className="relative text-[12px] leading-relaxed text-ink-2">
                  <span
                    className={cn(
                      "absolute -left-[17px] top-1.5 size-1.5 rounded-full",
                      event.kind === "error" ? "bg-danger" : event.kind === "progress" ? "bg-primary" : event.kind === "notice" ? "bg-success" : "bg-faint",
                    )}
                    aria-hidden
                  />
                  <span title={fullTimestamp(event.createdAt, zone)} className="mr-1.5 tabular-nums text-faint">{formatChatTime(event.createdAt, zone)}</span>
                  {event.message}
                </li>
              ))}
            </ol>
            {job.events.length > 5 && !compact && (
              <button type="button" onClick={() => setShowAllEvents((value) => !value)} className="mt-1.5 text-[12px] font-medium text-primary hover:underline">
                {showAllEvents ? "Show recent activity" : `Show all ${job.events.length} recorded events`}
              </button>
            )}
          </div>
        )}

        {error && <p className="text-[12px] text-danger-ink" role="alert">{error}</p>}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line/70 pt-2.5 text-[12px] text-muted">
          <span className="inline-flex items-center gap-1"><ShieldCheck className="size-3.5 text-success-ink" aria-hidden /> {footerNote}</span>
          {job.status === "completed" && leadResearch && job.resultCount > 0 && (
            <Link href="/leads?tab=review" className="inline-flex items-center gap-1 font-semibold text-primary hover:underline">
              Review {job.resultCount} lead{job.resultCount === 1 ? "" : "s"} <ArrowRight className="size-3.5" aria-hidden />
            </Link>
          )}
          {job.status === "completed" && job.capability === "lead_generation_review" && (
            <Link href="/leads?tab=review" className="inline-flex items-center gap-1 font-semibold text-primary hover:underline">
              Open the lead review queue <ArrowRight className="size-3.5" aria-hidden />
            </Link>
          )}
          {job.status === "failed" && <span className="inline-flex items-center gap-1"><XCircle className="size-3.5" aria-hidden />Nothing was reported as successful.</span>}
          {job.status === "cancelled" && <span className="inline-flex items-center gap-1"><Ban className="size-3.5" aria-hidden />Work stopped. Partial evidence remains in the activity log.</span>}
          {job.status === "completed" && <span className="inline-flex items-center gap-1"><CheckCircle2 className="size-3.5" aria-hidden />Saved with execution evidence.</span>}
        </div>
      </div>
    </section>
  );
}

/** Compact inline activity used while a job is still discovering candidates. */
export function WorkJobInlineActivity({ jobId }: { jobId: string }) {
  const [job, setJob] = React.useState<WorkJob | null>(null);
  React.useEffect(() => {
    let stopped = false;
    let timer: number | null = null;
    const load = async () => {
      const res = await fetch(`/api/work/jobs/${jobId}`, { cache: "no-store" }).catch(() => null);
      const body = res ? ((await res.json().catch(() => null)) as { job?: WorkJob } | null) : null;
      if (stopped) return;
      if (body?.job) setJob(body.job);
      if (body?.job && ACTIVE.has(body.job.status)) timer = window.setTimeout(load, 2500);
    };
    void load();
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [jobId]);
  if (!job) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-muted">
      <Search className="size-3.5" aria-hidden />
      {job.statusLabel}{job.recoveryPending ? " · waiting for worker recovery" : job.stageLabel ? ` · ${job.stageLabel}` : ""}
    </span>
  );
}
