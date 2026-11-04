import { describe, expect, it } from "vitest";
import { parseWorkforceChatTargetingIntent } from "@/lib/workforce-chat-targeting-intent";

describe("Growth Partner chat targeting intent", () => {
  it("recognizes an explicit industry and region update", () => {
    expect(parseWorkforceChatTargetingIntent("growth_partner", "Only look for dental clinics in Florida.")).toEqual({
      kind: "update", industry: "dental clinics", region: "Florida",
    });
    expect(parseWorkforceChatTargetingIntent("growth_partner", "Change our targeting rules to roofing businesses in Central Texas.")).toEqual({
      kind: "update", industry: "roofing businesses", region: "Central Texas",
    });
  });

  it("asks for a precise industry and location instead of guessing", () => {
    expect(parseWorkforceChatTargetingIntent("growth_partner", "Update our targeting.")).toMatchObject({ kind: "clarification" });
    expect(parseWorkforceChatTargetingIntent("growth_partner", "Only look for dental clinics.")).toMatchObject({ kind: "clarification" });
  });

  it("does not interpret one-time research requests or other roles as settings changes", () => {
    expect(parseWorkforceChatTargetingIntent("growth_partner", "Find 10 dental clinics in Florida")).toEqual({ kind: "none" });
    expect(parseWorkforceChatTargetingIntent("sales_assistant", "Only look for dental clinics in Florida.")).toEqual({ kind: "none" });
  });
});
