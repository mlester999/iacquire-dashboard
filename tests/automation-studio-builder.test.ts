// The AI Automation Builder, end to end on the server with a scripted stand-in for the model: what it stores, what it streams, what it refuses,
// and that nothing the model writes can bypass validation, the plan, permissions or tenant boundaries. No real model, customer or provider is
// contacted; the model is a function that returns the text a real one would.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { createTag } from "@/server/crm/tags";
import { runBuilderTurn, builderAvailability, MAX_REPAIRS, type LlmPort } from "@/server/automation-studio/builder/service";
import { ReplyStreamer, parseOperationsJson } from "@/server/automation-studio/builder/output";
import { getStudioState, listStudioWorkflows, saveStudioDraft, startStudioWorkflow, titleFromPrompt } from "@/server/automation-studio/studio";
import { studioUsageSnapshot } from "@/server/automation-studio/usage";
import type { LlmConfig, LlmResolution, LlmStreamEvent, LlmStreamInput } from "@/server/llm/client";
import type { BuilderEvent } from "@/lib/automation-studio/types";
import type { WorkflowDefinition, WorkflowStep } from "@/lib/crm/workflow/spec";
import { uid } from "./support/fixtures";
import { crmOrg, type CrmOrg } from "./support/crm";

const FENCE = "```";
const ops = (reply: string, operations: unknown[]) => `${reply}\n${FENCE}operations\n${JSON.stringify(operations)}\n${FENCE}`;

const config: LlmConfig = { baseUrl: "https://llm.example.test/v1", format: "openai", model: "scripted", apiKey: "never-shown", source: "environment" };
const ready: LlmResolution = { config, reason: "ready", connectionStatus: "connected", provider: "scripted", model: "scripted", host: "llm.example.test" };
const missing: LlmResolution = { config: null, reason: "not_configured", connectionStatus: null, provider: null, model: null, host: null };

type Reply = string | ((input: LlmStreamInput, call: number) => string | Promise<string>);
/** A model that answers from a script, a few characters at a time like a real stream, and remembers what it was asked. */
function scripted(replies: Reply[], opts: { resolution?: LlmResolution; usage?: boolean; onChunk?: (n: number) => void | Promise<void> } = {}) {
  const requests: LlmStreamInput[] = [];
  const port: LlmPort & { requests: LlmStreamInput[] } = {
    requests,
    resolve: async () => opts.resolution ?? ready,
    async *stream(_c, input, signal): AsyncGenerator<LlmStreamEvent> {
      requests.push(input);
      const r = replies[Math.min(requests.length - 1, replies.length - 1)];
      const text = typeof r === "function" ? await r(input, requests.length) : r;
      for (let i = 0, n = 0; i < text.length; i += 9, n++) {
        if (signal?.aborted) throw new Error("aborted");
        await opts.onChunk?.(n);
        yield { type: "delta", text: text.slice(i, i + 9) };
      }
      if (opts.usage !== false) yield { type: "usage", inputTokens: 1000, outputTokens: 200 };
    },
  };
  return port;
}

async function grantPlan(o: CrmOrg) {
  await withSystem((db) =>
    db.query(
      "insert into maintenance_subscriptions (org_id, status, monthly_price_cents, monthly_request_allowance, terms_version, accepted_by, activated_at, billing_start_on) values ($1, 'active', 29900, 4, 'test', $2, now() - interval '30 days', current_date - 30)",
      [o.org.id, o.people.owner.id],
    ),
  );
}
async function collect(gen: AsyncGenerator<BuilderEvent>) {
  const events: BuilderEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}
const types = (events: BuilderEvent[]) => events.map((e) => e.type);
const doneMessage = (events: BuilderEvent[]) => (events.find((e) => e.type === "done") as Extract<BuilderEvent, { type: "done" }>).message;
const rows = async <T,>(sql: string, params: unknown[]) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows as T[];

async function startedWorkflow(o: CrmOrg, prompt?: string) {
  await grantPlan(o);
  return startStudioWorkflow(o.actor("owner"), { prompt });
}
const stateOf = (o: CrmOrg, id: string) => getStudioState(o.actor("owner"), id);

const WELCOME = [
  { op: "set_trigger", trigger: { type: "contact.created" } },
  { op: "add_step", kind: "create_task", key: "welcome", name: "Welcome the lead", config: { title: "Welcome {{contact.full_name}}", priority: "high", assignee: "contact_owner" }, at: { after: null } },
  { op: "add_step", kind: "wait", key: "wait_2d", name: "Wait 2 days", config: { mode: "duration", amount: 2, unit: "days" }, at: { after: "welcome", via: "next" } },
];

// ---------------------------------------------------------------------------
// Reading the model's output
// ---------------------------------------------------------------------------

describe("reading the model's output", () => {
  it("streams the reply and holds the operations block back, wherever the chunks fall", () => {
    const text = ops("Done. I added a welcome task.", [{ op: "remove_step", key: "a" }]);
    for (const size of [1, 2, 3, 5, 8, 13, 50]) {
      const s = new ReplyStreamer();
      let shown = "";
      for (let i = 0; i < text.length; i += size) shown += s.push(text.slice(i, i + size));
      const out = s.finish();
      expect(shown, `chunks of ${size}`).toBe("Done. I added a welcome task.\n");
      expect(shown).not.toMatch(/`|operations|remove_step/);
      expect(out.reply).toBe("Done. I added a welcome task.");
      expect(out.operations).toBe('[{"op":"remove_step","key":"a"}]');
      expect(out.truncated).toBe(false);
    }
  });

  it("shows everything when there is no block, including single backticks and a lone quote of code", () => {
    const s = new ReplyStreamer();
    const shown = s.push("Use the `Wait` step, then ") + s.push("it works.") + s.push("`");
    // A trailing backtick could begin a fence, so it is held until it is known not to.
    expect(shown).toBe("Use the `Wait` step, then it works.");
    expect(s.finish()).toMatchObject({ reply: "Use the `Wait` step, then it works.`", operations: null, truncated: false });
  });

  it("notices an answer that was cut off inside the block, and ignores other code blocks", () => {
    const cut = new ReplyStreamer();
    cut.push(`Sure.\n${FENCE}operations\n[{"op":"remove_step"`);
    expect(cut.finish()).toMatchObject({ reply: "Sure.", operations: null, truncated: true });
    const other = new ReplyStreamer();
    other.push(`Here is an example:\n${FENCE}sh\nrm -rf /\n${FENCE}`);
    expect(other.finish()).toMatchObject({ reply: "Here is an example:", operations: null, truncated: false });
  });

  it("parses JSON arrays only", () => {
    expect(parseOperationsJson("[1]")).toEqual({ ok: true, value: [1] });
    expect(parseOperationsJson("{}")).toMatchObject({ ok: false });
    expect(parseOperationsJson("[1,")).toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// Starting and saving
// ---------------------------------------------------------------------------

describe("starting an automation", () => {
  it("makes a Studio workflow, stores the first message as waiting, and puts nothing in a URL", async () => {
    const o = await crmOrg();
    await grantPlan(o);
    const { id, pendingMessageId } = await startStudioWorkflow(o.actor("owner"), { prompt: "Text new leads a welcome message and remind my team if nobody replies in two days" });
    const s = await stateOf(o, id);
    expect(s.workflow).toMatchObject({ origin: "studio", status: "draft", name: "Text new leads a welcome message and" });
    expect(s.messages).toEqual([expect.objectContaining({ id: pendingMessageId, role: "user", status: "pending" })]);
    expect(s.history.map((h) => h.label)).toEqual(["Started"]);
    expect((await listStudioWorkflows(o.actor("owner"))).map((w) => w.id)).toContain(id);
  });

  it("needs the plan, and nothing is created without it", async () => {
    const o = await crmOrg();
    await expect(startStudioWorkflow(o.actor("owner"), { prompt: "Welcome new leads" })).rejects.toMatchObject({ code: "plan_required" });
    expect((await rows("select 1 from crm_workflows where org_id = $1", [o.org.id])).length).toBe(0);
  });

  it("names it from the request", () => {
    expect(titleFromPrompt("Please can you remind me about unpaid invoices every Monday?")).toBe("Remind me about unpaid invoices every Monday");
    expect(titleFromPrompt("   ")).toBe("New automation");
    expect(titleFromPrompt("x".repeat(200)).length).toBeLessThanOrEqual(60);
  });
});

describe("saving from the editor", () => {
  const withStep = (def: WorkflowDefinition): WorkflowDefinition => ({ ...def, steps: [{ key: "note", kind: "internal_note", config: { subject: "contact", body: "Hi" }, next: null } as WorkflowStep] });

  it("saves, records the change, and refuses a save over someone else's newer one", async () => {
    const o = await crmOrg();
    const { id } = await startedWorkflow(o);
    const s0 = await stateOf(o, id);
    const saved = await saveStudioDraft(o.actor("owner"), id, { definition: withStep(s0.workflow.draft), expectedRevision: s0.workflow.draftRevision, source: "manual", label: "Added a note" });
    expect(saved).toMatchObject({ revision: s0.workflow.draftRevision + 1, seq: 2 });
    await expect(saveStudioDraft(o.actor("owner"), id, { definition: s0.workflow.draft, expectedRevision: s0.workflow.draftRevision, source: "manual", label: "Stale" })).rejects.toMatchObject({ code: "conflict" });
    expect((await stateOf(o, id)).history.map((h) => [h.seq, h.source, h.label])).toEqual([[1, "manual", "Started"], [2, "manual", "Added a note"]]);
  });

  it("does not record a save that changes nothing, and keeps only the newest hundred", async () => {
    const o = await crmOrg();
    const { id } = await startedWorkflow(o);
    let s = await stateOf(o, id);
    await saveStudioDraft(o.actor("owner"), id, { definition: s.workflow.draft, expectedRevision: s.workflow.draftRevision, source: "manual", label: "Nothing" });
    expect((await stateOf(o, id)).history.length).toBe(1);
    for (let i = 0; i < 104; i++) {
      s = await stateOf(o, id);
      await saveStudioDraft(o.actor("owner"), id, { definition: { ...s.workflow.draft, steps: [{ key: "note", kind: "internal_note", name: `Version ${i}`, config: { subject: "contact", body: "Hi" }, next: null } as WorkflowStep] }, expectedRevision: s.workflow.draftRevision, source: "manual", label: `Edit ${i}` });
    }
    const kept = await rows<{ n: number; lo: number }>("select count(*)::int as n, min(seq)::int as lo from automation_studio_changes where workflow_id = $1", [id]);
    expect(kept[0]).toMatchObject({ n: 100 });
  }, 60_000);

  it("is blocked for a workflow built in Automation Studio once the plan lapses, and for people who may not build automations", async () => {
    const o = await crmOrg();
    const { id } = await startedWorkflow(o);
    const s = await stateOf(o, id);
    await expect(saveStudioDraft(o.actor("viewer"), id, { definition: withStep(s.workflow.draft), expectedRevision: s.workflow.draftRevision, source: "manual", label: "x" })).rejects.toMatchObject({ code: "forbidden" });
    await withSystem((db) => db.query("update maintenance_subscriptions set status = 'expired', expired_at = now() where org_id = $1", [o.org.id]));
    await expect(saveStudioDraft(o.actor("owner"), id, { definition: withStep(s.workflow.draft), expectedRevision: s.workflow.draftRevision, source: "manual", label: "x" })).rejects.toMatchObject({ code: "plan_required" });
    expect((await stateOf(o, id)).workflow.draftRevision).toBe(s.workflow.draftRevision);
  });
});

// ---------------------------------------------------------------------------
// A turn
// ---------------------------------------------------------------------------

describe("a turn with the builder", () => {
  it("builds the workflow from the first message: streams the reply, applies only validated changes, saves, and stores what happened", async () => {
    const o = await crmOrg();
    const { id } = await startedWorkflow(o, "Welcome every new lead and follow up in two days");
    const llm = scripted([ops("Done. Each new lead gets a welcome task, then a two-day wait.", WELCOME)]);
    const events = await collect(runBuilderTurn(o.actor("owner"), id, { resume: true }, llm));

    expect(types(events)[0]).toBe("start");
    expect(types(events).slice(-2)).toEqual(["applied", "done"]);
    // The reply streamed, without the block or any JSON.
    const streamed = events.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("");
    expect(streamed.trim()).toBe("Done. Each new lead gets a welcome task, then a two-day wait.");
    expect(streamed).not.toMatch(/operations|set_trigger|`/);
    // "applied" arrives after the change is saved, and says exactly what was applied.
    const applied = events.find((e) => e.type === "applied") as Extract<BuilderEvent, { type: "applied" }>;
    expect(applied.operations.map((x) => x.op)).toEqual(["set_trigger", "add_step", "add_step"]);
    expect(applied.changes).toEqual(expect.arrayContaining([{ type: "step_added", key: "welcome" }, { type: "step_added", key: "wait_2d" }]));
    const s = await stateOf(o, id);
    expect(s.workflow.draftRevision).toBe(applied.revision);
    expect(s.workflow.draft.steps.map((x) => x.key)).toEqual(["welcome", "wait_2d"]);
    expect(applied.definition).toEqual(s.workflow.draft);
    // Stored: the person's message answered, the assistant's applied with its operations and revisions; the working copy's trail has the AI change.
    expect(s.messages.map((m) => [m.role, m.status])).toEqual([["user", "answered"], ["assistant", "applied"]]);
    expect(s.messages[1]).toMatchObject({ operations: applied.operations, revisionBefore: 1, revisionAfter: applied.revision });
    expect(s.history.map((h) => h.source)).toEqual(["manual", "ai"]);
    // Metered: one message, the model's real token counts.
    const counters = (await withSystem((db) => studioUsageSnapshot(db, o.org.id))).counters;
    expect(counters.builder_messages.quantity).toBe(1);
    expect(counters.builder_input_tokens.quantity).toBe(1000);
    expect(counters.builder_output_tokens.quantity).toBe(200);
    // The model was told about this workspace and workflow, and nothing secret.
    const prompt = llm.requests[0].system;
    expect(prompt).toContain("THE WORKFLOW");
    expect(prompt).toContain("create_task");
    expect(prompt).not.toContain(config.apiKey);
  });

  it("edits the existing workflow, seeing manual changes made since, and keeps what wasn't asked to change", async () => {
    const o = await crmOrg();
    const { id } = await startedWorkflow(o, "Welcome new leads");
    await collect(runBuilderTurn(o.actor("owner"), id, { resume: true }, scripted([ops("Done.", WELCOME)])));
    // The person adds a step by hand.
    const s1 = await stateOf(o, id);
    const manual: WorkflowDefinition = { ...s1.workflow.draft, steps: [...s1.workflow.draft.steps.map((x) => (x.key === "wait_2d" ? { ...x, next: "mine" } : x)), { key: "mine", kind: "internal_note", name: "My own note", config: { subject: "contact", body: "Called them" }, next: null } as WorkflowStep] };
    await saveStudioDraft(o.actor("owner"), id, { definition: manual, expectedRevision: s1.workflow.draftRevision, source: "manual", label: "Added my note" });

    const llm = scripted([ops("Changed the wait to three days.", [{ op: "update_step", key: "wait_2d", name: "Wait 3 days", config: { amount: 3 } }])]);
    const events = await collect(runBuilderTurn(o.actor("owner"), id, { message: "Actually, make that three days", selectedKey: "wait_2d" }, llm));
    expect(types(events).slice(-2)).toEqual(["applied", "done"]);
    // It was shown the latest draft, including the manual step and the selection.
    expect(llm.requests[0].system).toContain("My own note");
    expect(llm.requests[0].system).toContain('SELECTED STEP: "wait_2d"');
    const s2 = await stateOf(o, id);
    expect(s2.workflow.draft.steps.map((x) => x.key)).toEqual(["welcome", "wait_2d", "mine"]);
    expect(s2.workflow.draft.steps.find((x) => x.key === "wait_2d")).toMatchObject({ name: "Wait 3 days", config: { mode: "duration", amount: 3, unit: "days" } });
    expect(s2.workflow.draft.steps.find((x) => x.key === "mine")?.name).toBe("My own note");
    // The earlier conversation went with the request, and the selection is stored with the message.
    expect(llm.requests[0].messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(s2.messages.find((m) => m.role === "user" && m.content.startsWith("Actually"))).toMatchObject({ nodeKey: "wait_2d" });
  });

  it("answers a question without touching the workflow", async () => {
    const o = await crmOrg();
    const { id } = await startedWorkflow(o);
    const before = (await stateOf(o, id)).workflow;
    const events = await collect(runBuilderTurn(o.actor("owner"), id, { message: "What would happen if a lead replies?" }, scripted(["Nothing yet: this workflow has no steps. Would you like me to add a reply check?"])));
    expect(types(events)).not.toContain("applied");
    const after = await stateOf(o, id);
    expect(after.workflow.draftRevision).toBe(before.draftRevision);
    expect(doneMessage(events)).toMatchObject({ role: "assistant", status: "clarification" });
    expect(after.messages.map((m) => m.status)).toEqual(["answered", "clarification"]);
    expect(after.history.length).toBe(1);
  });

  it("explains a failure from the real run records", async () => {
    const o = await crmOrg();
    const { id } = await startedWorkflow(o);
    await withSystem(async (db) => {
      await db.query("update crm_workflows set draft = $2 where id = $1", [id, JSON.stringify({ trigger: { type: "contact.created" }, steps: [{ key: "welcome", kind: "internal_note", name: "Add note", config: { subject: "contact", body: "x" }, next: null }] })]);
      const v = await db.query<{ id: string }>("insert into crm_workflow_versions (org_id, workflow_id, version, trigger_config, steps, content_hash) values ($1, $2, 1, '{\"type\":\"contact.created\"}', '[]', $3) returning id", [o.org.id, id, "c".repeat(64)]);
      await db.query("insert into crm_workflow_runs (org_id, workflow_id, version_id, started_via, status, current_step, last_error, finished_at) values ($1, $2, $3, 'event', 'failed', 'welcome', 'The tag was deleted.', now())", [o.org.id, id, v.rows[0].id]);
    });
    const llm = scripted(["It stopped at “Add note” because a tag it uses was deleted."]);
    await collect(runBuilderTurn(o.actor("owner"), id, { message: "Why did this workflow fail?" }, llm));
    expect(llm.requests[0].system).toMatch(/failed at step "Add note": The tag was deleted\./);
  });
});

// ---------------------------------------------------------------------------
// Validation, repair and refusal
// ---------------------------------------------------------------------------

describe("what the server refuses", () => {
  it("lets the model correct a refused change once, and applies only the corrected one", async () => {
    const o = await crmOrg();
    const { id } = await startedWorkflow(o, "Tag new leads");
    const real = (await createTag(o.actor("owner"), { name: `Hot ${uid()}` })).id;
    const bad = ops("Added the tag step.", [{ op: "set_trigger", trigger: { type: "contact.created" } }, { op: "add_step", kind: "add_tag", key: "tag", config: { tagIds: [] }, at: { after: null } }]);
    const good = ops("Added the tag step with your tag.", [{ op: "set_trigger", trigger: { type: "contact.created" } }, { op: "add_step", kind: "add_tag", key: "tag", config: { tagIds: [real] }, at: { after: null } }]);
    const llm = scripted([bad, good]);
    const events = await collect(runBuilderTurn(o.actor("owner"), id, { resume: true }, llm));
    expect(llm.requests.length).toBe(2);
    expect(llm.requests[1].messages.at(-1)?.content).toMatch(/The server refused your operations: .*tag/i);
    expect(types(events).slice(-2)).toEqual(["applied", "done"]);
    const s = await stateOf(o, id);
    expect(s.workflow.draft.steps[0].config).toEqual({ tagIds: [real] });
    // Only the stored, final reply is the assistant's message; the refused attempt left nothing behind.
    expect(s.messages.filter((m) => m.role === "assistant").map((m) => m.content)).toEqual(["Added the tag step with your tag."]);
    // Both calls were metered, one message was counted.
    const c = (await withSystem((db) => studioUsageSnapshot(db, o.org.id))).counters;
    expect(c.builder_messages.quantity).toBe(1);
    expect(c.builder_input_tokens.quantity).toBe(2000);
  });

  it("refuses an id the model made up, and says honestly that nothing changed when it can't be corrected", async () => {
    const o = await crmOrg();
    const { id } = await startedWorkflow(o, "Tag new leads");
    const invented = ops("Added the tag step.", [{ op: "add_step", kind: "add_tag", key: "tag", config: { tagIds: ["0b1e0000-0000-4000-8000-000000000001"] }, at: { after: null } }]);
    const llm = scripted([invented]);
    const before = (await stateOf(o, id)).workflow.draftRevision;
    const events = await collect(runBuilderTurn(o.actor("owner"), id, { resume: true }, llm));
    expect(llm.requests.length).toBe(MAX_REPAIRS + 1);
    expect(types(events)).toEqual(expect.arrayContaining(["refused", "done"]));
    expect(types(events)).not.toContain("applied");
    const s = await stateOf(o, id);
    expect(s.workflow.draftRevision).toBe(before);
    expect(s.workflow.draft.steps).toEqual([]);
    expect(doneMessage(events)).toMatchObject({ status: "refused" });
    expect(doneMessage(events).content).toMatch(/nothing was changed/i);
    expect(s.messages.at(-1)?.operations).toBeNull();
  });

  it("refuses operations that aren't in the language, and anything that tries to reach beyond the draft", async () => {
    const o = await crmOrg();
    const { id } = await startedWorkflow(o, "Hello");
    for (const hostile of [
      [{ op: "run_code", code: "process.exit(1)" }],
      [{ op: "approve_version", versionId: "x" }],
      [{ op: "update_step", key: "a", config: {}, orgId: "someone-else" }],
      "not even json",
    ]) {
      const text = typeof hostile === "string" ? `${FENCE}operations\n${hostile}\n${FENCE}` : ops("Sure.", hostile);
      const events = await collect(runBuilderTurn(o.actor("owner"), id, { message: "do something" }, scripted([text])));
      expect(types(events)).toContain("refused");
    }
    const s = await stateOf(o, id);
    expect(s.workflow.draftRevision).toBe(1);
    expect(s.workflow.draft.steps).toEqual([]);
    expect(s.workflow.status).toBe("draft");
  });

  it("will not choose a webhook address, and cannot switch anything on or approve anything", async () => {
    const o = await crmOrg();
    const { id } = await startedWorkflow(o, "Hi");
    const hook = ops("Set up the webhook.", [{ op: "set_trigger", trigger: { type: "inbound_webhook", inbound: { nonce: "a".repeat(24), match: "none", createContact: false } } }]);
    const events = await collect(runBuilderTurn(o.actor("owner"), id, { message: "start from a webhook" }, scripted([hook])));
    expect(types(events)).toContain("refused");
    expect((await stateOf(o, id)).workflow.draft.trigger.type).toBe("contact.created");
  });

  it("applies to the workflow as it is when the answer arrives, not as it was when the question was asked", async () => {
    const o = await crmOrg();
    const { id } = await startedWorkflow(o, "Welcome new leads");
    // While the model is "writing", the person edits by hand.
    const llm = scripted([ops("Added a welcome task.", [{ op: "set_trigger", trigger: { type: "contact.created" } }, { op: "add_step", kind: "create_task", key: "welcome", config: { title: "Welcome", priority: "normal", assignee: "none" }, at: { after: null } }])], {
      onChunk: async (n) => {
        if (n !== 1) return;
        const s = await stateOf(o, id);
        await saveStudioDraft(o.actor("owner"), id, { definition: { ...s.workflow.draft, steps: [{ key: "mine", kind: "internal_note", config: { subject: "contact", body: "Mine" }, next: null } as WorkflowStep] }, expectedRevision: s.workflow.draftRevision, source: "manual", label: "Mine" });
      },
    });
    const events = await collect(runBuilderTurn(o.actor("owner"), id, { resume: true }, llm));
    expect(types(events)).toContain("applied");
    const s = await stateOf(o, id);
    expect(s.workflow.draft.steps.map((x) => x.key).sort()).toEqual(["mine", "welcome"]);
  });
});

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

describe("who may use the builder, and when", () => {
  it("needs the plan: nothing is asked of the model and nothing is stored without it", async () => {
    const o = await crmOrg();
    const { id } = await startedWorkflow(o, "Hello");
    await withSystem((db) => db.query("update maintenance_subscriptions set status = 'expired', expired_at = now() where org_id = $1", [o.org.id]));
    const llm = scripted(["Hi."]);
    await expect(collect(runBuilderTurn(o.actor("owner"), id, { message: "more" }, llm))).rejects.toMatchObject({ code: "plan_required" });
    expect(llm.requests.length).toBe(0);
    expect((await rows("select 1 from automation_studio_messages where workflow_id = $1 and role = 'assistant'", [id])).length).toBe(0);
  });

  it("needs the automations permission", async () => {
    const o = await crmOrg();
    const { id } = await startedWorkflow(o, "Hello");
    const llm = scripted(["Hi."]);
    await expect(collect(runBuilderTurn(o.actor("viewer"), id, { message: "more" }, llm))).rejects.toMatchObject({ code: "forbidden" });
    await expect(collect(runBuilderTurn(o.actor("support"), id, { message: "more" }, llm))).rejects.toMatchObject({ code: "forbidden" });
    expect(llm.requests.length).toBe(0);
  });

  it("stays inside the workspace: another workspace's workflow doesn't exist for you", async () => {
    const a = await crmOrg();
    const b = await crmOrg();
    const { id } = await startedWorkflow(a, "Hello");
    await grantPlan(b);
    const llm = scripted(["Hi."]);
    await expect(collect(runBuilderTurn(b.actor("owner"), id, { message: "show me" }, llm))).rejects.toMatchObject({ code: "not_found" });
    await expect(getStudioState(b.actor("owner"), id)).rejects.toMatchObject({ code: "not_found" });
    expect(llm.requests.length).toBe(0);
    expect((await rows("select 1 from automation_studio_messages where org_id = $1", [b.org.id])).length).toBe(0);
  });

  it("is honest when no model is connected, without storing anything or counting the message", async () => {
    const o = await crmOrg();
    const { id } = await startedWorkflow(o, "Hello");
    const llm = scripted(["Hi."], { resolution: missing });
    await expect(collect(runBuilderTurn(o.actor("owner"), id, { message: "more" }, llm))).rejects.toMatchObject({ code: "integration_unavailable", message: expect.stringMatching(/isn't connected.*build by hand/) });
    expect(await builderAvailability(llm)).toMatchObject({ available: false });
    expect(await builderAvailability(scripted([]))).toEqual({ available: true, reason: null });
    expect((await withSystem((db) => studioUsageSnapshot(db, o.org.id))).counters.builder_messages.quantity).toBe(0);
    expect((await stateOf(o, id)).messages.map((m) => m.status)).toEqual(["pending"]);
  });

  it("stops at the workspace's monthly allowance before asking the model", async () => {
    const o = await crmOrg();
    const { id } = await startedWorkflow(o, "Hello");
    await withSystem((db) => db.query("insert into automation_studio_limits (org_id, monthly_builder_messages) values ($1, 1)", [o.org.id]));
    const llm = scripted([ops("Done.", WELCOME)]);
    await collect(runBuilderTurn(o.actor("owner"), id, { resume: true }, llm));
    const second = scripted(["Hi."]);
    await expect(collect(runBuilderTurn(o.actor("owner"), id, { message: "one more" }, second))).rejects.toMatchObject({ code: "usage_limit", message: expect.stringMatching(/by hand/) });
    expect(second.requests.length).toBe(0);
  });

  it("rejects an empty or oversized message, and answering when nothing is waiting", async () => {
    const o = await crmOrg();
    const { id } = await startedWorkflow(o);
    const llm = scripted(["Hi."]);
    await expect(collect(runBuilderTurn(o.actor("owner"), id, { message: "   " }, llm))).rejects.toMatchObject({ code: "invalid_input" });
    await expect(collect(runBuilderTurn(o.actor("owner"), id, { message: "x".repeat(4001) }, llm))).rejects.toMatchObject({ code: "invalid_input" });
    await expect(collect(runBuilderTurn(o.actor("owner"), id, { resume: true }, llm))).rejects.toMatchObject({ code: "conflict" });
    await expect(collect(runBuilderTurn(o.actor("owner"), "not-a-uuid", { message: "hi" }, llm))).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("leaving and coming back", () => {
  it("keeps an unanswered message waiting if the person closes the page mid-answer, and answers it next time", async () => {
    const o = await crmOrg();
    const { id } = await startedWorkflow(o, "Welcome new leads");
    const controller = new AbortController();
    const interrupted = scripted([ops("Done.", WELCOME)], { onChunk: (n) => { if (n === 1) controller.abort(); } });
    await expect(collect(runBuilderTurn(o.actor("owner"), id, { resume: true }, interrupted, controller.signal))).rejects.toThrow();
    let s = await stateOf(o, id);
    expect(s.messages.map((m) => [m.role, m.status])).toEqual([["user", "pending"]]);
    expect(s.workflow.draft.steps).toEqual([]);
    // Back again: the same message is answered, and it is not asked twice.
    const events = await collect(runBuilderTurn(o.actor("owner"), id, { resume: true }, scripted([ops("Done.", WELCOME)])));
    expect(types(events)).toContain("applied");
    s = await stateOf(o, id);
    expect(s.messages.filter((m) => m.role === "user").length).toBe(1);
    expect(s.messages.map((m) => m.status)).toEqual(["answered", "applied"]);
  });
});
