// The provider adapter interface for iAcquire's own payments: PayMongo is the first adapter and changes none of the matching rules; a second provider is one more adapter.
// No PayPal code exists: the fake adapter below only proves the shared handler does not depend on PayMongo's payload.
import { beforeAll, describe, expect, it } from "vitest";

process.env.PAYMONGO_SECRET_KEY = "sk_test_notarealkey123";
process.env.PAYMONGO_WEBHOOK_SECRET = "whsec_test_only_not_a_real_secret";
process.env.PAYMONGO_PAYMENT_METHODS = "card,gcash";

import { resetEnvCache } from "@/server/env";
import { withSystem } from "@/server/db";
import { handleProviderWebhook } from "@/server/billing/payments";
import { normalizePaymongoEvent, paymongoAdapter } from "@/server/billing/providers/paymongo";
import { parseEvent } from "@/server/billing/paymongo";
import type { NormalizedPaymentEvent, PaymentProviderAdapter } from "@/server/billing/providers/types";
import { uid } from "./support/fixtures";
import { evt, onboardedClient, paymongoPaidEvent, provisioningJobs, setupStatus, signPaymongo } from "./support/billing";

beforeAll(() => resetEnvCache());

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;

describe("the PayMongo adapter", () => {
  const body = paymongoPaidEvent({ eventId: "evt_adapter_1", checkoutId: "cs_adapter_1", reference: "IAQ-ADAPTER001", amount: 8694200, paymentId: "pay_adapter_1" });

  it("translates a paid checkout into the one normalised shape", () => {
    const event = normalizePaymongoEvent(parseEvent(body)!);
    expect(event).toMatchObject({
      provider: "paymongo", id: "evt_adapter_1", type: "checkout_session.payment.paid", kind: "payment_paid", livemode: false, checkoutId: "cs_adapter_1", reference: "IAQ-ADAPTER001",
      paidPayments: [{ id: "pay_adapter_1", amountMinor: 8694200, currency: "PHP", feeMinor: 250 }],
    });
  });

  it("reads a failed payment's reference from its description, and any other event as not used", () => {
    const failed = JSON.stringify({ data: { id: "evt_f", type: "event", attributes: { type: "payment.failed", livemode: false, data: { id: "pay_f", type: "payment", attributes: { description: "Setup [IAQ-FAILED00001]" } } } } });
    expect(paymongoAdapter.parse(failed)).toMatchObject({ kind: "payment_failed", checkoutId: null, description: "Setup [IAQ-FAILED00001]", paidPayments: [] });
    const other = JSON.stringify({ data: { id: "evt_o", type: "event", attributes: { type: "source.chargeable", livemode: false, data: { id: "src_1", type: "source", attributes: {} } } } });
    expect(paymongoAdapter.parse(other)).toMatchObject({ kind: "other", paidPayments: [], checkoutId: null });
    expect(paymongoAdapter.parse("not json")).toBeNull();
    expect(paymongoAdapter.parse(JSON.stringify({ data: {} }))).toBeNull();
  });

  it("an event that reports a payment as anything but paid carries no paid payment, and a missing number stays missing", () => {
    const pending = paymongoPaidEvent({ checkoutId: "cs_x", reference: "IAQ-X0000001", amount: 100 }).replace('"status":"paid"', '"status":"pending"');
    expect(paymongoAdapter.parse(pending)).toMatchObject({ kind: "payment_paid", paidPayments: [] });
    const noAmount = JSON.parse(paymongoPaidEvent({ checkoutId: "cs_x", reference: "IAQ-X0000001", amount: 100 }));
    delete noAmount.data.attributes.data.attributes.payments[0].attributes.amount;
    expect(paymongoAdapter.parse(JSON.stringify(noAmount))).toMatchObject({ paidPayments: [{ amountMinor: null }] });
  });

  it("verifies the delivery against the raw body and the provider's own header, and never trusts another secret or mode", async () => {
    expect(paymongoAdapter.notReady()).toBeNull();
    expect(paymongoAdapter.expectedLivemode()).toBe(false);
    expect(await paymongoAdapter.verify({ rawBody: body, headers: { "paymongo-signature": signPaymongo(body) } })).toEqual({ ok: true, livemode: false });
    expect(await paymongoAdapter.verify({ rawBody: body, headers: { "paymongo-signature": signPaymongo(body, { live: true }) } })).toEqual({ ok: true, livemode: true });
    expect(await paymongoAdapter.verify({ rawBody: body, headers: { "paymongo-signature": signPaymongo(body, { secret: "other" }) } })).toMatchObject({ ok: false, reason: "mismatch" });
    expect(await paymongoAdapter.verify({ rawBody: body + " ", headers: { "paymongo-signature": signPaymongo(body) } })).toMatchObject({ ok: false, reason: "mismatch" });
    expect(await paymongoAdapter.verify({ rawBody: body, headers: {} })).toMatchObject({ ok: false, reason: "missing" });
    expect(await paymongoAdapter.verify({ rawBody: body, headers: { "paymongo-signature": signPaymongo(body, { t: 1_600_000_000 }) } })).toMatchObject({ ok: false, reason: "stale" });
  });
});

describe("a second provider is one more adapter", () => {
  /** Records what the handler asked of it, and answers from fixed data. Its event shape is the interface's, not PayMongo's. */
  function fake(over: Partial<PaymentProviderAdapter> & { event?: NormalizedPaymentEvent | null } = {}) {
    const calls: string[] = [];
    const adapter: PaymentProviderAdapter = {
      id: "paypal",
      notReady: () => null,
      expectedLivemode: () => false,
      verify: ({ headers }) => { calls.push("verify"); return headers["x-fake-signature"] === "ok" ? { ok: true, livemode: false } : { ok: false, reason: "mismatch" }; },
      parse: () => { calls.push("parse"); return over.event ?? null; },
      ...over,
    };
    return { adapter, calls };
  }
  const headers = { "x-fake-signature": "ok" };
  const eventFor = (o: { id?: string; checkoutId: string; reference: string; amountMinor: number; currency?: string; livemode?: boolean }): NormalizedPaymentEvent => ({
    provider: "paypal", id: o.id ?? evt(), type: "PAYMENT.CAPTURE.COMPLETED", kind: "payment_paid", livemode: o.livemode ?? false, checkoutId: o.checkoutId, reference: o.reference,
    paidPayments: [{ id: `cap_${uid()}`, amountMinor: o.amountMinor, currency: o.currency ?? "USD", feeMinor: null }], description: null,
  });
  async function pending() {
    const c = await onboardedClient();
    const reference = `IAQ-FAKE${uid().toUpperCase()}`;
    const checkoutId = `order_${uid()}`;
    const row = (await rows<{ id: string }>(
      `insert into payments (org_id, kind, description, usd_amount_micros, charged_currency, charged_amount_minor, livemode, provider, reference_number, provider_checkout_id)
       values ($1, 'setup_fee', 'Setup', 1499000000, 'USD', 149900, false, 'paypal', $2, $3) returning id`, [c.org.id, reference, checkoutId]))[0];
    return { ...c, reference, checkoutId, paymentId: row.id };
  }

  it("clears the setup fee through the same rules, with the provider named in the ledger", async () => {
    const p = await pending();
    const event = eventFor({ checkoutId: p.checkoutId, reference: p.reference, amountMinor: 149900 });
    const { adapter } = fake({ event });
    expect(await handleProviderWebhook(adapter, { rawBody: "{}", headers })).toMatchObject({ httpStatus: 200, outcome: "processed" });
    expect(await setupStatus(p.org.id)).toMatchObject({ setup_payment_status: "paid", verified_payment_id: p.paymentId });
    expect(await provisioningJobs(p.org.id)).toBe(6);
    expect((await rows<{ provider: string; outcome: string }>("select provider, outcome from payment_webhook_events where provider_event_id = $1", [event.id]))).toEqual([{ provider: "paypal", outcome: "processed" }]);
    // The same provider's replay is a duplicate; the same event id from PayMongo is a different event.
    expect(await handleProviderWebhook(adapter, { rawBody: "{}", headers })).toMatchObject({ outcome: "duplicate" });
    expect(await provisioningJobs(p.org.id)).toBe(6);
  });

  it("applies the same matching rules: reference, mode, amount and currency must all agree with OUR row", async () => {
    const p = await pending();
    const run = (event: NormalizedPaymentEvent) => handleProviderWebhook(fake({ event }).adapter, { rawBody: "{}", headers });
    expect(await run(eventFor({ checkoutId: p.checkoutId, reference: "IAQ-NOTOURS0001", amountMinor: 149900 }))).toMatchObject({ outcome: "rejected", detail: expect.stringMatching(/Reference does not match/) });
    expect(await run(eventFor({ checkoutId: "order_unknown", reference: p.reference, amountMinor: 149900 }))).toMatchObject({ outcome: "ignored", detail: expect.stringMatching(/No matching checkout/) });
    // A live event on a test-mode stored payment: the adapter's mode and the event's disagree first.
    expect(await run(eventFor({ checkoutId: p.checkoutId, reference: p.reference, amountMinor: 149900, livemode: true }))).toMatchObject({ httpStatus: 400, outcome: "rejected" });
    // An event whose mode matches the signature but not the stored payment is refused as a mismatch.
    const live = fake({ event: eventFor({ checkoutId: p.checkoutId, reference: p.reference, amountMinor: 149900, livemode: true }), verify: () => ({ ok: true, livemode: true }), expectedLivemode: () => true });
    expect(await handleProviderWebhook(live.adapter, { rawBody: "{}", headers })).toMatchObject({ outcome: "rejected", detail: expect.stringMatching(/Payment mode mismatch/) });
    expect(await run(eventFor({ checkoutId: p.checkoutId, reference: p.reference, amountMinor: 149899 }))).toMatchObject({ outcome: "rejected", detail: expect.stringMatching(/Amount or currency/) });
    expect((await rows<{ status: string }>("select status from payments where id = $1", [p.paymentId]))[0].status).toBe("mismatch");
    expect((await setupStatus(p.org.id)).setup_payment_status).toBe("not_invoiced");
    expect(await provisioningJobs(p.org.id)).toBe(0);
    const eur = await pending();
    expect(await run(eventFor({ checkoutId: eur.checkoutId, reference: eur.reference, amountMinor: 149900, currency: "EUR" }))).toMatchObject({ outcome: "rejected" });
    // A payment with no usable amount can never clear anything.
    const blank = await pending();
    const noAmount = { ...eventFor({ checkoutId: blank.checkoutId, reference: blank.reference, amountMinor: 149900 }), paidPayments: [{ id: "cap_1", amountMinor: null, currency: null, feeMinor: null }] };
    expect(await run(noAmount)).toMatchObject({ outcome: "rejected" });
    // Two paid payments in one event are not guessed between.
    const two = await pending();
    const both = { ...eventFor({ checkoutId: two.checkoutId, reference: two.reference, amountMinor: 149900 }) };
    both.paidPayments = [both.paidPayments[0], { ...both.paidPayments[0], id: "cap_2" }];
    expect(await run(both)).toMatchObject({ outcome: "ignored", detail: expect.stringMatching(/No single paid payment/) });
  });

  it("answers for an adapter that is not ready, a delivery that cannot be verified and a payload it cannot read, before touching the database", async () => {
    const before = (await rows("select 1 from payment_webhook_events")).length;
    expect(await handleProviderWebhook(fake({ notReady: () => "Webhook secret is not configured." }).adapter, { rawBody: "{}", headers })).toEqual({ httpStatus: 503, outcome: "blocked", detail: "Webhook secret is not configured." });
    expect(await handleProviderWebhook(fake().adapter, { rawBody: "{}", headers: {} })).toMatchObject({ httpStatus: 401, outcome: "rejected", detail: "Signature mismatch." });
    expect(await handleProviderWebhook(fake({ event: null }).adapter, { rawBody: "{}", headers })).toMatchObject({ httpStatus: 400, detail: "Unrecognized payload." });
    const modeMismatch = eventFor({ checkoutId: "x", reference: "IAQ-X", amountMinor: 1, livemode: true });
    expect(await handleProviderWebhook(fake({ event: modeMismatch }).adapter, { rawBody: "{}", headers })).toMatchObject({ httpStatus: 400, detail: "Event mode does not match its signature." });
    expect((await rows("select 1 from payment_webhook_events")).length).toBe(before);
  });

  it("ignores an event type the adapter says is not used, and notes a failed attempt without clearing anything", async () => {
    const p = await pending();
    const other: NormalizedPaymentEvent = { ...eventFor({ checkoutId: p.checkoutId, reference: p.reference, amountMinor: 149900 }), kind: "other", paidPayments: [], checkoutId: null };
    expect(await handleProviderWebhook(fake({ event: other }).adapter, { rawBody: "{}", headers })).toMatchObject({ outcome: "ignored", detail: "Event type is not used." });
    const failed: NormalizedPaymentEvent = { ...other, id: evt(), kind: "payment_failed", description: `Setup [${p.reference}]` };
    expect(await handleProviderWebhook(fake({ event: failed }).adapter, { rawBody: "{}", headers })).toMatchObject({ outcome: "processed" });
    expect((await rows<{ status: string }>("select status from payments where id = $1", [p.paymentId]))[0].status).toBe("pending");
    expect((await setupStatus(p.org.id)).setup_payment_status).toBe("not_invoiced");
  });
});
