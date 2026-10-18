// Regression tests for the Phase 4 review's UI findings 13–26: honest copy (what an AI, Send-as or n8n step will really do, retry after an
// unknown n8n outcome, the follow-up style's saved state, rules a builder can't see), hydration-safe relative times, the workflow list on
// phones, and accessibility (status counters, template selects, step problems, focus after removing a step, the inbound URL for viewers).
// Synthetic workspaces only (pglite in memory); the n8n call is mocked and nothing leaves the machine.
import * as React from "react";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined, prefetch: () => undefined }),
  usePathname: () => "/crm/workflows",
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
}));
vi.mock("@/server/crm/request", () => ({
  resolveCrmActor: async () => {
    throw new Error("No server actions run in these tests.");
  },
}));
vi.mock("@/app/actions/crm-followups", () => {
  const ok = async () => ({ ok: true, data: null });
  return { saveFollowUpSettingsAction: ok, stopContactFollowUpsAction: ok };
});
// The n8n call runs for real unless a test answers for it (an unknown outcome).
vi.mock("@/server/integrations/n8n-actions", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/server/integrations/n8n-actions")>();
  return { ...mod, callN8nWorkflow: vi.fn(mod.callN8nWorkflow) };
});

import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { decideApproval } from "@/server/approvals/service";
import { memberActor, type CrmActor } from "@/server/crm/actor";
import { scopeFor } from "@/server/crm/page";
import { createContact, setContactConsent } from "@/server/crm/contacts";
import { createTag } from "@/server/crm/tags";
import { createAssignmentRule } from "@/server/crm/assignment";
import { approveTemplate, createTemplate } from "@/server/crm/message-templates";
import { createWorkflow, publishWorkflow, requestWorkflowApproval } from "@/server/crm/workflows/definitions";
import { getRun, retryRunStep, skipRunStep, startManualRun, startTestRun } from "@/server/crm/workflows/runs";
import { processWorkflowRuns, recoverAbandonedRuns } from "@/server/crm/workflows/runner";
import { loadBuilderOptions } from "@/server/crm/workflows/context";
import { agentLiveRunsVerified } from "@/server/crm/agent-tools/tasks";
import { callN8nWorkflow, configureN8nTrigger, n8nStepReadiness } from "@/server/integrations/n8n-actions";
import { saveFollowUpSettings } from "@/server/messaging/followups";
import { loadEditorOptions, WorkflowView } from "@/components/crm/views/workflow-view";
import { FollowUpsView } from "@/components/crm/views/followups-view";
import { StepPanel } from "@/components/crm/workflows/step-panel";
import { TriggerPanel } from "@/components/crm/workflows/trigger-panel";
import { WorkflowCanvas, type CanvasIssue } from "@/components/crm/workflows/canvas";
import { RunDetail } from "@/components/crm/workflows/run-detail";
import { TemplateInput, WorkflowsList } from "@/components/crm/workflows/workflows-list";
import { SinglePick } from "@/components/crm/workflows/pickers";
import { RelativeTime } from "@/components/crm/relative-time";
import { layoutCanvas, orderedKeys } from "@/components/crm/workflows/graph";
import { AI_PAUSED, effectItems, focusTargetAfterRemove, groupIssues, kindChoices, readinessIssues, validationContextOf } from "@/components/crm/workflows/editor-logic";
import { namesFrom } from "@/components/crm/workflows/summaries";
import { toRunDetailView } from "@/components/crm/workflows/run-format";
import { sameCustomFollowUp } from "@/components/crm/followups/sequence";
import { validateDefinition, type ValidationIssue, type WorkflowDefinition, type WorkflowStep } from "@/lib/crm/workflow/spec";
import type { EditorOptions, EditorWorkflow, WorkflowListItem } from "@/components/crm/workflows/types";
import type { CustomFollowUp } from "@/lib/messaging";
import { ctxFor, uid } from "./support/fixtures";
import { agencyPeople, crmOrg, type CrmOrg } from "./support/crm";
import { messagingOrg } from "./support/messaging";

const n8nMock = vi.mocked(callN8nWorkflow);
afterEach(() => n8nMock.mockClear());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Static HTML with React's text separators removed and the common entities decoded, so assertions read like the screen. */
const html = (el: React.ReactElement) =>
  renderToStaticMarkup(el).replace(/<!-- -->/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const HASH = "a".repeat(64);
const step = (key: string, kind: WorkflowStep["kind"], config: Record<string, unknown>, next: string | null = null, extra: Partial<WorkflowStep> = {}): WorkflowStep =>
  ({ key, kind, config, next, ...extra }) as WorkflowStep;
const manual = (...steps: WorkflowStep[]): WorkflowDefinition => ({ trigger: { type: "manual" }, steps });
const EMPLOYEE: EditorOptions["employees"][number] = { roleKey: "sales_assistant", name: "Sales Assistant", mode: "approval_required", enabled: true, ready: true, connected: true, liveRuns: true };

function editorOptions(over: Partial<EditorOptions> = {}): EditorOptions {
  return {
    tags: [{ id: U(1), name: "VIP", color: "#123456" }],
    members: [{ id: U(2), name: "Ana Reyes", role: "owner" }],
    pipelines: [{ id: U(3), name: "Sales", stages: [{ id: U(4), name: "New", kind: "open" }, { id: U(5), name: "Won", kind: "won" }] }],
    contactFields: [],
    opportunityFields: [],
    assignmentRules: [{ id: U(7), name: "Website leads", entity: "contact", active: true }],
    assignmentRuleRefs: [{ id: U(7), entity: "contact" }],
    templates: [{ id: U(8), key: "quote", name: "Quote follow-up", channel: "sms", purpose: "service", version: 2, subject: null, body: "Hi {{contact.first_name}}", contentHash: HASH }],
    unapprovedTemplates: [],
    n8nMappings: [{ id: U(9), label: "Sync to Sheets", workflowId: "wf1", problem: null }],
    webhooks: [{ id: U(10), name: "Billing", host: "billing.example.com", active: true }],
    employees: [EMPLOYEE],
    calendars: [],
    appointmentTypes: [],
    folders: [],
    ...over,
  };
}

function panel(s: WorkflowStep, options: EditorOptions, issues: ValidationIssue[] = []) {
  return html(React.createElement(StepPanel, { step: s, number: 1, definition: manual(s), options, issues, readOnly: false, base: "/crm", onChange: () => undefined, onRemove: () => undefined }));
}
const noteOf = (options: EditorOptions, kind: string) => kindChoices(options).find((c) => c.kind === kind)?.note ?? null;

const ask = step("ask", "ai_task", { roleKey: "sales_assistant", instruction: "Review this lead and add a short note." });
const send = step("msg", "send_message", { templateId: U(8), contentHash: HASH, channel: "sms", sendAs: "sales_assistant", businessHoursOnly: false });
const n8n = step("n8n", "n8n", { mappingId: U(9), includeContact: false });

/** Publishes a definition and has the owner approve it (switching it on). */
async function approvedLive(o: { actor: (w: "owner" | "manager") => CrmActor; ownerCtx: ReturnType<typeof ctxFor> }, definition: WorkflowDefinition) {
  const { id } = await createWorkflow(o.actor("manager"), { name: `Workflow ${uid()}`, definition });
  const pub = await publishWorkflow(o.actor("manager"), id);
  expect(pub.needsApproval).toBe(true);
  const req = await requestWorkflowApproval(o.actor("manager"), id, null, { activate: true });
  expect((await decideApproval(o.ownerCtx, req.approvalId!, "approve")).outcome?.status).toBe("succeeded");
  return id;
}
const crmApprover = (o: CrmOrg) => ({ actor: (w: "owner" | "manager") => o.actor(w), ownerCtx: ctxFor(o.people.owner, o.org, "owner") });

/** A synthetic Hermes credential row (never resolved here) for an employee that counts as connected. */
const credentialFor = async (orgId: string) =>
  (await withSystem((db) => db.query<{ id: string }>("insert into integration_credentials (org_id, provider, label, ciphertext, fingerprint) values ($1, 'hermes', 'Test Hermes key', 'v1.synthetic', 'fp-test') returning id", [orgId]))).rows[0].id;

/** An agency n8n connection (one per environment) whose approved list is exactly `approved`, and a verified mapping for the workspace. */
async function n8nMapping(orgId: string, workflowId: string, approved: string[]) {
  return withSystem(async (db) => {
    const conn = await db.query<{ id: string }>(
      `insert into integration_connections (org_id, provider, label, config, status) values (null, 'n8n', 'Agency n8n', $1, 'connected')
       on conflict (coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), provider) do update set config = excluded.config, status = 'connected' returning id`,
      [JSON.stringify({ baseUrl: "https://n8n.example.test", approvedWorkflowIds: approved })],
    );
    const m = await db.query<{ id: string }>(
      "insert into automation_template_mappings (org_id, global_connection_id, workflow_id, status, last_verified_at) values ($1, $2, $3, 'verified', now()) returning id",
      [orgId, conn.rows[0].id, workflowId],
    );
    return m.rows[0].id;
  });
}

// ---------------------------------------------------------------------------
// 13 · The AI step's paused copy
// ---------------------------------------------------------------------------

describe("13: a paused AI employee's step is described as skipped, the way the engine treats it", () => {
  it("says the step is skipped while paused and the run carries on, in the step panel and the approval preview", () => {
    const o = editorOptions({ employees: [{ ...EMPLOYEE, mode: "paused" }] });
    const page = panel(ask, o);
    expect(page).toContain("skipped while it's paused (nothing is asked) and the run carries on");
    expect(page).not.toMatch(/waits until you resume/);
    const [item] = effectItems(manual(ask), o);
    const mode = item.lines.find((l) => l.label === "Its mode")?.value;
    expect(mode).toBe(AI_PAUSED);
    expect(mode).not.toMatch(/nothing happens until/);
    // Pausing is the owner's own, temporary choice: it is said plainly but doesn't block asking for approval.
    expect(item.warning).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 14 · AI steps and Send-as show their real state
// ---------------------------------------------------------------------------

describe("14: AI steps and Send-as employees show whether they can act, from the checks the engine makes", () => {
  it("warns, and keeps approval from being requested, when live AI runs are off or the employee isn't connected", () => {
    const def = manual(ask);
    const off = editorOptions({ employees: [{ ...EMPLOYEE, liveRuns: false }] });
    expect(noteOf(off, "ai_task")).toMatch(/AI employee runs are switched off for now, so this step would be skipped/);
    expect(effectItems(def, off)[0].warning).toMatch(/switched off for now/);
    expect(readinessIssues(def, off)).toEqual([expect.objectContaining({ level: "warning", code: "not_ready", stepKey: "ask" })]);
    // The warning shows on the canvas and in the problem list without stopping publishing.
    const grouped = groupIssues([...validateDefinition(def, validationContextOf(off)), ...readinessIssues(def, off)]);
    expect(grouped.errors).toBe(0);
    expect(grouped.byStep.ask.map((i) => i.code)).toEqual(["not_ready"]);
    expect(panel(ask, off, grouped.byStep.ask)).toContain("AI employee runs are switched off for now, so this step is skipped (nothing is asked)");
    // Shown once, next to the choice, not repeated in the panel's problem list.
    expect(panel(ask, off, grouped.byStep.ask).match(/AI employee runs are switched off/g)).toHaveLength(1);

    const unplugged = editorOptions({ employees: [{ ...EMPLOYEE, connected: false, liveRuns: false }] });
    expect(panel(ask, unplugged)).toContain("Sales Assistant isn't connected to its AI service yet");
    const unchecked = editorOptions({ employees: [{ ...EMPLOYEE, ready: false }] });
    expect(effectItems(def, unchecked)[0].warning).toMatch(/hasn't passed its connection check/);

    // A live, connected employee: its mode, and nothing in the way.
    const live = editorOptions();
    expect(noteOf(live, "ai_task")).toBeNull();
    expect(effectItems(def, live)[0].warning).toBeNull();
    expect(readinessIssues(def, live)).toEqual([]);
    expect(panel(ask, live)).toContain("Asks you before it changes anything.");
  });

  it("says when the employee a message is sent as hasn't passed its connection check", () => {
    const notReady = editorOptions({ employees: [{ ...EMPLOYEE, ready: false }] });
    const page = panel(send, notReady);
    expect(page).toContain("Sales Assistant (not ready)");
    expect(page).toContain("Sales Assistant hasn't passed its connection check, so this step sends nothing (it's skipped) and the run carries on.");
    expect(effectItems(manual(send), notReady)[0].warning).toMatch(/connection check/);
    expect(noteOf(notReady, "send_message")).toMatch(/connection check/);
    expect(readinessIssues(manual(send), notReady).map((i) => i.code)).toEqual(["not_ready"]);
    const ready = editorOptions();
    expect(effectItems(manual(send), ready)[0].warning).toBeNull();
    expect(panel(send, ready)).not.toContain("(not ready)");
  });

  it("hands the editor each employee's readiness, using the same check requestAgentTask makes", async () => {
    const o = await crmOrg({ name: "Ready Co" });
    const credentialId = await credentialFor(o.org.id);
    await withSystem((db) =>
      db.query(
        `update agent_instances set status = 'online', hermes_base_url = 'http://127.0.0.1:8642', hermes_profile = $2, credential_id = $3,
           last_health_ok = true, tool_inventory_contract = 'hermes.api_server.tool_catalog.v1',
           tool_inventory_digest = repeat('a', 64), tool_inventory_verified_at = now(),
           tool_inventory_expires_at = now() + interval '2 minutes', tool_inventory_tool_count = 6
         where org_id = $1 and role_key = 'crm_manager'`,
        [o.org.id, `client-${uid()}`, credentialId],
      ),
    );
    const options = await loadEditorOptions(o.actor("owner"));
    const by = Object.fromEntries(options.employees.map((e) => [e.roleKey, e]));
    expect(by.crm_manager).toMatchObject({ ready: true, connected: true, liveRuns: true });
    expect(by.sales_assistant).toMatchObject({ ready: false, connected: false, liveRuns: false });
    // The preflight answer comes from the persisted, fresh attestation — not from the host name.
    const verified = {
      hermes_base_url: "https://hermes.example.com",
      hermes_profile: "client-x",
      credential_id: U(1),
      last_health_ok: true,
      tool_inventory_contract: "hermes.api_server.tool_catalog.v1",
      tool_inventory_digest: "a".repeat(64),
      tool_inventory_verified_at: new Date(),
      tool_inventory_expires_at: new Date(Date.now() + 60_000),
      tool_inventory_tool_count: 6,
    };
    expect(agentLiveRunsVerified(verified)).toBe(true);
    expect(agentLiveRunsVerified({ ...verified, hermes_base_url: "http://127.0.0.1.example.test:8642" })).toBe(true);
    expect(agentLiveRunsVerified({ ...verified, tool_inventory_expires_at: new Date(Date.now() - 1) })).toBe(false);
    expect(agentLiveRunsVerified({ ...verified, last_health_ok: false })).toBe(false);
    expect(agentLiveRunsVerified({ ...verified, credential_id: null })).toBe(false);
    expect(agentLiveRunsVerified({ hermes_base_url: "https://hermes.example.com", hermes_profile: "client-x", credential_id: U(1) })).toBe(false);
  });

  it("test runs say an AI step would be skipped exactly when the step would be", async () => {
    const o = await crmOrg({ name: "Dry AI Co" });
    const owner = o.actor("owner");
    const contactId = (await createContact(owner, { firstName: "Lia", lastName: uid() })).id;
    const id = await approvedLive(crmApprover(o), manual(step("ask", "ai_task", { roleKey: "crm_manager", instruction: "Review this lead." })));
    const trace = async () => (await startTestRun(owner, id, { contactId })).steps[0];
    const agent = (sql: string, params: unknown[] = []) => withSystem((db) => db.query(`update agent_instances set ${sql} where org_id = $1 and role_key = 'crm_manager'`, [o.org.id, ...params]));

    expect(await trace()).toMatchObject({ outcome: "would_skip", detail: expect.stringMatching(/hasn't passed its connection check, so nothing would be asked/) });
    await agent("status = 'online'");
    expect(await trace()).toMatchObject({ outcome: "would_skip", detail: expect.stringMatching(/isn't connected to its AI service yet/) });
    await agent("hermes_base_url = 'https://hermes.example.com', hermes_profile = $2, credential_id = $3", [`client-${uid()}`, await credentialFor(o.org.id)]);
    expect(await trace()).toMatchObject({ outcome: "would_skip", detail: expect.stringMatching(/Live AI employee runs are switched off for now/) });
    await agent(
      `last_health_ok = true, tool_inventory_contract = 'hermes.api_server.tool_catalog.v1',
       tool_inventory_digest = repeat('a', 64), tool_inventory_verified_at = now(),
       tool_inventory_expires_at = now() + interval '2 minutes', tool_inventory_tool_count = 6`,
    );
    const readiness = await withSystem(async (db) => (await db.query<Parameters<typeof agentLiveRunsVerified>[0] & { display_name: string }>(
      `select hermes_base_url, hermes_profile, credential_id, last_health_ok, tool_inventory_contract, tool_inventory_digest,
              tool_inventory_verified_at, tool_inventory_expires_at, tool_inventory_tool_count, display_name
       from agent_instances where org_id = $1 and role_key = 'crm_manager'`,
      [o.org.id],
    )).rows[0]);
    expect(agentLiveRunsVerified(readiness)).toBe(true);
    expect(await trace()).toMatchObject({ outcome: "would_run", detail: expect.stringMatching(/^Would ask/) });
  });

  it("test runs say a message would be blocked when the employee it's sent as isn't ready or is paused", async () => {
    const m = await messagingOrg({ provider: "twilio", name: "Dry Send Co" });
    const owner = memberActor(m.ctx("owner"));
    const t = await createTemplate(owner, { name: "Welcome text", channel: "sms", purpose: "service", body: "Hi {{contact.first_name}}, thanks for getting in touch." });
    const approved = await approveTemplate(owner, t.id, { version: t.currentVersion, contentHash: t.contentHash });
    const id = await approvedLive(
      { actor: (w) => memberActor(m.ctx(w)), ownerCtx: m.ctx("owner") },
      manual(step("send", "send_message", { templateId: t.id, contentHash: approved.contentHash, channel: "sms", sendAs: "sales_assistant", businessHoursOnly: false })),
    );
    const contactId = (await createContact(owner, { firstName: "Olga", lastName: uid(), phone: "+639171110042" })).id;
    await setContactConsent(owner, contactId, { channel: "sms", purpose: "service", status: "granted", evidence: "Asked to be texted." });
    const trace = async () => (await startTestRun(owner, id, { contactId })).steps[0];
    expect(await trace()).toMatchObject({ outcome: "would_run" });
    await withSystem((db) => db.query("update agent_instances set status = 'setup_required' where id = $1", [m.salesAgentId]));
    expect(await trace()).toMatchObject({ outcome: "would_skip", detail: expect.stringMatching(/hasn't passed its connection check, so it would be blocked/) });
    await withSystem((db) => db.query("update agent_instances set status = 'online', mode = 'paused' where id = $1", [m.salesAgentId]));
    expect(await trace()).toMatchObject({ outcome: "would_skip", detail: expect.stringMatching(/is paused, so nothing would be sent/) });
  });
});

// ---------------------------------------------------------------------------
// 15 · Rules a builder without the assign permission can't see
// ---------------------------------------------------------------------------

describe("15: an assign-through-a-rule step isn't flagged as deleted for builders who can't see rule names", () => {
  it("validates the step against bare rule references, and still catches a rule that really is gone", () => {
    const assign = step("as", "assign", { subject: "contact", to: "rule", ruleId: U(7), onlyIfUnassigned: true });
    const hidden = editorOptions({ assignmentRules: null });
    const issues = validateDefinition(manual(assign), validationContextOf(hidden));
    expect(issues.map((i) => i.code)).not.toContain("missing_rule");
    expect(groupIssues(issues).errors).toBe(0);
    const gone = validateDefinition(manual(assign), validationContextOf(editorOptions({ assignmentRules: null, assignmentRuleRefs: [] })));
    expect(gone.map((i) => i.code)).toContain("missing_rule");
    // The panel explains the permission instead of showing an error.
    const page = panel(assign, hidden, issues.filter((i) => i.stepKey === "as"));
    expect(page).toContain("Seeing assignment rules needs");
    expect(page).not.toContain("no longer active");
  });

  it("sends every builder the rule references, and the names only to people with the assign permission", async () => {
    const o = await crmOrg({ name: "Rules Co" });
    const rule = await createAssignmentRule(o.actor("owner"), { name: "Round robin", entity: "contact", strategy: "round_robin", members: [{ userId: o.people.setter.id }], active: true });
    const manager = o.actor("manager");
    const noAssign: CrmActor = { ...manager, can: (p) => p !== "contacts.assign" && manager.can(p) };
    const options = await loadEditorOptions(noAssign);
    expect(options.assignmentRules).toBeNull();
    expect(options.assignmentRuleRefs).toEqual([{ id: rule.id, entity: "contact" }]);
    expect(JSON.stringify(options.assignmentRuleRefs)).not.toContain("Round robin");
    const step1 = step("as", "assign", { subject: "contact", to: "rule", ruleId: rule.id, onlyIfUnassigned: false });
    expect(validateDefinition(manual(step1), validationContextOf(options)).map((i) => i.code)).not.toContain("missing_rule");
    expect((await loadEditorOptions(manager)).assignmentRules?.map((r) => r.name)).toEqual(["Round robin"]);
  });
});

// ---------------------------------------------------------------------------
// 16 · No Retry for an n8n step whose outcome is unknown
// ---------------------------------------------------------------------------

describe("16: a run stopped on an n8n call with an unknown outcome offers Skip, not a Retry that can't work", () => {
  let o: CrmOrg;
  let tagId: string;
  let workflowId: string;
  beforeAll(async () => {
    o = await crmOrg({ name: "Unknown Co" });
    tagId = (await createTag(o.actor("owner"), { name: "Synced" })).id;
    const mappingId = await n8nMapping(o.org.id, `wf${uid()}`, []);
    workflowId = await approvedLive(crmApprover(o), manual(step("n8n", "n8n", { mappingId, includeContact: true }, "tag"), step("tag", "add_tag", { tagIds: [tagId] })));
  });

  it("records the unknown outcome, refuses Retry with an explanation, and continues when the step is skipped", async () => {
    const owner = o.actor("owner");
    const contactId = (await createContact(owner, { firstName: "Uma", lastName: uid() })).id;
    n8nMock.mockResolvedValueOnce({ status: "unknown", retryable: false, detail: "n8n answered HTTP 502; the workflow may have started.", httpStatus: 502 });
    const { runId } = await startManualRun(owner, workflowId, { contactId });
    await processWorkflowRuns();
    const run = await getRun(owner, runId);
    expect(run).toMatchObject({ status: "failed", outcome: "external_unknown", canRetry: false, canSkip: true });
    expect(run.lastError).toMatch(/couldn't confirm whether n8n ran/);
    expect(run.lastError).toMatch(/if it did, skip this step/);
    expect(run.lastError).not.toMatch(/retry/i);
    await expect(retryRunStep(owner, runId)).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/skip this step/) });

    // The run screen offers only Skip, and says why.
    const steps = (await withSystem((db) => db.query<{ steps: WorkflowStep[] }>("select v.steps from crm_workflow_versions v join crm_workflow_runs r on r.version_id = v.id where r.id = $1", [runId]))).rows[0].steps;
    const view = toRunDetailView(run, steps, { names: namesFrom(editorOptions()), base: "/crm", formatTime: (x) => x });
    expect(view).toMatchObject({ externalUnknown: true, canRetry: false, canSkip: true });
    const page = html(React.createElement(RunDetail, { scope: await scopeFor(owner, "/crm"), run: view, canManage: true }));
    expect(page).toContain("Skip it and continue");
    expect(page).not.toMatch(/>Retry /);
    expect(page).toContain("It isn't retried, so it can't run twice");

    await skipRunStep(owner, runId);
    await processWorkflowRuns();
    expect((await getRun(owner, runId)).status).toBe("completed");
    expect(n8nMock).toHaveBeenCalledTimes(1);
  });

  it("treats a call cut off by a stopped worker the same way", async () => {
    const owner = o.actor("owner");
    const { runId } = await startManualRun(owner, workflowId, { contactId: (await createContact(owner, { firstName: "Vic", lastName: uid() })).id });
    await withSystem(async (db) => {
      const s = await db.query<{ id: string }>(
        "insert into crm_workflow_run_steps (org_id, run_id, step_key, kind, attempt, status, idempotency_key) values ($1, $2, 'n8n', 'n8n', 1, 'running', $3) returning id",
        [o.org.id, runId, `wf:${runId}:n8n#1`],
      );
      await db.query(
        "update crm_workflow_runs set status = 'running', current_step = 'n8n', claimed_at = now() - interval '5 minutes', context = context || jsonb_build_object('inflight', jsonb_build_object('key', 'n8n', 'rowId', $2::bigint)) where id = $1",
        [runId, s.rows[0].id],
      );
    });
    await recoverAbandonedRuns();
    await processWorkflowRuns();
    const run = await getRun(owner, runId);
    expect(run).toMatchObject({ status: "failed", outcome: "external_unknown", canRetry: false, canSkip: true });
    expect(n8nMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 17 · n8n steps that can't run, in client-safe words
// ---------------------------------------------------------------------------

describe("17: n8n steps show when calls are off or the trigger isn't set up, never naming a setting", () => {
  let o: CrmOrg;
  let mappingId: string;
  let superAdminId: string;
  const enable = (on: boolean) => {
    if (on) process.env.N8N_ACTIONS_ENABLED = "true";
    else delete process.env.N8N_ACTIONS_ENABLED;
    resetEnvCache();
  };
  const problem = async () => (await withSystem((db) => n8nStepReadiness(db, o.org.id))).get(mappingId);
  beforeAll(async () => {
    process.env.INTEGRATION_ALLOWED_HOSTS = "n8n.example.test";
    resetEnvCache();
    o = await crmOrg({ name: "n8n Ready Co" });
    superAdminId = (await agencyPeople()).superAdmin.id;
    mappingId = await n8nMapping(o.org.id, "wfReady01", []);
  });
  afterAll(() => {
    delete process.env.INTEGRATION_ALLOWED_HOSTS;
    enable(false);
  });

  it("says why each verified automation can't start, in the order a call checks, until it can", async () => {
    enable(false);
    expect(await problem()).toBe("Starting n8n automations is switched off by iAcquire for now, so this step won't run.");
    enable(true);
    expect(await problem()).toMatch(/no longer on your agency's approved list/);
    await n8nMapping(o.org.id, `wf${uid()}`, ["wfReady01"]);
    expect(await problem()).toMatch(/hasn't finished setting up this automation's trigger/);
    await configureN8nTrigger(superAdminId, { orgId: o.org.id, mappingId, url: "https://n8n.example.test/webhook/ready", token: "t".repeat(40) });
    expect(await problem()).toBeNull();
    await withSystem((db) => db.query("update integration_connections set status = 'error' where org_id is null and provider = 'n8n'"));
    expect(await problem()).toMatch(/n8n connection needs attention/);
    await withSystem((db) => db.query("update integration_connections set status = 'connected' where org_id is null and provider = 'n8n'"));

    // The editor gets it with each mapping.
    enable(false);
    const options = await withSystem((db) => loadBuilderOptions(db, o.org.id));
    expect(options.n8nMappings.find((m) => m.id === mappingId)?.problem).toMatch(/switched off by iAcquire/);
    enable(true);
    expect((await withSystem((db) => loadBuilderOptions(db, o.org.id))).n8nMappings.find((m) => m.id === mappingId)?.problem).toBeNull();
  });

  it("never shows the setting's name to a client when calls are off", async () => {
    enable(false);
    const r = await callN8nWorkflow({ orgId: o.org.id, mappingId, payload: { a: 1 }, idempotencyKey: "wf:ready-off-1" });
    expect(r.status).toBe("blocked");
    expect(r.detail).toMatch(/switched off by iAcquire/);
    expect(r.detail).not.toMatch(/N8N_|ENABLED|environment/);
  });

  it("shows the problem in the step's note, the + menu and the approval preview", () => {
    const off = "Starting n8n automations is switched off by iAcquire for now, so this step won't run.";
    const o2 = editorOptions({ n8nMappings: [{ id: U(9), label: "Sync to Sheets", workflowId: "wf1", problem: off }] });
    expect(noteOf(o2, "n8n")).toBe(off);
    expect(effectItems(manual(n8n), o2)[0].warning).toBe(off);
    expect(readinessIssues(manual(n8n), o2)).toEqual([expect.objectContaining({ code: "not_ready", message: off })]);
    const page = panel(n8n, o2);
    expect(page).toContain(off);
    expect(page).toContain("Sync to Sheets · can't run yet");
    expect(page).not.toMatch(/N8N_/);
    expect(noteOf(editorOptions(), "n8n")).toBeNull();
    expect(effectItems(manual(n8n), editorOptions())[0].warning).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 18 · The saved Custom follow-up style isn't "unsaved"
// ---------------------------------------------------------------------------

describe("18: a saved Custom follow-up style reads as saved", () => {
  it("compares the fields, not the stored JSON's key order or its shorter gap list", async () => {
    const draft: CustomFollowUp = { attempts: 3, daysBetween: [1, 3, 3], channel: "same", businessHoursOnly: true };
    const stored = (await withSystem((db) => db.query<{ c: CustomFollowUp }>(`select '{"attempts":3,"daysBetween":[1,3],"channel":"same","businessHoursOnly":true}'::jsonb as c`))).rows[0].c;
    expect(JSON.stringify(stored)).not.toBe(JSON.stringify(draft));
    expect(sameCustomFollowUp(draft, stored)).toBe(true);
    expect(sameCustomFollowUp(draft, { ...stored, businessHoursOnly: false })).toBe(false);
    expect(sameCustomFollowUp(draft, { ...stored, daysBetween: [1, 2] })).toBe(false);
    expect(sameCustomFollowUp(draft, { ...stored, attempts: 2 })).toBe(false);
    expect(sameCustomFollowUp(null, null)).toBe(true);
    expect(sameCustomFollowUp(draft, null)).toBe(false);
  });

  it("opens the screen with nothing to save after Custom was saved", async () => {
    const m = await messagingOrg({ name: "Custom Style Co" });
    const owner = memberActor(m.ctx("owner"));
    await saveFollowUpSettings(owner, { preset: "custom", custom: { attempts: 3, daysBetween: [1, 3], channel: "same", businessHoursOnly: true } });
    const page = html(await FollowUpsView({ actor: owner, scope: await scopeFor(owner, "/crm") }));
    expect(page).toContain("Save follow-up style");
    expect(page).not.toContain("Discard changes");
  });
});

// ---------------------------------------------------------------------------
// 19 · Relative times are hydration-safe
// ---------------------------------------------------------------------------

describe("19: relative times sit directly in an element that expects them to differ between server and browser", () => {
  it("renders the words directly inside a <time> that suppresses the hydration warning", () => {
    const iso = new Date(Date.now() - 3 * 60_000).toISOString();
    const el = RelativeTime({ iso, timezone: "UTC" }) as React.ReactElement<{ suppressHydrationWarning?: boolean; dateTime?: string; children?: unknown }>;
    expect(el.type).toBe("time");
    expect(el.props.suppressHydrationWarning).toBe(true);
    expect(el.props.dateTime).toBe(iso);
    expect(typeof el.props.children).toBe("string");
    expect(html(el)).toMatch(/<time datetime="[^"]+" title="[^"]+">3 minutes ago<\/time>/i);
  });

  it("is used for every relative time on the Phase 4 screens (no clock-dependent text a level too deep)", () => {
    const files = [
      "src/components/crm/workflows/runs-list.tsx", "src/components/crm/workflows/workflows-list.tsx", "src/components/crm/workflows/workflow-editor.tsx",
      "src/components/crm/agent-tools/ai-tools-screen.tsx", "src/components/crm/assignment/assignment-workspace.tsx", "src/components/crm/followups/followups-workspace.tsx",
      "src/components/crm/developer/api-keys-section.tsx", "src/components/crm/developer/webhooks-section.tsx", "src/components/crm/opportunities-table.tsx",
    ];
    for (const f of files) {
      const src = fs.readFileSync(path.resolve(import.meta.dirname, "..", f), "utf8");
      expect(src, f).not.toMatch(/\brelativeTime\(/);
      expect(src, f).toContain("<RelativeTime");
    }
  });
});

// ---------------------------------------------------------------------------
// 20, 21, 25 · The workflow list: phone layout, status counters, approval badges
// ---------------------------------------------------------------------------

describe("20, 21, 25: the workflow list", () => {
  const item = (over: Partial<WorkflowListItem>): WorkflowListItem => ({
    id: U(100), name: "Welcome", description: null, status: "draft", folderId: null, folderName: null, triggerType: "contact.created", triggerSummary: "Contact created", stepCount: 2,
    publishedVersion: 1, unpublishedChanges: false, approval: "not_needed", effects: [], lastRunAt: null, runsToday: 0, failuresToday: 0, updatedAt: new Date().toISOString(), ...over,
  });
  let page = "";
  beforeAll(async () => {
    const o = await crmOrg({ name: "List Co" });
    const owner = o.actor("owner");
    const workflows = [
      item({ id: U(101), name: "Declined one", approval: "rejected", effects: ["send_sms"], status: "paused" }),
      item({ id: U(102), name: "Lapsed one", approval: "expired", effects: ["send_sms"] }),
      item({ id: U(103), name: "Needs one", approval: "needed", effects: ["send_sms"] }),
      item({ id: U(104), name: "Waiting one", approval: "pending", effects: ["send_sms"] }),
      item({ id: U(105), name: "Approved one", approval: "approved", effects: ["send_sms"], status: "active", lastRunAt: new Date(Date.now() - 60_000).toISOString() }),
      item({ id: U(106), name: "Plain one" }),
    ];
    page = html(React.createElement(WorkflowsList, { scope: await scopeFor(owner, "/crm"), workflows, templates: [], templateOptions: { tags: [], members: [], pipelines: [], templates: [] }, folders: [], canManage: true, initialStatus: "" }));
  });
  const row = (name: string) => {
    const at = page.indexOf(`>${name}<`);
    const start = page.lastIndexOf("<li", at);
    return page.slice(start, page.indexOf("</li>", at));
  };

  it("21: status counters are a group of toggle buttons, with no definition list around them", () => {
    expect(page).toContain('role="group" aria-label="Workflows by status"');
    expect(page).not.toContain("<dl");
    expect(page).not.toContain("<dt");
    expect(page).toMatch(/<button[^>]*aria-pressed="false"[^>]*><span[^>]*>Active<\/span><span[^>]*>1<\/span><\/button>/);
  });

  it("25: shows every approval state that keeps a workflow from running", () => {
    expect(row("Declined one")).toContain("Approval declined");
    expect(row("Lapsed one")).toContain("Approval expired");
    expect(row("Needs one")).toContain("Needs owner approval");
    expect(row("Waiting one")).toContain("Approval requested");
    for (const name of ["Approved one", "Plain one"]) expect(row(name)).not.toMatch(/Approval|approval/);
  });

  it("20: on phones the name keeps the first cell and the status badge sits with it, not in the name's place", () => {
    const r = row("Declined one");
    const cells = [...r.matchAll(/<(?:div|p) class="([^"]*)"/g)].map((x) => x[1]);
    // The name block is pinned to the first cell; only it and the actions menu claim the first row.
    expect(cells[0]).toMatch(/\bcol-start-1\b/);
    expect(cells[0]).toMatch(/\brow-start-1\b/);
    expect(r.match(/\brow-start-1\b/g)).toHaveLength(2);
    expect(r).toMatch(/class="col-start-2 row-start-1[^"]*"/);
    // The badge shows next to the name below md and in its own column from md up.
    expect(r).toMatch(/<span class="md:hidden">[^]*?Paused/);
    expect(r).toMatch(/<div class="hidden md:block">[^]*?Paused/);
    expect(row("Approved one")).toMatch(/<time datetime="[^"]+" title="[^"]+">1 minute ago<\/time>/i);
  });
});

// ---------------------------------------------------------------------------
// 22 · Template gallery selects have names
// ---------------------------------------------------------------------------

describe("22: the template gallery's pipeline and stage selects have accessible names", () => {
  it("names both selects after the choice they belong to", () => {
    const input = { key: "stage", label: "Stage for new deals", help: "Where new deals start.", kind: "open_stage" as const, required: true };
    const options = { tags: [], members: [], pipelines: [{ id: U(3), name: "Sales", stages: [{ id: U(4), name: "New", kind: "open" as const }] }], templates: [] };
    const page = html(React.createElement(TemplateInput, { input, value: null, options, error: null, onChange: () => undefined }));
    expect(page).toMatch(/<select[^>]*id="wf-tpl-in-stage-pipe"[^>]*aria-label="Stage for new deals: pipeline"|<select[^>]*aria-label="Stage for new deals: pipeline"[^>]*id="wf-tpl-in-stage-pipe"/);
    expect(page).toContain('aria-label="Stage for new deals: stage"');
    // Without a label, SinglePick stays named by its <label for>.
    expect(html(React.createElement(SinglePick, { id: "x", value: null, onChange: () => undefined, options: [], placeholder: "Pick" }))).not.toContain("aria-label");
  });
});

// ---------------------------------------------------------------------------
// 23, 24 · Step cards: problems in their names; focus after removing one
// ---------------------------------------------------------------------------

describe("23, 24: step cards", () => {
  const steps = [step("a", "add_tag", { tagIds: [] }, "b"), step("b", "assign", { subject: "contact", to: "rule", ruleId: U(70), onlyIfUnassigned: true }, "c"), step("c", "end", {})];
  const canvas = (issues: Record<string, CanvasIssue[]>) => {
    const layout = layoutCanvas(steps);
    return html(React.createElement(WorkflowCanvas, {
      items: layout.items, kinds: Object.fromEntries(steps.map((s) => [s.key, s.kind])), summaries: { a: "Choose tags", b: "Assign through a rule", c: "Stop" }, issues,
      numbers: Object.fromEntries(orderedKeys(layout.items).map((k, i) => [k, i + 1])), trigger: { title: "Started by hand", summary: "", issues: [] }, selected: null, onSelect: () => undefined,
      readOnly: false, onRemove: () => undefined,
    }));
  };

  it("23: a step button uses its visible label and includes its problem text", () => {
    const page = canvas({ b: [{ severity: "error", message: "That assignment rule is no longer active." }], a: [{ severity: "warning", message: "Adds the tag that starts it." }] });
    expect(page).toContain('data-step-card="b"');
    expect(page).toContain('data-step-card="a"');
    expect(page).not.toContain('aria-label="Step 2: Assign owner');
    expect(page).toContain("Assign owner");
    expect(page).toContain("Assign through a rule");
    expect(page).toContain("That assignment rule is no longer active.");
    expect(page).toContain("Adds the tag that starts it.");
  });

  it("24: focus goes to the step that led to the removed one, or the trigger", () => {
    expect(focusTargetAfterRemove(steps, "b")).toBe("a");
    expect(focusTargetAfterRemove(steps, "a")).toBe("trigger");
    const branchy = [
      step("w", "wait", { mode: "duration", amount: 1, unit: "days" }, "br"),
      step("br", "branch", { subject: "contact", filter: { op: "and", conditions: [] } }, null, { branches: { yes: "y", no: "n" } }),
      step("y", "add_tag", { tagIds: [] }, "j"),
      step("n", "add_tag", { tagIds: [] }, "j"),
      step("j", "end", {}),
    ];
    expect(focusTargetAfterRemove(branchy, "y")).toBe("br");
    expect(focusTargetAfterRemove(branchy, "br")).toBe("w");
    // The join's predecessors that survive: y and n both lead to it.
    expect(["y", "n"]).toContain(focusTargetAfterRemove(branchy, "j"));
    // Every card can be found to receive that focus.
    const page = canvas({});
    for (const k of ["trigger", "a", "b", "c"]) expect(page).toContain(`data-step-card="${k}"`);
  });
});

// ---------------------------------------------------------------------------
// 26 · The inbound URL for people who can only look
// ---------------------------------------------------------------------------

describe("26: viewers are told the inbound URL is hidden from them, not that it doesn't exist yet", () => {
  const trigger = { type: "inbound_webhook" as const, inbound: { nonce: "n".repeat(24), match: "email_or_phone" as const, createContact: false } };
  const triggerPanel = (props: { inboundUrl: string | null; inboundHidden?: boolean }) =>
    html(React.createElement(TriggerPanel, { trigger, options: editorOptions(), issues: [], readOnly: true, onChange: () => undefined, ...props }));

  it("says only people who can change the workflow see its URL", () => {
    expect(triggerPanel({ inboundUrl: null, inboundHidden: true })).toContain("Only people who can change this workflow can see its URL.");
    expect(triggerPanel({ inboundUrl: null, inboundHidden: true })).not.toContain("once a version with this trigger is published");
    expect(triggerPanel({ inboundUrl: null })).toContain("The URL appears here once a version with this trigger is published.");
  });

  it("the workflow screen marks the URL hidden for viewers of a published inbound workflow", async () => {
    const o = await crmOrg({ name: "Inbound View Co" });
    const owner = o.actor("owner");
    const tag = await createTag(owner, { name: "From form" });
    const { id } = await createWorkflow(owner, { name: "Inbound", definition: { trigger, steps: [step("tag", "add_tag", { tagIds: [tag.id] })] } });
    await publishWorkflow(owner, id);
    const viewer: CrmActor = { ...owner, can: (p) => p !== "workflows.manage" && owner.can(p) };
    // The server view returns the editor element; its props are what the browser gets.
    const props = async (actor: CrmActor) => ((await WorkflowView({ actor, scope: await scopeFor(actor, "/crm"), id, searchParams: {} })) as React.ReactElement<{ workflow: EditorWorkflow }>).props.workflow;
    expect(await props(viewer)).toMatchObject({ inboundUrl: null, inboundHidden: true });
    const own = await props(owner);
    expect(own.inboundUrl).toMatch(/^https?:\/\//);
    expect(own.inboundHidden).toBe(false);
  });
});
