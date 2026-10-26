// The website chat and lead attribution inside Automation Studio: the triggers they announce, that a workflow built in the CRM screens runs from them
// without any plan, that each starts a workflow once, and that the existing safe steps (create a task, notify staff, ask an AI employee) work from them.
import { beforeAll, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/server/env";
import { withSystem } from "@/server/db";
import { memberActor } from "@/server/crm/actor";
import { crmEventDispatch } from "@/server/crm/dispatch";
import { processWorkflowRuns } from "@/server/crm/workflows/runner";
import { createWorkflow, publishWorkflow, setWorkflowStatus } from "@/server/crm/workflows/definitions";
import { TRIGGERS, derivePremiumFeatures, validateDefinition, type WorkflowDefinition, type WorkflowStep } from "@/lib/crm/workflow/spec";
import { answer, chatOrg, clientId, embedCall, hashOf, start, type ChatOrg } from "./support/webchat";

let c: ChatOrg;
beforeAll(async () => {
  resetEnvCache();
  c = await chatOrg();
});

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;
const step = (key: string, kind: WorkflowStep["kind"], config: Record<string, unknown>, next: string | null = null): WorkflowStep => ({ key, kind, config, next }) as WorkflowStep;

async function settle() {
  for (let i = 0; i < 40; i += 1) {
    const d = await crmEventDispatch();
    const r = await processWorkflowRuns();
    if (!d.claimed && !r.claimed && !r.scheduled) return;
  }
}

async function live(trigger: WorkflowDefinition["trigger"], steps: WorkflowStep[]) {
  const actor = memberActor(c.m.ctx("owner"));
  const { id } = await createWorkflow(actor, { name: `Chat workflow ${Math.random().toString(36).slice(2, 8)}`, definition: { trigger, steps } });
  const published = await publishWorkflow(actor, id);
  expect(published.needsApproval).toBe(false);
  await setWorkflowStatus(actor, id, "active");
  return id;
}
const runs = (id: string) => rows<{ status: string }>("select status from crm_workflow_runs where workflow_id = $1 order by created_at", [id]);
const steps = (id: string) =>
  rows<{ kind: string; status: string }>("select s.kind, s.status from crm_workflow_run_steps s join crm_workflow_runs r on r.id = s.run_id and r.org_id = s.org_id where r.workflow_id = $1 order by s.id", [id]);

describe("the triggers", () => {
  it("lists the website chat and source triggers, each with the contact it carries", () => {
    for (const type of ["webchat.started", "webchat.lead_captured", "webchat.qualification_completed", "webchat.booking_requested", "lead.source_recorded"] as const) {
      expect(TRIGGERS[type], type).toBeDefined();
      expect(TRIGGERS[type].label.length).toBeGreaterThan(5);
      expect(TRIGGERS[type].carries.contact).toBe("always");
    }
    expect(TRIGGERS["conversation.handoff_requested"]).toBeDefined(); // a chat handoff uses the existing trigger
  });

  it("builds in the CRM screens with no plan, for every one of them", () => {
    for (const type of ["webchat.started", "webchat.lead_captured", "webchat.qualification_completed", "webchat.booking_requested", "lead.source_recorded"] as const) {
      const def: WorkflowDefinition = { trigger: { type }, steps: [step("a", "notify_team", { roles: ["owner"], title: "New", body: "Open it." })] } as WorkflowDefinition;
      expect(validateDefinition(def, null).filter((i) => i.level === "error"), type).toEqual([]);
      expect(derivePremiumFeatures(def), type).toEqual([]);
    }
  });
});

describe("workflows started by the chat", () => {
  it("starts a workflow when a visitor shares their details, once, with the contact attached, and lets it create a task and ask the AI employee", async () => {
    const wf = await live({ type: "webchat.lead_captured" }, [
      step("t", "create_task", { title: "Follow up with this website lead", priority: "high", dueIn: { amount: 1, unit: "hours" }, assignee: "none" }, "n"),
      step("n", "notify_team", { roles: ["owner"], title: "Website lead", body: "A visitor shared their details." }),
    ]);
    const token = await start(c);
    await embedCall(c, { action: "send", token, body: { text: "Hello", clientMessageId: clientId() }, generate: answer("Hi!").generate });
    await embedCall(c, { action: "lead", token, body: { details: { name: "Auto Lead", email: "auto.lead@example.com" }, privacyAck: true } });
    // The same visitor submits the form again: no second run.
    await embedCall(c, { action: "lead", token, body: { details: { name: "Auto Lead", email: "auto.lead@example.com" }, privacyAck: true } });
    await settle();
    expect((await runs(wf)).map((r) => r.status)).toEqual(["completed"]);
    expect((await steps(wf)).map((s) => [s.kind, s.status])).toEqual([["create_task", "completed"], ["notify_team", "completed"]]);
    const contact = (await rows<{ contact_id: string }>("select contact_id from web_chat_sessions where token_hash = $1", [hashOf(token)]))[0].contact_id;
    expect(await rows("select 1 from tasks where org_id = $1 and contact_id = $2 and title = 'Follow up with this website lead'", [c.m.org.id, contact])).toHaveLength(1);
  });

  it("starts a workflow when a chat begins, and when a visitor asks for a person", async () => {
    const started = await live({ type: "webchat.started" }, [step("n", "notify_team", { roles: ["owner"], title: "Chat started", body: "A visitor opened a chat." })]);
    const handoff = await live({ type: "conversation.handoff_requested" }, [step("n", "notify_team", { roles: ["owner"], title: "Person needed", body: "A visitor asked for a person." })]);
    const token = await start(c);
    await embedCall(c, { action: "send", token, body: { text: "Can I speak to a human please", clientMessageId: clientId() }, generate: answer("never").generate });
    await settle();
    expect((await runs(started)).map((r) => r.status)).toContain("completed");
    expect((await runs(handoff)).map((r) => r.status)).toContain("completed");
  });

  it("starts a workflow when a lead's source is recorded, saying how sure it is", async () => {
    const wf = await live({ type: "lead.source_recorded" }, [step("n", "notify_team", { roles: ["owner"], title: "Source recorded", body: "Check the contact's source." })]);
    const token = await start(c, { landing: "/x?utm_source=newsletter&utm_medium=email" });
    await embedCall(c, { action: "send", token, body: { text: "Hello", clientMessageId: clientId() }, generate: answer("Hi!").generate });
    await settle();
    expect((await runs(wf)).length).toBeGreaterThanOrEqual(1);
    const ev = (await rows<{ payload: Record<string, unknown> }>("select payload from crm_events where org_id = $1 and type = 'lead.source_recorded' order by id desc limit 1", [c.m.org.id]))[0];
    expect(ev.payload).toMatchObject({ kind: "website_chat", source: "newsletter", medium: "email", confidence: "known" });
  });

  it("announces a booking request from the chat once", async () => {
    const wf = await live({ type: "webchat.booking_requested" }, [step("n", "notify_team", { roles: ["owner"], title: "Booking asked", body: "A visitor asked to book." })]);
    await withSystem(async (db) => {
      await db.query("insert into ghl_location_mappings (org_id, location_id, calendar_ids, status) values ($1, 'LOCchat0001', $2, 'connected') on conflict do nothing", [c.m.org.id, ["cal_chat_0001"]]);
      await db.query("insert into appointment_settings (org_id) values ($1) on conflict (org_id) do nothing", [c.m.org.id]);
    });
    const slot = new Date(Date.now() + 3 * 86_400_000);
    slot.setUTCMinutes(0, 0, 0);
    const provider = {
      name: "fake" as const,
      async freeSlots() { return { ok: true as const, slots: [{ start: slot.toISOString(), end: slot.toISOString() }] }; },
      async create() { return { ok: true as const, appointmentId: "x", status: "confirmed" as const }; },
      async update() { return { ok: true as const }; },
    };
    const token = await start(c);
    await embedCall(c, {
      action: "send", token, body: { text: "I'd like to book an inspection", clientMessageId: clientId() }, provider: provider as never,
      generate: async () => ({ kind: "book" as const, startIso: slot.toISOString(), summary: "Inspection" }),
    });
    await settle();
    expect(await rows("select 1 from crm_events where org_id = $1 and type = 'webchat.booking_requested'", [c.m.org.id])).toHaveLength(1);
    expect((await runs(wf)).map((r) => r.status)).toEqual(["completed"]);
  });
});
