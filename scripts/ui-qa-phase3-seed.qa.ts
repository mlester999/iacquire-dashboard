/**
 * Fictional website-chat and lead-source data for isolated local browser QA, added on top of the Unified Inbox QA workspace
 * ("Harbor Home Services (Inbox QA)"). It writes through the application's own services into the embedded QA database and sends nothing
 * anywhere: no provider is configured, every send switch is off, and the visitor chats are answered by a local stand-in (no language model is
 * contacted). Every name, email (example.test) and phone number (555-01xx) is made up.
 *
 *   node scripts/run-inbox-qa-seed.mjs      (first, once)
 *   node scripts/run-phase3-qa-seed.mjs     (this; with the QA server stopped)
 *
 * Idempotent: when the workspace already has a website-chat widget it adds nothing.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { it } from "vitest";
import { closeDb, withSystem } from "../src/server/db/index";
import { env } from "../src/server/env";
import { memberActor } from "../src/server/crm/actor";
import { createContact } from "../src/server/crm/contacts";
import { ensureWidget, saveWidgetSettings } from "../src/server/webchat/config";
import { handleWebChat, type ChatResponse } from "../src/server/webchat/http";
import { recordTouch, recordManualTouch } from "../src/server/attribution/touches";
import { addCost } from "../src/server/attribution/costs";
import type { ReplyGenerator } from "../src/server/messaging/responder";
import { permissionsFor, roleHasPermission, type OrgRole } from "../src/lib/permissions";
import type { Membership, OrgContext } from "../src/server/tenancy/context";

const ORG_NAME = "Harbor Home Services (Inbox QA)";
/** The page the browser run serves the widget from: a different origin from the portal, as a customer's own website would be. */
const EMBED_HOST = "localhost";
const EMBED_ORIGIN = "http://localhost:3280";
const SUMMARY_FILE = path.resolve(".data/crm-qa/phase3-seed-summary.json");
const qaDataDir = () => (process.env.PGLITE_DATA_DIR ?? "").replace(/\\/g, "/");

function assertIsolated() {
  const e = env();
  if (e.NODE_ENV === "production" || e.AUTH_PROVIDER !== "local" || e.DATABASE_DRIVER !== "pglite" || (e.DATABASE_URL ?? "") !== "" || !qaDataDir().startsWith(".data/crm-qa/")) {
    throw new Error("Refusing to seed outside the isolated QA database (local sign-in, embedded pglite in .data/crm-qa). Use node scripts/run-phase3-qa-seed.mjs.");
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

const say = (text: string): ReplyGenerator => async () => ({ kind: "reply", text });

async function seed() {
  assertIsolated();
  const org = (await q<{ id: string; name: string; slug: string }>("select id, name, slug from organizations where name = $1", [ORG_NAME]))[0];
  if (!org) throw new Error("Run node scripts/run-inbox-qa-seed.mjs first: the Inbox QA workspace does not exist.");
  if ((await q("select 1 from web_chat_widgets where org_id = $1", [org.id])).length) {
    console.log("The Phase 3 QA data already exists; nothing added.");
    return;
  }
  const ownerUser = (await q<{ id: string; email: string; full_name: string }>("select id, email, full_name from users where email = 'owner.harbor@example.test'"))[0];
  const ctx = ctxFor(ownerUser, org, "owner");
  const owner = memberActor(ctx);

  // The widget: on, for the one page the browser run serves it from.
  const initial = await withSystem((db) => ensureWidget(db, org.id));
  const widget = await saveWidgetSettings(ctx, {
    enabled: true, allowedOrigins: [EMBED_HOST], title: "Chat with Harbor", launcherLabel: "Chat", brandColor: "#1d4ed8",
    welcomeMessage: "Hi! Ask about repairs, tune-ups or booking a visit.", leadForm: "offer", offerMarketingOptIn: true,
    qualificationQuestions: [
      { label: "What do you need help with?", kind: "choice", choices: ["AC repair", "Plumbing", "Something else"], required: true },
      { label: "How soon?", kind: "text", required: false },
    ],
  }, initial.version);

  let n = 0;
  const call = (action: string, token: string | null, body: unknown, generate?: ReplyGenerator, method?: string): Promise<ChatResponse> =>
    handleWebChat({
      action, method: method ?? (action === "config" || action === "messages" ? "GET" : "POST"),
      surface: { kind: "embed", key: widget.publicKey, origin: EMBED_ORIGIN }, token, address: `203.0.113.${10 + ++n}`, query: new URLSearchParams(), body, generate, replyTimeoutMs: 20_000,
    });
  const begin = async (landing: string, referrer: string) => {
    const r = await call("session", null, { landing, referrer, timezone: "America/Chicago" });
    const token = (r.body as { token?: string }).token;
    if (!token) throw new Error(`session did not start: ${JSON.stringify(r.body)}`);
    return token;
  };
  const send = (token: string, text: string, reply: string) => call("send", token, { text, clientMessageId: crypto.randomBytes(9).toString("base64url") }, say(reply));

  // 1. A visitor from a paid search ad who only asks a question and leaves no details.
  const t1 = await begin("/services/ac-repair?utm_source=google&utm_medium=cpc&utm_campaign=spring-tuneup", "https://www.google.com/");
  await send(t1, "Do you repair older central air units?", "We repair most central air systems, including older ones. A technician can look at yours on a visit.");
  await send(t1, "Is the visit free?", "I don't have a confirmed price for a visit to share here. A team member can tell you the details.");

  // 2. A visitor who leaves details and answers the questions, then asks for a person.
  const t2 = await begin("/contact", "https://www.facebook.com/");
  await send(t2, "My water heater is leaking, can someone come today?", "I'm sorry about the leak. Let me take your details so the team can get back to you quickly.");
  await call("lead", t2, { details: { name: "Priya Raman", email: "priya.raman@example.test", phone: "+15125550177" }, privacyAck: true, marketingOptIn: false, answers: { what_do_you_need_help_with: "Plumbing", how_soon: "Today" } });
  await call("handoff", t2, { reason: "Water is leaking now" });

  // 3. A visitor whose typed email matches a contact the business already has: a hint to review, never a link.
  const existing = await createContact(owner, { displayName: "Dana Whitfield", email: "dana.whitfield@example.test", phone: "+15125550178" });
  const t3 = await begin("/pricing", "");
  await send(t3, "Hi, I'm looking to renew my maintenance plan", "Thanks for getting in touch. I can pass your request to the team.");
  await call("lead", t3, { details: { name: "Dana W.", email: "dana.whitfield@example.test" }, privacyAck: true, marketingOptIn: true, answers: { what_do_you_need_help_with: "Something else" } });

  // Lead sources: contacts that arrived by other routes, so the report has something to count. Each touch says exactly what it carried.
  const lead = async (name: string, phone: string) => (await createContact(owner, { displayName: name, phone })).id;
  const touch = (contactId: string, over: Parameters<typeof recordTouch>[1]["facts"], daysAgo: number, ref: string) =>
    withSystem((db) => recordTouch(db, { orgId: org.id, contactId, facts: over, occurredAt: new Date(Date.now() - daysAgo * 86_400_000), ref: { type: "website_submission", id: ref } }));
  const g1 = await lead("Jordan Ellis", "+15125550180");
  await touch(g1, { kind: "website_form", attribution: { utm_source: "google", utm_medium: "cpc", utm_campaign: "spring-tuneup", landing_page: "/services/ac-repair" } }, 6, "qa-form-1");
  const g2 = await lead("Casey Moreno", "+15125550181");
  await touch(g2, { kind: "website_form", attribution: { utm_source: "google", utm_medium: "cpc", utm_campaign: "water-heaters", landing_page: "/services/plumbing" } }, 12, "qa-form-2");
  const f1 = await lead("Riley Chen", "+15125550182");
  await touch(f1, { kind: "website_form", attribution: { utm_source: "facebook", utm_medium: "paid_social", utm_campaign: "summer-offer" } }, 9, "qa-form-3");
  const r1 = await lead("Morgan Bell", "+15125550183");
  await touch(r1, { kind: "website_form", attribution: { referrer: "https://www.bing.com/search" } }, 15, "qa-form-4");
  const c1 = await lead("Taylor Quinn", "+15125550184");
  await withSystem((db) => recordTouch(db, { orgId: org.id, contactId: c1, facts: { kind: "call" }, occurredAt: new Date(Date.now() - 4 * 86_400_000), ref: { type: "call", id: "qa-call-attr-1" } }));
  const m1 = await lead("Avery Stone", "+15125550185");
  await recordManualTouch(owner, { contactId: m1, source: "Referral", campaign: "Neighbour recommendation" });
  // A late first touch: a contact whose first recorded source arrives after a later one.
  const l1 = await lead("Sky Patel", "+15125550186");
  await touch(l1, { kind: "website_form", attribution: { utm_source: "newsletter", utm_medium: "email" } }, 3, "qa-form-5");
  await touch(l1, { kind: "website_form", attribution: { utm_source: "google", utm_medium: "organic" } }, 20, "qa-form-6");
  // Nothing recorded: a contact with no touch at all stays visibly "no source recorded", never "direct".
  await lead("Robin Hale", "+15125550187");

  // Campaign costs somebody typed in: one that sits wholly inside the default 30 days, one that does not.
  const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
  await addCost(owner, { source: "google", campaign: "spring-tuneup", periodStart: day(25), periodEnd: day(2), amount: 480, currency: "USD", note: "Search ads, from the invoice" });
  await addCost(owner, { source: "facebook", periodStart: day(80), periodEnd: day(50), amount: 220, currency: "USD", note: "Boosted posts" });

  fs.mkdirSync(path.dirname(SUMMARY_FILE), { recursive: true });
  fs.writeFileSync(SUMMARY_FILE, JSON.stringify({ orgId: org.id, widgetKey: widget.publicKey, embedOrigin: EMBED_ORIGIN, matchedContactId: existing.id }, null, 2));
  console.log("Phase 3 QA data is ready (widget on for localhost, three visitor chats, nine sourced contacts, two entered costs).");
}

it.skipIf(!qaDataDir().startsWith(".data/crm-qa/"))("seeds fictional website-chat and lead-source data into the isolated QA database", async () => {
  try {
    await seed();
  } finally {
    await closeDb();
  }
}, 240_000);
