/**
 * What the maintenance-payment browser QA needs that the other QA worlds do not have: Harbor Home Services (Inbox QA) with its core system ACTIVATED, its setup fee waived (so the
 * second paid product is allowed), and an ACTIVE Managed Maintenance plan whose paid period ends in four days, so "Pay online" for the next period can be pressed and checked. It
 * writes nothing else, sends nothing and contacts nobody. Run it with the QA server stopped:
 *
 *   node scripts/run-checkout-qa-seed.mjs
 *
 * Idempotent: a workspace that already has an open plan gets no second one.
 */
import { it } from "vitest";
import { closeDb, withSystem } from "../src/server/db/index";
import { env } from "../src/server/env";

const ORG_NAME = "Harbor Home Services (Inbox QA)";
const qaDataDir = () => (process.env.PGLITE_DATA_DIR ?? "").replace(/\\/g, "/");

function assertIsolated() {
  const e = env();
  if (e.NODE_ENV === "production" || e.AUTH_PROVIDER !== "local" || e.DATABASE_DRIVER !== "pglite" || (e.DATABASE_URL ?? "") !== "" || !qaDataDir().startsWith(".data/crm-qa/")) {
    throw new Error("Refusing to seed outside the isolated QA database (local sign-in, embedded pglite in .data/crm-qa). Use node scripts/run-checkout-qa-seed.mjs.");
  }
}

async function seed() {
  assertIsolated();
  await withSystem(async (db) => {
    const org = (await db.query<{ id: string }>("select id from organizations where name = $1 and kind = 'client'", [ORG_NAME])).rows[0];
    if (!org) throw new Error(`${ORG_NAME} does not exist: run node scripts/run-inbox-qa-seed.mjs first.`);
    const owner = (await db.query<{ user_id: string }>("select user_id from organization_memberships where org_id = $1 and role = 'owner' limit 1", [org.id])).rows[0];
    const agency = (await db.query<{ id: string }>("select id from users where platform_role = 'agency_super_admin' and status = 'active' order by created_at limit 1")).rows[0];
    if (!owner || !agency) throw new Error("The QA owner or the agency Super Admin is missing.");

    if (!(await db.query("select 1 from client_setup_instances where org_id = $1", [org.id])).rows.length) {
      await db.query("insert into client_setup_instances (org_id, state, activated_at) values ($1, 'activated', now())", [org.id]);
    } else {
      await db.query("update client_setup_instances set state = 'activated', activated_at = coalesce(activated_at, now()) where org_id = $1", [org.id]);
    }
    await db.query(
      `insert into billing_accounts (org_id, setup_payment_status, waiver_reason, waived_at) values ($1, 'waived', 'QA fixture: the setup fee is waived so maintenance can be paid for', now())
       on conflict (org_id) do update set setup_payment_status = 'waived', waiver_reason = excluded.waiver_reason, waived_at = now()`,
      [org.id],
    );
    const open = (await db.query("select 1 from maintenance_subscriptions where org_id = $1 and status in ('requested', 'active', 'past_due', 'cancel_requested')", [org.id])).rows.length;
    if (!open) {
      await db.query(
        `insert into maintenance_subscriptions (org_id, status, monthly_price_cents, monthly_request_allowance, terms_version, accepted_by, activated_at, activated_by, billing_start_on, paid_through_on)
         values ($1, 'active', 29900, 4, 'qa', $2, now() - interval '26 days', $3, current_date - 26, current_date + 4)`,
        [org.id, owner.user_id, agency.id],
      );
    }
  });
  console.log(`Checkout QA data is ready: ${ORG_NAME} has an activated core system, a waived setup fee and an active maintenance plan paid through four days from now.`);
}

it.skipIf(!qaDataDir().startsWith(".data/crm-qa/"))("seeds an active maintenance plan for Harbor Home Services (Inbox QA) into the isolated QA database", async () => {
  try {
    await seed();
  } finally {
    await closeDb();
  }
}, 240_000);
