/**
 * Fictional reputation data for isolated local browser QA, added on top of the Unified Inbox QA workspace ("Harbor Home Services (Inbox QA)"). It writes through the
 * application's own services into the embedded QA database and sends NOTHING anywhere: messages are queued and a few are marked sent by hand so the screens show every state;
 * no provider is called, every name and number is made up. Satisfaction surveys, review request batches and public reviews are switched on for the workspace, as a Super Admin
 * would; the public reviews come from the app's own made-up review site (Simulated badge), never from Google or Facebook.
 *
 *   node scripts/run-inbox-qa-seed.mjs        (first, once)
 *   node scripts/run-reputation-qa-seed.mjs   (this; with the QA server stopped)
 *
 * Idempotent, section by section: batches are added only when the workspace has no review request batch, and public reviews only when it has no review site connection.
 */
import fs from "node:fs";
import path from "node:path";
import { it } from "vitest";
import { closeDb, withSystem } from "../src/server/db/index";
import { env } from "../src/server/env";
import { memberActor, type CrmActor } from "../src/server/crm/actor";
import { createContact, setContactConsent } from "../src/server/crm/contacts";
import { approveTemplate, createTemplate, updateTemplate } from "../src/server/crm/message-templates";
import { createReviewDestination, requestReview, reviewTokenFor, submitReviewFeedback } from "../src/server/crm/reviews";
import { suppressAddress } from "../src/server/messaging/contacts";
import { approveBatch, cancelBatch, createBatch, pauseBatch, previewBatch, requestBatchApproval } from "../src/server/reputation/batches";
import { advanceBatch } from "../src/server/reputation/batch-job";
import { dayIn } from "../src/lib/reputation/ask-criteria";
import { connectSimulatedAccount } from "../src/server/social/accounts";
import { connectFacebookPage, connectSimulatedSite } from "../src/server/reputation/connections";
import { syncConnection } from "../src/server/reputation/sync";
import { decideReply, postReply, resolveReply, startReply, submitReply, insertReply } from "../src/server/reputation/replies";
import { saveReputationSettings } from "../src/server/reputation/settings";
import { simulatedReviews } from "../src/server/reputation/providers/simulated";
import { REPLY_AI_PROMPT_VERSION } from "../src/lib/reputation/reply-draft";
import { permissionsFor, roleHasPermission, type OrgRole } from "../src/lib/permissions";
import type { Membership, OrgContext } from "../src/server/tenancy/context";

const ORG_NAME = "Harbor Home Services (Inbox QA)";
const TIMEZONE = "America/Chicago";
const SUMMARY_FILE = path.resolve(".data/crm-qa/reputation-seed-summary.json");
const qaDataDir = () => (process.env.PGLITE_DATA_DIR ?? "").replace(/\\/g, "/");

function assertIsolated() {
  const e = env();
  if (e.NODE_ENV === "production" || e.AUTH_PROVIDER !== "local" || e.DATABASE_DRIVER !== "pglite" || (e.DATABASE_URL ?? "") !== "" || !qaDataDir().startsWith(".data/crm-qa/")) {
    throw new Error("Refusing to seed outside the isolated QA database (local sign-in, embedded pglite in .data/crm-qa). Use node scripts/run-reputation-qa-seed.mjs.");
  }
}
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;

function ctxFor(user: { id: string; email: string; full_name: string }, org: { id: string; name: string; slug: string }, role: OrgRole): OrgContext {
  const membership: Membership = { orgId: org.id, name: org.name, slug: org.slug, kind: "client", status: "active", role, isDemo: false, onboardingCompletedAt: null, timezone: TIMEZONE };
  return {
    user: { sessionId: "qa", id: user.id, email: user.email, fullName: user.full_name, platformRole: "none", timezone: TIMEZONE, preferences: {}, emailVerified: true },
    org: membership, role, permissions: permissionsFor(role), can: (perm) => roleHasPermission(role, perm), memberships: [membership],
  };
}

type Org = { id: string; name: string; slug: string };
const userOf = async (email: string) => (await q<{ id: string; email: string; full_name: string }>("select id, email, full_name from users where email = $1", [email]))[0];
const personCtx = async (org: Org, who: "owner" | "manager" | "sales") => ctxFor(await userOf(`${who}.harbor@example.test`), org, who === "owner" ? "owner" : who === "manager" ? "admin" : "sales_rep");

async function seed() {
  assertIsolated();
  const org = (await q<Org>("select id, name, slug from organizations where name = $1", [ORG_NAME]))[0];
  if (!org) throw new Error("Run node scripts/run-inbox-qa-seed.mjs first: the Inbox QA workspace does not exist.");
  const hasBatches = (await q("select 1 from review_request_batches where org_id = $1", [org.id])).length > 0;
  const hasReviews = (await q("select 1 from review_connections where org_id = $1", [org.id])).length > 0;
  if (hasBatches && hasReviews) {
    console.log("The reputation QA data already exists; nothing added.");
    return;
  }
  if (!hasBatches) await seedBatches(org, memberActor(await personCtx(org, "owner")), memberActor(await personCtx(org, "manager")));
  if (!hasReviews) await seedPublicReviews(org);
}

async function seedBatches(org: Org, owner: CrmActor, manager: CrmActor) {
  // What a Super Admin would switch on for this workspace.
  for (const feature of ["reputation_surveys", "reputation_batches"]) {
    await q("insert into org_features (org_id, feature, enabled) values ($1, $2, true) on conflict (org_id, feature) do update set enabled = true", [org.id, feature]);
  }
  await q("update messaging_policy set quiet_hours_start = '00:00', quiet_hours_end = '00:00'");
  await q("update organizations set timezone = $2 where id = $1", [org.id, TIMEZONE]);

  // Public review links, and two approved service templates that carry the customer's own link.
  if (!(await q("select 1 from crm_review_destinations where org_id = $1", [org.id])).length) {
    await createReviewDestination(owner, { platform: "google", url: "https://g.page/r/harbor-home-qa/review" });
    await createReviewDestination(owner, { platform: "facebook", label: "Review us on Facebook", url: "https://www.facebook.com/harborhomeqa/reviews" });
  }
  const makeTemplate = async (name: string, body: string) => {
    const t = await createTemplate(owner, { name, channel: "sms", purpose: "service", body });
    return approveTemplate(owner, t.id, { version: t.currentVersion, contentHash: t.contentHash });
  };
  const visit = await makeTemplate("How did we do (QA)", "Hi {{contact.first_name}}, thanks for choosing {{business.name}}. How did we do? {{review.link}}");
  const old = await makeTemplate("Old wording (QA)", "Hi {{contact.first_name}}, we'd love to hear about your visit to {{business.name}}. {{review.link}}");

  // Customers: most can be asked; a few cannot, each for a different reason.
  const today = dayIn(TIMEZONE, new Date());
  const day = (n: number) => dayIn(TIMEZONE, new Date(Date.now() - n * 86_400_000));
  const phoneOf = async (id: string) => (await q<{ phone: string }>("select phone from contacts where id = $1", [id]))[0].phone;
  const customer = async (first: string, last: string, i: number, o: { consent?: boolean; email?: string; phone?: boolean } = {}) => {
    const c = await createContact(owner, { firstName: first, lastName: last, ...(o.phone === false ? {} : { phone: `+1512555${String(2000 + i)}` }), ...(o.email ? { email: o.email } : {}) });
    // This workspace sends through GoHighLevel, whose messages need the contact's id there: a made-up one, so the (never-sent) messages can be queued.
    await q("update contacts set ghl_contact_id = $2 where id = $1", [c.id, `qa-ghl-${c.id}`]);
    if (o.consent !== false) await setContactConsent(owner, c.id, { channel: "sms", purpose: "service", status: "granted", evidence: "Signed intake form, QA data." });
    return c.id;
  };
  const attended = async (contactId: string, daysAgo: number) => {
    const ends = new Date(Date.now() - daysAgo * 86_400_000);
    await q(
      "insert into appointment_refs (org_id, ghl_appointment_id, ghl_calendar_id, title, status, start_at, end_at, contact_id) values ($1, $2, 'qa-cal', 'Service visit', 'showed', $3, $4, $5)",
      [org.id, `qa-rep-${contactId}`, new Date(ends.getTime() - 3_600_000).toISOString(), ends.toISOString(), contactId],
    );
  };
  // Twenty-four customers served on each of the last 24 days (one a day), so every batch below has people who can be asked even after the ones before it asked theirs.
  const firsts = ["Imani", "Mateo", "Priya", "Owen", "Lucia", "Dmitri", "Hana", "Tobias", "Amara", "Leo", "Zoe", "Kenji"];
  const lasts = ["Brooks", "Alvarez"];
  for (let i = 0; i < 24; i += 1) {
    const id = await customer(firsts[i % firsts.length], lasts[Math.floor(i / firsts.length)], i);
    await attended(id, 1 + i);
  }
  const noConsent = await customer("Nora", "Whitfield", 120, { consent: false });
  const optedOut = await customer("Felix", "Dorsey", 121);
  const held = await customer("Greta", "Lindqvist", 122);
  const asked = await customer("Samir", "Haddad", 123);
  const emailOnly = await customer("Ivy", "Chen", 124, { phone: false, email: "ivy.chen@example.test" });
  const archived = await customer("Rhea", "Patel", 125);
  for (const [i, id] of [noConsent, optedOut, held, asked, emailOnly, archived].entries()) await attended(id, 3 + i);
  const optedOutPhone = await phoneOf(optedOut);
  await withSystem((db) => suppressAddress(db, { orgId: org.id, channel: "sms", address: optedOutPhone, reason: "opt_out", source: "qa" }));
  await q("update contacts set retention_paused = true where id = $1", [held]);
  await q("update contacts set archived_at = now() where id = $1", [archived]);
  await requestReview(owner, { contactId: asked, templateId: visit.id, contentHash: visit.contentHash, businessHoursOnly: false });

  const base = { source: "appointments_showed", from: day(30), to: today };
  const approve = async (actor: CrmActor, id: string) => {
    const p = await previewBatch(actor, id);
    if (!p.fingerprint) throw new Error(`The batch cannot be approved: ${p.problems.join(" ")}`);
    return approveBatch(owner, id, { fingerprint: p.fingerprint });
  };

  // 1. Under way: approved by the owner, started, three asked a minute, so most are still waiting.
  const running = await createBatch(manager, { name: "Visits in the last 30 days", templateId: visit.id, criteria: base, ratePerMinute: 5 });
  await approve(manager, running.id);
  await advanceBatch(running.id, org.id, new Date());

  // 2. Prepared and waiting for the owner (the manager asked).
  const waiting = await createBatch(manager, { name: "Visits last week", templateId: visit.id, criteria: { ...base, from: day(7) }, ratePerMinute: 10 });
  const wp = await previewBatch(manager, waiting.id);
  await requestBatchApproval(manager, waiting.id, { fingerprint: wp.fingerprint! });

  // 3. A draft nobody has looked at yet.
  await createBatch(manager, { name: "Everyone served this year", templateId: visit.id, criteria: { source: "appointments_showed", from: day(120), to: today }, ratePerMinute: 10 });

  // 4. Approved and not started (the scheduler has not run).
  const approvedOnly = await createBatch(manager, { name: "Visits two to three weeks ago", templateId: visit.id, criteria: { ...base, from: day(21), to: day(14) }, ratePerMinute: 10 });
  await approve(manager, approvedOnly.id);

  // 5. A short satisfaction survey, finished, with a few private answers (one of them low, so the follow-up shows).
  const survey = await createBatch(manager, { name: "How likely to recommend us", templateId: visit.id, kind: "survey", scale: "nps10", criteria: { ...base, from: day(10) }, ratePerMinute: 30 });
  await approve(manager, survey.id);
  await advanceBatch(survey.id, org.id, new Date());
  const surveyRequests = await q<{ id: string }>("select id from crm_review_requests where batch_id = $1 order by created_at", [survey.id]);
  for (const [i, r] of surveyRequests.entries()) {
    if (i > 3) break;
    await submitReviewFeedback(reviewTokenFor(r.id), { rating: [9, 10, 4, 8][i], comment: i === 2 ? "The technician was late and nobody called ahead." : undefined });
  }

  // 6. Stopped by itself: approved under older wording, started, and then the wording was edited.
  const stopped = await createBatch(manager, { name: "Old wording batch", templateId: old.id, criteria: { ...base, from: day(14) }, ratePerMinute: 3 });
  await approve(manager, stopped.id);
  await advanceBatch(stopped.id, org.id, new Date());
  await updateTemplate(owner, old.id, { body: "Hi {{contact.first_name}}, a new draft nobody approved yet. {{review.link}}" });
  await advanceBatch(stopped.id, org.id, new Date(Date.now() + 61_000));

  // 7. Paused by a person, and one that was thrown away.
  const paused = await createBatch(manager, { name: "Paused for the holiday", templateId: visit.id, criteria: { ...base, from: day(25), to: day(20) }, ratePerMinute: 10 });
  await approve(manager, paused.id);
  await pauseBatch(manager, paused.id);
  const cancelled = await createBatch(manager, { name: "Wrong dates", templateId: visit.id, criteria: base, ratePerMinute: 10 });
  await cancelBatch(manager, cancelled.id);

  // A couple of the queued messages "went" and one customer opened their page, so the progress shows sent and opened.
  await q(
    `update conversation_messages set status = 'sent', sent_at = now() where id in (select message_id from crm_review_requests where batch_id = $1 and message_id is not null order by created_at limit 3)`,
    [running.id],
  );
  await q(`update crm_review_requests set opened_at = now(), status = 'opened' where id = (select id from crm_review_requests where batch_id = $1 order by created_at limit 1)`, [running.id]);

  fs.mkdirSync(path.dirname(SUMMARY_FILE), { recursive: true });
  fs.writeFileSync(SUMMARY_FILE, JSON.stringify({ orgId: org.id, batches: { running: running.id, waiting: waiting.id, approved: approvedOnly.id, survey: survey.id, stopped: stopped.id, paused: paused.id, cancelled: cancelled.id } }, null, 2));
  console.log("Reputation QA data is ready (surveys and batches switched on; eight batches: under way, waiting for the owner, a draft, approved, a survey, stopped, paused and cancelled).");
}

const CALM = "Thank you for taking the time to write this. We would like to hear more, and you can find how to reach us on our listing.";

/**
 * Public reviews, on the made-up review site that ships with the app: a Google location and (where the workspace has a Facebook Page for Social media) a Page, each read once, with
 * replies in every state a reply can be in. The reviews are the simulated site's fixed samples, so they carry the Simulated badge and reading the site again from the QA server
 * changes nothing. NOTHING is sent anywhere. (A reply "posted" here reached only this process's made-up site; the QA server's own copy of it starts empty, so reading the site
 * again there shows the reply as the person's word, not as something the site holds.)
 */
async function seedPublicReviews(org: Org) {
  const owner = memberActor(await personCtx(org, "owner"));
  const manager = memberActor(await personCtx(org, "manager"));
  const sales = memberActor(await personCtx(org, "sales"));
  await q("insert into org_features (org_id, feature, enabled) values ($1, 'reputation_reviews', true) on conflict (org_id, feature) do update set enabled = true", [org.id]);
  const version = (await q<{ version: number }>("select version from reputation_settings where org_id = $1", [org.id]))[0]?.version ?? 0;
  await saveReputationSettings(owner, { aiRepliesEnabled: true, replyStyleNote: "Warm, brief and plain. No exclamation marks.", renewalRemindersEnabled: true, publicReviewAlertAtOrBelow: 3 }, version);

  const reviewIn = async (connectionId: string, n: number) =>
    (await q<{ id: string }>("select id from external_reviews where connection_id = $1 and provider_review_id like $2", [connectionId, `%-${n}`]))[0].id;
  const approved = async (reviewId: string, body = CALM) => {
    const { id } = await startReply(sales, reviewId, { body });
    await submitReply(sales, id, { version: 1 });
    await decideReply(manager, id, { decision: "approve", version: 1, note: "Fine to post." });
    return id;
  };

  const google = await connectSimulatedSite(owner, { provider: "google", name: "Harbor Home Services (test Google location)" });
  await syncConnection(google.id);
  // 1: approved and ready for the owner to post. 2: waiting for the owner. 3: already answered on the site. 4: posted (the owner's word). 5: AI-drafted. 6: sent, and the answer was lost.
  await approved(await reviewIn(google.id, 1));
  const waiting = await startReply(sales, await reviewIn(google.id, 2), { body: "We are sorry the wait was long. The team would like to hear more, and you can find how to reach us on our listing." });
  await submitReply(sales, waiting.id, { version: 1 });
  const posted = await approved(await reviewIn(google.id, 4), "Thank you, we are glad it went well and we will pass your kind words on to the team.");
  simulatedReviews.setReplySupport(false);
  await resolveReply(owner, posted, { outcome: "posted" });
  simulatedReviews.setReplySupport(true);
  const draftedFor = await reviewIn(google.id, 5);
  await withSystem(async (db) => {
    const id = await insertReply(db, {
      orgId: org.id, reviewId: draftedFor, body: "We are sorry to hear this and thank you for telling us. The team would like to understand what happened, and you can find how to reach us on our listing.",
      origin: "ai", authorId: sales.userId as string, aiMeta: { promptVersion: REPLY_AI_PROMPT_VERSION, knowledgeSections: ["brand_voice"], warnings: [], checks: ["rules", "claims"] },
    });
    await db.query("insert into review_reply_events (org_id, reply_id, kind, actor_kind, detail) values ($1, $2, 'ai_drafted', 'ai', $3::jsonb)", [org.id, id, JSON.stringify({ requestedBy: sales.userId })]);
    return id;
  });
  const lost = await approved(await reviewIn(google.id, 6), "Thank you for your review. We take every comment seriously and the team will read it.");
  simulatedReviews.loseResponseNext("reply");
  await postReply(owner, lost);

  let facebook = "skipped";
  try {
    // The Page the workspace already connected for Social media, when the other QA data made one; otherwise a made-up one.
    const existing = (await q<{ id: string }>("select id from social_accounts where org_id = $1 and platform = 'facebook' and status = 'connected' and adapter = 'simulated' order by created_at limit 1", [org.id]))[0];
    const social = existing ?? (await connectSimulatedAccount(await personCtx(org, "owner"), { platform: "facebook", name: "Harbor Home Services" }));
    const page = await connectFacebookPage(owner, social.id);
    await syncConnection(page.id);
    // Posting replies to a Facebook Page is not offered for this connection, so an approved reply waits for a person to post it on the site and say so.
    await approved(await reviewIn(page.id, 2));
    facebook = "connected";
  } catch (err) {
    console.log(`The Facebook test connection was skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
  console.log(`Public reviews QA data is ready (public reviews switched on; a test Google location read once; replies: approved, waiting for the owner, posted on the owner's word, AI-drafted and not yet sent, and one whose result is being checked; Facebook ${facebook}).`);
}

it.skipIf(!qaDataDir().startsWith(".data/crm-qa/"))("seeds fictional reputation data into the isolated QA database", async () => {
  try {
    await seed();
  } finally {
    await closeDb();
  }
}, 240_000);
