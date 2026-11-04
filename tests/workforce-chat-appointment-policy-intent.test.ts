import { describe, expect, it } from "vitest";
import { parseWorkforceChatAppointmentPolicyIntent } from "@/lib/workforce-chat-appointment-policy-intent";

describe("Growth Partner appointment policy intent", () => {
  it("parses duration, minimum notice and booking-window updates", () => {
    expect(parseWorkforceChatAppointmentPolicyIntent("growth_partner", "Set the duration for Discovery Call to 45 minutes")).toEqual({
      kind: "update", field: "durationMinutes", value: 45, appointmentTypeName: "Discovery Call",
    });
    expect(parseWorkforceChatAppointmentPolicyIntent("growth_partner", "Change minimum booking notice to 2 hours")).toEqual({
      kind: "update", field: "minNoticeMinutes", value: 120, appointmentTypeName: null,
    });
    expect(parseWorkforceChatAppointmentPolicyIntent("growth_partner", "Update our booking window to 30 days")).toEqual({
      kind: "update", field: "maxDaysAhead", value: 30, appointmentTypeName: null,
    });
  });

  it("asks for supported units and values, and identifies working-hours requests", () => {
    expect(parseWorkforceChatAppointmentPolicyIntent("growth_partner", "Set appointment duration to 2 days")).toMatchObject({ kind: "clarification" });
    expect(parseWorkforceChatAppointmentPolicyIntent("growth_partner", "Update appointment hours")).toMatchObject({ kind: "clarification" });
    expect(parseWorkforceChatAppointmentPolicyIntent("growth_partner", "Set the booking window to 500 days")).toMatchObject({ kind: "clarification" });
  });

  it("does not turn booking requests or legacy employee messages into settings changes", () => {
    expect(parseWorkforceChatAppointmentPolicyIntent("growth_partner", "Book a consultation tomorrow at 2 PM")).toEqual({ kind: "none" });
    expect(parseWorkforceChatAppointmentPolicyIntent("appointment_setter", "Change minimum booking notice to 2 hours")).toEqual({ kind: "none" });
  });
});
