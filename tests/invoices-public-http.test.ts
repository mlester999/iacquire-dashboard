// The customer's invoice page over HTTP: the three endpoints, their headers, what they refuse before reading anything, and the proxy rules, with plain Request objects against
// embedded Postgres. The services behind them are covered in invoices-public.test.ts; this file is about what a browser can see and send.
import { NextRequest } from "next/server";
import { afterAll, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/server/env";
import { NO_STORE, handleCapture, handlePay, handleStatus, methodNotAllowed, sameSite } from "@/server/invoices/public-http";
import { POST as payRoute, GET as payGet } from "@/app/api/public/invoices/pay/route";
import { GET as statusRoute, POST as statusPost } from "@/app/api/public/invoices/status/route";
import { POST as captureRoute, GET as captureGet } from "@/app/api/public/invoices/capture/route";
import { simulatedPlatform } from "@/server/customer-payments/providers/simulated";
import { contactIn, freshIp, invoiceOrg, issuedInvoice, linkTokenOf, providerPayment } from "./support/invoices";
import { attempt, connect, q } from "./support/customer-payments";

const BASE = "http://localhost/api/public/invoices";
const req = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
  new Request(`${BASE}/${path}`, { method: init.method ?? "GET", headers: { "x-forwarded-for": freshIp(), "x-forwarded-host": "localhost", ...init.headers }, body: init.body });

async function setup() {
  const io = await invoiceOrg();
  const contactId = await contactIn(io, { email: "private.customer@example.test" });
  const inv = (await issuedInvoice(io, { contactId })).invoice;
  const conn = await connect(io, { provider: "simulated" });
  const token = await linkTokenOf(io, inv.id);
  return { io, inv, conn, token };
}
type S = Awaited<ReturnType<typeof setup>>;
const attempts = (invoiceId: string) => q<{ amount_minor: string; status: string }>("select amount_minor::text, status from customer_payment_attempts where invoice_id = $1 order by created_at", [invoiceId]);

afterAll(() => {
  simulatedPlatform.reset();
  resetEnvCache();
});

describe("every answer", () => {
  it("is never cached, never indexed and never passes the address on, whatever it says", async () => {
    const s = await setup();
    expect(NO_STORE).toEqual({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow", "X-Content-Type-Options": "nosniff" });
    const answers = [
      await handlePay(req("pay", { method: "POST", headers: { "x-invoice-token": s.token } })),
      await handlePay(req("pay", { method: "POST" })),
      await handleStatus(req("status", { headers: { "x-invoice-token": s.token } })),
      await handleStatus(req("status")),
      await handleCapture(req("capture", { method: "POST", body: "{}" })),
      await payGet(),
      await statusPost(),
      await captureGet(),
      methodNotAllowed("GET"),
    ];
    for (const res of answers) {
      for (const [name, value] of Object.entries(NO_STORE)) expect(res.headers.get(name), `${res.status} ${name}`).toBe(value);
    }
    simulatedPlatform.reset();
  });

  it("answers a verb an endpoint does not serve with 405 and the verb it does", async () => {
    expect((await payGet()).status).toBe(405);
    expect((await payGet()).headers.get("allow")).toBe("POST");
    expect((await statusPost()).status).toBe(405);
    expect((await statusPost()).headers.get("allow")).toBe("GET");
    expect((await captureGet()).status).toBe(405);
    expect((await captureGet()).headers.get("allow")).toBe("POST");
  });
});

describe("a request from another site", () => {
  it("is refused before anything is read or started: only a request from this very site may start a payment or ask for a capture", async () => {
    const s = await setup();
    expect(sameSite(new Request("http://localhost/x"))).toBe(true);
    expect(sameSite(new Request("http://localhost/x", { headers: { origin: "http://localhost", "x-forwarded-host": "localhost" } }))).toBe(true);
    expect(sameSite(new Request("http://localhost/x", { headers: { origin: "https://evil.example", "x-forwarded-host": "localhost" } }))).toBe(false);
    expect(sameSite(new Request("http://localhost/x", { headers: { origin: "null", "x-forwarded-host": "localhost" } }))).toBe(false);
    expect(sameSite(new Request("http://localhost/x", { headers: { origin: "http://localhost.evil.example", "x-forwarded-host": "localhost" } }))).toBe(false);
    for (const origin of ["https://evil.example", "null"]) {
      const pay = await handlePay(req("pay", { method: "POST", headers: { origin, "x-invoice-token": s.token } }));
      expect(pay.status, origin).toBe(403);
      const capture = await handleCapture(req("capture", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ reference: "CP-aaaaaaaaaaaaaaaaaaaa", checkoutId: "ORDER12345" }) }));
      expect(capture.status, origin).toBe(403);
    }
    expect(await attempts(s.inv.id)).toEqual([]);
    const same = await handlePay(req("pay", { method: "POST", headers: { origin: "http://localhost", "x-invoice-token": s.token } }));
    expect(same.status).toBe(200);
    simulatedPlatform.reset();
  });
});

describe("paying", () => {
  it("starts the checkout for the server's own balance, answers only with the address to go to, and ignores anything else the caller sends", async () => {
    const s = await setup();
    const res = await handlePay(req("pay", {
      method: "POST", headers: { "x-invoice-token": s.token, "content-type": "application/json" },
      // An amount, an invoice and a workspace the caller would like it to be: none of it is read.
      body: JSON.stringify({ amount: 1, amountMinor: 1, invoiceId: "00000000-0000-4000-8000-000000000000", orgId: s.io.orgId, currency: "USD" }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body)).toEqual(["url"]);
    expect(body.url).toMatch(/^\/dev\/simulated-checkout\//);
    expect(await attempts(s.inv.id)).toEqual([{ amount_minor: "150000", status: "redirected" }]);
    // The link in the address (a query string) is not a way to name it either.
    const viaQuery = await handlePay(new Request(`${BASE}/pay?token=${s.token}`, { method: "POST", headers: { "x-forwarded-for": freshIp() } }));
    expect(viaQuery.status).toBe(404);
    simulatedPlatform.reset();
  });

  it("answers a missing, malformed or unknown link with the same 404, and says each failure in plain words with the right status", async () => {
    const s = await setup();
    for (const token of [undefined, "", "short", "A".repeat(42), "A".repeat(44), "A".repeat(43), "!".repeat(43)]) {
      const res = await handlePay(req("pay", { method: "POST", headers: token === undefined ? {} : { "x-invoice-token": token } }));
      expect(res.status, String(token)).toBe(404);
      expect(await res.json(), String(token)).toMatchObject({ error: "invalid", message: expect.stringMatching(/This link is not valid/) });
    }
    // Paid: 409. No account to take it: 503.
    await providerPayment(s.io, s.inv.id, s.conn.id, 150000, { provider: "simulated", livemode: true });
    const paid = await handlePay(req("pay", { method: "POST", headers: { "x-invoice-token": s.token } }));
    expect(paid.status).toBe(409);
    expect(await paid.json()).toMatchObject({ error: "paid", message: "This invoice has already been paid." });
    const bare = await invoiceOrg();
    const inv = (await issuedInvoice(bare)).invoice;
    const none = await handlePay(req("pay", { method: "POST", headers: { "x-invoice-token": await linkTokenOf(bare, inv.id) } }));
    expect(none.status).toBe(503);
    expect(await none.json()).toMatchObject({ error: "unavailable" });
  });

  it("answers 429 with a time to wait once an address has asked too often", async () => {
    const ip = freshIp();
    let last: Response | null = null;
    for (let i = 0; i < 40; i += 1) {
      last = await handlePay(new Request(`${BASE}/pay`, { method: "POST", headers: { "x-forwarded-for": ip, "x-invoice-token": "A".repeat(43) } }));
      if (last.status === 429) break;
    }
    expect(last?.status).toBe(429);
    expect(last?.headers.get("retry-after")).toBe("300");
    expect(await last?.json()).toMatchObject({ error: "rate_limited" });
  });

  it("is reached through the route file with the same behaviour", async () => {
    const s = await setup();
    const res = await payRoute(req("pay", { method: "POST", headers: { "x-invoice-token": s.token } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ url: expect.stringMatching(/^\/dev\/simulated-checkout\//) });
    simulatedPlatform.reset();
  });
});

describe("where a payment stands", () => {
  async function started(s: S) {
    return attempt(s.inv.id, s.conn);
  }

  it("says 'received' for a checkout only when the database holds a payment for it, and asks nothing of the caller but the reference", async () => {
    const s = await setup();
    const a = await started(s);
    const ask = async () => handleStatus(req("status", { headers: { "x-payment-reference": a.reference } }));
    const before = await ask();
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({ state: "confirming", headline: "We are confirming your payment", detail: expect.stringMatching(/Please do not pay again/), polling: true, tone: "wait" });
    await providerPayment(s.io, s.inv.id, s.conn.id, 150000, { provider: "simulated", livemode: true, attemptId: a.id });
    const after = await (await ask()).json();
    expect(after).toMatchObject({ state: "received", polling: false, tone: "ok" });
  });

  it("answers by the invoice's link with the status the database holds, and says paid only when it is paid", async () => {
    const s = await setup();
    const ask = async () => (await handleStatus(req("status", { headers: { "x-invoice-token": s.token } }))).json();
    expect(await ask()).toEqual({ paymentStatus: "unpaid", balanceMinor: 150000, currency: "PHP", hasPendingPayment: false, banner: "pay_online" });
    await providerPayment(s.io, s.inv.id, s.conn.id, 50000, { provider: "simulated", livemode: true });
    expect(await ask()).toMatchObject({ paymentStatus: "partially_paid", balanceMinor: 100000, banner: "partly_paid" });
    await providerPayment(s.io, s.inv.id, s.conn.id, 100000, { provider: "simulated", livemode: true });
    expect(await ask()).toMatchObject({ paymentStatus: "paid", balanceMinor: 0, banner: "paid" });
    const text = JSON.stringify(await ask());
    for (const secret of ["private.customer", s.token, s.io.orgId, s.inv.id]) expect(text).not.toContain(secret);
  });

  it("answers nothing it could not have been asked: a made-up reference, a made-up link, or neither, are the same 404; the reference wins when both are given", async () => {
    const s = await setup();
    const a = await started(s);
    const unknown: Array<Record<string, string>> = [{}, { "x-payment-reference": "CP-nothingnothingnothingnothing" }, { "x-payment-reference": "nope" }, { "x-invoice-token": "A".repeat(43) }, { "x-invoice-token": "short" }];
    for (const headers of unknown) {
      const res = await handleStatus(req("status", { headers }));
      expect(res.status, JSON.stringify(headers)).toBe(404);
      expect(await res.json()).toEqual({ error: "invalid" });
    }
    const both = await handleStatus(req("status", { headers: { "x-payment-reference": a.reference, "x-invoice-token": s.token } }));
    expect(Object.keys(await both.json()).sort()).toEqual(["detail", "headline", "polling", "state", "tone"]);
    // The address cannot carry either one.
    const viaQuery = await handleStatus(new Request(`${BASE}/status?reference=${a.reference}&token=${s.token}`, { headers: { "x-forwarded-for": freshIp() } }));
    expect(viaQuery.status).toBe(404);
  });

  it("answers 429 with a time to wait once an address has asked too often, and the route file serves it", async () => {
    const ip = freshIp();
    let last: Response | null = null;
    for (let i = 0; i < 400; i += 1) {
      last = await statusRoute(new Request(`${BASE}/status`, { headers: { "x-forwarded-for": ip, "x-payment-reference": "CP-nothingnothingnothingnothing" } }));
      if (last.status === 429) break;
    }
    expect(last?.status).toBe(429);
    expect(last?.headers.get("retry-after")).toBe("60");
  });
});

describe("taking the payment a customer approved", () => {
  const body = (o: unknown) => JSON.stringify(o);
  const post = (o: unknown, headers: Record<string, string> = {}) => handleCapture(req("capture", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof o === "string" ? o : body(o) }));

  it("refuses a body that is not exactly a reference and a checkout id, before any lookup", async () => {
    const good = { reference: "CP-aaaaaaaaaaaaaaaaaaaa", checkoutId: "ORDER12345" };
    for (const bad of ["not json", "[]", "null", "42", body({ reference: good.reference }), body({ checkoutId: good.checkoutId }), body({ ...good, reference: "nope" }), body({ ...good, checkoutId: "../x" }), body({ ...good, checkoutId: "x".repeat(121) }), body({ reference: 5, checkoutId: 6 }), "x".repeat(5000)]) {
      const res = await post(bad);
      expect(res.status, bad.slice(0, 40)).toBe(400);
      expect(await res.json()).toEqual({ ok: false });
    }
  });

  it("answers 404 for a reference that is not ours, and 200 (nothing to do) for a checkout that is already finished; the route file serves it", async () => {
    const s = await setup();
    const a = await attempt(s.inv.id, s.conn, { status: "succeeded" });
    const unknown = await post({ reference: "CP-nothingnothingnothingnothing", checkoutId: "ORDER12345" });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ ok: false, reason: "invalid" });
    const wrongOrder = await post({ reference: a.reference, checkoutId: "ORDERNOTOURS1" });
    expect(wrongOrder.status).toBe(404);
    const done = await post({ reference: a.reference, checkoutId: a.checkoutId });
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ ok: true });
    const viaRoute = await captureRoute(req("capture", { method: "POST", headers: { "content-type": "application/json" }, body: body({ reference: a.reference, checkoutId: a.checkoutId }) }));
    expect(viaRoute.status).toBe(200);
  });
});

describe("the proxy", () => {
  it("serves the invoice page, the page a provider sends the customer back to and the three endpoints without a sign-in, and never lets them be cached, indexed or passed on", async () => {
    const { proxy } = await import("@/proxy");
    const token = "T".repeat(43);
    for (const path of [`/pay/${token}`, "/pay/return/CP-aaaaaaaaaaaaaaaaaaaa", "/api/public/invoices/pay", "/api/public/invoices/status", "/api/public/invoices/capture"]) {
      const res = await proxy(new NextRequest(`http://localhost${path}`));
      expect(res.status, path).toBe(200);
      expect(res.headers.get("location"), path).toBeNull();
      expect(res.headers.get("cache-control"), path).toBe("no-store");
      expect(res.headers.get("x-robots-tag"), path).toBe("noindex, nofollow");
      expect(res.headers.get("referrer-policy"), path).toBe("no-referrer");
      expect(res.headers.get("content-security-policy"), path).toContain("form-action 'self'");
      expect(res.headers.get("content-security-policy"), path).toContain("frame-ancestors 'none'");
      expect(res.headers.get("content-security-policy"), path).toContain("object-src 'none'");
    }
    // The team's own screens, the payment account's settings and the testing checkout's neighbours still need a sign-in.
    for (const path of ["/invoices", "/invoices/settings", "/settings/payments"]) {
      const portal = await proxy(new NextRequest(`http://localhost${path}`));
      expect(portal.status, path).toBe(307);
      expect(portal.headers.get("location"), path).toContain("/login");
    }
  });

  it("lets a provider reach the webhook without a sign-in (the delivery is trusted by its signature alone)", async () => {
    const { proxy } = await import("@/proxy");
    const res = await proxy(new NextRequest("http://localhost/api/webhooks/customer-payments/paypal/cpk_aaaaaaaaaaaaaaaaaaaa", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });
});
