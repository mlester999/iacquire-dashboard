// The internal Appointment Setter consultation calendar, as the founder specified it. This is a description only: nothing here creates, changes or activates anything. It exists so the
// settings are written down once, are checked by tests against the real calendar rules, and can be applied the same way by a person in iAcquire or by an approved admin step.
//
// Not decided by the founder, so not guessed here and left for confirmation before anything is applied:
//  - whether the 15-minute buffer sits before or after each consultation (this spec uses after);
//  - the calendar and appointment-type names (the names below are placeholders);
//  - whether each booking needs a person's confirmation (this spec says yes, so nothing is confirmed automatically).
// Google Meet links need Google Calendar to be connected for the host, and that needs the Google app to be registered for iAcquire first, so the type starts without a meeting link.

export const INTERNAL_CONSULTATION_CALENDAR = {
  calendar: {
    name: "Consultation",
    /** A booking page stays off until someone turns it on; nothing about this spec makes the calendar public. */
    public: false,
  },
  host: {
    /** The host is chosen by the signed-in owner when this is applied (the iAcquire owner, Mark Lester Acak). */
    timezone: "Asia/Manila",
    /** Monday to Friday, 09:00 to 17:00 (minutes from midnight). Sunday is 0. */
    weeklyHours: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 })),
  },
  appointmentType: {
    name: "Consultation call",
    durationMinutes: 30,
    slotIntervalMinutes: 30,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 15,
    minNoticeMinutes: 24 * 60,
    maxDaysAhead: 30,
    locationKind: "video" as const,
    /** Starts with no automatic meeting link. Switch to Google Meet once the host's Google account is connected. */
    meetingProvider: "none" as const,
    requiresConfirmation: true,
    public: false,
  },
  /** What must be true before the Google Meet link can be switched on. */
  googleMeetNeeds: [
    "iAcquire has the Google app registered (a client ID and secret in the server settings, added by the founder or an administrator)",
    "the host has connected their Google account in Calendar Connections",
  ],
} as const;
