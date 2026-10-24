import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { AGENT_ROLE_KEYS } from "@/lib/agents";
import { agentSettingsSchema } from "@/lib/agent-settings";
import { saveOnboardingStep, submitOnboarding } from "@/server/onboarding/service";
import { addMember, createOrg, createUser, ctxFor } from "./support/fixtures";
import { clearSetupPayment } from "./support/billing";

async function onboard(name: string, description: string, service: string, customer: string) {
  const org = await createOrg({ name });
  // Provisioning requests need the setup payment confirmed (tests/payment-gate.test.ts is about that); this test is about the workforce the flow builds.
  await clearSetupPayment(org.id);
  const owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  const ctx = ctxFor(owner, org, "owner");
  const answers = {
    "a.business_name": name,
    "a.industry": "home_services",
    "a.business_model": "local",
    "a.description": description,
    "a.timezone": "America/Chicago",
    "a.contact_email": owner.email,
    "a.territories": "Austin, Texas",
    "a.target_customers": customer,
    "b.goals": ["more_leads", "more_appointments"],
    "b.services": service,
    "b.ideal_customer": customer,
    "b.appointments": true,
    "b.website_need": "have",
    "d.pricing_policy": "never",
    "f.review": true,
  };
  const saved = await saveOnboardingStep(ctx, { answers: Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, { value }])), currentQuestionId: "f.review" });
  expect(saved.rejected).toEqual({});
  const result = await submitOnboarding(ctx);
  return { org, owner, ctx, result };
}

describe("isolated new-client onboarding acceptance (test database; no Hermes writes)", () => {
  it("configures two distinct six-person workforces from one flow each without cross-tenant knowledge or fake readiness", async () => {
    const dental = await onboard("Brightside Roofing", "We repair residential roofs after storm damage.", "Roof repair and inspection", "Austin homeowners");
    const legal = await onboard("Harbor Plumbing", "We repair plumbing systems for local homes.", "Pipe repair and drain cleaning", "Austin property owners");
    for (const client of [dental, legal]) {
      expect(client.result.employees).toHaveLength(6);
      const { rows } = await withSystem((db) => db.query<{ role_key: string; status: string; hermes_profile: string | null; settings: unknown; compiled_instructions: string; config_status: string }>(
        `select a.role_key, a.status, a.hermes_profile, v.settings, v.compiled_instructions, v.status as config_status
         from agent_instances a
         left join lateral (
           select settings, compiled_instructions, status from agent_config_versions
           where agent_instance_id = a.id and org_id = a.org_id order by version desc limit 1
         ) v on true
         where a.org_id = $1 order by a.role_key`, [client.org.id],
      ));
      expect(rows.map((row) => row.role_key).sort()).toEqual([...AGENT_ROLE_KEYS].sort());
      expect(rows.every((row) => row.status !== "online" && row.hermes_profile === null)).toBe(true);
      expect(rows.every((row) => row.settings !== null)).toBe(true);
      for (const row of rows) {
        expect(["applied", "pending_agency_review"]).toContain(row.config_status);
        const settings = agentSettingsSchema.parse(row.settings);
        expect(settings.personality).toBeTruthy();
        expect(settings.communicationStyle).toBeTruthy();
        expect(settings.operatingProcedures).toBeTruthy();
        expect(row.compiled_instructions).toContain(client.org.name);
        expect(row.compiled_instructions).not.toContain(client === dental ? legal.org.name : dental.org.name);
      }
      const jobs = await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from agent_provisioning_jobs where org_id = $1", [client.org.id]));
      expect(jobs.rows[0].n).toBe(6);
      const before = await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from agent_config_versions where org_id = $1", [client.org.id]));
      const repeated = await submitOnboarding(client.ctx);
      expect(repeated.employees.every((item) => item.configStatus === "unchanged")).toBe(true);
      const after = await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from agent_config_versions where org_id = $1", [client.org.id]));
      expect(after.rows[0].n).toBe(before.rows[0].n);
    }
  });
});
