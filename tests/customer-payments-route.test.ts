// The webhook route itself: what a provider's HTTP request gets back. There is no session; the delivery is trusted only by its signature. Embedded Postgres; no provider.
import { afterEach, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { MAX_BODY_BYTES } from "@/server/customer-payments/webhooks";
import { POST, GET } from "@/app/api/webhooks/customer-payments/[provider]/[key]/route";
import { invoiceOrg, issuedInvoice } from "./support/invoices";
import { attempt, connect, paymentsOf, paymongoPaid, paymongoSignature, receipts, type TestConnection } from "./support/customer-payments";

const state = vi.hoisted(() => ({ fail: false }));
vi.mock("@/server/customer-payments/webhooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/customer-payments/webhooks")>();
  return {
    ...actual,
    handleCustomerPaymentWebhook: (...args: Parameters<typeof actual.handleCustomerPaymentWebhook>) => {
      if (state.fail) throw new Error("boom with a secret sk_test_AbCdEfGh90abcdef in it");
      return actual.handleCustomerPaymentWebhook(...args);
    },
  };
});
afterEach(() => {
  state.fail = false;
  vi.restoreAllMocks();
});

async function setup() {
  const io = await invoiceOrg();
  const inv = (await issuedInvoice(io, { isTest: true })).invoice;
  const conn = await connect(io);
  const a = await attempt(inv.id, conn);
  return { io, inv, conn, a };
}
const url = (c: Pick<TestConnection, "provider" | "publicKey">) => `http://localhost:3000/api/webhooks/customer-payments/${c.provider}/${c.publicKey}`;
const post = (c: TestConnection, body: BodyInit | null, headers: Record<string, string> = {}, over: { provider?: string; key?: string } = {}, init: Record<string, unknown> = {}) =>
  POST(new Request(url(c), { method: "POST", body, headers, ...init }), { params: Promise.resolve({ provider: over.provider ?? c.provider, key: over.key ?? c.publicKey }) });

describe("what the provider gets back", () => {
  it("answers a genuine delivery 200 with its outcome, never cached, and a repeat as a duplicate", async () => {
    const s = await setup();
    const body = paymongoPaid({ checkoutId: s.a.checkoutId!, reference: s.a.reference, amount: s.a.amountMinor, eventId: "evt_route_1" });
    const headers = { "paymongo-signature": paymongoSignature(body, s.conn.webhookSecret) };
    const res = await post(s.conn, body, headers);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.json()).toEqual({ received: true, outcome: "processed" });
    expect((await post(s.conn, body, headers)).status).toBe(200);
    expect(await paymentsOf(s.inv.id)).toHaveLength(1);
    expect((await receipts(s.conn.id))).toHaveLength(1);
  });

  it("answers the same bare 403 for a wrong signature, an unknown key and a key of the wrong provider, with no session and no cookie", async () => {
    const s = await setup();
    const body = paymongoPaid({ checkoutId: s.a.checkoutId!, reference: s.a.reference, amount: s.a.amountMinor });
    const good = paymongoSignature(body, s.conn.webhookSecret);
    const answers = await Promise.all([
      post(s.conn, body, { "paymongo-signature": paymongoSignature(body, "whsk_another_secret_0000000") }),
      post(s.conn, body, { "paymongo-signature": good }, { key: "cpk_zzzzzzzzzzzzzzzzzzzz" }),
      post(s.conn, body, { "paymongo-signature": good }, { provider: "simulated" }),
      post(s.conn, body, {}),
    ]);
    for (const r of answers) {
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: "forbidden" });
      expect(r.headers.get("set-cookie")).toBeNull();
    }
    expect(await paymentsOf(s.inv.id)).toEqual([]);
    expect(await receipts(s.conn.id)).toEqual([]);
  });

  it("refuses a body that says it is too large without reading it, and one that turns out to be, however it arrives", async () => {
    const s = await setup();
    const small = "{}";
    const declared = await post(s.conn, small, { "content-length": String(MAX_BODY_BYTES + 1) });
    expect(declared.status).toBe(413);
    expect(await declared.json()).toEqual({ received: false });
    // A body with no length at all, streamed past the limit: the route stops reading and answers 413.
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024).fill(120);
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { pulled += 1; controller.enqueue(chunk); } });
    const streamed = await post(s.conn, stream, {}, {}, { duplex: "half" });
    expect(streamed.status).toBe(413);
    expect(pulled).toBeLessThan(10);
    // Exactly at the limit is fine to read (and is then refused as not authentic, not as too large).
    const at = await post(s.conn, "x".repeat(MAX_BODY_BYTES), {});
    expect(at.status).toBe(403);
    expect(await receipts(s.conn.id)).toEqual([]);
  });

  it("only takes POST", async () => {
    const res = await GET();
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("limits by the sender's address as the proxy reports it, using the first address in the list, and keeps only a fingerprint of it", async () => {
    const s = await setup();
    await post(s.conn, "{}", { "x-forwarded-for": "198.51.100.77, 10.0.0.1" });
    const buckets = (await withSystem((db) => db.query<{ bucket_key: string }>("select bucket_key from rate_limit_buckets where bucket_key like 'customer-payments:webhook:ip:%'"))).rows.map((r) => r.bucket_key);
    expect(buckets.length).toBeGreaterThanOrEqual(1);
    for (const key of buckets) {
      expect(key).not.toContain("198.51.100.77");
      expect(key).not.toContain("10.0.0.1");
    }
  });

  it("answers 500 when something fails before the delivery could be recorded, and logs nothing about it", async () => {
    const s = await setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.fail = true;
    const res = await post(s.conn, "{}", {});
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ received: false });
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/boom|sk_test|secret/);
  });
});
