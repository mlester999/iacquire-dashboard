import { beforeAll, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/server/env";
import { withSystem } from "@/server/db";
import { memberActor } from "@/server/crm/actor";
import { createTag } from "@/server/crm/tags";
import { crmEventDispatch } from "@/server/crm/dispatch";
import { processWorkflowRuns } from "@/server/crm/workflows/runner";
import { createWorkflow, publishWorkflow, setWorkflowStatus } from "@/server/crm/workflows/definitions";
import { studioEntitlement } from "@/server/automation-studio/entitlement";
import { resumeAi, takeOverConversation } from "@/server/messaging/handoff";
import { assignAiEmployee, transferConversation } from "@/server/messaging/ai-control";
import { approveDraft, retryFailedMessage, sendHumanReply, setConversationState } from "@/server/messaging/inbox";
import { suggestReply } from "@/server/messaging/inbox-ai";
import { createDealFromConversation, createTaskFromConversation, getInboxCrmContext } from "@/server/messaging/inbox-context";
import { listConversationsPage } from "@/server/messaging/inbox-list";
import { inboxSync, loadInboxThread } from "@/server/messaging/inbox-sync";
import { describeChannel, getChannelHealth } from "@/server/messaging/channel-health";
import { respondToConversation } from "@/server/messaging/responder";
import { applyDeliveryEvent, dispatchMessage, queueOutbound } from "@/server/messaging/send";
import { BLOCK_REASON_LABELS } from "@/lib/messaging";
import { inbound, messageRow, messagingOrg, recordingProvider, type MessagingOrg } from "./support/messaging";

// The eighteen acceptance scenarios of the Unified Inbox directive, walked through the real server code against an embedded Postgres.
//
// What is SIMULATED here: every messaging provider (a recording stand-in answers sends and delivery events) and the AI model (a stub returns
// text). Nothing in this file contacts a provider, a model or a customer. What it does prove is the behaviour of this application around
// them: contact matching, rules, ownership, the fence, delivery state, tenant isolation, automation. What it cannot prove is that a real
// provider accepts the request or that a real model answers well; docs/unified-inbox/readiness.md keeps that list.
//
// Scenario 17 (a mobile user) is a browser check, recorded in the readiness report; it is not repeated here.

let m: MessagingOrg;
let other: MessagingOrg;
beforeAll(async () => {
  resetEnvCache();
  m = await messagingOrg({ name: "Acceptance Co" });
  other = await messagingOrg({ name: "Another Business Co" });
});

const rec = recordingProvider();
const row = async (id: string) => (await withSystem((db) => db.query<Record<string, unknown>>("select * from conversations where id = $1", [id]))).rows[0];
const count = async (sql: string, params: unknown[]) => Number((await withSystem((db) => db.query<{ n: string }>(sql, params))).rows[0].n);

async function settle() {
  for (let i = 0; i < 30; i += 1) {
    const d = await crmEventDispatch();
    const r = await processWorkflowRuns();
    if (!d.claimed && !r.claimed && !r.scheduled) return;
  }
}

describe("scenarios 1 to 3: a message arrives and the right person is found", () => {
  it("1-2. a channel receives a message; the existing contact is found by exact identifier, a stranger gets a new contact", async () => {
    const first = await inbound(m.org.id, { name: "Dana Brooks" });
    const again = await inbound(m.org.id, { address: first.address, name: "Dana B." });
    expect(again.contactId).toBe(first.contactId);
    expect(again.conversationId).toBe(first.conversationId);
    const stranger = await inbound(m.org.id, { name: "Someone Else" });
    expect(stranger.contactId).not.toBe(first.contactId);
    expect(await count("select count(*)::text as n from contacts where org_id = $1 and id = any($2)", [m.org.id, [first.contactId, stranger.contactId]])).toBe(2);
    // The same message delivered twice by the provider is one message.
    const msg = await inbound(m.org.id, { address: first.address, providerMessageId: "dup-1" });
    const dup = await inbound(m.org.id, { address: first.address, providerMessageId: "dup-1" });
    expect(dup.status).toBe("duplicate");
    expect(await count("select count(*)::text as n from conversation_messages where conversation_id = $1 and provider_message_id = 'dup-1'", [msg.conversationId])).toBe(1);
  });

  it("3. the conversation appears in the inbox, unread, for the people allowed to see it", async () => {
    const c = await inbound(m.org.id, { name: "Visible Vera" });
    const page = await listConversationsPage(m.ctx("owner"), { view: "unread", limit: 100 });
    expect(page.items.find((i) => i.id === c.conversationId)).toMatchObject({ unread: 1, channel: "sms" });
    // A support person sees only what is assigned to them.
    expect((await listConversationsPage(m.ctx("support"), { limit: 100 })).items.find((i) => i.id === c.conversationId)).toBeUndefined();
  });
});

describe("scenarios 4 and 5: a person replies and the provider reports delivery (SIMULATED provider)", () => {
  it("sends through the provider once and shows 'delivered' only after the provider's own event", async () => {
    const c = await inbound(m.org.id, { name: "Reply Rosa" });
    const queued = await sendHumanReply(m.ctx("manager"), c.conversationId, "Hi Rosa, we can visit Thursday at 10.");
    expect(queued.status).toBe("queued");
    expect((await dispatchMessage(queued.messageId, { provider: rec.provider })).status).toBe("sent");
    expect(rec.calls.filter((x) => x.messageId === queued.messageId)).toHaveLength(1);
    // Accepted by the provider is "sent", never "delivered".
    let thread = await loadInboxThread(m.ctx("owner"), c.conversationId);
    expect(thread!.messages.find((x) => x.id === queued.messageId)).toMatchObject({ status: "sent" });
    const providerId = (await messageRow(queued.messageId)).provider_message_id as string;
    await withSystem((db) => applyDeliveryEvent(db, { provider: "ghl", providerEventId: "ev-accept-1", providerMessageId: providerId, status: "delivered" }));
    thread = await loadInboxThread(m.ctx("owner"), c.conversationId);
    const shown = thread!.messages.find((x) => x.id === queued.messageId)!;
    expect(shown.status).toBe("delivered");
    expect(shown.deliveryEvents.map((e) => e.status)).toContain("delivered");
    // The person who replied now owns the conversation; the AI does not talk over them.
    expect(await row(c.conversationId)).toMatchObject({ owner_kind: "human", owner_user_id: m.people.manager.id });
  });
});

describe("scenarios 6 to 8: an AI employee, and a person who takes over (SIMULATED model)", () => {
  it("6. only an employee that can talk to customers can be assigned, and a person can hand the conversation back to it", async () => {
    const c = await inbound(m.org.id, { name: "Assigned Alma" });
    const back = (await withSystem((db) => db.query<{ id: string }>("select id from agent_instances where org_id = $1 and role_key = 'crm_manager'", [m.org.id]))).rows[0];
    await expect(assignAiEmployee(m.ctx("manager"), c.conversationId, back.id)).rejects.toThrow(/behind the scenes/);
    await takeOverConversation(m.ctx("manager"), c.conversationId);
    expect(await assignAiEmployee(m.ctx("manager"), c.conversationId, m.salesAgentId)).toMatchObject({ agentId: m.salesAgentId, ownerKind: "human" });
    expect(await resumeAi(m.ctx("manager"), c.conversationId)).toEqual({ ownerKind: "ai" });
  });

  it("7. the AI employee answers through the same rule chain as everything else, and its reply is dispatched once", async () => {
    const c = await inbound(m.org.id, { name: "Question Quinn", body: "Do you service the Round Rock area?" });
    const result = await respondToConversation(m.org.id, c.conversationId, { generate: async () => ({ kind: "reply", text: "Yes, we service Round Rock. Would Thursday morning work for a visit?" }) });
    expect(result).toMatchObject({ status: "queued" });
    const id = (result as { messageId: string }).messageId;
    expect(await messageRow(id)).toMatchObject({ author_kind: "ai", status: "queued", scope: "reply" });
    const rc = recordingProvider();
    expect((await dispatchMessage(id, { provider: rc.provider })).status).toBe("sent");
    expect(rc.calls).toHaveLength(1);
    // Asking again for the same customer message does not answer it twice.
    expect(await respondToConversation(m.org.id, c.conversationId, { generate: async () => ({ kind: "reply", text: "again" }) })).toEqual({ status: "skipped", reason: "already_answered" });
  });

  it("8. when a person takes over, an AI reply that was already written is never sent", async () => {
    const c = await inbound(m.org.id, { name: "Takeover Tomas" });
    const queued = await withSystem((db) => queueOutbound(db, { orgId: m.org.id, conversationId: c.conversationId, scope: "reply", actor: { kind: "ai", agentId: m.salesAgentId }, body: "Written by the AI before the takeover." }));
    expect(queued.status).toBe("queued");
    await takeOverConversation(m.ctx("manager"), c.conversationId);
    // The takeover stopped it where it stood; dispatching it anyway finds nothing to send.
    expect(await messageRow(queued.messageId)).toMatchObject({ status: "blocked" });
    const rc = recordingProvider();
    expect((await dispatchMessage(queued.messageId, { provider: rc.provider })).status).not.toBe("sent");
    expect(rc.calls).toHaveLength(0);
    // And one still being written when the person arrives is dropped before it is even queued.
    const d = await inbound(m.org.id, { name: "Takeover Tina" });
    const dropped = await respondToConversation(m.org.id, d.conversationId, {
      generate: async () => {
        await takeOverConversation(m.ctx("manager"), d.conversationId);
        return { kind: "reply", text: "Too late." };
      },
    });
    expect(dropped).toMatchObject({ status: "skipped" });
    expect(await count("select count(*)::text as n from conversation_messages where conversation_id = $1 and direction = 'outbound'", [d.conversationId])).toBe(0);
  });
});

describe("scenarios 9 to 11: handing over, CRM links, automation", () => {
  it("9. a conversation is transferred to another team member, who is told once", async () => {
    const c = await inbound(m.org.id, { name: "Transfer Tess" });
    expect(await transferConversation(m.ctx("manager"), c.conversationId, m.people.sales.id)).toEqual({ ownerUserId: m.people.sales.id });
    expect(await row(c.conversationId)).toMatchObject({ owner_kind: "human", owner_user_id: m.people.sales.id });
    expect(await count("select count(*)::text as n from notifications where user_id = $1 and kind = 'conversation_assigned' and link like $2", [m.people.sales.id, `%${c.conversationId}%`])).toBe(1);
    // The new owner can now open it; a teammate without access to it cannot.
    expect(await loadInboxThread(m.ctx("sales"), c.conversationId)).not.toBeNull();
    expect(await loadInboxThread(m.ctx("support"), c.conversationId)).toBeNull();
  });

  it("10. a task and a deal are linked from the conversation, and show up beside it", async () => {
    const c = await inbound(m.org.id, { name: "Linked Lena" });
    const task = await createTaskFromConversation(m.ctx("manager"), c.conversationId, { title: "Send Lena the quote" });
    const deal = await createDealFromConversation(m.ctx("manager"), c.conversationId, { name: "Lena: gutter job", value: 1800 });
    const again = await createDealFromConversation(m.ctx("manager"), c.conversationId, { name: "Lena: gutter job", value: 1800 });
    expect(again.opportunityId).toBe(deal.opportunityId);
    const context = await getInboxCrmContext(m.ctx("manager"), c.conversationId);
    expect(context.tasks).toMatchObject({ state: "ok", items: [expect.objectContaining({ id: task.taskId, title: "Send Lena the quote" })] });
    expect(context.deals).toMatchObject({ state: "ok", items: [expect.objectContaining({ id: deal.opportunityId })] });
    const kinds = (await withSystem((db) => db.query<{ kind: string }>("select kind from conversation_events where conversation_id = $1", [c.conversationId]))).rows.map((r) => r.kind);
    expect(kinds).toEqual(expect.arrayContaining(["task_linked", "opportunity_linked"]));
  });

  it("11. a workflow reacts to an inbox event, as the workspace owner published it", async () => {
    const owner = memberActor(m.ctx("owner"));
    const tag = await createTag(owner, { name: "Resolved lead", color: "#16a34a" });
    const { id } = await createWorkflow(owner, {
      name: "Tag resolved conversations",
      definition: { trigger: { type: "conversation.resolved" }, steps: [{ key: "tag", kind: "add_tag", config: { tagIds: [tag.id] }, next: null }] },
    });
    expect((await publishWorkflow(owner, id)).needsApproval).toBe(false);
    await setWorkflowStatus(owner, id, "active");
    const c = await inbound(m.org.id, { name: "Workflow Wanda" });
    await setConversationState(m.ctx("manager"), c.conversationId, { status: "closed", outcome: "answered" });
    await settle();
    expect(await count("select count(*)::text as n from crm_contact_tags where tag_id = $1 and contact_id = $2", [tag.id, c.contactId])).toBe(1);
  });
});

describe("scenarios 12 to 14: consistency, tenants and the plan", () => {
  it("12. two staff members looking at the same thread are told of the same change, with the same thread", async () => {
    const c = await inbound(m.org.id, { name: "Shared Sara" });
    const start = await inboxSync(m.ctx("owner"), null);
    const since = new Date(Date.parse(start.serverTime) - 1000).toISOString();
    await setConversationState(m.ctx("manager"), c.conversationId, { priority: "urgent" });
    const sent = await sendHumanReply(m.ctx("manager"), c.conversationId, "We are on it.");
    await dispatchMessage(sent.messageId, { provider: recordingProvider().provider });
    const a = await inboxSync(m.ctx("owner"), since);
    const b = await inboxSync(m.ctx("manager"), since);
    expect(a.full).toBe(false);
    const seenByA = a.changes.find((x) => x.id === c.conversationId);
    expect(seenByA).toBeDefined();
    expect(b.changes.find((x) => x.id === c.conversationId)).toEqual(seenByA);
    const threadA = await loadInboxThread(m.ctx("owner"), c.conversationId);
    const threadB = await loadInboxThread(m.ctx("manager"), c.conversationId);
    expect(threadA!.messages.map((x) => [x.id, x.status])).toEqual(threadB!.messages.map((x) => [x.id, x.status]));
    expect(threadA!.events.map((e) => e.text)).toEqual(threadB!.events.map((e) => e.text));
    expect(threadA!.conversation).toMatchObject({ priority: "urgent", ownerKind: "human", ownerUserId: m.people.manager.id });
  });

  it("13. someone from another workspace cannot read, list, sync or link to this conversation", async () => {
    const c = await inbound(m.org.id, { name: "Private Priya" });
    const intruder = other.ctx("owner");
    expect(await loadInboxThread(intruder, c.conversationId)).toBeNull();
    expect((await listConversationsPage(intruder, { limit: 100 })).items.map((i) => i.id)).not.toContain(c.conversationId);
    expect(JSON.stringify(await inboxSync(intruder, new Date(Date.now() - 60_000).toISOString()))).not.toContain(c.conversationId);
    await expect(getInboxCrmContext(intruder, c.conversationId)).rejects.toThrow(/not found/i);
    await expect(createTaskFromConversation(intruder, c.conversationId, { title: "Steal" })).rejects.toThrow(/not found/i);
    await expect(sendHumanReply(intruder, c.conversationId, "Hello from outside")).rejects.toThrow();
    expect(await count("select count(*)::text as n from tasks where title = 'Steal'", [])).toBe(0);
  });

  it("14. a workspace without the Automation Studio plan still has the whole core inbox", async () => {
    expect((await withSystem((db) => studioEntitlement(db, m.org.id))).entitled).toBe(false);
    // Everything in scenarios 1 to 13 ran in this workspace: lists, replies, takeover, transfer, links, sync and a CRM workflow.
    const c = await inbound(m.org.id, { name: "No Plan Nina" });
    const sent = await sendHumanReply(m.ctx("manager"), c.conversationId, "Hello Nina.");
    expect(sent.status).toBe("queued");
    await setConversationState(m.ctx("manager"), c.conversationId, { status: "closed", outcome: "answered", archived: true });
    expect((await listConversationsPage(m.ctx("owner"), { view: "archived", limit: 100 })).items.map((i) => i.id)).toContain(c.conversationId);
  });
});

describe("scenarios 15 and 16: honest failures", () => {
  it("15. a provider that is not connected produces an honest state and an honest block, and nothing is sent", async () => {
    const org = await messagingOrg({ name: "Disconnected Co" });
    await withSystem((db) => db.query("update messaging_channels set enabled = false where org_id = $1 and channel = 'sms'", [org.org.id]));
    const health = await getChannelHealth(org.ctx("manager"));
    const sms = health.find((h) => h.key === "sms")!;
    expect(sms.state).not.toBe("connected");
    expect(sms.detail).toMatch(/switched off/i);
    for (const key of ["web_chat", "phone"] as const) expect(health.find((h) => h.key === key)!.state).toBe("not_available");
    const c = await inbound(org.org.id);
    // A person trying to reply is told plainly, and no message row exists that could later look sent.
    await expect(sendHumanReply(org.ctx("manager"), c.conversationId, "Can anyone hear me?")).rejects.toThrow(/SMS is not verified and enabled for this workspace yet/);
    expect(await count("select count(*)::text as n from conversation_messages where conversation_id = $1 and direction = 'outbound'", [c.conversationId])).toBe(0);
    // An AI reply to the same customer is stopped by the same rule and is recorded as blocked, never as sent.
    const ai = await withSystem((db) => queueOutbound(db, { orgId: org.org.id, conversationId: c.conversationId, scope: "reply", actor: { kind: "ai", agentId: org.salesAgentId }, body: "Hello" }));
    expect(ai).toMatchObject({ status: "blocked", reason: "channel_not_ready" });
    expect(BLOCK_REASON_LABELS.channel_not_ready).toMatch(/not verified or enabled/);
    const rc = recordingProvider();
    expect((await dispatchMessage(ai.messageId, { provider: rc.provider })).status).not.toBe("sent");
    expect(rc.calls).toHaveLength(0);
    // The pure rule: no sender is never "connected", and an environment with sending switched off says so.
    expect(describeChannel(undefined, { sent24h: 0, failed24h: 0 }, true).state).toBe("not_connected");
    expect(describeChannel({ channel: "sms", provider: "ghl", enabled: true, sender_verified_at: new Date(), registration_status: "approved", detail: null, capability_tested_at: null }, { sent24h: 0, failed24h: 0 }, false)).toMatchObject({ state: "needs_attention", detail: expect.stringMatching(/switched off in this environment/) });
  });

  it("16. a failed send can be inspected, and sent again once, only as a new linked message", async () => {
    const c = await inbound(m.org.id, { name: "Retry Rita" });
    const sent = await sendHumanReply(m.ctx("manager"), c.conversationId, "See you Thursday at 10.");
    const refused = recordingProvider(() => ({ ok: false, retryable: false, error: "The provider rejected the message (number not reachable)." }));
    expect((await dispatchMessage(sent.messageId, { provider: refused.provider })).status).toBe("failed");
    const thread = await loadInboxThread(m.ctx("manager"), c.conversationId);
    const failed = thread!.messages.find((x) => x.id === sent.messageId)!;
    expect(failed).toMatchObject({ status: "failed", failureKind: "rejected" });
    expect(failed.statusDetail).toMatch(/not reachable/);
    const again = await retryFailedMessage(m.ctx("manager"), sent.messageId);
    expect(await messageRow(again.messageId)).toMatchObject({ retry_of: sent.messageId, status: "queued" });
    await expect(retryFailedMessage(m.ctx("manager"), sent.messageId)).rejects.toThrow(/already sent again/);
    const ok = recordingProvider();
    expect((await dispatchMessage(again.messageId, { provider: ok.provider })).status).toBe("sent");
    expect(ok.calls).toHaveLength(1);
  });
});

describe("scenario 18: an AI suggestion stays a draft until a person sends or approves it", () => {
  it("a suggested reply is text only; an AI draft waits for approval and is sent only after a person approves it", async () => {
    const org = await messagingOrg({ name: "Drafts Co", autonomous: false });
    const c = await inbound(org.org.id, { name: "Draft Dora", body: "What does a gutter clean cost?" });
    const suggestion = await suggestReply(org.ctx("manager"), c.conversationId, { complete: async () => ({ ok: true, text: "Hi Dora, a typical gutter clean starts around the price on our website." }) });
    expect(suggestion).toMatchObject({ ok: true });
    expect(await count("select count(*)::text as n from conversation_messages where org_id = $1 and direction = 'outbound'", [org.org.id])).toBe(0);
    // An employee that must ask first writes a draft; nothing leaves until a person approves it.
    const result = await respondToConversation(org.org.id, c.conversationId, { generate: async () => ({ kind: "reply", text: "Hi Dora, I can have someone call you with a price." }) });
    expect(result).toMatchObject({ status: "draft" });
    const id = (result as { messageId: string }).messageId;
    const rc = recordingProvider();
    expect((await dispatchMessage(id, { provider: rc.provider })).status).not.toBe("sent");
    expect(rc.calls).toHaveLength(0);
    await approveDraft(org.ctx("manager"), id);
    expect((await dispatchMessage(id, { provider: rc.provider })).status).toBe("sent");
    expect(rc.calls).toHaveLength(1);
  });
});
