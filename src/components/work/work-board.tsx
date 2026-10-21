"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Activity, AlertTriangle, ArrowRight, CheckCircle2, Clock3, ListChecks, Loader2, Play, ShieldCheck, Sparkles, XCircle } from "lucide-react";
import { AgentAvatar } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { EmptyState, Select } from "@/components/ui/primitives";
import { StatusPill, InfoChip } from "@/components/ui/status";
import { MetricCard, PageHero } from "@/components/ui/workspace";
import { IconTile, Panel } from "@/components/overview/panel";
import { WorkJobPanel } from "@/components/work/job-progress";
import { startReviewAction } from "@/app/actions/work";
import { AGENT_BY_KEY, isAgentRoleKey } from "@/lib/agents";
import { formatDateTime, relativeTime } from "@/lib/utils";
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
  timeZone,
  focusJobId,
}: {
  jobs: WorkBoardJob[];
  summary: WorkBoardSummary;
  filter: WorkBoardFilter;
  reviewActions: WorkBoardCapabilityAction[];
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
