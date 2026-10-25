"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, ClipboardCheck, HelpCircle, Lock, PencilRuler, Plus, Send, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, EmptyState, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { InfoChip, StatusPill } from "@/components/ui/status";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { useRunner, type ActionResult } from "@/components/projects/common";
import {
  addPrerequisiteAction, applyRevisionAction, classifyChangeOrderAction, declineChangeOrderAction, markChangeAppliedAction, projectTermsAction, pullBackChangeQuoteAction,
  removePrerequisiteAction, requestChangeInfoAction, satisfyPrerequisiteAction, saveChangeNotesAction, sendChangeQuoteAction, startChangeReviewAction, waivePrerequisiteAction,
} from "@/app/(admin)/admin/projects/actions";
import { CHANGE_ORDER_STATUS_LABEL_AGENCY, describeQuote, formatDay, revisionsLeft, type ChangeOrderStatus } from "@/lib/project-change-orders";
import { PREREQUISITE_KINDS, PREREQUISITE_KIND_LABEL, PREREQUISITE_STATUS_LABEL, evidenceProblem, waiverProblem, type PrerequisiteBlocks, type PrerequisiteKind } from "@/lib/project-prerequisites";
import { isCurrency, parseAmount, toDecimalString, MoneyError } from "@/lib/money";
import { formatDate, formatDateTime } from "@/lib/utils";
import type { AgencyProjectDetail } from "@/server/projects/agency";
import type { ChangeOrderView, PrerequisiteView } from "@/server/projects/shared";

// The team's side of a project's change list and of what is confirmed before work starts. Every button here is convenience: each action is re-checked on the server for the
// person's role, client scope and permission (projects.manage to look at and classify, quotes.manage to price and to waive). Nothing here prices a change by itself: the
// price, the extra weeks and the terms are typed by the person sending the quote.

const TONE: Record<ChangeOrderStatus, "primary" | "warning" | "success" | "danger" | "neutral"> = {
  submitted: "primary", under_review: "primary", needs_info: "warning", quoted: "warning", accepted: "success", declined: "neutral", withdrawn: "neutral", applied: "success",
};

function SectionTitle({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <CardTitle className="flex items-center gap-2.5">
      <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-warning-soft text-warning-ink ring-1 ring-inset ring-line [&>svg]:size-4">{icon}</span>
      {children}
    </CardTitle>
  );
}

export function AdminChangePanel({ project: p }: { project: AgencyProjectDetail }) {
  const closed = p.request.status === "cancelled" || p.request.status === "completed";
  const currency = p.delivery?.currency ?? "USD";
  const open = p.changes.filter((c) => c.status === "submitted" || c.status === "under_review" || c.status === "needs_info" || c.status === "quoted").length;
  return (
    <Card>
      <CardHeader>
        <SectionTitle icon={<PencilRuler />}>Change requests</SectionTitle>
        {open > 0 && <StatusPill tone="warning" size="sm">{open} open</StatusPill>}
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-[12.5px] leading-relaxed text-muted">What the client asked for after the project was agreed. Decide whether it is a revision the agreement includes or something outside it. For the second kind, write the quote yourself: the price, the extra weeks and the terms are yours, and nothing is priced or promised for you. Declined and withdrawn changes stay on this list.</p>
        {p.delivery && (
          <p className="text-[12.5px] text-ink-2" role="status">
            Revisions: {p.delivery.revisionsIncluded === null ? `${p.delivery.revisionsUsed} made. No number of included revisions is recorded.` : `${p.delivery.revisionsUsed} of ${p.delivery.revisionsIncluded} used (${revisionsLeft(p.delivery.revisionsIncluded, p.delivery.revisionsUsed)} left).`}
          </p>
        )}
        {p.changes.length === 0 ? (
          <EmptyState compact icon={<PencilRuler className="size-5" />} title="No changes asked for" description="Changes the client asks for appear here. Request a Change has to be switched on for the workspace." />
        ) : (
          <ul className="space-y-3">
            {p.changes.map((c) => <ChangeRow key={c.id} project={p} change={c} currency={currency} closed={closed} />)}
          </ul>
        )}
        {p.amendments.length > 0 && (
          <div className="border-t border-line pt-3">
            <h3 className="text-[12px] font-semibold uppercase tracking-[.08em] text-muted">Added to the agreed scope</h3>
            <ul className="mt-2 space-y-1.5 text-[13px] text-ink-2">
              {p.amendments.map((a) => <li key={a.id}><span className="font-mono text-[12px] text-muted">{a.changeRef}</span> {a.changeTitle} · {describeQuote({ additionalCents: a.addedCents, currency: a.currency, weeksMin: a.weeksMin, weeksMax: a.weeksMax })} · agreed {formatDate(a.agreedAt)}</li>)}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ChangeRow({ project: p, change: c, currency, closed }: { project: AgencyProjectDetail; change: ChangeOrderView; currency: string; closed: boolean }) {
  const router = useRouter();
  const { run, isPending } = useRunner();
  const [dialog, setDialog] = React.useState<null | "quote" | "ask" | "decline" | "applied">(null);
  const [text, setText] = React.useState("");
  const [notes, setNotes] = React.useState(c.internalNotes ?? "");
  const [notesSaving, setNotesSaving] = React.useState(false);
  // Set when a colleague saved the notes after this person read them; `readAs` is the copy this person had, so their version is shown only once it has actually arrived.
  const [notesConflict, setNotesConflict] = React.useState<{ message: string; readAs: string } | null>(null);
  const messages = p.messages.filter((m) => m.changeOrderId === c.id);
  const id = p.request.id;
  async function saveNotes() {
    setNotesSaving(true);
    try {
      const res = await saveChangeNotesAction(id, c.id, notes, c.internalNotes ?? null);
      if (res.ok) {
        setNotesConflict(null);
        toast.success("Notes saved");
        router.refresh();
      } else if (res.code === "conflict") {
        setNotesConflict({ message: res.error, readAs: c.internalNotes ?? "" });
        router.refresh();
      } else {
        toast.error(res.error);
      }
    } catch {
      toast.error("Something went wrong. Please try again.");
    } finally {
      setNotesSaving(false);
    }
  }
  // `run` toasts the outcome and returns null when the action failed (a void action returns undefined on success).
  const act = async (key: string, fn: () => Promise<ActionResult<unknown>>, success: string) => {
    const res = await run(key, fn, success);
    if (res === null) return false;
    router.refresh();
    return true;
  };
  const revisionsOut = p.delivery && p.delivery.revisionsIncluded !== null && p.delivery.revisionsUsed >= p.delivery.revisionsIncluded;
  return (
    <li id={`agency-change-${c.id}`} className="scroll-mt-24 rounded-2xl border border-line p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[14px] font-medium text-ink"><span className="mr-2 font-mono text-[12px] text-muted">{c.ref}</span>{c.title}</p>
          <p className="mt-0.5 text-[12px] text-muted">Asked {formatDateTime(c.requestedAt)}{c.requestedByName ? ` by ${c.requestedByName}` : ""}{c.ticketId ? " · also filed as a Request a Change request" : ""}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {c.classification !== "undetermined" && <InfoChip>{c.classification === "in_scope_revision" ? "Revision" : "Outside what was agreed"}</InfoChip>}
          <StatusPill tone={TONE[c.status]}>{CHANGE_ORDER_STATUS_LABEL_AGENCY[c.status]}{c.expired ? " · expired" : ""}</StatusPill>
        </div>
      </div>
      <p className="mt-2 whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-ink-2">{c.description}</p>

      {c.quoteVersion > 0 && c.additionalCents !== null && (
        <div className="mt-3 rounded-xl bg-surface-2 p-3 text-[13px]">
          <p className="font-medium text-ink">Quote version {c.quoteVersion}: {describeQuote({ additionalCents: c.additionalCents, currency: c.currency, weeksMin: c.weeksMin, weeksMax: c.weeksMax })}</p>
          {c.validUntil && <p className="mt-0.5 text-[12px] text-muted">{c.expired ? "Expired" : "Valid until"} {formatDay(c.validUntil)}</p>}
          {c.termsText && <p className="mt-1.5 whitespace-pre-wrap break-words text-ink-2">{c.termsText}</p>}
        </div>
      )}
      {c.decisions.length > 0 && (
        <ul className="mt-2 space-y-1 text-[12.5px] text-ink-2">
          {c.decisions.map((d) => <li key={d.quoteVersion}>Version {d.quoteVersion} {d.decision} by {d.decidedByName ?? "the client"} on {formatDateTime(d.decidedAt)}{d.note ? ` — “${d.note}”` : ""}</li>)}
        </ul>
      )}
      {messages.length > 0 && (
        <ul className="mt-2 space-y-1.5" aria-label={`Messages about ${c.ref}`}>
          {messages.map((m) => <li key={m.id} className="rounded-lg bg-surface-2 px-3 py-2 text-[12.5px] text-ink-2"><span className="font-medium">{m.authorKind === "client" ? (m.authorName ?? "Client") : "iAcquire"}</span> · {formatDateTime(m.createdAt)}<br />{m.body}</li>)}
        </ul>
      )}

      {!closed && (
        <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
          {c.status === "submitted" && <Button size="sm" variant="secondary" loading={isPending("start")} onClick={() => void act("start", () => startChangeReviewAction(id, c.id), "Review started")}>Start review</Button>}
          {(c.status === "submitted" || c.status === "under_review") && c.quoteVersion === 0 && (
            <>
              <Button size="sm" variant={c.classification === "in_scope_revision" ? "soft" : "secondary"} loading={isPending("rev")} onClick={() => void act("rev", () => classifyChangeOrderAction(id, c.id, { classification: "in_scope_revision" }), "Marked as a revision")}>It&apos;s a revision</Button>
              <Button size="sm" variant={c.classification === "out_of_scope" ? "soft" : "secondary"} loading={isPending("oos")} onClick={() => void act("oos", () => classifyChangeOrderAction(id, c.id, { classification: "out_of_scope" }), "Marked as outside what was agreed")}>Outside what was agreed</Button>
            </>
          )}
          {c.status === "under_review" && c.classification === "in_scope_revision" && (
            <Button size="sm" variant="brand" disabled={Boolean(revisionsOut)} title={revisionsOut ? "All included revisions are used. Classify it as outside what was agreed and send a quote." : undefined} onClick={() => setDialog("applied")}><CheckCircle2 className="size-3.5" aria-hidden /> Made as a revision</Button>
          )}
          {c.status === "under_review" && c.classification === "out_of_scope" && p.delivery && <Button size="sm" variant="brand" onClick={() => setDialog("quote")}><Send className="size-3.5" aria-hidden /> {c.quoteVersion > 0 ? "Send a new quote" : "Write the quote"}</Button>}
          {(c.status === "submitted" || c.status === "under_review") && <Button size="sm" variant="secondary" onClick={() => setDialog("ask")}><HelpCircle className="size-3.5" aria-hidden /> Ask the client</Button>}
          {c.status === "quoted" && <Button size="sm" variant="secondary" loading={isPending("pull")} onClick={() => void act("pull", () => pullBackChangeQuoteAction(id, c.id), "Quote taken back")}>Take the quote back</Button>}
          {c.status === "accepted" && <Button size="sm" variant="brand" onClick={() => setDialog("applied")}><CheckCircle2 className="size-3.5" aria-hidden /> Mark as made</Button>}
          {(c.status === "submitted" || c.status === "under_review" || c.status === "needs_info") && <Button size="sm" variant="ghost" onClick={() => setDialog("decline")}>Decline</Button>}
        </div>
      )}
      {(c.status === "needs_info") && <p className="mt-2 text-[12.5px] text-muted">Waiting for the client&apos;s answer. Their reply puts it back in review.</p>}
      {revisionsOut && c.status === "under_review" && c.classification === "in_scope_revision" && <p className="mt-2 text-[12.5px] text-warning-ink" role="status">All included revisions are used, so this can&apos;t be made as a revision. Classify it as outside what was agreed and send a quote.</p>}

      <details className="mt-3">
        <summary className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 text-[12.5px] font-medium text-ink-2 hover:text-ink"><Lock className="size-3.5" aria-hidden /> Team notes</summary>
        <div className="mt-1 space-y-2">
          {notesConflict && (
            <div role="alert" className="rounded-xl bg-warning-soft px-3 py-2.5 text-[12.5px] leading-relaxed text-warning-ink">
              <p className="font-medium">{notesConflict.message}</p>
              {(c.internalNotes ?? "") !== notesConflict.readAs ? (
                <>
                  <p className="mt-1.5 whitespace-pre-wrap break-words rounded-lg bg-surface px-2.5 py-2 text-ink-2">{c.internalNotes ?? ""}</p>
                  <Button size="sm" variant="secondary" className="mt-2" onClick={() => { setNotes(c.internalNotes ?? ""); setNotesConflict(null); }}>Use their version</Button>
                </>
              ) : (
                <p className="mt-1">Loading their version…</p>
              )}
            </div>
          )}
          <Textarea aria-label={`Team notes for ${c.ref}`} rows={3} value={notes} maxLength={4000} placeholder="Only the agency can see this." onChange={(e) => setNotes(e.target.value)} />
          <Button size="sm" variant="secondary" loading={notesSaving} disabled={notes === (c.internalNotes ?? "")} onClick={() => void saveNotes()}>Save notes</Button>
        </div>
      </details>

      <Dialog open={dialog === "ask"} onOpenChange={(o) => { if (!o) { setDialog(null); setText(""); } }} title={`Ask the client about ${c.ref}`} description="Moves the change to “waiting for the client”. Their answer puts it back in review." size="sm"
        footer={<><Button variant="secondary" onClick={() => setDialog(null)}>Cancel</Button><Button variant="brand" loading={isPending("ask")} disabled={text.trim().length < 3} onClick={async () => { if (await act("ask", () => requestChangeInfoAction(id, c.id, text), "Question sent")) { setDialog(null); setText(""); } }}>Send question</Button></>}>
        <Field label="Your question" htmlFor={`ask-${c.id}`}><Textarea id={`ask-${c.id}`} rows={4} value={text} maxLength={5000} onChange={(e) => setText(e.target.value)} /></Field>
      </Dialog>
      <Dialog open={dialog === "decline"} onOpenChange={(o) => { if (!o) { setDialog(null); setText(""); } }} title={`Decline ${c.ref}`} description="The client is told, with your reason. It stays on the list as declined." size="sm"
        footer={<><Button variant="secondary" onClick={() => setDialog(null)}>Cancel</Button><Button variant="danger" loading={isPending("decline")} disabled={text.trim().length < 3} onClick={async () => { if (await act("decline", () => declineChangeOrderAction(id, c.id, text), "Declined")) { setDialog(null); setText(""); } }}>Decline</Button></>}>
        <Field label="Why not?" htmlFor={`decline-${c.id}`} hint="Shown to the client."><Textarea id={`decline-${c.id}`} rows={4} value={text} maxLength={500} onChange={(e) => setText(e.target.value)} /></Field>
      </Dialog>
      <Dialog open={dialog === "applied"} onOpenChange={(o) => { if (!o) { setDialog(null); setText(""); } }} title={c.status === "accepted" ? `Mark ${c.ref} as made` : `${c.ref} was made as a revision`}
        description={c.status === "accepted" ? "The client is told the change was made." : "This uses one of the revisions the agreement includes, and the client is told."} size="sm"
        footer={<><Button variant="secondary" onClick={() => setDialog(null)}>Cancel</Button><Button variant="brand" loading={isPending("applied")} onClick={async () => { const ok = await act("applied", () => (c.status === "accepted" ? markChangeAppliedAction(id, c.id, text) : applyRevisionAction(id, c.id, text)), "Recorded"); if (ok) { setDialog(null); setText(""); } }}>Record it</Button></>}>
        <Field label="A note for the client" htmlFor={`applied-${c.id}`} optional><Textarea id={`applied-${c.id}`} rows={3} value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} /></Field>
      </Dialog>
      {dialog === "quote" && <QuoteDialog projectId={id} change={c} currency={currency} onClose={() => setDialog(null)} />}
    </li>
  );
}

function QuoteDialog({ projectId, change: c, currency, onClose }: { projectId: string; change: ChangeOrderView; currency: string; onClose: () => void }) {
  const router = useRouter();
  const { run, isPending } = useRunner();
  const [price, setPrice] = React.useState(c.additionalCents !== null && isCurrency(currency) ? toDecimalString(c.additionalCents, currency) : "");
  const [weeksMin, setWeeksMin] = React.useState(c.weeksMin ? String(c.weeksMin) : "");
  const [weeksMax, setWeeksMax] = React.useState(c.weeksMax ? String(c.weeksMax) : "");
  const [terms, setTerms] = React.useState(c.termsText ?? "");
  const [validUntil, setValidUntil] = React.useState(c.validUntil ?? "");
  const [prerequisite, setPrerequisite] = React.useState("");
  const [problem, setProblem] = React.useState<string | null>(null);
  async function send() {
    setProblem(null);
    if (!isCurrency(currency)) return setProblem("This project's currency isn't supported.");
    let minor: number;
    try {
      minor = parseAmount(price, currency);
    } catch (e) {
      return setProblem(e instanceof MoneyError ? e.message : "Enter the extra cost as an amount, such as 1200 or 1200.00.");
    }
    const res = await run("quote", () => sendChangeQuoteAction(projectId, c.id, {
      additionalMinor: minor, currency, weeksMin: weeksMin ? Number(weeksMin) : null, weeksMax: weeksMax ? Number(weeksMax) : null, termsText: terms, validUntil: validUntil || null, prerequisiteLabel: prerequisite || null,
    }), "Quote sent to the client");
    if (res) {
      onClose();
      router.refresh();
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`${c.quoteVersion > 0 ? "New quote" : "Quote"} for ${c.ref}`} icon={<PencilRuler />}
      description="Your own price, weeks and terms. The client sees them when you send, and the owner accepts or declines this exact version. A sent quote can't be edited: take it back and send a new one."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="brand" loading={isPending("quote")} disabled={!price.trim() || terms.trim().length < 10} onClick={() => void send()}><Send className="size-4" aria-hidden /> Send quote</Button></>}>
      <div className="space-y-4">
        {problem && <p className="rounded-xl bg-danger-soft px-3 py-2 text-[13px] text-danger-ink" role="alert">{problem}</p>}
        <Field label={`Extra cost (${currency})`} htmlFor={`q-price-${c.id}`} hint="Use 0 for no extra charge. You decide this; nothing is suggested.">
          <Input id={`q-price-${c.id}`} inputMode="decimal" value={price} placeholder="0.00" onChange={(e) => setPrice(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Extra weeks (from)" htmlFor={`q-w1-${c.id}`} optional><Input id={`q-w1-${c.id}`} type="number" inputMode="numeric" min={1} max={104} value={weeksMin} onChange={(e) => setWeeksMin(e.target.value)} /></Field>
          <Field label="Extra weeks (to)" htmlFor={`q-w2-${c.id}`} optional><Input id={`q-w2-${c.id}`} type="number" inputMode="numeric" min={1} max={104} value={weeksMax} onChange={(e) => setWeeksMax(e.target.value)} /></Field>
        </div>
        <p className="-mt-2 text-[12px] text-muted">An estimate of the weeks this adds. The client is told it is not a delivery date.</p>
        <Field label="What this change includes, and any conditions" htmlFor={`q-terms-${c.id}`} hint="Becomes part of the agreed scope if it is accepted.">
          <Textarea id={`q-terms-${c.id}`} rows={5} value={terms} maxLength={2000} onChange={(e) => setTerms(e.target.value)} />
        </Field>
        <Field label="Valid until" htmlFor={`q-valid-${c.id}`} optional><Input id={`q-valid-${c.id}`} type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} /></Field>
        <Field label="Something a person must confirm first" htmlFor={`q-pre-${c.id}`} optional hint="For example “Deposit for this change received”. It must be confirmed or waived before the project is handed over.">
          <Input id={`q-pre-${c.id}`} value={prerequisite} maxLength={160} onChange={(e) => setPrerequisite(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Before work starts
// ---------------------------------------------------------------------------

export function AdminPrerequisitesPanel({ project: p }: { project: AgencyProjectDetail }) {
  const router = useRouter();
  const { run, isPending } = useRunner();
  const closed = p.request.status === "cancelled" || p.request.status === "completed";
  const id = p.request.id;
  const [kind, setKind] = React.useState<PrerequisiteKind>("access");
  const [label, setLabel] = React.useState("");
  const [blocks, setBlocks] = React.useState<PrerequisiteBlocks>("start");
  const [target, setTarget] = React.useState<{ item: PrerequisiteView; mode: "confirm" | "waive" } | null>(null);
  const [text, setText] = React.useState("");
  const [problem, setProblem] = React.useState<string | null>(null);
  const waiting = p.prerequisites.filter((x) => x.required && x.status === "pending").length;
  async function add() {
    const res = await run("add", () => addPrerequisiteAction(id, { kind: kind as Exclude<PrerequisiteKind, "change">, label, blocks, required: true }), "Added");
    if (res) {
      setLabel("");
      router.refresh();
    }
  }
  async function record() {
    if (!target) return;
    const check = target.mode === "confirm" ? evidenceProblem(text) : waiverProblem(text);
    if (check) return setProblem(check);
    setProblem(null);
    const res = await run("record", () => (target.mode === "confirm" ? satisfyPrerequisiteAction(id, target.item.id, text) : waivePrerequisiteAction(id, target.item.id, text)), target.mode === "confirm" ? "Confirmed" : "Marked as not needed");
    if (res !== null) {
      setTarget(null);
      setText("");
      router.refresh();
    }
  }
  return (
    <Card>
      <CardHeader>
        <SectionTitle icon={<ClipboardCheck />}>Before work starts</SectionTitle>
        {waiting > 0 ? <StatusPill tone="warning" size="sm">{waiting} waiting</StatusPill> : p.prerequisites.length > 0 ? <StatusPill tone="success" size="sm">All settled</StatusPill> : null}
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-[12.5px] leading-relaxed text-muted">A record of what a person checked: the written agreement, a payment, access or content. Nothing here detects a payment or charges anyone. Work can&apos;t start while a required item is waiting; confirm it with what you checked, or mark it not needed with a reason (that needs the quote permission).</p>
        {p.prerequisites.length === 0 ? (
          <EmptyState compact icon={<ClipboardCheck className="size-5" />} title="Nothing asked for yet" description="Accepting a quote asks for the agreement and payment where the Super Admin switched that on in Support settings. You can also add an item by hand." />
        ) : (
          <ul className="space-y-2.5">
            {p.prerequisites.map((x) => (
              <li key={x.id} className="rounded-xl border border-line p-3 text-[13px]">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-ink">{x.label}</span>
                  <InfoChip>{PREREQUISITE_KIND_LABEL[x.kind]}</InfoChip>
                  <InfoChip>{x.blocks === "start" ? "Blocks the start" : "Blocks the handover"}</InfoChip>
                  <StatusPill size="sm" tone={x.status === "satisfied" ? "success" : x.status === "waived" ? "neutral" : "warning"}>{PREREQUISITE_STATUS_LABEL[x.status]}</StatusPill>
                </div>
                {x.status === "satisfied" && <p className="mt-1.5 text-[12.5px] text-ink-2">Confirmed {x.satisfiedAt ? formatDateTime(x.satisfiedAt) : ""}{x.recordedByName ? ` by ${x.recordedByName}` : ""}: {x.evidenceNote}</p>}
                {x.status === "waived" && <p className="mt-1.5 text-[12.5px] text-ink-2">Not needed {x.waivedAt ? formatDateTime(x.waivedAt) : ""}{x.recordedByName ? ` by ${x.recordedByName}` : ""}: {x.waivedReason}</p>}
                {x.kind === "change" && x.changeStatus && x.changeStatus !== "accepted" && x.changeStatus !== "applied" && <p className="mt-1 text-[12px] text-muted">Binds once the change is accepted. The client doesn&apos;t see it before then.</p>}
                {x.status === "pending" && !closed && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button size="sm" variant="brand" onClick={() => { setTarget({ item: x, mode: "confirm" }); setText(""); setProblem(null); }}>Confirm it</Button>
                    <Button size="sm" variant="secondary" onClick={() => { setTarget({ item: x, mode: "waive" }); setText(""); setProblem(null); }}>Not needed</Button>
                    <Button size="icon-sm" variant="ghost" aria-label={`Remove ${x.label}`} loading={isPending(`rm-${x.id}`)} onClick={async () => { if ((await run(`rm-${x.id}`, () => removePrerequisiteAction(id, x.id), "Removed")) !== null) router.refresh(); }}><Trash2 className="size-4" aria-hidden /></Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {!closed && (
          <div className="grid gap-3 rounded-2xl bg-surface-2/50 p-4 sm:grid-cols-2">
            <Field label="Ask for something" htmlFor="pre-label" className="sm:col-span-2" hint="For example “Access to the booking calendar” or “Logo and brand colours”.">
              <Input id="pre-label" value={label} maxLength={160} onChange={(e) => setLabel(e.target.value)} />
            </Field>
            <Field label="Kind" htmlFor="pre-kind">
              <Select id="pre-kind" value={kind} onChange={(e) => setKind(e.target.value as PrerequisiteKind)}>
                {PREREQUISITE_KINDS.filter((k) => k !== "change").map((k) => <option key={k} value={k}>{PREREQUISITE_KIND_LABEL[k]}</option>)}
              </Select>
            </Field>
            <Field label="Blocks" htmlFor="pre-blocks">
              <Select id="pre-blocks" value={blocks} onChange={(e) => setBlocks(e.target.value as PrerequisiteBlocks)}>
                <option value="start">Starting work</option>
                <option value="handover">The handover</option>
              </Select>
            </Field>
            <div className="sm:col-span-2"><Button size="sm" variant="secondary" loading={isPending("add")} disabled={label.trim().length < 3} onClick={() => void add()}><Plus className="size-3.5" aria-hidden /> Add</Button></div>
          </div>
        )}
      </CardContent>
      <Dialog open={target !== null} onOpenChange={(o) => { if (!o) { setTarget(null); setText(""); setProblem(null); } }} size="sm"
        title={target?.mode === "confirm" ? "Confirm this item" : "Mark this item as not needed"} description={target?.item.label}
        footer={<><Button variant="secondary" onClick={() => setTarget(null)}>Cancel</Button><Button variant="brand" loading={isPending("record")} disabled={text.trim().length < 3} onClick={() => void record()}>{target?.mode === "confirm" ? "Confirm" : "Mark as not needed"}</Button></>}>
        {problem && <p className="mb-3 rounded-xl bg-danger-soft px-3 py-2 text-[13px] text-danger-ink" role="alert">{problem}</p>}
        <Field label={target?.mode === "confirm" ? "What you checked, and where" : "Why it isn't needed"} htmlFor="pre-text" hint={target?.mode === "confirm" ? "For example “Signed agreement received by email on the 3rd; filed in the project folder”. Never a card number or a password." : "Kept on the record."}>
          <Textarea id="pre-text" rows={4} value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} />
        </Field>
      </Dialog>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Revisions and the support period
// ---------------------------------------------------------------------------

export function AdminTermsCard({ project: p }: { project: AgencyProjectDetail }) {
  const router = useRouter();
  const { run, isPending } = useRunner();
  const d = p.delivery;
  const [revisions, setRevisions] = React.useState(d?.revisionsIncluded !== null && d?.revisionsIncluded !== undefined ? String(d.revisionsIncluded) : "");
  const [warranty, setWarranty] = React.useState(d?.warrantyDays !== null && d?.warrantyDays !== undefined ? String(d.warrantyDays) : "");
  if (!d || d.completedAt) return null;
  const same = revisions === (d.revisionsIncluded === null ? "" : String(d.revisionsIncluded)) && warranty === (d.warrantyDays === null ? "" : String(d.warrantyDays));
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ClipboardCheck className="size-4 text-muted" aria-hidden /> Revisions and support</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-[12.5px] leading-relaxed text-muted">Record what the quote agreed. Left empty, nothing is assumed: the quote&apos;s own wording stands and revisions are only counted. {d.revisionsUsed} used so far.</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Revisions included" htmlFor="terms-rev" optional><Input id="terms-rev" type="number" inputMode="numeric" min={0} max={100} value={revisions} onChange={(e) => setRevisions(e.target.value)} /></Field>
          <Field label="Support days after handover" htmlFor="terms-war" optional><Input id="terms-war" type="number" inputMode="numeric" min={0} max={3650} value={warranty} onChange={(e) => setWarranty(e.target.value)} /></Field>
        </div>
        <Button size="sm" variant="secondary" loading={isPending("terms")} disabled={same} onClick={async () => { if ((await run("terms", () => projectTermsAction(p.request.id, { revisionsIncluded: revisions === "" ? null : Number(revisions), warrantyDays: warranty === "" ? null : Number(warranty) }), "Saved")) !== null) router.refresh(); }}>Save</Button>
      </CardContent>
    </Card>
  );
}
