import { describe, expect, it } from "vitest";
import { AGENT_ROLES } from "@/lib/agents";
import { AGENT_TOOL_COPY } from "@/lib/agent-tools";
import {
  COMPANY_FIELD_GUIDANCE,
  KNOWLEDGE_GUIDANCE,
  ROLE_TOOL_GUIDANCE,
  SHARED_EMPLOYEE_GUIDANCE,
  changeFixForReason,
  configFieldElementId,
  employeeFieldGuidance,
} from "@/lib/employee-field-guidance";
import { INSTRUCTION_RISK_META } from "@/lib/instruction-risk";

const ROLE_EXAMPLES: Record<string, { responsibilities: string; goals: string }> = {
  operations_manager: {
    responsibilities: "Monitor operational tasks, identify blockers, coordinate internal work, and prepare progress reports.",
    goals: "Help the agency meet deadlines and reduce unresolved operational issues.",
  },
  lead_hunter: {
    responsibilities: "Research businesses that match our ideal customer profile and prepare qualified lead records.",
    goals: "Identify relevant prospects with accurate business information.",
  },
  appointment_setter: {
    responsibilities: "Help qualified customers find available appointment times and manage booking requests.",
    goals: "Improve scheduling efficiency and reduce missed appointments.",
  },
  sales_assistant: {
    responsibilities: "Answer approved sales questions, explain services, and prepare follow-up drafts.",
    goals: "Help qualified prospects move through the sales process.",
  },
  crm_manager: {
    responsibilities: "Maintain accurate CRM records, identify incomplete data, and organize pipeline information.",
    goals: "Improve CRM data quality and visibility.",
  },
  performance_analyst: {
    responsibilities: "Analyze authorized business metrics and create performance reports.",
    goals: "Identify trends, operational improvements, and opportunities.",
  },
};

describe("guided employee field coverage", () => {
  it("provides role-specific responsibilities and goals for every real role", () => {
    for (const role of AGENT_ROLES) {
      const expected = ROLE_EXAMPLES[role.key];
      const responsibilities = employeeFieldGuidance(role.key, "responsibilities");
      const goals = employeeFieldGuidance(role.key, "goals");
      expect(responsibilities.example, role.key).toBe(expected.responsibilities);
      expect(goals.example, role.key).toBe(expected.goals);
      expect(responsibilities.description.length, role.key).toBeGreaterThan(30);
      expect(goals.description.length, role.key).toBeGreaterThan(30);
      expect(employeeFieldGuidance(role.key, "targetCustomers").example, role.key).toBeTruthy();
      expect(employeeFieldGuidance(role.key, "customInstruction").example, role.key).toBeTruthy();
    }
  });

  it("provides visible guidance for every shared employee configuration field", () => {
    for (const key of ["displayName", "tone", "replyLength", "language", "companyRules", "neverPromise", "escalateWhen", "escalationContact"] as const) {
      expect(SHARED_EMPLOYEE_GUIDANCE[key].description.length, key).toBeGreaterThan(20);
      expect(employeeFieldGuidance("operations_manager", key).description, key).toBe(SHARED_EMPLOYEE_GUIDANCE[key].description);
    }
  });

  it("explains each real role question with real help text and an example", () => {
    for (const role of AGENT_ROLES) {
      expect(role.questions.length).toBeGreaterThan(0);
      for (const question of role.questions) {
        expect(question.help, `${role.key}.${question.id}`).toBeTruthy();
        expect(question.help!.length, `${role.key}.${question.id}`).toBeGreaterThan(40);
        expect(question.placeholder, `${role.key}.${question.id}`).toMatch(/^e\.g\./);
        expect(question.help!.toLowerCase(), `${role.key}.${question.id}`).not.toContain("without approval");
      }
    }
  });

  it("covers every granted tool with accurate, non-expansive guidance", () => {
    for (const label of Object.keys(AGENT_TOOL_COPY)) {
      const guidance = ROLE_TOOL_GUIDANCE[label];
      expect(guidance, label).toBeTruthy();
      expect(guidance.description.length, label).toBeGreaterThan(40);
      expect(guidance.off.length, label).toBeGreaterThan(10);
      expect(guidance.description.toLowerCase(), label).not.toContain("full access");
      expect(guidance.description.toLowerCase(), label).not.toContain("unrestricted");
    }
  });

  it("provides guidance for company profile and knowledge fields", () => {
    for (const key of ["companyName", "industry", "website", "operatingArea", "description", "services", "idealCustomers", "brandColor"] as const) {
      expect(COMPANY_FIELD_GUIDANCE[key].description.length, key).toBeGreaterThan(20);
    }
    expect(COMPANY_FIELD_GUIDANCE.description.description).toContain("who it serves");
    expect(COMPANY_FIELD_GUIDANCE.services.description).toContain("limitations");
    expect(COMPANY_FIELD_GUIDANCE.website.description).toContain("business knowledge");
    for (const key of ["upload", "title", "content"] as const) {
      expect(KNOWLEDGE_GUIDANCE[key].description.length, key).toBeGreaterThan(20);
    }
  });

  it("maps every reviewable configuration field to the input a user must fix", () => {
    const fields = [
      "displayName",
      "responsibilities",
      "goals",
      "targetCustomers",
      "companyRules",
      "neverPromise",
      "escalateWhen",
      "escalationContact",
      "customInstruction",
      "disabledTools",
      "approvalPreference",
      "roleAnswers.approval_rules",
    ];
    for (const field of fields) {
      expect(configFieldElementId(field), field).toBeTruthy();
    }
    expect(configFieldElementId("roleAnswers.approval_rules")).toBe("cfg-q-approval_rules");
    expect(configFieldElementId("unknown_field")).toBeNull();
  });

  it("gives a safe next step for every authoritative reason without promising an override", () => {
    for (const code of Object.keys(INSTRUCTION_RISK_META)) {
      const fix = changeFixForReason(code, "");
      expect(fix.length, code).toBeGreaterThan(30);
      expect(fix.toLowerCase(), code).not.toMatch(/ask (iacquire|support) to approve|approved anyway|disable the (check|rule)/);
    }
    for (const code of ["guardrail_removed", "guardrail_weakened", "approval_scope_reduced", "escalation_destination_changed", "tool_reenabled", "impersonation_risk"]) {
      const fix = changeFixForReason(code, "");
      expect(fix.length, code).toBeGreaterThan(30);
      expect(fix.toLowerCase(), code).not.toMatch(/approved anyway|disable the (check|rule)/);
    }
  });
});
