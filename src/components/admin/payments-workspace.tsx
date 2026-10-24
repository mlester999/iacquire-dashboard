"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Banknote, HandCoins, Undo2 } from "lucide-react";
import { recordManualPaymentAction, recordRefundForPaymentAction, waiveSetupFeeAction } from "@/app/(admin)/admin/billing/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, EmptyState, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/overlays";
import { StatusPill } from "@/components/ui/status";
import { formatUsd } from "@/lib/billing";
import { MANUAL_KIND_LABEL, MANUAL_METHOD_LABEL, MANUAL_PAYMENT_KINDS, MANUAL_PAYMENT_METHODS, MICROS_PER_CENT, centsToDollarText, paymentStatusCopy, paymentWayLabel, setupStatusCopy } from "@/lib/billing-clearance";
import { formatDate, formatDateTime, sentenceCase } from "@/lib/utils";
import type { AgencyPaymentView, PaymentClientOption } from "@/server/billing/payments-view";

/** Today as the person at the keyboard reads it (their own calendar day), for the date a payment arrived. */
const localDay = () => new Date().toLocaleDateString("en-CA");

const KIND_LABEL: Record<string, string> = { ...MANUAL_KIND_LABEL, credit_topup: "Service credits" };

/**
 * Records money a Super Admin saw arrive outside a provider. The words on this form say what it is: a person's record, with the reference they checked, never a payment
 * the portal detected. The server checks every field again and refuses a repeated reference.
 */
export function RecordPaymentDialog(props: { open: boolean; onOpenChange: (open: boolean) => void; clients: PaymentClientOption[]; orgId?: string; timeZone: string }) {
  // The form exists only while the dialog is open, so every opening starts empty without an effect to reset it.
  return props.open ? <RecordPaymentForm {...props} /> : null;
}

function RecordPaymentForm({ open, onOpenChange, clients, orgId, timeZone }: { open: boolean; onOpenChange: (open: boolean) => void; clients: PaymentClientOption[]; orgId?: string; timeZone: string }) {
  const router = useRouter();
  const [client, setClient] = React.useState(orgId ?? "");
  const [kind, setKind] = React.useState<string>("setup_fee");
  // null until the person types: the agreed setup fee is then offered as the amount, never assumed. Any other kind starts empty.
  const [typedAmount, setTypedAmount] = React.useState<string | null>(null);
  const [method, setMethod] = React.useState<string>("bank_transfer");
  const [reference, setReference] = React.useState("");
  const [paidOn, setPaidOn] = React.useState(localDay);
  const [note, setNote] = React.useState("");
  const [through, setThrough] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const chosen = clients.find((c) => c.orgId === client);
  const agreedFee = chosen ? centsToDollarText(chosen.setupFeeCents) : "";
  const amount = typedAmount ?? (kind === "setup_fee" ? agreedFee : "");

  const submit = async () => {
    setBusy(true);
    setError(null);
    const res = await recordManualPaymentAction(client, { kind, amount, method, externalReference: reference, paidOn, note, paidThroughOn: kind === "maintenance" ? through : null });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    toast.success(res.data.duplicate ? "That reference was already recorded. Nothing was added." : res.data.clearedSetup ? "Payment recorded. The setup fee is confirmed." : "Payment recorded.");
    onOpenChange(false);
    router.refresh();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      icon={<Banknote />}
      title="Record a payment you received"
      description={`Use this for money that arrived outside PayMongo: a bank transfer, cash, or a payment you saw in the PayPal or PayMongo dashboard. It is your record, not something the portal detected. Dates are in ${timeZone.replaceAll("_", " ")}.`}
      footer={<><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="brand" loading={busy} disabled={!client || !reference.trim() || !amount.trim() || !paidOn || note.trim().length < 5} onClick={submit}>Record payment</Button></>}
    >
      <div className="space-y-4">
        {error && <p role="alert" className="rounded-xl border border-danger/30 bg-danger-soft px-3.5 py-2.5 text-[13px] text-danger-ink">{error}</p>}
        <Field label="Client" htmlFor="rp-client">
          <Select id="rp-client" value={client} disabled={Boolean(orgId)} onChange={(e) => { setClient(e.target.value); setTypedAmount(null); }}>
            <option value="">Choose a client</option>
            {clients.map((c) => <option key={c.orgId} value={c.orgId}>{c.name}</option>)}
          </Select>
        </Field>
        {chosen && <p className="text-[12.5px] text-muted">Setup fee for {chosen.name}: {setupStatusCopy(chosen.setupStatus).label}.</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="What it paid for" htmlFor="rp-kind">
            <Select id="rp-kind" value={kind} onChange={(e) => { setKind(e.target.value); setTypedAmount(null); }}>
              {MANUAL_PAYMENT_KINDS.map((k) => <option key={k} value={k}>{MANUAL_KIND_LABEL[k]}</option>)}
            </Select>
          </Field>
          <Field label="Amount (US dollars)" htmlFor="rp-amount" hint={kind === "setup_fee" ? "A setup fee must equal the agreed fee. For any other arrangement, waive the fee with a reason." : undefined}>
            <Input id="rp-amount" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setTypedAmount(e.target.value)} placeholder="1499.00" />
          </Field>
          <Field label="How it arrived" htmlFor="rp-method">
            <Select id="rp-method" value={method} onChange={(e) => setMethod(e.target.value)}>
              {MANUAL_PAYMENT_METHODS.map((m) => <option key={m} value={m}>{MANUAL_METHOD_LABEL[m]}</option>)}
            </Select>
          </Field>
          <Field label="Day the money arrived" htmlFor="rp-date">
            <Input id="rp-date" type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
          </Field>
        </div>
        {kind === "maintenance" && (
          <Field label="Last day this payment covers" htmlFor="rp-through" hint="The plan is paid up to and including this day.">
            <Input id="rp-through" type="date" value={through} onChange={(e) => setThrough(e.target.value)} />
          </Field>
        )}
        <Field label="Bank reference, receipt number or transaction id" htmlFor="rp-ref" hint="Recorded once. Entering the same reference again never makes a second payment.">
          <Input id="rp-ref" autoComplete="off" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} />
        </Field>
        <Field label="What you checked" htmlFor="rp-note" hint="For example the statement line or the dashboard entry you matched it to.">
          <Textarea id="rp-note" rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

/** Waives the setup fee. The reason is required, kept for the agency, and not shown to the client. */
export function WaiveFeeDialog(props: { open: boolean; onOpenChange: (open: boolean) => void; orgId: string; orgName: string }) {
  return props.open ? <WaiveFeeForm {...props} /> : null;
}

function WaiveFeeForm({ open, onOpenChange, orgId, orgName }: { open: boolean; onOpenChange: (open: boolean) => void; orgId: string; orgName: string }) {
  const router = useRouter();
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    const res = await waiveSetupFeeAction(orgId, reason);
    setBusy(false);
    if (!res.ok) return setError(res.error);
    toast.success(res.data.changed ? "The setup fee is waived." : "The setup fee was already waived.");
    onOpenChange(false);
    router.refresh();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      icon={<HandCoins />}
      title={`Waive the setup fee for ${orgName}?`}
      description="The client's AI team can then be set up and the setup can be activated without a payment. Your reason is saved with your name and the time, and the client does not see it."
      footer={<><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="danger" loading={busy} disabled={reason.trim().length < 10} onClick={submit}>Waive the fee</Button></>}
    >
      <div className="space-y-3">
        {error && <p role="alert" className="rounded-xl border border-danger/30 bg-danger-soft px-3.5 py-2.5 text-[13px] text-danger-ink">{error}</p>}
        <Field label="Why is the fee waived?" htmlFor="wv-reason" hint="At least 10 characters. Say who agreed to it and where it is written down.">
          <Textarea id="wv-reason" rows={4} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

/** Records a refund that was already made with the provider or by hand. It does not send money. */
export function RefundDialog({ payment, onClose, timeZone }: { payment: AgencyPaymentView | null; onClose: () => void; timeZone: string }) {
  return payment ? <RefundForm key={payment.id} payment={payment} onClose={onClose} timeZone={timeZone} /> : null;
}

function RefundForm({ payment, onClose, timeZone }: { payment: AgencyPaymentView; onClose: () => void; timeZone: string }) {
  const router = useRouter();
  const remaining = payment.usdMicros - payment.refundedMicros;
  // The whole remainder is offered; the person types less for a partial refund.
  const [amount, setAmount] = React.useState(() => centsToDollarText(Math.round(remaining / MICROS_PER_CENT)));
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    const res = await recordRefundForPaymentAction(payment.id, amount, reason);
    setBusy(false);
    if (!res.ok) return setError(res.error);
    toast.success(res.data.setupRefunded ? "Refund recorded. The setup fee is no longer confirmed; nothing already running is paused." : "Refund recorded.");
    onClose();
    router.refresh();
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      icon={<Undo2 />}
      title="Record a refund"
      description={`This only records a refund you already made. ${payment.orgName}: ${KIND_LABEL[payment.kind] ?? sentenceCase(payment.kind)}, paid ${payment.paidAt ? formatDate(payment.paidAt, timeZone) : "(date not recorded)"}. Up to ${formatUsd(remaining)} can still be refunded.`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" loading={busy} disabled={!amount.trim() || reason.trim().length < 10} onClick={submit}>Record refund</Button></>}
    >
      <div className="space-y-3">
        {error && <p role="alert" className="rounded-xl border border-danger/30 bg-danger-soft px-3.5 py-2.5 text-[13px] text-danger-ink">{error}</p>}
        {payment.kind === "setup_fee" && <p className="text-[12.5px] leading-relaxed text-muted">A full refund of the payment that cleared the setup fee stops new AI employees from being set up. Anything already running keeps running.</p>}
        <Field label="Amount refunded (US dollars)" htmlFor="rf-amount">
          <Input id="rf-amount" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Why was it refunded?" htmlFor="rf-reason" hint="At least 10 characters.">
          <Textarea id="rf-reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

/** One payment as a card: readable at 375 px with nothing to scroll sideways. */
export function PaymentRow({ p, canManage, onRefund, timeZone, showClient = true }: { p: AgencyPaymentView; canManage: boolean; onRefund: (p: AgencyPaymentView) => void; timeZone: string; showClient?: boolean }) {
  const status = paymentStatusCopy(p.status);
  const refundable = canManage && (p.status === "paid" || p.status === "partially_refunded") && p.usdMicros > p.refundedMicros;
  return (
    <li className="space-y-1.5 px-4 py-3.5 sm:px-5">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <p className="text-[14px] font-semibold text-ink">{showClient ? `${p.orgName}: ` : ""}{KIND_LABEL[p.kind] ?? sentenceCase(p.kind)}</p>
          <p className="text-[12.5px] text-muted">{paymentWayLabel(p)}{p.paidOn ? ` · arrived ${formatDate(`${p.paidOn}T12:00:00Z`, "UTC")}` : p.paidAt ? ` · ${formatDateTime(p.paidAt, timeZone)}` : ""}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <strong className="text-[14px] font-semibold tabular-nums text-ink">{formatUsd(p.usdMicros)}</strong>
          <StatusPill tone={status.tone}>{status.label}</StatusPill>
          {p.clearedSetup && <StatusPill tone="success">Cleared the setup fee</StatusPill>}
        </div>
      </div>
      {p.refundedMicros > 0 && <p className="text-[12.5px] text-muted">Refunded so far: {formatUsd(p.refundedMicros)}</p>}
      {p.providerNotices.length > 0 && (
        // What PayMongo reported is shown beside what a person recorded, and labelled as a report: the status and amounts above change only when a person records a refund.
        <ul className="space-y-1 rounded-xl border border-warning/25 bg-warning-soft px-3 py-2 text-[12.5px] leading-relaxed text-warning-ink" aria-label="Reported by PayMongo">
          {p.providerNotices.map((n) => (
            <li key={`${n.type}:${n.receivedAt}`}>
              <strong className="font-semibold">{/dispute|chargeback/i.test(n.type) ? "PayMongo reported a dispute" : "PayMongo reported a refund"}</strong> ({formatDateTime(n.receivedAt, timeZone)}). {/dispute|chargeback/i.test(n.type) ? "The payment still counts as received until you record what happened." : "Record it below if you have not already; nothing was changed automatically."}
            </li>
          ))}
        </ul>
      )}
      {p.provider === "manual" && (
        <p className="break-words text-[12.5px] text-muted">
          Reference {p.externalReference}. Checked by {p.verifiedByName ?? "a former team member"}: {p.verificationNote}
        </p>
      )}
      <p className="text-[12px] text-faint">iAcquire reference {p.referenceNumber}</p>
      {refundable && (
        <div className="pt-1"><Button size="sm" variant="secondary" onClick={() => onRefund(p)}><Undo2 className="size-3.5" aria-hidden /> Record a refund</Button></div>
      )}
    </li>
  );
}

/** The Payments tab on /admin/billing: every payment across the clients this person may see, and the controls for a Super Admin. */
export function PaymentsWorkspace({ payments, clients, canManage, timeZone }: { payments: AgencyPaymentView[]; clients: PaymentClientOption[]; canManage: boolean; timeZone: string }) {
  const [recording, setRecording] = React.useState(false);
  const [refunding, setRefunding] = React.useState<AgencyPaymentView | null>(null);
  const waiting = clients.filter((c) => !c.cleared);
  return (
    <div className="space-y-5">
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-2xl text-[13px] leading-relaxed text-muted">
            iAcquire&apos;s own setup fees and plan payments. A payment is confirmed either by PayMongo&apos;s signed notice or by a Super Admin who saw the money arrive and recorded the reference. Nothing here is marked paid on a guess.
          </p>
          {canManage && <Button variant="brand" onClick={() => setRecording(true)}><Banknote className="size-4" aria-hidden /> Record a payment</Button>}
        </CardContent>
      </Card>
      {waiting.length > 0 && (
        <Card>
          <CardContent className="space-y-1.5">
            <h3 className="text-[14px] font-semibold text-ink">Setup fee not confirmed ({waiting.length})</h3>
            <ul className="divide-y divide-line text-[13px]">
              {waiting.map((c) => (
                <li key={c.orgId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <Link href={`/admin/clients/${c.orgId}?tab=billing`} className="inline-flex min-h-11 items-center font-medium text-ink underline-offset-2 hover:underline sm:min-h-0">{c.name}</Link>
                  <span className="text-muted">{setupStatusCopy(c.setupStatus).label}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      <Card className="overflow-hidden">
        {payments.length === 0 ? (
          <EmptyState icon={<Banknote className="size-5" />} title="No payments yet" description="Payments appear here once a client pays through PayMongo or a Super Admin records one." />
        ) : (
          <ul className="divide-y divide-line">
            {payments.map((p) => <PaymentRow key={p.id} p={p} canManage={canManage} onRefund={setRefunding} timeZone={timeZone} />)}
          </ul>
        )}
      </Card>
      <RecordPaymentDialog open={recording} onOpenChange={setRecording} clients={clients} timeZone={timeZone} />
      <RefundDialog payment={refunding} onClose={() => setRefunding(null)} timeZone={timeZone} />
    </div>
  );
}
