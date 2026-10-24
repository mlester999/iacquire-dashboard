import { describe, expect, it } from "vitest";
import { DRAFT_CALENDAR_NAME, NOTICE_MINUTES, planSchedulingDrafts, schedulingDraftMessage, weeklyRulesFromHours } from "@/lib/onboarding/scheduling-drafts";
import type { Answers } from "@/lib/onboarding/types";

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
      { name: "Free inspection", durationMinutes: 30, locationKind: "in_person", minNoticeMinutes: 1440 },
      { name: "Phone quote", durationMinutes: 15, locationKind: "phone", minNoticeMinutes: 1440 },
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
    expect(plan.skipped.map((s) => s.name)).toEqual(["Quick look", "site visit", "x".repeat(81)]);
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
