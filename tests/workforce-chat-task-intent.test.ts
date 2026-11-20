import { describe, expect, it } from "vitest";
import { parseWorkforceChatTaskIntent } from "@/lib/workforce-chat-task-intent";

const now = new Date("2026-11-16T15:00:00.000Z");

describe("Growth Partner chat task intent", () => {
  it("resolves Friday in the workspace timezone and keeps task creation separate from confirmation", () => {
    const intent = parseWorkforceChatTaskIntent(
      "growth_partner",
      "Schedule a follow-up task to call Maya about the roof estimate for Friday",
      { now, timeZone: "America/Chicago" },
    );
    expect(intent).toMatchObject({ kind: "proposal", title: "call Maya about the roof estimate", dueDate: "2026-11-20", timezone: "America/Chicago" });
    if (intent.kind === "proposal") {
      expect(intent.dueAt).toBe("2026-11-20T23:00:00.000Z");
    }
  });

  it("asks for a title when the request only says to schedule a task for Friday", () => {
    const intent = parseWorkforceChatTaskIntent("growth_partner", "Schedule a follow-up task for Friday", { now, timeZone: "UTC" });
    expect(intent.kind).toBe("clarification");
    expect(intent.kind === "clarification" && intent.message).toMatch(/what the follow-up task should be/i);
  });

  it("requires a single unambiguous future date and supports an exact optional contact", () => {
    expect(parseWorkforceChatTaskIntent("growth_partner", "Create a task called Call about quote for 03/04", { now, timeZone: "UTC" })).toMatchObject({ kind: "clarification" });
    expect(parseWorkforceChatTaskIntent("growth_partner", "Create a task to review the quote for 2026-11-20 for contact Maya Chen", { now, timeZone: "UTC" })).toMatchObject({
      kind: "proposal",
      title: "review the quote",
      dueDate: "2026-11-20",
      contactName: "Maya Chen",
    });
  });

  it("recognizes explicit confirm/cancel replies and ignores other roles", () => {
    expect(parseWorkforceChatTaskIntent("growth_partner", "confirm task", { now, timeZone: "UTC" })).toEqual({ kind: "confirm" });
    expect(parseWorkforceChatTaskIntent("growth_partner", "cancel follow-up task", { now, timeZone: "UTC" })).toEqual({ kind: "cancel" });
    expect(parseWorkforceChatTaskIntent("operations_manager", "confirm task", { now, timeZone: "UTC" })).toEqual({ kind: "none" });
  });
});
