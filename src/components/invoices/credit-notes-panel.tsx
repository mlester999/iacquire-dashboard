"use client";

import * as React from "react";
import Link from "next/link";
import { FilePlus2, FileText } from "lucide-react";
import { Badge } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/primitives";
import { ConfirmDialog, useCrmAction } from "@/components/crm/ui";
import {
  cancelCreditNoteAction, createCreditNoteAction, issueCreditNoteAction, returnCreditNoteAction, submitCreditNoteAction, updateCreditNoteAction, withdrawCreditNoteAction,
} from "@/app/actions/invoices";
import { amountText, formatInstant, money } from "@/lib/invoices/labels";
import { CREDIT_STATUS_EXPLAIN, CREDIT_STATUS_LABELS, canEditCredit, creditApproveBlockedReason, type CreditNoteStatus } from "@/lib/invoices/credit-notes";
import type { CreditNoteView } from "@/server/invoices/credit-notes";
import type { CurrencyCode } from "@/lib/money";

// The credit notes written against one invoice. A credit note takes money off what the customer still owes. It is NOT money received and NOT a refund: it never counts as a payment or
// as revenue, it can only reduce the unpaid part, and once it is issued it can no longer be changed or voided (a correction is a new invoice). Everything here asks the server, which
// decides; the buttons are only shown to the people the rules allow.

const input16 = "text-[16px] sm:text-[14px]";
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const TONE: Record<CreditNoteStatus, NonNullable<React.ComponentProps<typeof Badge>["tone"]>> = { draft: "neutral", pending_approval: "warning", issued: "primary", cancelled: "outline" };

type Dialog = { kind: "create" } | { kind: "edit"; note: CreditNoteView } | { kind: "cancel"; note: CreditNoteView } | { kind: "return"; note: CreditNoteView } | { kind: "issue"; note: CreditNoteView };

export function CreditNotesPanel({
  invoiceId, currency, notes, tz, currentUserId, isOwner, canCredit, canApprove, owedMinor, blockedReason,
}: {
  invoiceId: string; currency: CurrencyCode; notes: CreditNoteView[]; tz: string; currentUserId: string; isOwner: boolean; canCredit: boolean; canApprove: boolean; owedMinor: number; blockedReason: string | null;
}) {
  const { run, busy } = useCrmAction();
  const [dialog, setDialog] = React.useState<Dialog | null>(null);
  const [amount, setAmount] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [note, setNote] = React.useState("");
  const [key, setKey] = React.useState(newKey);
  const close = () => setDialog(null);
  const openCreate = () => { setAmount(""); setReason(""); setKey(newKey()); setDialog({ kind: "create" }); };
  const openEdit = (n: CreditNoteView) => { setAmount(amountText(n.amountMinor, currency)); setReason(n.reason); setDialog({ kind: "edit", note: n }); };
  const openText = (kind: "cancel" | "return", n: CreditNoteView) => { setNote(""); setDialog({ kind, note: n }); };

  return (
    <section aria-labelledby="inv-credits" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="inv-credits" className="text-[15px] font-semibold text-ink">Credit notes</h2>
        {canCredit && !blockedReason && <Button variant="secondary" size="sm" onClick={openCreate}><FilePlus2 className="size-4" aria-hidden />Write a credit note</Button>}
      </div>
      <p className="text-[14px] text-ink-2">
        A credit note takes money off what the customer still owes. It is not a payment and not a refund: it does not count as money received or as revenue, it can only reduce the part that is unpaid, and once it is issued it
        cannot be changed or voided. Owed now: <span className="font-medium tabular-nums text-ink">{money(owedMinor, currency)}</span>.
      </p>
      {canCredit && blockedReason && <p role="note" className="rounded-xl bg-surface-2 px-3 py-2.5 text-[14px] text-ink-2">{blockedReason}</p>}
      {notes.length === 0 ? (
        <p className="rounded-2xl border border-line bg-surface-2 px-4 py-3 text-[14px] text-ink-2">No credit note has been written against this invoice.</p>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface" aria-label="Credit notes">
          {notes.map((n) => {
            const isAuthor = n.createdBy === currentUserId;
            const mayEdit = canEditCredit({ canCredit, canApprove, isAuthor });
            const approveBlock = creditApproveBlockedReason({ status: n.status, canApprove, isAuthor, isOwner });
            return (
              <li key={n.id} className="space-y-1.5 px-4 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <span className="text-[14px] font-semibold tabular-nums text-ink">{money(n.amountMinor, currency)}</span>
                  <Badge tone={TONE[n.status]} title={CREDIT_STATUS_EXPLAIN[n.status]}>{CREDIT_STATUS_LABELS[n.status]}</Badge>
                  <span className="text-[13px] text-muted">{n.number ? <span className="tabular-nums">{n.number}</span> : "Not numbered yet"} · {n.createdByName ?? "A team member"} · {formatInstant(n.issuedAt ?? n.createdAt, tz)}</span>
                  <span className="ml-auto flex flex-wrap items-center gap-2">
                    {n.status === "issued" && <Link href={`/invoices/${invoiceId}/credit-notes/${n.id}`} className="inline-flex min-h-11 items-center gap-1.5 text-[14px] font-medium text-primary underline-offset-2 hover:underline sm:min-h-8"><FileText className="size-4" aria-hidden />View document</Link>}
                    {n.status === "draft" && mayEdit && <Button variant="ghost" size="sm" onClick={() => openEdit(n)}>Edit</Button>}
                    {n.status === "draft" && mayEdit && <Button variant="secondary" size="sm" loading={busy(`submit-${n.id}`)} onClick={() => void run(`submit-${n.id}`, () => submitCreditNoteAction(n.id, n.version), "Sent for approval.")}>Send for approval</Button>}
                    {n.status === "pending_approval" && mayEdit && isAuthor && <Button variant="ghost" size="sm" loading={busy(`withdraw-${n.id}`)} onClick={() => void run(`withdraw-${n.id}`, () => withdrawCreditNoteAction(n.id), "Taken back to a draft.")}>Take back</Button>}
                    {n.status === "pending_approval" && canApprove && !approveBlock && <Button variant="primary" size="sm" onClick={() => setDialog({ kind: "issue", note: n })}>Approve and issue</Button>}
                    {n.status === "pending_approval" && canApprove && !isAuthor && <Button variant="ghost" size="sm" onClick={() => openText("return", n)}>Send back</Button>}
                    {(n.status === "draft" || n.status === "pending_approval") && mayEdit && <Button variant="ghost" size="sm" onClick={() => openText("cancel", n)}>Cancel</Button>}
                  </span>
                </div>
                <p className="text-[13px] text-ink-2">{n.reason}</p>
                {n.status === "pending_approval" && approveBlock && canApprove && <p className="text-[13px] text-muted">{approveBlock}</p>}
                {n.status === "issued" && <p className="text-[13px] text-muted">Approved by {n.approvedByName ?? "a team member"} · {formatInstant(n.approvedAt, tz)}</p>}
                {n.status === "cancelled" && n.cancelReason && <p className="text-[13px] text-muted">Cancelled: {n.cancelReason}</p>}
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={dialog?.kind === "create" || dialog?.kind === "edit"} onOpenChange={(o) => !o && close()} title={dialog?.kind === "edit" ? "Change the credit note" : "Write a credit note"} confirmLabel={dialog?.kind === "edit" ? "Save changes" : "Save as a draft"}
        loading={busy("credit-save")} confirmDisabled={!amount.trim() || reason.trim().length < 5}
        description="This writes a draft. Nothing is taken off the invoice until the credit note is sent for approval and issued by the owner or another manager."
        onConfirm={async () => {
          if (!dialog) return;
          const ok = dialog.kind === "edit"
            ? await run("credit-save", () => updateCreditNoteAction(dialog.note.id, { amount, reason }, dialog.note.version), "Saved.")
            : await run("credit-save", () => createCreditNoteAction({ invoiceId, amount, reason, idempotencyKey: key }), "Draft saved.");
          if (ok) close();
        }}
      >
        <div className="space-y-3">
          <Field label={`Amount to credit (${currency}, tax included)`} htmlFor="credit-amount" hint={`The most you can credit is what is still owed: ${amountText(owedMinor, currency)}. To give money back that was already paid, record a refund instead.`}>
            <Input id="credit-amount" inputMode="decimal" className={input16} value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="Why is the invoice being credited?" htmlFor="credit-reason" hint="At least five characters. It is printed on the credit note.">
            <Textarea id="credit-reason" rows={3} className={input16} maxLength={400} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog?.kind === "issue"} onOpenChange={(o) => !o && close()} title="Approve and issue this credit note" confirmLabel="Issue credit note" loading={busy("credit-issue")}
        description={dialog?.kind === "issue" ? `This takes ${money(dialog.note.amountMinor, currency)} off what the customer owes and gives the credit note its number. Once issued it cannot be changed, voided or deleted; a mistake is corrected with a new invoice. You are approving version ${dialog.note.version}: ${dialog.note.reason}` : undefined}
        onConfirm={async () => {
          if (dialog?.kind !== "issue") return;
          const out = await run("credit-issue", () => issueCreditNoteAction(dialog.note.id, dialog.note.version), (d) => `Issued as ${(d as { number: string }).number}.`);
          if (out) close();
        }}
      />

      <ConfirmDialog
        open={dialog?.kind === "return"} onOpenChange={(o) => !o && close()} title="Send this credit note back" confirmLabel="Send back" loading={busy("credit-return")} confirmDisabled={note.trim().length < 3}
        description="It goes back to a draft and its author is told what to change."
        onConfirm={async () => {
          if (dialog?.kind !== "return") return;
          const ok = await run("credit-return", () => returnCreditNoteAction(dialog.note.id, { version: dialog.note.version, note }), "Sent back.");
          if (ok) close();
        }}
      >
        <Field label="What should change?" htmlFor="credit-return-note"><Textarea id="credit-return-note" rows={2} className={input16} maxLength={400} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog?.kind === "cancel"} onOpenChange={(o) => !o && close()} title="Cancel this credit note" confirmLabel="Cancel the credit note" danger loading={busy("credit-cancel")} confirmDisabled={note.trim().length < 5}
        description="It stays in the history as cancelled and never takes anything off the invoice."
        onConfirm={async () => {
          if (dialog?.kind !== "cancel") return;
          const ok = await run("credit-cancel", () => cancelCreditNoteAction(dialog.note.id, note), "Cancelled.");
          if (ok) close();
        }}
      >
        <Field label="Why?" htmlFor="credit-cancel-note"><Textarea id="credit-cancel-note" rows={2} className={input16} maxLength={400} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </ConfirmDialog>
    </section>
  );
}
