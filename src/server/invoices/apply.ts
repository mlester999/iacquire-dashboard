import "server-only";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { notifyOrgRoles } from "@/server/notifications";
import { formatMinor, taxPortion, toDecimalString, type CurrencyCode } from "@/lib/money";
import { derivePaymentStatus, type InvoicePaymentStatus, type InvoiceStatus } from "@/lib/invoices/state";
import { addInvoiceEvent, toMinor, type InvoiceActorKind } from "@/server/invoices/core";
import { announcePaid, announcePaymentFailed, announcePaymentReceived, announceRefunded } from "@/server/invoices/crm-effects";
import { stopReminders } from "@/server/invoices/reminders";

// The ONE place that decides how much of an invoice has been paid, refunded or disputed, and so what its payment status is. Everything else (the manual payment form,
// the provider webhooks, the reconciliation job) records a payment or a refund by calling a function here; none of them writes the paid or refunded amount, the
// payment status, or a payment or refund row itself (a test scans the source for that). The database enforces the same arithmetic from the other side: it refuses
// an invoice whose paid amount, refunded amount or payment status is not what its payment and refund rows add up to.
//
// Every function takes the transaction it runs in, locks the invoice row first (two payments for one invoice are applied one after the other), and is idempotent on
// the keys it is given: a payment is identified by (connection, the provider's payment id) or by an idempotency key, a refund by (payment, the provider's refund id)
// or by an idempotency key, and recording the same one twice changes nothing. A payment is counted only when its status is succeeded; anything the provider has not
// confirmed (pending), could not match to an invoice that can take it (needs_review) or refused (failed) is kept as a row and counts for nothing.
//
// What this file does not do: decide that a provider event is genuine (src/server/customer-payments does, before calling here), or touch the linked deal (the close
// rule runs after the transaction commits: src/server/invoices/close-rules.ts).

export type PaymentRowStatus = "succeeded" | "pending" | "failed" | "needs_review" | "partially_refunded" | "refunded" | "disputed";
export type PaymentProvider = "paymongo" | "paypal" | "simulated" | "manual";

/** Payments whose money was received: they add up to the invoice's paid amount. */
export const COUNTED_STATUSES: readonly PaymentRowStatus[] = ["succeeded", "partially_refunded", "refunded", "disputed"];
const COUNTED_SQL = "('succeeded', 'partially_refunded', 'refunded', 'disputed')";
export const isCounted = (s: PaymentRowStatus) => COUNTED_STATUSES.includes(s);

const money = (minor: number, currency: CurrencyCode) => formatMinor(minor, currency, "code");

interface LockedInvoice {
  id: string;
  status: InvoiceStatus;
  currency: CurrencyCode;
  totalMinor: number;
  taxMinor: number;
  paidMinor: number;
  refundedMinor: number;
  paymentStatus: InvoicePaymentStatus;
  number: string | null;
}

async function lockInvoice(db: Queryable, orgId: string, invoiceId: string): Promise<LockedInvoice> {
  const { rows } = await db.query<{ id: string; status: InvoiceStatus; currency: CurrencyCode; total_minor: string; tax_minor: string; paid_minor: string; refunded_minor: string; payment_status: InvoicePaymentStatus; number: string | null }>(
    "select id, status, currency, total_minor::text as total_minor, tax_minor::text as tax_minor, paid_minor::text as paid_minor, refunded_minor::text as refunded_minor, payment_status, number from customer_invoices where id = $1 and org_id = $2 for update",
    [invoiceId, orgId],
  );
  const r = rows[0];
  if (!r) throw new AppError("not_found", "That invoice was not found.");
  return { id: r.id, status: r.status, currency: r.currency, totalMinor: toMinor(r.total_minor), taxMinor: toMinor(r.tax_minor), paidMinor: toMinor(r.paid_minor), refundedMinor: toMinor(r.refunded_minor), paymentStatus: r.payment_status, number: r.number };
}

export interface InvoiceTotals {
  status: InvoiceStatus;
  currency: CurrencyCode;
  totalMinor: number;
  paidMinor: number;
  refundedMinor: number;
  balanceMinor: number;
  overpaidMinor: number;
  paymentStatus: InvoicePaymentStatus;
  number: string | null;
}

const totalsOf = (i: LockedInvoice): InvoiceTotals => ({
  status: i.status, currency: i.currency, totalMinor: i.totalMinor, paidMinor: i.paidMinor, refundedMinor: i.refundedMinor, balanceMinor: Math.max(i.totalMinor - i.paidMinor, 0),
  overpaidMinor: Math.max(i.paidMinor - i.totalMinor, 0), paymentStatus: i.paymentStatus, number: i.number,
});

/**
 * Re-adds an invoice's payments and refunds and writes the result onto it. Only an issued invoice carries amounts (a payment that arrives for any other invoice is kept for
 * review and never counted). Safe to call again at any time.
 */
export async function recomputeInvoice(db: Queryable, orgId: string, invoiceId: string): Promise<InvoiceTotals> {
  const inv = await lockInvoice(db, orgId, invoiceId);
  if (inv.status !== "issued") return totalsOf(inv);
  const { rows } = await db.query<{ paid: string; refunded: string; disputed: boolean }>(
    `select coalesce((select sum(amount_minor) from customer_payments where invoice_id = $1 and org_id = $2 and status in ${COUNTED_SQL}), 0)::text as paid,
            coalesce((select sum(amount_minor) from customer_refunds where invoice_id = $1 and org_id = $2 and status = 'succeeded'), 0)::text as refunded,
            exists (select 1 from customer_payments where invoice_id = $1 and org_id = $2 and status = 'disputed') as disputed`,
    [invoiceId, orgId],
  );
  const paid = toMinor(rows[0].paid);
  const refunded = toMinor(rows[0].refunded);
  const paymentStatus = derivePaymentStatus({ totalMinor: inv.totalMinor, paidMinor: paid, hasDispute: rows[0].disputed });
  if (paid !== inv.paidMinor || refunded !== inv.refundedMinor || paymentStatus !== inv.paymentStatus) {
    await db.query("update customer_invoices set paid_minor = $3, refunded_minor = $4, payment_status = $5 where id = $1 and org_id = $2", [invoiceId, orgId, paid, refunded, paymentStatus]);
  }
  return totalsOf({ ...inv, paidMinor: paid, refundedMinor: refunded, paymentStatus });
}

interface PaymentRow {
  id: string;
  invoice_id: string;
  status: PaymentRowStatus;
  amount_minor: string;
  tax_portion_minor: string;
  currency: CurrencyCode;
  provider: PaymentProvider;
  verification: "provider_confirmed" | "manual";
  livemode: boolean;
  attempt_id: string | null;
}

const PAYMENT_COLUMNS = "id, invoice_id, status, amount_minor::text as amount_minor, tax_portion_minor::text as tax_portion_minor, currency, provider, verification, livemode, attempt_id";

async function existingPayment(db: Queryable, orgId: string, input: { connectionId?: string | null; providerPaymentId?: string | null; idempotencyKey?: string | null }): Promise<PaymentRow | null> {
  if (input.connectionId && input.providerPaymentId) {
    const r = await db.query<PaymentRow>(`select ${PAYMENT_COLUMNS} from customer_payments where org_id = $1 and connection_id = $2 and provider_payment_id = $3`, [orgId, input.connectionId, input.providerPaymentId]);
    if (r.rows[0]) return r.rows[0];
  }
  if (input.idempotencyKey) {
    const r = await db.query<PaymentRow>(`select ${PAYMENT_COLUMNS} from customer_payments where org_id = $1 and idempotency_key = $2`, [orgId, input.idempotencyKey]);
    if (r.rows[0]) return r.rows[0];
  }
  return null;
}

export interface ApplyPaymentInput {
  orgId: string;
  invoiceId: string;
  amountMinor: number;
  currency: CurrencyCode;
  provider: PaymentProvider;
  /** provider_confirmed: the provider said so in a verified event, or an authenticated read. manual: a person recorded it. */
  verification: "provider_confirmed" | "manual";
  connectionId?: string | null;
  attemptId?: string | null;
  providerPaymentId?: string | null;
  /** false for a provider's test mode. A payment recorded by hand is a real-world record: true. */
  livemode: boolean;
  method?: string | null;
  receivedAt: Date;
  recordedBy?: string | null;
  evidence?: string | null;
  feeMinor?: number | null;
  idempotencyKey?: string | null;
  /** What the source says happened. Anything but succeeded is kept without being counted. */
  status?: "succeeded" | "pending" | "failed" | "needs_review";
  actor: { id: string | null; kind: InvoiceActorKind };
}

export interface ApplyPaymentResult {
  paymentId: string;
  /** The same payment (or the same request) was recorded before: nothing changed. */
  duplicate: boolean;
  status: PaymentRowStatus;
  /** The payment adds to the invoice's paid amount. */
  counted: boolean;
  /** Why a payment that said succeeded was kept for review instead. */
  reviewReason: "invoice_void" | "invoice_not_issued" | null;
  invoice: InvoiceTotals;
  /** This payment is the one that made the invoice paid in full. */
  justPaid: boolean;
}

/** Records a payment against an invoice, counts it when it succeeded and the invoice can take it, and keeps the invoice's paid amount and status in step. */
export async function applyPaymentInTx(db: Queryable, input: ApplyPaymentInput): Promise<ApplyPaymentResult> {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) throw new AppError("invalid_input", "A payment must be a whole number of minor units, more than zero.");
  const inv = await lockInvoice(db, input.orgId, input.invoiceId);
  if (inv.currency !== input.currency) throw new AppError("invalid_input", "That payment is in a different currency from the invoice, so it cannot be recorded against it.");

  const twin = await existingPayment(db, input.orgId, input);
  if (twin) {
    if (twin.invoice_id !== input.invoiceId) throw new AppError("conflict", "That payment was already recorded against a different invoice.");
    return { paymentId: twin.id, duplicate: true, status: twin.status, counted: isCounted(twin.status), reviewReason: null, invoice: totalsOf(inv), justPaid: false };
  }

  let status = input.status ?? "succeeded";
  let reviewReason: ApplyPaymentResult["reviewReason"] = null;
  if ((status === "succeeded" || status === "pending") && inv.status !== "issued") {
    reviewReason = inv.status === "void" ? "invoice_void" : "invoice_not_issued";
    status = "needs_review";
  }
  // The tax in this payment, in proportion to the invoice's tax, taken once from the part that settles the invoice (money beyond the balance is not tax).
  const applicable = Math.min(input.amountMinor, Math.max(inv.totalMinor - inv.paidMinor, 0));
  const taxPart = taxPortion(applicable, inv.taxMinor, inv.totalMinor);

  const ins = await db.query<{ id: string }>(
    `insert into customer_payments (org_id, invoice_id, connection_id, attempt_id, provider, provider_payment_id, amount_minor, fee_minor, tax_portion_minor, currency, livemode, verification,
       method, status, received_at, recorded_by, evidence, idempotency_key)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     on conflict do nothing returning id`,
    [input.orgId, input.invoiceId, input.connectionId ?? null, input.attemptId ?? null, input.provider, input.providerPaymentId ?? null, input.amountMinor, input.feeMinor ?? null, taxPart,
      input.currency, input.livemode, input.verification, input.method ?? null, status, input.receivedAt, input.recordedBy ?? null, input.evidence ?? null, input.idempotencyKey ?? null],
  );
  if (!ins.rows[0]) {
    const again = await existingPayment(db, input.orgId, input);
    if (!again) throw new AppError("conflict", "That payment could not be recorded. Try again.");
    return { paymentId: again.id, duplicate: true, status: again.status, counted: isCounted(again.status), reviewReason: null, invoice: totalsOf(inv), justPaid: false };
  }
  const paymentId = ins.rows[0].id;
  const detail = { paymentId, amount: toDecimalString(input.amountMinor, inv.currency), currency: inv.currency, provider: input.provider, method: input.method ?? null, livemode: input.livemode };
  const label = inv.number ?? "an invoice";

  if (status === "succeeded") {
    const after = await recomputeInvoice(db, input.orgId, input.invoiceId);
    const justPaid = inv.paymentStatus !== "paid" && after.paymentStatus === "paid";
    await addInvoiceEvent(db, input.orgId, input.invoiceId, input.provider === "manual" ? "manual_payment_recorded" : "payment_verified", input.actor, detail);
    await announcePaymentReceived(db, input.orgId, input.invoiceId, input.actor, { paymentId, amountMinor: input.amountMinor, verification: input.verification, livemode: input.livemode, attemptId: input.attemptId });
    if (justPaid) {
      await addInvoiceEvent(db, input.orgId, input.invoiceId, "paid", input.actor, { number: inv.number, paymentId });
      await notifyOrgRoles(db, input.orgId, ["owner", "admin"], {
        kind: "invoice_paid", severity: "success", title: `${label} was paid`, body: `${money(input.amountMinor, inv.currency)} received${input.verification === "manual" ? ", recorded by hand" : ""}.`,
        link: `/invoices/${input.invoiceId}`, dedupeKey: `invoice-paid:${input.invoiceId}`,
      });
      await announcePaid(db, input.orgId, input.invoiceId, input.actor, { paymentId, verification: input.verification });
      // Nothing more is owed: a reminder that has not gone out yet is withdrawn at once.
      await stopReminders(db, input.orgId, "paid", input.invoiceId);
    }
    if (after.overpaidMinor > Math.max(inv.paidMinor - inv.totalMinor, 0)) {
      await addInvoiceEvent(db, input.orgId, input.invoiceId, "overpaid", input.actor, { paymentId, overpaid: toDecimalString(after.overpaidMinor, inv.currency), currency: inv.currency });
      await notifyOrgRoles(db, input.orgId, ["owner", "admin"], {
        kind: "payment_review_needed", severity: "warning", title: `${label} was paid more than it was for`, body: `${money(after.overpaidMinor, inv.currency)} more than the invoice total was received. Nothing was refunded; decide what to do with the difference.`,
        link: `/invoices/${input.invoiceId}`, dedupeKey: `invoice-overpaid:${paymentId}`,
      });
    }
    return { paymentId, duplicate: false, status, counted: true, reviewReason, invoice: after, justPaid };
  }

  if (status === "needs_review") {
    await addInvoiceEvent(db, input.orgId, input.invoiceId, "payment_needs_review", input.actor, { ...detail, reason: reviewReason ?? "needs_review" });
    await notifyOrgRoles(db, input.orgId, ["owner", "admin"], {
      kind: "payment_review_needed", severity: "warning", title: `A payment for ${label} needs a look`,
      body: reviewReason === "invoice_void" ? `${money(input.amountMinor, inv.currency)} arrived for an invoice that was voided. It was not counted.` : `${money(input.amountMinor, inv.currency)} arrived and could not be matched to an invoice that can take it. It was not counted.`,
      link: `/invoices/${input.invoiceId}`, dedupeKey: `payment-review:${paymentId}`,
    });
  } else if (status === "failed") {
    await addInvoiceEvent(db, input.orgId, input.invoiceId, "payment_failed", input.actor, detail);
    await notifyOrgRoles(db, input.orgId, ["owner", "admin"], {
      kind: "invoice_payment_failed", severity: "warning", title: `A payment for ${label} failed`, body: `${money(input.amountMinor, inv.currency)} was attempted and did not go through. The invoice is still owed.`,
      link: `/invoices/${input.invoiceId}`, dedupeKey: `payment-failed:${paymentId}`,
    });
    await announcePaymentFailed(db, input.orgId, input.invoiceId, input.actor, { paymentId, attemptId: input.attemptId, amountMinor: input.amountMinor, livemode: input.livemode });
  }
  return { paymentId, duplicate: false, status, counted: false, reviewReason, invoice: totalsOf(inv), justPaid: false };
}

/**
 * Settles a payment that was waiting (pending, or kept for review): the provider confirmed it, a person resolved it, or it failed. Confirming one needs an issued invoice.
 * Settling a payment that is already settled changes nothing.
 */
export async function settlePaymentInTx(db: Queryable, input: { orgId: string; paymentId: string; to: "succeeded" | "failed" | "needs_review"; actor: { id: string | null; kind: InvoiceActorKind } }): Promise<{ status: PaymentRowStatus; invoice: InvoiceTotals; justPaid: boolean }> {
  const found = await db.query<{ invoice_id: string }>("select invoice_id from customer_payments where id = $1 and org_id = $2", [input.paymentId, input.orgId]);
  if (!found.rows[0]) throw new AppError("not_found", "That payment was not found.");
  const inv = await lockInvoice(db, input.orgId, found.rows[0].invoice_id);
  const pay = (await db.query<PaymentRow>(`select ${PAYMENT_COLUMNS} from customer_payments where id = $1 and org_id = $2 for update`, [input.paymentId, input.orgId])).rows[0];
  if (pay.status === input.to || !["pending", "needs_review"].includes(pay.status)) return { status: pay.status, invoice: totalsOf(inv), justPaid: false };
  if (input.to === "succeeded" && inv.status !== "issued") throw new AppError("conflict", inv.status === "void" ? "That invoice was voided, so this payment cannot be counted against it." : "That invoice has not been issued, so this payment cannot be counted against it.");
  await db.query("update customer_payments set status = $3 where id = $1 and org_id = $2", [input.paymentId, input.orgId, input.to]);
  const after = await recomputeInvoice(db, input.orgId, inv.id);
  const justPaid = inv.paymentStatus !== "paid" && after.paymentStatus === "paid";
  const amount = toMinor(pay.amount_minor);
  const detail = { paymentId: input.paymentId, amount: toDecimalString(amount, inv.currency), currency: inv.currency, provider: pay.provider };
  if (input.to === "succeeded") {
    await addInvoiceEvent(db, input.orgId, inv.id, pay.provider === "manual" ? "manual_payment_recorded" : "payment_verified", input.actor, detail);
    await announcePaymentReceived(db, input.orgId, inv.id, input.actor, { paymentId: input.paymentId, amountMinor: amount, verification: pay.verification, livemode: pay.livemode, attemptId: pay.attempt_id });
    if (justPaid) {
      await addInvoiceEvent(db, input.orgId, inv.id, "paid", input.actor, { number: inv.number, paymentId: input.paymentId });
      await notifyOrgRoles(db, input.orgId, ["owner", "admin"], { kind: "invoice_paid", severity: "success", title: `${inv.number ?? "An invoice"} was paid`, body: `${money(amount, inv.currency)} received.`, link: `/invoices/${inv.id}`, dedupeKey: `invoice-paid:${inv.id}` });
      await announcePaid(db, input.orgId, inv.id, input.actor, { paymentId: input.paymentId, verification: pay.verification });
      await stopReminders(db, input.orgId, "paid", inv.id);
    }
  } else if (input.to === "failed") {
    await addInvoiceEvent(db, input.orgId, inv.id, "payment_failed", input.actor, detail);
    await notifyOrgRoles(db, input.orgId, ["owner", "admin"], {
      kind: "invoice_payment_failed", severity: "warning", title: `A payment for ${inv.number ?? "an invoice"} failed`, body: `${money(amount, inv.currency)} was attempted and did not go through. The invoice is still owed.`,
      link: `/invoices/${inv.id}`, dedupeKey: `payment-failed:${input.paymentId}`,
    });
    await announcePaymentFailed(db, input.orgId, inv.id, input.actor, { paymentId: input.paymentId, attemptId: pay.attempt_id, amountMinor: amount, livemode: pay.livemode });
  }
  return { status: input.to, invoice: after, justPaid };
}

export interface ApplyRefundInput {
  orgId: string;
  paymentId: string;
  amountMinor: number;
  source: "provider_event" | "manual_record" | "chargeback" | "api_initiated";
  /** Defaults to succeeded: the money has been handed back (the business did it in the provider's dashboard, or the provider says it did). */
  status?: "pending" | "succeeded" | "failed";
  providerRefundId?: string | null;
  reason: string;
  recordedBy?: string | null;
  idempotencyKey?: string | null;
  actor: { id: string | null; kind: InvoiceActorKind };
}

export interface ApplyRefundResult {
  refundId: string;
  duplicate: boolean;
  paymentStatus: PaymentRowStatus;
  invoice: InvoiceTotals;
}

/**
 * Records a refund of a payment. A refund reduces what was kept (net revenue) and never re-opens the invoice or changes a deal: the paid amount stays, and the payment
 * becomes partly or fully refunded. It cannot be for more than is left of the payment.
 */
export async function applyRefundInTx(db: Queryable, input: ApplyRefundInput): Promise<ApplyRefundResult> {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) throw new AppError("invalid_input", "A refund must be more than zero.");
  const found = await db.query<{ invoice_id: string }>("select invoice_id from customer_payments where id = $1 and org_id = $2", [input.paymentId, input.orgId]);
  if (!found.rows[0]) throw new AppError("not_found", "That payment was not found.");
  const inv = await lockInvoice(db, input.orgId, found.rows[0].invoice_id);
  const pay = (await db.query<PaymentRow>(`select ${PAYMENT_COLUMNS} from customer_payments where id = $1 and org_id = $2 for update`, [input.paymentId, input.orgId])).rows[0];

  const twin = await db.query<{ id: string }>(
    `select id from customer_refunds where org_id = $1 and ((payment_id = $2 and provider_refund_id = $3) or idempotency_key = $4) limit 1`,
    [input.orgId, input.paymentId, input.providerRefundId ?? null, input.idempotencyKey ?? null],
  );
  if (twin.rows[0]) return { refundId: twin.rows[0].id, duplicate: true, paymentStatus: pay.status, invoice: totalsOf(inv) };

  const status = input.status ?? "succeeded";
  if (pay.status === "refunded") throw new AppError("conflict", "This payment was already refunded in full.");
  if (!["succeeded", "partially_refunded", "disputed"].includes(pay.status)) throw new AppError("conflict", "Only a payment that was received can be refunded.");
  const amount = toMinor(pay.amount_minor);
  const done = toMinor((await db.query<{ n: string }>("select coalesce(sum(amount_minor), 0)::text as n from customer_refunds where payment_id = $1 and org_id = $2 and status = 'succeeded'", [input.paymentId, input.orgId])).rows[0].n);
  const left = amount - done;
  if (status === "succeeded" && input.amountMinor > left) throw new AppError("conflict", `That is more than is left to refund on this payment (${money(left, inv.currency)}).`);
  const refundTax = taxPortion(Math.min(input.amountMinor, amount), toMinor(pay.tax_portion_minor), amount);

  const ins = await db.query<{ id: string }>(
    `insert into customer_refunds (org_id, payment_id, invoice_id, currency, amount_minor, tax_portion_minor, status, source, provider_refund_id, reason, recorded_by, idempotency_key)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) on conflict do nothing returning id`,
    [input.orgId, input.paymentId, inv.id, inv.currency, input.amountMinor, refundTax, status, input.source, input.providerRefundId ?? null, input.reason.trim().slice(0, 400), input.recordedBy ?? null, input.idempotencyKey ?? null],
  );
  if (!ins.rows[0]) {
    const again = await db.query<{ id: string }>(`select id from customer_refunds where org_id = $1 and ((payment_id = $2 and provider_refund_id = $3) or idempotency_key = $4) limit 1`, [input.orgId, input.paymentId, input.providerRefundId ?? null, input.idempotencyKey ?? null]);
    if (!again.rows[0]) throw new AppError("conflict", "That refund could not be recorded. Try again.");
    return { refundId: again.rows[0].id, duplicate: true, paymentStatus: pay.status, invoice: totalsOf(inv) };
  }
  let paymentStatus: PaymentRowStatus = pay.status;
  if (status === "succeeded") {
    // A payment under dispute stays disputed until the dispute is closed; otherwise it is partly or fully refunded now.
    if (pay.status !== "disputed") {
      paymentStatus = done + input.amountMinor >= amount ? "refunded" : "partially_refunded";
      if (paymentStatus !== pay.status) await db.query("update customer_payments set status = $3 where id = $1 and org_id = $2", [input.paymentId, input.orgId, paymentStatus]);
    }
  }
  const after = await recomputeInvoice(db, input.orgId, inv.id);
  await addInvoiceEvent(db, input.orgId, inv.id, "refund_recorded", input.actor, {
    refundId: ins.rows[0].id, paymentId: input.paymentId, amount: toDecimalString(input.amountMinor, inv.currency), currency: inv.currency, source: input.source, status,
  });
  if (status === "succeeded") {
    await notifyOrgRoles(db, input.orgId, ["owner", "admin"], {
      kind: "invoice_refund_recorded", title: `A refund was recorded on ${inv.number ?? "an invoice"}`, body: `${money(input.amountMinor, inv.currency)} refunded. The invoice stays paid; the refund reduces what you kept.`,
      link: `/invoices/${inv.id}`, dedupeKey: `invoice-refund:${ins.rows[0].id}`,
    });
    await announceRefunded(db, input.orgId, inv.id, input.actor, { refundId: ins.rows[0].id, paymentId: input.paymentId, amountMinor: input.amountMinor, livemode: pay.livemode });
  }
  return { refundId: ins.rows[0].id, duplicate: false, paymentStatus, invoice: after };
}

/**
 * Opens or closes a dispute (a chargeback claim) on a received payment. While one is open the invoice reads disputed and nothing about its deal changes; when it is
 * closed the payment goes back to what its refunds make it. Opening one twice, or closing one that is not open, changes nothing.
 */
export async function applyDisputeInTx(db: Queryable, input: { orgId: string; paymentId: string; open: boolean; actor: { id: string | null; kind: InvoiceActorKind } }): Promise<{ paymentStatus: PaymentRowStatus; changed: boolean; invoice: InvoiceTotals }> {
  const found = await db.query<{ invoice_id: string }>("select invoice_id from customer_payments where id = $1 and org_id = $2", [input.paymentId, input.orgId]);
  if (!found.rows[0]) throw new AppError("not_found", "That payment was not found.");
  const inv = await lockInvoice(db, input.orgId, found.rows[0].invoice_id);
  const pay = (await db.query<PaymentRow>(`select ${PAYMENT_COLUMNS} from customer_payments where id = $1 and org_id = $2 for update`, [input.paymentId, input.orgId])).rows[0];
  if (input.open) {
    if (pay.status === "disputed") return { paymentStatus: pay.status, changed: false, invoice: totalsOf(inv) };
    if (!["succeeded", "partially_refunded"].includes(pay.status)) throw new AppError("conflict", "Only a payment that was received and not fully refunded can be disputed.");
    await db.query("update customer_payments set status = 'disputed' where id = $1 and org_id = $2", [input.paymentId, input.orgId]);
  } else {
    if (pay.status !== "disputed") return { paymentStatus: pay.status, changed: false, invoice: totalsOf(inv) };
    const done = toMinor((await db.query<{ n: string }>("select coalesce(sum(amount_minor), 0)::text as n from customer_refunds where payment_id = $1 and org_id = $2 and status = 'succeeded'", [input.paymentId, input.orgId])).rows[0].n);
    const back: PaymentRowStatus = done >= toMinor(pay.amount_minor) ? "refunded" : done > 0 ? "partially_refunded" : "succeeded";
    await db.query("update customer_payments set status = $3 where id = $1 and org_id = $2", [input.paymentId, input.orgId, back]);
  }
  const after = await recomputeInvoice(db, input.orgId, inv.id);
  const status = (await db.query<{ status: PaymentRowStatus }>("select status from customer_payments where id = $1 and org_id = $2", [input.paymentId, input.orgId])).rows[0].status;
  await addInvoiceEvent(db, input.orgId, inv.id, input.open ? "dispute_opened" : "dispute_closed", input.actor, { paymentId: input.paymentId, amount: toDecimalString(toMinor(pay.amount_minor), inv.currency), currency: inv.currency });
  if (input.open) {
    // The customer has paid and is disputing it with their bank: asking them for the money again would be wrong, so reminders stop.
    await stopReminders(db, input.orgId, "disputed", inv.id);
    await notifyOrgRoles(db, input.orgId, ["owner", "admin"], {
      kind: "payment_review_needed", severity: "warning", title: `A payment for ${inv.number ?? "an invoice"} is disputed`, body: `The customer disputed ${money(toMinor(pay.amount_minor), inv.currency)} with their bank. Nothing about the deal changes while it is open.`,
      link: `/invoices/${inv.id}`, dedupeKey: `payment-dispute:${input.paymentId}`,
    });
  }
  return { paymentStatus: status, changed: true, invoice: after };
}
