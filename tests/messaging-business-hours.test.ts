import { describe, expect, it } from "vitest";
import { isWithinBusinessHours, type BusinessHours } from "@/lib/messaging";

describe("Messaging business-hours enforcement", () => {
  it("treats a schedule with no open windows as always open, as the settings UI says", () => {
    const mondayMorning = new Date("2026-11-09T14:00:00.000Z");
    expect(isWithinBusinessHours({}, mondayMorning, "America/New_York")).toBe(true);
    expect(isWithinBusinessHours({ mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] }, mondayMorning, "America/New_York")).toBe(true);
  });

  it("enforces real windows and treats a closed day as closed when another day is open", () => {
    const mondayMorning = new Date("2026-11-09T14:00:00.000Z");
    const mondayEarly = new Date("2026-11-09T13:00:00.000Z");
    const tuesdayMorning = new Date("2026-11-10T14:00:00.000Z");
    const hours: BusinessHours = { mon: [["09:00", "17:00"]], tue: [] };
    expect(isWithinBusinessHours(hours, mondayMorning, "America/New_York")).toBe(true);
    expect(isWithinBusinessHours(hours, mondayEarly, "America/New_York")).toBe(false);
    expect(isWithinBusinessHours(hours, tuesdayMorning, "America/New_York")).toBe(false);
  });
});
