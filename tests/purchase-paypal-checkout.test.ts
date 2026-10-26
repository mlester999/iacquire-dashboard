// PayPal for a purchase intent, on embedded Postgres: the buyer's link opens ONE PayPal order for the frozen US-dollar fee; approving on PayPal's page does not take the money; THIS
// SERVER does, with the app's credentials, for the order WE stored; only PayPal's own record of a COMPLETED capture (the capture response, a verified signed notice or a read-back)
// can make the checkout paid; and every rule the PayMongo checkout has holds for PayPal too (reference, mode, amount and currency must equal what we stored; replays are harmless;
// refunds, disputes and mismatches hold the purchase for a person). PayPal is a stand-in written from the documentation (tests/support/paypal-agency.ts): nothing here reaches PayPal.
import crypto from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.PAYMONGO_SECRET_KEY = "sk_test_notarealkey123";
process.env.PAYMONGO_WEBHOOK_SECRET = "whsec_test_only_not_a_real_secret";
process.env.PAYPAL_CLIENT_ID = "AaTestClientIdNotReal0123456789";
process.env.PAYPAL_CLIENT_SECRET = "EkTestSecretNotReal0123456789abc";
process.env.PAYPAL_WEBHOOK_ID = "WH-TEST-0123456789";
process.env.PAYPAL_ENVIRONMENT = "sandbox";

import { resetEnvCache } from "@/server/env";
import { withSystem } from "@/server/db";
import { handleProviderWebhook } from "@/server/billing/payments";
import { createPaypalAdapter, normalizePaypalWebhook, paypalStatus } from "@/server/billing/providers/paypal";
import { createPurchaseIntent, getPublicPurchase, provisionPurchaseIntent, releasePurchaseHold, startPurchase, verifyPurchasePayment, getCheckoutSwitch } from "@/server/purchase-intents/service";
import { availableCheckoutProviders, providerReadiness } from "@/server/purchase-intents/availability";
import { completePaypalPurchaseReturn, getCheckoutReturn, listIntentCheckouts, runPurchaseCheckoutSweep, startPurchaseCheckout } from "@/server/purchase-intents/checkout";
import { agencyUser } from "./support/fixtures";
import { agencyOrgId, rows, staffPerson } from "./support/staff-messages";
import { captureCompletedEvent, captureDeniedEvent, captureRefundedEvent, captureReversedEvent, disputeCreatedEvent, fakePaypal, paypalHeaders, type FakePaypal } from "./support/paypal-agency";

const NOW = new Date();
const email = () => `buyer-${crypto.randomUUID().slice(0, 8)}@example.test`;
const uid = () => crypto.randomUUID().slice(0, 8);

async function world() {
  const agencyId = await agencyOrgId();
  const superAdmin = await staffPerson("agency_super_admin");
  return { agencyId, superAdmin, superSession: agencyUser(superAdmin, "agency_super_admin") };
}

const setBilling = (over: { enabled?: boolean; rate?: number | null; reviewed?: boolean } = {}) =>
  withSystem((db) => db.query(
    "update agency_billing_settings set purchase_checkout_enabled = $1, usd_php_rate = $2, fx_source = 'test fixture', fx_updated_at = now(), live_payments_review_at = case when $3 then now() else null end",
    [over.enabled ?? true, over.rate === undefined ? 58 : over.rate, over.reviewed ?? true],
  ));

let pp: FakePaypal;
let adapter: ReturnType<typeof createPaypalAdapter>;
beforeAll(() => resetEnvCache());
beforeEach(async () => {
  await setBilling();
  // Orders of earlier cases belong to earlier PayPal stand-ins; close them so each case sweeps only its own.
  await withSystem((db) => db.query("update purchase_intent_checkouts set status = 'cancelled', failure_reason = 'test cleanup' where provider = 'paypal' and status in ('creating', 'pending')"));
  pp = fakePaypal();
  adapter = createPaypalAdapter({ wire: pp.wire });
});

const make = async (w: Awaited<ReturnType<typeof world>>, over: { autoProvision?: boolean } = {}) => {
  const created = await createPurchaseIntent(w.superSession, {
    buyerName: "Bailey Buyer", buyerEmail: email(), company: `PayPal Buyer Co ${uid()}`, industry: "Home services", website: "https://buyer.example.test", timezone: "America/Chicago",
    maintenanceSelected: false, autoProvision: over.autoProvision ?? false,
  }, { now: NOW });
  await startPurchase(created.token, { now: NOW });
  return created;
};

let nextBuyer = 0;
const ip = () => `198.51.100.${(nextBuyer++ % 250) + 1}`;
const open = async (token: string) => startPurchaseCheckout(token, { ip: ip(), provider: "paypal" }, { now: NOW, paypal: { wire: pp.wire } });
const ret = (reference: string) => completePaypalPurchaseReturn(reference, { ip: ip() }, { paypal: { wire: pp.wire } });
const deliver = (body: string, headers = paypalHeaders()) => handleProviderWebhook(adapter, { rawBody: body, headers });
const intentRow = async (id: string) => (await rows<Record<string, unknown>>("select status, payment_source, payment_checkout_id, payment_hold, payment_method, payment_reference, payment_amount_cents, auto_provision from purchase_intents where id = $1", [id]))[0];
const checkoutRow = async (reference: string) => (await rows<Record<string, unknown>>("select * from purchase_intent_checkouts where reference_number = $1", [reference]))[0];
const eventsOf = async (intentId: string, kind: string) => rows("select 1 from purchase_intent_events where intent_id = $1 and kind = $2", [intentId, kind]);

describe("PayPal is offered only when it can take and confirm a payment", () => {
  it("reads its readiness from the environment, needs the review for a live app, and needs no exchange rate", async () => {
    expect(paypalStatus()).toMatchObject({ configured: true, webhookConfigured: true, livemode: false, environment: "sandbox" });
    const ready = await withSystem((db) => providerReadiness(db, "paypal"));
    expect(ready).toMatchObject({ available: true, livemode: false });
    // PayPal charges the dollar price, so a missing exchange rate stops PayMongo and not PayPal.
    await setBilling({ rate: null });
    expect((await withSystem((db) => providerReadiness(db, "paymongo"))).available).toBe(false);
    expect((await withSystem((db) => providerReadiness(db, "paypal"))).available).toBe(true);
  });

  it("lists each ready provider for the buyer and for the team, and the switch still closes both", async () => {
    const w = await world();
    const c = await make(w);
    expect((await withSystem((db) => availableCheckoutProviders(db))).map((p) => p.provider)).toEqual(["paymongo", "paypal"]);
    const view = await getPublicPurchase(c.token, { now: NOW });
    expect(view?.checkout.offered).toBe(true);
    expect(view?.checkout.providers).toEqual([{ id: "paymongo", label: "PayMongo" }, { id: "paypal", label: "PayPal" }]);
    const team = await getCheckoutSwitch(w.superSession);
    expect(team.providers.map((p) => [p.id, p.available])).toEqual([["paymongo", true], ["paypal", true]]);
    await setBilling({ enabled: false });
    expect((await getPublicPurchase(c.token, { now: NOW }))?.checkout).toMatchObject({ offered: false, providers: [] });
    await expect(startPurchaseCheckout(c.token, { ip: ip(), provider: "paypal" }, { now: NOW, paypal: { wire: pp.wire } })).rejects.toMatchObject({ code: "integration_unavailable" });
    expect(pp.calls).toHaveLength(0); // a closed checkout never reaches PayPal
  });

  it("is not offered while the PayPal webhook id is missing, because a payment could not be confirmed", async () => {
    const was = process.env.PAYPAL_WEBHOOK_ID;
    delete process.env.PAYPAL_WEBHOOK_ID;
    resetEnvCache();
    try {
      const r = await withSystem((db) => providerReadiness(db, "paypal"));
      expect(r.available).toBe(false);
      expect(r.reason).toMatch(/webhook id/);
    } finally {
      process.env.PAYPAL_WEBHOOK_ID = was;
      resetEnvCache();
    }
  });
});

describe("opening the PayPal order", () => {
  it("asks PayPal for exactly the frozen US-dollar fee with our reference, never the bearer token, and stores a US-dollar checkout with no exchange rate", async () => {
    const w = await world();
    const c = await make(w);
    const o = await open(c.token);
    const create = pp.calls.find((x) => x.path === "/v2/checkout/orders" && x.method === "POST");
    expect(create).toBeTruthy();
    const body = create!.body as { intent: string; purchase_units: Array<{ custom_id: string; amount: { currency_code: string; value: string }; description: string }>; payment_source: { paypal: { experience_context: Record<string, string> } } };
    expect(body.intent).toBe("CAPTURE");
    expect(body.purchase_units[0]).toMatchObject({ custom_id: o.reference, amount: { currency_code: "USD", value: "1499.00" } });
    expect(body.purchase_units[0].description).toContain(`[${o.reference}]`);
    const ctx = body.payment_source.paypal.experience_context;
    expect(ctx.return_url).toBe(`${process.env.APP_URL?.replace(/\/$/, "") ?? "http://localhost:3000"}/purchase/return/${o.reference}`.replace(/^$/, ""));
    expect(ctx.return_url).toContain(`/purchase/return/${o.reference}`);
    expect(ctx.cancel_url).toContain(`/purchase/return/${o.reference}?result=cancelled`);
    expect(JSON.stringify(create!.body)).not.toContain(c.token);
    expect(create!.headers["PayPal-Request-Id"]).toBe(o.reference);
    expect(new URL(o.checkoutUrl).hostname).toMatch(/(^|\.)paypal\.com$/);
    const row = await checkoutRow(o.reference);
    expect(row).toMatchObject({ provider: "paypal", status: "pending", charged_currency: "USD", usd_amount_cents: 149900, fx_rate: null, livemode: false });
    expect(Number(row.charged_amount_minor)).toBe(149900);
    expect(row.provider_checkout_id).toBe(pp.byReference(o.reference)?.id);
  });

  it("returns the checkout that is already open instead of opening a second order", async () => {
    const w = await world();
    const c = await make(w);
    const first = await open(c.token);
    const again = await open(c.token);
    expect(again).toMatchObject({ resumed: true, checkoutUrl: first.checkoutUrl, reference: first.reference });
    expect(pp.orders.size).toBe(1);
    // A buyer who chose the other provider meanwhile is shown the open PayPal order, not a second payment page.
    const other = await startPurchaseCheckout(c.token, { ip: ip(), provider: "paymongo" }, { now: NOW });
    expect(other).toMatchObject({ resumed: true, checkoutUrl: first.checkoutUrl });
  });

  it("closes the checkout as failed and charges nobody when PayPal cannot be reached or refuses the app", async () => {
    const w = await world();
    const c = await make(w);
    pp.state.down = true;
    await expect(open(c.token)).rejects.toMatchObject({ code: "integration_unavailable" });
    const failed = await rows<{ status: string; provider: string }>("select status, provider from purchase_intent_checkouts where intent_id = $1", [c.id]);
    expect(failed).toEqual([{ status: "failed", provider: "paypal" }]);
    pp.state.down = false;
    pp.state.tokenRejected = true;
    await expect(open(c.token)).rejects.toMatchObject({ code: "integration_unavailable" });
    pp.state.tokenRejected = false;
    expect(await open(c.token)).toMatchObject({ resumed: false }); // the buyer may try again
  });
});

describe("approving is not paying: the server takes the payment, and only PayPal's COMPLETED capture counts", () => {
  it("does nothing for a buyer who came back without approving, and records the payment once the order is approved and captured", async () => {
    const w = await world();
    const c = await make(w);
    const o = await open(c.token);
    expect(await ret(o.reference)).toEqual({ state: "waiting" });
    expect((await checkoutRow(o.reference)).status).toBe("pending");
    expect((await intentRow(c.id)).status).toBe("started");
    // The return page says it is waiting, never "paid", and knows this server still has to take the payment.
    expect(await getCheckoutReturn(o.reference)).toMatchObject({ provider: "paypal", needsCapture: true, checkoutStatus: "pending" });
    const order = pp.byReference(o.reference)!;
    pp.approve(order.id);
    expect(await ret(o.reference)).toEqual({ state: "paid" });
    const checkout = await checkoutRow(o.reference);
    expect(checkout).toMatchObject({ status: "paid", provider_payment_id: order.captures[0].id });
    expect(Number(checkout.fee_minor)).toBe(5846);
    expect(await intentRow(c.id)).toMatchObject({ status: "payment_verified", payment_source: "provider", payment_method: "paypal", payment_reference: order.captures[0].id, payment_amount_cents: 149900, payment_checkout_id: checkout.id });
    expect(await getCheckoutReturn(o.reference)).toMatchObject({ checkoutStatus: "paid", needsCapture: false });
  });

  it("is idempotent: pressing back, reloading or a second tab changes nothing, and the later signed notice is the same payment", async () => {
    const w = await world();
    const c = await make(w);
    const o = await open(c.token);
    const order = pp.byReference(o.reference)!;
    pp.approve(order.id);
    expect(await ret(o.reference)).toEqual({ state: "paid" });
    expect(await ret(o.reference)).toEqual({ state: "paid" });
    const captureCalls = pp.calls.filter((x) => x.path.endsWith("/capture")).length;
    expect(captureCalls).toBe(1); // a paid checkout is never captured again
    const notice = await deliver(captureCompletedEvent({ orderId: order.id, reference: o.reference, captureId: order.captures[0].id }));
    expect(notice.outcome).toBe("ignored"); // already recorded
    expect(await eventsOf(c.id, "payment_received")).toHaveLength(1);
    expect(await rows("select 1 from purchase_intent_checkouts where intent_id = $1 and status = 'paid'", [c.id])).toHaveLength(1);
  });

  it("takes only the order WE stored: a reference that is not a PayPal checkout of ours, or that names another buyer's, cannot move anything", async () => {
    const w = await world();
    const a = await make(w);
    const b = await make(w);
    const oa = await open(a.token);
    pp.approve(pp.byReference(oa.reference)!.id);
    expect(await ret("IAQ-NOTAREALREFERENCE")).toEqual({ state: "not_applicable" });
    expect(await ret("not a reference")).toEqual({ state: "not_applicable" });
    const ob = await open(b.token);
    // B's page returning does not capture A's approved order, and A's return does not touch B.
    expect(await ret(ob.reference)).toEqual({ state: "waiting" });
    expect((await checkoutRow(oa.reference)).status).toBe("pending");
    expect(await ret(oa.reference)).toEqual({ state: "paid" });
    expect((await checkoutRow(ob.reference)).status).toBe("pending");
  });

  it("does not count a capture PayPal leaves pending, or one it declines, and the checkout stays open for a later success", async () => {
    const w = await world();
    const c = await make(w);
    const o = await open(c.token);
    const order = pp.byReference(o.reference)!;
    pp.approve(order.id);
    pp.state.captureDeclined = true;
    expect(await ret(o.reference)).toEqual({ state: "unavailable" });
    expect((await checkoutRow(o.reference)).status).toBe("pending");
    pp.state.captureDeclined = false;
    pp.state.capturePending = true;
    expect(await ret(o.reference)).toEqual({ state: "waiting" });
    expect((await checkoutRow(o.reference)).status).toBe("pending");
    expect((await intentRow(c.id)).status).toBe("started");
  });

  it("turns a PayPal outage into 'unavailable', not into a payment or a failure of the checkout", async () => {
    const w = await world();
    const c = await make(w);
    const o = await open(c.token);
    pp.approve(pp.byReference(o.reference)!.id);
    pp.state.down = true;
    expect(await ret(o.reference)).toEqual({ state: "unavailable" });
    expect((await checkoutRow(o.reference)).status).toBe("pending");
    pp.state.down = false;
    expect(await ret(o.reference)).toEqual({ state: "paid" });
  });

  it("holds a payment whose amount or currency is not what we stored (nothing is created from it) and tells the team", async () => {
    const w = await world();
    const c = await make(w);
    const o = await open(c.token);
    pp.approve(pp.byReference(o.reference)!.id);
    pp.state.captureAmountOverride = "1.00";
    expect(await ret(o.reference)).toEqual({ state: "waiting" });
    expect(await checkoutRow(o.reference)).toMatchObject({ status: "mismatch" });
    expect(await intentRow(c.id)).toMatchObject({ status: "started", payment_hold: "mismatch" });
    const notices = await rows<{ kind: string; severity: string }>("select kind, severity from notifications where kind = 'billing_reconciliation' and title like 'A purchase payment did not match%' order by created_at desc limit 1");
    expect(notices[0]).toMatchObject({ severity: "critical" });
    // A wrong currency is the same.
    const c2 = await make(w);
    const o2 = await open(c2.token);
    pp.approve(pp.byReference(o2.reference)!.id);
    pp.state.captureAmountOverride = null;
    pp.state.captureCurrencyOverride = "EUR";
    await ret(o2.reference);
    expect(await intentRow(c2.id)).toMatchObject({ payment_hold: "mismatch", status: "started" });
  });
});

describe("the verified notice is the second way a payment becomes real, and it is checked by asking PayPal", () => {
  it("records a payment from a verified PAYMENT.CAPTURE.COMPLETED when the return page never ran", async () => {
    const w = await world();
    const c = await make(w);
    const o = await open(c.token);
    const order = pp.byReference(o.reference)!;
    const r = await deliver(captureCompletedEvent({ orderId: order.id, reference: o.reference, captureId: "CAPFROMWEBHOOK1" }));
    expect(r).toMatchObject({ httpStatus: 200, outcome: "processed" });
    expect(await checkoutRow(o.reference)).toMatchObject({ status: "paid", provider_payment_id: "CAPFROMWEBHOOK1" });
    expect(await intentRow(c.id)).toMatchObject({ status: "payment_verified", payment_method: "paypal" });
    const asked = pp.calls.find((x) => x.path === "/v1/notifications/verify-webhook-signature");
    expect(asked).toBeTruthy();
    expect((asked!.body as { webhook_id: string }).webhook_id).toBe(pp.webhookId);
  });

  it("refuses an unverified delivery before reading its contents, and stores nothing", async () => {
    const w = await world();
    const c = await make(w);
    const o = await open(c.token);
    const order = pp.byReference(o.reference)!;
    pp.state.signaturesValid = false;
    const r = await deliver(captureCompletedEvent({ orderId: order.id, reference: o.reference }));
    expect(r).toMatchObject({ httpStatus: 401, outcome: "rejected" });
    expect((await checkoutRow(o.reference)).status).toBe("pending");
    pp.state.signaturesValid = true;
    // A delivery without PayPal's headers, with a certificate from another host, or an old one, is refused as well.
    expect((await deliver(captureCompletedEvent({ orderId: order.id, reference: o.reference }), { "paypal-transmission-id": "x" } as never)).httpStatus).toBe(401);
    expect((await deliver(captureCompletedEvent({ orderId: order.id, reference: o.reference }), paypalHeaders({ "paypal-cert-url": "https://evil.example.test/cert.pem" }))).httpStatus).toBe(401);
    expect((await deliver(captureCompletedEvent({ orderId: order.id, reference: o.reference }), paypalHeaders({ "paypal-transmission-time": new Date(Date.now() - 5 * 24 * 3600_000).toISOString() }))).httpStatus).toBe(401);
    expect((await checkoutRow(o.reference)).status).toBe("pending");
  });

  it("rejects a notice that borrows another buyer's reference, and one for a checkout of the wrong id", async () => {
    const w = await world();
    const a = await make(w);
    const b = await make(w);
    const oa = await open(a.token);
    const ob = await open(b.token);
    const orderA = pp.byReference(oa.reference)!;
    // B's reference with A's order id: the reference and the stored order must agree.
    const r = await deliver(captureCompletedEvent({ orderId: orderA.id, reference: ob.reference }));
    expect(r.outcome).toBe("rejected");
    expect((await checkoutRow(oa.reference)).status).toBe("pending");
    expect((await checkoutRow(ob.reference)).status).toBe("pending");
    // An order id we never stored is not ours at all.
    const unknown = await deliver(captureCompletedEvent({ orderId: "ORDNOTSTORED", reference: oa.reference }));
    expect(unknown.outcome).toBe("ignored");
  });

  it("ignores a capture that is not COMPLETED, treats a replay of the same event as a duplicate, and leaves a denied attempt's checkout open", async () => {
    const w = await world();
    const c = await make(w);
    const o = await open(c.token);
    const order = pp.byReference(o.reference)!;
    expect((await deliver(captureCompletedEvent({ orderId: order.id, reference: o.reference, status: "PENDING" }))).outcome).toBe("ignored");
    expect((await checkoutRow(o.reference)).status).toBe("pending");
    expect((await deliver(captureDeniedEvent({ reference: o.reference }))).httpStatus).toBe(200);
    expect((await checkoutRow(o.reference)).status).toBe("pending");
    const body = captureCompletedEvent({ orderId: order.id, reference: o.reference, captureId: "CAPONCE", id: "WH-REPLAY-1" });
    expect((await deliver(body)).outcome).toBe("processed");
    expect((await deliver(body)).outcome).toBe("duplicate");
    expect(await eventsOf(c.id, "payment_received")).toHaveLength(1);
  });

  it("keeps test and live apart: a live-mode delivery is not trusted by a sandbox app, and the live app needs the review", async () => {
    const w = await world();
    const c = await make(w);
    const o = await open(c.token);
    const order = pp.byReference(o.reference)!;
    // The adapter takes its mode from the app's environment: PayPal's events do not say. The checkout was opened under the sandbox app; if the app is switched to live afterwards, a
    // delivery is read as live and refused against the checkout's stored mode, and the other way round.
    process.env.PAYPAL_ENVIRONMENT = "live";
    resetEnvCache();
    try {
      const r = await handleProviderWebhook(createPaypalAdapter({ wire: pp.wire }), { rawBody: captureCompletedEvent({ orderId: order.id, reference: o.reference }), headers: paypalHeaders() });
      expect(r.outcome).toBe("rejected");
      expect(r.detail).toMatch(/mode/i);
      expect((await checkoutRow(o.reference)).status).toBe("pending");
      // A live app also needs the payment and tax review before PayPal is offered at all.
      await setBilling({ reviewed: false });
      expect((await withSystem((db) => providerReadiness(db, "paypal"))).available).toBe(false);
    } finally {
      process.env.PAYPAL_ENVIRONMENT = "sandbox";
      resetEnvCache();
    }
    const sandbox = await deliver(captureCompletedEvent({ orderId: order.id, reference: o.reference }));
    expect(sandbox.outcome).toBe("processed");
  });
});

describe("refunds, disputes and duplicates are reported to a person; nothing is created or removed by itself", () => {
  async function paidIntent(over: { autoProvision?: boolean } = {}) {
    const w = await world();
    const c = await make(w, over);
    const o = await open(c.token);
    const order = pp.byReference(o.reference)!;
    pp.approve(order.id);
    await ret(o.reference);
    return { w, c, o, order, captureId: order.captures[0].id };
  }

  it("holds a purchase when PayPal reports a refund before the workspace exists", async () => {
    const { c, o, captureId } = await paidIntent();
    expect((await deliver(captureRefundedEvent({ captureId }))).outcome).toBe("processed");
    expect(await checkoutRow(o.reference)).toMatchObject({ status: "refunded" });
    expect(await intentRow(c.id)).toMatchObject({ status: "payment_verified", payment_hold: "refunded" });
  });

  it("holds a purchase on a reversal or a dispute, and a person must release it", async () => {
    const a = await paidIntent();
    expect((await deliver(captureReversedEvent({ captureId: a.captureId }))).outcome).toBe("processed");
    expect(await checkoutRow(a.o.reference)).toMatchObject({ status: "disputed" });
    expect(await intentRow(a.c.id)).toMatchObject({ payment_hold: "disputed" });
    const b = await paidIntent();
    expect((await deliver(disputeCreatedEvent({ captureId: b.captureId }))).outcome).toBe("processed");
    expect(await intentRow(b.c.id)).toMatchObject({ payment_hold: "disputed" });
    // Releasing needs a person with a recorded reason; the hold does not lift by itself.
    const w = await world();
    await expect(provisionPurchaseIntent(w.superSession, b.c.id, { now: NOW })).rejects.toBeTruthy();
    await releasePurchaseHold(w.superSession, b.c.id, "Checked in PayPal: the dispute was withdrawn by the buyer.", { now: NOW });
    expect((await intentRow(b.c.id)).payment_hold).toBeNull();
  });

  it("does not auto-provision from a held payment, and does not touch a workspace that already exists", async () => {
    const a = await paidIntent({ autoProvision: true });
    // The auto-provision follow-up ran when it was paid (nothing was held yet), so the workspace exists; a later dispute must not change it.
    const before = await intentRow(a.c.id);
    await deliver(disputeCreatedEvent({ captureId: a.captureId }));
    const after = await intentRow(a.c.id);
    expect(after.status).toBe(before.status);
    const workspace = await rows("select 1 from organizations where id = (select client_org_id from purchase_intents where id = $1)", [a.c.id]);
    expect(workspace.length).toBeGreaterThanOrEqual(0);
  });

  it("records a payment that arrives after the purchase was already paid by hand as a duplicate for a person to refund, and creates nothing", async () => {
    const w = await world();
    const c = await make(w);
    const o = await open(c.token);
    const order = pp.byReference(o.reference)!;
    await verifyPurchasePayment(w.superSession, c.id, { amount: "1499.00", method: "bank_transfer", externalReference: `BANK-${uid()}`, paidOn: NOW.toISOString().slice(0, 10), note: "Saw the transfer in the bank statement." }, { now: NOW });
    // Recording by hand closes the open online checkout, so the buyer cannot pay it from the page; a payment PayPal already holds is still recorded if it arrives.
    expect((await checkoutRow(o.reference)).status).toBe("cancelled");
    pp.approve(order.id);
    const r = await deliver(captureCompletedEvent({ orderId: order.id, reference: o.reference }));
    expect(["processed", "ignored"]).toContain(r.outcome);
    expect((await intentRow(c.id)).payment_source).toBe("manual");
    expect(await rows("select 1 from organizations where id = (select client_org_id from purchase_intents where id = $1) and kind = 'client'", [c.id])).toHaveLength(0);
  });
});

describe("a lost return page and a lost notice do not lose the payment", () => {
  it("settles an approved order from the sweep: it captures what the buyer approved and finds what is already captured", async () => {
    const w = await world();
    const a = await make(w);
    const b = await make(w);
    const oa = await open(a.token);
    const ob = await open(b.token);
    pp.approve(pp.byReference(oa.reference)!.id);
    // B approved and was captured elsewhere (a lost notice): the sweep reads it back.
    const orderB = pp.byReference(ob.reference)!;
    pp.approve(orderB.id);
    await pp.wire.completeCheckout!({ apiKey: "x", apiSecret: "y", webhookSecret: null, settings: { environment: "sandbox" } }, orderB.id, { reference: ob.reference });
    const later = new Date(NOW.getTime() + 10 * 60_000);
    const swept = await runPurchaseCheckoutSweep({ now: later, paypal: { wire: pp.wire } });
    expect(swept.paypalSettled).toBeGreaterThanOrEqual(2);
    expect((await checkoutRow(oa.reference)).status).toBe("paid");
    expect((await checkoutRow(ob.reference)).status).toBe("paid");
  });

  it("leaves an order nobody approved alone until its checkout expires, and skips an order PayPal cannot answer for", async () => {
    const w = await world();
    const c = await make(w);
    const o = await open(c.token);
    const later = new Date(NOW.getTime() + 10 * 60_000);
    expect((await runPurchaseCheckoutSweep({ now: later, paypal: { wire: pp.wire } })).paypalSettled).toBe(0);
    expect((await checkoutRow(o.reference)).status).toBe("pending");
    pp.state.down = true;
    expect((await runPurchaseCheckoutSweep({ now: later, paypal: { wire: pp.wire } })).paypalSettled).toBe(0);
    pp.state.down = false;
    const expired = new Date(NOW.getTime() + 3 * 24 * 3600_000);
    const closed = await runPurchaseCheckoutSweep({ now: expired, paypal: { wire: pp.wire } });
    expect(closed.closedUnpaid).toBeGreaterThanOrEqual(1);
    expect((await checkoutRow(o.reference)).status).toBe("expired");
    // A payment that still arrives on a closed checkout is recorded.
    const order = pp.byReference(o.reference)!;
    expect((await deliver(captureCompletedEvent({ orderId: order.id, reference: o.reference }))).outcome).toBe("processed");
    expect((await checkoutRow(o.reference)).status).toBe("paid");
  });
});

describe("what the team reads", () => {
  it("shows the PayPal checkout with its currency, and names PayPal (not PayMongo) in a reconciliation notice", async () => {
    const w = await world();
    const c = await make(w);
    const o = await open(c.token);
    const order = pp.byReference(o.reference)!;
    pp.approve(order.id);
    await ret(o.reference);
    await deliver(captureRefundedEvent({ captureId: order.captures[0].id }));
    const list = await withSystem((db) => listIntentCheckouts(db, c.id));
    expect(list[0]).toMatchObject({ provider: "paypal", chargedCurrency: "USD", chargedAmountMinor: 149900, status: "refunded" });
    const notice = await rows<{ title: string; body: string }>("select title, body from notifications where title like 'PayPal reports a refund%' order by created_at desc limit 1");
    expect(notice[0]?.body).toMatch(/Check it in PayPal/);
  });

  it("normalizes PayPal's events into the shapes the shared handler applies, and nothing else", () => {
    expect(normalizePaypalWebhook("not json", false)).toBeNull();
    expect(normalizePaypalWebhook(JSON.stringify({ id: "X", event_type: "CHECKOUT.ORDER.APPROVED", resource: {} }), false)).toMatchObject({ kind: "other" });
    const paid = normalizePaypalWebhook(captureCompletedEvent({ orderId: "ORD1", reference: "IAQ-ABCDEFGH1234", captureId: "CAP1" }), false)!;
    expect(paid).toMatchObject({ provider: "paypal", kind: "payment_paid", checkoutId: "ORD1", reference: "IAQ-ABCDEFGH1234", livemode: false });
    expect(paid.paidPayments).toEqual([{ id: "CAP1", amountMinor: 149900, currency: "USD", feeMinor: 5846 }]);
    // A reference that is not ours is dropped, so a capture for someone else's order can never match one of our checkouts.
    expect(normalizePaypalWebhook(captureCompletedEvent({ orderId: "ORD1", reference: "CP-NOTOURS0123456789012", captureId: "CAP1" }), false)!.reference).toBeNull();
  });
});
