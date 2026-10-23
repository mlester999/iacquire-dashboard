"use client";

import * as React from "react";
import { Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/primitives";
import { ConfirmDialog, useCrmAction } from "@/components/crm/ui";
import { recordRefundAction } from "@/app/actions/invoices";
import { amountText, formatInstant, methodLabel, money, PROVIDER_NAMES, REFUND_SOURCE_LABELS } from "@/lib/invoices/labels";
import type { CurrencyCode } from "@/lib/money";
import { PaymentRowBadge } from "@/components/invoices/status";
import type { PaymentView, RefundView } from "@/server/invoices/invoices";

// What was received against the invoice, and what was handed back. A refund is recorded here after the business made it in its payment provider's own dashboard (or by hand):
// this product moves no money. A refund reduces what the business kept; it never re-opens the invoice or changes a deal.

const COUNTED = ["succeeded", "partially_refunded", "refunded", "disputed"];
const input16 = "text-[16px] sm:text-[14px]";
const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`);

export function PaymentsPanel({ payments, refunds, currency, canRefund, tz }: { payments: PaymentView[]; refunds: RefundView[]; currency: CurrencyCode; canRefund: boolean; tz: string }) {
  const { run, busy } = useCrmAction();
  const [target, setTarget] = React.useState<PaymentView | null>(null);
  const [amount, setAmount] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [key, setKey] = React.useState(newKey);
  const open = (p: PaymentView) => {
    setTarget(p);
    setAmount(amountText(Math.max(p.amountMinor - p.refundedMinor, 0), currency));
    setReason("");
    setKey(newKey());
  };

  return (
    <section aria-labelledby="inv-payments" className="space-y-3">
      <h2 id="inv-payments" className="text-[15px] font-semibold text-ink">Payments and refunds</h2>
      {payments.length === 0 ? (
        <p className="rounded-2xl border border-line bg-surface-2 px-4 py-3 text-[13.5px] text-ink-2">Nothing has been received against this invoice. A payment appears here only when your payment provider confirms it or you record it yourself.</p>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface" aria-label="Payments">
          {payments.map((p) => {
            const refundable = COUNTED.includes(p.status) && p.amountMinor - p.refundedMinor > 0 && p.status !== "refunded";
            return (
              <li key={p.id} className="space-y-1.5 px-4 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <span className="text-[14px] font-semibold tabular-nums text-ink">{money(p.amountMinor, currency)}</span>
                  <PaymentRowBadge status={p.status} testMode={p.provider !== "manual" && !p.livemode} />
                  <span className="text-[12.5px] text-muted">{PROVIDER_NAMES[p.provider] ?? p.provider}{p.method ? ` · ${methodLabel(p.method)}` : ""} · {formatInstant(p.receivedAt, tz)}</span>
                  {canRefund && refundable && <Button variant="ghost" size="sm" className="ml-auto" onClick={() => open(p)}><Undo2 className="size-4" aria-hidden />Record a refund</Button>}
                </div>
                <p className="text-[12.5px] text-muted">
                  {p.verification === "manual" ? `Recorded by ${p.recordedByName ?? "a team member"} from their own word${p.evidence ? `: ${p.evidence}` : "."}` : p.livemode ? "Confirmed by the payment provider." : "Confirmed by the payment provider in test mode. No real money moved."}
                  {p.refundedMinor > 0 ? ` ${money(p.refundedMinor, currency)} refunded.` : ""}
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
        open={Boolean(target)} onOpenChange={(o) => !o && setTarget(null)} title="Record a refund" confirmLabel="Record refund" loading={busy("refund")} confirmDisabled={!amount.trim() || reason.trim().length < 3}
        description="Record that this money was handed back, after you did it in your payment provider's own dashboard (or in cash). This product does not send the refund. The invoice stays paid; the refund reduces what you kept."
        onConfirm={async () => { if (!target) return; const r = await run("refund", () => recordRefundAction(target.id, { amount, reason, idempotencyKey: key }), (d) => ((d as { duplicate: boolean }).duplicate ? "That refund was already recorded." : "Refund recorded.")); if (r) setTarget(null); }}
      >
        <div className="space-y-3">
          <Field label={`Amount refunded (${currency})`} htmlFor="refund-amount" hint={target ? `Most you can refund on this payment: ${amountText(Math.max(target.amountMinor - target.refundedMinor, 0), currency)}` : undefined}>
            <Input id="refund-amount" inputMode="decimal" className={input16} value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label="Why?" htmlFor="refund-reason"><Textarea id="refund-reason" rows={2} className={input16} maxLength={400} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        </div>
      </ConfirmDialog>
    </section>
  );
}
