import { describe, expect, it } from "vitest";
import { recommendedSettings } from "@/lib/role-playbooks";
import { mergeGeneratedEmployeeFields, type EmployeeGeneratedFields } from "@/lib/employee-generated-fields";

const generated: EmployeeGeneratedFields = {
  personality: "A measured, helpful specialist who makes the next step clear.",
  characterTraits: "Patient, precise and attentive to detail.",
  communicationStyle: "Explain the evidence and next step in plain language.",
  responseBehavior: "Ask when a required fact is missing and state uncertainty clearly.",
  responsibilities: "Complete the assigned work using confirmed records and role limits.",
  goals: "Improve useful outcomes while preserving accuracy and human review.",
  operatingProcedures: "Check the authorized source, follow role steps and report the result.",
  proactiveResponsibilities: "Surface work only for an authorized request, schedule or trigger.",
  reportingBehavior: "State the source, period, uncertainty and next step.",
};

describe("generated employee field merging", () => {
  it("fills blank fields without replacing existing user text or unrelated controls", () => {
    const current = {
      ...recommendedSettings("appointment_setter"),
      personality: "An owner-written scheduling preference.",
      characterTraits: "",
      disabledTools: ["appointments-request_change"],
    };

    const result = mergeGeneratedEmployeeFields(current, generated);

    expect(result.settings.personality).toBe("An owner-written scheduling preference.");
    expect(result.settings.characterTraits).toBe(generated.characterTraits);
    expect(result.settings.disabledTools).toEqual(["appointments-request_change"]);
    expect(result.settings.approvalPreference).toBe("always");
    expect(result.applied).toEqual(["characterTraits"]);
    expect(result.preserved).toContain("personality");
  });

  it("replaces untouched role defaults only for a first config and still preserves custom text", () => {
    const defaults = recommendedSettings("crm_manager");
    const current = { ...defaults, responsibilities: "A manually written CRM responsibility." };

    const result = mergeGeneratedEmployeeFields(current, generated, defaults);

    expect(result.settings.personality).toBe(generated.personality);
    expect(result.settings.responsibilities).toBe("A manually written CRM responsibility.");
    expect(result.applied).toContain("personality");
    expect(result.preserved).toEqual(["responsibilities"]);
  });
});
