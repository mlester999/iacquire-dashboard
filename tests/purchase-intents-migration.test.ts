import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { agencyUser, createOrg } from "./support/fixtures";
import { agencyOrgId, asUser, rows, splitStatements, staffPerson } from "./support/staff-messages";
import { createPurchaseIntent } from "@/server/purchase-intents/service";

// Migration 0101: the schema, the select-only application role, the policy scoped to the one agency workspace, the append-only timeline and the commercial-record
// rollback guard. Each destructive probe runs inside a transaction that is always rolled back.

class Done extends Error {}
const down = readFileSync("supabase/rollbacks/0101_purchase_intents.down.sql", "utf8");
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

async function seed() {
  await agencyOrgId();
  const superAdmin = await staffPerson("agency_super_admin");
  const manager = await staffPerson("agency_manager");
  const staff = await staffPerson("agency_staff");
  const client = await staffPerson("none");
  const session = agencyUser(superAdmin, "agency_super_admin");
  const created = await createPurchaseIntent(session, {
    buyerName: "Migration Buyer",
    buyerEmail: `migration-${crypto.randomUUID().slice(0, 8)}@example.test`,
    company: `Migration Co ${crypto.randomUUID().slice(0, 6)}`,
    industry: "Home services",
    website: "",
    timezone: "UTC",
    maintenanceSelected: false,
  }, { now: NOW });
  return { superAdmin, manager, staff, client, session, created };
}

describe("the purchase intent schema is closed and the timeline is append-only", () => {
  it("enables RLS on both tables, gives no browser role a grant, and gives the application role select only", async () => {
    const meta = await rows<{ relname: string; rls: boolean; acl: string | null }>("select relname, relrowsecurity as rls, relacl::text as acl from pg_class where relnamespace = 'public'::regnamespace and relname = any($1::text[])", [["purchase_intents", "purchase_intent_events"]]);
    expect(meta).toHaveLength(2);
    for (const t of meta) {
      expect(t.rls, t.relname).toBe(true);
      for (const role of ["anon", "authenticated", "iaq_site_runtime"]) expect(t.acl ?? "", t.relname).not.toContain(`${role}=`);
    }
    const grants = await rows<{ t: string; read: boolean; write: boolean }>(
      `select t, has_table_privilege('iaq_app_user', format('public.%I', t), 'select') as read,
              has_table_privilege('iaq_app_user', format('public.%I', t), 'insert,update,delete,truncate') as write
         from unnest($1::text[]) t`, [["purchase_intents", "purchase_intent_events"]],
    );
    for (const g of grants) {
      expect(g.read, g.t).toBe(true);
      expect(g.write, g.t).toBe(false);
    }
    const policies = await rows<{ tablename: string; qual: string }>("select tablename, qual from pg_policies where tablename = any($1::text[])", [["purchase_intents", "purchase_intent_events"]]);
    expect(policies).toHaveLength(2);
    for (const p of policies) {
      expect(p.qual).toContain("agency_org_id");
      expect(p.qual).toContain("purchase_intents_allowed");
    }
    const acl = await rows<{ sig: string; grantees: string[] }>(
      `select p.oid::regprocedure::text as sig,
              (select coalesce(array_agg(coalesce(nullif(x.grantee, 0)::regrole::text, 'PUBLIC')), '{}') from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where x.privilege_type = 'EXECUTE') as grantees
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = 'purchase_intents_allowed'`,
    );
    expect(acl[0].grantees).toContain("iaq_app_user");
    for (const role of ["PUBLIC", "anon", "authenticated"]) expect(acl[0].grantees).not.toContain(role);
  });

  it("lets a manager read the agency's row, and gives a staff member or a client nothing", async () => {
    const { manager, staff, client, created } = await seed();
    const managerRows = await asUser<{ id: string }>(manager.id, "select id from purchase_intents");
    expect(managerRows.map((r) => r.id)).toContain(created.id);
    expect(await asUser(staff.id, "select id from purchase_intents")).toEqual([]);
    expect(await asUser(client.id, "select id from purchase_intents")).toEqual([]);
    expect(await asUser(manager.id, "select id from purchase_intent_events where intent_id = $1", [created.id])).not.toEqual([]);
    expect(await asUser(staff.id, "select id from purchase_intent_events")).toEqual([]);
  });

  it("refuses a duplicate open buyer, a wrong frozen amount, a bad token hash and a client org as the agency", async () => {
    const { created, superAdmin } = await seed();
    const agency = await agencyOrgId();
    const [row] = await rows<{ buyer_email: string; token_hash: string }>("select buyer_email, token_hash from purchase_intents where id = $1", [created.id]);
    const clientOrg = await createOrg({ name: "Not the agency" });
    const refused = async (sql: string, params: unknown[]) => {
      const before = await rows<{ n: string }>("select count(*)::text as n from purchase_intents");
      await expect(withSystem((db) => db.query(sql, params))).rejects.toBeTruthy();
      expect(await rows<{ n: string }>("select count(*)::text as n from purchase_intents")).toEqual(before);
    };
    await refused(
      `insert into purchase_intents (agency_org_id, token_hash, reference, buyer_name, buyer_email, company, setup_fee_cents, maintenance_monthly_cents, product_version, expires_at, created_by)
       values ($1, $2, 'PUR-DUPLICATE1', 'Duplicate', $3, 'Duplicate Co', 149900, 29900, 'launch-2026-10', now() + interval '1 day', $4)`,
      [agency, "a".repeat(64), row.buyer_email, superAdmin.id],
    );
    await refused(
      `insert into purchase_intents (agency_org_id, token_hash, reference, buyer_name, buyer_email, company, setup_fee_cents, maintenance_monthly_cents, product_version, expires_at, created_by)
       values ($1, $2, 'PUR-WRONGPRICE', 'Wrong', $3, 'Wrong Co', 149800, 29900, 'launch-2026-10', now() + interval '1 day', $4)`,
      [agency, "b".repeat(64), `wrong-${crypto.randomUUID()}@example.test`, superAdmin.id],
    );
    await refused(
      `insert into purchase_intents (agency_org_id, token_hash, reference, buyer_name, buyer_email, company, setup_fee_cents, maintenance_monthly_cents, product_version, expires_at, created_by)
       values ($1, 'short', 'PUR-BADTOKEN', 'Bad', $2, 'Bad Co', 149900, 29900, 'launch-2026-10', now() + interval '1 day', $3)`,
      [agency, `bad-${crypto.randomUUID()}@example.test`, superAdmin.id],
    );
    await refused(
      `insert into purchase_intents (agency_org_id, token_hash, reference, buyer_name, buyer_email, company, setup_fee_cents, maintenance_monthly_cents, product_version, expires_at, created_by)
       values ($1, $2, 'PUR-WRONGORG', 'Wrong', $3, 'Wrong Co', 149900, 29900, 'launch-2026-10', now() + interval '1 day', $4)`,
      [clientOrg.id, "c".repeat(64), `org-${crypto.randomUUID()}@example.test`, superAdmin.id],
    );
  });

  it("refuses to edit or delete a timeline row", async () => {
    const { created } = await seed();
    const event = (await rows<{ id: string }>("select id::text from purchase_intent_events where intent_id = $1 limit 1", [created.id]))[0];
    await expect(withSystem((db) => db.query("update purchase_intent_events set kind = 'cancelled' where id = $1", [event.id]))).rejects.toThrow(/append-only/);
    await expect(withSystem((db) => db.query("delete from purchase_intent_events where id = $1", [event.id]))).rejects.toThrow(/append-only/);
  });

  it("refuses the rollback while a purchase exists, and removes the schema when none does", async () => {
    await seed();
    await rolledBack(async (db) => {
      await expect(runDown(db)).rejects.toThrow(/Rollback refused: purchase intents/);
    });
    // With no purchase rows in this transaction, the rollback drops both tables and the helper functions; the outer transaction then rolls everything back.
    await expect(withSystem(async (db) => {
      await db.query("alter table purchase_intent_events disable trigger purchase_intent_events_immutable");
      await db.query("delete from purchase_intent_events");
      await db.query("delete from purchase_intents");
      await runDown(db);
      const left = await db.query<{ relname: string }>("select relname from pg_class where relnamespace = 'public'::regnamespace and relname in ('purchase_intents', 'purchase_intent_events')");
      expect(left.rows).toEqual([]);
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
    expect((await rows("select 1 from purchase_intents limit 1")).length).toBeGreaterThan(0);
  });
});
