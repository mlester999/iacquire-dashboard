import { describe, expect, it } from "vitest";
import { parseWorkforceChatCalendarCreateIntent } from "@/lib/workforce-chat-calendar-create-intent";

describe("Growth Partner calendar creation intent", () => {
  it("recognizes the requested consultation calendar and team descriptor", () => {
    expect(parseWorkforceChatCalendarCreateIntent("growth_partner", "Create a consultation calendar for our sales team")).toEqual({
      kind: "create", calendarName: "consultation", hostTarget: "our sales team", appointmentTypeName: "consultation", durationMinutes: 30,
    });
  });

  it("parses an explicit calendar name, named hosts, appointment type and duration", () => {
    expect(parseWorkforceChatCalendarCreateIntent("growth_partner", "Create a calendar named Chat Consultation for Alex Chen and Jamie Lee with a 45-minute appointment")).toEqual({
      kind: "create", calendarName: "Chat Consultation", hostTarget: "Alex Chen and Jamie Lee", appointmentTypeName: "Chat Consultation", durationMinutes: 45,
    });
  });

  it("uses an explicit appointment type and converts hours to minutes", () => {
    expect(parseWorkforceChatCalendarCreateIntent("growth_partner", "Set up a discovery calendar for our sales team with appointment type named Intro Call lasting 1 hour")).toEqual({
      kind: "create", calendarName: "discovery", hostTarget: "our sales team", appointmentTypeName: "Intro Call", durationMinutes: 60,
    });
  });

  it("asks for a name when the request only says calendar", () => {
    expect(parseWorkforceChatCalendarCreateIntent("growth_partner", "Create a calendar for our sales team")).toMatchObject({ kind: "clarification" });
  });

  it("does not capture calendar creation for a legacy employee", () => {
    expect(parseWorkforceChatCalendarCreateIntent("appointment_setter", "Create a consultation calendar for our sales team")).toEqual({ kind: "none" });
  });
});
