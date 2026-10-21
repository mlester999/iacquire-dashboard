/**
 * Puts the isolated Automation Studio QA database in the state the browser run needs, through the same tables the application reads, and sends nothing
 * anywhere. The database is a copy of the Native CRM QA one (fictional workspaces only), so this only adds: an ACTIVE Managed Maintenance +
 * Automation Studio plan for Brightside Roofing (QA), activated by the QA agency admin as the real process would. Haven Dental (QA) gets none, so
 * the upgrade page can be looked at too. It also gives Brightside two connections for the screens to show: a verified Slack one and an unverified HTTP one,
 * stored through the same columns the application writes (the secrets are made-up placeholders: nothing is ever sent to them). Idempotent. Run it through scripts/run-automation-qa-seed.mjs.
 */
import { it } from "vitest";
import { closeDb, withSystem } from "../src/server/db/index";
import { env } from "../src/server/env";
import { encryptSecret } from "../src/server/security/crypto";

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
    const connection = async (kind: string, name: string, settings: unknown, secret: string, status: string) => {
      const have = (await db.query("select 1 from automation_connections where org_id = $1 and lower(name) = lower($2)", [org.id, name])).rows.length;
      if (have) return;
      await db.query(
        `insert into automation_connections (org_id, kind, name, settings, secret_ciphertext, secret_hint, status, verified_at, verified_by, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, case when $7 = 'active' then now() end, case when $7 = 'active' then $8::uuid end, $8)`,
        [org.id, kind, name, JSON.stringify(settings), encryptSecret(secret), secret.slice(-4), status, owner.id],
      );
    };
    await connection("slack_webhook", "Sales channel", { channelLabel: "#sales" }, "https://hooks.slack.com/services/T0QAQAQA1/B0QAQAQA1/QaPlaceholderNotARealWebhook", "active");
    await connection("http", "Operations API", { host: "api.example.com", pathPrefix: "/v1", methods: ["GET", "POST"], auth: { type: "bearer" }, testPath: "/ping" }, "qa-placeholder-token-0001", "unverified");
    if (open) return;
    await db.query(
      `insert into maintenance_subscriptions (org_id, status, monthly_price_cents, monthly_request_allowance, terms_version, accepted_by, activated_at, activated_by, billing_start_on)
       values ($1, 'active', 29900, 4, 'qa', $2, now() - interval '5 days', $3, current_date - 5)`,
      [org.id, owner.id, admin.id],
    );
  });
  await closeDb();
});
