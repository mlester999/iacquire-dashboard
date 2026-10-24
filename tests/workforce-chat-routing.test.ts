import { describe, expect, it } from "vitest";
import { isAutomationBuilderRequest } from "@/lib/workforce-chat-routing";

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
