import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

// A throwaway RSA key stands in for GoHighLevel's signing key, so webhook verification is exercised without any real secret.
const keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
process.env.GHL_WEBHOOK_PUBLIC_KEY = keys.publicKey;

import { resetEnvCache } from "@/server/env";
import { withSystem, withUser } from "@/server/db";
import { setAgentMode, setClientPause } from "@/server/automation/controls";
import { saveIntegrationConnection } from "@/server/integrations/manager";
import { advanceEscalations, assignConversation, claimEscalation, createEscalation, declineEscalation, listOpenEscalations, resolveEscalation, resumeAi, takeOverConversation } from "@/server/messaging/handoff";
import { handleGhlWebhook } from "@/server/messaging/ingest";
import { queueOutbound } from "@/server/messaging/send";
import { getConversationDetail, listConversations, markConversationRead, addInternalNote } from "@/server/messaging/inbox";
import { addMemory } from "@/server/messaging/contacts";
import { startFollowUps } from "@/server/messaging/followups";
import { setAvailability, setNotificationPreferences, setOwnerPriorityMode } from "@/server/staff/service";
import { inbound, messageRow, messagingOrg, type MessagingOrg } from "./support/messaging";

const T = new Date("2026-10-21T12:00:00Z");
const after = (seconds: number) => new Date(T.getTime() + seconds * 1000);
let m: MessagingOrg;

beforeAll(async () => {
  resetEnvCache();
  m = await messagingOrg({ name: "Handoff Co" });
});

async function escalate(org: MessagingOrg, category: Parameters<typeof createEscalation>[1]["category"], opts: { body?: string; now?: Date; urgency?: "urgent" | "normal" } = {}) {
  const c = await inbound(org.org.id, { body: opts.body ?? "Customer message that must stay private" });
  const result = await withSystem((db) => createEscalation(db, { orgId: org.org.id, conversationId: c.conversationId, category, summary: "Customer needs help from a person.", urgency: opts.urgency, now: opts.now ?? T, agentId: org.salesAgentId }));
  return { c, result };
}
const row = async (id: string) => (await withSystem((db) => db.query<Record<string, unknown>>("select * from human_escalations where id = $1", [id]))).rows[0];
const notes = async (userId: string, kind: string) => (await withSystem((db) => db.query<{ title: string; severity: string }>("select title, severity from notifications where user_id = $1 and kind = $2", [userId, kind]))).rows;
const setAway = (org: MessagingOrg, who: keyof MessagingOrg["people"], availability: "away" | "busy" | "available") => setAvailability(org.ctx(who), { availability, until: availability === "available" ? null : new Date(Date.now() + 3600_000) });

describe("owner-first escalation", () => {
  it("gives the owner first priority: 2 minutes when urgent, 5 when normal", async () => {
    const urgent = await escalate(m, "ready_to_close");
    expect(urgent.result).toMatchObject({ created: true, status: "awaiting_owner" });
    expect(new Date((await row(urgent.result.escalationId)).owner_deadline_at as Date).getTime() - T.getTime()).toBe(120_000);
    const normal = await escalate(m, "human_requested");
    expect(new Date((await row(normal.result.escalationId)).owner_deadline_at as Date).getTime() - T.getTime()).toBe(300_000);
    expect(await row(normal.result.escalationId)).toMatchObject({ urgency: "normal", owner_response: "pending" });
  });

  it("uses the configured windows instead of the defaults", async () => {
    await withSystem((db) => db.query("update messaging_settings set owner_timeout_urgent_seconds = 45, owner_timeout_normal_seconds = 600 where org_id = $1", [m.org.id]));
    try {
      const u = await escalate(m, "complaint");
      const n = await escalate(m, "unanswered_question");
      expect(new Date((await row(u.result.escalationId)).owner_deadline_at as Date).getTime() - T.getTime()).toBe(45_000);
      expect(new Date((await row(n.result.escalationId)).owner_deadline_at as Date).getTime() - T.getTime()).toBe(600_000);
    } finally {
      await withSystem((db) => db.query("update messaging_settings set owner_timeout_urgent_seconds = 120, owner_timeout_normal_seconds = 300 where org_id = $1", [m.org.id]));
    }
  });

  it("asks the owner right away, tells only authorized staff for information, and keeps customer words out of email", async () => {
    const e = await escalate(m, "ready_to_close", { body: "My secret budget is 90000 and my name is Maria" });
    const owner = await notes(m.people.owner.id, "escalation_action_required");
    expect(owner.some((n) => n.severity === "critical")).toBe(true);
    // Staff authorized for "ready to close" get an FYI; the others hear nothing.
    expect((await notes(m.people.manager.id, "escalation_fyi")).length).toBeGreaterThan(0);
    expect((await notes(m.people.sales.id, "escalation_fyi")).length).toBeGreaterThan(0);
    const supportAll = await withSystem((db) => db.query("select 1 from notifications where user_id = $1 and (kind like 'escalation_%') and link like $2", [m.people.support.id, `%${e.c.conversationId}%`]));
    expect(supportAll.rows).toHaveLength(0);
    const viewerAll = await withSystem((db) => db.query("select 1 from notifications where user_id = $1 and (kind like 'escalation_%') and link like $2", [m.people.viewer.id, `%${e.c.conversationId}%`]));
    expect(viewerAll.rows).toHaveLength(0);
    expect(e.result.emails.length).toBeGreaterThan(0);
    for (const mail of e.result.emails) {
      expect(mail.template).toBe("escalation_alert");
      expect(mail.text).not.toContain("90000");
      expect(mail.text).not.toContain("Maria");
      expect(mail.text).toContain(e.c.conversationId);
    }
    expect(e.result.emails.map((x) => x.to)).not.toContain(m.people.support.email);
  });

  it("lets only the owner accept during the window, then lets authorized staff accept after it", async () => {
    const e = await escalate(m, "ready_to_close");
    await expect(claimEscalation(m.ctx("sales"), e.result.escalationId, after(60))).rejects.toThrow(/first priority/);
    expect(await row(e.result.escalationId)).toMatchObject({ status: "awaiting_owner" });
    expect(await advanceEscalations(after(121))).toBeGreaterThanOrEqual(1);
    expect(await row(e.result.escalationId)).toMatchObject({ status: "open", owner_response: "timed_out" });
    expect((await notes(m.people.sales.id, "escalation_action_required")).length).toBeGreaterThan(0);
    const won = await claimEscalation(m.ctx("sales"), e.result.escalationId, after(130));
    expect(won).toMatchObject({ escalationId: e.result.escalationId, alreadyYours: false });
    const conv = await withSystem((db) => db.query<{ owner_kind: string; owner_user_id: string }>("select owner_kind, owner_user_id from conversations where id = $1", [e.c.conversationId]));
    expect(conv.rows[0]).toEqual({ owner_kind: "human", owner_user_id: m.people.sales.id });
    // The others are told it is taken, and no action is needed.
    expect((await notes(m.people.manager.id, "escalation_claimed")).length).toBeGreaterThan(0);
  });

  it("opens the escalation on its own when someone tries to accept after the timer, without waiting for a worker", async () => {
    const e = await escalate(m, "ready_to_close");
    const won = await claimEscalation(m.ctx("manager"), e.result.escalationId, after(200));
    expect(won.alreadyYours).toBe(false);
    expect(await row(e.result.escalationId)).toMatchObject({ status: "claimed", owner_response: "timed_out" });
  });

  it("lets the owner accept inside the window, and records it as owner-accepted", async () => {
    const e = await escalate(m, "complaint");
    const out = await claimEscalation(m.ctx("owner"), e.result.escalationId, after(30));
    expect(out.alreadyYours).toBe(false);
    expect(await row(e.result.escalationId)).toMatchObject({ status: "claimed", owner_response: "accepted", claimed_by: m.people.owner.id });
    expect(await claimEscalation(m.ctx("owner"), e.result.escalationId, after(40))).toMatchObject({ alreadyYours: true });
  });

  it("sends the escalation straight to staff when the owner declines", async () => {
    const e = await escalate(m, "ready_to_close");
    await expect(declineEscalation(m.ctx("manager"), e.result.escalationId, after(5))).rejects.toThrow(/business owner/);
    await declineEscalation(m.ctx("owner"), e.result.escalationId, after(5));
    expect(await row(e.result.escalationId)).toMatchObject({ status: "open", owner_response: "declined" });
    const sales = await withSystem((db) => db.query("select 1 from escalation_recipients where escalation_id = $1 and user_id = $2 and kind = 'action_required'", [e.result.escalationId, m.people.sales.id]));
    expect(sales.rows).toHaveLength(1);
    await expect(declineEscalation(m.ctx("owner"), e.result.escalationId, after(6))).rejects.toThrow(/no longer waiting/);
  });

  it("skips the owner's waiting period when the owner is Away or Busy", async () => {
    for (const state of ["away", "busy"] as const) {
      await setAway(m, "owner", state);
      const e = await escalate(m, "ready_to_close");
      expect(await row(e.result.escalationId), state).toMatchObject({ status: "open", owner_response: state });
      expect((await notes(m.people.sales.id, "escalation_action_required")).length).toBeGreaterThan(0);
    }
    await setAway(m, "owner", "available");
  });

  it("lets exactly one of several simultaneous claimants win", async () => {
    await setAway(m, "owner", "away");
    try {
      const e = await escalate(m, "ready_to_close");
      const results = await Promise.allSettled([
        claimEscalation(m.ctx("manager"), e.result.escalationId, after(1)),
        claimEscalation(m.ctx("sales"), e.result.escalationId, after(1)),
        claimEscalation(m.ctx("owner"), e.result.escalationId, after(1)),
        claimEscalation(m.ctx("manager"), e.result.escalationId, after(1)),
      ]);
      const winners = results.filter((r) => r.status === "fulfilled" && !(r.value as { alreadyYours: boolean }).alreadyYours);
      expect(winners).toHaveLength(1);
      const losers = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      expect(losers.length).toBeGreaterThanOrEqual(2);
      for (const l of losers) expect(String(l.reason.message)).toMatch(/already took|Someone just took/);
      const esc = await row(e.result.escalationId);
      const conv = await withSystem((db) => db.query<{ owner_user_id: string; ownership_version: number }>("select owner_user_id, ownership_version from conversations where id = $1", [e.c.conversationId]));
      expect(conv.rows[0].owner_user_id).toBe(esc.claimed_by);
      expect(conv.rows[0].ownership_version).toBe(2);
      const events = await withSystem((db) => db.query("select 1 from conversation_ownership_events where conversation_id = $1 and to_kind = 'human'", [e.c.conversationId]));
      expect(events.rows).toHaveLength(1);
    } finally {
      await setAway(m, "owner", "available");
    }
  });

  it("refuses people who are not authorized for that kind of escalation, and other workspaces entirely", async () => {
    await setAway(m, "owner", "away");
    try {
      const e = await escalate(m, "ready_to_close");
      await expect(claimEscalation(m.ctx("support"), e.result.escalationId, after(1))).rejects.toThrow(/not authorized/);
      await expect(claimEscalation(m.ctx("viewer"), e.result.escalationId, after(1))).rejects.toThrow(/can't take customer escalations/);
      const other = await messagingOrg({ name: "Other Handoff Co" });
      await expect(claimEscalation(other.ctx("owner"), e.result.escalationId, after(1))).rejects.toThrow(/not found/i);
    } finally {
      await setAway(m, "owner", "available");
    }
  });

  it("puts it in a visible urgent queue and alerts the owner and managers when nobody is available", async () => {
    const org = await messagingOrg({ name: "Nobody Home Co" });
    for (const who of ["owner", "manager", "sales"] as const) await setAway(org, who, "away");
    const e = await escalate(org, "ready_to_close");
    expect(e.result).toMatchObject({ status: "open", unclaimedAlert: true });
    const alert = await notes(org.people.owner.id, "escalation_unclaimed");
    expect(alert).toHaveLength(1);
    expect(alert[0].severity).toBe("critical");
    expect((await listOpenEscalations(org.ctx("manager"))).map((x) => x.id)).toContain(e.result.escalationId);
    // The customer is not told a person is coming: the AI holds off while the escalation is open.
    const reply = await withSystem((db) => queueOutbound(db, { orgId: org.org.id, conversationId: e.c.conversationId, scope: "reply", actor: { kind: "ai", agentId: org.salesAgentId }, body: "A teammate will reply in 2 minutes!" }));
    expect(reply).toMatchObject({ status: "blocked", reason: "escalation_pending" });
  });

  it("honours the owner's notification preference", async () => {
    const org = await messagingOrg({ name: "Owner Modes Co" });
    // Notify me only: the owner is told, teammates are not asked, and there is no timer.
    await setOwnerPriorityMode(org.ctx("owner"), "notify_only");
    const a = await escalate(org, "ready_to_close");
    expect(await row(a.result.escalationId)).toMatchObject({ status: "awaiting_owner", owner_deadline_at: null });
    await advanceEscalations(after(100_000)); // the worker is global; this one has no timer, so it must stay with the owner
    expect(await row(a.result.escalationId)).toMatchObject({ status: "awaiting_owner", owner_response: "pending" });
    expect((await notes(org.people.sales.id, "escalation_fyi")).length + (await notes(org.people.sales.id, "escalation_action_required")).length).toBe(0);
    expect((await notes(org.people.owner.id, "escalation_action_required")).length).toBe(1);
    // Urgent only: routine escalations skip the owner and go straight to teammates.
    await setOwnerPriorityMode(org.ctx("owner"), "urgent_only");
    const normal = await escalate(org, "phone_consultation");
    expect(await row(normal.result.escalationId)).toMatchObject({ status: "open", owner_response: "not_applicable" });
    expect((await notes(org.people.sales.id, "escalation_action_required")).length).toBe(1);
    expect((await notes(org.people.owner.id, "escalation_action_required")).length).toBe(1); // unchanged: not told about the routine one
    const urgent = await escalate(org, "complaint");
    expect(await row(urgent.result.escalationId)).toMatchObject({ status: "awaiting_owner" });
  });

  it("returns the existing escalation instead of creating a second for the same conversation", async () => {
    const e = await escalate(m, "ready_to_close");
    const before = await withSystem((db) => db.query("select 1 from notifications where link like $1", [`%${e.c.conversationId}%`]));
    const again = await withSystem((db) => createEscalation(db, { orgId: m.org.id, conversationId: e.c.conversationId, category: "complaint", summary: "Again", now: after(5) }));
    expect(again).toMatchObject({ created: false, escalationId: e.result.escalationId });
    const afterRows = await withSystem((db) => db.query("select 1 from notifications where link like $1", [`%${e.c.conversationId}%`]));
    expect(afterRows.rows).toHaveLength(before.rows.length);
  });

  it("records honestly that optional SMS alerts were requested but not sent", async () => {
    const org = await messagingOrg({ name: "Optional Alerts Co" });
    await setNotificationPreferences(org.ctx("sales"), { notifyEmail: true, notifySms: true, notifyWhatsapp: false, alertPhone: "+639175550199", acknowledgeCosts: true });
    await setNotificationPreferences(org.ctx("manager"), { notifyEmail: false, notifySms: false, notifyWhatsapp: false });
    const e = await escalate(org, "ready_to_close");
    const rows = await withSystem((db) => db.query<{ user_id: string; email_status: string; optional_alert_status: string }>("select user_id, email_status, optional_alert_status from escalation_recipients where escalation_id = $1", [e.result.escalationId]));
    const by = (id: string) => rows.rows.find((r) => r.user_id === id);
    expect(by(org.people.sales.id)).toMatchObject({ email_status: "queued", optional_alert_status: "not_sent" });
    expect(by(org.people.manager.id)).toMatchObject({ email_status: "skipped", optional_alert_status: "not_requested" });
  });
});

describe("a plain request for a person is never ignored", () => {
  it("raises an escalation from an unmistakable message even when the AI employee is paused", async () => {
    const org = await messagingOrg({ name: "Safety Net Co" });
    await setAgentMode(org.ctx("manager"), { agentId: org.salesAgentId, mode: "paused" });
    const c = await inbound(org.org.id, { body: "I want to speak to a real person please" });
    expect(c.escalationId).toBeTruthy();
    expect(c.aiShouldRespond).toBe(false);
    expect((await withSystem((db) => db.query<{ category: string; status: string }>("select category, status from human_escalations where id = $1", [c.escalationId]))).rows[0]).toEqual({ category: "human_requested", status: "awaiting_owner" });
    const refund = await inbound(org.org.id, { body: "I want my money back, this is unacceptable" });
    expect(refund.escalationId).toBeTruthy();
    const plain = await inbound(org.org.id, { body: "What are your opening hours?" });
    expect(plain.escalationId).toBeNull();
  });
});

describe("owner priority is measured from when the escalation is raised", () => {
  it("gives the owner the full window even when the customer's message arrives late", async () => {
    const org = await messagingOrg({ name: "Late Webhook Co" });
    const late = await inbound(org.org.id, { body: "Please let me talk to a human", receivedAt: new Date(Date.now() - 20 * 60_000) });
    const e = (await withSystem((db) => db.query<{ status: string; owner_deadline_at: Date }>("select status, owner_deadline_at from human_escalations where id = $1", [late.escalationId]))).rows[0];
    expect(e.status).toBe("awaiting_owner");
    const remaining = new Date(e.owner_deadline_at).getTime() - Date.now();
    expect(remaining).toBeGreaterThan(4 * 60_000);
    expect(remaining).toBeLessThanOrEqual(5 * 60_000);
  });
});

describe("takeover and resume", () => {
  it("stops the AI on takeover and returns the conversation only after every safety check passes", async () => {
    const org = await messagingOrg({ name: "Resume Co" });
    await setAway(org, "owner", "away");
    const e = await escalate(org, "ready_to_close");
    await claimEscalation(org.ctx("sales"), e.result.escalationId, after(1));
    // The AI cannot send while a person owns the conversation.
    const blocked = await withSystem((db) => queueOutbound(db, { orgId: org.org.id, conversationId: e.c.conversationId, scope: "reply", actor: { kind: "ai", agentId: org.salesAgentId }, body: "hello" }));
    expect(blocked).toMatchObject({ status: "blocked", reason: "human_owner" });
    // The escalation is still open, so handing back is not safe yet.
    await expect(resumeAi(org.ctx("sales"), e.c.conversationId)).rejects.toThrow(/still open/);
    await resolveEscalation(org.ctx("sales"), e.result.escalationId, "Booked a call for Thursday");
    // Only the person handling it, or a manager, can hand it back.
    await expect(resumeAi(org.ctx("support"), e.c.conversationId)).rejects.toThrow(/Only the person handling this/);
    // The employee must be ready and not paused, and messaging must not be paused.
    await setAgentMode(org.ctx("manager"), { agentId: org.salesAgentId, mode: "paused" });
    await expect(resumeAi(org.ctx("sales"), e.c.conversationId)).rejects.toThrow(/is paused/);
    await setAgentMode(org.ctx("manager"), { agentId: org.salesAgentId, mode: "approval_required" });
    await setClientPause(org.ctx("manager"), { scope: "messaging", paused: true });
    await expect(resumeAi(org.ctx("sales"), e.c.conversationId)).rejects.toThrow(/messaging is paused/);
    await setClientPause(org.ctx("manager"), { scope: "messaging", paused: false });
    await withSystem((db) => db.query("update agent_instances set status = 'offline' where id = $1", [org.salesAgentId]));
    await expect(resumeAi(org.ctx("sales"), e.c.conversationId)).rejects.toThrow(/connection check/);
    await withSystem((db) => db.query("update agent_instances set status = 'online' where id = $1", [org.salesAgentId]));
    await withSystem((db) => db.query("update messaging_channels set enabled = false where org_id = $1 and channel = 'sms'", [org.org.id]));
    await expect(resumeAi(org.ctx("sales"), e.c.conversationId)).rejects.toThrow(/not verified and enabled/);
    await withSystem((db) => db.query("update messaging_channels set enabled = true where org_id = $1 and channel = 'sms'", [org.org.id]));
    expect(await resumeAi(org.ctx("sales"), e.c.conversationId)).toEqual({ ownerKind: "ai" });
    const events = await withSystem((db) => db.query<{ from_kind: string; to_kind: string }>("select from_kind, to_kind from conversation_ownership_events where conversation_id = $1 order by id", [e.c.conversationId]));
    expect(events.rows).toEqual([{ from_kind: "ai", to_kind: "human" }, { from_kind: "human", to_kind: "ai" }]);
    await expect(resumeAi(org.ctx("sales"), e.c.conversationId)).rejects.toThrow(/already owns/);
  });

  it("lets a manager hand a teammate's conversation back, and nobody else take it from the owner", async () => {
    const org = await messagingOrg({ name: "Manager Resume Co" });
    const c = await inbound(org.org.id);
    await takeOverConversation(org.ctx("manager"), c.conversationId);
    await assignConversation(org.ctx("owner"), c.conversationId, org.people.support.id);
    await withSystem((db) => db.query("update agent_instances set mode = 'autonomous' where id = $1", [org.salesAgentId]));
    // The owner is a different person, so another working teammate cannot grab or return it.
    await expect(takeOverConversation(org.ctx("support"), c.conversationId)).rejects.toThrow(/already owns/);
    await expect(resumeAi(org.ctx("support"), c.conversationId)).rejects.toThrow(/Only the person handling this/);
    expect(await resumeAi(org.ctx("owner"), c.conversationId)).toEqual({ ownerKind: "ai" });
  });
});

describe("who can see which conversations", () => {
  it("shows managers every conversation, and other people only what is assigned to them or owned by them", async () => {
    const org = await messagingOrg({ name: "Visibility Co" });
    const a = await inbound(org.org.id, { name: "Assigned Customer" });
    const b = await inbound(org.org.id, { name: "Unassigned Customer" });
    await assignConversation(org.ctx("manager"), a.conversationId, org.people.support.id);
    const manager = (await listConversations(org.ctx("manager"))).map((c) => c.id);
    expect(manager).toEqual(expect.arrayContaining([a.conversationId, b.conversationId]));
    const support = (await listConversations(org.ctx("support"))).map((c) => c.id);
    expect(support).toEqual([a.conversationId]);
    expect(await listConversations(org.ctx("sales"))).toEqual([]);
    expect(await listConversations(org.ctx("viewer"))).toEqual([]);
    // The same limit holds directly in the database, not just in this query.
    const msgs = await withUser(org.people.support.id, (db) => db.query("select conversation_id from conversation_messages"));
    expect(new Set(msgs.rows.map((r) => (r as { conversation_id: string }).conversation_id))).toEqual(new Set([a.conversationId]));
    await expect(assignConversation(org.ctx("manager"), a.conversationId, org.people.viewer.id)).rejects.toThrow(/can't reply to customers/);
    await expect(assignConversation(org.ctx("support"), a.conversationId, org.people.support.id)).rejects.toThrow(/Only owners and managers/);
  });

  it("builds the full conversation view for people who can see it, and reveals nothing to those who cannot", async () => {
    const org = await messagingOrg({ name: "Detail Co" });
    const c = await inbound(org.org.id, { name: "Detail Customer", body: "Do you have time Thursday?" });
    await withSystem((db) => queueOutbound(db, { orgId: org.org.id, conversationId: c.conversationId, scope: "reply", actor: { kind: "ai", agentId: org.salesAgentId }, body: "Yes, 10am is open." }));
    await withSystem((db) => startFollowUps(db, { orgId: org.org.id, conversationId: c.conversationId, now: T }));
    await addInternalNote(org.ctx("manager"), c.conversationId, "Customer prefers mornings.");
    await addMemory(org.ctx("manager"), { contactId: c.contactId, kind: "confirmed_fact", content: "Prefers Thursday mornings." });
    await addMemory(org.ctx("manager"), { contactId: c.contactId, kind: "ai_summary", content: "Asked about Thursday availability." });
    await withSystem((db) => createEscalation(db, { orgId: org.org.id, conversationId: c.conversationId, category: "phone_consultation", summary: "Wants a call.", now: T }));
    const d = await getConversationDetail(org.ctx("manager"), c.conversationId);
    expect(d.contact).toMatchObject({ name: "Detail Customer", lifecycleStage: "lead_captured" });
    expect(d.contact.identities).toEqual([{ kind: "phone", value: c.address, verified: true }]);
    expect(d.contact.consent).toEqual([{ channel: "sms", purpose: "service", status: "granted" }]);
    expect(d.messages.map((x) => [x.direction, x.status])).toEqual([["inbound", "received"], ["outbound", "queued"], ["internal", "note"]]);
    expect(d.memories.map((x) => x.kind).sort()).toEqual(["ai_summary", "confirmed_fact"]);
    expect(d.followUp).toMatchObject({ status: "active", remaining: 3 });
    expect(d.escalation).toMatchObject({ category: "phone_consultation", status: "awaiting_owner", summary: "Wants a call." });
    expect(d.timeline.some((t) => /AI queued a reply/.test(t.text))).toBe(true);
    expect(d.conversation.unread).toBe(1);
    await markConversationRead(org.ctx("manager"), c.conversationId);
    expect((await getConversationDetail(org.ctx("manager"), c.conversationId)).conversation.unread).toBe(0);
    // People without access, including teammates in the same workspace, get nothing.
    await expect(getConversationDetail(org.ctx("support"), c.conversationId)).rejects.toThrow(/not found/i);
    await expect(getConversationDetail(org.ctx("viewer"), c.conversationId)).rejects.toThrow(/not found/i);
    await expect(addInternalNote(org.ctx("viewer"), c.conversationId, "sneaky")).rejects.toThrow(/can't add notes/);
    await expect(addInternalNote(org.ctx("support"), c.conversationId, "sneaky")).rejects.toThrow(/not found/i);
    await assignConversation(org.ctx("manager"), c.conversationId, org.people.support.id);
    expect((await getConversationDetail(org.ctx("support"), c.conversationId)).conversation.id).toBe(c.conversationId);
  });

  it("never lets one workspace read another's conversations, contacts or escalations", async () => {
    const orgB = await messagingOrg({ name: "Isolation B Co" });
    const e = await escalate(m, "ready_to_close");
    for (const table of ["conversations", "conversation_messages", "contacts", "human_escalations", "contact_identities", "contact_consent_events", "follow_up_plans"]) {
      const rows = await withUser(orgB.people.owner.id, (db) => db.query(`select 1 from ${table} where org_id = $1`, [m.org.id]));
      expect(rows.rows, table).toEqual([]);
    }
    const seen = await withUser(orgB.people.owner.id, (db) => db.query("select 1 from conversations where id = $1", [e.c.conversationId]));
    expect(seen.rows).toEqual([]);
  });

  it("limits who can see an escalation to its recipients and managers, and keeps the application role read-only", async () => {
    const e = await escalate(m, "complaint");
    const supportSees = await withUser(m.people.support.id, (db) => db.query("select 1 from human_escalations where id = $1", [e.result.escalationId]));
    expect(supportSees.rows).toHaveLength(1); // support is authorized for complaints
    const salesSees = await withUser(m.people.sales.id, (db) => db.query("select 1 from human_escalations where id = $1", [e.result.escalationId]));
    expect(salesSees.rows).toHaveLength(0); // sales is not
    for (const sql of [
      "update conversations set owner_kind = 'ai', owner_user_id = null where org_id = $1",
      "delete from conversation_messages where org_id = $1",
      "update human_escalations set status = 'claimed' where org_id = $1",
      "insert into suppressions (org_id, channel, address, reason) values ($1, 'sms', '+639170000000', 'manual')",
    ]) {
      await expect(withUser(m.people.owner.id, (db) => db.query(sql, [m.org.id]))).rejects.toThrow(/permission denied|row-level security/);
    }
  });

  it("keeps consent history and ownership history append-only", async () => {
    const c = await inbound(m.org.id);
    await expect(withSystem((db) => db.query("update contact_consent_events set status = 'granted' where contact_id = $1", [c.contactId]))).rejects.toThrow(/append-only/);
    await expect(withSystem((db) => db.query("delete from contact_consent_events where contact_id = $1", [c.contactId]))).rejects.toThrow(/append-only/);
    await takeOverConversation(m.ctx("manager"), c.conversationId);
    await expect(withSystem((db) => db.query("delete from conversation_ownership_events where conversation_id = $1", [c.conversationId]))).rejects.toThrow(/append-only/);
  });
});

describe("GoHighLevel webhooks", () => {
  const LOCATION = "locSyntheticAAA111";
  let org: MessagingOrg;
  let other: MessagingOrg;
  const OTHER_LOCATION = "locSyntheticBBB222";

  const sign = (body: string, privateKey = keys.privateKey) => crypto.createSign("RSA-SHA256").update(body).sign(privateKey, "base64");
  const payload = (over: Record<string, unknown> = {}) => ({
    type: "InboundMessage",
    webhookId: `wh_${crypto.randomBytes(6).toString("hex")}`,
    timestamp: new Date().toISOString(),
    locationId: LOCATION,
    contactId: "ghlContactSynthetic1",
    conversationId: "ghlConvSynthetic1",
    messageId: `msg_${crypto.randomBytes(6).toString("hex")}`,
    messageType: "SMS",
    body: "Is the property still available?",
    direction: "inbound",
    status: "received",
    dateAdded: new Date().toISOString(),
    ...over,
  });
  const send = (p: Record<string, unknown>, opts: { signature?: string | null; now?: number } = {}) => {
    const raw = JSON.stringify(p);
    return handleGhlWebhook({ rawBody: raw, signature: opts.signature === undefined ? sign(raw) : opts.signature, now: opts.now }, { fetchContact: async (_org, id) => ({ id, name: "Pat Webhook", email: null, phone: "+639175550123" }) });
  };

  beforeAll(async () => {
    org = await messagingOrg({ name: "Webhook A Co" });
    other = await messagingOrg({ name: "Webhook B Co" });
    await saveIntegrationConnection(org.superAdmin, org.org.id, { provider: "ghl", label: "Synthetic CRM", environment: "development", secret: `synthetic-key-${"k".repeat(30)}`, config: { locationId: LOCATION, scopes: ["locations.readonly"] } });
    await saveIntegrationConnection(other.superAdmin, other.org.id, { provider: "ghl", label: "Synthetic CRM B", environment: "development", secret: `synthetic-key-${"q".repeat(30)}`, config: { locationId: OTHER_LOCATION, scopes: ["locations.readonly"] } });
  });

  it("creates the conversation in the workspace that owns the location, once, and ignores a replay", async () => {
    const p = payload();
    const first = await send(p);
    expect(first).toMatchObject({ httpStatus: 200, outcome: "processed", aiShouldRespond: true });
    const conv = await withSystem((db) => db.query<{ org_id: string; owner_kind: string }>("select org_id, owner_kind from conversations where id = $1", [first.conversationId]));
    expect(conv.rows[0]).toEqual({ org_id: org.org.id, owner_kind: "ai" });
    expect(await send(p)).toMatchObject({ httpStatus: 200, outcome: "duplicate" });
    // The same message id arriving under a new webhook id is still not a second message.
    expect(await send({ ...p, webhookId: `wh_${crypto.randomBytes(6).toString("hex")}` })).toMatchObject({ outcome: "duplicate" });
    const n = await withSystem((db) => db.query<{ n: string }>("select count(*)::text as n from conversation_messages where conversation_id = $1", [first.conversationId]));
    expect(n.rows[0].n).toBe("1");
  });

  it("rejects an invalid signature, a missing signature, a stale timestamp and a tampered body", async () => {
    expect(await send(payload(), { signature: null })).toMatchObject({ httpStatus: 401 });
    const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    const p = payload();
    const raw = JSON.stringify(p);
    expect(await handleGhlWebhook({ rawBody: raw, signature: sign(raw, other.privateKey) })).toMatchObject({ httpStatus: 401 });
    expect(await handleGhlWebhook({ rawBody: raw + " ", signature: sign(raw) })).toMatchObject({ httpStatus: 401 });
    const old = payload({ timestamp: new Date(Date.now() - 10 * 60_000).toISOString() });
    expect(await send(old)).toMatchObject({ httpStatus: 400 });
    const none = await withSystem((db) => db.query("select 1 from conversation_messages where dedupe_key = $1", [`inbound:ghl:${p.messageId}`]));
    expect(none.rows).toHaveLength(0);
  });

  it("only ever delivers to the workspace mapped to the location, and ignores unmapped and protected locations", async () => {
    const forOther = await send(payload({ locationId: OTHER_LOCATION, contactId: "ghlContactSynthetic2" }));
    const conv = await withSystem((db) => db.query<{ org_id: string }>("select org_id from conversations where id = $1", [forOther.conversationId]));
    expect(conv.rows[0].org_id).toBe(other.org.id);
    expect(await send(payload({ locationId: "locNobodyOwnsThis999" }))).toMatchObject({ httpStatus: 200, outcome: "ignored", detail: expect.stringMatching(/not connected/) });
    // The protected demo location can never be mapped to a workspace, so its events are ignored too.
    await expect(saveIntegrationConnection(org.superAdmin, org.org.id, { provider: "ghl", label: "Protected", environment: "development", secret: `synthetic-key-${"z".repeat(30)}`, config: { locationId: "u69CVh0ZlAofUmRoj1zF", scopes: ["locations.readonly"] } })).rejects.toThrow();
    expect(await send(payload({ locationId: "u69CVh0ZlAofUmRoj1zF" }))).toMatchObject({ outcome: "ignored" });
  });

  it("applies an opt-out arriving through the webhook", async () => {
    const p = payload({ contactId: "ghlContactSynthetic3", body: "STOP" });
    const out = await send(p);
    expect(out).toMatchObject({ outcome: "processed", aiShouldRespond: false });
    const sup = await withSystem((db) => db.query("select 1 from suppressions where org_id = $1 and address = '+639175550123' and lifted_at is null", [org.org.id]));
    expect(sup.rows).toHaveLength(1);
  });

  it("turns an outbound status webhook into a delivery state for a message we sent, and ignores unknown ones", async () => {
    const c = await inbound(org.org.id, { ghlContactId: "ghlContactSynthetic4" });
    await withSystem((db) => db.query("update conversations set owner_kind = 'ai' where id = $1", [c.conversationId]));
    const q = await withSystem((db) => queueOutbound(db, { orgId: org.org.id, conversationId: c.conversationId, scope: "reply", actor: { kind: "ai", agentId: org.salesAgentId }, body: "Yes, still available." }));
    const { dispatchMessage } = await import("@/server/messaging/send");
    await dispatchMessage(q.messageId, { provider: { name: "ghl", send: async () => ({ ok: true, providerMessageId: "ghlMsgSynthetic1" }) } });
    const delivered = await send(payload({ type: "OutboundMessage", messageId: "ghlMsgSynthetic1", status: "delivered", direction: "outbound" }));
    expect(delivered).toMatchObject({ outcome: "processed" });
    expect(await messageRow(q.messageId)).toMatchObject({ status: "delivered" });
    expect(await send(payload({ type: "OutboundMessage", messageId: "ghlMsgUnknown999", status: "delivered" }))).toMatchObject({ outcome: "ignored" });
    expect(await send(payload({ type: "ContactUpdate" }))).toMatchObject({ outcome: "ignored" });
  });
});
