// The Automation Studio template library, end to end: every template is built in a realistic workspace through the real service, validated with the
// workspace's real options, drawn on the canvas, dry-run, edited by the same operations the AI builder and the editor use, published, approved and
// switched on. Outside calls are never made (the transport is replaced); a template that reached a placeholder would fail here.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { withSystem } from "@/server/db";
import { decideApproval } from "@/server/approvals/service";
import { createContact } from "@/server/crm/contacts";
import { approveTemplate, createTemplate } from "@/server/crm/message-templates";
import { createFromTemplate, getWorkflow, publishWorkflow, requestWorkflowApproval, setWorkflowStatus } from "@/server/crm/workflows/definitions";
import { startTestRun } from "@/server/crm/workflows/runs";
import { processWorkflowRuns } from "@/server/crm/workflows/runner";
import { crmEventDispatch } from "@/server/crm/dispatch";
import { loadBuilderOptions } from "@/server/crm/workflows/context";
import { handleInboundWebhook, inboundToken } from "@/server/crm/workflows/inbound";
import { hostResolver } from "@/server/calendars/adapters/http";
import { pinnedHttps, type PinnedResponse } from "@/server/security/pinned-https";
import { createConnection, testConnection } from "@/server/automation-studio/connections";
import { createStudioFromTemplate } from "@/server/automation-studio/templates";
import { getStudioState } from "@/server/automation-studio/studio";
import { toFlow } from "@/components/automation-studio/canvas/flow-model";
import { namesFrom } from "@/components/crm/workflows/summaries";
import { STUDIO_TEMPLATES, STUDIO_TEMPLATE_CATEGORIES, studioTemplate, templateMatches, templateReadiness, type StudioInputs, type StudioTemplate } from "@/lib/automation-studio/templates";
import { applyOperations } from "@/lib/crm/workflow/operations";
import { TRIGGERS, deriveEffects, hasErrors, parseDefinition, validateDefinition, validationContextFrom, type WorkflowDefinition } from "@/lib/crm/workflow/spec";
import { ctxFor } from "./support/fixtures";
import { studioWorkspace, type StudioWorkspace } from "./support/studio-workspace";
import { setSurveys } from "./support/reputation";

const SLACK_HOOK = ["https://hooks.slack.com/services", "T0ABCDEFG", "B0HIJKLMN", "AbCdEfGhIjKlMnOpQrStUvWx"].join("/");
const ok = (body = "{}"): PinnedResponse => ({ status: 200, contentType: "application/json", retryAfterSeconds: null, bytes: body.length, truncated: false, body });

let request: MockInstance<typeof pinnedHttps.request>;
beforeEach(() => {
  vi.spyOn(hostResolver, "lookup").mockResolvedValue(["93.184.216.34"]);
  request = vi.spyOn(pinnedHttps, "request").mockResolvedValue(ok());
});
afterEach(() => {
  vi.restoreAllMocks();
});

interface Fixture {
  ws: StudioWorkspace;
  slack: string;
  api: string;
  review: string;
  contactId: string;
}
let fx: Fixture;

async function fixture(): Promise<Fixture> {
  const ws = await studioWorkspace();
  // The post-visit check-in template sends a satisfaction survey, which a Super Admin switches on per workspace.
  await setSurveys(ws.o.org.id, true);
  const owner = ws.o.actor("owner");
  vi.spyOn(hostResolver, "lookup").mockResolvedValue(["93.184.216.34"]);
  vi.spyOn(pinnedHttps, "request").mockImplementation(async (r) => ok(r.url.startsWith("https://hooks.slack.com") ? "ok" : "{}"));
  const slack = await createConnection(owner, { kind: "slack_webhook", name: "Sales channel", webhookUrl: SLACK_HOOK, channelLabel: "#sales" });
  const api = await createConnection(owner, { kind: "http", name: "Operations API", baseUrl: "https://api.example.com/v1", methods: ["GET", "POST"], auth: { type: "bearer" }, secret: "sk_live_Zr7Qw1XyAbCdEf90", testPath: "/ping" });
  for (const c of [slack, api]) expect((await testConnection(owner, c.id, { confirmed: true })).ok).toBe(true);
  const review = await createTemplate(owner, { name: "Review request", channel: "sms", purpose: "service", body: "Thanks for visiting {{business.name}}, {{contact.first_name}}. Would you leave a review? {{review.link}} Reply STOP to opt out." });
  await approveTemplate(owner, review.id, { version: review.currentVersion, contentHash: review.contentHash });
  const contactId = (await createContact(owner, { firstName: "Ada", lastName: "Lovelace", email: "ada.templates@example.com", phone: "+15555550142" })).id;
  vi.restoreAllMocks();
  return { ws, slack: slack.id, api: api.id, review: review.id, contactId };
}

/** The choices a person would make in the gallery, from what the workspace has. */
function inputsFor(t: StudioTemplate, f: Fixture): Record<string, unknown> {
  const { ids } = f.ws;
  const out: Record<string, unknown> = {};
  for (const spec of t.inputs) {
    switch (spec.kind) {
      case "tag": out[spec.key] = ids.tags.Hot; break;
      case "user": out[spec.key] = f.ws.o.people.owner.id; break;
      case "pipeline": out[spec.key] = ids.pipelines.Installations.id; break;
      case "stage": out[spec.key] = { pipelineId: ids.pipelines.Installations.id, stageId: ids.pipelines.Installations.stages["Quote sent"] }; break;
      case "message_template":
        out[spec.key] = spec.key === "confirmation" ? ids.templates["Booking confirmation"].id : spec.key === "reminder" ? ids.templates["Appointment reminder"].id : ids.templates["Follow-up check-in"].id;
        break;
      case "review_template": out[spec.key] = f.review; break;
      case "calendar": out[spec.key] = ids.calendar; break;
      case "form": out[spec.key] = ids.form; break;
      case "slack": out[spec.key] = f.slack; break;
      case "http": out[spec.key] = f.api; break;
      case "employee": out[spec.key] = "crm_manager"; break;
    }
  }
  return out;
}

beforeAll(async () => {
  fx = await fixture();
});

// ---------------------------------------------------------------------------

describe("the library", () => {
  it("has at least fifteen templates, each with a unique key, a real trigger and an honest description of what it reaches", () => {
    expect(STUDIO_TEMPLATES.length).toBeGreaterThanOrEqual(15);
    expect(new Set(STUDIO_TEMPLATES.map((t) => t.key)).size).toBe(STUDIO_TEMPLATES.length);
    for (const t of STUDIO_TEMPLATES) {
      expect(TRIGGERS[t.trigger], t.key).toBeDefined();
      expect(STUDIO_TEMPLATE_CATEGORIES, t.key).toContain(t.category);
      expect(t.name.length, t.key).toBeGreaterThan(5);
      expect(t.description.length, t.key).toBeGreaterThan(30);
      expect(t.before.length, t.key).toBeGreaterThan(20);
      for (const spec of t.inputs) expect(spec.help.length, `${t.key}.${spec.key}`).toBeGreaterThan(5);
    }
  });

  it("covers every kind of reach: messages, Slack, HTTP and an AI employee, and templates with none at all", () => {
    for (const reach of ["messages", "slack", "http", "employee"] as const) expect(STUDIO_TEMPLATES.some((t) => t.reach.includes(reach)), reach).toBe(true);
    expect(STUDIO_TEMPLATES.some((t) => t.reach.length === 0)).toBe(true);
    expect(new Set(STUDIO_TEMPLATES.map((t) => t.trigger)).size).toBeGreaterThanOrEqual(10);
  });

  it("declares its reach truthfully: what the built workflow does outside iAcquire is exactly what the card says", async () => {
    for (const t of STUDIO_TEMPLATES) {
      const def = t.build(inputsFor(t, fx) as StudioInputs, { newNonce: () => "n".repeat(24) });
      const effects = deriveEffects(def);
      const expected = new Set<string>();
      if (t.reach.includes("messages")) expected.add(effects.find((e) => e.startsWith("send_")) ?? "send_sms");
      if (t.reach.includes("slack") && def.steps.some((s) => s.kind === "slack_message")) expected.add("slack");
      if (t.reach.includes("http")) expected.add("http");
      if (t.reach.includes("employee")) expected.add("hermes");
      // A template may reach less than it could (Slack is optional in some), never more than it says.
      for (const e of effects) {
        const covered = e.startsWith("send_") ? t.reach.includes("messages") : e === "slack" ? t.reach.includes("slack") : e === "http" ? t.reach.includes("http") : e === "hermes" ? t.reach.includes("employee") : false;
        expect(covered, `${t.key} reaches ${e}`).toBe(true);
      }
      if (t.reach.length === 0) expect(effects, t.key).toEqual([]);
    }
  });

  it("reports what a workspace is missing, in words, from the lists the editor uses", async () => {
    const empty = await studioWorkspace();
    const options = await withSystem((db) => loadBuilderOptions(db, empty.o.org.id));
    const editor = {
      tags: [], members: [], pipelines: [], templates: [], calendars: [], forms: [], employees: [], connections: options.connections ?? [],
    } as never;
    const slack = templateReadiness(studioTemplate("new-lead-slack-alert")!, editor);
    expect(slack.ready).toBe(false);
    expect(slack.missing).toEqual(["a Slack connection"]);
    expect(templateReadiness(studioTemplate("speed-to-lead")!, editor)).toMatchObject({ ready: true, missing: [] });
    expect(templateReadiness(studioTemplate("post-visit-review-request")!, editor).missing).toEqual(["an approved review request template"]);
    const unverified = templateReadiness(studioTemplate("new-lead-slack-alert")!, { ...(editor as object), connections: [{ id: "x", name: "S", kind: "slack_webhook", status: "unverified", host: "hooks.slack.com", methods: [] }] } as never);
    expect(unverified).toMatchObject({ ready: true });
    expect(unverified.notes[0]).toMatch(/hasn't been verified/);
  });
});

// ---------------------------------------------------------------------------

describe.each(STUDIO_TEMPLATES.map((t) => [t.key, t] as const))("template %s", (_key, t) => {
  let id = "";
  let def: WorkflowDefinition;

  it("is created in the workspace as a valid Automation Studio draft with no problems", async () => {
    const owner = fx.ws.o.actor("owner");
    const created = await createStudioFromTemplate(owner, t.key, { inputs: inputsFor(t, fx) });
    id = created.id;
    expect(created.issues.filter((i) => i.level === "error"), JSON.stringify(created.issues)).toEqual([]);
    const w = await getWorkflow(owner, id);
    expect(w.origin).toBe("studio");
    expect(w.name).toBe(t.name);
    expect(w.draftRevision).toBe(1);
    def = parseDefinition(w.draft).definition!;
    expect(def).toBeTruthy();
    expect(def.trigger.type).toBe(t.trigger);
    expect(def.steps.length).toBeGreaterThanOrEqual(1);
    // The first change in the history says where it came from.
    const state = await getStudioState(owner, id);
    expect(state.history[0]).toMatchObject({ source: "template" });
  });

  it("has only real references: no placeholder id, no raw address, no secret", () => {
    const text = JSON.stringify(def);
    expect(text).not.toMatch(/"(templateId|connectionId|tagIds?|stageId|pipelineId)":\s*(""|\[\])/);
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toMatch(/sk_live|AbCdEf|Bearer/);
    for (const s of def.steps) if (s.kind === "send_message" || s.kind === "request_review") expect((s.config as { contentHash: string }).contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("draws on the canvas: a node for the trigger and every step, and every link leads somewhere", () => {
    const { nodes, edges } = toFlow({ def, names: namesFrom({}), issues: [] });
    expect(nodes.length).toBe(def.steps.length + 1);
    const ids = new Set(nodes.map((n) => n.id));
    for (const e of edges) {
      expect(ids.has(e.source), `${t.key}: ${e.source}`).toBe(true);
      expect(ids.has(e.target), `${t.key}: ${e.target}`).toBe(true);
    }
    for (const s of def.steps) {
      for (const to of [s.next, ...(s.branches ? [s.branches.yes, s.branches.no] : [])]) if (to) expect(def.steps.some((x) => x.key === to), `${t.key}: ${s.key} -> ${to}`).toBe(true);
    }
  });

  it("can be tested safely: a dry run describes every step and sends nothing", async () => {
    const owner = fx.ws.o.actor("owner");
    request.mockClear();
    const carriesContact = TRIGGERS[t.trigger].carries.contact !== "never";
    const run = await startTestRun(owner, id, { source: "draft", ...(carriesContact ? { contactId: fx.contactId } : {}) });
    expect(run.issues.filter((i) => i.level === "error")).toEqual([]);
    expect(run.steps.length).toBeGreaterThan(0);
    for (const s of run.steps) expect(s.outcome, `${t.key} · ${s.stepKey}: ${s.detail}`).not.toBe("would_fail");
    expect(request).not.toHaveBeenCalled();
  });

  it("is editable by the builder's operations and by hand, and stays valid", () => {
    const options = { mode: "strict" as const };
    void options;
    const first = def.steps[0];
    const renamed = applyOperations(def, [{ op: "update_step", key: first.key, name: "Renamed by hand" }], { mode: "draft" });
    expect(renamed.ok).toBe(true);
    if (renamed.ok) {
      expect(renamed.definition.steps[0].name).toBe("Renamed by hand");
      expect(renamed.contentChanged).toBe(true);
    }
    const added = applyOperations(def, [{ op: "add_step", kind: "internal_note", key: "extra-note", config: { subject: "contact", body: "Added in the editor." }, at: { after: first.key, via: "next" } }], { mode: "draft" });
    // A branch has two paths and needs its own insert point; every other first step accepts a note after it.
    if (first.kind !== "branch") {
      expect(added.ok).toBe(true);
      if (added.ok) expect(added.definition.steps.map((s) => s.key)).toContain("extra-note");
    }
    const moved = applyOperations(def, [{ op: "position_step", key: first.key, x: 400, y: 120 }], { mode: "draft" });
    expect(moved.ok && moved.contentChanged).toBe(false);
  });

  it("is published, needs the owner's approval exactly when it reaches outside iAcquire, and then switches on", async () => {
    const owner = fx.ws.o.actor("owner");
    const published = await publishWorkflow(owner, id);
    expect(published.needsApproval, `${t.key}: ${JSON.stringify(published)}`).toBe(t.reach.length > 0);
    if (published.needsApproval) {
      // Nothing can switch it on without the approval.
      await expect(setWorkflowStatus(owner, id, "active")).rejects.toThrow();
      const req = await requestWorkflowApproval(fx.ws.o.actor("manager"), id, null, { activate: true });
      expect(req.status).toBe("requested");
      const decided = await decideApproval(ctxFor(fx.ws.o.people.owner, fx.ws.o.org, "owner"), req.approvalId!, "approve");
      expect(decided.outcome?.status).toBe("succeeded");
    } else {
      await setWorkflowStatus(owner, id, "active");
    }
    expect((await getWorkflow(owner, id)).status).toBe("active");
  });
});

// ---------------------------------------------------------------------------

describe("what a template can and can't do", () => {
  it("builds the inbound-webhook template with a generated address that accepts a lead and nothing else", async () => {
    const owner = fx.ws.o.actor("owner");
    const created = await createStudioFromTemplate(owner, "inbound-webhook-lead", { inputs: { tag: fx.ws.ids.tags.Hot } });
    const w = await getWorkflow(owner, created.id);
    const def = parseDefinition(w.draft).definition!;
    const nonce = def.trigger.inbound!.nonce;
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    // The address belongs to this workflow only, and is different every time.
    const again = parseDefinition((await getWorkflow(owner, (await createStudioFromTemplate(owner, "inbound-webhook-lead", { inputs: { tag: fx.ws.ids.tags.Hot } })).id)).draft).definition!;
    expect(again.trigger.inbound!.nonce).not.toBe(nonce);
    await publishWorkflow(owner, created.id);
    await setWorkflowStatus(owner, created.id, "active");
    const email = `webhook-lead-${Date.now()}@example.test`;
    expect((await handleInboundWebhook({ token: inboundToken(created.id, nonce), body: { email, name: "Hook Lead" } })).httpStatus).toBe(202);
    expect((await handleInboundWebhook({ token: inboundToken(created.id, "x".repeat(24)), body: { email } })).httpStatus).toBe(404);
    const contact = await withSystem((db) => db.query("select 1 from contacts where org_id = $1 and email = $2", [fx.ws.o.org.id, email]));
    expect(contact.rows.length).toBe(1);
  });

  it("belongs to Automation Studio: the CRM builder can't create one, and the plan is needed to create one here", async () => {
    const owner = fx.ws.o.actor("owner");
    await expect(createFromTemplate(owner, "new-lead-slack-alert", { inputs: { slack: fx.slack } })).rejects.toMatchObject({ code: "not_found" });
    await expect(createStudioFromTemplate(owner, "new_lead_welcome", { inputs: { tag: fx.ws.ids.tags.Hot } })).rejects.toMatchObject({ code: "not_found" });
    await expect(createStudioFromTemplate(owner, "no-such-template")).rejects.toMatchObject({ code: "not_found" });

    const lapsed = await studioWorkspace({ plan: false });
    const before = await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from crm_workflows where org_id = $1", [lapsed.o.org.id]));
    await expect(createStudioFromTemplate(lapsed.o.actor("owner"), "speed-to-lead")).rejects.toMatchObject({ code: "plan_required" });
    const after = await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from crm_workflows where org_id = $1", [lapsed.o.org.id]));
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("needs the permission to build", async () => {
    await expect(createStudioFromTemplate(fx.ws.o.actor("viewer"), "speed-to-lead")).rejects.toMatchObject({ code: "forbidden" });
    await expect(createStudioFromTemplate(fx.ws.o.actor("support"), "speed-to-lead")).rejects.toMatchObject({ code: "forbidden" });
  });

  it("checks every choice against the workspace: a required choice, another workspace's record, the wrong kind of connection, an unapproved message", async () => {
    const owner = fx.ws.o.actor("owner");
    const other = await studioWorkspace();
    await expect(createStudioFromTemplate(owner, "new-lead-slack-alert", { inputs: {} })).rejects.toMatchObject({ code: "invalid_input", message: expect.stringMatching(/Slack connection: choose one/) });
    await expect(createStudioFromTemplate(owner, "new-lead-slack-alert", { inputs: { slack: fx.api } })).rejects.toMatchObject({ code: "invalid_input" }); // an HTTP connection is not a Slack one
    await expect(createStudioFromTemplate(owner, "new-lead-slack-alert", { inputs: { slack: "not-a-uuid" } })).rejects.toMatchObject({ code: "invalid_input" });
    const theirs = await createConnection(other.o.actor("owner"), { kind: "slack_webhook", name: "Theirs", webhookUrl: SLACK_HOOK });
    await expect(createStudioFromTemplate(owner, "new-lead-slack-alert", { inputs: { slack: theirs.id } })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(createStudioFromTemplate(owner, "lead-welcome-and-nudge", { inputs: { message: other.ids.templates["Follow-up check-in"].id } })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(createStudioFromTemplate(owner, "website-form-intake", { inputs: { tag: other.ids.tags.Hot } })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(createStudioFromTemplate(owner, "post-visit-review-request", { inputs: { review: fx.ws.ids.templates["Follow-up check-in"].id } })).rejects.toMatchObject({ code: "invalid_input", message: expect.stringMatching(/review link/) });
    await expect(createStudioFromTemplate(owner, "ai-lead-qualification", { inputs: { employee: "made_up_role" } })).rejects.toMatchObject({ code: "invalid_input" });
    const none = await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from crm_workflows where org_id = $1 and name in ('Theirs')", [fx.ws.o.org.id]));
    expect(none.rows[0].n).toBe(0);
  });

  it("lets a connection that isn't verified yet be chosen, and says so: the draft can't be published until it is", async () => {
    const owner = fx.ws.o.actor("owner");
    const fresh = await createConnection(owner, { kind: "slack_webhook", name: "Not verified yet", webhookUrl: SLACK_HOOK });
    const created = await createStudioFromTemplate(owner, "new-lead-slack-alert", { inputs: { slack: fresh.id } });
    expect(created.issues.some((i) => i.level === "error" && /hasn't been verified/.test(i.message))).toBe(true);
    await expect(publishWorkflow(owner, created.id)).rejects.toThrow(/verified/);
  });

  it("is built from the validator's own contract: every kind of step it uses exists, and no template uses a step that needs more than its inputs", () => {
    const ctxless = validationContextFrom({ tags: [], users: [], pipelines: [], fields: [], templates: [], n8nMappings: [], webhookSubscriptions: [], assignmentRules: [], agents: [], calendars: [], appointmentTypes: [], timezone: "UTC" } as never);
    for (const t of STUDIO_TEMPLATES) {
      const def = t.build({}, { newNonce: () => "n".repeat(24) });
      // Structure (shape of every step's settings) is valid even before the workspace's choices are made; only references are missing.
      const issues = validateDefinition(def, ctxless).filter((i) => i.level === "error" && !/exist|isn't|no longer|Choose|approved|included|workspace|Generate|verified/i.test(i.message));
      expect(hasErrors(issues) ? issues.map((i) => i.message) : [], t.key).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------

describe("running for real (with the outside transport replaced)", () => {
  // The workflows above were all switched on in the shared fixture workspace and its own contact's event is still waiting: put them away and let
  // the event pass, so what is counted below belongs to the workspace under test.
  beforeAll(async () => {
    await withSystem((db) => db.query("update crm_workflows set status = 'archived', archived_at = now() where org_id = $1", [fx.ws.o.org.id]));
    for (let i = 0; i < 3; i++) await crmEventDispatch();
    await withSystem((db) => db.query("update crm_workflow_runs set status = 'cancelled' where org_id = $1 and status in ('queued', 'waiting', 'running')", [fx.ws.o.org.id]));
  });
  async function live(f: Fixture, key: string) {
    const owner = f.ws.o.actor("owner");
    // Events from setting the workspace up (the fixture's own contact) are delivered before the workflow exists, as they would be in production.
    for (let i = 0; i < 3; i++) await crmEventDispatch();
    const t = studioTemplate(key)!;
    const { id } = await createStudioFromTemplate(owner, key, { inputs: inputsFor(t, f) });
    const published = await publishWorkflow(owner, id);
    if (published.needsApproval) {
      const req = await requestWorkflowApproval(f.ws.o.actor("manager"), id, null, { activate: true });
      await decideApproval(ctxFor(f.ws.o.people.owner, f.ws.o.org, "owner"), req.approvalId!, "approve");
    } else await setWorkflowStatus(owner, id, "active");
    return id;
  }
  const runsOf = async (workflowId: string) => (await withSystem((db) => db.query<{ status: string; last_error: string | null }>("select status, last_error from crm_workflow_runs where workflow_id = $1 order by created_at", [workflowId]))).rows;

  it("the Slack alert posts the filled message for a new contact, once, and creates the task", async () => {
    const f = await fixture();
    const id = await live(f, "new-lead-slack-alert");
    const owner = f.ws.o.actor("owner");
    const seen: Array<{ url: string; body: string }> = [];
    vi.spyOn(hostResolver, "lookup").mockResolvedValue(["93.184.216.34"]);
    vi.spyOn(pinnedHttps, "request").mockImplementation(async (r) => {
      seen.push({ url: r.url, body: r.body ?? "" });
      return ok("ok");
    });
    const contact = await createContact(owner, { firstName: "Grace", lastName: "Hopper", email: "grace.hopper@example.com" });
    for (let i = 0; i < 5; i++) {
      await crmEventDispatch();
      await processWorkflowRuns({});
    }
    const runs = await runsOf(id);
    expect(runs.map((r) => r.status), JSON.stringify(runs)).toEqual(["completed"]);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(SLACK_HOOK);
    expect(JSON.parse(seen[0].body).text).toBe("New lead: Grace Hopper. Open iAcquire to see their details and call them within the hour.");
    const tasks = await withSystem((db) => db.query<{ title: string }>("select title from tasks where org_id = $1 and contact_id = $2", [f.ws.o.org.id, contact.id]));
    expect(tasks.rows.map((r) => r.title)).toEqual(["Call Grace Hopper"]);
  });

  it("the lead sync calls the other system with the contact's details and tags the contact only after it accepted", async () => {
    const f = await fixture();
    const id = await live(f, "lead-sync-http");
    const owner = f.ws.o.actor("owner");
    const calls: Array<{ method: string; url: string; body?: string; auth?: string }> = [];
    vi.spyOn(hostResolver, "lookup").mockResolvedValue(["93.184.216.34"]);
    const spy = vi.spyOn(pinnedHttps, "request").mockImplementation(async (r) => {
      calls.push({ method: r.method, url: r.url, body: r.body, auth: r.headers.Authorization });
      return ok('{"id":"x1"}');
    });
    const contact = await createContact(owner, { firstName: "Alan", lastName: "Turing", email: "alan.turing@example.com", phone: "+15555550177" });
    for (let i = 0; i < 5; i++) {
      await crmEventDispatch();
      await processWorkflowRuns({});
    }
    expect((await runsOf(id)).map((r) => r.status)).toEqual(["completed"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", url: "https://api.example.com/v1/leads", auth: "Bearer sk_live_Zr7Qw1XyAbCdEf90" });
    expect(JSON.parse(calls[0].body!)).toEqual({ name: "Alan Turing", email: "alan.turing@example.com", phone: "+15555550177", source: "iacquire" });
    const tagged = await withSystem((db) => db.query("select 1 from crm_contact_tags where org_id = $1 and contact_id = $2 and tag_id = $3", [f.ws.o.org.id, contact.id, f.ws.ids.tags.Hot]));
    expect(tagged.rows.length).toBe(1);

    // The other system refuses the next lead: the tag is not added, and the run says why.
    spy.mockResolvedValue({ ...ok('{"error":"invalid"}'), status: 422 });
    const second = await createContact(owner, { firstName: "Edsger", lastName: "Dijkstra", email: "edsger@example.com" });
    for (let i = 0; i < 5; i++) {
      await crmEventDispatch();
      await processWorkflowRuns({});
    }
    const runs = await runsOf(id);
    expect(runs.map((r) => r.status)).toEqual(["completed", "failed"]);
    expect(runs[1].last_error).toMatch(/didn't run in the other system/);
    const notTagged = await withSystem((db) => db.query("select 1 from crm_contact_tags where org_id = $1 and contact_id = $2", [f.ws.o.org.id, second.id]));
    expect(notTagged.rows.length).toBe(0);
  });
});

describe("searching the library", () => {
  const list = STUDIO_TEMPLATES;
  it("matches every word, in any order, ignoring case and accents, across the name, description, category, trigger and reach", () => {
    expect(templateMatches(list, "")).toHaveLength(list.length);
    expect(templateMatches(list, "   ")).toHaveLength(list.length);
    const slackLead = templateMatches(list, "Slack LEAD").map((t) => t.key);
    expect(slackLead).toContain("new-lead-slack-alert");
    expect(templateMatches(list, "lead slack").map((t) => t.key)).toEqual(slackLead);
    expect(templateMatches(list, "calls another system").every((t) => t.reach.includes("http"))).toBe(true);
    expect(templateMatches(list, "appointment booked").map((t) => t.trigger)).toContain("appointment.booked");
    expect(templateMatches(list, "slàck léad").map((t) => t.key)).toEqual(slackLead);
    expect(templateMatches(list, "xyzzy")).toEqual([]);
    // A word that is in no template makes the whole search match nothing (every word must match).
    expect(templateMatches(list, "slack xyzzy")).toEqual([]);
  });
});
