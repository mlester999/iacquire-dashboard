// A date field's starting value is the day on the person's own clock, whatever time zone the machine is in.
import { describe, expect, it } from "vitest";
import { localDayIso } from "@/lib/local-day";

describe("localDayIso", () => {
  it("is the local calendar day, including the early hours that are still yesterday in UTC east of Greenwich", () => {
    expect(localDayIso(new Date(2026, 9, 26, 1, 30))).toBe("2026-10-26");
    expect(localDayIso(new Date(2026, 9, 26, 23, 59))).toBe("2026-10-26");
  });

  it("adds days across month and year ends", () => {
    expect(localDayIso(new Date(2026, 0, 31), 1)).toBe("2026-02-01");
    expect(localDayIso(new Date(2026, 11, 31), 1)).toBe("2027-01-01");
    expect(localDayIso(new Date(2026, 9, 26), 31)).toBe("2026-11-26");
  });

  it("pads single-digit months and days", () => {
    expect(localDayIso(new Date(2026, 2, 5))).toBe("2026-03-05");
  });
});
