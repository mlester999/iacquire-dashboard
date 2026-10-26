import { beforeEach, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { agentSettingsSchema } from "@/lib/agent-settings";
import { createConfigVersion } from "@/server/workforce/service";
import { saveOnboardingStep, submitOnboarding } from "@/server/onboarding/service";
import { addMember, agentId, createOrg, createUser, ctxFor } from "./support/fixtures";
import { clearSetupPayment } from "./support/billing";

const llm = vi.hoisted(() => ({
  config: null as object | null,
  reply: { ok: true, text: "{}" } as { ok: boolean; text?: string; status?: number },
}));

vi.mock("@/server/llm/client", () => ({
  resolveLlmConfig: async () => llm.config,
  llmComplete: async () => llm.reply,
}));

const preferences = (role: AgentRoleKey) => ({
  personality: `AI-personalized ${role} employee who works carefully and helpfully.`,
  characterTraits: `Careful, attentive, and focused on ${role} work.`,
  communicationStyle: `Use clear, calm language suited to the ${role} role.`,
  responseBehavior: "Answer from confirmed information and ask when something important is missing.",
  operatingProcedures: "Check the approved role steps and verify facts before returning any result.",
  proactiveResponsibilities: "Surface useful work only when an authorized request, schedule, or trigger exists.",
  reportingBehavior: "Separate confirmed findings from uncertainty and state a safe next step.",
  responsibilities: `Support the ${role} function using only the approved company context.`,
  goals: `Help the owner reach selected goals through accurate ${role} work.`,
});

const answers = (businessName: string, idealCustomer: string) => ({
  "a.business_name": businessName,
  "a.industry": "home_services",
  "a.business_model": "local",
  "a.description": "We repair residential roofs after storm damage.",
  "a.timezone": "America/Chicago",
  "a.contact_email": "owner@example.test",
  "a.territories": "Austin, Texas",
  "a.target_customers": "Central Texas residents",
  "b.goals": ["more_leads", "more_appointments"],
  "b.services": "Roof repair and inspection",
  "b.ideal_customer": idealCustomer,
  "b.appointments": true,
  "b.website_need": "have",
  "d.pricing_policy": "never",
  "f.review": true,
});

describe("isolated AI-filled client onboarding acceptance", () => {
  beforeEach(() => {
    llm.config = { baseUrl: "https://llm.example.test/v1", format: "openai", model: "test-model", apiKey: "test-only", source: "portal" };
    llm.reply = { ok: true, text: JSON.stringify(Object.fromEntries(AGENT_ROLE_KEYS.map((role) => [role, preferences(role)]))) };
  });

  it("submits six model-personalized employees and preserves a client edit through a later business update", async () => {
    const org = await createOrg({ name: "Juniper Roof Care" });
    await clearSetupPayment(org.id);
    const owner = await createUser();
    await addMember(org.id, owner.id, "owner");
    const ctx = ctxFor(owner, org, "owner");

    const initial = answers(org.name, "Austin homeowners");
    const saved = await saveOnboardingStep(ctx, {
      answers: Object.fromEntries(Object.entries(initial).map(([key, value]) => [key, { value }])),
      currentQuestionId: "f.review",
    });
    expect(saved.rejected).toEqual({});

    const result = await submitOnboarding(ctx);
    expect(result.employees).toHaveLength(AGENT_ROLE_KEYS.length);

    const { rows: configs } = await withSystem((db) => db.query<{
      role_key: AgentRoleKey;
      settings: unknown;
      compiled_instructions: string;
      source: string;
      change_request: string | null;
    }>(
      `select a.role_key, v.settings, v.compiled_instructions, v.source, v.change_request
       from agent_instances a
       join agent_config_versions v on v.id = a.active_config_version_id and v.org_id = a.org_id
       where a.org_id = $1 order by a.role_key`,
      [org.id],
    ));
    expect(configs.map((row) => row.role_key).sort()).toEqual([...AGENT_ROLE_KEYS].sort());
    for (const row of configs) {
      const settings = agentSettingsSchema.parse(row.settings);
      expect(settings.personality).toBe(preferences(row.role_key).personality);
      expect(settings.operatingProcedures).toBe(preferences(row.role_key).operatingProcedures);
      expect(settings.targetCustomers).toBe("Austin homeowners\nCentral Texas residents");
      expect(row.compiled_instructions).toContain(settings.personality);
      expect(row.compiled_instructions).toContain(org.name);
      expect(row.source).toBe("onboarding");
      expect(row.change_request).not.toContain("Safe deterministic defaults");
    }

    const provisioning = await withSystem((db) => db.query<{ n: number }>(
      "select count(*)::int as n from agent_provisioning_jobs where org_id = $1", [org.id],
    ));
    expect(provisioning.rows[0].n).toBe(AGENT_ROLE_KEYS.length);

    const hunterId = await agentId(org.id, "lead_hunter");
    const hunter = configs.find((row) => row.role_key === "lead_hunter")!;
    const clientEdited = agentSettingsSchema.parse({
      ...hunter.settings as object,
      targetCustomers: "Owner-approved independent roof specialists",
    });
    await withSystem((db) => createConfigVersion(db, {
      orgId: org.id,
      agentId: hunterId,
      settings: clientEdited,
      source: "client_edit",
      userId: owner.id,
      apply: true,
    }));

    const revised = answers(org.name, "Austin property managers");
    const update = await saveOnboardingStep(ctx, {
      answers: {
        "b.ideal_customer": { value: revised["b.ideal_customer"] },
        "f.review": { value: true },
      },
      currentQuestionId: "f.review",
    });
    expect(update.rejected).toEqual({});
    await submitOnboarding(ctx);

    const { rows: history } = await withSystem((db) => db.query<{ source: string; settings: unknown }>(
      `select source, settings from agent_config_versions
       where org_id = $1 and agent_instance_id = $2 and status in ('applied', 'pending_agency_review')
       order by version desc limit 1`,
      [org.id, hunterId],
    ));
    const latest = agentSettingsSchema.parse(history[0].settings);
    expect(latest.targetCustomers).toBe("Owner-approved independent roof specialists");
    expect(latest.personality).toBe(preferences("lead_hunter").personality);
    expect(history[0].source).toBe("onboarding");

    const { rows: profile } = await withSystem((db) => db.query<{ ideal_customers: string }>(
      "select ideal_customers from company_profiles where org_id = $1", [org.id],
    ));
    expect(profile[0].ideal_customers).toBe("Austin property managers\nCentral Texas residents");
  });
});
