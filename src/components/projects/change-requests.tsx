"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, CheckCircle2, ClipboardList, Info, Lock, PencilRuler, Plus, Send, ShieldCheck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, EmptyState, Field, Input, Textarea } from "@/components/ui/primitives";
import { InfoChip, StatusPill } from "@/components/ui/status";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { useRunner } from "@/components/projects/common";
import { decideChangeOrderAction, postChangeMessageAction, submitChangeOrderAction, withdrawChangeOrderAction } from "@/app/actions/projects-changes";
import {
  CHANGE_ACCEPT_ACKNOWLEDGEMENT, CHANGE_ORDER_STATUS_EXPLAIN, CHANGE_ORDER_STATUS_LABEL, CLASSIFICATION_LABEL_FOR_CLIENT, describeQuote, formatDay, isOpenChange, projectTakesChangeOrder,
  type ChangeOrderStatus,
} from "@/lib/project-change-orders";
import { newIdempotencyKey } from "@/lib/support/content";
import { cn, formatDate, formatDateTime } from "@/lib/utils";
import type { ChangeOrderView, MessageView, ProjectDetail } from "@/server/projects/shared";

// A custom project's change list, as its client sees it: the changes asked for after the project was agreed, what the team answered, the quote (if there is one) and its
// recorded decision, and what accepted changes added to the agreed scope. Declined and withdrawn changes stay on the list. Nothing here prices a change; every figure is
// the team's own, and an acceptance is a recorded answer to one exact quote, not an electronic signature.

const TONE: Record<ChangeOrderStatus | "expired", "primary" | "warning" | "success" | "danger" | "neutral"> = {
  submitted: "primary", under_review: "primary", needs_info: "warning", quoted: "warning", accepted: "success", declined: "neutral", withdrawn: "neutral", applied: "success", expired: "danger",
};

function SectionTitle({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <CardTitle className="flex min-w-0 items-center gap-2.5">
      <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary ring-1 ring-inset ring-primary/15 [&>svg]:size-4">{icon}</span>
      <span className="min-w-0">{children}</span>
    </CardTitle>
  );
}

export function ChangeRequestsSection({ project, timeZone, canRequest, canApprove, changesEnabled }: {
  project: ProjectDetail;
  timeZone: string;
  canRequest: boolean;
  canApprove: boolean;
  /** The workspace has Request a Change switched on. Off, nothing new can be asked, but changes already on the list stay and can still be answered. */
  changesEnabled: boolean;
}) {
  const r = project.request;
  const takes = projectTakesChangeOrder(r.status);
  const canAsk = changesEnabled && canRequest && takes.ok && Boolean(project.delivery);
  const [asking, setAsking] = React.useState(false);
  const changes = project.changes;
  if (!changes.length && !project.delivery && !canAsk) return null;
  const waiting = changes.filter((c) => c.status === "quoted" && !c.expired).length;
  return (
    <Card>
      <CardHeader>
        <SectionTitle icon={<PencilRuler />}>Change requests</SectionTitle>
        <div className="flex flex-wrap items-center gap-2">
          {waiting > 0 && <StatusPill tone="warning" size="sm">{waiting} quote{waiting === 1 ? "" : "s"} for your decision</StatusPill>}
          {canAsk && <Button size="sm" variant="secondary" onClick={() => setAsking(true)}><Plus className="size-3.5" aria-hidden /> Ask for a change</Button>}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-[12.5px] leading-relaxed text-muted">Something you want different from what was agreed? Ask here. The team tells you whether it is a revision your agreement includes or needs a quote. Nothing is done, priced or promised until they reply, and nothing is charged by asking.</p>
        {!canAsk && delivery(project) && (
          <p className="flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2 text-[12.5px] leading-relaxed text-ink-2" role="status">
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
            {!takes.ok ? takes.reason : !changesEnabled ? "Asking for changes isn't switched on for your workspace yet. Message the team in the conversation." : "Owners and admins ask for changes. You can follow them here."}
          </p>
        )}
        {changes.length === 0 ? (
          <EmptyState compact icon={<ClipboardList className="size-5" />} title="No changes asked for" description="Changes you ask for after the project is agreed, and the team's answers, are listed here." />
        ) : (
          <ul className="space-y-3">
            {changes.map((c) => <ChangeCard key={c.id} requestId={r.id} change={c} messages={project.messages.filter((m) => m.changeOrderId === c.id)} timeZone={timeZone} canRequest={canRequest} canApprove={canApprove} projectLive={takes.ok} />)}
          </ul>
        )}
        {project.amendments.length > 0 && (
          <div className="border-t border-line pt-4">
            <h3 className="text-[12px] font-semibold uppercase tracking-[.08em] text-muted">Added to what was agreed</h3>
            <ul className="mt-2 space-y-2">
              {project.amendments.map((a) => (
                <li key={a.id} className="rounded-xl bg-surface-2 p-3 text-[13px]">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="font-mono text-[11.5px] text-muted">{a.changeRef}</span><span className="font-medium text-ink">{a.changeTitle}</span>
                    <span className="text-ink-2">{describeQuote({ additionalCents: a.addedCents, currency: a.currency, weeksMin: a.weeksMin, weeksMax: a.weeksMax })}</span></p>
                  <p className="mt-1 whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-muted">{a.addedScope.split("\n\n").slice(1).join("\n\n") || a.addedScope}</p>
                  <p className="mt-1 text-[11.5px] text-faint">Agreed {formatDate(a.agreedAt, timeZone)}</p>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[12px] text-muted">The original scope above is unchanged. What was agreed is that scope plus these additions.</p>
          </div>
        )}
      </CardContent>
      {canAsk && <AskDialog requestId={r.id} open={asking} onOpenChange={setAsking} />}
    </Card>
  );
}

const delivery = (p: ProjectDetail) => Boolean(p.delivery);

function AskDialog({ requestId, open, onOpenChange }: { requestId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const { run, isPending } = useRunner();
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const key = React.useRef(newIdempotencyKey());
  async function send() {
    const made = await run("ask", () => submitChangeOrderAction(requestId, { title, description, idempotencyKey: key.current }), undefined);
    if (made) {
      onOpenChange(false);
      setTitle("");
      setDescription("");
      key.current = newIdempotencyKey();
      router.refresh();
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Ask for a change" icon={<PencilRuler />} description="The team reads it and tells you what happens next. Nothing is charged by asking."
      footer={<><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="brand" loading={isPending("ask")} disabled={title.trim().length < 3 || description.trim().length < 10} onClick={() => void send()}>Send request</Button></>}>
      <div className="space-y-4">
        <Field label="What should change?" htmlFor="chg-title" hint="A few words.">
          <Input id="chg-title" value={title} maxLength={160} autoComplete="off" onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Tell us more" htmlFor="chg-desc" hint="What you want different, and why it matters.">
          <Textarea id="chg-desc" rows={5} value={description} maxLength={4000} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <p className="flex items-start gap-2 text-[12.5px] leading-relaxed text-muted"><ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />Please don&apos;t include passwords, API keys or payment details.</p>
      </div>
    </Dialog>
  );
}

function ChangeCard({ requestId, change: c, messages, timeZone, canRequest, canApprove, projectLive }: {
  requestId: string; change: ChangeOrderView; messages: MessageView[]; timeZone: string; canRequest: boolean; canApprove: boolean; projectLive: boolean;
}) {
  const router = useRouter();
  const { run, isPending } = useRunner();
  const [mode, setMode] = React.useState<null | "accept" | "decline" | "withdraw">(null);
  const [note, setNote] = React.useState("");
  const [ack, setAck] = React.useState(false);
  const [reply, setReply] = React.useState("");
  const shown: ChangeOrderStatus | "expired" = c.expired ? "expired" : c.status;
  const hasQuote = c.quoteVersion > 0 && c.additionalCents !== null;
  const close = () => { setMode(null); setNote(""); setAck(false); };
  async function decide(decision: "accepted" | "declined") {
    const res = await run("decide", () => decideChangeOrderAction(requestId, c.id, decision, note || undefined), decision === "accepted" ? "Recorded. The change is now part of what was agreed." : "Your answer was recorded.");
    if (res) { close(); router.refresh(); }
  }
  async function withdraw() {
    const res = await run("withdraw", () => withdrawChangeOrderAction(requestId, c.id), undefined);
    if (res !== null) { close(); router.refresh(); }
  }
  async function send() {
    const id = globalThis.crypto?.randomUUID?.();
    const res = await run("reply", () => postChangeMessageAction(requestId, c.id, reply, id), undefined);
    if (res) { setReply(""); router.refresh(); }
  }
  const canDecide = canApprove && c.status === "quoted" && !c.expired && projectLive;
  return (
    <li id={`change-${c.id}`} className="scroll-mt-24 rounded-2xl border border-line p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[14px] font-medium text-ink"><span className="mr-2 font-mono text-[11.5px] text-muted">{c.ref}</span>{c.title}</p>
          <p className="mt-0.5 text-[12px] text-muted">Asked {formatDate(c.requestedAt, timeZone)}{c.requestedByName ? ` by ${c.requestedByName}` : ""}</p>
        </div>
        <StatusPill tone={TONE[shown]}>{CHANGE_ORDER_STATUS_LABEL[shown]}</StatusPill>
      </div>
      <p className="mt-2 whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-ink-2">{c.description}</p>
      <p className="mt-2 text-[12.5px] leading-relaxed text-muted">{CHANGE_ORDER_STATUS_EXPLAIN[shown]}</p>
      {CLASSIFICATION_LABEL_FOR_CLIENT[c.classification] && c.status !== "submitted" && <p className="mt-1 text-[12.5px] leading-relaxed text-muted">{CLASSIFICATION_LABEL_FOR_CLIENT[c.classification]}</p>}

      {hasQuote && (
        <div className="mt-3 rounded-xl bg-surface-2 p-3.5 text-[13px]">
          <p className="flex flex-wrap items-center gap-2 text-[12px] font-semibold uppercase tracking-[.08em] text-muted">Quote, version {c.quoteVersion}
            {c.validUntil && <InfoChip icon={<CalendarClock />}>{c.expired ? "Expired" : "Valid until"} {formatDay(c.validUntil)}</InfoChip>}</p>
          <p className="mt-1.5 text-[17px] font-semibold tabular-nums text-ink">{describeQuote({ additionalCents: c.additionalCents, currency: c.currency, weeksMin: c.weeksMin, weeksMax: c.weeksMax })}</p>
          {c.termsText && <p className="mt-2 whitespace-pre-wrap break-words leading-relaxed text-ink-2">{c.termsText}</p>}
        </div>
      )}
      {c.decisions.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {c.decisions.map((d) => (
            <li key={d.quoteVersion} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-2">
              <StatusPill size="sm" tone={d.decision === "accepted" ? "success" : "neutral"}>{d.decision === "accepted" ? "Accepted" : "Declined"}</StatusPill>
              <span>quote version {d.quoteVersion}{d.decidedByName ? ` by ${d.decidedByName}` : ""} on {formatDateTime(d.decidedAt, timeZone)}</span>
              {d.note && <span className="w-full text-muted">“{d.note}”</span>}
            </li>
          ))}
        </ul>
      )}

      {messages.length > 0 && (
        <ul className="mt-3 space-y-2" aria-label={`Messages about ${c.ref}`}>
          {messages.map((m) => (
            <li key={m.id} className={cn("max-w-[94%] rounded-2xl px-3.5 py-2.5 text-[13px] leading-relaxed", m.authorKind === "client" ? "ml-auto bg-primary-soft text-primary-ink" : "bg-surface-2 text-ink-2")}>
              {m.kind === "info_request" && <StatusPill size="sm" tone="warning" className="mb-1.5">Question from iAcquire</StatusPill>}
              <p className="whitespace-pre-wrap break-words">{m.body}</p>
              <p className="mt-1 text-[11.5px]">{m.authorKind === "agency" ? "iAcquire team" : (m.authorName ?? "You")} · {formatDateTime(m.createdAt, timeZone)}</p>
            </li>
          ))}
        </ul>
      )}
      {canRequest && (isOpenChange(c.status) || c.status === "accepted") && (
        <div className="mt-3 space-y-2">
          <label htmlFor={`reply-${c.id}`} className="sr-only">Write to the team about {c.ref}</label>
          <Textarea id={`reply-${c.id}`} rows={2} value={reply} maxLength={5000} placeholder={c.status === "needs_info" ? "Answer the team's question…" : "Add a note for the team…"} onChange={(e) => setReply(e.target.value)} />
          <div className="flex justify-end"><Button size="sm" variant={c.status === "needs_info" ? "brand" : "secondary"} loading={isPending("reply")} disabled={!reply.trim()} onClick={() => void send()}><Send className="size-3.5" aria-hidden /> Send</Button></div>
        </div>
      )}

      {(canDecide || (canRequest && isOpenChange(c.status))) && (
        <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
          {canDecide && <Button variant="brand" onClick={() => setMode("accept")}><CheckCircle2 className="size-4" aria-hidden /> Accept this change</Button>}
          {canDecide && <Button variant="ghost" onClick={() => setMode("decline")}>Decline</Button>}
          {canRequest && isOpenChange(c.status) && <Button variant="ghost" onClick={() => setMode("withdraw")}>Withdraw this request</Button>}
        </div>
      )}
      {c.status === "quoted" && !canApprove && !c.expired && <p className="mt-3 flex items-start gap-2 text-[12.5px] text-muted"><Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />A workspace owner accepts or declines a quote. You can still write to the team above.</p>}

      <Dialog open={mode !== null} onOpenChange={(o) => !o && close()}
        title={mode === "accept" ? "Accept this change" : mode === "decline" ? "Decline this change" : "Withdraw this request"}
        description={mode === "accept" ? `${c.ref} · ${describeQuote({ additionalCents: c.additionalCents, currency: c.currency, weeksMin: c.weeksMin, weeksMax: c.weeksMax })}` : mode === "withdraw" ? "The request stays on the list as withdrawn. Nothing is changed or charged." : "Your note goes to the iAcquire team."}
        footer={
          <>
            <Button variant="secondary" onClick={close}>Cancel</Button>
            {mode === "accept" && <Button variant="brand" loading={isPending("decide")} disabled={!ack} onClick={() => void decide("accepted")}>Accept this change</Button>}
            {mode === "decline" && <Button variant="danger" loading={isPending("decide")} onClick={() => void decide("declined")}>Decline</Button>}
            {mode === "withdraw" && <Button variant="danger" loading={isPending("withdraw")} onClick={() => void withdraw()}>Withdraw</Button>}
          </>
        }>
        {mode === "accept" ? (
          <div className="space-y-4">
            <label className="flex items-start gap-3 rounded-xl border border-line bg-surface-2/60 p-3.5 text-[13px] leading-relaxed text-ink-2">
              <input type="checkbox" className="mt-1 size-4" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              <span>{CHANGE_ACCEPT_ACKNOWLEDGEMENT}</span>
            </label>
            <Field label="A note for the team" htmlFor={`note-${c.id}`} optional><Textarea id={`note-${c.id}`} rows={3} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} /></Field>
          </div>
        ) : mode === "decline" ? (
          <Field label="Reason" htmlFor={`note-${c.id}`} optional><Textarea id={`note-${c.id}`} rows={4} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} /></Field>
        ) : null}
      </Dialog>
    </li>
  );
}
