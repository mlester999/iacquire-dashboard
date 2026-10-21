import { beforeAll, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/server/env";
import { withSystem } from "@/server/db";
import { memberActor } from "@/server/crm/actor";
import { createTag } from "@/server/crm/tags";
import { MAX_EVENT_DEPTH } from "@/server/crm/events";
import { crmEventDispatch } from "@/server/crm/dispatch";
import { processWorkflowRuns } from "@/server/crm/workflows/runner";
import { createWorkflow, publishWorkflow, setWorkflowStatus } from "@/server/crm/workflows/definitions";
import { permissionsNeeded } from "@/server/crm/workflows/permissions";
import { studioEntitlement } from "@/server/automation-studio/entitlement";
import { assignConversation, createEscalation, takeOverConversation } from "@/server/messaging/handoff";
import { queueOutbound } from "@/server/messaging/send";
import { applyConversationAction } from "@/server/messaging/workflow-actions";
import { CONVERSATION_ACTIONS, STEP_KINDS, deriveEffects, derivePremiumFeatures, validateDefinition, type WorkflowDefinition, type WorkflowStep } from "@/lib/crm/workflow/spec";
import { stepSummary } from "@/components/crm/workflows/summaries";
import { describeConversationEvent } from "@/lib/inbox";
import { inbound, messagingOrg, type MessagingOrg } from "./support/messaging";

// The "Update conversation" workflow step: the rules the editor and publisher apply, and what it does when a run reaches it.

let m: MessagingOrg;
beforeAll(async () => {
  resetEnvCache();
  m = await messagingOrg({ name: "Workflow Step Co" });
});

const step = (key: string, kind: WorkflowStep["kind"], config: Record<string, unknown>, next: string | null = null): WorkflowStep => ({ key, kind, config, next }) as WorkflowStep;
const act = (config: Record<string, unknown>) => step("act", "conversation_action", config);
const count = async (sql: string, params: unknown[]) => Number((await withSystem((db) => db.query<{ n: string }>(sql, params))).rows[0].n);

async function settle() {
  for (let i = 0; i < 40; i += 1) {
    const d = await crmEventDispatch();
    const r = await processWorkflowRuns();
    if (!d.claimed && !r.claimed && !r.scheduled) return;
  }
}

/** A workflow, published and switched on by the workspace owner. */
async function liveWorkflow(org: MessagingOrg, trigger: WorkflowDefinition["trigger"], steps: WorkflowStep[]) {
  const actor = memberActor(org.ctx("owner"));
  const { id } = await createWorkflow(actor, { name: `Step workflow ${Math.random().toString(36).slice(2, 8)}`, definition: { trigger, steps } });
  const published = await publishWorkflow(actor, id);
  expect(published.needsApproval).toBe(false);
  await setWorkflowStatus(actor, id, "active");
  return id;
}

const convRow = async (id: string) =>
  (await withSystem((db) => db.query<{ status: string; priority: string; outcome: string | null; assigned_user_id: string | null; owner_kind: string; ai_paused_at: Date | null }>(
    "select status, priority, outcome, assigned_user_id, owner_kind, ai_paused_at from conversations where id = $1", [id],
  ))).rows[0];
const convEvents = async (id: string) =>
  (await withSystem((db) => db.query<{ kind: string; actor_kind: string; detail: Record<string, unknown> }>("select kind, actor_kind, detail from conversation_events where conversation_id = $1 order by id", [id]))).rows;
const stepResults = async (workflowId: string) =>
  (await withSystem((db) => db.query<{ status: string; result: Record<string, unknown> }>(
    "select s.status, s.result from crm_workflow_run_steps s join crm_workflow_runs r on r.id = s.run_id and r.org_id = s.org_id where r.workflow_id = $1 and s.kind = 'conversation_action' order by s.id", [workflowId],
  ))).rows;

describe("the Update conversation step: its rules", () => {
  const definition = (type: string, config: Record<string, unknown>) => ({ trigger: { type }, steps: [act(config)] });
  const errors = (d: unknown) => validateDefinition(d, null).filter((i) => i.level === "error").map((i) => i.code);
  const warnings = (d: unknown) => validateDefinition(d, null).filter((i) => i.level === "warning").map((i) => i.code);

  it("is an ordinary CRM step: nothing outside, no plan, and no approval before it runs", () => {
    const spec = STEP_KINDS.conversation_action;
    expect(spec).toMatchObject({ external: false, emitsEvents: true, approvable: true });
    expect(spec.premium).toBeUndefined();
    const def = definition("conversation.message_received", { action: "resolve" }) as unknown as WorkflowDefinition;
    expect(deriveEffects(def)).toEqual([]);
    expect(derivePremiumFeatures(def, "crm")).toEqual([]);
    expect(errors(def)).toEqual([]);
  });

  it("only works from a trigger that has a conversation, and needs the choices its action asks for", () => {
    expect(errors(definition("contact.created", { action: "resolve" }))).toContain("needs_conversation");
    expect(errors(definition("conversation.message_received", { action: "resolve" }))).not.toContain("needs_conversation");
    expect(errors(definition("conversation.message_received", { action: "set_priority" }))).toContain("invalid_config");
    expect(errors(definition("conversation.message_received", { action: "set_priority", priority: "high" }))).toEqual([]);
    expect(errors(definition("conversation.message_received", { action: "assign_person" }))).toContain("invalid_config");
    expect(errors(definition("conversation.message_received", { action: "assign_person", userId: m.people.sales.id }))).toEqual([]);
    expect(errors(definition("conversation.message_received", { action: "pause_ai" }))).toEqual([]);
    // Unknown actions and stray fields are refused, not ignored.
    expect(errors(definition("conversation.message_received", { action: "send_message" }))).not.toEqual([]);
    expect(errors(definition("conversation.message_received", { action: "resolve", body: "hi" }))).not.toEqual([]);
  });

  it("warns where it would do nothing, or start itself again", () => {
    expect(warnings(definition("conversation.resolved", { action: "resolve" }))).toContain("no_effect");
    expect(warnings(definition("conversation.assigned", { action: "assign_contact_owner" }))).toContain("self_trigger");
    expect(warnings(definition("conversation.message_received", { action: "assign_contact_owner" }))).not.toContain("self_trigger");
  });

  it("needs the inbox permission of the person who publishes it, so a workflow can't do more than they can", () => {
    const need = (config: Record<string, unknown>) => permissionsNeeded(definition("conversation.message_received", config) as unknown as WorkflowDefinition).map((n) => n.permission);
    expect(need({ action: "assign_person", userId: m.people.sales.id })).toContain("inbox.assign");
    expect(need({ action: "assign_contact_owner" })).toContain("inbox.assign");
    for (const action of ["resolve", "reopen", "set_priority", "pause_ai"]) expect(need({ action, priority: "high" })).toContain("inbox.reply");
    expect(need({ action: "resolve" })).not.toContain("inbox.assign");
  });

  it("describes itself in words", () => {
    const names = { user: (id: string) => (id === m.people.sales.id ? "Sam Sales" : undefined) } as unknown as Parameters<typeof stepSummary>[1];
    expect(stepSummary(act({ action: "resolve", outcome: "booked" }), names)).toBe("Resolve the conversation (Appointment booked)");
    expect(stepSummary(act({ action: "assign_person", userId: m.people.sales.id }), names)).toBe("Assign the conversation to Sam Sales");
    expect(stepSummary(act({ action: "set_priority" }), names)).toBe("Choose the priority");
    expect(stepSummary(act({ action: "pause_ai" }), names)).toBe("Pause the AI employee on the conversation");
  });

  it("offers no action that messages a customer or turns AI replies on", () => {
    expect(CONVERSATION_ACTIONS.every((a) => !/send|message|resume|enable/.test(a))).toBe(true);
  });
});

describe("the Update conversation step: running", () => {
  it("resolves the conversation that started the run, with its outcome, as an automation, with no Automation Studio plan", async () => {
    const org = await messagingOrg({ name: "Auto Resolve Co" });
    expect((await withSystem((db) => studioEntitlement(db, org.org.id))).entitled).toBe(false);
    const wf = await liveWorkflow(org, { type: "conversation.message_received" }, [act({ action: "resolve", outcome: "answered" })]);
    const c = await inbound(org.org.id);
    await settle();
    expect(await convRow(c.conversationId)).toMatchObject({ status: "closed", outcome: "answered" });
    const ev = (await convEvents(c.conversationId)).find((e) => e.kind === "status_changed");
    expect(ev).toMatchObject({ actor_kind: "workflow", detail: { to: "closed", outcome: "answered", via: "workflow" } });
    expect(describeConversationEvent("status_changed", ev!.detail, { actor: "An automation" })).toBe("An automation resolved this (Question answered)");
    expect((await stepResults(wf))[0]).toMatchObject({ status: "completed", result: { action: "resolve" } });
  });

  it("assigns to a named person, tells them, and starts the workflows that listen for assignments", async () => {
    const org = await messagingOrg({ name: "Auto Assign Co" });
    const tag = await createTag(memberActor(org.ctx("owner")), { name: "Routed", color: "#2563eb" });
    const toSales = await liveWorkflow(org, { type: "conversation.message_received" }, [act({ action: "assign_person", userId: org.people.sales.id })]);
    const listener = await liveWorkflow(org, { type: "conversation.assigned", filters: { assigneeIds: [org.people.sales.id] } }, [step("tag", "add_tag", { tagIds: [tag.id] })]);
    const c = await inbound(org.org.id);
    await settle();
    expect((await convRow(c.conversationId)).assigned_user_id).toBe(org.people.sales.id);
    expect(await count("select count(*)::text as n from notifications where user_id = $1 and kind = 'conversation_assigned' and title like '%automation%'", [org.people.sales.id])).toBe(1);
    expect((await convEvents(c.conversationId)).find((e) => e.kind === "assigned")).toMatchObject({ actor_kind: "workflow", detail: { to: org.people.sales.id, via: "workflow" } });
    expect(await count("select count(*)::text as n from crm_workflow_runs where workflow_id = $1", [listener])).toBe(1);
    expect(await count("select count(*)::text as n from crm_contact_tags where tag_id = $1 and contact_id = $2", [tag.id, c.contactId])).toBe(1);
    expect((await stepResults(toSales))[0].result).toMatchObject({ assignedTo: org.people.sales.id });
    // Assigning is not taking over: the AI employee is still the one replying.
    expect((await convRow(c.conversationId)).owner_kind).toBe("ai");
  });

  it("uses the contact's owner, and skips with the reason when there is none or they can't take conversations", async () => {
    const org = await messagingOrg({ name: "Owner Route Co" });
    const wf = await liveWorkflow(org, { type: "conversation.message_received" }, [act({ action: "assign_contact_owner" })]);
    // The contact's owner is set after the first message, so the second message is the one that finds them.
    const owned = await inbound(org.org.id);
    const noOwner = await inbound(org.org.id);
    const viewerOwned = await inbound(org.org.id);
    await settle();
    await withSystem((db) => db.query("update contacts set assigned_user_id = $2 where id = $1", [owned.contactId, org.people.support.id]));
    await withSystem((db) => db.query("update contacts set assigned_user_id = $2 where id = $1", [viewerOwned.contactId, org.people.viewer.id]));
    await inbound(org.org.id, { address: owned.address });
    await inbound(org.org.id, { address: viewerOwned.address });
    await settle();
    expect((await convRow(owned.conversationId)).assigned_user_id).toBe(org.people.support.id);
    expect((await convRow(noOwner.conversationId)).assigned_user_id).toBeNull();
    expect((await convRow(viewerOwned.conversationId)).assigned_user_id).toBeNull();
    const reasons = (await stepResults(wf)).map((s) => s.result.reason).filter(Boolean);
    expect(reasons).toEqual(expect.arrayContaining(["no_owner", "owner_unavailable"]));
  });

  it("pauses the AI without making anyone the owner, and leaves a person's conversation alone", async () => {
    const org = await messagingOrg({ name: "Auto Pause Co" });
    await liveWorkflow(org, { type: "conversation.message_received" }, [act({ action: "pause_ai" })]);
    const c = await inbound(org.org.id);
    await settle();
    const row = await convRow(c.conversationId);
    expect(row.owner_kind).toBe("ai");
    expect(row.ai_paused_at).not.toBeNull();
    expect((await convEvents(c.conversationId)).find((e) => e.kind === "ai_paused")).toMatchObject({ actor_kind: "workflow" });
    // The AI cannot send now, exactly as after a person pressed Pause AI.
    const blocked = await withSystem((db) => queueOutbound(db, { orgId: org.org.id, conversationId: c.conversationId, scope: "reply", actor: { kind: "ai", agentId: org.salesAgentId }, body: "Hello again" }));
    expect(blocked).toMatchObject({ status: "blocked", reason: "ai_paused" });
    // A person's conversation is not the AI's to pause.
    const mine = await inbound(org.org.id);
    await takeOverConversation(org.ctx("manager"), mine.conversationId);
    const before = await convRow(mine.conversationId);
    const r = await withSystem((db) => applyConversationAction(db, { orgId: org.org.id, conversationId: mine.conversationId, config: { action: "pause_ai" }, since: new Date(0), causedBy: null, dryRun: false }));
    expect(r).toMatchObject({ result: "unchanged" });
    expect(await convRow(mine.conversationId)).toEqual(before);
  });

  it("doesn't resolve over a customer who wrote since the run started, or a person who was asked to take over", async () => {
    const org = await messagingOrg({ name: "Guarded Resolve Co" });
    const c = await inbound(org.org.id);
    const resolve = (since: Date) => withSystem((db) => applyConversationAction(db, { orgId: org.org.id, conversationId: c.conversationId, config: { action: "resolve" }, since, causedBy: null, dryRun: false }));
    expect(await resolve(new Date(Date.now() - 60_000))).toMatchObject({ result: "blocked", reason: "customer_replied" });
    expect((await convRow(c.conversationId)).status).toBe("open");
    await withSystem((db) => createEscalation(db, { orgId: org.org.id, conversationId: c.conversationId, category: "complaint", summary: "Customer needs help from a person.", agentId: org.salesAgentId }));
    expect(await resolve(new Date(Date.now() + 60_000))).toMatchObject({ result: "blocked", reason: "person_requested" });
    expect((await convRow(c.conversationId)).status).toBe("open");
  });

  it("changes nothing in a test run, and says what it would do", async () => {
    const org = await messagingOrg({ name: "Dry Run Co" });
    const c = await inbound(org.org.id);
    const before = await convRow(c.conversationId);
    const eventsBefore = (await convEvents(c.conversationId)).length;
    const configs = [{ action: "resolve" }, { action: "set_priority", priority: "urgent" }, { action: "assign_person", userId: org.people.sales.id }, { action: "pause_ai" }] as const;
    for (const config of configs) {
      const r = await withSystem((db) => applyConversationAction(db, { orgId: org.org.id, conversationId: c.conversationId, config, since: new Date(Date.now() + 60_000), causedBy: null, dryRun: true }));
      expect(r.result).toBe("changed");
      expect((r as { would: string }).would).toMatch(/^Would /);
    }
    expect(await convRow(c.conversationId)).toEqual(before);
    expect((await convEvents(c.conversationId)).length).toBe(eventsBefore);
    expect(await count("select count(*)::text as n from notifications where user_id = $1 and kind = 'conversation_assigned'", [org.people.sales.id])).toBe(0);
  });

  it("fails the run, visibly, when the person it names has left the team", async () => {
    const org = await messagingOrg({ name: "Gone Assignee Co" });
    const wf = await liveWorkflow(org, { type: "conversation.message_received" }, [act({ action: "assign_person", userId: org.people.sales.id })]);
    await withSystem((db) => db.query("update organization_memberships set status = 'revoked' where org_id = $1 and user_id = $2", [org.org.id, org.people.sales.id]));
    const c = await inbound(org.org.id);
    await settle();
    expect((await convRow(c.conversationId)).assigned_user_id).toBeNull();
    expect(await count("select count(*)::text as n from crm_workflow_runs where workflow_id = $1 and status in ('failed', 'dead')", [wf])).toBe(1);
  });

  it("stops two workflows that keep handing a conversation back and forth at the loop limit", async () => {
    const org = await messagingOrg({ name: "Ping Pong Co" });
    const { sales, support } = org.people;
    await liveWorkflow(org, { type: "conversation.assigned", filters: { assigneeIds: [sales.id] } }, [act({ action: "assign_person", userId: support.id })]);
    await liveWorkflow(org, { type: "conversation.assigned", filters: { assigneeIds: [support.id] } }, [act({ action: "assign_person", userId: sales.id })]);
    const c = await inbound(org.org.id);
    await assignConversation(org.ctx("manager"), c.conversationId, sales.id);
    await settle();
    const assigned = (await convEvents(c.conversationId)).filter((e) => e.kind === "assigned").length;
    // It went back and forth a few times and then stopped; it did not run away.
    expect(assigned).toBeGreaterThan(2);
    expect(assigned).toBeLessThanOrEqual(MAX_EVENT_DEPTH + 2);
  });
});
