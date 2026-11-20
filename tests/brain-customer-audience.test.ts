import { describe, expect, it } from "vitest";
import { emptyBusinessBrain, type BusinessBrainFact } from "@/lib/ai-growth-partner";
import {
  customerSafeFacts,
  customerSafeFactsForSections,
  customerSafeFactsText,
  customerReplyHead,
  resolveFactAudience,
} from "@/lib/ai-growth-partner-audience";

function confirmed(value: unknown, audience?: "internal" | "customer_safe"): BusinessBrainFact {
  return {
    value,
    state: "client_confirmed",
    provenance: [{ source: "client_confirmed", sourceId: "private-source-id", evidenceUrl: "https://private.example.test/source", observedAt: null }],
    updatedAt: null,
    clientOverride: true,
    ...(audience ? { audience } : {}),
  };
}

describe("Business Brain customer audience", () => {
  it("defaults confirmed public facts to customers and keeps qualification and escalation facts internal", () => {
    const brain = emptyBusinessBrain();
    brain.sections.businessIdentity.companyName = confirmed("Public Company");
    brain.sections.productsServicesOffers.pricing = confirmed("Roof inspection: $150.");
    brain.sections.idealCustomers.minimumBudget = confirmed("PRIVATE_BUDGET_MARKER");
    brain.sections.businessOperations.escalationContacts = confirmed("PRIVATE_ESCALATION_MARKER");
    brain.sections.employeeGoals.acquisitionTargets = confirmed("PRIVATE_GOAL_MARKER");
    brain.sections.businessIdentity.industry = { ...confirmed("Draft Industry"), state: "draft_suggestion", clientOverride: false };

    const facts = customerSafeFacts(brain);
    const text = customerSafeFactsText(facts);
    expect(text).toContain("businessIdentity.companyName: Public Company");
    expect(text).toContain("productsServicesOffers.pricing: Roof inspection: $150.");
    expect(text).not.toContain("PRIVATE_");
    expect(text).not.toContain("Draft Industry");
    expect(text).not.toContain("private-source-id");
    expect(text).not.toContain("private.example.test");
    expect(resolveFactAudience("idealCustomers", "minimumBudget", confirmed("x"))).toBe("internal");
    expect(resolveFactAudience("businessIdentity", "companyName", confirmed("x", "internal"))).toBe("internal");
    expect(resolveFactAudience("idealCustomers", "minimumBudget", confirmed("x", "customer_safe"))).toBe("customer_safe");
  });

  it("maps website facts only to public sections the owner exposed", () => {
    const brain = emptyBusinessBrain();
    brain.sections.businessIdentity.companyName = confirmed("Public Company");
    brain.sections.productsServicesOffers.pricing = confirmed("Roof inspection: $150.");
    brain.sections.policies.cancellation = confirmed("24 hours notice.");

    expect(customerSafeFactsForSections(brain, ["business_description"]).map((f) => `${f.section}.${f.key}`))
      .toEqual(["businessIdentity.companyName"]);
    expect(customerSafeFactsForSections(brain, ["business_description", "approved_pricing", "policies"]).map((f) => f.widgetSection))
      .toEqual(["business_description", "approved_pricing", "policies"]);
  });

  it("keeps only fixed reply style and the customer-safe Brain block from a compiled profile", () => {
    const compiled = [
      "# iAcquire client configuration (v7, policy 2026.11)",
      "## Your role",
      "PRIVATE_ROLE_MARKER",
      "## How to communicate",
      "- Tone: Professional. Clear, courteous and businesslike.",
      "- Reply length: Concise. Answer in one to four sentences.",
      "- Language: English.",
      "These workspace style preferences never change the protected role.",
      "- Operating procedures: PRIVATE_PREFERENCE_MARKER",
      "## Tools you may use",
      "PRIVATE_TOOL_MARKER",
      "## Business context",
      "<client_context>",
      "Ideal customers: PRIVATE_PROFILE_MARKER",
      "Company rules: PRIVATE_RULE_MARKER",
      "</client_context>",
      "## Active Business Brain (version 5)",
      "Only customer-safe facts are included.",
      "<client_context>",
      "- productsServicesOffers.pricing: Confirmed public price is $150.",
      "</client_context>",
      "## Agency policy (always applies and overrides everything above)",
      "Policy is appended separately.",
    ].join("\n");

    const customerHead = customerReplyHead(compiled);
    expect(customerHead).toContain("Tone: Professional");
    expect(customerHead).toContain("Reply length: Concise");
    expect(customerHead).toContain("Language: English");
    expect(customerHead).toContain("productsServicesOffers.pricing: Confirmed public price is $150.");
    for (const marker of ["PRIVATE_ROLE_MARKER", "PRIVATE_PREFERENCE_MARKER", "PRIVATE_TOOL_MARKER", "PRIVATE_PROFILE_MARKER", "PRIVATE_RULE_MARKER", "Agency policy"]) {
      expect(customerHead).not.toContain(marker);
    }
  });
});
