import { beforeAll, describe, expect, it } from "vitest";
import { AI_GROWTH_PARTNER_CAPABILITIES, AI_GROWTH_PARTNER_NAME, BUSINESS_BRAIN_SECTIONS, emptyBusinessBrain, generateBusinessBrainFromOnboarding, parseBusinessBrain, preserveClientOverrides } from "@/lib/ai-growth-partner";
import type { StoredAnswers } from "@/lib/onboarding/types";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { activateGrowthPartnerBusinessBrainVersion, draftGrowthPartnerBusinessBrainFromOnboarding, ensureGrowthPartnerIdentity, getGrowthPartnerControlState, saveGrowthPartnerBusinessBrainDraft, saveGrowthPartnerBusinessBrainFactDraft } from "@/server/ai-growth-partner/service";
import { decideHeldKnowledge, saveKnowledgeSection } from "@/server/knowledge/service";
import { buildRunInstructions, createConfigVersion } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { addMember, createOrg, createUser, ctxFor } from "./support/fixtures";

let org: Awaited<ReturnType<typeof createOrg>>;
let otherOrg: Awaited<ReturnType<typeof createOrg>>;
let owner: { id: string; email: string };
let runtimeId: string;
let otherRuntimeId: string;

beforeAll(async () => {
  org = await createOrg({ name: "Growth Partner Client" });
  otherOrg = await createOrg({ name: "Other Growth Partner Client" });
  owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  const runtimes = await withSystem(async (db) => {
    await db.query(
      `insert into agent_roles (key, name, short_name, tagline, description, capabilities, default_tools, accent, sort_order)
       values ('growth_partner', 'AI Growth Partner', 'Growth Partner', 'One partner', 'Unified test identity', '[]'::jsonb, '[]'::jsonb, '#6d63d8', 7)
       on conflict (key) do nothing`,
    );
    const first = (await db.query<{ id: string }>(
      "insert into agent_instances (org_id, role_key, display_name) values ($1, 'growth_partner', 'AI Growth Partner') returning id",
      [org.id],
    )).rows[0];
    const second = (await db.query<{ id: string }>(
      "insert into agent_instances (org_id, role_key, display_name) values ($1, 'growth_partner', 'AI Growth Partner') returning id",
      [otherOrg.id],
    )).rows[0];
    return { first: first.id, second: second.id };
  });
  runtimeId = runtimes.first;
  otherRuntimeId = runtimes.second;
});

describe("AI Growth Partner foundation", () => {
  it("defines one public identity with six internal capability domains and a structured brain", () => {
    const brain = parseBusinessBrain(emptyBusinessBrain());
    expect(AI_GROWTH_PARTNER_NAME).toBe("AI Growth Partner");
    expect(AI_GROWTH_PARTNER_CAPABILITIES).toHaveLength(6);
    expect(BUSINESS_BRAIN_SECTIONS).toHaveLength(11);
    expect(Object.keys(brain.sections)).toEqual(BUSINESS_BRAIN_SECTIONS);
  });

  it("keeps unknown facts explicitly empty and rejects unsupported or unverified claims", () => {
    const brain = emptyBusinessBrain();
    brain.sections.businessIdentity.companyName = {
      value: null,
      state: "unknown",
      provenance: [],
      updatedAt: null,
      clientOverride: false,
    };
    expect(parseBusinessBrain(brain).sections.businessIdentity.companyName.state).toBe("unknown");
    expect(brain.sections.businessIdentity.contactEmail).toMatchObject({ value: null, state: "unknown" });
    expect(brain.sections.businessIdentity.contactPhone).toMatchObject({ value: null, state: "unknown" });

    brain.sections.businessIdentity.companyName.value = "Invented Roofing Co.";
    expect(() => parseBusinessBrain(brain)).toThrow(/Unknown Business Brain facts must have a null value/);

    brain.sections.businessIdentity.companyName = {
      value: "$500",
      state: "draft_suggestion",
      provenance: [{ source: "draft_suggestion", sourceId: null, evidenceUrl: null, observedAt: null }],
      updatedAt: null,
      clientOverride: true,
    };
    expect(() => parseBusinessBrain(brain)).toThrow(/manual client override must remain client-confirmed/);
  });

  it("does not overwrite manually confirmed facts during regeneration", () => {
    const existing = emptyBusinessBrain();
    existing.sections.policies.freeConsultation = {
      value: false,
      state: "client_confirmed",
      provenance: [{ source: "client_edit", sourceId: "settings:free-consultation", evidenceUrl: null, observedAt: "2026-11-04T00:00:00Z" }],
      updatedAt: "2026-11-04T00:00:00Z",
      clientOverride: true,
    };
    const generated = emptyBusinessBrain();
    generated.generatedAt = "2026-11-04T00:00:00Z";
    generated.sections.policies.freeConsultation = {
      value: true,
      state: "verified",
      provenance: [{ source: "website", sourceId: "page:consultations", evidenceUrl: "https://example.com/consultations", observedAt: "2026-11-04T00:00:00Z" }],
      updatedAt: "2026-11-04T00:00:00Z",
      clientOverride: false,
    };

    expect(preserveClientOverrides(existing, generated).sections.policies.freeConsultation).toEqual(existing.sections.policies.freeConsultation);
  });

  it("builds a structured brain from saved onboarding while preserving confirmation state and unknowns", () => {
    const at = "2026-11-04T00:00:00.000Z";
    const brain = generateBusinessBrainFromOnboarding({
      "a.business_name": { value: "Northstar Roofing", skipped: false, source: "user", needsConfirmation: false, updatedAt: at },
      "a.website": { value: "https://northstar.example", skipped: false, source: "website_analysis", needsConfirmation: false, updatedAt: at },
      "a.contact_email": { value: "hello@northstar.example", skipped: false, source: "user", needsConfirmation: false, updatedAt: at },
      "a.contact_phone": { value: "+1 407 555 0123", skipped: false, source: "user", needsConfirmation: false, updatedAt: at },
      "e.policies": { value: "Draft: 30-day refund policy", skipped: false, source: "ai_suggestion", needsConfirmation: true, updatedAt: at },
      "b.services": { value: "Roof repair", skipped: true, source: "user", needsConfirmation: false, updatedAt: at },
      "unknown.question": { value: "ignore", skipped: false, source: "user", needsConfirmation: false, updatedAt: at },
    }, new Date(at));

    expect(brain.generatedAt).toBe(at);
    expect(brain.sections.businessIdentity.companyName).toMatchObject({ value: "Northstar Roofing", state: "client_confirmed", provenance: [{ source: "onboarding", sourceId: "a.business_name" }] });
    expect(brain.sections.businessIdentity.website).toMatchObject({ value: "https://northstar.example", state: "client_confirmed", provenance: [{ source: "website", sourceId: "a.website" }] });
    expect(brain.sections.businessIdentity.contactEmail).toMatchObject({ value: "hello@northstar.example", state: "client_confirmed", provenance: [{ source: "onboarding", sourceId: "a.contact_email" }] });
    expect(brain.sections.businessIdentity.contactPhone).toMatchObject({ value: "+1 407 555 0123", state: "client_confirmed", provenance: [{ source: "onboarding", sourceId: "a.contact_phone" }] });
    expect(brain.sections.policies.customerPolicies).toMatchObject({ state: "draft_suggestion" });
    expect(brain.sections.productsServicesOffers.services).toMatchObject({ value: null, state: "unknown" });
    expect(brain.sections.businessIdentity.companyName).toMatchObject({ value: "Northstar Roofing", state: "client_confirmed" });
    expect(brain.sections.productsServicesOffers.pricing).toMatchObject({ value: null, state: "unknown" });
  });

  it("maps submitted onboarding into named Brain facts and excludes upload references", () => {
    const at = "2026-11-05T12:00:00.000Z";
    const userAnswer = (value: StoredAnswers[string]["value"]) => ({
      value,
      skipped: false,
      source: "user" as const,
      needsConfirmation: false,
      updatedAt: at,
    });
    const brain = generateBusinessBrainFromOnboarding({
      "a.timezone": userAnswer("America/New_York"),
      "a.hours": userAnswer({ monday: [{ start: "09:00", end: "17:00" }] }),
      "b.goals": userAnswer(["qualified_leads"]),
      "c.never_promise": userAnswer("Never guarantee insurance reimbursement."),
      "d.appt_availability": userAnswer({ monday: [{ start: "10:00", end: "16:00" }] }),
      "d.pricing_info": userAnswer("Inspections start at $150."),
      "d.handoff_requirements": userAnswer("Route urgent roof damage to the owner."),
      "e.brand_colors": userAnswer({ primary: "#1d4ed8", accent: "#f97316" }),
      "e.documents": userAnswer(["upload-123"]),
      "e.logo": userAnswer(["asset-456"]),
    }, new Date(at));

    expect(brain.sections.businessOperations.timeZone).toMatchObject({ value: "America/New_York", state: "client_confirmed", provenance: [{ sourceId: "a.timezone" }] });
    expect(brain.sections.businessOperations.operatingHours.value).toEqual({ monday: [{ start: "09:00", end: "17:00" }] });
    expect(brain.sections.businessOperations.appointmentAvailability.value).toEqual({ monday: [{ start: "10:00", end: "16:00" }] });
    expect(brain.sections.businessOperations.internalHandoffs.value).toBe("Route urgent roof damage to the owner.");
    expect(brain.sections.businessIdentity.brandColor).toMatchObject({
      value: "#1d4ed8",
      state: "client_confirmed",
      provenance: [{ source: "onboarding", sourceId: "e.brand_colors" }],
    });
    expect(brain.sections.businessIdentity.brandAccentColor).toMatchObject({
      value: "#f97316",
      state: "client_confirmed",
      provenance: [{ source: "onboarding", sourceId: "e.brand_colors" }],
    });
    expect(brain.sections.employeeGoals.priorities.value).toEqual(["qualified_leads"]);
    expect(brain.sections.policies.prohibitedPromises.value).toBe("Never guarantee insurance reimbursement.");
    expect(brain.sections.productsServicesOffers.pricing.value).toBe("Inspections start at $150.");
    expect(Object.values(brain.sections).flatMap((section) => Object.keys(section))).not.toContain("e.documents");
    expect(Object.values(brain.sections).flatMap((section) => Object.keys(section))).not.toContain("e.logo");
    expect(brain.sections.businessIdentity.website.state).toBe("unknown");
  });

  it("keeps a blank submitted accent color explicitly unknown without losing its source", () => {
    const brain = generateBusinessBrainFromOnboarding({
      "e.brand_colors": {
        value: { primary: "#2c5bff", accent: "" },
        skipped: false,
        source: "user",
        needsConfirmation: false,
        updatedAt: "2026-11-05T12:00:00.000Z",
      },
    }, new Date("2026-11-05T12:00:00.000Z"));

    expect(brain.sections.businessIdentity.brandColor).toMatchObject({ value: "#2c5bff", state: "client_confirmed" });
    expect(brain.sections.businessIdentity.brandAccentColor).toMatchObject({
      value: null,
      state: "unknown",
      provenance: [{ source: "onboarding", sourceId: "e.brand_colors" }],
    });
  });

  it("enforces a single logical partner per tenant and preserves independent role records", async () => {
    const partner = await withSystem(async (db) => {
      const inserted = (await db.query<{ id: string }>(
        "insert into ai_growth_partners (org_id, runtime_agent_instance_id) values ($1, $2) returning id",
        [org.id, runtimeId],
      )).rows[0];
      expect(inserted.id).toBeTruthy();
      return inserted;
    });

    await expect(withSystem((db) => db.query(
        "insert into ai_growth_partners (org_id) values ($1)",
        [org.id],
      ))).rejects.toThrow();

    const secondTenant = await withSystem(async (db) => (await db.query<{ id: string }>(
        "insert into ai_growth_partners (org_id) values ($1) returning id",
        [otherOrg.id],
      )).rows[0]);
    expect(secondTenant.id).toBeTruthy();

    await withSystem(async (db) => {
      const versionsBefore = (await db.query<{ count: string }>(
        "select count(*)::text as count from agent_instances where org_id = $1",
        [org.id],
      )).rows[0].count;
      expect(Number(versionsBefore)).toBeGreaterThan(1);
      expect((await db.query<{ count: string }>(
        "select count(*)::text as count from ai_growth_partner_versions where partner_id = $1",
        [partner.id],
      )).rows[0].count).toBe("0");
    });
  });

  it("binds runtime and configuration versions to the same tenant and keeps snapshots immutable", async () => {
    const versionOrg = await createOrg({ name: "Versioned Growth Partner Client" });
    const partner = await withSystem(async (db) => {
      const partner = (await db.query<{ id: string }>(
        "insert into ai_growth_partners (org_id) values ($1) returning id",
        [versionOrg.id],
      )).rows[0];
      return partner;
    });

    await expect(withSystem((db) => db.query(
        "update ai_growth_partners set runtime_agent_instance_id = $2 where id = $1",
        [partner.id, otherRuntimeId],
      ))).rejects.toThrow();

    const brain = emptyBusinessBrain();
    const v1 = await withSystem(async (db) => (await db.query<{ version: number }>(
        `insert into ai_growth_partner_versions (partner_id, org_id, version, business_brain, source, created_by)
         values ($1, $2, 1, $3::jsonb, 'onboarding', $4) returning version`,
        [partner.id, versionOrg.id, JSON.stringify(brain), owner.id],
      )).rows[0]);
    expect(v1.version).toBe(1);

    await withSystem((db) => db.query("update ai_growth_partners set current_version = 1 where id = $1", [partner.id]));
    await expect(withSystem((db) => db.query(
        "update ai_growth_partner_versions set source = 'client_edit' where partner_id = $1 and version = 1",
        [partner.id],
      ))).rejects.toThrow(/ai_growth_partner_versions_are_immutable/);

    await expect(withSystem((db) => db.query(
        `insert into ai_growth_partner_versions (partner_id, org_id, version, business_brain, source)
         values ($1, $2, 1, '{}'::jsonb, 'client_edit')`,
        [partner.id, versionOrg.id],
      ))).rejects.toThrow();
  });

  it("enforces tenant permissions through the application database role", async () => {
    const rlsOrg = await createOrg({ name: "Growth Partner RLS Client" });
    const rlsOwner = await createUser();
    const otherUser = await createUser();
    await addMember(rlsOrg.id, rlsOwner.id, "owner");
    await addMember(otherOrg.id, otherUser.id, "owner");

    const partner = await withSystem(async (db) => (await db.query<{ id: string }>(
      "insert into ai_growth_partners (org_id) values ($1) returning id",
      [rlsOrg.id],
    )).rows[0]);
    const brain = emptyBusinessBrain();
    const insertVersion = (db: Queryable) => db.query(
      `insert into ai_growth_partner_versions (partner_id, org_id, version, business_brain, source, created_by)
       values ($1, $2, 1, $3::jsonb, 'client_edit', $4)`,
      [partner.id, rlsOrg.id, JSON.stringify(brain), rlsOwner.id],
    );
    await expect(withUser(rlsOwner.id, insertVersion)).rejects.toThrow(/permission denied/);
    await withSystem(insertVersion);

    const ownPartnerRows = await withUser(rlsOwner.id, (db) => db.query<{ n: number }>(
      "select count(*)::int as n from ai_growth_partners where org_id = $1",
      [rlsOrg.id],
    ));
    const crossTenantPartnerRows = await withUser(otherUser.id, (db) => db.query<{ n: number }>(
      "select count(*)::int as n from ai_growth_partners where org_id = $1",
      [rlsOrg.id],
    ));

    const ownRows = await withUser(rlsOwner.id, (db) => db.query<{ n: number }>(
      "select count(*)::int as n from ai_growth_partner_versions where org_id = $1",
      [rlsOrg.id],
    ));
    const crossTenantRows = await withUser(otherUser.id, (db) => db.query<{ n: number }>(
      "select count(*)::int as n from ai_growth_partner_versions where org_id = $1",
      [rlsOrg.id],
    ));
    expect(ownPartnerRows.rows[0].n).toBe(1);
    expect(crossTenantPartnerRows.rows[0].n).toBe(0);
    expect(ownRows.rows[0].n).toBe(1);
    expect(crossTenantRows.rows[0].n).toBe(0);
  });

  it("creates a draft identity and saves versioned Business Brain data without activating a runtime", async () => {
    const serviceOrg = await createOrg({ name: "Growth Partner Service Client" });
    const serviceOwner = await createUser();
    const member = await createUser();
    await addMember(serviceOrg.id, serviceOwner.id, "owner");
    await addMember(serviceOrg.id, member.id, "member");
    const ownerContext = ctxFor(serviceOwner, serviceOrg, "owner");

    const created = await ensureGrowthPartnerIdentity(ownerContext);
    expect(created.created).toBe(true);
    expect(await ensureGrowthPartnerIdentity(ownerContext)).toEqual({ ...created, created: false });
    expect(await getGrowthPartnerControlState(ownerContext)).toMatchObject({
      id: created.id,
      name: AI_GROWTH_PARTNER_NAME,
      status: "setup_required",
      runtimeAgentInstanceId: null,
      currentVersion: null,
      currentBusinessBrain: null,
    });

    const brain = emptyBusinessBrain();
    brain.sections.businessIdentity.companyName = {
      value: "Confirmed Service Company",
      state: "client_confirmed",
      provenance: [{ source: "client_confirmed", sourceId: "onboarding:company-name", evidenceUrl: null, observedAt: "2026-11-04T00:00:00Z" }],
      updatedAt: "2026-11-04T00:00:00Z",
      clientOverride: true,
    };
    const saved = await saveGrowthPartnerBusinessBrainDraft(ownerContext, { businessBrain: brain, personaSettings: { tone: "warm", replyLength: "concise" } });
    expect(saved).toMatchObject({ partnerId: created.id, version: 1, status: "draft", activated: false });
    const state = await getGrowthPartnerControlState(ownerContext);
    expect(state).toMatchObject({ currentVersion: null, draftVersion: 1, draftBusinessBrain: brain });

    const edit = await saveGrowthPartnerBusinessBrainFactDraft(ownerContext, {
      baseVersion: 1,
      section: "businessIdentity",
      key: "companyName",
      valueText: "Updated Service Company",
    });
    expect(edit).toMatchObject({ version: 2, status: "draft", activated: false });
    const editedState = await getGrowthPartnerControlState(ownerContext);
    expect(editedState).toMatchObject({ currentVersion: null, draftVersion: 2, versions: [
      { version: 2, source: "client_edit", active: false },
      { version: 1, source: "client_edit", active: false },
    ] });
    expect(editedState?.draftBusinessBrain?.sections.businessIdentity.companyName).toMatchObject({
      value: "Updated Service Company",
      state: "client_confirmed",
      clientOverride: true,
    });
    expect(editedState?.draftBusinessBrain?.sections.businessIdentity.companyName.provenance)
      .toContainEqual(expect.objectContaining({ source: "client_edit" }));
    expect((await withSystem((db) => db.query<{ persona_settings: Record<string, unknown> }>(
      "select persona_settings from ai_growth_partner_versions where org_id = $1 and partner_id = $2 and version = 2",
      [serviceOrg.id, created.id],
    ))).rows[0]?.persona_settings).toEqual({ tone: "warm", replyLength: "concise" });
    await expect(saveGrowthPartnerBusinessBrainFactDraft(ownerContext, {
      baseVersion: 1,
      section: "businessIdentity",
      key: "companyName",
      valueText: "Stale edit",
    })).rejects.toMatchObject({ code: "conflict" });

    const applied = await activateGrowthPartnerBusinessBrainVersion(ownerContext, { expectedCurrentVersion: null, version: 2 });
    expect(applied).toEqual({ version: 2, previousVersion: null, activated: true, alreadyActive: false });
    expect(await getGrowthPartnerControlState(ownerContext)).toMatchObject({
      currentVersion: 2,
      draftVersion: null,
      currentBusinessBrain: { sections: { businessIdentity: { companyName: { value: "Updated Service Company" } } } },
    });
    expect(await activateGrowthPartnerBusinessBrainVersion(ownerContext, { expectedCurrentVersion: null, version: 2 }))
      .toEqual({ version: 2, previousVersion: 2, activated: false, alreadyActive: true });
    await expect(activateGrowthPartnerBusinessBrainVersion(ownerContext, { expectedCurrentVersion: 2, version: 1 }))
      .rejects.toMatchObject({ code: "conflict" });
    const appliedAudit = (await withSystem((db) => db.query<{ action: string; metadata: Record<string, unknown> }>(
      "select action, metadata from audit_logs where org_id = $1 and action = 'ai_growth_partner.business_brain_activated'",
      [serviceOrg.id],
    ))).rows[0];
    expect(appliedAudit).toMatchObject({ action: "ai_growth_partner.business_brain_activated", metadata: { version: 2, previousVersion: null, activeVersionChanged: true } });

    await expect(saveGrowthPartnerBusinessBrainDraft(ctxFor(member, serviceOrg, "member"), { businessBrain: brain })).rejects.toMatchObject({ code: "forbidden" });
    await expect(ensureGrowthPartnerIdentity(ctxFor(member, serviceOrg, "member"))).rejects.toMatchObject({ code: "forbidden" });
    await expect(saveGrowthPartnerBusinessBrainFactDraft(ctxFor(member, serviceOrg, "member"), {
      baseVersion: 2,
      section: "businessIdentity",
      key: "companyName",
      valueText: "Unauthorized edit",
    })).rejects.toMatchObject({ code: "forbidden" });
    await expect(activateGrowthPartnerBusinessBrainVersion(ctxFor(member, serviceOrg, "member"), { expectedCurrentVersion: 2, version: 2 }))
      .rejects.toMatchObject({ code: "forbidden" });
  });

  it("reuses an onboarding snapshot when the preparation action is retried", async () => {
    const retryOrg = await createOrg({ name: "Idempotent Growth Partner Client" });
    const retryOwner = await createUser();
    await addMember(retryOrg.id, retryOwner.id, "owner");
    const retryContext = ctxFor(retryOwner, retryOrg, "owner");
    await withSystem((db) => db.query("insert into ai_growth_partners (org_id) values ($1)", [retryOrg.id]));
    const submittedAt = new Date("2026-09-05T12:00:00.000Z");
    const answers: StoredAnswers = {
      "a.business_name": { value: "Bright Path Roofing", skipped: false, source: "user", needsConfirmation: false, updatedAt: submittedAt.toISOString() },
      "a.website": { value: "https://brightpath.example", skipped: false, source: "website_analysis", needsConfirmation: true, updatedAt: submittedAt.toISOString() },
      "e.brand_colors": { value: { primary: "#1d4ed8", accent: "#f97316" }, skipped: false, source: "user", needsConfirmation: false, updatedAt: submittedAt.toISOString() },
    };

    const first = await withSystem((db) => draftGrowthPartnerBusinessBrainFromOnboarding(db, retryContext, answers, submittedAt, 2, submittedAt));
    const retry = await withSystem((db) => draftGrowthPartnerBusinessBrainFromOnboarding(db, retryContext, answers, new Date("2026-09-06T12:00:00.000Z"), 2, submittedAt));
    expect(first).toMatchObject({ version: 1, activeVersionChanged: true, reused: false });
    expect(retry).toMatchObject({ id: first?.id, version: 1, activeVersionChanged: false, reused: true });

    const state = await getGrowthPartnerControlState(retryContext);
    expect(state).toMatchObject({
      status: "setup_required",
      runtimeAgentInstanceId: null,
      currentVersion: 1,
      draftVersion: null,
      currentBusinessBrain: {
        sections: {
          businessIdentity: {
            brandColor: { value: "#1d4ed8", state: "client_confirmed", provenance: [{ source: "onboarding", sourceId: "e.brand_colors" }] },
            brandAccentColor: { value: "#f97316", state: "client_confirmed", provenance: [{ source: "onboarding", sourceId: "e.brand_colors" }] },
          },
        },
      },
    });
  });

  it("keeps an existing-tenant migration onboarding snapshot as a draft until explicit owner activation", async () => {
    const migrationOrg = await createOrg({ name: "Migration draft review client" });
    const migrationOwner = await createUser();
    await addMember(migrationOrg.id, migrationOwner.id, "owner");
    const migrationContext = ctxFor(migrationOwner, migrationOrg, "owner");
    await withSystem((db) => db.query(
      "insert into ai_growth_partners (org_id, status) values ($1, 'migration_required')",
      [migrationOrg.id],
    ));
    const submittedAt = new Date("2026-10-15T09:30:00.000Z");
    const answers: StoredAnswers = {
      "a.business_name": { value: "Owner Confirmed Roofing", skipped: false, source: "user", needsConfirmation: false, updatedAt: submittedAt.toISOString() },
      "a.website": { value: "https://roofing.example", skipped: false, source: "website_analysis", needsConfirmation: true, updatedAt: submittedAt.toISOString() },
    };

    const first = await withSystem((db) => draftGrowthPartnerBusinessBrainFromOnboarding(db, migrationContext, answers, submittedAt, 2, submittedAt));
    const retry = await withSystem((db) => draftGrowthPartnerBusinessBrainFromOnboarding(db, migrationContext, answers, new Date("2026-10-16T09:30:00.000Z"), 2, submittedAt));
    expect(first).toMatchObject({ version: 1, activeVersionChanged: false, reused: false });
    expect(retry).toMatchObject({ id: first?.id, version: 1, activeVersionChanged: false, reused: true });

    const state = await getGrowthPartnerControlState(migrationContext);
    expect(state).toMatchObject({
      status: "migration_required",
      runtimeAgentInstanceId: null,
      currentVersion: null,
      draftVersion: 1,
      draftBusinessBrain: {
        sections: {
          businessIdentity: {
            companyName: { value: "Owner Confirmed Roofing", state: "client_confirmed" },
            website: { value: "https://roofing.example", state: "draft_suggestion" },
          },
        },
      },
    });

    const audit = (await withSystem((db) => db.query<{ metadata: Record<string, unknown> }>(
      "select metadata from audit_logs where org_id = $1 and action = 'ai_growth_partner.business_brain_drafted'",
      [migrationOrg.id],
    ))).rows[0];
    expect(audit?.metadata).toMatchObject({ source: "onboarding", activeVersionChanged: false, version: 1 });

    const activated = await activateGrowthPartnerBusinessBrainVersion(migrationContext, { expectedCurrentVersion: null, version: 1 });
    expect(activated).toMatchObject({ version: 1, activated: true, alreadyActive: false });
    expect(await getGrowthPartnerControlState(migrationContext)).toMatchObject({ status: "migration_required", currentVersion: 1, draftVersion: null });
  });

  it("assembles approved company knowledge into onboarding drafts and excludes held or risky sections", async () => {
    const knowledgeOrg = await createOrg({ name: "Growth Partner Knowledge Import Client" });
    const knowledgeOwner = await createUser();
    await addMember(knowledgeOrg.id, knowledgeOwner.id, "owner");
    const knowledgeContext = ctxFor(knowledgeOwner, knowledgeOrg, "owner");
    await withSystem((db) => db.query(
      "insert into ai_growth_partners (org_id, status) values ($1, 'migration_required')",
      [knowledgeOrg.id],
    ));
    await withSystem(async (db) => {
      await db.query(
        `insert into company_knowledge (org_id, section, content, version, review_status, risk_flags)
         values ($1, 'business_description', 'Commercial roofing for multi-site property groups.', 3, 'approved', '{}'),
                ($1, 'products_services', 'Roof replacement and storm repair.', 2, 'approved', '{}'),
                ($1, 'faq', 'Do you provide weekend roof inspections?', 4, 'pending_agency_review', '{}'),
                ($1, 'approved_pricing', 'Promise every repair is under $100.', 5, 'approved', '{unreviewed_risk}')`,
        [knowledgeOrg.id],
      );
    });
    const submittedAt = new Date("2026-10-20T09:30:00.000Z");
    const answers: StoredAnswers = {
      "a.business_name": { value: "Confirmed Roofing Group", skipped: false, source: "user", needsConfirmation: false, updatedAt: submittedAt.toISOString() },
      "a.description": { value: "Residential roofing for local homeowners.", skipped: false, source: "user", needsConfirmation: false, updatedAt: submittedAt.toISOString() },
    };

    const prepared = await withSystem((db) => draftGrowthPartnerBusinessBrainFromOnboarding(db, knowledgeContext, answers, submittedAt, 2, submittedAt));
    expect(prepared).toMatchObject({ version: 1, activeVersionChanged: false, companyKnowledgeFactCount: 2, companyKnowledgeConflictCount: 1 });
    const state = await getGrowthPartnerControlState(knowledgeContext);
    expect(state).toMatchObject({
      status: "migration_required",
      currentVersion: null,
      draftVersion: 1,
      draftBusinessBrain: {
        sections: {
          businessIdentity: {
            background: {
              state: "draft_suggestion",
              value: {
                kind: "company_knowledge_conflict",
                section: "business_description",
                disputedValue: "Residential roofing for local homeowners.",
                knowledgeValue: "Commercial roofing for multi-site property groups.",
              },
            },
          },
          productsServicesOffers: {
            services: { value: "Roof replacement and storm repair.", state: "verified" },
            pricing: { value: null, state: "unknown" },
          },
          salesKnowledge: { commonQuestions: { value: null, state: "unknown" } },
        },
      },
    });
    const sourceMetadata = (await withSystem((db) => db.query<{ source_metadata: Record<string, unknown> }>(
      "select source_metadata from ai_growth_partner_versions where org_id = $1 and partner_id = $2 and version = 1",
      [knowledgeOrg.id, state?.id],
    ))).rows[0]?.source_metadata;
    expect(sourceMetadata).toMatchObject({ companyKnowledgeFactCount: 2, companyKnowledgeConflictCount: 1 });
    expect(JSON.stringify(sourceMetadata)).not.toContain("Commercial roofing for multi-site property groups.");
    const audit = (await withSystem((db) => db.query<{ metadata: Record<string, unknown> }>(
      "select metadata from audit_logs where org_id = $1 and action = 'ai_growth_partner.business_brain_drafted' order by created_at desc limit 1",
      [knowledgeOrg.id],
    ))).rows[0]?.metadata;
    expect(audit).toMatchObject({ companyKnowledgeFactCount: 2, companyKnowledgeConflictCount: 1, activeVersionChanged: false });

    const agencyAdmin = await createUser({ platformRole: "agency_super_admin" });
    await withSystem((db) => decideHeldKnowledge(db, {
      orgId: knowledgeOrg.id,
      section: "faq",
      approve: true,
      agencyUserId: agencyAdmin.id,
    }));
    const afterApproval = await getGrowthPartnerControlState(knowledgeContext);
    expect(afterApproval).toMatchObject({
      status: "migration_required",
      currentVersion: null,
      draftVersion: 2,
      draftBusinessBrain: {
        sections: { salesKnowledge: { commonQuestions: { value: "Do you provide weekend roof inspections?", state: "verified" } } },
      },
    });
  });

  it("synchronizes approved knowledge into active and draft versions without exposing conflicts to the Growth Partner prompt", async () => {
    const syncOrg = await createOrg({ name: "Growth Partner Knowledge Sync Client" });
    const syncOwner = await createUser();
    await addMember(syncOrg.id, syncOwner.id, "owner");
    const syncContext = ctxFor(syncOwner, syncOrg, "owner");
    const growthPartnerAgent = (await withSystem((db) => db.query<{ id: string }>(
      "insert into agent_instances (org_id, role_key, display_name) values ($1, 'growth_partner', 'AI Growth Partner') returning id",
      [syncOrg.id],
    ))).rows[0].id;
    await withSystem(async (db) => {
      await db.query("insert into ai_growth_partners (org_id, runtime_agent_instance_id) values ($1, $2)", [syncOrg.id, growthPartnerAgent]);
      await createConfigVersion(db, {
        orgId: syncOrg.id,
        agentId: growthPartnerAgent,
        settings: defaultSettings("growth_partner"),
        source: "onboarding",
        userId: syncOwner.id,
        apply: true,
      });
    });
    const submittedAt = new Date("2026-10-21T12:00:00.000Z");
    const answers: StoredAnswers = {
      "a.business_name": { value: "Orlando Roofing Works", skipped: false, source: "user", needsConfirmation: false, updatedAt: submittedAt.toISOString() },
      "a.description": { value: "Residential roofing founded in 2004.", skipped: false, source: "user", needsConfirmation: false, updatedAt: submittedAt.toISOString() },
    };
    await withSystem((db) => draftGrowthPartnerBusinessBrainFromOnboarding(db, syncContext, answers, submittedAt, 2, submittedAt));
    const manualDraft = await saveGrowthPartnerBusinessBrainFactDraft(syncContext, {
      baseVersion: 1,
      section: "employeeBehavior",
      key: "personality",
      valueText: "Calm, clear, and practical.",
    });
    expect(manualDraft.version).toBe(2);

    await saveKnowledgeSection(syncContext, "business_description", "Commercial properties only; no residential work.");
    await saveKnowledgeSection(syncContext, "products_services", "Roof replacement and storm repair.");

    const state = await getGrowthPartnerControlState(syncContext);
    expect(state).toMatchObject({
      currentVersion: 5,
      draftVersion: 6,
      currentBusinessBrain: {
        sections: {
          businessIdentity: {
            background: {
              state: "draft_suggestion",
              value: {
                kind: "company_knowledge_conflict",
                disputedValue: "Residential roofing founded in 2004.",
                knowledgeValue: "Commercial properties only; no residential work.",
              },
            },
          },
          productsServicesOffers: { services: { value: "Roof replacement and storm repair.", state: "verified" } },
        },
      },
      draftBusinessBrain: {
        sections: {
          employeeBehavior: { personality: { value: "Calm, clear, and practical.", clientOverride: true } },
        },
      },
    });
    const runtime = await withSystem((db) => buildRunInstructions(db, syncOrg.id, growthPartnerAgent));
    expect(runtime.instructions).toContain("productsServicesOffers.services: Roof replacement and storm repair.");
    expect(runtime.instructions).not.toContain("Residential roofing founded in 2004.");
    expect(runtime.instructions).not.toContain("Commercial properties only; no residential work.");
    const versions = (await withSystem((db) => db.query<{ version: number; source: string }>(
      "select version, source from ai_growth_partner_versions where org_id = $1 and partner_id = $2 order by version",
      [syncOrg.id, state?.id],
    ))).rows;
    expect(versions).toEqual([
      { version: 1, source: "onboarding" },
      { version: 2, source: "client_edit" },
      { version: 3, source: "knowledge_sync" },
      { version: 4, source: "knowledge_sync" },
      { version: 5, source: "knowledge_sync" },
      { version: 6, source: "knowledge_sync" },
    ]);
  });
});
