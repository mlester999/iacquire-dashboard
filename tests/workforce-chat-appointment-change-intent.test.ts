import { describe, expect, it } from "vitest";
import { parseWorkforceChatAppointmentChangeIntent } from "@/lib/workforce-chat-appointment-change-intent";

describe("Appointment Setter chat appointment change intent", () => {
  it("requires an exact CRM contact and appointment start for cancellation", () => {
    expect(parseWorkforceChatAppointmentChangeIntent(
      "appointment_setter",
      "Cancel the appointment for Jane Doe at 2026-11-02T09:00+08:00",
    )).toEqual({
      kind: "proposal",
      operation: "cancel",
      contactName: "Jane Doe",
      appointmentAt: "2026-11-02T01:00:00.000Z",
      newStartAt: null,
    });
    expect(parseWorkforceChatAppointmentChangeIntent(
      "appointment_setter",
      "Cancel Jane Doe's appointment at 2026-11-02T09:00+08:00",
    )).toMatchObject({ kind: "proposal", operation: "cancel", contactName: "Jane Doe" });
  });

  it("requires the current and replacement times for a reschedule", () => {
    expect(parseWorkforceChatAppointmentChangeIntent(
      "appointment_setter",
      "Reschedule the appointment for Jane Doe from 2026-11-02T09:00+08:00 to 2026-11-03T10:00+08:00",
    )).toEqual({
      kind: "proposal",
      operation: "reschedule",
      contactName: "Jane Doe",
      appointmentAt: "2026-11-02T01:00:00.000Z",
      newStartAt: "2026-11-03T02:00:00.000Z",
    });
    expect(parseWorkforceChatAppointmentChangeIntent(
      "appointment_setter",
      "Reschedule Jane Doe's appointment from 2026-11-02T09:00+08:00 to 2026-11-03T10:00+08:00",
    )).toMatchObject({ kind: "proposal", operation: "reschedule", contactName: "Jane Doe" });
  });

  it("requires explicit confirmation and keeps the cancellation preview separate", () => {
    expect(parseWorkforceChatAppointmentChangeIntent("appointment_setter", "confirm appointment change")).toEqual({ kind: "confirm" });
    expect(parseWorkforceChatAppointmentChangeIntent("appointment_setter", "discard appointment change preview")).toEqual({ kind: "discard" });
    expect(parseWorkforceChatAppointmentChangeIntent("appointment_setter", "cancel Jane Doe's appointment").kind).toBe("clarification");
    expect(parseWorkforceChatAppointmentChangeIntent("sales_assistant", "Cancel Jane Doe's appointment at 2026-11-02T09:00+08:00")).toEqual({ kind: "none" });
  });

  it("rejects malformed date, time and timezone values", () => {
    expect(parseWorkforceChatAppointmentChangeIntent(
      "appointment_setter",
      "Reschedule Jane Doe's appointment from 2026-02-30T09:00Z to 2026-03-01T10:00Z",
    ).kind).toBe("clarification");
    expect(parseWorkforceChatAppointmentChangeIntent(
      "appointment_setter",
      "Cancel Jane Doe's appointment at 2026-11-02T09:00+14:30",
    ).kind).toBe("clarification");
  });
});
