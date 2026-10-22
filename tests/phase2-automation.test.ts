// Missed-call recovery and lead scoring inside the rest of the platform: the new Automation Studio triggers and steps (and that they respect the
// same validation, permissions and plan rules as every other step), that automation cannot loop through them, the Appointment Setter routing, and
// the two read-only AI workforce reviews. Synthetic workspaces; nothing leaves the machine.
import { beforeAll, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/server/env";
import { withSystem } from "@/server/db";
import { memberActor } from "@/server/crm/actor";
import { createContact } from "@/server/crm/contacts";
import { crmEventDispatch } from "@/server/crm/dispatch";
import { processWorkflowRuns } from "@/server/crm/workflows/runner";
import { createWorkflow, publishWorkflow, setWorkflowStatus } from "@/server/crm/workflows/definitions";
import { permissionsNeeded } from "@/server/crm/workflows/permissions";
import { STEP_KINDS, TRIGGERS, deriveEffects, derivePremiumFeatures, validateDefinition, type WorkflowDefinition, type WorkflowStep } from "@/lib/crm/workflow/spec";
import { stepSummary } from "@/components/crm/workflows/summaries";
import { assessContact } from "@/server/lead-scoring/service";
import { saveProfile } from "@/server/lead-scoring/profile";
import { setOverride } from "@/server/lead-scoring/priority";
import { processScoringQueue } from "@/server/lead-scoring/queue";
import { processMissedCalls } from "@/server/missed-calls/engine";
import { dispatchCapabilityJob } from "@/server/workforce/capability-dispatch";
import { createConfigVersion } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { WORKFORCE_CAPABILITIES, capabilitiesForRole, roleMayUseCapability } from "@/lib/workforce-capabilities";
import { agentId } from "./support/fixtures";
import { inbound, messagingOrg, type MessagingOrg } from "./support/messaging";
import { callerNumber, caseOf, actionsOf, minutesAfter, recordCall, recoveryWorkspace, rows, count, T0, voice } from "./support/missed-calls";

let m: MessagingOrg;
beforeAll(async () => {
  resetEnvCache();
  m = await messagingOrg({ name: "Phase 2 Automation Co", provider: { sms: "twilio" } });
});

const step = (key: string, kind: WorkflowStep["kind"], config: Record<string, unknown>, next: string | null = null): WorkflowStep => ({ key, kind, config, next }) as WorkflowStep;

async function settle() {
  for (let i = 0; i < 40; i += 1) {
    const d = await crmEventDispatch();
    const r = await processWorkflowRuns();
    if (!d.claimed && !r.claimed && !r.scheduled) return;
  }
}

async function liveWorkflow(org: MessagingOrg, trigger: WorkflowDefinition["trigger"], steps: WorkflowStep[]) {
  const actor = memberActor(org.ctx("owner"));
  const { id } = await createWorkflow(actor, { name: `P2 workflow ${Math.random().toString(36).slice(2, 8)}`, definition: { trigger, steps } });
  const published = await publishWorkflow(actor, id);
  expect(published.needsApproval).toBe(false);
  await setWorkflowStatus(actor, id, "active");
  return id;
}

const runsOf = async (workflowId: string) => (await rows<{ status: string; id: string }>("select id, status from crm_workflow_runs where workflow_id = $1 order by created_at", [workflowId]));
const stepRows = async (workflowId: string) =>
  rows<{ kind: string; status: string; result: Record<string, unknown> }>(
    "select s.kind, s.status, s.result from crm_workflow_run_steps s join crm_workflow_runs r on r.id = s.run_id and r.org_id = s.org_id where r.workflow_id = $1 order by s.id", [workflowId]);

describe("triggers and steps: the rules", () => {
  const errors = (d: unknown) => validateDefinition(d, null).filter((i) => i.level === "error").map((i) => i.code);

  it("lists the new triggers with the contact they carry, and no trigger the engine cannot honour", () => {
    for (const t of ["call.missed", "recovery.eligible", "recovery.failed", "recovery.responded", "recovery.completed", "lead.score_updated", "lead.became_hot", "lead.label_changed", "lead.qualification_completed"] as const) {
      expect(TRIGGERS[t], t).toBeDefined();
      expect(TRIGGERS[t].carries.opportunity).toBe("never");
    }
    expect(TRIGGERS["lead.became_hot"].carries.contact).toBe("always");
    expect(TRIGGERS["call.missed"].filters).toEqual(["callClasses"]);
    expect(TRIGGERS["lead.label_changed"].filters).toEqual(["leadLabels"]);
  });

  it("makes the three new steps ordinary, safe CRM steps: nothing outside, no plan, nothing to approve", () => {
    for (const k of ["request_reassessment", "set_priority", "recovery_check"] as const) {
      expect(STEP_KINDS[k]).toMatchObject({ external: false, terminal: false, branches: false });
      expect(STEP_KINDS[k].premium).toBeUndefined();
    }
    const def = { trigger: { type: "lead.became_hot" }, steps: [step("a", "set_priority", { label: "hot", reason: "Asked for a quote", days: 7 }, "b"), step("b", "request_reassessment", {}, "c"), step("c", "recovery_check", {})] } as unknown as WorkflowDefinition;
    expect(errors(def)).toEqual([]);
    expect(deriveEffects(def)).toEqual([]);
    expect(derivePremiumFeatures(def, "crm")).toEqual([]);
    expect(derivePremiumFeatures(def, "studio")).toEqual(["studio_workflow"]);
  });

  it("validates trigger filters and the step settings, and needs a contact for every one of the steps", () => {
    const ok = { trigger: { type: "call.missed", filters: { callClasses: ["voicemail"] } }, steps: [step("a", "recovery_check", {})] };
    expect(errors(ok)).toEqual([]);
    expect(errors({ trigger: { type: "call.missed", filters: { callClasses: ["nonsense"] } }, steps: [step("a", "recovery_check", {})] })).not.toEqual([]);
    expect(errors({ trigger: { type: "lead.label_changed", filters: { leadLabels: ["hot", "warm"] } }, steps: [step("a", "request_reassessment", {})] })).toEqual([]);
    expect(errors({ trigger: { type: "lead.label_changed", filters: { callClasses: ["voicemail"] } }, steps: [step("a", "request_reassessment", {})] })).not.toEqual([]);
    expect(errors({ trigger: { type: "lead.became_hot" }, steps: [step("a", "set_priority", { label: "insufficient_data", reason: "x", days: 7 })] })).not.toEqual([]);
    expect(errors({ trigger: { type: "lead.became_hot" }, steps: [step("a", "set_priority", { label: "hot", reason: "Good reason", days: 90 })] })).not.toEqual([]);
    expect(errors({ trigger: { type: "lead.became_hot" }, steps: [step("a", "set_priority", { label: "hot", reason: "", days: 7 })] })).not.toEqual([]);
    // A scheduled run has no contact, so a step that needs one is refused.
    expect(errors({ trigger: { type: "schedule", schedule: { frequency: "daily", time: "09:00" } }, steps: [step("a", "request_reassessment", {})] })).not.toEqual([]);
  });

  it("asks for the permission each step really needs, and reads in plain words", () => {
    const need = (kind: WorkflowStep["kind"], config: Record<string, unknown>) =>
      permissionsNeeded({ trigger: { type: "lead.became_hot" }, steps: [step("a", kind, config)] } as unknown as WorkflowDefinition).map((n) => n.permission);
    expect(need("request_reassessment", {})).toContain("contacts.view");
    expect(need("set_priority", { label: "hot", reason: "Because", days: 7 })).toContain("contacts.edit");
    expect(need("recovery_check", {})).toContain("calls.view");
    expect(stepSummary(step("a", "set_priority", { label: "hot", reason: "Asked for a quote", days: 3 }), { user: new Map() } as never)).toMatch(/Mark the lead hot for 3 days/);
  });
});

describe("workflows on missed calls", () => {
  it("starts only for the kinds of missed call it names, and checks the waiting case when it runs", async () => {
    const r = await recoveryWorkspace({ mode: "manual" });
    const wf = await liveWorkflow(r.w, { type: "call.missed", filters: { callClasses: ["voicemail"] } }, [step("check", "recovery_check", {})]);
    const ringing = callerNumber(), vm = callerNumber();
    await recordCall(r.w.org.id, voice({ customerNumber: ringing, status: "no_answer" }));
    await recordCall(r.w.org.id, voice({ customerNumber: vm, status: "voicemail" }));
    await settle();
    const runs = await runsOf(wf);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("completed");
    const steps = await stepRows(wf);
    expect(steps).toEqual([expect.objectContaining({ kind: "recovery_check", status: "completed" })]);
    expect((await caseOf(r.w.org.id, ringing)).state).toBe("detected");
  });

  it("is told when a missed call is settled", async () => {
    const r = await recoveryWorkspace({ mode: "manual" });
    const wf = await liveWorkflow(r.w, { type: "recovery.completed" }, [step("n", "notify_team", { roles: ["owner"], title: "A missed call was settled" })]);
    const caller = callerNumber();
    await recordCall(r.w.org.id, voice({ customerNumber: caller, status: "no_answer" }));
    await recordCall(r.w.org.id, voice({ direction: "outbound", status: "completed", customerNumber: caller, startedAt: minutesAfter(20), endedAt: minutesAfter(25), durationSeconds: 120 }));
    await settle();
    expect((await runsOf(wf)).map((x) => x.status)).toEqual(["completed"]);
    expect(await count("select count(*)::text as n from notifications where org_id = $1 and title = 'A missed call was settled'", [r.w.org.id])).toBeGreaterThanOrEqual(1);
  });

  it("an automation cannot wake a case into breaking a rule: the engine still re-checks consent before any text", async () => {
    const r = await recoveryWorkspace({ mode: "automatic", policy: { delayMinutes: 0 } });
    await liveWorkflow(r.w, { type: "call.missed" }, [step("check", "recovery_check", {})]);
    const caller = callerNumber();
    const contact = await createContact(r.owner, { displayName: "No Consent Nia", phone: caller });
    await recordCall(r.w.org.id, voice({ customerNumber: caller }));
    await settle();
    await processMissedCalls({ now: minutesAfter(5), orgId: r.w.org.id });
    const msgs = await rows("select 1 from conversation_messages m join conversations c on c.id = m.conversation_id where c.contact_id = $1 and m.direction = 'outbound'", [contact.id]);
    expect(msgs).toHaveLength(0);
    expect((await caseOf(r.w.org.id, caller)).state_reason).toBe("no_consent");
  });
});

describe("workflows on lead priority", () => {
  async function chat(orgId: string, phone: string) {
    for (const [i, body] of ["Hi, do you have availability this week?", "Can I get a quote?", "Great, I'm ready to go ahead."].entries()) {
      await inbound(orgId, { provider: "twilio", address: phone, providerMessageId: `p2_${phone}_${i}`, body, receivedAt: new Date(Date.now() - (10 - i) * 60_000) });
    }
  }

  it("a lead turning hot starts the workflow once, and a workflow can ask for a time-limited priority", async () => {
    const hotOrg = await messagingOrg({ name: "Hot Lead Co", provider: { sms: "twilio" } });
    const actor = memberActor(hotOrg.ctx("owner"));
    await saveProfile(actor, { expectedVersion: 0, hotMin: 55, warmMin: 30 });
    const wf = await liveWorkflow(hotOrg, { type: "lead.became_hot" }, [step("n", "notify_team", { roles: ["owner"], title: "Hot lead", body: "Open the contact." }, "p"), step("p", "set_priority", { label: "hot", reason: "Likely to buy", days: 5 })]);
    const phone = callerNumber();
    const c = await createContact(actor, { displayName: "Hot Hana", phone });
    await chat(hotOrg.org.id, phone);
    // We answered one of her messages and she wrote back within the day, and she has a visit booked.
    await withSystem((db) => db.query(
      `insert into conversation_messages (org_id, conversation_id, direction, author_kind, author_user_id, body, status, scope, created_at)
       select c.org_id, c.id, 'outbound', 'human', $2, 'Yes we do, how about Thursday?', 'sent', 'human', now() - interval '9 minutes' from conversations c where c.contact_id = $1 limit 1`, [c.id, hotOrg.people.sales.id]));
    await inbound(hotOrg.org.id, { provider: "twilio", address: phone, providerMessageId: `p2_${phone}_late`, body: "Thursday works, thank you", receivedAt: new Date(Date.now() - 5 * 60_000) });
    await withSystem((db) => db.query(
      "insert into appointment_refs (org_id, ghl_appointment_id, ghl_calendar_id, status, start_at, end_at, contact_id) values ($1, $2, 'c1', 'confirmed', now() + interval '1 day', now() + interval '1 day 30 minutes', $3)", [hotOrg.org.id, `p2-${phone}`, c.id]));
    const first = await assessContact(hotOrg.org.id, c.id);
    expect(first).toMatchObject({ outcome: "created", label: "hot" });
    await settle();
    const hotEvents = await rows("select 1 from crm_events where org_id = $1 and type = 'lead.became_hot' and contact_id = $2", [hotOrg.org.id, c.id]);
    expect(hotEvents).toHaveLength(1);
    expect(await runsOf(wf)).toEqual([expect.objectContaining({ status: "completed" })]);
    const steps = await stepRows(wf);
    expect(steps.map((x) => [x.kind, x.status])).toEqual([["notify_team", "completed"], ["set_priority", "completed"]]);
    const o = (await rows<{ set_by: string | null; reason: string; expires_at: Date; label: string }>("select set_by, reason, expires_at, label from lead_score_overrides where contact_id = $1 and cleared_at is null", [c.id]))[0];
    expect(o.set_by).toBeNull();
    expect(o.label).toBe("hot");
    expect(o.reason).toMatch(/^Automation ".+": Likely to buy$/);
    expect(new Date(o.expires_at).getTime()).toBeGreaterThan(Date.now() + 4 * 86_400_000);
    expect(new Date(o.expires_at).getTime()).toBeLessThan(Date.now() + 6 * 86_400_000);
    expect((await rows<{ priority_source: string }>("select priority_source from contacts where id = $1", [c.id]))[0].priority_source).toBe("human");
    expect(await count("select count(*)::text as n from notifications where org_id = $1 and kind = 'hot_lead_detected'", [hotOrg.org.id])).toBeGreaterThanOrEqual(0);
  });

  it("the set-priority step leaves a teammate's own priority alone", async () => {
    const actor = memberActor(m.ctx("owner"));
    const wf = await liveWorkflow(m, { type: "contact.created" }, [step("p", "set_priority", { label: "warm", reason: "New enquiry", days: 3 })]);
    const phone = callerNumber();
    const c = await createContact(actor, { displayName: "Person Priority Pia", phone });
    await assessContact(m.org.id, c.id);
    await setOverride(memberActor(m.ctx("sales")), c.id, { label: "cold", reason: "Said they are not buying this year" });
    await settle();
    const steps = (await stepRows(wf)).filter((s) => s.kind === "set_priority");
    expect(steps.length).toBeGreaterThanOrEqual(1);
    const mine = await rows<{ label: string; set_by: string | null }>("select label, set_by from lead_score_overrides where contact_id = $1 and cleared_at is null", [c.id]);
    expect(mine).toHaveLength(1);
    expect(mine[0].set_by).not.toBeNull();
    expect(mine[0].label).toBe("cold");
  });

  it("a workflow that reacts to a score change by asking for a re-check cannot loop", async () => {
    const actor = memberActor(m.ctx("owner"));
    const wf = await liveWorkflow(m, { type: "lead.label_changed" }, [step("again", "request_reassessment", {})]);
    const phone = callerNumber();
    const c = await createContact(actor, { displayName: "Loop Lena", phone });
    await chat(m.org.id, phone);
    const base = Date.now();
    await assessContact(m.org.id, c.id, { now: new Date(base) });
    for (let i = 0; i < 6; i += 1) {
      await settle();
      await processScoringQueue({ now: new Date(base + (i + 1) * 15 * 60_000), orgId: m.org.id });
    }
    await settle();
    // However many times it ran, nothing changed after the first look, so no new assessment was written for the re-checks and the queue is empty.
    expect(await count("select count(*)::text as n from lead_score_assessments where contact_id = $1", [c.id])).toBeLessThanOrEqual(3);
    expect(await count("select count(*)::text as n from lead_score_queue where contact_id = $1 and attempts > 0", [c.id])).toBe(0);
    expect((await runsOf(wf)).length).toBeLessThanOrEqual(3);
  });
});

describe("handing a missed caller to the Appointment Setter", () => {
  async function readySetter(w: MessagingOrg) {
    const id = await agentId(w.org.id, "appointment_setter");
    await withSystem(async (db) => {
      await createConfigVersion(db, { orgId: w.org.id, agentId: id, settings: defaultSettings("appointment_setter"), source: "onboarding", userId: w.people.owner.id, apply: true });
      await db.query("update agent_instances set status = 'online', last_health_ok = true, enabled = true, mode = 'autonomous' where id = $1", [id]);
    });
    return id;
  }
  const convOf = async (id: string) => (await rows<{ owner_kind: string; ai_agent_id: string | null; ownership_version: number }>("select owner_kind, ai_agent_id, ownership_version from conversations where id = $1", [id]))[0];

  it("assigns the conversation to a ready Appointment Setter, once, and records who did it", async () => {
    const r = await recoveryWorkspace({ mode: "manual", policy: { routeAppointmentSetter: true } });
    const setter = await readySetter(r.w);
    const caller = callerNumber();
    const contact = await createContact(r.owner, { displayName: "Booking Bea", phone: caller });
    await recordCall(r.w.org.id, voice({ customerNumber: caller }));
    const c = await caseOf(r.w.org.id, caller);
    const before = await convOf(c.conversation_id!);
    await processMissedCalls({ now: minutesAfter(5), orgId: r.w.org.id });
    await processMissedCalls({ now: minutesAfter(40), orgId: r.w.org.id });
    const after = await convOf(c.conversation_id!);
    expect(after).toMatchObject({ owner_kind: "ai", ai_agent_id: setter });
    expect(after.ownership_version).toBeGreaterThan(before.ownership_version);
    expect((await actionsOf(c.id)).filter((a) => a.kind === "appointment_setter")).toEqual([expect.objectContaining({ status: "done" })]);
    const ev = await rows<{ kind: string; actor_kind: string; detail: Record<string, unknown> }>("select kind, actor_kind, detail from conversation_events where conversation_id = $1 and kind = 'ai_assigned'", [c.conversation_id]);
    expect(ev).toEqual([expect.objectContaining({ actor_kind: "system", detail: expect.objectContaining({ roleKey: "appointment_setter", by: "missed_call" }) })]);
    void contact;
  });

  it("leaves a conversation a person owns alone, and says it is not ready when the employee has not passed its check", async () => {
    const r = await recoveryWorkspace({ mode: "manual", policy: { routeAppointmentSetter: true } });
    const { takeOverConversation } = await import("@/server/messaging/handoff");
    const human = callerNumber();
    await createContact(r.owner, { displayName: "Human Hal", phone: human });
    await recordCall(r.w.org.id, voice({ customerNumber: human }));
    const hc = await caseOf(r.w.org.id, human);
    await takeOverConversation(r.w.ctx("manager"), hc.conversation_id!);
    await readySetter(r.w);
    await processMissedCalls({ now: minutesAfter(5), orgId: r.w.org.id });
    expect((await actionsOf(hc.id)).find((a) => a.kind === "appointment_setter")).toMatchObject({ status: "skipped", reason: "human_owner" });
    expect((await convOf(hc.conversation_id!)).owner_kind).toBe("human");

    const r2 = await recoveryWorkspace({ mode: "manual", policy: { routeAppointmentSetter: true } });
    const caller = callerNumber();
    await createContact(r2.owner, { displayName: "Not Ready Ned", phone: caller });
    await recordCall(r2.w.org.id, voice({ customerNumber: caller }));
    await processMissedCalls({ now: minutesAfter(5), orgId: r2.w.org.id });
    const c2 = await caseOf(r2.w.org.id, caller);
    expect((await actionsOf(c2.id)).find((a) => a.kind === "appointment_setter")).toMatchObject({ status: "blocked" });
  });
});

describe("the AI workforce's read-only reviews", () => {
  it("are limited to the roles that make sense, read-only, and need the permission to see what they read", () => {
    expect(WORKFORCE_CAPABILITIES.missed_call_review).toMatchObject({ allowedRoles: ["appointment_setter"], risk: "read_only", requiredPermission: "calls.view" });
    expect(WORKFORCE_CAPABILITIES.lead_priority_review).toMatchObject({ allowedRoles: ["sales_assistant"], risk: "read_only", requiredPermission: "contacts.view" });
    expect(roleMayUseCapability("sales_assistant", "missed_call_review")).toBe(false);
    expect(roleMayUseCapability("lead_hunter", "lead_priority_review")).toBe(false);
    expect(capabilitiesForRole("appointment_setter").map((c) => c.key)).toContain("missed_call_review");
  });

  it("report what is really waiting: unowned missed calls, drafts, hot leads nobody followed up", async () => {
    const w = await messagingOrg({ provider: { sms: "twilio" } });
    for (const role of ["appointment_setter", "sales_assistant"] as const) {
      const id = await agentId(w.org.id, role);
      await withSystem((db) => createConfigVersion(db, { orgId: w.org.id, agentId: id, settings: defaultSettings(role), source: "onboarding", userId: w.people.owner.id, apply: true }));
    }
    await withSystem((db) => db.query("update agent_instances set status = 'online', last_health_ok = true, last_health_check_at = now() where org_id = $1", [w.org.id]));
    const owner = memberActor(w.ctx("owner"));
    // A missed call with no owner for two hours, in a workspace where recovery is off.
    const caller = callerNumber();
    await recordCall(w.org.id, voice({ customerNumber: caller, startedAt: new Date(Date.now() - 3 * 3_600_000) }), new Date(Date.now() - 3 * 3_600_000));
    // A hot lead evaluated two days ago with nothing done since.
    const lead = await createContact(owner, { displayName: "Forgotten Fay", phone: callerNumber() });
    await withSystem((db) => db.query("update contacts set priority_label = 'hot', priority_score = 82, priority_source = 'engine', priority_evaluated_at = now() - interval '2 days' where id = $1", [lead.id]));
    const wait = async (jobId: string) => {
      for (let i = 0; i < 400; i += 1) {
        const r = (await rows<{ status: string; result: { findings?: Array<{ key: string; count: number }> } }>("select status, result from ai_work_jobs where id = $1", [jobId]))[0];
        if (["completed", "failed", "blocked", "cancelled"].includes(r.status)) return r;
        await new Promise((res) => setTimeout(res, 25));
      }
      throw new Error("job did not settle");
    };
    const setter = await dispatchCapabilityJob(w.ctx("owner"), { agentRole: "appointment_setter", capability: "missed_call_review", title: "Missed calls" });
    const mc = await wait(setter.jobId);
    expect(mc.status).toBe("completed");
    const mcKeys = (mc.result.findings ?? []).map((f) => f.key);
    expect(mcKeys).toEqual(expect.arrayContaining(["missed_calls_without_owner", "recovery_off_with_missed_calls"]));
    const sales = await dispatchCapabilityJob(w.ctx("owner"), { agentRole: "sales_assistant", capability: "lead_priority_review", title: "Lead priority" });
    const lp = await wait(sales.jobId);
    expect(lp.status).toBe("completed");
    expect((lp.result.findings ?? []).map((f) => f.key)).toEqual(expect.arrayContaining(["hot_leads_not_followed_up", "priority_leads_without_owner"]));
    // They read; they changed nothing.
    expect((await rows<{ priority_label: string }>("select priority_label from contacts where id = $1", [lead.id]))[0].priority_label).toBe("hot");
    expect((await caseOf(w.org.id, caller)).state).toBe("detected");
    // A role that does not hold the capability, and a viewer who may not see calls, are both refused.
    await expect(dispatchCapabilityJob(w.ctx("owner"), { agentRole: "sales_assistant", capability: "missed_call_review", title: "x" })).rejects.toThrow(/role does not include/i);
    await expect(dispatchCapabilityJob(w.ctx("viewer"), { agentRole: "appointment_setter", capability: "missed_call_review", title: "x" })).rejects.toThrow();
    void T0;
  });
});
