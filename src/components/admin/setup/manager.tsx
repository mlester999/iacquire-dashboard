"use client";

import * as React from "react";
import Link from "next/link";
import { motion, useReducedMotion } from "motion/react";
import { toast } from "sonner";
import { AlertTriangle, ArrowDown, ArrowLeft, ArrowUp, CalendarClock, CheckCircle2, ChevronRight, ListPlus, Package, PlayCircle, RefreshCw, ShieldCheck, Undo2, UserCheck, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Select } from "@/components/ui/primitives";
import { LiveBadge } from "@/components/setup/live-badge";
import { ProgressRing } from "@/components/setup/progress-ring";
import { StatusBadge, StatusIcon } from "@/components/setup/status";
import { useLiveSetup } from "@/components/setup/use-live-setup";
import { ActivateDialog, AddTaskDialog, SendBackDialog, ServicesDialog } from "@/components/admin/setup/dialogs";
import { eventLabel, initialsOf, MODE_LABEL, snapshotTasks, useAct } from "@/components/admin/setup/common";
import { TaskDrawer } from "@/components/admin/setup/task-drawer";
import { markReadyForReviewAction, reorderTasksAction, runAllChecksAction, setResponsibleStaffAction } from "@/app/(admin)/admin/setup-actions";
import { SECTION_TITLE, type AgencySetupSnapshot, type AgencyTaskView, type CheckStatus, type Section } from "@/lib/setup";
import { cn, formatDate, relativeTime } from "@/lib/utils";

const STATE_LABEL = { in_setup: "In setup", ready_for_review: "Ready for final review", activated: "Approved for activation" } as const;
const STATE_TONE = { in_setup: "primary", ready_for_review: "violet", activated: "success" } as const;

const CHECK_BADGE: Record<CheckStatus, { label: string; tone: "success" | "violet" | "danger" | "neutral" }> = {
  verified: { label: "Verified", tone: "success" },
  attested: { label: "Attested by agency", tone: "violet" },
  failed: { label: "Failing", tone: "danger" },
  unverified: { label: "Not verified", tone: "neutral" },
};

export function SetupManager({ initial, orgId, timeZone, viewerIsSuper, preview = false }: { initial: AgencySetupSnapshot; orgId: string; timeZone: string; viewerIsSuper: boolean; /** Design preview with sample data: no network. */ preview?: boolean }) {
  const { data, connection, error, accessLost, syncedAt, changed, refresh } = useLiveSetup<AgencySetupSnapshot>({
    initial,
    snapshotUrl: `/api/admin/setup/${orgId}`,
    streamUrl: `/api/admin/setup/${orgId}/stream`,
    enabled: !preview,
  });
  const { busy, act } = useAct(refresh, !preview);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [dialog, setDialog] = React.useState<null | "add" | "services" | "sendback" | "activate">(null);
  const task = data.tasks.find((t) => t.id === openId) ?? null;
  const byId = snapshotTasks(data);
  const staff = new Map(data.staff.map((s) => [s.id, s.name]));
  const checks = new Map(data.checks.map((c) => [c.key, c]));
  const p = data.progress;
  const r = data.readiness;

  const move = (section: Section, id: string, dir: -1 | 1) => {
    const ids = data.tasks.filter((t) => t.section === section).map((t) => t.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    void act("reorder", () => reorderTasksAction(orgId, section, ids));
  };

  if (accessLost) return <Card role="alert" className="p-6"><h1 className="font-semibold text-ink">Client access changed</h1><p className="mt-2 text-sm text-muted">{error}</p><Button className="mt-4" variant="secondary" onClick={() => window.location.reload()}>Refresh access</Button></Card>;

  return (
    <div className="space-y-6">
      <Link href={`/admin/clients/${orgId}`} className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink">
        <ArrowLeft className="size-3.5" /> {data.org.name}
      </Link>

      {/* Header */}
      <motion.section initial={false} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }} className="page-in card-surface relative overflow-hidden rounded-3xl p-5 sm:p-7">
        <div aria-hidden className="pointer-events-none absolute -right-20 -top-24 size-64 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-center">
          <div className="flex items-center gap-5">
            <ProgressRing percent={p.percent} size={104} stroke={9} caption="Tasks" />
            <div className="min-w-0 lg:hidden">
              <Badge tone={STATE_TONE[data.state]}>{STATE_LABEL[data.state]}</Badge>
            </div>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[12.5px] font-semibold uppercase tracking-wider text-primary">Client setup manager</p>
              <Badge tone={STATE_TONE[data.state]} className="hidden lg:inline-flex">
                {STATE_LABEL[data.state]}
              </Badge>
            </div>
            <h1 className="mt-1 text-[24px] font-semibold tracking-[-0.02em] text-ink sm:text-[28px]">{data.org.name}</h1>
            <p className="mt-1 text-[13.5px] text-muted">
              {p.total === 0 ? "No required steps apply." : `${p.completed} of ${p.total} required steps complete`}
              {p.counts.waiting_for_client > 0 && ` · ${p.counts.waiting_for_client} waiting on the client`}
              {p.counts.blocked > 0 && ` · ${p.counts.blocked} blocked`}
              {data.estimatedCompletion && ` · est. ${formatDate(`${data.estimatedCompletion}T12:00:00Z`, "UTC")}`}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[12.5px] text-muted">
              <label className="inline-flex items-center gap-2">
                <UserCheck className="size-3.5" />
                <span className="sr-only sm:not-sr-only">Responsible</span>
                <Select
                  aria-label="Responsible team member"
                  className="h-8 w-48 text-[12.5px]"
                  value={data.responsibleUserId ?? ""}
                  onChange={(e) => void act("resp", () => setResponsibleStaffAction(orgId, e.target.value || null), "Responsible person updated")}
                >
                  <option value="">Unassigned</option>
                  {data.staff.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </label>
              <LiveBadge connection={connection} syncedAt={syncedAt} preview={preview} />
            </div>
          </div>
          <div className="flex flex-wrap gap-2 lg:max-w-[260px] lg:justify-end">
            <Link href={`/admin/clients/${orgId}/provisioning`} className="rounded-xl border border-line px-3 py-2 text-[12.5px] font-medium text-ink-2 transition hover:bg-surface-2">Provisioning</Link>
            <Link href={`/admin/clients/${orgId}/activation`} className="rounded-xl border border-line px-3 py-2 text-[12.5px] font-medium text-ink-2 transition hover:bg-surface-2">Readiness</Link>
            <Link href={`/admin/clients/${orgId}/integrations`} className="rounded-xl border border-line px-3 py-2 text-[12.5px] font-medium text-ink-2 transition hover:bg-surface-2">Integrations</Link>
            <Button variant="secondary" size="sm" onClick={() => setDialog("add")}>
              <ListPlus className="size-4" /> Add step
            </Button>
            {viewerIsSuper && (
              <Button variant="secondary" size="sm" onClick={() => setDialog("services")}>
                <Package className="size-4" /> Services
              </Button>
            )}
          </div>
        </div>
      </motion.section>

      {error && (
        <div role="status" className="flex flex-col gap-3 rounded-2xl border border-warning/25 bg-warning-soft px-4 py-3 text-[13.5px] text-warning-ink sm:flex-row sm:items-center">
          <span className="flex flex-1 items-start gap-2.5">
            <WifiOff className="mt-0.5 size-4 shrink-0" /> {error}
          </span>
          <Button size="sm" variant="secondary" onClick={() => void refresh()}>
            <RefreshCw className="size-3.5" /> Retry
          </Button>
        </div>
      )}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* Checklist */}
        <div className="space-y-8">
          {(["agency", "client"] as const).map((section) => {
            const list = data.tasks.filter((t) => t.section === section);
            return (
              <section key={section} aria-labelledby={`mg-${section}`}>
                <div className="mb-3 flex items-baseline justify-between">
                  <h2 id={`mg-${section}`} className="text-[15px] font-semibold tracking-tight text-ink">
                    {SECTION_TITLE[section]}
                  </h2>
                  <span className="text-[12.5px] text-muted">{list.filter((t) => t.status === "completed").length} of {list.length} complete</span>
                </div>
                <ol className="space-y-2">
                  {list.map((t, i) => (
                    <TaskRow
                      key={t.id}
                      t={t}
                      index={i}
                      isFirst={i === 0}
                      isLast={i === list.length - 1}
                      highlight={changed.has(t.id)}
                      assignee={t.assignedTo ? staff.get(t.assignedTo) ?? null : null}
                      checkStatus={t.checkKey ? checks.get(t.checkKey)?.status ?? "unverified" : null}
                      waitingOn={t.unmetDependencies.map((id) => byId.get(id)?.title).filter(Boolean) as string[]}
                      onOpen={() => setOpenId(t.id)}
                      onMove={(dir) => move(section, t.id, dir)}
                      busy={busy === "reorder"}
                    />
                  ))}
                </ol>
              </section>
            );
          })}
        </div>

        {/* Readiness */}
        <aside className="space-y-4 lg:sticky lg:top-24">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Production readiness</CardTitle>
                <CardDescription>Finished tasks and a healthy system are two different things.</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-xl bg-surface-2/60 px-3 py-2.5 text-[13px]">
                <div className="flex items-center justify-between">
                  <span className="text-ink-2">Setup tasks</span>
                  <span className={cn("font-medium", r.tasksComplete ? "text-success-ink" : "text-ink")}>{r.tasksComplete ? "All complete" : `${p.completed} of ${p.total}`}</span>
                </div>
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-[13px] font-semibold text-ink">System checks</h3>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busy === "checks"}
                    onClick={async () => {
                      const res = await act("checks", () => runAllChecksAction(orgId));
                      if (res?.ok) {
                        const d = res.data as { passed: number; failed: number; total: number; completedSteps: string[] };
                        toast(d.failed ? `${d.failed} check${d.failed === 1 ? "" : "s"} failing` : `${d.passed} of ${d.total} checks passed`, { description: d.completedSteps.length ? `Completed: ${d.completedSteps.join(", ")}` : undefined });
                      }
                    }}
                  >
                    <RefreshCw className="size-3.5" /> Run all checks
                  </Button>
                </div>
                <ul className="space-y-2">
                  {data.checks.map((c) => (
                    <li key={c.key} className="rounded-xl border border-line px-3 py-2.5">
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-[13px] font-medium text-ink">{c.label}</span>
                        <Badge tone={CHECK_BADGE[c.status].tone}>{CHECK_BADGE[c.status].label}</Badge>
                      </div>
                      {c.detail && <p className="mt-1 text-[12px] leading-relaxed text-muted">{c.detail}</p>}
                      {!c.connectorImplemented && <p className="mt-1 text-[12px] text-warning-ink">No verified connector yet. Agency evidence can be recorded for review; activation stays blocked.</p>}
                      {c.checkedAt && <p className="mt-1 text-[11.5px] text-faint">Checked {relativeTime(c.checkedAt)}</p>}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[12px] leading-relaxed text-faint">The agency prepares resources using approved operations. This panel shows verified checks separately from task progress and evidence.</p>
              </div>

              {data.state !== "activated" && r.blockers.length > 0 && (
                <div>
                  <h3 className="mb-1.5 text-[13px] font-semibold text-ink">What&apos;s stopping activation</h3>
                  <ul className="space-y-1.5">
                    {r.blockers.slice(0, 6).map((b, i) => (
                      <li key={i} className="flex items-start gap-2 text-[12.5px] leading-snug text-muted">
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" /> {b.message}
                      </li>
                    ))}
                    {r.blockers.length > 6 && <li className="text-[12px] text-faint">+{r.blockers.length - 6} more</li>}
                  </ul>
                </div>
              )}

              {/* Stage actions */}
              <div className="space-y-2 border-t border-line pt-4">
                {data.state === "in_setup" && (
                  <>
                    <Button className="w-full" variant="brand" disabled={!r.canMarkReady} loading={busy === "ready"} onClick={() => act("ready", () => markReadyForReviewAction(orgId), "Marked ready for final review")}>
                      <PlayCircle className="size-4" /> Mark ready for final review
                    </Button>
                    {!r.canMarkReady && <p className="text-[12px] leading-relaxed text-muted">{r.taskBlockers[0]?.message ?? "Finish the remaining steps first."}</p>}
                  </>
                )}
                {data.state === "ready_for_review" && (
                  <>
                    {viewerIsSuper ? (
                      <Button className="w-full" variant="brand" onClick={() => setDialog("activate")}>
                        <ShieldCheck className="size-4" /> Approve activation
                      </Button>
                    ) : (
                      <p className="rounded-xl bg-violet-soft px-3 py-2.5 text-[12.5px] text-violet-ink">A super admin approves activation after reviewing the checks.</p>
                    )}
                    <Button className="w-full" variant="secondary" onClick={() => setDialog("sendback")}>
                      <Undo2 className="size-4" /> Send back to setup
                    </Button>
                  </>
                )}
                {data.state === "activated" && (
                  <p className="flex items-start gap-2 rounded-xl bg-success-soft px-3 py-2.5 text-[13px] text-success-ink">
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> Approved for activation{data.activatedAt ? ` on ${formatDate(data.activatedAt, timeZone)}` : ""}.
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recent activity</CardTitle>
            </CardHeader>
            <CardContent>
              {data.events.length === 0 ? (
                <p className="text-[13px] text-muted">Nothing yet.</p>
              ) : (
                <ol className="space-y-3">
                  {data.events.slice(0, 10).map((e) => (
                    <li key={e.id} className="text-[12.5px] leading-snug">
                      <p className="text-ink-2">{eventLabel(e, byId)}</p>
                      <p className="mt-0.5 text-[11.5px] text-faint">{relativeTime(e.at)}</p>
                    </li>
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>
        </aside>
      </div>

      <TaskDrawer orgId={orgId} snapshot={data} task={task} onClose={() => setOpenId(null)} act={act} busy={busy} timeZone={timeZone} />
      <AddTaskDialog open={dialog === "add"} onClose={() => setDialog(null)} orgId={orgId} snapshot={data} act={act} busy={busy} onCreated={(id) => setOpenId(id)} />
      <ServicesDialog open={dialog === "services"} onClose={() => setDialog(null)} orgId={orgId} current={data.services} act={act} busy={busy} />
      <SendBackDialog open={dialog === "sendback"} onClose={() => setDialog(null)} orgId={orgId} act={act} busy={busy} />
      <ActivateDialog open={dialog === "activate"} onClose={() => setDialog(null)} orgId={orgId} snapshot={data} act={act} busy={busy} />
    </div>
  );
}

function TaskRow({
  t,
  index,
  isFirst,
  isLast,
  highlight,
  assignee,
  checkStatus,
  waitingOn,
  onOpen,
  onMove,
  busy,
}: {
  t: AgencyTaskView;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  highlight: boolean;
  assignee: string | null;
  checkStatus: CheckStatus | null;
  waitingOn: string[];
  onOpen: () => void;
  onMove: (dir: -1 | 1) => void;
  busy: boolean;
}) {
  const reduce = useReducedMotion();
  const inactive = t.hidden || t.serviceExcluded;
  return (
    <motion.li
      layout="position"
      initial={false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: reduce ? 0 : Math.min(index, 8) * 0.03, ease: [0.16, 1, 0.3, 1] }}
      className={cn(
        "page-in group flex items-stretch rounded-2xl border bg-surface shadow-soft transition-[box-shadow,border-color] duration-200 hover:border-line-strong hover:shadow-card",
        t.status === "blocked" ? "border-danger/30" : "border-line",
        inactive && "opacity-60",
        highlight && "ring-2 ring-primary/40",
      )}
    >
      <div className="flex flex-col justify-center gap-0.5 border-r border-line px-1.5 py-2">
        <button type="button" aria-label={`Move “${t.title}” up`} disabled={isFirst || busy} onClick={() => onMove(-1)} className="flex size-6 items-center justify-center rounded-md text-faint hover:bg-surface-2 hover:text-ink disabled:opacity-30">
          <ArrowUp className="size-3.5" />
        </button>
        <button type="button" aria-label={`Move “${t.title}” down`} disabled={isLast || busy} onClick={() => onMove(1)} className="flex size-6 items-center justify-center rounded-md text-faint hover:bg-surface-2 hover:text-ink disabled:opacity-30">
          <ArrowDown className="size-3.5" />
        </button>
      </div>
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 rounded-r-2xl px-3.5 py-3 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary">
        <StatusIcon status={t.status} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[14px] font-medium leading-snug text-ink">{t.title}</span>
            {!t.required && <Badge tone="outline">Optional</Badge>}
            {t.hidden && <Badge tone="outline">Hidden</Badge>}
            {t.serviceExcluded && <Badge tone="outline">Not in package</Badge>}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
            <StatusBadge status={t.status} className="h-5 px-2 text-[11px] sm:hidden" />
            <span>{MODE_LABEL[t.completionMode]}</span>
            {checkStatus && <span className={cn(checkStatus === "verified" ? "text-success-ink" : checkStatus === "attested" ? "text-violet-ink" : checkStatus === "failed" ? "text-danger-ink" : "text-faint")}>{CHECK_BADGE[checkStatus].label}</span>}
            {assignee ? (
              <span className="inline-flex items-center gap-1">
                <span className="flex size-4 items-center justify-center rounded-full bg-primary-soft text-[8px] font-semibold text-primary-ink">{initialsOf(assignee)}</span>
                {assignee}
              </span>
            ) : (
              <span className="text-faint">Unassigned</span>
            )}
            {t.estimatedCompletionAt && (
              <span className="inline-flex items-center gap-1">
                <CalendarClock className="size-3" /> {formatDate(`${t.estimatedCompletionAt}T12:00:00Z`, "UTC")}
              </span>
            )}
            {t.status === "ready_for_review" && t.clientRespondedAt && <span className="text-violet-ink">Client responded</span>}
            {t.status !== "completed" && waitingOn.length > 0 && !inactive && <span className="text-warning-ink">Waiting on {waitingOn[0]}{waitingOn.length > 1 ? ` +${waitingOn.length - 1}` : ""}</span>}
          </span>
        </span>
        <StatusBadge status={t.status} className="hidden sm:inline-flex" />
        <ChevronRight className="size-4 shrink-0 text-faint transition-transform group-hover:translate-x-0.5" />
      </button>
    </motion.li>
  );
}
