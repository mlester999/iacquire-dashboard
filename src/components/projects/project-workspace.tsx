"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion, useReducedMotion } from "motion/react";
import { toast } from "sonner";
import {
  AlertTriangle, ArrowRight, CalendarClock, Check, CheckCircle2, ChevronDown, CircleDashed, Flag, Info, History, Milestone, CircleDot, Download, FileText, Hourglass, LifeBuoy, MessageSquare, Paperclip, PartyPopper, Send, ShieldCheck,
} from "lucide-react";
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState, Field, Input, Textarea } from "@/components/ui/primitives";
import { InfoChip, StatusPill } from "@/components/ui/status";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { ProjectStatusBadge, bytesLabel, useRunner } from "@/components/projects/common";
import { decideQuoteAction, markQuoteViewedAction, postProjectMessageAction, respondToMilestoneAction } from "@/app/actions/projects";
import { createTicketAction } from "@/app/actions/support";
import { MILESTONE_LABEL, PROJECT_FLOW, PROJECT_STATUS_LABEL, QUOTE_ACKNOWLEDGEMENT, QUOTE_STATUS_LABEL, formatMoney, type ProjectStatus } from "@/lib/projects";
import type { MilestoneView, ProjectDetail, QuoteView } from "@/server/projects/shared";
import { cn, formatDate, formatDateTime, relativeTime } from "@/lib/utils";
import { PageHero } from "@/components/ui/workspace";

const SHORT: Record<string, string> = { submitted: "Submitted", under_review: "Review", quote_preparing: "Quote", quote_sent: "Quote sent", approved: "Approved", in_development: "Building", testing: "Testing", ready_for_review: "Your review", completed: "Done" };

function effective(status: ProjectStatus, before: ProjectStatus | null): ProjectStatus {
  const s = status === "on_hold" ? (before ?? "under_review") : status;
  if (s === "discovery_needed") return "under_review";
  if (s === "awaiting_approval") return "quote_sent";
  return s;
}

function ProgressStepper({ status, before }: { status: ProjectStatus; before: ProjectStatus | null }) {
  const current = effective(status, before);
  const idx = PROJECT_FLOW.indexOf(current);
  const stopped = status === "cancelled";
  return (
    <ol aria-label="Project progress" className="flex w-full items-start">
      {PROJECT_FLOW.map((s, i) => {
        const done = !stopped && (i < idx || status === "completed");
        const active = !stopped && i === idx && status !== "completed";
        return (
          <li key={s} className="relative flex min-w-0 flex-1 flex-col items-center text-center" aria-label={PROJECT_STATUS_LABEL[s]} aria-current={active ? "step" : undefined}>
            {i > 0 && <span aria-hidden className={cn("absolute right-1/2 top-[11px] h-0.5 w-full", done || active ? "bg-primary" : "bg-line")} />}
            <span className={cn("relative z-10 flex size-6 items-center justify-center rounded-full border-2 bg-surface text-[10px] font-semibold", done ? "border-primary bg-primary text-white" : active ? "border-primary text-primary" : "border-line text-faint")}>
              {done ? <Check className="size-3.5" /> : i + 1}
            </span>
            <span className={cn("mt-1.5 hidden px-0.5 text-[11px] leading-tight sm:block", active ? "font-semibold text-ink" : done ? "text-ink-2" : "text-faint")}>{SHORT[s]}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function ProjectWorkspace({
  project,
  timeZone,
  canRequest,
  canApproveQuote,
  canOpenSupport,
  justSubmitted,
}: {
  project: ProjectDetail;
  timeZone: string;
  canRequest: boolean;
  canApproveQuote: boolean;
  canOpenSupport: boolean;
  justSubmitted: boolean;
}) {
  const r = project.request;
  const closed = r.status === "cancelled" || r.status === "completed";
  const liveQuote = project.quotes.find((q) => q.status === "sent") ?? null;
  const awaiting = project.milestones.filter((m) => m.status === "awaiting_approval");
  const threadRef = React.useRef<HTMLDivElement>(null);

  return (
    <div className="space-y-5">
      <PageHero tone="dark" eyebrow={`${r.ref} / Custom project`} title={r.title} description={<><span className="block">Requested {formatDate(r.submittedAt,timeZone)} · last activity {relativeTime(r.lastActivityAt)}</span><span className="mt-2 flex flex-wrap gap-2"><ProjectStatusBadge status={r.status}/>{r.serviceName&&<Badge tone="outline" className="border-white/20 text-slate-200">{r.serviceName}</Badge>}</span></>} aside={<div className="rounded-2xl border border-white/15 bg-white/5 p-4"><p className="text-[10px] font-semibold uppercase tracking-[.12em] text-blue-200">Delivery milestones</p><p className="mt-2 text-[26px] font-semibold tabular-nums">{project.milestones.length?<>{project.milestones.filter(m=>m.status==="completed").length}<span className="ml-1 text-sm font-normal text-slate-300">/ {project.milestones.length} completed</span></>:<span className="text-[22px]">Not set yet</span>}</p><p className="mt-2 text-[11px] leading-relaxed text-slate-300">{awaiting.length?`${awaiting.length} milestone${awaiting.length===1?"":"s"} waiting for your review`:project.milestones.length?"Follow the details and decisions below.":"Milestones appear once your scope is agreed."}</p></div>}/>

      {justSubmitted && (
        <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} className="flex items-start gap-3 rounded-2xl border border-success/25 bg-success-soft/70 p-4">
          <PartyPopper className="mt-0.5 size-5 shrink-0 text-success" />
          <div>
            <p className="text-[14px] font-semibold text-success-ink">Request received. Thank you!</p>
            <p className="mt-0.5 text-[13px] leading-relaxed text-success-ink/90">The iAcquire team has been notified and will review it. We&apos;ll ask anything we need to know here, then send a written quote. You haven&apos;t been charged.</p>
          </div>
        </motion.div>
      )}

      {r.status === "on_hold" && <Notice tone="neutral" title="This project is on hold" body="We'll update this page when work resumes. Message us below if you have questions." />}
      {r.status === "cancelled" && <Notice tone="danger" title="This project was cancelled" body={r.cancelReason ?? "No reason was recorded."} />}
      {r.status === "discovery_needed" && (
        <Notice tone="warning" title="We need a little more information" body="Please answer our question in the conversation below so we can continue." action={<Button size="sm" variant="secondary" onClick={() => threadRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>Go to the conversation</Button>} />
      )}
      {liveQuote && <Notice tone="warning" title="Your quote is ready for a decision" body="Review the scope, price and terms below. Accepting records your decision. Nothing is charged automatically." />}
      {awaiting.length > 0 && <Notice tone="warning" title={`${awaiting.length} deliverable${awaiting.length > 1 ? "s" : ""} waiting for your approval`} body="Review and approve them, or tell us what to change, in Milestones below." />}

      <Card className="border-primary/15 bg-primary-soft/15 px-4 py-5 sm:px-6">
        <ProgressStepper status={r.status} before={r.statusBeforeHold} />
        <p className="mt-4 flex items-center justify-center gap-2 text-[12.5px] text-muted">
          Current stage <ProjectStatusBadge status={r.status} />
        </p>
      </Card>
      <nav aria-label="Project workspace sections" className="flex gap-1 overflow-x-auto rounded-xl border border-line bg-surface p-1.5 shadow-card [scrollbar-width:none]"><a href="#project-milestones" className="inline-flex min-h-10 shrink-0 items-center rounded-lg px-3.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-primary-soft hover:text-primary-ink">Milestones</a>{project.quotes.length>0&&<a href="#project-quotes" className="inline-flex min-h-10 shrink-0 items-center rounded-lg px-3.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-primary-soft hover:text-primary-ink">Scope & quotes</a>}<a href="#project-conversation" className="inline-flex min-h-10 shrink-0 items-center rounded-lg px-3.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-primary-soft hover:text-primary-ink">Conversation <span className="ml-1.5 rounded-md bg-surface-3 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-ink-2">{project.messages.length}</span></a><a href="#project-updates" className="inline-flex min-h-10 shrink-0 items-center rounded-lg px-3.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-primary-soft hover:text-primary-ink">Activity</a></nav>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-5">
          {project.quotes.length > 0 && <div id="project-quotes" className="scroll-mt-24"><QuoteSection requestId={r.id} quotes={project.quotes} timeZone={timeZone} canAct={canRequest} canApprove={canApproveQuote}/></div>}
          {project.delivery && <DeliveryCard project={project} timeZone={timeZone} />}
          <div id="project-milestones" className="scroll-mt-24"><MilestonesCard requestId={r.id} milestones={project.milestones} canAct={canRequest} timeZone={timeZone}/></div>
          <div id="project-updates" className="scroll-mt-24"><UpdatesCard updates={project.updates} timeZone={timeZone}/></div>
          <div ref={threadRef} id="project-conversation" className="scroll-mt-24">
            <ThreadCard requestId={r.id} messages={project.messages} canPost={canRequest && !closed} timeZone={timeZone} />
          </div>
        </div>
        <aside className="min-w-0 space-y-5">
          <RequestCard project={project} />
          <FilesCard project={project} canUpload={canRequest && !closed} />
          <SupportCard project={project} canOpen={canOpenSupport} />
        </aside>
      </div>
    </div>
  );
}

function Notice({ tone, title, body, action }: { tone: "warning" | "danger" | "neutral"; title: string; body: string; action?: React.ReactNode }) {
  const styles = { warning: "border-warning/30 bg-warning-soft/70 text-warning-ink", danger: "border-danger/25 bg-danger-soft/70 text-danger-ink", neutral: "border-line bg-surface-2 text-ink-2" }[tone];
  return (
    <div role="status" className={cn("flex flex-col gap-3 rounded-2xl border p-4 sm:flex-row sm:items-center", styles)}>
      <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface/70 ring-1 ring-inset ring-current/15">{tone === "neutral" ? <Info className="size-[18px]" /> : <AlertTriangle className="size-[18px]" />}</span>
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-semibold">{title}</p>
        <p className="mt-0.5 text-[13px] leading-relaxed opacity-90">{body}</p>
      </div>
      {action}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quote
// ---------------------------------------------------------------------------

function QuoteSection({ requestId, quotes, timeZone, canAct, canApprove }: { requestId: string; quotes: QuoteView[]; timeZone: string; canAct: boolean; canApprove: boolean }) {
  const live = quotes.find((q) => q.status === "sent") ?? null;
  const shown = live ?? quotes[0];
  const history = quotes.filter((q) => q.id !== shown.id);
  const [showHistory, setShowHistory] = React.useState(false);
  const viewed = React.useRef(false);
  React.useEffect(() => {
    if (live && !live.firstViewedAt && !viewed.current) {
      viewed.current = true;
      void markQuoteViewedAction(requestId, live.id);
    }
  }, [live, requestId]);
  return (
    <div className="space-y-3">
      <QuoteCard requestId={requestId} quote={shown} timeZone={timeZone} canAct={canAct && shown.status === "sent"} canApprove={canApprove} />
      {history.length > 0 && (
        <div>
          <button type="button" onClick={() => setShowHistory((v) => !v)} className="inline-flex min-h-10 items-center gap-1 text-[12.5px] font-medium text-ink-2 hover:text-ink" aria-expanded={showHistory}>
            <ChevronDown className={cn("size-4 transition-transform", showHistory && "rotate-180")} /> Earlier quote versions ({history.length})
          </button>
          {showHistory && (
            <ul className="mt-2 space-y-2">
              {history.map((q) => (
                <li key={q.id} className="rounded-xl border border-line bg-surface-2/50 p-3 text-[13px]">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">Version {q.version}</span>
                    <span className="tabular-nums text-ink-2">{formatMoney(q.oneTimeCents, q.currency)}</span>
                    <StatusPill size="sm" tone={q.status === "accepted" ? "success" : q.status === "sent" ? "warning" : q.status === "declined" ? "danger" : "neutral"}>{QUOTE_STATUS_LABEL[q.status] ?? q.status}</StatusPill>
                  </div>
                  {q.decision?.note && <p className="mt-1 text-muted">“{q.decision.note}”</p>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function QuoteCard({ requestId, quote: q, timeZone, canAct, canApprove }: { requestId: string; quote: QuoteView; timeZone: string; canAct: boolean; canApprove: boolean }) {
  const router = useRouter();
  const { run, isPending } = useRunner();
  const [mode, setMode] = React.useState<null | "accept" | "changes" | "decline">(null);
  const [note, setNote] = React.useState("");
  const [ack, setAck] = React.useState(false);
  const expired = q.validUntil !== null && q.validUntil < new Date().toISOString().slice(0, 10);
  const close = () => {
    setMode(null);
    setNote("");
    setAck(false);
  };
  async function decide(decision: "accepted" | "changes_requested" | "declined") {
    const res = await run("decide", () => decideQuoteAction(requestId, q.id, decision, note || undefined), decision === "accepted" ? "Quote accepted. We'll confirm the written agreement and next steps." : "Your response was sent.");
    if (res) {
      close();
      router.refresh();
    }
  }
  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <div>
          <SectionTitle icon={<FileText />}>Quote · {q.projectName}</SectionTitle>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <InfoChip>Version {q.version}</InfoChip>
            {q.sentAt && <InfoChip icon={<CalendarClock />}>Sent {formatDate(q.sentAt, timeZone)}</InfoChip>}
            {q.validUntil && <InfoChip icon={<CalendarClock />}>Valid until {formatDate(q.validUntil, timeZone)}</InfoChip>}
          </div>
        </div>
        <StatusPill tone={q.status === "accepted" ? "success" : q.status === "sent" ? "warning" : q.status === "declined" ? "danger" : "neutral"}>{QUOTE_STATUS_LABEL[q.status] ?? q.status}</StatusPill>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl bg-surface-2 p-4">
            <p className="text-[11.5px] font-medium uppercase tracking-[.08em] text-muted">One-time cost</p>
            <p className="mt-1 text-[28px] font-semibold tabular-nums tracking-tight">{formatMoney(q.oneTimeCents, q.currency)}</p>
          </div>
          <div className="rounded-xl bg-surface-2 p-4">
            <p className="text-[11.5px] font-medium uppercase tracking-[.08em] text-muted">Optional ongoing cost</p>
            {q.ongoingMonthlyCents ? (
              <>
                <p className="mt-1 text-[22px] font-semibold tabular-nums">{formatMoney(q.ongoingMonthlyCents, q.currency)}/month</p>
                {q.ongoingDescription && <p className="mt-0.5 text-[12px] text-muted">{q.ongoingDescription}</p>}
              </>
            ) : (
              <div className="mt-2"><StatusPill tone="neutral">None</StatusPill></div>
            )}
          </div>
        </div>
        <Block title="Scope of work">
          <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink-2">{q.scope}</p>
        </Block>
        <div className="grid gap-5 sm:grid-cols-2">
          <ListBlock title="Deliverables" items={q.deliverables} />
          <ListBlock title="Included integrations" items={q.includedIntegrations} />
          <ListBlock title="Exclusions" items={q.exclusions} muted />
          <Block title="Estimated timeline">
            <p className="text-[13.5px] text-ink-2">{q.timelineText}</p>
          </Block>
        </div>
        <div className="grid gap-5 sm:grid-cols-3">
          <Block title="Revision terms">
            <p className="text-[13px] leading-relaxed text-ink-2">{q.revisionTerms}</p>
          </Block>
          <Block title="Payment terms">
            <p className="text-[13px] leading-relaxed text-ink-2">{q.paymentTerms}</p>
          </Block>
          <Block title="Support / warranty">
            <p className="text-[13px] leading-relaxed text-ink-2">{q.warrantyTerms}</p>
          </Block>
        </div>
        {q.decision && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-surface-2 p-3 text-[13px] text-ink-2 ring-1 ring-inset ring-line">
            <StatusPill tone={q.decision.decision === "accepted" ? "success" : q.decision.decision === "declined" ? "danger" : "warning"}>{q.decision.decision === "accepted" ? "Accepted" : q.decision.decision === "declined" ? "Declined" : "Changes requested"}</StatusPill>
            <span>by {q.decision.decidedByName ?? "your team"} on {formatDateTime(q.decision.decidedAt, timeZone)}</span>
            {q.decision.note && <p className="w-full text-muted">“{q.decision.note}”</p>}
          </div>
        )}
        {canAct && (
          <div className="space-y-3 border-t border-line pt-4">
            {expired && <StatusPill tone="danger" icon={<AlertTriangle className="size-3.5" />}>This quote has expired. Ask us for an updated quote.</StatusPill>}
            <div className="flex flex-wrap gap-2">
              <Button variant="brand" disabled={!canApprove || expired} onClick={() => setMode("accept")}>
                <CheckCircle2 className="size-4" /> Accept Quote
              </Button>
              <Button variant="secondary" onClick={() => setMode("changes")}>
                Request Changes
              </Button>
              <Button variant="ghost" disabled={!canApprove} onClick={() => setMode("decline")}>
                Decline Quote
              </Button>
            </div>
            {!canApprove && <p className="text-[12.5px] text-muted">A workspace owner accepts or declines quotes. You can still request changes.</p>}
          </div>
        )}
      </CardContent>

      <Dialog
        open={mode !== null}
        onOpenChange={(o) => !o && close()}
        title={mode === "accept" ? "Accept this quote" : mode === "changes" ? "Request changes" : "Decline this quote"}
        description={mode === "accept" ? `${q.projectName} · ${formatMoney(q.oneTimeCents, q.currency)} one-time` : "Your note goes straight to the iAcquire team."}
        footer={
          <>
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            {mode === "accept" && (
              <Button variant="brand" loading={isPending("decide")} disabled={!ack} onClick={() => void decide("accepted")}>
                Accept Quote
              </Button>
            )}
            {mode === "changes" && (
              <Button variant="brand" loading={isPending("decide")} disabled={note.trim().length < 3} onClick={() => void decide("changes_requested")}>
                Send request
              </Button>
            )}
            {mode === "decline" && (
              <Button variant="danger" loading={isPending("decide")} onClick={() => void decide("declined")}>
                Decline
              </Button>
            )}
          </>
        }
      >
        {mode === "accept" ? (
          <div className="space-y-4">
            <label className="flex items-start gap-3 rounded-xl border border-line bg-surface-2/60 p-3.5 text-[13px] leading-relaxed text-ink-2">
              <input type="checkbox" className="mt-1" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              <span>{QUOTE_ACKNOWLEDGEMENT}</span>
            </label>
            <p className="flex items-start gap-2 text-[12.5px] text-muted">
              <ShieldCheck className="mt-0.5 size-4 shrink-0" /> No payment is taken here. We&apos;ll confirm the agreement and payment terms with you directly.
            </p>
          </div>
        ) : (
          <Field label={mode === "changes" ? "What would you like changed?" : "Reason (optional)"} htmlFor="q-note">
            <Textarea id="q-note" rows={4} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
          </Field>
        )}
      </Dialog>
    </Card>
  );
}

function SectionTitle({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <CardTitle className="flex min-w-0 items-center gap-2.5">
      <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary ring-1 ring-inset ring-primary/15 [&>svg]:size-4">{icon}</span>
      <span className="min-w-0">{children}</span>
    </CardTitle>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <h3 className="mb-1.5 text-[12px] font-semibold uppercase tracking-[.08em] text-muted">{title}</h3>
      {children}
    </div>
  );
}
function ListBlock({ title, items, muted }: { title: string; items: string[]; muted?: boolean }) {
  if (!items.length) return null;
  return (
    <Block title={title}>
      <ul className="space-y-1">
        {items.map((i) => (
          <li key={i} className="flex items-start gap-2 text-[13.5px] leading-snug text-ink-2">
            {muted ? <span className="mt-2 size-1 shrink-0 rounded-full bg-faint" /> : <Check className="mt-0.5 size-4 shrink-0 text-success" />} {i}
          </li>
        ))}
      </ul>
    </Block>
  );
}

// ---------------------------------------------------------------------------
// Delivery, milestones, updates
// ---------------------------------------------------------------------------

function DeliveryCard({ project, timeZone }: { project: ProjectDetail; timeZone: string }) {
  const d = project.delivery!;
  return (
    <Card>
      <CardHeader>
        <SectionTitle icon={<ShieldCheck />}>Agreed project</SectionTitle>
        <StatusPill tone="success" className="tabular-nums">{formatMoney(d.agreedPriceCents, d.currency)}</StatusPill>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-1.5">
          <InfoChip icon={<CalendarClock />}>Agreed {formatDate(d.agreedAt, timeZone)}</InfoChip>
          {d.startedAt && <InfoChip icon={<Flag />}>Started {formatDate(d.startedAt, timeZone)}</InfoChip>}
          {d.timelineText && <InfoChip>{d.timelineText}</InfoChip>}
        </div>
        <Block title="Scope">
          <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink-2">{d.scope}</p>
        </Block>
        <ListBlock title="Deliverables" items={d.deliverables} />
        {d.handoverNotes && (
          <div className="rounded-xl border border-success/25 bg-success-soft/60 p-4">
            <p className="text-[13px] font-semibold text-success-ink">Handover{d.completedAt ? ` · ${formatDate(d.completedAt, timeZone)}` : ""}</p>
            <p className="mt-1 whitespace-pre-wrap text-[13.5px] leading-relaxed text-success-ink/90">{d.handoverNotes}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const MS_ICON: Record<MilestoneView["status"], React.ReactNode> = {
  pending: <CircleDashed className="size-5 text-faint" />,
  in_progress: <CircleDot className="size-5 text-primary" />,
  awaiting_approval: <Hourglass className="size-5 text-warning" />,
  completed: <CheckCircle2 className="size-5 text-success" />,
  blocked: <AlertTriangle className="size-5 text-danger" />,
};

function MilestonesCard({ requestId, milestones, canAct, timeZone }: { requestId: string; milestones: MilestoneView[]; canAct: boolean; timeZone: string }) {
  const router = useRouter();
  const { run, isPending } = useRunner();
  const [target, setTarget] = React.useState<MilestoneView | null>(null);
  const [note, setNote] = React.useState("");
  async function respond(m: MilestoneView, decision: "approve" | "request_changes", text?: string) {
    const ok = await run(`${m.id}:${decision}`, () => respondToMilestoneAction(requestId, m.id, decision, text), decision === "approve" ? "Approved. Thank you!" : "Your feedback was sent.");
    if (ok !== null) {
      setTarget(null);
      setNote("");
      router.refresh();
    }
  }
  return (
    <Card>
      <CardHeader>
        <SectionTitle icon={<Milestone />}>Milestones</SectionTitle>
        {milestones.length > 0 && <InfoChip className="tabular-nums">{milestones.filter((m) => m.status === "completed").length} of {milestones.length} complete</InfoChip>}
      </CardHeader>
      <CardContent>
        {milestones.length === 0 ? (
          <EmptyState compact icon={<Milestone className="size-5" />} title="No milestones yet" description="Milestones appear here once the project is scoped and agreed." />
        ) : (
          <ol className="relative space-y-1">
            {milestones.map((m, i) => (
              <li key={m.id} className="relative flex gap-3 pb-4 last:pb-0">
                {i < milestones.length - 1 && <span aria-hidden className="absolute left-[9.5px] top-6 h-[calc(100%-1rem)] w-px bg-line" />}
                <span className="relative z-10 mt-0.5 shrink-0 bg-surface">{MS_ICON[m.status]}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <p className="text-[14px] font-medium">{m.title}</p>
                    <StatusPill size="sm" tone={m.status === "completed" ? "success" : m.status === "awaiting_approval" ? "warning" : m.status === "blocked" ? "danger" : m.status === "in_progress" ? "primary" : "neutral"}>{MILESTONE_LABEL[m.status]}</StatusPill>
                    {m.requiresClientApproval && m.status !== "completed" && <InfoChip>Needs your approval</InfoChip>}
                  </div>
                  {m.description && <p className="mt-0.5 text-[13px] text-muted">{m.description}</p>}
                  {(m.completedAt || m.dueOn) && <p className="mt-1 inline-flex items-center gap-1.5 text-[12px] text-muted"><CalendarClock aria-hidden className="size-3.5" />{m.completedAt ? `Completed ${formatDate(m.completedAt, timeZone)}` : `Target ${formatDate(m.dueOn!, timeZone)}`}</p>}
                  {m.clientNote && m.status !== "completed" && <p className="mt-2 rounded-lg bg-surface-2 px-3 py-2 text-[12.5px] text-ink-2 ring-1 ring-inset ring-line">Your note: “{m.clientNote}”</p>}
                  {m.status === "awaiting_approval" && canAct && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button size="sm" variant="brand" loading={isPending(`${m.id}:approve`)} onClick={() => void respond(m, "approve")}>
                        <Check className="size-3.5" /> Approve
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => setTarget(m)}>
                        Request changes
                      </Button>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
      <Dialog
        open={!!target}
        onOpenChange={(o) => !o && setTarget(null)}
        title="Request changes"
        description={target?.title}
        footer={
          <>
            <Button variant="secondary" onClick={() => setTarget(null)}>
              Cancel
            </Button>
            <Button variant="brand" disabled={note.trim().length < 3} loading={target ? isPending(`${target.id}:request_changes`) : false} onClick={() => target && void respond(target, "request_changes", note)}>
              Send feedback
            </Button>
          </>
        }
      >
        <Field label="What needs to change?" htmlFor="ms-note">
          <Textarea id="ms-note" rows={4} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </Dialog>
    </Card>
  );
}

function UpdatesCard({ updates, timeZone }: { updates: ProjectDetail["updates"]; timeZone: string }) {
  const [all, setAll] = React.useState(false);
  const list = all ? updates : updates.slice(0, 5);
  return (
    <Card>
      <CardHeader>
        <SectionTitle icon={<History />}>Updates</SectionTitle>
      </CardHeader>
      <CardContent>
        {updates.length === 0 ? (
          <EmptyState compact icon={<History className="size-5" />} title="No updates yet" description="Progress updates from the iAcquire team will appear here." />
        ) : (
          <ul className="space-y-3">
            {list.map((u) => (
              <li key={u.id} className="flex gap-3">
                <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-primary/60" />
                <div className="min-w-0">
                  <p className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-ink-2">{u.body}</p>
                  <p className="mt-0.5 text-[12px] text-faint">
                    {u.authorName ? `${u.authorName} · ` : ""}
                    {formatDateTime(u.createdAt, timeZone)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
        {updates.length > 5 && (
          <Button variant="secondary" size="sm" className="mt-3" onClick={() => setAll((v) => !v)}>
            {all ? "Show fewer" : `Show all ${updates.length}`}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Conversation, request details, files, support
// ---------------------------------------------------------------------------

function ThreadCard({ requestId, messages, canPost, timeZone }: { requestId: string; messages: ProjectDetail["messages"]; canPost: boolean; timeZone: string }) {
  const router = useRouter();
  const reduce = useReducedMotion();
  const { run, isPending } = useRunner();
  const [body, setBody] = React.useState("");
  async function send() {
    const ok = await run("msg", () => postProjectMessageAction(requestId, body));
    if (ok !== null) {
      setBody("");
      router.refresh();
    }
  }
  return (
    <Card>
      <CardHeader>
        <SectionTitle icon={<MessageSquare />}>Conversation</SectionTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {messages.length === 0 ? (
          <EmptyState compact icon={<MessageSquare className="size-5" />} title="No messages yet" description="Questions and answers between you and the iAcquire team appear here." />
        ) : (
          <ul className="space-y-3">
            {messages.map((m) => (
              <motion.li key={m.id} initial={reduce ? false : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} className={cn("max-w-[92%] rounded-2xl px-4 py-3 text-[13.5px] leading-relaxed", m.authorKind === "client" ? "ml-auto bg-primary-soft text-primary-ink" : "bg-surface-2 text-ink-2")}>
                {m.kind === "info_request" && <StatusPill size="sm" tone="warning" className="mb-2">Question from iAcquire</StatusPill>}
                <p className="whitespace-pre-wrap break-words">{m.body}</p>
                <p className="mt-1.5 text-[11.5px]">
                  {m.authorKind === "agency" ? "iAcquire team" : m.authorKind === "system" ? "iAcquire" : (m.authorName ?? "You")} · {formatDateTime(m.createdAt, timeZone)}
                </p>
              </motion.li>
            ))}
          </ul>
        )}
        {canPost ? (
          <div className="space-y-2 border-t border-line pt-4">
            <label htmlFor="proj-msg" className="sr-only">
              Message the iAcquire team
            </label>
            <Textarea id="proj-msg" rows={3} value={body} maxLength={5000} placeholder="Write a message or answer a question…" onChange={(e) => setBody(e.target.value)} />
            <div className="flex justify-end">
              <Button variant="brand" size="sm" loading={isPending("msg")} disabled={!body.trim()} onClick={() => void send()}>
                <Send className="size-3.5" /> Send
              </Button>
            </div>
          </div>
        ) : (
          <p className="flex items-start gap-2 border-t border-line pt-3 text-[12.5px] text-muted"><Info aria-hidden className="mt-0.5 size-4 shrink-0" />Messaging is available to workspace owners and admins while a project is open.</p>
        )}
      </CardContent>
    </Card>
  );
}

function RequestCard({ project }: { project: ProjectDetail }) {
  const [open, setOpen] = React.useState(false);
  const rows = project.requirements.filter((x) => x.answer);
  return (
    <Card>
      <CardHeader>
        <SectionTitle icon={<FileText />}>Your request</SectionTitle>
        <button type="button" onClick={() => setOpen((v) => !v)} className="inline-flex min-h-9 items-center rounded-lg px-2 text-[12px] font-medium text-primary hover:bg-primary-soft" aria-expanded={open}>
          {open ? "Collapse" : "Expand"}
        </button>
      </CardHeader>
      <CardContent>
        <dl className="space-y-3">
          {rows.slice(0, open ? rows.length : 2).map((x) => (
            <div key={x.key}>
              <dt className="text-[11.5px] font-medium text-muted">{x.label}</dt>
              <dd className={cn("mt-0.5 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-2", !open && "line-clamp-3")}>{x.answer}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

function FilesCard({ project, canUpload }: { project: ProjectDetail; canUpload: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const ref = React.useRef<HTMLInputElement>(null);
  async function upload(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      const body = new FormData();
      body.set("file", file);
      const res = await fetch(`/api/projects/${project.request.id}/files`, { method: "POST", body });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "That file couldn't be saved.");
      toast.success("File added");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That file couldn't be saved.");
    } finally {
      setBusy(false);
      if (ref.current) ref.current.value = "";
    }
  }
  return (
    <Card>
      <CardHeader>
        <SectionTitle icon={<Paperclip />}>Files</SectionTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {project.files.length === 0 ? (
          <EmptyState compact icon={<Paperclip className="size-5" />} title="No files yet" description="Deliverables and anything you share appear here." />
        ) : (
          <ul className="space-y-2">
            {project.files.map((f) => (
              <li key={f.id}>
                <a href={`/api/projects/files/${f.id}`} className="flex min-w-0 items-center gap-2 rounded-xl bg-surface-2 px-3 py-2 text-[13px] transition hover:bg-surface-3">
                  <FileText className="size-4 shrink-0 text-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{f.filename}</span>
                    <span className="block text-[11px] text-faint">
                      {f.uploadedByKind === "agency" ? "From iAcquire" : "From you"} · {bytesLabel(f.sizeBytes)}
                    </span>
                  </span>
                  <Download className="size-3.5 shrink-0 text-muted" />
                </a>
              </li>
            ))}
          </ul>
        )}
        {canUpload && (
          <label className="block text-[12px] text-muted">
            Add a document or screenshot (up to 10 MB)
            <input ref={ref} type="file" accept=".pdf,.docx,.png,.jpg,.jpeg,.txt,.md,.csv" disabled={busy} onChange={(e) => void upload(e.target.files?.[0])} className="mt-1 block w-full min-w-0 text-[12px] file:mr-3 file:rounded-lg file:border-0 file:bg-surface-3 file:px-3 file:py-2 file:text-ink" />
          </label>
        )}
      </CardContent>
    </Card>
  );
}

function SupportCard({ project, canOpen }: { project: ProjectDetail; canOpen: boolean }) {
  const router = useRouter();
  const { run, isPending } = useRunner();
  const [open, setOpen] = React.useState(false);
  const [subject, setSubject] = React.useState("");
  const [message, setMessage] = React.useState("");
  async function create() {
    const res = await run("ticket", () => createTicketAction({ subject: `${project.request.ref}: ${subject}`.slice(0, 160), message, category: "project", priority: "normal", projectId: project.request.id }));
    if (res) {
      toast.success(`Request ${res.ref} created`);
      setOpen(false);
      router.push(`/support/${res.id}`);
    }
  }
  return (
    <Card>
      <CardHeader>
        <SectionTitle icon={<LifeBuoy />}>Support for this project</SectionTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {project.tickets.length > 0 && (
          <ul className="space-y-1.5">
            {project.tickets.map((t) => (
              <li key={t.id}>
                <Link href={`/support/${t.id}`} className="flex items-center justify-between gap-2 rounded-xl bg-surface-2 px-3 py-2 text-[13px] hover:bg-surface-3">
                  <span className="min-w-0 truncate">
                    <span className="font-mono text-[11.5px] text-muted">{t.ref}</span> {t.subject.replace(`${project.request.ref}: `, "")}
                  </span>
                  <ArrowRight className="size-3.5 shrink-0 text-muted" />
                </Link>
              </li>
            ))}
          </ul>
        )}
        {canOpen ? (
          <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
            Open a support request
          </Button>
        ) : (
          <p className="text-[12.5px] text-muted">Support requests are opened by your workspace team.</p>
        )}
      </CardContent>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Support request about this project"
        description="It goes to the iAcquire support inbox with this project attached."
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="brand" loading={isPending("ticket")} disabled={subject.trim().length < 3 || message.trim().length < 5} onClick={() => void create()}>
              Send request
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Subject" htmlFor="ps-subject">
            <Input id="ps-subject" value={subject} maxLength={120} onChange={(e) => setSubject(e.target.value)} />
          </Field>
          <Field label="How can we help?" htmlFor="ps-message">
            <Textarea id="ps-message" rows={4} value={message} maxLength={5000} onChange={(e) => setMessage(e.target.value)} />
          </Field>
        </div>
      </Dialog>
    </Card>
  );
}
