import { describe, expect, it } from "vitest";
import { isScheduleConfirmation, parseWorkforceChatScheduleIntent } from "@/lib/workforce-chat-schedule-intent";

describe("AI workforce chat schedule intent", () => {
  it("previews a weekday Zeng review without enabling or saving it", () => {
    expect(parseWorkforceChatScheduleIntent("operations_manager", "Review unresolved operational tasks every weekday at 9 AM")).toMatchObject({
      kind: "proposal",
      capability: "proactive_review",
      cadence: "weekly",
      recurrenceRule: { kind: "weekly", localTime: "09:00", weekdays: ["mon", "tue", "wed", "thu", "fri"] },
    });
  });

  it("requires a complete, role-scoped Lead Hunter assignment before proposing research", () => {
    expect(parseWorkforceChatScheduleIntent("lead_hunter", "Research 10 dental clinics in Austin every weekday at 9 AM")).toMatchObject({
      kind: "proposal",
      capability: "lead_research",
      payload: { target: "dental clinics", location: "Austin", quantity: 10 },
    });
    expect(parseWorkforceChatScheduleIntent("lead_hunter", "Research clinics every weekday at 9 AM")).toMatchObject({
      kind: "clarification",
      message: expect.stringMatching(/how many businesses to research/),
    });
    expect(parseWorkforceChatScheduleIntent("sales_assistant", "Research 10 clinics in Austin every weekday at 9 AM")).toMatchObject({
      kind: "clarification",
    });
  });

  it("lets the one Growth Partner schedule an exact research assignment and change its real run time", () => {
    expect(parseWorkforceChatScheduleIntent("growth_partner", "Research 10 dental clinics in Austin every weekday at 9 AM")).toMatchObject({
      kind: "proposal",
      capability: "lead_research",
      payload: { target: "dental clinics", location: "Austin", quantity: 10 },
    });
    expect(parseWorkforceChatScheduleIntent("growth_partner", "Change my lead-hunting schedule to 2 PM")).toEqual({
      kind: "update_existing", capability: "lead_research", localTime: "14:00",
    });
    expect(parseWorkforceChatScheduleIntent("growth_partner", "Change my lead-hunting schedule to 2 PM every weekday")).toEqual({
      kind: "update_existing", capability: "lead_research", localTime: "14:00", cadence: "weekly", weekdays: ["mon", "tue", "wed", "thu", "fri"],
    });
  });

  it("does not invent a work window or future start date the scheduler cannot represent", () => {
    expect(parseWorkforceChatScheduleIntent("growth_partner", "Change my lead-hunting schedule from 9 AM–12 PM to 2 PM–5 PM starting tomorrow")).toMatchObject({
      kind: "clarification", message: expect.stringMatching(/continuous work window/),
    });
    expect(parseWorkforceChatScheduleIntent("growth_partner", "Change my lead-hunting schedule to 2 PM starting tomorrow")).toMatchObject({
      kind: "clarification", message: expect.stringMatching(/future date/),
    });
  });

  it("maps other roles to their own scheduleable read-only reviews", () => {
    expect(parseWorkforceChatScheduleIntent("appointment_setter", "Check calendar availability every weekday at 9 AM")).toMatchObject({
      kind: "proposal", capability: "appointment_availability", recurrenceRule: { localTime: "09:00" },
    });
    expect(parseWorkforceChatScheduleIntent("sales_assistant", "Review open opportunities daily at 10 AM")).toMatchObject({
      kind: "proposal", capability: "pipeline_review", cadence: "daily", recurrenceRule: { localTime: "10:00" },
    });
    expect(parseWorkforceChatScheduleIntent("crm_manager", "Review incomplete CRM records every Monday and Wednesday at 14:00")).toMatchObject({
      kind: "proposal", capability: "crm_quality_review", recurrenceRule: { kind: "weekly", localTime: "14:00", weekdays: ["mon", "wed"] },
    });
    expect(parseWorkforceChatScheduleIntent("performance_analyst", "Prepare our weekly performance report every Friday at 9 AM")).toMatchObject({
      kind: "proposal", capability: "performance_snapshot", cadence: "weekly", recurrenceRule: { weekdays: ["fri"], localTime: "09:00" },
    });
  });

  it("asks for missing cadence details and refuses scheduled writes", () => {
    expect(parseWorkforceChatScheduleIntent("operations_manager", "Review blocked operations every evening")).toMatchObject({
      kind: "clarification", message: expect.stringMatching(/local time/),
    });
    expect(parseWorkforceChatScheduleIntent("performance_analyst", "Prepare a weekly performance report every Friday")).toMatchObject({
      kind: "clarification", message: expect.stringMatching(/local time/),
    });
    expect(parseWorkforceChatScheduleIntent("appointment_setter", "Book appointments every Friday at 9 AM")).toMatchObject({
      kind: "clarification", message: expect.stringMatching(/read-only reviews/),
    });
    expect(parseWorkforceChatScheduleIntent("sales_assistant", "Send follow-up emails every day at 9 AM")).toMatchObject({
      kind: "clarification", message: expect.stringMatching(/read-only reviews/),
    });
  });

  it("does not read \"every\" or \"each\" as a schedule when it means \"all of them\"", () => {
    // Found on production: "List every open time on Tuesday, November 3." was answered with "What local time should I use?" instead of reaching the employee.
    for (const [role, text] of [
      ["appointment_setter", "List every open time on Tuesday, November 3."],
      ["appointment_setter", "Show me every available time next week"],
      ["operations_manager", "Check each blocked task and tell me what needs my attention"],
      ["lead_hunter", "Review every researched lead on Friday"],
      ["crm_manager", "Find each duplicate contact on Monday"],
    ] as const) {
      expect(parseWorkforceChatScheduleIntent(role, text), text).toEqual({ kind: "none" });
    }
  });

  it("still reads a period after \"every\" or \"each\" as a schedule, and asks what is missing", () => {
    expect(parseWorkforceChatScheduleIntent("appointment_setter", "Check calendar availability every Tuesday at 9 AM")).toMatchObject({ kind: "proposal", capability: "appointment_availability", cadence: "weekly" });
    expect(parseWorkforceChatScheduleIntent("appointment_setter", "Check calendar availability each morning")).toMatchObject({ kind: "clarification" });
    expect(parseWorkforceChatScheduleIntent("appointment_setter", "Check calendar availability every 2 hours")).toMatchObject({ kind: "clarification" });
    expect(parseWorkforceChatScheduleIntent("appointment_setter", "List every open time on Tuesday every week")).toMatchObject({ kind: "clarification" });
  });

  it("only treats clear confirmation phrases as schedule authorization", () => {
    expect(isScheduleConfirmation("confirm schedule")).toBe("confirm");
    expect(isScheduleConfirmation("Create this schedule!")).toBe("confirm");
    expect(isScheduleConfirmation("cancel schedule")).toBe("cancel");
    expect(isScheduleConfirmation("yes, schedule something")).toBeNull();
  });
});
