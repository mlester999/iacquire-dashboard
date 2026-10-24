import { describe, expect, it } from "vitest";
import {
  addCalendarDays,
  calendarDateKeyAt,
  calendarDateKeys,
  getWorkforceCalendarRange,
  nextWorkforceScheduleAt,
  shiftCalendarMonth,
  startOfCalendarWeek,
} from "@/lib/workforce-calendar-view";

describe("workforce calendar view dates", () => {
  it("calculates the next recurrence for paused daily and weekly schedules", () => {
    expect(nextWorkforceScheduleAt({
      enabled: false,
      nextRunAt: "2027-03-14T13:00:00.000Z",
      recurrenceRule: { kind: "daily", localTime: "09:00" },
      timezone: "America/New_York",
    }, "2027-03-15T14:00:00.000Z")).toBe("2027-03-16T13:00:00.000Z");

    expect(nextWorkforceScheduleAt({
      enabled: false,
      nextRunAt: "2027-03-14T13:00:00.000Z",
      recurrenceRule: { kind: "weekly", localTime: "09:00", weekdays: ["mon", "wed"] },
      timezone: "America/New_York",
    }, "2027-03-15T14:00:00.000Z")).toBe("2027-03-17T13:00:00.000Z");
  });

  it("does not imply a next run for a paused legacy interval without a recurrence rule", () => {
    expect(nextWorkforceScheduleAt({
      enabled: false,
      nextRunAt: "2027-03-14T13:00:00.000Z",
      recurrenceRule: null,
      timezone: "America/New_York",
    }, "2027-03-15T14:00:00.000Z")).toBeNull();
  });

  it("formats event dates in the workspace timezone across daylight-saving transitions", () => {
    expect(calendarDateKeyAt(new Date("2027-03-14T06:59:00.000Z"), "America/New_York")).toBe("2027-03-14");
    expect(calendarDateKeyAt(new Date("2027-03-14T07:01:00.000Z"), "America/New_York")).toBe("2027-03-14");
    expect(calendarDateKeyAt(new Date("2027-03-14T00:30:00.000Z"), "America/Los_Angeles")).toBe("2027-03-13");
  });

  it("builds Monday-first month grids with bounded UTC padding", () => {
    const range = getWorkforceCalendarRange("2026-10-24", "month");
    expect(range.visibleFrom).toBe("2026-09-28");
    expect(range.visibleTo).toBe("2026-11-09");
    expect(calendarDateKeys(range.visibleFrom, range.visibleTo)).toHaveLength(42);
    expect(range.from.toISOString()).toBe("2026-09-27T00:00:00.000Z");
    expect(range.to.toISOString()).toBe("2026-11-10T00:00:00.000Z");
    expect((range.to.getTime() - range.from.getTime()) / 86_400_000).toBe(44);
  });

  it("moves week, day and agenda windows by their visible calendar dates", () => {
    expect(startOfCalendarWeek("2026-10-21")).toBe("2026-10-19");
    expect(getWorkforceCalendarRange("2026-10-21", "week").visibleTo).toBe("2026-10-26");
    expect(getWorkforceCalendarRange("2026-10-21", "day").visibleTo).toBe("2026-10-22");
    expect(getWorkforceCalendarRange("2026-10-21", "agenda").visibleTo).toBe("2026-11-20");
    expect(addCalendarDays("2026-10-31", 1)).toBe("2026-11-01");
  });

  it("clamps month navigation at the last valid day", () => {
    expect(shiftCalendarMonth("2027-01-31", 1)).toBe("2027-02-28");
    expect(shiftCalendarMonth("2028-01-31", 1)).toBe("2028-02-29");
    expect(shiftCalendarMonth("2026-03-31", -1)).toBe("2026-02-28");
  });
});

