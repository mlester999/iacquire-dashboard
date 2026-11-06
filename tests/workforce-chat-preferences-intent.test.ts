import { describe, expect, it } from "vitest";
import { parseWorkforceChatPreferencesIntent } from "@/lib/workforce-chat-preferences-intent";

describe("persistent AI Growth Partner preference requests", () => {
  it("parses bounded tone, reply-length and language changes together", () => {
    expect(parseWorkforceChatPreferencesIntent("growth_partner", "Set your tone to premium and reply in Spanish from now on.")).toEqual({
      kind: "update",
      preferences: { tone: "premium", language: "Spanish" },
    });
  });

  it("accepts supported reply lengths and longer language names", () => {
    expect(parseWorkforceChatPreferencesIntent("growth_partner", "Change the reply length to detailed.")).toEqual({
      kind: "update", preferences: { replyLength: "detailed" },
    });
    expect(parseWorkforceChatPreferencesIntent("growth_partner", "Always answer in Chinese (Simplified).")).toEqual({
      kind: "update", preferences: { language: "Chinese (Simplified)" },
    });
  });

  it("asks before saving unsupported or ambiguous choices", () => {
    expect(parseWorkforceChatPreferencesIntent("growth_partner", "Set your tone to bold.")).toMatchObject({ kind: "clarification" });
    expect(parseWorkforceChatPreferencesIntent("growth_partner", "Set your tone to casual, not premium.")).toMatchObject({ kind: "clarification" });
    expect(parseWorkforceChatPreferencesIntent("growth_partner", "Set your language to Klingon.")).toMatchObject({ kind: "clarification" });
  });

  it("leaves one-message style requests and other roles to the normal chat path", () => {
    expect(parseWorkforceChatPreferencesIntent("growth_partner", "Answer this one in Spanish.")).toEqual({ kind: "none" });
    expect(parseWorkforceChatPreferencesIntent("lead_hunter", "Set your tone to premium from now on.")).toEqual({ kind: "none" });
  });
});
