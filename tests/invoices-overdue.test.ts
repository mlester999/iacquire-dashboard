// The overdue sweep: an unpaid invoice past its due date, judged in the workspace's own time zone, is noticed once per invoice and due date (one history line, one notice to the
// owner and managers, one announcement, one timeline line) and nothing is sent to a customer. Embedded Postgres.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { applyDisputeInTx } from "@/server/invoices/apply";
import { setInvoicesEnabled } from "@/server/invoices/feature";
import { writeOffInvoice, voidInvoice } from "@/server/invoices/invoices";
import { recordManualPayment } from "@/server/invoices/payments";
import { runInvoiceOverdueSweep } from "@/server/invoices/overdue";
import { eventsFor } from "./support/crm";
import { connectionFor, contactIn, draftBy, invoiceOrg, issuedInvoice, providerPayment, rows } from "./support/invoices";

const ISSUED = new Date("2026-10-23T12:00:00Z");
const DUE = "2026-11-06";
const cash = (amount: string) => ({ amount, receivedOn: "2026-10-23", method: "cash" as const, evidence: "Cash, receipt 12" });
const overdueEvents = (invoiceId: string) => rows<{ detail: { dueOn: string; daysOverdue: number; balance: string; currency: string } }>("select detail from customer_invoice_events where invoice_id = $1 and kind = 'overdue'", [invoiceId]);
const notices = (orgId: string) => rows<{ user_id: string; title: string; body: string }>("select user_id, title, body from notifications where org_id = $1 and kind = 'invoice_overdue'", [orgId]);

describe("noticing an overdue invoice", () => {
  it("records it once with its due date and how late it is, tells the owner and managers, announces it, and puts a line on the customer's timeline", async () => {
    const io = await invoiceOrg();
    const contactId = await contactIn(io);
    const inv = await issuedInvoice(io, { contactId, dueOn: DUE }, ISSUED);
    const day = new Date("2026-11-09T10:00:00Z");
    expect(await runInvoiceOverdueSweep({ now: day })).toEqual({ marked: 1, failed: 0 });

    const ev = await overdueEvents(inv.invoice.id);
    expect(ev).toHaveLength(1);
    expect(ev[0].detail).toMatchObject({ dueOn: DUE, daysOverdue: 3, balance: "1500.00", currency: "PHP" });
    const told = await notices(io.orgId);
    expect(told.map((n) => n.user_id).sort()).toEqual([io.c.people.owner.id, io.c.people.manager.id].sort());
    expect(told[0]).toMatchObject({ title: "INV-0001 is overdue", body: "PHP 1,500.00 was due 6 Nov 2026 and is still unpaid." });
    const announced = await eventsFor(io.orgId, "invoice.overdue");
    expect(announced).toHaveLength(1);
    expect(announced[0]).toMatchObject({ entity_id: inv.invoice.id, contact_id: contactId, payload: { dueOn: DUE, balance: "1500.00", daysOverdue: 3, number: "INV-0001" } });
    expect((await rows<{ summary: string }>("select summary from crm_activities where org_id = $1 and contact_id = $2 and kind = 'invoice.overdue'", [io.orgId, contactId]))[0].summary)
      .toBe("Invoice INV-0001 is overdue: PHP 1,500.00 was due 6 Nov 2026");

    // Looking again, later, changes nothing: once per invoice and due date.
    expect(await runInvoiceOverdueSweep({ now: new Date("2026-11-10T10:00:00Z") })).toEqual({ marked: 0, failed: 0 });
    expect(await overdueEvents(inv.invoice.id)).toHaveLength(1);
    expect(await notices(io.orgId)).toHaveLength(2);
    expect(await eventsFor(io.orgId, "invoice.overdue")).toHaveLength(1);
    // It sends nothing to anyone.
    expect(await rows("select 1 from conversation_messages where org_id = $1", [io.orgId])).toHaveLength(0);
  });

  it("is not overdue on the due day itself, and is the next morning", async () => {
    const io = await invoiceOrg();
    const inv = await issuedInvoice(io, { dueOn: DUE }, ISSUED);
    expect(await runInvoiceOverdueSweep({ now: new Date("2026-11-06T23:59:00Z") })).toEqual({ marked: 0, failed: 0 });
    expect(await overdueEvents(inv.invoice.id)).toHaveLength(0);
    expect((await runInvoiceOverdueSweep({ now: new Date("2026-11-07T00:01:00Z") })).marked).toBeGreaterThanOrEqual(1);
    expect(await overdueEvents(inv.invoice.id)).toHaveLength(1);
  });

  it("judges each workspace by its own calendar: late in Manila while still the due day in UTC", async () => {
    const manila = await invoiceOrg({ timezone: "Asia/Manila" });
    const utc = await invoiceOrg();
    const m = await issuedInvoice(manila, { dueOn: DUE }, ISSUED);
    const u = await issuedInvoice(utc, { dueOn: DUE }, ISSUED);
    // 17:00 UTC on the due day is 01:00 the next day in Manila.
    await runInvoiceOverdueSweep({ now: new Date("2026-11-06T17:00:00Z") });
    expect(await overdueEvents(m.invoice.id)).toHaveLength(1);
    expect(await overdueEvents(u.invoice.id)).toHaveLength(0);
    await runInvoiceOverdueSweep({ now: new Date("2026-11-07T00:30:00Z") });
    expect(await overdueEvents(u.invoice.id)).toHaveLength(1);
    expect(await overdueEvents(m.invoice.id)).toHaveLength(1);
  });

  it("notices a part-paid invoice and reports only what is still owed", async () => {
    const io = await invoiceOrg();
    const inv = await issuedInvoice(io, { dueOn: DUE }, ISSUED);
    await recordManualPayment(io.ctx("owner"), inv.invoice.id, cash("500"), { now: ISSUED });
    await runInvoiceOverdueSweep({ now: new Date("2026-11-08T10:00:00Z") });
    expect((await overdueEvents(inv.invoice.id))[0].detail).toMatchObject({ balance: "1000.00" });
    expect((await notices(io.orgId))[0].body).toBe("PHP 1,000.00 was due 6 Nov 2026 and is still unpaid.");
  });
});

describe("what is never overdue", () => {
  it("is an invoice that was paid, written off, voided, never issued, not yet due, or under a disputed payment", async () => {
    const io = await invoiceOrg();
    const conn = await connectionFor(io);
    const paid = await issuedInvoice(io, { dueOn: DUE }, ISSUED);
    await recordManualPayment(io.ctx("owner"), paid.invoice.id, cash("1500"), { now: ISSUED });
    const writtenOff = await issuedInvoice(io, { dueOn: DUE }, ISSUED);
    await writeOffInvoice(io.ctx("owner"), writtenOff.invoice.id, { reason: "The customer closed their business" });
    const voided = await issuedInvoice(io, { dueOn: DUE }, ISSUED);
    await voidInvoice(io.ctx("owner"), voided.invoice.id, { reason: "Raised for the wrong job" });
    const draft = await draftBy(io, "owner", { dueOn: DUE });
    const early = await issuedInvoice(io, { dueOn: "2026-12-31" }, ISSUED);
    const disputed = await issuedInvoice(io, { dueOn: DUE }, ISSUED);
    const part = await providerPayment(io, disputed.invoice.id, conn, 50_000, { livemode: true });
    await withSystem((db) => applyDisputeInTx(db, { orgId: io.orgId, paymentId: part.paymentId, open: true, actor: { id: null, kind: "provider" } }));
    const owing = await issuedInvoice(io, { dueOn: DUE }, ISSUED);

    const swept = await runInvoiceOverdueSweep({ now: new Date("2026-11-20T10:00:00Z") });
    expect(swept.failed).toBe(0);
    for (const x of [paid, writtenOff, voided, draft, early, disputed]) expect(await overdueEvents(x.invoice.id), x.invoice.number ?? "draft").toHaveLength(0);
    expect(await overdueEvents(owing.invoice.id)).toHaveLength(1);
  });

  it("is an invoice of a workspace that has customer invoices switched off, or that is suspended", async () => {
    const off = await invoiceOrg();
    const suspended = await invoiceOrg();
    const live = await invoiceOrg();
    const a = await issuedInvoice(off, { dueOn: DUE }, ISSUED);
    const b = await issuedInvoice(suspended, { dueOn: DUE }, ISSUED);
    const c = await issuedInvoice(live, { dueOn: DUE }, ISSUED);
    await setInvoicesEnabled(off.superAdmin, off.orgId, false);
    await withSystem((db) => db.query("update organizations set status = 'suspended' where id = $1", [suspended.orgId]));
    await runInvoiceOverdueSweep({ now: new Date("2026-11-20T10:00:00Z") });
    expect(await overdueEvents(a.invoice.id)).toHaveLength(0);
    expect(await overdueEvents(b.invoice.id)).toHaveLength(0);
    expect(await overdueEvents(c.invoice.id)).toHaveLength(1);
    // Nothing leaks across: the live workspace's notice is its own.
    expect(await notices(off.orgId)).toHaveLength(0);
    expect(await notices(live.orgId)).toHaveLength(2);
  });

  it("stays out while a payment is disputed, and is noticed once when the dispute ends and it is still owed", async () => {
    const io = await invoiceOrg();
    const conn = await connectionFor(io);
    const inv = await issuedInvoice(io, { dueOn: DUE }, ISSUED);
    const part = await providerPayment(io, inv.invoice.id, conn, 50_000, { livemode: true });
    await withSystem((db) => applyDisputeInTx(db, { orgId: io.orgId, paymentId: part.paymentId, open: true, actor: { id: null, kind: "provider" } }));
    await runInvoiceOverdueSweep({ now: new Date("2026-11-20T10:00:00Z") });
    expect(await overdueEvents(inv.invoice.id)).toHaveLength(0);
    await withSystem((db) => applyDisputeInTx(db, { orgId: io.orgId, paymentId: part.paymentId, open: false, actor: { id: null, kind: "provider" } }));
    await runInvoiceOverdueSweep({ now: new Date("2026-11-21T10:00:00Z") });
    await runInvoiceOverdueSweep({ now: new Date("2026-11-22T10:00:00Z") });
    expect(await overdueEvents(inv.invoice.id)).toHaveLength(1);
  });
});

describe("running it more than once at the same time", () => {
  it("records one overdue line, one notice per person and one announcement however many sweeps overlap", async () => {
    const io = await invoiceOrg();
    const inv = await issuedInvoice(io, { dueOn: DUE }, ISSUED);
    const now = new Date("2026-11-09T10:00:00Z");
    await Promise.all([runInvoiceOverdueSweep({ now }), runInvoiceOverdueSweep({ now }), runInvoiceOverdueSweep({ now })]);
    expect(await overdueEvents(inv.invoice.id)).toHaveLength(1);
    expect(await notices(io.orgId)).toHaveLength(2);
    expect(await eventsFor(io.orgId, "invoice.overdue")).toHaveLength(1);
  });

  it("works through at most the number of invoices it is given, and finishes the rest next time", async () => {
    const io = await invoiceOrg();
    const made = [];
    for (let i = 0; i < 3; i += 1) made.push(await issuedInvoice(io, { dueOn: DUE }, ISSUED));
    const now = new Date("2026-11-09T10:00:00Z");
    expect((await runInvoiceOverdueSweep({ now, limit: 2 })).marked).toBe(2);
    let total = 2;
    for (let i = 0; i < 5; i += 1) {
      const n = (await runInvoiceOverdueSweep({ now, limit: 2 })).marked;
      expect(n).toBeLessThanOrEqual(2);
      total += n;
      if (!n) break;
    }
    expect(total).toBeGreaterThanOrEqual(3);
    for (const m of made) expect(await overdueEvents(m.invoice.id)).toHaveLength(1);
  });
});
