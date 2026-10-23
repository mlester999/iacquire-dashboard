// The two provider adapters against a replaced network layer and hand-written fixtures. Nothing here contacts PayMongo, and the PayMongo bodies were written from the
// documentation as remembered, not recorded from PayMongo: these tests prove the adapter does what it says with those bodies, not that PayMongo sends them.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPaymongoProvider, paymongoHttp, CHECKOUT_PATH } from "@/server/customer-payments/providers/paymongo";
import { SIGNATURE_HEADER, signSimulatedBody, simulatedBody, simulatedPlatform, simulatedProvider } from "@/server/customer-payments/providers/simulated";
import { providerFor } from "@/server/customer-payments/providers";
import { ProviderCallError } from "@/server/customer-payments/providers/types";
import { newReference } from "@/server/customer-payments/ids";
import { fakePaymongo, paymongoFailed, paymongoOther, paymongoPaid, paymongoRefundUpdated, paymongoSignature } from "./support/customer-payments";

const KEY = "sk_test_AbCdEfGh90abcdef";
const SECRET = "whsk_0123456789abcdef01234567";
const creds = { apiKey: KEY, webhookSecret: SECRET };
const headers = (sig: string | null) => ({ get: (n: string) => (n.toLowerCase() === "paymongo-signature" ? sig : null) });
const REF = newReference();
const URLS = { successUrl: "https://app.example/pay/return/x", cancelUrl: "https://app.example/pay/return/x?result=cancelled" };
const input = { reference: REF, amountMinor: 150000, currency: "PHP" as const, description: "Invoice INV-0001", ...URLS };

describe("PayMongo: checking a delivery's signature", () => {
  const pm = createPaymongoProvider({ http: fakePaymongo().http });
  const body = paymongoPaid({ checkoutId: "cs_1", reference: REF, amount: 150000 });
  const now = Date.now();

  it("accepts a delivery signed with the connection's own secret and reports the mode the signature carries", () => {
    expect(pm.verifyWebhook({ rawBody: body, headers: headers(paymongoSignature(body, SECRET)), secret: SECRET, now })).toEqual({ ok: true, livemode: false });
    expect(pm.verifyWebhook({ rawBody: body, headers: headers(paymongoSignature(body, SECRET, { live: true })), secret: SECRET, now })).toEqual({ ok: true, livemode: true });
  });

  it("refuses a changed body, another secret, a stale timestamp, a missing or malformed header, and a signature claiming both modes", () => {
    const sig = paymongoSignature(body, SECRET);
    expect(pm.verifyWebhook({ rawBody: `${body} `, headers: headers(sig), secret: SECRET, now })).toMatchObject({ ok: false, reason: "mismatch" });
    expect(pm.verifyWebhook({ rawBody: body, headers: headers(paymongoSignature(body, "whsk_another_secret_entirely")), secret: SECRET, now })).toMatchObject({ ok: false, reason: "mismatch" });
    expect(pm.verifyWebhook({ rawBody: body, headers: headers(paymongoSignature(body, SECRET, { t: Math.floor(now / 1000) - 2 * 86_400 })), secret: SECRET, now })).toMatchObject({ ok: false, reason: "stale" });
    expect(pm.verifyWebhook({ rawBody: body, headers: headers(null), secret: SECRET, now })).toMatchObject({ ok: false, reason: "missing" });
    expect(pm.verifyWebhook({ rawBody: body, headers: headers("nonsense"), secret: SECRET, now })).toMatchObject({ ok: false, reason: "malformed" });
    const t = Math.floor(now / 1000);
    expect(pm.verifyWebhook({ rawBody: body, headers: headers(`t=${t},te=${"a".repeat(64)},li=${"b".repeat(64)}`), secret: SECRET, now })).toMatchObject({ ok: false });
  });
});

describe("PayMongo: reading a delivery into facts", () => {
  const pm = createPaymongoProvider({ http: fakePaymongo().http });
  const parse = (b: string) => pm.parseEvent(b)?.event ?? null;

  it("reads a paid checkout as a payment with its reference, checkout, payment id, amount, currency, fee and method", () => {
    const e = parse(paymongoPaid({ eventId: "evt_abc123", checkoutId: "cs_9", reference: REF, amount: 150000, paymentId: "pay_9", fee: 600, source: "gcash" }));
    expect(e).toMatchObject({ kind: "payment.succeeded", eventId: "evt_abc123", livemode: false, checkoutId: "cs_9", reference: REF, paymentId: "pay_9", amountMinor: 150000, currency: "PHP", feeMinor: 600, method: "gcash" });
    expect(parse(paymongoPaid({ checkoutId: "cs_9", reference: REF, amount: 150000, livemode: true }))?.livemode).toBe(true);
  });

  it("does not read a checkout that holds no single paid payment as money (a later check of the checkout records each one)", () => {
    const none = JSON.parse(paymongoPaid({ checkoutId: "cs_1", reference: REF, amount: 1000 }));
    none.data.attributes.data.attributes.payments[0].attributes.status = "pending";
    expect(parse(JSON.stringify(none))).toMatchObject({ kind: "ignored", reason: expect.stringMatching(/exactly one paid payment/) });
    const two = JSON.parse(paymongoPaid({ checkoutId: "cs_1", reference: REF, amount: 1000 }));
    two.data.attributes.data.attributes.payments.push(two.data.attributes.data.attributes.payments[0]);
    expect(parse(JSON.stringify(two))?.kind).toBe("ignored");
  });

  it("finds our reference in a failed payment wherever it was left, and none in the business's other sales", () => {
    expect(parse(paymongoFailed({ paymentId: "pay_f", reference: REF }))).toMatchObject({ kind: "payment.failed", paymentId: "pay_f", reference: REF, amountMinor: 150000, currency: "PHP", reason: "Card declined" });
    const viaExternal = JSON.parse(paymongoFailed({ reference: null }));
    viaExternal.data.attributes.data.attributes.external_reference_number = REF;
    expect(parse(JSON.stringify(viaExternal))?.reference).toBe(REF);
    expect(parse(paymongoFailed({ reference: null }))?.reference).toBeNull();
  });

  it("reads refunds, and acts only on one that succeeded", () => {
    expect(parse(paymongoRefundUpdated({ refundId: "ref_1", paymentId: "pay_1", amount: 5000, reason: "requested_by_customer" }))).toMatchObject({ kind: "refund.succeeded", refundId: "ref_1", paymentId: "pay_1", amountMinor: 5000, currency: "PHP" });
    expect(parse(paymongoRefundUpdated({ paymentId: "pay_1", amount: 5000, status: "failed" }))?.kind).toBe("refund.failed");
    expect(parse(paymongoRefundUpdated({ paymentId: "pay_1", amount: 5000, status: "pending" }))?.kind).toBe("refund.pending");
    expect(parse(paymongoRefundUpdated({ paymentId: "pay_1", amount: 5000, status: "weird" }))?.kind).toBe("ignored");
    const onPayment = JSON.stringify({
      data: { id: "evt_pr", type: "event", attributes: { type: "payment.refunded", livemode: false, data: { id: "pay_1", type: "payment", attributes: { currency: "PHP", refunds: [
        { id: "ref_old", attributes: { amount: 1000, status: "succeeded", created_at: 100 } }, { id: "ref_new", attributes: { amount: 2000, status: "succeeded", created_at: 200, reason: "duplicate" } },
      ] } } } },
    });
    expect(parse(onPayment)).toMatchObject({ kind: "refund.succeeded", paymentId: "pay_1", refundId: "ref_new", amountMinor: 2000, reason: "duplicate" });
  });

  it("ignores a type it does not use, and returns nothing for what is not an event", () => {
    expect(parse(paymongoOther("source.chargeable"))).toMatchObject({ kind: "ignored", reason: "Event type is not used." });
    expect(parse(paymongoOther("payment.paid"))?.kind).toBe("ignored");
    expect(pm.parseEvent("not json")).toBeNull();
    expect(pm.parseEvent("{}")).toBeNull();
    expect(pm.parseEvent(JSON.stringify({ data: { id: "x" } }))).toBeNull();
  });
});

describe("PayMongo: starting a checkout", () => {
  const answer = (id = "cs_new", url = "https://checkout.paymongo.com/cs_new_client_abc") => ({ status: 200, json: { data: { id, attributes: { checkout_url: url } } } });

  it("asks for exactly the amount, once, with our reference, no customer details and no emailed receipt, and returns the checkout and its address", async () => {
    const f = fakePaymongo();
    f.on((r) => r.method === "POST", answer());
    const r = await createPaymongoProvider({ http: f.http }).createCheckout(creds, input);
    expect(r).toEqual({ checkoutId: "cs_new", checkoutUrl: "https://checkout.paymongo.com/cs_new_client_abc" });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ method: "POST", path: CHECKOUT_PATH, apiKey: KEY });
    const a = (f.calls[0].body as { data: { attributes: Record<string, unknown> } }).data.attributes;
    expect(a).toMatchObject({ line_items: [{ amount: 150000, currency: "PHP", quantity: 1, name: "Invoice INV-0001" }], reference_number: REF, send_email_receipt: false, metadata: { reference: REF }, payment_method_types: ["card"], success_url: URLS.successUrl, cancel_url: URLS.cancelUrl, description: "Invoice INV-0001" });
    expect(Object.keys(a).sort()).toEqual(["cancel_url", "description", "line_items", "metadata", "payment_method_types", "reference_number", "send_email_receipt", "success_url"]);
    expect(CHECKOUT_PATH).toBe("/v1/checkout_sessions");
  });

  it("offers the payment methods the owner chose", async () => {
    const f = fakePaymongo();
    f.on(() => true, answer());
    await createPaymongoProvider({ http: f.http }).createCheckout({ ...creds, settings: { paymentMethods: ["gcash", "paymaya"] } }, input);
    expect((f.calls[0].body as { data: { attributes: { payment_method_types: string[] } } }).data.attributes.payment_method_types).toEqual(["gcash", "paymaya"]);
  });

  it("never hands a customer an address that is not on PayMongo's own domain", async () => {
    for (const url of ["https://evil.example/cs_new", "http://checkout.paymongo.com/cs_new", "https://paymongo.com.evil.example/x", "javascript:alert(1)", "not a url"]) {
      const f = fakePaymongo();
      f.on(() => true, answer("cs_new", url));
      await expect(createPaymongoProvider({ http: f.http }).createCheckout(creds, input), url).rejects.toMatchObject({ name: "ProviderCallError", kind: "invalid_response" });
    }
    const f = fakePaymongo();
    f.on(() => true, answer("cs_new", "https://pm.link/abc"));
    await expect(createPaymongoProvider({ http: f.http }).createCheckout(creds, input)).rejects.toThrow(/did not point to PayMongo/);
  });

  it("turns each kind of failure into a sentence a person can act on, without the key, a URL or a body in it", async () => {
    const cases: Array<[Parameters<ReturnType<typeof fakePaymongo>["on"]>[1], string, RegExp]> = [
      [{ status: 401, json: { errors: [{ code: "authentication_failed" }] } }, "rejected", /did not accept this key/],
      [{ status: 403, json: null }, "rejected", /did not accept this key/],
      [{ status: 429, json: null }, "unreachable", /busy or having trouble/],
      [{ status: 503, json: null }, "unreachable", /busy or having trouble/],
      [{ status: 400, json: { errors: [{ code: "parameter_below_minimum", detail: "amount must be at least 2000 see https://developers.paymongo.com/x using sk_test_AbCdEfGh90abcdef" }] } }, "rejected", /parameter_below_minimum.*amount must be at least 2000/],
      [{ status: 200, json: { data: {} } }, "invalid_response", /unexpected answer/],
      [{ status: 200, json: null }, "invalid_response", /unexpected answer/],
    ];
    for (const [answerWith, kind, words] of cases) {
      const f = fakePaymongo();
      f.on(() => true, answerWith);
      const err = await createPaymongoProvider({ http: f.http }).createCheckout(creds, input).catch((e: unknown) => e);
      expect(err, JSON.stringify(answerWith)).toBeInstanceOf(ProviderCallError);
      expect((err as ProviderCallError).kind).toBe(kind);
      expect((err as ProviderCallError).message).toMatch(words);
      expect((err as ProviderCallError).message).not.toContain(KEY);
      expect((err as ProviderCallError).message).not.toMatch(/https?:\/\//);
    }
    const f = fakePaymongo();
    f.throwNext(new ProviderCallError("unreachable", "PayMongo could not be reached, or took too long to answer."));
    await expect(createPaymongoProvider({ http: f.http }).createCheckout(creds, input)).rejects.toMatchObject({ kind: "unreachable" });
  });
});

describe("PayMongo: the authenticated read-back and the check of a key", () => {
  it("reads a checkout with the payments made through it, and says expired, open or paid", async () => {
    const f = fakePaymongo();
    const body = (status: string, payments: unknown[]) => ({ status: 200, json: { data: { id: "cs_1", attributes: { status, reference_number: REF, payments } } } });
    const pay = (id: string, status: string, amount = 150000) => ({ id, type: "payment", attributes: { amount, fee: 100, currency: "PHP", status, livemode: false } });
    const pm = createPaymongoProvider({ http: f.http });
    f.on(() => true, body("active", [pay("pay_1", "paid"), pay("pay_2", "failed", 5)]));
    expect(await pm.fetchCheckout!(creds, "cs_1")).toEqual({
      checkoutId: "cs_1", reference: REF, status: "paid",
      payments: [{ id: "pay_1", status: "paid", amountMinor: 150000, currency: "PHP", feeMinor: 100, livemode: false }, { id: "pay_2", status: "failed", amountMinor: 5, currency: "PHP", feeMinor: 100, livemode: false }],
    });
    f.on(() => true, body("expired", []));
    expect((await pm.fetchCheckout!(creds, "cs_1"))?.status).toBe("expired");
    f.on(() => true, body("active", []));
    expect((await pm.fetchCheckout!(creds, "cs_1"))?.status).toBe("open");
    expect(f.calls.every((c) => c.method === "GET" && c.path === `${CHECKOUT_PATH}/cs_1`)).toBe(true);
  });

  it("returns nothing for a checkout PayMongo does not know, refuses an answer about another checkout, and never builds a path from odd text", async () => {
    const f = fakePaymongo();
    const pm = createPaymongoProvider({ http: f.http });
    expect(await pm.fetchCheckout!(creds, "cs_unknown")).toBeNull();
    f.on(() => true, { status: 200, json: { data: { id: "cs_other", attributes: { status: "active", payments: [] } } } });
    await expect(pm.fetchCheckout!(creds, "cs_1")).rejects.toMatchObject({ kind: "invalid_response" });
    const before = f.calls.length;
    for (const bad of ["../x", "a/b", "cs 1", "", "@evil.example", "x".repeat(200)]) expect(await pm.fetchCheckout!(creds, bad), bad).toBeNull();
    expect(f.calls).toHaveLength(before);
  });

  it("proves a key with a read-only call, and notes whether a webhook for this connection's address exists", async () => {
    const f = fakePaymongo();
    const pm = createPaymongoProvider({ http: f.http });
    const url = "https://app.example/api/webhooks/customer-payments/paymongo/cpk_abcdefghij0123456789";
    f.on(() => true, { status: 200, json: { data: [{ attributes: { url, status: "enabled" } }] } });
    expect(await pm.verifyCredentials(creds, { webhookUrl: url })).toEqual({ ok: true, accountLabel: null, webhookFound: true });
    f.on(() => true, { status: 200, json: { data: [{ attributes: { url: "https://other.example/hook", status: "enabled" } }] } });
    expect(await pm.verifyCredentials(creds, { webhookUrl: url })).toMatchObject({ ok: true, webhookFound: false });
    f.on(() => true, { status: 200, json: { data: [{ attributes: { url, status: "disabled" } }] } });
    expect(await pm.verifyCredentials(creds, { webhookUrl: url })).toMatchObject({ ok: true, webhookFound: false });
    f.on(() => true, { status: 200, json: {} });
    expect(await pm.verifyCredentials(creds, { webhookUrl: url })).toMatchObject({ ok: true, webhookFound: null });
    expect(f.calls.every((c) => c.method === "GET" && c.path === "/v1/webhooks")).toBe(true);
    f.on(() => true, { status: 401, json: { errors: [{ code: "authentication_failed" }] } });
    const rejected = await pm.verifyCredentials(creds, { webhookUrl: url });
    expect(rejected).toMatchObject({ ok: false, reason: "rejected" });
    expect(JSON.stringify(rejected)).not.toContain(KEY);
    f.on(() => true, { status: 502, json: null });
    expect(await pm.verifyCredentials(creds, { webhookUrl: url })).toMatchObject({ ok: false, reason: "unreachable" });
    f.throwNext(new Error("socket hang up"));
    expect(await pm.verifyCredentials(creds, { webhookUrl: url })).toMatchObject({ ok: false, reason: "unreachable" });
  });
});

describe("PayMongo: the real network layer", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("calls PayMongo's own origin only, with the key in a header and never in the address, and does not follow a redirect", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const r = await paymongoHttp({ method: "GET", path: "/v1/webhooks", apiKey: KEY });
    expect(r).toEqual({ status: 200, json: { data: [] } });
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("https://api.paymongo.com/v1/webhooks");
    expect(String(url)).not.toContain(KEY);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from(`${KEY}:`).toString("base64")}`);
    expect(init.redirect).toBe("error");
    // A path that would change the host is refused before anything is sent.
    fetchSpy.mockClear();
    await expect(paymongoHttp({ method: "GET", path: "@evil.example/x", apiKey: KEY })).rejects.toMatchObject({ name: "ProviderCallError", kind: "unreachable" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("says unreachable when the network fails, and reads a non-JSON answer as nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET"); }));
    await expect(paymongoHttp({ method: "GET", path: "/v1/webhooks", apiKey: KEY })).rejects.toMatchObject({ kind: "unreachable", message: expect.not.stringContaining(KEY) });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 502 })));
    expect(await paymongoHttp({ method: "GET", path: "/v1/webhooks", apiKey: KEY })).toEqual({ status: 502, json: null });
  });
});

describe("the simulated provider", () => {
  const secret = "simulated-secret-0123456789abcdef";
  const now = Date.now();
  const verify = (body: string, sig: string | null) => simulatedProvider.verifyWebhook({ rawBody: body, headers: { get: (n: string) => (n === SIGNATURE_HEADER ? sig : null) }, secret, now });

  it("signs and checks a delivery the way a provider does", () => {
    const body = simulatedBody({ kind: "payment.succeeded", reference: REF, paymentId: "p1", amountMinor: 100, currency: "PHP", checkoutId: "simco_1" });
    expect(verify(body, signSimulatedBody(secret, body))).toEqual({ ok: true, livemode: null });
    expect(verify(`${body} `, signSimulatedBody(secret, body))).toMatchObject({ ok: false, reason: "mismatch" });
    expect(verify(body, signSimulatedBody("another-secret-entirely-0123456789", body))).toMatchObject({ ok: false, reason: "mismatch" });
    expect(verify(body, signSimulatedBody(secret, body, Math.floor(now / 1000) - 3600))).toMatchObject({ ok: false, reason: "stale" });
    expect(verify(body, null)).toMatchObject({ ok: false, reason: "missing" });
    expect(verify(body, "t=1,v1=zz")).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("reads back exactly the facts it was given, and nothing from a body that is not facts", () => {
    const body = simulatedBody({ kind: "refund.succeeded", paymentId: "p1", refundId: "r1", amountMinor: 50, currency: "PHP" });
    expect(simulatedProvider.parseEvent(body)?.event).toMatchObject({ kind: "refund.succeeded", paymentId: "p1", refundId: "r1", amountMinor: 50, currency: "PHP", livemode: false });
    expect(simulatedProvider.parseEvent("{}")).toBeNull();
    expect(simulatedProvider.parseEvent("nope")).toBeNull();
  });

  it("makes a checkout on an address that can never resolve, holds payments made there, and can be told to fail", async () => {
    simulatedPlatform.reset();
    const c = await simulatedProvider.createCheckout({ apiKey: "sim_x", webhookSecret: secret }, input);
    expect(c.checkoutUrl).toMatch(/^https:\/\/simulated-checkout\.invalid\//);
    expect(simulatedPlatform.checkout(c.checkoutId)).toMatchObject({ reference: REF, amountMinor: 150000, status: "open" });
    const paid = simulatedPlatform.pay(c.checkoutId, secret);
    expect(verify(paid.rawBody, paid.signature)).toMatchObject({ ok: true });
    expect(await simulatedProvider.fetchCheckout!({ apiKey: "sim_x", webhookSecret: secret }, c.checkoutId)).toMatchObject({ status: "paid", reference: REF, payments: [{ id: paid.paymentId, status: "paid", amountMinor: 150000 }] });
    expect(await simulatedProvider.fetchCheckout!({ apiKey: "sim_x", webhookSecret: secret }, "simco_none")).toBeNull();
    simulatedPlatform.failNext("create", new ProviderCallError("rejected", "No."));
    await expect(simulatedProvider.createCheckout({ apiKey: "sim_x", webhookSecret: secret }, input)).rejects.toThrow("No.");
    await expect(simulatedProvider.createCheckout({ apiKey: "sim_x", webhookSecret: secret }, input)).resolves.toBeTruthy();
    expect(await simulatedProvider.verifyCredentials({ apiKey: "wrong", webhookSecret: null }, { webhookUrl: "x" })).toMatchObject({ ok: false, reason: "rejected" });
  });

  it("is what the registry returns outside production, PayPal is honestly absent, and PayMongo is the real adapter", () => {
    expect(providerFor("simulated")).toBe(simulatedProvider);
    expect(providerFor("paymongo").id).toBe("paymongo");
    expect(providerFor("paymongo").contractVerified).toBe(false);
    expect(() => providerFor("paypal")).toThrow(/PayPal is not available in this release/);
  });
});
