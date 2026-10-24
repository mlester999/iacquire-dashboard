// How a dispute ends decides what the books say, on embedded Postgres: money is never put back as received on a guess. A win puts the payment back; a loss records what the buyer got
// back as a chargeback refund, so the payment, the invoice and net revenue follow the money; a close with no clear result leaves the payment disputed and asks the owner. The owner can
// open a dispute and record how it ended by hand (the only way a dispute the provider never reported, or a reversal with no resolution, can be represented).
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { applyDisputeInTx, applyRefundInTx } from "@/server/invoices/apply";
import { getInvoiceDetail } from "@/server/invoices/invoices";
import { recordDisputeOpened, recordDisputeResult } from "@/server/invoices/disputes";
import { recordManualPayment } from "@/server/invoices/payments";
import { connectionFor, invoiceOrg, issuedInvoice, providerPayment, rows, type InvoiceOrg } from "./support/invoices";

const NOW = new Date("2026-10-23T12:00:00Z");
const PROVIDER = { id: null, kind: "provider" as const };
const open = (io: InvoiceOrg, paymentId: string) => withSystem((db) => applyDisputeInTx(db, { orgId: io.orgId, paymentId, open: true, actor: PROVIDER }));
const close = (io: InvoiceOrg, paymentId: string, over: Partial<Parameters<typeof applyDisputeInTx>[1]> = {}) => withSystem((db) => applyDisputeInTx(db, { orgId: io.orgId, paymentId, open: false, actor: PROVIDER, ...over }));
const notes = (io: InvoiceOrg, kind: string) => rows<{ title: string; body: string | null }>("select title, body from notifications where org_id = $1 and kind = $2 and user_id = $3 order by created_at", [io.orgId, kind, io.c.people.owner.id]);
const kinds = async (invoiceId: string) => (await rows<{ kind: string }>("select kind from customer_invoice_events where invoice_id = $1 order by id", [invoiceId])).map((e) => e.kind);
const invoiceRow = async (id: string) => (await rows<{ paid_minor: string; refunded_minor: string; payment_status: string }>("select paid_minor::text, refunded_minor::text, payment_status from customer_invoices where id = $1", [id]))[0];
const paymentStatus = async (id: string) => (await rows<{ status: string }>("select status from customer_payments where id = $1", [id]))[0].status;
const refundsOf = (paymentId: string) => rows<{ source: string; status: string; amount: string }>("select source, status, amount_minor::text as amount from customer_refunds where payment_id = $1 order by created_at", [paymentId]);

async function paid(amount = 150000) {
  const io = await invoiceOrg();
  const conn = await connectionFor(io);
  const inv = (await issuedInvoice(io, {}, NOW)).invoice;
  const p = await providerPayment(io, inv.id, conn, amount);
  return { io, conn, inv, p };
}

describe("a dispute that closes", () => {
  it("is never put back as received on a guess: no result, or a loss with no amount, leaves the payment disputed and asks the owner once", async () => {
    const s = await paid();
    await open(s.io, s.p.paymentId);
    const none = await close(s.io, s.p.paymentId);
    expect(none).toMatchObject({ paymentStatus: "disputed", changed: false, outcome: "unknown", chargebackMinor: 0, invoice: { paymentStatus: "disputed" } });
    const noAmount = await close(s.io, s.p.paymentId, { outcome: "lost" });
    expect(noAmount).toMatchObject({ paymentStatus: "disputed", outcome: "unknown" });
    expect(await paymentStatus(s.p.paymentId)).toBe("disputed");
    expect(await invoiceRow(s.inv.id)).toMatchObject({ payment_status: "disputed", paid_minor: "150000", refunded_minor: "0" });
    expect(await refundsOf(s.p.paymentId)).toEqual([]);
    expect((await notes(s.io, "payment_review_needed")).map((n) => n.title)).toEqual(["A payment for INV-0001 is disputed", "A dispute on INV-0001 was closed, but how it ended is not known"]);
    expect(await kinds(s.inv.id)).toEqual(["created", "issued", "payment_verified", "paid", "dispute_opened", "dispute_result_unknown", "dispute_result_unknown"]);
  });

  it("puts the payment back when it was won, and says so", async () => {
    const s = await paid();
    await open(s.io, s.p.paymentId);
    const won = await close(s.io, s.p.paymentId, { outcome: "won" });
    expect(won).toMatchObject({ paymentStatus: "succeeded", changed: true, outcome: "won", chargebackMinor: 0, invoice: { paymentStatus: "paid", paidMinor: 150000, refundedMinor: 0 } });
    expect(await refundsOf(s.p.paymentId)).toEqual([]);
    expect(await kinds(s.inv.id)).toEqual(["created", "issued", "payment_verified", "paid", "dispute_opened", "dispute_closed"]);
    const detail = await getInvoiceDetail(s.io.ctx("owner"), s.inv.id);
    expect(detail.events.at(-1)).toMatchObject({ kind: "dispute_closed", detail: { outcome: "won" } });
    expect((await notes(s.io, "payment_review_needed")).map((n) => n.title)).toContain("A dispute on INV-0001 was won");
  });

  it("records what the buyer got back as a chargeback refund when it was lost, and the payment and invoice follow the rows", async () => {
    const s = await paid();
    await open(s.io, s.p.paymentId);
    const lost = await close(s.io, s.p.paymentId, { outcome: "lost", lostMinor: 150000 });
    expect(lost).toMatchObject({ paymentStatus: "refunded", changed: true, outcome: "lost", chargebackMinor: 150000, chargebackRefundId: expect.any(String), invoice: { paymentStatus: "paid", paidMinor: 150000, refundedMinor: 150000 } });
    expect(await refundsOf(s.p.paymentId)).toEqual([{ source: "chargeback", status: "succeeded", amount: "150000" }]);
    expect(await invoiceRow(s.inv.id)).toMatchObject({ payment_status: "paid", paid_minor: "150000", refunded_minor: "150000" });
    expect(await kinds(s.inv.id)).toEqual(["created", "issued", "payment_verified", "paid", "dispute_opened", "refund_recorded", "dispute_closed"]);
    expect((await getInvoiceDetail(s.io.ctx("owner"), s.inv.id)).events.at(-1)).toMatchObject({ kind: "dispute_closed", detail: { outcome: "lost", lost: "1500.00", currency: "PHP" } });
    expect((await notes(s.io, "payment_review_needed")).map((n) => n.title)).toContain("A dispute on INV-0001 was lost");
    expect((await notes(s.io, "invoice_refund_recorded")).map((n) => n.title)).toEqual(["A chargeback was recorded on INV-0001"]);
  });

  it("takes back only what the buyer got: a part leaves the payment partly refunded, and never more than is left of it", async () => {
    const s = await paid();
    await open(s.io, s.p.paymentId);
    const part = await close(s.io, s.p.paymentId, { outcome: "lost", lostMinor: 40000 });
    expect(part).toMatchObject({ paymentStatus: "partially_refunded", chargebackMinor: 40000, invoice: { refundedMinor: 40000, paymentStatus: "paid" } });

    // Refunded in part while the dispute was open, and then lost for the whole payment: only what is left can have been taken back.
    const t = await paid();
    await open(t.io, t.p.paymentId);
    await withSystem((db) => applyRefundInTx(db, { orgId: t.io.orgId, paymentId: t.p.paymentId, amountMinor: 50000, source: "manual_record", reason: "Partly refunded meanwhile", actor: { id: null, kind: "system" } }));
    const rest = await close(t.io, t.p.paymentId, { outcome: "lost", lostMinor: 150000 });
    expect(rest).toMatchObject({ paymentStatus: "refunded", chargebackMinor: 100000, invoice: { refundedMinor: 150000 } });
    expect(await refundsOf(t.p.paymentId)).toEqual([{ source: "manual_record", status: "succeeded", amount: "50000" }, { source: "chargeback", status: "succeeded", amount: "100000" }]);

    // Already refunded in full while it was open: nothing more to take back, and the owner is told why.
    const u = await paid();
    await open(u.io, u.p.paymentId);
    await withSystem((db) => applyRefundInTx(db, { orgId: u.io.orgId, paymentId: u.p.paymentId, amountMinor: 150000, source: "manual_record", reason: "Refunded in full meanwhile", actor: { id: null, kind: "system" } }));
    const none = await close(u.io, u.p.paymentId, { outcome: "lost", lostMinor: 150000 });
    expect(none).toMatchObject({ paymentStatus: "refunded", chargebackMinor: 0, chargebackRefundId: null });
    expect(await refundsOf(u.p.paymentId)).toHaveLength(1);
    expect((await notes(u.io, "payment_review_needed")).find((n) => /was lost/.test(n.title))?.body).toMatch(/already recorded on this payment cover/);
  });

  it("can be opened again after one ended, and each round tells the owner", async () => {
    const s = await paid();
    await open(s.io, s.p.paymentId);
    await close(s.io, s.p.paymentId, { outcome: "won" });
    await open(s.io, s.p.paymentId);
    await close(s.io, s.p.paymentId, { outcome: "lost", lostMinor: 10000 });
    expect((await notes(s.io, "payment_review_needed")).map((n) => n.title)).toEqual([
      "A payment for INV-0001 is disputed", "A dispute on INV-0001 was won", "A payment for INV-0001 is disputed", "A dispute on INV-0001 was lost",
    ]);
    expect(await refundsOf(s.p.paymentId)).toEqual([{ source: "chargeback", status: "succeeded", amount: "10000" }]);
  });
});

describe("a dispute the owner records by hand", () => {
  it("is the owner's alone, and only for a payment the provider confirmed", async () => {
    const s = await paid();
    for (const who of ["manager", "sales", "viewer", "member"] as const) {
      await expect(recordDisputeOpened(s.io.ctx(who), s.p.paymentId, {}), who).rejects.toThrow(/Only the business owner can record a dispute/);
      await expect(recordDisputeResult(s.io.ctx(who), s.p.paymentId, { outcome: "won" }), who).rejects.toThrow(/Only the business owner can record a dispute/);
    }
    const manual = await recordManualPayment(s.io.ctx("owner"), (await issuedInvoice(s.io, {}, NOW)).invoice.id, { amount: "100", receivedOn: "2026-10-23", method: "cash", evidence: "Cash handed over, receipt 5" }, { now: NOW });
    await expect(recordDisputeOpened(s.io.ctx("owner"), manual.paymentId, {})).rejects.toThrow(/payment your payment provider confirmed/);
    const other = await invoiceOrg();
    await expect(recordDisputeOpened(other.ctx("owner"), s.p.paymentId, {})).rejects.toThrow(/That payment was not found/);
    expect(await paymentStatus(s.p.paymentId)).toBe("succeeded");
  });

  it("opens a dispute the provider never reported: audited, on the history, held out of revenue, and not twice", async () => {
    const s = await paid();
    const r = await recordDisputeOpened(s.io.ctx("owner"), s.p.paymentId, { note: "The bank phoned about a chargeback" });
    expect(r).toMatchObject({ paymentStatus: "disputed", invoice: { paymentStatus: "disputed" } });
    expect(await kinds(s.inv.id)).toContain("dispute_opened");
    const audit = await rows<{ metadata: Record<string, unknown> }>("select metadata from audit_logs where target_id = $1 and action = 'invoice.dispute_opened'", [s.inv.id]);
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({ number: "INV-0001", paymentId: s.p.paymentId, amount: "1500.00", currency: "PHP", note: "The bank phoned about a chargeback" });
    expect((await notes(s.io, "payment_review_needed")).map((n) => n.title)).toEqual(["A payment for INV-0001 is disputed"]);
    await expect(recordDisputeOpened(s.io.ctx("owner"), s.p.paymentId, {})).rejects.toThrow(/already under dispute/);
    await expect(recordDisputeOpened(s.io.ctx("owner"), s.p.paymentId, { note: "Card 4242 4242 4242 4242" })).rejects.toThrow(/card number/);
  });

  it("closes it as won: the payment is back, audited, and the owner is told", async () => {
    const s = await paid();
    await recordDisputeOpened(s.io.ctx("owner"), s.p.paymentId, {});
    const r = await recordDisputeResult(s.io.ctx("owner"), s.p.paymentId, { outcome: "won", note: "Bank ruled for us" });
    expect(r).toMatchObject({ paymentStatus: "succeeded", invoice: { paymentStatus: "paid" }, reviewTaskId: null });
    const audit = await rows<{ metadata: Record<string, unknown> }>("select metadata from audit_logs where target_id = $1 and action = 'invoice.dispute_closed'", [s.inv.id]);
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({ outcome: "won", paymentId: s.p.paymentId, note: "Bank ruled for us" });
    expect((await getInvoiceDetail(s.io.ctx("owner"), s.inv.id)).events.at(-1)).toMatchObject({ kind: "dispute_closed", actorKind: "user", detail: { outcome: "won" } });
    expect((await notes(s.io, "payment_review_needed")).map((n) => n.title)).toContain("A dispute on INV-0001 was won");
    await expect(recordDisputeResult(s.io.ctx("owner"), s.p.paymentId, { outcome: "won" })).rejects.toThrow(/not under dispute/);
  });

  it("closes it as lost with what the buyer got back: a chargeback refund, never more than is left, and audited", async () => {
    const s = await paid();
    await recordDisputeOpened(s.io.ctx("owner"), s.p.paymentId, {});
    await expect(recordDisputeResult(s.io.ctx("owner"), s.p.paymentId, { outcome: "lost" })).rejects.toThrow();
    await expect(recordDisputeResult(s.io.ctx("owner"), s.p.paymentId, { outcome: "lost", amount: "0" })).rejects.toThrow(/more than zero/);
    await expect(recordDisputeResult(s.io.ctx("owner"), s.p.paymentId, { outcome: "lost", amount: "1500.01" })).rejects.toThrow(/more than is left of this payment \(PHP 1,500\.00\)/);
    await expect(recordDisputeResult(s.io.ctx("owner"), s.p.paymentId, { outcome: "maybe" })).rejects.toThrow();
    expect(await paymentStatus(s.p.paymentId)).toBe("disputed");
    const r = await recordDisputeResult(s.io.ctx("owner"), s.p.paymentId, { outcome: "lost", amount: "600.00" });
    expect(r).toMatchObject({ paymentStatus: "partially_refunded", invoice: { paymentStatus: "paid", paidMinor: 150000, refundedMinor: 60000 } });
    expect(await refundsOf(s.p.paymentId)).toEqual([{ source: "chargeback", status: "succeeded", amount: "60000" }]);
    const audit = await rows<{ metadata: Record<string, unknown> }>("select metadata from audit_logs where target_id = $1 and action = 'invoice.dispute_closed'", [s.inv.id]);
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({ outcome: "lost", lost: "600.00", currency: "PHP", refundId: expect.any(String) });
    expect((await getInvoiceDetail(s.io.ctx("owner"), s.inv.id)).refunds.map((x) => [x.source, x.amountMinor])).toEqual([["chargeback", 60000]]);
  });

  it("settles a payment a provider's unresolved reversal left disputed", async () => {
    const s = await paid();
    await open(s.io, s.p.paymentId); // what a reversed capture does, with no resolution after it
    await close(s.io, s.p.paymentId); // a close that says nothing
    expect(await paymentStatus(s.p.paymentId)).toBe("disputed");
    expect(await recordDisputeResult(s.io.ctx("owner"), s.p.paymentId, { outcome: "lost", amount: "1500.00" })).toMatchObject({ paymentStatus: "refunded" });
    expect(await invoiceRow(s.inv.id)).toMatchObject({ payment_status: "paid", refunded_minor: "150000" });
  });
});
