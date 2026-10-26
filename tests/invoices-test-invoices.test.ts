// Test invoices (decision D2), end to end on embedded Postgres. A test invoice is made on purpose to try a payment account in a provider's test mode: nothing is owed on it and no
// money moves. These tests pin every rule: only the owner makes one; a test payment never lands on a real invoice and live money never on a test one; the testing checkout and
// Pay as a test exist for test invoices only; a test invoice is never reminded about and is kept out of what is owed, overdue, revenue and deals; and it can be voided or deleted
// with its test payments. Nothing contacts a provider: PayMongo's network layer is a fixture and the simulated provider lives in process.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { createDraft, getInvoiceDetail, issueInvoice, listInvoices, receivablesSummary, updateDraft, voidInvoice } from "@/server/invoices/invoices";
import { getInvoiceSettings, saveInvoiceSettings } from "@/server/invoices/settings";
import { recordManualPayment, recordRefund } from "@/server/invoices/payments";
import { recordDisputeOpened } from "@/server/invoices/disputes";
import { applyPaymentInTx } from "@/server/invoices/apply";
import { runCloseRule } from "@/server/invoices/close-rules";
import { runInvoiceOverdueSweep } from "@/server/invoices/overdue";
import { authorizeReminders, getReminderOverview } from "@/server/invoices/reminders";
import { deleteTestInvoice } from "@/server/invoices/test-invoice";
import { hasTestConnection, startTestPayment } from "@/server/invoices/test-payment";
import { loadPublicInvoice, loadReturn } from "@/server/invoices/public";
import { startCheckout } from "@/server/customer-payments/attempts";
import { completeSimulatedCheckout, loadSimulatedAttempt } from "@/server/customer-payments/dev-checkout";
import { runCustomerPaymentReconcileDetailed } from "@/server/customer-payments/reconcile";
import { createPaymongoProvider } from "@/server/customer-payments/providers/paymongo";
import { setAdapterForTests } from "@/server/customer-payments/providers";
import { simulatedPlatform } from "@/server/customer-payments/providers/simulated";
import {
  addMessaging, connectionFor, contactIn, dealFor, freshIp, invoiceOrg, issuedInvoice, issuedTestInvoice, line, linkTokenOf, providerPayment, rows, type InvoiceOrg,
} from "./support/invoices";
import { attempt, connect, deliver, fakePaymongo, invoiceNow, paymentsOf, paymongoPaid, q, receipts } from "./support/customer-payments";

const NOW = new Date("2026-10-23T12:00:00Z");
const f = fakePaymongo();

beforeAll(() => {
  setAdapterForTests("paymongo", createPaymongoProvider({ http: f.http }));
  process.env.CUSTOMER_PAYMENTS_WRITES_ENABLED = "true";
  process.env.CUSTOMER_PAYMENTS_LIVE_ENABLED = "true";
  resetEnvCache();
});
afterAll(() => {
  setAdapterForTests("paymongo", null);
  delete process.env.CUSTOMER_PAYMENTS_WRITES_ENABLED;
  delete process.env.CUSTOMER_PAYMENTS_LIVE_ENABLED;
  resetEnvCache();
});
afterEach(() => {
  simulatedPlatform.reset();
  f.calls.length = 0;
});

const answerPaymongo = () => f.on((r) => r.method === "POST", { status: 200, json: { data: { id: "cs_real_1", attributes: { checkout_url: "https://checkout.paymongo.com/cs_real_1_client_x" } } } });
const start = (io: InvoiceOrg, invoiceId: string, audience: "public" | "member", onlyMode?: "test" | "live") =>
  startCheckout({ orgId: io.orgId, invoiceId, audience, actorUserId: audience === "member" ? io.c.people.owner.id : undefined, onlyMode }, { now: NOW });
const attemptsOf = (invoiceId: string) => q<{ status: string }>("select status from customer_payment_attempts where invoice_id = $1", [invoiceId]);

describe("making a test invoice", () => {
  it("is the owner's alone to do or undo, and the mark is fixed from the moment the invoice is issued", async () => {
    const io = await invoiceOrg();
    const contactId = await contactIn(io);
    const body = { contactId, currency: "PHP", lines: [line()] };
    await expect(createDraft(io.ctx("sales"), { ...body, isTest: true })).rejects.toMatchObject({ code: "forbidden" });
    await expect(createDraft(io.ctx("manager"), { ...body, isTest: true })).rejects.toMatchObject({ code: "forbidden" });
    expect((await createDraft(io.ctx("owner"), { ...body, isTest: true })).invoice.isTest).toBe(true);
    expect((await createDraft(io.ctx("owner"), body)).invoice.isTest).toBe(false);

    // Someone who writes invoices cannot use the mark to take a real invoice out of what is owed, and sending the mark a draft already has is not a change.
    const real = await createDraft(io.ctx("sales"), body);
    await expect(updateDraft(io.ctx("sales"), real.invoice.id, { isTest: true }, real.invoice.version)).rejects.toMatchObject({ code: "forbidden" });
    const same = await updateDraft(io.ctx("sales"), real.invoice.id, { isTest: false, notes: "No change of mark" }, real.invoice.version);
    expect(same.invoice.isTest).toBe(false);
    const flipped = await updateDraft(io.ctx("owner"), real.invoice.id, { isTest: true }, same.invoice.version);
    expect(flipped.invoice).toMatchObject({ isTest: true, version: same.invoice.version + 1 });
    // The author cannot take it off again, either.
    await expect(updateDraft(io.ctx("sales"), real.invoice.id, { isTest: false }, flipped.invoice.version)).rejects.toMatchObject({ code: "forbidden" });
    const back = await updateDraft(io.ctx("owner"), real.invoice.id, { isTest: false }, flipped.invoice.version);
    expect(back.invoice.isTest).toBe(false);

    // Issued, it is what it was: nothing can change it, and the database refuses a direct write too (tests/invoices-test-invoices-db.test.ts).
    const issued = await issueInvoice(io.ctx("owner"), back.invoice.id, { version: back.invoice.version }, { now: NOW });
    await expect(updateDraft(io.ctx("owner"), back.invoice.id, { isTest: true }, back.invoice.version)).rejects.toMatchObject({ code: "conflict" });
    expect(issued.detail.invoice.isTest).toBe(false);
  });

  it("never lets a test invoice close a deal, however it is asked for", async () => {
    const io = await invoiceOrg();
    const contactId = await contactIn(io);
    const dealId = await dealFor(io, contactId);
    const made = await createDraft(io.ctx("owner"), { opportunityId: dealId, currency: "PHP", lines: [line()], closesDeal: true, isTest: true });
    expect(made.invoice).toMatchObject({ isTest: true, closesDeal: false });
    const plain = await createDraft(io.ctx("owner"), { opportunityId: dealId, currency: "PHP", lines: [line()], closesDeal: true });
    expect(plain.invoice.closesDeal).toBe(true);
    const turned = await updateDraft(io.ctx("owner"), plain.invoice.id, { isTest: true }, plain.invoice.version);
    expect(turned.invoice).toMatchObject({ isTest: true, closesDeal: false });
  });

  it("numbers a test invoice from its own counter, so the real sequence has no gap for a test", async () => {
    const io = await invoiceOrg();
    const a = await issuedInvoice(io);
    const t1 = await issuedTestInvoice(io);
    const b = await issuedInvoice(io);
    const t2 = await issuedTestInvoice(io);
    expect([a, t1, b, t2].map((d) => d.invoice.number)).toEqual(["INV-0001", "TEST-0001", "INV-0002", "TEST-0002"]);
    const s = await getInvoiceSettings(io.ctx("owner"));
    expect(s.nextNumber).toBe(3);
    expect((await rows<{ next_test_number: string }>("select next_test_number::text from customer_invoice_settings where org_id = $1", [io.orgId]))[0].next_test_number).toBe("3");
    const issuedEvent = await rows<{ detail: { test?: boolean } }>("select detail from customer_invoice_events where invoice_id = $1 and kind = 'issued'", [t1.invoice.id]);
    expect(issuedEvent[0].detail.test).toBe(true);
  });

  it("is offered only while a payment account in test mode is connected, and only to the owner", async () => {
    const io = await invoiceOrg();
    expect(await hasTestConnection(io.ctx("owner"))).toBe(false);
    await connect(io, { provider: "simulated" });
    expect(await hasTestConnection(io.ctx("owner"))).toBe(true);
    expect(await hasTestConnection(io.ctx("manager"))).toBe(false);
    expect(await hasTestConnection(io.ctx("sales"))).toBe(false);
    await withSystem((db) => db.query("update customer_payment_connections set status = 'revoked' where org_id = $1", [io.orgId]));
    expect(await hasTestConnection(io.ctx("owner"))).toBe(false);
  });
});

describe("test money and real money are never on the same invoice", () => {
  it("refuses a payment made in test mode on a real invoice, and anything live on a test invoice, with nothing recorded", async () => {
    const io = await invoiceOrg();
    const real = (await issuedInvoice(io)).invoice;
    const test = (await issuedTestInvoice(io)).invoice;
    const conn = await connectionFor(io);
    await expect(providerPayment(io, real.id, conn, 150000, { livemode: false })).rejects.toThrow(/only a test invoice takes one/);
    await expect(providerPayment(io, test.id, conn, 150000, { livemode: true })).rejects.toThrow(/takes only payments made in a payment provider's test mode/);
    await expect(recordManualPayment(io.ctx("owner"), test.id, { amount: "1500", receivedOn: "2026-10-23", method: "cash", evidence: "Cash, receipt 12" }, { now: NOW })).rejects.toThrow(/test invoice: nothing is owed on it/);
    expect(await q("select 1 from customer_payments where invoice_id = any($1::uuid[])", [[real.id, test.id]])).toEqual([]);
    expect(await invoiceNow(real.id)).toMatchObject({ payment_status: "unpaid", paid_minor: "0" });
    expect(await invoiceNow(test.id)).toMatchObject({ payment_status: "unpaid", paid_minor: "0" });
    // The matching pairs are taken.
    expect((await providerPayment(io, test.id, conn, 150000)).counted).toBe(true);
    expect((await providerPayment(io, real.id, conn, 150000)).counted).toBe(true);
    expect((await q<{ livemode: boolean }>("select livemode from customer_payments where invoice_id = $1", [test.id]))[0].livemode).toBe(false);
    expect((await q<{ livemode: boolean }>("select livemode from customer_payments where invoice_id = $1", [real.id]))[0].livemode).toBe(true);
  });

  it("refuses a refund or a dispute on a test invoice: no money moved, so there is nothing to give back or fight", async () => {
    const io = await invoiceOrg();
    const test = (await issuedTestInvoice(io)).invoice;
    const paid = await providerPayment(io, test.id, await connectionFor(io), 150000);
    await expect(recordRefund(io.ctx("owner"), paid.paymentId, { amount: "10.00", reason: "A test refund" })).rejects.toThrow(/test invoice: no money moved, so there is nothing to refund/);
    await expect(recordDisputeOpened(io.ctx("owner"), paid.paymentId, {})).rejects.toThrow(/test invoice: no money moved/);
    expect(await q("select 1 from customer_refunds where invoice_id = $1", [test.id])).toEqual([]);
  });

  it("rejects a test-mode delivery for a real invoice's checkout and a live one for a test invoice's, and records neither", async () => {
    // With provider calls off the signed delivery stands alone (no read-back), which is the path being pinned here.
    delete process.env.CUSTOMER_PAYMENTS_WRITES_ENABLED;
    resetEnvCache();
    const io = await invoiceOrg();
    const real = (await issuedInvoice(io)).invoice;
    const test = (await issuedTestInvoice(io)).invoice;
    const sandbox = await connect(io, { provider: "paymongo", mode: "test" });
    const a = await attempt(real.id, sandbox);
    const out = await deliver(sandbox, paymongoPaid({ checkoutId: a.checkoutId as string, reference: a.reference, amount: a.amountMinor, livemode: false }));
    expect(out.outcome).toBe("rejected");
    expect((await receipts(sandbox.id))[0]).toMatchObject({ outcome: "rejected", detail: { note: expect.stringMatching(/only a test invoice takes one/) } });
    expect(await paymentsOf(real.id)).toEqual([]);
    expect(await invoiceNow(real.id)).toMatchObject({ payment_status: "unpaid", paid_minor: "0" });

    // The other way round, on another workspace's live account.
    const other = await invoiceOrg();
    const otherTest = (await issuedTestInvoice(other)).invoice;
    const live = await connect(other, { provider: "paymongo", mode: "live", liveConfirmed: true });
    const b = await attempt(otherTest.id, live);
    const liveOut = await deliver(live, paymongoPaid({ checkoutId: b.checkoutId as string, reference: b.reference, amount: b.amountMinor, livemode: true }));
    expect(liveOut.outcome).toBe("rejected");
    expect((await receipts(live.id))[0]).toMatchObject({ outcome: "rejected", detail: { note: expect.stringMatching(/live payment cannot be recorded on a test invoice/) } });
    expect(await paymentsOf(otherTest.id)).toEqual([]);

    // The matching pairs go through: a test-mode delivery for a test invoice's checkout is a test payment.
    const c = await attempt(test.id, sandbox);
    expect((await deliver(sandbox, paymongoPaid({ checkoutId: c.checkoutId as string, reference: c.reference, amount: c.amountMinor, livemode: false }))).outcome).toBe("processed");
    expect(await paymentsOf(test.id)).toEqual([expect.objectContaining({ status: "succeeded", livemode: false })]);
    process.env.CUSTOMER_PAYMENTS_WRITES_ENABLED = "true";
    resetEnvCache();
  });
});

describe("what a checkout may be started through", () => {
  it("sends a real invoice to a live account and a test invoice to an account in test mode, and never the other way round", async () => {
    const io = await invoiceOrg();
    const real = (await issuedInvoice(io)).invoice;
    const test = (await issuedTestInvoice(io)).invoice;
    await connect(io, { provider: "paymongo", mode: "live", liveConfirmed: true });
    await connect(io, { provider: "simulated" });
    answerPaymongo();
    const realStart = await start(io, real.id, "member");
    expect(realStart.provider).toBe("paymongo");
    expect(f.calls).toHaveLength(1);
    const testStart = await start(io, test.id, "member");
    expect(testStart.provider).toBe("simulated");
    // A customer who opens a test invoice's link is sent to the testing checkout too, never to the live account.
    await q("update customer_payment_attempts set status = 'cancelled' where id = $1", [testStart.attemptId]);
    expect((await start(io, test.id, "public")).provider).toBe("simulated");
    expect(f.calls).toHaveLength(1);
  });

  it("refuses a test invoice when only a live account is connected, without asking the provider", async () => {
    const io = await invoiceOrg();
    const test = (await issuedTestInvoice(io)).invoice;
    await connect(io, { provider: "paymongo", mode: "live", liveConfirmed: true });
    answerPaymongo();
    await expect(start(io, test.id, "member")).rejects.toThrow(/No payment account in test mode is connected/);
    await expect(start(io, test.id, "public")).rejects.toMatchObject({ code: "unavailable" });
    expect(f.calls).toEqual([]);
    expect(await attemptsOf(test.id)).toEqual([]);
  });

  it("refuses a real invoice when only an account in test mode is connected, for the team and for a customer", async () => {
    const io = await invoiceOrg();
    const real = (await issuedInvoice(io)).invoice;
    await connect(io, { provider: "simulated" });
    await connect(io, { provider: "paymongo", mode: "test" });
    await expect(start(io, real.id, "member")).rejects.toThrow(/real invoice, and the payment account connected is in test mode/);
    await expect(start(io, real.id, "public")).rejects.toMatchObject({ code: "unavailable" });
    expect(await attemptsOf(real.id)).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it("makes Pay as a test a test invoice's alone: a real invoice is refused before anything is asked of the provider", async () => {
    const io = await invoiceOrg();
    const real = (await issuedInvoice(io)).invoice;
    const test = (await issuedTestInvoice(io)).invoice;
    await connect(io, { provider: "simulated" });
    await expect(startTestPayment(io.ctx("owner"), real.id, { now: NOW })).rejects.toThrow(/only for a test invoice, and this is a real one/);
    expect(await attemptsOf(real.id)).toEqual([]);
    const ok = await startTestPayment(io.ctx("owner"), test.id, { now: NOW });
    expect(ok.url).toMatch(/^\/dev\/simulated-checkout\//);
    await expect(startTestPayment(io.ctx("manager"), test.id, { now: NOW })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("opens the testing checkout for a test invoice's checkout only", async () => {
    const io = await invoiceOrg();
    const real = (await issuedInvoice(io)).invoice;
    const test = (await issuedTestInvoice(io)).invoice;
    const sim = await connect(io, { provider: "simulated" });
    const onReal = await attempt(real.id, sim);
    const onTest = await attempt(test.id, sim);
    expect(await loadSimulatedAttempt(onReal.id)).toBeNull();
    expect(await loadSimulatedAttempt(onTest.id)).toMatchObject({ attemptId: onTest.id, invoiceNumber: "TEST-0001" });
  });

  it("goes the whole way as a test: the testing checkout pays a test invoice, which reads as a test everywhere and counts as no revenue", async () => {
    const io = await invoiceOrg();
    const test = (await issuedTestInvoice(io)).invoice;
    await connect(io, { provider: "simulated" });
    const started = await start(io, test.id, "public");
    const done = await completeSimulatedCheckout(started.attemptId, "pay", { origin: "http://localhost:3000" });
    expect(done.delivered).toBe(200);
    expect(await paymentsOf(test.id)).toEqual([expect.objectContaining({ status: "succeeded", livemode: false })]);
    expect(await invoiceNow(test.id)).toMatchObject({ payment_status: "paid", paid_minor: "150000" });
    const back = await loadReturn(done.reference, { ip: freshIp() });
    expect(back.state === "ok" && back.view).toMatchObject({ isTest: true, description: { state: "received", headline: "The test payment went through" } });
    const notice = await rows<{ title: string; body: string }>("select title, body from notifications where org_id = $1 and kind = 'invoice_paid'", [io.orgId]);
    expect(notice.length).toBeGreaterThan(0);
    expect(notice.every((n) => /as a test/.test(n.title) && /no money moved/.test(n.body))).toBe(true);
  });
});

describe("the customer's page for a test invoice", () => {
  it("says it is a test first, offers the testing checkout and nothing live, and is never called overdue", async () => {
    const io = await invoiceOrg();
    const test = (await issuedTestInvoice(io, { dueOn: "2026-10-24" }, NOW)).invoice;
    await connect(io, { provider: "simulated" });
    const res = await loadPublicInvoice(await linkTokenOf(io, test.id), { ip: freshIp(), now: new Date("2026-12-01T00:00:00Z") });
    expect(res.state === "ok" && res.invoice).toMatchObject({ isTest: true, number: "TEST-0001", banner: { kind: "test" }, canPayOnline: true });
  });

  it("offers no way to pay a test invoice online when only a test-mode PayMongo account exists (customers are never sent there), and none for a real invoice through a test account", async () => {
    const io = await invoiceOrg();
    const test = (await issuedTestInvoice(io)).invoice;
    const real = (await issuedInvoice(io)).invoice;
    await connect(io, { provider: "paymongo", mode: "test" });
    const t = await loadPublicInvoice(await linkTokenOf(io, test.id), { ip: freshIp() });
    expect(t.state === "ok" && t.invoice).toMatchObject({ isTest: true, canPayOnline: false, banner: { kind: "test" } });
    const other = await invoiceOrg();
    const otherReal = (await issuedInvoice(other)).invoice;
    await connect(other, { provider: "simulated" });
    const r = await loadPublicInvoice(await linkTokenOf(other, otherReal.id), { ip: freshIp() });
    expect(r.state === "ok" && r.invoice).toMatchObject({ isTest: false, canPayOnline: false, banner: { kind: "pay_other_way" } });
    const plain = await loadPublicInvoice(await linkTokenOf(io, real.id), { ip: freshIp() });
    expect(plain.state === "ok" && plain.invoice.isTest).toBe(false);
  });
});

describe("what a test invoice is kept out of", () => {
  it("leaves it out of what is owed, overdue and received, and says how many are kept apart", async () => {
    const io = await invoiceOrg();
    await issuedInvoice(io, { dueOn: "2026-10-05" }, new Date("2026-10-01T12:00:00Z"));
    const t = (await issuedTestInvoice(io, { dueOn: "2026-10-05" }, new Date("2026-10-01T12:00:00Z"))).invoice;
    const usd = (await issuedTestInvoice(io, { currency: "USD" }, NOW)).invoice;
    const conn = await connectionFor(io);
    await providerPayment(io, usd.id, conn, 150000, { currency: "USD" });
    const summary = await receivablesSummary(io.ctx("owner"), { now: new Date("2026-11-01T00:00:00Z") });
    expect(summary.byCurrency).toEqual([expect.objectContaining({ currency: "PHP", outstandingMinor: 150000, openCount: 1, overdueMinor: 150000, overdueCount: 1, netReceivedMinor: 0 })]);
    expect(summary.byCurrency.some((r) => r.currency === "USD")).toBe(false);
    expect(summary.testInvoices).toBe(2);
    expect(t.id).toBeTruthy();
  });

  it("never calls a test invoice overdue, in the list, in a filter or in the sweep that raises the notice", async () => {
    const io = await invoiceOrg();
    const issuedAt = new Date("2026-10-01T12:00:00Z");
    const later = new Date("2026-11-20T12:00:00Z");
    const real = (await issuedInvoice(io, { dueOn: "2026-10-05" }, issuedAt)).invoice;
    const test = (await issuedTestInvoice(io, { dueOn: "2026-10-05" }, issuedAt)).invoice;
    const owner = io.ctx("owner");
    expect((await getInvoiceDetail(owner, real.id, { now: later })).invoice.overdue).toBe(true);
    expect((await getInvoiceDetail(owner, test.id, { now: later })).invoice).toMatchObject({ overdue: false, daysOverdue: 0 });
    expect((await listInvoices(owner, { overdueOnly: true }, { now: later })).map((i) => i.id)).toEqual([real.id]);
    expect((await listInvoices(owner, { tests: "only" })).map((i) => i.id)).toEqual([test.id]);
    expect((await listInvoices(owner, { tests: "exclude", status: ["issued"] })).map((i) => i.id)).toEqual([real.id]);
    await runInvoiceOverdueSweep({ now: later });
    const marked = async (id: string) => (await rows("select 1 from customer_invoice_events where invoice_id = $1 and kind = 'overdue'", [id])).length;
    expect(await marked(real.id)).toBe(1);
    expect(await marked(test.id)).toBe(0);
  });

  it("does not act on a deal when a test invoice is paid, whatever the owner's rule says", async () => {
    const io = await invoiceOrg();
    const cur = await getInvoiceSettings(io.ctx("owner"));
    await saveInvoiceSettings(io.ctx("owner"), { closeRule: "task" }, cur.version);
    const contactId = await contactIn(io);
    const dealId = await dealFor(io, contactId);
    const made = await createDraft(io.ctx("owner"), { opportunityId: dealId, currency: "PHP", lines: [line()], isTest: true });
    const issued = (await issueInvoice(io.ctx("owner"), made.invoice.id, { version: made.invoice.version }, { now: NOW })).detail.invoice;
    await providerPayment(io, issued.id, await connectionFor(io), 150000);
    expect(await runCloseRule(io.orgId, issued.id)).toMatchObject({ decision: { action: "none", reason: "test_invoice" } });
    await runCustomerPaymentReconcileDetailed({ now: NOW });
    expect(await rows("select 1 from tasks where opportunity_id = $1", [dealId])).toEqual([]);
    expect((await rows<{ status: string }>("select status from crm_opportunities where id = $1", [dealId]))[0].status).toBe("open");
    expect(await rows("select 1 from customer_invoice_events where invoice_id = $1 and kind = 'close_rule_applied'", [issued.id])).toEqual([]);
  });

  it("starts no automation from a test invoice and labels its lines on the customer's timeline", async () => {
    const io = await invoiceOrg();
    const contactId = await contactIn(io);
    const real = (await issuedInvoice(io, { contactId })).invoice;
    const test = (await issuedTestInvoice(io, { contactId })).invoice;
    await providerPayment(io, test.id, await connectionFor(io), 150000);
    const events = (id: string) => rows<{ type: string }>("select type from crm_events where org_id = $1 and entity_type = 'invoice' and entity_id = $2", [io.orgId, id]);
    expect((await events(real.id)).map((e) => e.type)).toContain("invoice.issued");
    expect(await events(test.id)).toEqual([]);
    const lines = await rows<{ summary: string }>("select summary from crm_activities where org_id = $1 and ref_type = 'invoice' and ref_id = $2", [io.orgId, test.id]);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => /a test invoice: nothing is owed/.test(l.summary))).toBe(true);
  });

  it("is never reminded about: no reminder is planned for it, though the owner's reminders are on and a real invoice gets its days", async () => {
    const io = await invoiceOrg();
    await addMessaging(io);
    const overview = await getReminderOverview(io.ctx("owner"), { now: NOW });
    await authorizeReminders(io.ctx("owner"), { wordingHash: overview.wordingHash, settingsVersion: overview.settingsVersion }, { now: NOW });
    const real = (await issuedInvoice(io, {}, NOW)).invoice;
    const test = (await issuedTestInvoice(io, {}, NOW)).invoice;
    const planned = (id: string) => rows<{ step_key: string }>("select step_key from customer_invoice_reminders where invoice_id = $1", [id]);
    expect((await planned(real.id)).length).toBeGreaterThan(0);
    expect(await planned(test.id)).toEqual([]);
  });
});

describe("voiding and deleting a test invoice", () => {
  it("voids it with a test payment on it and a checkout still open, and its link stops working; a real invoice that took money still cannot be voided", async () => {
    const io = await invoiceOrg();
    const test = (await issuedTestInvoice(io, {}, NOW)).invoice;
    const real = (await issuedInvoice(io, {}, NOW)).invoice;
    const sim = await connect(io, { provider: "simulated" });
    await providerPayment(io, test.id, sim.id, 50000);
    await attempt(test.id, sim, { status: "redirected" });
    const token = await linkTokenOf(io, test.id);
    const voided = await voidInvoice(io.ctx("manager"), test.id, { reason: "Only a test of the payment account" });
    expect(voided.invoice).toMatchObject({ status: "void", isTest: true });
    expect(await attemptsOf(test.id)).toEqual([{ status: "cancelled" }]);
    expect((await loadPublicInvoice(token, { ip: freshIp() })).state).toBe("invalid");
    await providerPayment(io, real.id, sim.id, 50000);
    await expect(voidInvoice(io.ctx("owner"), real.id, { reason: "Trying to hide money" })).rejects.toThrow(/payment recorded against it/);
  });

  it("deletes a test invoice with its test payments, checkouts and timeline lines, for the owner only, and never a real invoice", async () => {
    const io = await invoiceOrg();
    const contactId = await contactIn(io);
    const test = (await issuedTestInvoice(io, { contactId }, NOW)).invoice;
    const real = (await issuedInvoice(io, { contactId }, NOW)).invoice;
    const sim = await connect(io, { provider: "simulated" });
    await providerPayment(io, test.id, sim.id, 50000);
    await attempt(test.id, sim, { status: "expired" });
    await expect(deleteTestInvoice(io.ctx("manager"), test.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(deleteTestInvoice(io.ctx("owner"), real.id)).rejects.toThrow(/Only a test invoice can be deleted/);
    const stranger = await invoiceOrg();
    await expect(deleteTestInvoice(stranger.ctx("owner"), test.id)).rejects.toMatchObject({ code: "not_found" });
    expect((await rows("select 1 from customer_invoices where id = any($1::uuid[])", [[test.id, real.id]])).length).toBe(2);

    const done = await deleteTestInvoice(io.ctx("owner"), test.id);
    expect(done).toEqual({ number: "TEST-0001", payments: 1, refunds: 0, checkouts: 1 });
    for (const table of ["customer_invoices", "customer_payments", "customer_payment_attempts", "customer_invoice_lines", "customer_invoice_events"]) {
      const col = table === "customer_invoices" ? "id" : "invoice_id";
      expect(await rows(`select 1 from ${table} where ${col} = $1`, [test.id]), table).toEqual([]);
    }
    expect(await rows("select 1 from crm_activities where org_id = $1 and ref_type = 'invoice' and ref_id = $2", [io.orgId, test.id])).toEqual([]);
    expect((await rows("select 1 from crm_activities where org_id = $1 and ref_type = 'invoice' and ref_id = $2", [io.orgId, real.id])).length).toBeGreaterThan(0);
    const audit = await rows<{ metadata: { number: string; payments: number } }>("select metadata from audit_logs where target_id = $1 and action = 'invoice.test_deleted'", [test.id]);
    expect(audit).toEqual([{ metadata: expect.objectContaining({ number: "TEST-0001", payments: 1 }) }]);
    // The real invoice, its link and its history are untouched.
    expect((await getInvoiceDetail(io.ctx("owner"), real.id)).invoice.number).toBe("INV-0001");
  });
});

describe("the database is the last word", () => {
  it("is not fooled by a hand-made payment: a service call that would put test money on a real invoice never reaches the table", async () => {
    const io = await invoiceOrg();
    const real = (await issuedInvoice(io)).invoice;
    const conn = await connectionFor(io);
    await expect(
      withSystem((db) => applyPaymentInTx(db, { orgId: io.orgId, invoiceId: real.id, amountMinor: 1000, currency: "PHP", provider: "simulated", verification: "provider_confirmed", connectionId: conn, providerPaymentId: "hand-made-1", livemode: false, receivedAt: NOW, actor: { id: null, kind: "provider" } })),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await q("select 1 from customer_payments where invoice_id = $1", [real.id])).toEqual([]);
  });
});
