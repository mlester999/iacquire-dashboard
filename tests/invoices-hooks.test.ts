// How invoices follow a customer through the CRM's merge, a privacy request and the website chat's tidying of contacts it made.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { mergeCrmContacts } from "@/server/crm/contacts";
import { redactContact } from "@/server/messaging/contacts";
import { purgeExpiredWebChats } from "@/server/webchat/retention";
import { getInvoiceDetail, issueInvoice, listInvoices, voidInvoice } from "@/server/invoices/invoices";
import { setInvoicesEnabled } from "@/server/invoices/feature";
import { recordManualPayment } from "@/server/invoices/payments";
import { agencyUser, createUser } from "./support/fixtures";
import { answer, chatOrg, clientId, embedCall, hashOf, start } from "./support/webchat";
import { contactIn, draftBy, invoiceOrg, issuedInvoice, rows, submittedInvoice } from "./support/invoices";

const NOW = new Date("2026-10-23T12:00:00Z");

describe("merging two records of one customer", () => {
  it("moves every invoice to the record that stays, and leaves what each invoice said at issue as it was", async () => {
    const io = await invoiceOrg();
    const kept = await contactIn(io, { firstName: "Kept", lastName: "Record" });
    const merged = await contactIn(io, { firstName: "Merged", lastName: "Away" });
    const stranger = await contactIn(io, { firstName: "Not", lastName: "Merged" });
    const a = await issuedInvoice(io, { contactId: kept });
    const b = await issuedInvoice(io, { contactId: merged });
    const draft = await draftBy(io, "owner", { contactId: merged });
    const s = await issuedInvoice(io, { contactId: stranger });
    await mergeCrmContacts(io.c.actor("owner"), { keptId: kept, mergedId: merged, reason: "Same person, two records" });
    const mine = await listInvoices(io.ctx("owner"), { contactId: kept });
    expect(mine.map((i) => i.id).sort()).toEqual([a.invoice.id, b.invoice.id, draft.invoice.id].sort());
    expect(await listInvoices(io.ctx("owner"), { contactId: merged })).toEqual([]);
    expect((await listInvoices(io.ctx("owner"), { contactId: stranger })).map((i) => i.id)).toEqual([s.invoice.id]);
    // What the customer was shown does not follow the merge: the invoice still says what it said.
    expect((await getInvoiceDetail(io.ctx("owner"), b.invoice.id)).invoice.billTo).toMatchObject({ name: "Merged Away" });
    expect((await getInvoiceDetail(io.ctx("owner"), b.invoice.id)).invoice.contactName).toBeTruthy();
  });
});

describe("a privacy request for a customer", () => {
  it("deletes invoices that were never issued, blanks the customer's details on the rest and keeps the numbers, amounts and payments", async () => {
    const io = await invoiceOrg();
    const other = await invoiceOrg();
    const person = await contactIn(io, { firstName: "Erase", lastName: "Me" });
    const bystander = await contactIn(io, { firstName: "Keep", lastName: "Me" });
    const draft = await draftBy(io, "owner", { contactId: person });
    const waiting = await submittedInvoice(io, "sales", { contactId: person });
    const issued = await issuedInvoice(io, { contactId: person }, NOW);
    await recordManualPayment(io.ctx("owner"), issued.invoice.id, { amount: "500", receivedOn: "2026-10-23", method: "cash", evidence: "Cash, receipt 12" }, { now: NOW });
    const voided = await issuedInvoice(io, { contactId: person }, NOW);
    await voidInvoice(io.ctx("owner"), voided.invoice.id, { reason: "Raised for the wrong job" });
    const kept = await issuedInvoice(io, { contactId: bystander }, NOW);
    const foreign = await issuedInvoice(other, {}, NOW);

    await redactContact(io.ctx("owner"), person, "Privacy request received by email");

    expect(await rows("select 1 from customer_invoices where id = any($1::uuid[])", [[draft.invoice.id, waiting.invoice.id]])).toHaveLength(0);
    expect(await rows("select 1 from customer_invoice_lines where invoice_id = any($1::uuid[])", [[draft.invoice.id, waiting.invoice.id]])).toHaveLength(0);
    const after = await rows<{ id: string; contact_id: string | null; bill_to: Record<string, unknown>; number: string; total_minor: string; paid_minor: string; status: string }>(
      "select id, contact_id, bill_to, number, total_minor::text, paid_minor::text, status from customer_invoices where id = any($1::uuid[]) order by number", [[issued.invoice.id, voided.invoice.id]],
    );
    expect(after).toHaveLength(2);
    for (const r of after) expect(r).toMatchObject({ contact_id: null, bill_to: { erased: true } });
    expect(after.map((r) => [r.number, r.total_minor, r.paid_minor, r.status])).toEqual([["INV-0001", "150000", "50000", "issued"], ["INV-0002", "150000", "0", "void"]]);
    expect(await rows("select 1 from customer_payments where invoice_id = $1", [issued.invoice.id])).toHaveLength(1);
    const events = await rows<{ kind: string }>("select kind from customer_invoice_events where invoice_id = $1 and kind = 'customer_details_erased'", [issued.invoice.id]);
    expect(events).toHaveLength(1);
    const detail = (await getInvoiceDetail(io.ctx("owner"), issued.invoice.id)).invoice;
    expect(detail).toMatchObject({ contactId: null, contactName: null, billTo: { erased: true }, paidMinor: 50000 });
    // Nothing of the customer's name or address is left on those rows, or in what was recorded about them.
    expect(JSON.stringify(await rows("select bill_to, notes from customer_invoices where id = $1", [issued.invoice.id]))).not.toMatch(/Erase|Mango|Cebu/);
    expect(JSON.stringify(await rows("select detail from customer_invoice_events where invoice_id = $1", [issued.invoice.id]))).not.toMatch(/Erase|Mango|Cebu/);
    // Somebody else's invoices, in this workspace and in another, are untouched.
    expect((await getInvoiceDetail(io.ctx("owner"), kept.invoice.id)).invoice.billTo).toMatchObject({ name: "Keep Me" });
    expect((await getInvoiceDetail(other.ctx("owner"), foreign.invoice.id)).invoice.billTo).toMatchObject({ name: "Maria Santos" });
  });
});

describe("the website chat's tidying of contacts it made", () => {
  it("never deletes a contact that has an invoice, and still deletes an empty one in the same run", async () => {
    const c = await chatOrg({ anonymousRetentionDays: 1 });
    // The chat's workspace gets invoicing the way any workspace does.
    const superAdmin = agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
    await setInvoicesEnabled(superAdmin, c.m.org.id, true);
    const withInvoice = await start(c);
    const empty = await start(c);
    for (const t of [withInvoice, empty]) await embedCall(c, { action: "send", token: t, body: { text: "Just browsing", clientMessageId: clientId() }, generate: answer("Welcome!").generate });
    const contactOf = async (t: string) => (await rows<{ contact_id: string }>("select contact_id from web_chat_sessions where token_hash = $1", [hashOf(t)]))[0].contact_id;
    const billed = await contactOf(withInvoice);
    const nobody = await contactOf(empty);
    await withSystem((db) => db.query("insert into customer_invoices (org_id, contact_id, currency, created_by) values ($1, $2, 'PHP', $3)", [c.m.org.id, billed, c.m.people.owner.id]));
    await withSystem((db) => db.query("update web_chat_sessions set last_seen_at = now() - interval '5 days' where token_hash = any($1::text[])", [[hashOf(withInvoice), hashOf(empty)]]));
    await purgeExpiredWebChats();
    expect(await rows("select 1 from web_chat_sessions where token_hash = any($1::text[])", [[hashOf(withInvoice), hashOf(empty)]])).toHaveLength(0);
    expect(await rows("select 1 from contacts where id = $1", [billed])).toHaveLength(1);
    expect(await rows("select 1 from contacts where id = $1", [nobody])).toHaveLength(0);
    expect(await rows("select contact_id from customer_invoices where org_id = $1", [c.m.org.id])).toEqual([{ contact_id: billed }]);
  });
});

describe("a draft for a customer who is then erased", () => {
  it("goes with the customer, so there is nothing left to issue", async () => {
    const io = await invoiceOrg();
    const contactId = await contactIn(io);
    const d = await draftBy(io, "owner", { contactId });
    await redactContact(io.ctx("owner"), contactId, "Privacy request received by email");
    // The draft went with the customer, so there is nothing left to issue.
    await expect(issueInvoice(io.ctx("owner"), d.invoice.id, { version: 1 })).rejects.toThrow(/That invoice was not found/);
  });
});
