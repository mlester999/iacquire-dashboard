import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import type { OrgContext } from "@/server/tenancy/context";
import { formatMinor, parseAmount, toDecimalString, type CurrencyCode } from "@/lib/money";
import { freeTextProblem } from "@/lib/invoices/guards";
import { disputeOpenSchema, disputeResultSchema } from "@/lib/invoices/schemas";
import { assertInvoicesAvailable } from "@/server/invoices/feature";
import { applyDisputeInTx, type InvoiceTotals, type PaymentRowStatus } from "@/server/invoices/apply";
import { runRefundReview } from "@/server/invoices/close-rules";
import { asAppError, loadInvoiceRow, toMinor } from "@/server/invoices/core";

// Disputes the owner records by hand. A payment provider tells this product about a dispute itself (a PayPal dispute, a reversed capture), but not every provider does, and a
// reversal that is never followed by a resolution would leave the payment held for ever. The owner can open a dispute on a payment the provider confirmed, and close one with how
// it ended: won, or lost with what the buyer got back. It is the owner's word, audited, and the books follow it through the same code a provider's event goes through
// (src/server/invoices/apply.ts), so a lost dispute becomes a chargeback refund exactly as it does when the provider says so.

const NOT_OWNER = "Only the business owner can record a dispute.";

export interface DisputeRecordResult {
  paymentStatus: PaymentRowStatus;
  invoice: InvoiceTotals;
  /** The task a chargeback after an automatic "won" asked for, if any. */
  reviewTaskId: string | null;
}

interface Target {
  invoiceId: string;
  number: string | null;
  currency: CurrencyCode;
  amountMinor: number;
  refundedMinor: number;
  status: PaymentRowStatus;
}

/** The payment, if it is this workspace's and a provider confirmed it: a payment somebody recorded by hand has no provider to dispute it with. */
async function targetOf(db: Queryable, ctx: OrgContext, paymentId: string): Promise<Target> {
  const pay = (await db.query<{ invoice_id: string; verification: string; status: PaymentRowStatus; amount_minor: string }>(
    "select invoice_id, verification, status, amount_minor::text as amount_minor from customer_payments where id = $1 and org_id = $2", [paymentId, ctx.org.orgId],
  )).rows[0];
  if (!pay) throw new AppError("not_found", "That payment was not found.");
  if (pay.verification !== "provider_confirmed") throw new AppError("conflict", "A dispute can only be recorded on a payment your payment provider confirmed. A payment you recorded by hand has no provider to dispute it with.");
  const inv = await loadInvoiceRow(db, ctx.org.orgId, pay.invoice_id);
  if (!inv) throw new AppError("not_found", "That invoice was not found.");
  if (inv.is_test) throw new AppError("conflict", "This is a test invoice: no money moved, so nobody can dispute it. Void or delete the test invoice instead.");
  const refunded =(await db.query<{ n: string }>("select coalesce(sum(amount_minor), 0)::text as n from customer_refunds where payment_id = $1 and org_id = $2 and status = 'succeeded'", [paymentId, ctx.org.orgId])).rows[0].n;
  return { invoiceId: inv.id, number: inv.number, currency: inv.currency, amountMinor: toMinor(pay.amount_minor), refundedMinor: toMinor(refunded), status: pay.status };
}

/** Records that the customer disputed a payment with their bank, for a dispute this product was not told about. Reminders stop and the payment is held out of revenue until the result is recorded. */
export async function recordDisputeOpened(ctx: OrgContext, paymentId: string, rawInput: unknown): Promise<DisputeRecordResult> {
  const input = disputeOpenSchema.parse(rawInput);
  return withSystem(async (db) => {
    await assertInvoicesAvailable(db, ctx);
    if (!ctx.can("invoices.refund")) throw new AppError("forbidden", NOT_OWNER);
    const t = await targetOf(db, ctx, paymentId);
    const problem = freeTextProblem("The note", input.note);
    if (problem) throw new AppError("invalid_input", problem);
    if (t.status === "disputed") throw new AppError("conflict", "This payment is already under dispute.");
    const r = await applyDisputeInTx(db, { orgId: ctx.org.orgId, paymentId, open: true, actor: { id: ctx.user.id, kind: "user" } });
    await recordAudit({
      orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "invoice.dispute_opened", targetType: "customer_invoice", targetId: t.invoiceId, result: "success",
      metadata: { number: t.number, paymentId, amount: toDecimalString(t.amountMinor, t.currency), currency: t.currency, ...(input.note?.trim() ? { note: input.note.trim() } : {}) },
    }, db);
    return { paymentStatus: r.paymentStatus, invoice: r.invoice, reviewTaskId: null };
  });
}

/** Records how a dispute ended: won, or lost with what the buyer got back (never more than is left of the payment). A lost dispute becomes a chargeback refund. */
export async function recordDisputeResult(ctx: OrgContext, paymentId: string, rawInput: unknown): Promise<DisputeRecordResult> {
  const input = disputeResultSchema.parse(rawInput);
  const done = await withSystem(async (db) => {
    await assertInvoicesAvailable(db, ctx);
    if (!ctx.can("invoices.refund")) throw new AppError("forbidden", NOT_OWNER);
    const t = await targetOf(db, ctx, paymentId);
    const problem = freeTextProblem("The note", input.note);
    if (problem) throw new AppError("invalid_input", problem);
    if (t.status !== "disputed") throw new AppError("conflict", "This payment is not under dispute, so there is no result to record. The page may be out of date.");
    let lostMinor: number | null = null;
    if (input.outcome === "lost") {
      lostMinor = asAppError(() => parseAmount(input.amount ?? "", t.currency));
      if (lostMinor <= 0) throw new AppError("invalid_input", "Enter how much the buyer got back, more than zero.");
      const left = t.amountMinor - t.refundedMinor;
      if (lostMinor > left) throw new AppError("conflict", `That is more than is left of this payment (${formatMinor(left, t.currency, "code")}).`);
    }
    const r = await applyDisputeInTx(db, { orgId: ctx.org.orgId, paymentId, open: false, outcome: input.outcome, lostMinor, actor: { id: ctx.user.id, kind: "user" } });
    await recordAudit({
      orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "invoice.dispute_closed", targetType: "customer_invoice", targetId: t.invoiceId, result: "success",
      metadata: {
        number: t.number, paymentId, outcome: input.outcome, currency: t.currency, ...(input.outcome === "lost" ? { lost: toDecimalString(r.chargebackMinor, t.currency) } : {}),
        ...(r.chargebackRefundId ? { refundId: r.chargebackRefundId } : {}), ...(input.note?.trim() ? { note: input.note.trim() } : {}),
      },
    }, db);
    return { r, invoiceId: t.invoiceId };
  });
  // A chargeback after the deal was marked won asks a person to look at the deal again, the same as any refund.
  const review = done.r.chargebackRefundId ? await runRefundReview(ctx.org.orgId, done.invoiceId, done.r.chargebackRefundId) : null;
  return { paymentStatus: done.r.paymentStatus, invoice: done.r.invoice, reviewTaskId: review?.taskId ?? null };
}
