// Automation Studio and the reputation module: the two new triggers, the request-a-review step's survey mode, the rule that nothing started by low feedback may ask anyone for a
// review, and the post-visit check-in template. Synthetic workspaces on embedded Postgres; nothing contacts a provider.
import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { decideApproval } from "@/server/approvals/service";
import { createTemplate, approveTemplate } from "@/server/crm/message-templates";
import { createWorkflow, publishWorkflow, requestWorkflowApproval, validateWorkflowDraft } from "@/server/crm/workflows/definitions";
import { startManualRun, startTestRun } from "@/server/crm/workflows/runs";
import { processWorkflowRuns } from "@/server/crm/workflows/runner";
import { EVENT_TRIGGER_TYPES, STEP_KINDS, TRIGGERS, definitionHash, validateDefinition, validationContextFrom, type WorkflowDefinition, type WorkflowStep } from "@/lib/crm/workflow/spec";
import { STUDIO_TEMPLATES, templateReadiness, type StudioInputs } from "@/lib/automation-studio/templates";
import { stepSummary, type Names } from "@/components/crm/workflows/summaries";
import { isWebhookEventType } from "@/server/crm/webhooks";
import { all, count, one, reputationShop, shopCustomer, type ReputationShop } from "./support/reputation";

const step = (key: string, kind: WorkflowStep["kind"], config: Record<string, unknown>, next: string | null = null): WorkflowStep => ({ key, kind, config, next }) as WorkflowStep;
const codes = (def: unknown, ctx: Parameters<typeof validateDefinition>[1] = null) => validateDefinition(def, ctx).map((i) => i.code);
const HASH = "a".repeat(64);
const ID = "11111111-1111-4111-8111-111111111111";
const ask = (config: Record<string, unknown> = {}) => step("ask", "request_review", { templateId: ID, contentHash: HASH, channel: "sms", businessHoursOnly: true, ...config });

let s: ReputationShop;
beforeAll(async () => {
  s = await reputationShop("Automation Reputation Shop");
});

describe("the reputation triggers", () => {
  it("adds low private feedback and a new public review, each with an honest description of who it carries", () => {
    for (const t of ["feedback.escalated", "review.external_received"] as const) {
      expect(EVENT_TRIGGER_TYPES).toContain(t);
      expect(TRIGGERS[t].type).toBe(t);
      expect(TRIGGERS[t].group).toBe("Growth");
      // No filter on either: a rating or a star level as a filter would be a way to choose who is asked.
      expect(TRIGGERS[t].filters).toEqual([]);
    }
    expect(TRIGGERS["feedback.escalated"]).toMatchObject({ entity: "contact", carries: { contact: "always", opportunity: "never" } });
    expect(TRIGGERS["feedback.escalated"].description).toMatch(/no rating or comment/);
    expect(TRIGGERS["feedback.escalated"].description).toMatch(/can't ask anyone for a review/);
    // A public review is never matched to a customer.
    expect(TRIGGERS["review.external_received"]).toMatchObject({ entity: "none", carries: { contact: "never", opportunity: "never" } });
    expect(TRIGGERS["review.external_received"].description).toMatch(/never matched to a customer/);
    expect(TRIGGERS["review.external_received"].description).toMatch(/Nothing starts this until a review site is connected/);
  });

  it("are not offered to outside systems: webhooks still carry only the events they always did", () => {
    expect(isWebhookEventType("feedback.escalated")).toBe(false);
    expect(isWebhookEventType("review.external_received")).toBe(false);
    expect(isWebhookEventType("feedback.received")).toBe(true);
  });

  it("accept a workflow that tells people and creates tasks, and nothing needs a contact where there is none", () => {
    const tell = step("tell", "notify_team", { roles: ["owner"], title: "Low feedback" }, "task");
    const task = step("task", "create_task", { title: "Call them back", priority: "high", assignee: "contact_owner" });
    expect(codes({ trigger: { type: "feedback.escalated" }, steps: [tell, task] })).toEqual([]);
    expect(codes({ trigger: { type: "review.external_received" }, steps: [step("tell", "notify_team", { roles: ["owner"], title: "New review" })] })).toEqual([]);
    // A step that needs a contact has none on a public review.
    expect(codes({ trigger: { type: "review.external_received" }, steps: [ask()] })).toContain("needs_contact");
    // Filtering either trigger is refused: they have no filters.
    expect(codes({ trigger: { type: "feedback.escalated", filters: { channels: ["sms"] } }, steps: [tell] })).toContain("invalid_trigger");
  });
});

describe("nothing started by low feedback may ask anyone for a review", () => {
  it("refuses a request-a-review step, in either mode, on a workflow started by low feedback", () => {
    for (const config of [{}, { mode: "survey" }, { mode: "survey", scale: "nps10" }, { mode: "review" }]) {
      const found = validateDefinition({ trigger: { type: "feedback.escalated" }, steps: [ask(config)] }, null);
      const hit = found.find((i) => i.code === "review_after_low_feedback");
      expect(hit, JSON.stringify(config)).toMatchObject({ level: "error", stepKey: "ask" });
      expect(hit!.message).toMatch(/can't ask anyone for a review or a survey/);
      expect(hit!.message).toMatch(/never depend on how they felt/);
    }
  });

  it("allows the same step after a trigger that fires for every answer alike, or for anything else", () => {
    for (const trigger of ["feedback.received", "appointment.showed", "manual", "contact.created"] as const) {
      expect(codes({ trigger: { type: trigger }, steps: [ask()] }), trigger).not.toContain("review_after_low_feedback");
    }
  });

  it("also refuses a message whose approved wording carries the customer's review link", () => {
    const send = step("send", "send_message", { templateId: ID, contentHash: HASH, channel: "sms", sendAs: "sales_assistant", businessHoursOnly: true });
    const ctx = (reviewLink: boolean | undefined) => validationContextFrom({
      tags: [], users: [], pipelines: [], fields: [], templates: [{ id: ID, contentHash: HASH, channel: "sms", ...(reviewLink === undefined ? {} : { reviewLink }) }], n8nMappings: [], webhookSubscriptions: [],
      assignmentRules: [], agents: [{ roleKey: "sales_assistant" }], calendars: [], appointmentTypes: [],
    });
    const def = { trigger: { type: "feedback.escalated" }, steps: [send] };
    expect(codes(def, ctx(true))).toContain("review_after_low_feedback");
    expect(codes(def, ctx(false))).not.toContain("review_after_low_feedback");
    expect(codes(def, ctx(undefined))).not.toContain("review_after_low_feedback");
    expect(validationContextFrom({
      tags: [], users: [], pipelines: [], fields: [], templates: [{ id: ID, contentHash: HASH, channel: "sms", body: "How did we do? {{review.link}}" }], n8nMappings: [], webhookSubscriptions: [], assignmentRules: [], agents: [], calendars: [], appointmentTypes: [],
    }).templates.get(ID)).toMatchObject({ hasReviewLink: true });
    // Another trigger sending the same message is fine.
    expect(codes({ trigger: { type: "manual" }, steps: [send] }, ctx(true))).not.toContain("review_after_low_feedback");
  });

  it("is enforced where a workflow is checked against a real workspace, from the template's stored wording", async () => {
    const t = await createTemplate(s.owner, { name: "Survey text", channel: "sms", purpose: "service", body: "Hi {{contact.first_name}}, how did we do? {{review.link}}" });
    const ok = await approveTemplate(s.owner, t.id, { version: t.currentVersion, contentHash: t.contentHash });
    const plain = await createTemplate(s.owner, { name: "Plain thanks", channel: "sms", purpose: "service", body: "Thanks for visiting {{business.name}}." });
    const plainOk = await approveTemplate(s.owner, plain.id, { version: plain.currentVersion, contentHash: plain.contentHash });
    const definition = (templateId: string, contentHash: string): WorkflowDefinition => ({
      trigger: { type: "feedback.escalated" },
      steps: [step("send", "send_message", { templateId, contentHash, channel: "sms", sendAs: "sales_assistant", businessHoursOnly: true })],
    });
    expect((await validateWorkflowDraft(s.manager, definition(t.id, ok.contentHash))).map((i) => i.code)).toContain("review_after_low_feedback");
    expect((await validateWorkflowDraft(s.manager, definition(plain.id, plainOk.contentHash))).map((i) => i.code)).not.toContain("review_after_low_feedback");
    // A real publish of the asking workflow is refused with the reason.
    const asking: WorkflowDefinition = { trigger: { type: "feedback.escalated" }, steps: [ask({ templateId: t.id, contentHash: ok.contentHash })] };
    const { id } = await createWorkflow(s.manager, { name: "Ask the unhappy", definition: asking });
    await expect(publishWorkflow(s.manager, id)).rejects.toThrow(/can't ask anyone for a review or a survey/);
    // The same workspace may build a workflow that follows low feedback by telling people.
    const caring: WorkflowDefinition = { trigger: { type: "feedback.escalated" }, steps: [step("tell", "notify_team", { roles: ["owner", "admin"], title: "Low feedback needs a call" })] };
    const made = await createWorkflow(s.manager, { name: "Tell the team", definition: caring });
    expect(await publishWorkflow(s.manager, made.id)).toMatchObject({ created: true, effects: [] });
  });
});

describe("the request-a-review step's survey mode", () => {
  it("stores nothing new for a review request, so a workflow published before surveys existed keeps its exact content", () => {
    const old = { trigger: { type: "manual" as const }, steps: [ask()] };
    const explicit = { trigger: { type: "manual" as const }, steps: [ask({ mode: "review" })] };
    expect(codes(old)).toEqual([]);
    expect(codes(explicit)).toEqual([]);
    // The hash of the old shape is unchanged by the new optional fields: it is computed from exactly what was published.
    const hash = definitionHash(old as WorkflowDefinition);
    expect(definitionHash({ trigger: { type: "manual" }, steps: [ask()] } as WorkflowDefinition)).toBe(hash);
    expect(definitionHash(explicit as WorkflowDefinition)).not.toBe(hash);
    expect(STEP_KINDS.request_review.defaults()).toEqual({ businessHoursOnly: true });
  });

  it("accepts a survey on either scale, and refuses a scale on anything but a survey", () => {
    expect(codes({ trigger: { type: "manual" }, steps: [ask({ mode: "survey" })] })).toEqual([]);
    expect(codes({ trigger: { type: "manual" }, steps: [ask({ mode: "survey", scale: "nps10" })] })).toEqual([]);
    expect(codes({ trigger: { type: "manual" }, steps: [ask({ scale: "nps10" })] })).toContain("invalid_config");
    expect(codes({ trigger: { type: "manual" }, steps: [ask({ mode: "review", scale: "csat5" })] })).toContain("invalid_config");
    expect(codes({ trigger: { type: "manual" }, steps: [ask({ mode: "poll" })] })).toContain("invalid_config");
    expect(codes({ trigger: { type: "manual" }, steps: [ask({ mode: "survey", scale: "stars" })] })).toContain("invalid_config");
  });

  it("is told in plain words on the canvas and to the owner approving it", () => {
    const names = { template: () => ({ name: "How did we do" }) } as unknown as Names;
    const summary = (config: Record<string, unknown>) => stepSummary({ kind: "request_review", config } as unknown as WorkflowStep, names);
    expect(summary({ templateId: ID, channel: "sms", businessHoursOnly: true })).toBe("Ask for a review by SMS with “How did we do”, in business hours");
    expect(summary({ templateId: ID, channel: "sms", businessHoursOnly: false, mode: "survey" })).toBe("Send a 1 to 5 survey by SMS with “How did we do”");
    expect(summary({ templateId: ID, channel: "email", businessHoursOnly: true, mode: "survey", scale: "nps10" })).toBe("Send a 0 to 10 recommend survey by Email with “How did we do”, in business hours");
  });

  it("sends a survey under the owner's approval: the request is a survey on the chosen scale, started by the workflow, with the same consent rules", async () => {
    const t = await createTemplate(s.owner, { name: "Survey ask", channel: "sms", purpose: "service", body: "Hi {{contact.first_name}}, a quick question from {{business.name}}: {{review.link}}" });
    const ok = await approveTemplate(s.owner, t.id, { version: t.currentVersion, contentHash: t.contentHash });
    const def: WorkflowDefinition = { trigger: { type: "manual" }, steps: [ask({ templateId: t.id, contentHash: ok.contentHash, businessHoursOnly: false, mode: "survey", scale: "nps10" })] };
    const { id } = await createWorkflow(s.manager, { name: "Send the survey", definition: def });
    expect(await publishWorkflow(s.manager, id)).toMatchObject({ needsApproval: true, effects: ["send_sms"] });
    const req = await requestWorkflowApproval(s.manager, id, null, { activate: true });
    expect((await decideApproval(s.m.ctx("owner"), req.approvalId!, "approve")).outcome?.status).toBe("succeeded");

    const noConsent = await shopCustomer(s, { consent: false });
    const a = await startManualRun(s.owner, id, { contactId: noConsent });
    await processWorkflowRuns();
    expect(await one("select status, result->>'reason' as reason from crm_workflow_run_steps where run_id = $1", [a.runId])).toEqual({ status: "skipped", reason: "no_consent" });
    expect(await count("select count(*)::text as n from crm_review_requests where contact_id = $1", [noConsent])).toBe(0);

    const contactId = await shopCustomer(s);
    const dry = JSON.stringify(await startTestRun(s.owner, id, { contactId }));
    expect(dry).toMatch(/Would send .* a survey/);
    expect(await count("select count(*)::text as n from crm_review_requests where contact_id = $1", [contactId])).toBe(0);
    const b = await startManualRun(s.owner, id, { contactId });
    await processWorkflowRuns();
    const made = await one<{ id: string; kind: string; scale: string; requested_via: string; status: string; message_id: string }>("select id, kind, scale, requested_via, status, message_id from crm_review_requests where contact_id = $1", [contactId]);
    expect(made).toMatchObject({ kind: "survey", scale: "nps10", requested_via: "workflow", status: "queued" });
    expect(await one("select dedupe_key from conversation_messages where id = $1", [made.message_id])).toEqual({ dedupe_key: `wf:${b.runId}:ask` });
    const ev = (await all<{ payload: Record<string, unknown> }>("select payload from crm_events where org_id = $1 and type = 'review.requested' and entity_id = $2", [s.m.org.id, made.id]))[0];
    expect(ev.payload).toMatchObject({ kind: "survey", scale: "nps10", via: "workflow" });
  });
});

describe("the post-visit check-in template", () => {
  const tpl = STUDIO_TEMPLATES.find((t) => t.key === "post-service-check-in")!;

  it("is in the library, starts when someone is marked as having attended, and says it sends approved messages", () => {
    expect(tpl).toBeTruthy();
    expect(tpl).toMatchObject({ trigger: "appointment.showed", reach: ["messages"], category: "Appointments", needsSurveys: true });
    expect(tpl.inputs.map((i) => [i.key, i.kind, i.required])).toEqual([["message", "message_template", true], ["survey", "review_template", true]]);
  });

  it("says in the gallery what a workspace is missing, including that surveys are not switched on for it", () => {
    const editor = (surveysEnabled: boolean | undefined) => ({
      tags: [], members: [], pipelines: [], calendars: [], forms: [], employees: [], connections: [], surveysEnabled,
      templates: [
        { id: ID, key: "k", name: "Thanks", channel: "sms", purpose: "service", version: 1, subject: null, body: "Thanks for visiting.", contentHash: HASH },
        { id: crypto.randomUUID(), key: "s", name: "Survey", channel: "sms", purpose: "service", version: 1, subject: null, body: "How did we do? {{review.link}}", contentHash: HASH },
      ],
    }) as never;
    expect(templateReadiness(tpl, editor(false))).toMatchObject({ ready: false, missing: ["satisfaction surveys switched on for your workspace (ask your iAcquire contact)"] });
    expect(templateReadiness(tpl, editor(true))).toMatchObject({ ready: true, missing: [] });
    expect(templateReadiness(tpl, editor(undefined))).toMatchObject({ ready: true });
    // A template that sends no survey is not held back by the switch.
    expect(templateReadiness(STUDIO_TEMPLATES.find((t) => t.key === "post-visit-review-request")!, editor(false))).toMatchObject({ ready: true });
  });

  it("checks in a day after the visit, then three days later sends a survey: two messages, in that order, and nothing else", () => {
    const inputs: StudioInputs = {
      message: { templateId: crypto.randomUUID(), contentHash: "b".repeat(64), channel: "sms" },
      survey: { templateId: crypto.randomUUID(), contentHash: "c".repeat(64), channel: "email" },
    };
    const def = tpl.build(inputs, { newNonce: () => "n".repeat(24) });
    expect(def.trigger).toEqual({ type: "appointment.showed" });
    expect(def.steps.map((x) => [x.key, x.kind, x.next])).toEqual([["wait", "wait", "checkin"], ["checkin", "send_message", "wait_survey"], ["wait_survey", "wait", "survey"], ["survey", "request_review", null]]);
    expect(def.steps[0].config).toMatchObject({ mode: "duration", amount: 1, unit: "days" });
    expect(def.steps[2].config).toMatchObject({ mode: "duration", amount: 3, unit: "days" });
    expect(def.steps[3].config).toEqual({ templateId: (inputs.survey as { templateId: string }).templateId, contentHash: "c".repeat(64), channel: "email", businessHoursOnly: true, mode: "survey" });
    expect(def.steps[1].config).toMatchObject({ channel: "sms", businessHoursOnly: true });
    // It never starts from, or branches on, how anyone felt.
    expect(JSON.stringify(def)).not.toMatch(/"(rating|score|feedback|sentiment)"/);
  });
});
