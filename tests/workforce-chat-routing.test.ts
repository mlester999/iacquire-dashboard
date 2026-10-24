import { describe, expect, it } from "vitest";
import { explicitlyAddressedWorkforceRole, isAutomationBuilderRequest, parseNamedWorkforceHandoff } from "@/lib/workforce-chat-routing";

describe("AI employee automation routing", () => {
  it("routes workflow-building requests to the specialized builder", () => {
    expect(isAutomationBuilderRequest("Create an automation that sends an email when we receive a new lead.")).toBe(true);
    expect(isAutomationBuilderRequest("Lead Hunter, build a workflow that starts when a lead is approved.")).toBe(true);
    expect(isAutomationBuilderRequest("Can you help me modify this workflow?" )).toBe(true);
  });

  it("leaves employee work and ordinary Automation Studio questions in employee chat", () => {
    expect(isAutomationBuilderRequest("Review our current workflows for errors.")).toBe(false);
    expect(isAutomationBuilderRequest("Can you explain this workflow?" )).toBe(false);
    expect(isAutomationBuilderRequest("What is Automation Studio?" )).toBe(false);
    expect(isAutomationBuilderRequest("Review our pipeline and prepare follow-ups.")).toBe(false);
    expect(isAutomationBuilderRequest(" ")).toBe(false);
  });
});

describe("AI employee named handoff routing", () => {
  it("routes one explicitly addressed, supported assignment to the named employee", () => {
    expect(parseNamedWorkforceHandoff("lead_hunter", "CRM Manager, check our CRM for duplicates and incomplete records."))
      .toMatchObject({ targetRole: "crm_manager", assignment: { capability: "crm_quality_review" } });
    expect(parseNamedWorkforceHandoff("lead_hunter", "Could you ask the Operations Manager to review our operations?"))
      .toMatchObject({ targetRole: "operations_manager", assignment: { capability: "proactive_review" } });
  });

  it("does not infer delegation from a mention, unsupported task, same role, or recurrence", () => {
    expect(parseNamedWorkforceHandoff("lead_hunter", "Can you tell me what the CRM Manager does? Check our CRM for duplicates.")).toBeNull();
    expect(parseNamedWorkforceHandoff("lead_hunter", "CRM Manager, check our CRM for duplicates, then ask Sales Assistant to prepare follow-ups.")).toBeNull();
    expect(parseNamedWorkforceHandoff("lead_hunter", "CRM Manager, update the duplicate records.")).toBeNull();
    expect(parseNamedWorkforceHandoff("crm_manager", "CRM Manager, check our CRM for duplicates.")).toBeNull();
    expect(parseNamedWorkforceHandoff("lead_hunter", "CRM Manager, check our CRM for duplicates every Friday.")).toBeNull();
    expect(parseNamedWorkforceHandoff("lead_hunter", "Operations Manager, review blocked work every evening.")).toBeNull();
    expect(explicitlyAddressedWorkforceRole("lead_hunter", "Performance Analyst, prepare a report every Friday at 9 AM."))
      .toBe("performance_analyst");
    expect(explicitlyAddressedWorkforceRole("lead_hunter", "Can you tell me what the CRM Manager does?"))
      .toBeNull();
  });
});
