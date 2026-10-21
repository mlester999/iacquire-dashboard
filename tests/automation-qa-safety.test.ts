// The Automation Studio browser QA stays isolated, and its stand-in for the AI model only ever proposes changes the real validation accepts.
import { describe, expect, it } from "vitest";
import { AUTOMATION_QA_ENV, assertAutomationQaIsolated } from "../scripts/automation-qa-env.mjs";
import { answer } from "../scripts/mock-automation-llm.mjs";
import { applyOperations, parseOperations } from "@/lib/crm/workflow/operations";
import { validateDefinition, validationContextFrom, type WorkflowDefinition } from "@/lib/crm/workflow/spec";

describe("Automation Studio QA environment", () => {
  it("is the Native CRM QA environment plus only the model stand-in, its own port and its own data", () => {
    expect(() => assertAutomationQaIsolated({ root: process.cwd(), env: AUTOMATION_QA_ENV })).not.toThrow();
    expect(AUTOMATION_QA_ENV.LLM_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    expect(AUTOMATION_QA_ENV.PGLITE_DATA_DIR.startsWith(".data/automation-qa/")).toBe(true);
    expect(AUTOMATION_QA_ENV.DATABASE_URL).toBe("");
  });

  it.each([
    ["a real model host", { LLM_BASE_URL: "https://api.example.com/v1" }],
    ["another loopback port", { LLM_BASE_URL: "http://127.0.0.1:9/v1" }],
    ["a model host that isn't loopback", { LLM_BASE_URL: "http://localhost:3263/v1" }],
    ["a database path outside its data directory", { PGLITE_DATA_DIR: ".data/crm-qa/database" }],
    ["uploads outside its data directory", { UPLOAD_DIR: ".data/automation-qa/../elsewhere" }],
    ["another build directory", { IAQ_DIST_DIR: ".next" }],
    ["a hosted database", { DATABASE_URL: "postgres://user@db.example.com/app" }],
    ["a message provider switched on", { TWILIO_WRITES_ENABLED: "true" }],
    ["an email provider key", { RESEND_API_KEY: "key" }],
    ["a variable the Native CRM QA environment doesn't know", { SOME_NEW_PROVIDER_KEY: "x" }],
  ])("refuses %s", (_name, change) => {
    expect(() => assertAutomationQaIsolated({ root: process.cwd(), env: { ...AUTOMATION_QA_ENV, ...change } })).toThrow(/not isolated/);
  });

  it("names variables, never values", () => {
    let message = "";
    try {
      assertAutomationQaIsolated({ root: process.cwd(), env: { ...AUTOMATION_QA_ENV, RESEND_API_KEY: "do-not-print-this-value" } });
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain("RESEND_API_KEY");
    expect(message).not.toContain("do-not-print-this-value");
  });
});

const ctx = validationContextFrom({ tags: [], users: [], pipelines: [], fields: [], templates: [], n8nMappings: [], webhookSubscriptions: [], assignmentRules: [], agents: [], calendars: [], appointmentTypes: [] });
const systemWith = (def: unknown) => `You are the builder.\nTHE WORKFLOW "Test" (status: draft; the first step in the list runs first)\n${JSON.stringify(def)}\nNo step is selected.\n`;
const EMPTY: WorkflowDefinition = { trigger: { type: "contact.created" }, steps: [] };

describe("the scripted model stand-in", () => {
  it("builds a welcome-and-follow-up automation from an empty canvas, and the real validation accepts it", () => {
    const { reply, ops } = answer({ system: systemWith(EMPTY), message: "When a new lead comes in, welcome them and remind my team if they haven't replied." });
    expect(reply).toMatch(/welcome task/);
    const parsed = parseOperations(ops);
    expect(parsed.ok).toBe(true);
    const applied = applyOperations(EMPTY, parsed.ok ? parsed.operations : [], { mode: "strict", context: ctx });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.definition.steps.map((s) => s.kind)).toEqual(["create_task", "wait", "branch", "end", "notify_team"]);
    expect(validateDefinition(applied.definition, ctx).filter((i) => i.level === "error")).toEqual([]);
  });

  it("edits the wait it finds in the workflow it is shown, and removes the reminder on request", () => {
    const built = applyOperations(EMPTY, answer({ system: systemWith(EMPTY), message: "build a welcome flow" }).ops as never, { mode: "strict", context: ctx });
    if (!built.ok) throw new Error(built.error.message);
    const system = systemWith(built.definition);
    const days = answer({ system, message: "Make that wait three days instead." });
    expect(days.ops).toEqual([expect.objectContaining({ op: "update_step", key: "wait_2d", config: { amount: 3 } })]);
    const removed = answer({ system, message: "Please remove the reminder." });
    expect(removed.ops).toEqual([{ op: "remove_step", key: "remind" }]);
    const changed = applyOperations(built.definition, days.ops as never, { mode: "strict", context: ctx });
    expect(changed.ok && (changed.definition.steps.find((s) => s.key === "wait_2d")?.config as { amount: number }).amount).toBe(3);
  });

  it("changes nothing when it doesn't recognise the request, and says it is a stand-in", () => {
    const r = answer({ system: systemWith(EMPTY), message: "hmm" });
    expect(r.ops).toBeNull();
    expect(r.reply).toMatch(/stand-in/);
  });
});
