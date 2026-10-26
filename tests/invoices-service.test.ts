// Drafting, approving, issuing, voiding and writing off invoices on embedded Postgres: who may do what, what an approval covers, what is frozen, and what another
// workspace can never see or change.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { createDraft, discardDraft, getInvoiceDetail, issueInvoice, listInvoices, receivablesSummary, requestChanges, submitForApproval, updateDraft, voidInvoice, withdrawFromApproval, writeOffInvoice } from "@/server/invoices/invoices";
import { getInvoiceSettings, saveInvoiceSettings } from "@/server/invoices/settings";
import { recordManualPayment } from "@/server/invoices/payments";
import { getInvoiceLink, rotateInvoiceLink } from "@/server/invoices/share";
import { assertInvoicesAvailable, invoicesEnabled, setInvoicesEnabled } from "@/server/invoices/feature";
import { invoiceTokenFor, tokenIsFor } from "@/server/invoices/links";
import { invoiceContentHash } from "@/lib/invoices/hash";
import { connectionFor, contactIn, dealFor, draftBy, invoiceOrg, issuedInvoice, line, providerPayment, rows, submittedInvoice, uniqueEmail } from "./support/invoices";
import { createContact } from "@/server/crm/contacts";
import { createOpportunity } from "@/server/crm/opportunities";
import { agencyUser, createOrg, createUser } from "./support/fixtures";

const NOW = new Date("2026-10-23T12:00:00Z");
const notes = (orgId: string, kind: string) => rows<{ user_id: string; title: string; body: string | null }>("select user_id, title, body from notifications where org_id = $1 and kind = $2", [orgId, kind]);

describe("who may do what", () => {
  it("lets the owner, manager and sales rep write invoices and nobody else", async () => {
    const io = await invoiceOrg();
    const contactId = await contactIn(io);
    for (const who of ["owner", "manager", "sales"] as const) {
      const d = await createDraft(io.ctx(who), { contactId, currency: "PHP", lines: [line()] });
      expect(d.invoice.status).toBe("draft");
    }
    for (const who of ["viewer", "support", "setter", "member"] as const) {
      await expect(createDraft(io.ctx(who), { contactId, lines: [line()] }), who).rejects.toThrow(/can't write invoices/);
      await expect(listInvoices(io.ctx(who)), who).rejects.toThrow(/can't see invoices/);
    }
  });

  it("lets only the writer or a manager change a draft, and only a manager review or issue a sales rep's invoice", async () => {
    const io = await invoiceOrg();
    const d = await draftBy(io, "owner");
    // A sales rep did not write it and cannot approve: not theirs to change.
    await expect(updateDraft(io.ctx("sales"), d.invoice.id, { notes: "mine now" }, d.invoice.version)).rejects.toThrow(/person who wrote/);
    await expect(discardDraft(io.ctx("sales"), d.invoice.id)).rejects.toThrow(/person who wrote/);
    const edited = await updateDraft(io.ctx("manager"), d.invoice.id, { notes: "Manager's note" }, d.invoice.version);
    expect(edited.invoice.notes).toBe("Manager's note");
    const sub = await submittedInvoice(io, "sales");
    await expect(issueInvoice(io.ctx("sales"), sub.invoice.id, { version: sub.invoice.version })).rejects.toThrow(/needs the owner's or a manager's approval/);
    await expect(requestChanges(io.ctx("sales"), sub.invoice.id, { version: sub.invoice.version, note: "Please fix" })).rejects.toThrow(/owner or a manager/);
    await expect(issueInvoice(io.ctx("viewer"), sub.invoice.id, { version: sub.invoice.version })).rejects.toThrow(/owner or a manager can approve/);
    await expect(issueInvoice(io.ctx("support"), sub.invoice.id, { version: sub.invoice.version })).rejects.toThrow(/owner or a manager can approve/);
    await expect(voidInvoice(io.ctx("sales"), sub.invoice.id, { reason: "not allowed" })).rejects.toThrow(/owner or a manager can void/);
  });

  it("lets a sales rep issue their own draft only when the owner switched approval off for creators, and never an invoice a workflow made", async () => {
    const io = await invoiceOrg();
    const own = await draftBy(io, "sales");
    await expect(issueInvoice(io.ctx("sales"), own.invoice.id, { version: own.invoice.version })).rejects.toThrow(/needs the owner's or a manager's approval/);
    await saveInvoiceSettings(io.ctx("owner"), { approvalRequiredForCreators: false }, 0);
    const issued = await issueInvoice(io.ctx("sales"), own.invoice.id, { version: own.invoice.version }, { now: NOW });
    expect(issued.detail.invoice.status).toBe("issued");
    // Somebody else's draft is still not theirs to issue, and a workflow-made one needs an approver whatever the setting says.
    const others = await draftBy(io, "owner");
    await expect(issueInvoice(io.ctx("sales"), others.invoice.id, { version: others.invoice.version })).rejects.toThrow(/needs the owner's or a manager's approval/);
    const workflowContact = await contactIn(io);
    const made = await withSystem(async (db) => {
      const inv = (await db.query<{ id: string }>(
        "insert into customer_invoices (org_id, contact_id, currency, subtotal_minor, tax_minor, total_minor, created_by, created_via) values ($1, $2, 'PHP', 100000, 0, 100000, $3, 'workflow') returning id",
        [io.orgId, workflowContact, io.c.people.sales.id],
      )).rows[0].id;
      await db.query(
        `insert into customer_invoice_lines (org_id, invoice_id, position, description, quantity_milli, unit_price_minor, gross_minor, discount_minor, net_minor, tax_minor, total_minor, ex_tax_minor)
         values ($1, $2, 1, 'Made by a workflow', 1000, 100000, 100000, 0, 100000, 0, 100000, 100000)`, [io.orgId, inv],
      );
      return inv;
    });
    await expect(issueInvoice(io.ctx("sales"), made, { version: 1 })).rejects.toThrow(/needs the owner's or a manager's approval/);
    // An approver can issue it, and the history says a workflow made it.
    await expect(issueInvoice(io.ctx("owner"), made, { version: 1 }, { now: NOW })).resolves.toMatchObject({ detail: { invoice: { createdVia: "workflow", status: "issued" } } });
  });
});

describe("drafts and lines", () => {
  it("builds the totals from the lines with integer arithmetic: exclusive tax, inclusive tax, discounts and a zero-decimal currency", async () => {
    const io = await invoiceOrg();
    const contactId = await contactIn(io);
    const exclusive = await createDraft(io.ctx("owner"), { contactId, currency: "PHP", lines: [line({ unitPrice: "1000.00", taxPercent: "12" })] });
    expect(exclusive.invoice).toMatchObject({ subtotalMinor: 100000, taxMinor: 12000, totalMinor: 112000, currency: "PHP" });
    const inclusive = await createDraft(io.ctx("owner"), { contactId, currency: "PHP", taxInclusive: true, lines: [line({ unitPrice: "1120.00", taxPercent: "12" })] });
    expect(inclusive.invoice).toMatchObject({ subtotalMinor: 100000, taxMinor: 12000, totalMinor: 112000 });
    const mixed = await createDraft(io.ctx("owner"), { contactId, currency: "USD", lines: [line({ quantity: "2.5", unitPrice: "19.99", discountPercent: "10" }), line({ description: "Parts", unitPrice: "0.10", quantity: "3" }), line({ description: "Goodwill", unitPrice: "100", discountAmount: "25.50", taxPercent: "7.25" })] });
    expect(mixed.lines.map((l) => l.totalMinor)).toEqual([4498, 30, 7450 + Math.round((7450 * 725) / 10000)]);
    expect(mixed.invoice.totalMinor).toBe(mixed.lines.reduce((a, l) => a + l.totalMinor, 0));
    const yen = await createDraft(io.ctx("owner"), { contactId, currency: "JPY", lines: [line({ unitPrice: "1500", quantity: "3" })] });
    expect(yen.invoice.totalMinor).toBe(4500);
    // Nothing a person types as a fraction of a yen is accepted.
    await expect(createDraft(io.ctx("owner"), { contactId, currency: "JPY", lines: [line({ unitPrice: "1500.50" })] })).rejects.toThrow(/Line 1/);
  });

  it("fills in the workspace's currency and payment instructions, and records who wrote it and how", async () => {
    const io = await invoiceOrg();
    await saveInvoiceSettings(io.ctx("owner"), { defaultCurrency: "EUR", defaultPaymentInstructions: "Pay by bank transfer to the account on file." }, 0);
    const d = await createDraft(io.ctx("sales"), { contactId: await contactIn(io), lines: [line()] });
    expect(d.invoice).toMatchObject({ currency: "EUR", paymentInstructions: "Pay by bank transfer to the account on file.", createdVia: "manual", status: "draft", version: 1, number: null });
    const ev = await rows<{ kind: string; actor_id: string }>("select kind, actor_id from customer_invoice_events where invoice_id = $1", [d.invoice.id]);
    expect(ev).toHaveLength(1);
    expect(ev[0].kind).toBe("created");
    expect(ev[0].actor_id).toBe(io.c.people.sales.id);
  });

  it("refuses a customer, company or deal that is not this workspace's, a deal of a different customer, and a removed customer", async () => {
    const a = await invoiceOrg();
    const b = await invoiceOrg();
    const aContact = await contactIn(a);
    const bContact = await contactIn(b);
    const bDeal = await dealFor(b, bContact);
    await expect(createDraft(a.ctx("owner"), { contactId: bContact, lines: [line()] })).rejects.toThrow(/customer was not found/);
    await expect(createDraft(a.ctx("owner"), { contactId: aContact, opportunityId: bDeal, lines: [line()] })).rejects.toThrow(/deal was not found/);
    const bCompany = (await withSystem((db) => db.query<{ id: string }>("insert into crm_companies (org_id, name) values ($1, 'Other Co') returning id", [b.orgId]))).rows[0].id;
    await expect(createDraft(a.ctx("owner"), { contactId: aContact, companyId: bCompany, lines: [line()] })).rejects.toThrow(/company was not found/);
    const other = await contactIn(a);
    const aDeal = await dealFor(a, aContact);
    await expect(createDraft(a.ctx("owner"), { contactId: other, opportunityId: aDeal, lines: [line()] })).rejects.toThrow(/different customer/);
    // A deal brings its customer along.
    const fromDeal = await createDraft(a.ctx("owner"), { opportunityId: aDeal, lines: [line()] }, { via: "deal" });
    expect(fromDeal.invoice).toMatchObject({ contactId: aContact, opportunityId: aDeal, createdVia: "deal" });
    await withSystem((db) => db.query("update contacts set deleted_at = now() where id = $1", [other]));
    await expect(createDraft(a.ctx("owner"), { contactId: other, lines: [line()] })).rejects.toThrow(/customer was not found/);
  });

  it("makes one invoice for one idempotency key, even when two requests arrive together", async () => {
    const io = await invoiceOrg();
    const contactId = await contactIn(io);
    const key = `key-${Math.random().toString(36).slice(2)}`;
    const [x, y] = await Promise.all([createDraft(io.ctx("owner"), { contactId, lines: [line()], idempotencyKey: key }), createDraft(io.ctx("owner"), { contactId, lines: [line()], idempotencyKey: key })]);
    expect(x.invoice.id).toBe(y.invoice.id);
    const again = await createDraft(io.ctx("owner"), { contactId, lines: [line({ unitPrice: "9999" })], idempotencyKey: key });
    expect(again.invoice.id).toBe(x.invoice.id);
    expect(again.invoice.totalMinor).toBe(150000);
    expect(await rows("select 1 from customer_invoices where org_id = $1 and idempotency_key = $2", [io.orgId, key])).toHaveLength(1);
    expect(await rows("select 1 from customer_invoice_events where invoice_id = $1 and kind = 'created'", [x.invoice.id])).toHaveLength(1);
  });

  it("bumps the version on a real change only, refuses a stale edit, and needs the lines again when the currency changes", async () => {
    const io = await invoiceOrg();
    const d = await draftBy(io, "owner");
    const same = await updateDraft(io.ctx("owner"), d.invoice.id, { notes: null, lines: [line()] }, 1);
    expect(same.invoice.version).toBe(1);
    const changed = await updateDraft(io.ctx("owner"), d.invoice.id, { lines: [line({ unitPrice: "2000" })], dueOn: "2026-12-31" }, 1);
    expect(changed.invoice).toMatchObject({ version: 2, totalMinor: 200000, dueOn: "2026-12-31" });
    await expect(updateDraft(io.ctx("owner"), d.invoice.id, { notes: "late" }, 1)).rejects.toThrow(/Someone changed this invoice/);
    await expect(updateDraft(io.ctx("owner"), d.invoice.id, { currency: "JPY" }, 2)).rejects.toThrow(/entering the lines again/);
    const yen = await updateDraft(io.ctx("owner"), d.invoice.id, { currency: "JPY", lines: [line({ unitPrice: "2000" })] }, 2);
    expect(yen.invoice).toMatchObject({ currency: "JPY", totalMinor: 2000, version: 3 });
    // Switching to tax-inclusive re-reads the same typed prices under the new rule.
    const inc = await updateDraft(io.ctx("owner"), d.invoice.id, { taxInclusive: true, lines: [line({ unitPrice: "1120", taxPercent: "12" })] }, 3);
    expect(inc.invoice).toMatchObject({ totalMinor: 1120, taxMinor: 120, taxInclusive: true });
    const back = await updateDraft(io.ctx("owner"), d.invoice.id, { taxInclusive: false }, 4);
    expect(back.invoice).toMatchObject({ totalMinor: 1254, taxMinor: 134 });
    const ev = await rows<{ kind: string; detail: { changed?: string[] } }>("select kind, detail from customer_invoice_events where invoice_id = $1 and kind = 'edited' order by id", [d.invoice.id]);
    expect(ev[0].detail.changed).toEqual(expect.arrayContaining(["lines", "due_on"]));
  });

  it("refuses card numbers and keys in any free text, and a customer typed with a bad email", async () => {
    const io = await invoiceOrg();
    const contactId = await contactIn(io);
    await expect(createDraft(io.ctx("owner"), { contactId, lines: [line({ description: "Pay with 4242 4242 4242 4242" })] })).rejects.toThrow(/card number/);
    await expect(createDraft(io.ctx("owner"), { contactId, lines: [line()], notes: "card 5555-5555-5555-4444 exp 12/30" })).rejects.toThrow(/card number/);
    await expect(createDraft(io.ctx("owner"), { contactId, lines: [line()], paymentInstructions: "api key sk_live_abcdefghijklmnop1234" })).rejects.toThrow(/key|password|token/i);
    await expect(createDraft(io.ctx("owner"), { contactId, lines: [line()], billTo: { email: "not-an-email" } })).rejects.toThrow(/email/i);
    // Ordinary numbers are fine: a bank account, a phone number, an order reference.
    await expect(createDraft(io.ctx("owner"), { contactId, lines: [line({ description: "Order 2026-1023-0007" })], paymentInstructions: "BDO account 0012 3456 7890, Atlas Plumbing" })).resolves.toBeTruthy();
  });

  it("discards a draft with its lines and history, and refuses to discard anything that left draft", async () => {
    const io = await invoiceOrg();
    const d = await draftBy(io, "owner");
    await discardDraft(io.ctx("owner"), d.invoice.id);
    expect(await rows("select 1 from customer_invoices where id = $1", [d.invoice.id])).toHaveLength(0);
    expect(await rows("select 1 from customer_invoice_lines where invoice_id = $1", [d.invoice.id])).toHaveLength(0);
    expect(await rows("select 1 from customer_invoice_events where invoice_id = $1", [d.invoice.id])).toHaveLength(0);
    const sub = await submittedInvoice(io, "owner");
    await expect(discardDraft(io.ctx("owner"), sub.invoice.id)).rejects.toThrow(/back to a draft/);
    const issued = await issuedInvoice(io);
    await expect(discardDraft(io.ctx("owner"), issued.invoice.id)).rejects.toThrow(/voided instead/);
  });
});

describe("approval is of one version", () => {
  it("is asked for with a notice to the owner and manager, refuses what could not be issued, and can be taken back", async () => {
    const io = await invoiceOrg();
    const noCustomer = await draftBy(io, "sales", { contactId: null });
    await expect(submitForApproval(io.ctx("sales"), noCustomer.invoice.id, 1)).rejects.toThrow(/Choose the customer/);
    const noLines = await draftBy(io, "sales", { lines: [] });
    await expect(submitForApproval(io.ctx("sales"), noLines.invoice.id, 1)).rejects.toThrow(/Add at least one line/);
    const zero = await draftBy(io, "sales", { lines: [line({ unitPrice: "0" })] });
    await expect(submitForApproval(io.ctx("sales"), zero.invoice.id, 1)).rejects.toThrow(/more than zero/);
    const gone = await contactIn(io);
    const goneDraft = await draftBy(io, "sales", { contactId: gone });
    await withSystem((db) => db.query("update contacts set deleted_at = now() where id = $1", [gone]));
    await expect(submitForApproval(io.ctx("sales"), goneDraft.invoice.id, 1)).rejects.toThrow(/Choose the customer/);
    await expect(issueInvoice(io.ctx("owner"), goneDraft.invoice.id, { version: 1 })).rejects.toThrow(/Choose the customer/);
    const d = await draftBy(io, "sales");
    await expect(submitForApproval(io.ctx("sales"), d.invoice.id, 7)).rejects.toThrow(/Someone changed this invoice/);
    const pending = await submitForApproval(io.ctx("sales"), d.invoice.id, 1);
    expect(pending.invoice.status).toBe("pending_approval");
    const asked = await notes(io.orgId, "invoice_approval_requested");
    expect(asked.map((n) => n.user_id).sort()).toEqual([io.c.people.owner.id, io.c.people.manager.id].sort());
    expect(asked[0].title).not.toMatch(/Maria|Santos/);
    // It cannot be edited while it waits, and cannot be submitted twice.
    await expect(updateDraft(io.ctx("sales"), d.invoice.id, { notes: "x" }, 1)).rejects.toThrow(/sent for approval/);
    await expect(submitForApproval(io.ctx("sales"), d.invoice.id, 1)).rejects.toThrow(/already waiting/);
    const back = await withdrawFromApproval(io.ctx("sales"), d.invoice.id);
    expect(back.invoice).toMatchObject({ status: "draft", version: 1 });
    await expect(withdrawFromApproval(io.ctx("sales"), d.invoice.id)).rejects.toThrow(/not waiting/);
  });

  it("is of the version the reviewer read: a change after submitting voids the reading, and changes are asked for with a note the writer is told", async () => {
    const io = await invoiceOrg();
    const sub = await submittedInvoice(io, "sales");
    await expect(requestChanges(io.ctx("manager"), sub.invoice.id, { version: sub.invoice.version, note: "" })).rejects.toThrow(/Say what should change/);
    await expect(requestChanges(io.ctx("manager"), sub.invoice.id, { version: 99, note: "Add the parts" })).rejects.toThrow(/changed while you were reviewing/);
    const back = await requestChanges(io.ctx("manager"), sub.invoice.id, { version: sub.invoice.version, note: "Add the parts" });
    expect(back.invoice.status).toBe("draft");
    const told = await notes(io.orgId, "invoice_approval_decided");
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ user_id: io.c.people.sales.id, body: "Add the parts" });
    const edited = await updateDraft(io.ctx("sales"), sub.invoice.id, { lines: [line(), line({ description: "Parts", unitPrice: "200" })] }, back.invoice.version);
    expect(edited.invoice.version).toBe(sub.invoice.version + 1);
    const again = await submitForApproval(io.ctx("sales"), sub.invoice.id, edited.invoice.version);
    // The reviewer who opened the earlier version cannot approve the new one by naming the old one.
    await expect(issueInvoice(io.ctx("owner"), sub.invoice.id, { version: sub.invoice.version })).rejects.toThrow(/changed while you were reviewing/);
    const issued = await issueInvoice(io.ctx("owner"), sub.invoice.id, { version: again.invoice.version }, { now: NOW });
    expect(issued.detail.invoice).toMatchObject({ status: "issued", approvedVersion: again.invoice.version, totalMinor: 170000 });
    expect(issued.detail.invoice.approvedByName).toBeTruthy();
    const kinds = (await rows<{ kind: string }>("select kind from customer_invoice_events where invoice_id = $1 order by id", [sub.invoice.id])).map((e) => e.kind);
    expect(kinds).toEqual(["created", "submitted", "changes_requested", "edited", "submitted", "approved", "issued"]);
    const author = await notes(io.orgId, "invoice_approval_decided");
    expect(author.map((n) => n.title)).toEqual(expect.arrayContaining(["Your invoice was approved and issued"]));
  });
});

describe("issuing", () => {
  it("takes the number from the workspace's counter, freezes the customer's and the business's details, and fixes a content hash that can be recomputed", async () => {
    const io = await invoiceOrg();
    await saveInvoiceSettings(io.ctx("owner"), { legalName: "Atlas Plumbing and Heating", addressLines: ["1 Harbor Road", "Cebu City"], taxLabel: "VAT", taxId: "123-456-789", replyToEmail: "billing@atlas.example.test", paymentTermsDays: 30 }, 0);
    const email = uniqueEmail();
    const contactId = await contactIn(io, { email, firstName: "Maria", lastName: "Santos" });
    const d = await draftBy(io, "owner", { contactId, notes: "Thank you.", billTo: { company: "Santos Bakery", taxId: "TIN 555" } });
    const out = await issueInvoice(io.ctx("owner"), d.invoice.id, { version: d.invoice.version }, { now: NOW });
    expect(out.number).toBe("INV-0001");
    const inv = out.detail.invoice;
    expect(inv).toMatchObject({ status: "issued", number: "INV-0001", issueOn: "2026-10-23", dueOn: "2026-11-22", paymentStatus: "unpaid", balanceMinor: 150000, paidMinor: 0 });
    expect(inv.billFrom).toMatchObject({ name: "Atlas Plumbing and Heating", addressLines: ["1 Harbor Road", "Cebu City"], taxLabel: "VAT", taxId: "123-456-789", replyToEmail: "billing@atlas.example.test" });
    expect(inv.billTo).toMatchObject({ name: "Maria Santos", company: "Santos Bakery", email, taxId: "TIN 555" });
    expect((inv.billTo as { addressLines: string[] }).addressLines).toEqual(["12 Mango Street", "Cebu, Cebu 6000", "PH"]);
    // Later edits to the contact and the settings do not reach the issued invoice.
    await withSystem((db) => db.query("update contacts set display_name = 'Someone Else', email = null where id = $1", [contactId]));
    await saveInvoiceSettings(io.ctx("owner"), { legalName: "New Name Ltd" }, 1);
    const reread = (await getInvoiceDetail(io.ctx("owner"), d.invoice.id)).invoice;
    expect(reread.billTo).toMatchObject({ name: "Maria Santos", email });
    expect(reread.billFrom).toMatchObject({ name: "Atlas Plumbing and Heating" });
    // The hash covers what a customer is shown, and can be recomputed from the stored rows.
    const stored = (await rows<{ content_hash: string }>("select content_hash from customer_invoices where id = $1", [d.invoice.id]))[0].content_hash;
    const detail = await getInvoiceDetail(io.ctx("owner"), d.invoice.id);
    const recomputed = invoiceContentHash({
      number: "INV-0001", currency: "PHP", taxInclusive: false, issueOn: "2026-10-23", dueOn: "2026-11-22", billFrom: detail.invoice.billFrom, billTo: detail.invoice.billTo,
      lines: detail.lines.map((l) => ({ position: l.position, description: l.description, quantityMilli: l.quantityMilli, unitPriceMinor: l.unitPriceMinor, discountBps: l.discountBps, taxRateBps: l.taxRateBps, grossMinor: l.grossMinor, discountMinor: l.discountMinor, netMinor: l.netMinor, taxMinor: l.taxMinor, totalMinor: l.totalMinor, exTaxMinor: l.exTaxMinor })),
      subtotalMinor: detail.invoice.subtotalMinor, taxMinor: detail.invoice.taxMinor, totalMinor: detail.invoice.totalMinor, paymentInstructions: detail.invoice.paymentInstructions, notes: "Thank you.", terms: null,
    });
    expect(stored).toBe(recomputed);
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
  });

  it("derives the customer's link from the invoice, stores only its hash, and never shows the hash or the link in a view", async () => {
    const io = await invoiceOrg();
    const issued = await issuedInvoice(io);
    const stored = (await rows<{ public_token_hash: string; public_token_version: number }>("select public_token_hash, public_token_version from customer_invoices where id = $1", [issued.invoice.id]))[0];
    const token = invoiceTokenFor(issued.invoice.id, stored.public_token_version);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenIsFor(token, issued.invoice.id, stored.public_token_version, stored.public_token_hash)).toBe(true);
    expect(tokenIsFor(token, issued.invoice.id, stored.public_token_version + 1, stored.public_token_hash)).toBe(false);
    const other = await issuedInvoice(io);
    expect(tokenIsFor(token, other.invoice.id, 1, stored.public_token_hash)).toBe(false);
    const json = JSON.stringify(await getInvoiceDetail(io.ctx("owner"), issued.invoice.id));
    expect(json).not.toContain(token);
    expect(json).not.toContain(stored.public_token_hash);
    // And none of it is in the history or the audit trail.
    expect(JSON.stringify(await rows("select detail from customer_invoice_events where invoice_id = $1", [issued.invoice.id]))).not.toContain(token);
    expect(JSON.stringify(await rows("select metadata from audit_logs where target_id = $1", [issued.invoice.id]))).not.toContain(token);
  });

  it("gives out consecutive numbers per workspace, never the same one twice even when invoices are issued together, and never reuses a voided one", async () => {
    const io = await invoiceOrg();
    const other = await invoiceOrg();
    const drafts = [];
    for (let i = 0; i < 6; i += 1) drafts.push(await draftBy(io, "owner"));
    const issued = await Promise.all(drafts.map((d) => issueInvoice(io.ctx("owner"), d.invoice.id, { version: d.invoice.version }, { now: NOW })));
    expect(issued.map((i) => i.number).sort()).toEqual(["INV-0001", "INV-0002", "INV-0003", "INV-0004", "INV-0005", "INV-0006"]);
    expect((await issuedInvoice(other)).invoice.number).toBe("INV-0001");
    const victim = issued[2];
    await voidInvoice(io.ctx("owner"), victim.detail.invoice.id, { reason: "Raised by mistake" });
    const next = await issuedInvoice(io);
    expect(next.invoice.number).toBe("INV-0007");
    expect((await rows<{ number: string }>("select number from customer_invoices where id = $1", [victim.detail.invoice.id]))[0].number).toBe(victim.number);
  });

  it("uses the owner's prefix and next number, allows raising the number and never lowering it", async () => {
    const io = await invoiceOrg();
    await expect(saveInvoiceSettings(io.ctx("owner"), { numberPrefix: "BAD PREFIX!" }, 0)).rejects.toThrow(/prefix/);
    await saveInvoiceSettings(io.ctx("owner"), { numberPrefix: "AT-2026-", nextNumber: 1001 }, 0);
    expect((await issuedInvoice(io)).invoice.number).toBe("AT-2026-1001");
    await expect(saveInvoiceSettings(io.ctx("owner"), { nextNumber: 5 }, 1)).rejects.toThrow(/raised but not lowered/);
    await saveInvoiceSettings(io.ctx("owner"), { nextNumber: 2000 }, 1);
    expect((await issuedInvoice(io)).invoice.number).toBe("AT-2026-2000");
  });

  it("keeps a first save working after an invoice was issued with no settings", async () => {
    const io = await invoiceOrg();
    expect((await issuedInvoice(io)).invoice.number).toBe("INV-0001");
    const settings = await getInvoiceSettings(io.ctx("owner"));
    expect(settings).toMatchObject({ version: 0, nextNumber: 2 });
    const saved = await saveInvoiceSettings(io.ctx("owner"), { legalName: "Late Setup Co" }, settings.version);
    expect(saved).toMatchObject({ version: 1, legalName: "Late Setup Co", nextNumber: 2 });
  });

  it("works out the due date from the terms, keeps one the writer chose, and refuses one before the issue date", async () => {
    const io = await invoiceOrg();
    const terms = await issuedInvoice(io, {}, NOW);
    expect(terms.invoice.dueOn).toBe("2026-11-06");
    const chosen = await issuedInvoice(io, { dueOn: "2026-12-24" }, NOW);
    expect(chosen.invoice.dueOn).toBe("2026-12-24");
    const stale = await draftBy(io, "owner", { dueOn: "2026-10-01" });
    await expect(issueInvoice(io.ctx("owner"), stale.invoice.id, { version: 1 }, { now: NOW })).rejects.toThrow(/before the day the invoice would be issued/);
  });

  it("issues in the workspace's own day: a business in Manila issues on its date, not the server's", async () => {
    const io = await invoiceOrg({ timezone: "Asia/Manila" });
    const late = new Date("2026-10-23T18:30:00Z"); // 02:30 on the 24th in Manila
    const inv = await issuedInvoice(io, {}, late);
    expect(inv.invoice.issueOn).toBe("2026-10-24");
  });

  it("records the issue in the audit trail without the customer's details", async () => {
    const io = await invoiceOrg();
    const inv = (await issuedInvoice(io, {}, NOW)).invoice;
    const audit = await rows<{ action: string; metadata: Record<string, unknown> }>("select action, metadata from audit_logs where target_id = $1 and action = 'invoice.issued'", [inv.id]);
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({ number: "INV-0001", currency: "PHP", total: "1500.00" });
    expect(JSON.stringify(audit[0].metadata)).not.toMatch(/Maria|Santos|@example|\+1555/);
  });
});

describe("void and write-off", () => {
  it("voids an issued invoice that took no money: it keeps its number, its link stops working and its reminders are cancelled", async () => {
    const io = await invoiceOrg();
    const inv = (await issuedInvoice(io)).invoice;
    await withSystem((db) => db.query("insert into customer_invoice_reminders (org_id, invoice_id, step_key, due_at) values ($1, $2, 'on_due:0', now() + interval '3 days')", [io.orgId, inv.id]));
    await expect(voidInvoice(io.ctx("owner"), inv.id, { reason: "x" })).rejects.toThrow();
    const out = await voidInvoice(io.ctx("manager"), inv.id, { reason: "Raised for the wrong customer" });
    expect(out.invoice).toMatchObject({ status: "void", number: inv.number, voidReason: "Raised for the wrong customer" });
    const row = (await rows<{ public_token_hash: string | null }>("select public_token_hash from customer_invoices where id = $1", [inv.id]))[0];
    expect(row.public_token_hash).toBeNull();
    expect((await rows<{ status: string; reason: string }>("select status, reason from customer_invoice_reminders where invoice_id = $1", [inv.id]))[0]).toMatchObject({ status: "cancelled", reason: "invoice_voided" });
    await expect(voidInvoice(io.ctx("owner"), inv.id, { reason: "Again please" })).rejects.toThrow(/already void/);
    await expect(issueInvoice(io.ctx("owner"), inv.id, { version: 1 })).rejects.toThrow(/void invoice cannot be issued/);
  });

  it("refuses to void an invoice with a payment, a pending or unreviewed payment, or an open checkout, and a draft", async () => {
    const io = await invoiceOrg();
    const conn = await connectionFor(io);
    const paid = (await issuedInvoice(io)).invoice;
    await providerPayment(io, paid.id, conn, 1000);
    await expect(voidInvoice(io.ctx("owner"), paid.id, { reason: "Wrong customer" })).rejects.toThrow(/payment recorded against it/);
    const waiting = (await issuedInvoice(io)).invoice;
    await providerPayment(io, waiting.id, conn, 1000, { status: "pending" });
    await expect(voidInvoice(io.ctx("owner"), waiting.id, { reason: "Wrong customer" })).rejects.toThrow(/may be paying this invoice, or a payment is waiting/);
    const checkout = (await issuedInvoice(io)).invoice;
    await withSystem((db) => db.query("insert into customer_payment_attempts (org_id, invoice_id, connection_id, currency, amount_minor, reference, status) values ($1, $2, $3, 'PHP', 150000, 'CP-' || substr(md5(random()::text), 1, 24), 'redirected')", [io.orgId, checkout.id, conn]));
    await expect(voidInvoice(io.ctx("owner"), checkout.id, { reason: "Wrong customer" })).rejects.toThrow(/may be paying this invoice/);
    const draft = await draftBy(io, "owner");
    await expect(voidInvoice(io.ctx("owner"), draft.invoice.id, { reason: "Wrong customer" })).rejects.toThrow(/Only an issued invoice can be voided/);
  });

  it("writes off what is owed: owner only, with a reason, once, and it is not a payment", async () => {
    const io = await invoiceOrg();
    const conn = await connectionFor(io);
    const inv = (await issuedInvoice(io)).invoice;
    await providerPayment(io, inv.id, conn, 50000);
    await expect(writeOffInvoice(io.ctx("manager"), inv.id, { reason: "Customer closed down" })).rejects.toThrow(/Only the business owner/);
    await expect(writeOffInvoice(io.ctx("owner"), inv.id, { reason: "no" })).rejects.toThrow(/reason/);
    const out = await writeOffInvoice(io.ctx("owner"), inv.id, { reason: "Customer closed down" });
    expect(out.invoice).toMatchObject({ writeOffReason: "Customer closed down", paidMinor: 50000, balanceMinor: 100000, paymentStatus: "partially_paid" });
    expect(out.invoice.writtenOffAt).toBeTruthy();
    await expect(writeOffInvoice(io.ctx("owner"), inv.id, { reason: "Customer closed down" })).rejects.toThrow(/already written off/);
    // A write-off is not revenue: nothing was received, and the overdue list no longer chases it.
    const list = await listInvoices(io.ctx("owner"), { overdueOnly: true }, { now: new Date("2027-03-01T00:00:00Z") });
    expect(list.map((i) => i.id)).not.toContain(inv.id);
    const paidFull = (await issuedInvoice(io)).invoice;
    await providerPayment(io, paidFull.id, conn, 150000);
    await expect(writeOffInvoice(io.ctx("owner"), paidFull.id, { reason: "Nothing is owed" })).rejects.toThrow(/Nothing is owed/);
    const draft = await draftBy(io, "owner");
    await expect(writeOffInvoice(io.ctx("owner"), draft.invoice.id, { reason: "Not issued yet" })).rejects.toThrow(/Only an issued invoice/);
  });
});

describe("the feature switch", () => {
  it("is off until a Super Admin turns it on, and then only that workspace has it", async () => {
    const off = await invoiceOrg({ enabled: false });
    const contactId = await contactIn(off);
    const attempt = createDraft(off.ctx("owner"), { contactId, lines: [line()] });
    await expect(attempt).rejects.toBeInstanceOf(AppError);
    await expect(attempt).rejects.toMatchObject({ code: "not_enabled" });
    await expect(listInvoices(off.ctx("owner"))).rejects.toMatchObject({ code: "not_enabled" });
    await expect(getInvoiceSettings(off.ctx("owner"))).resolves.toBeTruthy();
    await expect(saveInvoiceSettings(off.ctx("owner"), { legalName: "x" }, 0)).rejects.toMatchObject({ code: "not_enabled" });
    expect(await invoicesEnabled(off.orgId)).toBe(false);
    await expect(setInvoicesEnabled({ id: off.c.people.owner.id, platformRole: "none" }, off.orgId, true)).rejects.toThrow(/Only a Super Admin/);
    await expect(setInvoicesEnabled(agencyUser(await createUser({ platformRole: "agency_manager" }), "agency_manager"), off.orgId, true)).rejects.toThrow(/Only a Super Admin/);
    await setInvoicesEnabled(off.superAdmin, off.orgId, true);
    expect(await invoicesEnabled(off.orgId)).toBe(true);
    await expect(createDraft(off.ctx("owner"), { contactId, lines: [line()] })).resolves.toBeTruthy();
    const audit = await rows("select 1 from audit_logs where org_id = $1 and action = 'invoices.enabled' and actor_user_id = $2", [off.orgId, off.superAdmin.id]);
    expect(audit).toHaveLength(1);
    // Another workspace is untouched.
    const other = await invoiceOrg({ enabled: false });
    expect(await invoicesEnabled(other.orgId)).toBe(false);
    await setInvoicesEnabled(off.superAdmin, off.orgId, false);
    await expect(listInvoices(off.ctx("owner"))).rejects.toMatchObject({ code: "not_enabled" });
  });

  it("is a client workspace's: an agency workspace is refused, and cannot be switched on", async () => {
    const io = await invoiceOrg();
    const agencyCtx = { ...io.ctx("owner"), org: { ...io.ctx("owner").org, kind: "agency" as const } };
    await expect(withSystem((db) => assertInvoicesAvailable(db, agencyCtx))).rejects.toThrow(/client's own workspace/);
    const agency = (await withSystem((db) => db.query<{ id: string }>("select id from organizations where kind = 'agency' limit 1"))).rows[0]?.id ?? (await createOrg({ kind: "agency", name: "Agency Invoices Co" })).id;
    await expect(setInvoicesEnabled(io.superAdmin, agency, true)).rejects.toThrow(/client's own workspace/);
  });
});

describe("invoice settings", () => {
  it("are the owner's, versioned, validated, and cannot switch reminders on", async () => {
    const io = await invoiceOrg();
    await expect(saveInvoiceSettings(io.ctx("manager"), { legalName: "x" }, 0)).rejects.toThrow(/Only the business owner/);
    const saved = await saveInvoiceSettings(io.ctx("owner"), { legalName: "  Atlas   Plumbing ", reminderOffsetsDays: [10, -3, 0, 3], reminderMax: 4, closeRule: "task", countManualAsVerified: true, remindersEnabled: true } as never, 0);
    expect(saved).toMatchObject({ legalName: "Atlas Plumbing", reminderOffsetsDays: [-3, 0, 3, 10], closeRule: "task", countManualAsVerified: true, remindersEnabled: false, version: 1 });
    await expect(saveInvoiceSettings(io.ctx("owner"), { legalName: "again" }, 0)).rejects.toThrow(/Someone else changed/);
    await expect(saveInvoiceSettings(io.ctx("owner"), { reminderOffsetsDays: [-3, 0, 3], reminderMax: 2 }, 1)).rejects.toThrow(/at most 2/);
    await expect(saveInvoiceSettings(io.ctx("owner"), { reminderOffsetsDays: [99] }, 1)).rejects.toThrow(/days/);
    await expect(saveInvoiceSettings(io.ctx("owner"), { footerNote: "pay to sk_live_abcdefghijklmnop1234" }, 1)).rejects.toThrow(/key|password|token/i);
    await expect(saveInvoiceSettings(io.ctx("owner"), { closeRule: "everything" as never }, 1)).rejects.toThrow();
    // Two saves with the same version cannot both win.
    const results = await Promise.allSettled([saveInvoiceSettings(io.ctx("owner"), { paymentTermsDays: 7 }, 1), saveInvoiceSettings(io.ctx("owner"), { paymentTermsDays: 9 }, 1)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const audit = await rows("select 1 from audit_logs where org_id = $1 and action = 'invoices.settings_saved'", [io.orgId]);
    expect(audit.length).toBeGreaterThanOrEqual(2);
    // Everybody who can see invoices can read the settings; nobody else can.
    await expect(getInvoiceSettings(io.ctx("sales"))).resolves.toMatchObject({ legalName: "Atlas Plumbing" });
    await expect(getInvoiceSettings(io.ctx("viewer"))).rejects.toThrow(/can't see invoices/);
  });
});

describe("reading", () => {
  it("lists, filters and searches within the workspace, and shows overdue by the workspace's own day", async () => {
    const io = await invoiceOrg({ timezone: "Asia/Manila" });
    const issuedOn = new Date("2026-10-01T00:00:00Z");
    const late = await issuedInvoice(io, { dueOn: "2026-10-23", contactId: await contactIn(io, { firstName: "Late", lastName: "Payer" }) }, issuedOn);
    const fine = await issuedInvoice(io, { dueOn: "2026-12-01" }, issuedOn);
    const draft = await draftBy(io, "owner");
    const manilaMorning = new Date("2026-10-23T16:30:00Z"); // 00:30 on the 24th in Manila, still the 23rd in UTC
    const all = await listInvoices(io.ctx("owner"), {}, { now: manilaMorning });
    expect(all.map((i) => i.id).sort()).toEqual([late.invoice.id, fine.invoice.id, draft.invoice.id].sort());
    expect(all.find((i) => i.id === late.invoice.id)).toMatchObject({ overdue: true, daysOverdue: 1 });
    expect(all.find((i) => i.id === fine.invoice.id)).toMatchObject({ overdue: false, daysOverdue: 0 });
    expect((await listInvoices(io.ctx("owner"), { overdueOnly: true }, { now: manilaMorning })).map((i) => i.id)).toEqual([late.invoice.id]);
    // The same instant is still the 23rd in UTC: not overdue there.
    const utc = await invoiceOrg();
    const same = await issuedInvoice(utc, { dueOn: "2026-10-23" }, issuedOn);
    expect((await listInvoices(utc.ctx("owner"), { overdueOnly: true }, { now: manilaMorning })).map((i) => i.id)).toEqual([]);
    expect((await listInvoices(utc.ctx("owner"), {}, { now: manilaMorning }))[0].id).toBe(same.invoice.id);
    expect((await listInvoices(io.ctx("owner"), { status: ["draft"] })).map((i) => i.id)).toEqual([draft.invoice.id]);
    expect((await listInvoices(io.ctx("owner"), { search: "payer" })).map((i) => i.id)).toEqual([late.invoice.id]);
    expect((await listInvoices(io.ctx("owner"), { search: "INV-0002" })).map((i) => i.id)).toEqual([fine.invoice.id]);
    expect(await listInvoices(io.ctx("owner"), { search: "100%_" })).toEqual([]);
  });

  it("adds receivables per currency and never across currencies", async () => {
    const io = await invoiceOrg();
    const conn = await connectionFor(io);
    const usd = await issuedInvoice(io, { currency: "USD", lines: [line({ unitPrice: "200" })] }, NOW);
    await issuedInvoice(io, { currency: "PHP", lines: [line({ unitPrice: "1000" })] }, NOW);
    await issuedInvoice(io, { currency: "PHP", lines: [line({ unitPrice: "500" })], dueOn: "2026-10-24" }, NOW);
    await providerPayment(io, usd.invoice.id, conn, 5000, { currency: "USD", livemode: true });
    // A test invoice, paid in a provider's test mode, is in none of it: nothing is owed on a test, and no money moved.
    const test = await issuedInvoice(io, { isTest: true, currency: "USD", lines: [line({ unitPrice: "100" })] }, NOW);
    await providerPayment(io, test.invoice.id, conn, 2500, { currency: "USD" });
    await draftBy(io, "owner");
    await submittedInvoice(io, "sales");
    const s = await receivablesSummary(io.ctx("owner"), { now: new Date("2026-11-30T00:00:00Z") });
    expect(s.byCurrency.map((r) => r.currency)).toEqual(["PHP", "USD"]);
    expect(s.byCurrency[0]).toMatchObject({ currency: "PHP", outstandingMinor: 150000, overdueMinor: 150000, openCount: 2, overdueCount: 2, netReceivedMinor: 0 });
    expect(s.byCurrency[1]).toMatchObject({ currency: "USD", outstandingMinor: 15000, openCount: 1, netReceivedMinor: 5000 });
    expect(s).toMatchObject({ drafts: 1, pendingApproval: 1, testInvoices: 1 });
    const early = await receivablesSummary(io.ctx("owner"), { now: new Date("2026-10-23T00:00:00Z") });
    expect(early.byCurrency[0]).toMatchObject({ currency: "PHP", overdueMinor: 0, overdueCount: 0 });
  });

  it("shows the whole story of an invoice to those who may see it, and nothing of another workspace's", async () => {
    const a = await invoiceOrg();
    const b = await invoiceOrg();
    const inv = (await issuedInvoice(a)).invoice;
    const detail = await getInvoiceDetail(a.ctx("sales"), inv.id);
    expect(detail.invoice.id).toBe(inv.id);
    expect(detail.lines).toHaveLength(1);
    expect(detail.events.map((e) => e.kind)).toEqual(["created", "issued"]);
    expect(detail.events[0].actorName).toBeTruthy();
    expect(detail).toMatchObject({ payments: [], refunds: [], reminders: [], closeRule: "none" });
    await expect(getInvoiceDetail(b.ctx("owner"), inv.id)).rejects.toThrow(/not found/);
    await expect(getInvoiceDetail(a.ctx("viewer"), inv.id)).rejects.toThrow(/can't see invoices/);
    // Every write is refused for an id from another workspace, with the same words as for one that does not exist.
    const ghost = "00000000-0000-4000-8000-000000000000";
    for (const call of [
      () => updateDraft(b.ctx("owner"), inv.id, { notes: "x" }, 1),
      () => submitForApproval(b.ctx("owner"), inv.id, 1),
      () => issueInvoice(b.ctx("owner"), inv.id, { version: 1 }),
      () => voidInvoice(b.ctx("owner"), inv.id, { reason: "Not yours to void" }),
      () => writeOffInvoice(b.ctx("owner"), inv.id, { reason: "Not yours to write off" }),
      () => discardDraft(b.ctx("owner"), inv.id),
    ]) {
      await expect(call()).rejects.toThrow(/That invoice was not found/);
    }
    await expect(issueInvoice(a.ctx("owner"), ghost, { version: 1 })).rejects.toThrow(/That invoice was not found/);
    // The invoice is as it was.
    expect((await getInvoiceDetail(a.ctx("owner"), inv.id)).invoice).toMatchObject({ status: "issued", version: 1, notes: null });
  });
});

describe("the customer's link", () => {
  const stored = async (id: string) => (await rows<{ public_token_hash: string | null; public_token_version: number }>("select public_token_hash, public_token_version from customer_invoices where id = $1", [id]))[0];

  it("is given to those who may send invoices, recorded without being written down, and replaced on request, which kills the old one", async () => {
    const io = await invoiceOrg();
    const inv = (await issuedInvoice(io)).invoice;
    for (const who of ["sales", "viewer", "support"] as const) await expect(getInvoiceLink(io.ctx(who), inv.id), who).rejects.toThrow(/Only the business owner or a manager/);
    const { url } = await getInvoiceLink(io.ctx("manager"), inv.id);
    expect(url).toMatch(/\/pay\/[A-Za-z0-9_-]{43}$/);
    const token = url.split("/pay/")[1];
    const first = await stored(inv.id);
    expect(tokenIsFor(token, inv.id, first.public_token_version, first.public_token_hash)).toBe(true);
    expect((await getInvoiceLink(io.ctx("owner"), inv.id)).url).toBe(url);
    // Each time it was shown is a line in the history and the audit trail; the link itself is in neither.
    expect((await rows("select 1 from customer_invoice_events where invoice_id = $1 and kind = 'link_shown'", [inv.id]))).toHaveLength(2);
    expect((await rows("select 1 from audit_logs where target_id = $1 and action = 'invoice.link_shown'", [inv.id]))).toHaveLength(2);
    expect(JSON.stringify(await rows("select detail from customer_invoice_events where invoice_id = $1", [inv.id]))).not.toContain(token);
    expect(JSON.stringify(await rows("select metadata from audit_logs where target_id = $1", [inv.id]))).not.toContain(token);
    await expect(rotateInvoiceLink(io.ctx("sales"), inv.id)).rejects.toThrow(/Only the business owner or a manager/);
    await rotateInvoiceLink(io.ctx("manager"), inv.id);
    const second = await stored(inv.id);
    expect(second.public_token_version).toBe(first.public_token_version + 1);
    expect(second.public_token_hash).not.toBe(first.public_token_hash);
    expect(tokenIsFor(token, inv.id, second.public_token_version, second.public_token_hash)).toBe(false);
    const next = (await getInvoiceLink(io.ctx("owner"), inv.id)).url;
    expect(next).not.toBe(url);
    expect(tokenIsFor(next.split("/pay/")[1], inv.id, second.public_token_version, second.public_token_hash)).toBe(true);
    expect((await rows("select 1 from customer_invoice_events where invoice_id = $1 and kind = 'link_rotated'", [inv.id]))).toHaveLength(1);
  });

  it("does not exist for a draft, a void invoice or another workspace's invoice, and a link whose key is gone can be replaced", async () => {
    const io = await invoiceOrg();
    const other = await invoiceOrg();
    const draft = (await draftBy(io)).invoice;
    await expect(getInvoiceLink(io.ctx("owner"), draft.id)).rejects.toThrow(/once it is issued/);
    await expect(rotateInvoiceLink(io.ctx("owner"), draft.id)).rejects.toThrow(/once it is issued/);
    const inv = (await issuedInvoice(io)).invoice;
    await expect(getInvoiceLink(other.ctx("owner"), inv.id)).rejects.toThrow(/That invoice was not found/);
    await expect(rotateInvoiceLink(other.ctx("owner"), inv.id)).rejects.toThrow(/That invoice was not found/);
    // A hash that no key can make: the server's key changed and the old one was dropped.
    await withSystem((db) => db.query("update customer_invoices set public_token_hash = repeat('f', 64) where id = $1", [inv.id]));
    await expect(getInvoiceLink(io.ctx("owner"), inv.id)).rejects.toThrow(/can no longer be shown/);
    await rotateInvoiceLink(io.ctx("owner"), inv.id);
    await expect(getInvoiceLink(io.ctx("owner"), inv.id)).resolves.toMatchObject({ url: expect.stringMatching(/\/pay\//) });
    const voidable = (await issuedInvoice(io)).invoice;
    await voidInvoice(io.ctx("owner"), voidable.id, { reason: "Raised by mistake" });
    await expect(getInvoiceLink(io.ctx("owner"), voidable.id)).rejects.toThrow(/void/);
    await expect(rotateInvoiceLink(io.ctx("owner"), voidable.id)).rejects.toThrow(/void/);
    expect((await stored(voidable.id)).public_token_hash).toBeNull();
  });
});

describe("the permission matrix, role by role", () => {
  const ROLES = ["owner", "manager", "sales", "support", "viewer", "setter", "member"] as const;
  type Role = (typeof ROLES)[number];
  const ALLOWED: Record<string, readonly Role[]> = {
    list: ["owner", "manager", "sales"], create: ["owner", "manager", "sales"], approve: ["owner", "manager"], pay: ["owner", "manager"], void: ["owner", "manager"], refund: ["owner"], settings: ["owner"],
  };

  it("lets exactly the roles of the matrix do each thing, and refuses every other role as forbidden", async () => {
    const io = await invoiceOrg();
    const contactId = await contactIn(io);
    const fresh = async (state: "draft" | "issued") => {
      const d = await draftBy(io, "owner", { contactId });
      return state === "draft" ? d.invoice : (await issueInvoice(io.ctx("owner"), d.invoice.id, { version: d.invoice.version }, { now: NOW })).detail.invoice;
    };
    const run: Record<string, (role: Role) => Promise<unknown>> = {
      list: (role) => listInvoices(io.ctx(role)),
      create: (role) => createDraft(io.ctx(role), { contactId, lines: [line()] }),
      approve: async (role) => issueInvoice(io.ctx(role), (await fresh("draft")).id, { version: 1 }, { now: NOW }),
      pay: async (role) => recordManualPayment(io.ctx(role), (await fresh("issued")).id, { amount: "1", receivedOn: "2026-10-23", method: "cash", evidence: "Cash in hand, receipt 1" }, { now: NOW }),
      void: async (role) => voidInvoice(io.ctx(role), (await fresh("issued")).id, { reason: "Testing the roles" }),
      refund: async (role) => writeOffInvoice(io.ctx(role), (await fresh("issued")).id, { reason: "Testing the roles" }),
      settings: async (role) => saveInvoiceSettings(io.ctx(role), { footerNote: `Footer ${role}` }, (await getInvoiceSettings(io.ctx("owner"))).version),
    };
    for (const [action, roles] of Object.entries(ALLOWED)) {
      for (const role of ROLES) {
        const outcome = await run[action](role).then(() => "allowed", (e: unknown) => (e instanceof AppError ? e.code : `unexpected: ${String(e)}`));
        expect(outcome, `${role} ${action}`).toBe(roles.includes(role) ? "allowed" : "forbidden");
      }
    }
  });
});

describe("deals", () => {
  it("brings a deal's customer and company into the invoice and keeps the deal link", async () => {
    const io = await invoiceOrg();
    const contactId = await contactIn(io);
    const created = await createOpportunity(io.c.actor("owner"), { name: "Bathroom remodel", contactId, value: 4000 });
    const out = await createDraft(io.ctx("owner"), { opportunityId: created.id, lines: [line()] });
    expect(out.invoice).toMatchObject({ opportunityId: created.id, opportunityName: "Bathroom remodel", contactId });
    const other = await createContact(io.c.actor("owner"), { firstName: "Other", lastName: "Person", email: uniqueEmail() });
    await expect(updateDraft(io.ctx("owner"), out.invoice.id, { contactId: other.id }, 1)).rejects.toThrow(/different customer/);
  });
});
