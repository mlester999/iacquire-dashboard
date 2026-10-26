import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { rows, splitStatements } from "./support/staff-messages";
import { crmOrg } from "./support/crm";
import { planRow } from "./support/billing-plan";

// Migration 0110: the automatic-payment agreement tables (no access for any signed-in role, one open agreement per plan, terms that never change, ended agreements that never come back),
// the payment link, the Super Admin's switch (off), and a rollback that refuses while an agreement can still charge a client. Each destructive probe runs inside a transaction that is
// always rolled back.

class Done extends Error {}
const down = readFileSync("supabase/rollbacks/0110_maintenance_agreements.down.sql", "utf8");
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

/** A statement the database must refuse. A refusal aborts a transaction, so it runs inside a savepoint that is rolled back to. */
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

let n = 0;
const ref = () => `IAQ-MIG${String(++n).padStart(6, "0")}`;

async function plan() {
  const o = await crmOrg();
  const id = await planRow(o, { status: "active", paidThroughOn: "2026-12-31" });
  return { org: o.org.id, plan: id };
}

const insertAgreement = (db: Db, o: { org: string; plan: string; status?: string; providerId?: string | null; reference?: string }) =>
  db.query<{ id: string }>(
    `insert into maintenance_agreements (org_id, subscription_id, reference_number, provider_agreement_id, status, livemode, amount_minor, currency)
     values ($1, $2, $3, $4, $5, false, 29900, 'USD') returning id`,
    [o.org, o.plan, o.reference ?? ref(), o.providerId === undefined ? (o.status && o.status !== "approval_pending" && o.status !== "abandoned" ? `I-${ref()}` : null) : o.providerId, o.status ?? "approval_pending"],
  );

describe("the agreement schema", () => {
  it("is invisible to every signed-in role: row-level security is on and nothing is granted", async () => {
    for (const table of ["maintenance_agreements", "maintenance_agreement_charges"]) {
      const [t] = await rows<{ rls: boolean }>("select relrowsecurity as rls from pg_class where oid = $1::regclass", [table]);
      expect(t.rls, table).toBe(true);
      for (const role of ["iaq_app_user", "iaq_site_runtime", "anon", "authenticated"]) {
        const r = await rows<{ ok: boolean }>("select exists (select 1 from pg_roles where rolname = $1) as ok", [role]);
        if (!r[0].ok) continue;
        for (const priv of ["select", "insert", "update", "delete"]) {
          const [g] = await rows<{ ok: boolean }>("select has_table_privilege($1, $2, $3) as ok", [role, table, priv]);
          expect(g.ok, `${role} ${priv} ${table}`).toBe(false);
        }
      }
    }
  });

  it("keeps the switch off, and the payment link nullable", async () => {
    const [s] = await rows<{ recurring_billing_enabled: boolean; recurring_billing_by: string | null }>("select recurring_billing_enabled, recurring_billing_by from agency_billing_settings limit 1");
    expect(s.recurring_billing_enabled).toBe(false);
    expect(s.recurring_billing_by).toBeNull();
    const [c] = await rows<{ is_nullable: string }>("select is_nullable from information_schema.columns where table_name = 'payments' and column_name = 'maintenance_agreement_id'");
    expect(c.is_nullable).toBe("YES");
  });

  it("allows one open agreement per plan, a provider id once, and only for an agreement PayPal knows", async () => {
    const p = await plan();
    const other = await plan();
    const third = await plan();
    await rolledBack(async (db) => {
      await insertAgreement(db, { ...p, status: "approval_pending" });
      await refused(db, () => insertAgreement(db, { ...p, status: "approval_pending" }), /duplicate key|maintenance_agreements_one_open/);
      // An approved or active agreement that PayPal never named is not a thing.
      await refused(db, () => insertAgreement(db, { ...other, status: "active", providerId: null }), /check constraint/);
      // The same provider id cannot be on two agreements.
      await insertAgreement(db, { ...other, status: "active", providerId: "I-SAMEID123" });
      await refused(db, () => insertAgreement(db, { ...third, status: "active", providerId: "I-SAMEID123" }), /duplicate key/);
      // Once the first has ended, the plan can have another.
      await db.query("update maintenance_agreements set status = 'abandoned' where subscription_id = $1", [p.plan]);
      await insertAgreement(db, { ...p, status: "approval_pending" });
    });
  });

  it("keeps the terms an agreement was opened with, sets the provider id once, and never revives an ended agreement", async () => {
    const p = await plan();
    await rolledBack(async (db) => {
      const id = (await insertAgreement(db, { ...p, status: "active", providerId: "I-TERMS12345" })).rows[0].id;
      for (const set of ["amount_minor = 1", "currency = 'PHP'", "livemode = true", "reference_number = 'IAQ-OTHER0000001'", "provider_agreement_id = 'I-CHANGED999'"]) {
        await refused(db, () => db.query(`update maintenance_agreements set ${set} where id = $1`, [id]), /never change|set once/);
      }
      await db.query("update maintenance_agreements set status = 'suspended' where id = $1", [id]);
      await db.query("update maintenance_agreements set status = 'active' where id = $1", [id]);
      await db.query("update maintenance_agreements set status = 'cancelled' where id = $1", [id]);
      await refused(db, () => db.query("update maintenance_agreements set status = 'active' where id = $1", [id]), /does not come back/);
      await refused(db, () => db.query("update maintenance_agreements set status = 'expired' where id = $1", [id]), /does not come back/);
    });
  });

  it("lets an abandoned attempt end by cancellation and no other way", async () => {
    const p = await plan();
    await rolledBack(async (db) => {
      const id = (await insertAgreement(db, { ...p, status: "approval_pending" })).rows[0].id;
      await db.query("update maintenance_agreements set status = 'abandoned' where id = $1", [id]);
      await refused(db, () => db.query("update maintenance_agreements set status = 'active', provider_agreement_id = 'I-LATE123456' where id = $1", [id]), /abandoned agreement does not come back/);
      await db.query("update maintenance_agreements set status = 'cancelled', provider_agreement_id = 'I-LATE123456' where id = $1", [id]);
    });
  });

  it("holds an agreement as a pair (hold and since) and a charge cannot name another workspace's agreement or payment", async () => {
    const a = await plan();
    const b = await plan();
    await rolledBack(async (db) => {
      const id = (await insertAgreement(db, { ...a, status: "active", providerId: "I-HOLDPAIR123" })).rows[0].id;
      await refused(db, () => db.query("update maintenance_agreements set hold = 'disputed' where id = $1", [id]), /check constraint/);
      await db.query("update maintenance_agreements set hold = 'disputed', hold_since = now() where id = $1", [id]);
      const payment = (await db.query<{ id: string }>(
        `insert into payments (org_id, kind, status, description, usd_amount_micros, charged_currency, charged_amount_minor, provider, livemode, reference_number, provider_payment_id, paid_at,
           maintenance_subscription_id, covers_months, maintenance_agreement_id)
         values ($1, 'maintenance', 'paid', 'Seed', 299000000, 'USD', 29900, 'paypal', false, $2, 'SALE-MIGPAY1', now(), $3, 1, $4) returning id`, [a.org, ref(), a.plan, id],
      )).rows[0].id;
      await db.query("insert into maintenance_agreement_charges (org_id, agreement_id, payment_id, provider_charge_id, amount_minor, currency, outcome, applied_at) values ($1, $2, $3, 'SALE-MIGPAY1', 29900, 'USD', 'applied', now())", [a.org, id, payment]);
      // A charge needs its payment unless it is a mismatch, and an applied charge says when.
      await refused(db, () => db.query("insert into maintenance_agreement_charges (org_id, agreement_id, provider_charge_id, outcome) values ($1, $2, 'SALE-NOPAY', 'held')", [a.org, id]), /check constraint/);
      await refused(db, () => db.query("insert into maintenance_agreement_charges (org_id, agreement_id, payment_id, provider_charge_id, outcome) values ($1, $2, $3, 'SALE-NOAT', 'applied')", [a.org, id, payment]), /check constraint/);
      await db.query("insert into maintenance_agreement_charges (org_id, agreement_id, provider_charge_id, amount_minor, currency, outcome) values ($1, $2, 'SALE-MISMATCH', 1, 'USD', 'mismatch')", [a.org, id]);
      // One row per provider charge.
      await refused(db, () => db.query("insert into maintenance_agreement_charges (org_id, agreement_id, provider_charge_id, amount_minor, currency, outcome) values ($1, $2, 'SALE-MISMATCH', 1, 'USD', 'mismatch')", [a.org, id]), /duplicate key/);
      // Another workspace's agreement or payment is out of reach, for a charge and for the payment's own link.
      await refused(db, () => db.query("insert into maintenance_agreement_charges (org_id, agreement_id, provider_charge_id, amount_minor, currency, outcome) values ($1, $2, 'SALE-CROSS', 1, 'USD', 'mismatch')", [b.org, id]), /foreign key/);
      await refused(db, () => db.query(
        `insert into payments (org_id, kind, status, description, usd_amount_micros, charged_currency, charged_amount_minor, provider, livemode, reference_number, provider_payment_id, paid_at,
           maintenance_subscription_id, covers_months, maintenance_agreement_id)
         values ($1, 'maintenance', 'paid', 'Cross', 299000000, 'USD', 29900, 'paypal', false, $2, 'SALE-MIGCROSS', now(), $3, 1, $4)`, [b.org, ref(), b.plan, id],
      ), /foreign key/);
    });
  });
});

describe("the rollback", () => {
  it("refuses while an agreement is open, whatever its status, so a subscription that can still charge is never left unrecorded", async () => {
    for (const status of ["approval_pending", "approved", "active", "suspended"]) {
      const p = await plan();
      await rolledBack(async (db) => {
        await insertAgreement(db, { ...p, status });
        await refused(db, () => runDown(db), /Rollback refused: an automatic payment agreement is still open/);
      });
    }
  });

  it("runs once every agreement has ended, drops both tables, the link and the switch, and keeps the payments that were made", async () => {
    const p = await plan();
    await rolledBack(async (db) => {
      const id = (await insertAgreement(db, { ...p, status: "active", providerId: "I-ROLLBACK123" })).rows[0].id;
      await db.query(
        `insert into payments (org_id, kind, status, description, usd_amount_micros, charged_currency, charged_amount_minor, provider, livemode, reference_number, provider_payment_id, paid_at,
           maintenance_subscription_id, covers_months, maintenance_agreement_id)
         values ($1, 'maintenance', 'paid', 'Seed', 299000000, 'USD', 29900, 'paypal', false, $2, 'SALE-ROLLBACK1', now(), $3, 1, $4)`, [p.org, ref(), p.plan, id],
      );
      await db.query("update maintenance_agreements set status = 'cancelled' where id = $1", [id]);
      await runDown(db);
      const gone = await db.query<{ t: string | null }>("select to_regclass('maintenance_agreements')::text as t");
      expect(gone.rows[0].t).toBeNull();
      expect((await db.query<{ t: string | null }>("select to_regclass('maintenance_agreement_charges')::text as t")).rows[0].t).toBeNull();
      expect((await db.query("select 1 from information_schema.columns where table_name = 'payments' and column_name = 'maintenance_agreement_id'")).rows).toHaveLength(0);
      expect((await db.query("select 1 from information_schema.columns where table_name = 'agency_billing_settings' and column_name = 'recurring_billing_enabled'")).rows).toHaveLength(0);
      // The money that arrived and the plan period it paid for stay.
      const kept = await db.query<{ status: string }>("select status from payments where provider_payment_id = 'SALE-ROLLBACK1'");
      expect(kept.rows[0]?.status).toBe("paid");
    });
  });
});
