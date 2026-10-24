import "server-only";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import type { OrgContext } from "@/server/tenancy/context";
import { assertInvoicesAvailable } from "@/server/invoices/feature";
import { loadInvoiceRow } from "@/server/invoices/core";

// Deleting a test invoice. A test invoice is made on purpose to try a payment account in test mode: nothing is owed on it and no money moved, so, unlike a real invoice (which is
// voided and keeps every payment and refund for good), it can be removed with everything it collected. The database allows these deletes only for an invoice marked as a test
// (migration 0093: the payment, refund and checkout guards look at the invoice), and only children first, as below.

export interface DeletedTestInvoice {
  number: string | null;
  payments: number;
  refunds: number;
  checkouts: number;
}

/** Deletes a test invoice with its test payments, refunds, checkouts, lines, history and the lines it left on the customer's timeline. Owner only. Audited. A real invoice is refused. */
export async function deleteTestInvoice(ctx: OrgContext, invoiceId: string): Promise<DeletedTestInvoice> {
  return withSystem(async (db) => {
    await assertInvoicesAvailable(db, ctx);
    if (!ctx.can("invoices.connect_payments")) throw new AppError("forbidden", "Only the business owner can delete a test invoice.");
    const row = await loadInvoiceRow(db, ctx.org.orgId, invoiceId, true);
    if (!row) throw new AppError("not_found", "That invoice was not found.");
    if (!row.is_test) throw new AppError("conflict", "Only a test invoice can be deleted. A real invoice is voided, and its payments and refunds are kept.");
    const refunds = (await db.query("delete from customer_refunds where invoice_id = $1 and org_id = $2", [invoiceId, ctx.org.orgId])).rowCount ?? 0;
    const payments = (await db.query("delete from customer_payments where invoice_id = $1 and org_id = $2", [invoiceId, ctx.org.orgId])).rowCount ?? 0;
    const checkouts = (await db.query("delete from customer_payment_attempts where invoice_id = $1 and org_id = $2", [invoiceId, ctx.org.orgId])).rowCount ?? 0;
    // What it left in the CRM: its lines on the customer's and the deal's timeline, and notices that link to it.
    await db.query("delete from crm_activities where org_id = $1 and ref_type = 'invoice' and ref_id = $2", [ctx.org.orgId, invoiceId]);
    await db.query("delete from notifications where org_id = $1 and link = $2", [ctx.org.orgId, `/invoices/${invoiceId}`]);
    // Its lines, history and reminder rows go with it.
    await db.query("delete from customer_invoices where id = $1 and org_id = $2 and is_test", [invoiceId, ctx.org.orgId]);
    await recordAudit({
      orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "invoice.test_deleted", targetType: "customer_invoice", targetId: invoiceId, result: "success",
      metadata: { number: row.number, status: row.status, payments, refunds, checkouts },
    }, db);
    return { number: row.number, payments, refunds, checkouts };
  });
}
