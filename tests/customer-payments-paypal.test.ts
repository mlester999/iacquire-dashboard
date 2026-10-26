// The PayPal adapter against a replaced network layer and hand-written fixtures. NOTHING here contacts PayPal, and the PayPal bodies were written from the documentation
// as remembered, not recorded from PayPal: these tests prove the adapter and the services around it do what they say with those shapes, NOT that PayPal sends them or
// answers this way. The adapter is labelled unverified in code, in the connection screen and in the report until a run against a PayPal sandbox app is recorded.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { CURRENCY_CODES } from "@/lib/money";
import { PROVIDER_STATE } from "@/lib/invoices/connection-rules";
import { credentialVault, type ProviderCredentials } from "@/server/customer-payments/credentials";
import { connectProvider, listConnections, replaceCredentials, saveWebhookSecret } from "@/server/customer-payments/connections";
import { startCheckout } from "@/server/customer-payments/attempts";
import { setAdapterForTests } from "@/server/customer-payments/providers";
import { createPaypalProvider, disputeOutcomeOf, paypalHttp, type PaypalRequest } from "@/server/customer-payments/providers/paypal";
import { ProviderCallError } from "@/server/customer-payments/providers/types";
import { newReference } from "@/server/customer-payments/ids";
import { runCustomerPaymentReconcileDetailed } from "@/server/customer-payments/reconcile";
import { SWITCHED_OFF_RETRY_SECONDS } from "@/server/customer-payments/webhooks";
import { completeApprovedCheckout } from "@/server/invoices/public";
import { createDraft, issueInvoice } from "@/server/invoices/invoices";
import { contactIn, dealFor, invoiceOrg, issuedInvoice, line, rows } from "./support/invoices";
import { uid } from "./support/fixtures";
import {
  AUTHORIZATION, PAYPAL_CERT_URL, attempt, attemptNow, connect, fakePaypal, invoiceNow, paymentsOf, paypalCaptureCompleted, paypalCaptureOther, paypalDeliver, paypalDispute, paypalDisputeResolved, paypalOrder, paypalOrderApproved,
  paypalRefunded, paypalSignatureFor, q, receipts, type FakePaypal,
} from "./support/customer-payments";

const CLIENT_ID = "AbCdEfGhIjKlMnOpQrStUvWx";
const CLIENT_SECRET = "ZyXwVuTsRqPoNmLkJiHgFeDcBa12";
const WH = "4JH86294D6297924G";
const creds: ProviderCredentials = { apiKey: CLIENT_ID, apiSecret: CLIENT_SECRET, webhookSecret: WH, settings: { environment: "sandbox" } };
const REF = newReference();
const URLS = { successUrl: "https://app.example/pay/return/x", cancelUrl: "https://app.example/pay/return/x?result=cancelled" };
const input = { reference: REF, amountMinor: 150000, currency: "PHP" as const, description: "Invoice INV-0001", ...URLS };
const headers = (map: Record<string, string | null>) => ({ get: (n: string) => map[n.toLowerCase()] ?? null });
const now = Date.now();
const ORDER = "5O190127TN364715T";

const goodHeaders = (body: string, over: Record<string, string | null> = {}) => {
  const id = "tx-1234567890";
  return headers({
    "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": PAYPAL_CERT_URL, "paypal-transmission-id": id, "paypal-transmission-sig": paypalSignatureFor(WH, id, body), "paypal-transmission-time": new Date(now).toISOString(), ...over,
  });
};
/** What the adapter put in a request body, with the fields these tests read. */
interface Sent {
  intent?: string;
  purchase_units: Array<{ custom_id: string; description: string; amount: { currency_code: string; value: string } }>;
  payment_source: { paypal: { experience_context: { return_url: string; cancel_url: string; user_action: string; shipping_preference: string } } };
  [key: string]: unknown;
}
const sentOf = (call: PaypalRequest) => JSON.parse(call.body ?? "{}") as Sent;

describe("PayPal: proving the app's keys", () => {
  const url = "https://app.example/api/webhooks/customer-payments/paypal/cpk_abcdefghij0123456789";

  it("asks for a token with the client ID and secret, then lists webhooks read-only, and notes whether one for this connection's address exists", async () => {
    const f = fakePaypal(WH);
    const pp = createPaypalProvider({ http: f.http });
    f.on((r) => r.method === "GET" && r.path === "/v1/notifications/webhooks", { status: 200, json: { webhooks: [{ id: WH, url }] } });
    expect(await pp.verifyCredentials(creds, { webhookUrl: url })).toEqual({ ok: true, accountLabel: null, webhookFound: true });
    expect(f.calls[0]).toMatchObject({ method: "POST", path: "/v1/oauth2/token", environment: "sandbox", basic: { id: CLIENT_ID, secret: CLIENT_SECRET }, contentType: "application/x-www-form-urlencoded", body: "grant_type=client_credentials" });
    expect(f.calls[1]).toMatchObject({ method: "GET", path: "/v1/notifications/webhooks", environment: "sandbox", bearer: "A21AAfixtureToken" });
    // Nothing that creates, changes or deletes anything at PayPal was asked.
    expect(f.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /v1/oauth2/token", "GET /v1/notifications/webhooks"]);

    f.on((r) => r.path === "/v1/notifications/webhooks", { status: 200, json: { webhooks: [{ id: "OTHER", url: "https://other.example/hook" }] } });
    expect(await pp.verifyCredentials(creds, { webhookUrl: url })).toMatchObject({ ok: true, webhookFound: false });
    f.on((r) => r.path === "/v1/notifications/webhooks", { status: 200, json: {} });
    expect(await pp.verifyCredentials(creds, { webhookUrl: url })).toMatchObject({ ok: true, webhookFound: null });
    // The keys work but this app may not be allowed to list webhooks: that is "not known", not a failure.
    f.on((r) => r.path === "/v1/notifications/webhooks", { status: 403, json: { name: "NOT_AUTHORIZED" } });
    expect(await pp.verifyCredentials(creds, { webhookUrl: url })).toMatchObject({ ok: true, webhookFound: null });
  });

  it("uses PayPal's live origin only for a live app, and refuses an app that does not say which it is", async () => {
    const f = fakePaypal(WH);
    const pp = createPaypalProvider({ http: f.http });
    await pp.verifyCredentials({ ...creds, settings: { environment: "live" } }, { webhookUrl: url });
    expect(f.calls.every((c) => c.environment === "live")).toBe(true);
    const before = f.calls.length;
    expect(await pp.verifyCredentials({ ...creds, settings: undefined }, { webhookUrl: url })).toMatchObject({ ok: false, reason: "rejected", message: expect.stringMatching(/incomplete/) });
    expect(await pp.verifyCredentials({ ...creds, apiSecret: null }, { webhookUrl: url })).toMatchObject({ ok: false, reason: "rejected" });
    expect(f.calls.length).toBe(before);
    expect(pp.modeOf(creds)).toBe("test");
    expect(pp.modeOf({ ...creds, settings: { environment: "live" } })).toBe("live");
    expect(pp.modeOf({ ...creds, settings: undefined })).toBeNull();
  });

  it("turns a refused token, a busy PayPal and a lost connection into sentences that carry no secret, no address and no body", async () => {
    const f = fakePaypal(WH);
    const pp = createPaypalProvider({ http: f.http });
    f.on((r) => r.path === "/v1/oauth2/token", { status: 401, json: { error: "invalid_client", error_description: `Client Authentication failed for ${CLIENT_ID}` } });
    const refused = await pp.verifyCredentials(creds, { webhookUrl: url });
    expect(refused).toMatchObject({ ok: false, reason: "rejected", message: expect.stringMatching(/did not accept this client ID and secret/) });
    f.on((r) => r.path === "/v1/oauth2/token", { status: 503, json: null });
    expect(await pp.verifyCredentials(creds, { webhookUrl: url })).toMatchObject({ ok: false, reason: "unreachable", message: expect.stringMatching(/busy or having trouble/) });
    f.throwNext(new Error(`socket hang up ${CLIENT_SECRET}`));
    const lost = await pp.verifyCredentials(creds, { webhookUrl: url });
    expect(lost).toMatchObject({ ok: false, reason: "unreachable" });
    for (const r of [refused, lost]) {
      expect(JSON.stringify(r)).not.toContain(CLIENT_ID);
      expect(JSON.stringify(r)).not.toContain(CLIENT_SECRET);
      expect(JSON.stringify(r)).not.toMatch(/https?:\/\//);
    }
  });
});

describe("PayPal: starting a checkout", () => {
  const created = (links: unknown[], id = ORDER) => ({ status: 201, json: { id, status: "PAYER_ACTION_REQUIRED", links } });
  const link = (rel: string, href: string) => ({ href, rel, method: "GET" });
  const route = (f: FakePaypal, answer: Parameters<FakePaypal["on"]>[1]) => f.on((r) => r.method === "POST" && r.path === "/v2/checkout/orders", answer);

  it("asks for exactly the amount, once, as a decimal string, with our reference and no customer details, and gives back the order and the PayPal page to send the payer to", async () => {
    const f = fakePaypal(WH);
    route(f, created([link("self", `https://api.sandbox.paypal.com/v2/checkout/orders/${ORDER}`), link("payer-action", `https://www.sandbox.paypal.com/checkoutnow?token=${ORDER}`)]));
    const r = await createPaypalProvider({ http: f.http }).createCheckout(creds, input);
    expect(r).toEqual({ checkoutId: ORDER, checkoutUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${ORDER}` });
    const call = f.to("/v2/checkout/orders")[0];
    expect(call).toMatchObject({ method: "POST", environment: "sandbox", bearer: "A21AAfixtureToken", contentType: "application/json", headers: { "PayPal-Request-Id": REF } });
    const body = sentOf(call);
    expect(body).toMatchObject({
      intent: "CAPTURE",
      purchase_units: [{ custom_id: REF, description: "Invoice INV-0001", amount: { currency_code: "PHP", value: "1500.00" } }],
      payment_source: { paypal: { experience_context: { return_url: URLS.successUrl, cancel_url: URLS.cancelUrl, user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING" } } },
    });
    // Nothing about the payer, and nothing else about the invoice, is sent.
    expect(Object.keys(body).sort()).toEqual(["intent", "payment_source", "purchase_units"]);
    expect(Object.keys(body.purchase_units[0]).sort()).toEqual(["amount", "custom_id", "description"]);
  });

  it("writes the amount in the currency's own decimals and never as a float", async () => {
    const f = fakePaypal(WH);
    route(f, created([link("approve", `https://www.sandbox.paypal.com/checkoutnow?token=${ORDER}`)]));
    const pp = createPaypalProvider({ http: f.http });
    await pp.createCheckout(creds, { ...input, amountMinor: 1, currency: "USD" });
    await pp.createCheckout(creds, { ...input, amountMinor: 123456789, currency: "EUR" });
    await pp.createCheckout(creds, { ...input, amountMinor: 1500, currency: "JPY" });
    expect(f.to("/v2/checkout/orders").map((c) => sentOf(c).purchase_units[0].amount)).toEqual([
      { currency_code: "USD", value: "0.01" }, { currency_code: "EUR", value: "1234567.89" }, { currency_code: "JPY", value: "1500" },
    ]);
  });

  it("prefers the payer-action link, falls back to approve, and never hands a payer an address that is not on PayPal's own domain", async () => {
    const f = fakePaypal(WH);
    const pp = createPaypalProvider({ http: f.http });
    route(f, created([link("approve", "https://www.paypal.com/checkoutnow?token=A"), link("payer-action", "https://www.paypal.com/checkoutnow?token=B")]));
    expect((await pp.createCheckout(creds, input)).checkoutUrl).toBe("https://www.paypal.com/checkoutnow?token=B");
    route(f, created([link("approve", "https://www.paypal.com/checkoutnow?token=A")]));
    expect((await pp.createCheckout(creds, input)).checkoutUrl).toBe("https://www.paypal.com/checkoutnow?token=A");
    for (const href of ["https://evil.example/checkoutnow", "http://www.paypal.com/checkoutnow", "https://paypal.com.evil.example/x", "javascript:alert(1)", "not a url"]) {
      route(f, created([link("payer-action", href)]));
      await expect(pp.createCheckout(creds, input), href).rejects.toMatchObject({ name: "ProviderCallError", kind: "invalid_response" });
    }
    route(f, created([link("payer-action", "https://paypal.evil.example/x")]));
    await expect(pp.createCheckout(creds, input)).rejects.toThrow(/did not point to PayPal/);
  });

  it("turns each kind of failure into a sentence a person can act on, without the secret, an address or a body in it", async () => {
    const cases: Array<[Parameters<FakePaypal["on"]>[1], string, RegExp]> = [
      [{ status: 401, json: { name: "AUTHENTICATION_FAILURE" } }, "rejected", /did not accept this client ID and secret/],
      [{ status: 429, json: null }, "unreachable", /busy or having trouble/],
      [{ status: 500, json: null }, "unreachable", /busy or having trouble/],
      [{ status: 422, json: { name: "UNPROCESSABLE_ENTITY", message: `Currency not supported see https://developer.paypal.com/docs using ${CLIENT_SECRET}${CLIENT_SECRET}` } }, "rejected", /UNPROCESSABLE_ENTITY.*Currency not supported/],
      [{ status: 201, json: { id: ORDER, links: [] } }, "invalid_response", /unexpected answer. Nothing was charged/],
      [{ status: 201, json: null }, "invalid_response", /unexpected answer/],
    ];
    for (const [answer, kind, words] of cases) {
      const f = fakePaypal(WH);
      route(f, answer);
      const err = await createPaypalProvider({ http: f.http }).createCheckout(creds, input).catch((e: unknown) => e);
      expect(err, JSON.stringify(answer)).toBeInstanceOf(ProviderCallError);
      expect((err as ProviderCallError).kind).toBe(kind);
      expect((err as ProviderCallError).message).toMatch(words);
      for (const secret of [CLIENT_ID, CLIENT_SECRET]) expect((err as ProviderCallError).message).not.toContain(secret);
      expect((err as ProviderCallError).message).not.toMatch(/https?:\/\//);
    }
    // An app that cannot even get a token creates nothing.
    const f = fakePaypal(WH);
    f.on((r) => r.path === "/v1/oauth2/token", { status: 401, json: null });
    await expect(createPaypalProvider({ http: f.http }).createCheckout(creds, input)).rejects.toMatchObject({ kind: "rejected" });
    expect(f.to("/v2/checkout/orders")).toHaveLength(0);
  });
});

describe("PayPal: reading an order back", () => {
  const readOrder = (f: FakePaypal, answer: Parameters<FakePaypal["on"]>[1]) => f.on((r) => r.method === "GET" && r.path === `/v2/checkout/orders/${ORDER}`, answer);

  it("shows the captures with their id, amount, currency and fee, and says paid only when a capture completed", async () => {
    const f = fakePaypal(WH);
    const pp = createPaypalProvider({ http: f.http });
    readOrder(f, { status: 200, json: paypalOrder({ orderId: ORDER, reference: REF, status: "COMPLETED", amount: 150000, captures: [{ id: "CAP1", status: "COMPLETED", fee: 700 }, { id: "CAP2", status: "DECLINED", amount: 5 }, { id: "CAP3", status: "PENDING" }] }) });
    expect(await pp.fetchCheckout!(creds, ORDER)).toEqual({
      checkoutId: ORDER, reference: REF, status: "paid",
      payments: [
        { id: "CAP1", status: "paid", amountMinor: 150000, currency: "PHP", feeMinor: 700, livemode: null },
        { id: "CAP2", status: "failed", amountMinor: 5, currency: "PHP", feeMinor: 500, livemode: null },
        { id: "CAP3", status: "pending", amountMinor: 150000, currency: "PHP", feeMinor: 500, livemode: null },
      ],
    });
    // An order the payer approved, but PayPal has not been asked to capture, is still open: approval is not payment.
    for (const status of ["CREATED", "SAVED", "APPROVED", "PAYER_ACTION_REQUIRED"]) {
      readOrder(f, { status: 200, json: paypalOrder({ orderId: ORDER, reference: REF, status, amount: 150000 }) });
      expect((await pp.fetchCheckout!(creds, ORDER))?.status, status).toBe("open");
    }
    readOrder(f, { status: 200, json: paypalOrder({ orderId: ORDER, reference: REF, status: "VOIDED", amount: 150000 }) });
    expect((await pp.fetchCheckout!(creds, ORDER))?.status).toBe("expired");
    readOrder(f, { status: 200, json: paypalOrder({ orderId: ORDER, reference: REF, status: "COMPLETED", amount: 150000, captures: [{ id: "CAP9", status: "COMPLETED" }] }) });
    expect(f.to(`/v2/checkout/orders/${ORDER}`).every((c) => c.method === "GET")).toBe(true);
  });

  it("reads an amount it cannot understand as no amount, so it can never agree with the delivery", async () => {
    const f = fakePaypal(WH);
    const pp = createPaypalProvider({ http: f.http });
    const body = paypalOrder({ orderId: ORDER, reference: REF, status: "COMPLETED", amount: 150000, captures: [{ id: "CAP1", status: "COMPLETED" }] });
    const capture = (body.purchase_units[0] as unknown as { payments: { captures: Array<{ amount: unknown }> } }).payments.captures[0];
    capture.amount = { currency_code: "XYZ", value: "1500.00" };
    readOrder(f, { status: 200, json: body });
    expect((await pp.fetchCheckout!(creds, ORDER))?.payments[0]).toMatchObject({ amountMinor: null, currency: null });
    capture.amount = { currency_code: "PHP", value: "1500.005" };
    expect((await pp.fetchCheckout!(creds, ORDER))?.payments[0]).toMatchObject({ amountMinor: null, currency: "PHP" });
  });

  it("returns nothing for an order PayPal does not know, refuses an answer about another order, and never builds a path from odd text", async () => {
    const f = fakePaypal(WH);
    const pp = createPaypalProvider({ http: f.http });
    expect(await pp.fetchCheckout!(creds, ORDER)).toBeNull();
    readOrder(f, { status: 200, json: paypalOrder({ orderId: "SOMETHINGELSE1", reference: REF, status: "COMPLETED", amount: 1 }) });
    await expect(pp.fetchCheckout!(creds, ORDER)).rejects.toMatchObject({ kind: "invalid_response" });
    const before = f.calls.length;
    for (const bad of ["../x", "a/b", "ord 1", "", "@evil.example", "x".repeat(200), "abc"]) expect(await pp.fetchCheckout!(creds, bad), bad).toBeNull();
    expect(f.calls.length).toBe(before);
  });
});

describe("PayPal: taking the payment the customer approved", () => {
  const read = (f: FakePaypal, status: string, captures?: Array<{ id: string; status: string }>) =>
    f.on((r) => r.method === "GET" && r.path === `/v2/checkout/orders/${ORDER}`, { status: 200, json: paypalOrder({ orderId: ORDER, reference: REF, status, amount: 150000, captures }) });
  const capture = (f: FakePaypal, answer: Parameters<FakePaypal["on"]>[1]) => f.on((r) => r.method === "POST" && r.path === `/v2/checkout/orders/${ORDER}/capture`, answer);

  it("captures an order the payer approved, once, with a request id of its own, and returns PayPal's record of what it took", async () => {
    const f = fakePaypal(WH);
    read(f, "APPROVED");
    capture(f, { status: 201, json: paypalOrder({ orderId: ORDER, reference: REF, status: "COMPLETED", amount: 150000, captures: [{ id: "CAP1", status: "COMPLETED" }] }) });
    const co = await createPaypalProvider({ http: f.http }).completeCheckout!(creds, ORDER, { reference: REF });
    expect(co).toMatchObject({ checkoutId: ORDER, status: "paid", payments: [{ id: "CAP1", status: "paid", amountMinor: 150000 }] });
    const call = f.to(`/v2/checkout/orders/${ORDER}/capture`);
    expect(call).toHaveLength(1);
    expect(call[0]).toMatchObject({ method: "POST", body: "{}", headers: { "PayPal-Request-Id": `${REF}-capture` } });
  });

  it("leaves an order that is not approved, or is already paid, exactly as it is: it asks for no capture", async () => {
    for (const [status, captures, expected] of [
      ["CREATED", undefined, "open"], ["PAYER_ACTION_REQUIRED", undefined, "open"], ["VOIDED", undefined, "expired"], ["COMPLETED", [{ id: "CAP1", status: "COMPLETED" }], "paid"],
    ] as const) {
      const f = fakePaypal(WH);
      read(f, status, captures as Array<{ id: string; status: string }> | undefined);
      expect((await createPaypalProvider({ http: f.http }).completeCheckout!(creds, ORDER, { reference: REF }))?.status, status).toBe(expected);
      expect(f.to(/capture$/), status).toHaveLength(0);
    }
    const f = fakePaypal(WH);
    expect(await createPaypalProvider({ http: f.http }).completeCheckout!(creds, ORDER, { reference: REF })).toBeNull();
  });

  it("reads the order again when PayPal says it was already captured, and refuses any other failure with PayPal's own reason", async () => {
    const f = fakePaypal(WH);
    const pp = createPaypalProvider({ http: f.http });
    capture(f, { status: 422, json: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_ALREADY_CAPTURED" }] } });
    f.on((r) => r.path === `/v2/checkout/orders/${ORDER}`, ((n = 0) => () => (n++ === 0 ? { status: 200, json: paypalOrder({ orderId: ORDER, reference: REF, status: "APPROVED", amount: 150000 }) } : { status: 200, json: paypalOrder({ orderId: ORDER, reference: REF, status: "COMPLETED", amount: 150000, captures: [{ id: "CAP1", status: "COMPLETED" }] }) }))());
    expect((await pp.completeCheckout!(creds, ORDER, { reference: REF }))?.status).toBe("paid");
    capture(f, { status: 422, json: { name: "UNPROCESSABLE_ENTITY", message: "The instrument presented was declined.", details: [{ issue: "INSTRUMENT_DECLINED" }] } });
    read(f, "APPROVED");
    await expect(pp.completeCheckout!(creds, ORDER, { reference: REF })).rejects.toMatchObject({ kind: "rejected", message: expect.stringMatching(/UNPROCESSABLE_ENTITY.*declined/) });
    capture(f, { status: 500, json: null });
    await expect(pp.completeCheckout!(creds, ORDER, { reference: REF })).rejects.toMatchObject({ kind: "unreachable" });
  });
});

describe("PayPal: checking a delivery", () => {
  const body = paypalCaptureCompleted({ eventId: "WH-1", captureId: "CAP1", orderId: ORDER, reference: REF, amount: 150000 });
  const verify = (f: FakePaypal, raw: string, h: ReturnType<typeof headers>, over: Partial<{ credentials: ProviderCredentials | undefined; now: number }> = {}) =>
    createPaypalProvider({ http: f.http }).verifyWebhook({ rawBody: raw, headers: h, secret: WH, now: over.now ?? now, credentials: "credentials" in over ? over.credentials : creds });

  it("asks PayPal, with the webhook's id and the event exactly as it arrived, and believes only PayPal's SUCCESS", async () => {
    const f = fakePaypal(WH);
    expect(await verify(f, body, goodHeaders(body))).toEqual({ ok: true, livemode: null });
    const call = f.to("/v1/notifications/verify-webhook-signature")[0];
    expect(call).toMatchObject({ method: "POST", bearer: "A21AAfixtureToken", contentType: "application/json" });
    const sent = sentOf(call);
    expect(sent).toMatchObject({ auth_algo: "SHA256withRSA", cert_url: PAYPAL_CERT_URL, transmission_id: "tx-1234567890", transmission_time: new Date(now).toISOString(), webhook_id: WH });
    // The event goes in byte for byte: it is the bytes that were signed.
    expect(call.body!.endsWith(`"webhook_event":${body}}`)).toBe(true);
  });

  it("does not believe a changed body, another webhook, another signature or a verdict that is not SUCCESS", async () => {
    const f = fakePaypal(WH);
    expect(await verify(f, `${body} `, goodHeaders(body))).toMatchObject({ ok: false, reason: "mismatch" });
    expect(await verify(f, body, goodHeaders(body, { "paypal-transmission-sig": "fixture-sig-forged" }))).toMatchObject({ ok: false, reason: "mismatch" });
    expect(await verify(f, body, goodHeaders(body, { "paypal-transmission-id": "tx-another" }))).toMatchObject({ ok: false, reason: "mismatch" });
    const other = fakePaypal("ANOTHERWEBHOOKID");
    expect(await verify(other, body, goodHeaders(body))).toMatchObject({ ok: false, reason: "mismatch" });
    for (const json of [{ verification_status: "FAILURE" }, { verification_status: "success" }, {}, null]) {
      const g = fakePaypal(WH);
      g.on((r) => r.path === "/v1/notifications/verify-webhook-signature", { status: 200, json });
      expect(await verify(g, body, goodHeaders(body)), JSON.stringify(json)).toMatchObject({ ok: false, reason: "mismatch" });
    }
    const g = fakePaypal(WH);
    g.on((r) => r.path === "/v1/notifications/verify-webhook-signature", { status: 500, json: { verification_status: "SUCCESS" } });
    expect(await verify(g, body, goodHeaders(body))).toMatchObject({ ok: false });
  });

  it("refuses, without asking PayPal anything, a delivery with a header missing, a certificate that is not on PayPal's domain, a stale time, no keys, or a body that is not one JSON object", async () => {
    const f = fakePaypal(WH);
    for (const name of ["paypal-auth-algo", "paypal-cert-url", "paypal-transmission-id", "paypal-transmission-sig", "paypal-transmission-time"]) {
      expect(await verify(f, body, goodHeaders(body, { [name]: null })), name).toMatchObject({ ok: false, reason: "missing" });
    }
    for (const cert of ["https://evil.example/v1/notifications/certs/x", "https://paypal.com.evil.example/certs/x", "http://api.sandbox.paypal.com/certs/x", "https://evilpaypal.com/certs/x", "ftp://api.paypal.com/x"]) {
      expect(await verify(f, body, goodHeaders(body, { "paypal-cert-url": cert })), cert).toMatchObject({ ok: false, reason: "certificate_host" });
    }
    expect(await verify(f, body, goodHeaders(body, { "paypal-cert-url": "not a url" }))).toMatchObject({ ok: false, reason: "malformed" });
    expect(await verify(f, body, goodHeaders(body, { "paypal-transmission-time": new Date(now - 5 * 86_400_000).toISOString() }))).toMatchObject({ ok: false, reason: "stale" });
    expect(await verify(f, body, goodHeaders(body, { "paypal-transmission-time": new Date(now + 5 * 86_400_000).toISOString() }))).toMatchObject({ ok: false, reason: "stale" });
    expect(await verify(f, body, goodHeaders(body, { "paypal-transmission-time": "yesterday" }))).toMatchObject({ ok: false, reason: "stale" });
    expect(await verify(f, body, goodHeaders(body), { credentials: undefined })).toMatchObject({ ok: false, reason: "no_credentials" });
    // Text after the object could add keys of its own to what PayPal is asked (a webhook id of the sender's choosing), so it is not sent.
    for (const raw of [`{"id":"WH-1","event_type":"X"}, "webhook_id":"attacker"`, "[]", '"text"', "nope", `${body}${body}`]) {
      expect(await verify(f, raw, goodHeaders(raw)), raw).toMatchObject({ ok: false, reason: "malformed" });
    }
    expect(f.calls).toHaveLength(0);
  });

  it("answers an unreachable PayPal, or keys it refuses, the same way as a forged delivery: unverifiable, with nothing about why", async () => {
    const f = fakePaypal(WH);
    f.throwNext(new ProviderCallError("unreachable", "PayPal could not be reached."));
    expect(await verify(f, body, goodHeaders(body))).toEqual({ ok: false, reason: "unverifiable" });
    f.on((r) => r.path === "/v1/oauth2/token", { status: 401, json: null });
    expect(await verify(f, body, goodHeaders(body))).toEqual({ ok: false, reason: "unverifiable" });
  });
});

describe("PayPal: reading a delivery into facts", () => {
  const pp = createPaypalProvider({ http: fakePaypal(WH).http });
  const parse = (b: string, live = false) => pp.parseEvent(b, { connectionLive: live })?.event ?? null;

  it("reads a completed capture as a payment with our reference, the order, the capture, the amount, the currency, the fee and the method", () => {
    const e = parse(paypalCaptureCompleted({ eventId: "WH-ABC", captureId: "CAP9", orderId: ORDER, reference: REF, amount: 150000, fee: 650, createTime: "2026-10-23T10:00:00.000Z" }));
    expect(e).toMatchObject({ kind: "payment.succeeded", eventId: "WH-ABC", type: "PAYMENT.CAPTURE.COMPLETED", livemode: false, checkoutId: ORDER, reference: REF, paymentId: "CAP9", amountMinor: 150000, currency: "PHP", feeMinor: 650, method: "paypal", occurredAt: "2026-10-23T10:00:00.000Z" });
  });

  it("takes the mode from the connection, because a PayPal event does not say", () => {
    const body = paypalCaptureCompleted({ orderId: ORDER, reference: REF, amount: 1000 });
    expect(parse(body, false)?.livemode).toBe(false);
    expect(parse(body, true)?.livemode).toBe(true);
    expect(pp.parseEvent(body)?.event.livemode).toBe(false);
  });

  it("does not read an approved order as money: approval is not payment", () => {
    expect(parse(paypalOrderApproved({ orderId: ORDER, reference: REF, amount: 150000 }))).toMatchObject({ kind: "ignored", reason: expect.stringMatching(/Approval is not payment/) });
    expect(parse(paypalCaptureCompleted({ orderId: ORDER, reference: REF, amount: 1000, status: "PENDING" }))).toMatchObject({ kind: "ignored", reason: expect.stringMatching(/not in the completed state/) });
  });

  it("reads a pending, denied or reversed capture, a refund, and a dispute, and each carries what the services need", () => {
    expect(parse(paypalCaptureOther("PAYMENT.CAPTURE.PENDING", { captureId: "CAP1", orderId: ORDER, reference: REF, amount: 1000 }))).toMatchObject({ kind: "payment.pending", paymentId: "CAP1", reference: REF, amountMinor: 1000 });
    expect(parse(paypalCaptureOther("PAYMENT.CAPTURE.DENIED", { captureId: "CAP2", orderId: ORDER, reference: REF, amount: 1000 }))).toMatchObject({ kind: "payment.failed", paymentId: "CAP2", reason: "PayPal denied the payment." });
    expect(parse(paypalCaptureOther("PAYMENT.CAPTURE.REVERSED", { captureId: "CAP3", orderId: ORDER, reference: REF, amount: 1000 }))).toMatchObject({ kind: "dispute.opened", paymentId: "CAP3" });
    // The resource of a refund event is the refund; the capture it belongs to is the link that points up.
    expect(parse(paypalRefunded({ refundId: "REFX", captureId: "CAP7", amount: 5000, note: "Customer changed their mind" }))).toMatchObject({ kind: "refund.succeeded", refundId: "REFX", paymentId: "CAP7", amountMinor: 5000, currency: "PHP", reason: "Customer changed their mind" });
    expect(parse(paypalDispute("CUSTOMER.DISPUTE.CREATED", { captureId: "CAP8" }))).toMatchObject({ kind: "dispute.opened", paymentId: "CAP8" });
    expect(parse(paypalDispute("CUSTOMER.DISPUTE.RESOLVED", { captureId: "CAP8" }))).toMatchObject({ kind: "dispute.closed", paymentId: "CAP8", disputeOutcome: "unknown" });
  });

  it("reads who won a resolved dispute from its outcome code, and anything it does not know plainly as unknown", () => {
    const outcome = (code: string | null, refunded?: number) => parse(paypalDisputeResolved({ captureId: "CAP9", outcomeCode: code, refunded }));
    for (const code of ["RESOLVED_SELLER_FAVOUR", "CANCELED_BY_BUYER"]) expect(outcome(code), code).toMatchObject({ kind: "dispute.closed", paymentId: "CAP9", disputeOutcome: "won" });
    // A loss carries what the buyer got back.
    expect(outcome("RESOLVED_BUYER_FAVOUR", 5000)).toMatchObject({ disputeOutcome: "lost", amountMinor: 5000, currency: "PHP" });
    expect(outcome("RESOLVED_WITH_PAYOUT", 7000)).toMatchObject({ disputeOutcome: "lost", amountMinor: 7000 });
    expect(outcome("RESOLVED_BUYER_FAVOUR")).toMatchObject({ disputeOutcome: "lost", amountMinor: null });
    for (const code of ["ACCEPTED", "DENIED", "EMPTY", "SOMETHING_NEW", "", null]) expect(outcome(code), String(code)).toMatchObject({ disputeOutcome: "unknown" });
    expect(disputeOutcomeOf(undefined)).toBe("unknown");
  });

  it("does not take a reference that is not ours, and ignores a type it does not use or a currency it does not know", () => {
    expect(parse(paypalCaptureCompleted({ orderId: ORDER, reference: "INV-12", amount: 1000 }))?.reference).toBeNull();
    expect(parse(JSON.stringify({ id: "WH-1", event_type: "BILLING.SUBSCRIPTION.CREATED", resource: {} }))).toMatchObject({ kind: "ignored", reason: "Event type is not used." });
    expect(parse(paypalCaptureCompleted({ orderId: ORDER, reference: REF, amount: 1000, currency: "XYZ" }))).toMatchObject({ kind: "payment.succeeded", amountMinor: null, currency: null });
    expect(pp.parseEvent("not json")).toBeNull();
    expect(pp.parseEvent("[]")).toBeNull();
    expect(pp.parseEvent("{}")).toBeNull();
    expect(pp.parseEvent(JSON.stringify({ id: "WH-1" }))).toBeNull();
  });
});

describe("PayPal: the real network layer", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("calls PayPal's own origin for the mode the app is in, with the secret in a header and never in the address, and does not follow a redirect", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ access_token: "tok" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const r = await paypalHttp({ method: "POST", path: "/v1/oauth2/token", environment: "sandbox", basic: { id: CLIENT_ID, secret: CLIENT_SECRET }, contentType: "application/x-www-form-urlencoded", body: "grant_type=client_credentials" });
    expect(r).toEqual({ status: 200, json: { access_token: "tok" } });
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("https://api-m.sandbox.paypal.com/v1/oauth2/token");
    for (const secret of [CLIENT_ID, CLIENT_SECRET]) expect(String(url)).not.toContain(secret);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`);
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(init.redirect).toBe("error");
    expect(init.body).toBe("grant_type=client_credentials");

    await paypalHttp({ method: "GET", path: "/v2/checkout/orders/ABC12345", environment: "live", bearer: "tok" });
    const [liveUrl, liveInit] = fetchSpy.mock.calls[1] as unknown as [URL, RequestInit];
    expect(String(liveUrl)).toBe("https://api-m.paypal.com/v2/checkout/orders/ABC12345");
    expect((liveInit.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("says unreachable when the network fails, with nothing of the request in the sentence, and reads a non-JSON answer as nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error(`ECONNRESET ${CLIENT_SECRET}`); }));
    await expect(paypalHttp({ method: "GET", path: "/v1/notifications/webhooks", environment: "sandbox", bearer: "tok" })).rejects.toMatchObject({ kind: "unreachable", message: expect.not.stringContaining(CLIENT_SECRET) });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 502 })));
    expect(await paypalHttp({ method: "GET", path: "/v1/notifications/webhooks", environment: "sandbox", bearer: "tok" })).toEqual({ status: 502, json: null });
  });
});

// ---------------------------------------------------------------------------
// The services around the adapter, on embedded Postgres
// ---------------------------------------------------------------------------

describe("PayPal: the owner connects an app", () => {
  let f: FakePaypal;
  beforeAll(() => {
    f = fakePaypal(WH);
    setAdapterForTests("paypal", createPaypalProvider({ http: f.http }));
    process.env.CUSTOMER_PAYMENTS_WRITES_ENABLED = "true";
    resetEnvCache();
  });
  afterAll(() => {
    setAdapterForTests("paypal", null);
    delete process.env.CUSTOMER_PAYMENTS_WRITES_ENABLED;
    resetEnvCache();
  });
  const stored = (id: string) => q<{ credentials: string | null; status: string; mode: string; supported_currencies: string[]; live_confirmed_at: string | null }>("select credentials, status, mode, supported_currencies, live_confirmed_at from customer_payment_connections where id = $1", [id]).then((r) => r[0]);

  it("checks the keys with a read-only call first, reads the mode from what the owner said, seals both secrets, and waits for the webhook's id", async () => {
    const io = await invoiceOrg();
    const before = f.calls.length;
    const view = await connectProvider(io.ctx("owner"), { provider: "paypal", apiKey: `  ${CLIENT_ID} `, apiSecret: CLIENT_SECRET, environment: "sandbox", accountLabel: "Santos Plumbing PayPal", authorization: AUTHORIZATION });
    expect(f.calls.slice(before).map((c) => `${c.method} ${c.path}`)).toEqual(["POST /v1/oauth2/token", "GET /v1/notifications/webhooks"]);
    expect(view).toMatchObject({ provider: "paypal", mode: "test", status: "pending_verification", environment: "sandbox", webhookSecretSaved: false, accountLabel: "Santos Plumbing PayPal" });
    expect(view.providerNote).toMatch(/has not run against a PayPal app yet/);
    expect([...view.supportedCurrencies].sort()).toEqual([...CURRENCY_CODES].sort());
    expect(view.webhookUrl).toMatch(/\/api\/webhooks\/customer-payments\/paypal\/cpk_/);
    expect(view.teamCheckoutBlock?.code).toBe("not_ready");
    const row = await stored(view.id);
    expect(row.credentials).toMatch(/^v1\./);
    expect(row.credentials).not.toContain(CLIENT_SECRET);
    expect(credentialVault.open(row.credentials)).toMatchObject({ apiKey: CLIENT_ID, apiSecret: CLIENT_SECRET, webhookSecret: null, settings: { environment: "sandbox" } });

    await expect(saveWebhookSecret(io.ctx("owner"), view.id, { webhookSecret: "short" })).rejects.toThrow(/exactly as PayPal shows it/);
    const saved = await saveWebhookSecret(io.ctx("owner"), view.id, { webhookSecret: ` ${WH} ` });
    expect(saved).toMatchObject({ status: "connected", webhookSecretSaved: true, environment: "sandbox" });
    expect(credentialVault.open((await stored(view.id)).credentials)).toMatchObject({ apiKey: CLIENT_ID, apiSecret: CLIENT_SECRET, webhookSecret: WH });
    // None of the three secrets is in what the owner is given, the audit trail or the notifications.
    for (const secret of [CLIENT_ID, CLIENT_SECRET, WH]) {
      expect(JSON.stringify(saved)).not.toContain(secret);
      for (const table of ["audit_logs", "notifications", "customer_invoice_events"]) expect(JSON.stringify(await q(`select * from ${table} where org_id = $1`, [io.orgId])), `${table} / ${secret}`).not.toContain(secret);
    }
  });

  it("treats a live app as live and a sandbox app as test, and never lets the sandbox take a customer's payment", async () => {
    const io = await invoiceOrg();
    const live = await connectProvider(io.ctx("owner"), { provider: "paypal", apiKey: CLIENT_ID, apiSecret: CLIENT_SECRET, environment: "live", webhookSecret: WH, authorization: AUTHORIZATION });
    expect(live).toMatchObject({ mode: "live", environment: "live", status: "connected", customerCheckoutBlock: { code: "live_off" } });
    expect(f.calls[f.calls.length - 2].environment).toBe("live");
    const other = await invoiceOrg();
    const sandbox = await connectProvider(other.ctx("owner"), { provider: "paypal", apiKey: CLIENT_ID, apiSecret: CLIENT_SECRET, environment: "sandbox", webhookSecret: WH, authorization: AUTHORIZATION });
    expect(sandbox.customerCheckoutBlock?.code).toBe("test_mode_public");
    expect(sandbox.teamCheckoutBlock).toBeNull();
  });

  it("saves nothing, and sends nothing, when what was pasted is not an app, and when PayPal refuses it", async () => {
    const io = await invoiceOrg();
    const connectWith = (over: Record<string, unknown>) => connectProvider(io.ctx("owner"), { provider: "paypal", apiKey: CLIENT_ID, apiSecret: CLIENT_SECRET, environment: "sandbox", authorization: AUTHORIZATION, ...over });
    const before = f.calls.length;
    await expect(connectWith({ apiKey: "" })).rejects.toThrow(/Paste your PayPal client ID/);
    await expect(connectWith({ apiSecret: "" })).rejects.toThrow(/Paste your PayPal client secret/);
    await expect(connectWith({ apiKey: "short" })).rejects.toThrow(/does not look like a PayPal client ID/);
    await expect(connectWith({ apiSecret: CLIENT_ID })).rejects.toThrow(/different values/);
    await expect(connectWith({ environment: undefined })).rejects.toThrow(/sandbox \(testing\) app or a live one/);
    await expect(connectWith({ webhookSecret: "no" })).rejects.toThrow(/exactly as PayPal shows it/);
    expect(f.calls.length).toBe(before);
    f.on((r) => r.path === "/v1/oauth2/token", { status: 401, json: null });
    const refused = await connectWith({}).catch((e: Error) => e);
    expect(refused).toMatchObject({ code: "invalid_input", message: expect.stringMatching(/did not accept this client ID and secret.*Nothing was saved/) });
    for (const secret of [CLIENT_ID, CLIENT_SECRET]) expect(String((refused as Error).message)).not.toContain(secret);
    f.on((r) => r.path === "/v1/oauth2/token", { status: 503, json: null });
    await expect(connectWith({})).rejects.toMatchObject({ code: "upstream_error", message: expect.stringMatching(/Nothing was saved/) });
    expect(await q("select id from customer_payment_connections where org_id = $1", [io.orgId])).toEqual([]);
    f.on((r) => r.path === "/v1/oauth2/token", { status: 200, json: { access_token: "A21AAfixtureToken" } });
  });

  it("keeps the webhook's id when the app's keys are rotated, but not from the sandbox app to the live one (their webhooks are different), checks the new keys first, and never carries a live confirmation over", async () => {
    const io = await invoiceOrg();
    const view = await connectProvider(io.ctx("owner"), { provider: "paypal", apiKey: CLIENT_ID, apiSecret: CLIENT_SECRET, environment: "sandbox", webhookSecret: WH, authorization: AUTHORIZATION });
    // The same environment: the sandbox webhook is still the sandbox webhook.
    const rotated = await replaceCredentials(io.ctx("owner"), view.id, { apiKey: "RotatedClientIdRotated12", apiSecret: "RotatedClientSecretRotated1", authorization: AUTHORIZATION });
    expect(rotated).toMatchObject({ mode: "test", environment: "sandbox", status: "connected", webhookSecretSaved: true });
    expect(credentialVault.open((await stored(view.id)).credentials)).toMatchObject({ apiKey: "RotatedClientIdRotated12", webhookSecret: WH });
    // Sandbox to live: the sandbox app's webhook id means nothing to the live app, so it is dropped and the connection waits for the live webhook's id.
    const live = await replaceCredentials(io.ctx("owner"), view.id, { apiKey: "LiveClientIdLiveClientId12", apiSecret: "LiveClientSecretLiveClientSecret1", environment: "live", authorization: AUTHORIZATION });
    expect(live).toMatchObject({ mode: "live", environment: "live", status: "pending_verification", webhookSecretSaved: false, liveConfirmedAt: null });
    expect(live.liveConfirmBlock).toMatch(/webhook signing secret/);
    expect(credentialVault.open((await stored(view.id)).credentials)).toMatchObject({ apiKey: "LiveClientIdLiveClientId12", apiSecret: "LiveClientSecretLiveClientSecret1", webhookSecret: null, settings: { environment: "live" } });
    const paired = await replaceCredentials(io.ctx("owner"), view.id, { apiKey: "LiveClientIdLiveClientId12", apiSecret: "LiveClientSecretLiveClientSecret1", environment: "live", webhookSecret: "LIVEWEBHOOK1234567890", authorization: AUTHORIZATION });
    expect(paired).toMatchObject({ mode: "live", status: "connected", webhookSecretSaved: true });
    expect(credentialVault.open((await stored(view.id)).credentials)).toMatchObject({ webhookSecret: "LIVEWEBHOOK1234567890" });
    await withSystem((db) => db.query("update customer_payment_connections set live_confirmed_at = now(), live_confirmed_by = $2 where id = $1", [view.id, io.c.people.owner.id]));
    f.on((r) => r.path === "/v1/oauth2/token", { status: 401, json: null });
    await expect(replaceCredentials(io.ctx("owner"), view.id, { apiKey: CLIENT_ID, apiSecret: CLIENT_SECRET, environment: "sandbox", authorization: AUTHORIZATION })).rejects.toThrow(/did not accept/);
    expect((await stored(view.id)).live_confirmed_at).not.toBeNull();
    f.on((r) => r.path === "/v1/oauth2/token", { status: 200, json: { access_token: "A21AAfixtureToken" } });
    const again = await replaceCredentials(io.ctx("owner"), view.id, { apiKey: CLIENT_ID, apiSecret: CLIENT_SECRET, environment: "sandbox", authorization: AUTHORIZATION });
    expect(again).toMatchObject({ mode: "test", liveConfirmedAt: null });
    expect(await listConnections(io.ctx("owner"))).toHaveLength(1);
  });

  it("is switched off with the environment's calls switch: nothing is sent to PayPal and nothing is saved", async () => {
    const io = await invoiceOrg();
    delete process.env.CUSTOMER_PAYMENTS_WRITES_ENABLED;
    resetEnvCache();
    try {
      const before = f.calls.length;
      await expect(connectProvider(io.ctx("owner"), { provider: "paypal", apiKey: CLIENT_ID, apiSecret: CLIENT_SECRET, environment: "sandbox", authorization: AUTHORIZATION })).rejects.toThrow(/switched off on this server/);
      expect(f.calls.length).toBe(before);
      expect(await q("select id from customer_payment_connections where org_id = $1", [io.orgId])).toEqual([]);
    } finally {
      process.env.CUSTOMER_PAYMENTS_WRITES_ENABLED = "true";
      resetEnvCache();
    }
  });

  it("is honest in its own label: built, and never run against PayPal", () => {
    expect(PROVIDER_STATE.paypal).toEqual({ state: "built_unverified", note: expect.stringMatching(/has not run against a PayPal app yet/) });
    expect(createPaypalProvider().contractVerified).toBe(false);
  });
});

describe("PayPal: starting a customer's payment", () => {
  let f: FakePaypal;
  beforeAll(() => {
    process.env.CUSTOMER_PAYMENTS_WRITES_ENABLED = "true";
    resetEnvCache();
  });
  afterAll(() => {
    setAdapterForTests("paypal", null);
    delete process.env.CUSTOMER_PAYMENTS_WRITES_ENABLED;
    delete process.env.CUSTOMER_PAYMENTS_LIVE_ENABLED;
    resetEnvCache();
  });

  async function ready(over: Parameters<typeof connect>[1] = {}) {
    const io = await invoiceOrg();
    // A sandbox app takes a TEST invoice and a live app a real one: test money and real money never meet on an invoice.
    const inv = (await issuedInvoice(io, { isTest: (over.mode ?? "test") === "test" })).invoice;
    const conn = await connect(io, { provider: "paypal", ...over });
    f = fakePaypal(conn.webhookSecret);
    setAdapterForTests("paypal", createPaypalProvider({ http: f.http }));
    const order = `ORD${uid()}${uid()}`.toUpperCase();
    f.on((r) => r.method === "POST" && r.path === "/v2/checkout/orders", { status: 201, json: { id: order, status: "PAYER_ACTION_REQUIRED", links: [{ href: `https://www.sandbox.paypal.com/checkoutnow?token=${order}`, rel: "payer-action", method: "GET" }] } });
    return { io, inv, conn, order };
  }

  it("asks PayPal for the invoice's balance as the server worked it out, stores the order and the page, finds the same checkout again, and sends the return addresses of this product", async () => {
    const s = await ready();
    const first = await startCheckout({ orgId: s.io.orgId, invoiceId: s.inv.id, audience: "member", actorUserId: s.io.c.people.owner.id });
    expect(first).toMatchObject({ provider: "paypal", amountMinor: 150000, currency: "PHP", reused: false, checkoutUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${s.order}` });
    const body = sentOf(f.to("/v2/checkout/orders")[0]);
    expect(body.purchase_units[0]).toMatchObject({ amount: { currency_code: "PHP", value: "1500.00" }, description: expect.stringMatching(/^Invoice TEST-/) });
    expect(body.purchase_units[0].custom_id).toMatch(/^CP-[A-Za-z0-9]{20,40}$/);
    expect(body.payment_source.paypal.experience_context.return_url).toContain(`/pay/return/${body.purchase_units[0].custom_id}`);
    expect(await q("select provider_checkout_id, status from customer_payment_attempts where id = $1", [first.attemptId])).toEqual([{ provider_checkout_id: s.order, status: "redirected" }]);
    const again = await startCheckout({ orgId: s.io.orgId, invoiceId: s.inv.id, audience: "member", actorUserId: s.io.c.people.owner.id });
    expect(again).toMatchObject({ attemptId: first.attemptId, reused: true });
    expect(f.to("/v2/checkout/orders")).toHaveLength(1);
  });

  it("does not send a customer to a sandbox app, and sends one to a live app only after the owner confirmed going live and both switches are on", async () => {
    const sandbox = await ready();
    await expect(startCheckout({ orgId: sandbox.io.orgId, invoiceId: sandbox.inv.id, audience: "public" })).rejects.toMatchObject({ code: "unavailable" });
    expect(f.to("/v2/checkout/orders")).toHaveLength(0);
    const live = await ready({ mode: "live", liveConfirmed: true });
    await expect(startCheckout({ orgId: live.io.orgId, invoiceId: live.inv.id, audience: "public" })).rejects.toMatchObject({ code: "unavailable" });
    process.env.CUSTOMER_PAYMENTS_LIVE_ENABLED = "true";
    resetEnvCache();
    try {
      expect(await startCheckout({ orgId: live.io.orgId, invoiceId: live.inv.id, audience: "public" })).toMatchObject({ provider: "paypal", reused: false });
      expect(f.to("/v2/checkout/orders")[0].environment).toBe("live");
    } finally {
      delete process.env.CUSTOMER_PAYMENTS_LIVE_ENABLED;
      resetEnvCache();
    }
  });

  it("tells the team PayPal's own reason, and leaves the attempt closed so the payer can try again, when PayPal refuses the order", async () => {
    const s = await ready();
    f.on((r) => r.method === "POST" && r.path === "/v2/checkout/orders", { status: 422, json: { name: "UNPROCESSABLE_ENTITY", message: "Currency not supported." } });
    const team = await startCheckout({ orgId: s.io.orgId, invoiceId: s.inv.id, audience: "member", actorUserId: s.io.c.people.owner.id }).catch((e: Error) => e);
    expect(team).toMatchObject({ message: expect.stringMatching(/UNPROCESSABLE_ENTITY.*Nothing was charged/) });
    expect(await q("select status from customer_payment_attempts where invoice_id = $1 order by created_at", [s.inv.id])).toEqual([{ status: "failed" }]);
  });
});

describe("PayPal: a delivery reaches the books only through the webhook's checks", () => {
  beforeAll(() => {
    process.env.CUSTOMER_PAYMENTS_WRITES_ENABLED = "true";
    resetEnvCache();
  });
  afterAll(() => {
    setAdapterForTests("paypal", null);
    delete process.env.CUSTOMER_PAYMENTS_WRITES_ENABLED;
    resetEnvCache();
  });

  async function setup(over: Parameters<typeof connect>[1] = {}) {
    const io = await invoiceOrg();
    const inv = (await issuedInvoice(io, { isTest: (over.mode ?? "test") === "test" })).invoice;
    const conn = await connect(io, { provider: "paypal", ...over });
    const fake = fakePaypal(conn.webhookSecret);
    setAdapterForTests("paypal", createPaypalProvider({ http: fake.http }));
    const order = `ORD${uid()}${uid()}`.toUpperCase();
    const a = await attempt(inv.id, conn, { checkoutId: order });
    return { io, inv, conn, a, order, fake };
  }
  type S = Awaited<ReturnType<typeof setup>>;
  /** What PayPal answers when asked about the order: the read-back that backs a delivery. */
  const orderIs = (s: S, status: string, captures: Array<{ id: string; status: string; amount?: number }>) =>
    s.fake.on((r) => r.method === "GET" && r.path === `/v2/checkout/orders/${s.order}`, { status: 200, json: paypalOrder({ orderId: s.order, reference: s.a.reference, status, amount: s.a.amountMinor, captures }) });
  const completed = (s: S, over: Partial<Parameters<typeof paypalCaptureCompleted>[0]> = {}) => paypalCaptureCompleted({ orderId: s.order, reference: s.a.reference, amount: s.a.amountMinor, captureId: "CAPONE", ...over });
  const FORBIDDEN = { status: 403, body: { error: "forbidden" }, outcome: "rejected" };
  const kinds = async (invoiceId: string) => (await rows<{ kind: string }>("select kind from customer_invoice_events where invoice_id = $1 order by id", [invoiceId])).map((e) => e.kind);

  it("records a genuine completed capture once: PayPal is asked to verify it and to confirm the capture, the money is counted, and the receipt keeps facts, not the body", async () => {
    const s = await setup();
    orderIs(s, "COMPLETED", [{ id: "CAPONE", status: "COMPLETED" }]);
    const raw = JSON.stringify({ ...JSON.parse(completed(s, { eventId: "WH-ONE" })), payer: { name: "Maria Santos", email: "maria.santos@example.test" } });
    expect(await paypalDeliver(s.conn, raw)).toMatchObject({ status: 200, outcome: "processed" });
    expect(s.fake.to("/v1/notifications/verify-webhook-signature")).toHaveLength(1);
    expect(s.fake.to(`/v2/checkout/orders/${s.order}`)).toHaveLength(1);
    expect(await paymentsOf(s.inv.id)).toEqual([{ id: expect.any(String), status: "succeeded", amount_minor: "150000", provider_payment_id: "CAPONE", livemode: false, verification: "provider_confirmed", attempt_id: s.a.id }]);
    expect(await invoiceNow(s.inv.id)).toMatchObject({ payment_status: "paid", paid_minor: "150000", balance_minor: "0" });
    expect((await attemptNow(s.a.id)).status).toBe("succeeded");
    expect(await q("select provider, method, fee_minor::text as fee from customer_payments where invoice_id = $1", [s.inv.id])).toEqual([{ provider: "paypal", method: "paypal", fee: "500" }]);
    const stored = JSON.stringify(await q("select * from customer_payment_events where connection_id = $1", [s.conn.id]));
    for (const secret of ["Maria", "maria.santos", s.conn.webhookSecret, s.conn.apiSecret as string]) expect(stored, secret).not.toContain(secret);
    expect(await kinds(s.inv.id)).toEqual(["created", "issued", "payment_verified", "paid"]);
    // The same event again changes nothing.
    expect(await paypalDeliver(s.conn, raw)).toMatchObject({ status: 200, outcome: "duplicate" });
    expect(await paymentsOf(s.inv.id)).toHaveLength(1);
  });

  it("counts a live app's payment as live money and a sandbox app's as test money", async () => {
    const live = await setup({ mode: "live", liveConfirmed: true });
    orderIs(live, "COMPLETED", [{ id: "CAPONE", status: "COMPLETED" }]);
    expect((await paypalDeliver(live.conn, completed(live))).outcome).toBe("processed");
    expect((await paymentsOf(live.inv.id))[0]).toMatchObject({ livemode: true, status: "succeeded" });
    const test = await setup();
    orderIs(test, "COMPLETED", [{ id: "CAPONE", status: "COMPLETED" }]);
    expect((await paypalDeliver(test.conn, completed(test))).outcome).toBe("processed");
    expect((await paymentsOf(test.inv.id))[0].livemode).toBe(false);
  });

  it("answers a changed body, another webhook, a forged or missing header, a certificate off PayPal's domain, a stale delivery and an unknown key with one identical bare 403, and stores nothing", async () => {
    const s = await setup();
    orderIs(s, "COMPLETED", [{ id: "CAPONE", status: "COMPLETED" }]);
    const body = completed(s);
    const good = paypalSignatureFor(s.conn.webhookSecret, "tx-fixed-1", body);
    const tries: Array<[string, Awaited<ReturnType<typeof paypalDeliver>>]> = [
      ["tampered body", await paypalDeliver(s.conn, `${body} `, { transmissionId: "tx-fixed-1", signature: good })],
      ["another webhook's id", await paypalDeliver(s.conn, body, { webhookId: "ANOTHERWEBHOOKID" })],
      ["forged signature", await paypalDeliver(s.conn, body, { signature: "fixture-sig-forged" })],
      ["missing signature", await paypalDeliver(s.conn, body, { signature: null })],
      ["missing time", await paypalDeliver(s.conn, body, { omit: ["paypal-transmission-time"] })],
      ["certificate off PayPal's domain", await paypalDeliver(s.conn, body, { certUrl: "https://evil.example/certs/x" })],
      ["stale time", await paypalDeliver(s.conn, body, { time: new Date(Date.now() - 5 * 86_400_000).toISOString() })],
      ["unknown key", await paypalDeliver(s.conn, body, { key: "cpk_zzzzzzzzzzzzzzzzzzzz" })],
    ];
    for (const [label, r] of tries) expect(r, label).toEqual(FORBIDDEN);
    expect(await receipts(s.conn.id)).toEqual([]);
    expect(await paymentsOf(s.inv.id)).toEqual([]);
    expect((await invoiceNow(s.inv.id)).payment_status).toBe("unpaid");
    // A header or a certificate that is wrong never even reaches PayPal.
    expect(s.fake.to("/v1/notifications/verify-webhook-signature").length).toBeLessThan(tries.length);
  });

  it("lets only so many deliveries a minute spend the business's own credentials on asking PayPal to check them, whoever sent them, and leaves another connection alone", async () => {
    const s = await setup();
    const other = await setup();
    // (The adapter in use is the one made last, so its network layer is the one that is asked.)
    const verifications = () => other.fake.to("/v1/notifications/verify-webhook-signature").length;
    const seen: number[] = [];
    // A body that is one JSON object and carries well-formed headers gets as far as PayPal; it is not genuine, so PayPal says so.
    for (let i = 0; i < 400 && !seen.includes(429); i += 1) seen.push((await paypalDeliver(s.conn, JSON.stringify({ id: `WH-forged-${i}`, event_type: "PAYMENT.CAPTURE.COMPLETED", resource: {} }))).status);
    expect(seen.at(-1)).toBe(429);
    expect(seen.slice(0, -1).every((st) => st === 403)).toBe(true);
    expect(verifications()).toBe(seen.length - 1);
    expect(verifications()).toBeLessThanOrEqual(120);
    // Once the budget is spent, nothing more is asked of PayPal for this connection (a genuine delivery waits for PayPal's own retry)...
    const before = verifications();
    expect((await paypalDeliver(s.conn, completed(s))).status).toBe(429);
    expect(verifications()).toBe(before);
    expect(await paymentsOf(s.inv.id)).toEqual([]);
    // ...while another business's connection is untouched.
    orderIs(other, "COMPLETED", [{ id: "CAPONE", status: "COMPLETED" }]);
    expect((await paypalDeliver(other.conn, completed(other))).status).toBe(200);
  }, 120_000);

  it("answers the same bare 403 while PayPal cannot be reached to verify, stores nothing, and records the delivery when PayPal is back", async () => {
    const s = await setup();
    orderIs(s, "COMPLETED", [{ id: "CAPONE", status: "COMPLETED" }]);
    const body = completed(s);
    s.fake.throwNext(new ProviderCallError("unreachable", "PayPal could not be reached."));
    expect(await paypalDeliver(s.conn, body)).toEqual(FORBIDDEN);
    expect(await receipts(s.conn.id)).toEqual([]);
    expect(await paypalDeliver(s.conn, body)).toMatchObject({ status: 200, outcome: "processed" });
    expect((await invoiceNow(s.inv.id)).payment_status).toBe("paid");
  });

  it("does not count an approval: the order was approved, nothing was captured, and the invoice is as unpaid as before", async () => {
    const s = await setup();
    const r = await paypalDeliver(s.conn, paypalOrderApproved({ orderId: s.order, reference: s.a.reference, amount: s.a.amountMinor }));
    expect(r).toMatchObject({ status: 200, outcome: "ignored" });
    expect(await receipts(s.conn.id)).toEqual([]);
    expect(await paymentsOf(s.inv.id)).toEqual([]);
    expect((await invoiceNow(s.inv.id)).payment_status).toBe("unpaid");
    expect((await attemptNow(s.a.id)).status).toBe("redirected");
  });

  it("keeps a capture for review, counting nothing, when PayPal's own record does not show it, does not agree on the amount, or when the event names another order", async () => {
    const missing = await setup();
    orderIs(missing, "APPROVED", []);
    expect((await paypalDeliver(missing.conn, completed(missing))).outcome).toBe("processed");
    expect(await paymentsOf(missing.inv.id)).toEqual([expect.objectContaining({ status: "needs_review" })]);
    expect((await invoiceNow(missing.inv.id)).payment_status).toBe("unpaid");

    const disagree = await setup();
    orderIs(disagree, "COMPLETED", [{ id: "CAPONE", status: "COMPLETED", amount: 100 }]);
    expect((await paypalDeliver(disagree.conn, completed(disagree))).outcome).toBe("processed");
    expect(await paymentsOf(disagree.inv.id)).toEqual([expect.objectContaining({ status: "needs_review" })]);

    const short = await setup();
    orderIs(short, "COMPLETED", [{ id: "CAPONE", status: "COMPLETED", amount: 100 }]);
    expect((await paypalDeliver(short.conn, completed(short, { amount: 100 }))).outcome).toBe("processed");
    expect(await paymentsOf(short.inv.id)).toEqual([expect.objectContaining({ status: "needs_review", amount_minor: "100" })]);
    expect((await invoiceNow(short.inv.id)).paid_minor).toBe("0");

    const foreign = await setup();
    orderIs(foreign, "COMPLETED", [{ id: "CAPONE", status: "COMPLETED" }]);
    expect((await paypalDeliver(foreign.conn, completed(foreign, { orderId: "SOMEOTHERORDER1" }))).outcome).toBe("processed");
    expect(await paymentsOf(foreign.inv.id)).toEqual([expect.objectContaining({ status: "needs_review" })]);
    expect((await invoiceNow(foreign.inv.id)).payment_status).toBe("unpaid");
  });

  it("records a pending capture without counting it, counts it when PayPal completes it, and notes a denied one while the checkout stays open", async () => {
    const s = await setup();
    expect((await paypalDeliver(s.conn, paypalCaptureOther("PAYMENT.CAPTURE.PENDING", { captureId: "CAPONE", orderId: s.order, reference: s.a.reference, amount: s.a.amountMinor }))).outcome).toBe("processed");
    expect(await paymentsOf(s.inv.id)).toEqual([expect.objectContaining({ status: "pending", provider_payment_id: "CAPONE" })]);
    expect((await invoiceNow(s.inv.id)).payment_status).toBe("unpaid");
    orderIs(s, "COMPLETED", [{ id: "CAPONE", status: "COMPLETED" }]);
    expect((await paypalDeliver(s.conn, completed(s))).outcome).toBe("processed");
    expect(await paymentsOf(s.inv.id)).toEqual([expect.objectContaining({ status: "succeeded" })]);
    expect((await invoiceNow(s.inv.id)).payment_status).toBe("paid");

    const d = await setup();
    expect((await paypalDeliver(d.conn, paypalCaptureOther("PAYMENT.CAPTURE.DENIED", { captureId: "CAPDENIED", orderId: d.order, reference: d.a.reference, amount: d.a.amountMinor }))).outcome).toBe("processed");
    expect(await paymentsOf(d.inv.id)).toEqual([expect.objectContaining({ status: "failed" })]);
    expect((await invoiceNow(d.inv.id)).payment_status).toBe("unpaid");
    expect((await attemptNow(d.a.id)).status).toBe("redirected");
  });

  it("records a refund PayPal reports against a capture it recorded, defers one that comes first, and holds a reversed capture as a dispute", async () => {
    const s = await setup();
    const refund = paypalRefunded({ refundId: "REFONE", captureId: "CAPONE", amount: 50000 });
    // The refund came before its payment: kept until the payment is recorded.
    expect((await paypalDeliver(s.conn, refund)).outcome).toBe("deferred");
    orderIs(s, "COMPLETED", [{ id: "CAPONE", status: "COMPLETED" }]);
    expect((await paypalDeliver(s.conn, completed(s))).outcome).toBe("processed");
    expect((await paypalDeliver(s.conn, paypalRefunded({ refundId: "REFTWO", captureId: "CAPONE", amount: 50000 }))).outcome).toBe("processed");
    expect(await invoiceNow(s.inv.id)).toMatchObject({ refunded_minor: "50000" });
    expect(await q("select source, amount_minor::text as amount, provider_refund_id from customer_refunds where invoice_id = $1", [s.inv.id])).toEqual([{ source: "provider_event", amount: "50000", provider_refund_id: "REFTWO" }]);
    // A refund for more than is left is refused and a person is told.
    expect((await paypalDeliver(s.conn, paypalRefunded({ refundId: "REFTHREE", captureId: "CAPONE", amount: 999999 }))).outcome).toBe("rejected");
    expect((await invoiceNow(s.inv.id)).refunded_minor).toBe("50000");

    const d = await setup();
    orderIs(d, "COMPLETED", [{ id: "CAPONE", status: "COMPLETED" }]);
    await paypalDeliver(d.conn, completed(d));
    expect((await paypalDeliver(d.conn, paypalCaptureOther("PAYMENT.CAPTURE.REVERSED", { captureId: "CAPONE", orderId: d.order, reference: d.a.reference, amount: d.a.amountMinor }))).outcome).toBe("processed");
    expect((await invoiceNow(d.inv.id)).payment_status).toBe("disputed");
    // A resolution that does not say who won clears nothing: the hold the reversal set stays until a person says how it ended.
    expect((await paypalDeliver(d.conn, paypalDispute("CUSTOMER.DISPUTE.RESOLVED", { captureId: "CAPONE" }))).outcome).toBe("processed");
    expect((await invoiceNow(d.inv.id)).payment_status).toBe("disputed");
  });

  it("settles a dispute by how PayPal says it ended: a win puts the payment back, a loss is a chargeback, and anything else waits for the owner", async () => {
    const disputed = async () => {
      const s = await setup();
      orderIs(s, "COMPLETED", [{ id: "CAPONE", status: "COMPLETED" }]);
      await paypalDeliver(s.conn, completed(s));
      // PayPal often reports the reversed capture first and the resolution after it.
      await paypalDeliver(s.conn, paypalCaptureOther("PAYMENT.CAPTURE.REVERSED", { captureId: "CAPONE", orderId: s.order, reference: s.a.reference, amount: s.a.amountMinor }));
      expect((await invoiceNow(s.inv.id)).payment_status).toBe("disputed");
      return s;
    };
    const paymentStatus = async (s: S) => (await paymentsOf(s.inv.id))[0].status;

    const won = await disputed();
    expect((await paypalDeliver(won.conn, paypalDisputeResolved({ captureId: "CAPONE", outcomeCode: "RESOLVED_SELLER_FAVOUR" }))).outcome).toBe("processed");
    expect(await paymentStatus(won)).toBe("succeeded");
    expect(await invoiceNow(won.inv.id)).toMatchObject({ payment_status: "paid", refunded_minor: "0" });
    expect(await kinds(won.inv.id)).toContain("dispute_closed");

    const lost = await disputed();
    expect((await paypalDeliver(lost.conn, paypalDisputeResolved({ captureId: "CAPONE", outcomeCode: "RESOLVED_BUYER_FAVOUR", refunded: lost.a.amountMinor }))).outcome).toBe("processed");
    expect(await paymentStatus(lost)).toBe("refunded");
    expect(await invoiceNow(lost.inv.id)).toMatchObject({ payment_status: "paid", paid_minor: "150000", refunded_minor: "150000" });
    expect(await q("select source, status, amount_minor::text as amount from customer_refunds where invoice_id = $1", [lost.inv.id])).toEqual([{ source: "chargeback", status: "succeeded", amount: "150000" }]);
    expect((await rows<{ title: string }>("select title from notifications where org_id = $1 and kind = 'payment_review_needed' and user_id = $2 order by created_at", [lost.io.orgId, lost.io.c.people.owner.id])).map((n) => n.title)).toContain("A dispute on TEST-0001 was lost");

    // A buyer's win with no amount, and a code PayPal uses that this product does not read, are not guessed at.
    for (const code of ["RESOLVED_BUYER_FAVOUR", "ACCEPTED", null]) {
      const open = await disputed();
      expect((await paypalDeliver(open.conn, paypalDisputeResolved({ captureId: "CAPONE", outcomeCode: code }))).outcome).toBe("processed");
      expect(await paymentStatus(open), String(code)).toBe("disputed");
      expect(await invoiceNow(open.inv.id)).toMatchObject({ payment_status: "disputed", refunded_minor: "0" });
      expect(await kinds(open.inv.id)).toContain("dispute_result_unknown");
    }
  });

  it("asks the deal's owner to look again when a dispute is lost after the deal was marked won, and never reopens the deal", async () => {
    const io = await invoiceOrg();
    await withSystem((db) => db.query("insert into customer_invoice_settings (org_id, close_rule) values ($1, 'auto_won') on conflict (org_id) do update set close_rule = 'auto_won'", [io.orgId]));
    const dealId = await dealFor(io, await contactIn(io), { ownerId: io.c.people.sales.id });
    const d = await createDraft(io.ctx("owner"), { opportunityId: dealId, currency: "PHP", lines: [line({ unitPrice: "1500" })], closesDeal: true });
    const inv = (await issueInvoice(io.ctx("owner"), d.invoice.id, { version: d.invoice.version })).detail.invoice;
    const conn = await connect(io, { provider: "paypal", mode: "live", liveConfirmed: true });
    const fake = fakePaypal(conn.webhookSecret);
    setAdapterForTests("paypal", createPaypalProvider({ http: fake.http }));
    const order = `ORD${uid()}${uid()}`.toUpperCase();
    const a = await attempt(inv.id, conn, { checkoutId: order });
    const s = { io, inv, conn, a, order, fake };
    orderIs(s, "COMPLETED", [{ id: "CAPONE", status: "COMPLETED" }]);
    expect((await paypalDeliver(conn, completed(s))).outcome).toBe("processed");
    const status = async () => (await rows<{ status: string }>("select status from crm_opportunities where id = $1", [dealId]))[0].status;
    expect(await status()).toBe("won");
    await paypalDeliver(conn, paypalCaptureOther("PAYMENT.CAPTURE.REVERSED", { captureId: "CAPONE", orderId: order, reference: a.reference, amount: a.amountMinor }));
    expect(await rows("select 1 from tasks where opportunity_id = $1", [dealId])).toEqual([]);
    expect((await paypalDeliver(conn, paypalDisputeResolved({ captureId: "CAPONE", outcomeCode: "RESOLVED_BUYER_FAVOUR", refunded: a.amountMinor }))).outcome).toBe("processed");
    expect(await status()).toBe("won");
    expect(await rows<{ title: string }>("select title from tasks where opportunity_id = $1", [dealId])).toEqual([{ title: "A refund was recorded on invoice INV-0001: review the deal" }]);
  });

  it("is inert for another workspace: a delivery that PayPal verifies for one app but that names another workspace's checkout finds nothing there", async () => {
    const a = await setup();
    const b = await setup();
    orderIs(b, "COMPLETED", [{ id: "CAPONE", status: "COMPLETED" }]);
    // Genuine for A's webhook, but the checkout it names is B's.
    const body = paypalCaptureCompleted({ orderId: b.order, reference: b.a.reference, amount: b.a.amountMinor, captureId: "CAPCROSS" });
    setAdapterForTests("paypal", createPaypalProvider({ http: a.fake.http }));
    expect(await paypalDeliver(a.conn, body)).toMatchObject({ status: 200, outcome: "rejected" });
    expect(await paymentsOf(b.inv.id)).toEqual([]);
    expect((await invoiceNow(b.inv.id)).payment_status).toBe("unpaid");
    expect((await attemptNow(b.a.id)).status).toBe("redirected");
    expect(await paymentsOf(a.inv.id)).toEqual([]);
    expect((await receipts(a.conn.id))[0]).toMatchObject({ outcome: "rejected", detail: { note: expect.stringMatching(/No checkout on this connection has that reference/) } });
    // And B's own webhook cannot be reached with A's key, or the other way round.
    expect(await paypalDeliver(a.conn, body, { key: b.conn.publicKey })).toEqual(FORBIDDEN);
  });
});

describe("PayPal: the customer comes back from PayPal", () => {
  let f: FakePaypal;
  beforeAll(() => {
    process.env.CUSTOMER_PAYMENTS_WRITES_ENABLED = "true";
    resetEnvCache();
  });
  afterAll(() => {
    setAdapterForTests("paypal", null);
    delete process.env.CUSTOMER_PAYMENTS_WRITES_ENABLED;
    resetEnvCache();
  });

  async function setup(over: Parameters<typeof connect>[1] = {}) {
    const io = await invoiceOrg();
    const inv = (await issuedInvoice(io, { isTest: (over.mode ?? "test") === "test" })).invoice;
    const conn = await connect(io, { provider: "paypal", ...over });
    const fake = fakePaypal(conn.webhookSecret);
    f = fake;
    setAdapterForTests("paypal", createPaypalProvider({ http: fake.http }));
    const order = `ORD${uid()}${uid()}`.toUpperCase();
    const a = await attempt(inv.id, conn, { checkoutId: order });
    return { io, inv, conn, a, order, fake };
  }
  type S = Awaited<ReturnType<typeof setup>>;
  const order = (s: S, status: string, captures?: Array<{ id: string; status: string }>) =>
    ({ status: 200, json: paypalOrder({ orderId: s.order, reference: s.a.reference, status, amount: s.a.amountMinor, captures }) });
  const capturePath = (s: S) => `/v2/checkout/orders/${s.order}/capture`;

  it("takes the approved payment once, and counts it only through the same receipt a delivery leaves", async () => {
    const s = await setup();
    // PayPal's order is approved until the capture is asked for, and completed after it.
    s.fake.on((r) => r.method === "GET" && r.path === `/v2/checkout/orders/${s.order}`, () => (s.fake.to(capturePath(s)).length ? order(s, "COMPLETED", [{ id: "CAPRET", status: "COMPLETED" }]) : order(s, "APPROVED")));
    s.fake.on((r) => r.method === "POST" && r.path === capturePath(s), { ...order(s, "COMPLETED", [{ id: "CAPRET", status: "COMPLETED" }]), status: 201 });
    expect(await completeApprovedCheckout(s.a.reference, s.order, { ip: null })).toEqual({ ok: true });
    expect(s.fake.to(capturePath(s))).toHaveLength(1);
    expect(await paymentsOf(s.inv.id)).toEqual([expect.objectContaining({ status: "succeeded", provider_payment_id: "CAPRET", verification: "provider_confirmed" })]);
    expect((await invoiceNow(s.inv.id)).payment_status).toBe("paid");
    expect((await receipts(s.conn.id))[0]).toMatchObject({ provider_event_id: "poll:CAPRET", outcome: "processed" });
    // The checkout is finished, so a second visit to the return page asks PayPal for nothing and records nothing.
    const calls = s.fake.calls.length;
    expect(await completeApprovedCheckout(s.a.reference, s.order, { ip: null })).toEqual({ ok: true });
    expect(s.fake.calls.length).toBe(calls);
    expect(await paymentsOf(s.inv.id)).toHaveLength(1);
    // The delivery PayPal sends for the same capture is the same payment.
    s.fake.on((r) => r.method === "GET" && r.path === `/v2/checkout/orders/${s.order}`, order(s, "COMPLETED", [{ id: "CAPRET", status: "COMPLETED" }]));
    const delivered = await paypalDeliver(s.conn, paypalCaptureCompleted({ orderId: s.order, reference: s.a.reference, amount: s.a.amountMinor, captureId: "CAPRET" }));
    expect(delivered.status).toBe(200);
    expect(await paymentsOf(s.inv.id)).toHaveLength(1);
    expect((await invoiceNow(s.inv.id)).paid_minor).toBe("150000");
  });

  it("names the checkout PayPal says was approved, and that must be the one this product stored for the reference", async () => {
    const s = await setup();
    expect(await completeApprovedCheckout(s.a.reference, "SOMEOTHERORDER1", { ip: null })).toEqual({ ok: false, reason: "invalid" });
    expect(await completeApprovedCheckout("CP-doesnotexistdoesnotexist", s.order, { ip: null })).toEqual({ ok: false, reason: "invalid" });
    expect(s.fake.calls).toHaveLength(0);
    expect(await paymentsOf(s.inv.id)).toEqual([]);
  });

  it("counts nothing when PayPal declines, only holds the capture as pending, or cannot be reached, and leaves the checkout open for the notification or the scheduled check", async () => {
    const s = await setup();
    s.fake.on((r) => r.method === "GET" && r.path === `/v2/checkout/orders/${s.order}`, order(s, "APPROVED"));
    s.fake.on((r) => r.method === "POST" && r.path === capturePath(s), { status: 422, json: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "INSTRUMENT_DECLINED" }] } });
    expect(await completeApprovedCheckout(s.a.reference, s.order, { ip: null })).toEqual({ ok: false, reason: "try_again" });
    s.fake.on((r) => r.method === "POST" && r.path === capturePath(s), { ...order(s, "COMPLETED", [{ id: "CAPPEND", status: "PENDING" }]), status: 201 });
    expect(await completeApprovedCheckout(s.a.reference, s.order, { ip: null })).toEqual({ ok: true });
    s.fake.throwNext(new ProviderCallError("unreachable", "PayPal could not be reached."));
    expect(await completeApprovedCheckout(s.a.reference, s.order, { ip: null })).toEqual({ ok: false, reason: "try_again" });
    expect(await paymentsOf(s.inv.id)).toEqual([]);
    expect((await invoiceNow(s.inv.id)).payment_status).toBe("unpaid");
    expect((await attemptNow(s.a.id)).status).toBe("redirected");
  });

  it("does nothing for a disconnected account or while the environment's calls switch is off", async () => {
    const s = await setup();
    s.fake.on((r) => r.method === "GET" && r.path === `/v2/checkout/orders/${s.order}`, order(s, "APPROVED"));
    delete process.env.CUSTOMER_PAYMENTS_WRITES_ENABLED;
    resetEnvCache();
    try {
      expect(await completeApprovedCheckout(s.a.reference, s.order, { ip: null })).toEqual({ ok: false, reason: "unavailable" });
    } finally {
      process.env.CUSTOMER_PAYMENTS_WRITES_ENABLED = "true";
      resetEnvCache();
    }
    await withSystem((db) => db.query("update customer_payment_connections set status = 'revoked', credentials = null where id = $1", [s.conn.id]));
    expect(await completeApprovedCheckout(s.a.reference, s.order, { ip: null })).toEqual({ ok: false, reason: "unavailable" });
    expect(s.fake.calls).toHaveLength(0);
  });

  it("is rate limited by the caller's address before any lookup is made", async () => {
    const s = await setup();
    const seen = new Set<string>();
    for (let i = 0; i < 60 && !seen.has("rate_limited"); i += 1) {
      const r = await completeApprovedCheckout("CP-doesnotexistdoesnotexist", s.order, { ip: "203.0.113.77" });
      seen.add(r.ok ? "ok" : r.reason);
    }
    expect([...seen].sort()).toEqual(["invalid", "rate_limited"]);
    expect(f.calls).toHaveLength(0);
  });
});

describe("PayPal: through the real route", () => {
  beforeAll(() => {
    process.env.CUSTOMER_PAYMENTS_WRITES_ENABLED = "true";
    resetEnvCache();
  });
  afterAll(() => {
    setAdapterForTests("paypal", null);
    delete process.env.CUSTOMER_PAYMENTS_WRITES_ENABLED;
    resetEnvCache();
  });

  it("hands PayPal's five headers and the exact body to the handler, so a genuine delivery is recorded and a tampered one is the same bare 403 as any stranger's", async () => {
    const { POST } = await import("@/app/api/webhooks/customer-payments/[provider]/[key]/route");
    const io = await invoiceOrg();
    const inv = (await issuedInvoice(io, { isTest: true })).invoice;
    const conn = await connect(io, { provider: "paypal" });
    const fake = fakePaypal(conn.webhookSecret);
    setAdapterForTests("paypal", createPaypalProvider({ http: fake.http }));
    const order = `ORD${uid()}${uid()}`.toUpperCase();
    const a = await attempt(inv.id, conn, { checkoutId: order });
    fake.on((r) => r.method === "GET" && r.path === `/v2/checkout/orders/${order}`, { status: 200, json: paypalOrder({ orderId: order, reference: a.reference, status: "COMPLETED", amount: a.amountMinor, captures: [{ id: "CAPROUTE", status: "COMPLETED" }] }) });
    const body = paypalCaptureCompleted({ orderId: order, reference: a.reference, amount: a.amountMinor, captureId: "CAPROUTE" });
    const sign = (raw: string) => {
      const id = `tx-${uid()}${uid()}`;
      return { "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": PAYPAL_CERT_URL, "paypal-transmission-id": id, "paypal-transmission-sig": paypalSignatureFor(conn.webhookSecret, id, raw), "paypal-transmission-time": new Date().toISOString() };
    };
    const post = (raw: string, headers: Record<string, string>) =>
      POST(new Request(`http://localhost:3000/api/webhooks/customer-payments/paypal/${conn.publicKey}`, { method: "POST", body: raw, headers }), { params: Promise.resolve({ provider: "paypal", key: conn.publicKey }) });

    const forged = await post(`${body} `, sign(body));
    expect(forged.status).toBe(403);
    expect(await forged.json()).toEqual({ error: "forbidden" });
    expect(await paymentsOf(inv.id)).toEqual([]);
    const genuine = await post(body, sign(body));
    expect(genuine.status).toBe(200);
    expect(await genuine.json()).toEqual({ received: true, outcome: "processed" });
    expect(genuine.headers.get("cache-control")).toBe("no-store");
    expect(await paymentsOf(inv.id)).toEqual([expect.objectContaining({ status: "succeeded", provider_payment_id: "CAPROUTE" })]);
    expect((await invoiceNow(inv.id)).payment_status).toBe("paid");
  });
});

describe("PayPal: a delivery while the environment's calls switch is off", () => {
  afterAll(() => {
    setAdapterForTests("paypal", null);
    delete process.env.CUSTOMER_PAYMENTS_WRITES_ENABLED;
    resetEnvCache();
  });

  it("is turned away with a 503 and a retry time before PayPal is asked anything, stores nothing, and is recorded by the scheduled check once the switch is on", async () => {
    delete process.env.CUSTOMER_PAYMENTS_WRITES_ENABLED;
    resetEnvCache();
    const { POST } = await import("@/app/api/webhooks/customer-payments/[provider]/[key]/route");
    const io = await invoiceOrg();
    const inv = (await issuedInvoice(io, { isTest: true })).invoice;
    const conn = await connect(io, { provider: "paypal" });
    const fake = fakePaypal(conn.webhookSecret);
    setAdapterForTests("paypal", createPaypalProvider({ http: fake.http }));
    const order = `ORD${uid()}${uid()}`.toUpperCase();
    // A checkout the customer opened three quarters of an hour ago and paid; PayPal's notice of it is what arrives while the switch is off.
    const a = await attempt(inv.id, conn, { checkoutId: order, ageMinutes: 45 });
    const body = paypalCaptureCompleted({ orderId: order, reference: a.reference, amount: a.amountMinor, captureId: "CAPSWITCH" });
    const sign = (raw: string) => {
      const id = `tx-${uid()}${uid()}`;
      return { "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": PAYPAL_CERT_URL, "paypal-transmission-id": id, "paypal-transmission-sig": paypalSignatureFor(conn.webhookSecret, id, raw), "paypal-transmission-time": new Date().toISOString() };
    };
    const post = (raw: string, headers: Record<string, string>, key = conn.publicKey) =>
      POST(new Request(`http://localhost:3000/api/webhooks/customer-payments/paypal/${key}`, { method: "POST", body: raw, headers }), { params: Promise.resolve({ provider: "paypal", key }) });

    const off = await post(body, sign(body));
    expect(off.status).toBe(503);
    expect(off.headers.get("retry-after")).toBe(String(SWITCHED_OFF_RETRY_SECONDS));
    expect(await off.json()).toEqual({ received: false, error: "unavailable" });
    // Not even the token call: no real provider is called while the switch is off. Nothing was stored, and the connection did not hear anything either.
    expect(fake.calls).toEqual([]);
    expect(await receipts(conn.id)).toEqual([]);
    expect(await paymentsOf(inv.id)).toEqual([]);
    expect((await q<{ last_event_at: string | null }>("select last_event_at from customer_payment_connections where id = $1", [conn.id]))[0].last_event_at).toBeNull();
    // Every address gets the same answer, so it says nothing about which connections exist; a forged body is no different, and PayMongo's local check is not touched by it.
    expect((await post(body, sign(body), "cpk_zzzzzzzzzzzzzzzzzzzz")).status).toBe(503);
    expect((await post(`${body} `, sign(body))).status).toBe(503);
    expect(fake.calls).toEqual([]);
    const mongo = await connect(io, { provider: "paymongo" });
    const local = await POST(new Request(`http://localhost:3000/api/webhooks/customer-payments/paymongo/${mongo.publicKey}`, { method: "POST", body: "{}" }), { params: Promise.resolve({ provider: "paymongo", key: mongo.publicKey }) });
    expect(local.status).toBe(403);

    // The switch is on again: nothing was lost, because the scheduled check reads the open checkout back from PayPal and records the payment through the same receipt path.
    process.env.CUSTOMER_PAYMENTS_WRITES_ENABLED = "true";
    resetEnvCache();
    fake.on((r) => r.method === "GET" && r.path === `/v2/checkout/orders/${order}`, { status: 200, json: paypalOrder({ orderId: order, reference: a.reference, status: "COMPLETED", amount: a.amountMinor, captures: [{ id: "CAPSWITCH", status: "COMPLETED" }] }) });
    await withSystem(async (db) => {
      await db.query("update customer_payment_attempts set status = 'cancelled' where status in ('created', 'redirected') and id <> $1", [a.id]);
      await db.query("update customer_payment_events set outcome = 'ignored' where outcome in ('received', 'error', 'deferred')");
      await db.query("update customer_payment_connections set last_checked_at = now() where last_checked_at is null or last_checked_at < now() - interval '24 hours'");
    });
    const report = await runCustomerPaymentReconcileDetailed({ now: new Date(Date.now() + 60_000) });
    expect(report.recordedFromPoll).toBeGreaterThanOrEqual(1);
    expect(await paymentsOf(inv.id)).toEqual([expect.objectContaining({ status: "succeeded", provider_payment_id: "CAPSWITCH", verification: "provider_confirmed" })]);
    expect((await invoiceNow(inv.id)).payment_status).toBe("paid");
    // And PayPal's own retry of the notice, now that the switch is on, finds it already recorded.
    expect(await paypalDeliver(conn, body)).toMatchObject({ status: 200, outcome: "processed" });
    expect(await paymentsOf(inv.id)).toHaveLength(1);
  });
});
