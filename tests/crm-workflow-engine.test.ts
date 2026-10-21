// The native workflow engine: the pure contract (catalog, validator, effects, content hash), definitions and versions with the owner
// approval bound to a version's content, the event dispatcher (claiming, idempotency, subscriber isolation, dead letters), the runner
// (every step kind, branches, waits, pauses, the loop limit, retries, dead runs) and test runs. External effects are mocked: the n8n call
// (E), the webhook queue (wrapped, so its real idempotency is exercised) and the AI-employee request (C). Nothing leaves the machine.
import crypto from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/integrations/n8n-actions", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/server/integrations/n8n-actions")>();
  return { ...mod, callN8nWorkflow: vi.fn(async () => ({ status: "sent", retryable: false, detail: "n8n accepted the request (HTTP 200).", httpStatus: 200 })) };
});
vi.mock("@/server/crm/webhooks", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/server/crm/webhooks")>();
  return { ...mod, enqueueWorkflowWebhook: vi.fn(mod.enqueueWorkflowWebhook) };
});
vi.mock("@/server/crm/agent-tools/tasks", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/server/crm/agent-tools/tasks")>();
  return { ...mod, requestAgentTask: vi.fn(mod.requestAgentTask) };
});

import { withSystem } from "@/server/db";
import { decideApproval } from "@/server/approvals/service";
import { callN8nWorkflow } from "@/server/integrations/n8n-actions";
import { enqueueWorkflowWebhook } from "@/server/crm/webhooks";
import { requestAgentTask } from "@/server/crm/agent-tools/tasks";
import { memberActor, type CrmActor } from "@/server/crm/actor";
import { createContact, setContactConsent } from "@/server/crm/contacts";
import { createTag } from "@/server/crm/tags";
import { listPipelines } from "@/server/crm/pipelines";
import { createOpportunity } from "@/server/crm/opportunities";
import { createTask } from "@/server/crm/tasks";
import { createAssignmentRule } from "@/server/crm/assignment";
import { createTemplate, approveTemplate } from "@/server/crm/message-templates";
import { MAX_EVENT_DEPTH } from "@/server/crm/events";
import { crmEventDispatch, DISPATCH_MAX_ATTEMPTS, type Subscriber } from "@/server/crm/dispatch";
import {
  cloneWorkflow, createFromTemplate, createWorkflow, getWorkflow, listWorkflowTemplates, listWorkflows, publishWorkflow, requestWorkflowApproval, saveWorkflowDraft,
  setWorkflowStatus, updateWorkflowSettings,
} from "@/server/crm/workflows/definitions";
import { cancelRun, getRun, listRuns, retryRunStep, skipRunStep, startManualRun, startTestRun } from "@/server/crm/workflows/runs";
import { fireSchedules, processWorkflowRuns, recoverAbandonedRuns } from "@/server/crm/workflows/runner";
import { handleInboundWebhook, inboundToken } from "@/server/crm/workflows/inbound";
import { checkOrgAutomation } from "@/server/automation/gate";
import { JOBS } from "@/server/ops/tick";
import { emitTaskDueEvents } from "@/server/crm/tasks";
import {
  STEP_KINDS, STEP_KIND_LIST, TRIGGERS, TRIGGER_TYPES, WORKFLOW_LIMITS, definitionHash, deriveEffects, validateDefinition, validationContextFrom,
  type ValidationContext, type WorkflowDefinition, type WorkflowStep,
} from "@/lib/crm/workflow/spec";
import { sha256Hex } from "@/lib/crm/workflow/sha256";
import { WORKFLOW_TEMPLATES } from "@/lib/crm/workflow/templates";
import { addMember, createUser, ctxFor, uid } from "./support/fixtures";
import { crmOrg, type CrmOrg } from "./support/crm";
import { inbound, messagingOrg } from "./support/messaging";

const n8nMock = vi.mocked(callN8nWorkflow);
const webhookMock = vi.mocked(enqueueWorkflowWebhook);
const agentTaskMock = vi.mocked(requestAgentTask);
afterEach(() => {
  n8nMock.mockClear();
  webhookMock.mockClear();
  agentTaskMock.mockClear();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const U = () => crypto.randomUUID();
const step = (key: string, kind: WorkflowStep["kind"], config: Record<string, unknown>, next: string | null = null, extra: Partial<WorkflowStep> = {}): WorkflowStep =>
  ({ key, kind, config, next, ...extra }) as WorkflowStep;
const chain = (...steps: WorkflowStep[]): WorkflowStep[] => steps.map((s, i) => (s.kind === "branch" || s.kind === "end" || s.next ? s : { ...s, next: steps[i + 1]?.key ?? null }));

const ownerCtx = (o: CrmOrg) => ctxFor(o.people.owner, o.org, "owner");
const managerCtx = (o: CrmOrg) => ctxFor(o.people.manager, o.org, "admin");

/** Runs the dispatcher and the runner until nothing is left to do at `now`. */
async function settle(now?: Date) {
  for (let i = 0; i < 25; i++) {
    const d = await crmEventDispatch({ now });
    const r = await processWorkflowRuns({ now });
    if (!d.claimed && !r.claimed && !r.scheduled) return;
  }
}

async function runsOf(workflowId: string) {
  const { rows } = await withSystem((db) =>
    db.query<{ id: string; status: string; contact_id: string | null; depth: number; context: Record<string, unknown>; last_error: string | null; current_step: string | null; attempts: number; next_run_at: Date; trigger_event_id: string | null }>(
      "select id, status, contact_id, depth, context, last_error, current_step, attempts, next_run_at, trigger_event_id from crm_workflow_runs where workflow_id = $1 order by created_at, id",
      [workflowId],
    ),
  );
  return rows;
}

async function stepsOf(runId: string) {
  const { rows } = await withSystem((db) =>
    db.query<{ step_key: string; kind: string; attempt: number; status: string; result: Record<string, unknown>; error: string | null; idempotency_key: string; approval_id: string | null }>(
      "select step_key, kind, attempt, status, result, error, idempotency_key, approval_id from crm_workflow_run_steps where run_id = $1 order by id",
      [runId],
    ),
  );
  return rows;
}

const one = async <T>(sql: string, params: unknown[]): Promise<T> => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows[0] as T;
const count = async (sql: string, params: unknown[]) => Number((await one<{ n: string }>(sql, params)).n);

/** Creates, publishes and (unless told not to) switches on a workflow that needs no owner approval. */
async function liveWorkflow(o: CrmOrg, definition: WorkflowDefinition, opts: { name?: string; hourlyRunLimit?: number; activate?: boolean; actor?: CrmActor } = {}) {
  const actor = opts.actor ?? o.actor("owner");
  const { id } = await createWorkflow(actor, { name: opts.name ?? `Workflow ${uid()}`, definition });
  if (opts.hourlyRunLimit) await updateWorkflowSettings(actor, id, { hourlyRunLimit: opts.hourlyRunLimit });
  const published = await publishWorkflow(actor, id);
  if (opts.activate !== false && !published.needsApproval) await setWorkflowStatus(actor, id, "active");
  return { id, published };
}

/** The owner approves the published version (switching the workflow on). */
async function ownerApproves(o: CrmOrg, workflowId: string, activate = true) {
  const req = await requestWorkflowApproval(o.actor("manager"), workflowId, null, { activate });
  expect(req.status).toBe("requested");
  const decided = await decideApproval(ownerCtx(o), req.approvalId!, "approve");
  expect(decided.outcome?.status).toBe("succeeded");
  return req.approvalId!;
}

async function contactIn(o: CrmOrg, over: Parameters<typeof createContact>[1] = {}) {
  return (await createContact(o.actor("owner"), { firstName: "Lead", lastName: uid(), ...over })).id;
}

/** A verified agency n8n mapping for the workspace (the call itself is mocked). */
async function verifiedN8nMapping(o: CrmOrg) {
  return withSystem(async (db) => {
    const conn = await db.query<{ id: string }>(
      `insert into integration_connections (org_id, provider, label, config, status) values (null, 'n8n', 'Agency n8n', '{}'::jsonb, 'connected')
       on conflict (coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), provider) do update set status = 'connected' returning id`,
    );
    const m = await db.query<{ id: string }>(
      "insert into automation_template_mappings (org_id, global_connection_id, workflow_id, status, last_verified_at) values ($1, $2, $3, 'verified', now()) returning id",
      [o.org.id, conn.rows[0].id, `wf${uid()}`],
    );
    return m.rows[0].id;
  });
}

/** An active outbound webhook subscription, written directly (the step only queues; nothing is delivered in these tests). */
async function webhookSubscription(o: CrmOrg, name = "Zapier") {
  return (await one<{ id: string }>(
    "insert into crm_webhook_subscriptions (org_id, name, url, event_types, secret_ciphertext, secret_hint) values ($1, $2, 'https://hooks.example.test/in', '{note.added}', 'v1.synthetic', 'abcd') returning id",
    [o.org.id, name],
  )).id;
}

const tagsOf = async (contactId: string) =>
  (await withSystem((db) => db.query<{ name: string }>("select t.name::text as name from crm_contact_tags ct join crm_tags t on t.id = ct.tag_id where ct.contact_id = $1 order by 1", [contactId]))).rows.map((r) => r.name);

/** A context with everything present, for the pure validator. */
function fullContext(over: Partial<Parameters<typeof validationContextFrom>[0]> = {}): ValidationContext {
  return validationContextFrom({
    tags: [{ id: TAG }], users: [{ id: USER }], pipelines: [{ id: PIPE, stages: [{ id: OPEN, kind: "open" }, { id: LOST, kind: "lost" }] }],
    fields: [{ id: FIELD, entity: "contact", type: "date", key: "renewal" }], templates: [{ id: TPL, contentHash: HASH, channel: "sms" }],
    n8nMappings: [{ id: N8N }], webhookSubscriptions: [{ id: HOOK }], assignmentRules: [{ id: RULE, entity: "contact" }], agents: [{ roleKey: "sales_assistant" }, { roleKey: "crm_manager" }],
    calendars: [], appointmentTypes: [], ...over,
  });
}
const [TAG, USER, PIPE, OPEN, LOST, FIELD, TPL, N8N, HOOK, RULE] = Array.from({ length: 10 }, U);
const HASH = "a".repeat(64);

// ---------------------------------------------------------------------------
// The pure contract
// ---------------------------------------------------------------------------

describe("catalog, validation, effects and the content hash (pure)", () => {
  it("lists every trigger and step kind with a schema, effects and branching", () => {
    expect(Object.keys(STEP_KINDS).sort()).toEqual([...STEP_KIND_LIST].sort());
    for (const t of TRIGGER_TYPES) expect(TRIGGERS[t].type).toBe(t);
    for (const k of STEP_KIND_LIST) {
      const spec = STEP_KINDS[k];
      expect(spec.kind).toBe(k);
      expect(typeof spec.schema.safeParse).toBe("function");
      expect(spec.label.length).toBeGreaterThan(2);
    }
    expect(STEP_KINDS.branch.branches).toBe(true);
    expect(STEP_KIND_LIST.filter((k) => STEP_KINDS[k].branches)).toEqual(["branch"]);
    expect(STEP_KINDS.end.terminal).toBe(true);
    expect(STEP_KINDS.n8n.external).toBe(true);
    // Only messages, webhooks, n8n, the AI employee, HTTP requests and Slack messages leave the CRM.
    for (const k of STEP_KIND_LIST) {
      if (["send_message", "n8n", "webhook", "ai_task", "http_request", "slack_message"].includes(k)) continue;
      expect((STEP_KINDS[k].effects as (c: never) => string[])(STEP_KINDS[k].defaults() as never), k).toEqual([]);
    }
    expect(STEP_KINDS.send_message.effects({ channel: "whatsapp" } as never)).toEqual(["send_whatsapp"]);
    expect(STEP_KINDS.n8n.effects({} as never)).toEqual(["n8n"]);
    expect(STEP_KINDS.webhook.effects({} as never)).toEqual(["webhook"]);
    expect(STEP_KINDS.ai_task.effects({} as never)).toEqual(["hermes"]);
    expect(STEP_KINDS.http_request.effects({} as never)).toEqual(["http"]);
    expect(STEP_KINDS.slack_message.effects({} as never)).toEqual(["slack"]);
    expect(TRIGGERS.schedule.carries.contact).toBe("never");
    expect(TRIGGERS["opportunity.won"].filters).toContain("pipelineId");
  });

  it("accepts a valid definition and reports structural problems in plain words", () => {
    const ctx = fullContext();
    const good: WorkflowDefinition = { trigger: { type: "contact.created" }, steps: chain(step("tag", "add_tag", { tagIds: [TAG] }), step("task", "create_task", { title: "Call {{contact.first_name}}", priority: "high", assignee: "contact_owner" })) };
    expect(validateDefinition(good, ctx)).toEqual([]);

    const issues = (def: unknown) => validateDefinition(def, ctx);
    expect(issues({ trigger: { type: "contact.created" }, steps: [] }).map((i) => i.code)).toContain("no_steps");
    expect(issues({ trigger: { type: "nope" }, steps: [] }).map((i) => i.code)).toContain("invalid_trigger");
    expect(issues({ trigger: { type: "contact.created" }, steps: [step("x", "explode" as never, {})] }).map((i) => i.code)).toContain("unknown_step");
    const badConfig = issues({ trigger: { type: "contact.created" }, steps: [step("t", "add_tag", { tagIds: [] })] });
    expect(badConfig[0]).toMatchObject({ code: "invalid_config", stepKey: "t" });
    expect(badConfig[0].message).toMatch(/Choose at least one tag/);
    expect(issues({ trigger: { type: "contact.created" }, steps: [step("a", "add_tag", { tagIds: [TAG] }, "ghost")] }).map((i) => i.code)).toContain("missing_step");
    expect(issues({ trigger: { type: "contact.created" }, steps: [step("a", "add_tag", { tagIds: [TAG] }), step("a", "end", {})] }).map((i) => i.code)).toContain("duplicate_key");
    expect(issues({ trigger: { type: "contact.created" }, steps: [step("a", "add_tag", { tagIds: [TAG] }), step("b", "end", {})] }).find((i) => i.code === "unreachable")?.stepKey).toBe("b");
    const tokens = issues({ trigger: { type: "contact.created" }, steps: [step("t", "create_task", { title: "Hi {{contact.shoe_size}}", priority: "low", assignee: "none" })] });
    expect(tokens.map((i) => i.code)).toContain("unknown_token");
  });

  it("allows loops only through a wait, and limits size and depth", () => {
    const ctx = fullContext();
    const loopNoWait: WorkflowDefinition = { trigger: { type: "contact.created" }, steps: [step("a", "add_tag", { tagIds: [TAG] }, "b"), step("b", "remove_tag", { tagIds: [TAG] }, "a")] };
    const cyc = validateDefinition(loopNoWait, ctx).filter((i) => i.code === "cycle");
    expect(cyc.map((i) => i.stepKey).sort()).toEqual(["a", "b"]);
    const loopWithWait: WorkflowDefinition = { trigger: { type: "contact.created" }, steps: [step("a", "add_tag", { tagIds: [TAG] }, "w"), step("w", "wait", { mode: "duration", amount: 1, unit: "days" }, "a")] };
    expect(validateDefinition(loopWithWait, ctx).filter((i) => i.level === "error")).toEqual([]);

    const many = Array.from({ length: WORKFLOW_LIMITS.maxSteps + 1 }, (_, i) => step(`s${i}`, "internal_note", { subject: "contact", body: "x" }));
    expect(validateDefinition({ trigger: { type: "contact.created" }, steps: chain(...many) }, ctx).map((i) => i.code)).toContain("too_many_steps");
    const deep = Array.from({ length: WORKFLOW_LIMITS.maxDepth + 1 }, (_, i) => step(`d${i}`, "internal_note", { subject: "contact", body: "x" }));
    expect(validateDefinition({ trigger: { type: "contact.created" }, steps: chain(...deep) }, ctx).map((i) => i.code)).toContain("too_deep");

    const branchWithNext = validateDefinition({ trigger: { type: "contact.created" }, steps: [step("b", "branch", { subject: "contact", filter: { op: "and", conditions: [{ field: "tags", op: "has_any", value: [TAG] }] } }, "e", { branches: { yes: "e" } }), step("e", "end", {})] }, ctx);
    expect(branchWithNext.map((i) => i.code)).toContain("invalid_link");
  });

  it("checks every reference against the workspace", () => {
    const def = (steps: WorkflowStep[], trigger: WorkflowDefinition["trigger"] = { type: "contact.created" }): WorkflowDefinition => ({ trigger, steps });
    const codes = (d: WorkflowDefinition, ctx = fullContext()) => validateDefinition(d, ctx).filter((i) => i.level === "error").map((i) => i.code);
    expect(codes(def([step("t", "add_tag", { tagIds: [U()] })]))).toEqual(["missing_tag"]);
    expect(codes(def([step("a", "assign", { subject: "contact", to: "user", userId: U(), onlyIfUnassigned: true })]))).toEqual(["missing_user"]);
    expect(codes(def([step("a", "assign", { subject: "opportunity", to: "rule", ruleId: RULE, onlyIfUnassigned: true })], { type: "opportunity.created" }))).toEqual(["invalid_config"]);
    expect(codes(def([step("m", "move_stage", { pipelineId: U(), stageId: OPEN })]))).toEqual(["missing_pipeline"]);
    expect(codes(def([step("m", "move_stage", { pipelineId: PIPE, stageId: U() })]))).toEqual(["missing_stage"]);
    expect(codes(def([step("m", "move_stage", { pipelineId: PIPE, stageId: LOST })]))).toEqual(["invalid_config"]);
    expect(codes(def([step("o", "create_opportunity", { name: "Deal", pipelineId: PIPE, stageId: LOST, ownerFromContact: true, skipIfOpenInPipeline: true })]))).toEqual(["invalid_config"]);
    const send = (over: Record<string, unknown> = {}) => step("s", "send_message", { templateId: TPL, contentHash: HASH, channel: "sms", sendAs: "sales_assistant", businessHoursOnly: false, ...over });
    expect(codes(def([send()]))).toEqual([]);
    expect(codes(def([send({ templateId: U() })]))).toEqual(["missing_template"]);
    expect(codes(def([send({ contentHash: "b".repeat(64) })]))).toEqual(["template_changed"]);
    expect(codes(def([send({ sendAs: "appointment_setter" })]), fullContext({ agents: [{ roleKey: "sales_assistant" }] }))).toEqual(["missing_agent"]);
    expect(codes(def([step("n", "n8n", { mappingId: U(), includeContact: true })]))).toEqual(["missing_n8n"]);
    expect(codes(def([step("w", "webhook", { subscriptionId: U(), includeContact: false })]))).toEqual(["missing_webhook"]);
    expect(codes(def([step("w", "wait", { mode: "until_date", source: "contact_field", fieldId: U(), offset: { amount: 1, unit: "days", direction: "before" }, ifMissing: "end" })]))).toEqual(["missing_field"]);
    // A trigger can only be filtered the ways its catalog entry allows, and a schedule has no contact to act on.
    expect(codes(def([step("t", "add_tag", { tagIds: [TAG] })], { type: "contact.created", filters: { pipelineId: PIPE } }))).toEqual(["invalid_trigger"]);
    expect(codes(def([step("t", "add_tag", { tagIds: [TAG] })], { type: "schedule", schedule: { frequency: "daily", time: "09:00" } }))).toEqual(["needs_contact"]);
    expect(codes(def([step("t", "add_tag", { tagIds: [TAG] })], { type: "contact.tag_added", filters: { tagIds: [U()] } }))).toEqual(["missing_tag"]);
  });

  it("derives effects in a fixed order and hashes content, not layout", () => {
    const d: WorkflowDefinition = {
      trigger: { type: "contact.created" },
      steps: chain(
        step("w", "webhook", { subscriptionId: HOOK, includeContact: true }),
        step("e", "send_message", { templateId: TPL, contentHash: HASH, channel: "email", sendAs: "sales_assistant", businessHoursOnly: true }),
        step("s", "send_message", { templateId: TPL, contentHash: HASH, channel: "sms", sendAs: "sales_assistant", businessHoursOnly: true }),
        step("t", "add_tag", { tagIds: [TAG] }),
      ),
    };
    expect(deriveEffects(d)).toEqual(["send_email", "send_sms", "webhook"]);
    expect(deriveEffects({ trigger: { type: "contact.created" }, steps: [step("t", "add_tag", { tagIds: [TAG] })] })).toEqual([]);
    const h = definitionHash(d);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    // Moving a step on the canvas, or listing keys in another order, is the same content.
    const moved = { trigger: { type: "contact.created" as const }, steps: d.steps.map((s) => ({ ui: { x: 10, y: 20 }, next: s.next, config: s.config, kind: s.kind, key: s.key }) as WorkflowStep) };
    expect(definitionHash(moved)).toBe(h);
    // Any change to what it does is new content.
    const edited = { ...d, steps: d.steps.map((s) => (s.key === "t" ? { ...s, config: { tagIds: [U()] } } : s)) };
    expect(definitionHash(edited)).not.toBe(h);
    expect(definitionHash({ ...d, steps: d.steps.map((s) => (s.key === "t" ? { ...s, requireApproval: true } : s)) })).not.toBe(h);
  });

  it("computes the same SHA-256 as node:crypto, in the browser-safe implementation", () => {
    for (const text of ["", "abc", "Grüße, 世界 — 🙂", "x".repeat(1000), JSON.stringify({ a: [1, 2, 3], b: "c" })]) {
      expect(sha256Hex(text)).toBe(crypto.createHash("sha256").update(text, "utf8").digest("hex"));
    }
  });

  it("builds a valid draft from every built-in template once its choices are made", () => {
    const inputs = { tag: TAG, owner: USER, pipeline: PIPE, stage: { pipelineId: PIPE, stageId: OPEN }, message: { templateId: TPL, contentHash: HASH, channel: "sms" as const } };
    for (const t of WORKFLOW_TEMPLATES) {
      const def = t.build(inputs);
      expect(validateDefinition(def, fullContext()).filter((i) => i.level === "error"), t.key).toEqual([]);
      expect(def.trigger.type).toBe(t.trigger);
      if (t.sendsMessages) expect(deriveEffects(def)).toEqual(["send_sms"]);
      else expect(deriveEffects(def)).toEqual([]);
    }
    // A template that sends messages has no message step until a template is chosen (the no-show one makes it optional).
    expect(WORKFLOW_TEMPLATES.find((t) => t.key === "no_show_follow_up")!.build({}).steps.map((s) => s.kind)).toEqual(["create_task"]);
  });
});

// ---------------------------------------------------------------------------
// Definitions, versions and the owner approval
// ---------------------------------------------------------------------------

describe("definitions, publishing and approval", () => {
  let o: CrmOrg;
  let tag: string;
  beforeAll(async () => {
    o = await crmOrg({ name: "Definitions Co" });
    tag = (await createTag(o.actor("owner"), { name: `Lead ${uid()}` })).id;
  });

  it("saves drafts with a revision check and refuses to publish a draft with errors", async () => {
    const owner = o.actor("owner");
    const { id } = await createWorkflow(owner, { name: "New lead welcome", triggerType: "contact.created" });
    const w = await getWorkflow(owner, id);
    expect(w).toMatchObject({ status: "draft", draftRevision: 1, publishedVersion: null, unpublishedChanges: true, approval: "not_needed" });
    expect(w.issues.map((i) => i.code)).toContain("no_steps");
    await expect(publishWorkflow(owner, id)).rejects.toThrow(/Fix this before publishing: Add at least one step/);

    const def: WorkflowDefinition = { trigger: { type: "contact.created" }, steps: [step("tag", "add_tag", { tagIds: [tag] })] };
    const saved = await saveWorkflowDraft(owner, id, { definition: def, expectedRevision: 1 });
    expect(saved.revision).toBe(2);
    expect(saved.issues).toEqual([]);
    // A second editor still on revision 1 can't overwrite it.
    await expect(saveWorkflowDraft(o.actor("manager"), id, { definition: { ...def, steps: [] }, expectedRevision: 1 })).rejects.toThrow(/Someone else saved/);
    await expect(publishWorkflow(owner, id, { expectedRevision: 1 })).rejects.toThrow(/Someone else saved/);
    // Sales reps can't build automations.
    await expect(saveWorkflowDraft(o.actor("sales"), id, { definition: def, expectedRevision: 2 })).rejects.toThrow(/permission|role/);
    await expect(saveWorkflowDraft(owner, id, { definition: "nope", expectedRevision: 2 })).rejects.toThrow(/isn't a workflow definition/);
  });

  it("freezes a version on publish, creates nothing for an unchanged draft, and keeps versions immutable", async () => {
    const owner = o.actor("owner");
    const def: WorkflowDefinition = { trigger: { type: "contact.created" }, steps: [step("tag", "add_tag", { tagIds: [tag] })] };
    const { id } = await createWorkflow(owner, { name: "Freeze me", definition: def });
    const v1 = await publishWorkflow(owner, id);
    expect(v1).toMatchObject({ version: 1, created: true, needsApproval: false, effects: [], approval: "not_needed", status: "draft" });
    expect(v1.contentHash).toBe(definitionHash(def));
    const again = await publishWorkflow(owner, id);
    expect(again).toMatchObject({ version: 1, created: false, versionId: v1.versionId });
    const listed = (await listWorkflows(owner)).find((w) => w.id === id)!;
    expect(listed).toMatchObject({ publishedVersion: 1, unpublishedChanges: false, triggerType: "contact.created", stepCount: 1 });
    // The database refuses to change a published version.
    await expect(withSystem((db) => db.query("update crm_workflow_versions set steps = '[]'::jsonb where id = $1", [v1.versionId]))).rejects.toThrow();
    const w = await getWorkflow(owner, id);
    expect(w.versions).toHaveLength(1);
    expect(w.versions[0]).toMatchObject({ version: 1, current: true, contentHash: v1.contentHash });
    expect(w.versions[0].definition.steps[0].key).toBe("tag");
  });

  it("needs the owner's approval of the exact version before an outside-effect workflow runs, and again after any edit", async () => {
    const owner = o.actor("owner");
    const manager = o.actor("manager");
    const mappingId = await verifiedN8nMapping(o);
    const def: WorkflowDefinition = { trigger: { type: "contact.created" }, steps: chain(step("tag", "add_tag", { tagIds: [tag] }), step("n8n", "n8n", { mappingId, includeContact: true })) };
    const { id } = await createWorkflow(manager, { name: "Hand off to n8n", definition: def });
    const v1 = await publishWorkflow(manager, id);
    expect(v1).toMatchObject({ needsApproval: true, effects: ["n8n"], approval: "needed" });
    await expect(setWorkflowStatus(manager, id, "active")).rejects.toThrow(/Version 1 messages customers or calls outside systems, so the owner must approve it/);
    await expect(startManualRun(owner, id, { contactId: await contactIn(o) })).rejects.toThrow(/Turn the workflow on/);

    const req = await requestWorkflowApproval(manager, id, v1.versionId, { activate: true });
    expect(req.status).toBe("requested");
    expect(await requestWorkflowApproval(manager, id, v1.versionId, { activate: true })).toEqual({ status: "pending", approvalId: req.approvalId });
    const approval = await one<{ kind: string; risk: string; status: string; action: Record<string, unknown>; expected_effect: string }>("select kind, risk, status, action, expected_effect from approval_requests where id = $1", [req.approvalId]);
    expect(approval).toMatchObject({ kind: "workflow_activation", risk: "high", status: "pending" });
    expect(approval.action).toMatchObject({ workflowId: id, versionId: v1.versionId, contentHash: v1.contentHash, activate: true });
    expect(approval.expected_effect).toMatch(/agency-verified n8n automation/);
    expect(await count("select count(*)::text as n from notifications where org_id = $1 and user_id = $2 and kind = 'approval_requested'", [o.org.id, o.people.owner.id])).toBeGreaterThan(0);
    await expect(setWorkflowStatus(manager, id, "active")).rejects.toThrow(/waiting for the owner's approval/);

    // Only the owner decides: a manager can't approve high-risk automation.
    await expect(decideApproval(managerCtx(o), req.approvalId!, "approve")).rejects.toThrow(/owner/);
    const decided = await decideApproval(ownerCtx(o), req.approvalId!, "approve");
    expect(decided.outcome).toMatchObject({ status: "succeeded" });
    expect(decided.outcome!.detail).toMatch(/is on/);
    const after = await getWorkflow(owner, id);
    expect(after).toMatchObject({ status: "active", approval: "approved" });
    const v = await one<{ approved_hash: string; content_hash: string; approval_id: string }>("select approved_hash, content_hash, approval_id from crm_workflow_versions where id = $1", [v1.versionId]);
    expect(v.approved_hash).toBe(v.content_hash);
    expect(v.approval_id).toBe(req.approvalId);
    // The approval stands while this version runs.
    expect((await one<{ expires_at: Date | null }>("select expires_at from approval_requests where id = $1", [req.approvalId])).expires_at).toBeNull();

    // Editing makes a new version: it needs a new approval, and the running workflow holds until then.
    const w = await getWorkflow(owner, id);
    const edited: WorkflowDefinition = { ...def, steps: chain(step("tag", "add_tag", { tagIds: [tag] }), step("n8n", "n8n", { mappingId, includeContact: false })) };
    await saveWorkflowDraft(manager, id, { definition: edited, expectedRevision: w.draftRevision });
    const v2 = await publishWorkflow(manager, id);
    expect(v2).toMatchObject({ version: 2, needsApproval: true, approval: "needed", status: "paused", pausedForApproval: true });
    await expect(setWorkflowStatus(owner, id, "active")).rejects.toThrow(/Version 2 messages customers or calls outside systems, so the owner must approve it/);
    // An approval for version 1 doesn't carry over; only the published version can be approved.
    await expect(requestWorkflowApproval(manager, id, v1.versionId)).rejects.toThrow(/Only the version that is published now/);
    const r2 = await requestWorkflowApproval(manager, id, null, { activate: false });
    await decideApproval(ownerCtx(o), r2.approvalId!, "approve");
    expect((await getWorkflow(owner, id)).status).toBe("paused");
    await setWorkflowStatus(owner, id, "active");
    expect((await getWorkflow(owner, id)).status).toBe("active");
    await setWorkflowStatus(owner, id, "archived");
  });

  it("withdraws a pending approval request when a newer version is published", async () => {
    const manager = o.actor("manager");
    const mappingId = await verifiedN8nMapping(o);
    const def = (includeContact: boolean): WorkflowDefinition => ({ trigger: { type: "manual" }, steps: [step("n8n", "n8n", { mappingId, includeContact })] });
    const { id } = await createWorkflow(manager, { name: "Superseded", definition: def(true) });
    await publishWorkflow(manager, id);
    const req = await requestWorkflowApproval(manager, id);
    const w = await getWorkflow(manager, id);
    await saveWorkflowDraft(manager, id, { definition: def(false), expectedRevision: w.draftRevision });
    await publishWorkflow(manager, id);
    expect((await one<{ status: string }>("select status from approval_requests where id = $1", [req.approvalId])).status).toBe("cancelled");
    await setWorkflowStatus(manager, id, "archived");
  });

  it("refuses to switch on a version whose references were deleted since it was published", async () => {
    const owner = o.actor("owner");
    const doomed = (await createTag(owner, { name: `Doomed ${uid()}` })).id;
    const { id } = await createWorkflow(owner, { name: "Uses a tag", definition: { trigger: { type: "contact.created" }, steps: [step("tag", "add_tag", { tagIds: [doomed] })] } });
    await publishWorkflow(owner, id);
    await withSystem((db) => db.query("delete from crm_tags where id = $1", [doomed]));
    await expect(setWorkflowStatus(owner, id, "active")).rejects.toThrow(/changed since it was published: This step uses a tag that no longer exists/);
  });

  it("refuses a value a custom field or built-in field can't hold, and lists only usable choices for the editor", async () => {
    const owner = o.actor("owner");
    const field = await withSystem(async (db) => (await db.query<{ id: string }>("insert into crm_custom_fields (org_id, entity, key, label, type) values ($1, 'contact', $2, 'Budget', 'number') returning id", [o.org.id, `budget_${uid()}`])).rows[0].id);
    const bad = await createWorkflow(owner, { name: "Bad value", definition: { trigger: { type: "contact.created" }, steps: [step("set", "update_field", { subject: "contact", field: `cf:${field}`, value: "lots" })] } });
    await expect(publishWorkflow(owner, bad.id)).rejects.toThrow(/Budget/);
    const good = await createWorkflow(owner, { name: "Good value", definition: { trigger: { type: "contact.created" }, steps: [step("set", "update_field", { subject: "contact", field: `cf:${field}`, value: 2500 })] } });
    expect((await publishWorkflow(owner, good.id)).created).toBe(true);
    const source = await createWorkflow(owner, { name: "Empty source", definition: { trigger: { type: "contact.created" }, steps: [step("set", "update_field", { subject: "contact", field: "source", value: "  " })] } });
    await expect(publishWorkflow(owner, source.id)).rejects.toThrow(/Lead source can't be empty/);
    const { getWorkflowBuilderOptions } = await import("@/server/crm/workflows/definitions");
    const options = await getWorkflowBuilderOptions(owner);
    expect(options.tags.some((t) => t.id === tag)).toBe(true);
    expect(options.users.map((u) => u.id)).toEqual(expect.arrayContaining([o.people.owner.id, o.people.sales.id]));
    expect(options.templates).toEqual([]);
    expect(options.fields.some((f) => f.id === field && f.type === "number")).toBe(true);
    await expect(getWorkflowBuilderOptions(o.actor("sales"))).rejects.toThrow(/role|permission/);
  });

  it("clones the working copy as a new draft with a new inbound URL", async () => {
    const owner = o.actor("owner");
    const def: WorkflowDefinition = { trigger: { type: "inbound_webhook", inbound: { nonce: "n".repeat(24), match: "email_or_phone", createContact: true } }, steps: [step("tag", "add_tag", { tagIds: [tag] })] };
    const { id } = await createWorkflow(owner, { name: "Inbound", definition: def });
    await publishWorkflow(owner, id);
    const copy = await cloneWorkflow(owner, id);
    const c = await getWorkflow(owner, copy.id);
    expect(c).toMatchObject({ name: "Copy of Inbound", status: "draft", publishedVersion: null, versions: [] });
    expect(c.draft.steps).toEqual(def.steps);
    expect(c.draft.trigger.inbound?.nonce).not.toBe("n".repeat(24));
    expect(copy.key).not.toBe((await getWorkflow(owner, id)).key);
  });

  it("archives (stopping live runs) and restores", async () => {
    const owner = o.actor("owner");
    const { id } = await liveWorkflow(o, { trigger: { type: "manual" }, steps: chain(step("wait", "wait", { mode: "duration", amount: 3, unit: "days" }), step("tag", "add_tag", { tagIds: [tag] })) });
    const contactId = await contactIn(o);
    const { runId } = await startManualRun(owner, id, { contactId });
    await processWorkflowRuns();
    expect((await runsOf(id))[0].status).toBe("waiting");
    const r = await setWorkflowStatus(owner, id, "archived");
    expect(r.cancelledRuns).toBe(1);
    expect((await getRun(owner, runId)).status).toBe("cancelled");
    expect((await stepsOf(runId)).map((s) => s.status)).toEqual(["cancelled"]);
    await expect(saveWorkflowDraft(owner, id, { definition: { trigger: { type: "manual" }, steps: [] }, expectedRevision: 1 })).rejects.toThrow(/archived/);
    expect((await listWorkflows(owner)).some((w) => w.id === id)).toBe(false);
    expect((await listWorkflows(owner, { status: "archived" })).some((w) => w.id === id)).toBe(true);
    await setWorkflowStatus(owner, id, "draft");
    expect((await getWorkflow(owner, id)).status).toBe("draft");
  });

  it("creates drafts from built-in templates with the workspace's own, checked choices", async () => {
    const owner = o.actor("owner");
    const list = listWorkflowTemplates();
    expect(list.map((t) => t.key)).toEqual(WORKFLOW_TEMPLATES.map((t) => t.key));
    expect(list.find((t) => t.key === "no_reply_nudge")).toMatchObject({ sendsMessages: true, trigger: "contact.tag_added", stepKinds: ["send_message", "wait", "branch", "create_task"] });
    const made = await createFromTemplate(owner, "new_lead_welcome", { inputs: { tag } });
    expect(made.issues).toEqual([]);
    const w = await getWorkflow(owner, made.id);
    expect(w.draft.steps.map((s) => s.kind)).toEqual(["add_tag", "create_task"]);
    expect((await publishWorkflow(owner, made.id)).needsApproval).toBe(false);
    await expect(createFromTemplate(owner, "new_lead_welcome", {})).rejects.toThrow(/Tag for new leads: choose one/);
    await expect(createFromTemplate(owner, "new_lead_welcome", { inputs: { tag: U() } })).rejects.toThrow(/that tag doesn't exist/);
    // A template that sends messages only takes an approved message template of this workspace.
    await expect(createFromTemplate(owner, "no_reply_nudge", { inputs: { tag, message: { templateId: U(), contentHash: "f".repeat(64), channel: "sms" } } })).rejects.toThrow(/isn't approved/);
    await expect(createFromTemplate(owner, "nope")).rejects.toThrow(/doesn't exist/);
  });
});

// ---------------------------------------------------------------------------
// The event dispatcher
// ---------------------------------------------------------------------------

describe("event dispatcher", () => {
  let o: CrmOrg;
  let tag: string;
  beforeAll(async () => {
    o = await crmOrg({ name: "Dispatch Co" });
    tag = (await createTag(o.actor("owner"), { name: `Dispatched ${uid()}` })).id;
  });

  it("starts one run per workflow version and event, even when the event is dispatched again", async () => {
    const { id } = await liveWorkflow(o, { trigger: { type: "contact.created" }, steps: [step("tag", "add_tag", { tagIds: [tag] })] });
    const contactId = await contactIn(o);
    const ev = await one<{ id: string }>("select id::text as id from crm_events where org_id = $1 and type = 'contact.created' and entity_id = $2", [o.org.id, contactId]);
    const first = await crmEventDispatch();
    expect(first.dispatched).toBeGreaterThan(0);
    expect(await one<{ dispatch_attempts: number; dispatch_error: string | null }>("select dispatch_attempts, dispatch_error from crm_events where id = $1", [ev.id])).toMatchObject({ dispatch_attempts: 1, dispatch_error: null });
    expect(await runsOf(id)).toHaveLength(1);
    // A redelivery (the event made pending again, as after a crash before it was marked) starts nothing new.
    await withSystem((db) => db.query("update crm_events set dispatched_at = null, dispatch_claimed_at = null where id = $1", [ev.id]));
    await crmEventDispatch();
    const runs = await runsOf(id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ contact_id: contactId, depth: 0 });
    expect(Number(runs[0].trigger_event_id)).toBe(Number(ev.id));
    // Two overlapping ticks never take the same event.
    await contactIn(o);
    const [a, b] = await Promise.all([crmEventDispatch(), crmEventDispatch()]);
    expect(a.claimed + b.claimed).toBe(1);
    expect(await runsOf(id)).toHaveLength(2);
    await setWorkflowStatus(o.actor("owner"), id, "archived");
  });

  it("calls subscribers in order, isolates a failing one, retries it and dead-letters after five attempts", async () => {
    const seen: string[] = [];
    const subscribers: Subscriber[] = [
      { name: "first", run: async (db, e) => { seen.push(`first:${e.id}`); await db.query("insert into crm_tags (org_id, name) values ($1, $2) on conflict do nothing", [o.org.id, `kept-${e.id}`]); } },
      { name: "broken", run: async (db) => { seen.push("broken"); await db.query("select 1/0"); } },
      { name: "last", run: async (_db, e) => { seen.push(`last:${e.id}`); } },
    ];
    // Clear the outbox of everything else first, so only this event is in play.
    await crmEventDispatch({ limit: 500 });
    const contactId = await contactIn(o);
    const ev = Number((await one<{ id: string }>("select id::text as id from crm_events where org_id = $1 and type = 'contact.created' and entity_id = $2", [o.org.id, contactId])).id);
    let t = Date.now();
    const r1 = await crmEventDispatch({ subscribers, now: new Date(t) });
    expect(r1).toMatchObject({ claimed: 1, retrying: 1, dispatched: 0 });
    expect(seen).toEqual([`first:${ev}`, "broken", `last:${ev}`]);
    // The healthy subscribers' work is kept; the error is recorded; the event waits for the next attempt.
    expect(await count("select count(*)::text as n from crm_tags where org_id = $1 and name = $2", [o.org.id, `kept-${ev}`])).toBe(1);
    const row = await one<{ dispatched_at: Date | null; dispatch_error: string }>("select dispatched_at, dispatch_error from crm_events where id = $1", [ev]);
    expect(row.dispatched_at).toBeNull();
    expect(row.dispatch_error).toMatch(/^broken: /);
    // Not retried before its claim goes stale.
    expect((await crmEventDispatch({ subscribers, now: new Date(t + 60_000) })).claimed).toBe(0);
    let dead = 0;
    for (let i = 2; i <= DISPATCH_MAX_ATTEMPTS; i++) {
      t += 6 * 60_000;
      dead += (await crmEventDispatch({ subscribers, now: new Date(t) })).dead;
    }
    expect(dead).toBe(1);
    const final = await one<{ dispatched_at: Date | null; dispatch_error: string; dispatch_attempts: number }>("select dispatched_at, dispatch_error, dispatch_attempts from crm_events where id = $1", [ev]);
    expect(final.dispatched_at).not.toBeNull();
    expect(final.dispatch_attempts).toBe(DISPATCH_MAX_ATTEMPTS);
    expect(final.dispatch_error).toMatch(/^Gave up after 5 attempts: broken/);
    expect(await count("select count(*)::text as n from crm_tags where org_id = $1 and name = $2", [o.org.id, `kept-${ev}`])).toBe(1);
  });

  it("dead-letters an event abandoned on its last attempt", async () => {
    await crmEventDispatch({ limit: 500 });
    const contactId = await contactIn(o);
    const ev = Number((await one<{ id: string }>("select id::text as id from crm_events where org_id = $1 and type = 'contact.created' and entity_id = $2", [o.org.id, contactId])).id);
    await withSystem((db) => db.query("update crm_events set dispatch_attempts = $2, dispatch_claimed_at = now() - interval '10 minutes' where id = $1", [ev, DISPATCH_MAX_ATTEMPTS]));
    await crmEventDispatch();
    const row = await one<{ dispatched_at: Date | null; dispatch_error: string }>("select dispatched_at, dispatch_error from crm_events where id = $1", [ev]);
    expect(row.dispatched_at).not.toBeNull();
    expect(row.dispatch_error).toMatch(/Gave up after 5 attempts/);
  });

  it("respects the hourly run limit, recording runs it didn't start and telling owners and managers once", async () => {
    const { id } = await liveWorkflow(o, { trigger: { type: "contact.created" }, steps: [step("tag", "add_tag", { tagIds: [tag] })] }, { hourlyRunLimit: 2, name: "Limited" });
    for (let i = 0; i < 4; i++) await contactIn(o);
    await crmEventDispatch();
    const runs = await runsOf(id);
    expect(runs).toHaveLength(4);
    expect(runs.filter((r) => r.status === "queued")).toHaveLength(2);
    const limited = runs.filter((r) => r.context.outcome === "rate_limited");
    expect(limited).toHaveLength(2);
    expect(limited[0]).toMatchObject({ status: "cancelled" });
    expect(limited[0].last_error).toMatch(/limit of 2 runs an hour/);
    expect(await count("select count(*)::text as n from notifications where org_id = $1 and user_id = $2 and kind = 'crm_workflow_failed'", [o.org.id, o.people.manager.id])).toBe(1);
    await setWorkflowStatus(o.actor("owner"), id, "archived");
  });

  it("applies trigger filters and the contact filter when the event is dispatched", async () => {
    const owner = o.actor("owner");
    const vip = (await createTag(owner, { name: `VIP ${uid()}` })).id;
    const other = (await createTag(owner, { name: `Other ${uid()}` })).id;
    const done = await createTag(owner, { name: `Done ${uid()}` });
    const { id } = await liveWorkflow(o, {
      trigger: { type: "contact.tag_added", filters: { tagIds: [vip] }, contactFilter: { op: "and", conditions: [{ field: "lead_status", op: "in", value: ["new"] }] } },
      steps: [step("tag", "add_tag", { tagIds: [done.id] })],
    });
    const a = await contactIn(o, { tagIds: [vip] });
    await contactIn(o, { tagIds: [other] });
    await contactIn(o, { tagIds: [vip], leadStatus: "qualified" });
    await settle();
    const runs = await runsOf(id);
    expect(runs.map((r) => r.contact_id)).toEqual([a]);
    expect(runs[0].status).toBe("completed");
    expect(await tagsOf(a)).toContain(done.name);
    await setWorkflowStatus(owner, id, "archived");
  });

  it("is registered in the scheduler before the message dispatcher, with the runner right after it", () => {
    const names = JOBS.map((j) => j.name);
    expect(names.indexOf("crmEventDispatch")).toBeGreaterThan(-1);
    expect(names.indexOf("crmEventDispatch")).toBeLessThan(names.indexOf("messagesDispatched"));
    expect(names.indexOf("crmWorkflowRuns")).toBe(names.indexOf("crmEventDispatch") + 1);
    expect(names.indexOf("crmWorkflowRuns")).toBeLessThan(names.indexOf("messagesDispatched"));
    for (const job of ["expiredReservations", "followUpsPrepared", "appointmentReminders", "retentionPrograms", "crmImports", "crmTaskReminders", "whatsappTemplateSync", "crmWebhookDeliveries"]) expect(names).toContain(job);
  });
});

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

describe("runner: step kinds, branches and waits", () => {
  let o: CrmOrg;
  let pipelineId: string;
  let stages: Array<{ id: string; kind: string }>;
  beforeAll(async () => {
    o = await crmOrg({ name: "Runner Co" });
    const p = (await listPipelines(o.actor("owner"), { ensureDefault: true }))[0];
    pipelineId = p.id;
    stages = p.stages.map((s) => ({ id: s.id, kind: s.kind }));
  });

  it("carries out every internal step kind through the CRM services, as the workflow, with the loop depth carried", async () => {
    const owner = o.actor("owner");
    const t1 = await createTag(owner, { name: `Welcomed ${uid()}` });
    const t2 = await createTag(owner, { name: `Cold ${uid()}` });
    const { id } = await liveWorkflow(o, {
      trigger: { type: "contact.created" },
      steps: chain(
        step("tag", "add_tag", { tagIds: [t1.id] }),
        step("untag", "remove_tag", { tagIds: [t2.id] }),
        step("owner", "assign", { subject: "contact", to: "user", userId: o.people.sales.id, onlyIfUnassigned: true }),
        step("status", "update_field", { subject: "contact", field: "lead_status", value: "contacted" }),
        step("score", "update_field", { subject: "contact", field: "lead_score", value: 42 }),
        step("task", "create_task", { title: "Call {{contact.first_name}}", priority: "high", dueIn: { amount: 1, unit: "days" }, assignee: "contact_owner" }),
        step("deal", "create_opportunity", { name: "{{contact.full_name}} deal", pipelineId, stageId: stages[0].id, value: 500, ownerFromContact: true, skipIfOpenInPipeline: true }),
        step("move", "move_stage", { pipelineId, stageId: stages[1].id }),
        step("value", "update_field", { subject: "opportunity", field: "value", value: 750 }),
        step("note", "internal_note", { subject: "contact", body: "Welcomed by automation" }),
        step("dealnote", "internal_note", { subject: "opportunity", body: "Deal created for {{contact.first_name}}" }),
        step("notify", "notify_team", { roles: ["owner"], title: "New lead {{contact.first_name}}" }),
        step("end", "end", {}),
      ),
    });
    const contactId = (await createContact(owner, { firstName: "Rosa", lastName: "Diaz", tagIds: [t2.id] })).id;
    await settle();
    const [run] = await runsOf(id);
    expect(run).toMatchObject({ status: "completed", contact_id: contactId, current_step: null });
    const steps = await stepsOf(run.id);
    expect(steps.map((s) => `${s.step_key}:${s.status}`)).toEqual(["tag", "untag", "owner", "status", "score", "task", "deal", "move", "value", "note", "dealnote", "notify", "end"].map((k) => `${k}:completed`));

    expect(await tagsOf(contactId)).toEqual([t1.name]);
    const c = await one<{ assigned_user_id: string; lead_status: string; lead_score: number }>("select assigned_user_id, lead_status, lead_score from contacts where id = $1", [contactId]);
    expect(c).toMatchObject({ assigned_user_id: o.people.sales.id, lead_status: "contacted", lead_score: 42 });
    const task = await one<{ title: string; assigned_user_id: string; source: string; priority: string }>("select title, assigned_user_id, source, priority from tasks where contact_id = $1", [contactId]);
    expect(task).toMatchObject({ title: "Call Rosa", assigned_user_id: o.people.sales.id, source: "workflow", priority: "high" });
    const deal = await one<{ id: string; name: string; stage_ref: string; monetary_value: string; assigned_user_id: string }>("select id, name, stage_ref, monetary_value::text, assigned_user_id from crm_opportunities where contact_id = $1", [contactId]);
    expect(deal).toMatchObject({ name: "Rosa Diaz deal", stage_ref: stages[1].id, assigned_user_id: o.people.sales.id });
    expect(Number(deal.monetary_value)).toBe(750);
    expect((await getRun(owner, run.id)).opportunity?.id).toBe(deal.id);
    expect(await count("select count(*)::text as n from record_notes where record_id = any($1::text[])", [[contactId, deal.id]])).toBe(2);
    expect(await count("select count(*)::text as n from notifications where user_id = $1 and title = 'New lead Rosa'", [o.people.owner.id])).toBe(1);

    // Every change records an event one level deeper than the one that started the run, as the workflow.
    const events = await withSystem((db) => db.query<{ type: string; depth: number; actor_kind: string; causation_event_id: string | null }>(
      "select type, depth, actor_kind, causation_event_id from crm_events where org_id = $1 and contact_id = $2 and type <> 'contact.created' order by id", [o.org.id, contactId]));
    expect(events.rows.filter((e) => e.actor_kind === "workflow").map((e) => e.type)).toEqual(expect.arrayContaining(["contact.tag_added", "contact.tag_removed", "contact.assigned", "task.created", "opportunity.created", "opportunity.stage_changed", "note.added"]));
    for (const e of events.rows.filter((x) => x.actor_kind === "workflow")) {
      expect(e.depth).toBe(1);
      expect(Number(e.causation_event_id)).toBe(Number(run.trigger_event_id));
    }
    const activity = await one<{ n: string }>("select count(*)::text as n from crm_activities where contact_id = $1 and actor_kind = 'system'", [contactId]);
    expect(Number(activity.n)).toBeGreaterThan(3);
    await setWorkflowStatus(owner, id, "archived");
  });

  it("assigns through an assignment rule", async () => {
    const r = await crmOrg({ name: "Rule Runner" });
    const rule = await createAssignmentRule(r.actor("owner"), { name: "Round robin", entity: "contact", strategy: "round_robin", members: [{ userId: r.people.setter.id }], active: true });
    const { id } = await liveWorkflow(r, { trigger: { type: "manual" }, steps: [step("route", "assign", { subject: "contact", to: "rule", ruleId: rule.id, onlyIfUnassigned: true })] });
    const contactId = (await createContact(r.actor("owner"), { firstName: "Routed", lastName: uid() })).id;
    const { runId } = await startManualRun(r.actor("owner"), id, { contactId });
    await processWorkflowRuns();
    expect((await stepsOf(runId))[0]).toMatchObject({ status: "completed" });
    expect((await stepsOf(runId))[0].result).toMatchObject({ outcome: "assigned", userId: r.people.setter.id, ruleId: rule.id });
    expect((await one<{ assigned_user_id: string }>("select assigned_user_id from contacts where id = $1", [contactId])).assigned_user_id).toBe(r.people.setter.id);
  });

  it("follows the Yes or No path of a condition on the contact or the deal", async () => {
    const owner = o.actor("owner");
    const vip = await createTag(owner, { name: `VIP ${uid()}` });
    const yes = await createTag(owner, { name: `Yes ${uid()}` });
    const no = await createTag(owner, { name: `No ${uid()}` });
    const { id } = await liveWorkflow(o, {
      trigger: { type: "manual" },
      steps: [
        step("check", "branch", { subject: "contact", filter: { op: "and", conditions: [{ field: "tags", op: "has_any", value: [vip.id] }] } }, null, { branches: { yes: "yes", no: "no" } }),
        step("yes", "add_tag", { tagIds: [yes.id] }),
        step("no", "add_tag", { tagIds: [no.id] }),
      ],
    });
    const a = await contactIn(o, { tagIds: [vip.id] });
    const b = await contactIn(o);
    const ra = await startManualRun(owner, id, { contactId: a });
    const rb = await startManualRun(owner, id, { contactId: b });
    await processWorkflowRuns();
    expect(await tagsOf(a)).toEqual([vip.name, yes.name].sort());
    expect(await tagsOf(b)).toEqual([no.name]);
    expect((await stepsOf(ra.runId))[0].result).toMatchObject({ matched: true, path: "yes" });
    expect((await stepsOf(rb.runId))[0].result).toMatchObject({ matched: false, path: "no" });

    // On the deal: its value decides.
    const big = await createTag(owner, { name: `Big ${uid()}` });
    const deals = await liveWorkflow(o, {
      trigger: { type: "opportunity.created", filters: { pipelineId } },
      steps: [
        step("size", "branch", { subject: "opportunity", filter: { op: "and", conditions: [{ field: "value", op: "gt", value: 1000 }] } }, null, { branches: { yes: "big" } }),
        step("big", "add_tag", { tagIds: [big.id] }),
      ],
    });
    const c1 = await contactIn(o);
    const c2 = await contactIn(o);
    await createOpportunity(owner, { name: "Large", pipelineId, contactId: c1, value: 5000 });
    await createOpportunity(owner, { name: "Small", pipelineId, contactId: c2, value: 10 });
    await settle();
    expect(await tagsOf(c1)).toEqual([big.name]);
    expect(await tagsOf(c2)).toEqual([]);
    const runs = await runsOf(deals.id);
    expect(runs.map((r) => r.status)).toEqual(["completed", "completed"]);
    await setWorkflowStatus(owner, id, "archived");
    await setWorkflowStatus(owner, deals.id, "archived");
  });

  it("waits for a duration, wakes up when due, and ends early when a date to wait for is missing", async () => {
    const owner = o.actor("owner");
    const done = await createTag(owner, { name: `Waited ${uid()}` });
    const { id } = await liveWorkflow(o, { trigger: { type: "manual" }, steps: chain(step("wait", "wait", { mode: "duration", amount: 2, unit: "days" }), step("tag", "add_tag", { tagIds: [done.id] })) });
    const contactId = await contactIn(o);
    const t0 = Date.now() + 1000;
    const { runId } = await startManualRun(owner, id, { contactId });
    await processWorkflowRuns({ now: new Date(t0) });
    let run = (await runsOf(id))[0];
    expect(run.status).toBe("waiting");
    expect(new Date(run.next_run_at).getTime()).toBe(t0 + 2 * 86_400_000);
    expect((await getRun(owner, runId)).waitingUntil).toBe(new Date(t0 + 2 * 86_400_000).toISOString());
    await processWorkflowRuns({ now: new Date(t0 + 86_400_000) });
    expect((await runsOf(id))[0].status).toBe("waiting");
    expect(await tagsOf(contactId)).toEqual([]);
    await processWorkflowRuns({ now: new Date(t0 + 2 * 86_400_000 + 60_000) });
    run = (await runsOf(id))[0];
    expect(run.status).toBe("completed");
    expect(await tagsOf(contactId)).toEqual([done.name]);
    expect((await stepsOf(runId)).map((s) => `${s.step_key}:${s.status}`)).toEqual(["wait:completed", "tag:completed"]);

    const field = await withSystem(async (db) => (await db.query<{ id: string }>("insert into crm_custom_fields (org_id, entity, key, label, type) values ($1, 'contact', $2, 'Renewal', 'date') returning id", [o.org.id, `renewal_${uid()}`])).rows[0].id);
    const missing = await liveWorkflow(o, {
      trigger: { type: "manual" },
      steps: chain(step("until", "wait", { mode: "until_date", source: "contact_field", fieldId: field, offset: { amount: 1, unit: "days", direction: "before" }, ifMissing: "end" }), step("tag", "add_tag", { tagIds: [done.id] })),
    });
    const other = await contactIn(o);
    const r2 = await startManualRun(owner, missing.id, { contactId: other });
    await processWorkflowRuns();
    expect((await runsOf(missing.id))[0].status).toBe("completed");
    expect((await stepsOf(r2.runId)).map((s) => s.result.outcome)).toEqual(["date_missing"]);
    expect(await tagsOf(other)).toEqual([]);
    await setWorkflowStatus(owner, id, "archived");
    await setWorkflowStatus(owner, missing.id, "archived");
  });

  it("checks whether the contact replied since the run started (no response)", async () => {
    const owner = o.actor("owner");
    const { id } = await liveWorkflow(o, {
      trigger: { type: "manual" },
      steps: [
        step("wait", "wait", { mode: "duration", amount: 1, unit: "hours" }, "replied"),
        step("replied", "branch", { subject: "contact", filter: { op: "and", conditions: [] }, reply: "not_replied" }, null, { branches: { yes: "call" } }),
        step("call", "create_task", { title: "No reply from {{contact.first_name}}", priority: "normal", assignee: "none" }),
      ],
    });
    const quiet = await contactIn(o, { firstName: "Quiet", phone: "+15550101001" });
    const chatty = await contactIn(o, { firstName: "Chatty", phone: "+15550101002" });
    const t0 = Date.now() + 1000;
    await startManualRun(owner, id, { contactId: quiet });
    await startManualRun(owner, id, { contactId: chatty });
    await processWorkflowRuns({ now: new Date(t0) });
    const reply = await inbound(o.org.id, { address: "+15550101002", body: "Yes please call me tomorrow" });
    expect(reply.contactId).toBe(chatty);
    await processWorkflowRuns({ now: new Date(t0 + 2 * 3_600_000) });
    expect(await count("select count(*)::text as n from tasks where contact_id = $1 and title = 'No reply from Quiet'", [quiet])).toBe(1);
    expect(await count("select count(*)::text as n from tasks where contact_id = $1", [chatty])).toBe(0);
    await setWorkflowStatus(owner, id, "archived");
  });
});

describe("runner: approvals, pauses, loops, retries and dead runs", () => {
  let o: CrmOrg;
  let tag: { id: string; name: string };
  beforeAll(async () => {
    o = await crmOrg({ name: "Runner Safety Co" });
    tag = await createTag(o.actor("owner"), { name: `Safe ${uid()}` });
  });

  it("asks a person before a step marked 'ask first', and stops the run when they reject it", async () => {
    const owner = o.actor("owner");
    const { id } = await liveWorkflow(o, { trigger: { type: "manual" }, steps: [step("tag", "add_tag", { tagIds: [tag.id] }, null, { requireApproval: true })] });
    const a = await contactIn(o);
    const b = await contactIn(o);
    const ra = await startManualRun(owner, id, { contactId: a });
    const rb = await startManualRun(owner, id, { contactId: b });
    await processWorkflowRuns();
    const runA = await getRun(owner, ra.runId);
    expect(runA.status).toBe("awaiting_approval");
    expect(await tagsOf(a)).toEqual([]);
    const approvalA = runA.approvalId!;
    expect(await one<{ kind: string; risk: string }>("select kind, risk from approval_requests where id = $1", [approvalA])).toMatchObject({ kind: "workflow_action", risk: "medium" });
    // Deciding only marks the step approved; the scheduler runs it.
    const decided = await decideApproval(managerCtx(o), approvalA, "approve");
    expect(decided.outcome).toMatchObject({ status: "succeeded" });
    expect(await tagsOf(a)).toEqual([]);
    expect((await getRun(owner, ra.runId)).status).toBe("queued");
    await processWorkflowRuns();
    expect(await tagsOf(a)).toEqual([tag.name]);
    const stepsA = await stepsOf(ra.runId);
    expect(stepsA).toHaveLength(1);
    expect(stepsA[0]).toMatchObject({ status: "completed", approval_id: approvalA });

    const approvalB = (await getRun(owner, rb.runId)).approvalId!;
    await decideApproval(managerCtx(o), approvalB, "reject", "Not this one");
    expect((await getRun(owner, rb.runId)).status).toBe("cancelled");
    expect((await stepsOf(rb.runId))[0]).toMatchObject({ status: "cancelled" });
    await processWorkflowRuns();
    expect(await tagsOf(b)).toEqual([]);

    // Nobody decided in time: the request expires and the housekeeping pass stops the run.
    const c = await contactIn(o);
    const rc = await startManualRun(owner, id, { contactId: c });
    await processWorkflowRuns();
    const approvalC = (await getRun(owner, rc.runId)).approvalId!;
    await withSystem((db) => db.query("update approval_requests set expires_at = now() - interval '1 minute' where id = $1", [approvalC]));
    expect((await recoverAbandonedRuns()).lapsed).toBe(1);
    expect(await getRun(owner, rc.runId)).toMatchObject({ status: "cancelled", lastError: expect.stringMatching(/wasn't given in time/) });
    await processWorkflowRuns();
    expect(await tagsOf(c)).toEqual([]);
    await setWorkflowStatus(owner, id, "archived");
  });

  it("holds runs while the workspace's workflows (or iAcquire's agency switch) are paused, and continues afterwards", async () => {
    const owner = o.actor("owner");
    const { id } = await liveWorkflow(o, { trigger: { type: "manual" }, steps: [step("tag", "add_tag", { tagIds: [tag.id] })] });
    const contactId = await contactIn(o);
    await withSystem((db) => db.query("insert into automation_pauses (org_id, scope, active, reason, set_at) values ($1, 'workflows', true, 'Reviewing automations', now()) on conflict (org_id, scope) do update set active = true", [o.org.id]));
    expect(await withSystem((db) => checkOrgAutomation(db, o.org.id, "workflows"))).toMatchObject({ allowed: false, reason: "workflows_paused" });
    expect(await withSystem((db) => checkOrgAutomation(db, o.org.id, "outbound"))).toEqual({ allowed: true });
    const t0 = Date.now() + 1000;
    const { runId } = await startManualRun(owner, id, { contactId });
    await processWorkflowRuns({ now: new Date(t0) });
    let run = await getRun(owner, runId);
    expect(run.status).toBe("queued");
    expect(run.lastError).toMatch(/On hold: Workflows are paused/);
    expect(await tagsOf(contactId)).toEqual([]);
    expect((await getWorkflow(owner, id)).pausedReason).toMatch(/Workflows are paused/);
    // Still paused when it comes due again: still held, nothing done.
    await processWorkflowRuns({ now: new Date(t0 + 16 * 60_000) });
    expect(await tagsOf(contactId)).toEqual([]);
    await withSystem((db) => db.query("update automation_pauses set active = false where org_id = $1 and scope = 'workflows'", [o.org.id]));
    await processWorkflowRuns({ now: new Date(t0 + 40 * 60_000) });
    run = await getRun(owner, runId);
    expect(run.status).toBe("completed");
    expect(await tagsOf(contactId)).toEqual([tag.name]);

    // The agency switch stops every workspace's workflows.
    const agency = await withSystem(async (db) => (await db.query<{ id: string }>("insert into organizations (name, slug, kind, status) values ('Agency', $1, 'agency', 'active') returning id", [`agency-${uid()}`])).rows[0].id);
    await withSystem((db) => db.query("insert into automation_pauses (org_id, scope, active, set_at) values ($1, 'agency', true, now())", [agency]));
    try {
      expect(await withSystem((db) => checkOrgAutomation(db, o.org.id, "workflows"))).toMatchObject({ allowed: false, reason: "agency_paused" });
    } finally {
      await withSystem((db) => db.query("update automation_pauses set active = false where org_id = $1", [agency]));
    }
    // A workflow switched off holds its waiting runs; they continue when it is switched back on.
    await withSystem((db) => db.query("update organizations set status = 'suspended' where id = $1", [o.org.id]));
    expect(await withSystem((db) => checkOrgAutomation(db, o.org.id, "workflows"))).toMatchObject({ allowed: false, reason: "org_inactive" });
    await withSystem((db) => db.query("update organizations set status = 'active' where id = $1", [o.org.id]));
    await setWorkflowStatus(owner, id, "archived");
  });

  it("stops a workflow that keeps re-triggering itself at the loop limit, without making the change", async () => {
    const owner = o.actor("owner");
    const loop = await createTag(owner, { name: `Loop ${uid()}` });
    const { id } = await liveWorkflow(o, {
      trigger: { type: "contact.tag_added", filters: { tagIds: [loop.id] } },
      steps: chain(step("off", "remove_tag", { tagIds: [loop.id] }), step("on", "add_tag", { tagIds: [loop.id] })),
    });
    const contactId = await contactIn(o);
    const { tagContacts } = await import("@/server/crm/tags");
    await tagContacts(owner, { contactIds: [contactId], addTagIds: [loop.id] });
    await settle();
    const runs = await runsOf(id);
    expect(runs.map((r) => r.depth)).toEqual(Array.from({ length: MAX_EVENT_DEPTH + 1 }, (_, i) => i));
    expect(runs.slice(0, -1).every((r) => r.status === "completed")).toBe(true);
    const last = runs[runs.length - 1];
    expect(last).toMatchObject({ status: "failed", depth: MAX_EVENT_DEPTH });
    expect(last.context.outcome).toBe("loop_limit");
    expect(last.last_error).toMatch(/looks like a loop/);
    expect((await stepsOf(last.id))[0]).toMatchObject({ step_key: "off", status: "skipped" });
    // The last run changed nothing: the tag is still on, and nothing deeper than the limit was recorded.
    expect(await tagsOf(contactId)).toEqual([loop.name]);
    expect(await count("select count(*)::text as n from crm_events where org_id = $1 and depth > $2", [o.org.id, MAX_EVENT_DEPTH])).toBe(0);
    expect(await count("select count(*)::text as n from notifications where org_id = $1 and user_id = $2 and kind = 'crm_workflow_failed'", [o.org.id, o.people.owner.id])).toBeGreaterThan(0);
    await expect(retryRunStep(owner, last.id)).rejects.toThrow(/loop limit/);
    await setWorkflowStatus(owner, id, "archived");
  });

  it("never repeats an outside effect when a later step is retried", async () => {
    const owner = o.actor("owner");
    const hook = await webhookSubscription(o);
    const mappingId = await verifiedN8nMapping(o);
    const helper = await createUser({ name: "Temp Helper" });
    await addMember(o.org.id, helper.id, "sales_rep");
    const { id } = await liveWorkflow(o, {
      trigger: { type: "manual" },
      steps: chain(
        step("hook", "webhook", { subscriptionId: hook, includeContact: true }),
        step("n8n", "n8n", { mappingId, includeContact: false }),
        step("task", "create_task", { title: "Follow up", priority: "normal", assignee: "user", userId: helper.id }),
      ),
    });
    await ownerApproves(o, id);
    // The person the task is for leaves before the run gets there.
    await withSystem((db) => db.query("update organization_memberships set status = 'revoked' where org_id = $1 and user_id = $2", [o.org.id, helper.id]));
    const contactId = await contactIn(o);
    const { runId } = await startManualRun(owner, id, { contactId });
    await processWorkflowRuns();
    let run = await getRun(owner, runId);
    expect(run.status).toBe("failed");
    expect(run.currentStep?.key).toBe("task");
    expect(run.lastError).toMatch(/no longer in the workspace/);
    expect(run.canRetry).toBe(true);
    expect(webhookMock).toHaveBeenCalledTimes(1);
    expect(n8nMock).toHaveBeenCalledTimes(1);
    expect(n8nMock.mock.calls[0][0]).toMatchObject({ orgId: o.org.id, mappingId, idempotencyKey: `wf:${runId}:n8n` });
    expect(webhookMock.mock.calls[0][1]).toMatchObject({ subscriptionId: hook, idempotencyKey: `wf:${runId}:hook` });
    expect(await count("select count(*)::text as n from crm_webhook_deliveries where subscription_id = $1", [hook])).toBe(1);

    await withSystem((db) => db.query("update organization_memberships set status = 'active' where org_id = $1 and user_id = $2", [o.org.id, helper.id]));
    await retryRunStep(owner, runId, "task");
    await processWorkflowRuns();
    run = await getRun(owner, runId);
    expect(run.status).toBe("completed");
    expect(webhookMock).toHaveBeenCalledTimes(1);
    expect(n8nMock).toHaveBeenCalledTimes(1);
    expect(await count("select count(*)::text as n from tasks where contact_id = $1", [contactId])).toBe(1);
    const steps = await stepsOf(runId);
    expect(steps.map((s) => `${s.step_key}#${s.attempt}:${s.status}`)).toEqual(["hook#1:completed", "n8n#1:completed", "task#1:failed", "task#2:completed"]);
    // Even called again with the step's key, the webhook queue adds nothing: the key is the step's, not the attempt's.
    const again = await withSystem((db) => enqueueWorkflowWebhook(db, { orgId: o.org.id, subscriptionId: hook, payload: { x: 1 }, idempotencyKey: `wf:${runId}:hook` }));
    expect(again.status).toBe("duplicate");
    expect(await count("select count(*)::text as n from crm_webhook_deliveries where subscription_id = $1", [hook])).toBe(1);
    await setWorkflowStatus(owner, id, "archived");
  });

  it("never blindly repeats an n8n call whose outcome is unknown", async () => {
    const owner = o.actor("owner");
    const mappingId = await verifiedN8nMapping(o);
    const { id } = await liveWorkflow(o, { trigger: { type: "manual" }, steps: chain(step("n8n", "n8n", { mappingId, includeContact: true }), step("tag", "add_tag", { tagIds: [tag.id] })) });
    await ownerApproves(o, id);
    const contactId = await contactIn(o);
    n8nMock.mockResolvedValueOnce({ status: "unknown", retryable: false, detail: "n8n answered HTTP 502; the workflow may have started.", httpStatus: 502 });
    const { runId } = await startManualRun(owner, id, { contactId });
    await processWorkflowRuns();
    let run = await getRun(owner, runId);
    expect(run.status).toBe("failed");
    expect(run.lastError).toMatch(/couldn't confirm whether n8n ran/);
    expect(await tagsOf(contactId)).toEqual([]);
    expect(n8nMock).toHaveBeenCalledTimes(1);
    // Retrying would send the same idempotency key, which E's ledger only ever answers "unknown" again, so it isn't offered or allowed:
    // a person checks n8n and skips the step.
    expect(run).toMatchObject({ outcome: "external_unknown", canRetry: false, canSkip: true });
    await expect(retryRunStep(owner, runId)).rejects.toThrow(/skip this step/);
    await skipRunStep(owner, runId);
    await processWorkflowRuns();
    run = await getRun(owner, runId);
    expect(run.status).toBe("completed");
    expect(n8nMock).toHaveBeenCalledTimes(1);

    // A worker that stopped mid-call leaves the step "running": the next worker marks it unknown and calls nothing.
    const r2 = await startManualRun(owner, id, { contactId: await contactIn(o) });
    await withSystem(async (db) => {
      const s = await db.query<{ id: string }>(
        "insert into crm_workflow_run_steps (org_id, run_id, step_key, kind, attempt, status, idempotency_key) values ($1, $2, 'n8n', 'n8n', 1, 'running', $3) returning id",
        [o.org.id, r2.runId, `wf:${r2.runId}:n8n#1`],
      );
      await db.query(
        "update crm_workflow_runs set status = 'running', claimed_at = now() - interval '5 minutes', context = context || jsonb_build_object('inflight', jsonb_build_object('key', 'n8n', 'rowId', $2::bigint)) where id = $1",
        [r2.runId, s.rows[0].id],
      );
    });
    n8nMock.mockClear();
    // The ordinary pass doesn't take a run another worker holds; the recovery pass gives back abandoned ones.
    await processWorkflowRuns();
    expect((await getRun(owner, r2.runId)).status).toBe("running");
    expect(await recoverAbandonedRuns()).toMatchObject({ recovered: 1 });
    await processWorkflowRuns();
    const crashed = await getRun(owner, r2.runId);
    expect(crashed.status).toBe("failed");
    expect(crashed.lastError).toMatch(/isn't sent again/);
    expect(crashed).toMatchObject({ outcome: "external_unknown", canRetry: false, canSkip: true });
    expect(n8nMock).not.toHaveBeenCalled();
    expect((await stepsOf(r2.runId))[0]).toMatchObject({ status: "failed", result: { outcome: "unknown" } });
    await setWorkflowStatus(owner, id, "archived");
  });

  it("retries a failing step with backoff, then gives the run up and tells owners and managers once an hour", async () => {
    const owner = o.actor("owner");
    const hook = await webhookSubscription(o, "Flaky");
    const actual = await vi.importActual<typeof import("@/server/crm/webhooks")>("@/server/crm/webhooks");
    webhookMock.mockImplementation(async (db, input) => {
      if (input.subscriptionId === hook) throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
      return actual.enqueueWorkflowWebhook(db, input);
    });
    try {
      const { id } = await liveWorkflow(o, { trigger: { type: "manual" }, steps: [step("hook", "webhook", { subscriptionId: hook, includeContact: false })] }, { name: "Flaky hook" });
      await ownerApproves(o, id);
      const before = await count("select count(*)::text as n from notifications where org_id = $1 and kind = 'crm_workflow_failed' and user_id = $2", [o.org.id, o.people.manager.id]);
      const runA = await startManualRun(owner, id, { contactId: await contactIn(o) });
      const runB = await startManualRun(owner, id, { contactId: await contactIn(o) });
      let t = Date.now() + 1000;
      const delays: number[] = [];
      for (let i = 0; i < WORKFLOW_LIMITS.maxAttempts; i++) {
        await processWorkflowRuns({ now: new Date(t) });
        const r = (await runsOf(id)).find((x) => x.id === runA.runId)!;
        if (r.status === "queued") delays.push(Math.round((new Date(r.next_run_at).getTime() - t) / 60_000));
        t += 20 * 60_000;
      }
      expect(delays).toEqual([1, 2, 4, 8]);
      const a = await getRun(owner, runA.runId);
      expect(a.status).toBe("dead");
      expect(a.attempts).toBe(WORKFLOW_LIMITS.maxAttempts);
      expect(a.lastError).toMatch(/failed 5 times and was given up/);
      expect((await stepsOf(runA.runId)).map((s) => s.status)).toEqual(Array(5).fill("failed"));
      expect((await getRun(owner, runB.runId)).status).toBe("dead");
      // Two dead runs of the same workflow in the same hour: one notification each for owners and managers.
      const after = await count("select count(*)::text as n from notifications where org_id = $1 and kind = 'crm_workflow_failed' and user_id = $2", [o.org.id, o.people.manager.id]);
      expect(after - before).toBe(1);
      expect((await listRuns(owner, { workflowId: id, status: "problems" })).items).toHaveLength(2);
      await setWorkflowStatus(owner, id, "archived");
    } finally {
      webhookMock.mockImplementation(actual.enqueueWorkflowWebhook);
    }
  });

  it("asks the client's own AI employee through the scoped path, and says honestly when nothing could be asked", async () => {
    const owner = o.actor("owner");
    const { id } = await liveWorkflow(o, { trigger: { type: "manual" }, steps: chain(step("ask", "ai_task", { roleKey: "crm_manager", instruction: "Research this lead and add a short note." }), step("tag", "add_tag", { tagIds: [tag.id] })) });
    await ownerApproves(o, id);
    const contactId = await contactIn(o);
    const { runId } = await startManualRun(owner, id, { contactId });
    await processWorkflowRuns();
    expect(agentTaskMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ orgId: o.org.id, roleKey: "crm_manager", contactId, runId, stepKey: "ask" }));
    const [ask] = await stepsOf(runId);
    // Live employee runs are switched off in this environment, so it was blocked, and the run went on.
    expect(ask).toMatchObject({ status: "skipped", result: { outcome: "blocked" } });
    expect((await getRun(owner, runId)).status).toBe("completed");
    agentTaskMock.mockResolvedValueOnce({ status: "queued", detail: "Queued for CRM Manager.", agentRunId: U() });
    const r2 = await startManualRun(owner, id, { contactId: await contactIn(o) });
    await processWorkflowRuns();
    expect((await stepsOf(r2.runId))[0]).toMatchObject({ status: "completed", result: { status: "queued" } });
    await setWorkflowStatus(owner, id, "archived");
  });

  it("test runs report what each step would do and change nothing", async () => {
    const owner = o.actor("owner");
    const hook = await webhookSubscription(o, "Test only");
    const mappingId = await verifiedN8nMapping(o);
    const vip = await createTag(owner, { name: `TestVip ${uid()}` });
    const def: WorkflowDefinition = {
      trigger: { type: "contact.created" },
      steps: [
        step("check", "branch", { subject: "contact", filter: { op: "and", conditions: [{ field: "tags", op: "has_any", value: [vip.id] }] } }, null, { branches: { yes: "tag", no: "end" } }),
        step("tag", "add_tag", { tagIds: [tag.id] }, "task"),
        step("task", "create_task", { title: "Call {{contact.first_name}}", priority: "high", assignee: "none" }, "hook"),
        step("hook", "webhook", { subscriptionId: hook, includeContact: true }, "n8n"),
        step("n8n", "n8n", { mappingId, includeContact: true }, "wait"),
        step("wait", "wait", { mode: "duration", amount: 1, unit: "days" }, "end"),
        step("end", "end", {}),
      ],
    };
    const { id } = await createWorkflow(owner, { name: "Dry", definition: def });
    await publishWorkflow(owner, id);
    const contactId = await contactIn(o, { firstName: "Tess", tagIds: [vip.id] });
    await crmEventDispatch({ limit: 500 });
    const snapshot = async () => ({
      tags: await count("select count(*)::text as n from crm_contact_tags where contact_id = $1", [contactId]),
      tasks: await count("select count(*)::text as n from tasks where org_id = $1", [o.org.id]),
      events: await count("select count(*)::text as n from crm_events where org_id = $1", [o.org.id]),
      approvals: await count("select count(*)::text as n from approval_requests where org_id = $1", [o.org.id]),
      deliveries: await count("select count(*)::text as n from crm_webhook_deliveries where org_id = $1", [o.org.id]),
      notifications: await count("select count(*)::text as n from notifications where org_id = $1", [o.org.id]),
      activities: await count("select count(*)::text as n from crm_activities where org_id = $1", [o.org.id]),
    });
    const before = await snapshot();
    const res = await startTestRun(owner, id, { contactId });
    expect(res.issues).toEqual([]);
    expect(res.steps.map((s) => `${s.stepKey}:${s.outcome}`)).toEqual(["check:branch_yes", "tag:would_run", "task:would_run", "hook:would_skip", "n8n:would_skip", "wait:would_run", "end:would_end"]);
    expect(res.steps.find((s) => s.stepKey === "task")!.detail).toMatch(/Would create the task "Call Tess"/);
    expect(res.steps.find((s) => s.stepKey === "hook")!.detail).toMatch(/owner must approve/);
    expect(await snapshot()).toEqual(before);
    expect(webhookMock).not.toHaveBeenCalled();
    expect(n8nMock).not.toHaveBeenCalled();
    expect(agentTaskMock).not.toHaveBeenCalled();
    // The test is logged as a test run, which can't be retried and did nothing.
    const run = await getRun(owner, res.runId!);
    expect(run).toMatchObject({ startedVia: "test", status: "completed", canRetry: false, canCancel: false });
    expect(run.steps.every((s) => s.status === "skipped" && s.result.dryRun === true)).toBe(true);
    // The draft can be tried before it is published, too.
    const draft = await startTestRun(owner, id, { contactId, source: "draft" });
    expect(draft.runId).toBeNull();
    expect(draft.steps[0].outcome).toBe("branch_yes");
    expect(await snapshot()).toEqual({ ...before, events: before.events });
    await expect(startTestRun(owner, id, {})).rejects.toThrow(/Choose a contact/);
  });

  it("lets a person cancel or skip past a step of a run", async () => {
    const owner = o.actor("owner");
    const { id } = await liveWorkflow(o, { trigger: { type: "manual" }, steps: chain(step("wait", "wait", { mode: "duration", amount: 5, unit: "days" }), step("tag", "add_tag", { tagIds: [tag.id] })) });
    const c = await contactIn(o);
    const { runId } = await startManualRun(owner, id, { contactId: c });
    await processWorkflowRuns();
    await expect(cancelRun(o.actor("sales"), runId)).rejects.toThrow(/permission/);
    await cancelRun(owner, runId);
    expect((await getRun(owner, runId))).toMatchObject({ status: "cancelled", canCancel: false });
    await expect(cancelRun(owner, runId)).rejects.toThrow(/already finished/);
    await expect(skipRunStep(owner, runId)).rejects.toThrow(/Only runs that failed/);
    await setWorkflowStatus(owner, id, "archived");
  });
});

// ---------------------------------------------------------------------------
// Customer messages go through the gated outbound path
// ---------------------------------------------------------------------------

describe("send_message", () => {
  it("sends only an approved template, under the version's owner approval, through every messaging rule", async () => {
    const m = await messagingOrg({ provider: "twilio", name: "Messaging Workflows" });
    const owner = memberActor(m.ctx("owner"));
    const manager = memberActor(m.ctx("manager"));
    const t = await createTemplate(owner, { name: "Welcome text", channel: "sms", purpose: "service", body: "Hi {{contact.first_name}}, thanks for getting in touch with us." });
    const approved = await approveTemplate(owner, t.id, { version: t.currentVersion, contentHash: t.contentHash });
    const def: WorkflowDefinition = {
      trigger: { type: "manual" },
      steps: [step("send", "send_message", { templateId: t.id, contentHash: approved.contentHash, channel: "sms", sendAs: "sales_assistant", businessHoursOnly: false })],
    };
    const { id } = await createWorkflow(manager, { name: "Welcome", definition: def });
    const pub = await publishWorkflow(manager, id);
    expect(pub).toMatchObject({ needsApproval: true, effects: ["send_sms"] });
    const req = await requestWorkflowApproval(manager, id, null, { activate: true });
    expect((await decideApproval(m.ctx("owner"), req.approvalId!, "approve")).outcome?.status).toBe("succeeded");
    expect((await getWorkflow(owner, id)).status).toBe("active");

    // No consent on record: the outbound rules block it, and nothing is queued.
    const noConsent = (await createContact(owner, { firstName: "Nora", lastName: "Cruz", phone: "+639171110001" })).id;
    const r1 = await startManualRun(owner, id, { contactId: noConsent });
    await processWorkflowRuns();
    const [s1] = await stepsOf(r1.runId);
    expect(s1).toMatchObject({ status: "skipped", result: { outcome: "blocked", reason: "no_consent" } });
    expect((await getRun(owner, r1.runId)).status).toBe("completed");
    const outbound = (contactId: string) => withSystem((db) => db.query<{ id: string; status: string; dedupe_key: string; scope: string; approval_id: string | null; body: string }>(
      "select m.id, m.status, m.dedupe_key, m.scope, m.approval_id, m.body from conversation_messages m join conversations c on c.id = m.conversation_id where c.contact_id = $1 and m.direction = 'outbound'", [contactId])).then((r) => r.rows);
    expect(await outbound(noConsent)).toEqual([]);

    // With consent, the message is queued with the step's key, the version's approval and the rendered approved wording.
    const ok = (await createContact(owner, { firstName: "Olga", lastName: "Reyes", phone: "+639171110002" })).id;
    await setContactConsent(owner, ok, { channel: "sms", purpose: "service", status: "granted", evidence: "Asked to be texted at the front desk." });
    // Even an employee that asks first sends, because the owner approved this exact workflow version.
    await withSystem((db) => db.query("update agent_instances set mode = 'approval_required' where id = $1", [m.salesAgentId]));
    const r2 = await startManualRun(owner, id, { contactId: ok });
    await processWorkflowRuns();
    const msgs = await outbound(ok);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ status: "queued", dedupe_key: `wf:${r2.runId}:send`, scope: "followup", approval_id: req.approvalId });
    expect(msgs[0].body).toMatch(/Hi Olga, thanks for getting in touch with us\./);
    expect((await stepsOf(r2.runId))[0]).toMatchObject({ status: "completed", result: { status: "queued" } });

    // Running the step again (a person moved the run back) finds the message and sends nothing new.
    await withSystem((db) => db.query("update crm_workflow_runs set status = 'failed', current_step = 'send', finished_at = now() where id = $1", [r2.runId]));
    await retryRunStep(owner, r2.runId);
    await processWorkflowRuns();
    expect(await outbound(ok)).toHaveLength(1);
    expect((await stepsOf(r2.runId)).at(-1)!.result).toMatchObject({ duplicate: true });

    // A paused employee sends nothing, whatever the workflow's approval.
    await withSystem((db) => db.query("update agent_instances set mode = 'paused' where id = $1", [m.salesAgentId]));
    const r3 = await startManualRun(owner, id, { contactId: ok });
    await processWorkflowRuns();
    expect((await stepsOf(r3.runId))[0]).toMatchObject({ status: "skipped", result: { outcome: "blocked" } });
    expect(await outbound(ok)).toHaveLength(1);

    // If the template's approved wording changes after publishing, the step stops instead of sending the new words.
    await withSystem((db) => db.query("update agent_instances set mode = 'autonomous' where id = $1", [m.salesAgentId]));
    await withSystem(async (db) => {
      await db.query("insert into crm_message_template_versions (org_id, template_id, version, body, content_hash) values ($1, $2, 2, 'Different words', $3)", [m.org.id, t.id, "c".repeat(64)]);
      await db.query("update crm_message_templates set current_version = 2, approved_version = 2 where id = $1", [t.id]);
    });
    const r4 = await startManualRun(owner, id, { contactId: ok });
    await processWorkflowRuns();
    const run4 = await getRun(owner, r4.runId);
    expect(run4.status).toBe("failed");
    expect(run4.lastError).toMatch(/approved wording changed/);
    expect(await outbound(ok)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Other ways in: inbound webhooks, schedules, customer messages, due tasks
// ---------------------------------------------------------------------------

describe("triggers beyond the CRM records", () => {
  let o: CrmOrg;
  let tag: { id: string; name: string };
  beforeAll(async () => {
    o = await crmOrg({ name: "Triggers Co" });
    tag = await createTag(o.actor("owner"), { name: `Triggered ${uid()}` });
  });

  it("starts from a signed inbound webhook URL, matching or creating the contact, once per idempotency key", async () => {
    const owner = o.actor("owner");
    const nonce = "abcdefghijklmnopqrstuvwx";
    const { id } = await liveWorkflow(o, { trigger: { type: "inbound_webhook", inbound: { nonce, match: "email_or_phone", createContact: true } }, steps: [step("tag", "add_tag", { tagIds: [tag.id] })] });
    const token = inboundToken(id, nonce);
    expect((await getWorkflow(owner, id)).inboundUrl).toMatch(new RegExp(`/api/public/workflows/${token.replace(".", "\\.")}$`));
    const res = await handleInboundWebhook({ token, body: { email: "Ana.Lim@Example.test", firstName: "Ana", source: "landing page" }, idempotencyKey: "req-1" });
    expect(res).toMatchObject({ httpStatus: 202, body: { status: "accepted" } });
    const run = (await runsOf(id))[0];
    const contact = await one<{ id: string; email: string; created_via: string }>("select id, email::text as email, created_via from contacts where id = $1", [run.contact_id]);
    expect(contact).toMatchObject({ email: "ana.lim@example.test", created_via: "workflow" });
    expect(run.context.inbound).toMatchObject({ source: "landing page" });
    await settle();
    expect(await tagsOf(contact.id)).toEqual([tag.name]);
    // The same request again starts nothing; a new one for the same person reuses the contact.
    expect(await handleInboundWebhook({ token, body: { email: "ana.lim@example.test" }, idempotencyKey: "req-1" })).toMatchObject({ httpStatus: 200, body: { status: "duplicate", runId: run.id } });
    await handleInboundWebhook({ token, body: { contact: { email: "ana.lim@example.test" } } });
    expect((await runsOf(id)).map((r) => r.contact_id)).toEqual([contact.id, contact.id]);
    // Forged or unknown URLs learn nothing; bodies must be objects; a workflow that is off starts nothing.
    expect((await handleInboundWebhook({ token: `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`, body: {} })).httpStatus).toBe(404);
    expect((await handleInboundWebhook({ token: inboundToken(U(), nonce), body: {} })).httpStatus).toBe(404);
    expect((await handleInboundWebhook({ token: "nonsense", body: {} })).httpStatus).toBe(404);
    expect((await handleInboundWebhook({ token, body: [1, 2] })).httpStatus).toBe(400);
    await setWorkflowStatus(owner, id, "paused");
    expect(await handleInboundWebhook({ token, body: { email: "x@example.test" } })).toMatchObject({ httpStatus: 409 });
    await setWorkflowStatus(owner, id, "archived");
    expect((await handleInboundWebhook({ token, body: {} })).httpStatus).toBe(404);
  });

  it("runs a scheduled workflow once per slot, in the workspace's time zone", async () => {
    const owner = o.actor("owner");
    const { id } = await liveWorkflow(o, { trigger: { type: "schedule", schedule: { frequency: "daily", time: "09:00" } }, steps: [step("ping", "notify_team", { roles: ["owner"], title: "Daily pipeline check" })] });
    const tomorrow = new Date(Date.now() + 86_400_000);
    const at = new Date(Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate(), 9, 30));
    expect(await fireSchedules(at)).toBeGreaterThanOrEqual(1);
    expect(await fireSchedules(at)).toBe(0);
    const runs = await runsOf(id);
    expect(runs).toHaveLength(1);
    expect(runs[0].contact_id).toBeNull();
    expect(runs[0].context.slot).toBe(new Date(Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate(), 9, 0)).toISOString());
    await processWorkflowRuns({ now: at });
    expect((await runsOf(id))[0].status).toBe("completed");
    expect(await count("select count(*)::text as n from notifications where user_id = $1 and title = 'Daily pipeline check'", [o.people.owner.id])).toBe(1);
    await setWorkflowStatus(owner, id, "archived");
  });

  it("records a customer's message as an event a workflow can start from (proven senders only, not STOP)", async () => {
    const owner = o.actor("owner");
    const { id } = await liveWorkflow(o, { trigger: { type: "conversation.message_received", filters: { channels: ["sms"] } }, steps: [step("tag", "add_tag", { tagIds: [tag.id] })] });
    const msg = await inbound(o.org.id, { address: "+15550202001", body: "Do you have time on Friday?" });
    const ev = await one<{ actor_kind: string; entity_type: string; entity_id: string; contact_id: string; payload: Record<string, unknown> }>(
      "select actor_kind, entity_type, entity_id, contact_id, payload from crm_events where org_id = $1 and type = 'conversation.message_received' and contact_id = $2", [o.org.id, msg.contactId]);
    expect(ev).toMatchObject({ actor_kind: "contact", entity_type: "conversation", entity_id: msg.conversationId, payload: { channel: "sms", keyword: null, messageId: msg.messageId } });
    // A redelivered provider webhook records nothing new.
    await inbound(o.org.id, { address: "+15550202001", providerMessageId: (await one<{ provider_message_id: string }>("select provider_message_id from conversation_messages where id = $1", [msg.messageId])).provider_message_id });
    expect(await count("select count(*)::text as n from crm_events where org_id = $1 and type = 'conversation.message_received' and contact_id = $2", [o.org.id, msg.contactId])).toBe(1);
    const stop = await inbound(o.org.id, { address: "+15550202002", body: "STOP" });
    const forged = await inbound(o.org.id, { channel: "email", provider: "resend", address: "someone@example.test", ghlContactId: null, senderVerified: false, body: "Please call me" });
    expect(await count("select count(*)::text as n from crm_events where org_id = $1 and type = 'conversation.message_received' and contact_id = $2", [o.org.id, forged.contactId])).toBe(0);
    await settle();
    const runs = await runsOf(id);
    expect(runs.map((r) => r.contact_id)).toEqual([msg.contactId]);
    expect(await tagsOf(msg.contactId!)).toEqual([tag.name]);
    expect(await tagsOf(stop.contactId!)).toEqual([]);
    await setWorkflowStatus(owner, id, "archived");
  });

  it("records 'task due' once per due time, only for workspaces with such a workflow and tasks due after it was published", async () => {
    const owner = o.actor("owner");
    const contactId = await contactIn(o);
    const old = await createTask(owner, { title: "Old", dueAt: new Date(Date.now() - 60_000).toISOString(), contactId });
    expect((await emitTaskDueEvents()).emitted).toBe(0);
    const { id } = await liveWorkflow(o, { trigger: { type: "task.due" }, steps: [step("tag", "add_tag", { tagIds: [tag.id] })] });
    const due = await createTask(owner, { title: "Call back", dueAt: new Date(Date.now() + 2000).toISOString(), contactId });
    const later = new Date(Date.now() + 5000);
    expect((await emitTaskDueEvents(200, later)).emitted).toBe(1);
    expect((await emitTaskDueEvents(200, later)).emitted).toBe(0);
    const ev = await one<{ entity_id: string; contact_id: string; payload: Record<string, unknown> }>("select entity_id, contact_id, payload from crm_events where org_id = $1 and type = 'task.due'", [o.org.id]);
    expect(ev).toMatchObject({ entity_id: due.id, contact_id: contactId, payload: { title: "Call back" } });
    expect(ev.entity_id).not.toBe(old.id);
    await settle(later);
    const runs = await runsOf(id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ contact_id: contactId, status: "completed" });
    expect(runs[0].context).toMatchObject({ taskId: due.id });
    await setWorkflowStatus(owner, id, "archived");
  });
});

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

describe("cross-tenant isolation", () => {
  it("keeps every workflow, version, run and event inside its own workspace", async () => {
    const a = await crmOrg({ name: "Tenant A" });
    const b = await crmOrg({ name: "Tenant B" });
    const tagA = await createTag(a.actor("owner"), { name: `A ${uid()}` });
    const tagB = await createTag(b.actor("owner"), { name: `B ${uid()}` });
    const wfA = await liveWorkflow(a, { trigger: { type: "manual" }, steps: chain(step("wait", "wait", { mode: "duration", amount: 1, unit: "days" }), step("tag", "add_tag", { tagIds: [tagA.id] })) });
    const contactA = await contactIn(a);
    const contactB = await contactIn(b);
    const { runId } = await startManualRun(a.actor("owner"), wfA.id, { contactId: contactA });
    const bOwner = b.actor("owner");

    await expect(getWorkflow(bOwner, wfA.id)).rejects.toThrow(/not found/i);
    expect((await listWorkflows(bOwner)).some((w) => w.id === wfA.id)).toBe(false);
    await expect(publishWorkflow(bOwner, wfA.id)).rejects.toThrow(/not found/i);
    await expect(setWorkflowStatus(bOwner, wfA.id, "paused")).rejects.toThrow(/not found/i);
    await expect(requestWorkflowApproval(bOwner, wfA.id)).rejects.toThrow(/not found/i);
    await expect(cloneWorkflow(bOwner, wfA.id)).rejects.toThrow(/not found/i);
    await expect(saveWorkflowDraft(bOwner, wfA.id, { definition: { trigger: { type: "manual" }, steps: [] }, expectedRevision: 1 })).rejects.toThrow(/not found/i);
    await expect(startTestRun(bOwner, wfA.id, { contactId: contactB })).rejects.toThrow(/not found/i);
    await expect(startManualRun(bOwner, wfA.id, { contactId: contactB })).rejects.toThrow(/not found/i);
    await expect(getRun(bOwner, runId)).rejects.toThrow(/not found/i);
    await expect(cancelRun(bOwner, runId)).rejects.toThrow(/not found/i);
    await expect(retryRunStep(bOwner, runId)).rejects.toThrow(/not found/i);
    expect((await listRuns(bOwner)).items.some((r) => r.id === runId)).toBe(false);
    // A's workflow can't be started for B's contact, nor refer to B's tags.
    await expect(startManualRun(a.actor("owner"), wfA.id, { contactId: contactB })).rejects.toThrow(/Contact not found/);
    const { id: crossRef } = await createWorkflow(a.actor("owner"), { name: "Cross ref", definition: { trigger: { type: "manual" }, steps: [step("tag", "add_tag", { tagIds: [tagB.id] })] } });
    await expect(publishWorkflow(a.actor("owner"), crossRef)).rejects.toThrow(/tag that no longer exists/);
    // B's workflows never start from A's events (B's own earlier events are dispatched first).
    await crmEventDispatch({ limit: 500 });
    const wfB = await liveWorkflow(b, { trigger: { type: "contact.created" }, steps: [step("tag", "add_tag", { tagIds: [tagB.id] })] });
    await contactIn(a);
    await settle();
    expect(await runsOf(wfB.id)).toEqual([]);
    expect((await listRuns(a.actor("owner"), { workflowId: wfA.id })).items.map((r) => r.id)).toEqual([runId]);
    await setWorkflowStatus(a.actor("owner"), wfA.id, "archived");
    await setWorkflowStatus(bOwner, wfB.id, "archived");
  });
});
