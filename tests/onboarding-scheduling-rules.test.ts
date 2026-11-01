import { describe, expect, it } from "vitest";
import { DRAFT_CALENDAR_NAME, NOTICE_MINUTES, planSchedulingDrafts, schedulingDraftMessage, weeklyRulesFromHours } from "@/lib/onboarding/scheduling-drafts";
import { describeAction } from "@/lib/activity";
import { QUESTION_BY_ID } from "@/lib/onboarding/definitions";
import { toRoleAnswers } from "@/lib/onboarding/engine";
import type { Answers } from "@/lib/onboarding/types";

/** What a drafted type carries when the client answered none of the booking-policy questions: what a hand-made type starts with. */
const POLICY_DEFAULTS = { bufferAfterMinutes: 0, requiresConfirmation: false, allowCustomerChanges: true, changeCutoffMinutes: 0, meetingProvider: "none" } as const;

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

  it("sets a video tool only on video types, only from the client's own choice, and never a fixed link", () => {
    const a = base({ "d.appt_types": [{ name: "Video consult", minutes: "30", mode: "video" }, { name: "Phone quote", minutes: "15", mode: "phone" }], "d.appt_video": "google_meet" });
    expect(planSchedulingDrafts(a).types.map((t) => [t.name, t.meetingProvider])).toEqual([["Video consult", "google_meet"], ["Phone quote", "none"]]);
    expect(planSchedulingDrafts({ ...a, "d.appt_video": "microsoft_teams" }).types[0].meetingProvider).toBe("microsoft_teams");
    expect(planSchedulingDrafts({ ...a, "d.appt_video": "own" }).types[0].meetingProvider).toBe("none");
    expect(planSchedulingDrafts({ ...a, "d.appt_video": undefined }).types[0].meetingProvider).toBe("none");
    expect(planSchedulingDrafts({ ...a, "d.appt_video": "custom_link" }).types[0].meetingProvider).toBe("none");
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
