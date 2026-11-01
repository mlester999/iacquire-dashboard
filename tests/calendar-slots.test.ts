import { describe, expect, it } from "vitest";
import { mergeIntervals, offsetMinutes, slotStarts, subtractIntervals, workingIntervals, zonedDate, zonedParts, zonedToInstant } from "@/lib/calendars/slots";

const iso = (t: number) => new Date(t).toISOString();

describe("time zones", () => {
  it("converts wall-clock times to instants, including across daylight saving", () => {
    expect(iso(zonedToInstant("2026-10-19", 9 * 60, "Asia/Manila"))).toBe("2026-10-19T01:00:00.000Z");
    expect(offsetMinutes(Date.parse("2026-07-01T12:00:00Z"), "America/New_York")).toBe(-240);
    expect(offsetMinutes(Date.parse("2026-12-01T12:00:00Z"), "America/New_York")).toBe(-300);
    // 2026-03-08 02:30 doesn't exist in New York (clocks jump 2:00 → 3:00); it lands one hour later.
    expect(iso(zonedToInstant("2026-03-08", 150, "America/New_York"))).toBe("2026-03-08T07:30:00.000Z");
    // 2026-11-01 01:30 happens twice in New York; the earlier (daylight time) one is used.
    expect(iso(zonedToInstant("2026-11-01", 90, "America/New_York"))).toBe("2026-11-01T05:30:00.000Z");
    expect(zonedDate(Date.parse("2026-10-18T17:00:00Z"), "Asia/Manila")).toBe("2026-10-19");
  });
});

describe("working hours", () => {
  const rules = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 9 * 60, endMinute: 17 * 60 }));
  const week = { from: Date.parse("2026-10-18T16:00:00Z"), to: Date.parse("2026-10-25T16:00:00Z"), timeZone: "Asia/Manila" }; // Mon 19 → Sun 25 local

  it("expands weekly hours in the host's own time zone", () => {
    const w = workingIntervals({ ...week, rules, overrides: [] });
    expect(w).toHaveLength(5);
    expect(iso(w[0].start)).toBe("2026-10-19T01:00:00.000Z");
    expect(iso(w[0].end)).toBe("2026-10-19T09:00:00.000Z");
  });

  it("applies a closed day and a shortened day", () => {
    const w = workingIntervals({ ...week, rules, overrides: [{ date: "2026-10-20", startMinute: null, endMinute: null }, { date: "2026-10-21", startMinute: 13 * 60, endMinute: 15 * 60 }] });
    expect(w).toHaveLength(4);
    expect(w.map((i) => iso(i.start))).toContain("2026-10-21T05:00:00.000Z");
    expect(w.some((i) => iso(i.start).startsWith("2026-10-20"))).toBe(false);
  });

  it("keeps a full day open until midnight", () => {
    const w = workingIntervals({ from: Date.parse("2026-10-19T00:00:00Z"), to: Date.parse("2026-10-20T00:00:00Z"), timeZone: "UTC", rules: [{ weekday: 1, startMinute: 0, endMinute: 1440 }], overrides: [] });
    expect(w).toEqual([{ start: Date.parse("2026-10-19T00:00:00Z"), end: Date.parse("2026-10-20T00:00:00Z") }]);
  });
});

describe("slots", () => {
  const day = [{ start: Date.parse("2026-10-19T01:00:00Z"), end: Date.parse("2026-10-19T05:00:00Z") }]; // 9:00–13:00 Manila
  const base = { durationMinutes: 30, intervalMinutes: 30, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, timeZone: "Asia/Manila" };

  it("offers every interval that fits", () => {
    const s = slotStarts(day, [], base);
    expect(s).toHaveLength(8);
    expect(iso(s[0])).toBe("2026-10-19T01:00:00.000Z");
    expect(iso(s[7])).toBe("2026-10-19T04:30:00.000Z");
  });

  it("removes times that overlap a busy block, counting buffers", () => {
    const busy = [{ start: Date.parse("2026-10-19T02:00:00Z"), end: Date.parse("2026-10-19T02:30:00Z") }]; // 10:00–10:30
    expect(slotStarts(day, busy, base).map(iso)).not.toContain("2026-10-19T02:00:00.000Z");
    const buffered = slotStarts(day, busy, { ...base, bufferBeforeMinutes: 15, bufferAfterMinutes: 15 }).map(iso);
    // 9:30 would end at 10:00 but its 15-minute after-buffer runs into the 10:00 block; 10:30 has a 15-minute before-buffer overlapping it.
    expect(buffered).not.toContain("2026-10-19T01:30:00.000Z");
    expect(buffered).not.toContain("2026-10-19T02:30:00.000Z");
    expect(buffered).toContain("2026-10-19T03:00:00.000Z");
  });

  it("aligns starts to the local clock and never offers a meeting that runs past working hours", () => {
    const odd = [{ start: Date.parse("2026-10-19T01:10:00Z"), end: Date.parse("2026-10-19T02:20:00Z") }]; // 9:10–10:20
    expect(slotStarts(odd, [], { ...base, durationMinutes: 45 }).map(iso)).toEqual(["2026-10-19T01:30:00.000Z"]);
  });

  it("subtracts and merges intervals", () => {
    expect(mergeIntervals([{ start: 1, end: 3 }, { start: 2, end: 5 }, { start: 7, end: 8 }])).toEqual([{ start: 1, end: 5 }, { start: 7, end: 8 }]);
    expect(subtractIntervals([{ start: 0, end: 10 }], [{ start: 2, end: 3 }, { start: 5, end: 12 }])).toEqual([{ start: 0, end: 2 }, { start: 3, end: 5 }]);
  });
});

describe("daylight saving days in the business's own zone (America/Chicago)", () => {
  const CHICAGO = "America/Chicago";
  const SUNDAY = 0;
  const hourly = { durationMinutes: 60, intervalMinutes: 60, bufferBeforeMinutes: 0, bufferAfterMinutes: 0, timeZone: CHICAGO };
  const localHour = (t: number) => zonedParts(t, CHICAGO).hour;

  it("keeps 9-17 local as 8 real hours on the day clocks go forward (2026-03-08)", () => {
    const work = workingIntervals({ from: Date.parse("2026-03-07T00:00:00Z"), to: Date.parse("2026-03-10T00:00:00Z"), timeZone: CHICAGO, rules: [{ weekday: SUNDAY, startMinute: 9 * 60, endMinute: 17 * 60 }], overrides: [] });
    // 09:00 is already daylight time (UTC-5): 14:00Z to 22:00Z.
    expect(work.map((w) => [iso(w.start), iso(w.end)])).toEqual([["2026-03-08T14:00:00.000Z", "2026-03-08T22:00:00.000Z"]]);
    const starts = slotStarts(work, [], hourly);
    expect(starts).toHaveLength(8);
    expect(iso(starts[0])).toBe("2026-03-08T14:00:00.000Z");
    expect(iso(starts[7])).toBe("2026-03-08T21:00:00.000Z");
  });

  it("keeps 9-17 local as 8 real hours on the day clocks go back (2026-11-01)", () => {
    const work = workingIntervals({ from: Date.parse("2026-10-31T00:00:00Z"), to: Date.parse("2026-11-03T00:00:00Z"), timeZone: CHICAGO, rules: [{ weekday: SUNDAY, startMinute: 9 * 60, endMinute: 17 * 60 }], overrides: [] });
    // 09:00 is standard time (UTC-6) by then: 15:00Z to 23:00Z.
    expect(work.map((w) => [iso(w.start), iso(w.end)])).toEqual([["2026-11-01T15:00:00.000Z", "2026-11-01T23:00:00.000Z"]]);
    expect(slotStarts(work, [], hourly)).toHaveLength(8);
  });

  it("offers nothing in the hour that does not exist when a whole day is open (2026-03-08 has 23 hours)", () => {
    const work = workingIntervals({ from: Date.parse("2026-03-07T00:00:00Z"), to: Date.parse("2026-03-10T00:00:00Z"), timeZone: CHICAGO, rules: [{ weekday: SUNDAY, startMinute: 0, endMinute: 1440 }], overrides: [] });
    expect(work).toEqual([{ start: Date.parse("2026-03-08T06:00:00Z"), end: Date.parse("2026-03-09T05:00:00Z") }]);
    const starts = slotStarts(work, [], hourly);
    expect(starts).toHaveLength(23);
    // Clocks jump from 01:59 to 03:00, so no start reads as 2 o'clock, and the instants run on without a hole or a repeat.
    expect(starts.map(localHour)).not.toContain(2);
    expect(starts.map(localHour).slice(0, 4)).toEqual([0, 1, 3, 4]);
    expect(new Set(starts).size).toBe(23);
    expect(starts.every((t, i) => i === 0 || t - starts[i - 1] === 3_600_000)).toBe(true);
  });

  it("offers both 1 o'clock hours when a whole day is open on the day clocks go back (2026-11-01 has 25 hours)", () => {
    const work = workingIntervals({ from: Date.parse("2026-10-31T00:00:00Z"), to: Date.parse("2026-11-03T00:00:00Z"), timeZone: CHICAGO, rules: [{ weekday: SUNDAY, startMinute: 0, endMinute: 1440 }], overrides: [] });
    expect(work).toEqual([{ start: Date.parse("2026-11-01T05:00:00.000Z"), end: Date.parse("2026-11-02T06:00:00.000Z") }]);
    const starts = slotStarts(work, [], hourly);
    expect(starts).toHaveLength(25);
    expect(starts.map(localHour).filter((h) => h === 1)).toHaveLength(2);
    expect(new Set(starts).size).toBe(25);
  });

  it("reads a Manila host's hours in Manila, whatever the business's own zone is", () => {
    const work = workingIntervals({ from: Date.parse("2026-03-07T00:00:00Z"), to: Date.parse("2026-03-10T00:00:00Z"), timeZone: "Asia/Manila", rules: [{ weekday: SUNDAY, startMinute: 9 * 60, endMinute: 17 * 60 }], overrides: [] });
    expect(work.map((w) => [iso(w.start), iso(w.end)])).toEqual([["2026-03-08T01:00:00.000Z", "2026-03-08T09:00:00.000Z"]]);
  });
});
