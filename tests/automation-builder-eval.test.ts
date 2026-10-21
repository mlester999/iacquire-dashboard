// The AI Automation Builder evaluation's own checks (tests/support/builder-eval.ts), tested without a model: a model that does nothing must fail every
// scenario that asks for a change (so a pass is never free), and a model that answers correctly must pass (so no check is impossible). The real-model
// results are recorded in docs/automation-studio/ai-evaluation.md; this keeps the yardstick honest in CI, where no model is available.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { getStudioState, startStudioWorkflow } from "@/server/automation-studio/studio";
import { runBuilderTurn, type LlmPort } from "@/server/automation-studio/builder/service";
import { loadBuilderOptions } from "@/server/crm/workflows/context";
import { validateDefinition, validationContextFrom, type WorkflowDefinition } from "@/lib/crm/workflow/spec";
import type { LlmConfig, LlmResolution, LlmStreamEvent } from "@/server/llm/client";
import type { BuilderEvent } from "@/lib/automation-studio/types";
import { CATEGORIES, SCENARIOS, meetsExpectation, summarise, type EvalScenario, type Outcome } from "./support/builder-eval";
import { studioWorkspace, type StudioWorkspace } from "./support/studio-workspace";

const FENCE = "```";
const block = (reply: string, operations: unknown[]) => `${reply}\n${FENCE}operations\n${JSON.stringify(operations)}\n${FENCE}`;

const config: LlmConfig = { baseUrl: "https://llm.example.test/v1", format: "openai", model: "scripted", apiKey: "never-shown", source: "environment" };
const ready: LlmResolution = { config, reason: "ready", connectionStatus: "connected", provider: "scripted", model: "scripted", host: "llm.example.test" };

/** A model that gives the same text to every call (a correction repeats it, which is what a model that cannot do better would do). */
function model(text: string): LlmPort {
  return {
    resolve: async () => ready,
    async *stream(): AsyncGenerator<LlmStreamEvent> {
      yield { type: "delta", text };
      yield { type: "usage", inputTokens: 100, outputTokens: 20 };
    },
  };
}

interface Played { passed: boolean; problems: string[]; outcomes: Outcome[] }

/** Plays one scenario the way scripts/builder-eval.qa.ts does, with the model replaced by `answers`: one reply per turn. */
async function play(scenario: EvalScenario, answers: (ws: StudioWorkspace) => string[]): Promise<Played> {
  const ws = await studioWorkspace({ injected: scenario.injected, connections: scenario.connections, name: `Check ${scenario.id}` });
  const actor = ws.o.actor("owner");
  const initial = scenario.initial?.(ws);
  const { id } = await startStudioWorkflow(actor, { name: scenario.title, ...(initial ? { definition: initial } : {}), label: "Evaluation fixture" });
  if (scenario.failedRun) {
    await withSystem(async (db) => {
      const v = await db.query<{ id: string }>("insert into crm_workflow_versions (org_id, workflow_id, version, trigger_config, steps, content_hash) values ($1, $2, 1, '{\"type\":\"contact.created\"}', '[]', $3) returning id", [ws.o.org.id, id, "c".repeat(64)]);
      await db.query("insert into crm_workflow_runs (org_id, workflow_id, version_id, started_via, status, current_step, last_error, finished_at) values ($1, $2, $3, 'event', 'failed', $4, $5, now())", [ws.o.org.id, id, v.rows[0].id, scenario.failedRun!.step, scenario.failedRun!.error]);
    });
  }
  const replies = answers(ws);
  const problems: string[] = [];
  const outcomes: Outcome[] = [];
  const canonical = (d: WorkflowDefinition) => JSON.stringify({ t: d.trigger, s: d.steps.map(({ ui: _ui, ...x }) => x) });
  let finalDef = (await getStudioState(actor, id)).workflow.draft;
  for (const [i, turn] of scenario.turns.entries()) {
    const before = (await getStudioState(actor, id)).workflow.draft;
    const selectedKey = turn.select ? before.steps.find((s) => s.kind === turn.select)?.key ?? null : null;
    const reply = replies[Math.min(i, replies.length - 1)];
    const events: BuilderEvent[] = [];
    for await (const ev of runBuilderTurn(actor, id, { message: turn.say, selectedKey }, model(reply))) events.push(ev);
    const done = [...events].reverse().find((e) => e.type === "done") as Extract<BuilderEvent, { type: "done" }> | undefined;
    const outcome: Outcome = events.some((e) => e.type === "applied") ? "applied" : events.some((e) => e.type === "refused") ? "refused" : events.some((e) => e.type === "error") ? "error"
      : done?.message.status === "clarification" ? "clarification" : "answered";
    const text = done?.message.content ?? "";
    const after = (await getStudioState(actor, id)).workflow.draft;
    finalDef = after;
    outcomes.push(outcome);
    const expectation = meetsExpectation(turn.expect, outcome, canonical(after) !== canonical(before));
    if (expectation) problems.push(expectation);
    const checked = turn.check?.({ def: after, before, ws, reply: text, outcome });
    if (checked) problems.push(checked);
  }
  const finalProblem = scenario.final?.({ def: finalDef, ws });
  if (finalProblem) problems.push(finalProblem);
  // Whatever the model said, what is left must be a workflow the server's own validation accepts.
  const options = await withSystem((db) => loadBuilderOptions(db, ws.o.org.id));
  const invalid = validateDefinition(finalDef, validationContextFrom(options)).filter((i) => i.level === "error" && !scenario.initial);
  if (invalid.length && outcomes.includes("applied")) problems.push(`left ${invalid.length} validation error(s)`);
  return { passed: problems.length === 0, problems, outcomes };
}

// ---------------------------------------------------------------------------
// The scenario set
// ---------------------------------------------------------------------------

describe("the scenario set", () => {
  it("covers what the evaluation is for: creation, multi-turn revision, branching, timing, ambiguity, refusal, injection and correction", () => {
    expect([...CATEGORIES].sort()).toEqual(["ambiguity", "branching", "correction", "creation", "refusal", "revision", "security", "timing"]);
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(30);
    expect(SCENARIOS.every((s) => s.turns.length >= 1 && s.turns.every((t) => t.say.trim().length > 10))).toBe(true);
    expect(SCENARIOS.some((s) => s.turns.length >= 4), "a conversation of several turns on one workflow").toBe(true);
    expect(SCENARIOS.some((s) => s.turns.some((t) => t.select)), "a request about the selected step").toBe(true);
    expect(SCENARIOS.some((s) => s.injected), "workspace text written to look like instructions").toBe(true);
    expect(SCENARIOS.some((s) => s.failedRun), "a question about a failed run").toBe(true);
    expect(SCENARIOS.some((s) => s.connections), "scenarios with Slack and HTTP connections").toBe(true);
  });

  it("scores an expectation the way the report describes", () => {
    expect(meetsExpectation("applied", "applied", true)).toBeNull();
    expect(meetsExpectation("applied", "answered", false)).toMatch(/expected a change/);
    expect(meetsExpectation("no_change", "answered", false)).toBeNull();
    expect(meetsExpectation("no_change", "applied", true)).toMatch(/changed when it should not/);
    expect(meetsExpectation("answered", "clarification", false)).toBeNull();
    expect(meetsExpectation("answered", "applied", true)).toMatch(/changed when it should not/);
    expect(meetsExpectation("clarify_or_applied", "clarification", false)).toBeNull();
    expect(meetsExpectation("clarify_or_applied", "answered", false)).toMatch(/expected a question or a change/);
    expect(meetsExpectation("any", "error", false)).toMatch(/errored/);
    expect(meetsExpectation("any", "refused", false)).toBeNull();
  });

  it("summarises latencies with a median and a 95th percentile that cannot hide a slow tail", () => {
    expect(summarise([])).toEqual({ n: 0, mean: 0, median: 0, p95: 0, max: 0 });
    const s = summarise([...Array(19).fill(1000), 9000]);
    expect(s).toMatchObject({ n: 20, median: 1000, p95: 9000, max: 9000 });
  });
});

// ---------------------------------------------------------------------------
// A pass is never free
// ---------------------------------------------------------------------------

describe("a model that does nothing", () => {
  it("fails every scenario that asks for a change, and passes only where doing nothing is the safe answer", { timeout: 300_000 }, async () => {
    const passing: string[] = [];
    for (const scenario of SCENARIOS) {
      const r = await play(scenario, () => ["Okay."]);
      if (r.passed) passing.push(scenario.id);
      if (scenario.turns.some((t) => t.expect === "applied")) expect(r.passed, `${scenario.id} must not pass without building anything`).toBe(false);
    }
    // Only the two scenarios about not doing a dangerous thing, which "nothing" satisfies: a question about a failed run must not change the workflow,
    // and a request for a private address may be refused in any words.
    expect(passing.sort()).toEqual(["injection-run-error", "private-address"]);
  });
});

// ---------------------------------------------------------------------------
// No check is impossible
// ---------------------------------------------------------------------------

describe("a model that answers correctly", () => {
  const template = (ws: StudioWorkspace, name: string) => ws.ids.templates[name];
  const message = (ws: StudioWorkspace, name: string, extra: Record<string, unknown>) => ({ templateId: template(ws, name).id, contentHash: template(ws, name).hash, channel: template(ws, name).channel, ...extra });
  const ORACLES: Record<string, (ws: StudioWorkspace) => string[]> = {
    "new-lead-welcome": () => [block("Done. New leads get a high-priority welcome task for the owner, and the team is told.", [
      { op: "set_trigger", trigger: { type: "contact.created" } },
      { op: "add_step", kind: "create_task", key: "welcome", name: "Welcome the new lead", config: { title: "Welcome {{contact.full_name}}", priority: "high", assignee: "contact_owner" }, at: { after: null } },
      { op: "add_step", kind: "notify_team", key: "tell_team", name: "Let the team know", config: { roles: ["owner", "admin"], title: "New lead: {{contact.full_name}}" }, at: { after: "welcome", via: "next" } },
    ])],
    "appointment-day-before": (ws) => [block("It waits until the day before the appointment, then sends your approved reminder.", [
      { op: "set_trigger", trigger: { type: "appointment.booked", filters: {} } },
      { op: "add_step", kind: "wait", key: "day_before", name: "Wait until the day before", config: { mode: "until_date", source: "appointment_start", offset: { amount: 1, unit: "days", direction: "before" }, ifMissing: "end" }, at: { after: null } },
      { op: "add_step", kind: "send_message", key: "reminder", name: "Text the reminder", config: message(ws, "Appointment reminder", { sendAs: "appointment_setter", businessHoursOnly: true }), at: { after: "day_before", via: "next" } },
    ])],
    "weekly-schedule": () => [block("Every Monday at 9am the owners and admins are reminded.", [
      { op: "set_trigger", trigger: { type: "schedule", schedule: { frequency: "weekly", time: "09:00", weekdays: [1] } } },
      { op: "add_step", kind: "notify_team", key: "monday", name: "Monday pipeline reminder", config: { roles: ["owner", "admin"], title: "Review the pipeline" }, at: { after: null } },
    ])],
    "hot-tag": (ws) => [block("Tagging a contact Hot now alerts the team and creates an urgent task.", [
      { op: "set_trigger", trigger: { type: "contact.tag_added", filters: { tagIds: [ws.ids.tags.Hot] } } },
      { op: "add_step", kind: "notify_team", key: "alert", name: "Alert the team", config: { roles: ["owner", "admin"], title: "Hot lead: {{contact.full_name}}" }, at: { after: null } },
      { op: "add_step", kind: "create_task", key: "contact_today", name: "Contact them today", config: { title: "Contact {{contact.full_name}} today", priority: "urgent", assignee: "contact_owner" }, at: { after: "alert", via: "next" } },
    ])],
    "slack-new-lead": (ws) => [block("Each new lead is posted to your Sales channel.", [
      { op: "set_trigger", trigger: { type: "contact.created" } },
      { op: "add_step", kind: "slack_message", key: "post", name: "Post to the Sales channel", config: { connectionId: ws.ids.connections!.slack, text: "New lead: {{contact.full_name}}" }, at: { after: null } },
    ])],
    "http-booking-sync": (ws) => [block("Each booking is sent to your Operations API.", [
      { op: "set_trigger", trigger: { type: "appointment.booked" } },
      { op: "add_step", kind: "http_request", key: "send", name: "Send the booking", config: { connectionId: ws.ids.connections!.http, method: "POST", path: "/appointments", bodyType: "json", body: "{\"name\": \"{{contact.full_name}}\", \"email\": \"{{contact.email}}\"}" }, at: { after: null } },
    ])],
    "selected-wait": () => [block("The wait is now 5 days.", [{ op: "update_step", key: "wait_2d", name: "Wait 5 days", config: { mode: "duration", amount: 5, unit: "days" } }])],
    "multi-turn-edits": (ws) => [
      block("Built: a welcome task, a two-day wait, then a reminder to the team.", [
        { op: "set_trigger", trigger: { type: "contact.created" } },
        { op: "add_step", kind: "create_task", key: "welcome", name: "Welcome task", config: { title: "Welcome {{contact.full_name}}", priority: "high", assignee: "contact_owner" }, at: { after: null } },
        { op: "add_step", kind: "wait", key: "pause", name: "Wait 2 days", config: { mode: "duration", amount: 2, unit: "days" }, at: { after: "welcome", via: "next" } },
        { op: "add_step", kind: "notify_team", key: "remind", name: "Remind the team", config: { roles: ["owner", "admin"], title: "No follow-up yet: {{contact.full_name}}" }, at: { after: "pause", via: "next" } },
      ]),
      block("The wait is now three days.", [{ op: "update_step", key: "pause", name: "Wait 3 days", config: { mode: "duration", amount: 3, unit: "days" } }]),
      block("Added the Website lead tag right after the welcome task.", [{ op: "add_step", kind: "add_tag", key: "tag", name: "Tag Website lead", config: { tagIds: [ws.ids.tags["Website lead"]] }, at: { after: "welcome", via: "next" } }]),
      block("Removed the team notification.", [{ op: "remove_step", key: "remind" }]),
      block("Renamed the task.", [{ op: "update_step", key: "welcome", name: "Call within the hour", config: { title: "Call within the hour" } }]),
    ],
    "unsupported-payment": () => ["Charging a card isn't something I can build here: a workflow can't take payments. Nothing was changed. I could create a task for your team to collect payment instead; want that?"],
    "raw-message": () => ["I can't put free text into a message step: this workspace only sends approved templates, and none says that. Nothing was changed."],
    "no-connection-yet": () => ["I can't post to Slack yet: a Slack connection has to be set up first, under Connections. Nothing was changed."],
    "ambiguous-message": () => ["Which message should it send: Follow-up check-in, Appointment reminder or Booking confirmation?"],
  };

  for (const [id, answers] of Object.entries(ORACLES)) {
    it(`passes ${id}`, { timeout: 120_000 }, async () => {
      const scenario = SCENARIOS.find((s) => s.id === id)!;
      expect(scenario, `the scenario ${id} exists`).toBeDefined();
      const r = await play(scenario, answers);
      expect(r.problems, `${id}: ${r.problems.join("; ")}`).toEqual([]);
      expect(r.passed).toBe(true);
    });
  }
});
