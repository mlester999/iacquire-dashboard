import { describe, expect, it } from "vitest";
import { parseWorkforceChatMessagingHoursIntent } from "@/lib/workforce-chat-messaging-hours-intent";

describe("explicit Growth Partner Messaging hours commands", () => {
  it("parses weekday and weekend schedules with 24-hour times", () => {
    expect(parseWorkforceChatMessagingHoursIntent(
      "growth_partner",
      "Set messaging business hours to Mon-Fri 09:00-17:00; Sat-Sun closed.",
    )).toMatchObject({
      kind: "update",
      businessHours: {
        mon: [["09:00", "17:00"]],
        tue: [["09:00", "17:00"]],
        wed: [["09:00", "17:00"]],
        thu: [["09:00", "17:00"]],
        fri: [["09:00", "17:00"]],
      },
    });
  });

  it("supports split windows and always open, and clarifies a schedule with no open windows", () => {
    expect(parseWorkforceChatMessagingHoursIntent("growth_partner", "Set messaging hours to Tue 09:00-12:00; Tue 13:00-17:00")).toMatchObject({
      kind: "update", businessHours: { tue: [["09:00", "12:00"], ["13:00", "17:00"]] },
    });
    expect(parseWorkforceChatMessagingHoursIntent("growth_partner", "Set messaging hours to every day closed").kind).toBe("clarification");
    expect(parseWorkforceChatMessagingHoursIntent("growth_partner", "Set messaging hours to 24/7")).toMatchObject({
      kind: "update", businessHours: {}, summary: "24/7",
    });
  });

  it("clarifies incomplete or conflicting changes and rejects invalid times", () => {
    for (const message of [
      "Change business hours",
      "Set messaging hours to Mon-Fri 09:00-17:00; Monday closed",
      "Set messaging hours to Sat-Sun closed",
      "Set messaging hours to Monday 17:00-09:00",
      "Set messaging hours to Monday 09:00-17:00; Monday 10:00-11:00",
      "Set messaging hours to Monday 09:00-17:00 and also change follow-up hours",
    ]) expect(parseWorkforceChatMessagingHoursIntent("growth_partner", message).kind, message).toBe("clarification");
  });

  it("leaves questions and other employee roles to their normal chat path", () => {
    expect(parseWorkforceChatMessagingHoursIntent("growth_partner", "What are our business hours?").kind).toBe("none");
    expect(parseWorkforceChatMessagingHoursIntent("sales_assistant", "Set messaging business hours to Mon-Fri 09:00-17:00").kind).toBe("none");
  });
});
