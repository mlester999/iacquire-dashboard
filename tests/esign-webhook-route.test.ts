// The webhook route a signing service posts to: only POST, a body read as bytes and abandoned the moment it is too large, the handler's answer passed on with headers that keep it
// out of caches and search, and a failure that says nothing. Embedded Postgres for the one case that goes all the way through; the stand-in service signs the notice.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ throwIt: false }));
vi.mock("@/server/esign/webhook", async (original) => {
  const real = await original<typeof import("@/server/esign/webhook")>();
  return { ...real, handleEsignWebhook: (...a: Parameters<typeof real.handleEsignWebhook>) => (hooks.throwIt ? Promise.reject(new Error("db password is hunter2")) : real.handleEsignWebhook(...a)) };
});

import { GET, POST } from "@/app/api/webhooks/esign/[connectionToken]/route";
import { withSystem } from "@/server/db";
import { hashIp } from "@/server/security/crypto";
import { RATE_LIMITS } from "@/server/security/rate-limit";
import { MAX_BODY_BYTES } from "@/server/esign/webhook";
import { simulatedEsign } from "@/server/esign/providers/simulated";
import { connectionKeys, freshIp, handedOver, requestRow, signingOrg } from "./support/proposals";

beforeEach(() => {
  simulatedEsign.reset();
  hooks.throwIt = false;
});
afterEach(() => vi.restoreAllMocks());

const params = (connectionToken: string) => ({ params: Promise.resolve({ connectionToken }) });
const url = (token: string) => `https://app.example.test/api/webhooks/esign/${token}`;
const TOKEN = "A".repeat(43);

describe("the route", () => {
  it("answers only POST, and says so", async () => {
    const r = await GET();
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("POST");
    expect(await r.json()).toEqual({ error: "method_not_allowed" });
  });

  it("sends every answer with headers that keep it out of caches, referrers, search and sniffing", async () => {
    const r = await POST(new Request(url(TOKEN), { method: "POST", body: "{}", headers: { "x-forwarded-for": freshIp() } }), params(TOKEN));
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ received: false, reason: "not_found" });
    expect(Object.fromEntries(["cache-control", "referrer-policy", "x-robots-tag", "x-content-type-options"].map((h) => [h, r.headers.get(h)]))).toEqual({
      "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow", "x-content-type-options": "nosniff",
    });
  });

  it("refuses a body that says it is too large without reading it, and one that turns out too large whatever it said, and does not look the address up for either", async () => {
    const declared = await POST(new Request(url(TOKEN), { method: "POST", body: "{}", headers: { "content-length": String(MAX_BODY_BYTES + 1) } }), params(TOKEN));
    expect(declared.status).toBe(413);
    expect(await declared.json()).toEqual({ received: false, reason: "too_large" });
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(c) { pulls += 1; c.enqueue(new Uint8Array(64 * 1024)); if (pulls > 100) c.close(); } });
    const streamed = await POST(new Request(url(TOKEN), { method: "POST", body: stream, duplex: "half" } as RequestInit), params(TOKEN));
    expect(streamed.status).toBe(413);
    // It stopped reading soon after the limit instead of taking everything offered.
    expect(pulls).toBeLessThan(10);
    const exactly = await POST(new Request(url(TOKEN), { method: "POST", body: new Uint8Array(MAX_BODY_BYTES), headers: { "x-forwarded-for": freshIp() } }), params(TOKEN));
    expect(exactly.status).toBe(404);
  });

  it("takes the caller's address from the first hop the proxy named, and keeps counting unknown addresses against it", async () => {
    const ip = freshIp();
    const call = () => POST(new Request(url(TOKEN), { method: "POST", body: "{}", headers: { "x-forwarded-for": `${ip}, 10.0.0.1` } }), params(TOKEN));
    expect((await call()).status).toBe(404);
    const viaReal = await POST(new Request(url(TOKEN), { method: "POST", body: "{}", headers: { "x-real-ip": ip } }), params(TOKEN));
    expect(viaReal.status).toBe(404);
  });

  it("carries a genuine, signed notice all the way through and passes the handler's answer on", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    const keys = await connectionKeys(p.org.id);
    simulatedEsign.signerAction(h.documentId, "view");
    const d = simulatedEsign.delivery(h.documentId, keys.creds.webhookKey);
    const headers = new Headers(d.headers);
    headers.set("x-forwarded-for", freshIp());
    const r = await POST(new Request(url(keys.token), { method: "POST", body: new Uint8Array(d.rawBody), headers }), params(keys.token));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ received: true, events: 1 });
    expect((await requestRow(h.requestId)).status).toBe("viewed");
  });

  it("tells a caller that knocked too often when to come back", async () => {
    const ip = freshIp();
    await withSystem((db) => db.query("insert into rate_limit_buckets (bucket_key, window_start, hits) values ($1, $2, $3)", [
      `${RATE_LIMITS.esignWebhookByIp.name}:${hashIp(ip)}`, new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString(), RATE_LIMITS.esignWebhookByIp.limit,
    ]));
    const r = await POST(new Request(url(TOKEN), { method: "POST", body: "{}", headers: { "x-forwarded-for": ip } }), params(TOKEN));
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("60");
    expect(await r.json()).toEqual({ received: false, reason: "rate_limited" });
  });

  it("answers a failure it could not handle with a bare server error (so the service tries again) and logs only that it happened", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    hooks.throwIt = true;
    const r = await POST(new Request(url(TOKEN), { method: "POST", body: "secret body {}" }), params(TOKEN));
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ received: false });
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/hunter2|secret body|AAAA/);
    expect(log).toHaveBeenCalledTimes(1);
  });
});
