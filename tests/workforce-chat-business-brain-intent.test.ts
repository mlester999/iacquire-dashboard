import { describe, expect, it } from "vitest";
import { parseWorkforceChatBusinessBrainIntent } from "@/lib/workforce-chat-business-brain-intent";

describe("Growth Partner Business Brain chat edits", () => {
  it("recognizes one explicit field update and preserves newline-separated list values", () => {
    expect(parseWorkforceChatBusinessBrainIntent(
      "growth_partner",
      "Update Business Brain service areas to Orlando metropolitan area\nWinter Park\nKissimmee",
    )).toEqual({
      kind: "draft",
      section: "businessIdentity",
      key: "serviceAreas",
      label: "service areas",
      valueText: "Orlando metropolitan area\nWinter Park\nKissimmee",
    });
  });

  it("supports the owner's explicit field syntax and punctuation", () => {
    expect(parseWorkforceChatBusinessBrainIntent("growth_partner", "Set the Business Brain's industry = roofing."))
      .toEqual({ kind: "draft", section: "businessIdentity", key: "industry", label: "industry", valueText: "roofing" });
  });

  it("clarifies unsupported, empty, malformed, or multi-edit requests", () => {
    for (const content of [
      "Update Business Brain tone to friendly",
      "Update Business Brain service areas to ",
      "Update Business Brain services to gutters and also change Business Brain industry to roofing",
      "Update Business Brain services to " + "x".repeat(4001),
    ]) {
      expect(parseWorkforceChatBusinessBrainIntent("growth_partner", content).kind).toBe("clarification");
    }
  });

  it("does not interpret another role's message as a Growth Partner settings edit", () => {
    expect(parseWorkforceChatBusinessBrainIntent("lead_hunter", "Update Business Brain industry to roofing"))
      .toEqual({ kind: "none" });
  });
});
