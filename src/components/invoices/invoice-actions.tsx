"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, Copy, FlaskConical } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { ConfirmDialog, useCrmAction } from "@/components/crm/ui";
import {
  discardInvoiceDraftAction, getInvoiceLinkAction, issueInvoiceAction, recordPaymentAction, requestInvoiceChangesAction, rotateInvoiceLinkAction, startTestPaymentAction,
  submitInvoiceAction, voidInvoiceAction, withdrawInvoiceAction, writeOffInvoiceAction,
} from "@/app/actions/invoices";
import { amountText, money } from "@/lib/invoices/labels";
import { invoiceActions, type ActionFacts, type InvoiceActionId } from "@/lib/invoices/screens";
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS } from "@/lib/invoices/schemas";
import { todayIn } from "@/lib/invoices/state";
import type { CurrencyCode } from "@/lib/money";

// What a person can do with an invoice right now. The server decides every one of these again; this only offers what the status and the person's role allow, and says why
// when something is not offered. Money and quantities go to the server as the text the person typed.

type Dialog = null | "issue" | "changes" | "discard" | "void" | "write_off" | "payment" | "rotate" | "test";

export interface InvoiceActionsProps {
  invoiceId: string;
  version: number;
  number: string | null;
  status: ActionFacts["status"];
  currency: CurrencyCode;
  balanceMinor: number;
  totalMinor: number;
  facts: ActionFacts;
  tz: string;
  /** The customer is known and the invoice can be issued (a draft is sent for approval or issued only with a customer). */
  hasCustomer: boolean;
  /** The owner's rule for the linked deal, said in words, or null when no deal is linked or the rule is off. */
  closeRuleNote: string | null;
}

const input16 = "text-[16px] sm:text-[14px]";
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`);

export function InvoiceActions({ invoiceId, version, number, status, currency, balanceMinor, totalMinor, facts, tz, hasCustomer, closeRuleNote }: InvoiceActionsProps) {
  const router = useRouter();
  const { run, busy } = useCrmAction();
  const { offered, notes } = React.useMemo(() => invoiceActions(facts), [facts]);
  const has = (a: InvoiceActionId) => offered.includes(a);
  const [dialog, setDialog] = React.useState<Dialog>(null);
  const [reason, setReason] = React.useState("");
  const [link, setLink] = React.useState<string | null>(null);
  const [pay, setPay] = React.useState({ amount: "", receivedOn: todayIn(new Date(), tz), method: "bank_transfer", evidence: "", overpayment: false, override: false, key: newKey() });
  const close = () => {
    setDialog(null);
    setReason("");
  };

  const showLink = async () => {
    const r = await run("link", () => getInvoiceLinkAction(invoiceId));
    if (r) setLink((r as { url: string }).url);
  };
  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      toast.success("Link copied.");
    } catch {
      toast.error("Could not copy. Select the link and copy it yourself.");
    }
  };

  const recordPayment = async () => {
    const r = await run("payment", () => recordPaymentAction(invoiceId, { amount: pay.amount, receivedOn: pay.receivedOn, method: pay.method, evidence: pay.evidence, allowOverpayment: pay.overpayment, overrideOpenAttempt: pay.override, idempotencyKey: pay.key }), (d) => {
      const out = d as { duplicate: boolean; justPaid: boolean };
      return out.duplicate ? "That payment was already recorded." : out.justPaid ? "Payment recorded. The invoice is paid." : "Payment recorded.";
    });
    if (r) {
      setPay({ amount: "", receivedOn: todayIn(new Date(), tz), method: "bank_transfer", evidence: "", overpayment: false, override: false, key: newKey() });
      close();
    }
  };

  const testPay = async () => {
    const r = await run("test", () => startTestPaymentAction(invoiceId));
    if (r) window.location.assign((r as { url: string }).url);
  };

  const issueLabel = status === "pending_approval" ? "Approve and issue" : "Issue invoice";

  return (
    <section aria-label="Actions" className="space-y-4 rounded-2xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        {has("edit") && <Link href={`/invoices/${invoiceId}/edit`} className="inline-flex min-h-11 items-center rounded-xl border border-line bg-surface px-4 text-[13.5px] font-medium text-ink shadow-soft hover:bg-surface-2 sm:min-h-10">Edit draft</Link>}
        {has("submit") && <Button variant="secondary" loading={busy("submit")} disabled={!hasCustomer} onClick={() => run("submit", () => submitInvoiceAction(invoiceId, version), "Sent for approval.")}>Send for approval</Button>}
        {(has("issue") || has("approve_issue")) && <Button variant="brand" disabled={!hasCustomer} onClick={() => setDialog("issue")}>{issueLabel}</Button>}
        {has("request_changes") && <Button variant="secondary" onClick={() => setDialog("changes")}>Ask for changes</Button>}
        {has("withdraw") && <Button variant="secondary" loading={busy("withdraw")} onClick={() => run("withdraw", () => withdrawInvoiceAction(invoiceId), "Taken back to a draft.")}>Take back to draft</Button>}
        {has("link") && <Button variant="brand" loading={busy("link")} onClick={showLink}>Get the customer&apos;s link</Button>}
        {has("record_payment") && <Button variant="secondary" onClick={() => setDialog("payment")}>Record a payment</Button>}
        {has("test_payment") && <Button variant="outline" onClick={() => setDialog("test")}><FlaskConical className="size-4" aria-hidden />Pay as a test</Button>}
        {has("write_off") && <Button variant="outline" onClick={() => setDialog("write_off")}>Write off</Button>}
        {has("void") && <Button variant="outline" onClick={() => setDialog("void")}>Void</Button>}
        {has("discard") && <Button variant="ghost" onClick={() => setDialog("discard")}>Discard draft</Button>}
      </div>
      {!hasCustomer && (has("submit") || has("issue") || has("approve_issue")) && <p className="text-[12.5px] text-warning-ink">Choose the customer on the draft before it can be sent for approval or issued.</p>}
      {notes.map((n) => <p key={n} className="text-[12.5px] text-muted">{n}</p>)}
      {closeRuleNote && <p className="text-[12.5px] text-muted">{closeRuleNote}</p>}

      {link && (
        <div className="space-y-2 rounded-xl border border-line bg-surface-2/60 p-3" role="group" aria-label="The customer's link">
          <p className="text-[13px] font-medium text-ink">The customer&apos;s link</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input readOnly value={link} aria-label="The customer's link" className={input16} onFocus={(e) => e.currentTarget.select()} />
            <Button variant="secondary" onClick={copy}><Copy className="size-4" aria-hidden />Copy</Button>
          </div>
          <p className="text-[12.5px] text-muted">Anyone who has this link can see this invoice and start a payment. Give it only to your customer, in a message you send yourself. Showing it is recorded in the invoice&apos;s history. Nothing was sent to anyone.</p>
          <Button variant="ghost" size="sm" onClick={() => setDialog("rotate")}>Replace the link</Button>
        </div>
      )}

      <ConfirmDialog
        open={dialog === "issue"} onOpenChange={(o) => !o && close()} title={status === "pending_approval" ? "Approve and issue this invoice?" : "Issue this invoice?"} confirmLabel={issueLabel} loading={busy("issue")}
        description={`You are issuing exactly what you can see now (version ${version}), for ${money(totalMinor, currency)}. It gets its number, the customer's and your details are frozen, and the amounts, dates and wording can no longer change. Nothing is sent to the customer yet.`}
        onConfirm={async () => { const r = await run("issue", () => issueInvoiceAction(invoiceId, version), (d) => `Issued as ${(d as { number: string }).number}.`); if (r) close(); }}
      />
      <ConfirmDialog
        open={dialog === "changes"} onOpenChange={(o) => !o && close()} title="Ask for changes" confirmLabel="Send back" loading={busy("changes")} confirmDisabled={reason.trim().length < 3}
        description="The invoice goes back to a draft and the person who wrote it is told what to change."
        onConfirm={async () => { const r = await run("changes", () => requestInvoiceChangesAction(invoiceId, { version, note: reason }), "Sent back."); if (r) close(); }}
      >
        <Field label="What should change?" htmlFor="inv-changes"><Textarea id="inv-changes" rows={3} className={input16} maxLength={400} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </ConfirmDialog>
      <ConfirmDialog
        open={dialog === "discard"} onOpenChange={(o) => !o && close()} title="Discard this draft?" confirmLabel="Discard" danger loading={busy("discard")}
        description="The draft is deleted. It never had a number, so nothing is lost from your invoice sequence."
        onConfirm={async () => { const r = await run("discard", () => discardInvoiceDraftAction(invoiceId), "Draft discarded."); if (r) router.push("/invoices"); }}
      />
      <ConfirmDialog
        open={dialog === "void"} onOpenChange={(o) => !o && close()} title={`Void ${number ?? "this invoice"}?`} confirmLabel="Void invoice" danger loading={busy("void")} confirmDisabled={reason.trim().length < 5}
        description="It keeps its number, the customer's link stops working and its reminders are cancelled. An invoice with a payment cannot be voided."
        onConfirm={async () => { const r = await run("void", () => voidInvoiceAction(invoiceId, { reason }), "Invoice voided."); if (r) close(); }}
      >
        <Field label="Why is it being voided?" htmlFor="inv-void"><Textarea id="inv-void" rows={2} className={input16} maxLength={400} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </ConfirmDialog>
      <ConfirmDialog
        open={dialog === "write_off"} onOpenChange={(o) => !o && close()} title={`Write off ${money(balanceMinor, currency)}?`} confirmLabel="Write off" danger loading={busy("write_off")} confirmDisabled={reason.trim().length < 5}
        description="You give up collecting what is still owed. It is a loss, never revenue, and it is final. A late payment can still be recorded afterwards. Reminders stop."
        onConfirm={async () => { const r = await run("write_off", () => writeOffInvoiceAction(invoiceId, { reason }), "Written off."); if (r) close(); }}
      >
        <Field label="Why?" htmlFor="inv-writeoff"><Textarea id="inv-writeoff" rows={2} className={input16} maxLength={400} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </ConfirmDialog>
      <ConfirmDialog
        open={dialog === "rotate"} onOpenChange={(o) => !o && close()} title="Replace the customer's link?" confirmLabel="Replace link" loading={busy("rotate")}
        description="The old link stops working at once, for everyone who has it. Use this if the link was sent to the wrong person. Then get the new link and give it to the customer."
        onConfirm={async () => { const r = await run("rotate", () => rotateInvoiceLinkAction(invoiceId), "Link replaced. Get the new link to share it."); if (r) { setLink(null); close(); } }}
      />
      <ConfirmDialog
        open={dialog === "test"} onOpenChange={(o) => !o && close()} title="Pay this invoice as a test?" confirmLabel="Open the test payment page" loading={busy("test")}
        description={<span className="space-y-2"><span className="block">Your payment account is in test mode, so no real money moves. But the provider will report the payment as made, and that is recorded against THIS invoice: it will show as paid in your records (marked as a test), reminders for it stop, and the customer&apos;s page will read as paid.</span><span className="block font-medium text-ink">Use an invoice you made only for testing, not one a customer owes.</span></span>}
        onConfirm={testPay}
      />
      <ConfirmDialog
        open={dialog === "payment"} onOpenChange={(o) => !o && close()} title="Record a payment you received" confirmLabel="Record payment" loading={busy("payment")}
        confirmDisabled={!pay.amount.trim() || pay.evidence.trim().length < 3}
        description={`This is your own record of money you received outside this product, kept with your evidence. It is not confirmed by a payment provider${balanceMinor > 0 ? `, and ${money(balanceMinor, currency)} is still owed` : ""}.`}
        onConfirm={recordPayment}
      >
        <div className="space-y-3">
          <Field label={`Amount received (${currency})`} htmlFor="pay-amount" hint={balanceMinor > 0 ? `Still owed: ${amountText(balanceMinor, currency)}` : undefined}><Input id="pay-amount" inputMode="decimal" className={input16} value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} /></Field>
          <Field label="Received on" htmlFor="pay-date"><Input id="pay-date" type="date" className={input16} value={pay.receivedOn} max={todayIn(new Date(), tz)} onChange={(e) => setPay({ ...pay, receivedOn: e.target.value })} /></Field>
          <Field label="How was it paid?" htmlFor="pay-method"><Select id="pay-method" className={input16} value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>{PAYMENT_METHODS.map((m) => <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>)}</Select></Field>
          <Field label="How do you know? (kept with the payment)" htmlFor="pay-evidence" hint="A transfer reference, a receipt number, who handed over the cash. Never a card number."><Textarea id="pay-evidence" rows={2} className={input16} maxLength={600} value={pay.evidence} onChange={(e) => setPay({ ...pay, evidence: e.target.value })} /></Field>
          <label className="flex min-h-11 items-start gap-3 text-[13px] text-ink-2"><input type="checkbox" className="mt-0.5 size-5" checked={pay.overpayment} onChange={(e) => setPay({ ...pay, overpayment: e.target.checked })} />The customer paid more than the invoice is for</label>
          <details className="rounded-xl border border-line px-3 py-2">
            <summary className="min-h-11 cursor-pointer text-[13px] text-ink-2 sm:min-h-8">If the customer may also be paying online</summary>
            <p className="mt-2 text-[12.5px] text-muted">A payment page may be open for this invoice. Recording a payment while one is open is refused, because it could be the same money twice. If this is a different payment, tick below.</p>
            <label className="mt-2 flex min-h-11 items-start gap-3 text-[13px] text-ink-2"><input type="checkbox" className="mt-0.5 size-5" checked={pay.override} onChange={(e) => setPay({ ...pay, override: e.target.checked })} />This is a different payment from the one the customer may be making online. Record it anyway.</label>
          </details>
          <p className="flex items-start gap-2 text-[12.5px] text-muted"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />Recorded by hand, this payment is shown apart and does not count as verified revenue unless the owner chose that in the invoice settings.</p>
        </div>
      </ConfirmDialog>
    </section>
  );
}
