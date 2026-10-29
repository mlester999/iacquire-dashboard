import { describe, expect, it } from "vitest";
import { parseWorkforceChatBookingIntent } from "@/lib/workforce-chat-booking-intent";

describe("Appointment Setter chat booking intent", () => {
  it("prepares only an exact contact and ISO time with an explicit offset", () => {
    expect(parseWorkforceChatBookingIntent(
      "appointment_setter",
      "Book an appointment with Jane Doe at 2026-11-02T09:00+08:00",
    )).toEqual({ kind: "proposal", contactName: "Jane Doe", startAt: "2026-11-02T01:00:00.000Z" });

    expect(parseWorkforceChatBookingIntent(
      "appointment_setter",
      "Book Jane Doe for 2026-11-02T09:00+08:00",
    )).toEqual({ kind: "proposal", contactName: "Jane Doe", startAt: "2026-11-02T01:00:00.000Z" });
  });

  it("asks for exact contact and timezone details instead of guessing", () => {
    expect(parseWorkforceChatBookingIntent("appointment_setter", "Book an appointment with Jane Doe at 2026-11-02T09:00").kind).toBe("clarification");
    expect(parseWorkforceChatBookingIntent("appointment_setter", "Book an appointment for 2026-11-02T09:00+08:00").kind).toBe("clarification");
    expect(parseWorkforceChatBookingIntent("appointment_setter", "Book an appointment with Jane Doe next Tuesday at 9 AM").kind).toBe("clarification");
    expect(parseWorkforceChatBookingIntent("appointment_setter", "Book Jane Doe for 2026-02-30T09:00Z").kind).toBe("clarification");
    expect(parseWorkforceChatBookingIntent("appointment_setter", "Book Jane Doe for 2026-11-02T09:00+14:30").kind).toBe("clarification");
  });

  it("lets questions about the calendar's state reach the employee instead of the fixed booking reply", () => {
    // "set up" as a state and "schedule" as a noun are not requests to book anything.
    for (const question of [
      "What appointments do we have this week, and is the booking calendar set up?",
      "Is the booking calendar set up yet?",
      "Can you tell me if booking appointments is set up?",
      "Are we set up to take bookings?",
      "We are not set up for bookings yet, are we?",
      "Is the booking schedule set up?",
      "What's on the schedule for the call tomorrow?",
      "What does our meeting schedule look like this week?",
    ]) {
      expect(parseWorkforceChatBookingIntent("appointment_setter", question), question).toEqual({ kind: "none" });
    }
  });

  it("still recognises a genuine request to set up or schedule an appointment", () => {
    expect(parseWorkforceChatBookingIntent("appointment_setter", "Set up an appointment with Jane Doe at 2026-11-02T09:00+08:00"))
      .toEqual({ kind: "proposal", contactName: "Jane Doe", startAt: "2026-11-02T01:00:00.000Z" });
    expect(parseWorkforceChatBookingIntent("appointment_setter", "Please set up Jane Doe for 2026-11-02T09:00+08:00"))
      .toEqual({ kind: "proposal", contactName: "Jane Doe", startAt: "2026-11-02T01:00:00.000Z" });
    for (const request of [
      "Schedule a call with Jane Doe",
      "Can you schedule a meeting with Jane Doe?",
      "Could you arrange an appointment?",
      "Set up a meeting with Jane Doe next Tuesday",
    ]) {
      expect(parseWorkforceChatBookingIntent("appointment_setter", request).kind, request).toBe("clarification");
    }
  });

  it("routes exact confirmation and cancellation phrases and preserves read-only availability requests", () => {
    expect(parseWorkforceChatBookingIntent("appointment_setter", "confirm booking")).toEqual({ kind: "confirm" });
    expect(parseWorkforceChatBookingIntent("appointment_setter", "cancel booking preview")).toEqual({ kind: "cancel" });
    expect(parseWorkforceChatBookingIntent("appointment_setter", "Check our calendar and schedule an appointment for an available time")).toEqual({ kind: "none" });
    expect(parseWorkforceChatBookingIntent("appointment_setter", "Check our appointment availability and help me schedule a consultation")).toEqual({ kind: "none" });
    expect(parseWorkforceChatBookingIntent("sales_assistant", "Book an appointment with Jane Doe at 2026-11-02T09:00+08:00")).toEqual({ kind: "none" });
  });
});
