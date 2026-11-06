// Settings > AI preferences and the questionnaire's communication answers are two editors of the same company-wide defaults. A Settings edit moves the answers, and a
// re-submission writes a preference only when its answers changed since the last submission. "Apply to employees" is off unless asked for, previews what it would replace,
// keeps the wording a client wrote on an employee unless told otherwise, reports what it did as updated, held or skipped, and one employee's blocked version never takes the others
// down with it. Embedded Postgres on the real migrations.
import { describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { AI_GROWTH_PARTNER_ROLE_KEY, AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { agentSettingsSchema } from "@/lib/agent-settings";
import { aiPreferencesApplyMessage, parseProfileSnapshot } from "@/lib/onboarding/business-profile";
import { aiPrefsInputSchema, getProfile, previewAiPreferencesApply, updateAiPreferences } from "@/server/settings/service";
import { getOnboardingSession, saveOnboardingStep, submitOnboarding } from "@/server/onboarding/service";
import { createConfigVersion } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { addMember, agentId, createOrg, createUser, ctxFor } from "./support/fixtures";
import { submitRealOnboarding } from "./support/billing";

// One test makes a single employee's new version fail; every other test runs the real thing.
const control = vi.hoisted(() => ({ blockAgent: null as string | null }));
vi.mock("@/server/workforce/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/workforce/service")>();
  return {
    ...actual,
    createConfigVersion: (...args: Parameters<typeof actual.createConfigVersion>) => {
      if (control.blockAgent && args[1].agentId === control.blockAgent) throw new AppError("forbidden", "This change is blocked: test");
      return actual.createConfigVersion(...args);
    },
  };
});

type Ctx = ReturnType<typeof ctxFor>;
// With these answers the CRM Manager's first configuration is held for review, so it has no applied configuration; the other five do.
const HELD_FIRST: AgentRoleKey = "crm_manager";
const APPLIED_ROLES = AGENT_ROLE_KEYS.filter((r) => r !== HELD_FIRST);
const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;
const activeOf = async (orgId: string, role: string) => (await rows<{ version: number; source: string; settings: Record<string, string>; change_request: string | null }>(
  `select v.version, v.source, v.settings, v.change_request from agent_config_versions v join agent_instances a on a.active_config_version_id = v.id where a.org_id = $1 and a.role_key = $2`, [orgId, role]))[0];
const activeWorkforceOf = async (orgId: string, role: string) => (await rows<{ version: number; source: string; settings: Record<string, string>; change_request: string | null }>(
  `select v.version, v.source, v.settings, v.change_request from agent_config_versions v join agent_instances a on a.active_config_version_id = v.id where a.org_id = $1 and a.role_key = $2`, [orgId, role]))[0];
const versionTotals = async (orgId: string) => Object.fromEntries((await rows<{ role_key: string; n: number }>(
  "select a.role_key, count(v.id)::int as n from agent_instances a left join agent_config_versions v on v.agent_instance_id = a.id where a.org_id = $1 group by a.role_key", [orgId])).map((r) => [r.role_key, r.n]));
const answerOf = async (orgId: string, id: string) => (await rows<{ value: unknown; source: string }>("select value, source from onboarding_answers where org_id = $1 and question_id = $2", [orgId, id]))[0];
const storedPrefs = async (orgId: string) => (await rows<{ ai_preferences: Record<string, unknown> }>("select ai_preferences from company_profiles where org_id = $1", [orgId]))[0].ai_preferences;
const snapshotOf = async (orgId: string) => parseProfileSnapshot((await rows<{ s: unknown }>("select submitted_snapshot as s from onboarding_responses where org_id = $1", [orgId]))[0]?.s);
const save = (ctx: Ctx, answers: Record<string, unknown>) => saveOnboardingStep(ctx, { answers: Object.fromEntries(Object.entries(answers).map(([k, value]) => [k, { value }])) });
const resubmit = async (ctx: Ctx) => {
  await save(ctx, { "f.review": true });
  return submitOnboarding(ctx);
};
const PREFS = { tone: "casual", replyLength: "balanced", language: "English", companyRules: "Always offer a free inspection first.", neverPromise: "Exact prices before an assessment.", escalateWhen: "Anything unsafe or unclear." } as const;
const OWN_RULES = "Our own rules for this employee, written by the client.";

describe("a Settings > AI preferences edit and the answers it comes from", () => {
  it("moves the answers it came from, and an unrelated re-submission does not revert the preferences", async () => {
    const c = await submitRealOnboarding({ name: "Prefs Roofing", clearPayment: true });
    await updateAiPreferences(c.ctx, { ...PREFS });

    expect(await answerOf(c.org.id, "c.tone")).toMatchObject({ value: "casual", source: "user" });
    expect(await answerOf(c.org.id, "c.reply_length")).toMatchObject({ value: "balanced", source: "user" });
    expect(await answerOf(c.org.id, "c.company_rules")).toMatchObject({ value: PREFS.companyRules, source: "user" });
    expect(await answerOf(c.org.id, "c.never_promise")).toMatchObject({ value: PREFS.neverPromise, source: "user" });
    expect((await getOnboardingSession(c.ctx)).hasUnsubmittedChanges).toBe(false);

    await save(c.ctx, { "d.followup": "gentle" });
    const outcome = await resubmit(c.ctx);
    expect(await storedPrefs(c.org.id)).toMatchObject({ tone: "casual", replyLength: "balanced", companyRules: PREFS.companyRules, neverPromise: PREFS.neverPromise, escalateWhen: PREFS.escalateWhen });
    expect((await snapshotOf(c.org.id))?.prefs).toMatchObject({ tone: "casual", companyRules: PREFS.companyRules });
    // The hand-off preference is built from picked situations and has no answer, so the re-submission says it left it alone.
    expect(outcome.notes.map((n) => n.key)).toContain("preferences.kept");
    expect(outcome.notes.find((n) => n.key === "preferences.kept")?.message).toMatch(/when to ask a human/);
  }, 120_000);

  it("writes only the preferences whose answers the owner changed in the questionnaire", async () => {
    const c = await submitRealOnboarding({ name: "Prefs Changed Roofing", clearPayment: true });
    await updateAiPreferences(c.ctx, { ...PREFS });
    await save(c.ctx, { "c.reply_length": "detailed" });
    await resubmit(c.ctx);
    expect(await storedPrefs(c.org.id)).toMatchObject({ replyLength: "detailed", tone: "casual", companyRules: PREFS.companyRules });
    // A first submission always wrote every preference; one for a workspace whose snapshot predates this rule falls back to the answers' edit times.
    await withSystem((db) => db.query("update onboarding_responses set submitted_snapshot = null where org_id = $1", [c.org.id]));
    await updateAiPreferences(c.ctx, { ...PREFS, replyLength: "concise", companyRules: "Rules edited once more in Settings." });
    await save(c.ctx, { "c.language": "English" });
    await resubmit(c.ctx);
    expect(await storedPrefs(c.org.id)).toMatchObject({ replyLength: "concise", companyRules: "Rules edited once more in Settings." });
  }, 120_000);

  it("does not touch an unapproved questionnaire edit that is still waiting", async () => {
    const c = await submitRealOnboarding({ name: "Prefs Waiting Roofing", clearPayment: true });
    await save(c.ctx, { "c.tone": "premium" });
    await updateAiPreferences(c.ctx, { ...PREFS, tone: "casual" });
    // Settings' own choice replaces the waiting answer (it is the newer word), and the edit is a change the live setup now has.
    expect((await answerOf(c.org.id, "c.tone")).value).toBe("casual");
    expect((await storedPrefs(c.org.id)).tone).toBe("casual");
  }, 120_000);

  it("leaves the questionnaire alone for a workspace that has not started it", async () => {
    const c = await submitRealOnboarding({ name: "Prefs Plain Roofing", clearPayment: true });
    await withSystem((db) => db.query("delete from onboarding_answers where org_id = $1", [c.org.id]));
    await updateAiPreferences(c.ctx, { ...PREFS });
    expect(await rows("select 1 from onboarding_answers where org_id = $1", [c.org.id])).toHaveLength(0);
    expect((await getProfile(c.ctx))!.ai_preferences).toMatchObject({ tone: "casual" });
  }, 120_000);
});

/** The six preferences exactly as one employee runs them now, with some changed: applying these to that employee changes only what was changed (a guardrail that differs is a review). */
async function prefsLike(orgId: string, role: AgentRoleKey, change: Partial<Record<keyof typeof PREFS, string>>) {
  const s = (await activeOf(orgId, role)).settings;
  return { tone: s.tone, replyLength: s.replyLength, language: s.language, companyRules: s.companyRules, neverPromise: s.neverPromise, escalateWhen: s.escalateWhen, ...change } as typeof PREFS;
}
/** A client edit of one employee's company rules that extends what it had (so it is applied, not held for review). */
async function ownCompanyRules(orgId: string, owner: { id: string }, role: AgentRoleKey) {
  const active = (await activeOf(orgId, role)).settings;
  const own = `${active.companyRules} ${OWN_RULES}`;
  const id = await agentId(orgId, role);
  await withSystem((db) => createConfigVersion(db, { orgId, agentId: id, settings: agentSettingsSchema.parse({ ...active, companyRules: own }), source: "client_edit", userId: owner.id, apply: true }));
  return own;
}
const statusOfLatest = async (orgId: string, role: string) => (await rows<{ status: string }>(
  "select v.status from agent_config_versions v join agent_instances a on a.id = v.agent_instance_id where a.org_id = $1 and a.role_key = $2 order by v.version desc limit 1", [orgId, role]))[0].status;

async function createGrowthPartnerOnlyWorkspace(name: string) {
  const org = await createOrg({ name });
  const owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  const ctx = ctxFor(owner, org, "owner");
  const agentId = await withSystem(async (db) => {
    await db.query("update agent_instances set enabled = false where org_id = $1", [org.id]);
    await db.query(
      `insert into agent_roles (key, name, short_name, tagline, description, capabilities, default_tools, accent, sort_order)
       values ('growth_partner', 'AI Growth Partner', 'Growth Partner', 'One partner', 'Unified test identity', '[]'::jsonb, '[]'::jsonb, '#6d63d8', 7)
       on conflict (key) do nothing`,
    );
    const { rows: agents } = await db.query<{ id: string }>(
      "insert into agent_instances (org_id, role_key, display_name) values ($1, 'growth_partner', 'AI Growth Partner') returning id",
      [org.id],
    );
    const id = agents[0].id;
    await createConfigVersion(db, { orgId: org.id, agentId: id, settings: defaultSettings(AI_GROWTH_PARTNER_ROLE_KEY), source: "onboarding", userId: owner.id, apply: true });
    await db.query("insert into ai_growth_partners (org_id, runtime_agent_instance_id) values ($1, $2)", [org.id, id]);
    return id;
  });
  return { org, owner, ctx, agentId };
}

describe("apply to employees", () => {
  it("is off unless asked for: saving the preferences changes no employee", async () => {
    expect(aiPrefsInputSchema.parse({ ...PREFS }).applyToEmployees).toBe(false);
    expect(aiPrefsInputSchema.parse({ ...PREFS }).replaceOwnEdits).toBe(false);
    const c = await submitRealOnboarding({ name: "Apply Off Roofing", clearPayment: true });
    const before = await versionTotals(c.org.id);
    const res = await updateAiPreferences(c.ctx, { ...PREFS });
    expect(res).toEqual({ updated: [], held: [], skipped: [] });
    expect(await versionTotals(c.org.id)).toEqual(before);
  }, 120_000);

  it("previews and applies company preferences to the single AI Growth Partner configuration", async () => {
    const c = await createGrowthPartnerOnlyWorkspace("Preferences Growth Partner Only");
    const control = await createGrowthPartnerOnlyWorkspace("Preferences Growth Partner Control");
    const before = await rows<{ count: string }>("select count(*)::text as count from agent_config_versions where agent_instance_id = $1", [c.agentId]);
    const preferences = { ...PREFS, tone: "casual" as const };

    const savedOnly = await updateAiPreferences(c.ctx, preferences);
    expect(savedOnly).toEqual({ updated: [], held: [], skipped: [] });
    expect((await activeWorkforceOf(c.org.id, AI_GROWTH_PARTNER_ROLE_KEY)).settings.tone).toBe("friendly");
    expect(await rows<{ count: string }>("select count(*)::text as count from agent_config_versions where agent_instance_id = $1", [c.agentId])).toEqual(before);

    const preview = await previewAiPreferencesApply(c.ctx, preferences);
    expect(preview.employees).toContainEqual(expect.objectContaining({ role: AI_GROWTH_PARTNER_ROLE_KEY, name: "AI Growth Partner", changes: expect.arrayContaining([expect.objectContaining({ field: "tone" })]) }));
    const applied = await updateAiPreferences(c.ctx, { ...preferences, applyToEmployees: true });
    expect(applied.updated).toEqual([AI_GROWTH_PARTNER_ROLE_KEY]);
    expect(applied.held).toEqual([]);
    expect((await activeWorkforceOf(c.org.id, AI_GROWTH_PARTNER_ROLE_KEY)).settings.tone).toBe("casual");
    expect((await activeWorkforceOf(control.org.id, AI_GROWTH_PARTNER_ROLE_KEY)).settings.tone).toBe("friendly");
  }, 120_000);

  it("gives every configured employee a new version when asked, says which are applied and which wait, and never touches a role outside the plan", async () => {
    const c = await submitRealOnboarding({ name: "Apply All Roofing", clearPayment: true, disableRoles: ["sales_assistant"] });
    const entitled = APPLIED_ROLES.filter((r) => r !== "sales_assistant");
    const before = await versionTotals(c.org.id);
    // Only the Lead Hunter's guardrails already read like these preferences, so only its new version is applied; the others' role-specific guardrails would be replaced, which is a review.
    const res = await updateAiPreferences(c.ctx, { ...(await prefsLike(c.org.id, "lead_hunter", { tone: "premium" })), applyToEmployees: true });
    expect(res.updated).toEqual(["lead_hunter"]);
    expect([...res.updated, ...res.held].sort()).toEqual([...entitled].sort());
    expect((await activeOf(c.org.id, "lead_hunter")).settings.tone).toBe("premium");
    expect((await activeOf(c.org.id, "lead_hunter")).source).toBe("client_edit");
    for (const role of res.held) {
      expect((await activeOf(c.org.id, role)).settings.tone, role).not.toBe("premium");
      expect(await statusOfLatest(c.org.id, role), role).toBe("pending_agency_review");
    }
    const after = await versionTotals(c.org.id);
    expect(after.sales_assistant).toBe(before.sales_assistant);
    expect(after.crm_manager).toBe(before.crm_manager);
  }, 120_000);

  it("previews what would replace a client edit, and skips those fields unless the client ticks to replace them", async () => {
    const c = await submitRealOnboarding({ name: "Own Rules Roofing", clearPayment: true });
    const own = await ownCompanyRules(c.org.id, c.owner, "lead_hunter");
    expect((await activeOf(c.org.id, "lead_hunter")).settings.companyRules).toBe(own);

    const next = await prefsLike(c.org.id, "lead_hunter", { tone: "premium", companyRules: `${own} Be brief and kind.` });
    const keepOwn = { ...next, companyRules: "A new company-wide rule that is not the employee's own." };
    const preview = await previewAiPreferencesApply(c.ctx, keepOwn);
    const hunterPreview = preview.employees.find((e) => e.role === "lead_hunter")!;
    expect(hunterPreview.replaces.map((x) => x.field)).toEqual(["companyRules"]);
    expect(hunterPreview.changes.map((x) => x.field)).toContain("tone");
    expect(preview.employees.filter((e) => e.role !== "lead_hunter").every((e) => e.replaces.length === 0)).toBe(true);

    const kept = await updateAiPreferences(c.ctx, { ...keepOwn, applyToEmployees: true });
    expect(kept.skipped).toEqual([{ role: "lead_hunter", fields: ["companyRules"], why: "client_edit" }]);
    expect(kept.updated).toEqual(["lead_hunter"]);
    const hunterNow = await activeOf(c.org.id, "lead_hunter");
    expect(hunterNow.settings.companyRules).toBe(own);
    expect(hunterNow.settings.tone).toBe("premium");

    // Ticked: the employee's own wording is replaced too, and nothing is reported as skipped.
    const replaced = await updateAiPreferences(c.ctx, { ...next, tone: "casual", applyToEmployees: true, replaceOwnEdits: true });
    expect(replaced.skipped).toEqual([]);
    expect(replaced.updated).toEqual(["lead_hunter"]);
    expect((await activeOf(c.org.id, "lead_hunter")).settings.companyRules).toBe(`${own} Be brief and kind.`);
  }, 120_000);

  it("does not mistake an earlier company-wide apply for an employee's own edit", async () => {
    const c = await submitRealOnboarding({ name: "Twice Applied Roofing", clearPayment: true });
    const first = await updateAiPreferences(c.ctx, { ...(await prefsLike(c.org.id, "lead_hunter", { tone: "casual" })), applyToEmployees: true });
    expect(first.updated).toEqual(["lead_hunter"]);
    const second = await updateAiPreferences(c.ctx, { ...(await prefsLike(c.org.id, "lead_hunter", { tone: "premium" })), applyToEmployees: true });
    expect(second.skipped).toEqual([]);
    expect(second.updated).toEqual(["lead_hunter"]);
    expect((await activeOf(c.org.id, "lead_hunter")).settings.tone).toBe("premium");
  }, 120_000);

  it("reports a version that needs review as held, and the employee keeps what it ran", async () => {
    const c = await submitRealOnboarding({ name: "Apply Held Roofing", clearPayment: true });
    const rules = "Always contact customers by message right after a storm.";
    const res = await updateAiPreferences(c.ctx, { ...PREFS, companyRules: rules, applyToEmployees: true });
    expect(res.held.length).toBeGreaterThan(0);
    for (const role of res.held) {
      expect(res.updated).not.toContain(role);
      expect((await activeOf(c.org.id, role)).settings.companyRules, role).not.toBe(rules);
      expect(await statusOfLatest(c.org.id, role), role).toBe("pending_agency_review");
    }
    expect(aiPreferencesApplyMessage({ updated: res.updated.length, held: res.held.length, keptOwn: 0, blocked: 0 })).toMatch(/waiting for iAcquire's review/);
  }, 120_000);

  it("does not let one blocked version discard the others, or the saved preferences", async () => {
    const c = await submitRealOnboarding({ name: "Apply Blocked Roofing", clearPayment: true });
    const analyst = await agentId(c.org.id, "performance_analyst");
    const prefs = await prefsLike(c.org.id, "lead_hunter", { tone: "premium" });
    control.blockAgent = analyst;
    try {
      const res = await updateAiPreferences(c.ctx, { ...prefs, applyToEmployees: true });
      expect(res.skipped).toEqual([{ role: "performance_analyst", fields: expect.arrayContaining(["tone"]), why: "blocked", detail: "This change is blocked: test" }]);
      expect(res.updated).toEqual(["lead_hunter"]);
      expect([...res.held].sort()).toEqual(APPLIED_ROLES.filter((r) => r !== "performance_analyst" && r !== "lead_hunter").sort());
    } finally {
      control.blockAgent = null;
    }
    expect((await activeOf(c.org.id, "performance_analyst")).settings.tone).not.toBe("premium");
    expect((await activeOf(c.org.id, "lead_hunter")).settings.tone).toBe("premium");
    expect((await storedPrefs(c.org.id)).tone).toBe("premium");
    expect(await rows("select 1 from audit_logs where org_id = $1 and action = 'settings.ai_preferences_updated' and (metadata->>'skipped')::int = 1", [c.org.id])).toHaveLength(1);
  }, 120_000);

  it("never touches another client's employees, and only an owner or admin may apply", async () => {
    const a = await submitRealOnboarding({ name: "Apply Iso A", clearPayment: true });
    const b = await submitRealOnboarding({ name: "Apply Iso B", clearPayment: true });
    const bBefore = await versionTotals(b.org.id);
    await updateAiPreferences(a.ctx, { ...PREFS, tone: "premium", applyToEmployees: true });
    expect(await versionTotals(b.org.id)).toEqual(bBefore);
    expect((await storedPrefs(b.org.id)).tone).not.toBe("premium");

    const viewer = await createUser();
    await addMember(a.org.id, viewer.id, "viewer");
    const asViewer = ctxFor(viewer, a.org, "viewer");
    await expect(updateAiPreferences(asViewer, { ...PREFS })).rejects.toMatchObject({ code: "forbidden" });
    await expect(previewAiPreferencesApply(asViewer, { ...PREFS })).rejects.toMatchObject({ code: "forbidden" });
  }, 120_000);
});

describe("aiPreferencesApplyMessage", () => {
  it("says only what is true", () => {
    expect(aiPreferencesApplyMessage({ updated: 0, held: 0, keptOwn: 0, blocked: 0 })).toBe("");
    expect(aiPreferencesApplyMessage({ updated: 1, held: 0, keptOwn: 0, blocked: 0 })).toBe("Applied to 1 retained profile.");
    expect(aiPreferencesApplyMessage({ updated: 4, held: 2, keptOwn: 1, blocked: 1 })).toBe(
      "Applied to 4 retained profiles. 2 updates are waiting for iAcquire's review. 1 retained profile kept its own wording for some fields. 1 retained profile could not be updated.",
    );
    expect(aiPreferencesApplyMessage({ updated: 1, held: 0, keptOwn: 0, blocked: 0, growthPartnerUpdated: true })).toBe("Applied to your AI Growth Partner.");
    expect(aiPreferencesApplyMessage({ updated: 3, held: 0, keptOwn: 0, blocked: 0, growthPartnerUpdated: true })).toBe("Applied to your AI Growth Partner and 2 retained profiles.");
  });
});
