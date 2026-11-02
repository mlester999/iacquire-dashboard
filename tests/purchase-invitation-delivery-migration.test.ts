// Migration 0119: purchase invitation delivery records and payment-provider connection checks. The tables, their protections (read-only to the application role, scoped to the one
// agency workspace, append-only checks, an invitation never in two agencies), the new timeline kind, and the rollback that refuses while a record exists and otherwise puts the schema
// back exactly. Each case that changes the schema runs in a transaction that is rolled back.
import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { withSystem, type Queryable } from "@/server/db";
import { createPurchaseIntent } from "@/server/purchase-intents/service";
import { agencyUser } from "./support/fixtures";
import { agencyOrgId, rows, staffPerson } from "./support/staff-messages";

class Done extends Error {}
const up = readFileSync("supabase/migrations/0119_purchase_invitation_delivery.sql", "utf8");
const down = readFileSync("supabase/rollbacks/0119_purchase_invitation_delivery.down.sql", "utf8");

/** Splits a script into statements, keeping `$$ ... $$` bodies whole (the test driver runs one statement per call). */
function statements(sql: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let inside = false;
  for (const raw of sql.split("\n")) {
    const line = raw.replace("\r", "");
    if (!inside && (line.trim() === "" || line.trim().startsWith("--"))) continue;
    cur.push(line);
    if (line.split("$$").length % 2 === 0) inside = !inside;
    if (!inside && line.trimEnd().endsWith(";")) {
      out.push(cur.join("\n"));
      cur = [];
    }
  }
  return out;
}
const run = async (db: Queryable, sql: string) => {
  for (const statement of statements(sql)) await db.query(statement);
};
async function inRolledBackTransaction(body: (db: Queryable) => Promise<void>) {
  await expect(withSystem(async (db) => {
    await body(db);
    throw new Done();
  })).rejects.toBeInstanceOf(Done);
}
const attempt = async (db: Queryable, sql: string, params: unknown[] = []) => {
  await db.query("savepoint attempt");
  try {
    await db.query(sql, params);
    await db.query("release savepoint attempt");
    return "allowed";
  } catch (error) {
    await db.query("rollback to savepoint attempt");
    return String((error as Error).message);
  }
};

async function intent() {
  const agency = await agencyOrgId();
  const person = await staffPerson("agency_super_admin");
  const made = await createPurchaseIntent(agencyUser(person, "agency_super_admin"), { buyerName: "Bailey Buyer", buyerEmail: `b-${crypto.randomUUID().slice(0, 8)}@example.test`, company: "Buyer Co", timezone: "America/Chicago" });
  return { agency, person, intentId: made.id };
}

const delivery = (over: Record<string, string | null> = {}) => ({
  kind: "invitation", status: "pending", reason: null, recipient: "bailey@example.test", provider: "resend", completed_at: null, idempotency_key: null, ...over,
});
const insertDelivery = (db: Queryable, intentId: string, agency: string, d: ReturnType<typeof delivery>) =>
  attempt(
    db,
    `insert into purchase_intent_deliveries (intent_id, agency_org_id, kind, status, reason, recipient, provider, idempotency_key, link_expires_at, completed_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, now() + interval '14 days', $9::timestamptz)`,
    [intentId, agency, d.kind, d.status, d.reason, d.recipient, d.provider, d.idempotency_key, d.completed_at],
  );

describe("0119 as applied", () => {
  it("enables row level security, gives the application role read access only, and scopes reads to the one agency workspace", async () => {
    for (const table of ["purchase_intent_deliveries", "payment_provider_checks"]) {
      const [flag] = await rows<{ relrowsecurity: boolean }>("select relrowsecurity from pg_class where relname = $1 and relnamespace = 'public'::regnamespace", [table]);
      expect(flag?.relrowsecurity, `${table} has RLS`).toBe(true);
      const grants = await rows<{ privilege_type: string }>("select privilege_type from information_schema.role_table_grants where grantee = 'iaq_app_user' and table_name = $1 order by 1", [table]);
      expect(grants.map((g) => g.privilege_type), `${table} grants`).toEqual(["SELECT"]);
      const policies = await rows<{ policyname: string; cmd: string }>("select policyname, cmd from pg_policies where tablename = $1", [table]);
      expect(policies.map((p) => p.cmd), `${table} policies`).toEqual(["SELECT"]);
    }
    const noBrowser = await rows<{ grantee: string }>("select grantee from information_schema.role_table_grants where table_name in ('purchase_intent_deliveries', 'payment_provider_checks') and grantee in ('anon', 'authenticated', 'public', 'iaq_site_runtime')");
    expect(noBrowser).toEqual([]);
  });

  it("accepts the delivery states the application writes and refuses the ones it must not", async () => {
    const { agency, intentId } = await intent();
    await inRolledBackTransaction(async (db) => {
      expect(await insertDelivery(db, intentId, agency, delivery())).toBe("allowed");
      expect(await insertDelivery(db, intentId, agency, delivery({ kind: "resend", status: "sent", completed_at: "2026-10-25T12:00:00Z" }))).toBe("allowed");
      expect(await insertDelivery(db, intentId, agency, delivery({ kind: "rotation", status: "manual", reason: "chosen", provider: "none", completed_at: "2026-10-25T12:00:00Z" }))).toBe("allowed");
      expect(await insertDelivery(db, intentId, agency, delivery({ status: "failed", reason: "provider_refused", completed_at: "2026-10-25T12:00:00Z" }))).toBe("allowed");
      // A pending delivery has no completion, and a settled one must have it.
      expect(await insertDelivery(db, intentId, agency, delivery({ status: "sent", completed_at: null }))).toMatch(/purchase_intent_deliveries_completed_check/);
      expect(await insertDelivery(db, intentId, agency, delivery({ status: "pending", completed_at: "2026-10-25T12:00:00Z" }))).toMatch(/purchase_intent_deliveries_completed_check/);
      // Manual and failed need a reason; the others must not have one.
      expect(await insertDelivery(db, intentId, agency, delivery({ status: "manual", reason: null, completed_at: "2026-10-25T12:00:00Z" }))).toMatch(/purchase_intent_deliveries_reason_required/);
      expect(await insertDelivery(db, intentId, agency, delivery({ status: "sent", reason: "chosen", completed_at: "2026-10-25T12:00:00Z" }))).toMatch(/purchase_intent_deliveries_reason_required/);
      // Words outside the fixed lists are refused.
      expect(await insertDelivery(db, intentId, agency, delivery({ status: "delivered-ish" }))).toMatch(/check/);
      expect(await insertDelivery(db, intentId, agency, delivery({ kind: "blast" }))).toMatch(/check/);
      expect(await insertDelivery(db, intentId, agency, delivery({ provider: "sendgrid" }))).toMatch(/check/);
      expect(await insertDelivery(db, intentId, agency, delivery({ idempotency_key: "short" }))).toMatch(/check/);
    });
  });

  it("makes a repeated idempotency key one delivery, and ties a delivery to its own purchase and the agency workspace", async () => {
    const { agency, intentId } = await intent();
    const other = await intent();
    const client = (await rows<{ id: string }>("select id from organizations where kind = 'client' limit 1"))[0];
    await inRolledBackTransaction(async (db) => {
      const key = crypto.randomUUID();
      expect(await insertDelivery(db, intentId, agency, delivery({ idempotency_key: key }))).toBe("allowed");
      expect(await insertDelivery(db, other.intentId, agency, delivery({ idempotency_key: key }))).toMatch(/purchase_intent_deliveries_idempotency/);
      expect(await insertDelivery(db, intentId, agency, delivery({ idempotency_key: crypto.randomUUID() }))).toBe("allowed");
      if (client) expect(await insertDelivery(db, intentId, client.id, delivery())).toMatch(/purchase_delivery_agency_mismatch|purchase_delivery_must_be_the_agency_workspace/);
    });
  });

  it("keeps connection checks append-only, and ties 'ok' to the one outcome that means verified", async () => {
    await inRolledBackTransaction(async (db) => {
      const ins = (outcome: string, ok: boolean, fp = "0123456789abcdef") => attempt(db, "insert into payment_provider_checks (provider, livemode, outcome, ok, fingerprint) values ('paymongo', false, $1, $2, $3)", [outcome, ok, fp]);
      expect(await ins("verified", true)).toBe("allowed");
      expect(await ins("webhook_not_registered", false)).toBe("allowed");
      expect(await ins("verified", false)).toMatch(/payment_provider_checks_ok_check/);
      expect(await ins("credentials_rejected", true)).toMatch(/payment_provider_checks_ok_check/);
      expect(await ins("verified", true, "not-a-fingerprint")).toMatch(/check/);
      expect(await attempt(db, "update payment_provider_checks set ok = false")).toMatch(/append-only/);
      expect(await attempt(db, "delete from payment_provider_checks")).toMatch(/append-only/);
      expect(await attempt(db, "insert into payment_provider_checks (provider, livemode, outcome, ok, fingerprint, facts) values ('paypal', false, 'verified', true, '0123456789abcdef', '[]'::jsonb)")).toMatch(/check/);
    });
  });

  it("lets the purchase timeline carry an invitation email entry", async () => {
    const { agency, intentId } = await intent();
    await inRolledBackTransaction(async (db) => {
      expect(await attempt(db, "insert into purchase_intent_events (intent_id, agency_org_id, kind) values ($1, $2, 'invitation_email')", [intentId, agency])).toBe("allowed");
      expect(await attempt(db, "insert into purchase_intent_events (intent_id, agency_org_id, kind) values ($1, $2, 'sent_by_pigeon')", [intentId, agency])).toMatch(/purchase_intent_events_kind_check/);
    });
  });
});

describe("the rollback", () => {
  it("refuses while a delivery, a check or an invitation email entry exists, and changes nothing", async () => {
    const { agency, intentId } = await intent();
    await inRolledBackTransaction(async (db) => {
      expect(await insertDelivery(db, intentId, agency, delivery())).toBe("allowed");
      expect(await attempt(db, "select 1")).toBe("allowed");
      await db.query("savepoint rb");
      await expect(run(db, down)).rejects.toThrow(/Rollback refused: purchase invitation deliveries exist/);
      await db.query("rollback to savepoint rb");
      await db.query("delete from purchase_intent_deliveries");
      await db.query("insert into payment_provider_checks (provider, livemode, outcome, ok, fingerprint) values ('paypal', false, 'verified', true, '0123456789abcdef')");
      await db.query("savepoint rb2");
      await expect(run(db, down)).rejects.toThrow(/Rollback refused: payment provider connection checks exist/);
      await db.query("rollback to savepoint rb2");
    });
    await inRolledBackTransaction(async (db) => {
      await db.query("insert into purchase_intent_events (intent_id, agency_org_id, kind) values ($1, $2, 'invitation_email')", [intentId, agency]);
      await expect(run(db, down)).rejects.toThrow(/Rollback refused: the purchase timeline holds invitation email entries/);
    });
  });

  it("removes exactly what 0119 added when nothing was recorded, and applies again cleanly", async () => {
    await inRolledBackTransaction(async (db) => {
      await db.query("delete from purchase_intent_deliveries");
      await run(db, down);
      const gone = await db.query<{ n: number }>("select count(*)::int as n from pg_class where relname in ('purchase_intent_deliveries', 'payment_provider_checks') and relnamespace = 'public'::regnamespace");
      expect(gone.rows[0].n).toBe(0);
      const fns = await db.query<{ n: number }>("select count(*)::int as n from pg_proc where proname in ('purchase_delivery_guard', 'payment_provider_checks_immutable')");
      expect(fns.rows[0].n).toBe(0);
      // 0103's own list of timeline kinds is back (no invitation_email).
      const agency = (await db.query<{ id: string }>("select id from organizations where kind = 'agency' limit 1")).rows[0].id;
      const anyIntent = (await db.query<{ id: string }>("select id from purchase_intents limit 1")).rows[0].id;
      expect(await attempt(db, "insert into purchase_intent_events (intent_id, agency_org_id, kind) values ($1, $2, 'invitation_email')", [anyIntent, agency])).toMatch(/purchase_intent_events_kind_check/);
      await run(db, up);
      const back = await db.query<{ n: number }>("select count(*)::int as n from pg_class where relname in ('purchase_intent_deliveries', 'payment_provider_checks') and relnamespace = 'public'::regnamespace");
      expect(back.rows[0].n).toBe(2);
      expect(await attempt(db, "insert into purchase_intent_events (intent_id, agency_org_id, kind) values ($1, $2, 'invitation_email')", [anyIntent, agency])).toBe("allowed");
    });
  });
});
