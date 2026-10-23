// The scheduled job that makes a lost or failed webhook harmless, on embedded Postgres: deliveries received and never finished are applied from their receipts, stale
// checkouts are closed, open checkouts are read back so a lost webhook still settles, connections are checked daily, and deal rules an interrupted payment skipped run.
// A real provider is never asked while the environment's calls switch is off. Nothing here contacts a provider.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { sha256 } from "@/server/security/crypto";
import { createDraft, issueInvoice } from "@/server/invoices/invoices";
import { runCustomerPaymentReconcileDetailed, MAX_ATTEMPTS } from "@/server/customer-payments/reconcile";
import { markReceiptError, storeReceipt } from "@/server/customer-payments/events";
import { createPaymongoProvider } from "@/server/customer-payments/providers/paymongo";
import { setAdapterForTests } from "@/server/customer-payments/providers";
import { simulatedPlatform } from "@/server/customer-payments/providers/simulated";
import { ProviderCallError } from "@/server/customer-payments/providers/types";
import { emptyEvent } from "@/lib/invoices/payment-events";
import { contactIn, dealFor, invoiceOrg, issuedInvoice, line, providerPayment, rows } from "./support/invoices";
import { attempt, attemptNow, connect, deliver, fakePaymongo, invoiceNow, paymentsOf, paymongoPaid, paymongoRefundUpdated, q, receipts, simulatedSetup } from "./support/customer-payments";

// The job works across every workspace, so what earlier tests left behind (open checkouts, unfinished receipts, connections not yet checked) is set aside before each test:
// what a test counts is only what the test made.
beforeEach(async () => {
  await withSystem(async (db) => {
    await db.query("update customer_payment_attempts set status = 'cancelled' where status in ('created', 'redirected')");
    await db.query("update customer_payment_events set outcome = 'ignored' where outcome in ('received', 'error', 'deferred')");
    await db.query("update customer_payment_connections set last_checked_at = now() where last_checked_at is null or last_checked_at < now() - interval '24 hours'");
  });
});

const soon = (minutes: number) => new Date(Date.now() + minutes * 60_000);
const run = (minutes: number, deps: Parameters<typeof runCustomerPaymentReconcileDetailed>[0] = {}) => runCustomerPaymentReconcileDetailed({ now: soon(minutes), ...deps });

async function setup(over: Parameters<typeof connect>[1] = {}, attemptOver: Parameters<typeof attempt>[2] = {}) {
  const io = await invoiceOrg();
  const inv = (await issuedInvoice(io)).invoice;
  const conn = await connect(io, over);
  const a = await attempt(inv.id, conn, attemptOver);
  return { io, inv, conn, a };
}
type S = Awaited<ReturnType<typeof setup>>;
const succeeded = (s: S, paymentId: string) => ({ ...emptyEvent("payment.succeeded", { eventId: `evt_${paymentId}`, type: "t", livemode: false }), checkoutId: s.a.checkoutId, reference: s.a.reference, paymentId, amountMinor: s.a.amountMinor, currency: "PHP" });

describe("a delivery that was received and never finished", () => {
  it("is applied from its receipt once it has waited ten minutes, and only once", async () => {
    const s = await setup();
    const stored = await storeReceipt({ id: s.conn.id, orgId: s.io.orgId }, succeeded(s, "pay_lost"), sha256("x"));
    expect((await run(5)).retried).toBe(0); // too fresh: its own delivery may still be on its way
    expect(await paymentsOf(s.inv.id)).toEqual([]);
    expect(await run(11)).toMatchObject({ retried: 1 });
    expect(await paymentsOf(s.inv.id)).toMatchObject([{ status: "succeeded", provider_payment_id: "pay_lost" }]);
    expect(await invoiceNow(s.inv.id)).toMatchObject({ payment_status: "paid", paid_minor: "150000" });
    expect((await receipts(s.conn.id)).find((r) => r.id === stored.receiptId)).toMatchObject({ outcome: "processed", attempts: 1 });
    expect(await run(12)).toMatchObject({ retried: 0 });
    expect(await paymentsOf(s.inv.id)).toHaveLength(1);
  });

  it("retries one that failed, and gives up after the cap so a poison event is left for the alarm", async () => {
    const s = await setup();
    const stored = await storeReceipt({ id: s.conn.id, orgId: s.io.orgId }, succeeded(s, "pay_boom2"), sha256("y"));
    await markReceiptError(stored.receiptId, "Error: boom");
    await withSystem((db) => db.query("create or replace function test_boom2() returns trigger language plpgsql as $$ begin if new.provider_payment_id = 'pay_boom2' then raise exception 'boom'; end if; return new; end $$"));
    await withSystem((db) => db.query("create trigger test_boom2 before insert on customer_payments for each row execute function test_boom2()"));
    try {
      // Still failing: the run goes on to its other work, the receipt stays open and counts the try.
      expect((await run(11)).retried).toBe(0);
      expect((await receipts(s.conn.id))[0]).toMatchObject({ outcome: "error", attempts: 2 });
      await withSystem((db) => db.query("update customer_payment_events set attempts = $2 where id = $1", [stored.receiptId, MAX_ATTEMPTS]));
    } finally {
      await withSystem((db) => db.query("drop trigger test_boom2 on customer_payments"));
    }
    // Over the cap: not retried again, even though it would work now.
    expect(await run(30)).toMatchObject({ retried: 0 });
    expect(await paymentsOf(s.inv.id)).toEqual([]);
    expect((await receipts(s.conn.id))[0].outcome).toBe("error");
    // Under it, it is.
    await withSystem((db) => db.query("update customer_payment_events set attempts = 3 where id = $1", [stored.receiptId]));
    expect(await run(30)).toMatchObject({ retried: 1 });
    expect(await paymentsOf(s.inv.id)).toMatchObject([{ status: "succeeded" }]);
  });

  it("applies a refund that came before its payment once the payment is there, and lets go of one nobody's payment ever matched, quietly", async () => {
    const s = await setup();
    expect((await deliver(s.conn, paymongoRefundUpdated({ paymentId: "pay_first", refundId: "ref_first", amount: 5000 }))).outcome).toBe("deferred");
    expect((await deliver(s.conn, paymongoRefundUpdated({ paymentId: "pay_never_ours", refundId: "ref_foreign", amount: 700 }))).outcome).toBe("deferred");
    await deliver(s.conn, paymongoPaid({ checkoutId: s.a.checkoutId!, reference: s.a.reference, amount: s.a.amountMinor, paymentId: "pay_first" }));
    expect(await run(11)).toMatchObject({ retried: 1 });
    expect((await invoiceNow(s.inv.id)).refunded_minor).toBe("5000");
    const by = async (id: string) => (await receipts(s.conn.id)).find((r) => r.detail.facts?.refundId === id)!;
    expect(await by("ref_first")).toMatchObject({ outcome: "processed" });
    expect(await by("ref_foreign")).toMatchObject({ outcome: "deferred" });
    // Three days on, the refund that matched nothing is let go; nobody is told, because it was most likely the business's own other sale.
    const notesBefore = (await rows("select id from notifications where org_id = $1", [s.io.orgId])).length;
    await run(73 * 60);
    expect(await by("ref_foreign")).toMatchObject({ outcome: "ignored", detail: { note: expect.stringMatching(/most likely not one of this product's/) } });
    expect((await rows("select id from notifications where org_id = $1", [s.io.orgId])).length).toBe(notesBefore);
  });
});

describe("checkouts nobody paid", () => {
  it("expires an open checkout whose time is up, closes a request that never got an answer, and leaves a fresh or a finished one alone", async () => {
    const io = await invoiceOrg();
    const conn = await connect(io);
    const mk = async (over: Parameters<typeof attempt>[2]) => {
      const inv = (await issuedInvoice(io)).invoice;
      return attempt(inv.id, conn, over);
    };
    const timedOut = await mk({ expiresInHours: -1 });
    const unanswered = await mk({ checkoutId: null, status: "created", ageMinutes: 15 });
    const settingUp = await mk({ checkoutId: null, status: "created", ageMinutes: 2 });
    const open = await mk({});
    const done = await mk({ status: "succeeded", expiresInHours: -1 });
    expect(await run(0)).toMatchObject({ expired: 1, closedUnanswered: 1 });
    expect(await attemptNow(timedOut.id)).toMatchObject({ status: "expired" });
    expect(await attemptNow(unanswered.id)).toMatchObject({ status: "failed" });
    expect((await attemptNow(settingUp.id)).status).toBe("created");
    expect((await attemptNow(open.id)).status).toBe("redirected");
    expect((await attemptNow(done.id)).status).toBe("succeeded");
  });
});

describe("a payment whose webhook was lost", () => {
  it("is not looked for while the checkout is young", async () => {
    const s = await simulatedSetup();
    simulatedPlatform.pay(s.a.checkoutId!, s.conn.webhookSecret);
    expect(await run(5)).toMatchObject({ retried: 0, expired: 0, closedUnanswered: 0, polled: 0, recordedFromPoll: 0, dealRules: 0 });
    expect(simulatedPlatform.calls("fetch")).toBe(0);
    expect(await paymentsOf(s.inv.id)).toEqual([]);
  });

  it("is found by reading the open checkout back, recorded through the same receipt path, and not asked about again at once", async () => {
    const s = await simulatedSetup({ ageMinutes: 45 });
    const lost = simulatedPlatform.pay(s.a.checkoutId!, s.conn.webhookSecret);
    expect(await run(0)).toMatchObject({ polled: 1, recordedFromPoll: 1 });
    expect(await paymentsOf(s.inv.id)).toMatchObject([{ status: "succeeded", provider_payment_id: lost.paymentId, verification: "provider_confirmed" }]);
    expect(await invoiceNow(s.inv.id)).toMatchObject({ payment_status: "paid", paid_minor: "150000" });
    expect((await attemptNow(s.a.id)).status).toBe("succeeded");
    expect((await receipts(s.conn.id)).map((x) => [x.provider_event_id, x.outcome])).toEqual([[`poll:${lost.paymentId}`, "processed"]]);
    // The webhook that was thought lost arrives after all: it is the one payment.
    expect((await deliver(s.conn, lost.rawBody, { signature: lost.signature })).outcome).toBe("processed");
    expect(await paymentsOf(s.inv.id)).toHaveLength(1);
    expect((await invoiceNow(s.inv.id)).paid_minor).toBe("150000");
    const calls = simulatedPlatform.calls("fetch");
    expect(await run(1)).toMatchObject({ polled: 0 });
    expect(simulatedPlatform.calls("fetch")).toBe(calls);
  });

  it("looks at each open checkout in turn, not the same ones again and again", async () => {
    const s = await simulatedSetup({ ageMinutes: 45 });
    expect(await run(0)).toMatchObject({ polled: 1, recordedFromPoll: 0 });
    // Looked at: the next run, a few minutes later, does not ask again; one a quarter of an hour on does.
    expect(await run(5)).toMatchObject({ polled: 0 });
    expect(await run(20)).toMatchObject({ polled: 1 });
    expect((await attemptNow(s.a.id)).status).toBe("redirected");
  });

  it("closes a checkout the provider says ran out, and records nothing for a record that names another reference", async () => {
    const s = await simulatedSetup({ ageMinutes: 45 });
    simulatedPlatform.expire(s.a.checkoutId!);
    expect(await run(0)).toMatchObject({ polled: 1, recordedFromPoll: 0 });
    expect((await attemptNow(s.a.id)).status).toBe("expired");

    const t = await simulatedSetup({ ageMinutes: 45 });
    simulatedPlatform.pay(t.a.checkoutId!, t.conn.webhookSecret);
    const co = simulatedPlatform.checkout(t.a.checkoutId!)!;
    co.reference = "CP-someoneelsesreference000000000";
    expect(await run(60)).toMatchObject({ polled: 1, recordedFromPoll: 0 });
    expect(await paymentsOf(t.inv.id)).toEqual([]);
  });

  it("leaves a checkout alone, and tries it again later, when the provider cannot be reached", async () => {
    const s = await simulatedSetup({ ageMinutes: 45 });
    simulatedPlatform.pay(s.a.checkoutId!, s.conn.webhookSecret);
    simulatedPlatform.failNext("fetch", new ProviderCallError("unreachable", "The platform could not be reached."));
    expect(await run(0)).toMatchObject({ polled: 0, recordedFromPoll: 0 });
    expect(await paymentsOf(s.inv.id)).toEqual([]);
    expect(await run(20)).toMatchObject({ polled: 1, recordedFromPoll: 1 });
    expect(await invoiceNow(s.inv.id)).toMatchObject({ payment_status: "paid" });
  });

  describe("a real provider", () => {
    const f = fakePaymongo();
    const old = () => setup({ provider: "paymongo" }, { ageMinutes: 45 });
    const paidCheckout = (s: S, over: { reference?: string; amount?: number } = {}) =>
      f.on((r) => r.method === "GET", { status: 200, json: { data: { id: s.a.checkoutId, attributes: { status: "active", reference_number: over.reference ?? s.a.reference, payments: [{ id: "pay_polled", attributes: { amount: over.amount ?? 150000, currency: "PHP", status: "paid" } }] } } } });
    beforeAll(() => setAdapterForTests("paymongo", createPaymongoProvider({ http: f.http })));
    afterAll(() => {
      setAdapterForTests("paymongo", null);
      delete process.env.CUSTOMER_PAYMENTS_WRITES_ENABLED;
      resetEnvCache();
    });

    it("is never asked while the environment's calls switch is off: the checkout is left exactly as it was", async () => {
      const s = await old();
      paidCheckout(s);
      const before = f.calls.length;
      expect(await run(0)).toMatchObject({ polled: 0, recordedFromPoll: 0, connectionsChecked: 0 });
      expect(f.calls.length).toBe(before);
      expect((await attemptNow(s.a.id)).status).toBe("redirected");
      expect(await paymentsOf(s.inv.id)).toEqual([]);
    });

    it("reads it back once the switch is on, and counts what the provider's own record shows", async () => {
      process.env.CUSTOMER_PAYMENTS_WRITES_ENABLED = "true";
      resetEnvCache();
      const s = await old();
      paidCheckout(s);
      expect(await run(0)).toMatchObject({ polled: 1, recordedFromPoll: 1 });
      expect(await paymentsOf(s.inv.id)).toMatchObject([{ status: "succeeded", provider_payment_id: "pay_polled" }]);
      expect(f.calls.some((c) => c.method === "GET" && c.path === `/v1/checkout_sessions/${s.a.checkoutId}` && c.apiKey === s.conn.apiKey)).toBe(true);
      // A record that names another reference is not this checkout.
      const t = await old();
      paidCheckout(t, { reference: "CP-0123456789abcdef0123456789abcdef" });
      expect(await run(0)).toMatchObject({ recordedFromPoll: 0 });
      expect(await paymentsOf(t.inv.id)).toEqual([]);
      // A payment at another amount than the checkout asked for is kept for a person.
      const u = await old();
      paidCheckout(u, { amount: 1000 });
      expect(await run(0)).toMatchObject({ polled: 1 });
      expect(await paymentsOf(u.inv.id)).toMatchObject([{ status: "needs_review" }]);
      expect(await invoiceNow(u.inv.id)).toMatchObject({ payment_status: "unpaid" });
    });
  });
});

describe("a payment account is checked once a day", () => {
  const f = fakePaymongo();
  const owner = (s: S) => s.io.c.people.owner.id;
  beforeAll(() => {
    setAdapterForTests("paymongo", createPaymongoProvider({ http: f.http }));
  });
  afterAll(() => {
    setAdapterForTests("paymongo", null);
    delete process.env.CUSTOMER_PAYMENTS_WRITES_ENABLED;
    resetEnvCache();
  });
  const checked = (id: string) => q<{ status: string; last_checked_at: string | null; last_error: string | null }>("select status, last_checked_at, last_error from customer_payment_connections where id = $1", [id]).then((r) => r[0]);

  it("asks a real provider nothing while the calls switch is off, and the simulated one reaches nothing, so it is checked", async () => {
    const s = await setup({ provider: "paymongo" });
    f.on(() => true, { status: 401, json: null });
    const before = f.calls.length;
    expect(await run(0)).toMatchObject({ connectionsChecked: 0 });
    expect(f.calls.length).toBe(before);
    expect(await checked(s.conn.id)).toMatchObject({ status: "connected", last_checked_at: null });
    const sim = await setup({ provider: "simulated" });
    expect((await run(0)).connectionsChecked).toBeGreaterThanOrEqual(1);
    expect(await checked(sim.conn.id)).toMatchObject({ status: "connected", last_error: null });
    expect((await checked(sim.conn.id)).last_checked_at).not.toBeNull();
    // Checked today: not again until tomorrow.
    expect((await run(60)).connectionsChecked).toBe(0);
  });

  it("stops new payments and tells the owner once a day when the provider refuses the key, and recovers when it accepts it again", async () => {
    process.env.CUSTOMER_PAYMENTS_WRITES_ENABLED = "true";
    resetEnvCache();
    const s = await setup({ provider: "paymongo" });
    // Every other workspace's account is checked on its own turn (a few at a time); this one is looked at on its own here.
    await withSystem((db) => db.query("update customer_payment_connections set last_checked_at = now() + interval '30 days' where id <> $1", [s.conn.id]));
    f.on(() => true, { status: 401, json: { errors: [{ code: "authentication_failed" }] } });
    await run(0);
    expect(await checked(s.conn.id)).toMatchObject({ status: "needs_attention", last_error: expect.stringMatching(/did not accept this key/) });
    const notes = await rows<{ title: string; link: string }>("select title, link from notifications where org_id = $1 and kind = 'payment_connection_attention' and user_id = $2", [s.io.orgId, owner(s)]);
    expect(notes).toEqual([{ title: "Your payment account needs attention", link: "/settings/payments" }]);
    // The same trouble a day later is the same notice for that day; a different day is a new one.
    await run(24 * 60 + 1);
    expect(await rows("select id from notifications where org_id = $1 and kind = 'payment_connection_attention' and user_id = $2", [s.io.orgId, owner(s)])).toHaveLength(2);
    f.on(() => true, { status: 200, json: { data: [] } });
    await run(2 * 24 * 60 + 2);
    expect(await checked(s.conn.id)).toMatchObject({ status: "connected", last_error: null });
  });

  it("changes nothing but the note when the provider cannot be reached", async () => {
    process.env.CUSTOMER_PAYMENTS_WRITES_ENABLED = "true";
    resetEnvCache();
    const s = await setup({ provider: "paymongo" });
    f.on(() => true, { status: 503, json: null });
    await run(0);
    expect(await checked(s.conn.id)).toMatchObject({ status: "connected", last_error: expect.stringMatching(/busy or having trouble/) });
    expect(await rows("select id from notifications where org_id = $1 and kind = 'payment_connection_attention'", [s.io.orgId])).toEqual([]);
  });
});

describe("a deal rule an interrupted payment skipped", () => {
  async function dealInvoice(io: Awaited<ReturnType<typeof invoiceOrg>>) {
    const dealId = await dealFor(io, await contactIn(io), { ownerId: io.c.people.sales.id });
    const d = await createDraft(io.ctx("owner"), { opportunityId: dealId, currency: "PHP", lines: [line({ unitPrice: "1500" })] });
    const inv = (await issueInvoice(io.ctx("owner"), d.invoice.id, { version: d.invoice.version })).detail.invoice;
    return { dealId, inv };
  }
  const tasks = (dealId: string) => rows<{ title: string }>("select title from tasks where opportunity_id = $1", [dealId]);

  it("runs now, once, for an invoice paid in full whose rule never got to act", async () => {
    const io = await invoiceOrg();
    await withSystem((db) => db.query("insert into customer_invoice_settings (org_id, close_rule) values ($1, 'task') on conflict (org_id) do update set close_rule = 'task'", [io.orgId]));
    const { dealId, inv } = await dealInvoice(io);
    const conn = await connect(io);
    // The payment was recorded, and the process died before the deal rule ran.
    await providerPayment(io, inv.id, conn.id, 150_000, { provider: "paymongo", livemode: true });
    expect(await tasks(dealId)).toEqual([]);
    expect(await run(0)).toMatchObject({ dealRules: 1 });
    expect(await tasks(dealId)).toEqual([{ title: "Invoice INV-0001 is paid: mark the deal won?" }]);
    expect(await run(1)).toMatchObject({ dealRules: 0 });
    expect(await tasks(dealId)).toHaveLength(1);
  });

  it("does nothing for the default rule, for an invoice still owing, or for one with no deal", async () => {
    const none = await invoiceOrg();
    const a = await dealInvoice(none);
    await providerPayment(none, a.inv.id, await connect(none).then((c) => c.id), 150_000, { provider: "paymongo", livemode: true });
    expect(await run(0)).toMatchObject({ dealRules: 0 });
    expect(await tasks(a.dealId)).toEqual([]);

    const task = await invoiceOrg();
    await withSystem((db) => db.query("insert into customer_invoice_settings (org_id, close_rule) values ($1, 'task') on conflict (org_id) do update set close_rule = 'task'", [task.orgId]));
    const owing = await dealInvoice(task);
    await providerPayment(task, owing.inv.id, await connect(task).then((c) => c.id), 50_000, { provider: "paymongo", livemode: true });
    const noDeal = (await issuedInvoice(task)).invoice;
    await providerPayment(task, noDeal.id, (await q<{ id: string }>("select id from customer_payment_connections where org_id = $1", [task.orgId]))[0].id, 150_000, { provider: "paymongo", livemode: true });
    expect(await run(0)).toMatchObject({ dealRules: 0 });
    expect(await tasks(owing.dealId)).toEqual([]);
  });
});

