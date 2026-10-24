import { describe, expect, it } from "vitest";
import {
  nextWorkforceScheduleOccurrence,
  projectWorkforceScheduleOccurrences,
  validateWorkforceScheduleRule,
} from "@/lib/workforce-schedule-recurrence";

describe("AI workforce local schedule recurrence", () => {
  it("keeps a daily wall-clock time across the spring DST transition", () => {
    const next = nextWorkforceScheduleOccurrence(
      { kind: "daily", localTime: "09:00" },
      "America/New_York",
      new Date("2026-03-07T14:30:00.000Z"),
    );
    expect(next.toISOString()).toBe("2026-03-08T13:00:00.000Z");
  });

  it("moves a nonexistent spring-forward time to the first valid local minute", () => {
    const next = nextWorkforceScheduleOccurrence(
      { kind: "daily", localTime: "02:30" },
      "America/New_York",
      new Date("2026-03-08T06:00:00.000Z"),
    );
    expect(next.toISOString()).toBe("2026-03-08T07:00:00.000Z");
  });

  it("chooses the earlier instant when a local time occurs twice at fall-back", () => {
    const next = nextWorkforceScheduleOccurrence(
      { kind: "daily", localTime: "01:30" },
      "America/New_York",
      new Date("2026-11-01T04:00:00.000Z"),
    );
    expect(next.toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });

  it("selects only configured weekdays in the schedule timezone", () => {
    const next = nextWorkforceScheduleOccurrence(
      { kind: "weekly", localTime: "09:00", weekdays: ["mon", "tue", "wed", "thu", "fri"] },
      "America/New_York",
      new Date("2026-03-06T14:30:00.000Z"),
    );
    expect(next.toISOString()).toBe("2026-03-09T13:00:00.000Z");
  });

  it("rejects malformed rules and invalid IANA zones instead of falling back to UTC", () => {
    expect(validateWorkforceScheduleRule({ kind: "weekly", localTime: "9am", weekdays: ["mon"] })).toBeNull();
    expect(() => nextWorkforceScheduleOccurrence(
      { kind: "daily", localTime: "09:00" },
      "Not/A_Timezone",
      new Date("2026-01-01T00:00:00.000Z"),
    )).toThrow();
  });

  it("projects weekday occurrences through DST without inventing earlier calendar entries", () => {
    const projection = projectWorkforceScheduleOccurrences({
      cadence: "weekly",
      recurrenceRule: { kind: "weekly", localTime: "09:00", weekdays: ["mon"] },
      timezone: "America/New_York",
      nextRunAt: new Date("2026-03-06T14:30:00.000Z"),
      from: new Date("2026-03-06T14:30:00.000Z"),
      to: new Date("2026-03-17T00:00:00.000Z"),
    });
    expect(projection.occurrences.map((date) => date.toISOString())).toEqual([
      "2026-03-09T13:00:00.000Z",
      "2026-03-16T13:00:00.000Z",
    ]);
    expect(projection.truncated).toBe(false);
  });

  it("keeps legacy interval projections aligned to their saved anchor and reports truncation", () => {
    const projection = projectWorkforceScheduleOccurrences({
      cadence: "hourly",
      intervalMinutes: 60,
      nextRunAt: new Date("2027-03-15T08:00:00.000Z"),
      from: new Date("2027-03-15T09:30:00.000Z"),
      to: new Date("2027-03-15T13:00:00.000Z"),
      maxOccurrences: 2,
      timezone: "UTC",
    });
    expect(projection.occurrences.map((date) => date.toISOString())).toEqual([
      "2027-03-15T10:00:00.000Z",
      "2027-03-15T11:00:00.000Z",
    ]);
    expect(projection.truncated).toBe(true);
  });

  it("rejects invalid recurrence projections and overlong ranges", () => {
    expect(() => projectWorkforceScheduleOccurrences({
      cadence: "daily",
      recurrenceRule: { kind: "weekly", localTime: "09:00", weekdays: [] },
      timezone: "UTC",
      nextRunAt: new Date("2027-01-01T00:00:00.000Z"),
      from: new Date("2027-01-01T00:00:00.000Z"),
      to: new Date("2027-01-02T00:00:00.000Z"),
    })).toThrow();
    expect(() => projectWorkforceScheduleOccurrences({
      cadence: "daily",
      nextRunAt: new Date("2027-01-01T00:00:00.000Z"),
      from: new Date("2027-01-01T00:00:00.000Z"),
      to: new Date("2028-01-10T00:00:00.000Z"),
      timezone: "UTC",
    })).toThrow();
  });
});
