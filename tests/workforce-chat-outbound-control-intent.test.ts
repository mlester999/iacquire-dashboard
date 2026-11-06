import { describe, expect, it } from "vitest";
import { parseWorkforceChatOutboundControlIntent } from "@/lib/workforce-chat-outbound-control-intent";

describe("Growth Partner outbound control intent", () => {
  it("recognizes only clear, workspace-wide pause and resume commands", () => {
    expect(parseWorkforceChatOutboundControlIntent("growth_partner", "Pause outbound campaigns.")).toEqual({ kind: "change", paused: true });
    expect(parseWorkforceChatOutboundControlIntent("growth_partner", "Please stop all outbound actions")).toEqual({ kind: "change", paused: true });
    expect(parseWorkforceChatOutboundControlIntent("growth_partner", "Can you resume outbound automation?")).toEqual({ kind: "change", paused: false });
    expect(parseWorkforceChatOutboundControlIntent("growth_partner", "Unpause all campaigns, please")).toEqual({ kind: "change", paused: false });
  });

  it("does not broaden a specific, timed or mixed request into a workspace-wide change", () => {
    for (const text of [
      "Pause the Spring email campaign",
      "Pause outbound campaigns for one week",
      "Pause outbound campaigns and send the prospect a message",
      "I want to pause outbound campaigns",
    ]) {
      expect(parseWorkforceChatOutboundControlIntent("growth_partner", text), text).toMatchObject({ kind: "clarification" });
    }
  });

  it("does not expose workspace-wide pause controls through previous employee chats", () => {
    expect(parseWorkforceChatOutboundControlIntent("operations_manager", "Pause outbound campaigns")).toEqual({ kind: "none" });
  });

  it("ignores ordinary mentions and questions without a control verb", () => {
    expect(parseWorkforceChatOutboundControlIntent("growth_partner", "How are our outbound campaigns doing?")).toEqual({ kind: "none" });
  });
});
