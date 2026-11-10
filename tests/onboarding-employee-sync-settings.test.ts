// A business-information edit made in Settings reaches the employees that should hear about it, safely: updateProfile catches the entitled employees up after the edit has
// committed (one new attributed version each, nothing the client changed on an employee touched), says what is waiting for review instead of calling it applied, keeps a profile
// that was saved when the catch-up fails, and leaves a before-and-after in the audit row. Settings > Team lists the people the client named in setup who are not invited yet.
// Embedded Postgres on the real migrations; nothing talks to a provider.
import { describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { agentSettingsSchema } from "@/lib/agent-settings";
import { employeeUpdateMessage } from "@/lib/onboarding/business-profile";
import { getProfile, getTeamSuggestions, inviteMember, updateProfile } from "@/server/settings/service";
import { getGrowthPartnerControlState, saveGrowthPartnerBusinessBrainFactDraft } from "@/server/ai-growth-partner/service";
import { saveOnboardingStep } from "@/server/onboarding/service";
import { createConfigVersion } from "@/server/workforce/service";
import { addMember, agentId, createOrg, createUser, ctxFor } from "./support/fixtures";
import { submitRealOnboarding } from "./support/billing";

// One test makes the catch-up fail; every other test runs the real one.
const control = vi.hoisted(() => ({ failRefresh: false }));
vi.mock("@/server/onboarding/employee-sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/onboarding/employee-sync")>();
  return {
    ...actual,
    refreshEmployeesFromWorkspace: (...args: Parameters<typeof actual.refreshEmployeesFromWorkspace>) => {
      if (control.failRefresh) throw new Error("the catch-up failed");
      return actual.refreshEmployeesFromWorkspace(...args);
    },
  };
});

type Ctx = ReturnType<typeof ctxFor>;
// With these answers the CRM Manager's first configuration is held for review (a risk flag on its role template), so it has no applied configuration; the other five do.
const HELD_FIRST: AgentRoleKey = "crm_manager";
const APPLIED_ROLES = AGENT_ROLE_KEYS.filter((r) => r !== HELD_FIRST);
const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;

const versionsOf = (orgId: string, role: AgentRoleKey) => rows<{ version: number; source: string; status: string; compiled_instructions: string }>(
  `select v.version, v.source, v.status, v.compiled_instructions from agent_config_versions v join agent_instances a on a.id = v.agent_instance_id
    where a.org_id = $1 and a.role_key = $2 order by v.version`, [orgId, role]);
const activeOf = async (orgId: string, role: AgentRoleKey) => (await rows<{ version: number; source: string; settings: Record<string, unknown>; compiled_instructions: string }>(
  `select v.version, v.source, v.settings, v.compiled_instructions from agent_config_versions v join agent_instances a on a.active_config_version_id = v.id where a.org_id = $1 and a.role_key = $2`, [orgId, role]))[0];
const versionTotals = async (orgId: string) => Object.fromEntries((await rows<{ role_key: string; n: number }>(
  "select a.role_key, count(v.id)::int as n from agent_instances a left join agent_config_versions v on v.agent_instance_id = a.id where a.org_id = $1 group by a.role_key", [orgId])).map((r) => [r.role_key, r.n]));
const createdAudits = async (orgId: string, role: AgentRoleKey) => Number((await rows<{ n: string }>(
  "select count(*) as n from audit_logs l join agent_instances a on a.id = l.agent_instance_id where l.org_id = $1 and a.role_key = $2 and l.action = 'agent.config_version_created'", [orgId, role]))[0].n);
const profileAudit = async (orgId: string) => (await rows<{ metadata: Record<string, unknown> }>(
  "select metadata from audit_logs where org_id = $1 and action = 'settings.profile_updated' order by id desc limit 1", [orgId]))[0]?.metadata;
const partnerVersions = (orgId: string) => rows<{ version: number; current_version: number | null; business_brain: unknown; source_metadata: Record<string, unknown> }>(
  `select v.version, p.current_version, v.business_brain, v.source_metadata
   from ai_growth_partners p join ai_growth_partner_versions v on v.partner_id = p.id and v.org_id = p.org_id
   where p.org_id = $1 order by v.version`, [orgId]);
const knowledgeOf = async (orgId: string, section: string) => (await rows<{ content: string }>("select content from company_knowledge where org_id = $1 and section = $2", [orgId, section]))[0]?.content;

/** The whole Settings form, as the browser sends it: the current profile with a few facts changed. */
async function settingsEdit(ctx: Ctx, patch: Partial<Record<"name" | "industry" | "website" | "region" | "timezone" | "description" | "services" | "idealCustomers" | "brandColor", string>>) {
  const p = (await getProfile(ctx))!;
  return updateProfile(ctx, {
    name: p.name, industry: p.industry ?? "", website: p.website ?? "", region: p.region ?? "", timezone: p.timezone, description: p.description ?? "", services: p.services ?? "",
    idealCustomers: p.ideal_customers ?? "", brandColor: p.brand_color ?? "", ...patch,
  });
}
const save = (ctx: Ctx, answers: Record<string, unknown>) => saveOnboardingStep(ctx, { answers: Object.fromEntries(Object.entries(answers).map(([k, value]) => [k, { value }])) });

describe("a Settings > Business profile edit reaches the employees", () => {
  it("gives each entitled employee one new attributed version and one audit row, and leaves a role that is not in the plan alone", async () => {
    const c = await submitRealOnboarding({ name: "Reach Roofing", clearPayment: true, disableRoles: ["sales_assistant"] });
    const entitled = APPLIED_ROLES.filter((r) => r !== "sales_assistant");
    const before = new Map<AgentRoleKey, { version: number; audits: number }>();
    for (const role of entitled) before.set(role, { version: (await activeOf(c.org.id, role)).version, audits: await createdAudits(c.org.id, role) });

    const saved = await settingsEdit(c.ctx, { services: "Roof repair, gutter replacement and skylight sealing" });

    expect([...saved.employees.updated].sort()).toEqual([...entitled].sort());
    expect(saved.employees.held).toEqual([]);
    expect(saved.employees.failed).toBe(false);
    for (const role of entitled) {
      const now = await activeOf(c.org.id, role);
      expect(now.version, role).toBe(before.get(role)!.version + 1);
      expect(now.source, role).toBe("onboarding");
      expect(now.compiled_instructions, role).toContain("skylight sealing");
      expect(await createdAudits(c.org.id, role), role).toBe(before.get(role)!.audits + 1);
    }
    // The role outside the plan got nothing, and the one still waiting for its first review is not rewritten behind the reviewer's back.
    expect(await versionsOf(c.org.id, "sales_assistant")).toHaveLength(0);
    expect(await versionsOf(c.org.id, HELD_FIRST)).toHaveLength(1);
  }, 120_000);

  it("syncs confirmed profile facts into the active Growth Partner brain and rebases an existing draft without activating it", async () => {
    const c = await submitRealOnboarding({
      name: "Brain Profile Roofing",
      clearPayment: true,
      withGrowthPartner: true,
      extraAnswers: { "a.contact_phone": "+1 512 555 0100" },
    });
    const before = await getGrowthPartnerControlState(c.ctx);
    expect(before?.currentVersion).not.toBeNull();
    const activeBefore = before!.currentBusinessBrain!;
    expect(activeBefore.sections.businessIdentity.contactEmail).toMatchObject({
      value: c.owner.email, state: "client_confirmed", provenance: [{ source: "onboarding", sourceId: "a.contact_email" }],
    });
    expect(activeBefore.sections.businessIdentity.contactPhone).toMatchObject({
      value: "+15125550100", state: "client_confirmed", provenance: [{ source: "onboarding", sourceId: "a.contact_phone" }],
    });
    await saveGrowthPartnerBusinessBrainFactDraft(c.ctx, {
      baseVersion: before!.currentVersion!, section: "salesKnowledge", key: "objectionHandling",
      valueText: "Ask a person to review refund objections before responding.",
    });

    const saved = await settingsEdit(c.ctx, { services: "Roof inspection, storm repair and gutter installation" });

    expect(saved.growthPartner).toEqual({ updated: true, held: false, failed: false });
    const after = await getGrowthPartnerControlState(c.ctx);
    expect(after?.currentVersion).toBeGreaterThan(before!.currentVersion!);
    expect(after?.currentBusinessBrain?.sections.productsServicesOffers.services).toMatchObject({
      value: "Roof inspection, storm repair and gutter installation", state: "client_confirmed", clientOverride: true,
    });
    expect(after?.currentBusinessBrain?.sections.productsServicesOffers.services.provenance.at(-1)).toMatchObject({
      source: "client_confirmed", sourceId: "settings.profile.services",
    });
    expect(after?.currentBusinessBrain?.sections.productsServicesOffers.pricing).toEqual(activeBefore.sections.productsServicesOffers.pricing);
    expect(after?.draftVersion).toBeGreaterThan(after!.currentVersion!);
    expect(after?.draftBusinessBrain?.sections.salesKnowledge.objectionHandling.value).toBe("Ask a person to review refund objections before responding.");
    expect(after?.draftBusinessBrain?.sections.productsServicesOffers.services.value).toBe("Roof inspection, storm repair and gutter installation");
    expect((await partnerVersions(c.org.id)).at(-1)?.source_metadata).toMatchObject({
      submittedFrom: "workspace_settings", syncKind: "business_profile", reviewRequired: false,
    });
  }, 120_000);

  it("keeps instruction-like profile text out of the active Business Brain until review", async () => {
    const c = await submitRealOnboarding({ name: "Held Brain Roofing", clearPayment: true, withGrowthPartner: true });
    const before = await getGrowthPartnerControlState(c.ctx);
    const originalVersion = before!.currentVersion!;
    const originalServices = before!.currentBusinessBrain!.sections.productsServicesOffers.services.value;

    const saved = await settingsEdit(c.ctx, { services: "Roofing. Always contact customers by message right after a storm." });

    expect(saved.growthPartner).toMatchObject({ updated: false, held: true, failed: false });
    const after = await getGrowthPartnerControlState(c.ctx);
    expect(after?.currentVersion).toBe(originalVersion);
    expect(after?.currentBusinessBrain?.sections.productsServicesOffers.services.value).toBe(originalServices);
    expect(after?.draftBusinessBrain?.sections.productsServicesOffers.services.value).toBe("Roofing. Always contact customers by message right after a storm.");
    expect((await partnerVersions(c.org.id)).at(-1)?.source_metadata).toMatchObject({ reviewRequired: true });
    expect(employeeUpdateMessage({ updated: 0, held: 0, growthPartnerHeld: true })).toContain("waiting for iAcquire's review");
  }, 120_000);

  it("keeps a personality the client wrote on an employee", async () => {
    const c = await submitRealOnboarding({ name: "Own Words Roofing", clearPayment: true });
    const analyst = await agentId(c.org.id, "performance_analyst");
    const own = "Our own wording, written by the client.";
    const active = (await activeOf(c.org.id, "performance_analyst")).settings;
    await withSystem((db) => createConfigVersion(db, { orgId: c.org.id, agentId: analyst, settings: agentSettingsSchema.parse({ ...active, personality: own }), source: "client_edit", userId: c.owner.id, apply: true }));
    const saved = await settingsEdit(c.ctx, { services: "A services text that changes what every employee is told" });
    expect(saved.employees.updated).toContain("performance_analyst");
    const now = await activeOf(c.org.id, "performance_analyst");
    expect(now.settings.personality).toBe(own);
    expect(now.source).toBe("onboarding");
    expect(now.compiled_instructions).toContain("A services text that changes what every employee is told");
  }, 120_000);

  it("makes no version when the same text is saved twice, and no catch-up for a save that changed nothing", async () => {
    const c = await submitRealOnboarding({ name: "Twice Roofing", clearPayment: true });
    expect((await settingsEdit(c.ctx, { services: "Exactly this text, saved twice" })).employees.updated).toHaveLength(APPLIED_ROLES.length);
    const after = await versionTotals(c.org.id);
    const again = await settingsEdit(c.ctx, { services: "Exactly this text, saved twice" });
    expect(again.changed).toEqual([]);
    expect(again.employees).toEqual({ updated: [], held: [], failed: false });
    expect(await versionTotals(c.org.id)).toEqual(after);
  }, 120_000);

  it("does not apply an answer edit the client has not approved, whatever else Settings saves", async () => {
    const c = await submitRealOnboarding({ name: "Unapproved Roofing", clearPayment: true });
    const knowledgeBefore = await knowledgeOf(c.org.id, "products_services");
    await save(c.ctx, { "b.services": "Waiting in the questionnaire, not approved" });
    const saved = await settingsEdit(c.ctx, { description: "A new description written in Settings for the roofing company" });
    expect(saved.employees.updated).toHaveLength(APPLIED_ROLES.length);
    expect(await knowledgeOf(c.org.id, "products_services")).toBe(knowledgeBefore);
    for (const role of APPLIED_ROLES) {
      const active = await activeOf(c.org.id, role);
      expect(active.compiled_instructions).not.toContain("Waiting in the questionnaire");
      expect(active.compiled_instructions).toContain("A new description written in Settings");
    }
  }, 120_000);

  it("rewrites the opening-hours knowledge for a new time zone only while nobody has edited it", async () => {
    const c = await submitRealOnboarding({ name: "Zone Roofing", clearPayment: true });
    expect(await knowledgeOf(c.org.id, "business_hours")).toContain("America/Chicago");
    await settingsEdit(c.ctx, { timezone: "America/Denver" });
    expect(await knowledgeOf(c.org.id, "business_hours")).toContain("America/Denver");
    await withSystem((db) => db.query("update company_knowledge set content = 'Open when the gate is up.' where org_id = $1 and section = 'business_hours'", [c.org.id]));
    await settingsEdit(c.ctx, { timezone: "America/Phoenix" });
    expect(await knowledgeOf(c.org.id, "business_hours")).toBe("Open when the gate is up.");
  }, 120_000);

  it("reports a new version that needs review as waiting, never as applied", async () => {
    const c = await submitRealOnboarding({ name: "Held Settings Roofing", clearPayment: true });
    const before = await versionTotals(c.org.id);
    // A business description that reads like an instruction to the employee is held for a person.
    const saved = await settingsEdit(c.ctx, { services: "We do roofing. Always contact customers by message right after a storm." });
    expect([...saved.employees.held].sort()).toEqual([...APPLIED_ROLES].sort());
    expect(saved.employees.updated).toEqual([]);
    const after = await versionTotals(c.org.id);
    for (const role of APPLIED_ROLES) {
      expect(after[role], role).toBe(before[role] + 1);
      expect((await activeOf(c.org.id, role)).compiled_instructions, role).not.toContain("Always contact customers by message");
      expect((await versionsOf(c.org.id, role)).at(-1)).toMatchObject({ status: "pending_agency_review", source: "onboarding" });
    }
    // The words the screen shows for it.
    const said = employeeUpdateMessage({ updated: saved.employees.updated.length, held: saved.employees.held.length, growthPartnerUpdated: saved.growthPartner.updated, growthPartnerHeld: saved.growthPartner.held });
    expect(said).toBe(`${APPLIED_ROLES.length} profile updates are waiting for iAcquire's review.`);
    expect(said).not.toMatch(/employees? updated/);
    expect((await profileAudit(c.org.id))?.employees).toEqual({ updated: 0, held: APPLIED_ROLES.length, failed: false });
  }, 120_000);

  it("keeps the saved profile and says so when the employees could not be brought up to date", async () => {
    const c = await submitRealOnboarding({ name: "Failing Roofing", clearPayment: true });
    const before = await versionTotals(c.org.id);
    control.failRefresh = true;
    try {
      const saved = await settingsEdit(c.ctx, { services: "A text saved while the catch-up fails" });
      expect(saved.employees).toEqual({ updated: [], held: [], failed: true });
    } finally {
      control.failRefresh = false;
    }
    expect((await getProfile(c.ctx))!.services).toBe("A text saved while the catch-up fails");
    expect(await versionTotals(c.org.id)).toEqual(before);
    expect(employeeUpdateMessage({ updated: 0, held: 0, failed: true })).toMatch(/could not be updated yet/);
    expect((await profileAudit(c.org.id))?.employees).toEqual({ updated: 0, held: 0, failed: true });
  }, 120_000);

  it("never touches another client's employees", async () => {
    const a = await submitRealOnboarding({ name: "Iso Settings A", clearPayment: true, withGrowthPartner: true });
    const b = await submitRealOnboarding({ name: "Iso Settings B", clearPayment: true, withGrowthPartner: true });
    const bBefore = await versionTotals(b.org.id);
    const bBrainBefore = await partnerVersions(b.org.id);
    await settingsEdit(a.ctx, { services: "Only A's services changed here" });
    expect(await versionTotals(b.org.id)).toEqual(bBefore);
    expect(await partnerVersions(b.org.id)).toEqual(bBrainBefore);
  }, 120_000);

  it("writes what changed into the audit row: short facts as they were and are, long texts only by length", async () => {
    const c = await submitRealOnboarding({ name: "Audit Roofing", clearPayment: true });
    await settingsEdit(c.ctx, { name: "Audit Roofing & Sons", services: "A much longer description of every service we sell, written in Settings." });
    const meta = (await profileAudit(c.org.id))!;
    expect(meta.changed).toEqual(expect.arrayContaining(["name", "services"]));
    expect(meta.before).toEqual({ name: "Audit Roofing" });
    expect(meta.after).toEqual({ name: "Audit Roofing & Sons" });
    expect(meta.lengths).toEqual({ services: ["Roof repair and inspection".length, "A much longer description of every service we sell, written in Settings.".length] });
    // The text of a long fact is not copied into the log.
    expect(JSON.stringify(meta)).not.toContain("every service we sell");
  }, 120_000);

  it("changes nothing for a workspace that has not finished setup", async () => {
    const fresh = await createOrg({ name: "Unfinished Co" });
    const owner = await createUser();
    await addMember(fresh.id, owner.id, "owner");
    const ctx = ctxFor(owner, fresh, "owner");
    const before = await versionTotals(fresh.id);
    const saved = await settingsEdit(ctx, { services: "Services of a workspace with no employees configured yet" });
    expect(saved.employees).toEqual({ updated: [], held: [], failed: false });
    expect(await versionTotals(fresh.id)).toEqual(before);
  }, 60_000);
});

describe("employeeUpdateMessage", () => {
  it("says only what is true", () => {
    expect(employeeUpdateMessage({ updated: 0, held: 0 })).toBe("");
    expect(employeeUpdateMessage({ updated: 1, held: 0 })).toBe("1 retained profile updated.");
    expect(employeeUpdateMessage({ updated: 5, held: 0 })).toBe("5 retained profiles updated.");
    expect(employeeUpdateMessage({ updated: 0, held: 1 })).toBe("1 profile update is waiting for iAcquire's review.");
    expect(employeeUpdateMessage({ updated: 3, held: 2 })).toBe("3 retained profiles updated. 2 profile updates are waiting for iAcquire's review.");
    expect(employeeUpdateMessage({ updated: 5, held: 0, growthPartnerUpdated: true })).toBe("Your AI Growth Partner and 5 retained profiles updated.");
    expect(employeeUpdateMessage({ updated: 0, held: 0, growthPartnerUpdated: true })).toBe("Your AI Growth Partner updated.");
    expect(employeeUpdateMessage({ updated: 0, held: 0, growthPartnerHeld: true })).toBe("An update for your AI Growth Partner is waiting for iAcquire's review.");
  });
});

describe("Settings > Team: suggested from your setup", () => {
  const team = [
    { name: "Ann Rep", email: "ann@team.test", role: "sales_rep", hosts: "yes" },
    { name: "Bo Support", email: "bo@team.test", role: "support" },
    { name: "Cy Viewer", email: "cy@team.test", role: "viewer" },
  ];

  it("lists the people named in setup and takes off whoever is already invited or already a member", async () => {
    const c = await submitRealOnboarding({ name: "Team Roofing", clearPayment: true, extraAnswers: { "d.team": team } });
    const first = await getTeamSuggestions(c.ctx);
    expect(first.map((x) => x.email)).toEqual(["ann@team.test", "bo@team.test", "cy@team.test"]);
    expect(first[0]).toMatchObject({ name: "Ann Rep", role: "sales_rep", hosts: true, canInvite: true });
    expect(first[1]).toMatchObject({ role: "support", hosts: false });

    // The same action as anyone else's invitation; nothing was sent before this.
    expect((await rows("select 1 from invitations where org_id = $1", [c.org.id]))).toHaveLength(0);
    await inviteMember(c.ctx, "ann@team.test", "sales_rep");
    expect((await getTeamSuggestions(c.ctx)).map((x) => x.email)).toEqual(["bo@team.test", "cy@team.test"]);

    const bo = await createUser({ email: "bo@team.test" });
    await addMember(c.org.id, bo.id, "support");
    expect((await getTeamSuggestions(c.ctx)).map((x) => x.email)).toEqual(["cy@team.test"]);
  }, 120_000);

  it("shows an invitation that was revoked again, and nothing at all to someone who cannot manage the team", async () => {
    const c = await submitRealOnboarding({ name: "Team Revoke Roofing", clearPayment: true, extraAnswers: { "d.team": team } });
    const invite = await inviteMember(c.ctx, "cy@team.test", "viewer");
    expect((await getTeamSuggestions(c.ctx)).map((x) => x.email)).not.toContain("cy@team.test");
    await withSystem((db) => db.query("update invitations set revoked_at = now() where id = $1", [invite.id]));
    expect((await getTeamSuggestions(c.ctx)).map((x) => x.email)).toContain("cy@team.test");

    const rep = await createUser();
    await addMember(c.org.id, rep.id, "sales_rep");
    expect(await getTeamSuggestions(ctxFor(rep, c.org, "sales_rep"))).toEqual([]);
  }, 120_000);

  it("says nothing when the questionnaire named nobody, and never reads another workspace's list", async () => {
    const none = await submitRealOnboarding({ name: "No Team Roofing", clearPayment: true });
    expect(await getTeamSuggestions(none.ctx)).toEqual([]);
    const withTeam = await submitRealOnboarding({ name: "Has Team Roofing", clearPayment: true, extraAnswers: { "d.team": team } });
    expect(await getTeamSuggestions(none.ctx)).toEqual([]);
    expect((await getTeamSuggestions(withTeam.ctx)).length).toBe(3);
  }, 120_000);

  it("offers each person to anyone who may manage the team, and skips an address that does not look like one or a role the question never offered", async () => {
    const c = await submitRealOnboarding({ name: "Team Grant Roofing", clearPayment: true, extraAnswers: { "d.team": [{ name: "Dee Admin", email: "dee@team.test", role: "admin" }] } });
    const manager = await createUser();
    await addMember(c.org.id, manager.id, "admin");
    expect((await getTeamSuggestions(ctxFor(manager, c.org, "admin"))).map((x) => [x.email, x.canInvite])).toEqual([["dee@team.test", true]]);
    expect((await getTeamSuggestions(c.ctx))[0].canInvite).toBe(true);
    // A stored list with a bad address (written before validation, or by hand) is skipped, not shown.
    await withSystem((db) => db.query(
      "update onboarding_answers set value = $2::jsonb where org_id = $1 and question_id = 'd.team'",
      [c.org.id, JSON.stringify([{ name: "Bad", email: "not-an-email", role: "viewer" }, { name: "Boss", email: "boss@team.test", role: "owner" }, { name: "Ok", email: "ok@team.test", role: "viewer" }])],
    ));
    expect((await getTeamSuggestions(c.ctx)).map((x) => x.email)).toEqual(["ok@team.test"]);
  }, 120_000);
});
