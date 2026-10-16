"use client";

import * as React from "react";
import Link from "next/link";
import { motion, useReducedMotion } from "motion/react";
import { toast } from "sonner";
import { AlertTriangle, ArrowDown, ArrowLeft, ArrowUp, Ban, CalendarClock, CheckCircle2, ChevronRight, Clock, History, Hourglass, KeyRound, Layers, ListChecks, ListPlus, Lock, Package, PlayCircle, RefreshCw, Settings2, ShieldCheck, Undo2, UserCheck, UserRound, WifiOff } from "lucide-react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, ProgressBar, Select } from "@/components/ui/primitives";
import { LiveBadge } from "@/components/setup/live-badge";
import { ProgressRing } from "@/components/setup/progress-ring";
import { StatusIcon } from "@/components/setup/status";
import { useLiveSetup } from "@/components/setup/use-live-setup";
import { InfoChip, StatusPill } from "@/components/ui/status";
import { ActivateDialog, AddTaskDialog, SendBackDialog, ServicesDialog } from "@/components/admin/setup/dialogs";
import { CHECK_STATUS, eventLabel, initialsOf, MODE_ICON, MODE_LABEL, snapshotTasks, TaskStatusPill, useAct } from "@/components/admin/setup/common";
import { Callout, IconTile } from "@/components/admin/setup/ui";
import { TaskDrawer } from "@/components/admin/setup/task-drawer";
import { markReadyForReviewAction, reorderTasksAction, runAllChecksAction, setResponsibleStaffAction } from "@/app/(admin)/admin/setup-actions";
import { SECTION_TITLE, type AgencySetupSnapshot, type AgencyTaskView, type CheckStatus, type Section } from "@/lib/setup";
import { cn, formatDate, relativeTime } from "@/lib/utils";

const STATE_LABEL = { in_setup: "In setup", ready_for_review: "Ready for final review", activated: "Approved for activation" } as const;
const STATE_TONE = { in_setup: "primary", ready_for_review: "violet", activated: "success" } as const;


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

  if (accessLost) return <Card role="alert"><EmptyState icon={<Lock className="size-5" />} title="Client access changed" description={error} action={<Button variant="secondary" onClick={() => window.location.reload()}><RefreshCw className="size-4" /> Refresh access</Button>} /></Card>;

  return (
    <div className="space-y-6">
      <Link href={`/admin/clients/${orgId}`} className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink">
        <ArrowLeft className="size-3.5" /> {data.org.name}
      </Link>

      {/* Header */}
      <motion.section initial={false} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }} className="page-in card-surface relative overflow-hidden rounded-3xl p-5 sm:p-7">
        <div aria-hidden className="pointer-events-none absolute -right-20 -top-24 size-64 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-center">
          <ProgressRing percent={p.percent} size={104} stroke={9} caption="Tasks" className="shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[12.5px] font-semibold uppercase tracking-wider text-primary">Client setup manager</p>
              <StatusPill tone={STATE_TONE[data.state]} size="sm">{STATE_LABEL[data.state]}</StatusPill>
            </div>
            <h1 className="mt-1 text-[24px] font-semibold tracking-[-0.02em] text-ink sm:text-[28px]">{data.org.name}</h1>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <InfoChip icon={<ListChecks />}>{p.total === 0 ? "No required steps apply." : `${p.completed} of ${p.total} required steps complete`}</InfoChip>
              {p.counts.waiting_for_client > 0 && <StatusPill tone="warning" icon={<Clock className="size-3" />}>{p.counts.waiting_for_client} waiting on the client</StatusPill>}
              {p.counts.blocked > 0 && <StatusPill tone="danger" icon={<Ban className="size-3" />}>{p.counts.blocked} blocked</StatusPill>}
              {data.estimatedCompletion && <InfoChip icon={<CalendarClock />}>Est. {formatDate(`${data.estimatedCompletion}T12:00:00Z`, "UTC")}</InfoChip>}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-[12.5px] text-muted">
              <label className="inline-flex items-center gap-2">
                <UserCheck className="size-3.5" />
                <span className="sr-only sm:not-sr-only">Responsible</span>
                <Select
                  aria-label="Responsible team member"
                  className="w-48 text-[12.5px] sm:h-9"
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
          <div className="grid grid-cols-2 gap-2 lg:w-[290px] [&>*:last-child:nth-child(odd)]:col-span-2">
            <ButtonLink href={`/admin/clients/${orgId}/provisioning`} variant="secondary" size="sm"><Layers className="size-4" /> Provisioning</ButtonLink>
            <ButtonLink href={`/admin/clients/${orgId}/activation`} variant="secondary" size="sm"><ShieldCheck className="size-4" /> Readiness</ButtonLink>
            <ButtonLink href={`/admin/clients/${orgId}/integrations`} variant="secondary" size="sm"><KeyRound className="size-4" /> Integrations</ButtonLink>
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

      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* Checklist */}
        <div className="space-y-8">
          {(["agency", "client"] as const).map((section) => {
            const list = data.tasks.filter((t) => t.section === section);
            return (
              <section key={section} aria-labelledby={`mg-${section}`}>
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <IconTile icon={section === "agency" ? <Settings2 /> : <UserRound />} tone={section === "agency" ? "primary" : "warning"} size="sm" />
                    <h2 id={`mg-${section}`} className="text-[15px] font-semibold tracking-tight text-ink">
                      {SECTION_TITLE[section]}
                    </h2>
                  </div>
                  <InfoChip>{list.filter((t) => t.status === "completed").length} of {list.length} complete</InfoChip>
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
              <div className="flex min-w-0 items-start gap-3">
                <IconTile icon={<ShieldCheck />} tone={r.canMarkReady || data.state !== "in_setup" ? "success" : "primary"} />
                <div className="min-w-0">
                  <CardTitle>Production readiness</CardTitle>
                  <CardDescription>Finished tasks and a healthy system are two different things.</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-xl bg-surface-2/60 px-3.5 py-3 ring-1 ring-inset ring-line">
                <div className="flex items-center justify-between gap-3 text-[13px]">
                  <span className="font-medium text-ink-2">Setup tasks</span>
                  <StatusPill tone={r.tasksComplete ? "success" : "primary"} size="sm">{r.tasksComplete ? "All complete" : `${p.completed} of ${p.total}`}</StatusPill>
                </div>
                <ProgressBar value={r.tasksComplete ? 100 : p.percent ?? 0} tone={r.tasksComplete ? "success" : "primary"} label="Setup tasks complete" className="mt-2.5 h-1.5" />
              </div>

              <div>
                <div className="mb-2.5 flex items-center justify-between gap-2">
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
                    <li key={c.key} className={cn("rounded-xl border px-3 py-2.5", c.status === "failed" ? "border-danger/25 bg-danger-soft/20" : c.status === "verified" ? "border-success/20 bg-success-soft/20" : "border-line")}>
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-[13px] font-medium text-ink">{c.label}</span>
                        <StatusPill tone={CHECK_STATUS[c.status].tone} size="sm">{CHECK_STATUS[c.status].label}</StatusPill>
                      </div>
                      {c.detail && <p className="mt-1.5 text-[12px] leading-relaxed text-muted">{c.detail}</p>}
                      {!c.connectorImplemented && <Callout tone="warning" icon={<AlertTriangle />} className="mt-2 px-2.5 py-2 text-[12px]">No verified connector yet. Agency evidence can be recorded for review; activation stays blocked.</Callout>}
                      {c.checkedAt && <InfoChip icon={<Clock />} className="mt-2 h-5 text-[11px]"><span suppressHydrationWarning>Checked {relativeTime(c.checkedAt)}</span></InfoChip>}
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-[12px] leading-relaxed text-muted">The agency prepares resources using approved operations. This panel shows verified checks separately from task progress and evidence.</p>
              </div>

              {data.state !== "activated" && r.blockers.length > 0 && (
                <div>
                  <h3 className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-ink">
                    What&apos;s stopping activation
                    <StatusPill tone="warning" size="sm" dot={false}>{r.blockers.length}</StatusPill>
                  </h3>
                  <ul className="space-y-1.5">
                    {r.blockers.slice(0, 6).map((b, i) => (
                      <li key={i} className="flex items-start gap-2 rounded-lg bg-warning-soft/40 px-2.5 py-2 text-[12.5px] leading-snug text-ink-2 ring-1 ring-inset ring-warning/15">
                        <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning-ink" /> <span className="min-w-0">{b.message}</span>
                      </li>
                    ))}
                    {r.blockers.length > 6 && <li className="px-1 text-[12px] font-medium text-muted">+{r.blockers.length - 6} more</li>}
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
                    {!r.canMarkReady && <Callout tone="neutral" icon={<Lock />} className="px-3 py-2 text-[12px]">{r.taskBlockers[0]?.message ?? "Finish the remaining steps first."}</Callout>}
                  </>
                )}
                {data.state === "ready_for_review" && (
                  <>
                    {viewerIsSuper ? (
                      <Button className="w-full" variant="brand" onClick={() => setDialog("activate")}>
                        <ShieldCheck className="size-4" /> Approve activation
                      </Button>
                    ) : (
                      <Callout tone="violet" icon={<ShieldCheck />}>A super admin approves activation after reviewing the checks.</Callout>
                    )}
                    <Button className="w-full" variant="secondary" onClick={() => setDialog("sendback")}>
                      <Undo2 className="size-4" /> Send back to setup
                    </Button>
                  </>
                )}
                {data.state === "activated" && (
                  <Callout tone="success" icon={<CheckCircle2 />}>
                    Approved for activation{data.activatedAt ? ` on ${formatDate(data.activatedAt, timeZone)}` : ""}.
                  </Callout>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex min-w-0 items-center gap-3">
                <IconTile icon={<History />} tone="neutral" size="sm" />
                <CardTitle>Recent activity</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              {data.events.length === 0 ? (
                <EmptyState compact icon={<History className="size-5" />} title="Nothing yet" description="Changes to this checklist are recorded here as they happen." />
              ) : (
                <ol className="relative space-y-4 border-l border-line pl-4">
                  {data.events.slice(0, 10).map((e) => (
                    <li key={e.id} className="relative text-[12.5px] leading-snug">
                      <span aria-hidden className="absolute -left-[21px] top-1 size-2.5 rounded-full border-2 border-surface bg-primary" />
                      <p className="text-ink-2">{eventLabel(e, byId)}</p>
                      <InfoChip icon={<Clock />} className="mt-1.5 h-5 text-[11px]"><span suppressHydrationWarning>{relativeTime(e.at)}</span></InfoChip>
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
  const chip = "h-5 text-[11px]";
  return (
    <motion.li
      layout="position"
      initial={false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: reduce ? 0 : Math.min(index, 8) * 0.03, ease: [0.16, 1, 0.3, 1] }}
      className={cn(
        "page-in group flex items-stretch rounded-2xl border bg-surface shadow-soft transition-[box-shadow,border-color] duration-200 hover:border-line-strong hover:shadow-card",
        t.status === "blocked" ? "border-danger/30 bg-danger-soft/10" : "border-line",
        inactive && "opacity-60",
        highlight && "ring-2 ring-primary/40",
      )}
    >
      <div className="flex flex-col justify-center border-r border-line px-1 py-1 sm:gap-0.5 sm:px-1.5 sm:py-2">
        <button type="button" aria-label={`Move “${t.title}” up`} disabled={isFirst || busy} onClick={() => onMove(-1)} className="flex h-10 w-9 items-center justify-center rounded-md text-faint transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-30 sm:size-6">
          <ArrowUp className="size-3.5" />
        </button>
        <button type="button" aria-label={`Move “${t.title}” down`} disabled={isLast || busy} onClick={() => onMove(1)} className="flex h-10 w-9 items-center justify-center rounded-md text-faint transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-30 sm:size-6">
          <ArrowDown className="size-3.5" />
        </button>
      </div>
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 rounded-r-2xl px-3.5 py-3.5 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary">
        <StatusIcon status={t.status} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[14px] font-medium leading-snug text-ink">{t.title}</span>
            {!t.required && <StatusPill tone="neutral" size="sm" dot={false}>Optional</StatusPill>}
            {t.hidden && <StatusPill tone="neutral" size="sm" dot={false}>Hidden</StatusPill>}
            {t.serviceExcluded && <StatusPill tone="neutral" size="sm" dot={false}>Not in package</StatusPill>}
          </span>
          <span className="mt-2 flex flex-wrap items-center gap-1.5">
            <TaskStatusPill status={t.status} size="sm" className="sm:hidden" />
            <InfoChip icon={MODE_ICON[t.completionMode]} className={chip}>{MODE_LABEL[t.completionMode]}</InfoChip>
            {checkStatus && <StatusPill tone={CHECK_STATUS[checkStatus].tone} size="sm">{CHECK_STATUS[checkStatus].label}</StatusPill>}
            {assignee ? (
              <InfoChip className={chip} icon={<span className="flex !size-4 items-center justify-center rounded-full bg-primary-soft text-[8px] font-semibold text-primary-ink">{initialsOf(assignee)}</span>}>{assignee}</InfoChip>
            ) : (
              <InfoChip icon={<UserRound />} className={cn(chip, "border border-dashed border-line-strong bg-transparent text-muted ring-0")}>Unassigned</InfoChip>
            )}
            {t.estimatedCompletionAt && <InfoChip icon={<CalendarClock />} className={chip}>{formatDate(`${t.estimatedCompletionAt}T12:00:00Z`, "UTC")}</InfoChip>}
            {t.status === "ready_for_review" && t.clientRespondedAt && <StatusPill tone="violet" size="sm">Client responded</StatusPill>}
            {t.status !== "completed" && waitingOn.length > 0 && !inactive && (
              <StatusPill tone="warning" size="sm" icon={<Hourglass className="size-3 shrink-0" />} className="max-w-full">
                <span className="truncate" title={waitingOn.join(", ")}>Waiting on {waitingOn[0]}{waitingOn.length > 1 ? ` +${waitingOn.length - 1}` : ""}</span>
              </StatusPill>
            )}
          </span>
        </span>
        <TaskStatusPill status={t.status} className="hidden sm:inline-flex" />
        <ChevronRight className="size-4 shrink-0 text-faint transition-transform group-hover:translate-x-0.5" />
      </button>
    </motion.li>
  );
}
