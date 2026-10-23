import "server-only";
import type { Queryable } from "@/server/db";

// A privacy request for one contact reaches their invoices here (called from redactContact in the same transaction).
//
//   * An invoice that was never issued (a draft, or one waiting for approval) was never a financial record: it goes, with its lines and history.
//   * An issued or void invoice is the business's financial record. Its number, amounts, dates and payments stay, because keeping them is the business's own legal
//     question and this product does not decide it. What identifies the person goes: the details frozen at issue are blanked (the database accepts only that one change
//     to them) and the link to the contact is cut. The invoice then reads as "customer details removed", and its revenue is unattributed.
//
// Free text the business typed on an issued invoice (notes, terms, payment instructions) is part of the frozen document and is left as written; if it names the person,
// that is for the business to decide with its adviser. This is recorded as an open question in the release notes.

export interface InvoiceErasureResult {
  discardedDrafts: number;
  blankedInvoices: number;
}

export async function eraseInvoiceCustomerDetails(db: Queryable, orgId: string, contactId: string): Promise<InvoiceErasureResult> {
  // A submitted invoice goes back to a draft first (the database allows that one step), then every unissued invoice of the contact is deleted.
  await db.query("update customer_invoices set status = 'draft' where org_id = $1 and contact_id = $2 and status = 'pending_approval'", [orgId, contactId]);
  const gone = await db.query("delete from customer_invoices where org_id = $1 and contact_id = $2 and status = 'draft' returning id", [orgId, contactId]);
  const blanked = await db.query<{ id: string }>(
    `update customer_invoices set bill_to = '{"erased": true}'::jsonb, contact_id = null where org_id = $1 and contact_id = $2 and status in ('issued', 'void') returning id`,
    [orgId, contactId],
  );
  for (const r of blanked.rows) {
    await db.query("insert into customer_invoice_events (org_id, invoice_id, kind, actor_kind, detail) values ($1, $2, 'customer_details_erased', 'system', '{}'::jsonb)", [orgId, r.id]);
  }
  // Nobody is left to remind: what was scheduled is cancelled. (A reminder already queued goes with the customer's messages, which the same erasure removes.)
  if (blanked.rows.length) {
    await db.query("update customer_invoice_reminders set status = 'cancelled', reason = 'no_customer' where org_id = $1 and invoice_id = any($2::uuid[]) and status = 'scheduled'", [orgId, blanked.rows.map((r) => r.id)]);
  }
  return { discardedDrafts: gone.rows.length, blankedInvoices: blanked.rows.length };
}
