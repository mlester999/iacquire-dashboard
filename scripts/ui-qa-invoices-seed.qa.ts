/**
 * Fictional customer invoices for isolated local browser QA, added on top of the Unified Inbox QA workspace ("Harbor Home Services (Inbox QA)"). It writes through the
 * application's own services into the embedded QA database and contacts NOBODY: no payment provider is called (the connection is the simulated one, and its testing checkout page
 * moves no money), no message is sent, and every name, address, account number and price is made up (scripts/invoices-qa-world.ts says which invoice is in which state and why).
 *
 *   node scripts/run-inbox-qa-seed.mjs         (first, once)
 *   node scripts/run-invoices-qa-seed.mjs      (this; with the QA server stopped)
 *
 * It switches customer invoices ON for that one QA workspace (the switch a Super Admin would use), which is the only change outside the invoice tables. The customer addresses it
 * prints (and writes to .data/crm-qa/invoices-seed-summary.json) are bearer links to FICTIONAL invoices in the throwaway QA database. A few invoices carry a fictional "live" payment
 * so the Lead Sources report has verified revenue, a dispute and a payment kept for review to look at, and two are TEST invoices (TEST-0001, TEST-0002) that the testing checkout pays;
 * the world's own header says so. Idempotent: when the workspace already has invoices it adds nothing. Run it with INVOICES_QA_DELIVERY=1 to also make a few of the issued invoices
 * sendable from their page (a native email channel with a made-up credential; nothing can leave, and it replaces the workspace's email channel).
 */
import fs from "node:fs";
import path from "node:path";
import { it } from "vitest";
import { closeDb, withSystem } from "../src/server/db/index";
import { env } from "../src/server/env";
import { memberActor } from "../src/server/crm/actor";
import { permissionsFor, roleHasPermission, type OrgRole } from "../src/lib/permissions";
import type { Membership, OrgContext } from "../src/server/tenancy/context";
import { seedInvoiceDeliveryWorld, seedInvoiceWorld } from "./invoices-qa-world";

const ORG_NAME = "Harbor Home Services (Inbox QA)";
const SUMMARY_FILE = path.resolve(".data/crm-qa/invoices-seed-summary.json");
const qaDataDir = () => (process.env.PGLITE_DATA_DIR ?? "").replace(/\\/g, "/");

function assertIsolated() {
  const e = env();
  if (e.NODE_ENV === "production" || e.AUTH_PROVIDER !== "local" || e.DATABASE_DRIVER !== "pglite" || (e.DATABASE_URL ?? "") !== "" || !qaDataDir().startsWith(".data/crm-qa/")) {
    throw new Error("Refusing to seed outside the isolated QA database (local sign-in, embedded pglite in .data/crm-qa). Use node scripts/run-invoices-qa-seed.mjs.");
  }
  if (e.CUSTOMER_PAYMENTS_WRITES_ENABLED || e.CUSTOMER_PAYMENTS_LIVE_ENABLED) throw new Error("Refusing to seed while a switch for real customer payments is on.");
}
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;

function ctxFor(user: { id: string; email: string; full_name: string }, org: { id: string; name: string; slug: string }, role: OrgRole): OrgContext {
  const membership: Membership = { orgId: org.id, name: org.name, slug: org.slug, kind: "client", status: "active", role, isDemo: false, onboardingCompletedAt: null, timezone: "America/Chicago" };
  return {
    user: { sessionId: "qa", id: user.id, email: user.email, fullName: user.full_name, platformRole: "none", timezone: "America/Chicago", preferences: {}, emailVerified: true },
    org: membership, role, permissions: permissionsFor(role), can: (perm) => roleHasPermission(role, perm), memberships: [membership],
  };
}

async function seed() {
  assertIsolated();
  const org = (await q<{ id: string; name: string; slug: string }>("select id, name, slug from organizations where name = $1", [ORG_NAME]))[0];
  if (!org) throw new Error("Run node scripts/run-inbox-qa-seed.mjs first: the Inbox QA workspace does not exist.");
  const user = async (email: string) => (await q<{ id: string; email: string; full_name: string }>("select id, email, full_name from users where email = $1", [email]))[0];
  const ctx = async (email: string, role: OrgRole) => ctxFor(await user(email), org, role);
  const owner = await ctx("owner.harbor@example.test", "owner");
  // Opt in with INVOICES_QA_DELIVERY=1: the workspace's email channel becomes a native one with a made-up credential, so the invoice page's "Send it to the customer" can be tried.
  // Nothing can leave (RESEND_WRITES_ENABLED stays off in the QA environment). It replaces the workspace's email channel, which the Inbox QA data uses, so it is not the default.
  const delivery = async () => {
    if (process.env.INVOICES_QA_DELIVERY !== "1") return;
    const out = await seedInvoiceDeliveryWorld({ owner, ownerActor: memberActor(owner) });
    console.log(`Delivery QA data is ready. Consent to email is on record for the customers of: ${out.ready.join(", ")}. ${out.refused.join(", ")} has none, so the preview says it cannot be sent. A test invoice is never offered.`);
  };
  if ((await q("select 1 from customer_invoices where org_id = $1", [org.id])).length) {
    console.log("The invoices QA data already exists; nothing added.");
    await delivery();
    return;
  }
  // The switch a Super Admin uses, set directly: there is no signed-in Super Admin in a seed.
  await withSystem((db) => db.query("insert into org_features (org_id, feature, enabled) values ($1, 'invoices', true) on conflict (org_id, feature) do update set enabled = true", [org.id]));
  const out = await seedInvoiceWorld({ owner, ownerActor: memberActor(owner), sales: await ctx("sales.harbor@example.test", "sales_rep") });
  fs.mkdirSync(path.dirname(SUMMARY_FILE), { recursive: true });
  fs.writeFileSync(SUMMARY_FILE, JSON.stringify({ orgId: org.id, invoices: out }, null, 2));
  console.log(`Invoices QA data is ready (${out.length} invoices). Screens and customer addresses:`);
  for (const r of out) console.log(`  ${r.number ?? "(draft)"}  ${r.title}: ${r.state}\n      team: ${r.portalPath}${r.customerPath ? `\n      customer: ${r.customerPath}` : ""}`);
  await delivery();
}

it.skipIf(!qaDataDir().startsWith(".data/crm-qa/"))("seeds fictional customer invoices into the isolated QA database", async () => {
  try {
    await seed();
  } finally {
    await closeDb();
  }
}, 240_000);
