// Every place that calls the paid language model either records the call against the workspace (src/server/llm/meter.ts) or is on a short, explicit list of
// exceptions with the reason. The scan fails for a new caller that does neither. The Website Studio assistant, the onboarding assistant and the employee
// generator are metered here too: whatever becomes of the answer, a failed call that still cost tokens included. The model is a stub: no request leaves the machine.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";

const model = vi.hoisted(() => ({ complete: vi.fn(), configured: true }));
vi.mock("@/server/llm/client", () => ({
  resolveLlmConfig: async () => (model.configured ? { baseUrl: "https://provider.test/v1", format: "openai", model: "configured-model", apiKey: "server-only-secret", source: "portal" } : null),
  llmComplete: model.complete,
}));

import { withSystem } from "@/server/db";
import { suggestWithAi } from "@/server/websites/assistant";
import { suggestOnboardingAnswer, saveOnboardingStep } from "@/server/onboarding/service";
import { generateEmployeeSettings } from "@/server/onboarding/employee-generator";
import { AGENT_ROLE_KEYS } from "@/lib/agents";
import { onboardingSchema } from "@/lib/agent-settings";
import type { OrgContext } from "@/server/tenancy/context";
import { addMember, createOrg, createUser, ctxFor } from "./support/fixtures";

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

/** Files that import llmComplete and are deliberately not metered against a workspace. Each needs a reason a reader can check. */
const EXEMPT: Record<string, string> = {
  "src/server/aqi/service.ts": "AQi keeps its own cost accounting (aqi_usage_events); the llmComplete call here is the Super Admin's 'test the AQi connection' check, which has no workspace to charge",
  "src/server/aqi/titles.ts": "AQi keeps its own cost accounting (aqi_usage_events); this is the 40-token title for a conversation",
  "src/server/integrations/inspection.ts": "a one-token health ping when the Super Admin checks the AI connection; there is no workspace to charge",
};

const ROOT = path.resolve(import.meta.dirname, "..");
function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(e.name) ? [full] : [];
  });
}
const IMPORTS_LLM_COMPLETE = /import\s*(?:type\s*)?\{[^}]*\bllmComplete\b[^}]*\}\s*from\s*["']@\/server\/llm\/client["']/;
const importers = sourceFiles(path.join(ROOT, "src"))
  .map((f) => ({ rel: path.relative(ROOT, f).split(path.sep).join("/"), text: fs.readFileSync(f, "utf8") }))
  .filter((f) => IMPORTS_LLM_COMPLETE.test(f.text));

describe("every caller of the language model", () => {
  it("finds the callers it should (so an empty scan cannot pass)", () => {
    const names = importers.map((f) => f.rel);
    expect(names).toEqual(expect.arrayContaining(["src/server/webchat/generator.ts", "src/server/lead-scoring/ai.ts", "src/server/websites/assistant.ts", "src/server/onboarding/employee-generator.ts", "src/server/onboarding/service.ts"]));
    expect(names.length).toBeGreaterThanOrEqual(12);
  });

  it("records its calls with meterModelUse, or is on the exemption list with a reason", () => {
    const unmetered = importers.filter((f) => !EXEMPT[f.rel] && !(/from\s*["']@\/server\/llm\/meter["']/.test(f.text) && /\b(?:meterModelUse|recordModelUse)\(/.test(f.text))).map((f) => f.rel);
    expect(unmetered, "these files call the language model without recording the call").toEqual([]);
  });

  it("keeps the exemption list honest: every entry still exists, still calls the model, and says why", () => {
    for (const [rel, reason] of Object.entries(EXEMPT)) {
      const hit = importers.find((f) => f.rel === rel);
      expect(hit, `${rel} is on the exemption list but no longer imports llmComplete`).toBeTruthy();
      expect(reason.length).toBeGreaterThan(30);
    }
  });
});

// ---------------------------------------------------------------------------
// The three that were not metered
// ---------------------------------------------------------------------------

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;
const lines = async (orgId: string, feature: string) =>
  (await rows<{ unit_type: string; quantity: string }>("select unit_type, quantity::text from metered_usage_events where org_id = $1 and provider = 'llm' and job_reference = $2 order by unit_type, quantity", [orgId, `ai:${feature}`])).map((l) => `${l.unit_type} ${l.quantity}`);

async function workspace(opts: { status?: string } = {}) {
  const org = await createOrg({ name: `Meter ${Math.random().toString(36).slice(2, 8)}`, status: opts.status ?? "onboarding" });
  const user = await createUser();
  await addMember(org.id, user.id, "owner");
  const ctx: OrgContext = ctxFor(user, org, "owner");
  return { org, ctx };
}
const suspend = (orgId: string) => withSystem((db) => db.query("update organizations set status = 'suspended' where id = $1", [orgId]));

beforeEach(() => {
  model.configured = true;
  model.complete.mockReset();
});

describe("the Website Studio assistant", () => {
  const brief = {
    business: { name: "Marko Bar", tagline: "", areas: [] },
    design: { mode: "light", primary: "#112233", accent: "#445566", headingFont: "inter", bodyFont: "inter", radius: "soft", spacing: "regular", scale: "regular", buttonStyle: "solid" },
    pages: [], sections: [], selection: null,
  };
  const ask = (ctx: OrgContext) => suggestWithAi(ctx, { request: "Make the buttons rounder", brief });

  it("records the tokens of an answer, and of one it could not read, tagged website_assistant", async () => {
    const { org, ctx } = await workspace();
    model.complete.mockResolvedValueOnce({ ok: true, text: JSON.stringify({ summary: "Rounder buttons.", notes: [], ops: [{ op: "design", set: { radius: "round" } }] }), usage: { inputTokens: 700, outputTokens: 90 } });
    expect(await ask(ctx)).not.toBeNull();
    model.complete.mockResolvedValueOnce({ ok: true, text: "not a plan at all", usage: { inputTokens: 650, outputTokens: 20 } });
    expect(await ask(ctx)).toBeNull();
    expect(await lines(org.id, "website_assistant")).toEqual(["ai_tokens_in 650.000000", "ai_tokens_in 700.000000", "ai_tokens_out 20.000000", "ai_tokens_out 90.000000"]);
  });

  it("records a call that failed but still cost tokens, and nothing for one that reported none", async () => {
    const { org, ctx } = await workspace();
    model.complete.mockResolvedValueOnce({ ok: false, status: 0, usage: { inputTokens: 500, outputTokens: 0 } });
    expect(await ask(ctx)).toBeNull();
    model.complete.mockResolvedValueOnce({ ok: false, status: 503 });
    expect(await ask(ctx)).toBeNull();
    expect(await lines(org.id, "website_assistant")).toEqual(["ai_tokens_in 500.000000"]);
  });

  it("does not ask the model for a suspended workspace, and the built-in assistant carries on", async () => {
    const { org, ctx } = await workspace();
    await suspend(org.id);
    expect(await ask(ctx)).toBeNull();
    expect(model.complete).not.toHaveBeenCalled();
    expect(await lines(org.id, "website_assistant")).toEqual([]);
  });

  it("is not refused for an empty balance: a workspace setting up its site has none yet, and the call is recorded", async () => {
    const { org, ctx } = await workspace({ status: "active" });
    model.complete.mockResolvedValueOnce({ ok: true, text: JSON.stringify({ summary: "x", notes: [], ops: [] }), usage: { inputTokens: 10, outputTokens: 5 } });
    await ask(ctx);
    expect(model.complete).toHaveBeenCalledTimes(1);
    expect(await lines(org.id, "website_assistant")).toHaveLength(2);
  });
});

describe("the onboarding assistant", () => {
  async function onboarding() {
    const w = await workspace();
    await saveOnboardingStep(w.ctx, { answers: Object.fromEntries(Object.entries({ "a.business_name": "Marko Bar", "a.industry": "real_estate", "a.business_model": "mixed" }).map(([id, value]) => [id, { value }])) });
    return w;
  }
  const answer = (usage?: { inputTokens: number | null; outputTokens: number | null }) =>
    model.complete.mockResolvedValue({ ok: true, text: JSON.stringify({ value: "Marko Bar is a real estate business serving customers in person and online.", evidence: [{ factId: "a.business_name", quote: "Marko Bar" }], reason: "Based on your saved information." }), ...(usage ? { usage } : {}) });

  it("records the tokens of a suggestion, tagged onboarding_assist", async () => {
    const { org, ctx } = await onboarding();
    answer({ inputTokens: 900, outputTokens: 80 });
    await suggestOnboardingAnswer(ctx, "a.description");
    expect(await lines(org.id, "onboarding_assist")).toEqual(["ai_tokens_in 900.000000", "ai_tokens_out 80.000000"]);
  });

  it("records the tokens of a suggestion the checks then refused, and of a call that failed after spending them", async () => {
    const { org, ctx } = await onboarding();
    model.complete.mockResolvedValueOnce({ ok: true, text: "not json", usage: { inputTokens: 400, outputTokens: 30 } });
    await expect(suggestOnboardingAnswer(ctx, "a.description", { regenerate: true })).rejects.toThrow();
    model.complete.mockResolvedValueOnce({ ok: false, status: 0, usage: { inputTokens: 410, outputTokens: 0 } });
    await expect(suggestOnboardingAnswer(ctx, "a.description", { regenerate: true })).rejects.toThrow(/couldn't answer/);
    expect(await lines(org.id, "onboarding_assist")).toEqual(["ai_tokens_in 400.000000", "ai_tokens_in 410.000000", "ai_tokens_out 30.000000"]);
  });

  it("records nothing when the provider reports no tokens", async () => {
    const { org, ctx } = await onboarding();
    answer();
    await suggestOnboardingAnswer(ctx, "a.description");
    expect(await lines(org.id, "onboarding_assist")).toEqual([]);
  });

  it("does not ask the model for a suspended workspace: the answers a suggestion is built from cannot be read for it, so the call is never reached", async () => {
    const { org, ctx } = await onboarding();
    await suspend(org.id);
    answer({ inputTokens: 1, outputTokens: 1 });
    await expect(suggestOnboardingAnswer(ctx, "a.description")).rejects.toThrow();
    expect(model.complete).not.toHaveBeenCalled();
    expect(await lines(org.id, "onboarding_assist")).toEqual([]);
  });
});

describe("the employee generator", () => {
  const data = onboardingSchema.parse({
    business: { companyName: "North Shore Dental", description: "Family dentistry and preventive care in Portland.", industry: "Healthcare", services: "Exams and cleanings", idealCustomers: "Portland families", operatingArea: "Portland, Oregon" },
    goals: { selected: ["more_appointments"] },
    communication: { tone: "friendly", replyLength: "balanced", language: "English" },
    workforce: { selected: [...AGENT_ROLE_KEYS], answers: {} },
  });

  it("records the one call it makes against the workspace it was given, tagged employee_generator, whatever the answer", async () => {
    const { org } = await workspace();
    model.complete.mockResolvedValueOnce({ ok: true, text: "this is not the JSON asked for", usage: { inputTokens: 1800, outputTokens: 900 } });
    const out = await generateEmployeeSettings(data, [], undefined, org.id);
    expect(model.complete).toHaveBeenCalledTimes(1);
    expect(AGENT_ROLE_KEYS.every((role) => out[role].source === "safe_defaults")).toBe(true);
    expect(await lines(org.id, "employee_generator")).toEqual(["ai_tokens_in 1800.000000", "ai_tokens_out 900.000000"]);
  });

  it("records a failed call that still cost tokens", async () => {
    const { org } = await workspace();
    model.complete.mockResolvedValueOnce({ ok: false, status: 0, usage: { inputTokens: 1700, outputTokens: 0 } });
    await generateEmployeeSettings(data, [], undefined, org.id);
    expect(await lines(org.id, "employee_generator")).toEqual(["ai_tokens_in 1700.000000"]);
  });

  it("uses the safe defaults without asking the model for a suspended workspace", async () => {
    const { org } = await workspace();
    await suspend(org.id);
    const out = await generateEmployeeSettings(data, [], undefined, org.id);
    expect(model.complete).not.toHaveBeenCalled();
    expect(AGENT_ROLE_KEYS.every((role) => out[role].source === "safe_defaults")).toBe(true);
  });

  it("will not call the model without a workspace to record the call against", async () => {
    await expect((generateEmployeeSettings as (...a: unknown[]) => Promise<unknown>)(data, [], undefined)).rejects.toThrow(/workspace/);
    expect(model.complete).not.toHaveBeenCalled();
  });

  it("leaves a completion the caller supplies alone: no model call, nothing recorded", async () => {
    const out = await generateEmployeeSettings(data, [], async () => null);
    expect(model.complete).not.toHaveBeenCalled();
    expect(AGENT_ROLE_KEYS.every((role) => out[role].source === "safe_defaults")).toBe(true);
  });
});
