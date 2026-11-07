import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EmployeeInstructions } from "@/components/workforce/employee-instructions";
import type { EmployeeInstructionOverview } from "@/server/workforce/instructions";

const overview = {
  role: "lead_hunter",
  roleName: "Lead Hunter",
  soul: "SOUL fixture",
  policyVersion: "policy-1",
  active: { version: 1, summary: null, appliedAt: null, settings: null, compiledInstructions: null },
  layers: [],
  knowledge: { companySections: 1, employeeNotes: 2, referenceDocuments: 0, characters: 120, truncated: false },
  memory: {
    scopeLabel: "legacy-profile-scope",
    conversations: 1,
    messages: 2,
    retentionDays: 30,
    inspectionSupported: false,
    hermesMemoryEvidence: [],
  },
  usage: { runs: 1, completed: 1, failed: 0, tokens: 50, toolCalls: 0, averageLatencyMs: 200, lastRunAt: null, costsAvailable: false },
} as EmployeeInstructionOverview;

describe("previous role profile instruction history", () => {
  it("separates retained role history from the permanent Partner conversation and unverified Hermes memory", () => {
    const html = renderToStaticMarkup(
      <EmployeeInstructions overview={overview} agentName="Lead Hunter" role="lead_hunter" timeZone="UTC" isClientPreviousProfile onOpenKnowledge={() => {}} />,
    );

    expect(html).toContain("Saved conversations remain linked to this profile.");
    expect(html).toContain("has not passed the pinned-runtime acceptance");
    expect(html).toContain("This history belongs to a previous role profile.");
    expect(html).toContain("New client requests belong in the permanent AI Growth Partner conversation.");
    expect(html).toContain('href="/growth-partner/conversation"');
    expect(html).not.toContain("Long-term memory is kept by Hermes");
    expect(html).not.toContain("AI employee");
  });
});
