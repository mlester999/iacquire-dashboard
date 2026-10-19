import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

const WEBHOOK_SECRET = "whsec_route_test_not_real";
const CRON = "cron-secret-for-route-tests-0123456789";
process.env.PAYMONGO_SECRET_KEY = "sk_test_routekey123";
process.env.PAYMONGO_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.CRON_SECRET = CRON;
process.env.SCHEDULER_ENABLED = "true";

import { resetEnvCache } from "@/server/env";
import { POST as webhook } from "@/app/api/webhooks/paymongo/route";
import { POST as tick, GET as tickGet } from "@/app/api/internal/tick/route";
import { withSystem } from "@/server/db";
import { createOrg } from "./support/fixtures";

beforeAll(() => resetEnvCache());

const signed = (body: string) => {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},te=${crypto.createHmac("sha256", WEBHOOK_SECRET).update(`${t}.${body}`).digest("hex")},li=`;
};
const request = (body: string, headers: Record<string, string>) => new Request("http://localhost/api/webhooks/paymongo", { method: "POST", body, headers });

describe("PayMongo webhook route", () => {
  const body = JSON.stringify({ data: { id: "evt_route_1", type: "event", attributes: { type: "source.chargeable", livemode: false, data: { id: "src_1", type: "source", attributes: {} } } } });

  it("acknowledges a correctly signed delivery using the raw body", async () => {
    const res = await webhook(request(body, { "paymongo-signature": signed(body) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, outcome: "ignored" });
  });

  it("rejects missing and invalid signatures with 401 and processes nothing", async () => {
    expect((await webhook(request(body, {}))).status).toBe(401);
    expect((await webhook(request(body, { "paymongo-signature": "t=1700000000,te=deadbeef,li=" }))).status).toBe(401);
    const { rows } = await withSystem((db) => db.query("select 1 from payment_webhook_events where provider_event_id = 'evt_route_1'"));
    // Only the single valid delivery above was recorded.
    expect(rows).toHaveLength(1);
  });

  it("rejects an oversized body before doing any work", async () => {
    const huge = "x".repeat(300_000);
    const res = await webhook(request(huge, { "paymongo-signature": signed(huge), "content-length": String(huge.length) }));
    expect(res.status).toBe(413);
  });

  it("stays reachable without a session (the signature is the authentication)", async () => {
    const res = await webhook(request(body, { "paymongo-signature": signed(body) }));
    expect(res.status).toBe(200);
  });
});

describe("worker tick route", () => {
  const call = (headers: Record<string, string>) => tick(new Request("http://localhost/api/internal/tick", { method: "POST", headers }));
  const callGet = (headers: Record<string, string>) => tickGet(new Request("http://localhost/api/internal/tick", { method: "GET", headers }));

  it("requires the shared secret", async () => {
    expect((await call({})).status).toBe(401);
    expect((await call({ authorization: "Bearer wrong-secret-value-wrong-secret" })).status).toBe(401);
    // Vercel Cron calls with GET; it is the same authenticated handler, never a cookie or query parameter.
    expect((await callGet({})).status).toBe(401);
  });

  it("runs the idempotent jobs when authorized", async () => {
    const org = await createOrg({ name: "Tick Co" });
    await withSystem(async (db) => {
      await db.query("insert into credit_accounts (org_id, balance_micros, reserved_micros) values ($1, 5000000, 2000000) on conflict (org_id) do update set balance_micros = 5000000, reserved_micros = 2000000", [org.id]);
      await db.query("insert into usage_reservations (org_id, purpose, estimated_micros, expires_at) values ($1, 'stale', 2000000, now() - interval '1 minute')", [org.id]);
      await db.query("insert into credit_ledger_entries (org_id, kind, delta_micros, balance_after_micros, reserved_after_micros) values ($1, 'adjustment', 5000000, 5000000, 0)", [org.id]);
      await db.query("insert into credit_ledger_entries (org_id, kind, reserved_delta_micros, balance_after_micros, reserved_after_micros) values ($1, 'reservation_held', 2000000, 5000000, 2000000)", [org.id]);
    });
    const res = await call({ authorization: `Bearer ${CRON}` });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ran: { expiredReservations: number } };
    expect(json.ran.expiredReservations).toBeGreaterThanOrEqual(1);
    const { rows } = await withSystem((db) => db.query<{ reserved_micros: string }>("select reserved_micros from credit_accounts where org_id = $1", [org.id]));
    expect(Number(rows[0].reserved_micros)).toBe(0);
  });

  it("stays off until SCHEDULER_ENABLED is explicitly true", async () => {
    const saved = process.env.SCHEDULER_ENABLED;
    process.env.SCHEDULER_ENABLED = "false";
    resetEnvCache();
    try {
      const res = await call({ authorization: `Bearer ${CRON}` });
      expect(res.status).toBe(503);
      expect((await res.json()) as { error: string }).toMatchObject({ error: expect.stringContaining("SCHEDULER_ENABLED") });
    } finally {
      process.env.SCHEDULER_ENABLED = saved;
      resetEnvCache();
    }
  });

  it("stays off when no secret is configured", async () => {
    const saved = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    resetEnvCache();
    try {
      expect((await call({ authorization: `Bearer ${CRON}` })).status).toBe(503);
    } finally {
      process.env.CRON_SECRET = saved;
      resetEnvCache();
    }
  });
});
