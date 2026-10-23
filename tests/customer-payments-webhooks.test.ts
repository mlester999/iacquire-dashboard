// A business's payment provider delivers events to the per-connection webhook. Everything below runs the REAL handler on embedded Postgres with deliveries signed
// the way each provider signs them (PayMongo's bodies are hand-written fixtures, not recordings; the simulated provider signs its own). The properties that matter:
// a delivery that is not authentic changes nothing and is told nothing; money is counted only when every fact agrees; the same event is applied once; a failure is
// recorded and retried; and an event can never reach another workspace's invoice.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { sha256 } from "@/server/security/crypto";
import { createDraft, issueInvoice, voidInvoice } from "@/server/invoices/invoices";
import { processReceipt } from "@/server/customer-payments/events";
import { MAX_BODY_BYTES, MAX_REDELIVERIES } from "@/server/customer-payments/webhooks";
import { createPaymongoProvider } from "@/server/customer-payments/providers/paymongo";
import { setAdapterForTests } from "@/server/customer-payments/providers";
import { ProviderCallError } from "@/server/customer-payments/providers/types";
import { simulatedPlatform } from "@/server/customer-payments/providers/simulated";
import { newReference } from "@/server/customer-payments/ids";
import { contactIn, dealFor, invoiceOrg, issuedInvoice, line, rows, type InvoiceOrg } from "./support/invoices";
import { attempt, attemptNow, connect, deliver, fakePaymongo, invoiceNow, paymentsOf, paymongoFailed, paymongoOther, paymongoPaid, paymongoRefundUpdated, paymongoSignature, q, receipts, simulatedDelivery, simulatedSetup } from "./support/customer-payments";
import { uid } from "./support/fixtures";

async function setup(over: Parameters<typeof connect>[1] = {}, attemptOver: Parameters<typeof attempt>[2] = {}) {
  const io = await invoiceOrg();
  const inv = (await issuedInvoice(io)).invoice;
  const conn = await connect(io, over);
  const a = await attempt(inv.id, conn, attemptOver);
  return { io, inv, conn, a };
}
type S = Awaited<ReturnType<typeof setup>>;
const paid = (s: S, over: Partial<Parameters<typeof paymongoPaid>[0]> = {}) => paymongoPaid({ checkoutId: s.a.checkoutId!, reference: s.a.reference, amount: s.a.amountMinor, ...over });
const FORBIDDEN = { status: 403, body: { error: "forbidden" }, outcome: "rejected" };
const notes = (io: InvoiceOrg, kind: string) => rows<{ title: string; body: string | null }>("select title, body from notifications where org_id = $1 and kind = $2 and user_id = $3 order by created_at", [io.orgId, kind, io.c.people.owner.id]);
const kinds = async (invoiceId: string) => (await rows<{ kind: string }>("select kind from customer_invoice_events where invoice_id = $1 order by id", [invoiceId])).map((e) => e.kind);

describe("a delivery that is not authentic changes nothing and gets one and the same answer", () => {
  it("answers a changed body, another secret, a stale or missing signature, an unknown or mismatched key and a disconnected account with the identical bare 403, and stores nothing", async () => {
    const s = await setup();
    const body = paid(s);
    const good = paymongoSignature(body, s.conn.webhookSecret);
    const tries: Array<[string, Awaited<ReturnType<typeof deliver>>]> = [
      ["tampered body", await deliver(s.conn, `${body} `, { signature: good })],
      ["wrong secret", await deliver(s.conn, body, { secret: "whsk_not_the_secret_at_all_0000" })],
      ["stale timestamp", await deliver(s.conn, body, { t: Math.floor(Date.now() / 1000) - 3 * 86_400 })],
      ["missing signature", await deliver(s.conn, body, { signature: null })],
      ["malformed signature", await deliver(s.conn, body, { signature: "garbage" })],
      ["unknown key", await deliver(s.conn, body, { key: "cpk_zzzzzzzzzzzzzzzzzzzz" })],
      ["key of the wrong shape", await deliver(s.conn, body, { key: "nope" })],
      ["provider that is not the connection's", await deliver(s.conn, body, { provider: "simulated" })],
      ["provider that does not exist", await deliver(s.conn, body, { provider: "stripe" })],
    ];
    for (const [label, r] of tries) expect(r, label).toEqual(FORBIDDEN);
    // A connection with no keys, one that cannot open them and one with no signing secret are no different from a key that does not exist.
    const gone = await connect(s.io, { provider: "simulated" });
    await withSystem((db) => db.query("update customer_payment_connections set status = 'revoked', credentials = null where id = $1", [gone.id]));
    expect(await deliver(gone, body)).toEqual(FORBIDDEN);
    const unreadable = await connect(s.io, { provider: "simulated" });
    await withSystem((db) => db.query("update customer_payment_connections set credentials = 'v1.garbage.garbage.garbage' where id = $1", [unreadable.id]));
    expect(await deliver(unreadable, "{}")).toEqual(FORBIDDEN);
    const noSecret = await connect(await invoiceOrg(), { webhookSecret: null });
    expect(await deliver(noSecret, "{}", { secret: "x".repeat(24) })).toEqual(FORBIDDEN);
    expect(await receipts(s.conn.id)).toEqual([]);
    expect(await paymentsOf(s.inv.id)).toEqual([]);
    expect((await invoiceNow(s.inv.id)).payment_status).toBe("unpaid");
    expect((await q<{ last_event_at: string | null }>("select last_event_at from customer_payment_connections where id = $1", [s.conn.id]))[0].last_event_at).toBeNull();
  });

  it("refuses a body past the size limit before reading any of it", async () => {
    const s = await setup();
    const big = "x".repeat(MAX_BODY_BYTES + 1);
    expect(await deliver(s.conn, big)).toEqual({ status: 413, body: { received: false } });
    expect(await receipts(s.conn.id)).toEqual([]);
  });

  it("limits how often one address may knock, whatever it knocks with, and does not limit another address", async () => {
    const s = await setup();
    const knock = (ip: string) => deliver(s.conn, "{}", { key: "cpk_zzzzzzzzzzzzzzzzzzzz", ip });
    // The window is a minute long and fixed, so a run that happens to straddle one needs up to twice the limit before it is certain to hit the wall.
    const seen = new Set<number>();
    for (let i = 0; i < 1300 && !seen.has(429); i += 1) seen.add((await knock("203.0.113.9")).status);
    expect([...seen].sort()).toEqual([403, 429]);
    expect((await knock("203.0.113.10")).status).toBe(403);
  }, 120_000);
});

describe("a genuine payment", () => {
  it("is recorded once, counted, tied to its attempt, and its receipt keeps the facts and a fingerprint, not the body", async () => {
    const s = await setup();
    const body = paid(s, { paymentId: "pay_one" });
    // The body carries the payer's name and email, as PayMongo's does; none of it may be kept.
    const withPayer = JSON.stringify({ ...JSON.parse(body), payer: { name: "Maria Santos", email: "maria.santos@example.test", phone: "+639171234567" } });
    expect(await deliver(s.conn, withPayer)).toMatchObject({ status: 200, outcome: "processed" });
    expect(await paymentsOf(s.inv.id)).toEqual([{ id: expect.any(String), status: "succeeded", amount_minor: "150000", provider_payment_id: "pay_one", livemode: false, verification: "provider_confirmed", attempt_id: s.a.id }]);
    expect(await invoiceNow(s.inv.id)).toMatchObject({ payment_status: "paid", paid_minor: "150000", balance_minor: "0", overpaid_minor: "0" });
    expect((await attemptNow(s.a.id)).status).toBe("succeeded");
    const [r] = await receipts(s.conn.id);
    expect(r).toMatchObject({ outcome: "processed", attempts: 1, detail: { facts: { kind: "payment.succeeded", reference: s.a.reference, paymentId: "pay_one", amountMinor: 150000, currency: "PHP", method: "card" } } });
    const stored = JSON.stringify(await q("select * from customer_payment_events where connection_id = $1", [s.conn.id]));
    for (const secret of ["Maria", "maria.santos", "+63917", s.conn.webhookSecret]) expect(stored, secret).not.toContain(secret);
    expect((await q<{ payload_sha256: string }>("select payload_sha256 from customer_payment_events where connection_id = $1", [s.conn.id]))[0].payload_sha256).toBe(sha256(withPayer));
    expect((await q<{ last_event_at: string | null }>("select last_event_at from customer_payment_connections where id = $1", [s.conn.id]))[0].last_event_at).not.toBeNull();
    expect(await kinds(s.inv.id)).toEqual(["created", "issued", "payment_verified", "paid"]);
    expect((await notes(s.io, "invoice_paid"))[0].title).toBe("INV-0001 was paid");
    expect(JSON.stringify(await q("select detail from customer_invoice_events where invoice_id = $1", [s.inv.id]))).not.toMatch(/Maria|maria\.santos/);
  });

  it("is applied once however many times, and however concurrently, the provider sends it, and once for two events about the same payment", async () => {
    const s = await setup();
    const body = paid(s, { paymentId: "pay_dup", eventId: "evt_dup" });
    const first = await deliver(s.conn, body);
    expect(first.outcome).toBe("processed");
    expect((await deliver(s.conn, body)).outcome).toBe("duplicate");
    // Another event id for the same payment (the provider's own retry under a new id) is still the one payment.
    expect((await deliver(s.conn, paid(s, { paymentId: "pay_dup", eventId: "evt_dup_2" }))).outcome).toBe("processed");
    expect(await paymentsOf(s.inv.id)).toHaveLength(1);
    expect((await invoiceNow(s.inv.id)).paid_minor).toBe("150000");

    const t = await setup();
    const concurrent = paid(t, { paymentId: "pay_race", eventId: "evt_race" });
    const results = await Promise.all(Array.from({ length: 6 }, () => deliver(t.conn, concurrent)));
    expect(results.filter((r) => r.outcome === "processed")).toHaveLength(1);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await paymentsOf(t.inv.id)).toHaveLength(1);
    expect(await receipts(t.conn.id)).toHaveLength(1);
    expect((await invoiceNow(t.inv.id)).paid_minor).toBe("150000");
  });

  it("is still recorded when the account is paused or needs attention: money that arrived is recorded whatever the state", async () => {
    for (const status of ["disabled", "needs_attention", "pending_verification"] as const) {
      const s = await setup({ status });
      expect((await deliver(s.conn, paid(s))).outcome, status).toBe("processed");
      expect((await invoiceNow(s.inv.id)).payment_status, status).toBe("paid");
    }
  });

  it("is recorded against a checkout that has expired or been closed, and leaves that attempt as it was", async () => {
    const s = await setup({}, { status: "expired" });
    expect((await deliver(s.conn, paid(s))).outcome).toBe("processed");
    expect((await invoiceNow(s.inv.id)).payment_status).toBe("paid");
    expect((await attemptNow(s.a.id)).status).toBe("expired");
  });
});

describe("what is not counted", () => {
  it("keeps a payment of another amount for a person, counts nothing, and says so", async () => {
    for (const amount of [100000, 150001]) {
      const s = await setup();
      expect(await deliver(s.conn, paid(s, { amount, paymentId: `pay_${amount}` }))).toMatchObject({ status: 200, outcome: "processed" });
      expect(await paymentsOf(s.inv.id)).toMatchObject([{ status: "needs_review", amount_minor: String(amount), verification: "provider_confirmed" }]);
      expect(await invoiceNow(s.inv.id)).toMatchObject({ payment_status: "unpaid", paid_minor: "0" });
      expect((await attemptNow(s.a.id)).status).toBe("needs_review");
      expect((await notes(s.io, "payment_review_needed"))[0].title).toBe("A payment for INV-0001 needs a look");
      expect((await receipts(s.conn.id))[0].detail.note).toMatch(/^Kept for review: its amount is not what the checkout asked for/);
    }
  });

  it("keeps a payment from another checkout than the one started for that reference", async () => {
    const s = await setup();
    await deliver(s.conn, paid(s, { checkoutId: "cs_somebody_elses", paymentId: "pay_x" }));
    expect(await paymentsOf(s.inv.id)).toMatchObject([{ status: "needs_review" }]);
    expect((await invoiceNow(s.inv.id)).payment_status).toBe("unpaid");
  });

  it("holds a payment in another currency out of the books altogether (it cannot sit on this invoice) and tells the owner", async () => {
    const s = await setup();
    const r = await deliver(s.conn, paid(s, { currency: "USD", paymentId: "pay_usd" }));
    expect(r).toMatchObject({ status: 200, outcome: "rejected" });
    expect(await paymentsOf(s.inv.id)).toEqual([]);
    expect((await invoiceNow(s.inv.id)).payment_status).toBe("unpaid");
    expect((await attemptNow(s.a.id)).status).toBe("needs_review");
    expect(await kinds(s.inv.id)).toContain("payment_needs_review");
    expect((await notes(s.io, "payment_review_needed"))[0].body).toMatch(/it is in a different currency from the invoice/);
  });

  it("counts a payment the provider re-reads as something else for nothing, never for money", async () => {
    // A signed delivery says paid; the provider's own record (asked with the business's key) says pending.
    const f = fakePaymongo();
    const s = await setup();
    setAdapterForTests("paymongo", createPaymongoProvider({ http: f.http }));
    process.env.CUSTOMER_PAYMENTS_WRITES_ENABLED = "true";
    resetEnvCache();
    try {
      f.on(() => true, { status: 200, json: { data: { id: s.a.checkoutId, attributes: { status: "active", reference_number: s.a.reference, payments: [{ id: "pay_pend", attributes: { amount: 150000, currency: "PHP", status: "pending" } }] } } } });
      expect((await deliver(s.conn, paid(s, { paymentId: "pay_pend" }))).outcome).toBe("processed");
      expect(await paymentsOf(s.inv.id)).toMatchObject([{ status: "needs_review" }]);
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]).toMatchObject({ method: "GET", path: `/v1/checkout_sessions/${s.a.checkoutId}`, apiKey: s.conn.apiKey });
    } finally {
      setAdapterForTests("paymongo", null);
      delete process.env.CUSTOMER_PAYMENTS_WRITES_ENABLED;
      resetEnvCache();
    }
  });

  it("does not count a payment that arrives for a voided invoice", async () => {
    const s = await setup({}, { status: "expired" });
    await voidInvoice(s.io.ctx("owner"), s.inv.id, { reason: "Issued to the wrong customer" });
    expect((await deliver(s.conn, paid(s))).outcome).toBe("processed");
    expect(await paymentsOf(s.inv.id)).toMatchObject([{ status: "needs_review" }]);
    expect((await invoiceNow(s.inv.id)).payment_status).toBe("unpaid");
    expect((await notes(s.io, "payment_review_needed"))[0].body).toMatch(/voided/);
  });

  it("waits for a checkout that is still being set up, and keeps the money for a person when an old one never learned its checkout", async () => {
    const young = await setup({}, { checkoutId: null, status: "created" });
    expect(await deliver(young.conn, paid(young, { checkoutId: "cs_late" }))).toMatchObject({ status: 200, outcome: "deferred" });
    expect(await paymentsOf(young.inv.id)).toEqual([]);
    expect((await receipts(young.conn.id))[0].outcome).toBe("deferred");
    const old = await setup({}, { checkoutId: null, status: "failed", ageMinutes: 30 });
    expect((await deliver(old.conn, paid(old, { checkoutId: "cs_late" }))).outcome).toBe("processed");
    expect(await paymentsOf(old.inv.id)).toMatchObject([{ status: "needs_review" }]);
  });

  it("leaves a failed try recorded and the checkout open, and a later success still pays the invoice", async () => {
    const s = await setup();
    expect((await deliver(s.conn, paymongoFailed({ paymentId: "pay_bad", reference: s.a.reference }))).outcome).toBe("processed");
    expect(await paymentsOf(s.inv.id)).toMatchObject([{ status: "failed", provider_payment_id: "pay_bad" }]);
    expect((await invoiceNow(s.inv.id)).payment_status).toBe("unpaid");
    expect((await attemptNow(s.a.id)).status).toBe("redirected");
    expect((await notes(s.io, "invoice_payment_failed"))).toHaveLength(1);
    expect((await deliver(s.conn, paid(s, { paymentId: "pay_good" }))).outcome).toBe("processed");
    expect((await invoiceNow(s.inv.id)).payment_status).toBe("paid");
  });

  it("does not quietly believe a payment it recorded as failed when the same payment is later reported paid: a person is asked", async () => {
    const s = await setup();
    await deliver(s.conn, paymongoFailed({ paymentId: "pay_flip", reference: s.a.reference }));
    expect((await deliver(s.conn, paid(s, { paymentId: "pay_flip", eventId: "evt_flip_a" }))).outcome).toBe("processed");
    expect((await deliver(s.conn, paid(s, { paymentId: "pay_flip", eventId: "evt_flip_b" }))).outcome).toBe("processed");
    expect(await paymentsOf(s.inv.id)).toMatchObject([{ status: "failed", provider_payment_id: "pay_flip" }]);
    expect((await invoiceNow(s.inv.id)).payment_status).toBe("unpaid");
    const asked = await notes(s.io, "payment_review_needed");
    expect(asked).toHaveLength(1);
    expect(asked[0].body).toMatch(/first reported this payment as failed and now reports it as paid/);
    expect((await kinds(s.inv.id)).filter((k) => k === "payment_needs_review")).toHaveLength(2);
  });

  it("counts a payment the provider first called pending only when it is confirmed, and only once", async () => {
    const s = await simulatedSetup();
    // The platform holds the payment; before it settled the provider told us it was pending.
    const settled = simulatedPlatform.pay(s.a.checkoutId!, s.conn.webhookSecret);
    const facts = { checkoutId: s.a.checkoutId, reference: s.a.reference, paymentId: settled.paymentId, amountMinor: 150000, currency: "PHP" };
    expect((await simulatedDelivery(s.conn, { kind: "payment.pending", ...facts })).outcome).toBe("processed");
    expect(await paymentsOf(s.inv.id)).toMatchObject([{ status: "pending" }]);
    expect((await invoiceNow(s.inv.id)).payment_status).toBe("unpaid");
    expect((await deliver(s.conn, settled.rawBody, { signature: settled.signature })).outcome).toBe("processed");
    expect(await paymentsOf(s.inv.id)).toMatchObject([{ status: "succeeded" }]);
    expect(await invoiceNow(s.inv.id)).toMatchObject({ payment_status: "paid", paid_minor: "150000" });
    // The same confirmation again changes nothing.
    expect((await simulatedDelivery(s.conn, { kind: "payment.succeeded", ...facts })).outcome).toBe("processed");
    expect(await paymentsOf(s.inv.id)).toHaveLength(1);
    expect((await invoiceNow(s.inv.id)).paid_minor).toBe("150000");
  });

  it("records an overpayment in full, flags it, tells the owner, and refunds nothing by itself", async () => {
    const s = await setup();
    await deliver(s.conn, paid(s, { paymentId: "pay_1" }));
    // The same checkout paid a second time (two tabs, a double tap): a second payment with its own id.
    expect((await deliver(s.conn, paid(s, { paymentId: "pay_2" }))).outcome).toBe("processed");
    expect(await invoiceNow(s.inv.id)).toMatchObject({ payment_status: "paid", paid_minor: "300000", overpaid_minor: "150000", balance_minor: "0", refunded_minor: "0" });
    expect(await kinds(s.inv.id)).toContain("overpaid");
    expect((await notes(s.io, "payment_review_needed"))[0].title).toBe("INV-0001 was paid more than it was for");
    expect(await q("select id from customer_refunds where invoice_id = $1", [s.inv.id])).toEqual([]);
  });
});

describe("what is not ours", () => {
  it("is acknowledged without being kept: the business's other sales, and event types this product does not use", async () => {
    const s = await setup();
    expect(await deliver(s.conn, paid(s, { reference: "order-4471" }))).toMatchObject({ status: 200, outcome: "ignored" });
    expect(await deliver(s.conn, paymongoOther("source.chargeable"))).toMatchObject({ status: 200, outcome: "ignored" });
    expect(await deliver(s.conn, paymongoFailed({ reference: null }))).toMatchObject({ status: 200, outcome: "ignored" });
    expect(await receipts(s.conn.id)).toEqual([]);
    expect(await paymentsOf(s.inv.id)).toEqual([]);
    expect((await q<{ last_event_at: string | null }>("select last_event_at from customer_payment_connections where id = $1", [s.conn.id]))[0].last_event_at).not.toBeNull();
  });

  it("rejects an event in the other mode, whatever its signature says, and an event whose payload contradicts its signature", async () => {
    const s = await setup();
    // Live-signed, live payload, to a test connection.
    expect(await deliver(s.conn, paid(s, { livemode: true }), { live: true })).toMatchObject({ status: 200, outcome: "rejected" });
    // Test-signed signature on a payload that says live.
    expect(await deliver(s.conn, paid(s, { livemode: true, paymentId: "pay_c" }), { live: false })).toMatchObject({ outcome: "rejected" });
    // A live connection and a test event.
    const live = await setup({ mode: "live", liveConfirmed: true });
    expect(await deliver(live.conn, paid(live, { livemode: false }))).toMatchObject({ outcome: "rejected" });
    expect(await paymentsOf(s.inv.id)).toEqual([]);
    expect(await paymentsOf(live.inv.id)).toEqual([]);
    const why = (await receipts(s.conn.id)).map((r) => r.detail.note);
    expect(why).toEqual(expect.arrayContaining([expect.stringMatching(/other mode/), expect.stringMatching(/does not match its signature/)]));
    // A live payment on a live connection is a payment.
    expect((await deliver(live.conn, paid(live, { livemode: true, paymentId: "pay_live" }))).outcome).toBe("processed");
    expect(await paymentsOf(live.inv.id)).toMatchObject([{ status: "succeeded", livemode: true }]);
  });

  it("is rejected quietly when the reference is one of ours that this connection never issued, and reads an unreadable signed body as rejected", async () => {
    const s = await setup();
    expect(await deliver(s.conn, paid(s, { reference: newReference(), paymentId: "pay_ghost" }))).toMatchObject({ status: 200, outcome: "rejected" });
    expect((await receipts(s.conn.id))[0]).toMatchObject({ outcome: "rejected", detail: { note: "No checkout on this connection has that reference." } });
    expect(await notes(s.io, "payment_review_needed")).toEqual([]);
    expect(await deliver(s.conn, "not json at all")).toMatchObject({ status: 200, outcome: "rejected" });
    expect((await receipts(s.conn.id)).map((r) => r.provider_event_id)).toEqual(expect.arrayContaining([expect.stringMatching(/^unreadable:[0-9a-f]{40}$/)]));
  });

  it("is inert when it is validly signed for one workspace and names another workspace's checkout", async () => {
    const a = await setup();
    const b = await setup();
    const att = await deliver(a.conn, paid(b, { paymentId: "pay_cross" }));
    expect(att).toMatchObject({ status: 200, outcome: "rejected" });
    expect(await paymentsOf(b.inv.id)).toEqual([]);
    expect(await paymentsOf(a.inv.id)).toEqual([]);
    expect((await invoiceNow(b.inv.id)).payment_status).toBe("unpaid");
    expect((await attemptNow(b.a.id)).status).toBe("redirected");
    expect(await notes(b.io, "payment_review_needed")).toEqual([]);
    // And the other way round: B's genuine connection still records B's own payment, and A's invoice is untouched.
    expect((await deliver(b.conn, paid(b, { paymentId: "pay_b" }))).outcome).toBe("processed");
    expect(await paymentsOf(a.inv.id)).toEqual([]);
    // A's secret cannot speak at B's address.
    expect(await deliver(b.conn, paid(b, { paymentId: "pay_b2" }), { secret: a.conn.webhookSecret })).toEqual(FORBIDDEN);
    expect(await q("select id from customer_payment_events where org_id = $1", [a.io.orgId])).toHaveLength(1);
  });
});

describe("refunds and disputes", () => {
  async function paidSetup() {
    const s = await setup();
    await deliver(s.conn, paid(s, { paymentId: "pay_known" }));
    return s;
  }
  const refund = (s: S, over: Partial<Parameters<typeof paymongoRefundUpdated>[0]> = {}) => deliver(s.conn, paymongoRefundUpdated({ paymentId: "pay_known", refundId: `ref_${uid()}`, amount: 5000, ...over }));
  const paymentRow = async (s: S) => (await q<{ status: string }>("select status from customer_payments where invoice_id = $1", [s.inv.id]))[0].status;

  it("records a partial refund, then the rest, and never reopens the invoice", async () => {
    const s = await paidSetup();
    expect((await refund(s, { refundId: "ref_1", amount: 5000 })).outcome).toBe("processed");
    expect(await paymentRow(s)).toBe("partially_refunded");
    expect(await invoiceNow(s.inv.id)).toMatchObject({ payment_status: "paid", paid_minor: "150000", refunded_minor: "5000" });
    expect((await refund(s, { refundId: "ref_2", amount: 145000 })).outcome).toBe("processed");
    expect(await paymentRow(s)).toBe("refunded");
    expect(await invoiceNow(s.inv.id)).toMatchObject({ payment_status: "paid", refunded_minor: "150000" });
    expect(await q("select source, status from customer_refunds where invoice_id = $1 order by created_at", [s.inv.id])).toEqual([{ source: "provider_event", status: "succeeded" }, { source: "provider_event", status: "succeeded" }]);
    expect(await notes(s.io, "invoice_refund_recorded")).toHaveLength(2);
  });

  it("records a refund once, however many events carry it", async () => {
    const s = await paidSetup();
    await refund(s, { refundId: "ref_same", eventId: "evt_refund_a", amount: 5000 });
    expect((await refund(s, { refundId: "ref_same", eventId: "evt_refund_b", amount: 5000 })).outcome).toBe("processed");
    expect(await q("select id from customer_refunds where invoice_id = $1", [s.inv.id])).toHaveLength(1);
    expect((await invoiceNow(s.inv.id)).refunded_minor).toBe("5000");
  });

  it("refuses a refund for more than is left, tells the owner, and leaves the books as they were", async () => {
    const s = await paidSetup();
    const r = await refund(s, { refundId: "ref_big", amount: 200000 });
    expect(r).toMatchObject({ status: 200, outcome: "rejected" });
    expect((await invoiceNow(s.inv.id)).refunded_minor).toBe("0");
    expect(await paymentRow(s)).toBe("succeeded");
    expect((await notes(s.io, "payment_review_needed"))[0].title).toBe("A refund for INV-0001 could not be recorded");
    await refund(s, { refundId: "ref_all", amount: 150000 });
    expect((await refund(s, { refundId: "ref_more", amount: 100 })).outcome).toBe("rejected");
    expect(await q("select id from customer_refunds where invoice_id = $1", [s.inv.id])).toHaveLength(1);
  });

  it("waits for a refund that arrives before its payment, and applies it once the payment is there", async () => {
    const s = await setup();
    const early = await deliver(s.conn, paymongoRefundUpdated({ paymentId: "pay_late", refundId: "ref_early", amount: 5000 }));
    expect(early).toMatchObject({ status: 200, outcome: "deferred" });
    const [receipt] = await receipts(s.conn.id);
    expect(receipt).toMatchObject({ outcome: "deferred", attempts: 1 });
    expect(await q("select id from customer_refunds where invoice_id = $1", [s.inv.id])).toEqual([]);
    await deliver(s.conn, paid(s, { paymentId: "pay_late" }));
    const retry = await processReceipt(receipt.id);
    expect(retry.outcome).toBe("processed");
    expect(await paymentRow(s)).toBe("partially_refunded");
    expect((await invoiceNow(s.inv.id)).refunded_minor).toBe("5000");
    expect((await receipts(s.conn.id)).find((r) => r.id === receipt.id)).toMatchObject({ outcome: "processed", attempts: 2 });
  });

  it("ignores a refund still in progress or failed, a refund in another currency, and a refund of a payment that was never received", async () => {
    const s = await paidSetup();
    expect((await refund(s, { status: "pending" })).outcome).toBe("ignored");
    expect((await refund(s, { status: "failed" })).outcome).toBe("ignored");
    expect((await refund(s, { currency: "USD", refundId: "ref_usd" })).outcome).toBe("rejected");
    const failedPay = await setup();
    await deliver(failedPay.conn, paymongoFailed({ paymentId: "pay_never", reference: failedPay.a.reference }));
    expect((await deliver(failedPay.conn, paymongoRefundUpdated({ paymentId: "pay_never", refundId: "ref_never", amount: 100 }))).outcome).toBe("rejected");
    expect(await q("select id from customer_refunds where invoice_id = any($1::uuid[])", [[s.inv.id, failedPay.inv.id]])).toEqual([]);
  });

  it("opens and closes a dispute, and counts it only once", async () => {
    const s = await simulatedSetup();
    const p = simulatedPlatform.pay(s.a.checkoutId!, s.conn.webhookSecret, {});
    await deliver(s.conn, p.rawBody, { signature: p.signature });
    const sim_pay = p.paymentId;
    expect(await paymentsOf(s.inv.id)).toMatchObject([{ status: "succeeded" }]);
    expect((await simulatedDelivery(s.conn, { kind: "dispute.opened", paymentId: sim_pay })).outcome).toBe("processed");
    expect((await invoiceNow(s.inv.id)).payment_status).toBe("disputed");
    expect((await simulatedDelivery(s.conn, { kind: "dispute.opened", paymentId: sim_pay, eventId: "evt_again" })).outcome).toBe("processed");
    expect(await q("select id from customer_invoice_events where invoice_id = $1 and kind = 'dispute_opened'", [s.inv.id])).toHaveLength(1);
    expect((await simulatedDelivery(s.conn, { kind: "dispute.closed", paymentId: sim_pay })).outcome).toBe("processed");
    expect((await invoiceNow(s.inv.id)).payment_status).toBe("paid");
    expect((await notes(s.io, "payment_review_needed"))[0].title).toBe("A payment for INV-0001 is disputed");
  });
});

describe("a failure while applying an event is recorded, answered with a 500 so the provider sends it again, and retried", () => {
  async function failingInsert(paymentId: string, on: boolean) {
    if (on) {
      await withSystem((db) => db.query("create or replace function test_boom() returns trigger language plpgsql as $$ begin if new.provider_payment_id = '" + paymentId + "' then raise exception 'boom: database unavailable sk_test_AbCdEfGh90abcdef'; end if; return new; end $$"));
      await withSystem((db) => db.query("create trigger test_boom before insert on customer_payments for each row execute function test_boom()"));
    } else {
      await withSystem((db) => db.query("drop trigger if exists test_boom on customer_payments"));
    }
  }

  it("keeps the receipt open with a clean sentence, leaves the books alone, and records the payment exactly once when the same event is sent again", async () => {
    const s = await setup();
    const body = paid(s, { paymentId: "pay_boom", eventId: "evt_boom" });
    await failingInsert("pay_boom", true);
    try {
      const r = await deliver(s.conn, body);
      expect(r).toEqual({ status: 500, body: { received: false } });
      const [receipt] = await receipts(s.conn.id);
      expect(receipt).toMatchObject({ outcome: "error", attempts: 1 });
      expect(receipt.detail.error).toMatch(/boom: database unavailable/);
      expect(receipt.detail.error).not.toContain("sk_test_AbCdEfGh90abcdef");
      expect(receipt.detail.facts).toMatchObject({ paymentId: "pay_boom" });
      expect(await paymentsOf(s.inv.id)).toEqual([]);
      expect((await invoiceNow(s.inv.id)).payment_status).toBe("unpaid");
      expect((await attemptNow(s.a.id)).status).toBe("redirected");
    } finally {
      await failingInsert("pay_boom", false);
    }
    expect((await deliver(s.conn, body)).outcome).toBe("processed");
    expect(await paymentsOf(s.inv.id)).toHaveLength(1);
    expect(await receipts(s.conn.id)).toMatchObject([{ outcome: "processed", attempts: 2 }]);
    // The earlier failure is not left on a receipt that has since been applied.
    expect((await receipts(s.conn.id))[0].detail.error).toBeUndefined();
    expect((await invoiceNow(s.inv.id)).paid_minor).toBe("150000");
  });

  it("stops asking the provider to resend after a few tries, and leaves the receipt in error for the scheduled job and the alarm", async () => {
    const s = await setup();
    const body = paid(s, { paymentId: "pay_poison", eventId: "evt_poison" });
    await failingInsert("pay_poison", true);
    try {
      const statuses: number[] = [];
      for (let i = 0; i < MAX_REDELIVERIES; i += 1) statuses.push((await deliver(s.conn, body)).status);
      expect(statuses).toEqual([...Array(MAX_REDELIVERIES - 1).fill(500), 200]);
      expect(await receipts(s.conn.id)).toMatchObject([{ outcome: "error", attempts: MAX_REDELIVERIES }]);
    } finally {
      await failingInsert("pay_poison", false);
    }
  });
});

describe("the owner's deal rule runs once the payment is safely recorded", () => {
  it("asks the deal's owner once when the invoice is paid in full by the provider, however many times the event arrives", async () => {
    const io = await invoiceOrg();
    await withSystem((db) => db.query("insert into customer_invoice_settings (org_id, close_rule) values ($1, 'task') on conflict (org_id) do update set close_rule = 'task'", [io.orgId]));
    const dealId = await dealFor(io, await contactIn(io), { ownerId: io.c.people.sales.id });
    const d = await createDraft(io.ctx("owner"), { opportunityId: dealId, currency: "PHP", lines: [line({ unitPrice: "1500" })] });
    const inv = (await issueInvoice(io.ctx("owner"), d.invoice.id, { version: d.invoice.version })).detail.invoice;
    const conn = await connect(io, { mode: "live", liveConfirmed: true });
    const a = await attempt(inv.id, conn);
    const body = paymongoPaid({ checkoutId: a.checkoutId!, reference: a.reference, amount: a.amountMinor, paymentId: "pay_deal", eventId: "evt_deal", livemode: true });
    await deliver(conn, body);
    await deliver(conn, body);
    const tasks = await rows<{ title: string; assigned_user_id: string | null }>("select title, assigned_user_id from tasks where opportunity_id = $1", [dealId]);
    expect(tasks).toEqual([{ title: "Invoice INV-0001 is paid: mark the deal won?", assigned_user_id: io.c.people.sales.id }]);
    expect((await rows<{ status: string }>("select status from crm_opportunities where id = $1", [dealId]))[0].status).toBe("open");
  });

  it("does nothing to the deal when the payment moved no real money (the provider's test mode), and starts no automation", async () => {
    const io = await invoiceOrg();
    await withSystem((db) => db.query("insert into customer_invoice_settings (org_id, close_rule) values ($1, 'task') on conflict (org_id) do update set close_rule = 'task'", [io.orgId]));
    const dealId = await dealFor(io, await contactIn(io), { ownerId: io.c.people.sales.id });
    const d = await createDraft(io.ctx("owner"), { opportunityId: dealId, currency: "PHP", lines: [line({ unitPrice: "1500" })] });
    const inv = (await issueInvoice(io.ctx("owner"), d.invoice.id, { version: d.invoice.version })).detail.invoice;
    const conn = await connect(io);
    const a = await attempt(inv.id, conn);
    await deliver(conn, paymongoPaid({ checkoutId: a.checkoutId!, reference: a.reference, amount: a.amountMinor, paymentId: "pay_test_deal", eventId: "evt_test_deal" }));
    expect(await paymentsOf(inv.id)).toMatchObject([{ status: "succeeded", livemode: false }]);
    expect(await rows("select 1 from tasks where opportunity_id = $1", [dealId])).toEqual([]);
    expect(await rows("select 1 from customer_invoice_events where invoice_id = $1 and kind = 'close_rule_applied'", [inv.id])).toEqual([]);
    expect(await rows("select 1 from crm_events where org_id = $1 and type in ('invoice.paid', 'payment.verified')", [io.orgId])).toEqual([]);
  });
});

describe("the provider's own record is asked, with the business's key, before a payment is counted", () => {
  const simSetup = simulatedSetup;

  it("counts a payment the platform confirms", async () => {
    const s = await simSetup();
    const p = simulatedPlatform.pay(s.a.checkoutId!, s.conn.webhookSecret);
    expect((await deliver(s.conn, p.rawBody, { signature: p.signature })).outcome).toBe("processed");
    expect(await paymentsOf(s.inv.id)).toMatchObject([{ status: "succeeded", provider_payment_id: p.paymentId }]);
    expect(simulatedPlatform.calls("fetch")).toBe(1);
  });

  it("keeps for a person a signed delivery the platform has no record of, or records differently", async () => {
    const s = await simSetup();
    const facts = { kind: "payment.succeeded" as const, checkoutId: s.a.checkoutId, reference: s.a.reference, currency: "PHP" };
    // Signed correctly, but the platform holds no such payment.
    expect((await simulatedDelivery(s.conn, { ...facts, paymentId: "sim_pay_invented", amountMinor: 150000 })).outcome).toBe("processed");
    expect(await paymentsOf(s.inv.id)).toMatchObject([{ status: "needs_review", provider_payment_id: "sim_pay_invented" }]);
    expect((await receipts(s.conn.id))[0].detail.note).toMatch(/does not show the payment/);
    // The platform holds a payment of another amount than the delivery claims.
    const t = await simSetup();
    const real = simulatedPlatform.pay(t.a.checkoutId!, t.conn.webhookSecret, { amountMinor: 100 });
    expect((await simulatedDelivery(t.conn, { kind: "payment.succeeded", checkoutId: t.a.checkoutId, reference: t.a.reference, currency: "PHP", paymentId: real.paymentId, amountMinor: 150000 })).outcome).toBe("processed");
    expect(await paymentsOf(t.inv.id)).toMatchObject([{ status: "needs_review" }]);
    expect((await invoiceNow(t.inv.id)).payment_status).toBe("unpaid");
  });

  it("asks again later, with a 500, when the platform cannot be reached; and goes on from the signed delivery when it refuses the key", async () => {
    const s = await simSetup();
    const p = simulatedPlatform.pay(s.a.checkoutId!, s.conn.webhookSecret);
    simulatedPlatform.failNext("fetch", new ProviderCallError("unreachable", "The platform could not be reached."));
    expect((await deliver(s.conn, p.rawBody, { signature: p.signature })).status).toBe(500);
    expect(await paymentsOf(s.inv.id)).toEqual([]);
    expect((await deliver(s.conn, p.rawBody, { signature: p.signature })).outcome).toBe("processed");
    const t = await simSetup();
    const q2 = simulatedPlatform.pay(t.a.checkoutId!, t.conn.webhookSecret);
    simulatedPlatform.failNext("fetch", new ProviderCallError("rejected", "The platform did not accept this key."));
    expect((await deliver(t.conn, q2.rawBody, { signature: q2.signature })).outcome).toBe("processed");
    expect(await paymentsOf(t.inv.id)).toMatchObject([{ status: "succeeded" }]);
  });

  describe("a real provider", () => {
    beforeAll(() => {
      process.env.CUSTOMER_PAYMENTS_WRITES_ENABLED = "true";
      resetEnvCache();
    });
    afterAll(() => {
      setAdapterForTests("paymongo", null);
      delete process.env.CUSTOMER_PAYMENTS_WRITES_ENABLED;
      resetEnvCache();
    });

    it("counts a PayMongo payment the checkout confirms, and records one that its own record shows at another amount for review", async () => {
      const f = fakePaymongo();
      setAdapterForTests("paymongo", createPaymongoProvider({ http: f.http }));
      const s = await setup();
      const answer = (id: string, amount: number) => ({ status: 200, json: { data: { id: s.a.checkoutId, attributes: { status: "active", reference_number: s.a.reference, payments: [{ id, attributes: { amount, currency: "PHP", status: "paid" } }] } } } });
      f.on(() => true, answer("pay_ok", 150000));
      expect((await deliver(s.conn, paid(s, { paymentId: "pay_ok" }))).outcome).toBe("processed");
      expect(await paymentsOf(s.inv.id)).toMatchObject([{ status: "succeeded" }]);
      const t = await setup();
      f.on(() => true, { status: 200, json: { data: { id: t.a.checkoutId, attributes: { status: "active", reference_number: t.a.reference, payments: [{ id: "pay_off", attributes: { amount: 1000, currency: "PHP", status: "paid" } }] } } } });
      expect((await deliver(t.conn, paid(t, { paymentId: "pay_off" }))).outcome).toBe("processed");
      expect(await paymentsOf(t.inv.id)).toMatchObject([{ status: "needs_review" }]);
      expect((await receipts(t.conn.id))[0].detail.note).toMatch(/does not agree with the delivery/);
    });
  });
});

describe("with the environment's calls switch off, a real provider is never asked", () => {
  it("records a signed PayMongo delivery from the delivery alone", async () => {
    const f = fakePaymongo();
    setAdapterForTests("paymongo", createPaymongoProvider({ http: f.http }));
    try {
      const s = await setup();
      expect((await deliver(s.conn, paid(s))).outcome).toBe("processed");
      expect(await paymentsOf(s.inv.id)).toMatchObject([{ status: "succeeded" }]);
      expect(f.calls).toHaveLength(0);
    } finally {
      setAdapterForTests("paymongo", null);
    }
  });
});
