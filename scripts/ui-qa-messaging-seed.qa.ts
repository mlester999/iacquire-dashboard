/**
 * Synthetic messaging data for local visual QA only. It writes through the application's own services into the isolated
 * embedded QA database (never a hosted one) and sends nothing anywhere. Run it while the QA server is stopped, with the QA
 * environment variables set (see docs/messaging.md, "Local visual QA"):
 *
 *   npx vitest run --config scripts/ui-qa.vitest.config.ts
 */
import { it } from "vitest";
import { closeDb, withSystem } from "../src/server/db/index";
import { env } from "../src/server/env";
import { adjustCredits } from "../src/server/billing/ledger";
import { ingestInbound } from "../src/server/messaging/ingest";
import { applyDeliveryEvent, dispatchMessage, queueOutbound } from "../src/server/messaging/send";
import { createEscalation, takeOverConversation } from "../src/server/messaging/handoff";
import { startFollowUps } from "../src/server/messaging/followups";
import { addInternalNote } from "../src/server/messaging/inbox";
import { addMemory } from "../src/server/messaging/contacts";
import { permissionsFor } from "../src/lib/permissions";
import type { OrgContext } from "../src/server/tenancy/context";

async function seed() {
  const e = env();
  if (e.NODE_ENV === "production" || e.AUTH_PROVIDER !== "local" || e.DATABASE_DRIVER === "postgres") throw new Error("Refusing to seed messaging data outside the isolated local QA database.");

  const base = await withSystem(async (db) => {
    const org = (await db.query<{ id: string; name: string; timezone: string }>("select id, name, timezone from organizations where is_demo = true and kind = 'client' order by created_at limit 1")).rows[0];
    if (!org) throw new Error("Run the QA seed (with --demo) first.");
    const users = (await db.query<{ id: string; email: string; full_name: string; role: string }>("select u.id, u.email::text as email, u.full_name, m.role from organization_memberships m join users u on u.id = m.user_id where m.org_id = $1", [org.id])).rows;
    const agent = (await db.query<{ id: string }>("select id from agent_instances where org_id = $1 and role_key = 'sales_assistant'", [org.id])).rows[0];
    return { org, users, agent };
  });
  const owner = base.users.find((u) => u.role === "owner");
  if (!owner) throw new Error("The demo workspace has no owner.");
  const ctxFor = (u: { id: string; email: string; full_name: string }, role: "owner" | "admin" | "member"): OrgContext => ({
    user: { sessionId: "qa", id: u.id, email: u.email, fullName: u.full_name, platformRole: "none", timezone: "UTC", preferences: {}, emailVerified: true },
    org: { orgId: base.org.id, name: base.org.name, slug: "demo", kind: "client", status: "active", role, isDemo: true, onboardingCompletedAt: null, timezone: base.org.timezone },
    role,
    permissions: permissionsFor(role),
    can: (p) => permissionsFor(role).includes(p),
    memberships: [],
  });
  const ownerCtx = ctxFor(owner, "owner");

  await withSystem(async (db) => {
    await db.query("update agent_instances set status = 'online', last_health_ok = true, enabled = true, mode = 'autonomous' where id = $1", [base.agent.id]);
    await db.query("insert into messaging_settings (org_id, auto_reply_enabled) values ($1, true) on conflict (org_id) do update set auto_reply_enabled = true", [base.org.id]);
    await db.query("update messaging_policy set quiet_hours_start = '00:00', quiet_hours_end = '00:00'");
    for (const channel of ["sms", "whatsapp", "email"] as const) {
      await db.query(
        `insert into messaging_channels (org_id, channel, enabled, sender_identity, sender_verified_at, registration_status, detail)
         values ($1, $2, true, $3, now(), $4, 'Synthetic QA sender') on conflict (org_id, channel) do nothing`,
        [base.org.id, channel, channel === "email" ? "hello@demo.example" : "+15550001111", channel === "email" ? "not_required" : "approved"],
      );
    }
    await db.query("insert into whatsapp_templates (org_id, template_id, name, status) values ($1, 'tmpl_checkin', 'Appointment check-in', 'approved') on conflict do nothing", [base.org.id]);
    const rate = (await db.query<{ id: string }>("select id from usage_rate_versions order by version desc limit 1")).rows[0];
    for (const [unit, w, c] of [["sms_segment", 8000, 10400], ["whatsapp_message", 5000, 6500], ["email_send", 1000, 1300]] as const) {
      await db.query("insert into usage_unit_rates (rate_version_id, provider, unit_type, unit_label, wholesale_micros_per_unit, client_micros_per_unit) values ($1, 'ghl', $2, $2, $3, $4) on conflict do nothing", [rate.id, unit, w, c]);
    }
    await adjustCredits(db, { orgId: base.org.id, deltaMicros: 25_000_000, reason: "synthetic QA credits", userId: owner.id, idempotencyKey: "qa-messaging-seed-credit" }).catch(() => undefined);
  });

  const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000);
  let n = 0;
  const inbound = (channel: "sms" | "whatsapp" | "email", address: string, name: string, body: string, hoursAgo: number, subject?: string) =>
    withSystem((db) => ingestInbound(db, { orgId: base.org.id, provider: "ghl", channel, address, name, body, providerMessageId: `qa-${++n}`, ghlContactId: `qa_ghl_${address.replace(/\W/g, "")}`, receivedAt: ago(hoursAgo), subject }));
  const send = async (conversationId: string, body: string, provider: string) => {
    const q = await withSystem((db) => queueOutbound(db, { orgId: base.org.id, conversationId, scope: "reply", actor: { kind: "ai", agentId: base.agent.id }, body }));
    await dispatchMessage(q.messageId, { provider: { name: "ghl", send: async () => ({ ok: true, providerMessageId: provider }) } });
    return q.messageId;
  };

  // 1. An ordinary AI-handled SMS thread with a delivered reply and a new unread message.
  const maria = await inbound("sms", "+639171110001", "Maria Santos", "Hi! Do you have an inspection slot this week?", 5);
  const m1 = await send(maria.conversationId, "Hi Maria, I'm the AI assistant for Demo Workspace. We have Thursday 10am and Friday 2pm open. Which suits you?", "qa-out-1");
  await withSystem((db) => applyDeliveryEvent(db, { provider: "ghl", providerEventId: "qa-d1", providerMessageId: "qa-out-1", status: "delivered" }));
  void m1;
  await inbound("sms", "+639171110001", "Maria Santos", "Thursday 10am works. Can you also tell me what it costs?", 1);
  await addMemory(ownerCtx, { contactId: maria.contactId, kind: "confirmed_fact", content: "Owns a two-storey house; prefers morning visits." });
  await withSystem((db) => db.query("insert into contact_memories (org_id, contact_id, kind, content, created_by_kind) values ($1, $2, 'ai_summary', 'Asked about an inspection slot and pricing. Not yet qualified.', 'ai')", [base.org.id, maria.contactId]));
  await withSystem((db) => startFollowUps(db, { orgId: base.org.id, conversationId: maria.conversationId }));

  // 2. WhatsApp thread whose reply window closed, with an AI draft awaiting approval is created by switching to approval mode first.
  const carlos = await inbound("whatsapp", "+639171110002", "Carlos Rivera", "Is the Saturday viewing still on?", 30);
  await withSystem((db) => db.query("update agent_instances set mode = 'approval_required' where id = $1", [base.agent.id]));
  await withSystem((db) => queueOutbound(db, { orgId: base.org.id, conversationId: carlos.conversationId, scope: "reply", actor: { kind: "ai", agentId: base.agent.id }, body: "Hi Carlos, yes, Saturday at 11am is confirmed. I'm the AI assistant for Demo Workspace.", templateId: "tmpl_checkin" }));
  const carlos2 = await inbound("whatsapp", "+639171110012", "Nina Cruz", "Could someone confirm my booking?", 2);
  await withSystem((db) => queueOutbound(db, { orgId: base.org.id, conversationId: carlos2.conversationId, scope: "reply", actor: { kind: "ai", agentId: base.agent.id }, body: "Hi Nina, I can see your booking request. A teammate will confirm the time shortly." }));
  await withSystem((db) => db.query("update agent_instances set mode = 'autonomous' where id = $1", [base.agent.id]));

  // 3. An urgent escalation waiting on the owner's priority window.
  const lena = await inbound("email", "lena.park@demo.example", "Dr. Lena Park", "I'd like to go ahead with the full package today. Can someone call me?", 0.2, "Ready to move forward");
  await withSystem((db) => createEscalation(db, { orgId: base.org.id, conversationId: lena.conversationId, category: "ready_to_close", summary: "Customer says they want to go ahead with the full package today and asked for a call.", agentId: base.agent.id }));

  // 4. A conversation a person owns, with an internal note and a sent message.
  const james = await inbound("sms", "+639171110004", "James O'Neil", "I was charged twice last month. Please check.", 26);
  await withSystem((db) => db.query("update conversations set unread_count = 0 where id = $1", [james.conversationId]));
  await takeOverConversation(ownerCtx, james.conversationId, "Billing question");
  const jm = await withSystem((db) => queueOutbound(db, { orgId: base.org.id, conversationId: james.conversationId, scope: "human", actor: { kind: "human", userId: owner.id }, body: "Hi James, it's Jordan. I'm checking the invoices now and will come back to you today." }));
  await dispatchMessage(jm.messageId, { provider: { name: "ghl", send: async () => ({ ok: true, providerMessageId: "qa-out-4" }) } });
  await addInternalNote(ownerCtx, james.conversationId, "Looks like a duplicate card authorization. Waiting on the bank statement.");

  // 5. A customer who opted out.
  const priya = await inbound("sms", "+639171110005", "Priya Nair", "Thanks for the info.", 72);
  await inbound("sms", "+639171110005", "Priya Nair", "STOP", 71);
  await withSystem((db) => db.query("update conversations set unread_count = 0 where id = $1", [priya.conversationId]));

  console.log("Synthetic messaging data is ready for the demo workspace.");
}

it("seeds synthetic messaging data into the isolated QA database", async () => {
  try {
    await seed();
  } finally {
    await closeDb();
  }
}, 120_000);
