// What migration 0099 adds for the maintenance plan's lifecycle (Phase 7, M2): the provider reserved for recurring billing, the automatic past-due switch (off), and the index the
// sweep looks at stale checkouts through. Embedded Postgres. No provider code exists for the reserved columns: they are null today and nothing reads them.
import { describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { createOrg, createUser, addMember, uid } from "./support/fixtures";

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;

async function plan(orgId: string, ownerId: string, over: { provider?: string | null; subscription?: string | null } = {}) {
  return withSystem((db) => db.query(
    `insert into maintenance_subscriptions (org_id, status, monthly_price_cents, monthly_request_allowance, terms_version, accepted_by, activated_at, billing_start_on, provider, provider_subscription_id)
     values ($1, 'active', 29900, 4, 'test-terms', $2, now(), current_date, $3, $4)`,
    [orgId, ownerId, over.provider ?? null, over.subscription ?? null],
  ));
}
const workspace = async () => {
  const org = await createOrg({ name: `Plan columns ${uid()}` });
  const owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  return { org, owner };
};

describe("the billing provider a plan names", () => {
  it("is null today, so a plan an agency member verifies by hand needs neither column", async () => {
    const w = await workspace();
    await plan(w.org.id, w.owner.id);
    expect((await rows("select provider, provider_subscription_id from maintenance_subscriptions where org_id = $1", [w.org.id]))[0]).toEqual({ provider: null, provider_subscription_id: null });
  });

  it("is set together with its subscription id or not at all, and only to a provider the code knows", async () => {
    const w = await workspace();
    await expect(plan(w.org.id, w.owner.id, { provider: "paymongo" })).rejects.toThrow(/maintenance_subscriptions_provider_pair_check/);
    await expect(plan(w.org.id, w.owner.id, { subscription: "sub_alone_1" })).rejects.toThrow(/maintenance_subscriptions_provider_pair_check/);
    await expect(plan(w.org.id, w.owner.id, { provider: "stripe", subscription: "sub_stripe_1" })).rejects.toThrow(/provider/);
    await expect(plan(w.org.id, w.owner.id, { provider: "paypal", subscription: "ab" })).rejects.toThrow(/provider_subscription_id/);
    await expect(plan(w.org.id, w.owner.id, { provider: "paypal", subscription: "x".repeat(121) })).rejects.toThrow(/provider_subscription_id/);
    expect(await rows("select 1 from maintenance_subscriptions where org_id = $1", [w.org.id])).toHaveLength(0);
    await plan(w.org.id, w.owner.id, { provider: "paypal", subscription: "I-PLANSUB0001" });
    expect(await rows("select 1 from maintenance_subscriptions where org_id = $1", [w.org.id])).toHaveLength(1);
  });

  it("belongs to one plan: another workspace cannot claim the same provider subscription, though the same id at another provider is a different subscription", async () => {
    const a = await workspace();
    const b = await workspace();
    const c = await workspace();
    const id = `sub_${uid()}`;
    await plan(a.org.id, a.owner.id, { provider: "paymongo", subscription: id });
    await expect(plan(b.org.id, b.owner.id, { provider: "paymongo", subscription: id })).rejects.toThrow(/maintenance_subscriptions_provider_sub_idx/);
    await plan(c.org.id, c.owner.id, { provider: "paypal", subscription: id });
    expect(await rows("select 1 from maintenance_subscriptions where org_id = $1", [b.org.id])).toHaveLength(0);
  });

  it("is invisible to the people it concerns: no signed-in role can read it, and the columns the portal already used are unchanged", async () => {
    const w = await workspace();
    await plan(w.org.id, w.owner.id, { provider: "paymongo", subscription: `sub_${uid()}` });
    await withSystem(async (db) => {
      for (const column of ["provider", "provider_subscription_id", "last_payment_id"]) {
        expect((await db.query<{ ok: boolean }>("select has_column_privilege('iaq_app_user', 'public.maintenance_subscriptions', $1, 'select') as ok", [column])).rows[0].ok, `${column} is not readable`).toBe(false);
      }
      for (const column of ["status", "monthly_price_cents", "renewal_on", "billing_start_on"]) {
        expect((await db.query<{ ok: boolean }>("select has_column_privilege('iaq_app_user', 'public.maintenance_subscriptions', $1, 'select') as ok", [column])).rows[0].ok, `${column} is readable`).toBe(true);
      }
    });
    await expect(withUser(w.owner.id, (db) => db.query("select provider_subscription_id from maintenance_subscriptions"))).rejects.toThrow(/permission denied/);
    expect((await withUser(w.owner.id, (db) => db.query<{ status: string }>("select status from maintenance_subscriptions where org_id = $1", [w.org.id]))).rows).toEqual([{ status: "active" }]);
  });
});

describe("the automatic past-due switch", () => {
  it("is off in a fresh database with nobody recorded against it, and the application role has no access to the table at all", async () => {
    const [settings] = await rows<{ auto_past_due: boolean; auto_past_due_by: string | null; auto_past_due_at: Date | null }>("select auto_past_due, auto_past_due_by, auto_past_due_at from agency_billing_settings");
    expect(settings).toEqual({ auto_past_due: false, auto_past_due_by: null, auto_past_due_at: null });
    expect((await rows("select 1 from agency_billing_settings")).length).toBe(1);
    const w = await workspace();
    await expect(withUser(w.owner.id, (db) => db.query("select auto_past_due from agency_billing_settings"))).rejects.toThrow(/permission denied/);
  });

  it("forgets who switched it on when that person is deleted, rather than blocking their removal", async () => {
    const person = await createUser();
    await withSystem((db) => db.query("update agency_billing_settings set auto_past_due = true, auto_past_due_by = $1, auto_past_due_at = now()", [person.id]));
    await withSystem((db) => db.query("delete from users where id = $1", [person.id]));
    const [settings] = await rows<{ auto_past_due: boolean; auto_past_due_by: string | null }>("select auto_past_due, auto_past_due_by from agency_billing_settings");
    expect(settings).toEqual({ auto_past_due: true, auto_past_due_by: null });
    await withSystem((db) => db.query("update agency_billing_settings set auto_past_due = false, auto_past_due_at = null"));
  });
});

describe("the sweep's look at checkouts nobody completed", () => {
  it("has an index on the age of the pending ones only, so the sweep never scans the paid history", async () => {
    const [index] = await rows<{ indexdef: string }>("select indexdef from pg_indexes where indexname = 'payments_pending_age_idx'");
    expect(index.indexdef).toMatch(/\(created_at\)/);
    expect(index.indexdef).toMatch(/WHERE \(status = 'pending'::text\)/);
  });
});
