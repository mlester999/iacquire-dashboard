/**
 * Puts the isolated Automation Studio QA database in the state the browser run needs, through the same tables the application reads, and sends nothing
 * anywhere. The database is a copy of the Native CRM QA one (fictional workspaces only), so this only adds: an ACTIVE Managed Maintenance +
 * Automation Studio plan for Brightside Roofing (QA), activated by the QA agency admin as the real process would. Haven Dental (QA) gets none, so
 * the upgrade page can be looked at too. Idempotent. Run it through scripts/run-automation-qa-seed.mjs.
 */
import { it } from "vitest";
import { closeDb, withSystem } from "../src/server/db/index";
import { env } from "../src/server/env";

const dataDir = () => (process.env.PGLITE_DATA_DIR ?? "").split("\\").join("/");

it("gives Brightside Roofing (QA) an active plan and leaves Haven Dental (QA) without one", async () => {
  const e = env();
  if (e.NODE_ENV === "production" || e.AUTH_PROVIDER !== "local" || e.DATABASE_DRIVER !== "pglite" || (e.DATABASE_URL ?? "") !== "" || !dataDir().startsWith(".data/automation-qa/")) {
    throw new Error("Refusing to seed outside the isolated Automation Studio QA database (local sign-in, embedded pglite in .data/automation-qa).");
  }
  await withSystem(async (db) => {
    const org = (await db.query<{ id: string }>("select id from organizations where slug = 'brightside-roofing-qa'")).rows[0];
    const owner = (await db.query<{ id: string }>("select id from users where lower(email) = 'brightside.owner@example.test'")).rows[0];
    const admin = (await db.query<{ id: string }>("select id from users where lower(email) = 'qa.admin@example.test'")).rows[0];
    if (!org || !owner || !admin) throw new Error("The Native CRM QA seed is missing: copy it first (scripts/run-automation-qa-seed.mjs does).");
    const open = (await db.query("select 1 from maintenance_subscriptions where org_id = $1 and status in ('requested', 'active', 'past_due', 'cancel_requested')", [org.id])).rows.length;
    if (open) return;
    await db.query(
      `insert into maintenance_subscriptions (org_id, status, monthly_price_cents, monthly_request_allowance, terms_version, accepted_by, activated_at, activated_by, billing_start_on)
       values ($1, 'active', 29900, 4, 'qa', $2, now() - interval '5 days', $3, current_date - 5)`,
      [org.id, owner.id, admin.id],
    );
  });
  await closeDb();
});
