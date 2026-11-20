import { describe, expect, it } from "vitest";
import { growthPartnerPrimaryAction } from "@/lib/ai-growth-partner-navigation";

describe("overview Growth Partner navigation", () => {
  it("routes the primary action to one conversation after it exists and setup to the Control Center before then", () => {
    expect(growthPartnerPrimaryAction({ conversationId: "conversation-1" })).toEqual({
      href: "/growth-partner/conversation",
      label: "Open AI Growth Partner",
    });
    expect(growthPartnerPrimaryAction({ conversationId: null })).toEqual({
      href: "/growth-partner",
      label: "Review Partner setup",
    });
    expect(growthPartnerPrimaryAction(null)).toEqual({
      href: "/growth-partner",
      label: "Set up AI Growth Partner",
    });
  });
});
