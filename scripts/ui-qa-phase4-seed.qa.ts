/**
 * Fictional social media data for isolated local browser QA, added on top of the Unified Inbox QA workspace ("Harbor Home Services (Inbox QA)"). It writes through
 * the application's own services into the embedded QA database and posts NOTHING anywhere: the accounts are the in-process simulated ones, no Meta app exists,
 * live publishing is off. The pictures are generated here (plain colours); every name is made up.
 *
 *   node scripts/run-inbox-qa-seed.mjs      (first, once)
 *   node scripts/run-phase4-qa-seed.mjs     (this; with the QA server stopped)
 *
 * Idempotent: when the workspace already has a social account it adds nothing.
 */
import fs from "node:fs";
import path from "node:path";
import { it } from "vitest";
import sharp from "sharp";
import { closeDb, withSystem } from "../src/server/db/index";
import { env } from "../src/server/env";
import { connectSimulatedAccount } from "../src/server/social/accounts";
import { createCampaign, saveSocialSettings } from "../src/server/social/settings";
import { createPost, decide, schedulePost, submitForApproval } from "../src/server/social/posts";
import { insertDraft } from "../src/server/social/posts";
import { uploadMedia } from "../src/server/social/media";
import { processDueSocialPosts } from "../src/server/social/publisher";
import { simulated, simulatedProvider } from "../src/server/social/providers/simulated";
import { syncPostMetrics } from "../src/server/social/analytics";
import { permissionsFor, roleHasPermission, type OrgRole } from "../src/lib/permissions";
import type { Membership, OrgContext } from "../src/server/tenancy/context";

const ORG_NAME = "Harbor Home Services (Inbox QA)";
const SUMMARY_FILE = path.resolve(".data/crm-qa/phase4-seed-summary.json");
const qaDataDir = () => (process.env.PGLITE_DATA_DIR ?? "").replace(/\\/g, "/");

function assertIsolated() {
  const e = env();
  if (e.NODE_ENV === "production" || e.AUTH_PROVIDER !== "local" || e.DATABASE_DRIVER !== "pglite" || (e.DATABASE_URL ?? "") !== "" || !qaDataDir().startsWith(".data/crm-qa/")) {
    throw new Error("Refusing to seed outside the isolated QA database (local sign-in, embedded pglite in .data/crm-qa). Use node scripts/run-phase4-qa-seed.mjs.");
  }
}
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;

function ctxFor(user: { id: string; email: string; full_name: string }, org: { id: string; name: string; slug: string }, role: OrgRole): OrgContext {
  const membership: Membership = { orgId: org.id, name: org.name, slug: org.slug, kind: "client", status: "active", role, isDemo: false, onboardingCompletedAt: null, timezone: "America/Chicago" };
  return {
    user: { sessionId: "qa", id: user.id, email: user.email, fullName: user.full_name, platformRole: "none", timezone: "America/Chicago", preferences: {}, emailVerified: true },
    org: membership, role, permissions: permissionsFor(role), can: (perm) => roleHasPermission(role, perm), memberships: [membership],
  };
}

const solid = (w: number, h: number, rgb: [number, number, number]) => sharp({ create: { width: w, height: h, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } });

async function seed() {
  assertIsolated();
  const org = (await q<{ id: string; name: string; slug: string }>("select id, name, slug from organizations where name = $1", [ORG_NAME]))[0];
  if (!org) throw new Error("Run node scripts/run-inbox-qa-seed.mjs first: the Inbox QA workspace does not exist.");
  if ((await q("select 1 from social_accounts where org_id = $1", [org.id])).length) {
    console.log("The Phase 4 QA data already exists; nothing added.");
    return;
  }
  const user = async (email: string) => (await q<{ id: string; email: string; full_name: string }>("select id, email, full_name from users where email = $1", [email]))[0];
  const owner = ctxFor(await user("owner.harbor@example.test"), org, "owner");
  const manager = ctxFor(await user("manager.harbor@example.test"), org, "admin");
  const sales = ctxFor(await user("sales.harbor@example.test"), org, "sales_rep");
  simulated.reset();

  // The managed maintenance plan, so media can be stored (a synthetic subscription in the isolated database only).
  await q(
    "insert into maintenance_subscriptions (org_id, status, monthly_price_cents, monthly_request_allowance, terms_version, accepted_by, activated_at, billing_start_on) values ($1, 'active', 29900, 4, 'qa', $2, now() - interval '30 days', current_date - 30)",
    [org.id, owner.user.id],
  );
  // Approved knowledge the AI may use. No prices and no promotions: nothing in it can be turned into an invented offer.
  for (const [section, content] of [
    ["business_description", "Harbor Home Services repairs and maintains heating, cooling and plumbing systems for homes in Austin, Texas."],
    ["products_services", "Air conditioner and furnace repair, seasonal tune-ups, water heater service and drain clearing."],
    ["brand_voice", "Warm, plain and helpful. Short sentences. No hype."],
  ]) {
    await q(
      "insert into company_knowledge (org_id, section, content, review_status, risk_flags) values ($1, $2, $3, 'approved', '{}') on conflict (org_id, section) do update set content = excluded.content, review_status = 'approved', risk_flags = '{}'",
      [org.id, section, content],
    );
  }

  await saveSocialSettings(owner, { brandVoiceNote: "Warm, plain and helpful.", defaultHashtags: ["HarborHome"] }, 0);
  const fb = await connectSimulatedAccount(owner, { platform: "facebook", name: "Harbor Home Services", externalId: "qa-page-1" });
  const ig = await connectSimulatedAccount(owner, { platform: "instagram", name: "Harbor Home", externalId: "qa-ig-1" });
  const spring = await createCampaign(manager, { name: "Spring Tune-Up", goal: "Fill the spring tune-up calendar." });
  await createCampaign(manager, { name: "Water heater checks" });

  // Pictures: a JPEG that Instagram accepts, a PNG that it does not, and a very wide banner.
  const jpeg = await solid(1080, 1350, [29, 78, 216]).jpeg({ quality: 70 }).toBuffer();
  const png = await solid(800, 600, [21, 128, 61]).png().toBuffer();
  const wide = await solid(1600, 300, [180, 83, 9]).jpeg({ quality: 70 }).toBuffer();
  const mJpeg = await uploadMedia(manager, { filename: "technician-at-work.jpg", contentType: "image/jpeg", bytes: jpeg, altText: "A technician servicing an air conditioner outdoors" });
  await uploadMedia(manager, { filename: "team-photo.png", contentType: "image/png", bytes: png, altText: "The Harbor Home team" });
  await uploadMedia(manager, { filename: "spring-banner.jpg", contentType: "image/jpeg", bytes: wide });

  const day = (n: number, hour: number) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + n);
    d.setUTCHours(hour, 0, 0, 0);
    return d;
  };

  // 1. Published (through the real publisher, to the simulated platform), with engagement numbers and a tracked link.
  const published = await createPost(owner, { accountId: fb.id, kind: "link", caption: "Spring is the best time for a tune-up. Book a visit with us.", hashtags: ["springtuneup"], linkUrl: "https://www.example.test/spring", campaignId: spring.id });
  await schedulePost(owner, published.id, { asap: true });
  const sent = await processDueSocialPosts({ orgId: org.id, liveEnabled: () => false });
  console.log(`publisher: ${JSON.stringify(sent)}`);
  const pid = (await q<{ provider_post_id: string }>("select provider_post_id from social_posts where id = $1", [published.id]))[0]?.provider_post_id;
  if (pid) {
    simulated.setMetrics(pid, { likes: 14, comments: 3 });
    await syncPostMetrics({ orgId: org.id, provider: () => simulatedProvider });
  }

  // 2. Scheduled (approved by the manager), for later this week.
  const sched = await createPost(sales, { accountId: ig.id, kind: "image", caption: "A look at a morning tune-up. Message us to book yours.", hashtags: ["hvac", "austin"], mediaAssetIds: [mJpeg.id], campaignId: spring.id });
  const pendingSched = await submitForApproval(sales, sched.id);
  const approvedSched = await decide(manager, pendingSched.id, { decision: "approve", version: pendingSched.version });
  await schedulePost(manager, approvedSched.id, { at: day(2, 15) });

  // 3. Waiting for approval, written by a person and by AI.
  const waiting = await createPost(sales, { accountId: fb.id, kind: "text", caption: "Water heater making noises? It may be time for a check. Send us a message.", hashtags: ["waterheater"] });
  await submitForApproval(sales, waiting.id);
  const aiDraft = await withSystem((db) => insertDraft(db, { orgId: org.id, userId: owner.user.id }, { accountId: fb.id, kind: "text", caption: "Thinking about seasonal maintenance? A little attention now saves trouble later. Message us and we will point you in the right direction.", hashtags: ["maintenance", "HarborHome"] }, "ai"));
  await submitForApproval(owner, aiDraft.id);

  // 4. Changes requested, and a draft.
  const changes = await createPost(sales, { accountId: fb.id, kind: "text", caption: "We fix furnaces.", hashtags: [] });
  const pendingChanges = await submitForApproval(sales, changes.id);
  await decide(manager, pendingChanges.id, { decision: "request_changes", version: pendingChanges.version, note: "Say where we work and how to get in touch." });
  await createPost(sales, { accountId: ig.id, kind: "image", caption: "Draft: spring banner", hashtags: [] });

  // 5. A failure, honestly shown: the simulated platform refuses a post, and the publisher records why.
  const failing = await createPost(owner, { accountId: fb.id, kind: "text", caption: "This post will be refused by the test platform." });
  simulated.failNext("create", new (await import("../src/server/social/providers/types")).ProviderError("invalid_content", "The platform refused this post."));
  await schedulePost(owner, failing.id, { asap: true });
  await processDueSocialPosts({ orgId: org.id, liveEnabled: () => false });

  fs.mkdirSync(path.dirname(SUMMARY_FILE), { recursive: true });
  fs.writeFileSync(SUMMARY_FILE, JSON.stringify({ orgId: org.id, facebookAccount: fb.id, instagramAccount: ig.id }, null, 2));
  console.log("Phase 4 QA data is ready (two test accounts, media, a published, a scheduled, two waiting, a changes-requested, a draft and a failed post).");
}

it.skipIf(!qaDataDir().startsWith(".data/crm-qa/"))("seeds fictional social media data into the isolated QA database", async () => {
  try {
    await seed();
  } finally {
    await closeDb();
  }
}, 240_000);
