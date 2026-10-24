"use client";

import * as React from "react";
import { ShieldAlert, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/primitives";
import { ConfirmDialog, useCrmAction } from "@/components/crm/ui";
import { recordDisputeOpenedAction, recordDisputeResultAction, recordRefundAction } from "@/app/actions/invoices";
import { amountText, formatInstant, methodLabel, money, PROVIDER_NAMES, REFUND_SOURCE_LABELS } from "@/lib/invoices/labels";
import { providerRefundTwin } from "@/lib/invoices/refund-match";
import { parseAmount, type CurrencyCode } from "@/lib/money";
import { PaymentRowBadge } from "@/components/invoices/status";
import type { PaymentView, RefundView } from "@/server/invoices/invoices";

// What was received against the invoice, and what was handed back. A refund is recorded here after the business made it in its payment provider's own dashboard (or by hand):
// this product moves no money. A refund reduces what the business kept; it never re-opens the invoice or changes a deal. A dispute the payment provider never told this product
// about is recorded here too, and so is how any dispute ended: until then the payment is held out of revenue, because nobody guesses who won.

const COUNTED = ["succeeded", "partially_refunded", "refunded", "disputed"];
const input16 = "text-[16px] sm:text-[14px]";
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** What the person typed as an amount, or null when it is not one (the server reads it again; this only decides whether to warn). */
function minorOf(text: string, currency: CurrencyCode): number | null {
  try {
    return parseAmount(text, currency);
  } catch {
    return null;
  }
}

type DisputeDialog = { payment: PaymentView; mode: "open" | "result" };

/** `isTest`: the invoice is a test invoice. Its payments moved no money, so there is nothing to refund or dispute; it is voided or deleted instead. */
export function PaymentsPanel({ payments, refunds, currency, canRefund: mayRefund, isTest = false, tz }: { payments: PaymentView[]; refunds: RefundView[]; currency: CurrencyCode; canRefund: boolean; isTest?: boolean; tz: string }) {
  const canRefund = mayRefund && !isTest;
  const { run, busy } = useCrmAction();
  const [target, setTarget] = React.useState<PaymentView | null>(null);
  const [amount, setAmount] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [separate, setSeparate] = React.useState(false);
  const [key, setKey] = React.useState(newKey);
  const open = (p: PaymentView) => {
    setTarget(p);
    setAmount(amountText(Math.max(p.amountMinor - p.refundedMinor, 0), currency));
    setReason("");
    setSeparate(false);
    setKey(newKey());
  };
  // The provider may have reported this very refund already: recording it again would count it twice, so the person is told and has to say it is a different one.
  const typed = target ? minorOf(amount, currency) : null;
  const twin = target && typed !== null && target.verification === "provider_confirmed" ? providerRefundTwin(refunds, target.id, typed, new Date()) : null;

  const [dispute, setDispute] = React.useState<DisputeDialog | null>(null);
  const [result, setResult] = React.useState<"" | "won" | "lost">("");
  const [lostAmount, setLostAmount] = React.useState("");
  const [note, setNote] = React.useState("");
  const openDispute = (p: PaymentView, mode: DisputeDialog["mode"]) => {
    setDispute({ payment: p, mode });
    setResult("");
    setLostAmount(amountText(Math.max(p.amountMinor - p.refundedMinor, 0), currency));
    setNote("");
  };
  const left = dispute ? Math.max(dispute.payment.amountMinor - dispute.payment.refundedMinor, 0) : 0;
  const resultReady = result === "won" || (result === "lost" && (minorOf(lostAmount, currency) ?? 0) > 0);

  return (
    <section aria-labelledby="inv-payments" className="space-y-3">
      <h2 id="inv-payments" className="text-[15px] font-semibold text-ink">Payments and refunds</h2>
      {payments.length === 0 ? (
        <p className="rounded-2xl border border-line bg-surface-2 px-4 py-3 text-[13.5px] text-ink-2">{isTest ? "No test payment has been made on this test invoice yet. Use Pay as a test to try your payment account." : "Nothing has been received against this invoice. A payment appears here only when your payment provider confirms it or you record it yourself."}</p>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface" aria-label="Payments">
          {payments.map((p) => {
            const refundable = COUNTED.includes(p.status) && p.amountMinor - p.refundedMinor > 0 && p.status !== "refunded";
            const providerConfirmed = p.verification === "provider_confirmed";
            return (
              <li key={p.id} className="space-y-1.5 px-4 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <span className="text-[14px] font-semibold tabular-nums text-ink">{money(p.amountMinor, currency)}</span>
                  <PaymentRowBadge status={p.status} testMode={p.provider !== "manual" && !p.livemode} />
                  <span className="text-[12.5px] text-muted">{PROVIDER_NAMES[p.provider] ?? p.provider}{p.method ? ` · ${methodLabel(p.method)}` : ""} · {formatInstant(p.receivedAt, tz)}</span>
                  <span className="ml-auto flex flex-wrap items-center gap-2">
                    {canRefund && providerConfirmed && ["succeeded", "partially_refunded"].includes(p.status) && <Button variant="ghost" size="sm" onClick={() => openDispute(p, "open")}><ShieldAlert className="size-4" aria-hidden />Record a dispute</Button>}
                    {canRefund && providerConfirmed && p.status === "disputed" && <Button variant="secondary" size="sm" onClick={() => openDispute(p, "result")}><ShieldAlert className="size-4" aria-hidden />Record how the dispute ended</Button>}
                    {canRefund && refundable && <Button variant="ghost" size="sm" onClick={() => open(p)}><Undo2 className="size-4" aria-hidden />Record a refund</Button>}
                  </span>
                </div>
                <p className="text-[12.5px] text-muted">
                  {p.verification === "manual" ? `Recorded by ${p.recordedByName ?? "a team member"} from their own word${p.evidence ? `: ${p.evidence}` : "."}` : p.livemode ? "Confirmed by the payment provider." : "Confirmed by the payment provider in test mode. No real money moved."}
                  {p.refundedMinor > 0 ? ` ${money(p.refundedMinor, currency)} refunded.` : ""}
                  {p.status === "disputed" ? " Under dispute: held out of your revenue until the result is recorded." : ""}
                </p>
              </li>
            );
          })}
        </ul>
      )}
      {refunds.length > 0 && (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface" aria-label="Refunds">
          {refunds.map((r) => (
            <li key={r.id} className="space-y-0.5 px-4 py-3 text-[13.5px]">
              <p><span className="font-semibold tabular-nums text-ink">{money(r.amountMinor, currency)}</span> <span className="text-muted">refunded · {REFUND_SOURCE_LABELS[r.source] ?? r.source}{r.recordedByName ? ` · ${r.recordedByName}` : ""} · {formatInstant(r.createdAt, tz)}</span></p>
              <p className="text-[12.5px] text-ink-2">{r.reason}</p>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={Boolean(target)} onOpenChange={(o) => !o && setTarget(null)} title="Record a refund" confirmLabel="Record refund" loading={busy("refund")} confirmDisabled={!amount.trim() || reason.trim().length < 3 || (twin !== null && !separate)}
        description="Record that this money was handed back, after you did it in your payment provider's own dashboard (or in cash). This product does not send the refund. The invoice stays paid; the refund reduces what you kept."
        onConfirm={async () => { if (!target) return; const r = await run("refund", () => recordRefundAction(target.id, { amount, reason, idempotencyKey: key, ...(twin ? { separateFromProvider: separate } : {}) }), (d) => ((d as { duplicate: boolean }).duplicate ? "That refund was already recorded." : "Refund recorded.")); if (r) setTarget(null); }}
      >
        <div className="space-y-3">
          <Field label={`Amount refunded (${currency})`} htmlFor="refund-amount" hint={target ? `Most you can refund on this payment: ${amountText(Math.max(target.amountMinor - target.refundedMinor, 0), currency)}` : undefined}>
            <Input id="refund-amount" inputMode="decimal" className={input16} value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="Why?" htmlFor="refund-reason"><Textarea id="refund-reason" rows={2} className={input16} maxLength={400} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          {twin && (
            <div role="note" className="rounded-xl bg-warning-soft px-3 py-2 text-[13px] text-warning-ink">
              <p>Your payment provider already reported a refund of {money(twin.amountMinor, currency)} on this payment ({formatInstant(twin.createdAt, tz)}), and it is counted. Recording this too would count it twice.</p>
              <label className="mt-1 flex min-h-11 items-start gap-3"><input type="checkbox" className="mt-0.5 size-5 shrink-0" checked={separate} onChange={(e) => setSeparate(e.target.checked)} />This is a different refund. Record it as well.</label>
            </div>
          )}
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={dispute?.mode === "open"} onOpenChange={(o) => !o && setDispute(null)} title="Record a dispute" confirmLabel="Record dispute" loading={busy("dispute-open")}
        description="Record that the customer disputed this payment with their bank, when your payment provider did not tell this product. Reminders for the invoice stop, and the payment is held out of your revenue until you record how the dispute ended. Nothing about the deal changes."
        onConfirm={async () => { if (!dispute) return; const r = await run("dispute-open", () => recordDisputeOpenedAction(dispute.payment.id, { note: note.trim() || null }), "Dispute recorded."); if (r) setDispute(null); }}
      >
        <Field label="Note (optional)" htmlFor="dispute-note"><Textarea id="dispute-note" rows={2} className={input16} maxLength={400} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </ConfirmDialog>
      <ConfirmDialog
        open={dispute?.mode === "result"} onOpenChange={(o) => !o && setDispute(null)} title="Record how the dispute ended" confirmLabel="Record result" loading={busy("dispute-result")} confirmDisabled={!resultReady}
        description="Say what the bank or your payment provider decided. Nothing is put back as received until you do. If you won, the payment counts again. If you lost, the money the buyer got back is recorded as a chargeback and reduces what you kept."
        onConfirm={async () => { if (!dispute || !result) return; const r = await run("dispute-result", () => recordDisputeResultAction(dispute.payment.id, { outcome: result, ...(result === "lost" ? { amount: lostAmount } : {}), note: note.trim() || null }), result === "won" ? "Recorded: you won the dispute." : "Recorded: you lost the dispute."); if (r) setDispute(null); }}
      >
        <div className="space-y-3">
          <fieldset className="space-y-1">
            <legend className="text-[13px] font-medium text-ink">How did it end?</legend>
            <label className="flex min-h-11 items-center gap-3 text-[13.5px] text-ink-2"><input type="radio" name="dispute-result" className="size-5 shrink-0" checked={result === "won"} onChange={() => setResult("won")} />We won: the money stays with us</label>
            <label className="flex min-h-11 items-center gap-3 text-[13.5px] text-ink-2"><input type="radio" name="dispute-result" className="size-5 shrink-0" checked={result === "lost"} onChange={() => setResult("lost")} />We lost: the buyer got money back</label>
          </fieldset>
          {result === "lost" && (
            <Field label={`How much the buyer got back (${currency})`} htmlFor="dispute-lost" hint={`Most it can be: ${amountText(left, currency)}`}>
              <Input id="dispute-lost" inputMode="decimal" className={input16} value={lostAmount} onChange={(e) => setLostAmount(e.target.value)} />
            </Field>
          )}
          <Field label="Note (optional)" htmlFor="dispute-result-note"><Textarea id="dispute-result-note" rows={2} className={input16} maxLength={400} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        </div>
      </ConfirmDialog>
    </section>
  );
}
