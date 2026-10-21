"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  BellRing,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleSlash,
  Clock3,
  Lightbulb,
  ListChecks,
  ListPlus,
  Radar,
  ShieldCheck,
  Sparkles,
  Sunrise,
  XCircle,
} from "lucide-react";
import { AgentAvatar } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/primitives";
import { InfoChip, StatusPill } from "@/components/ui/status";
import { Panel } from "@/components/overview/panel";
import { acknowledgeReportAction, createFindingTaskAction } from "@/app/actions/work";
import { AGENT_BY_KEY, isAgentRoleKey } from "@/lib/agents";
import {
  PROACTIVE_DUTIES,
  PROACTIVE_KIND_LABELS,
  PROACTIVE_SEVERITY_LABELS,
  type ProactiveReportKind,
  type ProactiveSeverity,
} from "@/lib/proactive";
import { cn, formatDateTime, relativeTime } from "@/lib/utils";
import type { MonitoringStatus, ProactiveReportView } from "@/server/workforce/reports";

const SEVERITY_TONE: Record<ProactiveSeverity, "danger" | "warning" | "primary"> = {
  critical: "danger",
  warning: "warning",
  info: "primary",
};

const KIND_ICON: Record<ProactiveReportKind, React.ReactNode> = {
  alert: <AlertTriangle />,
  recommendation: <Lightbulb />,
  completion: <CheckCircle2 />,
  blocker: <CircleSlash />,
  approval_request: <ShieldCheck />,
  daily_briefing: <Sunrise />,
  weekly_summary: <BarChart3 />,
};

function reportIcon(kind: ProactiveReportKind) {
  return KIND_ICON[kind] ?? <BellRing />;
}

function reportHref(report: ProactiveReportView): string | null {
  if (report.jobId) return `/work?job=${report.jobId}&report=${report.id}`;
  return null;
}

function deliveryNote(report: ProactiveReportView): { label: string; tone: "neutral" | "warning" | "primary" } | null {
  if (report.deliveryStatus === "held") return { label: "Held for quiet hours", tone: "warning" };
  if (report.deliveryStatus === "digest") return { label: "In your daily digest", tone: "primary" };
  if (report.deliveryStatus === "suppressed") return { label: "Notification filtered", tone: "neutral" };
  return null;
}

function ReportCard({ report, timeZone, focus }: { report: ProactiveReportView; timeZone: string; focus: boolean }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(focus);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [taskIds, setTaskIds] = React.useState<Record<string, string>>({});
  const meta = report.employeeRole && isAgentRoleKey(report.employeeRole) ? AGENT_BY_KEY[report.employeeRole] : null;
  const note = deliveryNote(report);
  const autoTask = report.actions.find((action) => action.type === "task_created" && action.taskId);
  const href = reportHref(report);
  const findings = report.findings.slice(0, 8);

  const acknowledge = async () => {
    if (busy) return;
    setBusy("acknowledge");
    const res = await acknowledgeReportAction(report.id);
    setBusy(null);
    if (!res.ok) return toast.error(res.error);
    toast.success(res.data.acknowledged ? "Report acknowledged" : "Already acknowledged");
    router.refresh();
  };

  const createTask = async (findingKey: string) => {
    if (!report.jobId || busy) return;
    setBusy(findingKey);
    const res = await createFindingTaskAction(report.jobId, findingKey);
    setBusy(null);
    if (!res.ok) return toast.error(res.error);
    setTaskIds((current) => ({ ...current, [findingKey]: res.data.taskId }));
    toast.success(res.data.created ? "Follow-up task created" : "That task already exists", {
      description: res.data.created ? "It is assigned to you in CRM Tasks." : "No duplicate was created.",
    });
    router.refresh();
  };

  return (
    <li className={cn("rounded-2xl border bg-surface", report.severity === "critical" ? "border-danger/30" : "border-line")}>
      <div className="flex items-start gap-3 p-4">
        <span
          className={cn(
            "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl [&_svg]:size-4",
            report.severity === "critical"
              ? "bg-danger-soft text-danger-ink"
              : report.severity === "warning"
                ? "bg-warning-soft text-warning-ink"
                : "bg-primary-soft text-primary-ink",
          )}
          aria-hidden
        >
          {reportIcon(report.kind)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusPill tone={SEVERITY_TONE[report.severity]} size="sm">{PROACTIVE_SEVERITY_LABELS[report.severity]}</StatusPill>
            <span className="text-[11.5px] font-medium text-muted">{PROACTIVE_KIND_LABELS[report.kind]}</span>
            <span className="text-[11.5px] text-faint">·</span>
            <span className="inline-flex items-center gap-1.5 text-[11.5px] text-muted">
              {meta && <AgentAvatar role={meta} size="xs" />}
              {report.employeeName}
            </span>
            {report.status === "acknowledged" && <InfoChip icon={<Check />}>Acknowledged</InfoChip>}
            {note && <StatusPill tone={note.tone} size="sm">{note.label}</StatusPill>}
          </div>
          <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className="mt-1.5 block w-full text-left">
            <span className="block text-[14px] font-semibold leading-snug text-ink">{report.title}</span>
            <span className="mt-0.5 block text-[12.5px] leading-relaxed text-muted">{report.summary}</span>
          </button>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px]">
            <InfoChip icon={<Clock3 />}><span suppressHydrationWarning>{formatDateTime(report.createdAt, timeZone)}</span></InfoChip>
            <span className="text-faint" suppressHydrationWarning>{relativeTime(report.createdAt)}</span>
            {report.findings.length > 0 && <span className="text-muted">{report.findings.length} finding{report.findings.length === 1 ? "" : "s"}</span>}
          </div>

          {open && (
            <div className="mt-3 space-y-4 border-t border-line pt-3">
              {report.sections.length > 0 && (
                <dl className="grid gap-3 sm:grid-cols-2">
                  {report.sections.map((section) => (
                    <div key={section.key} className={section.key === "what_happened" ? "sm:col-span-2" : ""}>
                      <dt className="text-[11px] font-semibold uppercase tracking-[.06em] text-faint">{section.title}</dt>
                      {section.body && <dd className="mt-1 text-[12.5px] leading-relaxed text-ink-2">{section.body}</dd>}
                      {section.items && section.items.length > 0 && (
                        <dd className="mt-1">
                          <ul className="list-disc space-y-0.5 pl-4 text-[12.5px] leading-relaxed text-ink-2">
                            {section.items.map((item, index) => <li key={`${section.key}-${index}`}>{item}</li>)}
                          </ul>
                        </dd>
                      )}
                    </div>
                  ))}
                </dl>
              )}

              {report.metrics.length > 0 && (
                <div className="rounded-xl border border-line bg-surface-2/40 p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[.06em] text-faint">Measured values</p>
                  <ul className="mt-2 grid gap-2 sm:grid-cols-2">
                    {report.metrics.slice(0, 8).map((metric) => (
                      <li key={metric.key} className="text-[12.5px]">
                        <span className="font-semibold text-ink">{metric.label}: {metric.value}{metric.unit ? ` ${metric.unit}` : ""}</span>
                        <span className="block text-[11.5px] text-muted">{metric.period} · {metric.definition}</span>
                        {typeof metric.change === "number" && metric.trend && (
                          <span className={cn("block text-[11.5px]", metric.trend === "flat" ? "text-muted" : "text-ink-2")}>
                            {metric.trend === "up" ? "Up" : metric.trend === "down" ? "Down" : "Unchanged"} {Math.abs(metric.change)}{metric.unit ? ` ${metric.unit}` : ""} from the preceding period
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {findings.length > 0 && (
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[.06em] text-faint">Findings and recommended actions</p>
                  <ul className="mt-2 space-y-2">
                    {findings.map((finding) => {
                      const key = finding.key;
                      return (
                        <li key={key} className="rounded-xl border border-line bg-surface-2/30 p-3">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <StatusPill tone={SEVERITY_TONE[finding.severity]} size="sm">{PROACTIVE_SEVERITY_LABELS[finding.severity]}</StatusPill>
                            <span className="text-[12.5px] font-semibold text-ink">{finding.title}</span>
                          </div>
                          <p className="mt-1 text-[12px] leading-relaxed text-ink-2">{finding.detail}</p>
                          {finding.samples.length > 0 && <p className="mt-1 text-[11.5px] text-muted">Examples: {finding.samples.join("; ")}</p>}
                          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px]">
                            {finding.recommendedAction && <span className="text-ink-2"><span className="font-medium">Next:</span> {finding.recommendedAction}</span>}
                            <Link href={finding.evidenceHref} className="font-semibold text-primary hover:underline">Open evidence</Link>
                            {report.jobStatus === "completed" && report.canCreateTask && (
                              taskIds[key] ? (
                                <Link href={`/crm/tasks?task=${taskIds[key]}`} className="inline-flex items-center gap-1 font-semibold text-success-ink hover:underline">
                                  <CheckCircle2 className="size-3.5" aria-hidden /> Task created
                                </Link>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => createTask(key)}
                                  disabled={busy !== null}
                                  className="inline-flex items-center gap-1 font-semibold text-primary hover:underline disabled:opacity-50"
                                >
                                  <ListPlus className="size-3.5" aria-hidden /> {busy === key ? "Creating task…" : "Create follow-up task"}
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

              {report.evidence.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {report.evidence.map((item) => item.href ? (
                    <Link key={`${item.label}-${item.href}`} href={item.href} className="inline-flex min-h-8 items-center gap-1 rounded-lg border border-line px-2.5 text-[11.5px] font-semibold text-primary hover:bg-primary-soft/40">
                      {item.label} <ArrowRight className="size-3.5" aria-hidden />
                    </Link>
                  ) : null)}
                </div>
              )}

              {autoTask && (
                <p className="flex flex-wrap items-center gap-1.5 rounded-xl border border-success/25 bg-success-soft/30 px-3 py-2 text-[12px] text-success-ink">
                  <CheckCircle2 className="size-3.5" aria-hidden />
                  An internal follow-up task was created under the owner&apos;s preauthorized critical-report setting.
                  <Link href={`/crm/tasks?task=${autoTask.taskId}`} className="font-semibold underline">Open task</Link>
                </p>
              )}

              <div className="flex flex-wrap items-center gap-2">
                {href && <Link href={href} className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-[11.5px] font-semibold text-primary hover:bg-primary-soft/50 hover:underline">Open work <ArrowRight className="size-3.5" aria-hidden /></Link>}
                {report.status === "open" && (
                  <Button size="sm" variant="secondary" onClick={acknowledge} loading={busy === "acknowledge"} disabled={busy !== null}>
                    <Check className="size-3.5" aria-hidden /> Acknowledge
                  </Button>
                )}
                <span className="text-[11px] text-faint">Evidence is stored in this workspace; no external message was sent by this report.</span>
              </div>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="mt-1 inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink"
          aria-label={open ? "Collapse report" : "Expand report"}
          aria-expanded={open}
        >
          {open ? <ChevronUp className="size-4" aria-hidden /> : <ChevronDown className="size-4" aria-hidden />}
        </button>
      </div>
    </li>
  );
}

function CoverageRow({ role, status }: { role: (typeof PROACTIVE_DUTIES)[number]; status: MonitoringStatus }) {
  const meta = AGENT_BY_KEY[role.role];
  const row = status.byRole.find((item) => item.role === role.role);
  const enabled = row?.enabled ?? 0;
  return (
    <li className="flex items-start gap-2.5 rounded-xl border border-line bg-surface-2/30 p-2.5">
      <AgentAvatar role={meta} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12px] font-semibold text-ink">{meta.shortName}</p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-muted">{role.title}</p>
      </div>
      <span
        className={cn(
          "mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold ring-1 ring-inset",
          enabled
            ? status.state === "active"
              ? "bg-success-soft text-success-ink ring-success/20"
              : "bg-warning-soft text-warning-ink ring-warning/20"
            : "bg-surface text-faint ring-line",
        )}
      >
        {enabled ? (status.state === "active" ? "Watching" : "Paused") : "Not scheduled"}
      </span>
    </li>
  );
}

export function ProactiveWatch({
  reports,
  monitoring,
  timeZone,
  focusReportId,
  canManageSchedules,
}: {
  reports: ProactiveReportView[];
  monitoring: MonitoringStatus;
  timeZone: string;
  focusReportId: string | null;
  canManageSchedules: boolean;
}) {
  const [showCoverage, setShowCoverage] = React.useState(false);
  const focused = reports.find((report) => report.id === focusReportId) ?? null;
  const visible = focused ? [focused, ...reports.filter((report) => report.id !== focused.id)] : reports;
  const stateTone = monitoring.state === "active" ? "success" : monitoring.state === "paused" ? "warning" : "neutral";
  const stateLabel = monitoring.state === "active" ? "Monitoring active" : monitoring.state === "paused" ? "Monitoring paused by operator" : "No monitoring schedule";
  return (
    <Panel
      icon={<Radar />}
      tone={monitoring.state === "active" ? "success" : monitoring.state === "paused" ? "warning" : "neutral"}
      title="Proactive watch"
      description="Verified reports from work an AI employee actually ran. A report can recommend an action, but customer-facing or high-impact changes still need a person."
      action={<StatusPill tone={stateTone} size="sm">{stateLabel}</StatusPill>}
    >
      <div className="space-y-4">
        <div className="rounded-xl border border-line bg-surface-2/30 p-3 text-[12px] leading-relaxed text-ink-2">
          {monitoring.state === "active" ? (
            <p>
              {monitoring.schedulesEnabled} schedule{monitoring.schedulesEnabled === 1 ? "" : "s"} and {monitoring.triggersEnabled} event trigger{monitoring.triggersEnabled === 1 ? "" : "s"} are enabled and authorized by the operator.
              {monitoring.lastVerifiedReportAt ? <> Most recent verified report <span suppressHydrationWarning>{relativeTime(monitoring.lastVerifiedReportAt)}</span>.</> : " No report has completed yet."}
            </p>
          ) : monitoring.state === "paused" ? (
            <p>
              {monitoring.schedulesEnabled + monitoring.triggersEnabled} monitoring row{monitoring.schedulesEnabled + monitoring.triggersEnabled === 1 ? " is" : "s are"} enabled, but the deployment operator switch is off for{" "}
              {!monitoring.schedulesOperatorEnabled ? "schedules" : "triggers"}. No recurring job will run until the operator enables it. Reports below are historical.
            </p>
          ) : (
            <p>
              No recurring monitoring is scheduled. The reports below came from work a person started, or from an event trigger that has since been paused. The employees are not watching continuously.
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[12px] font-semibold text-ink">Employee coverage</p>
          <button type="button" onClick={() => setShowCoverage((value) => !value)} className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-[11.5px] font-semibold text-primary hover:bg-primary-soft/40" aria-expanded={showCoverage}>
            {showCoverage ? "Hide duties" : "What each employee watches"} {showCoverage ? <ChevronUp className="size-3.5" aria-hidden /> : <ChevronDown className="size-3.5" aria-hidden />}
          </button>
        </div>
        {showCoverage && (
          <div className="space-y-3">
            <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {PROACTIVE_DUTIES.map((duty) => <CoverageRow key={duty.role} role={duty} status={monitoring} />)}
            </ul>
            <p className="text-[11.5px] text-muted">
              Each employee is limited to its reviewed capability and tenant. Creating a schedule is always paused first; enabling one still needs the operator switch.
            </p>
          </div>
        )}

        {!canManageSchedules && (
          <p className="text-[11.5px] text-muted">Only an owner or admin can create or enable a monitoring schedule.</p>
        )}

        {visible.length === 0 ? (
          <EmptyState
            icon={<BellRing className="size-5" />}
            title="No proactive reports yet"
            description="When a reviewed employee completes a monitoring job, its verified findings and recommended next actions appear here. Nothing is generated from an open page."
          />
        ) : (
          <ul className="space-y-2">
            {visible.map((report) => (
              <ReportCard key={report.id} report={report} timeZone={timeZone} focus={report.id === focusReportId} />
            ))}
          </ul>
        )}

        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-faint">
          <ListChecks className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          Acknowledging a report records that a person saw it; it does not mark the underlying business problem resolved. Follow-up tasks and approvals remain separate, audited actions.
        </p>
      </div>
    </Panel>
  );
}
