/**
 * Fictional Unified Inbox data for isolated local browser QA. It writes through the application's own services into the embedded QA
 * database (.data/crm-qa/database) and sends nothing anywhere: no provider is configured, every send switch is off, and message history is
 * recorded through the same paths the product uses with a stand-in provider that answers locally (nothing leaves this process). Every name,
 * email (example.test) and phone number (555-01xx) is made up. Run it with the QA server stopped:
 *
 *   node scripts/run-inbox-qa-seed.mjs
 *
 * Idempotent: when the QA workspace already exists it adds nothing. Local passwords go to .data/crm-qa/inbox-credentials.local.json
 * (gitignored, never printed); ids go to .data/crm-qa/inbox-seed-summary.json.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { it } from "vitest";
import { closeDb, withSystem } from "../src/server/db/index";
import { env } from "../src/server/env";
import { hashPassword } from "../src/server/security/crypto";
import { adjustCredits } from "../src/server/billing/ledger";
import { ensureAgentInstances } from "../src/server/workforce/service";
import { ingestInbound } from "../src/server/messaging/ingest";
import { dispatchMessage, queueOutbound, applyDeliveryEvent } from "../src/server/messaging/send";
import { assignConversation, createEscalation, takeOverConversation } from "../src/server/messaging/handoff";
import { pauseAi } from "../src/server/messaging/ai-control";
import { addInternalNote, setConversationState } from "../src/server/messaging/inbox";
import { addMemory } from "../src/server/messaging/contacts";
import { memberActor } from "../src/server/crm/actor";
import { createCompany } from "../src/server/crm/companies";
import { linkContactCompany } from "../src/server/crm/contacts";
import { createTag } from "../src/server/crm/tags";
import { addNote } from "../src/server/crm/notes";
import { createOpportunity } from "../src/server/crm/opportunities";
import { createTask } from "../src/server/crm/tasks";
import { logCall } from "../src/server/crm/calls";
import { permissionsFor, roleHasPermission, type OrgRole } from "../src/lib/permissions";
import type { Membership, OrgContext } from "../src/server/tenancy/context";

const DATA_DIR = path.resolve(".data/crm-qa");
const CRED_FILE = path.join(DATA_DIR, "inbox-credentials.local.json");
const SUMMARY_FILE = path.join(DATA_DIR, "inbox-seed-summary.json");
const ORG_NAME = "Harbor Home Services (Inbox QA)";
const OTHER_ORG_NAME = "Other Tenant (Inbox QA)";

const qaDataDir = () => (process.env.PGLITE_DATA_DIR ?? "").replace(/\\/g, "/");

function assertIsolated() {
  const e = env();
  if (e.NODE_ENV === "production" || e.AUTH_PROVIDER !== "local" || e.DATABASE_DRIVER !== "pglite" || (e.DATABASE_URL ?? "") !== "" || !qaDataDir().startsWith(".data/crm-qa/")) {
    throw new Error("Refusing to seed outside the isolated QA database (local sign-in, embedded pglite in .data/crm-qa). Use node scripts/run-inbox-qa-seed.mjs.");
  }
}

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T>(sql, params))).rows;
const password = () => `${crypto.randomBytes(18).toString("base64url")}-Qa9`;

type Who = "owner" | "manager" | "sales" | "support" | "viewer";
const ROLE: Record<Who, OrgRole> = { owner: "owner", manager: "admin", sales: "sales_rep", support: "support", viewer: "viewer" };
const NAME: Record<Who, string> = { owner: "Olivia Owner", manager: "Mia Manager", sales: "Sam Sales", support: "Sue Support", viewer: "Vic Viewer" };

interface Person { id: string; email: string; name: string }

async function createOrg(name: string) {
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      "insert into organizations (name, slug, kind, status, timezone, onboarding_completed_at) values ($1, $2, 'client', 'active', 'America/Chicago', now()) returning id",
      [name, slug],
    );
    const id = rows[0].id;
    await db.query("insert into company_profiles (org_id, description) values ($1, 'We repair roofs and gutters for local homeowners.')", [id]);
    await db.query("insert into usage_limits (org_id) values ($1)", [id]);
    await db.query("insert into billing_accounts (org_id) values ($1)", [id]);
    await db.query("insert into onboarding_responses (org_id) values ($1) on conflict do nothing", [id]);
    await ensureAgentInstances(id, db);
    return { id, name, slug };
  });
}

async function createPerson(orgId: string, who: Who, slug: string, creds: Record<string, { email: string; password: string; name: string }>): Promise<Person> {
  const email = `${who}.${slug}@example.test`;
  const pw = password();
  const person = await withSystem(async (db) => {
    const { rows } = await db.query<{ id: string }>("insert into users (email, full_name, email_verified_at, platform_role, timezone) values ($1, $2, now(), 'none', 'America/Chicago') returning id", [email, NAME[who]]);
    await db.query("insert into auth_credentials (user_id, password_hash) values ($1, $2)", [rows[0].id, await hashPassword(pw)]);
    await db.query("insert into organization_memberships (org_id, user_id, role) values ($1, $2, $3)", [orgId, rows[0].id, ROLE[who]]);
    return { id: rows[0].id, email, name: NAME[who] };
  });
  creds[`${slug}:${who}`] = { email, password: pw, name: NAME[who] };
  return person;
}

function ctxFor(p: Person, org: { id: string; name: string; slug: string }, who: Who): OrgContext {
  const role = ROLE[who];
  const membership: Membership = { orgId: org.id, name: org.name, slug: org.slug, kind: "client", status: "active", role, isDemo: false, onboardingCompletedAt: null, timezone: "America/Chicago" };
  return {
    user: { sessionId: "qa", id: p.id, email: p.email, fullName: p.name, platformRole: "none", timezone: "America/Chicago", preferences: {}, emailVerified: true },
    org: membership,
    role,
    permissions: permissionsFor(role),
    can: (perm) => roleHasPermission(role, perm),
    memberships: [membership],
  };
}

async function prepareMessaging(orgId: string, ownerId: string) {
  await withSystem(async (db) => {
    await db.query("insert into messaging_settings (org_id, auto_reply_enabled) values ($1, true) on conflict (org_id) do update set auto_reply_enabled = true", [orgId]);
    await db.query("update messaging_policy set quiet_hours_start = '00:00', quiet_hours_end = '00:00'");
    for (const channel of ["sms", "whatsapp", "email"] as const) {
      await db.query(
        `insert into messaging_channels (org_id, channel, enabled, sender_identity, sender_verified_at, registration_status, detail)
         values ($1, $2, true, $3, now(), $4, 'Synthetic QA sender') on conflict (org_id, channel) do nothing`,
        [orgId, channel, channel === "email" ? "hello@harbor-qa.example.test" : "+15125550100", channel === "email" ? "not_required" : "approved"],
      );
    }
    await db.query("insert into whatsapp_templates (org_id, template_id, name, body, status) values ($1, 'tmpl_checkin', 'Appointment check-in', 'Hi, just checking you can still make your visit.', 'approved') on conflict do nothing", [orgId]);
    await db.query("update agent_instances set status = 'online', last_health_ok = true, enabled = true, mode = 'autonomous' where org_id = $1 and role_key in ('sales_assistant', 'appointment_setter')", [orgId]);
    const rate = (await db.query<{ id: string }>("select id from usage_rate_versions order by version desc limit 1")).rows[0];
    if (rate) {
      for (const [unit, w, c] of [["sms_segment", 8000, 10400], ["whatsapp_message", 5000, 6500], ["email_send", 1000, 1300]] as const) {
        await db.query("insert into usage_unit_rates (rate_version_id, provider, unit_type, unit_label, wholesale_micros_per_unit, client_micros_per_unit) values ($1, 'ghl', $2, $2, $3, $4) on conflict do nothing", [rate.id, unit, w, c]);
      }
    }
    await adjustCredits(db, { orgId, deltaMicros: 25_000_000, reason: "synthetic QA credits", userId: ownerId, idempotencyKey: `qa-inbox-credit-${orgId}` }).catch(() => undefined);
  });
}

async function seed() {
  assertIsolated();
  if ((await q("select 1 from organizations where name = $1", [ORG_NAME])).length) {
    console.log("The Inbox QA workspace already exists; nothing added.");
    return;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const creds: Record<string, { email: string; password: string; name: string }> = {};

  const org = await createOrg(ORG_NAME);
  const people = {} as Record<Who, Person>;
  for (const who of Object.keys(ROLE) as Who[]) people[who] = await createPerson(org.id, who, "harbor", creds);
  fs.writeFileSync(CRED_FILE, JSON.stringify({ note: "Local-only passwords for the isolated QA database.", users: creds }, null, 2));
  const ctx = (who: Who) => ctxFor(people[who], org, who);
  await prepareMessaging(org.id, people.owner.id);
  const agents = Object.fromEntries((await q<{ id: string; role_key: string }>("select id, role_key from agent_instances where org_id = $1", [org.id])).map((a) => [a.role_key, a.id]));

  const other = await createOrg(OTHER_ORG_NAME);
  const otherOwner = await createPerson(other.id, "owner", "other", creds);
  fs.writeFileSync(CRED_FILE, JSON.stringify({ note: "Local-only passwords for the isolated QA database.", users: creds }, null, 2));
  await prepareMessaging(other.id, otherOwner.id);

  const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000);
  let n = 0;
  const inbound = (channel: "sms" | "whatsapp" | "email", address: string, name: string, body: string, hoursAgo: number, subject?: string, orgId = org.id) =>
    withSystem((db) => ingestInbound(db, { orgId, provider: "ghl", channel, address, name, body, providerMessageId: `qa-in-${++n}`, ghlContactId: `qa_ghl_${address.replace(/\W/g, "")}`, receivedAt: ago(hoursAgo), subject }));
  /** A reply that reaches a stand-in provider, which answers locally. "ok" is accepted (then delivered), "refused" is rejected, "silent" never confirms. */
  const reply = async (conversationId: string, body: string, kind: "ok" | "refused" | "silent", as: "ai" | Who = "ai", hoursAgo?: number) => {
    const q2 = await withSystem((db) =>
      queueOutbound(db, { orgId: org.id, conversationId, scope: as === "ai" ? "reply" : "human", actor: as === "ai" ? { kind: "ai", agentId: agents.sales_assistant } : { kind: "human", userId: people[as].id }, body }),
    );
    const pid = `qa-out-${++n}`;
    await dispatchMessage(q2.messageId, {
      provider: {
        name: "ghl",
        send: async () => (kind === "ok" ? { ok: true, providerMessageId: pid } : kind === "refused" ? { ok: false, retryable: false, error: "The provider rejected the message (number not reachable)." } : { ok: false, retryable: false, error: "The provider did not answer. The message was not confirmed sent." }),
      },
    });
    if (kind === "ok") await withSystem((db) => applyDeliveryEvent(db, { provider: "ghl", providerEventId: `qa-ev-${n}`, providerMessageId: pid, status: "delivered" }));
    // The seed runs in a moment, but the thread should read as it would have over hours: the reply is stamped just after the message it answers.
    if (hoursAgo !== undefined) {
      const at = ago(hoursAgo);
      await q(
        "update conversation_messages set created_at = $2, sent_at = case when sent_at is null then null else $2 end, delivered_at = case when delivered_at is null then null else $2 end, failed_at = case when failed_at is null then null else $2 end, status_changed_at = $2 where id = $1",
        [q2.messageId, at],
      );
    }
    return q2.messageId;
  };

  // 1. An AI-handled SMS thread with a delivered reply and a new unread message. The customer record is rich (company, deal, task, note, call).
  const maria = await inbound("sms", "+15125550101", "Maria Santos", "Hi! Do you have an inspection slot this week?", 6);
  await reply(maria.conversationId, "Hi Maria, I'm the AI assistant for Harbor Home Services. We have Thursday 10am and Friday 2pm open. Which suits you?", "ok", "ai", 5.9);
  await inbound("sms", "+15125550101", "Maria Santos", "Thursday 10am works. Can you also tell me what a gutter replacement costs?", 1.5);
  await addMemory(ctx("owner"), { contactId: maria.contactId, kind: "confirmed_fact", content: "Owns a two-storey house; prefers morning visits." });
  const owner = memberActor(ctx("owner"));
  const company = await createCompany(owner, { name: "Santos Family Rentals" });
  await linkContactCompany(owner, { contactId: maria.contactId, companyId: company.id, title: "Owner" });
  const tag = await createTag(owner, { name: "Gutters", color: "#2563eb" });
  void tag;
  await addNote(owner, "contact", maria.contactId, "Referred by the Cruz family. Wants a written quote before deciding.");
  await createOpportunity(owner, { name: "Gutter replacement: Santos house", contactId: maria.contactId, value: 2400, source: "inbox" });
  await createTask(owner, { title: "Send Maria the gutter quote", contactId: maria.contactId, priority: "high", dueAt: new Date(Date.now() + 86_400_000).toISOString(), assigneeId: people.sales.id });
  await logCall(owner, { contactId: maria.contactId, direction: "inbound", status: "completed", startedAt: ago(48).toISOString(), durationSeconds: 312, summary: "Asked about storm damage after last week's hail." }).catch((e) => console.warn("call not seeded:", e instanceof Error ? e.message : e));
  await q(
    "insert into appointment_refs (org_id, ghl_appointment_id, ghl_calendar_id, title, status, start_at, end_at, contact_id) values ($1, 'qa-appt-1', 'qa-cal', 'Roof inspection', 'confirmed', $2, $3, $4)",
    [org.id, new Date(Date.now() + 2 * 86_400_000), new Date(Date.now() + 2 * 86_400_000 + 3_600_000), maria.contactId],
  ).catch((e) => console.warn("appointment not seeded:", e instanceof Error ? e.message : e));

  // 2. An email thread, waiting on the customer (we replied last).
  const lena = await inbound("email", "lena.park@example.test", "Dr. Lena Park", "Could you send over your warranty terms for a full roof replacement?", 30, "Warranty terms");
  await reply(lena.conversationId, "Hello Dr. Park, our warranty covers workmanship for 10 years. I've attached the full terms for your records.", "ok", "ai", 29.5);
  await q("update conversations set unread_count = 0 where id = $1", [lena.conversationId]);

  // 3. A WhatsApp customer whose reply window has closed.
  const carlos = await inbound("whatsapp", "+15125550103", "Carlos Rivera", "Is the Saturday viewing still on?", 40);
  await q("update conversations set unread_count = 1 where id = $1", [carlos.conversationId]);

  // 4. A person's request: an escalation waiting on the owner's priority window.
  const dana = await inbound("sms", "+15125550104", "Dana Whitfield", "I'm done waiting. Can I speak to a real person about my refund?", 0.3);
  void dana;

  // 5. A conversation a person owns, with an internal note and a sent message.
  const james = await inbound("sms", "+15125550105", "James O'Neil", "I was charged twice last month. Please check.", 26);
  await assignConversation(ctx("manager"), james.conversationId, people.support.id);
  await takeOverConversation(ctx("manager"), james.conversationId, "Billing question");
  await reply(james.conversationId, "Hi James, it's Mia. I'm checking the invoices now and will come back to you today.", "ok", "manager", 25);
  await addInternalNote(ctx("manager"), james.conversationId, "Looks like a duplicate card authorization. Waiting on the bank statement.");
  await q("update conversation_messages set created_at = $2 where conversation_id = $1 and direction = 'internal'", [james.conversationId, ago(24.5)]);
  await q("update conversations set unread_count = 0 where id = $1", [james.conversationId]);

  // 6. A reply the provider refused, and another that was never confirmed.
  const priya = await inbound("sms", "+15125550106", "Priya Nair", "Please confirm my appointment time.", 5);
  await takeOverConversation(ctx("manager"), priya.conversationId);
  await reply(priya.conversationId, "Hi Priya, you're booked for Thursday at 10am.", "refused", "manager", 4.9);
  const omar = await inbound("sms", "+15125550107", "Omar Haddad", "What time will your crew arrive tomorrow?", 4);
  await takeOverConversation(ctx("manager"), omar.conversationId);
  await reply(omar.conversationId, "Hi Omar, the crew arrives between 8 and 9am.", "silent", "manager", 3.9);

  // 7. A conversation with the AI paused, and an unassigned one with no AI employee.
  const tess = await inbound("sms", "+15125550108", "Tess Lindqvist", "Can you look at a leak above my garage?", 3);
  await pauseAi(ctx("manager"), tess.conversationId, "Owner wants to call her first");
  const noah = await inbound("email", "noah.kim@example.test", "Noah Kim", "Quote request: new roof on a small cabin", 2, "New roof quote");
  await q("update conversations set owner_kind = 'unassigned', ai_agent_id = null where id = $1", [noah.conversationId]);

  // 8. Resolved with an outcome, and archived.
  const ruth = await inbound("sms", "+15125550109", "Ruth Aquino", "Thanks, the gutter fix looks great!", 70);
  await q("update conversations set unread_count = 0 where id = $1", [ruth.conversationId]);
  await setConversationState(ctx("manager"), ruth.conversationId, { status: "closed", outcome: "answered" });
  const old = await inbound("sms", "+15125550110", "Walter Novak", "No thanks, we went with someone else.", 200);
  await q("update conversations set unread_count = 0 where id = $1", [old.conversationId]);
  await setConversationState(ctx("manager"), old.conversationId, { status: "closed", outcome: "not_a_fit", archived: true });

  // 9. A customer who opted out.
  const ben = await inbound("sms", "+15125550111", "Ben Okafor", "Thanks for the info.", 80);
  await inbound("sms", "+15125550111", "Ben Okafor", "STOP", 79);
  await q("update conversations set unread_count = 0 where id = $1", [ben.conversationId]);

  // 10. A long thread to scroll, and an AI draft waiting for approval.
  const long = await inbound("sms", "+15125550112", "Grace Lim", "Hello, I have a few questions about my roof.", 100);
  for (let i = 1; i <= 24; i += 1) {
    await inbound("sms", "+15125550112", "Grace Lim", `Question ${i}: how long does a shingle repair usually take, and does weather change it?`, 100 - i * 3);
    await q("update conversations set unread_count = 0 where id = $1", [long.conversationId]);
  }
  await withSystem((db) => db.query("update agent_instances set mode = 'approval_required' where id = $1", [agents.sales_assistant]));
  const hal = await inbound("sms", "+15125550113", "Hal Brooks", "Do you service the Round Rock area?", 0.6);
  await withSystem((db) => queueOutbound(db, { orgId: org.id, conversationId: hal.conversationId, scope: "reply", actor: { kind: "ai", agentId: agents.sales_assistant }, body: "Hi Hal, yes, we service Round Rock. I'm the AI assistant for Harbor Home Services. Would you like to book an inspection?" }));
  await withSystem((db) => db.query("update agent_instances set mode = 'autonomous' where id = $1", [agents.sales_assistant]));

  // The escalation needs the AI agent that raised it.
  await withSystem(async (db) => {
    const esc = await db.query<{ conversation_id: string }>("select conversation_id from human_escalations where org_id = $1", [org.id]);
    if (!esc.rows.length) await createEscalation(db, { orgId: org.id, conversationId: dana.conversationId, category: "refund_concern", summary: "The customer wants to talk to a person about a refund.", agentId: agents.sales_assistant });
  });

  // The conversation's own "last" timestamps follow its messages (the replies above were stamped after they were queued).
  await q(
    `update conversations c set last_message_at = s.mx, last_outbound_at = s.out_mx, last_inbound_at = coalesce(s.in_mx, c.last_inbound_at)
     from (select conversation_id, max(created_at) as mx, max(created_at) filter (where direction = 'outbound' and status in ('sent', 'delivered', 'read')) as out_mx, max(created_at) filter (where direction = 'inbound') as in_mx
           from conversation_messages where direction <> 'internal' group by conversation_id) s
     where s.conversation_id = c.id and c.org_id = $1`,
    [org.id],
  );

  // Another workspace's conversation, to prove the boundary in the browser.
  const foreign = await inbound("sms", "+15125550199", "Foreign Customer", "This belongs to another business.", 1, undefined, other.id);

  fs.writeFileSync(
    SUMMARY_FILE,
    JSON.stringify({
      note: "Fictional QA data in the isolated embedded database. Passwords are in inbox-credentials.local.json, not here.",
      org: org.id,
      otherOrg: other.id,
      people: Object.fromEntries(Object.entries(people).map(([k, v]) => [k, v.email])),
      conversations: { maria: maria.conversationId, lena: lena.conversationId, carlos: carlos.conversationId, dana: dana.conversationId, james: james.conversationId, priya: priya.conversationId, omar: omar.conversationId, tess: tess.conversationId, noah: noah.conversationId, ruth: ruth.conversationId, old: old.conversationId, ben: ben.conversationId, long: long.conversationId, hal: hal.conversationId, foreign: foreign.conversationId },
    }, null, 2),
  );
  console.log("Inbox QA data is ready. Credentials: .data/crm-qa/inbox-credentials.local.json");
}

// scripts/ui-qa.vitest.config.ts also runs the other QA seeds, whose commands name no file: under their databases this one skips itself.
it.skipIf(!qaDataDir().startsWith(".data/crm-qa/"))("seeds fictional Unified Inbox data into the isolated QA database", async () => {
  try {
    await seed();
  } finally {
    await closeDb();
  }
}, 240_000);
