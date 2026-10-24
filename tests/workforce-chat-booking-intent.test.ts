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

  it("routes exact confirmation and cancellation phrases and preserves read-only availability requests", () => {
    expect(parseWorkforceChatBookingIntent("appointment_setter", "confirm booking")).toEqual({ kind: "confirm" });
    expect(parseWorkforceChatBookingIntent("appointment_setter", "cancel booking preview")).toEqual({ kind: "cancel" });
    expect(parseWorkforceChatBookingIntent("appointment_setter", "Check our calendar and schedule an appointment for an available time")).toEqual({ kind: "none" });
    expect(parseWorkforceChatBookingIntent("appointment_setter", "Check our appointment availability and help me schedule a consultation")).toEqual({ kind: "none" });
    expect(parseWorkforceChatBookingIntent("sales_assistant", "Book an appointment with Jane Doe at 2026-11-02T09:00+08:00")).toEqual({ kind: "none" });
  });
});
