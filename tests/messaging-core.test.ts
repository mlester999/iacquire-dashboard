import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { adjustCredits, getBalance } from "@/server/billing/ledger";
import { publishUnitRate } from "@/server/billing/service";
import { setAgencyPause, setClientPause } from "@/server/automation/controls";
import { decideApproval } from "@/server/approvals/service";
import { mergeContacts, redactContact } from "@/server/messaging/contacts";
import { applyDeliveryEvent, dispatchDue, dispatchMessage, evaluateSend, queueOutbound } from "@/server/messaging/send";
import { ghlProvider } from "@/server/messaging/provider";
import { onBooking, processDueFollowUps, startFollowUps } from "@/server/messaging/followups";
import { approveDraft, sendHumanReply } from "@/server/messaging/inbox";
import { takeOverConversation } from "@/server/messaging/handoff";
import { ingestInbound } from "@/server/messaging/ingest";
import { DEFAULT_FOLLOWUP_TEXT } from "@/lib/messaging";
import { inbound, messageRow, messagingOrg, phone, recordingProvider, type MessagingOrg } from "./support/messaging";

// A Wednesday, midday UTC, always after the real clock: the database stamps rows with its own now(), so the simulated "now" has to stay later than any real one. A fixed date went
// stale on its own day (this file started failing the day after the date it named), so it is the next Wednesday at 12:00 UTC counted from today.
const NOW = (() => {
  const date = new Date();
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + (((3 - date.getUTCDay() + 7) % 7) || 7));
  return date;
})();
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
/** The given UTC time of day, `offset` days after NOW's day. */
const at = (offset: number, hour: number, minute = 0) => {
  const date = days(offset);
  date.setUTCHours(hour, minute, 0, 0);
  return date;
};

let m: MessagingOrg;
beforeAll(async () => {
  m = await messagingOrg({ name: "Core Messaging Co" });
});
afterEach(() => vi.restoreAllMocks());

const queueAi = (conversationId: string, body = "Thanks for reaching out. We have room on Thursday.", extra: Record<string, unknown> = {}, org: MessagingOrg = m) =>
  withSystem((db) => queueOutbound(db, { orgId: org.org.id, conversationId, scope: "reply", actor: { kind: "ai", agentId: org.salesAgentId }, body, ...extra }));
const balance = (org: MessagingOrg = m) => withSystem((db) => getBalance(db, org.org.id));

describe("inbound messages, identity and consent", () => {
  it("creates an AI-owned conversation, records inquiry consent, and ignores a duplicate provider event", async () => {
    const first = await inbound(m.org.id, { providerMessageId: "dup-1", address: phone() });
    expect(first.status).toBe("created");
    expect(first.aiShouldRespond).toBe(true);
    const { rows } = await withSystem((db) => db.query<{ owner_kind: string; ai_agent_id: string; unread_count: number }>("select owner_kind, ai_agent_id, unread_count from conversations where id = $1", [first.conversationId]));
    expect(rows[0]).toEqual({ owner_kind: "ai", ai_agent_id: m.salesAgentId, unread_count: 1 });
    const consent = await withSystem((db) => db.query<{ status: string; source: string }>("select status, source from contact_consent_events where contact_id = $1", [first.contactId]));
    expect(consent.rows).toEqual([{ status: "granted", source: "inbound_inquiry" }]);
    const dup = await withSystem((db) => ingestInbound(db, { orgId: m.org.id, provider: "ghl", channel: "sms", address: first.address, body: "Hi again", providerMessageId: "dup-1" }));
    expect(dup.status).toBe("duplicate");
    const count = await withSystem((db) => db.query<{ n: string }>("select count(*)::text as n from conversation_messages where conversation_id = $1", [first.conversationId]));
    expect(count.rows[0].n).toBe("1");
  });

  it("matches a person across SMS and WhatsApp by the exact phone number, and never by name", async () => {
    const number = phone();
    const sms = await inbound(m.org.id, { address: number, channel: "sms", name: "Ana Reyes" });
    const wa = await inbound(m.org.id, { address: number, channel: "whatsapp", name: "Ana R." });
    expect(wa.contactId).toBe(sms.contactId);
    expect(wa.conversationId).not.toBe(sms.conversationId);
    const namesake = await inbound(m.org.id, { address: phone(), name: "Ana Reyes" });
    expect(namesake.contactId).not.toBe(sms.contactId);
  });

  it("treats an inbound email address as unverified, but a texting phone number as provider-verified", async () => {
    const mail = await inbound(m.org.id, { channel: "email", address: `buyer-${Date.now()}@example.test`, subject: "Question" });
    const text = await inbound(m.org.id, { channel: "sms" });
    const ids = await withSystem((db) => db.query<{ kind: string; verified: boolean }>("select kind, verified from contact_identities where contact_id = any($1::uuid[]) order by kind", [[mail.contactId, text.contactId]]));
    expect(ids.rows).toEqual([{ kind: "email", verified: false }, { kind: "phone", verified: true }]);
  });

  it("merges two contacts only by an authorized person, keeps the most restrictive consent, and records the merge", async () => {
    const a = await inbound(m.org.id, { channel: "sms", name: "Kept" });
    const emailAddress = `merge-${Date.now()}@example.test`;
    const b = await inbound(m.org.id, { channel: "email", address: emailAddress, name: "Merged" });
    await inbound(m.org.id, { channel: "email", address: emailAddress, body: "STOP" });
    await expect(mergeContacts(m.ctx("support"), { keptId: a.contactId, mergedId: b.contactId, reason: "Same person per phone call" })).rejects.toThrow(/Only owners and managers/);
    await expect(mergeContacts(m.ctx("manager"), { keptId: a.contactId, mergedId: b.contactId, reason: "x" })).rejects.toThrow(/Record why/);
    await mergeContacts(m.ctx("manager"), { keptId: a.contactId, mergedId: b.contactId, reason: "Same person per phone call" });
    const kept = await withSystem((db) => db.query<{ kind: string }>("select kind from contact_identities where contact_id = $1 order by kind", [a.contactId]));
    expect(kept.rows.map((r) => r.kind)).toEqual(["email", "phone"]);
    const gone = await withSystem((db) => db.query<{ deleted_at: Date | null }>("select deleted_at from contacts where id = $1", [b.contactId]));
    expect(gone.rows[0].deleted_at).not.toBeNull();
    const consent = await withSystem((db) => db.query<{ status: string }>("select distinct on (channel, purpose) status from contact_consent_events where contact_id = $1 and channel = 'email' and purpose = 'service' order by channel, purpose, id desc", [a.contactId]));
    expect(consent.rows[0].status).toBe("revoked");
    const log = await withSystem((db) => db.query("select 1 from contact_merges where kept_contact_id = $1 and merged_contact_id = $2", [a.contactId, b.contactId]));
    expect(log.rows).toHaveLength(1);
    await expect(mergeContacts(m.ctx("manager"), { keptId: a.contactId, mergedId: a.contactId, reason: "same" })).rejects.toThrow(/two different/);
  });

  it("removes personal details on a privacy request but keeps the opt-out", async () => {
    const c = await inbound(m.org.id, { channel: "sms", body: "STOP" });
    await expect(redactContact(m.ctx("support"), c.contactId, "Customer asked to be deleted")).rejects.toThrow(/Only owners and managers/);
    await redactContact(m.ctx("owner"), c.contactId, "Customer asked to be deleted");
    const row = await withSystem((db) => db.query<{ display_name: string; phone: string | null }>("select display_name, phone from contacts where id = $1", [c.contactId]));
    expect(row.rows[0]).toEqual({ display_name: "Removed contact", phone: null });
    const body = await withSystem((db) => db.query<{ body: string }>("select body from conversation_messages where conversation_id = $1", [c.conversationId]));
    expect(body.rows.every((r) => r.body === "[removed on request]")).toBe(true);
    const sup = await withSystem((db) => db.query("select 1 from suppressions where org_id = $1 and address = $2 and lifted_at is null", [m.org.id, c.address]));
    expect(sup.rows).toHaveLength(1);
  });

  it("STOP revokes consent, suppresses the number and blocks every later send; START restores it", async () => {
    const c = await inbound(m.org.id, { channel: "sms" });
    const stop = await inbound(m.org.id, { channel: "sms", address: c.address, body: "STOP" });
    expect(stop.optOut).toBe("stop");
    expect(stop.aiShouldRespond).toBe(false);
    const ai = await queueAi(c.conversationId);
    expect(ai).toMatchObject({ status: "blocked", reason: "suppressed" });
    await withSystem((db) => db.query("update conversations set owner_kind = 'human', owner_user_id = $2 where id = $1", [c.conversationId, m.people.sales.id]));
    await expect(sendHumanReply(m.ctx("sales"), c.conversationId, "Just one more thing")).rejects.toThrow(/opted out/);
    const start = await inbound(m.org.id, { channel: "sms", address: c.address, body: "start" });
    expect(start.optOut).toBe("start");
    await expect(sendHumanReply(m.ctx("sales"), c.conversationId, "Welcome back")).resolves.toMatchObject({ status: "queued" });
  });
});

describe("the send rule chain", () => {
  it("queues an allowed AI reply, bills wholesale plus the approved 30%, and never reports delivered on its own", async () => {
    const c = await inbound(m.org.id);
    const before = await balance();
    const q = await queueAi(c.conversationId);
    expect(q.status).toBe("queued");
    expect((await balance()).reservedMicros - before.reservedMicros).toBe(10400); // 8000 wholesale x 1.30, rounded up
    const { provider, calls } = recordingProvider();
    expect(await dispatchMessage(q.messageId, { provider })).toEqual({ status: "sent" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ channel: "sms", fromIdentity: "+15550001111", contactRef: expect.stringMatching(/^ghl_/) });
    const row = await messageRow(q.messageId);
    expect(row).toMatchObject({ status: "sent", provider: "ghl" });
    expect(row.delivered_at).toBeNull();
    const after = await balance();
    expect(after.reservedMicros).toBe(before.reservedMicros);
    expect(before.balanceMicros - after.balanceMicros).toBe(10400);
    const usage = await withSystem((db) => db.query<{ wholesale_micros: number; client_micros: number; markup_bps: number; unit_type: string; message_id: string }>("select wholesale_micros, client_micros, markup_bps, unit_type, message_id from metered_usage_events where message_id = $1", [q.messageId]));
    expect(usage.rows[0]).toMatchObject({ wholesale_micros: 8000, client_micros: 10400, markup_bps: 13000, unit_type: "sms_segment" });
  });

  it("prices a long SMS by its segments", async () => {
    const c = await inbound(m.org.id);
    const before = await balance();
    const q = await queueAi(c.conversationId, "x".repeat(400)); // 3 segments
    expect((await balance()).reservedMicros - before.reservedMicros).toBe(31200);
    const { provider } = recordingProvider();
    await dispatchMessage(q.messageId, { provider });
    expect(before.balanceMicros - (await balance()).balanceMicros).toBe(31200);
  });

  it("keeps an approval-required employee's message as a draft, shows it in the Approval Center, and sends only after a person approves", async () => {
    const org = await messagingOrg({ name: "Approval Messaging Co", autonomous: false });
    const c = await inbound(org.org.id);
    const q = await queueAi(c.conversationId, "Happy to help with that.", {}, org);
    expect(q).toMatchObject({ status: "draft", reason: "needs_approval" });
    const approval = await withSystem((db) => db.query<{ id: string; status: string; kind: string }>("select id, status, kind from approval_requests where org_id = $1 and action->>'messageId' = $2", [org.org.id, q.messageId]));
    expect(approval.rows[0]).toMatchObject({ status: "pending", kind: "follow_up_message" });
    const { provider, calls } = recordingProvider();
    expect(await dispatchMessage(q.messageId, { provider })).toEqual({ status: "skipped" });
    const decided = await decideApproval(org.ctx("owner"), approval.rows[0].id, "approve");
    expect(decided.outcome).toMatchObject({ status: "succeeded" });
    expect((await messageRow(q.messageId)).status).toBe("queued");
    expect(await dispatchMessage(q.messageId, { provider })).toEqual({ status: "sent" });
    expect(calls).toHaveLength(1);
  });

  it("discards a draft when the approval is rejected, and a second approval cannot revive it", async () => {
    const org = await messagingOrg({ name: "Reject Messaging Co", autonomous: false });
    const c = await inbound(org.org.id);
    const q = await queueAi(c.conversationId, "Draft to reject", {}, org);
    const approvalId = (await messageRow(q.messageId)).approval_id as string;
    await decideApproval(org.ctx("owner"), approvalId, "reject");
    expect(await messageRow(q.messageId)).toMatchObject({ status: "blocked", blocked_reason: "discarded" });
    await expect(approveDraft(org.ctx("owner"), q.messageId)).rejects.toThrow(/not waiting for approval/);
  });

  it("lets a person approve a draft from the inbox once, even if the Approval Center decides it at the same time", async () => {
    const org = await messagingOrg({ name: "Inbox Approval Co", autonomous: false });
    const c = await inbound(org.org.id);
    const q = await queueAi(c.conversationId, "Draft to approve from the inbox", {}, org);
    const results = await Promise.allSettled([approveDraft(org.ctx("owner"), q.messageId), approveDraft(org.ctx("manager"), q.messageId)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await messageRow(q.messageId)).status).toBe("queued");
    const approvalId = (await messageRow(q.messageId)).approval_id;
    const events = await withSystem((db) => db.query("select 1 from approval_events where approval_id = $1 and event = 'approved'", [approvalId]));
    expect(events.rows.length).toBeGreaterThanOrEqual(1);
  });

  it("keeps a WhatsApp draft's approved template when a person approves it after the window has closed", async () => {
    const org = await messagingOrg({ name: "Template Draft Co", autonomous: false });
    const c = await inbound(org.org.id, { channel: "whatsapp", receivedAt: new Date(Date.now() - 30 * 3600_000) });
    const q = await queueAi(c.conversationId, "Your viewing is confirmed.", { templateId: "tmpl_followup" }, org);
    expect(q.status).toBe("draft");
    expect((await messageRow(q.messageId)).template_id).toBe("tmpl_followup");
    await approveDraft(org.ctx("manager"), q.messageId);
    expect(await messageRow(q.messageId)).toMatchObject({ status: "queued", template_id: "tmpl_followup" });
    const { provider, calls } = recordingProvider();
    expect(await dispatchMessage(q.messageId, { provider })).toEqual({ status: "sent" });
    expect(calls[0].templateId).toBe("tmpl_followup");
  });

  it("keeps replies as drafts until the owner has switched automatic replies on", async () => {
    const org = await messagingOrg({ name: "No Autopilot Co", autoReply: false });
    const c = await inbound(org.org.id);
    expect(await queueAi(c.conversationId, "Hello", {}, org)).toMatchObject({ status: "draft", reason: "needs_approval" });
  });

  it("blocks the AI the moment a person owns the conversation, including a message that was already queued", async () => {
    const c = await inbound(m.org.id);
    const q = await queueAi(c.conversationId);
    const { provider, calls } = recordingProvider();
    const held = (await balance()).reservedMicros;
    await takeOverConversation(m.ctx("manager"), c.conversationId);
    expect(await messageRow(q.messageId)).toMatchObject({ status: "blocked", blocked_reason: "human_owner" });
    expect((await balance()).reservedMicros).toBe(held - 10400);
    // A new AI message is refused outright.
    expect(await queueAi(c.conversationId)).toMatchObject({ status: "blocked", reason: "human_owner" });
    expect(calls).toHaveLength(0);
    // The person's own reply goes out.
    const reply = await sendHumanReply(m.ctx("manager"), c.conversationId, "Hi, it's Mia. Thursday works.");
    expect(await dispatchMessage(reply.messageId, { provider })).toEqual({ status: "sent" });
    expect(calls).toHaveLength(1);
  });

  it("re-checks ownership at dispatch, so a worker restart can never send an AI message after a takeover", async () => {
    const c = await inbound(m.org.id);
    const q = await queueAi(c.conversationId);
    // A takeover that did not clean up the queue (for example, done by another process): the message is still 'queued'.
    await withSystem((db) => db.query("update conversations set owner_kind = 'human', owner_user_id = $2 where id = $1", [c.conversationId, m.people.sales.id]));
    expect((await messageRow(q.messageId)).status).toBe("queued");
    const { provider, calls } = recordingProvider();
    const held = (await balance()).reservedMicros;
    expect(await dispatchMessage(q.messageId, { provider })).toEqual({ status: "blocked" });
    expect(calls).toHaveLength(0);
    expect(await messageRow(q.messageId)).toMatchObject({ status: "blocked", blocked_reason: "human_owner" });
    expect((await balance()).reservedMicros).toBe(held - 10400);
  });

  it("applies a messaging pause to messages that were queued before the pause", async () => {
    const c = await inbound(m.org.id);
    const q = await queueAi(c.conversationId);
    await setClientPause(m.ctx("manager"), { scope: "messaging", paused: true, reason: "Wrong price sent" });
    const { provider, calls } = recordingProvider();
    expect(await dispatchMessage(q.messageId, { provider })).toEqual({ status: "blocked" });
    expect(calls).toHaveLength(0);
    expect(await messageRow(q.messageId)).toMatchObject({ blocked_reason: "automation_paused" });
    await setClientPause(m.ctx("manager"), { scope: "messaging", paused: false });
    expect(await queueAi(c.conversationId)).toMatchObject({ status: "queued" });
  });

  it("applies an agency emergency pause at send time, and the pause survives a fresh read", async () => {
    const c = await inbound(m.org.id);
    const q = await queueAi(c.conversationId);
    await setAgencyPause(m.superAdmin, { orgId: m.org.id, paused: true, reason: "Investigating a complaint" });
    const { provider, calls } = recordingProvider();
    expect(await dispatchMessage(q.messageId, { provider })).toEqual({ status: "blocked" });
    expect(calls).toHaveLength(0);
    await setAgencyPause(m.superAdmin, { orgId: m.org.id, paused: false, reason: "" });
  });

  it("blocks free-form WhatsApp outside the reply window and allows only an approved template", async () => {
    const old = await inbound(m.org.id, { channel: "whatsapp", receivedAt: new Date(Date.now() - 30 * 3600_000) });
    expect(await queueAi(old.conversationId)).toMatchObject({ status: "blocked", reason: "whatsapp_window_closed" });
    expect(await queueAi(old.conversationId, "Following up", { templateId: "tmpl_pending" })).toMatchObject({ status: "blocked", reason: "whatsapp_window_closed" });
    expect(await queueAi(old.conversationId, "Following up", { templateId: "tmpl_followup" })).toMatchObject({ status: "queued" });
    const fresh = await inbound(m.org.id, { channel: "whatsapp", receivedAt: new Date(Date.now() - 3600_000) });
    expect(await queueAi(fresh.conversationId)).toMatchObject({ status: "queued" });
  });

  it("refuses to enable a channel whose sender is unverified or unregistered, at the database", async () => {
    const orgId = (await messagingOrg({ name: "Channel Guard Co" })).org.id;
    await expect(withSystem((db) => db.query("update messaging_channels set sender_verified_at = null where org_id = $1 and channel = 'sms'", [orgId]))).rejects.toThrow();
    await expect(withSystem((db) => db.query("update messaging_channels set registration_status = 'pending' where org_id = $1 and channel = 'sms'", [orgId]))).rejects.toThrow();
    await withSystem((db) => db.query("update messaging_channels set enabled = false where org_id = $1 and channel = 'sms'", [orgId]));
    const c = await inbound(orgId);
    const org = await withSystem((db) => db.query("select 1"));
    expect(org.rows).toHaveLength(1);
    const decision = await withSystem((db) => evaluateSend(db, { orgId, conversationId: c.conversationId, scope: "reply", actor: { kind: "ai", agentId: null }, body: "x" }));
    expect(decision).toMatchObject({ allow: false });
  });

  it("holds messages when credits run out, tells the owner once, and resumes after a top-up", async () => {
    const org = await messagingOrg({ name: "Low Credit Co", credits: 0.005 }); // less than one SMS segment
    const c = await inbound(org.org.id);
    const blocked = await queueAi(c.conversationId, "Hello", {}, org);
    expect(blocked).toMatchObject({ status: "blocked", reason: "credits" });
    await queueAi(c.conversationId, "Hello again", {}, org);
    const notes = await withUser(org.people.owner.id, (db) => db.query("select 1 from notifications where kind = 'message_blocked'"));
    expect(notes.rows).toHaveLength(1);
    await withSystem((db) => adjustCredits(db, { orgId: org.org.id, deltaMicros: 5_000_000, reason: "top-up for the test", userId: org.people.owner.id }));
    expect(await queueAi(c.conversationId, "Now it works", {}, org)).toMatchObject({ status: "queued" });
    // A person's own reply is refused with the reason when there is no credit.
    const poor = await messagingOrg({ name: "Zero Credit Co", credits: 0 });
    const pc = await inbound(poor.org.id);
    await expect(sendHumanReply(poor.ctx("manager"), pc.conversationId, "Hi")).rejects.toThrow(/service credits/);
  });

  it("refuses a channel that has no published usage rate, because it could not be billed", async () => {
    const org = await messagingOrg({ name: "No Rate Co" });
    const c = await inbound(org.org.id, { channel: "email", address: `norate-${Date.now()}@example.test`, subject: "Hello" });
    await withSystem((db) => db.query("delete from usage_unit_rates where unit_type = 'email_send'"));
    expect(await queueAi(c.conversationId, "Hello", {}, org)).toMatchObject({ status: "blocked", reason: "rate_not_published" });
    await publishUnitRate(org.superAdmin, { provider: "ghl", unitType: "email_send", wholesaleMicrosPerUnit: 1000 });
    expect(await queueAi(c.conversationId, "Hello", {}, org)).toMatchObject({ status: "queued" });
  });

  it("will not publish a rate that is not a positive integer or that names an unknown unit", async () => {
    await expect(publishUnitRate(m.superAdmin, { provider: "ghl", unitType: "sms_segment", wholesaleMicrosPerUnit: 1.5 })).rejects.toThrow(/micro-dollars/);
    await expect(publishUnitRate(m.superAdmin, { provider: "ghl", unitType: "made_up", wholesaleMicrosPerUnit: 10 })).rejects.toThrow(/known usage unit/);
    await expect(publishUnitRate({ id: m.people.owner.id, platformRole: "agency_staff" }, { provider: "ghl", unitType: "sms_segment", wholesaleMicrosPerUnit: 10 })).rejects.toThrow(/super admin/);
  });
});

describe("dispatch and delivery", () => {
  it("moves a message to delivered only on a provider event, never backwards, and ignores repeats", async () => {
    const c = await inbound(m.org.id);
    const q = await queueAi(c.conversationId);
    const { provider } = recordingProvider((_r, n) => ({ ok: true, providerMessageId: `deliv_${n}_${q.messageId.slice(0, 6)}` }));
    await dispatchMessage(q.messageId, { provider });
    const pid = (await messageRow(q.messageId)).provider_message_id as string;
    const event = (status: "sent" | "delivered" | "read" | "failed", id: string) => withSystem((db) => applyDeliveryEvent(db, { provider: "ghl", providerEventId: id, providerMessageId: pid, status }));
    expect(await event("delivered", "e1")).toMatchObject({ result: "applied", status: "delivered" });
    expect(await event("delivered", "e1")).toMatchObject({ result: "duplicate" });
    expect(await event("sent", "e2")).toMatchObject({ result: "no_change", status: "delivered" });
    expect(await event("read", "e3")).toMatchObject({ result: "applied", status: "read" });
    expect(await event("failed", "e4")).toMatchObject({ result: "no_change" });
    expect(await messageRow(q.messageId)).toMatchObject({ status: "read" });
    const unknown = await withSystem((db) => applyDeliveryEvent(db, { provider: "ghl", providerEventId: "e5", providerMessageId: "no-such-message", status: "delivered" }));
    expect(unknown.result).toBe("unknown_message");
  });

  it("records a failed delivery and suppresses an address the provider reports as bounced", async () => {
    const address = `bounce-${Date.now()}@example.test`;
    const c = await inbound(m.org.id, { channel: "email", address, subject: "Hi" });
    const q = await queueAi(c.conversationId);
    const { provider } = recordingProvider((_r, n) => ({ ok: true, providerMessageId: `bnc_${n}_${q.messageId.slice(0, 6)}` }));
    await dispatchMessage(q.messageId, { provider });
    const pid = (await messageRow(q.messageId)).provider_message_id as string;
    await withSystem((db) => applyDeliveryEvent(db, { provider: "ghl", providerEventId: "b1", providerMessageId: pid, status: "failed", detail: "Mailbox does not exist", suppress: "bounce" }));
    expect(await messageRow(q.messageId)).toMatchObject({ status: "failed" });
    expect(await queueAi(c.conversationId)).toMatchObject({ status: "blocked", reason: "suppressed" });
  });

  it("fails a message and releases its credit when the provider rejects it, and tells the owner", async () => {
    const c = await inbound(m.org.id);
    const q = await queueAi(c.conversationId);
    const held = (await balance()).reservedMicros;
    const { provider } = recordingProvider(() => ({ ok: false, retryable: false, error: "GoHighLevel refused the message (422)." }));
    expect(await dispatchMessage(q.messageId, { provider })).toEqual({ status: "failed" });
    expect((await balance()).reservedMicros).toBe(held - 10400);
    expect(await messageRow(q.messageId)).toMatchObject({ status: "failed", blocked_reason: "provider_error" });
    const note = await withUser(m.people.owner.id, (db) => db.query("select 1 from notifications where kind = 'message_failed'"));
    expect(note.rows.length).toBeGreaterThan(0);
  });

  it("retries a rate-limited send with backoff up to three attempts, then fails it", async () => {
    const c = await inbound(m.org.id);
    const q = await queueAi(c.conversationId);
    const { provider, calls } = recordingProvider(() => ({ ok: false, retryable: true, error: "rate limit" }));
    let at = new Date(Date.now() + 1000);
    expect(await dispatchMessage(q.messageId, { provider, now: at })).toEqual({ status: "queued" });
    expect(Number(new Date((await messageRow(q.messageId)).send_after as Date)) - at.getTime()).toBeGreaterThanOrEqual(120_000 - 1);
    // Not due again until the backoff has passed.
    expect(await dispatchMessage(q.messageId, { provider, now: at })).toEqual({ status: "skipped" });
    at = new Date(at.getTime() + 3 * 60_000);
    expect(await dispatchMessage(q.messageId, { provider, now: at })).toEqual({ status: "queued" });
    at = new Date(at.getTime() + 10 * 60_000);
    expect(await dispatchMessage(q.messageId, { provider, now: at })).toEqual({ status: "failed" });
    expect(calls).toHaveLength(3);
  });

  it("never calls GoHighLevel while sending is switched off, and says why", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const c = await inbound(m.org.id);
    const q = await queueAi(c.conversationId);
    const held = (await balance()).reservedMicros;
    expect(await dispatchMessage(q.messageId, { provider: ghlProvider })).toEqual({ status: "blocked" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await messageRow(q.messageId)).toMatchObject({ status: "blocked", blocked_reason: "provider_not_enabled" });
    expect((await balance()).reservedMicros).toBe(held - 10400);
  });

  it("sends a message only once even if two workers claim it at the same time", async () => {
    const c = await inbound(m.org.id);
    const q = await queueAi(c.conversationId);
    const { provider, calls } = recordingProvider();
    const results = await Promise.all([dispatchMessage(q.messageId, { provider }), dispatchMessage(q.messageId, { provider })]);
    expect(results.map((r) => r.status).sort()).toEqual(["sent", "skipped"]);
    expect(calls).toHaveLength(1);
  });

  it("fails a send whose outcome was never recorded instead of repeating it", async () => {
    const c = await inbound(m.org.id);
    const q = await queueAi(c.conversationId);
    await withSystem((db) => db.query("update conversation_messages set status = 'sending', claimed_at = now() - interval '30 minutes' where id = $1", [q.messageId]));
    const { provider, calls } = recordingProvider();
    const out = await dispatchDue({ provider });
    expect(out.recovered).toBeGreaterThanOrEqual(1);
    // Other queued work from earlier tests may be sent by the same run, but never the message whose outcome is unknown.
    expect(calls.some((call) => call.messageId === q.messageId)).toBe(false);
    expect(await messageRow(q.messageId)).toMatchObject({ status: "failed" });
  });

  it("dispatches whatever is due when the worker runs", async () => {
    const org = await messagingOrg({ name: "Worker Co" });
    const c = await inbound(org.org.id);
    const q = await queueAi(c.conversationId, "Worker message", {}, org);
    const { provider } = recordingProvider();
    const out = await dispatchDue({ provider, limit: 100 });
    expect(out.attempted).toBeGreaterThanOrEqual(1);
    expect((await messageRow(q.messageId)).status).toBe("sent");
  });
});

describe("follow-ups", () => {
  const plan = async (org: MessagingOrg, conversationId: string, now = NOW) => withSystem((db) => startFollowUps(db, { orgId: org.org.id, conversationId, now }));
  const steps = async (planId: string) => (await withSystem((db) => db.query<{ step_number: number; due_at: Date; status: string; channel: string; reason: string | null }>("select step_number, due_at, status, channel, reason from follow_up_steps where plan_id = $1 order by step_number", [planId]))).rows;
  const setPreset = (org: MessagingOrg, preset: string, custom?: unknown) => withSystem((db) => db.query("update messaging_settings set followup_preset = $2, followup_custom = $3 where org_id = $1", [org.org.id, preset, custom ? JSON.stringify(custom) : null]));

  it("schedules the Balanced preset on days 1, 3 and 7, and never creates a second plan for the contact", async () => {
    const org = await messagingOrg({ name: "Balanced Co" });
    const c = await inbound(org.org.id);
    const p = await plan(org, c.conversationId);
    expect(p.steps).toBe(3);
    const rows = await steps(p.planId as string);
    expect(rows.map((r) => (new Date(r.due_at).getTime() - NOW.getTime()) / 86_400_000)).toEqual([1, 3, 7]);
    expect(await plan(org, c.conversationId)).toMatchObject({ planId: p.planId, steps: 0, reason: "already_active" });
  });

  it("supports Gentle, Persistent, Off and custom schedules, always inside the agency maximum", async () => {
    const org = await messagingOrg({ name: "Presets Co" });
    const c = await inbound(org.org.id);
    await setPreset(org, "gentle");
    const gentle = await plan(org, c.conversationId);
    expect(gentle.steps).toBe(2);
    await withSystem((db) => db.query("update follow_up_plans set status = 'cancelled', closed_at = now() where org_id = $1", [org.org.id]));
    await setPreset(org, "persistent");
    expect((await plan(org, c.conversationId)).steps).toBe(5);
    await withSystem((db) => db.query("update follow_up_plans set status = 'cancelled', closed_at = now() where org_id = $1", [org.org.id]));
    await withSystem((db) => db.query("update messaging_policy set max_followup_attempts = 2"));
    expect((await plan(org, c.conversationId)).steps).toBe(2); // the agency limit overrides the preset
    await withSystem((db) => db.query("update messaging_policy set max_followup_attempts = 5"));
    await withSystem((db) => db.query("update follow_up_plans set status = 'cancelled', closed_at = now() where org_id = $1", [org.org.id]));
    await setPreset(org, "custom", { attempts: 4, daysBetween: [2, 5], channel: "same", businessHoursOnly: true });
    const custom = await plan(org, c.conversationId);
    expect((await steps(custom.planId as string)).map((r) => (new Date(r.due_at).getTime() - NOW.getTime()) / 86_400_000)).toEqual([2, 7, 12, 17]);
    await withSystem((db) => db.query("update follow_up_plans set status = 'cancelled', closed_at = now() where org_id = $1", [org.org.id]));
    await setPreset(org, "off");
    expect(await plan(org, c.conversationId)).toMatchObject({ planId: null, reason: "off" });
  });

  it("shares one allowance across SMS, WhatsApp and email for the same person", async () => {
    const org = await messagingOrg({ name: "Cross Channel Co" });
    const number = phone();
    const sms = await inbound(org.org.id, { address: number, channel: "sms" });
    const wa = await inbound(org.org.id, { address: number, channel: "whatsapp" });
    const first = await plan(org, sms.conversationId);
    const second = await plan(org, wa.conversationId);
    expect(first.steps).toBe(3);
    expect(second).toMatchObject({ planId: first.planId, reason: "already_active" });
    const all = await withSystem((db) => db.query("select 1 from follow_up_steps where contact_id = $1", [sms.contactId]));
    expect(all.rows).toHaveLength(3);
  });

  it("limits a contact to the agency's 30-day allowance at planning time and again at send time, across channels", async () => {
    const org = await messagingOrg({ name: "Cap Co" });
    const c = await inbound(org.org.id);
    const p = await plan(org, c.conversationId); // planned under the normal limit of six: three steps
    expect(p.steps).toBe(3);
    // The agency lowers the limit afterwards: the plan must still obey the new one when it sends.
    await withSystem((db) => db.query("update messaging_policy set max_followups_per_contact_30d = 2"));
    try {
      const { provider } = recordingProvider();
      for (const day of [1, 3, 7]) {
        await processDueFollowUps({ now: days(day) });
        for (const row of (await withSystem((db) => db.query<{ id: string }>("select id from conversation_messages where conversation_id = $1 and scope = 'followup' and status = 'queued'", [c.conversationId]))).rows) await dispatchMessage(row.id, { provider, now: days(day) });
      }
      const rows = await steps(p.planId as string);
      expect(rows.map((r) => r.status)).toEqual(["sent", "sent", "blocked"]);
      expect(rows[2].reason).toBe("followup_limit");
      // A fresh plan for the same person, even on another channel, gets nothing more this month.
      const wa = await inbound(org.org.id, { address: c.address, channel: "whatsapp" });
      expect(await plan(org, wa.conversationId, days(8))).toMatchObject({ planId: null, reason: "followup_limit" });
    } finally {
      await withSystem((db) => db.query("update messaging_policy set max_followups_per_contact_30d = 6"));
    }
  });

  it("stops the sequence when the customer replies", async () => {
    const org = await messagingOrg({ name: "Reply Stops Co" });
    const c = await inbound(org.org.id);
    const p = await plan(org, c.conversationId);
    await processDueFollowUps({ now: days(1) });
    const queued = (await withSystem((db) => db.query<{ id: string }>("select id from conversation_messages where conversation_id = $1 and scope = 'followup'", [c.conversationId]))).rows[0].id;
    await inbound(org.org.id, { address: c.address, body: "Actually yes, still interested!" });
    expect((await withSystem((db) => db.query<{ status: string; cancel_reason: string }>("select status, cancel_reason from follow_up_plans where id = $1", [p.planId]))).rows[0]).toEqual({ status: "cancelled", cancel_reason: "customer_replied" });
    expect(await messageRow(queued)).toMatchObject({ status: "blocked", blocked_reason: "customer_replied" });
    expect((await steps(p.planId as string)).every((s) => s.status === "cancelled")).toBe(true);
  });

  it("stops the sequence when the customer books, opts out, or a person takes over", async () => {
    const org = await messagingOrg({ name: "Stop Conditions Co" });
    for (const [reason, trigger] of [
      ["customer_booked", async (c: Awaited<ReturnType<typeof inbound>>) => withSystem((db) => onBooking(db, org.org.id, c.contactId))],
      ["customer_opted_out", async (c: Awaited<ReturnType<typeof inbound>>) => inbound(org.org.id, { address: c.address, body: "STOP" })],
      ["human_took_over", async (c: Awaited<ReturnType<typeof inbound>>) => takeOverConversation(org.ctx("manager"), c.conversationId)],
    ] as const) {
      const c = await inbound(org.org.id);
      const p = await plan(org, c.conversationId);
      await trigger(c);
      const row = await withSystem((db) => db.query<{ status: string; cancel_reason: string }>("select status, cancel_reason from follow_up_plans where id = $1", [p.planId]));
      expect(row.rows[0], reason).toEqual({ status: "cancelled", cancel_reason: reason });
    }
  });

  it("does not start a plan for a conversation a person owns", async () => {
    const org = await messagingOrg({ name: "Human Owned Co" });
    const c = await inbound(org.org.id);
    await takeOverConversation(org.ctx("manager"), c.conversationId);
    expect(await plan(org, c.conversationId)).toMatchObject({ planId: null, reason: "human_owner" });
  });

  it("cancels the plan when automation is paused, and when credits run out", async () => {
    const org = await messagingOrg({ name: "Pause Plan Co" });
    const a = await inbound(org.org.id);
    const pa = await plan(org, a.conversationId);
    await setClientPause(org.ctx("owner"), { scope: "outbound", paused: true });
    await processDueFollowUps({ now: days(1) });
    expect((await withSystem((db) => db.query<{ cancel_reason: string }>("select cancel_reason from follow_up_plans where id = $1", [pa.planId]))).rows[0].cancel_reason).toBe("automation_paused");
    await setClientPause(org.ctx("owner"), { scope: "outbound", paused: false });
    const broke = await messagingOrg({ name: "Broke Plan Co", credits: 0 });
    const b = await inbound(broke.org.id);
    const pb = await plan(broke, b.conversationId);
    await processDueFollowUps({ now: days(1) });
    expect((await withSystem((db) => db.query<{ cancel_reason: string }>("select cancel_reason from follow_up_plans where id = $1", [pb.planId]))).rows[0].cancel_reason).toBe("budget_exhausted");
  });

  it("holds follow-ups through quiet hours and sends them at the next allowed time", async () => {
    const org = await messagingOrg({ name: "Quiet Hours Co" });
    const c = await inbound(org.org.id);
    const p = await plan(org, c.conversationId);
    await withSystem((db) => db.query("update messaging_policy set quiet_hours_start = '21:00', quiet_hours_end = '08:00'"));
    try {
      const lateNight = at(1, 23);
      await processDueFollowUps({ now: lateNight });
      const msg = (await withSystem((db) => db.query<{ id: string; send_after: Date; status: string }>("select id, send_after, status from conversation_messages where conversation_id = $1 and scope = 'followup'", [c.conversationId]))).rows[0];
      expect(msg.status).toBe("queued");
      expect(new Date(msg.send_after).toISOString()).toBe(at(2, 8).toISOString());
      const { provider, calls } = recordingProvider();
      expect(await dispatchMessage(msg.id, { provider, now: at(2, 7) })).toEqual({ status: "skipped" });
      expect(await dispatchMessage(msg.id, { provider, now: at(2, 8, 30) })).toEqual({ status: "sent" });
      expect(calls).toHaveLength(1);
      expect((await steps(p.planId as string))[0].status).toBe("sent");
    } finally {
      await withSystem((db) => db.query("update messaging_policy set quiet_hours_start = '00:00', quiet_hours_end = '00:00'"));
    }
  });

  it("writes follow-ups that name the AI and offer an opt-out", () => {
    expect(DEFAULT_FOLLOWUP_TEXT("Lakeside Dental", 1)).toMatch(/AI assistant for Lakeside Dental/);
    expect(DEFAULT_FOLLOWUP_TEXT("Lakeside Dental", 2)).toMatch(/Reply STOP to opt out/);
  });
});
