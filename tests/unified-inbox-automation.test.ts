import { beforeAll, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/server/env";
import { withSystem } from "@/server/db";
import { memberActor } from "@/server/crm/actor";
import { createTag } from "@/server/crm/tags";
import { crmEventDispatch } from "@/server/crm/dispatch";
import { processWorkflowRuns } from "@/server/crm/workflows/runner";
import { createWorkflow, publishWorkflow, setWorkflowStatus } from "@/server/crm/workflows/definitions";
import { studioEntitlement } from "@/server/automation-studio/entitlement";
import { assignConversation } from "@/server/messaging/handoff";
import { setConversationState } from "@/server/messaging/inbox";
import { announceIdleConversations, AWAITING_NOTICE_CAP, idleWindowHours, notifyAwaitingReplies, scanInboxAttention } from "@/server/messaging/attention";
import { JOBS } from "@/server/ops/tick";
import { CONVERSATION_IDLE_HOURS, EVENT_TRIGGER_TYPES, TRIGGERS, validateDefinition, type WorkflowDefinition, type WorkflowStep } from "@/lib/crm/workflow/spec";
import { triggerSummary } from "@/components/crm/workflows/summaries";
import { idleLabel } from "@/lib/inbox";
import { inbound, messagingOrg, type MessagingOrg } from "./support/messaging";

let m: MessagingOrg;
beforeAll(async () => {
  resetEnvCache();
  m = await messagingOrg({ name: "Inbox Automation Co" });
});

const step = (key: string, kind: WorkflowStep["kind"], config: Record<string, unknown>, next: string | null = null): WorkflowStep => ({ key, kind, config, next }) as WorkflowStep;
const count = async (sql: string, params: unknown[]) => Number((await withSystem((db) => db.query<{ n: string }>(sql, params))).rows[0].n);

async function settle() {
  for (let i = 0; i < 25; i += 1) {
    const d = await crmEventDispatch();
    const r = await processWorkflowRuns();
    if (!d.claimed && !r.claimed && !r.scheduled) return;
  }
}

/** A workflow, published and switched on by the workspace owner. */
async function liveWorkflow(org: MessagingOrg, trigger: WorkflowDefinition["trigger"], steps: WorkflowStep[]) {
  const actor = memberActor(org.ctx("owner"));
  const { id } = await createWorkflow(actor, { name: `Inbox workflow ${Math.random().toString(36).slice(2, 8)}`, definition: { trigger, steps } });
  const published = await publishWorkflow(actor, id);
  expect(published.needsApproval).toBe(false);
  await setWorkflowStatus(actor, id, "active");
  return id;
}

/** A workflow, published and switched on, that tags the customer. */
async function tagWorkflow(org: MessagingOrg, trigger: WorkflowDefinition["trigger"]) {
  const tag = await createTag(memberActor(org.ctx("owner")), { name: `T${Math.random().toString(36).slice(2, 8)}`, color: "#2563eb" });
  const id = await liveWorkflow(org, trigger, [step("tag", "add_tag", { tagIds: [tag.id] })]);
  return { id, tagId: tag.id };
}
const runs = (workflowId: string) => count("select count(*)::text as n from crm_workflow_runs where workflow_id = $1", [workflowId]);
const tagged = (tagId: string, contactId: string) => count("select count(*)::text as n from crm_contact_tags where tag_id = $1 and contact_id = $2", [tagId, contactId]);

describe("the triggers a conversation can start", () => {
  it("lists each one, with the filters it supports", () => {
    for (const t of ["conversation.assigned", "conversation.resolved", "conversation.urgent", "conversation.handoff_requested", "conversation.idle"] as const) {
      expect(EVENT_TRIGGER_TYPES).toContain(t);
      expect(TRIGGERS[t]).toMatchObject({ group: "Conversations", entity: "conversation", carries: { contact: "always", opportunity: "never" } });
      expect(TRIGGERS[t].filters).toContain("channels");
    }
    expect(TRIGGERS["conversation.assigned"].filters).toContain("assigneeIds");
    expect(TRIGGERS["conversation.idle"].filters).toContain("idleHours");
  });

  it("needs a chosen time for a quiet conversation, from the offered ones only", () => {
    const def = (type: string, filters?: Record<string, unknown>) => ({ trigger: { type, ...(filters ? { filters } : {}) }, steps: [{ key: "end", kind: "end", config: {}, next: null }] });
    const errors = (d: unknown) => validateDefinition(d, null).filter((i) => i.level === "error").map((i) => `${i.code}:${i.path ?? ""}`);
    expect(errors(def("conversation.idle"))).toContain("invalid_trigger:trigger.filters.idleHours");
    expect(errors(def("conversation.idle", { idleHours: [] }))).not.toEqual([]);
    expect(errors(def("conversation.idle", { idleHours: [5] })).join(",")).toContain("trigger.filters.idleHours");
    expect(errors(def("conversation.idle", { idleHours: [24] }))).toEqual([]);
    expect(errors(def("conversation.idle", { idleHours: [...CONVERSATION_IDLE_HOURS], channels: ["sms"] }))).toEqual([]);
    // Only the quiet-conversation trigger takes the filter.
    expect(errors(def("conversation.resolved", { idleHours: [24] }))).toContain("invalid_trigger:trigger.filters.idleHours");
    expect(errors(def("conversation.resolved", { channels: ["sms", "email"] }))).toEqual([]);
    expect(errors(def("conversation.assigned", { assigneeIds: [m.people.support.id] }))).toEqual([]);
  });

  it("describes itself in words", () => {
    const names = { tag: () => undefined, user: () => undefined, pipeline: () => undefined, stage: () => undefined, calendar: () => undefined, appointmentType: () => undefined, field: () => undefined } as unknown as Parameters<typeof triggerSummary>[1];
    expect(triggerSummary({ type: "conversation.idle", filters: { idleHours: [4, 72], channels: ["sms"] } }, names)).toEqual({ title: "Conversation went quiet", detail: "on SMS · quiet for 4 hours, 3 days" });
    expect(idleLabel(1)).toBe("1 hour");
    expect(idleLabel(24)).toBe("1 day");
    expect(idleLabel(168)).toBe("7 days");
  });
});

describe("a workflow reacting to the inbox", () => {
  it("starts when a conversation is resolved, once, for the right channel, with no Automation Studio plan", async () => {
    expect((await withSystem((db) => studioEntitlement(db, m.org.id))).entitled).toBe(false);
    const wf = await tagWorkflow(m, { type: "conversation.resolved", filters: { channels: ["sms"] } });
    const sms = await inbound(m.org.id);
    await setConversationState(m.ctx("manager"), sms.conversationId, { status: "closed", outcome: "booked" });
    await settle();
    expect(await runs(wf.id)).toBe(1);
    expect(await tagged(wf.tagId, sms.contactId)).toBe(1);
    // Resolving again changes nothing and starts nothing; another channel is not this workflow's.
    await setConversationState(m.ctx("manager"), sms.conversationId, { status: "closed" });
    const email = await inbound(m.org.id, { channel: "email", provider: "resend", address: "buyer@example.test", ghlContactId: null });
    await setConversationState(m.ctx("manager"), email.conversationId, { status: "closed" });
    await settle();
    expect(await runs(wf.id)).toBe(1);
  });

  it("starts when a conversation is assigned to the people it names, and only then", async () => {
    const wf = await tagWorkflow(m, { type: "conversation.assigned", filters: { assigneeIds: [m.people.support.id] } });
    const c = await inbound(m.org.id);
    await assignConversation(m.ctx("manager"), c.conversationId, m.people.sales.id);
    await settle();
    expect(await runs(wf.id)).toBe(0);
    await assignConversation(m.ctx("manager"), c.conversationId, m.people.support.id);
    await settle();
    expect(await runs(wf.id)).toBe(1);
    expect(await tagged(wf.tagId, c.contactId)).toBe(1);
  });

  it("starts when a person is asked for and when a conversation becomes urgent, without the customer's words in the event", async () => {
    const asked = await tagWorkflow(m, { type: "conversation.handoff_requested" });
    const urgent = await tagWorkflow(m, { type: "conversation.urgent" });
    const c = await inbound(m.org.id, { body: "I need a refund immediately, my card number is 4111 1111 1111 1111" });
    await settle();
    expect(await runs(asked.id)).toBe(1);
    const ev = await withSystem((db) => db.query<{ payload: Record<string, unknown> }>("select payload from crm_events where org_id = $1 and type = 'conversation.handoff_requested' and entity_id = $2", [m.org.id, c.conversationId]));
    expect(JSON.stringify(ev.rows[0].payload)).not.toMatch(/4111|refund immediately/);
    // The escalation also raised the priority to urgent.
    expect(await runs(urgent.id)).toBe(1);
  });

  it("keeps the whole inbox working without the plan: replying, assigning, pausing and resolving need no workflow", async () => {
    const org = await messagingOrg({ name: "No Plan Co" });
    expect((await withSystem((db) => studioEntitlement(db, org.org.id))).entitled).toBe(false);
    const c = await inbound(org.org.id);
    await assignConversation(org.ctx("manager"), c.conversationId, org.people.support.id);
    await setConversationState(org.ctx("manager"), c.conversationId, { priority: "urgent" });
    await setConversationState(org.ctx("manager"), c.conversationId, { status: "closed", outcome: "answered" });
    const row = (await withSystem((db) => db.query<{ status: string; priority: string; outcome: string }>("select status, priority, outcome from conversations where id = $1", [c.conversationId]))).rows[0];
    expect(row).toEqual({ status: "closed", priority: "urgent", outcome: "answered" });
    // The events were recorded for any workflow that later listens; nothing ran because nothing listens.
    expect(await count("select count(*)::text as n from crm_workflow_runs where org_id = $1", [org.org.id])).toBe(0);
  });
});

describe("conversations that went quiet", () => {
  const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000);
  const setLast = (id: string, at: Date) => withSystem((db) => db.query("update conversations set last_message_at = $2 where id = $1", [id, at]));

  it("announces each chosen time once, only to workspaces whose workflows listen, and starts the count again after a message", async () => {
    const org = await messagingOrg({ name: "Quiet Co" });
    const c = await inbound(org.org.id);
    await setLast(c.conversationId, ago(25));
    // Nobody listens yet: nothing is recorded.
    expect(await withSystem((db) => announceIdleConversations(db))).toBe(0);
    const wf = await tagWorkflow(org, { type: "conversation.idle", filters: { idleHours: [24] } });
    expect(await withSystem((db) => announceIdleConversations(db))).toBe(1);
    expect(await withSystem((db) => announceIdleConversations(db))).toBe(0);
    await settle();
    expect(await runs(wf.id)).toBe(1);
    expect(await tagged(wf.tagId, c.contactId)).toBe(1);
    // Not yet quiet for long enough, past its window, resolved, or archived: not announced.
    const recent = await inbound(org.org.id);
    await setLast(recent.conversationId, ago(23));
    const stale = await inbound(org.org.id);
    await setLast(stale.conversationId, ago(24 + idleWindowHours(24) + 1));
    const done = await inbound(org.org.id);
    await setLast(done.conversationId, ago(25));
    await setConversationState(org.ctx("manager"), done.conversationId, { status: "closed" });
    await setLast(done.conversationId, ago(25));
    expect(await withSystem((db) => announceIdleConversations(db))).toBe(0);
    // A new message starts the count again: the same conversation can be announced for its new last message.
    await withSystem((db) => db.query("update conversations set last_message_at = $2 where id = $1", [c.conversationId, ago(24.5)]));
    expect(await withSystem((db) => announceIdleConversations(db))).toBe(1);
  });

  it("announces only the times a workflow asked for", async () => {
    const org = await messagingOrg({ name: "Quiet Times Co" });
    const c = await inbound(org.org.id);
    await setLast(c.conversationId, ago(1.2));
    await tagWorkflow(org, { type: "conversation.idle", filters: { idleHours: [24] } });
    expect(await withSystem((db) => announceIdleConversations(db))).toBe(0);
    await tagWorkflow(org, { type: "conversation.idle", filters: { idleHours: [1] } });
    expect(await withSystem((db) => announceIdleConversations(db))).toBe(1);
  });
});

describe("telling people a customer is waiting", () => {
  const waitingSince = (id: string, minutes: number) =>
    withSystem((db) => db.query("update conversations set last_inbound_at = now() - ($2 || ' minutes')::interval, unread_count = 1, last_outbound_at = null where id = $1", [id, String(minutes)]));
  const notes = (userId: string, kind: string) => count("select count(*)::text as n from notifications where user_id = $1 and kind = $2", [userId, kind]);

  it("tells the person handling it once per customer message, and nobody else", async () => {
    const org = await messagingOrg({ name: "Waiting Co" });
    const c = await inbound(org.org.id);
    await assignConversation(org.ctx("manager"), c.conversationId, org.people.support.id);
    await waitingSince(c.conversationId, 5);
    expect(await withSystem((db) => notifyAwaitingReplies(db))).toBe(0);
    await waitingSince(c.conversationId, 45);
    expect(await withSystem((db) => notifyAwaitingReplies(db))).toBe(1);
    expect(await notes(org.people.support.id, "conversation_awaiting_reply")).toBe(1);
    expect(await withSystem((db) => notifyAwaitingReplies(db))).toBe(0);
    expect(await notes(org.people.sales.id, "conversation_awaiting_reply")).toBe(0);
    const body = (await withSystem((db) => db.query<{ title: string; body: string }>("select title, body from notifications where user_id = $1 and kind = 'conversation_awaiting_reply'", [org.people.support.id]))).rows[0];
    expect(`${body.title} ${body.body}`).not.toContain("availability");
    // Answering it ends the waiting; a person who has opened it no longer needs telling.
    await withSystem((db) => db.query("update conversations set last_outbound_at = now() where id = $1", [c.conversationId]));
    await waitingSince(c.conversationId, 50);
    await withSystem((db) => db.query("update conversations set last_outbound_at = now() where id = $1", [c.conversationId]));
    expect(await withSystem((db) => notifyAwaitingReplies(db))).toBe(0);
  });

  it("goes to the owners and managers when nobody is assigned, and caps a flood at one summary", async () => {
    const org = await messagingOrg({ name: "Flood Co" });
    const ids: string[] = [];
    for (let i = 0; i < AWAITING_NOTICE_CAP + 3; i += 1) {
      const c = await inbound(org.org.id);
      await waitingSince(c.conversationId, 40 + i);
      ids.push(c.conversationId);
    }
    await withSystem((db) => notifyAwaitingReplies(db));
    expect(await notes(org.people.owner.id, "conversation_awaiting_reply")).toBe(AWAITING_NOTICE_CAP + 1);
    expect(await notes(org.people.manager.id, "conversation_awaiting_reply")).toBe(AWAITING_NOTICE_CAP + 1);
    const digest = await withSystem((db) => db.query<{ title: string }>("select title from notifications where user_id = $1 and title like '%customers are waiting%'", [org.people.owner.id]));
    expect(digest.rows).toHaveLength(1);
    expect(await notes(org.people.support.id, "conversation_awaiting_reply")).toBe(0);
  });

  it("is part of the scheduler, on its own five-minute rhythm", async () => {
    const job = JOBS.find((j) => j.name === "inboxAttention");
    expect(job?.everyMinutes).toBe(5);
    expect(await scanInboxAttention()).toEqual(expect.objectContaining({ notified: expect.any(Number), idle: expect.any(Number) }));
  });

  it("tells the owners about a new inquiry nobody is set to handle, once and without what it says", async () => {
    const org = await messagingOrg({ name: "No Agent Co" });
    await withSystem((db) => db.query("update agent_instances set enabled = false where org_id = $1 and role_key = 'sales_assistant'", [org.org.id]));
    const c = await inbound(org.org.id, { body: "Private budget details here" });
    await inbound(org.org.id, { address: c.address, body: "Another message" });
    const n = await withSystem((db) => db.query<{ title: string; body: string; link: string }>("select title, body, link from notifications where user_id = $1 and kind = 'conversation_new_inquiry'", [org.people.owner.id]));
    expect(n.rows).toHaveLength(1);
    expect(JSON.stringify(n.rows[0])).not.toContain("budget");
    expect(n.rows[0].link).toBe(`/inbox?conversation=${c.conversationId}`);
    expect(await count("select count(*)::text as n from notifications where user_id = $1 and kind = 'conversation_new_inquiry'", [org.people.sales.id])).toBe(0);
  });
});
