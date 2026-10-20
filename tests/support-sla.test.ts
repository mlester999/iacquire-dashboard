import { describe, expect, it } from "vitest";
import {
  addSupportMinutes, computeSlaState, describeTarget, isWithinSupportHours, normalizeBusinessHours, normalizeHolidays, normalizeTargets, supportMinutesBetween,
  zonedToUtc, type ScheduleConfig,
} from "@/lib/support/sla";

const weekdays = { mon: [["09:00", "17:00"]], tue: [["09:00", "17:00"]], wed: [["09:00", "17:00"]], thu: [["09:00", "17:00"]], fri: [["09:00", "17:00"]] } as ScheduleConfig["hours"];
const utc: ScheduleConfig = { timezone: "UTC", hours: weekdays, holidays: [], businessHoursOnly: true };
const iso = (d: Date) => d.toISOString();

describe("response-target clock", () => {
  it("carries a Friday-evening request over the weekend to Monday morning", () => {
    // 2026-10-16 is a Friday.
    expect(iso(addSupportMinutes(new Date("2026-10-16T16:50:00Z"), 30, utc))).toBe("2026-10-19T09:20:00.000Z");
  });

  it("starts the clock at opening time for a request that arrives before hours", () => {
    expect(iso(addSupportMinutes(new Date("2026-10-19T07:00:00Z"), 60, utc))).toBe("2026-10-19T10:00:00.000Z");
  });

  it("skips holidays, whole days and weekends", () => {
    const cfg = { ...utc, holidays: ["2026-10-19"] };
    expect(iso(addSupportMinutes(new Date("2026-10-16T16:00:00Z"), 120, cfg))).toBe("2026-10-20T10:00:00.000Z");
    // Eight business hours is exactly one business day.
    expect(iso(addSupportMinutes(new Date("2026-10-19T09:00:00Z"), 480, utc))).toBe("2026-10-19T17:00:00.000Z");
    expect(iso(addSupportMinutes(new Date("2026-10-19T09:00:00Z"), 481, utc))).toBe("2026-10-20T09:01:00.000Z");
  });

  it("handles split opening windows", () => {
    const cfg = { ...utc, hours: { mon: [["09:00", "12:00"], ["13:00", "17:00"]] } as ScheduleConfig["hours"] };
    expect(iso(addSupportMinutes(new Date("2026-10-19T11:30:00Z"), 60, cfg))).toBe("2026-10-19T13:30:00.000Z");
  });

  it("is correct in a different time zone", () => {
    const ny: ScheduleConfig = { ...utc, timezone: "America/New_York" };
    // Friday 17:00 EDT is closing time; one hour later is Monday 10:00 EDT (14:00 UTC).
    expect(iso(addSupportMinutes(new Date("2026-10-16T21:00:00Z"), 60, ny))).toBe("2026-10-19T14:00:00.000Z");
    expect(isWithinSupportHours(new Date("2026-10-19T14:00:00Z"), ny)).toBe(true);
    expect(isWithinSupportHours(new Date("2026-10-19T12:00:00Z"), ny)).toBe(false);
  });

  it("stays correct across a daylight-saving change", () => {
    const ny: ScheduleConfig = { ...utc, timezone: "America/New_York" };
    // Clocks went back on Sunday 2026-11-01. Friday 16:30 EDT + 60 business minutes is Monday 09:30 EST (14:30 UTC).
    expect(iso(addSupportMinutes(zonedToUtc(2026, 10, 30, 16, 30, "America/New_York"), 60, ny))).toBe("2026-11-02T14:30:00.000Z");
    // Spring forward (2026-03-08): Friday 16:30 EST + 60 is Monday 09:30 EDT (13:30 UTC).
    expect(iso(addSupportMinutes(zonedToUtc(2026, 3, 6, 16, 30, "America/New_York"), 60, ny))).toBe("2026-03-09T13:30:00.000Z");
  });

  it("runs around the clock when business hours are not required, or when none are configured", () => {
    expect(iso(addSupportMinutes(new Date("2026-10-16T22:00:00Z"), 120, { ...utc, businessHoursOnly: false }))).toBe("2026-10-17T00:00:00.000Z");
    expect(iso(addSupportMinutes(new Date("2026-10-16T22:00:00Z"), 120, { ...utc, hours: {} }))).toBe("2026-10-17T00:00:00.000Z");
  });

  it("measures elapsed support time in both directions", () => {
    expect(supportMinutesBetween(new Date("2026-10-16T16:00:00Z"), new Date("2026-10-19T10:00:00Z"), utc)).toBe(120);
    expect(supportMinutesBetween(new Date("2026-10-19T10:00:00Z"), new Date("2026-10-16T16:00:00Z"), utc)).toBe(-120);
    expect(supportMinutesBetween(new Date("2026-10-17T10:00:00Z"), new Date("2026-10-18T10:00:00Z"), utc)).toBe(0);
  });
});

describe("response-target state", () => {
  const started = new Date("2026-10-19T09:00:00Z");
  const due = new Date("2026-10-19T13:00:00Z"); // four business hours
  const state = (status: string, now: string, dueAt: Date | null = due) => computeSlaState({ status, dueAt, startedAt: started, now: new Date(now), approachingPercent: 80, cfg: utc });

  it("moves from within target to approaching to overdue", () => {
    expect(state("open", "2026-10-19T10:00:00Z")).toBe("on_track");
    expect(state("open", "2026-10-19T12:12:00Z")).toBe("approaching");
    expect(state("new", "2026-10-19T13:00:00Z")).toBe("overdue");
  });

  it("does not run the clock while waiting on the client or after the work is finished", () => {
    expect(state("waiting_for_client", "2026-10-19T20:00:00Z")).toBe("waiting_on_client");
    expect(state("resolved", "2026-10-19T20:00:00Z")).toBe("resolved");
    expect(state("closed", "2026-10-19T20:00:00Z")).toBe("resolved");
  });

  it("reports no target rather than inventing one", () => {
    expect(state("open", "2026-10-19T20:00:00Z", null)).toBe("none");
  });
});

describe("wording and validation", () => {
  it("words a target only from what is configured", () => {
    expect(describeTarget(30, utc)).toBe("within 30 minutes");
    expect(describeTarget(240, utc)).toBe("within 4 business hours");
    expect(describeTarget(480, utc)).toBe("within 1 business day");
    expect(describeTarget(960, utc)).toBe("within 2 business days");
    expect(describeTarget(90, utc)).toBe("within 1 business hour 30 minutes");
    expect(describeTarget(1440, { hours: weekdays, businessHoursOnly: false })).toBe("within 1 day");
  });

  it("validates opening hours, holidays and targets", () => {
    expect(normalizeBusinessHours({ mon: [["09:00", "17:00"]] })).toEqual({ ok: true, hours: { mon: [["09:00", "17:00"]] } });
    expect(normalizeBusinessHours({ mon: [["13:00", "17:00"], ["09:00", "12:00"]] })).toEqual({ ok: true, hours: { mon: [["09:00", "12:00"], ["13:00", "17:00"]] } });
    expect(normalizeBusinessHours({ mon: [["09:00", "08:00"]] }).ok).toBe(false);
    expect(normalizeBusinessHours({ mon: [["09:00", "12:00"], ["11:00", "17:00"]] }).ok).toBe(false);
    expect(normalizeBusinessHours({ mon: [["9am", "5pm"]] }).ok).toBe(false);
    expect(normalizeBusinessHours({ someday: [["09:00", "17:00"]] }).ok).toBe(false);
    expect(normalizeHolidays(["2026-12-25", "2026-12-25", "2026-01-01"])).toEqual({ ok: true, holidays: ["2026-01-01", "2026-12-25"] });
    expect(normalizeHolidays(["2026-02-30"]).ok).toBe(false);
    expect(normalizeHolidays(["Christmas"]).ok).toBe(false);
    expect(normalizeTargets({ urgent: 60, normal: 480, low: null })).toEqual({ ok: true, targets: { urgent: 60, normal: 480 } });
    expect(normalizeTargets({ urgent: 0 }).ok).toBe(false);
    expect(normalizeTargets({ critical: 5 }).ok).toBe(false);
    expect(normalizeTargets({ urgent: 1.5 }).ok).toBe(false);
  });
});
