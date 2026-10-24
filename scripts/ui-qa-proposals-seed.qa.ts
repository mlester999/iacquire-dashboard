/**
 * Fictional proposals for isolated local browser QA, added on top of the Unified Inbox QA workspace ("Harbor Home Services (Inbox QA)"). It writes through the application's
 * own services into the embedded QA database and contacts NOBODY: code emails are captured (readable at /dev/mailbox), the only signing service is the stand-in that lives inside
 * the server (it sends nothing to anyone and signs nothing), and every name, address and price is made up (scripts/proposals-qa-world.ts says which proposal is in which state and why).
 *
 *   node scripts/run-inbox-qa-seed.mjs         (first, once)
 *   node scripts/run-proposals-qa-seed.mjs     (this; with the QA server stopped)
 *
 * The customer addresses it prints (and writes to .data/crm-qa/proposals-seed-summary.json) are bearer links to FICTIONAL proposals in the throwaway QA database.
 * Idempotent: when the workspace already has proposals it adds nothing.
 */
import fs from "node:fs";
import path from "node:path";
import { it } from "vitest";
import { closeDb, withSystem } from "../src/server/db/index";
import { env } from "../src/server/env";
import { memberActor } from "../src/server/crm/actor";
import { permissionsFor, roleHasPermission, type OrgRole } from "../src/lib/permissions";
import type { Membership, OrgContext } from "../src/server/tenancy/context";
import { seedDeliveryWorld, seedInvoicingStories, seedProposalWorld, seedSigningWorld } from "./proposals-qa-world";

const ORG_NAME = "Harbor Home Services (Inbox QA)";
const SUMMARY_FILE = path.resolve(".data/crm-qa/proposals-seed-summary.json");
const qaDataDir = () => (process.env.PGLITE_DATA_DIR ?? "").replace(/\\/g, "/");

function assertIsolated() {
  const e = env();
  if (e.NODE_ENV === "production" || e.AUTH_PROVIDER !== "local" || e.DATABASE_DRIVER !== "pglite" || (e.DATABASE_URL ?? "") !== "" || !qaDataDir().startsWith(".data/crm-qa/")) {
    throw new Error("Refusing to seed outside the isolated QA database (local sign-in, embedded pglite in .data/crm-qa). Use node scripts/run-proposals-qa-seed.mjs.");
  }
  if (e.EMAIL_PROVIDER !== "capture") throw new Error("Refusing to seed unless emails are only captured (EMAIL_PROVIDER=capture).");
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
  const as = async (email: string, role: OrgRole) => memberActor(ctxFor(await user(email), org, role));
  const actors = async () => ({ owner: await as("owner.harbor@example.test", "owner"), manager: await as("manager.harbor@example.test", "admin"), sales: await as("sales.harbor@example.test", "sales_rep") });
  // Opt in with PROPOSALS_QA_DELIVERY=1: the workspace's email channel becomes a native one with a made-up credential, so the Delivery tab's "Send it to the customer" can be tried.
  // Nothing can leave (RESEND_WRITES_ENABLED stays off in the QA environment). It replaces the workspace's email channel, which the Inbox QA data uses, so it is not the default.
  const delivery = async () => {
    if (process.env.PROPOSALS_QA_DELIVERY !== "1") return;
    const out = await seedDeliveryWorld(await actors());
    console.log(`Delivery QA data is ready. Consent to email is on record for ${out.ready.join(", ")}; ${out.refused.join(", ")} has none, so the preview says it cannot be sent.`);
  };
  // Opt in with PROPOSALS_QA_INVOICING=1: customer invoices are switched on for the workspace and three accepted proposals are added, to try "Make a draft invoice" on a proposal's
  // Invoice tab. Nothing is issued, sent or charged. Once only: it adds nothing when its first story is already there.
  const invoicing = async () => {
    if (process.env.PROPOSALS_QA_INVOICING !== "1") return;
    if ((await q("select 1 from proposals where org_id = $1 and title = $2", [org.id, "Boiler service for the Soto household"])).length) {
      console.log("The invoicing QA proposals already exist; nothing added.");
      return;
    }
    const owner = ctxFor(await user("owner.harbor@example.test"), org, "owner");
    const stories = await seedInvoicingStories(await actors(), owner);
    console.log("Invoicing QA proposals are ready (customer invoices are switched on for this workspace). Open each on its Invoice tab:");
    for (const s of stories) console.log(`  ${s.number}  ${s.title}: ${s.state}\n      team: ${s.proposalPath}${s.invoicePath ? `\n      draft invoice: ${s.invoicePath}` : ""}`);
  };
  if ((await q("select 1 from proposals where org_id = $1", [org.id])).length) {
    // The workspace was seeded before electronic signing existed: add only the three signing stories, once.
    if ((await q("select 1 from esign_connections where org_id = $1", [org.id])).length) {
      console.log("The proposals QA data already exists; nothing added.");
      await delivery();
      await invoicing();
      return;
    }
    const added = await seedSigningWorld(await actors());
    console.log(`Added the electronic signing stories to the existing proposals QA data (${added.length} proposals). Customer addresses:`);
    for (const r of added) console.log(`  ${r.number}  ${r.state}\n      ${r.url ?? "(no customer link)"}${r.email ? `\n      code email to ${r.email}` : ""}`);
    return;
  }
  const rows = await seedProposalWorld(await actors());
  fs.mkdirSync(path.dirname(SUMMARY_FILE), { recursive: true });
  fs.writeFileSync(SUMMARY_FILE, JSON.stringify({ orgId: org.id, proposals: rows }, null, 2));
  console.log(`Proposals QA data is ready (${rows.length} proposals). Customer addresses:`);
  for (const r of rows) console.log(`  ${r.number}  ${r.state}\n      ${r.url ?? "(no customer link)"}${r.email ? `\n      code email to ${r.email}` : ""}`);
  await delivery();
  await invoicing();
}

it.skipIf(!qaDataDir().startsWith(".data/crm-qa/"))("seeds fictional proposals into the isolated QA database", async () => {
  try {
    await seed();
  } finally {
    await closeDb();
  }
}, 240_000);
