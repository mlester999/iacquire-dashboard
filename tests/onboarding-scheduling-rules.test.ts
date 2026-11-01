import { describe, expect, it } from "vitest";
import { DRAFT_CALENDAR_NAME, NOTICE_MINUTES, planSchedulingDrafts, schedulingDraftMessage, slotIntervalFor, validMeetingLink, weeklyRulesFromHours } from "@/lib/onboarding/scheduling-drafts";
import { validateAnswer } from "@/lib/onboarding/engine";
import { describeAction } from "@/lib/activity";
import { QUESTION_BY_ID } from "@/lib/onboarding/definitions";
import { toRoleAnswers } from "@/lib/onboarding/engine";
import type { Answers } from "@/lib/onboarding/types";

/** What a drafted type carries when the client answered none of the booking-policy questions: what a hand-made type starts with. */
const POLICY_DEFAULTS = { bufferAfterMinutes: 0, requiresConfirmation: false, allowCustomerChanges: true, changeCutoffMinutes: 0, meetingProvider: "none", meetingLink: null, slotIntervalMinutes: null } as const;

// The pure rules that turn the booking answers of the questionnaire into a plan for a DRAFT calendar. Nothing here is live: the plan only describes rows that take no bookings.

const base = (over: Answers = {}): Answers => ({
  "a.business_name": "Brightside Roofing",
  "a.timezone": "America/Chicago",
  "b.appointments": true,
  "d.appt_types": [
    { name: "Free inspection", minutes: "30", mode: "in_person" },
    { name: "Phone quote", minutes: "15", mode: "phone" },
  ],
  "d.appt_availability": { mon: [["09:00", "12:00"], ["13:00", "17:00"]], sat: [["10:00", "14:00"]] },
  "d.appt_notice": "24h",
  ...over,
});

describe("what the plan takes from the booking answers", () => {
  it("drafts one calendar with the listed types, the bookable hours, the time zone and the notice", () => {
    const plan = planSchedulingDrafts(base());
    expect(plan.reason).toBeNull();
    expect(plan.calendarName).toBe(DRAFT_CALENDAR_NAME);
    expect(plan.timezone).toBe("America/Chicago");
    expect(plan.types).toEqual([
      { name: "Free inspection", durationMinutes: 30, locationKind: "in_person", minNoticeMinutes: 1440, ...POLICY_DEFAULTS },
      { name: "Phone quote", durationMinutes: 15, locationKind: "phone", minNoticeMinutes: 1440, ...POLICY_DEFAULTS },
    ]);
    // Sunday is 0: Monday is 1 and Saturday is 6, minutes from midnight, in the order a person reads them.
    expect(plan.hoursTemplate).toEqual([
      { weekday: 1, startMinute: 540, endMinute: 720 },
      { weekday: 1, startMinute: 780, endMinute: 1020 },
      { weekday: 6, startMinute: 600, endMinute: 840 },
    ]);
    expect(plan.hoursSource).toBe("booking_hours");
  });

  it("maps every notice answer to minutes and leaves the type default when none was given", () => {
    expect(NOTICE_MINUTES).toEqual({ none: 0, "2h": 120, "24h": 1440, "48h": 2880 });
    expect(planSchedulingDrafts(base({ "d.appt_notice": "none" })).types[0].minNoticeMinutes).toBe(0);
    expect(planSchedulingDrafts(base({ "d.appt_notice": "48h" })).types[0].minNoticeMinutes).toBe(2880);
    // Not answered: the same 2 hours a hand-made type starts with (src/server/calendars/setup.ts).
    expect(planSchedulingDrafts(base({ "d.appt_notice": undefined })).types[0].minNoticeMinutes).toBe(120);
    expect(planSchedulingDrafts(base({ "d.appt_notice": "next week" })).types[0].minNoticeMinutes).toBe(120);
  });

  it("takes the booking-policy answers into every drafted type, and assumes nothing when they are missing or not recognised", () => {
    const plan = planSchedulingDrafts(base({ "d.appt_buffer": "15m", "d.appt_confirmation": "manual", "d.appt_changes": "24h" }));
    for (const t of plan.types) expect(t).toMatchObject({ bufferAfterMinutes: 15, requiresConfirmation: true, allowCustomerChanges: true, changeCutoffMinutes: 1440, meetingProvider: "none" });
    expect(planSchedulingDrafts(base({ "d.appt_changes": "none" })).types[0]).toMatchObject({ allowCustomerChanges: false, changeCutoffMinutes: 0 });
    expect(planSchedulingDrafts(base({ "d.appt_changes": "2h" })).types[0]).toMatchObject({ allowCustomerChanges: true, changeCutoffMinutes: 120 });
    expect(planSchedulingDrafts(base({ "d.appt_confirmation": "auto" })).types[0].requiresConfirmation).toBe(false);
    expect(planSchedulingDrafts(base({ "d.appt_buffer": "20m", "d.appt_confirmation": "maybe", "d.appt_changes": "constructor" })).types[0]).toMatchObject(POLICY_DEFAULTS);
  });

  it("sets a video tool only on video types, only from the client's own choice, and no link unless the client gave a valid one", () => {
    const a = base({ "d.appt_types": [{ name: "Video consult", minutes: "30", mode: "video" }, { name: "Phone quote", minutes: "15", mode: "phone" }], "d.appt_video": "google_meet" });
    expect(planSchedulingDrafts(a).types.map((t) => [t.name, t.meetingProvider])).toEqual([["Video consult", "google_meet"], ["Phone quote", "none"]]);
    expect(planSchedulingDrafts({ ...a, "d.appt_video": "microsoft_teams" }).types[0].meetingProvider).toBe("microsoft_teams");
    expect(planSchedulingDrafts({ ...a, "d.appt_video": "own" }).types[0].meetingProvider).toBe("none");
    expect(planSchedulingDrafts({ ...a, "d.appt_video": undefined }).types[0].meetingProvider).toBe("none");
    expect(planSchedulingDrafts({ ...a, "d.appt_video": "custom_link" }).types[0].meetingProvider).toBe("none");
  });

  it("makes an own-link video type a custom_link type with the client's https link, only on video types and only when they chose to send their own", () => {
    const video = [{ name: "Video consult", minutes: "30", mode: "video" }, { name: "Phone quote", minutes: "15", mode: "phone" }];
    const link = "https://meet.example.com/room/abc?pwd=1";
    const plan = planSchedulingDrafts(base({ "d.appt_types": video, "d.appt_video": "own", "d.appt_video_link": link }));
    expect(plan.types.map((t) => [t.name, t.meetingProvider, t.meetingLink])).toEqual([["Video consult", "custom_link", link], ["Phone quote", "none", null]]);
    // Without a link the type stays "none": the database refuses custom_link with no address.
    for (const given of [undefined, "", "   "]) {
      expect(planSchedulingDrafts(base({ "d.appt_types": video, "d.appt_video": "own", "d.appt_video_link": given })).types[0]).toMatchObject({ meetingProvider: "none", meetingLink: null });
    }
    // A link left over from an earlier answer does nothing once the client picked another tool, or none.
    expect(planSchedulingDrafts(base({ "d.appt_types": video, "d.appt_video": "google_meet", "d.appt_video_link": link })).types[0]).toMatchObject({ meetingProvider: "google_meet", meetingLink: null });
    expect(planSchedulingDrafts(base({ "d.appt_types": video, "d.appt_video_link": link })).types[0]).toMatchObject({ meetingProvider: "none", meetingLink: null });
  });

  it("rejects a link that is not https, in the question and again in the plan", () => {
    const question = QUESTION_BY_ID["d.appt_video_link"];
    expect(validateAnswer(question, "http://meet.example.com/room").ok).toBe(false);
    expect(validateAnswer(question, "javascript:alert(1)").ok).toBe(false);
    expect(validateAnswer(question, "https://meet.example.com/room")).toMatchObject({ ok: true });
    for (const bad of ["http://meet.example.com/x", "ftp://meet.example.com/x", "meet.example.com/x", "https://", "https://localhost/x", "https://user:pw@meet.example.com/x", "https://meet.example.com/a b", `https://meet.example.com/${"x".repeat(500)}`, 42, null]) {
      expect(validMeetingLink(bad), String(bad)).toBeNull();
    }
    expect(validMeetingLink("  https://meet.example.com/x  ")).toBe("https://meet.example.com/x");
    // A stored http value (it cannot be saved, but the plan never trusts it) never becomes a link.
    const plan = planSchedulingDrafts(base({ "d.appt_types": [{ name: "Video consult", minutes: "30", mode: "video" }], "d.appt_video": "own", "d.appt_video_link": "http://meet.example.com/x" }));
    expect(plan.types[0]).toMatchObject({ meetingProvider: "none", meetingLink: null });
  });

  it("asks for the link only when the client sends their own, and the host and busy-calendar questions only when appointments are wanted", () => {
    const own = base({ "d.appt_types": [{ name: "Video consult", minutes: "30", mode: "video" }], "d.appt_video": "own" });
    expect(QUESTION_BY_ID["d.appt_video_link"].show!(own)).toBe(true);
    expect(QUESTION_BY_ID["d.appt_video_link"].show!({ ...own, "d.appt_video": "google_meet" })).toBe(false);
    expect(QUESTION_BY_ID["d.appt_video_link"].show!({ ...own, "b.appointments": false })).toBe(false);
    for (const id of ["d.appt_host", "d.appt_busy_calendar"]) {
      expect(QUESTION_BY_ID[id].show!(base()), id).toBe(true);
      expect(QUESTION_BY_ID[id].show!(base({ "b.appointments": false })), id).toBe(false);
      expect(QUESTION_BY_ID[id].required, id).toBeFalsy();
    }
  });

  it("exposes the host and busy-calendar choices on the plan, and invents neither when the client did not choose", () => {
    expect(planSchedulingDrafts(base())).toMatchObject({ hostChoice: null, busyCalendar: null });
    expect(planSchedulingDrafts(base({ "d.appt_host": "owner", "d.appt_busy_calendar": "google" }))).toMatchObject({ hostChoice: "owner", busyCalendar: "google" });
    expect(planSchedulingDrafts(base({ "d.appt_host": "team", "d.appt_busy_calendar": "microsoft" }))).toMatchObject({ hostChoice: "team", busyCalendar: "microsoft" });
    expect(planSchedulingDrafts(base({ "d.appt_busy_calendar": "none" })).busyCalendar).toBe("none");
    expect(planSchedulingDrafts(base({ "d.appt_host": "somebody", "d.appt_busy_calendar": "icloud" }))).toMatchObject({ hostChoice: null, busyCalendar: null });
    // No appointments: nothing is chosen or exposed.
    expect(planSchedulingDrafts(base({ "b.appointments": false, "d.appt_host": "owner" }))).toMatchObject({ hostChoice: null, busyCalendar: null });
    // The client's hours stay on the plan for them to approve, whoever the host is.
    expect(planSchedulingDrafts(base({ "d.appt_host": "owner" })).hoursTemplate.length).toBeGreaterThan(0);
  });

  it("asks the booking-policy questions only when appointments are wanted, and the video question only when a video type is listed", () => {
    for (const id of ["d.appt_buffer", "d.appt_confirmation", "d.appt_changes"]) {
      expect(QUESTION_BY_ID[id].show!(base()), id).toBe(true);
      expect(QUESTION_BY_ID[id].show!(base({ "b.appointments": false })), id).toBe(false);
    }
    expect(QUESTION_BY_ID["d.appt_video"].show!(base())).toBe(false);
    expect(QUESTION_BY_ID["d.appt_video"].show!(base({ "d.appt_types": [{ name: "Video consult", minutes: "30", mode: "video" }] }))).toBe(true);
    expect(QUESTION_BY_ID["d.appt_video"].show!(base({ "b.appointments": false, "d.appt_types": [{ name: "Video consult", minutes: "30", mode: "video" }] }))).toBe(false);
  });

  it("tells the Appointment Setter the booking policy, and when it does not fit the stored limit the policy lines give way, never the client's cancellation wording", () => {
    const policy = { "d.appt_buffer": "15m", "d.appt_confirmation": "manual", "d.appt_changes": "24h" };
    const short = toRoleAnswers(base({ ...policy, "d.appt_cancellation": "Free to reschedule up to 24 hours before." })).appointment_setter.hours;
    expect(short).toContain("Gap kept after every appointment: 15 minutes.");
    expect(short).toContain("a team member confirms each booking");
    expect(short).toContain("until 24 hours before");
    expect(short.endsWith("Free to reschedule up to 24 hours before.")).toBe(true);
    // Nothing was answered: nothing is added, so existing configurations read exactly as before.
    expect(toRoleAnswers(base({ "d.appt_cancellation": "No refunds." })).appointment_setter.hours).not.toMatch(/Gap kept|Bookings:|Customers changing/);
    const cancellation = "No refunds after the visit has started. ".repeat(20).trim().slice(0, 800);
    const long = toRoleAnswers(base({ ...policy, "d.appt_cancellation": cancellation })).appointment_setter.hours;
    expect(long.length).toBeLessThanOrEqual(1000);
    expect(long.endsWith(cancellation)).toBe(true);
  });

  it("falls back to the opening hours when no bookable hours were given, and says so", () => {
    const plan = planSchedulingDrafts(base({ "d.appt_availability": {}, "a.hours": { tue: [["08:00", "16:00"]] } }));
    expect(plan.hoursTemplate).toEqual([{ weekday: 2, startMinute: 480, endMinute: 960 }]);
    expect(plan.hoursSource).toBe("business_hours");
    const none = planSchedulingDrafts(base({ "d.appt_availability": undefined }));
    expect(none.hoursTemplate).toEqual([]);
    expect(none.hoursSource).toBe("none");
  });

  it("drafts nothing when the owner said they do not book appointments, and says why", () => {
    for (const a of [base({ "b.appointments": false }), base({ "b.appointments": undefined })]) {
      const plan = planSchedulingDrafts(a);
      expect(plan.types).toEqual([]);
      expect(plan.reason).toMatch(/don't book appointments|did not say/i);
    }
  });

  it("drafts nothing when no appointment type is usable", () => {
    const plan = planSchedulingDrafts(base({ "d.appt_types": [] }));
    expect(plan.reason).toMatch(/no appointment types/i);
    const bad = planSchedulingDrafts(base({ "d.appt_types": [{ name: "Marathon", minutes: "1000", mode: "phone" }] }));
    expect(bad.types).toEqual([]);
    expect(bad.skipped).toEqual([{ name: "Marathon", why: expect.stringMatching(/5 minutes to 12 hours/) }]);
    expect(bad.reason).toMatch(/no usable appointment type/i);
  });

  it("skips what the calendar cannot hold: a length outside 5 minutes to 12 hours, a repeated name, an over-long name", () => {
    const plan = planSchedulingDrafts(base({
      "d.appt_types": [
        { name: "Quick look", minutes: "3", mode: "phone" },
        { name: "Site visit", minutes: "60", mode: "in_person" },
        { name: "site visit ", minutes: "45", mode: "phone" },
        { name: "x".repeat(81), minutes: "30", mode: "video" },
        { name: "Video tour", minutes: "720", mode: "video" },
      ],
    }));
    expect(plan.types.map((t) => t.name)).toEqual(["Site visit", "Video tour"]);
    expect(plan.types[1].locationKind).toBe("video");
    // The over-long name is shown cut to the length that fits, so a left-out name can never flood a message.
    expect(plan.skipped.map((s) => s.name)).toEqual(["Quick look", "site visit", `${"x".repeat(80)}…`]);
    expect(plan.skipped[1].why).toMatch(/already listed/i);
  });

  it("ignores a time zone that is not real and a malformed hours value", () => {
    expect(planSchedulingDrafts(base({ "a.timezone": "Mars/Olympus" })).timezone).toBeNull();
    expect(planSchedulingDrafts(base({ "d.appt_availability": "all day" as never })).hoursTemplate).toEqual([]);
  });
});

describe("the start-time step of a drafted type", () => {
  it("rounds length plus gap up to 5, never below 15, only when the length is not a multiple of 15", () => {
    expect(slotIntervalFor(50, 0)).toBe(50);
    expect(slotIntervalFor(50, 10)).toBe(60);
    expect(slotIntervalFor(50, 15)).toBe(65);
    expect(slotIntervalFor(20, 10)).toBe(30);
    expect(slotIntervalFor(25, 0)).toBe(25);
    expect(slotIntervalFor(12, 0)).toBe(15);
    expect(slotIntervalFor(7, 3)).toBe(15);
    expect(slotIntervalFor(52, 0)).toBe(55);
  });

  it("leaves a length that is a multiple of 15 on the type's own step, and a step the database would refuse", () => {
    for (const minutes of [15, 30, 45, 60, 90]) {
      for (const gap of [0, 10, 30]) expect(slotIntervalFor(minutes, gap), `${minutes}+${gap}`).toBeNull();
    }
    expect(slotIntervalFor(0, 0)).toBeNull();
    expect(slotIntervalFor(700, 30)).toBeNull();
    expect(slotIntervalFor(235, 0)).toBe(235);
    expect(slotIntervalFor(236, 10)).toBeNull();
  });

  it("is on the drafted type: a 50-minute type with a gap gets a clean step, 15, 30 and 45 minutes get none", () => {
    const plan = planSchedulingDrafts(base({
      "d.appt_types": [{ name: "Long look", minutes: "50", mode: "in_person" }, { name: "Quick", minutes: "15", mode: "phone" }, { name: "Standard", minutes: "30", mode: "phone" }, { name: "Walkthrough", minutes: "45", mode: "in_person" }],
      "d.appt_buffer": "10m",
    }));
    expect(plan.types.map((t) => [t.name, t.slotIntervalMinutes])).toEqual([["Long look", 60], ["Quick", null], ["Standard", null], ["Walkthrough", null]]);
    // No answers: nothing about 15 or 30 changes from what a hand-made type does.
    expect(planSchedulingDrafts(base()).types.map((t) => t.slotIntervalMinutes)).toEqual([null, null]);
  });
});

describe("weekly rules from opening hours", () => {
  it("keeps ranges in order, drops one that overlaps an earlier range of the same day, and caps the list", () => {
    expect(weeklyRulesFromHours({ wed: [["13:00", "17:00"], ["09:00", "14:00"]] })).toEqual([
      { weekday: 3, startMinute: 540, endMinute: 840 },
    ]);
    const week = Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, [["06:00", "07:00"], ["08:00", "09:00"], ["10:00", "11:00"], ["12:00", "13:00"]]]));
    expect(weeklyRulesFromHours(week as never).length).toBe(28);
  });
});

describe("the sentence shown after a submission", () => {
  it("says what was drafted and that it takes no bookings", () => {
    expect(schedulingDraftMessage({ state: "created", calendarId: "c", typesAdded: 2, skipped: [] })).toMatch(/drafted a booking calendar with 2 appointment types.*no bookings/i);
    expect(schedulingDraftMessage({ state: "updated", calendarId: "c", typesAdded: 1, skipped: [] })).toMatch(/added 1 appointment type to your draft/i);
  });

  it("says nothing when nothing happened or nothing applies", () => {
    expect(schedulingDraftMessage({ state: "unchanged", calendarId: "c", typesAdded: 0, skipped: [] })).toBeNull();
    expect(schedulingDraftMessage({ state: "skipped", reason: "You already have a calendar.", typesAdded: 0, skipped: [] })).toBeNull();
  });

  it("says the submitter is now the host and that no hours are set, even when no type was added", () => {
    const host = { choice: "owner", state: "assigned" } as const;
    expect(schedulingDraftMessage({ state: "created", calendarId: "c", typesAdded: 1, skipped: [], host })).toMatch(/drafted a booking calendar.*You are now the host.*No working hours are set/is);
    expect(schedulingDraftMessage({ state: "unchanged", calendarId: "c", typesAdded: 0, skipped: [], host })).toMatch(/^You are now the host.*No working hours are set for you yet/);
    // A host who was not added is not announced.
    expect(schedulingDraftMessage({ state: "unchanged", calendarId: "c", typesAdded: 0, skipped: [], host: { choice: "owner", state: "unchanged" } })).toBeNull();
    expect(schedulingDraftMessage({ state: "unchanged", calendarId: "c", typesAdded: 0, skipped: [], host: { choice: "team", state: "waiting" } })).toBeNull();
  });

  it("names the types it left out so the owner can add them by hand", () => {
    expect(schedulingDraftMessage({ state: "created", calendarId: "c", typesAdded: 1, skipped: [{ name: "Marathon", why: "x" }] })).toMatch(/left out Marathon/);
  });
});

describe("very long input stays cheap", () => {
  const timed = <T>(fn: () => T): { value: T; ms: number } => {
    const start = performance.now();
    const value = fn();
    return { value, ms: performance.now() - start };
  };

  it("a 20,000-character appointment name is left out, not scanned again and again", () => {
    // (A name that is only spaces around one letter is a short name once trimmed, so it is not one of the shapes here.)
    for (const name of ["a".repeat(20_000), "a ".repeat(10_000), `${" ".repeat(9_990)}x${" ".repeat(9_990)}x`]) {
      const { value, ms } = timed(() => planSchedulingDrafts(base({ "d.appt_types": [{ name, minutes: "30", mode: "video" }, { name: "Visit", minutes: "30", mode: "video" }] })));
      expect(value.types.map((t) => t.name)).toEqual(["Visit"]);
      expect(value.skipped).toHaveLength(1);
      expect(value.skipped[0].name.length).toBeLessThanOrEqual(81);
      expect(ms).toBeLessThan(500);
    }
  });

  it("thousands of rows and thousands of hour ranges are capped without a quadratic wait", () => {
    const rows = Array.from({ length: 20_000 }, (_, i) => ({ name: `Type ${i}`, minutes: "30", mode: "phone" }));
    const ranges = Array.from({ length: 20_000 }, (_, i) => [`${String(Math.floor(i / 60) % 24).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`, `${String(Math.floor(i / 60) % 24).padStart(2, "0")}:${String((i % 60) + 1 === 60 ? 59 : (i % 60) + 1).padStart(2, "0")}`]);
    const { value, ms } = timed(() => planSchedulingDrafts(base({ "d.appt_types": rows, "d.appt_availability": { mon: ranges, tue: ranges } })));
    expect(value.types).toHaveLength(10);
    expect(value.hoursTemplate.length).toBeLessThanOrEqual(50);
    expect(ms).toBeLessThan(1500);
  });
});

describe("the activity feed", () => {
  it("describes the drafting in plain words and says it is not live", () => {
    expect(describeAction("onboarding.scheduling_drafted")).toBe("drafted a booking calendar from the setup answers (not live)");
  });
});
