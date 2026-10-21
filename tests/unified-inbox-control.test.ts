import { beforeAll, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/server/env";
import { withSystem, withUser } from "@/server/db";
import { assignConversation, claimEscalation, resumeAi, takeOverConversation } from "@/server/messaging/handoff";
import { assignAiEmployee, pauseAi, transferConversation } from "@/server/messaging/ai-control";
import { approveDraft, bulkUpdateConversations, retryFailedMessage, sendHumanReply, setConversationState, getConversationDetail } from "@/server/messaging/inbox";
import { respondToConversation } from "@/server/messaging/responder";
import { dispatchMessage, queueOutbound } from "@/server/messaging/send";
import { unconfirmedOutcome } from "@/lib/messaging";
import { canHandleConversations, describeConversationEvent } from "@/lib/inbox";
import { createOrg } from "./support/fixtures";
import { inbound, messageRow, messagingOrg, recordingProvider, type MessagingOrg } from "./support/messaging";

let m: MessagingOrg;

beforeAll(async () => {
  resetEnvCache();
  m = await messagingOrg({ name: "Unified Inbox Control Co" });
});

const conv = async (id: string) => (await withSystem((db) => db.query<Record<string, unknown>>("select * from conversations where id = $1", [id]))).rows[0];
const events = async (id: string) => (await withSystem((db) => db.query<{ kind: string; actor_kind: string; detail: Record<string, unknown> }>("select kind, actor_kind, detail from conversation_events where conversation_id = $1 order by id", [id]))).rows;
const crmEvents = async (orgId: string, type: string) => (await withSystem((db) => db.query<{ dedupe_key: string; payload: Record<string, unknown> }>("select dedupe_key, payload from crm_events where org_id = $1 and type = $2", [orgId, type]))).rows;
const setupAgent = async (org: MessagingOrg, role: string) => {
  const { rows } = await withSystem((db) => db.query<{ id: string }>("select id from agent_instances where org_id = $1 and role_key = $2", [org.org.id, role]));
  await withSystem((db) => db.query("update agent_instances set status = 'online', last_health_ok = true, enabled = true, mode = 'autonomous' where id = $1", [rows[0].id]));
  return rows[0].id;
};
const preparedUnder = async (conversationId: string) => Number((await conv(conversationId)).ownership_version);

describe("which AI employees may handle a conversation", () => {
  it("names only the customer-facing roles", () => {
    expect(canHandleConversations("sales_assistant")).toBe(true);
    expect(canHandleConversations("appointment_setter")).toBe(true);
    for (const internal of ["operations_manager", "lead_hunter", "crm_manager", "performance_analyst", "", null, undefined]) expect(canHandleConversations(internal)).toBe(false);
  });

  it("lets a manager choose between the two, and refuses the four that work behind the scenes", async () => {
    const setter = await setupAgent(m, "appointment_setter");
    const c = await inbound(m.org.id);
    expect(await assignAiEmployee(m.ctx("manager"), c.conversationId, setter)).toEqual({ agentId: setter, ownerKind: "ai" });
    expect((await conv(c.conversationId)).ai_agent_id).toBe(setter);
    expect((await events(c.conversationId)).map((e) => e.kind)).toContain("ai_assigned");
    for (const role of ["lead_hunter", "operations_manager", "crm_manager", "performance_analyst"]) {
      const id = await setupAgent(m, role);
      await expect(assignAiEmployee(m.ctx("manager"), c.conversationId, id)).rejects.toThrow(/can't talk to customers/);
    }
    expect((await conv(c.conversationId)).ai_agent_id).toBe(setter);
  });

  it("is a manager's decision, scoped to this workspace, and needs the employee to be ready", async () => {
    const c = await inbound(m.org.id);
    await expect(assignAiEmployee(m.ctx("sales"), c.conversationId, m.salesAgentId)).rejects.toThrow(/Only owners and managers/);
    const other = await messagingOrg({ name: "Foreign Agents Co" });
    await expect(assignAiEmployee(m.ctx("manager"), c.conversationId, other.salesAgentId)).rejects.toThrow(/isn't part of this workspace/);
    const setter = await setupAgent(m, "appointment_setter");
    await withSystem((db) => db.query("update agent_instances set status = 'offline' where id = $1", [setter]));
    await expect(assignAiEmployee(m.ctx("manager"), c.conversationId, setter)).rejects.toThrow(/connection check/);
    await withSystem((db) => db.query("update agent_instances set status = 'online' where id = $1", [setter]));
  });

  it("attaches the employee to a conversation a person owns without letting it speak", async () => {
    const setter = await setupAgent(m, "appointment_setter");
    const c = await inbound(m.org.id);
    await takeOverConversation(m.ctx("manager"), c.conversationId);
    expect(await assignAiEmployee(m.ctx("owner"), c.conversationId, setter)).toEqual({ agentId: setter, ownerKind: "human" });
    const blocked = await withSystem((db) => queueOutbound(db, { orgId: m.org.id, conversationId: c.conversationId, scope: "reply", actor: { kind: "ai", agentId: setter }, body: "hi" }));
    expect(blocked).toMatchObject({ status: "blocked", reason: "human_owner" });
  });
});

describe("pausing the AI", () => {
  it("stops its replies without making a person the owner, and keeps its drafts for a person to approve", async () => {
    const org = await messagingOrg({ name: "Pause Co", autoReply: false });
    const c = await inbound(org.org.id);
    const draft = await withSystem((db) => queueOutbound(db, { orgId: org.org.id, conversationId: c.conversationId, scope: "reply", actor: { kind: "ai", agentId: org.salesAgentId }, body: "Happy to help with that." }));
    expect(draft.status).toBe("draft");
    const before = await preparedUnder(c.conversationId);
    expect(await pauseAi(org.ctx("manager"), c.conversationId, "Customer asked us to wait")).toEqual({ changed: true });
    const row = await conv(c.conversationId);
    expect(row).toMatchObject({ owner_kind: "ai", ownership_version: before + 1 });
    expect(row.ai_paused_at).not.toBeNull();
    expect(row.ai_pause_reason).toBe("Customer asked us to wait");
    // A second pause changes nothing.
    expect(await pauseAi(org.ctx("manager"), c.conversationId)).toEqual({ changed: false });
    // The AI cannot send on its own now.
    const auto = await withSystem((db) => queueOutbound(db, { orgId: org.org.id, conversationId: c.conversationId, scope: "reply", actor: { kind: "ai", agentId: org.salesAgentId }, body: "Another thing" }));
    expect(auto).toMatchObject({ status: "blocked", reason: "ai_paused" });
    // The earlier draft is still there, and a person approving it is allowed to send it.
    expect((await messageRow(draft.messageId)).status).toBe("draft");
    await approveDraft(org.ctx("manager"), draft.messageId);
    expect((await messageRow(draft.messageId)).status).toBe("queued");
    expect((await events(c.conversationId)).find((e) => e.kind === "ai_paused")?.detail).toEqual({ reason: "Customer asked us to wait" });
  });

  it("is lifted by resume with the same safety checks, and a takeover ends it too", async () => {
    const c = await inbound(m.org.id);
    await pauseAi(m.ctx("manager"), c.conversationId);
    await withSystem((db) => db.query("update agent_instances set status = 'offline' where id = $1", [m.salesAgentId]));
    await expect(resumeAi(m.ctx("manager"), c.conversationId)).rejects.toThrow(/connection check/);
    await withSystem((db) => db.query("update agent_instances set status = 'online' where id = $1", [m.salesAgentId]));
    expect(await resumeAi(m.ctx("manager"), c.conversationId)).toEqual({ ownerKind: "ai" });
    expect((await conv(c.conversationId)).ai_paused_at).toBeNull();
    expect((await events(c.conversationId)).map((e) => e.kind)).toContain("ai_resumed");
    await pauseAi(m.ctx("manager"), c.conversationId);
    await assignConversation(m.ctx("manager"), c.conversationId, m.people.sales.id);
    await takeOverConversation(m.ctx("sales"), c.conversationId);
    expect(await conv(c.conversationId)).toMatchObject({ owner_kind: "human", ai_paused_at: null, ai_pause_reason: null });
  });

  it("cannot pause what the AI is not handling, and cannot be done by someone who cannot reply", async () => {
    const c = await inbound(m.org.id);
    await takeOverConversation(m.ctx("manager"), c.conversationId);
    await expect(pauseAi(m.ctx("owner"), c.conversationId)).rejects.toThrow(/A person is handling/);
    await expect(pauseAi(m.ctx("viewer"), c.conversationId)).rejects.toThrow(/can't pause/);
    const hidden = await inbound(m.org.id);
    await expect(pauseAi(m.ctx("support"), hidden.conversationId)).rejects.toThrow(/not found/i);
  });
});

describe("a reply prepared for an earlier situation is never sent", () => {
  it("is refused at queue time when ownership changed and changed back while it was being written", async () => {
    const c = await inbound(m.org.id);
    const fence = await preparedUnder(c.conversationId);
    await takeOverConversation(m.ctx("manager"), c.conversationId);
    await resumeAi(m.ctx("manager"), c.conversationId);
    // The owner is the AI again, so an owner-kind check alone would let it through.
    expect((await conv(c.conversationId)).owner_kind).toBe("ai");
    const stale = await withSystem((db) => queueOutbound(db, { orgId: m.org.id, conversationId: c.conversationId, scope: "reply", actor: { kind: "ai", agentId: m.salesAgentId }, body: "Written earlier", fenceVersion: fence }));
    expect(stale).toMatchObject({ status: "blocked", reason: "stale_ownership" });
    const current = await preparedUnder(c.conversationId);
    const fresh = await withSystem((db) => queueOutbound(db, { orgId: m.org.id, conversationId: c.conversationId, scope: "reply", actor: { kind: "ai", agentId: m.salesAgentId }, body: "Written now", fenceVersion: current }));
    expect(fresh.status).toBe("queued");
  });

  it("is refused again at dispatch when the conversation moved after it was queued", async () => {
    const c = await inbound(m.org.id);
    const q = await withSystem((db) => queueOutbound(db, { orgId: m.org.id, conversationId: c.conversationId, scope: "reply", actor: { kind: "ai", agentId: m.salesAgentId }, body: "Queued reply" }));
    expect(q.status).toBe("queued");
    expect((await messageRow(q.messageId)).ownership_fence).toBe(await preparedUnder(c.conversationId));
    // Something changed who may speak (here: a different employee was attached) without cancelling the queued message.
    await withSystem((db) => db.query("update conversations set ownership_version = ownership_version + 1 where id = $1", [c.conversationId]));
    const rec = recordingProvider();
    const out = await dispatchMessage(q.messageId, { provider: rec.provider });
    expect(out.status).toBe("blocked");
    expect(rec.calls).toHaveLength(0);
    expect(await messageRow(q.messageId)).toMatchObject({ status: "blocked", blocked_reason: "stale_ownership" });
  });

  it("makes the responder drop a reply when a person took over and handed back during generation", async () => {
    const c = await inbound(m.org.id, { body: "Can you help me with a quote?" });
    const result = await respondToConversation(m.org.id, c.conversationId, {
      generate: async () => {
        await takeOverConversation(m.ctx("manager"), c.conversationId);
        await resumeAi(m.ctx("manager"), c.conversationId);
        return { kind: "reply", text: "Of course, here is your quote." };
      },
    });
    expect(result).toEqual({ status: "skipped", reason: "conversation_changed" });
    const out = await withSystem((db) => db.query("select 1 from conversation_messages where conversation_id = $1 and direction = 'outbound'", [c.conversationId]));
    expect(out.rows).toHaveLength(0);
  });

  it("does not even generate a reply while the AI is paused", async () => {
    const c = await inbound(m.org.id);
    await pauseAi(m.ctx("manager"), c.conversationId);
    let called = false;
    const result = await respondToConversation(m.org.id, c.conversationId, { generate: async () => { called = true; return { kind: "reply", text: "x" }; } });
    expect(result).toEqual({ status: "skipped", reason: "ai_paused" });
    expect(called).toBe(false);
  });
});

describe("handing a conversation to someone", () => {
  it("makes them the owner, stops the AI, tells them once and records it", async () => {
    const c = await inbound(m.org.id);
    const q = await withSystem((db) => queueOutbound(db, { orgId: m.org.id, conversationId: c.conversationId, scope: "reply", actor: { kind: "ai", agentId: m.salesAgentId }, body: "Queued" }));
    expect(await transferConversation(m.ctx("manager"), c.conversationId, m.people.support.id)).toEqual({ ownerUserId: m.people.support.id });
    expect(await conv(c.conversationId)).toMatchObject({ owner_kind: "human", owner_user_id: m.people.support.id, assigned_user_id: m.people.support.id });
    expect((await messageRow(q.messageId)).status).toBe("blocked");
    const notes = await withSystem((db) => db.query("select 1 from notifications where user_id = $1 and kind = 'conversation_assigned' and link like $2", [m.people.support.id, `%${c.conversationId}%`]));
    expect(notes.rows).toHaveLength(1);
    expect(await transferConversation(m.ctx("manager"), c.conversationId, m.people.support.id)).toEqual({ ownerUserId: m.people.support.id });
    const again = await withSystem((db) => db.query("select 1 from notifications where user_id = $1 and kind = 'conversation_assigned' and link like $2", [m.people.support.id, `%${c.conversationId}%`]));
    expect(again.rows).toHaveLength(1);
    const own = await withSystem((db) => db.query<{ to_kind: string; reason: string }>("select to_kind, reason from conversation_ownership_events where conversation_id = $1 order by id", [c.conversationId]));
    expect(own.rows.at(-1)).toMatchObject({ to_kind: "human", reason: expect.stringContaining("Handed to") });
  });

  it("reads in the thread as one plain line, not as a takeover with a reason attached", async () => {
    const c = await inbound(m.org.id);
    await transferConversation(m.ctx("manager"), c.conversationId, m.people.support.id);
    const lines = (await getConversationDetail(m.ctx("manager"), c.conversationId)).events.map((e) => e.text);
    expect(lines).toEqual(["Handed to Sue Support"]);
    // A person taking it over themselves is a takeover, with the reason they gave.
    const d = await inbound(m.org.id);
    await assignConversation(m.ctx("manager"), d.conversationId, m.people.sales.id);
    await takeOverConversation(m.ctx("sales"), d.conversationId, "Billing question");
    expect((await getConversationDetail(m.ctx("sales"), d.conversationId)).events.map((e) => e.text)).toContain("Sam Sales took over · Billing question");
  });

  it("lets the current owner pass it on, but not another working teammate take it from them", async () => {
    const c = await inbound(m.org.id);
    await assignConversation(m.ctx("manager"), c.conversationId, m.people.sales.id);
    await takeOverConversation(m.ctx("sales"), c.conversationId);
    await expect(transferConversation(m.ctx("support"), c.conversationId, m.people.support.id)).rejects.toThrow(/not found|Only the person handling/i);
    expect(await transferConversation(m.ctx("sales"), c.conversationId, m.people.manager.id)).toEqual({ ownerUserId: m.people.manager.id });
  });

  it("refuses a recipient who cannot reply, who is not on the team, or who is in another workspace", async () => {
    const c = await inbound(m.org.id);
    await expect(transferConversation(m.ctx("manager"), c.conversationId, m.people.viewer.id)).rejects.toThrow(/can't reply to customers/);
    const other = await messagingOrg({ name: "Other Team Co" });
    await expect(transferConversation(m.ctx("manager"), c.conversationId, other.people.owner.id)).rejects.toThrow(/not on your team/);
  });

  it("leaves the business owner's priority window alone", async () => {
    const c = await inbound(m.org.id, { body: "I want to speak to a real person please" });
    await expect(transferConversation(m.ctx("manager"), c.conversationId, m.people.support.id)).rejects.toThrow(/first priority/);
    await claimEscalation(m.ctx("owner"), (await withSystem((db) => db.query<{ id: string }>("select id from human_escalations where conversation_id = $1", [c.conversationId]))).rows[0].id);
    expect(await transferConversation(m.ctx("owner"), c.conversationId, m.people.support.id)).toEqual({ ownerUserId: m.people.support.id });
  });

  it("records assigning a teammate as a lifecycle event and tells them", async () => {
    const c = await inbound(m.org.id);
    await assignConversation(m.ctx("manager"), c.conversationId, m.people.support.id);
    await assignConversation(m.ctx("manager"), c.conversationId, m.people.support.id);
    expect((await events(c.conversationId)).filter((e) => e.kind === "assigned")).toHaveLength(1);
    const keys = (await crmEvents(m.org.id, "conversation.assigned")).filter((e) => e.payload.conversationId === c.conversationId);
    expect(keys).toHaveLength(1);
    await assignConversation(m.ctx("manager"), c.conversationId, null);
    expect((await events(c.conversationId)).filter((e) => e.kind === "assigned")).toHaveLength(2);
    // Removing the assignment starts no "assigned" automation.
    expect((await crmEvents(m.org.id, "conversation.assigned")).filter((e) => e.payload.conversationId === c.conversationId)).toHaveLength(1);
  });
});

describe("resolving, reopening and archiving", () => {
  it("records the outcome and starts a resolved automation exactly once", async () => {
    const c = await inbound(m.org.id);
    await setConversationState(m.ctx("manager"), c.conversationId, { status: "closed", outcome: "booked" });
    expect(await conv(c.conversationId)).toMatchObject({ status: "closed", outcome: "booked", resolved_by: m.people.manager.id });
    expect((await conv(c.conversationId)).resolved_at).not.toBeNull();
    await setConversationState(m.ctx("manager"), c.conversationId, { status: "closed", outcome: "booked" });
    expect((await crmEvents(m.org.id, "conversation.resolved")).filter((e) => e.payload.conversationId === c.conversationId)).toHaveLength(1);
    await setConversationState(m.ctx("manager"), c.conversationId, { status: "open" });
    expect(await conv(c.conversationId)).toMatchObject({ status: "open", outcome: null, resolved_at: null, resolved_by: null });
  });

  it("refuses to resolve over a customer message the person has not seen, or while a person is being asked for", async () => {
    const c = await inbound(m.org.id);
    const seen = new Date(Date.now() - 60_000).toISOString();
    await expect(setConversationState(m.ctx("manager"), c.conversationId, { status: "closed", seenInboundAt: seen })).rejects.toThrow(/wrote again while you were looking/);
    expect((await conv(c.conversationId)).status).toBe("open");
    const asked = await inbound(m.org.id, { body: "Please let me talk to a human" });
    await expect(setConversationState(m.ctx("manager"), asked.conversationId, { status: "closed" })).rejects.toThrow(/still being asked/);
  });

  it("archives only a resolved conversation, and a new customer message brings it back", async () => {
    const c = await inbound(m.org.id);
    await expect(setConversationState(m.ctx("manager"), c.conversationId, { archived: true })).rejects.toThrow(/Resolve a conversation before archiving/);
    await setConversationState(m.ctx("manager"), c.conversationId, { status: "closed", archived: true });
    expect((await conv(c.conversationId)).archived_at).not.toBeNull();
    await inbound(m.org.id, { address: c.address, body: "Actually, one more question" });
    expect(await conv(c.conversationId)).toMatchObject({ status: "open", archived_at: null, resolved_at: null });
  });

  it("starts an urgent automation only when the priority becomes urgent", async () => {
    const c = await inbound(m.org.id);
    await setConversationState(m.ctx("manager"), c.conversationId, { priority: "high" });
    await setConversationState(m.ctx("manager"), c.conversationId, { priority: "urgent" });
    await setConversationState(m.ctx("manager"), c.conversationId, { priority: "urgent" });
    const urgent = (await crmEvents(m.org.id, "conversation.urgent")).filter((e) => e.payload.conversationId === c.conversationId);
    expect(urgent).toHaveLength(1);
  });

  it("starts a handoff automation when the AI asks for a person", async () => {
    const c = await inbound(m.org.id, { body: "I need a refund right now" });
    const found = (await crmEvents(m.org.id, "conversation.handoff_requested")).filter((e) => e.payload.conversationId === c.conversationId);
    expect(found).toHaveLength(1);
    expect(found[0].payload).toMatchObject({ category: "refund_concern", channel: "sms" });
    expect(JSON.stringify(found[0].payload)).not.toContain("refund right now");
  });

  it("applies the person's own permissions, conversation by conversation, when changing many", async () => {
    const a = await inbound(m.org.id);
    const b = await inbound(m.org.id);
    await assignConversation(m.ctx("manager"), a.conversationId, m.people.support.id);
    const res = await bulkUpdateConversations(m.ctx("support"), [a.conversationId, b.conversationId], { kind: "resolve", outcome: "answered" });
    expect(res.done).toBe(1);
    expect(res.skipped).toEqual([{ id: b.conversationId, reason: expect.stringMatching(/not found/i) }]);
    expect((await conv(a.conversationId)).status).toBe("closed");
    expect((await conv(b.conversationId)).status).toBe("open");
    await expect(bulkUpdateConversations(m.ctx("support"), [a.conversationId], { kind: "assign", userId: m.people.support.id })).rejects.toThrow(/Your role can't/);
    await expect(bulkUpdateConversations(m.ctx("viewer"), [a.conversationId], { kind: "resolve" })).rejects.toThrow(/Your role can't/);
    await expect(bulkUpdateConversations(m.ctx("manager"), Array.from({ length: 51 }, () => a.conversationId.replace(/.$/, "0")), { kind: "mark_read" })).resolves.toBeDefined();
    await expect(bulkUpdateConversations(m.ctx("manager"), [], { kind: "mark_read" })).rejects.toThrow(/at least one/);
  });
});

describe("sending a failed message again", () => {
  const rejectedBy = () => recordingProvider(() => ({ ok: false, retryable: false, error: "The provider rejected the message." }));
  const unclear = () => recordingProvider(() => ({ ok: false, retryable: false, error: "The provider did not answer. The message was not confirmed sent." }));

  async function failedReply(provider: ReturnType<typeof recordingProvider>) {
    const c = await inbound(m.org.id);
    const sent = await sendHumanReply(m.ctx("manager"), c.conversationId, "We can do Thursday at 10.");
    expect((await dispatchMessage(sent.messageId, { provider: provider.provider })).status).toBe("failed");
    return { c, id: sent.messageId };
  }

  it("classifies how it failed: refused by the provider, or never confirmed", async () => {
    const refused = await failedReply(rejectedBy());
    expect(await messageRow(refused.id)).toMatchObject({ status: "failed", failure_kind: "rejected" });
    const lost = await failedReply(unclear());
    expect(await messageRow(lost.id)).toMatchObject({ status: "failed", failure_kind: "unconfirmed" });
  });

  it("recognises the way every transport words an unknown outcome", () => {
    for (const text of ["Twilio could not be reached. The message was not confirmed sent.", "WhatsApp returned 503. The message was not confirmed sent.", "Twilio did not confirm the message.", "Resend did not answer in time.", "The send was started but never confirmed."]) {
      expect(unconfirmedOutcome(text)).toBe(true);
    }
    for (const text of ["The provider rejected the message.", "The destination is not an international (E.164) phone number.", "The message is empty.", null, undefined]) expect(unconfirmedOutcome(text)).toBe(false);
  });

  it("sends a refused message once, as a new linked message, and keeps the first as it was", async () => {
    const { c, id } = await failedReply(rejectedBy());
    const again = await retryFailedMessage(m.ctx("manager"), id);
    const row = await messageRow(again.messageId);
    expect(row).toMatchObject({ status: "queued", retry_of: id, body: "We can do Thursday at 10.", author_kind: "human" });
    expect((await messageRow(id)).status).toBe("failed");
    await expect(retryFailedMessage(m.ctx("manager"), id)).rejects.toThrow(/already sent again/);
    const detail = await getConversationDetail(m.ctx("manager"), c.conversationId);
    expect(detail.messages.find((x) => x.id === id)).toMatchObject({ failureKind: "rejected", retriedBy: again.messageId });
    expect(detail.messages.find((x) => x.id === again.messageId)?.retryOf).toBe(id);
    expect((await events(c.conversationId)).map((e) => e.kind)).toContain("message_retried");
    const rec = recordingProvider();
    expect((await dispatchMessage(again.messageId, { provider: rec.provider })).status).toBe("sent");
    expect(rec.calls).toHaveLength(1);
  });

  it("asks the person to confirm when the first attempt was never confirmed", async () => {
    const { id } = await failedReply(unclear());
    await expect(retryFailedMessage(m.ctx("manager"), id)).rejects.toThrow(/never confirmed.*may already have/);
    const again = await retryFailedMessage(m.ctx("manager"), id, { acknowledgeUnconfirmed: true });
    expect((await messageRow(again.messageId)).status).toBe("queued");
  });

  it("still enforces opt-out and consent, and refuses messages that are not a reply", async () => {
    const { c, id } = await failedReply(rejectedBy());
    await inbound(m.org.id, { address: c.address, body: "STOP" });
    await expect(retryFailedMessage(m.ctx("manager"), id)).rejects.toThrow(/withdrew consent|opted out|suppress/i);
    const other = await inbound(m.org.id);
    await withSystem((db) => db.query("insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status, scope, failure_kind) values ($1, $2, 'outbound', 'ai', 'Nudge', 'failed', 'followup', 'rejected')", [m.org.id, other.conversationId]));
    const nudge = (await withSystem((db) => db.query<{ id: string }>("select id from conversation_messages where conversation_id = $1 and scope = 'followup'", [other.conversationId]))).rows[0].id;
    await expect(retryFailedMessage(m.ctx("manager"), nudge)).rejects.toThrow(/not sent again by hand/);
  });

  it("cannot be used on a message that did not fail, by someone who cannot see it, or from another workspace", async () => {
    const c = await inbound(m.org.id);
    const sent = await sendHumanReply(m.ctx("manager"), c.conversationId, "Fine");
    await expect(retryFailedMessage(m.ctx("manager"), sent.messageId)).rejects.toThrow(/Only a message that failed/);
    const { id } = await failedReply(rejectedBy());
    await expect(retryFailedMessage(m.ctx("support"), id)).rejects.toThrow(/not found/i);
    await expect(retryFailedMessage(m.ctx("viewer"), id)).rejects.toThrow(/can't send/);
    const other = await messagingOrg({ name: "Retry Elsewhere Co" });
    await expect(retryFailedMessage(other.ctx("manager"), id)).rejects.toThrow(/not found/i);
  });

  it("makes concurrent attempts send once", async () => {
    const { id } = await failedReply(rejectedBy());
    const results = await Promise.allSettled([retryFailedMessage(m.ctx("manager"), id), retryFailedMessage(m.ctx("manager"), id), retryFailedMessage(m.ctx("owner"), id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const n = await withSystem((db) => db.query("select 1 from conversation_messages where retry_of = $1", [id]));
    expect(n.rows).toHaveLength(1);
  });
});

describe("what the thread says about lifecycle events", () => {
  it("reads like a sentence and never carries message text", () => {
    expect(describeConversationEvent("assigned", { to: "u" }, { actor: "Mia", target: "Sam" })).toBe("Mia assigned this to Sam");
    expect(describeConversationEvent("assigned", {}, { actor: "Mia" })).toBe("Mia removed the assignment");
    expect(describeConversationEvent("ai_assigned", {}, { actor: "Mia", agent: "AI Appointment Setter" })).toBe("Mia handed this to AI Appointment Setter");
    expect(describeConversationEvent("status_changed", { to: "closed", outcome: "booked" }, { actor: "Mia" })).toBe("Mia resolved this (Appointment booked)");
    expect(describeConversationEvent("handoff_requested", { category: "refund_concern" }, { actor: "System", agent: "AI Sales Assistant" })).toBe("AI Sales Assistant asked for a person to take over (refund concern)");
    expect(describeConversationEvent("something_new", {}, { actor: "Mia" })).toBe("Mia updated this conversation");
  });

  it("is part of the conversation's timeline for people who can open it", async () => {
    const c = await inbound(m.org.id);
    await pauseAi(m.ctx("manager"), c.conversationId, "Waiting for the owner");
    await setConversationState(m.ctx("manager"), c.conversationId, { priority: "high" });
    const d = await getConversationDetail(m.ctx("manager"), c.conversationId);
    const text = d.timeline.map((t) => t.text).join("\n");
    expect(text).toMatch(/paused AI replies: Waiting for the owner/);
    expect(text).toMatch(/set the priority to high/);
  });

  it("keeps the trail append-only, read-only for the application role, and private to the workspace", async () => {
    const c = await inbound(m.org.id);
    await pauseAi(m.ctx("manager"), c.conversationId);
    const row = (await withSystem((db) => db.query<{ id: string }>("select id from conversation_events where conversation_id = $1", [c.conversationId]))).rows[0];
    await expect(withSystem((db) => db.query("update conversation_events set kind = 'archived' where id = $1", [row.id]))).rejects.toThrow();
    await expect(withUser(m.people.manager.id, (db) => db.query("insert into conversation_events (org_id, conversation_id, kind, actor_kind) values ($1, $2, 'archived', 'user')", [m.org.id, c.conversationId]))).rejects.toThrow();
    const seen = await withUser(m.people.manager.id, (db) => db.query("select id from conversation_events where conversation_id = $1", [c.conversationId]));
    expect(seen.rows).toHaveLength(1);
    const foreign = await createOrg({ name: "Foreign Events Co" });
    void foreign;
    const stranger = await messagingOrg({ name: "Event Stranger Co" });
    const hidden = await withUser(stranger.people.owner.id, (db) => db.query("select id from conversation_events where conversation_id = $1", [c.conversationId]));
    expect(hidden.rows).toHaveLength(0);
    // A teammate who cannot see the conversation cannot see its trail either.
    const support = await withUser(m.people.support.id, (db) => db.query("select id from conversation_events where conversation_id = $1", [c.conversationId]));
    expect(support.rows).toHaveLength(0);
  });
});
