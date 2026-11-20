import { afterEach, describe, expect, it, vi } from "vitest";
import { parseBusinessBrain } from "@/lib/ai-growth-partner";
import { AGENT_ROLE_KEYS } from "@/lib/agents";
import { agentSettingsSchema } from "@/lib/agent-settings";
import { createClientTenant } from "@/server/admin/tenants";
import { resetEnvCache } from "@/server/env";
import { withSystem } from "@/server/db";
import { getOnboardingReview, saveOnboardingStep, submitOnboarding } from "@/server/onboarding/service";
import { createConfigVersion } from "@/server/workforce/service";
import { addMember, agencyUser, createUser, ctxFor, uid } from "./support/fixtures";
import { clearSetupPayment } from "./support/billing";

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

async function prepareOnboarding(name: string, description: string, service: string, customer: string, extraAnswers: Record<string, unknown> = {}) {
  const admin = agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
  const ownerEmail = `owner-${uid()}@example.test`;
  // Capture invitation mail in the test environment. This acceptance makes no outbound requests.
  vi.stubEnv("EMAIL_PROVIDER", "capture");
  resetEnvCache();
  const client = await createClientTenant(admin, {
    name,
    ownerEmail,
    industry: "Home services",
    timezone: "America/Chicago",
    enabledRoles: [...AGENT_ROLE_KEYS],
  });
  const org = { id: client.orgId, name, slug: client.slug };
  await clearSetupPayment(org.id, "Synthetic onboarding acceptance: setup fee cleared");
  const owner = await createUser({ email: ownerEmail });
  await addMember(org.id, owner.id, "owner");
  const ctx = ctxFor(owner, org, "owner");
  const answers = {
    "a.business_name": name,
    "a.industry": "home_services",
    "a.business_model": "local",
    "a.description": description,
    "a.timezone": "America/Chicago",
    "a.hours": { mon: [["09:00", "17:00"]], tue: [["09:00", "17:00"]], wed: [["09:00", "17:00"]], thu: [["09:00", "17:00"]], fri: [["09:00", "17:00"]] },
    "a.contact_email": owner.email,
    "a.territories": "Austin, Texas",
    "a.target_customers": customer,
    "b.goals": ["more_leads", "more_appointments"],
    "b.services": service,
    "b.ideal_customer": customer,
    "b.appointments": true,
    "b.website_need": "have",
    "d.pricing_policy": "never",
    ...extraAnswers,
  };
  const saved = await saveOnboardingStep(ctx, {
    answers: Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, { value }])),
    currentQuestionId: "f.review",
  });
  expect(saved.rejected).toEqual({});
  expect(client.emailDelivery.status).toBe("captured");
  return { org, owner, ctx };
}

async function onboard(...args: Parameters<typeof prepareOnboarding>) {
  const client = await prepareOnboarding(...args);
  const review = await getOnboardingReview(client.ctx);
  const confirmation = review.businessBrain?.confirmation;
  expect(confirmation).toMatch(/^[0-9a-f]{64}$/);
  const mapped = review.businessBrain?.groups.flatMap(({ facts }) => facts);
  expect(mapped).toEqual(expect.arrayContaining([
    expect.objectContaining({ key: "companyName", value: client.org.name, state: "client_confirmed" }),
    expect.objectContaining({ key: "industry", questionId: "a.industry", value: "Home services" }),
  ]));
  expect(mapped?.some((fact) => fact.questionId === "d.pricing_info")).toBe(false);
  await saveOnboardingStep(client.ctx, { answers: { "f.review": { value: true } } });
  const result = await submitOnboarding(client.ctx, { confirmation });
  return { ...client, confirmation, result };
}

describe("isolated new-client onboarding acceptance (test database; no Hermes writes)", () => {
  it("requires explicit approval and refuses a stale Business Brain confirmation before creating work", async () => {
    const { ctx, org } = await prepareOnboarding("Spruce Roof Repair", "We inspect roofs in Austin.", "Roof inspections", "Austin homeowners");
    const reviewed = await getOnboardingReview(ctx);
    await expect(submitOnboarding(ctx, { confirmation: reviewed.businessBrain?.confirmation })).rejects.toMatchObject({
      code: "invalid_input", message: "Confirm that you approve this setup",
    });
    await saveOnboardingStep(ctx, { answers: { "a.description": { value: "We repair storm-damaged roofs in Austin too." } } });
    await saveOnboardingStep(ctx, { answers: { "f.review": { value: true } } });

    await expect(submitOnboarding(ctx)).rejects.toMatchObject({ code: "conflict" });
    await expect(submitOnboarding(ctx, {})).rejects.toMatchObject({ code: "conflict" });
    await expect(submitOnboarding(ctx, { confirmation: reviewed.businessBrain?.confirmation })).rejects.toMatchObject({ code: "conflict" });
    const counts = (await withSystem((db) => db.query(
      `select (select count(*)::int from ai_growth_partner_versions where org_id = $1) as versions,
              (select count(*)::int from agent_provisioning_jobs where org_id = $1) as jobs`,
      [org.id],
    ))).rows[0];
    expect(counts).toEqual({ versions: 0, jobs: 0 });

    const current = await getOnboardingReview(ctx);
    expect(current.businessBrain?.confirmation).not.toBe(reviewed.businessBrain?.confirmation);
    expect(current.businessBrain?.groups.flatMap(({ facts }) => facts)).toContainEqual(expect.objectContaining({
      key: "background", value: "We repair storm-damaged roofs in Austin too.",
    }));
    await expect(submitOnboarding(ctx, { confirmation: current.businessBrain?.confirmation })).resolves.toMatchObject({
      employees: [expect.objectContaining({ role: "growth_partner" })],
    });
  });

  it("creates one Growth Partner, one Business Brain and one provisioning request per client from one onboarding flow", async () => {
    const roofing = await onboard("Brightside Roofing", "We repair residential roofs after storm damage.", "Roof repair and inspection", "Austin homeowners", {
      "c.ai_behavior": "answer_book",
      "c.tone": "professional",
      "c.company_rules": "Use plain language with homeowners.",
      "c.never_promise": "Never guarantee a repair date.",
      "c.human_escalation": ["unsafe_or_uncertain"],
      "d.pricing_info": "Stale prices from a hidden question."
    });
    const plumbing = await onboard("Harbor Plumbing", "We repair plumbing systems for local homes.", "Pipe repair and drain cleaning", "Austin property owners");

    for (const client of [roofing, plumbing]) {
      expect(client.result.employees).toHaveLength(1);
      expect(client.result.employees[0].role).toBe("growth_partner");

      const { rows } = await withSystem((db) => db.query<{
        role_key: string;
        status: string;
        hermes_profile: string | null;
        settings: unknown;
        compiled_instructions: string;
        config_status: string;
      }>(
        `select a.role_key, a.status, a.hermes_profile, v.settings, v.compiled_instructions, v.status as config_status
         from agent_instances a
         join agent_config_versions v on v.id = a.active_config_version_id and v.org_id = a.org_id
         where a.org_id = $1 order by a.role_key`,
        [client.org.id],
      ));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        role_key: "growth_partner",
        status: "setup_required",
        hermes_profile: null,
      });
      expect(["applied", "pending_agency_review"]).toContain(rows[0].config_status);
      const settings = agentSettingsSchema.parse(rows[0].settings);
      expect(settings.personality).toBeTruthy();
      expect(settings.communicationStyle).toBeTruthy();
      expect(settings.operatingProcedures).toBeTruthy();
      if (client === roofing) {
        expect(settings).toMatchObject({
          tone: "professional",
          companyRules: "Use plain language with homeowners.",
          neverPromise: "Never guarantee a repair date.",
          approvalPreference: "always",
        });
        expect(settings.personality).toContain("professional voice");
        expect(settings.personality).toContain("practical and proactive about permitted routine work and scheduling");
        expect(settings.escalateWhen).toContain("anything unsafe or uncertain");
        expect(settings.proactiveResponsibilities).toMatch(/prefers routine answers, lead qualification and booking/i);
        expect(settings.proactiveResponsibilities).toMatch(/grants no permission/i);
      }
      expect(rows[0].compiled_instructions).toContain(client.org.name);
      expect(rows[0].compiled_instructions).not.toContain(client === roofing ? plumbing.org.name : roofing.org.name);

      const brainRows = await withSystem((db) => db.query<{ current_version: number; source: string; business_brain: unknown }>(
        `select p.current_version, v.source, v.business_brain
         from ai_growth_partners p
         join ai_growth_partner_versions v on v.partner_id = p.id and v.org_id = p.org_id and v.version = p.current_version
         where p.org_id = $1`,
        [client.org.id],
      ));
      expect(brainRows.rows).toHaveLength(1);
      expect(brainRows.rows[0].current_version).toBe(1);
      expect(brainRows.rows[0].source).toBe("onboarding");
      const audit = (await withSystem((db) => db.query(
        "select actor_user_id, metadata from audit_logs where org_id = $1 and action = 'onboarding.completed'",
        [client.org.id],
      ))).rows[0];
      expect(audit).toMatchObject({ actor_user_id: client.owner.id, metadata: {
        businessBrainReview: { version: 1, confirmation: client.confirmation },
      } });
      const brain = parseBusinessBrain(brainRows.rows[0].business_brain);
      expect(brain.sections.businessIdentity.companyName).toMatchObject({ value: client.org.name, state: "client_confirmed" });
      expect(brain.sections.businessIdentity.industry).toMatchObject({ value: "home_services", state: "client_confirmed" });
      expect(brain.sections.productsServicesOffers.services).toMatchObject({ value: client === roofing ? "Roof repair and inspection" : "Pipe repair and drain cleaning", state: "client_confirmed" });
      expect(brain.sections.productsServicesOffers.pricing).toMatchObject({
        value: "Do not share prices. Hand pricing questions to a person.",
        state: "verified",
        provenance: [expect.objectContaining({ source: "company_knowledge", sourceId: "company_knowledge:approved_pricing@1" })],
      });

      const jobs = await withSystem((db) => db.query<{ kind: string; status: string }>(
        "select kind, status from agent_provisioning_jobs where org_id = $1",
        [client.org.id],
      ));
      expect(jobs.rows).toEqual([{ kind: "provision", status: "requested" }]);

      const before = await withSystem((db) => db.query<{ n: number }>(
        "select count(*)::int as n from ai_growth_partner_versions where org_id = $1",
        [client.org.id],
      ));
      const replay = await saveOnboardingStep(client.ctx, {
        answers: { "d.pricing_info": { value: "Old draft pricing that was hidden from the reviewed answers." }, "f.review": { value: true } },
      });
      expect(replay.rejected).toEqual({});
      const replayed = await submitOnboarding(client.ctx, { confirmation: client.confirmation });
      expect(replayed.notes.map((note) => note.key)).toContain("nothing.changed");
      const after = await withSystem((db) => db.query<{ n: number }>(
        "select count(*)::int as n from ai_growth_partner_versions where org_id = $1",
        [client.org.id],
      ));
      expect(after.rows[0].n).toBe(before.rows[0].n);
    }

    const runtime = (await withSystem((db) => db.query<{ id: string; settings: Record<string, unknown> }>(
      `select a.id, v.settings from agent_instances a join agent_config_versions v on v.id = a.active_config_version_id
       where a.org_id = $1 and a.role_key = 'growth_partner'`,
      [roofing.org.id],
    ))).rows[0];
    const clientPersonality = "Keep the partner calm and concise in every conversation.";
    await withSystem((db) => createConfigVersion(db, {
      orgId: roofing.org.id,
      agentId: runtime.id,
      settings: agentSettingsSchema.parse({ ...runtime.settings, personality: clientPersonality }),
      source: "client_edit",
      userId: roofing.owner.id,
      apply: true,
    }));
    const changed = await saveOnboardingStep(roofing.ctx, { answers: { "c.ai_behavior": { value: "draft_only" }, "c.tone": { value: "casual" }, "f.review": { value: true } } });
    expect(changed.rejected).toEqual({});
    await submitOnboarding(roofing.ctx);
    const updated = (await withSystem((db) => db.query<{ settings: unknown; compiled_instructions: string; status: string }>(
      `select v.settings, v.compiled_instructions, v.status from agent_instances a join agent_config_versions v on v.id = a.active_config_version_id
       where a.org_id = $1 and a.role_key = 'growth_partner'`,
      [roofing.org.id],
    ))).rows[0];
    const updatedSettings = agentSettingsSchema.parse(updated.settings);
    expect(updatedSettings.personality).toBe(clientPersonality);
    expect(updatedSettings.tone).toBe("casual");
    expect(updatedSettings.communicationStyle).toMatch(/Use a casual tone/i);
    expect(updatedSettings.proactiveResponsibilities).toMatch(/draft-only behavior/i);
    expect(updatedSettings.approvalPreference).toBe("always");
    expect(updated.compiled_instructions).toContain("draft-only behavior");

    const plumbingBefore = (await withSystem((db) => db.query<{ id: string; settings: unknown }>(
      `select a.id, v.settings from agent_instances a join agent_config_versions v on v.id = a.active_config_version_id
       where a.org_id = $1 and a.role_key = 'growth_partner'`,
      [plumbing.org.id],
    ))).rows[0];
    const previousGeneratedPersonality = agentSettingsSchema.parse(plumbingBefore.settings).personality;
    expect(previousGeneratedPersonality).toContain("friendly voice");
    const resubmitted = await saveOnboardingStep(plumbing.ctx, { answers: { "c.tone": { value: "premium" }, "f.review": { value: true } } });
    expect(resubmitted.rejected).toEqual({});
    await submitOnboarding(plumbing.ctx);
    const plumbingAfter = (await withSystem((db) => db.query<{ settings: unknown }>(
      `select v.settings from agent_instances a join agent_config_versions v on v.id = a.active_config_version_id
       where a.org_id = $1 and a.role_key = 'growth_partner'`,
      [plumbing.org.id],
    ))).rows[0];
    const updatedGeneratedPersonality = agentSettingsSchema.parse(plumbingAfter.settings).personality;
    expect(updatedGeneratedPersonality).toContain("premium voice");
    expect(updatedGeneratedPersonality).not.toBe(previousGeneratedPersonality);

    const runtimeCounts = await withSystem((db) => db.query<{ org_id: string; profiles: number; identities: number }>(
      `select o.id as org_id,
              count(distinct a.id)::int as profiles,
              count(distinct p.id)::int as identities
       from organizations o
       left join agent_instances a on a.org_id = o.id
       left join ai_growth_partners p on p.org_id = o.id
       where o.id in ($1, $2)
       group by o.id order by o.id`,
      [roofing.org.id, plumbing.org.id],
    ));
    expect(runtimeCounts.rows).toHaveLength(2);
    expect(runtimeCounts.rows.every((row) => row.profiles === 1 && row.identities === 1)).toBe(true);
  });
});
