import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { agencyUser } from "./support/fixtures";
import { agencyOrgId, rows, splitStatements, staffPerson } from "./support/staff-messages";
import { createPurchaseIntent, startPurchase } from "@/server/purchase-intents/service";
import { crmOrg } from "./support/crm";
import { planRow } from "./support/billing-plan";

// Migration 0103: the purchase checkout table (amount copied by the database, terms that never change, one open checkout per purchase), the intent's new evidence columns, the
// maintenance period columns on payments, and the commercial-record rollback guard. Each destructive probe runs inside a transaction that is always rolled back.

class Done extends Error {}
const down = readFileSync("supabase/rollbacks/0103_purchase_checkouts.down.sql", "utf8");
type Db = { query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[]; rowCount: number }> };
const runDown = async (db: Db) => {
  for (const stmt of splitStatements(down)) await db.query(stmt);
};
const rolledBack = (fn: (db: Db) => Promise<void>) =>
  withSystem(async (db) => {
    await fn(db);
    throw new Done();
  }).catch((e) => {
    if (!(e instanceof Done)) throw e;
  });

const NOW = new Date("2026-10-25T12:00:00Z");

/** A statement the database must refuse. A refusal aborts a transaction, so it runs inside a savepoint that is rolled back to, leaving the probe's transaction usable. */
async function refused(db: Db, run: () => Promise<unknown>, pattern?: RegExp) {
  await db.query("savepoint probe");
  try {
    await run();
  } catch (error) {
    await db.query("rollback to savepoint probe");
    if (pattern) expect(String(error instanceof Error ? error.message : error)).toMatch(pattern);
    return;
  }
  throw new Error("The database accepted a statement it must refuse.");
}

async function seedIntent() {
  const agencyId = await agencyOrgId();
  const superAdmin = await staffPerson("agency_super_admin");
  const created = await createPurchaseIntent(agencyUser(superAdmin, "agency_super_admin"), { buyerName: "Mig Buyer", buyerEmail: `mig-${crypto.randomUUID().slice(0, 8)}@example.test`, company: `Mig Co ${crypto.randomUUID().slice(0, 6)}`, timezone: "America/Chicago" }, { now: NOW });
  await startPurchase(created.token, { now: NOW });
  return { agencyId, created };
}

const insertCheckout = (db: Db, o: { intent: string; agency: string; reference: string; cents?: number; status?: string }) =>
  db.query(
    `insert into purchase_intent_checkouts (intent_id, agency_org_id, reference_number, usd_amount_cents, charged_currency, charged_amount_minor, livemode, expires_at, status, provider_checkout_id, checkout_url)
     values ($1, $2, $3, $4, 'PHP', 8694200, false, now() + interval '1 day', $5, $6, $7)`,
    [o.intent, o.agency, o.reference, o.cents ?? 149900, o.status ?? "pending", o.status === "creating" ? null : `cs_${o.reference}`, o.status === "creating" ? null : "https://checkout.paymongo.com/x"],
  );

describe("the purchase checkout schema", () => {
  it("allows one open checkout per purchase, takes the amount from the frozen fee, and keeps a paid checkout paid", async () => {
    const { agencyId, created } = await seedIntent();
    await rolledBack(async (db) => {
      await insertCheckout(db, { intent: created.id, agency: agencyId, reference: "IAQ-MIGTEST0001" });
      await refused(db, () => insertCheckout(db, { intent: created.id, agency: agencyId, reference: "IAQ-MIGTEST0002" }));
    });
    await rolledBack(async (db) => {
      await refused(db, () => insertCheckout(db, { intent: created.id, agency: agencyId, reference: "IAQ-MIGTEST0003", cents: 100 }), /frozen_setup_fee/);
    });
    await rolledBack(async (db) => {
      await insertCheckout(db, { intent: created.id, agency: agencyId, reference: "IAQ-MIGTEST0004" });
      await db.query("update purchase_intent_checkouts set status = 'paid', paid_at = now(), provider_payment_id = 'pay_mig' where reference_number = 'IAQ-MIGTEST0004'");
      await refused(db, () => db.query("update purchase_intent_checkouts set status = 'pending' where reference_number = 'IAQ-MIGTEST0004'"), /paid_is_final/);
      await db.query("update purchase_intent_checkouts set status = 'refunded' where reference_number = 'IAQ-MIGTEST0004'");
    });
  });

  it("requires provider evidence to name the checkout that produced it, and manual evidence to name none", async () => {
    const { agencyId, created } = await seedIntent();
    await rolledBack(async (db) => {
      await refused(db, () => db.query("update purchase_intents set payment_source = 'provider' where id = $1", [created.id]));
      await insertCheckout(db, { intent: created.id, agency: agencyId, reference: "IAQ-MIGTEST0005" });
      const checkout = (await db.query<{ id: string }>("select id from purchase_intent_checkouts where reference_number = 'IAQ-MIGTEST0005'")).rows[0].id;
      await refused(db, () => db.query("update purchase_intents set payment_checkout_id = $2 where id = $1", [created.id, checkout]));
    });
  });

  it("ties a maintenance period to a plan of the same workspace and says how many months it covers", async () => {
    const o = await crmOrg();
    const plan = await planRow(o, { status: "active" });
    const other = await crmOrg();
    await rolledBack(async (db) => {
      const base = `insert into payments (org_id, kind, status, description, usd_amount_micros, charged_currency, charged_amount_minor, livemode, reference_number, provider, maintenance_subscription_id, covers_months)
        values ($1, 'maintenance', 'pending', 'Plan', 299000000, 'PHP', 1734200, false, $2, 'paymongo', $3, $4)`;
      await db.query(base, [o.org.id, "IAQ-MIGPLAN0001", plan, 1]);
      await refused(db, () => db.query(base, [o.org.id, "IAQ-MIGPLAN0002", plan, 1])); // one open period payment per plan
      await refused(db, () => db.query(base, [o.org.id, "IAQ-MIGPLAN0003", plan, 13]));
      await refused(db, () => db.query(base, [o.org.id, "IAQ-MIGPLAN0004", plan, null])); // a plan without its months
      await refused(db, () => db.query(base, [other.org.id, "IAQ-MIGPLAN0005", plan, 1])); // another workspace's plan
    });
  });

  it("refuses the rollback while a checkout, an online-paid purchase or a maintenance period payment exists, and removes the schema when none does", async () => {
    const { agencyId, created } = await seedIntent();
    await rolledBack(async (db) => {
      await insertCheckout(db, { intent: created.id, agency: agencyId, reference: "IAQ-MIGTEST0006" });
      await refused(db, () => runDown(db), /Rollback refused: purchase checkouts exist/);
    });
    await rolledBack(async (db) => {
      await db.query("update purchase_intents set auto_provision = true where id = $1", [created.id]);
      await refused(db, () => runDown(db), /Rollback refused: a purchase intent/);
    });
    const o = await crmOrg();
    const plan = await planRow(o, { status: "active" });
    await rolledBack(async (db) => {
      await db.query(
        `insert into payments (org_id, kind, status, description, usd_amount_micros, charged_currency, charged_amount_minor, livemode, reference_number, provider, maintenance_subscription_id, covers_months)
         values ($1, 'maintenance', 'pending', 'Plan', 299000000, 'PHP', 1734200, false, 'IAQ-MIGPLAN0009', 'paymongo', $2, 1)`, [o.org.id, plan],
      );
      await refused(db, () => runDown(db), /Rollback refused: a payment names the maintenance plan period/);
    });
    // With nothing of this migration's in the way, the rollback drops its table and columns; the outer transaction then rolls everything back.
    await expect(withSystem(async (db) => {
      await runDown(db);
      const left = await db.query<{ relname: string }>("select relname from pg_class where relnamespace = 'public'::regnamespace and relname = 'purchase_intent_checkouts'");
      expect(left.rows).toEqual([]);
      const cols = await db.query<{ column_name: string }>("select column_name from information_schema.columns where table_name = 'purchase_intents' and column_name in ('auto_provision', 'payment_source', 'payment_hold')");
      expect(cols.rows).toEqual([]);
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
    expect((await rows("select 1 from purchase_intent_checkouts limit 1")).length).toBe(0);
    expect((await rows("select 1 from information_schema.columns where table_name = 'purchase_intents' and column_name = 'auto_provision'")).length).toBe(1);
  });
});
