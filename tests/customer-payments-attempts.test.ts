// Starting a customer's payment on embedded Postgres: one open checkout per invoice, for the balance the SERVER worked out, through a connection that is allowed to
// take it, with the provider asked outside any transaction. Nothing contacts a provider: PayMongo's network layer is a fixture and the simulated provider lives in process.
import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { env, resetEnvCache } from "@/server/env";
import { invoiceTokenFor } from "@/server/invoices/links";
import { voidInvoice, writeOffInvoice } from "@/server/invoices/invoices";
import { setInvoicesEnabled } from "@/server/invoices/feature";
import { recordManualPayment } from "@/server/invoices/payments";
import { applyDisputeInTx } from "@/server/invoices/apply";
import { startCheckout, ATTEMPT_TTL_HOURS } from "@/server/customer-payments/attempts";
import { createPaymongoProvider } from "@/server/customer-payments/providers/paymongo";
import { setAdapterForTests } from "@/server/customer-payments/providers";
import { simulatedPlatform, simulatedProvider } from "@/server/customer-payments/providers/simulated";
import { ProviderCallError, type CheckoutInput, type PaymentProviderAdapter } from "@/server/customer-payments/providers/types";
import { draftBy, invoiceOrg, issuedInvoice, providerPayment, rows } from "./support/invoices";
import { connect, deliver, fakePaymongo, q } from "./support/customer-payments";

const NOW = new Date("2026-10-23T12:00:00Z");
const PUBLIC_WORDS = "Online payment is not available for this invoice right now. Please contact the business to arrange payment.";
const pay = { receivedOn: "2026-10-23", method: "bank_transfer" as const, evidence: "Bank transfer ref 4410" };

afterEach(() => {
  setAdapterForTests("simulated", null);
  simulatedPlatform.reset();
});

async function setup(over: Parameters<typeof connect>[1] | null = { provider: "simulated" }) {
  const io = await invoiceOrg();
  const inv = (await issuedInvoice(io, {}, NOW)).invoice;
  const conn = over === null ? null : await connect(io, over);
  return { io, inv, conn };
}
const open = (invoiceId: string) => q<{ id: string; status: string; amount_minor: string; reference: string; provider_checkout_id: string | null; checkout_url: string | null; expires_at: string }>(
  "select id, status, amount_minor::text, reference, provider_checkout_id, checkout_url, expires_at from customer_payment_attempts where invoice_id = $1 order by created_at, id", [invoiceId]);
const start = (s: { io: { orgId: string }; inv: { id: string } }, audience: "public" | "member" = "public", now?: Date, userId?: string) =>
  startCheckout({ orgId: s.io.orgId, invoiceId: s.inv.id, audience, actorUserId: userId }, { now });

/** The simulated provider, watched: what it was asked to create. */
function watched(): { asked: CheckoutInput[] } {
  const asked: CheckoutInput[] = [];
  const spy: PaymentProviderAdapter = { ...simulatedProvider, async createCheckout(c, input) { asked.push(input); return simulatedProvider.createCheckout(c, input); } };
  setAdapterForTests("simulated", spy);
  return { asked };
}

describe("starting a payment", () => {
  it("makes one checkout for the invoice's balance, ties it to a reference of ours, and sends the provider an invoice number and a return address with no secret in it", async () => {
    const s = await setup();
    const w = watched();
    const r = await start(s, "public", NOW);
    expect(r).toMatchObject({ reused: false, provider: "simulated", amountMinor: 150000, currency: "PHP", checkoutUrl: expect.stringMatching(/^https:\/\/simulated-checkout\.invalid\/pay\/simco_/) });
    const [a] = await open(s.inv.id);
    expect(a).toMatchObject({ id: r.attemptId, status: "redirected", amount_minor: "150000", provider_checkout_id: expect.stringMatching(/^simco_/), checkout_url: r.checkoutUrl });
    expect(a.reference).toMatch(/^CP-[0-9a-f]{32}$/);
    expect(new Date(a.expires_at).getTime()).toBe(NOW.getTime() + ATTEMPT_TTL_HOURS * 3_600_000);
    expect(w.asked).toHaveLength(1);
    const asked = w.asked[0];
    expect(asked).toMatchObject({ reference: a.reference, amountMinor: 150000, currency: "PHP", description: "Invoice INV-0001" });
    // The invoice's link is a bearer credential: it goes to nobody, and the provider's return address carries the checkout's own reference instead.
    expect(asked.successUrl).toBe(`${env().APP_URL.replace(/\/+$/, "")}/pay/return/${a.reference}`);
    expect(asked.cancelUrl).toBe(`${asked.successUrl}?result=cancelled`);
    const token = invoiceTokenFor(s.inv.id, 1);
    for (const text of [asked.successUrl, asked.cancelUrl, asked.description, JSON.stringify(simulatedPlatform.checkouts())]) expect(text).not.toContain(token);
    expect(simulatedPlatform.checkouts()).toMatchObject([{ reference: a.reference, amountMinor: 150000, status: "open" }]);
    // The customer's name is on the invoice and nowhere in what the provider was told.
    expect(JSON.stringify(asked)).not.toMatch(/Maria|Santos/);
    const events = await rows<{ kind: string; detail: Record<string, unknown> }>("select kind, detail from customer_invoice_events where invoice_id = $1 and kind = 'checkout_started'", [s.inv.id]);
    expect(events).toHaveLength(1);
    expect(events[0].detail).toMatchObject({ attemptId: r.attemptId, provider: "simulated", amount: "1500.00", currency: "PHP", audience: "public" });
    expect(JSON.stringify(events)).not.toContain("simulated-checkout");
  });

  it("keeps the provider's address where the application role cannot read it", async () => {
    const s = await setup();
    await start(s);
    const err = await withUser(s.io.c.people.owner.id, (db) => db.query("select checkout_url from customer_payment_attempts")).catch((e: unknown) => e);
    expect(String(err)).toMatch(/permission denied/);
    const ok = await withUser(s.io.c.people.owner.id, (db) => db.query("select id, reference, provider_checkout_id from customer_payment_attempts where invoice_id = $1", [s.inv.id]));
    expect(ok.rows).toHaveLength(1);
  });

  it("finds the one open checkout again for a second click, a second tab and the team, and makes one however many ask at once", async () => {
    const s = await setup();
    const first = await start(s, "public", NOW);
    const again = await start(s, "public", NOW);
    const team = await start(s, "member", NOW, s.io.c.people.owner.id);
    expect(again).toMatchObject({ reused: true, attemptId: first.attemptId, checkoutUrl: first.checkoutUrl });
    expect(team).toMatchObject({ reused: true, attemptId: first.attemptId });
    expect(await open(s.inv.id)).toHaveLength(1);
    expect(simulatedPlatform.checkouts()).toHaveLength(1);

    simulatedPlatform.reset();
    const t = await setup();
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => start(t, "public")));
    const made = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof start>>> => r.status === "fulfilled" && !r.value.reused);
    expect(made).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(String(r.reason)).toMatch(/being set up/);
    expect(await open(t.inv.id)).toHaveLength(1);
    expect((await open(t.inv.id))[0].status).toBe("redirected");
    expect(simulatedPlatform.checkouts()).toHaveLength(1);
  });

  it("asks for what is owed NOW: a payment since the last checkout closes the old one and starts another for the new balance; an expired one is replaced", async () => {
    const s = await setup();
    const first = await start(s, "public", NOW);
    await recordManualPayment(s.io.ctx("owner"), s.inv.id, { ...pay, amount: "500", overrideOpenAttempt: true }, { now: NOW });
    const second = await start(s, "public", NOW);
    expect(second).toMatchObject({ reused: false, amountMinor: 100000 });
    expect(second.attemptId).not.toBe(first.attemptId);
    expect((await open(s.inv.id)).map((a) => [a.status, a.amount_minor])).toEqual([["cancelled", "150000"], ["redirected", "100000"]]);
    const later = await start(s, "public", new Date(NOW.getTime() + (ATTEMPT_TTL_HOURS + 1) * 3_600_000));
    expect(later.reused).toBe(false);
    expect((await open(s.inv.id)).map((a) => a.status)).toEqual(["cancelled", "expired", "redirected"]);
  });
});

describe("what is refused, and what a customer is told", () => {
  const refused = async (s: { io: { orgId: string }; inv: { id: string } }, member: RegExp) => {
    await expect(start(s, "public")).rejects.toThrow(PUBLIC_WORDS);
    await expect(start(s, "member")).rejects.toThrow(member);
  };

  it("says nothing of the business's setup to a customer, and the reason to the team, when nothing can take the payment", async () => {
    const none = await setup(null);
    await refused(none, /No payment account is connected/);
    const cases: Array<[Parameters<typeof connect>[1], RegExp]> = [
      [{ provider: "simulated", status: "disabled" }, /Online payments are paused/],
      [{ provider: "simulated", status: "pending_verification" }, /webhook signing secret has not been saved/],
      [{ provider: "simulated", status: "needs_attention" }, /needs attention/],
      [{ provider: "simulated", authorized: false }, /not recorded their authorization/],
      [{ provider: "simulated", currencies: ["USD"] }, /cannot collect PHP/],
    ];
    for (const [over, words] of cases) {
      const s = await setup(over);
      await refused(s, words);
      expect(await open(s.inv.id), JSON.stringify(over)).toEqual([]);
    }
  });

  it("refuses an invoice that is not issued, void, written off, disputed or already paid", async () => {
    const io = await invoiceOrg();
    const conn = await connect(io, { provider: "simulated" });
    const draft = (await draftBy(io)).invoice;
    await expect(start({ io, inv: draft }, "member")).rejects.toThrow(/has not been issued yet/);
    await expect(start({ io, inv: draft }, "public")).rejects.toThrow(PUBLIC_WORDS);

    const voided = (await issuedInvoice(io, {}, NOW)).invoice;
    await voidInvoice(io.ctx("owner"), voided.id, { reason: "Raised by mistake" });
    await expect(start({ io, inv: voided }, "member")).rejects.toThrow(/This invoice is void/);

    const off = (await issuedInvoice(io, {}, NOW)).invoice;
    await writeOffInvoice(io.ctx("owner"), off.id, { reason: "The customer closed their business" });
    await expect(start({ io, inv: off }, "member")).rejects.toThrow(/written off/);

    const disputed = (await issuedInvoice(io, {}, NOW)).invoice;
    const p = await providerPayment(io, disputed.id, conn.id, 50_000, { provider: "simulated" });
    await withSystem((db) => applyDisputeInTx(db, { orgId: io.orgId, paymentId: p.paymentId, open: true, actor: { id: null, kind: "provider" } }));
    await expect(start({ io, inv: disputed }, "member")).rejects.toThrow(/is disputed/);

    const paid = (await issuedInvoice(io, {}, NOW)).invoice;
    await providerPayment(io, paid.id, conn.id, 150_000, { provider: "simulated" });
    await expect(start({ io, inv: paid }, "member")).rejects.toThrow(/nothing left to pay/);
    await expect(start({ io, inv: paid }, "public")).rejects.toThrow(/already been paid/);
    expect(await q("select id from customer_payment_attempts where org_id = $1", [io.orgId])).toEqual([]);
  });

  it("starts nothing new once invoicing is switched off for the workspace, yet still records a payment that was already on its way", async () => {
    const s = await setup();
    const first = await start(s, "public", NOW);
    await setInvoicesEnabled(s.io.superAdmin, s.io.orgId, false);
    await expect(start(s, "public")).rejects.toThrow(PUBLIC_WORDS);
    await expect(start(s, "member")).rejects.toThrow(/not switched on for this workspace/);
    expect((await open(s.inv.id)).map((a) => a.status)).toEqual(["redirected"]);
    const [a] = await open(s.inv.id);
    expect(a.id).toBe(first.attemptId);
    const paid = simulatedPlatform.pay(a.provider_checkout_id!, s.conn!.webhookSecret);
    expect((await deliver(s.conn!, paid.rawBody, { signature: paid.signature })).outcome).toBe("processed");
    expect(await q("select status from customer_invoices where id = $1 and payment_status = 'paid'", [s.inv.id])).toHaveLength(1);
  });

  it("will not start a payment for another workspace's invoice", async () => {
    const a = await setup();
    const b = await setup();
    await expect(startCheckout({ orgId: b.io.orgId, invoiceId: a.inv.id, audience: "member" })).rejects.toThrow(/was not found/);
    expect(await open(a.inv.id)).toEqual([]);
  });

  it("flags a connection whose keys can no longer be read, and does not pretend it works", async () => {
    const s = await setup();
    await withSystem((db) => db.query("update customer_payment_connections set credentials = 'v1.garbage.garbage.garbage' where id = $1", [s.conn!.id]));
    await expect(start(s, "public")).rejects.toThrow(PUBLIC_WORDS);
    expect((await q<{ status: string; last_error: string }>("select status, last_error from customer_payment_connections where id = $1", [s.conn!.id]))[0]).toMatchObject({ status: "needs_attention", last_error: expect.stringMatching(/can no longer be read/) });
    // From then on the team is told the account needs attention, and nothing was started.
    await expect(start(s, "member")).rejects.toThrow(/needs attention/);
    expect(await open(s.inv.id)).toEqual([]);
  });
});

describe("when the provider does not answer well", () => {
  it("closes the attempt and says nothing was charged when the provider refuses, and the next try starts afresh", async () => {
    const s = await setup();
    simulatedPlatform.failNext("create", new ProviderCallError("rejected", "The platform declined the request."));
    await expect(start(s, "member")).rejects.toMatchObject({ code: "integration_unavailable", message: "The platform declined the request. Nothing was charged." });
    expect((await open(s.inv.id)).map((a) => a.status)).toEqual(["failed"]);
    expect(await start(s, "public")).toMatchObject({ reused: false });
    expect((await open(s.inv.id)).map((a) => a.status)).toEqual(["failed", "redirected"]);
    simulatedPlatform.failNext("create", new ProviderCallError("rejected", "Declined again."));
    const t = await setup();
    await expect(start(t, "public")).rejects.toThrow("The payment page could not be opened just now. Nothing was charged. Please try again in a few minutes.");
  });

  it("keeps the attempt when it cannot know whether the provider made a checkout, tells the payer to wait, and closes it only after the wait", async () => {
    const s = await setup();
    simulatedPlatform.failNext("create", new ProviderCallError("unreachable", "The platform could not be reached."));
    await expect(start(s, "member")).rejects.toMatchObject({ code: "upstream_error" });
    const [a] = await open(s.inv.id);
    expect(a).toMatchObject({ status: "created", provider_checkout_id: null, checkout_url: null });
    // A second payer is not sent to start a second checkout while the first may exist.
    await expect(start(s, "public")).rejects.toThrow(/being set up/);
    expect(await open(s.inv.id)).toHaveLength(1);
    const later = await start(s, "public", new Date(Date.now() + 2 * 60_000));
    expect(later.reused).toBe(false);
    expect((await open(s.inv.id)).map((x) => x.status)).toEqual(["cancelled", "redirected"]);
  });
});

describe("a real provider", () => {
  const f = fakePaymongo();
  beforeAll(() => {
    setAdapterForTests("paymongo", createPaymongoProvider({ http: f.http }));
    process.env.CUSTOMER_PAYMENTS_WRITES_ENABLED = "true";
    resetEnvCache();
  });
  afterAll(() => {
    setAdapterForTests("paymongo", null);
    delete process.env.CUSTOMER_PAYMENTS_WRITES_ENABLED;
    delete process.env.CUSTOMER_PAYMENTS_LIVE_ENABLED;
    resetEnvCache();
  });
  const answer = () => f.on((r) => r.method === "POST", { status: 200, json: { data: { id: "cs_real_1", attributes: { checkout_url: "https://checkout.paymongo.com/cs_real_1_client_x" } } } });

  it("is open to the team in test mode and never to a customer, and the team's checkout holds exactly the balance", async () => {
    const s = await setup({ provider: "paymongo", mode: "test" });
    answer();
    await expect(start(s, "public")).rejects.toThrow(PUBLIC_WORDS);
    expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    const r = await start(s, "member", NOW, s.io.c.people.owner.id);
    expect(r).toMatchObject({ provider: "paymongo", amountMinor: 150000, checkoutUrl: "https://checkout.paymongo.com/cs_real_1_client_x" });
    const post = f.calls.find((c) => c.method === "POST")!;
    expect(post).toMatchObject({ path: "/v1/checkout_sessions", apiKey: s.conn!.apiKey });
    const a = (post.body as { data: { attributes: { line_items: Array<{ amount: number; currency: string }>; reference_number: string } } }).data.attributes;
    expect(a.line_items).toMatchObject([{ amount: 150000, currency: "PHP" }]);
    expect(a.reference_number).toBe((await open(s.inv.id))[0].reference);
    expect((await q<{ actor_kind: string }>("select actor_kind from customer_invoice_events where invoice_id = $1 and kind = 'checkout_started'", [s.inv.id]))[0].actor_kind).toBe("user");
  });

  it("cannot collect an invoice in a currency the provider does not settle", async () => {
    const io = await invoiceOrg();
    const usd = (await issuedInvoice(io, { currency: "USD" }, NOW)).invoice;
    await connect(io, { provider: "paymongo", mode: "test" });
    answer();
    await expect(start({ io, inv: usd }, "member")).rejects.toThrow(/cannot collect USD/);
    expect(await open(usd.id)).toEqual([]);
  });

  it("opens live money only when the owner confirmed AND the service-wide switch is on, and the kill switch closes it at once", async () => {
    const s = await setup({ provider: "paymongo", mode: "live", liveConfirmed: true });
    answer();
    await expect(start(s, "public")).rejects.toThrow(PUBLIC_WORDS);
    await expect(start(s, "member")).rejects.toThrow(/Live payments are switched off for the whole service/);
    process.env.CUSTOMER_PAYMENTS_LIVE_ENABLED = "true";
    resetEnvCache();
    expect(await start(s, "public")).toMatchObject({ provider: "paymongo", reused: false });
    delete process.env.CUSTOMER_PAYMENTS_LIVE_ENABLED;
    resetEnvCache();
    await expect(start(s, "public")).rejects.toThrow(PUBLIC_WORDS);
    const unconfirmed = await setup({ provider: "paymongo", mode: "live", liveConfirmed: false });
    process.env.CUSTOMER_PAYMENTS_LIVE_ENABLED = "true";
    resetEnvCache();
    await expect(start(unconfirmed, "member")).rejects.toThrow(/has not confirmed going live/);
    delete process.env.CUSTOMER_PAYMENTS_LIVE_ENABLED;
    resetEnvCache();
  });

  it("is never asked while the environment's calls switch is off", async () => {
    delete process.env.CUSTOMER_PAYMENTS_WRITES_ENABLED;
    resetEnvCache();
    try {
      const s = await setup({ provider: "paymongo", mode: "test" });
      const before = f.calls.length;
      await expect(start(s, "member")).rejects.toThrow(/Calls to payment providers are switched off/);
      expect(f.calls.length).toBe(before);
    } finally {
      process.env.CUSTOMER_PAYMENTS_WRITES_ENABLED = "true";
      resetEnvCache();
    }
  });

  it("refuses an address that is not the provider's, closing the attempt, and hands the customer nothing", async () => {
    const s = await setup({ provider: "paymongo", mode: "test" });
    f.on((r) => r.method === "POST", { status: 200, json: { data: { id: "cs_evil", attributes: { checkout_url: "https://evil.example/cs_evil" } } } });
    await expect(start(s, "member")).rejects.toThrow(/did not point to PayMongo/);
    const [a] = await open(s.inv.id);
    expect(a).toMatchObject({ status: "failed", checkout_url: null });
  });
});

describe("the attempt is a record of what was asked, not something a payment can rewrite", () => {
  it("cannot be changed after it is made except to move to its next status", async () => {
    const s = await setup();
    const r = await start(s);
    await expect(withSystem((db) => db.query("update customer_payment_attempts set amount_minor = 1 where id = $1", [r.attemptId]))).rejects.toThrow(/cannot be changed/);
    await expect(withSystem((db) => db.query("update customer_payment_attempts set reference = 'CP-aaaaaaaaaaaaaaaaaaaaaaaa' where id = $1", [r.attemptId]))).rejects.toThrow(/cannot be changed/);
    await withSystem((db) => db.query("update customer_payment_attempts set status = 'expired' where id = $1", [r.attemptId]));
    await expect(withSystem((db) => db.query("update customer_payment_attempts set status = 'succeeded' where id = $1", [r.attemptId]))).rejects.toThrow(/cannot become/);
  });
});
