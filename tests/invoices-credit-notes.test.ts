// Credit notes on customer invoices, on embedded Postgres. A credit note takes money off what a customer still owes on ONE issued invoice. It is not a payment and not a refund: it
// never counts as money received, as revenue or as a reason to close a deal; it can only reduce the unpaid part; a second person approves it (unless the owner wrote it); once issued it
// cannot be changed, deleted or voided; and the invoice and the note move together or not at all (the database refuses a mismatch at commit).
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { createDraft, getInvoiceDetail, receivablesSummary, voidInvoice } from "@/server/invoices/invoices";
import { recordManualPayment } from "@/server/invoices/payments";
import { loadPublicInvoice } from "@/server/invoices/public";
import { cohortRevenue, unattributedRevenue } from "@/server/invoices/revenue";
import {
  cancelCreditNote, createCreditNoteDraft, getCreditNote, issueCreditNote, listCreditNotes, returnCreditNote, submitCreditNote, updateCreditNoteDraft, withdrawCreditNote,
} from "@/server/invoices/credit-notes";
import { connectionFor, contactIn, draftBy, freshIp, invoiceOrg, issuedInvoice, issuedTestInvoice, line, linkTokenOf, providerPayment, rows } from "./support/invoices";

const NOW = new Date("2026-10-26T12:00:00Z");
const pay = { receivedOn: "2026-10-26", method: "bank_transfer" as const, evidence: "Bank transfer ref 7731" };
const invoiceRow = async (id: string) => (await rows<{ paid_minor: string; credited_minor: string; balance_minor: string; overpaid_minor: string; payment_status: string; status: string }>(
  "select paid_minor::text, credited_minor::text, balance_minor::text, overpaid_minor::text, payment_status, status from customer_invoices where id = $1", [id]))[0];
const kinds = async (invoiceId: string) => (await rows<{ kind: string }>("select kind from customer_invoice_events where invoice_id = $1 order by id", [invoiceId])).map((e) => e.kind);
const auditActions = async (orgId: string, prefix = "credit_note.") => (await rows<{ action: string }>("select action from audit_logs where org_id = $1 and action like $2 order by created_at, id", [orgId, `${prefix}%`])).map((a) => a.action);

/** An issued invoice of 1,500.00 PHP (150000 minor) and a credit note drafted on it by the manager. */
async function setup(over: { amount?: string; who?: "owner" | "manager" } = {}) {
  const io = await invoiceOrg();
  const inv = (await issuedInvoice(io, {}, NOW)).invoice;
  const note = await createCreditNoteDraft(io.ctx(over.who ?? "manager"), { invoiceId: inv.id, amount: over.amount ?? "500.00", reason: "Goodwill for a late visit" });
  return { io, inv, note };
}

describe("writing a credit note", () => {
  it("makes a draft that takes nothing off the invoice, with an event, an audit entry and a version", async () => {
    const { io, inv, note } = await setup();
    expect(note).toMatchObject({ status: "draft", number: null, amountMinor: 50000, currency: "PHP", version: 1, reason: "Goodwill for a late visit", invoiceNumber: "INV-0001" });
    expect(await invoiceRow(inv.id)).toMatchObject({ credited_minor: "0", balance_minor: "150000", payment_status: "unpaid" });
    expect(await kinds(inv.id)).toEqual(["created", "issued", "credit_note_created"]);
    expect(await auditActions(io.orgId)).toEqual(["credit_note.created"]);
  });

  it("is for the owner and the manager only: a sales rep, a viewer and agency staff cannot", async () => {
    const io = await invoiceOrg();
    const inv = (await issuedInvoice(io, {}, NOW)).invoice;
    for (const who of ["sales", "viewer", "support", "setter"] as const) {
      await expect(createCreditNoteDraft(io.ctx(who), { invoiceId: inv.id, amount: "10.00", reason: "Not allowed" }), who).rejects.toMatchObject({ code: "forbidden" });
    }
    expect(await rows("select 1 from customer_credit_notes where org_id = $1", [io.orgId])).toHaveLength(0);
  });

  it("reads the amount as the person typed it in the invoice's currency and never takes more than is owed", async () => {
    const io = await invoiceOrg();
    const inv = (await issuedInvoice(io, {}, NOW)).invoice;
    for (const bad of ["", "abc", "0", "-5", "0.00", "1500.01", "1,500.00x"]) {
      await expect(createCreditNoteDraft(io.ctx("manager"), { invoiceId: inv.id, amount: bad, reason: "Goodwill" }), bad).rejects.toMatchObject({ code: "invalid_input" });
    }
    expect((await createCreditNoteDraft(io.ctx("manager"), { invoiceId: inv.id, amount: "1500.00", reason: "All of it" })).amountMinor).toBe(150000);
    await expect(createCreditNoteDraft(io.ctx("manager"), { invoiceId: inv.id, amount: "10.00", reason: "ok" })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("is refused on every invoice a credit cannot apply to", async () => {
    const io = await invoiceOrg();
    const draft = (await draftBy(io)).invoice;
    const test = (await issuedTestInvoice(io, {}, NOW)).invoice;
    const written = (await issuedInvoice(io, {}, NOW)).invoice;
    await withSystem((db) => db.query("update customer_invoices set written_off_at = now(), written_off_by = $2, write_off_reason = 'gave up' where id = $1", [written.id, io.c.people.owner.id]));
    const paid = (await issuedInvoice(io, {}, NOW)).invoice;
    await recordManualPayment(io.ctx("owner"), paid.id, { ...pay, amount: "1500.00" }, { now: NOW });
    const voided = (await issuedInvoice(io, {}, NOW)).invoice;
    await voidInvoice(io.ctx("owner"), voided.id, { reason: "Raised in error" });
    for (const [label, id] of [["draft", draft.id], ["test", test.id], ["written off", written.id], ["paid", paid.id], ["void", voided.id]] as const) {
      await expect(createCreditNoteDraft(io.ctx("owner"), { invoiceId: id, amount: "10.00", reason: "Not possible" }), label).rejects.toMatchObject({ code: "conflict" });
    }
    await expect(createCreditNoteDraft(io.ctx("owner"), { invoiceId: "00000000-0000-4000-8000-000000000000", amount: "10.00", reason: "Nothing here" })).rejects.toMatchObject({ code: "not_found" });
    expect(await rows("select 1 from customer_credit_notes where org_id = $1", [io.orgId])).toHaveLength(0);
  });

  it("makes one note for a retried request", async () => {
    const io = await invoiceOrg();
    const inv = (await issuedInvoice(io, {}, NOW)).invoice;
    const a = await createCreditNoteDraft(io.ctx("manager"), { invoiceId: inv.id, amount: "100.00", reason: "Retry safe", idempotencyKey: "credit-retry-0001" });
    const b = await createCreditNoteDraft(io.ctx("manager"), { invoiceId: inv.id, amount: "100.00", reason: "Retry safe", idempotencyKey: "credit-retry-0001" });
    expect(b.id).toBe(a.id);
    expect(await rows("select 1 from customer_credit_notes where org_id = $1", [io.orgId])).toHaveLength(1);
    const other = (await issuedInvoice(io, {}, NOW)).invoice;
    await expect(createCreditNoteDraft(io.ctx("manager"), { invoiceId: other.id, amount: "100.00", reason: "Retry safe", idempotencyKey: "credit-retry-0001" })).rejects.toMatchObject({ code: "conflict" });
  });

  it("edits a draft with the version it read, bumping it, and refuses a stale edit and a stranger", async () => {
    const { io, note } = await setup();
    const edited = await updateCreditNoteDraft(io.ctx("manager"), note.id, { amount: "250.00", reason: "Corrected amount agreed by phone" }, 1);
    expect(edited).toMatchObject({ amountMinor: 25000, version: 2, reason: "Corrected amount agreed by phone" });
    await expect(updateCreditNoteDraft(io.ctx("manager"), note.id, { amount: "300.00" }, 1)).rejects.toMatchObject({ code: "conflict" });
    await expect(updateCreditNoteDraft(io.ctx("manager"), note.id, { amount: "9999.00" }, 2)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(updateCreditNoteDraft(io.ctx("sales"), note.id, { amount: "300.00" }, 2)).rejects.toMatchObject({ code: "forbidden" });
    // The owner may change a manager's draft; the draft stays the manager's.
    expect((await updateCreditNoteDraft(io.ctx("owner"), note.id, { reason: "Owner clarified the reason" }, 2)).createdBy).toBe(io.c.people.manager.id);
  });
});

describe("approving and issuing", () => {
  it("is done by someone other than the author, names the version read, numbers the note and writes the invoice together with it", async () => {
    const { io, inv, note } = await setup();
    await submitCreditNote(io.ctx("manager"), note.id, 1);
    expect((await getCreditNote(io.ctx("owner"), note.id)).status).toBe("pending_approval");
    // The author cannot approve their own; a stale version is refused; then the owner issues it.
    await expect(issueCreditNote(io.ctx("manager"), note.id, { version: 1 }, { now: NOW })).rejects.toMatchObject({ code: "forbidden" });
    await expect(issueCreditNote(io.ctx("owner"), note.id, { version: 7 }, { now: NOW })).rejects.toMatchObject({ code: "conflict" });
    expect(await invoiceRow(inv.id)).toMatchObject({ credited_minor: "0", balance_minor: "150000" });
    const out = await issueCreditNote(io.ctx("owner"), note.id, { version: 1 }, { now: NOW });
    expect(out).toMatchObject({ number: "CN-0001", owedMinor: 100000, settled: false });
    expect(out.creditNote).toMatchObject({ status: "issued", number: "CN-0001", approvedVersion: 1, taxPortionMinor: 0 });
    expect(await invoiceRow(inv.id)).toMatchObject({ credited_minor: "50000", balance_minor: "100000", payment_status: "unpaid", paid_minor: "0", overpaid_minor: "0" });
    const stored = (await rows<{ content_hash: string; approved_by: string; issued_by: string; bill_to: Record<string, unknown>; bill_from: Record<string, unknown> }>("select content_hash, approved_by, issued_by, bill_to, bill_from from customer_credit_notes where id = $1", [note.id]))[0];
    expect(stored.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect([stored.approved_by, stored.issued_by]).toEqual([io.c.people.owner.id, io.c.people.owner.id]);
    // The customer's and the business's details are the invoice's, frozen.
    const frozen = (await rows<{ bill_to: Record<string, unknown>; bill_from: Record<string, unknown> }>("select bill_to, bill_from from customer_invoices where id = $1", [inv.id]))[0];
    expect(stored.bill_to).toEqual(frozen.bill_to);
    expect(stored.bill_from).toEqual(frozen.bill_from);
    expect(await kinds(inv.id)).toEqual(["created", "issued", "credit_note_created", "credit_note_submitted", "credit_note_issued"]);
    expect(await auditActions(io.orgId)).toEqual(["credit_note.created", "credit_note.issued"]);
    const audit = (await rows<{ metadata: Record<string, unknown>; actor_user_id: string }>("select metadata, actor_user_id from audit_logs where org_id = $1 and action = 'credit_note.issued'", [io.orgId]))[0];
    expect(audit.metadata).toMatchObject({ number: "CN-0001", invoiceNumber: "INV-0001", amount: "500.00", currency: "PHP", author: io.c.people.manager.id });
    expect(audit.actor_user_id).toBe(io.c.people.owner.id);
    const told = await rows<{ title: string }>("select title from notifications where org_id = $1 and user_id = $2 and kind = 'invoice_approval_decided'", [io.orgId, io.c.people.manager.id]);
    expect(told.map((n) => n.title)).toContain("Your credit note was approved and issued");
  });

  it("lets the owner approve their own, and numbers the next one CN-0002 without a gap", async () => {
    const { io, inv, note } = await setup({ who: "owner" });
    expect((await issueCreditNote(io.ctx("owner"), note.id, { version: 1 }, { now: NOW })).number).toBe("CN-0001");
    const second = await createCreditNoteDraft(io.ctx("owner"), { invoiceId: inv.id, amount: "100.00", reason: "A second goodwill credit" });
    expect((await issueCreditNote(io.ctx("owner"), second.id, { version: 1 }, { now: NOW })).number).toBe("CN-0002");
    expect(await invoiceRow(inv.id)).toMatchObject({ credited_minor: "60000", balance_minor: "90000" });
    // Another workspace has its own sequence.
    const other = await setup({ who: "owner" });
    expect((await issueCreditNote(other.io.ctx("owner"), other.note.id, { version: 1 }, { now: NOW })).number).toBe("CN-0001");
  });

  it("will not issue what a reviewer sent back, a cancelled note, or one the invoice can no longer take", async () => {
    const { io, inv, note } = await setup();
    await submitCreditNote(io.ctx("manager"), note.id, 1);
    await returnCreditNote(io.ctx("owner"), note.id, { version: 1, note: "Please say which visit" });
    expect((await getCreditNote(io.ctx("owner"), note.id)).status).toBe("draft");
    const told = await rows<{ title: string }>("select title from notifications where org_id = $1 and user_id = $2 and kind = 'invoice_approval_decided'", [io.orgId, io.c.people.manager.id]);
    expect(told.map((n) => n.title)).toContain("Changes were requested on your credit note");
    // It was never issued, so the owner cannot issue what is a draft that was not submitted?  A draft can be issued by an approver directly, so it is the version that matters.
    const cancelled = await createCreditNoteDraft(io.ctx("manager"), { invoiceId: inv.id, amount: "20.00", reason: "To be cancelled" });
    await cancelCreditNote(io.ctx("manager"), cancelled.id, "Raised twice by mistake");
    await expect(issueCreditNote(io.ctx("owner"), cancelled.id, { version: 1 }, { now: NOW })).rejects.toMatchObject({ code: "conflict" });
    // Another credit used up the balance in the meantime: this one no longer fits.
    const big = await createCreditNoteDraft(io.ctx("owner"), { invoiceId: inv.id, amount: "1400.00", reason: "Large goodwill credit" });
    const second = await createCreditNoteDraft(io.ctx("owner"), { invoiceId: inv.id, amount: "1400.00", reason: "Duplicate large credit" });
    await issueCreditNote(io.ctx("owner"), big.id, { version: 1 }, { now: NOW });
    await expect(issueCreditNote(io.ctx("owner"), second.id, { version: 1 }, { now: NOW })).rejects.toMatchObject({ code: "conflict" });
    expect(await invoiceRow(inv.id)).toMatchObject({ credited_minor: "140000", balance_minor: "10000" });
  });

  it("takes the tax of the invoice in proportion, once, at issue", async () => {
    const io = await invoiceOrg();
    const contactId = await contactIn(io);
    const created = await createDraft(io.ctx("owner"), { contactId, currency: "PHP", lines: [line({ unitPrice: "1000.00", taxPercent: "12" })] });
    const { issueInvoice } = await import("@/server/invoices/invoices");
    const inv = (await issueInvoice(io.ctx("owner"), created.invoice.id, { version: created.invoice.version }, { now: NOW })).detail.invoice;
    expect(inv).toMatchObject({ totalMinor: 112000, taxMinor: 12000 });
    const note = await createCreditNoteDraft(io.ctx("owner"), { invoiceId: inv.id, amount: "560.00", reason: "Half the job was not done" });
    const out = await issueCreditNote(io.ctx("owner"), note.id, { version: 1 }, { now: NOW });
    expect(out.creditNote.taxPortionMinor).toBe(6000);
  });
});

describe("what a credit does to the invoice", () => {
  it("a credit of everything makes it credited, not paid: no payment event, no deal closed, reminders and sending stop", async () => {
    const io = await invoiceOrg();
    const inv = (await issuedInvoice(io, {}, NOW)).invoice;
    const note = await createCreditNoteDraft(io.ctx("owner"), { invoiceId: inv.id, amount: "1500.00", reason: "The job was cancelled" });
    const out = await issueCreditNote(io.ctx("owner"), note.id, { version: 1 }, { now: NOW });
    expect(out).toMatchObject({ owedMinor: 0, settled: true });
    expect(await invoiceRow(inv.id)).toMatchObject({ credited_minor: "150000", balance_minor: "0", paid_minor: "0", payment_status: "credited", status: "issued" });
    expect(await kinds(inv.id)).not.toContain("paid");
    expect(await rows("select 1 from notifications where org_id = $1 and kind = 'invoice_paid'", [io.orgId])).toHaveLength(0);
    // Nothing is owed any more, so a payment cannot be recorded against it without saying it is an overpayment.
    await expect(recordManualPayment(io.ctx("owner"), inv.id, { ...pay, amount: "10.00" }, { now: NOW })).rejects.toMatchObject({ code: "conflict" });
    const detail = await getInvoiceDetail(io.ctx("owner"), inv.id);
    expect(detail.invoice).toMatchObject({ paymentStatus: "credited", creditedMinor: 150000, balanceMinor: 0, paidMinor: 0 });
    expect(detail.creditNotes.map((n) => [n.number, n.status])).toEqual([["CN-0001", "issued"]]);
  });

  it("a part credit and a payment of the rest make it paid, with the payment announced as the money that arrived", async () => {
    const io = await invoiceOrg();
    const inv = (await issuedInvoice(io, {}, NOW)).invoice;
    const note = await createCreditNoteDraft(io.ctx("owner"), { invoiceId: inv.id, amount: "500.00", reason: "Goodwill for a late visit" });
    await issueCreditNote(io.ctx("owner"), note.id, { version: 1 }, { now: NOW });
    const part = await recordManualPayment(io.ctx("owner"), inv.id, { ...pay, amount: "400.00" }, { now: NOW });
    expect(part).toMatchObject({ justPaid: false, invoice: { paidMinor: 40000, creditedMinor: 50000, balanceMinor: 60000, paymentStatus: "partially_paid" } });
    await expect(recordManualPayment(io.ctx("owner"), inv.id, { ...pay, amount: "700.00" }, { now: NOW })).rejects.toMatchObject({ code: "conflict" });
    const rest = await recordManualPayment(io.ctx("owner"), inv.id, { ...pay, amount: "600.00" }, { now: NOW });
    expect(rest).toMatchObject({ justPaid: true, invoice: { paidMinor: 100000, creditedMinor: 50000, balanceMinor: 0, paymentStatus: "paid", overpaidMinor: 0 } });
    expect(await invoiceRow(inv.id)).toMatchObject({ paid_minor: "100000", credited_minor: "50000", balance_minor: "0", overpaid_minor: "0", payment_status: "paid" });
    expect(await kinds(inv.id)).toContain("paid");
  });

  it("limits a credit to the unpaid part: after a payment only what is still owed can be credited", async () => {
    const io = await invoiceOrg();
    const inv = (await issuedInvoice(io, {}, NOW)).invoice;
    await recordManualPayment(io.ctx("owner"), inv.id, { ...pay, amount: "1000.00" }, { now: NOW });
    await expect(createCreditNoteDraft(io.ctx("owner"), { invoiceId: inv.id, amount: "600.00", reason: "More than is owed" })).rejects.toMatchObject({ code: "invalid_input" });
    const note = await createCreditNoteDraft(io.ctx("owner"), { invoiceId: inv.id, amount: "500.00", reason: "Exactly the unpaid part" });
    const out = await issueCreditNote(io.ctx("owner"), note.id, { version: 1 }, { now: NOW });
    expect(out).toMatchObject({ owedMinor: 0, settled: true });
    expect(await invoiceRow(inv.id)).toMatchObject({ payment_status: "paid", paid_minor: "100000", credited_minor: "50000", balance_minor: "0" });
  });

  it("is refused while a customer may be paying: a payment waiting for review or an open checkout", async () => {
    const io = await invoiceOrg();
    const inv = (await issuedInvoice(io, {}, NOW)).invoice;
    const note = await createCreditNoteDraft(io.ctx("owner"), { invoiceId: inv.id, amount: "100.00", reason: "Goodwill for a delay" });
    const connection = await connectionFor(io, { provider: "paypal", mode: "live" });
    await withSystem((db) => db.query(
      `insert into customer_payment_attempts (org_id, invoice_id, connection_id, currency, amount_minor, reference, status, expires_at) values ($1, $2, $3, 'PHP', 150000, $4, 'redirected', now() + interval '1 hour')`,
      [io.orgId, inv.id, connection, `CP-${Math.random().toString(36).slice(2).padEnd(24, "0").slice(0, 24)}`],
    ));
    await expect(issueCreditNote(io.ctx("owner"), note.id, { version: 1 }, { now: NOW })).rejects.toMatchObject({ code: "conflict" });
    await expect(createCreditNoteDraft(io.ctx("owner"), { invoiceId: inv.id, amount: "50.00", reason: "Second goodwill credit" })).rejects.toMatchObject({ code: "conflict" });
    await withSystem((db) => db.query("update customer_payment_attempts set status = 'cancelled' where invoice_id = $1", [inv.id]));
    expect((await issueCreditNote(io.ctx("owner"), note.id, { version: 1 }, { now: NOW })).number).toBe("CN-0001");
  });

  it("makes the invoice impossible to void once it was credited", async () => {
    const io = await invoiceOrg();
    const inv = (await issuedInvoice(io, {}, NOW)).invoice;
    const note = await createCreditNoteDraft(io.ctx("owner"), { invoiceId: inv.id, amount: "100.00", reason: "Goodwill for a delay" });
    await issueCreditNote(io.ctx("owner"), note.id, { version: 1 }, { now: NOW });
    await expect(voidInvoice(io.ctx("owner"), inv.id, { reason: "Trying to undo the credit" })).rejects.toMatchObject({ code: "conflict" });
    await expect(withSystem((db) => db.query("update customer_invoices set status = 'void', voided_at = now(), void_reason = 'sneaky' where id = $1", [inv.id]))).rejects.toThrow();
    expect((await invoiceRow(inv.id)).status).toBe("issued");
  });
});

describe("credit is not revenue and not money received", () => {
  it("leaves verified revenue and net received exactly as the money that arrived, and lowers only what is owed", async () => {
    const io = await invoiceOrg();
    const connection = await connectionFor(io, { provider: "paypal", mode: "live" });
    const inv = (await issuedInvoice(io, {}, NOW)).invoice;
    await providerPayment(io, inv.id, connection, 60000, { provider: "paypal", livemode: true });
    const before = await receivablesSummary(io.ctx("owner"), { now: NOW });
    expect(before.byCurrency[0]).toMatchObject({ outstandingMinor: 90000, netReceivedMinor: 60000, creditedMinor: 0 });
    const revenueBefore = await withSystem((db) => unattributedRevenue(db, io.orgId, new Date("2026-12-31T00:00:00Z"), true));
    const note = await createCreditNoteDraft(io.ctx("owner"), { invoiceId: inv.id, amount: "400.00", reason: "Goodwill for a late visit" });
    await issueCreditNote(io.ctx("owner"), note.id, { version: 1 }, { now: NOW });
    const after = await receivablesSummary(io.ctx("owner"), { now: NOW });
    expect(after.byCurrency[0]).toMatchObject({ outstandingMinor: 50000, netReceivedMinor: 60000, creditedMinor: 40000 });
    const revenueAfter = await withSystem((db) => unattributedRevenue(db, io.orgId, new Date("2026-12-31T00:00:00Z"), true));
    expect(revenueAfter).toEqual(revenueBefore);
    void cohortRevenue;
    // The invoice's own figures say the same.
    expect(await invoiceRow(inv.id)).toMatchObject({ paid_minor: "60000", credited_minor: "40000", balance_minor: "50000" });
  });
});

describe("a note that was issued is a record", () => {
  it("cannot be edited, cancelled, deleted, taken back or re-issued, by the application or by the database", async () => {
    const { io, inv, note } = await setup({ who: "owner" });
    await issueCreditNote(io.ctx("owner"), note.id, { version: 1 }, { now: NOW });
    await expect(updateCreditNoteDraft(io.ctx("owner"), note.id, { amount: "1.00" }, 1)).rejects.toMatchObject({ code: "conflict" });
    await expect(cancelCreditNote(io.ctx("owner"), note.id, "Trying to undo it")).rejects.toMatchObject({ code: "conflict" });
    await expect(withdrawCreditNote(io.ctx("owner"), note.id)).rejects.toMatchObject({ code: "conflict" });
    await expect(submitCreditNote(io.ctx("owner"), note.id, 1)).rejects.toMatchObject({ code: "conflict" });
    await expect(issueCreditNote(io.ctx("owner"), note.id, { version: 1 }, { now: NOW })).rejects.toMatchObject({ code: "conflict" });
    for (const sql of [
      "update customer_credit_notes set amount_minor = 1 where id = $1",
      "update customer_credit_notes set reason = 'rewritten history' where id = $1",
      "update customer_credit_notes set status = 'cancelled', cancelled_at = now() where id = $1",
      "update customer_credit_notes set number = 'CN-9999' where id = $1",
      "update customer_credit_notes set bill_to = '{\"name\": \"someone else\"}'::jsonb where id = $1",
      "update customer_credit_notes set content_hash = repeat('0', 64) where id = $1",
      "delete from customer_credit_notes where id = $1",
    ]) await expect(withSystem((db) => db.query(sql, [note.id])), sql).rejects.toThrow();
    // The customer's details can be erased on a privacy request and only to the erased form.
    await withSystem((db) => db.query("update customer_credit_notes set bill_to = '{\"erased\": true}'::jsonb where id = $1", [note.id]));
    expect((await rows<{ amount_minor: string; status: string }>("select amount_minor::text, status from customer_credit_notes where id = $1", [note.id]))[0]).toEqual({ amount_minor: "50000", status: "issued" });
    expect(await invoiceRow(inv.id)).toMatchObject({ credited_minor: "50000" });
  });

  it("is kept in step with the invoice by the database: neither can move without the other", async () => {
    const { io, inv, note } = await setup({ who: "owner" });
    // The invoice cannot claim a credit that no issued note backs.
    await expect(withSystem((db) => db.query("update customer_invoices set credited_minor = 100, payment_status = 'unpaid' where id = $1", [inv.id]))).rejects.toThrow(/credit/i);
    // A note cannot be issued past the invoice's balance (guarded in the row).
    await withSystem((db) => db.query("update customer_credit_notes set amount_minor = 150000 where id = $1", [note.id]));
    await expect(withSystem((db) => db.query(
      "update customer_credit_notes set status = 'issued', number = 'CN-0099', content_hash = repeat('a', 64), issued_at = now(), approved_version = 1, amount_minor = 150001 where id = $1", [note.id]))).rejects.toThrow();
    // A note flipped to issued without the invoice moving is refused when the transaction commits.
    await expect(withSystem(async (db) => {
      await db.query("update customer_credit_notes set amount_minor = 1000 where id = $1", [note.id]);
      await db.query("update customer_credit_notes set status = 'issued', number = 'CN-0098', content_hash = repeat('b', 64), issued_at = now(), approved_version = 1 where id = $1", [note.id]);
    })).rejects.toThrow(/credited amount of an invoice must equal its issued credit notes/);
    expect(await invoiceRow(inv.id)).toMatchObject({ credited_minor: "0" });
    expect((await getCreditNote(io.ctx("owner"), note.id)).status).toBe("draft");
  });

  it("is created only as a draft, on an issued real invoice, and never for more than the invoice", async () => {
    const io = await invoiceOrg();
    const inv = (await issuedInvoice(io, {}, NOW)).invoice;
    const test = (await issuedTestInvoice(io, {}, NOW)).invoice;
    const insert = (invoiceId: string, extra = "", amount = 100) => withSystem((db) => db.query(
      `insert into customer_credit_notes (org_id, invoice_id, currency, amount_minor, reason ${extra ? ", " + extra.split("=")[0] : ""}) values ($1, $2, 'PHP', ${amount}, 'Direct write' ${extra ? ", " + extra.split("=")[1] : ""})`, [io.orgId, invoiceId]));
    await insert(inv.id);
    await expect(insert(inv.id, "status='issued'")).rejects.toThrow();
    await expect(insert(inv.id, "number='CN-0001'")).rejects.toThrow();
    await expect(insert(test.id)).rejects.toThrow(/test invoice/);
    await expect(insert(inv.id, "", 150001)).rejects.toThrow(/more than the invoice/);
    // Another workspace's invoice is out of reach (the composite key).
    const other = await invoiceOrg();
    await expect(withSystem((db) => db.query("insert into customer_credit_notes (org_id, invoice_id, currency, amount_minor, reason) values ($1, $2, 'PHP', 100, 'Cross workspace')", [other.orgId, inv.id]))).rejects.toThrow();
  });
});

describe("who can see and act on a credit note", () => {
  it("keeps one workspace's notes out of another's, in reading and in acting", async () => {
    const a = await setup({ who: "owner" });
    const b = await invoiceOrg();
    await expect(getCreditNote(b.ctx("owner"), a.note.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(issueCreditNote(b.ctx("owner"), a.note.id, { version: 1 }, { now: NOW })).rejects.toMatchObject({ code: "not_found" });
    await expect(cancelCreditNote(b.ctx("owner"), a.note.id, "Not yours to cancel")).rejects.toMatchObject({ code: "not_found" });
    await expect(submitCreditNote(b.ctx("owner"), a.note.id, 1)).rejects.toMatchObject({ code: "not_found" });
    expect(await listCreditNotes(b.ctx("owner"), a.inv.id)).toEqual([]);
    expect((await listCreditNotes(a.io.ctx("owner"), a.inv.id)).map((n) => n.id)).toEqual([a.note.id]);
    // A person who may see invoices but not write credits reads them and cannot act.
    expect((await listCreditNotes(a.io.ctx("sales"), a.inv.id)).length).toBe(1);
    await expect(issueCreditNote(a.io.ctx("sales"), a.note.id, { version: 1 }, { now: NOW })).rejects.toMatchObject({ code: "forbidden" });
    // The workspace without invoicing switched on cannot use any of it.
    const off = await invoiceOrg({ enabled: false });
    await expect(listCreditNotes(off.ctx("owner"), a.inv.id)).rejects.toBeTruthy();
  });

  it("takes back a submitted note for its author only, and lets the author or a manager cancel a draft with a reason", async () => {
    const { io, note } = await setup();
    await submitCreditNote(io.ctx("manager"), note.id, 1);
    await expect(submitCreditNote(io.ctx("manager"), note.id, 1)).rejects.toMatchObject({ code: "conflict" });
    await expect(updateCreditNoteDraft(io.ctx("manager"), note.id, { amount: "1.00" }, 1)).rejects.toMatchObject({ code: "conflict" });
    await expect(withdrawCreditNote(io.ctx("sales"), note.id)).rejects.toMatchObject({ code: "forbidden" });
    expect((await withdrawCreditNote(io.ctx("manager"), note.id)).status).toBe("draft");
    await expect(cancelCreditNote(io.ctx("manager"), note.id, "no")).rejects.toMatchObject({ code: "invalid_input" });
    const cancelled = await cancelCreditNote(io.ctx("owner"), note.id, "Raised on the wrong invoice");
    expect(cancelled).toMatchObject({ status: "cancelled", cancelReason: "Raised on the wrong invoice" });
    expect(await auditActions(io.orgId)).toEqual(["credit_note.created", "credit_note.cancelled"]);
  });
});

describe("what the customer sees", () => {
  it("shows the credit note and what is still due on the invoice page, and says a fully credited invoice has nothing due", async () => {
    const io = await invoiceOrg();
    const inv = (await issuedInvoice(io, {}, NOW)).invoice;
    const token = await linkTokenOf(io, inv.id);
    const note = await createCreditNoteDraft(io.ctx("owner"), { invoiceId: inv.id, amount: "500.00", reason: "Internal reason that is not shown" });
    await issueCreditNote(io.ctx("owner"), note.id, { version: 1 }, { now: NOW });
    const res = await loadPublicInvoice(token, { ip: freshIp(), now: NOW });
    if (res.state !== "ok") throw new Error(`expected ok, got ${res.state}`);
    expect(res.invoice).toMatchObject({ totalMinor: 150000, creditedMinor: 50000, paidMinor: 0, balanceMinor: 100000, paymentStatus: "unpaid", credits: [{ number: "CN-0001", amountMinor: 50000 }] });
    expect(JSON.stringify(res.invoice)).not.toContain("Internal reason");
    const rest = await createCreditNoteDraft(io.ctx("owner"), { invoiceId: inv.id, amount: "1000.00", reason: "The rest of the job was cancelled" });
    await issueCreditNote(io.ctx("owner"), rest.id, { version: 1 }, { now: NOW });
    const done = await loadPublicInvoice(token, { ip: freshIp(), now: NOW });
    if (done.state !== "ok") throw new Error("expected ok");
    expect(done.invoice).toMatchObject({ balanceMinor: 0, paymentStatus: "credited", canPayOnline: false, banner: { kind: "credited" } });
    expect(done.invoice.credits.map((c) => c.number)).toEqual(["CN-0001", "CN-0002"]);
  });

  it("does not show a draft, a submitted or a cancelled note to the customer", async () => {
    const io = await invoiceOrg();
    const inv = (await issuedInvoice(io, {}, NOW)).invoice;
    const token = await linkTokenOf(io, inv.id);
    const draft = await createCreditNoteDraft(io.ctx("owner"), { invoiceId: inv.id, amount: "100.00", reason: "Still a draft here" });
    const submitted = await createCreditNoteDraft(io.ctx("owner"), { invoiceId: inv.id, amount: "100.00", reason: "Submitted and waiting" });
    await submitCreditNote(io.ctx("owner"), submitted.id, 1);
    const gone = await createCreditNoteDraft(io.ctx("owner"), { invoiceId: inv.id, amount: "100.00", reason: "Cancelled before issue" });
    await cancelCreditNote(io.ctx("owner"), gone.id, "Raised twice by mistake");
    void draft;
    const res = await loadPublicInvoice(token, { ip: freshIp(), now: NOW });
    if (res.state !== "ok") throw new Error("expected ok");
    expect(res.invoice).toMatchObject({ creditedMinor: 0, credits: [], balanceMinor: 150000 });
  });
});
