import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import type { OrgContext } from "@/server/tenancy/context";
import { assertInvoicesAvailable } from "@/server/invoices/feature";
import { invoiceLinkUrl, invoiceTokenHashFor, tokenForStoredHash } from "@/server/invoices/links";
import { addInvoiceEvent } from "@/server/invoices/core";
import { withdrawInvoiceDeliveriesInTx } from "@/server/invoices/delivery";

// Handing the customer's link to a person on the team, and replacing it. The link is a bearer credential (whoever holds it can see the invoice and start a payment), so
// only those who may send invoices get it, each time it is shown is a line in the invoice's history and the audit trail (the link itself is in neither), and a new link
// kills the old one. Nothing here sends anything: copying the link into a message the business writes itself is the person's act. (Sending it through the consent-gated
// send chain is src/server/invoices/delivery.ts.)

interface LinkRow {
  status: "draft" | "pending_approval" | "issued" | "void";
  number: string | null;
  public_token_version: number;
  public_token_hash: string | null;
}

async function loadLinkRow(db: Queryable, orgId: string, id: string, lock: boolean): Promise<LinkRow> {
  const { rows } = await db.query<LinkRow>(`select status, number, public_token_version, public_token_hash from customer_invoices where id = $1 and org_id = $2${lock ? " for update" : ""}`, [id, orgId]);
  if (!rows[0]) throw new AppError("not_found", "That invoice was not found.");
  return rows[0];
}

/** The link to an issued invoice, for the business to give its customer. */
export async function getInvoiceLink(ctx: OrgContext, id: string): Promise<{ url: string }> {
  return withSystem(async (db) => {
    await assertInvoicesAvailable(db, ctx);
    if (!ctx.can("invoices.send")) throw new AppError("forbidden", "Only the business owner or a manager can get an invoice's link.");
    const row = await loadLinkRow(db, ctx.org.orgId, id, false);
    if (row.status !== "issued") throw new AppError("conflict", row.status === "void" ? "This invoice is void, so it has no link." : "An invoice has a link once it is issued.");
    const token = tokenForStoredHash(id, row.public_token_version, row.public_token_hash);
    if (!token) throw new AppError("conflict", "This invoice's link can no longer be shown. Make a new link.");
    await addInvoiceEvent(db, ctx.org.orgId, id, "link_shown", { id: ctx.user.id, kind: "user" }, { number: row.number });
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "invoice.link_shown", targetType: "customer_invoice", targetId: id, result: "success", metadata: { number: row.number } }, db);
    return { url: invoiceLinkUrl(token) };
  });
}

/** Replaces the customer's link. The old one stops working at once; the new one is shown with getInvoiceLink. */
export async function rotateInvoiceLink(ctx: OrgContext, id: string): Promise<void> {
  await withSystem(async (db) => {
    await assertInvoicesAvailable(db, ctx);
    if (!ctx.can("invoices.send")) throw new AppError("forbidden", "Only the business owner or a manager can replace an invoice's link.");
    const row = await loadLinkRow(db, ctx.org.orgId, id, true);
    if (row.status !== "issued") throw new AppError("conflict", row.status === "void" ? "This invoice is void, so it has no link." : "An invoice has a link once it is issued.");
    const version = row.public_token_version + 1;
    await db.query("update customer_invoices set public_token_version = $3, public_token_hash = $4 where id = $1 and org_id = $2", [id, ctx.org.orgId, version, invoiceTokenHashFor(id, version)]);
    await addInvoiceEvent(db, ctx.org.orgId, id, "link_rotated", { id: ctx.user.id, kind: "user" }, { number: row.number, linkVersion: version });
    // A message that has not gone out was about the old link: it is stopped, and the way to send the customer the new one is a new send.
    await withdrawInvoiceDeliveriesInTx(db, ctx.org.orgId, id, "invoice_link_replaced");
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "invoice.link_rotated", targetType: "customer_invoice", targetId: id, result: "success", metadata: { number: row.number, linkVersion: version } }, db);
  });
}
