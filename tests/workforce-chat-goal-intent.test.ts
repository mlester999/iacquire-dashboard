import { describe, expect, it } from "vitest";
import { parseWorkforceChatGoalIntent } from "@/lib/workforce-chat-goal-intent";

describe("Growth Partner chat goal intent", () => {
  it("recognizes one explicit bounded target and period", () => {
    expect(parseWorkforceChatGoalIntent("growth_partner", "Set a goal of 20 qualified leads per week.")).toEqual({
      kind: "set", metric: "leads_approved", cadence: "weekly", targetValue: 20,
    });
    expect(parseWorkforceChatGoalIntent("growth_partner", "Change our monthly appointment target to 5.")).toEqual({
      kind: "set", metric: "appointments_booked", cadence: "monthly", targetValue: 5,
    });
    expect(parseWorkforceChatGoalIntent("growth_partner", "Aim for 3 won deals each month.")).toEqual({
      kind: "set", metric: "deals_won", cadence: "monthly", targetValue: 3,
    });
    expect(parseWorkforceChatGoalIntent("growth_partner", "Update the new lead target to 100000 every week.")).toEqual({
      kind: "set", metric: "leads_created", cadence: "weekly", targetValue: 100_000,
    });
  });

  it("asks for clarification instead of guessing missing, conflicting, or out-of-range fields", () => {
    for (const text of [
      "Set our goal to 20 per week.",
      "Set our lead goal to 20.",
      "Set a goal of 20 qualified leads per week and 5 appointments per month.",
      "Set a goal of 100001 new leads per month.",
      "Change the weekly qualified leads target to 20 per month.",
    ]) {
      expect(parseWorkforceChatGoalIntent("growth_partner", text), text).toMatchObject({ kind: "clarification" });
    }
  });

  it("does not treat a one-time task, a question, or another role as a saved goal change", () => {
    expect(parseWorkforceChatGoalIntent("growth_partner", "Find 10 dental clinics in Florida.")).toEqual({ kind: "none" });
    expect(parseWorkforceChatGoalIntent("growth_partner", "What is our target for qualified leads this week?")).toEqual({ kind: "none" });
    expect(parseWorkforceChatGoalIntent("sales_assistant", "Set a goal of 20 qualified leads per week.")).toEqual({ kind: "none" });
  });
});
