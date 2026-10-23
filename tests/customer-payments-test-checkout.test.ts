// The testing checkout (what a customer sees instead of a provider's page when the business's connection is the simulated provider) and the owner's test payment. Neither
// exists in production, neither writes a payment itself, and both go through the real webhook route with a SIGNED event. Embedded Postgres; no provider is contacted.
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/server/env";

const mode = vi.hoisted(() => ({ nodeEnv: "test" as string }));
vi.mock("@/server/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/env")>();
  return { ...actual, env: () => ({ ...actual.env(), NODE_ENV: mode.nodeEnv }) };
});

import { startCheckout } from "@/server/customer-payments/attempts";
import { completeSimulatedCheckout, loadSimulatedAttempt, type Deliver } from "@/server/customer-payments/dev-checkout";
import { createPaymongoProvider } from "@/server/customer-payments/providers/paymongo";
import { setAdapterForTests } from "@/server/customer-payments/providers";
import { simulatedPlatform } from "@/server/customer-payments/providers/simulated";
import { listConnections } from "@/server/customer-payments/connections";
import { startTestPayment, testPaymentPossible } from "@/server/invoices/test-payment";
import { loadReturn } from "@/server/invoices/public";
import SimulatedCheckoutPage from "@/app/dev/simulated-checkout/[attemptId]/page";
import { POST as completeRoute } from "@/app/dev/simulated-checkout/[attemptId]/complete/route";
import { freshIp, invoiceOrg, issuedInvoice, rows } from "./support/invoices";
import { connect, deliver, fakePaymongo, invoiceNow, paymentsOf, paymongoPaid, q, receipts } from "./support/customer-payments";

afterEach(() => {
  mode.nodeEnv = "test";
  setAdapterForTests("paymongo", null);
  simulatedPlatform.reset();
});
afterAll(() => {
  delete process.env.CUSTOMER_PAYMENTS_WRITES_ENABLED;
  resetEnvCache();
});

/** An issued invoice, a simulated connection, and the customer's checkout started the way the pay page starts it. */
async function started() {
  simulatedPlatform.reset();
  const io = await invoiceOrg();
  const inv = (await issuedInvoice(io)).invoice;
  const conn = await connect(io, { provider: "simulated" });
  const r = await startCheckout({ orgId: io.orgId, invoiceId: inv.id, audience: "public" });
  return { io, inv, conn, attemptId: r.attemptId };
}
type S = Awaited<ReturnType<typeof started>>;
const NOT_FOUND = /404|NOT_FOUND/;

/** The real route, called in process, with what it was sent kept for the test to look at. */
function watching(): { deliver: Deliver; sent: Array<{ url: string; headers: Record<string, string>; body: string; status: number }> } {
  const sent: Array<{ url: string; headers: Record<string, string>; body: string; status: number }> = [];
  const real = vi.fn<Deliver>(async (url, init) => {
    const { deliverToRoute } = await import("@/server/customer-payments/dev-checkout");
    const out = await deliverToRoute(url, init);
    sent.push({ url, headers: init.headers, body: init.body, status: out.status });
    return out;
  });
  return { deliver: real, sent };
}

describe("the testing checkout", () => {
  it("knows the checkout of a simulated connection by its attempt, and nothing else: another provider's attempt, a malformed id and an unknown id are not found", async () => {
    const s = await started();
    expect(await loadSimulatedAttempt(s.attemptId)).toMatchObject({ attemptId: s.attemptId, amountMinor: 150000, currency: "PHP", status: "redirected", invoiceNumber: "INV-0001", publicKey: s.conn.publicKey });
    expect(await loadSimulatedAttempt("not-a-uuid")).toBeNull();
    expect(await loadSimulatedAttempt("00000000-0000-4000-8000-000000000000")).toBeNull();
    const other = await invoiceOrg();
    const inv = (await issuedInvoice(other)).invoice;
    const pm = await connect(other, { provider: "paymongo" });
    const [a] = await q<{ id: string }>("insert into customer_payment_attempts (org_id, invoice_id, connection_id, currency, amount_minor, reference, provider_checkout_id, status) values ($1, $2, $3, 'PHP', 150000, 'CP-aaaaaaaaaaaaaaaaaaaa', 'cs_x', 'redirected') returning id", [other.orgId, inv.id, pm.id]);
    expect(await loadSimulatedAttempt(a.id)).toBeNull();
  });

  it("pays as a test by posting a SIGNED event to the real webhook route, which counts it as a test-mode payment, and sends the customer to the page a provider would", async () => {
    const s = await started();
    const w = watching();
    const done = await completeSimulatedCheckout(s.attemptId, "pay", { origin: "http://localhost:3000", deliver: w.deliver });
    expect(done).toMatchObject({ cancelled: false, delivered: 200 });
    expect(done.reference).toMatch(/^CP-/);
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0].url).toBe(`http://localhost:3000/api/webhooks/customer-payments/simulated/${s.conn.publicKey}`);
    expect(w.sent[0].headers["x-simulated-signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    // The route authenticated it like any provider's delivery, and that is the only thing that made it a payment.
    expect(await receipts(s.conn.id)).toEqual([expect.objectContaining({ outcome: "processed" })]);
    expect(await paymentsOf(s.inv.id)).toEqual([expect.objectContaining({ status: "succeeded", amount_minor: "150000", livemode: false, verification: "provider_confirmed" })]);
    expect(await invoiceNow(s.inv.id)).toMatchObject({ payment_status: "paid", paid_minor: "150000" });
    const back = await loadReturn(done.reference, { ip: freshIp() });
    expect(back.state === "ok" && back.view.description.state).toBe("received");
    // Paying twice is refused: the checkout is closed.
    await expect(completeSimulatedCheckout(s.attemptId, "pay", { origin: "http://localhost:3000", deliver: w.deliver })).rejects.toThrow(/no longer open/);
    expect(w.sent).toHaveLength(1);
  });

  it("posts nothing when the customer cancels, as a customer closing a provider's page tells the provider nothing", async () => {
    const s = await started();
    const w = watching();
    const done = await completeSimulatedCheckout(s.attemptId, "cancel", { origin: "http://localhost:3000", deliver: w.deliver });
    expect(done).toMatchObject({ cancelled: true, delivered: null });
    expect(w.sent).toHaveLength(0);
    expect(await paymentsOf(s.inv.id)).toEqual([]);
    expect((await invoiceNow(s.inv.id)).payment_status).toBe("unpaid");
  });

  it("declines with a signed failure that leaves the invoice owed and the checkout open, and a notice for the team", async () => {
    const s = await started();
    const w = watching();
    const done = await completeSimulatedCheckout(s.attemptId, "decline", { origin: "http://localhost:3000", deliver: w.deliver });
    expect(done).toMatchObject({ cancelled: false, delivered: 200 });
    expect(await paymentsOf(s.inv.id)).toEqual([]);
    expect((await invoiceNow(s.inv.id)).payment_status).toBe("unpaid");
    expect(await q("select status from customer_payment_attempts where id = $1", [s.attemptId])).toEqual([{ status: "redirected" }]);
    expect((await rows<{ title: string }>("select title from notifications where org_id = $1 and kind = 'invoice_payment_failed'", [s.io.orgId])).length).toBeGreaterThan(0);
  });

  it("is refused for a closed checkout, an unknown one and any choice that is not offered, and is not available in production at all", async () => {
    const s = await started();
    await q("update customer_payment_attempts set status = 'cancelled' where id = $1", [s.attemptId]);
    await expect(completeSimulatedCheckout(s.attemptId, "pay", { origin: "http://localhost:3000" })).rejects.toThrow(/no longer open/);
    await expect(completeSimulatedCheckout("00000000-0000-4000-8000-000000000000", "pay", { origin: "http://localhost:3000" })).rejects.toThrow(/not found/);
    mode.nodeEnv = "production";
    await expect(completeSimulatedCheckout(s.attemptId, "cancel", { origin: "http://localhost:3000" })).rejects.toThrow(/not available in production/);
    expect(await loadSimulatedAttempt(s.attemptId)).toBeNull();
  });
});

describe("the testing checkout's page and button", () => {
  const form = (choice: string | null, headers: Record<string, string> = {}) => {
    const body = new FormData();
    if (choice !== null) body.set("choice", choice);
    return new Request("http://localhost/dev/simulated-checkout/x/complete", { method: "POST", body, headers: { "x-forwarded-host": "localhost", ...headers } });
  };
  const post = (s: S, choice: string | null, headers?: Record<string, string>) => completeRoute(form(choice, headers), { params: Promise.resolve({ attemptId: s.attemptId }) });

  it("says in words that it stands in for a provider's page and that no money moves, and offers exactly three choices to post back to itself", async () => {
    const s = await started();
    const html = renderToStaticMarkup(await SimulatedCheckoutPage({ params: Promise.resolve({ attemptId: s.attemptId }) }));
    expect(html).toContain("Testing checkout");
    expect(html).toContain("No card is asked for and no money moves");
    expect(html).toContain("INV-0001");
    expect(html).toMatch(/Pay .*1,500\.00/);
    expect(html.match(/<form /g)).toHaveLength(3);
    expect(html.match(new RegExp(`action="/dev/simulated-checkout/${s.attemptId}/complete"`, "g"))).toHaveLength(3);
    for (const choice of ["pay", "decline", "cancel"]) expect(html).toContain(`name="choice" value="${choice}"`);
    await q("update customer_payment_attempts set status = 'expired' where id = $1", [s.attemptId]);
    const closed = renderToStaticMarkup(await SimulatedCheckoutPage({ params: Promise.resolve({ attemptId: s.attemptId }) }));
    expect(closed).toMatch(/This checkout is closed \(expired\), so it cannot be paid/);
    expect(closed).not.toContain("<form");
  });

  it("is a 404 for an unknown checkout, and for everything in production", async () => {
    const s = await started();
    await expect(SimulatedCheckoutPage({ params: Promise.resolve({ attemptId: "00000000-0000-4000-8000-000000000000" }) })).rejects.toMatchObject({ digest: expect.stringMatching(NOT_FOUND) });
    mode.nodeEnv = "production";
    await expect(SimulatedCheckoutPage({ params: Promise.resolve({ attemptId: s.attemptId }) })).rejects.toMatchObject({ digest: expect.stringMatching(NOT_FOUND) });
    const res = await post(s, "pay");
    expect(res.status).toBe(404);
    expect(await paymentsOf(s.inv.id)).toEqual([]);
  });

  it("sends the customer back to the page a provider would, never cached, and refuses another site, an unknown choice and no choice", async () => {
    const s = await started();
    expect((await post(s, "pay", { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(s, "refund")).status).toBe(400);
    expect((await post(s, null)).status).toBe(400);
    expect(await paymentsOf(s.inv.id)).toEqual([]);
    const cancelled = await post(s, "cancel");
    expect(cancelled.status).toBe(303);
    expect(cancelled.headers.get("location")).toMatch(/^\/pay\/return\/CP-[A-Za-z0-9]+\?result=cancelled$/);
    expect(cancelled.headers.get("cache-control")).toBe("no-store");
    expect(cancelled.headers.get("referrer-policy")).toBe("no-referrer");
    const paid = await post(s, "pay");
    expect(paid.status).toBe(303);
    expect(paid.headers.get("location")).toMatch(/^\/pay\/return\/CP-[A-Za-z0-9]+$/);
    expect(await paymentsOf(s.inv.id)).toEqual([expect.objectContaining({ status: "succeeded" })]);
    // A second press says why it cannot happen.
    const again = await post(s, "pay");
    expect(again.status).toBe(409);
    expect(await again.text()).toMatch(/no longer open/);
  });
});

describe("the owner's test payment", () => {
  beforeAll(() => {
    process.env.CUSTOMER_PAYMENTS_WRITES_ENABLED = "true";
    resetEnvCache();
  });

  it("is the owner's alone, needs a connection in test mode, and does not touch a live account a customer may be using", async () => {
    const io = await invoiceOrg();
    const inv = (await issuedInvoice(io)).invoice;
    for (const who of ["manager", "sales", "viewer", "support", "member"] as const) {
      expect(await testPaymentPossible(io.ctx(who), "PHP"), who).toBe(false);
      await expect(startTestPayment(io.ctx(who), inv.id), who).rejects.toThrow(/Only the business owner can run a test payment/);
    }
    expect(await testPaymentPossible(io.ctx("owner"), "PHP")).toBe(false);
    await expect(startTestPayment(io.ctx("owner"), inv.id)).rejects.toThrow(/No payment account in test mode is connected/);
    await connect(io, { provider: "paymongo", mode: "live", liveConfirmed: true });
    expect(await testPaymentPossible(io.ctx("owner"), "PHP")).toBe(false);
    await expect(startTestPayment(io.ctx("owner"), inv.id)).rejects.toThrow(/No payment account in test mode is connected/);
    await expect(startTestPayment(io.ctx("owner"), "00000000-0000-4000-8000-000000000000")).rejects.toThrow(/was not found/);
    expect(await q("select 1 from customer_payment_attempts where org_id = $1", [io.orgId])).toEqual([]);
  });

  it("opens the provider's own page through the test account, audits it, and leaves a confirmed test payment that unlocks the owner's going live", async () => {
    simulatedPlatform.reset();
    const f = fakePaymongo();
    setAdapterForTests("paymongo", createPaymongoProvider({ http: f.http }));
    f.on((r) => r.method === "POST", { status: 200, json: { data: { id: "cs_test_1", attributes: { checkout_url: "https://checkout.paymongo.com/cs_test_1_client_abc" } } } });
    const io = await invoiceOrg();
    const inv = (await issuedInvoice(io)).invoice;
    const conn = await connect(io, { provider: "paymongo", mode: "test" });
    expect(await testPaymentPossible(io.ctx("owner"), "PHP")).toBe(true);
    expect(await testPaymentPossible(io.ctx("owner"), "USD")).toBe(false);
    const r = await startTestPayment(io.ctx("owner"), inv.id);
    expect(r).toEqual({ url: "https://checkout.paymongo.com/cs_test_1_client_abc", invoiceNumber: "INV-0001", amountMinor: 150000 });
    const audit = await rows<{ metadata: Record<string, unknown> }>("select metadata from audit_logs where org_id = $1 and action = 'payments.test_payment_started'", [io.orgId]);
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({ number: "INV-0001", provider: "paymongo", amount: "1500.00", currency: "PHP" });
    expect(JSON.stringify(audit)).not.toContain("checkout.paymongo.com");
    expect((await listConnections(io.ctx("owner")))[0].hasConfirmedTestPayment).toBe(false);
    // The provider confirms it in test mode: that is what a test payment is, and it is not live revenue.
    const [a] = await q<{ reference: string }>("select reference from customer_payment_attempts where invoice_id = $1", [inv.id]);
    // PayMongo's own record of the checkout, which the delivery is checked against.
    f.on((r) => r.method === "GET" && r.path === "/v1/checkout_sessions/cs_test_1", {
      status: 200, json: { data: { id: "cs_test_1", attributes: { status: "active", reference_number: a.reference, payments: [{ id: "pay_test_1", type: "payment", attributes: { amount: 150000, fee: 250, currency: "PHP", status: "paid", livemode: false } }] } } },
    });
    expect((await deliver(conn, paymongoPaid({ checkoutId: "cs_test_1", reference: a.reference, amount: 150000, paymentId: "pay_test_1" }))).outcome).toBe("processed");
    expect(await paymentsOf(inv.id)).toEqual([expect.objectContaining({ status: "succeeded", livemode: false })]);
    expect((await listConnections(io.ctx("owner")))[0].hasConfirmedTestPayment).toBe(true);
  });
});
