import { describe, expect, it } from "vitest";
import { readableTimeZone, sampleSlotsPerDay, summarizeSlotsByDay } from "@/lib/calendars/availability-summary";

// The open times of a week, counted and grouped the way a person reads them. These functions only describe the start times the booking service already offered.

const MANILA = "Asia/Manila";
// Manila is UTC+8 all year: 9:00 AM there is 01:00 UTC and 5:00 PM is 09:00 UTC.
const manilaDay = (date: string, hours: number[]) => hours.map((hour) => ({ start: new Date(`${date}T${String(hour).padStart(2, "0")}:00:00+08:00`).toISOString() }));

describe("summarizeSlotsByDay", () => {
  it("counts each day in the zone the person reads it in, with the first and the last start", () => {
    const slots = [...manilaDay("2026-11-02", [9, 10, 16]), ...manilaDay("2026-11-03", [9, 15])];
    const days = summarizeSlotsByDay(slots, MANILA);
    expect(days.map((day) => [day.date, day.weekday, day.count])).toEqual([["2026-11-02", "Mon", 3], ["2026-11-03", "Tue", 2]]);
    expect(days[0].firstStart).toBe(new Date("2026-11-02T09:00:00+08:00").toISOString());
    expect(days[0].lastStart).toBe(new Date("2026-11-02T16:00:00+08:00").toISOString());
  });

  it("puts a start just after Manila midnight on Manila's next day, not on the UTC day it falls in", () => {
    // 00:30 on Tuesday in Manila is 16:30 UTC on Monday: a UTC reading would count it as Monday's.
    const slots = [{ start: new Date("2026-11-03T00:30:00+08:00").toISOString() }, ...manilaDay("2026-11-02", [9])];
    expect(summarizeSlotsByDay(slots, MANILA).map((day) => [day.date, day.count])).toEqual([["2026-11-02", 1], ["2026-11-03", 1]]);
    expect(summarizeSlotsByDay(slots, "UTC").map((day) => [day.date, day.count])).toEqual([["2026-11-02", 2]]);
  });

  it("orders days by time whatever order the slots arrive in, skips a start that is not a time, and has no entry for a day without one", () => {
    const slots = [...manilaDay("2026-11-05", [9]), { start: "not a time" }, ...manilaDay("2026-11-02", [9])];
    expect(summarizeSlotsByDay(slots, MANILA).map((day) => day.date)).toEqual(["2026-11-02", "2026-11-05"]);
    expect(summarizeSlotsByDay([], MANILA)).toEqual([]);
  });

  it("reads in UTC, never a guessed zone, when the zone is missing or not a real one", () => {
    expect(readableTimeZone(undefined)).toBe("UTC");
    expect(readableTimeZone("")).toBe("UTC");
    expect(readableTimeZone("Mars/Olympus")).toBe("UTC");
    expect(readableTimeZone(MANILA)).toBe(MANILA);
    const slots = manilaDay("2026-11-02", [9]);
    expect(summarizeSlotsByDay(slots, "Mars/Olympus")).toEqual(summarizeSlotsByDay(slots, "UTC"));
  });
});

describe("sampleSlotsPerDay", () => {
  const week = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"].flatMap((date) => manilaDay(date, [9, 10, 11, 12, 13, 14, 15, 16]));

  it("takes the earliest few of every day, so the list reaches across the week", () => {
    const sample = sampleSlotsPerDay(week, MANILA, 3, 15);
    expect(sample).toHaveLength(15);
    expect(summarizeSlotsByDay(sample, MANILA).map((day) => [day.weekday, day.count])).toEqual([["Mon", 3], ["Tue", 3], ["Wed", 3], ["Thu", 3], ["Fri", 3]]);
    expect(sample[0].start).toBe(new Date("2026-11-02T09:00:00+08:00").toISOString());
  });

  it("stops at the limit and keeps time order", () => {
    const sample = sampleSlotsPerDay([...week].reverse(), MANILA, 3, 7);
    expect(sample).toHaveLength(7);
    expect(sample.map((slot) => slot.start)).toEqual([...sample.map((slot) => slot.start)].sort());
    expect(summarizeSlotsByDay(sample, MANILA).map((day) => day.count)).toEqual([3, 3, 1]);
  });

  it("returns nothing for no slots", () => {
    expect(sampleSlotsPerDay([], MANILA, 3, 15)).toEqual([]);
  });
});
