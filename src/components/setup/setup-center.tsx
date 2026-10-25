"use client";

import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { toast } from "sonner";
import { AlertTriangle, ArrowRight, CalendarClock, CheckCircle2, ClipboardList, Clock, ExternalLink, Headset, Hourglass, LifeBuoy, RefreshCw, ShieldCheck, Sparkles, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, EmptyState, Field, Textarea } from "@/components/ui/primitives";
import { InfoChip } from "@/components/ui/status";
import { Dialog, Segmented } from "@/components/ui/overlays";
import { openHelp } from "@/components/help/help-widget";
import { ProgressRing } from "@/components/setup/progress-ring";
import { StatusBadge, StatusIcon } from "@/components/setup/status";
import { useLiveSetup } from "@/components/setup/use-live-setup";
import { LiveBadge } from "@/components/setup/live-badge";
import { respondToSetupAction } from "@/app/actions/setup";
import { CLIENT_STATUS_LABEL, SECTION_TITLE, type ClientSetupSnapshot, type ClientTaskView, type Section } from "@/lib/setup";
import { cn, formatDate, relativeTime } from "@/lib/utils";

export function SetupCenter({ initial, firstName, timeZone, preview = false }: { initial: ClientSetupSnapshot; firstName: string; timeZone: string; /** Design preview with sample data: no network. */ preview?: boolean }) {
  const reduce = useReducedMotion();
  const selfAction = React.useRef(0);
  const [responding, setResponding] = React.useState<ClientTaskView | null>(null);
  const { data, connection, error, accessLost, syncedAt, changed, refresh } = useLiveSetup<ClientSetupSnapshot>({
    initial,
    snapshotUrl: "/api/setup",
    streamUrl: "/api/setup/stream",
    enabled: !preview,
    onChange: (prev, next) => {
      if (Date.now() - selfAction.current < 4000) return; // the person just did this themselves
      const before = new Map(prev.tasks.map((t) => [t.id, t.status]));
      const moved = next.tasks.filter((t) => before.has(t.id) && before.get(t.id) !== t.status);
      moved.slice(0, 2).forEach((t) => toast(t.status === "completed" ? `${t.title} is complete` : `${t.title}: ${CLIENT_STATUS_LABEL[t.status].toLowerCase()}`, { description: "Updated just now by the iAcquire team." }));
      if (moved.length > 2) toast(`${moved.length - 2} more updates from the iAcquire team`);
      if (!moved.length && next.state !== prev.state) toast(next.state === "activated" ? "Your system is approved for activation" : "Your setup status changed");
    },
  });

  const bySection = (section: Section) => data.tasks.filter((t) => t.section === section);
  const p = data.progress;
  const working = p.counts.in_progress + p.counts.ready_for_review;
  const needsYou = p.counts.waiting_for_client;
  const allDone = p.total > 0 && p.completed === p.total;

  if (accessLost) return <Card role="alert" className="mx-auto max-w-3xl"><EmptyState icon={<AlertTriangle className="size-5" />} title="Setup access changed" description={error} action={<Button variant="secondary" onClick={() => window.location.reload()}><RefreshCw className="size-3.5" /> Refresh access</Button>} /></Card>;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {/* Hero */}
      <motion.section
        data-aqi-target="setup.hero"
        initial={false}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
        className="page-in surface-tint relative overflow-hidden rounded-[26px] border border-line p-6 sm:p-8"
      >
        <div aria-hidden className="pointer-events-none absolute -right-24 -top-24 size-72 rounded-full bg-primary/10 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -bottom-28 left-1/3 size-72 rounded-full bg-violet/10 blur-3xl" />
        <div className="relative flex flex-col items-center gap-6 text-center sm:flex-row sm:items-center sm:gap-8 sm:text-left">
          <ProgressRing percent={p.percent} caption={p.percent === null ? "Not started" : "Setup tasks"} />
          <div className="min-w-0 flex-1">
            <p className="text-[12.5px] font-semibold uppercase tracking-wider text-primary">Setup center<span className="text-muted"> · </span><span className="break-words normal-case tracking-normal text-ink-2">{data.orgName}</span></p>
            <h1 className="mt-1 text-[26px] font-semibold leading-tight tracking-[-0.02em] text-ink sm:text-[30px]">
              {data.state === "activated" ? `${firstName}, your system is approved` : "Your AI workforce is taking shape."}
            </h1>
            <p className="mt-1.5 max-w-xl text-[14.5px] leading-relaxed text-muted">
              {data.state !== "activated" && <span className="font-medium text-ink-2">Welcome, {firstName}. </span>}
              {data.state === "activated"
                ? `${data.orgName} has passed final review${data.activatedAt ? ` (${formatDate(data.activatedAt, timeZone)})` : ""}. The iAcquire team will confirm before any automation is switched on.`
                : p.total === 0
                  ? "Your checklist will appear here as soon as the iAcquire team sets it up."
                  : "We're preparing your AI employees, CRM, automations, and business integrations. Track your progress and complete the few steps that need your attention."}
            </p>
            <p className="mt-2 text-[12.5px] text-muted">{p.total > 0 && `${p.completed} of ${p.total} required setup steps complete. `}Technical steps are completed after verification. Final activation needs a separate agency review.</p>

            <dl className="mt-4 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
              <Chip label="Completed" value={p.counts.completed} tone="success" />
              <Chip label="iAcquire is working on" value={working} tone="primary" />
              <Chip label="Needs you" value={needsYou} tone="warning" />
              <Chip label="Blocked" value={p.counts.blocked} tone="danger" />
            </dl>

            <div className="mt-4 flex flex-wrap items-center justify-center gap-2 sm:justify-start">
              {data.estimatedCompletion && (
                <span title="Set by the iAcquire team from its schedule">
                  <InfoChip icon={<CalendarClock />}>Estimated setup completion {formatDate(`${data.estimatedCompletion}T12:00:00Z`, "UTC")}</InfoChip>
                </span>
              )}
              <span title={formatDate(data.lastUpdatedAt, timeZone)}>
                <InfoChip icon={<Clock />}>Last updated {relativeTime(data.lastUpdatedAt)}</InfoChip>
              </span>
              <LiveBadge connection={connection} syncedAt={syncedAt} preview={preview} />
            </div>
          </div>
        </div>
      </motion.section>

      <section aria-label="Your setup journey" data-aqi-target="setup.journey" className="grid gap-3 sm:grid-cols-3">
        {[{label:"iAcquire preparation",tasks:data.tasks.filter(task=>task.section==="agency"&&!task.isActivation),description:"Our team builds and verifies your system."},{label:"Your contributions",tasks:data.tasks.filter(task=>task.section==="client"),description:"The few things that need your input."},{label:"Final agency review",tasks:data.tasks.filter(task=>task.isActivation),description:"Readiness and approval before activation."}].map((stage,index)=>{
          const complete=stage.tasks.filter(task=>task.status==="completed").length;
          return <div key={stage.label} className="relative overflow-hidden rounded-2xl border border-line bg-surface p-4"><div className="flex items-center justify-between"><span className="font-mono text-[12px] text-muted">0{index+1}</span><span className="text-[12px] font-medium text-muted">{complete}/{stage.tasks.length} complete</span></div><h2 className="mt-3 text-[14px] font-semibold">{stage.label}</h2><p className="mt-1 text-[12px] leading-relaxed text-muted">{stage.description}</p><div role="img" className="mt-4 flex h-1.5 gap-1" aria-label={`${stage.label}: ${complete} of ${stage.tasks.length} complete`}>{stage.tasks.length?stage.tasks.map(task=><span key={task.id} className={cn("min-w-0 flex-1 rounded-full",task.status==="completed"?"bg-success":task.status==="blocked"?"bg-danger":task.status==="in_progress"?"bg-primary":"bg-surface-3")}/>):<span className="h-full w-full rounded-full bg-surface-3"/>}</div></div>;
        })}
      </section>

      {/* Honest status banners */}
      <AnimatePresence initial={false}>
        {error && (
          <Banner key="err" tone="warning" icon={<WifiOff className="size-4" />} action={<Button size="sm" variant="secondary" onClick={() => void refresh()}><RefreshCw className="size-3.5" /> Retry</Button>}>
            {error}
          </Banner>
        )}
        {data.finalCheckIssue && (
          <Banner key="check" tone="warning" icon={<AlertTriangle className="size-4" />}>
            {allDone ? "Every setup task is finished, but one final check on your system needs attention." : "One of the checks on your system needs attention."} Contact the iAcquire team for help, or check any requests below.
          </Banner>
        )}
        {data.state === "ready_for_review" && !data.finalCheckIssue && (
          <Banner key="review" tone="violet" icon={<ShieldCheck className="size-4" />}>
            Every setup step is finished. Our team is doing a last review before activation.
          </Banner>
        )}
        {data.state === "activated" && (
          <Banner key="live" tone="success" icon={<CheckCircle2 className="size-4" />}>
            Your full system has been approved for activation. Nothing is switched on without the iAcquire team confirming it with you first.
          </Banner>
        )}
        {data.needsAttention > 0 && data.state !== "activated" && (
          <Banner key="needs" tone="primary" icon={<Sparkles className="size-4" />} action={<Button size="sm" variant="brand" onClick={() => document.getElementById("setup-needs-you")?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" })}>Show me <ArrowRight className="size-3.5" /></Button>}>
            {data.needsAttention === 1 ? "One thing needs your attention." : `${data.needsAttention} things need your attention.`}
          </Banner>
        )}
      </AnimatePresence>

      {(["agency", "client"] as const).map((section) => {
        const list = bySection(section);
        return (
          <section key={section} id={section === "client" ? "setup-needs-you" : undefined} aria-labelledby={`sec-${section}`} className="scroll-mt-24">
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <h2 id={`sec-${section}`} className="text-[16px] font-semibold tracking-tight text-ink">
                {SECTION_TITLE[section]}
              </h2>
              <InfoChip>
                {list.filter((t) => t.status === "completed").length} of {list.length} done
              </InfoChip>
            </div>
            {list.length === 0 ? (
              <Card>
                <EmptyState
                  compact
                  icon={section === "client" ? <CheckCircle2 className="size-5" /> : <ClipboardList className="size-5" />}
                  title={section === "client" ? "Nothing needs you right now" : "No steps to show yet"}
                  description={section === "client" ? "We'll tell you the moment we need something." : "Your checklist appears here once the iAcquire team sets it up."}
                />
              </Card>
            ) : (
              <ol className="relative space-y-3 border-l-2 border-line pl-4 sm:pl-6">
                {list.map((t, i) => (
                  <TaskCard key={t.id} task={t} index={i} timeZone={timeZone} highlight={changed.has(t.id)} onRespond={() => setResponding(t)} />
                ))}
              </ol>
            )}
          </section>
        );
      })}

      {/* Help */}
      <Card className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-primary-soft text-primary">
            <LifeBuoy className="size-5" />
          </span>
          <div>
            <h3 className="text-[15px] font-semibold text-ink">Questions about your setup?</h3>
            <p className="mt-0.5 text-[13.5px] text-muted">Ask the iAcquire Assistant, or message the team and a real person will reply here.</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => openHelp("chat")}>
            <Sparkles className="size-4" /> Ask the assistant
          </Button>
          <Button variant="brand" onClick={() => openHelp("human")}>
            <Headset className="size-4" /> Talk to iAcquire Team
          </Button>
        </div>
      </Card>

      <ResponseDialog
        preview={preview}
        task={responding}
        onClose={() => setResponding(null)}
        onSent={() => {
          selfAction.current = Date.now();
          void refresh();
        }}
      />
    </div>
  );
}

function Chip({ label, value, tone }: { label: string; value: number; tone: "success" | "primary" | "warning" | "danger" }) {
  const dot = { success: "bg-success", primary: "bg-primary", warning: "bg-warning", danger: "bg-danger" }[tone];
  return (
    <div className="flex items-center gap-2 rounded-xl border border-line bg-surface/70 px-3 py-2 backdrop-blur">
      <span className={cn("size-2 shrink-0 rounded-full", dot)} aria-hidden />
      <dd className="text-[15px] font-semibold tabular-nums text-ink">{value}</dd>
      <dt className="text-[12.5px] leading-tight text-muted">{label}</dt>
    </div>
  );
}

function Banner({ tone, icon, children, action }: { tone: "warning" | "primary" | "violet" | "success"; icon: React.ReactNode; children: React.ReactNode; action?: React.ReactNode }) {
  const reduce = useReducedMotion();
  const styles = {
    warning: "border-warning/25 bg-warning-soft text-warning-ink",
    primary: "border-primary/20 bg-primary-soft text-primary-ink",
    violet: "border-violet/20 bg-violet-soft text-violet-ink",
    success: "border-success/20 bg-success-soft text-success-ink",
  }[tone];
  return (
    <motion.div
      role="status"
      initial={false}
      animate={{ opacity: 1, height: "auto", y: 0 }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: reduce ? 0 : 0.28, ease: [0.16, 1, 0.3, 1] }}
      className="overflow-hidden"
    >
      <div className={cn("flex flex-col gap-3 rounded-2xl border px-4 py-3 text-[13.5px] leading-relaxed sm:flex-row sm:items-center", styles)}>
        <span className="flex flex-1 items-start gap-2.5">
          <span className="mt-0.5 shrink-0">{icon}</span>
          <span>{children}</span>
        </span>
        {action}
      </div>
    </motion.div>
  );
}

function TaskCard({ task: t, index, timeZone, highlight, onRespond }: { task: ClientTaskView; index: number; timeZone: string; highlight: boolean; onRespond: () => void }) {
  const reduce = useReducedMotion();
  const actionable = t.action?.available;
  return (
    <motion.li
      layout="position"
      initial={false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: reduce ? 0 : Math.min(index, 8) * 0.05, ease: [0.16, 1, 0.3, 1] }}
      className={cn(
        "page-in group relative rounded-2xl border bg-surface p-4 transition-[box-shadow,border-color,transform] duration-200 hover:shadow-card sm:p-5",
        actionable ? "border-warning/40" : "border-line",
        t.status === "blocked" && "border-danger/30",
        highlight && "ring-2 ring-primary/40",
      )}
    >
      <span aria-hidden className={cn("absolute -left-[24px] top-6 size-3 rounded-full border-[3px] border-bg sm:-left-[32px]",t.status==="completed"?"bg-success":t.status==="blocked"?"bg-danger":t.status==="in_progress"?"bg-primary":"bg-surface-3")}/>
      <div className="flex items-start gap-3.5">
        <StatusIcon status={t.status} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h3 className="text-[15px] font-semibold leading-snug tracking-tight text-ink">{t.title}</h3>
            <StatusBadge status={t.status} audience="client" />
            {!t.required && <InfoChip className="h-5 text-[12px]">Optional</InfoChip>}
          </div>
          {t.description && <p className="mt-1 text-[13.5px] leading-relaxed text-muted">{t.description}</p>}

          {t.status === "completed" && (
            <div className="mt-3 flex items-start gap-2 rounded-xl bg-success-soft px-3 py-2.5 text-[13px] text-success-ink">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
              <div>
                <p className="font-medium">Completed {t.completedAt ? formatDate(t.completedAt, timeZone) : ""}</p>
                {t.completionNote && <p className="mt-0.5 leading-relaxed">{t.completionNote}</p>}
              </div>
            </div>
          )}

          {t.status === "blocked" && (
            <div className="mt-3 rounded-xl bg-danger-soft px-3 py-2.5 text-[13px] leading-relaxed text-danger-ink">
              <p className="font-medium">Why this is on hold</p>
              <p className="mt-0.5">{t.blockedReason}</p>
            </div>
          )}

          {t.status === "waiting_for_client" && (
            <div className="mt-3 rounded-xl border border-warning/25 bg-warning-soft/60 px-3 py-3 text-[13px] leading-relaxed text-ink-2">
              {t.action && <p className="font-medium text-ink">{t.action.label}</p>}
              <p className={cn(t.action && "mt-0.5")}>{t.clientNote || t.action?.instructions}</p>
              {t.action && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="brand" onClick={onRespond} disabled={!actionable}>
                    {t.action.type === "review_and_approve" ? "Review" : t.action.type === "approve" ? "Review & approve" : t.action.type === "provide_info" ? "Reply" : "Mark as done"}
                    <ArrowRight className="size-3.5" />
                  </Button>
                  {t.action.unavailableReason && <span className="text-[12.5px] text-muted">{t.action.unavailableReason}</span>}
                </div>
              )}
            </div>
          )}

          {t.status === "ready_for_review" && (
            <p className="mt-3 text-[13px] leading-relaxed text-muted">
              {t.responded ? `Thank you. We received your response ${relativeTime(t.responded.at)} and our team is reviewing it.` : "This is ready and our team is giving it a final check."}
            </p>
          )}

          {t.status === "in_progress" && t.clientNote && <p className="mt-3 text-[13px] leading-relaxed text-muted">{t.clientNote}</p>}

          {t.status === "pending" && t.waitingOn.length > 0 && <div className="mt-3"><InfoChip icon={<Hourglass />}>Starts after {t.waitingOn.slice(0, 2).join(", ")}{t.waitingOn.length > 2 ? ` and ${t.waitingOn.length - 2} more` : ""}</InfoChip></div>}

          {t.attachments.length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-2">
              {t.attachments.map((a) => (
                <li key={a.id}>
                  <a href={a.url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-2.5 py-1 text-[12.5px] font-medium text-ink-2 transition hover:border-primary/30 hover:text-primary">
                    {a.label} <ExternalLink className="size-3" />
                  </a>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-muted">
            {t.estimatedCompletionAt && t.status !== "completed" && <InfoChip icon={<CalendarClock />}>Estimated {formatDate(`${t.estimatedCompletionAt}T12:00:00Z`, "UTC")}</InfoChip>}
            <InfoChip icon={<Clock />}>Updated {relativeTime(t.updatedAt)}</InfoChip>
            {t.history.length > 0 && (
              <details className="group/h">
                <summary className="cursor-pointer list-none rounded text-primary hover:underline [&::-webkit-details-marker]:hidden">History</summary>
                <ul className="mt-1.5 space-y-1 text-muted">
                  {t.history.map((h, i) => (
                    <li key={i}>
                      <span className="text-faint">{formatDate(h.at, timeZone)} · </span>
                      {h.text}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        </div>
      </div>
    </motion.li>
  );
}

function ResponseDialog({ task, onClose, onSent, preview }: { task: ClientTaskView | null; onClose: () => void; onSent: () => void; preview: boolean }) {
  const action = task?.action;
  const [message, setMessage] = React.useState("");
  const [choice, setChoice] = React.useState<"approve" | "request_changes">("approve");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // The dialog is modal, so clearing on close covers every way of leaving it.
  const close = () => {
    setMessage("");
    setChoice("approve");
    setError(null);
    onClose();
  };

  const submit = async () => {
    if (!task || !action || preview) return;
    setPending(true);
    setError(null);
    const decision = action.type === "provide_info" ? undefined : action.type === "approve" ? "approve" : action.type === "external" ? "confirm" : choice;
    const res = await respondToSetupAction(task.id, { decision, message });
    setPending(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    toast.success(decision === "request_changes" ? "Thanks. We'll make those changes." : "Thank you. The iAcquire team has been notified.");
    onSent();
    close();
  };

  const cta =
    action?.type === "provide_info" ? "Send" : action?.type === "approve" ? "Approve" : action?.type === "external" ? "I've done this" : choice === "approve" ? "Approve" : "Send my changes";

  return (
    <Dialog
      open={Boolean(task)}
      onOpenChange={(o) => !o && close()}
      title={action?.label ?? "Respond"}
      description={task?.title}
      footer={
        <>
          {action?.type === "external" && (
            <Button variant="ghost" onClick={() => openHelp("human")}>
              <Headset className="size-4" /> Ask the team
            </Button>
          )}
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button variant="brand" loading={pending} onClick={submit} disabled={preview}>
            {cta}
          </Button>
        </>
      }
    >
      {action && (
        <div className="space-y-4">
          <p className="text-[14px] leading-relaxed text-ink-2">{task?.clientNote || action.instructions}</p>
          {action.type === "review_and_approve" && (
            <>
              {action.previewLinks.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {action.previewLinks.map((l) => (
                    <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1.5 rounded-xl border border-line bg-surface-2 px-3 py-2 text-[13px] font-medium text-primary transition hover:border-primary/30">
                      {l.label} <ExternalLink className="size-3.5" />
                    </a>
                  ))}
                </div>
              ) : (
                <p className="rounded-xl bg-surface-2 px-3 py-2.5 text-[13px] text-muted">The preview link will appear here when the team shares it. Message the team if you can&apos;t find it.</p>
              )}
              <Segmented
                id="setup-review-choice"
                ariaLabel="Your decision"
                value={choice}
                onChange={setChoice}
                options={[
                  { value: "approve", label: "Looks good" },
                  { value: "request_changes", label: "Request changes" },
                ]}
              />
            </>
          )}
          {(action.type === "provide_info" || (action.type === "review_and_approve" && choice === "request_changes") || action.type === "external" || action.type === "approve") && (
            <Field
              label={action.type === "provide_info" ? "Your answer" : action.type === "review_and_approve" ? "What should we change?" : "Add a note"}
              htmlFor="setup-response"
              optional={action.type === "approve" || action.type === "external"}
            >
              <Textarea id="setup-response" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={2000} rows={4} placeholder="Type here…" />
            </Field>
          )}
          {error && (
            <p role="alert" className="text-[13px] text-danger-ink">
              {error}
            </p>
          )}
          <p className="text-[12.5px] leading-relaxed text-muted">Your response goes to the iAcquire team, who review it before anything is marked complete.</p>
        </div>
      )}
    </Dialog>
  );
}
