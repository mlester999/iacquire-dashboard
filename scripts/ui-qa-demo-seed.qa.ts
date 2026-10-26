/**
 * What the prospect demo's AI chat needs that the other QA worlds do not have: an active agency workspace, because every demo message is a call the AI chat records against the
 * agency's own workspace (src/server/demo/generator.ts, agencyOrgId). It writes nothing else, sends nothing and contacts nobody. Run it with the QA server stopped:
 *
 *   node scripts/run-demo-qa-seed.mjs
 *
 * Idempotent: when an agency workspace exists it adds nothing. (The database allows exactly one.)
 */
import { it } from "vitest";
import { closeDb, withSystem } from "../src/server/db/index";
import { env } from "../src/server/env";
import { ensureAgentInstances } from "../src/server/workforce/service";

const qaDataDir = () => (process.env.PGLITE_DATA_DIR ?? "").replace(/\\/g, "/");

function assertIsolated() {
  const e = env();
  if (e.NODE_ENV === "production" || e.AUTH_PROVIDER !== "local" || e.DATABASE_DRIVER !== "pglite" || (e.DATABASE_URL ?? "") !== "" || !qaDataDir().startsWith(".data/crm-qa/")) {
    throw new Error("Refusing to seed outside the isolated QA database (local sign-in, embedded pglite in .data/crm-qa). Use node scripts/run-demo-qa-seed.mjs.");
  }
}

async function seed() {
  assertIsolated();
  const existing = await withSystem((db) => db.query<{ id: string }>("select id from organizations where kind = 'agency' limit 1"));
  if (existing.rows.length) {
    console.log("An agency workspace already exists; nothing added.");
    return;
  }
  await withSystem(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      "insert into organizations (name, slug, kind, status, timezone, onboarding_completed_at) values ('iAcquire (QA)', 'iacquire-qa', 'agency', 'active', 'America/Chicago', now()) returning id",
    );
    const id = rows[0].id;
    await db.query("insert into company_profiles (org_id) values ($1) on conflict do nothing", [id]);
    await db.query("insert into usage_limits (org_id) values ($1) on conflict do nothing", [id]);
    await db.query("insert into billing_accounts (org_id) values ($1) on conflict do nothing", [id]);
    await db.query("insert into onboarding_responses (org_id) values ($1) on conflict do nothing", [id]);
    await ensureAgentInstances(id, db);
  });
  console.log("Demo QA data is ready: an agency workspace (iAcquire (QA)) now exists, so the demo's AI chat has somewhere to record its calls.");
}

it.skipIf(!qaDataDir().startsWith(".data/crm-qa/"))("seeds the agency workspace the demo chat records against, into the isolated QA database", async () => {
  try {
    await seed();
  } finally {
    await closeDb();
  }
}, 240_000);
