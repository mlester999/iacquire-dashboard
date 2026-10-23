// Payments, refunds and disputes against invoices on embedded Postgres: what counts as paid, what never does, that recording the same thing twice records it once, and
// that the books of the business's customers never mix with iAcquire's own.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { applyDisputeInTx, applyPaymentInTx, applyRefundInTx, recomputeInvoice, settlePaymentInTx, COUNTED_STATUSES } from "@/server/invoices/apply";
import { getInvoiceDetail, voidInvoice } from "@/server/invoices/invoices";
import { recordManualPayment, recordRefund } from "@/server/invoices/payments";
import { getFinancialReport } from "@/server/billing/finance";
import { resolvePeriod } from "@/lib/finance";
import { derivePaymentStatus } from "@/lib/invoices/state";
import { taxPortion, type CurrencyCode } from "@/lib/money";
import { connectionFor, draftBy, invoiceOrg, issuedInvoice, line, providerPayment, rows, type InvoiceOrg } from "./support/invoices";
import { uid } from "./support/fixtures";

const NOW = new Date("2026-10-23T12:00:00Z");
const pay = { receivedOn: "2026-10-23", method: "bank_transfer" as const, evidence: "Bank transfer ref 7731" };
/** What the owner was told (the owner and the manager are each told, so one event is one notice per person). */
const notes = (io: InvoiceOrg, kind: string) => rows<{ title: string; body: string | null }>("select title, body from notifications where org_id = $1 and kind = $2 and user_id = $3 order by created_at", [io.orgId, kind, io.c.people.owner.id]);
const kinds = async (invoiceId: string) => (await rows<{ kind: string }>("select kind from customer_invoice_events where invoice_id = $1 order by id", [invoiceId])).map((e) => e.kind);
const invoiceRow = async (id: string) => (await rows<{ paid_minor: string; refunded_minor: string; balance_minor: string; overpaid_minor: string; payment_status: string }>("select paid_minor::text, refunded_minor::text, balance_minor::text, overpaid_minor::text, payment_status from customer_invoices where id = $1", [id]))[0];

describe("recording a payment received outside the product", () => {
  it("counts it, keeps it as the person's own record with its evidence, and says so on the invoice", async () => {
    const io = await invoiceOrg();
    const inv = (await issuedInvoice(io, {}, NOW)).invoice;
    const partial = await recordManualPayment(io.ctx("manager"), inv.id, { ...pay, amount: "500.00" }, { now: NOW });
    expect(partial).toMatchObject({ duplicate: false, justPaid: false, invoice: { paidMinor: 50000, balanceMinor: 100000, paymentStatus: "partially_paid" }, closeRule: { decision: { action: "none" } } });
    const full = await recordManualPayment(io.ctx("owner"), inv.id, { ...pay, amount: "1000", method: "cash", evidence: "Cash handed to Sam, receipt 88" }, { now: NOW });
    expect(full).toMatchObject({ justPaid: true, invoice: { paidMinor: 150000, balanceMinor: 0, paymentStatus: "paid" } });
    const detail = await getInvoiceDetail(io.ctx("owner"), inv.id);
    expect(detail.invoice).toMatchObject({ paymentStatus: "paid", paidMinor: 150000, balanceMinor: 0, overpaidMinor: 0 });
    expect(detail.payments.map((p) => [p.provider, p.verification, p.method, p.status, p.livemode, p.amountMinor])).toEqual([["manual", "manual", "bank_transfer", "succeeded", true, 50000], ["manual", "manual", "cash", "succeeded", true, 100000]]);
    expect(detail.payments[1].evidence).toBe("Cash handed to Sam, receipt 88");
    expect(detail.payments[1].recordedByName).toBeTruthy();
    expect(await kinds(inv.id)).toEqual(["created", "issued", "manual_payment_recorded", "manual_payment_recorded", "paid"]);
    const paid = await notes(io,"invoice_paid");
    expect(paid).toHaveLength(1);
    expect(paid[0].title).toBe("INV-0001 was paid");
    expect(paid[0].body).toMatch(/recorded by hand/);
    const audit = await rows<{ metadata: Record<string, unknown> }>("select metadata from audit_logs where target_id = $1 and action = 'invoice.payment_recorded' order by created_at", [inv.id]);
    expect(audit).toHaveLength(2);
    expect(audit[0].metadata).toMatchObject({ amount: "500.00", currency: "PHP", method: "bank_transfer", number: "INV-0001" });
    expect(JSON.stringify(audit)).not.toContain("7731");
  });

  it("needs a permission, an issued invoice, a real day that is not in the future, a plausible amount and no card number", async () => {
    const io = await invoiceOrg();
    const inv = (await issuedInvoice(io, {}, NOW)).invoice;
    for (const who of ["sales", "viewer", "support", "member"] as const) {
      await expect(recordManualPayment(io.ctx(who), inv.id, { ...pay, amount: "10" }, { now: NOW }), who).rejects.toThrow(/Only the business owner or a manager can record a payment/);
    }
    await expect(recordManualPayment(io.ctx("owner"), inv.id, { ...pay, amount: "10", evidence: "ok" }, { now: NOW })).rejects.toThrow();
    await expect(recordManualPayment(io.ctx("owner"), inv.id, { ...pay, amount: "10", method: "barter" }, { now: NOW })).rejects.toThrow();
    await expect(recordManualPayment(io.ctx("owner"), inv.id, { ...pay, amount: "0" }, { now: NOW })).rejects.toThrow(/more than zero/);
    await expect(recordManualPayment(io.ctx("owner"), inv.id, { ...pay, amount: "ten pesos" }, { now: NOW })).rejects.toThrow(/Enter an amount/);
    await expect(recordManualPayment(io.ctx("owner"), inv.id, { ...pay, amount: "10.001" }, { now: NOW })).rejects.toThrow(/decimal/);
    await expect(recordManualPayment(io.ctx("owner"), inv.id, { ...pay, amount: "10", receivedOn: "2026-10-24" }, { now: NOW })).rejects.toThrow(/future/);
    await expect(recordManualPayment(io.ctx("owner"), inv.id, { ...pay, amount: "10", receivedOn: "2026-02-30" }, { now: NOW })).rejects.toThrow();
    await expect(recordManualPayment(io.ctx("owner"), inv.id, { ...pay, amount: "10", evidence: "Visa 4242 4242 4242 4242 paid" }, { now: NOW })).rejects.toThrow(/card number/);
    const draft = await draftBy(io);
    await expect(recordManualPayment(io.ctx("owner"), draft.invoice.id, { ...pay, amount: "10" }, { now: NOW })).rejects.toThrow(/Only an issued invoice can take a payment/);
    expect(await rows("select 1 from customer_payments where org_id = $1", [io.orgId])).toHaveLength(0);
    await voidInvoice(io.ctx("owner"), inv.id, { reason: "Raised by mistake" });
    await expect(recordManualPayment(io.ctx("owner"), inv.id, { ...pay, amount: "10" }, { now: NOW })).rejects.toThrow(/void/);
    // The day the payment arrived is in the workspace's zone: the 24th is today in Manila, tomorrow in UTC.
    const manila = await invoiceOrg({ timezone: "Asia/Manila" });
    const mi = (await issuedInvoice(manila, {}, NOW)).invoice;
    await expect(recordManualPayment(manila.ctx("owner"), mi.id, { ...pay, amount: "10", receivedOn: "2026-10-24" }, { now: new Date("2026-10-23T17:00:00Z") })).resolves.toMatchObject({ duplicate: false });
  });

  it("refuses more than is owed unless the person says it was, then keeps the difference visible and tells the owner", async () => {
    const io = await invoiceOrg();
    const inv = (await issuedInvoice(io, {}, NOW)).invoice;
    await expect(recordManualPayment(io.ctx("owner"), inv.id, { ...pay, amount: "1500.01" }, { now: NOW })).rejects.toThrow(/more than is owed \(PHP 1,500\.00\)/);
    const over = await recordManualPayment(io.ctx("owner"), inv.id, { ...pay, amount: "1600", allowOverpayment: true }, { now: NOW });
    expect(over.invoice).toMatchObject({ paidMinor: 160000, balanceMinor: 0, overpaidMinor: 10000, paymentStatus: "paid" });
    expect(await kinds(inv.id)).toEqual(["created", "issued", "manual_payment_recorded", "paid", "overpaid"]);
    const review = await notes(io,"payment_review_needed");
    expect(review).toHaveLength(1);
    expect(review[0].body).toMatch(/PHP 100\.00 more than the invoice total.*Nothing was refunded/);
    // Once it is paid in full another payment needs the same say-so.
    await expect(recordManualPayment(io.ctx("owner"), inv.id, { ...pay, amount: "5" }, { now: NOW })).rejects.toThrow(/already paid in full/);
  });

  it("records the same request once: a double click, a reloaded form, even after the first made the invoice paid", async () => {
    const io = await invoiceOrg();
    const inv = (await issuedInvoice(io, {}, NOW)).invoice;
    const key = `form-${uid()}-${uid()}`;
    const first = await recordManualPayment(io.ctx("owner"), inv.id, { ...pay, amount: "1500", idempotencyKey: key }, { now: NOW });
    const [again, third] = await Promise.all([recordManualPayment(io.ctx("owner"), inv.id, { ...pay, amount: "1500", idempotencyKey: key }, { now: NOW }), recordManualPayment(io.ctx("owner"), inv.id, { ...pay, amount: "1500", idempotencyKey: key }, { now: NOW })]);
    expect(first.duplicate).toBe(false);
    expect([again.duplicate, third.duplicate]).toEqual([true, true]);
    expect(again.paymentId).toBe(first.paymentId);
    expect(await rows("select 1 from customer_payments where invoice_id = $1", [inv.id])).toHaveLength(1);
    expect((await invoiceRow(inv.id)).paid_minor).toBe("150000");
    expect(await notes(io,"invoice_paid")).toHaveLength(1);
    expect((await kinds(inv.id)).filter((k) => k === "manual_payment_recorded")).toHaveLength(1);
    // The key belongs to one invoice: using it for another is refused, not silently merged.
    const other = (await issuedInvoice(io, {}, NOW)).invoice;
    await expect(recordManualPayment(io.ctx("owner"), other.id, { ...pay, amount: "10", idempotencyKey: key }, { now: NOW })).rejects.toThrow(/different invoice|Only|already/);
  });

  it("will not record it by hand while a customer may be paying online, unless the person says it is a different payment", async () => {
    const io = await invoiceOrg();
    const conn = await connectionFor(io);
    const inv = (await issuedInvoice(io, {}, NOW)).invoice;
    await withSystem((db) => db.query("insert into customer_payment_attempts (org_id, invoice_id, connection_id, currency, amount_minor, reference, status) values ($1, $2, $3, 'PHP', 150000, 'CP-' || substr(md5(random()::text), 1, 24), 'redirected')", [io.orgId, inv.id, conn]));
    await expect(recordManualPayment(io.ctx("owner"), inv.id, { ...pay, amount: "100" }, { now: NOW })).rejects.toThrow(/may be paying this invoice online/);
    await expect(recordManualPayment(io.ctx("owner"), inv.id, { ...pay, amount: "100", overrideOpenAttempt: true }, { now: NOW })).resolves.toMatchObject({ duplicate: false });
  });

  it("works out the tax in each payment in proportion, once, and never counts money beyond the balance as tax", async () => {
    const io = await invoiceOrg();
    const inv = (await issuedInvoice(io, { lines: [line({ unitPrice: "1000.00", taxPercent: "12" })] }, NOW)).invoice;
    expect(inv).toMatchObject({ totalMinor: 112000, taxMinor: 12000 });
    await recordManualPayment(io.ctx("owner"), inv.id, { ...pay, amount: "560" }, { now: NOW });
    await recordManualPayment(io.ctx("owner"), inv.id, { ...pay, amount: "700", allowOverpayment: true }, { now: NOW });
    const p = await rows<{ amount_minor: string; tax_portion_minor: string }>("select amount_minor::text, tax_portion_minor::text from customer_payments where invoice_id = $1 order by created_at", [inv.id]);
    expect(p.map((x) => [x.amount_minor, x.tax_portion_minor])).toEqual([["56000", String(taxPortion(56000, 12000, 112000))], ["70000", String(taxPortion(56000, 12000, 112000))]]);
    expect(taxPortion(56000, 12000, 112000)).toBe(6000);
    expect(Number(p[0].tax_portion_minor) + Number(p[1].tax_portion_minor)).toBe(12000);
  });

  it("is not available for another workspace's invoice, and says the same as for one that does not exist", async () => {
    const a = await invoiceOrg();
    const b = await invoiceOrg();
    const inv = (await issuedInvoice(a, {}, NOW)).invoice;
    await expect(recordManualPayment(b.ctx("owner"), inv.id, { ...pay, amount: "10" }, { now: NOW })).rejects.toThrow(/That invoice was not found/);
    await expect(recordManualPayment(a.ctx("owner"), "00000000-0000-4000-8000-000000000000", { ...pay, amount: "10" }, { now: NOW })).rejects.toThrow(/That invoice was not found/);
    expect((await invoiceRow(inv.id)).paid_minor).toBe("0");
  });
});

describe("a payment a provider confirmed", () => {
  it("is recorded once per provider payment id, however many times and however concurrently it arrives", async () => {
    const io = await invoiceOrg();
    const conn = await connectionFor(io);
    const inv = (await issuedInvoice(io, {}, NOW)).invoice;
    const input = { providerPaymentId: `pay_${uid()}` };
    const results = await Promise.all([providerPayment(io, inv.id, conn, 50000, input), providerPayment(io, inv.id, conn, 50000, input), providerPayment(io, inv.id, conn, 50000, input)]);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(new Set(results.map((r) => r.paymentId)).size).toBe(1);
    expect(await rows("select 1 from customer_payments where invoice_id = $1", [inv.id])).toHaveLength(1);
    expect((await invoiceRow(inv.id)).paid_minor).toBe("50000");
    expect((await kinds(inv.id)).filter((k) => k === "payment_verified")).toHaveLength(1);
    // Another connection may reuse a provider's id: it is a different payment.
    const other = await connectionFor(io, { provider: "paypal" });
    await providerPayment(io, inv.id, other, 10000, input);
    expect((await invoiceRow(inv.id)).paid_minor).toBe("60000");
  });

  it("adds up several payments to paid, keeps test-mode payments marked, and counts a second checkout's duplicate money as an overpayment, never as more revenue than was received", async () => {
    const io = await invoiceOrg();
    const conn = await connectionFor(io);
    const inv = (await issuedInvoice(io, {}, NOW)).invoice;
    const first = await providerPayment(io, inv.id, conn, 100000);
    expect(first).toMatchObject({ counted: true, justPaid: false, invoice: { paymentStatus: "partially_paid" } });
    const second = await providerPayment(io, inv.id, conn, 50000);
    expect(second).toMatchObject({ justPaid: true, invoice: { paymentStatus: "paid", paidMinor: 150000, overpaidMinor: 0 } });
    const dup = await providerPayment(io, inv.id, conn, 150000);
    expect(dup).toMatchObject({ justPaid: false, invoice: { paidMinor: 300000, balanceMinor: 0, overpaidMinor: 150000, paymentStatus: "paid" } });
    expect((await notes(io,"invoice_paid"))).toHaveLength(1);
    expect((await notes(io,"payment_review_needed")).map((n) => n.title)).toEqual([expect.stringMatching(/paid more than it was for/)]);
    const flags = await rows<{ livemode: boolean; verification: string }>("select livemode, verification from customer_payments where invoice_id = $1", [inv.id]);
    expect(flags.every((f) => f.livemode === false && f.verification === "provider_confirmed")).toBe(true);
  });

  it("keeps a payment the provider has not confirmed, or that cannot be matched, without counting it, and tells the owner", async () => {
    const io = await invoiceOrg();
    const conn = await connectionFor(io);
    const inv = (await issuedInvoice(io, {}, NOW)).invoice;
    const pending = await providerPayment(io, inv.id, conn, 150000, { status: "pending" });
    expect(pending).toMatchObject({ status: "pending", counted: false, invoice: { paidMinor: 0, paymentStatus: "unpaid" } });
    const failed = await providerPayment(io, inv.id, conn, 150000, { status: "failed" });
    expect(failed).toMatchObject({ status: "failed", counted: false });
    expect((await invoiceRow(inv.id)).payment_status).toBe("unpaid");
    expect((await notes(io,"invoice_payment_failed"))).toHaveLength(1);
    // The pending one is settled by a later verified event; settling again changes nothing.
    const settled = await withSystem((db) => settlePaymentInTx(db, { orgId: io.orgId, paymentId: pending.paymentId, to: "succeeded", actor: { id: null, kind: "provider" } }));
    expect(settled).toMatchObject({ status: "succeeded", justPaid: true, invoice: { paymentStatus: "paid", paidMinor: 150000 } });
    const again = await withSystem((db) => settlePaymentInTx(db, { orgId: io.orgId, paymentId: pending.paymentId, to: "succeeded", actor: { id: null, kind: "provider" } }));
    expect(again.justPaid).toBe(false);
    expect((await invoiceRow(inv.id)).paid_minor).toBe("150000");
    // A failed payment stays failed.
    await expect(withSystem((db) => settlePaymentInTx(db, { orgId: io.orgId, paymentId: failed.paymentId, to: "succeeded", actor: { id: null, kind: "provider" } }))).resolves.toMatchObject({ status: "failed" });
  });

  it("never counts a payment for a voided or unissued invoice, keeps it for review and says so", async () => {
    const io = await invoiceOrg();
    const conn = await connectionFor(io);
    const voided = (await issuedInvoice(io, {}, NOW)).invoice;
    await voidInvoice(io.ctx("owner"), voided.id, { reason: "Wrong customer entirely" });
    const late = await providerPayment(io, voided.id, conn, 150000);
    expect(late).toMatchObject({ status: "needs_review", counted: false, reviewReason: "invoice_void", invoice: { status: "void", paidMinor: 0 } });
    const draft = (await draftBy(io)).invoice;
    const early = await providerPayment(io, draft.id, conn, 150000);
    expect(early).toMatchObject({ status: "needs_review", counted: false, reviewReason: "invoice_not_issued" });
    expect((await invoiceRow(voided.id)).paid_minor).toBe("0");
    expect((await invoiceRow(draft.id)).paid_minor).toBe("0");
    expect((await notes(io,"payment_review_needed")).map((n) => n.body)).toEqual(expect.arrayContaining([expect.stringMatching(/voided/), expect.stringMatching(/could not be matched/)]));
    // The payment of a voided invoice cannot be turned into a counted one later either.
    await expect(withSystem((db) => settlePaymentInTx(db, { orgId: io.orgId, paymentId: late.paymentId, to: "succeeded", actor: { id: null, kind: "provider" } }))).rejects.toThrow(/voided/);
  });

  it("refuses a payment in another currency, in another workspace's name, or with a key used for another invoice", async () => {
    const a = await invoiceOrg();
    const b = await invoiceOrg();
    const conn = await connectionFor(a);
    const inv = (await issuedInvoice(a, {}, NOW)).invoice;
    await expect(providerPayment(a, inv.id, conn, 1000, { currency: "USD" as CurrencyCode })).rejects.toThrow(/different currency/);
    await expect(providerPayment(b, inv.id, conn, 1000)).rejects.toThrow(/That invoice was not found/);
    await expect(withSystem((db) => applyPaymentInTx(db, { orgId: a.orgId, invoiceId: inv.id, amountMinor: 0, currency: "PHP", provider: "simulated", verification: "provider_confirmed", connectionId: conn, providerPaymentId: "p0", livemode: false, receivedAt: NOW, actor: { id: null, kind: "provider" } }))).rejects.toThrow(/more than zero/);
    await expect(withSystem((db) => applyPaymentInTx(db, { orgId: a.orgId, invoiceId: inv.id, amountMinor: 1.5, currency: "PHP", provider: "simulated", verification: "provider_confirmed", connectionId: conn, providerPaymentId: "p1", livemode: false, receivedAt: NOW, actor: { id: null, kind: "provider" } }))).rejects.toThrow(/whole number/);
    const other = (await issuedInvoice(a, {}, NOW)).invoice;
    await providerPayment(a, inv.id, conn, 1000, { idempotencyKey: "same-key-1234" });
    await expect(providerPayment(a, other.id, conn, 1000, { idempotencyKey: "same-key-1234" })).rejects.toThrow(/different invoice/);
    expect((await invoiceRow(other.id)).paid_minor).toBe("0");
  });

  it("applies two payments that arrive together one after the other, so the invoice adds up", async () => {
    const io = await invoiceOrg();
    const conn = await connectionFor(io);
    const inv = (await issuedInvoice(io, {}, NOW)).invoice;
    const all = await Promise.all([40000, 30000, 20000, 10000, 5000].map((n) => providerPayment(io, inv.id, conn, n)));
    expect(all.every((r) => r.counted)).toBe(true);
    expect(await invoiceRow(inv.id)).toMatchObject({ paid_minor: "105000", payment_status: "partially_paid", balance_minor: "45000" });
    const rec = await withSystem((db) => recomputeInvoice(db, io.orgId, inv.id));
    expect(rec).toMatchObject({ paidMinor: 105000, paymentStatus: "partially_paid" });
  });
});

describe("refunds", () => {
  it("reduce what was kept without re-opening the invoice: the invoice stays paid, the payment becomes part or fully refunded", async () => {
    const io = await invoiceOrg();
    const conn = await connectionFor(io);
    const inv = (await issuedInvoice(io, {}, NOW)).invoice;
    const p = await providerPayment(io, inv.id, conn, 150000);
    const r1 = await recordRefund(io.ctx("owner"), p.paymentId, { amount: "400", reason: "Part of the job was not done" });
    expect(r1).toMatchObject({ duplicate: false, invoice: { paymentStatus: "paid", paidMinor: 150000, refundedMinor: 40000, balanceMinor: 0 }, reviewTaskId: null });
    expect((await rows<{ status: string }>("select status from customer_payments where id = $1", [p.paymentId]))[0].status).toBe("partially_refunded");
    const r2 = await recordRefund(io.ctx("owner"), p.paymentId, { amount: "1100", reason: "Customer cancelled the rest" });
    expect(r2.invoice).toMatchObject({ refundedMinor: 150000, paymentStatus: "paid" });
    expect((await rows<{ status: string }>("select status from customer_payments where id = $1", [p.paymentId]))[0].status).toBe("refunded");
    await expect(recordRefund(io.ctx("owner"), p.paymentId, { amount: "1", reason: "One more peso" })).rejects.toThrow(/already refunded in full/);
    const detail = await getInvoiceDetail(io.ctx("owner"), inv.id);
    expect(detail.refunds.map((r) => [r.amountMinor, r.source, r.status])).toEqual([[40000, "manual_record", "succeeded"], [110000, "manual_record", "succeeded"]]);
    expect(detail.payments[0]).toMatchObject({ refundedMinor: 150000, status: "refunded" });
    expect(await kinds(inv.id)).toEqual(["created", "issued", "payment_verified", "paid", "refund_recorded", "refund_recorded"]);
    expect((await notes(io,"invoice_refund_recorded"))).toHaveLength(2);
  });

  it("are the owner's alone, need a reason, cannot be for more than is left or for money never received, and are recorded once per key or provider id", async () => {
    const io = await invoiceOrg();
    const conn = await connectionFor(io);
    const inv = (await issuedInvoice(io, {}, NOW)).invoice;
    const p = await providerPayment(io, inv.id, conn, 100000);
    for (const who of ["manager", "sales", "viewer"] as const) await expect(recordRefund(io.ctx(who), p.paymentId, { amount: "1", reason: "Not allowed" }), who).rejects.toThrow(/Only the business owner can record a refund/);
    await expect(recordRefund(io.ctx("owner"), p.paymentId, { amount: "1", reason: "x" })).rejects.toThrow();
    await expect(recordRefund(io.ctx("owner"), p.paymentId, { amount: "0", reason: "Zero is nothing" })).rejects.toThrow(/more than zero/);
    await expect(recordRefund(io.ctx("owner"), p.paymentId, { amount: "1000.01", reason: "More than was paid" })).rejects.toThrow(/more than is left to refund on this payment \(PHP 1,000\.00\)/);
    await expect(recordRefund(io.ctx("owner"), p.paymentId, { amount: "5", reason: "Card 4242 4242 4242 4242" })).rejects.toThrow(/card number/);
    const waiting = await providerPayment(io, inv.id, conn, 5000, { status: "pending" });
    await expect(recordRefund(io.ctx("owner"), waiting.paymentId, { amount: "1", reason: "Not received yet" })).rejects.toThrow(/Only a payment that was received/);
    const key = `refund-${uid()}-${uid()}`;
    const [x, y] = await Promise.all([recordRefund(io.ctx("owner"), p.paymentId, { amount: "100", reason: "Goodwill", idempotencyKey: key }), recordRefund(io.ctx("owner"), p.paymentId, { amount: "100", reason: "Goodwill", idempotencyKey: key })]);
    expect([x.duplicate, y.duplicate].sort()).toEqual([false, true]);
    expect(x.refundId).toBe(y.refundId);
    expect((await invoiceRow(inv.id)).refunded_minor).toBe("10000");
    // A provider's own refund id is the other key.
    const viaProvider = { orgId: io.orgId, paymentId: p.paymentId, amountMinor: 2000, source: "provider_event" as const, providerRefundId: "re_1", reason: "Refunded in the provider dashboard", actor: { id: null, kind: "provider" as const } };
    const one = await withSystem((db) => applyRefundInTx(db, viaProvider));
    const two = await withSystem((db) => applyRefundInTx(db, viaProvider));
    expect([one.duplicate, two.duplicate]).toEqual([false, true]);
    expect((await invoiceRow(inv.id)).refunded_minor).toBe("12000");
    // Another workspace cannot refund it.
    const other = await invoiceOrg();
    await expect(recordRefund(other.ctx("owner"), p.paymentId, { amount: "1", reason: "Not mine to refund" })).rejects.toThrow(/That payment was not found/);
  });

  it("keep a pending refund out of the totals until it succeeds, and can refund a payment recorded by hand", async () => {
    const io = await invoiceOrg();
    const inv = (await issuedInvoice(io, {}, NOW)).invoice;
    const manual = await recordManualPayment(io.ctx("owner"), inv.id, { ...pay, amount: "1500" }, { now: NOW });
    const pending = await withSystem((db) => applyRefundInTx(db, { orgId: io.orgId, paymentId: manual.paymentId, amountMinor: 50000, status: "pending", source: "provider_event", providerRefundId: "re_p", reason: "Provider is processing it", actor: { id: null, kind: "provider" } }));
    expect(pending.invoice.refundedMinor).toBe(0);
    expect((await rows<{ status: string }>("select status from customer_payments where id = $1", [manual.paymentId]))[0].status).toBe("succeeded");
    expect((await notes(io,"invoice_refund_recorded"))).toHaveLength(0);
    const done = await recordRefund(io.ctx("owner"), manual.paymentId, { amount: "500", reason: "Handed back in cash" });
    expect(done.invoice.refundedMinor).toBe(50000);
  });

  it("take the tax back in proportion", async () => {
    const io = await invoiceOrg();
    const conn = await connectionFor(io);
    const inv = (await issuedInvoice(io, { lines: [line({ unitPrice: "1000.00", taxPercent: "12" })] }, NOW)).invoice;
    const p = await providerPayment(io, inv.id, conn, 112000);
    await recordRefund(io.ctx("owner"), p.paymentId, { amount: "280", reason: "A quarter of the work was dropped" });
    const r = await rows<{ amount_minor: string; tax_portion_minor: string }>("select amount_minor::text, tax_portion_minor::text from customer_refunds where payment_id = $1", [p.paymentId]);
    expect(r[0]).toMatchObject({ amount_minor: "28000", tax_portion_minor: "3000" });
  });
});

describe("disputes", () => {
  it("mark the invoice disputed while open, change nothing about the money, and put it back when closed", async () => {
    const io = await invoiceOrg();
    const conn = await connectionFor(io);
    const inv = (await issuedInvoice(io, {}, NOW)).invoice;
    const p = await providerPayment(io, inv.id, conn, 150000);
    const open = await withSystem((db) => applyDisputeInTx(db, { orgId: io.orgId, paymentId: p.paymentId, open: true, actor: { id: null, kind: "provider" } }));
    expect(open).toMatchObject({ paymentStatus: "disputed", changed: true, invoice: { paymentStatus: "disputed", paidMinor: 150000 } });
    const twice = await withSystem((db) => applyDisputeInTx(db, { orgId: io.orgId, paymentId: p.paymentId, open: true, actor: { id: null, kind: "provider" } }));
    expect(twice.changed).toBe(false);
    expect((await notes(io,"payment_review_needed"))).toHaveLength(1);
    // While it is open a refund is recorded against the payment but it stays disputed.
    const part = await withSystem((db) => applyRefundInTx(db, { orgId: io.orgId, paymentId: p.paymentId, amountMinor: 50000, source: "manual_record", reason: "Partly refunded meanwhile", actor: { id: null, kind: "system" } }));
    expect(part.paymentStatus).toBe("disputed");
    const closed = await withSystem((db) => applyDisputeInTx(db, { orgId: io.orgId, paymentId: p.paymentId, open: false, actor: { id: null, kind: "provider" } }));
    expect(closed).toMatchObject({ paymentStatus: "partially_refunded", invoice: { paymentStatus: "paid", paidMinor: 150000, refundedMinor: 50000 } });
    const none = await withSystem((db) => applyDisputeInTx(db, { orgId: io.orgId, paymentId: p.paymentId, open: false, actor: { id: null, kind: "provider" } }));
    expect(none.changed).toBe(false);
    expect(await kinds(inv.id)).toEqual(["created", "issued", "payment_verified", "paid", "dispute_opened", "refund_recorded", "dispute_closed"]);
  });

  it("can only be opened on a payment that was received and is not fully refunded", async () => {
    const io = await invoiceOrg();
    const conn = await connectionFor(io);
    const inv = (await issuedInvoice(io, {}, NOW)).invoice;
    const waiting = await providerPayment(io, inv.id, conn, 1000, { status: "pending" });
    await expect(withSystem((db) => applyDisputeInTx(db, { orgId: io.orgId, paymentId: waiting.paymentId, open: true, actor: { id: null, kind: "provider" } }))).rejects.toThrow(/received and not fully refunded/);
    const full = await providerPayment(io, inv.id, conn, 2000);
    await recordRefund(io.ctx("owner"), full.paymentId, { amount: "20", reason: "Refunded in full" });
    await expect(withSystem((db) => applyDisputeInTx(db, { orgId: io.orgId, paymentId: full.paymentId, open: true, actor: { id: null, kind: "provider" } }))).rejects.toThrow(/not fully refunded/);
  });
});

describe("the books always add up", () => {
  it("keeps the invoice equal to its payment and refund rows through any run of payments, refunds, disputes and settlements", async () => {
    const r = (() => {
      let s = 424242;
      return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 0x100000000;
      };
    })();
    const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
    const io = await invoiceOrg();
    const conn = await connectionFor(io);
    const invoices = [(await issuedInvoice(io, { currency: "PHP", lines: [line({ unitPrice: "1000", taxPercent: "12" })] }, NOW)).invoice, (await issuedInvoice(io, { currency: "PHP", lines: [line({ unitPrice: "250.50" })] }, NOW)).invoice, (await issuedInvoice(io, { currency: "PHP", lines: [line({ unitPrice: "75", quantity: "3" })], taxInclusive: true }, NOW)).invoice];
    let operations = 0;
    for (let step = 0; step < 90; step += 1) {
      const inv = pick(invoices);
      const payments = await rows<{ id: string; status: string; amount_minor: string }>("select id, status, amount_minor::text from customer_payments where invoice_id = $1 and status in ('succeeded', 'partially_refunded', 'disputed')", [inv.id]);
      const pendings = await rows<{ id: string }>("select id from customer_payments where invoice_id = $1 and status = 'pending'", [inv.id]);
      const roll = r();
      try {
        if (roll < 0.35) await providerPayment(io, inv.id, conn, 1 + Math.floor(r() * 90_000));
        else if (roll < 0.45) await providerPayment(io, inv.id, conn, 1 + Math.floor(r() * 5_000), { status: pick(["pending", "failed"] as const) });
        else if (roll < 0.55 && pendings.length) await withSystem((db) => settlePaymentInTx(db, { orgId: io.orgId, paymentId: pick(pendings).id, to: pick(["succeeded", "failed"] as const), actor: { id: null, kind: "provider" } }));
        else if (roll < 0.8 && payments.length) {
          const target = pick(payments);
          await withSystem((db) => applyRefundInTx(db, { orgId: io.orgId, paymentId: target.id, amountMinor: 1 + Math.floor(r() * Number(target.amount_minor)), source: "manual_record", reason: "Random refund", actor: { id: null, kind: "system" } }));
        } else if (payments.length) {
          const target = pick(payments);
          await withSystem((db) => applyDisputeInTx(db, { orgId: io.orgId, paymentId: target.id, open: target.status !== "disputed", actor: { id: null, kind: "provider" } }));
        }
        operations += 1;
      } catch (e) {
        // The only refusals a random run may meet are the honest ones: more than is left to refund, or a payment that cannot be refunded or disputed.
        expect(String((e as Error).message)).toMatch(/more than is left to refund|already refunded in full|Only a payment that was received|received and not fully refunded/);
      }
      const check = await rows<{ paid: string; refunded: string; status: string; total: string; counted: string; refunds: string; disputed: boolean; balance: string; overpaid: string }>(
        `select i.paid_minor::text as paid, i.refunded_minor::text as refunded, i.payment_status as status, i.total_minor::text as total, i.balance_minor::text as balance, i.overpaid_minor::text as overpaid,
           coalesce((select sum(amount_minor) from customer_payments where invoice_id = i.id and status in ('succeeded', 'partially_refunded', 'refunded', 'disputed')), 0)::text as counted,
           coalesce((select sum(amount_minor) from customer_refunds where invoice_id = i.id and status = 'succeeded'), 0)::text as refunds,
           exists (select 1 from customer_payments where invoice_id = i.id and status = 'disputed') as disputed
         from customer_invoices i where i.id = $1`, [inv.id],
      );
      const c = check[0];
      expect(c.paid).toBe(c.counted);
      expect(c.refunded).toBe(c.refunds);
      expect(c.status).toBe(derivePaymentStatus({ totalMinor: Number(c.total), paidMinor: Number(c.paid), hasDispute: c.disputed }));
      expect(Number(c.balance)).toBe(Math.max(Number(c.total) - Number(c.paid), 0));
      expect(Number(c.overpaid)).toBe(Math.max(Number(c.paid) - Number(c.total), 0));
      expect(Number(c.refunded)).toBeLessThanOrEqual(Number(c.paid));
    }
    expect(operations).toBeGreaterThan(40);
    const perPayment = await rows<{ amount_minor: string; refunded: string }>(
      "select p.amount_minor::text, coalesce((select sum(r.amount_minor) from customer_refunds r where r.payment_id = p.id and r.status = 'succeeded'), 0)::text as refunded from customer_payments p where p.org_id = $1", [io.orgId],
    );
    for (const p of perPayment) expect(Number(p.refunded)).toBeLessThanOrEqual(Number(p.amount_minor));
    expect(COUNTED_STATUSES).toEqual(["succeeded", "partially_refunded", "refunded", "disputed"]);
  });

  it("is also what the database insists on: nothing but apply.ts changes the paid amount, the refunds or the payment rows", () => {
    const root = path.resolve(import.meta.dirname, "..", "src");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
      }
    };
    walk(root);
    const apply = path.join(root, "server", "invoices", "apply.ts");
    const forbidden: Array<[string, RegExp]> = [
      ["sets the paid amount", /\bpaid_minor\s*=\s*[^=>\s]/],
      ["sets the refunded amount", /\brefunded_minor\s*=\s*[^=>\s]/],
      ["sets the payment status", /\bpayment_status\s*=\s*(?!any\()[^=>\s]/],
      ["writes payment or refund rows", /\b(insert\s+into|update|delete\s+from)\s+customer_(payments|refunds)\b/i],
    ];
    const hits: string[] = [];
    for (const f of files) {
      if (f === apply) continue;
      const text = fs.readFileSync(f, "utf8");
      for (const [what, re] of forbidden) if (re.test(text)) hits.push(`${path.relative(root, f)} ${what}`);
    }
    expect(hits).toEqual([]);
    // The scan means something only if apply.ts itself does each of these things.
    const own = fs.readFileSync(apply, "utf8");
    for (const [what, re] of forbidden) expect(re.test(own), what).toBe(true);
  });
});

describe("iAcquire's own books", () => {
  it("are untouched by anything a client does with its customers' invoices", async () => {
    const io = await invoiceOrg();
    const conn = await connectionFor(io);
    const fingerprint = async () => {
      const out: Record<string, string> = {};
      for (const t of ["payments", "payment_webhook_events", "credit_ledger_entries", "credit_accounts", "billing_accounts", "agency_finance_entries", "metered_usage_events", "usage_reservations"]) {
        const r = await rows<{ n: string; h: string }>(`select count(*)::text as n, coalesce(md5(string_agg(t::text, '|' order by t::text)), '') as h from ${t} t`);
        out[t] = `${r[0].n}:${r[0].h}`;
      }
      return out;
    };
    const period = resolvePeriod("this_month", new Date());
    const before = await fingerprint();
    const reportBefore = JSON.stringify(await getFinancialReport(io.superAdmin, period));
    const inv = (await issuedInvoice(io, {}, NOW)).invoice;
    await recordManualPayment(io.ctx("owner"), inv.id, { ...pay, amount: "700" }, { now: NOW });
    const p = await providerPayment(io, inv.id, conn, 80000);
    await recordRefund(io.ctx("owner"), p.paymentId, { amount: "100", reason: "Goodwill gesture" });
    await withSystem((db) => applyDisputeInTx(db, { orgId: io.orgId, paymentId: p.paymentId, open: true, actor: { id: null, kind: "provider" } }));
    expect(await fingerprint()).toEqual(before);
    expect(JSON.stringify(await getFinancialReport(io.superAdmin, period))).toBe(reportBefore);
  });
});
