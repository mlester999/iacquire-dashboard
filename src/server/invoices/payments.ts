import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import type { OrgContext } from "@/server/tenancy/context";
import type { Permission } from "@/lib/permissions";
import { formatMinor, parseAmount, toDecimalString } from "@/lib/money";
import { zonedToInstant } from "@/lib/calendars/slots";
import { isDay, todayIn } from "@/lib/invoices/state";
import { freeTextProblem } from "@/lib/invoices/guards";
import { manualPaymentSchema, refundSchema } from "@/lib/invoices/schemas";
import { assertInvoicesAvailable } from "@/server/invoices/feature";
import { applyPaymentInTx, applyRefundInTx, recomputeInvoice, type InvoiceTotals } from "@/server/invoices/apply";
import { runCloseRule, runRefundReview, type CloseRuleOutcome } from "@/server/invoices/close-rules";
import { asAppError, loadInvoiceRow, toMinor } from "@/server/invoices/core";

// Money a person tells the product about: a payment received outside it (a bank transfer, cash, a check), and a refund handed back (in the payment provider's own
// dashboard, or by hand). Both are the person's word, with their evidence or reason, audited, and neither is ever described as confirmed by a provider. Recording
// one never moves money: this release sends no refund to any provider.
//
// What the money does to the invoice is decided by src/server/invoices/apply.ts, not here.

const must = (ctx: OrgContext, permission: Permission, message: string) => {
  if (!ctx.can(permission)) throw new AppError("forbidden", message);
};

async function authorize(db: Queryable, ctx: OrgContext, permission: Permission, message: string) {
  await assertInvoicesAvailable(db, ctx);
  must(ctx, permission, message);
}

export interface ManualPaymentResult {
  paymentId: string;
  /** The same request had been recorded already: nothing changed. */
  duplicate: boolean;
  invoice: InvoiceTotals;
  justPaid: boolean;
  /** What the owner's close rule did about the linked deal, when this payment finished the invoice. */
  closeRule: CloseRuleOutcome | null;
}

/**
 * Records a payment the business received outside the product. It counts toward the invoice (and so turns it partly paid or paid), is kept as the person's own record
 * (not provider-verified) with the evidence they gave, and is never counted as verified revenue unless the owner chose that. Refused when it is more than is owed, unless
 * the person says it was, and when an online checkout for the invoice is open, unless they say to record it anyway: either could be the same money twice.
 */
export async function recordManualPayment(ctx: OrgContext, invoiceId: string, rawInput: unknown, deps: { now?: Date } = {}): Promise<ManualPaymentResult> {
  const input = manualPaymentSchema.parse(rawInput);
  const now = deps.now ?? new Date();
  const result = await withSystem(async (db) => {
    await authorize(db, ctx, "invoices.record_payment", "Only the business owner or a manager can record a payment.");
    const org = (await db.query<{ timezone: string }>("select timezone from organizations where id = $1", [ctx.org.orgId])).rows[0];
    const tz = org?.timezone ?? "UTC";
    const inv = await loadInvoiceRow(db, ctx.org.orgId, invoiceId, true);
    if (!inv) throw new AppError("not_found", "That invoice was not found.");
    if (inv.status !== "issued") throw new AppError("conflict", inv.status === "void" ? "This invoice is void, so no payment can be recorded against it." : "Only an issued invoice can take a payment. Issue it first.");

    if (input.idempotencyKey) {
      // Pressing the button twice, or a reloaded form, is the same payment: answer it from the first record before any other check can object to it.
      const twin = await db.query<{ id: string }>("select id from customer_payments where org_id = $1 and idempotency_key = $2 and invoice_id = $3", [ctx.org.orgId, input.idempotencyKey, invoiceId]);
      if (twin.rows[0]) return { paymentId: twin.rows[0].id, duplicate: true, invoice: await recomputeInvoice(db, ctx.org.orgId, invoiceId), justPaid: false, closeRuleNeeded: false };
    }

    const amount = asAppError(() => parseAmount(input.amount, inv.currency));
    if (amount <= 0) throw new AppError("invalid_input", "Enter an amount more than zero.");
    const balance = toMinor(inv.balance_minor);
    if (!input.allowOverpayment) {
      if (balance === 0) throw new AppError("conflict", "This invoice is already paid in full. If the customer paid more than was owed, record it as an overpayment.");
      if (amount > balance) throw new AppError("conflict", `That is more than is owed (${formatMinor(balance, inv.currency, "code")}). Record only what was received, or say it was more than the invoice.`);
    }
    if (!isDay(input.receivedOn)) throw new AppError("invalid_input", "Choose the day the payment was received.");
    const today = todayIn(now, tz);
    if (input.receivedOn > today) throw new AppError("invalid_input", "The payment date can't be in the future.");
    const problem = freeTextProblem("The evidence", input.evidence);
    if (problem) throw new AppError("invalid_input", problem);

    if (!input.overrideOpenAttempt) {
      const open = await db.query("select 1 from customer_payment_attempts where invoice_id = $1 and org_id = $2 and status in ('created', 'redirected')", [invoiceId, ctx.org.orgId]);
      if (open.rows[0]) throw new AppError("conflict", "A customer may be paying this invoice online right now. Wait for that to finish, or confirm that this is a different payment to record it anyway.");
    }
    const receivedAt = input.receivedOn === today ? now : new Date(zonedToInstant(input.receivedOn, 12 * 60, tz));
    const applied = await applyPaymentInTx(db, {
      orgId: ctx.org.orgId, invoiceId, amountMinor: amount, currency: inv.currency, provider: "manual", verification: "manual", livemode: true, method: input.method, receivedAt,
      recordedBy: ctx.user.id, evidence: input.evidence.trim(), idempotencyKey: input.idempotencyKey ?? null, actor: { id: ctx.user.id, kind: "user" },
    });
    if (!applied.duplicate) {
      await recordAudit({
        orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "invoice.payment_recorded", targetType: "customer_invoice", targetId: invoiceId, result: "success",
        metadata: { number: inv.number, paymentId: applied.paymentId, amount: toDecimalString(amount, inv.currency), currency: inv.currency, method: input.method, overpayment: Boolean(input.allowOverpayment) && amount > balance },
      }, db);
    }
    return { paymentId: applied.paymentId, duplicate: applied.duplicate, invoice: applied.invoice, justPaid: applied.justPaid, closeRuleNeeded: applied.counted && !applied.duplicate };
  });
  // The deal is the CRM's to change, in its own transaction, after the payment is safely recorded.
  const closeRule = result.closeRuleNeeded ? await runCloseRule(ctx.org.orgId, invoiceId) : null;
  return { paymentId: result.paymentId, duplicate: result.duplicate, invoice: result.invoice, justPaid: result.justPaid, closeRule };
}

export interface RefundResult {
  refundId: string;
  duplicate: boolean;
  invoice: InvoiceTotals;
  /** The task a refund after an automatic "won" asked for, if any. */
  reviewTaskId: string | null;
}

/**
 * Records that part or all of a payment was handed back. This release moves no money: the business refunds in its payment provider's own dashboard (or hands cash
 * back) and records it here. A refund reduces what was kept; it never re-opens the invoice, and it never changes a deal: if the deal was marked won by this invoice,
 * a task asks its owner to take another look.
 */
export async function recordRefund(ctx: OrgContext, paymentId: string, rawInput: unknown): Promise<RefundResult> {
  const input = refundSchema.parse(rawInput);
  const result = await withSystem(async (db) => {
    await authorize(db, ctx, "invoices.refund", "Only the business owner can record a refund.");
    const pay = (await db.query<{ invoice_id: string; currency: string }>("select invoice_id, currency from customer_payments where id = $1 and org_id = $2", [paymentId, ctx.org.orgId])).rows[0];
    if (!pay) throw new AppError("not_found", "That payment was not found.");
    const inv = await loadInvoiceRow(db, ctx.org.orgId, pay.invoice_id);
    if (!inv) throw new AppError("not_found", "That invoice was not found.");
    const amount = asAppError(() => parseAmount(input.amount, inv.currency));
    if (amount <= 0) throw new AppError("invalid_input", "Enter an amount more than zero.");
    const problem = freeTextProblem("The reason", input.reason);
    if (problem) throw new AppError("invalid_input", problem);
    const applied = await applyRefundInTx(db, {
      orgId: ctx.org.orgId, paymentId, amountMinor: amount, source: "manual_record", reason: input.reason, recordedBy: ctx.user.id, idempotencyKey: input.idempotencyKey ?? null,
      actor: { id: ctx.user.id, kind: "user" },
    });
    if (!applied.duplicate) {
      await recordAudit({
        orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "invoice.refund_recorded", targetType: "customer_invoice", targetId: inv.id, result: "success",
        metadata: { number: inv.number, paymentId, refundId: applied.refundId, amount: toDecimalString(amount, inv.currency), currency: inv.currency },
      }, db);
    }
    return { applied, invoiceId: inv.id };
  });
  const review = result.applied.duplicate ? null : await runRefundReview(ctx.org.orgId, result.invoiceId, result.applied.refundId);
  return { refundId: result.applied.refundId, duplicate: result.applied.duplicate, invoice: result.applied.invoice, reviewTaskId: review?.taskId ?? null };
}
