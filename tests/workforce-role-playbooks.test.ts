import { describe, expect, it } from "vitest";
import { AGENT_ROLE_KEYS } from "@/lib/agents";
import { INTERNAL_BUSINESS } from "@/lib/internal-business-profile";
import { auditRoleConfiguration, recommendedSettings } from "@/lib/role-playbooks";
import { compileAgentConfig } from "@/server/workforce/compiler";
import { agentSettingsSchema } from "@/lib/agent-settings";

const company = {
  companyName: "Example Agency",
  description: "We build websites and automation for local service businesses.",
  services: "Website design, automation and lead follow-up.",
  idealCustomers: "Independent dental and medical clinics with 2-20 staff.",
  operatingArea: "Miami-Dade County, Florida.",
  industry: "Marketing agency",
};

describe("role playbooks", () => {
  it("provides complete role-specific starting configurations for all six employees", () => {
    const confirmedAgency = {
      description: INTERNAL_BUSINESS.description,
      services: INTERNAL_BUSINESS.services,
      idealCustomers: INTERNAL_BUSINESS.idealCustomers,
      operatingArea: INTERNAL_BUSINESS.operatingArea,
      industry: INTERNAL_BUSINESS.industry,
    };
    for (const role of AGENT_ROLE_KEYS) {
      const settings = recommendedSettings(role);
      expect(agentSettingsSchema.safeParse(settings).success, role).toBe(true);
      expect(settings.displayName, role).toBeTruthy();
      expect(settings.personality, role).toMatch(/.{12,}/);
      expect(settings.characterTraits, role).toMatch(/.{8,}/);
      expect(settings.communicationStyle, role).toMatch(/.{12,}/);
      expect(settings.responseBehavior, role).toMatch(/.{12,}/);
      expect(settings.operatingProcedures, role).toMatch(/.{12,}/);
      expect(settings.proactiveResponsibilities, role).toMatch(/.{12,}/);
      expect(settings.reportingBehavior, role).toMatch(/.{12,}/);
      expect(settings.responsibilities, role).toMatch(/\S{8,}/);
      expect(settings.goals, role).toMatch(/\S{8,}/);
      expect(settings.neverPromise, role).toMatch(/\S{8,}/);
      expect(settings.escalateWhen, role).toMatch(/\S{8,}/);
      expect(settings.customInstruction, role).toMatch(/\S{8,}/);
      expect(settings.approvalPreference, role).toBe("always");
      expect(auditRoleConfiguration(role, settings, confirmedAgency).ready, role).toBe(true);
    }
    expect(new Set(AGENT_ROLE_KEYS.map((role) => recommendedSettings(role).personality)).size).toBe(AGENT_ROLE_KEYS.length);
  });

  it("provides a complete, valid Lead Hunter starting point without inventing company facts", () => {
    const settings = recommendedSettings("lead_hunter");
    expect(agentSettingsSchema.safeParse(settings).success).toBe(true);
    expect(settings.tone).toBe("professional");
    expect(settings.responsibilities).toMatch(/approved public sources/i);
    expect(settings.neverPromise).toMatch(/never claim a business is interested/i);
    expect(settings.escalateWhen).toMatch(/industry, location, quantity/i);
    expect(settings.roleAnswers.targets).toMatch(/workspace targeting rules/i);
    expect(settings.roleAnswers.qualification).toMatch(/at least one verified public source/i);
    // Company-specific targeting and contact details must remain unanswered.
    expect(settings.targetCustomers).toBe("");
    expect(settings.escalationContact).toBe("");
    expect(settings.companyRules).toBe("");
  });

  it("does not copy the Operations Manager playbook into the Lead Hunter", () => {
    const hunter = recommendedSettings("lead_hunter");
    const operations = recommendedSettings("operations_manager");
    expect(hunter.responsibilities).not.toBe(operations.responsibilities);
    expect(hunter.displayName).not.toBe(operations.displayName);
    expect(hunter.customInstruction).not.toBe(operations.customInstruction);
    expect(hunter.neverPromise).not.toBe(operations.neverPromise);
  });

  it("separates role completeness from missing company facts", () => {
    const settings = recommendedSettings("lead_hunter");
    const incompleteCompany = auditRoleConfiguration("lead_hunter", settings, {});
    expect(incompleteCompany.employeeComplete).toBe(incompleteCompany.employeeTotal);
    expect(incompleteCompany.companyComplete).toBe(0);
    expect(incompleteCompany.ready).toBe(false);
    expect(incompleteCompany.missingCompanyFacts).toEqual(
      expect.arrayContaining(["Business description", "Products and services", "Ideal customers", "Operating area"]),
    );

    const complete = auditRoleConfiguration("lead_hunter", settings, company);
    expect(complete.ready).toBe(true);
    expect(complete.missingCompanyFacts).toEqual([]);
  });

  it("flags placeholder text rather than counting it as configured", () => {
    const settings = { ...recommendedSettings("lead_hunter"), responsibilities: "TBD", escalateWhen: "unknown" };
    const audit = auditRoleConfiguration("lead_hunter", settings, company);
    expect(audit.ready).toBe(false);
    expect(audit.items.find((item) => item.key === "responsibilities")?.state).toBe("missing");
    expect(audit.items.find((item) => item.key === "escalateWhen")?.state).toBe("missing");
  });

  it("accepts a short employee name such as Zeng while still rejecting a placeholder", () => {
    const settings = { ...recommendedSettings("operations_manager"), displayName: "Zeng" };
    const audit = auditRoleConfiguration("operations_manager", settings, company);
    expect(audit.items.find((item) => item.key === "displayName")?.state).toBe("complete");
    expect(audit.ready).toBe(true);

    const placeholder = auditRoleConfiguration("operations_manager", { ...settings, displayName: "TBD" }, company);
    expect(placeholder.items.find((item) => item.key === "displayName")?.state).toBe("missing");
    expect(placeholder.ready).toBe(false);
  });
});

describe("compiled Lead Hunter operating standard", () => {
  const compiled = compileAgentConfig({
    role: "lead_hunter",
    settings: recommendedSettings("lead_hunter"),
    company,
    version: 1,
    allowedTools: ["research.public_web", "leads.stage_for_review"],
  });

  it("includes the server-owned evidence, duplicate, approval and reporting standards", () => {
    expect(compiled.instructions).toContain("## Role operating standard");
    expect(compiled.instructions).toContain("Evidence standard:");
    expect(compiled.instructions).toContain("Duplicates:");
    expect(compiled.instructions).toContain("Approvals:");
    expect(compiled.instructions).toContain("Never fabricate a result to fill the requested quantity.");
    expect(compiled.instructions).toMatch(/human reviews every candidate before import or contact/i);
  });

  it("keeps the operating standard before the quoted client context and the final agency policy", () => {
    const operatingAt = compiled.instructions.indexOf("## Role operating standard");
    const clientAt = compiled.instructions.indexOf("<client_context>");
    const policyAt = compiled.instructions.indexOf("## Agency policy");
    expect(operatingAt).toBeGreaterThan(-1);
    expect(clientAt).toBeGreaterThan(operatingAt);
    expect(policyAt).toBeGreaterThan(clientAt);
  });

  it("does not leak another role's operating standard", () => {
    const ops = compileAgentConfig({
      role: "operations_manager",
      settings: recommendedSettings("operations_manager"),
      company,
      version: 1,
      allowedTools: [],
    });
    expect(ops.instructions).not.toContain("Duplicates: treat an existing CRM company");
    expect(ops.instructions).toContain("Do not create, approve, send or apply business actions.");
  });
});
