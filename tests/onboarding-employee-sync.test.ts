// What keeps an AI employee in step with the client's answers and business information: the shared per-employee build (the part a submission runs), a submission that no
// longer ignores an employee with no configuration, a Settings edit reaching the employees without touching their settings, and the report of who is behind. Embedded
// Postgres on the real migrations; nothing talks to a provider.
import { describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { agentSettingsSchema } from "@/lib/agent-settings";
import { defaultSettings } from "@/server/workforce/compiler";
import { confirmedAnswers, planScope, toLegacyData } from "@/lib/onboarding/engine";
import { getProfile, writeBusinessProfile } from "@/server/settings/service";
import { lockOnboardingRow, syncProfileToAnswers } from "@/server/onboarding/profile-sync";
import { saveOnboardingStep, submitOnboarding } from "@/server/onboarding/service";
import { loadAnswerRows, toStored } from "@/server/onboarding/answers";
import { employeeSyncState, hasUnconfiguredEnabledEmployee, refreshEmployeesFromWorkspace, syncEmployeesFromAnswers } from "@/server/onboarding/employee-sync";
import { createConfigVersion, decideHeldVersion } from "@/server/workforce/service";
import { agentId, createOrg, createUser, ctxFor } from "./support/fixtures";
import { submitRealOnboarding } from "./support/billing";

type Ctx = ReturnType<typeof ctxFor>;
// With these answers the CRM Manager's first configuration is held for review (a risk flag on its role template), so it has no applied configuration; the other five do.
const HELD_FIRST: AgentRoleKey = "crm_manager";
const APPLIED_ROLES = AGENT_ROLE_KEYS.filter((r) => r !== HELD_FIRST);
const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;

const versionsOf = (orgId: string, role: AgentRoleKey) => rows<{ version: number; source: string; status: string; settings: unknown; compiled_instructions: string; change_request: string | null }>(
  `select v.version, v.source, v.status, v.settings, v.compiled_instructions, v.change_request from agent_config_versions v join agent_instances a on a.id = v.agent_instance_id
    where a.org_id = $1 and a.role_key = $2 order by v.version`, [orgId, role]);
const activeOf = async (orgId: string, role: AgentRoleKey) => (await rows<{ version: number; source: string; settings: Record<string, unknown>; compiled_instructions: string }>(
  `select v.version, v.source, v.settings, v.compiled_instructions from agent_config_versions v join agent_instances a on a.active_config_version_id = v.id where a.org_id = $1 and a.role_key = $2`, [orgId, role]))[0];
const versionTotals = async (orgId: string) => Object.fromEntries((await rows<{ role_key: string; n: number }>(
  "select a.role_key, count(v.id)::int as n from agent_instances a left join agent_config_versions v on v.agent_instance_id = a.id where a.org_id = $1 group by a.role_key", [orgId])).map((r) => [r.role_key, r.n]));
const createdAudits = async (orgId: string, role: AgentRoleKey) => Number((await rows<{ n: string }>(
  "select count(*) as n from audit_logs l join agent_instances a on a.id = l.agent_instance_id where l.org_id = $1 and a.role_key = $2 and l.action = 'agent.config_version_created'", [orgId, role]))[0].n);

// The platform allows exactly one internal agency workspace.
let internal: Awaited<ReturnType<typeof createOrg>> | null = null;
const internalWorkspace = async () => (internal ??= await createOrg({ name: "Internal Workspace", kind: "agency" }));

/**
 * The whole Settings form, as the browser sends it: the current profile with a few facts changed. Written the way Settings writes it (the profile, then the answers that follow it)
 * but WITHOUT the catch-up of the employees that updateProfile now runs after it, so these tests can run that catch-up themselves and look at each step. The catch-up through
 * updateProfile is covered in tests/onboarding-employee-sync-settings.test.ts.
 */
async function settingsEdit(ctx: Ctx, patch: Partial<Record<"name" | "industry" | "website" | "region" | "timezone" | "description" | "services" | "idealCustomers" | "brandColor", string>>) {
  const p = (await getProfile(ctx))!;
  await withUser(ctx.user.id, async (db) => {
    await lockOnboardingRow(db, ctx.org.orgId);
    const res = await writeBusinessProfile(db, ctx, {
      name: p.name, industry: p.industry ?? "", website: p.website ?? "", region: p.region ?? "", timezone: p.timezone, description: p.description ?? "", services: p.services ?? "",
      idealCustomers: p.ideal_customers ?? "", brandColor: p.brand_color ?? "", ...patch,
    });
    await syncProfileToAnswers(db, ctx, { changed: res.changed, values: res.values });
  });
}
const save = (ctx: Ctx, answers: Record<string, unknown>) => saveOnboardingStep(ctx, { answers: Object.fromEntries(Object.entries(answers).map(([k, value]) => [k, { value }])) });
const refresh = (ctx: Ctx, keys: Array<"services" | "description" | "name" | "idealCustomers">) => withSystem((db) => refreshEmployeesFromWorkspace(db, ctx, { reason: "Business profile updated in Settings", keys }));
const stateOf = async (orgId: string) => Object.fromEntries((await withSystem((db) => employeeSyncState(db, orgId))).map((r) => [r.role, r.state]));

async function answersData(orgId: string) {
  const roles = (await rows<{ role_key: AgentRoleKey }>("select role_key from agent_instances where org_id = $1 and enabled", [orgId])).map((r) => r.role_key);
  const stored = toStored(await withSystem((db) => loadAnswerRows(db, orgId)));
  return { roles, data: toLegacyData(confirmedAnswers(stored, planScope(roles)), roles) };
}

describe("the per-employee build a submission shares with the rest of the platform", () => {
  it("leaves every employee as it is when the same answers are applied again, and says so", async () => {
    const c = await submitRealOnboarding({ name: "Shared Build Roofing", clearPayment: true });
    const before = await versionTotals(c.org.id);
    expect(Object.values(before).every((n) => n === 1)).toBe(true);
    const { roles, data } = await answersData(c.org.id);
    const out = await withSystem((db) => syncEmployeesFromAnswers(db, { orgId: c.org.id, userId: c.owner.id, actorKind: "user" }, { data, selected: roles, basis: { firstSubmission: false, generated: null } }));
    expect(out).toHaveLength(6);
    expect(out.map((e) => e.configStatus)).toEqual(Array(6).fill("unchanged"));
    expect(await versionTotals(c.org.id)).toEqual(before);
  }, 120_000);

  it("changes a business-derived field of one employee and keeps what the client wrote in another", async () => {
    const c = await submitRealOnboarding({ name: "Preserve Roofing", clearPayment: true });
    const analyst = await agentId(c.org.id, "performance_analyst");
    const own = "Our own wording, written by the client.";
    const active = (await activeOf(c.org.id, "performance_analyst")).settings;
    await withSystem((db) => createConfigVersion(db, { orgId: c.org.id, agentId: analyst, settings: agentSettingsSchema.parse({ ...active, personality: own }), source: "client_edit", userId: c.owner.id, apply: true }));
    await save(c.ctx, { "c.tone": "casual" });
    await save(c.ctx, { "f.review": true });
    await submitOnboarding(c.ctx);
    expect((await activeOf(c.org.id, "performance_analyst")).settings.personality).toBe(own);
    expect((await activeOf(c.org.id, "lead_hunter")).settings.tone).toBe("casual");
  }, 120_000);
});

describe("a submission and an employee with no configuration", () => {
  it("builds an enabled employee that has none, even though no answer changed", async () => {
    const c = await submitRealOnboarding({ name: "Late Plan Roofing", clearPayment: true, disableRoles: ["sales_assistant"] });
    const others = await versionTotals(c.org.id);
    expect(others.sales_assistant).toBe(0);
    expect(await withSystem((db) => hasUnconfiguredEnabledEmployee(db, c.org.id))).toBe(false);
    // The plan changes by a plain switch (nothing here goes through the plan-change path), and nothing about the answers does.
    await withSystem((db) => db.query("update agent_instances set enabled = true where org_id = $1 and role_key = 'sales_assistant'", [c.org.id]));
    expect(await withSystem((db) => hasUnconfiguredEnabledEmployee(db, c.org.id))).toBe(true);
    const result = await submitOnboarding(c.ctx);
    expect(result.employees.find((e) => e.role === "sales_assistant")).toMatchObject({ configStatus: "applied" });
    const after = await versionTotals(c.org.id);
    expect(after.sales_assistant).toBe(1);
    // Everyone else was already as the answers say.
    for (const role of AGENT_ROLE_KEYS.filter((r) => r !== "sales_assistant")) expect(after[role], role).toBe(others[role]);
    expect(await withSystem((db) => hasUnconfiguredEnabledEmployee(db, c.org.id))).toBe(false);
  }, 120_000);

  it("still takes the quiet path when nothing changed and every enabled employee is configured", async () => {
    const c = await submitRealOnboarding({ name: "Quiet Roofing", clearPayment: true });
    const before = await versionTotals(c.org.id);
    const result = await submitOnboarding(c.ctx);
    expect(result.employees.every((e) => e.configStatus === "unchanged")).toBe(true);
    expect(result.scheduling.state).toBe("unchanged");
    expect(await versionTotals(c.org.id)).toEqual(before);
  }, 120_000);

  it("does not count an employee whose first configuration is waiting for review, or one that is switched off", async () => {
    const c = await submitRealOnboarding({ name: "Held Roofing", clearPayment: true, disableRoles: ["sales_assistant"] });
    const sales = await agentId(c.org.id, "sales_assistant");
    await withSystem((db) => db.query("update agent_instances set enabled = true where id = $1", [sales]));
    expect(await withSystem((db) => hasUnconfiguredEnabledEmployee(db, c.org.id))).toBe(true);
    // A first version that was held: the employee has no applied configuration, but something is already waiting, and a submission would only repeat it.
    await withSystem((db) => db.query(
      `insert into agent_config_versions (org_id, agent_instance_id, version, settings, summary, compiled_instructions, policy_version, source, status, created_by)
       select $1, $2, 1, settings, summary, compiled_instructions, policy_version, 'onboarding', 'pending_agency_review', $3 from agent_config_versions where agent_instance_id = (select id from agent_instances where org_id = $1 and role_key = 'lead_hunter') limit 1`,
      [c.org.id, sales, c.owner.id]));
    expect(await withSystem((db) => hasUnconfiguredEnabledEmployee(db, c.org.id))).toBe(false);
  }, 120_000);
});

describe("a business-information edit reaches the employees", () => {
  it("gives each entitled employee one new attributed version with its settings untouched, and leaves a non-entitled role alone", async () => {
    const c = await submitRealOnboarding({ name: "Refresh Roofing", clearPayment: true, disableRoles: ["sales_assistant"] });
    const entitled = APPLIED_ROLES.filter((r) => r !== "sales_assistant");
    const before = new Map<string, { version: number; settings: Record<string, unknown> }>();
    for (const role of entitled) before.set(role, await activeOf(c.org.id, role));
    await settingsEdit(c.ctx, { services: "Roof repair, gutter replacement and skylight sealing" });
    const result = await refresh(c.ctx, ["services"]);
    expect(result.updated.sort()).toEqual([...entitled].sort());
    expect(result.held).toEqual([]);
    for (const role of entitled) {
      const now = await activeOf(c.org.id, role);
      expect(now.version, role).toBe(before.get(role)!.version + 1);
      expect(now.source).toBe("onboarding");
      expect(now.compiled_instructions, role).toContain("skylight sealing");
      // The settings are the ones the employee already ran, so nothing the client changed can have moved.
      expect(now.settings, role).toEqual(before.get(role)!.settings);
      expect(await createdAudits(c.org.id, role), role).toBe(2);
    }
    // The role that is not in the plan got no version and no row of any kind; the one still waiting for its first review is not rewritten behind the reviewer's back.
    expect(await versionsOf(c.org.id, "sales_assistant")).toHaveLength(0);
    expect(await versionsOf(c.org.id, HELD_FIRST)).toHaveLength(1);
    expect(result.updated).not.toContain("sales_assistant");
  }, 120_000);

  it("keeps a personality the client wrote", async () => {
    const c = await submitRealOnboarding({ name: "Personality Roofing", clearPayment: true });
    const analyst = await agentId(c.org.id, "performance_analyst");
    const own = "Our own wording, written by the client.";
    const active = (await activeOf(c.org.id, "performance_analyst")).settings;
    await withSystem((db) => createConfigVersion(db, { orgId: c.org.id, agentId: analyst, settings: agentSettingsSchema.parse({ ...active, personality: own }), source: "client_edit", userId: c.owner.id, apply: true }));
    await settingsEdit(c.ctx, { services: "A services text that changes what every employee is told" });
    const result = await refresh(c.ctx, ["services"]);
    expect(result.updated).toContain("performance_analyst");
    const now = await activeOf(c.org.id, "performance_analyst");
    expect(now.settings.personality).toBe(own);
    expect(now.source).toBe("onboarding");
    expect(now.compiled_instructions).toContain("A services text that changes what every employee is told");
    expect(now.compiled_instructions).toContain(own);
  }, 120_000);

  it("makes no version when the same text is saved twice", async () => {
    const c = await submitRealOnboarding({ name: "Twice Roofing", clearPayment: true });
    await settingsEdit(c.ctx, { services: "Exactly this text, saved twice" });
    expect((await refresh(c.ctx, ["services"])).updated).toHaveLength(APPLIED_ROLES.length);
    const after = await versionTotals(c.org.id);
    await settingsEdit(c.ctx, { services: "Exactly this text, saved twice" });
    const again = await refresh(c.ctx, ["services"]);
    expect(again.updated).toEqual([]);
    expect(again.unchanged).toHaveLength(APPLIED_ROLES.length);
    expect(await versionTotals(c.org.id)).toEqual(after);
    // A refresh with nothing named does nothing either.
    expect(await withSystem((db) => refreshEmployeesFromWorkspace(db, c.ctx, { reason: "Nothing changed", keys: [] }))).toMatchObject({ updated: [], held: [], unchanged: [] });
  }, 120_000);

  it("does not apply an answer edit the client has not approved", async () => {
    const c = await submitRealOnboarding({ name: "Unapproved Roofing", clearPayment: true });
    const knowledgeBefore = (await rows<{ content: string }>("select content from company_knowledge where org_id = $1 and section = 'products_services'", [c.org.id]))[0].content;
    await save(c.ctx, { "b.services": "Waiting in the questionnaire, not approved" });
    await settingsEdit(c.ctx, { description: "A new description written in Settings for the roofing company" });
    const result = await refresh(c.ctx, ["description"]);
    // The description is the workspace's own and reaches the employees; the unapproved answer reaches nobody and no knowledge section.
    expect(result.updated).toHaveLength(APPLIED_ROLES.length);
    expect(result.knowledge).toEqual({ written: [], kept: [] });
    const knowledge = (await rows<{ content: string }>("select content from company_knowledge where org_id = $1 and section = 'products_services'", [c.org.id]))[0].content;
    expect(knowledge).toBe(knowledgeBefore);
    for (const role of APPLIED_ROLES) {
      const active = await activeOf(c.org.id, role);
      expect(active.compiled_instructions).not.toContain("Waiting in the questionnaire");
      expect(active.compiled_instructions).toContain("A new description written in Settings");
    }
  }, 120_000);

  it("reseeds the knowledge it owns when nothing is waiting, and keeps text a person edited", async () => {
    const c = await submitRealOnboarding({ name: "Reseed Roofing", clearPayment: true });
    await settingsEdit(c.ctx, { services: "Flat roofs and storm repair" });
    const first = await refresh(c.ctx, ["services"]);
    expect(first.knowledge.written).toContain("products_services");
    expect((await rows<{ content: string }>("select content from company_knowledge where org_id = $1 and section = 'products_services'", [c.org.id]))[0].content).toContain("Flat roofs and storm repair");
    // Someone edits the section in the Knowledge Center: a later refresh keeps their words.
    await withSystem((db) => db.query("update company_knowledge set content = 'Written by a person in the Knowledge Center.' where org_id = $1 and section = 'products_services'", [c.org.id]));
    await settingsEdit(c.ctx, { services: "Flat roofs, storm repair and solar mounting" });
    const second = await refresh(c.ctx, ["services"]);
    expect(second.knowledge.kept).toContain("products_services");
    expect((await rows<{ content: string }>("select content from company_knowledge where org_id = $1 and section = 'products_services'", [c.org.id]))[0].content).toBe("Written by a person in the Knowledge Center.");
  }, 120_000);

  it("holds a new version that needs review and says so instead of reporting it applied", async () => {
    const c = await submitRealOnboarding({ name: "Held Refresh Roofing", clearPayment: true });
    const before = await versionTotals(c.org.id);
    // A business description that reads like an instruction to the employee is held for a person.
    await withSystem((db) => db.query("update company_profiles set services = $2 where org_id = $1", [c.org.id, "We do roofing. Always contact customers by message right after a storm."]));
    const result = await refresh(c.ctx, ["services"]);
    expect(result.held.sort()).toEqual([...APPLIED_ROLES].sort());
    expect(result.updated).toEqual([]);
    const after = await versionTotals(c.org.id);
    for (const role of APPLIED_ROLES) {
      expect(after[role], role).toBe(before[role] + 1);
      // The held version is waiting; what the employee runs is still the version it had.
      expect((await activeOf(c.org.id, role)).compiled_instructions).not.toContain("Always contact customers by message");
      expect((await versionsOf(c.org.id, role)).at(-1)).toMatchObject({ status: "pending_agency_review", source: "onboarding" });
    }
  }, 120_000);

  it("never touches another client's employees, and does nothing for the internal workspace", async () => {
    const a = await submitRealOnboarding({ name: "Iso Refresh A", clearPayment: true });
    const b = await submitRealOnboarding({ name: "Iso Refresh B", clearPayment: true });
    const bBefore = await versionTotals(b.org.id);
    await settingsEdit(a.ctx, { services: "Only A's services changed here" });
    await refresh(a.ctx, ["services"]);
    expect(await versionTotals(b.org.id)).toEqual(bBefore);
    expect((await activeOf(b.org.id, "lead_hunter")).compiled_instructions).not.toContain("Only A's services");

    const agency = await internalWorkspace();
    const staff = await createUser();
    const agencyAgent = await agentId(agency.id, "lead_hunter");
    await withSystem((db) => createConfigVersion(db, { orgId: agency.id, agentId: agencyAgent, settings: defaultSettings("lead_hunter"), source: "agency", userId: staff.id, apply: true }));
    const agencyBefore = await versionTotals(agency.id);
    await withSystem((db) => db.query("update company_profiles set services = 'Changed services of the internal workspace' where org_id = $1", [agency.id]));
    const none = await withSystem((db) => refreshEmployeesFromWorkspace(db, ctxFor(staff, agency, "owner"), { reason: "Business profile updated in Settings", keys: ["services"] }));
    expect(none).toMatchObject({ updated: [], held: [], unchanged: [] });
    expect(await versionTotals(agency.id)).toEqual(agencyBefore);
  }, 120_000);
});

describe("who is behind the answers", () => {
  it("reports every enabled employee in step after a submission, and nothing for a workspace that has not submitted", async () => {
    const c = await submitRealOnboarding({ name: "In Step Roofing", clearPayment: true, disableRoles: ["sales_assistant"] });
    // The CRM Manager's first configuration is waiting for review, which is what "held" says; the sales role is not in the plan and is not listed.
    expect(await stateOf(c.org.id)).toEqual({
      operations_manager: "in_sync", lead_hunter: "in_sync", appointment_setter: "in_sync", crm_manager: "held", performance_analyst: "in_sync",
    });
    const fresh = await createOrg({ name: "Not Submitted Co" });
    expect(await withSystem((db) => employeeSyncState(db, fresh.id))).toEqual([]);
    const internalId = (await internalWorkspace()).id;
    expect(await withSystem((db) => employeeSyncState(db, internalId))).toEqual([]);
  }, 120_000);

  it("does not count a client's own edit as drift, and notices when the business information moved on", async () => {
    const c = await submitRealOnboarding({ name: "Drift Roofing", clearPayment: true });
    const analyst = await agentId(c.org.id, "performance_analyst");
    const active = (await activeOf(c.org.id, "performance_analyst")).settings;
    await withSystem((db) => createConfigVersion(db, { orgId: c.org.id, agentId: analyst, settings: agentSettingsSchema.parse({ ...active, personality: "The client's own wording." }), source: "client_edit", userId: c.owner.id, apply: true }));
    expect((await stateOf(c.org.id)).performance_analyst).toBe("in_sync");
    // The workspace's information changes and nothing has been refreshed yet: every employee is behind, and a refresh brings them back.
    await settingsEdit(c.ctx, { services: "Metal roofing and gutters" });
    const behind = await withSystem((db) => employeeSyncState(db, c.org.id));
    expect(behind.filter((r) => r.role !== HELD_FIRST).map((r) => r.state)).toEqual(Array(APPLIED_ROLES.length).fill("behind"));
    expect(behind.find((r) => r.role === "lead_hunter")!.reason).toMatch(/business information/i);
    await refresh(c.ctx, ["services"]);
    // The refresh recompiles instructions and never touches settings, so the employees are back in step with the information. The Sales Assistant's role answer ("what we offer")
    // is built from the same services answer, so it still says it is behind the approved answers; bringing its settings in step is the answers' own sync.
    expect(await stateOf(c.org.id)).toEqual({
      operations_manager: "in_sync", lead_hunter: "in_sync", appointment_setter: "in_sync", sales_assistant: "behind", crm_manager: "held", performance_analyst: "in_sync",
    });
    const { roles, data } = await answersData(c.org.id);
    await withSystem((db) => syncEmployeesFromAnswers(db, { orgId: c.org.id, userId: c.owner.id, actorKind: "user" }, { data, selected: roles, basis: { firstSubmission: false, generated: null } }));
    expect((await stateOf(c.org.id)).sales_assistant).toBe("in_sync");
    // The client's own personality survived both.
    expect((await activeOf(c.org.id, "performance_analyst")).settings.personality).toBe("The client's own wording.");
  }, 120_000);

  it("ignores answers the client has changed but not approved", async () => {
    const c = await submitRealOnboarding({ name: "Pending Answers Roofing", clearPayment: true });
    await save(c.ctx, { "c.tone": "casual" });
    expect(Object.values(await stateOf(c.org.id)).filter((s) => s !== "held")).toEqual(Array(APPLIED_ROLES.length).fill("in_sync"));
  }, 120_000);

  it("reports held while a version is waiting for review, and behind once it is rejected", async () => {
    const c = await submitRealOnboarding({ name: "Rejected Roofing", clearPayment: true });
    // The client rewrites the company rules (a guardrail change, so the new version is held for a person) and approves the change.
    await save(c.ctx, { "c.company_rules": "Always greet customers by name and offer a call-back." });
    await save(c.ctx, { "f.review": true });
    const submitted = await submitOnboarding(c.ctx);
    const heldRoles = submitted.employees.filter((e) => e.configStatus === "pending_agency_review" && e.role !== HELD_FIRST).map((e) => e.role);
    expect(heldRoles.length).toBeGreaterThan(0);
    const states = await stateOf(c.org.id);
    for (const role of heldRoles) expect(states[role], role).toBe("held");

    const reviewer = await createUser({ platformRole: "agency_super_admin" });
    for (const role of heldRoles) {
      const pending = (await rows<{ id: string }>(
        "select v.id from agent_config_versions v join agent_instances a on a.id = v.agent_instance_id where a.org_id = $1 and a.role_key = $2 and v.status = 'pending_agency_review'", [c.org.id, role]))[0];
      await withSystem((db) => decideHeldVersion(db, { orgId: c.org.id, versionId: pending.id, approve: false, agencyUserId: reviewer.id }));
    }
    const after = await withSystem((db) => employeeSyncState(db, c.org.id));
    for (const role of heldRoles) {
      const row = after.find((r) => r.role === role)!;
      expect(row.state, role).toBe("behind");
      expect(row.reason).toMatch(/approved answers/i);
    }
  }, 120_000);

  it("reports a stale employee only for its own workspace", async () => {
    const a = await submitRealOnboarding({ name: "Stale A", clearPayment: true });
    const b = await submitRealOnboarding({ name: "Stale B", clearPayment: true });
    await settingsEdit(a.ctx, { services: "Changed for A only" });
    expect(Object.values(await stateOf(a.org.id)).filter((s) => s !== "held")).toEqual(Array(APPLIED_ROLES.length).fill("behind"));
    expect(Object.values(await stateOf(b.org.id)).filter((s) => s !== "held")).toEqual(Array(APPLIED_ROLES.length).fill("in_sync"));
  }, 120_000);
});
