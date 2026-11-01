// The currency and phone country suggested from a time zone: exact, unambiguous zones only, everything else null. Pure rules, no database.
import { describe, expect, it } from "vitest";
import { REGION_CURRENCIES, describeRegionDefaults, regionDefaultsForTimezone } from "@/lib/onboarding/region-defaults";

describe("regionDefaultsForTimezone", () => {
  it.each([
    ["Asia/Manila", "PHP", "63"],
    ["America/Chicago", "USD", "1"],
    ["America/New_York", "USD", "1"],
    ["America/Denver", "USD", "1"],
    ["America/Los_Angeles", "USD", "1"],
    ["Pacific/Honolulu", "USD", "1"],
    ["America/Toronto", "CAD", "1"],
    ["America/Vancouver", "CAD", "1"],
    ["Europe/London", "GBP", "44"],
    ["Australia/Sydney", "AUD", "61"],
    ["Australia/Perth", "AUD", "61"],
    ["Asia/Singapore", "SGD", "65"],
    ["Asia/Tokyo", "JPY", "81"],
    ["Europe/Berlin", "EUR", "49"],
    ["Europe/Paris", "EUR", "33"],
    ["Europe/Dublin", "EUR", "353"],
  ])("%s gives %s and +%s", (zone, currency, callingCode) => {
    expect(regionDefaultsForTimezone(zone)).toMatchObject({ currency, callingCode });
  });

  it("names the country so the suggestion can say where it came from", () => {
    expect(regionDefaultsForTimezone("Asia/Manila")?.country).toBe("Philippines");
    expect(describeRegionDefaults(regionDefaultsForTimezone("Asia/Manila")!)).toBe("PHP and +63 (Philippines)");
  });

  it.each([
    "UTC",
    "Etc/UTC",
    "Asia/Kolkata", // a currency outside the workspace's set
    "Europe/Zurich", // not in the set either
    "Africa/Johannesburg",
    "Europe/Istanbul",
    "Asia/Dubai",
    "America/Mexico_City",
    "Atlantic/Canary", // part of Spain, but a zone the table does not claim
    "Not/AZone",
    "",
    "   ",
    "asia/manila", // exact match only: the canonical name has capitals
    "Asia/Manila/Extra",
    "Asia",
    "constructor", // inherited object keys must not be found
    "__proto__",
    "toString",
  ])("returns null for %j", (zone) => {
    expect(regionDefaultsForTimezone(zone)).toBeNull();
  });

  it("returns null for anything that is not a string", () => {
    for (const value of [undefined, null, 63, {}, ["Asia/Manila"], true]) expect(regionDefaultsForTimezone(value)).toBeNull();
  });

  it("ignores spaces around a real zone name", () => {
    expect(regionDefaultsForTimezone("  Asia/Manila ")).toMatchObject({ currency: "PHP", callingCode: "63" });
  });

  it("only ever suggests a currency the invoice table accepts, with a calling code of one to three digits", () => {
    for (const zone of ["Asia/Manila", "America/Chicago", "America/Toronto", "Europe/London", "Australia/Sydney", "Asia/Singapore", "Asia/Tokyo", "Europe/Berlin", "Europe/Dublin", "Europe/Athens"]) {
      const found = regionDefaultsForTimezone(zone);
      expect(found).not.toBeNull();
      expect(REGION_CURRENCIES).toContain(found?.currency);
      expect(found?.callingCode).toMatch(/^[0-9]{1,3}$/);
    }
  });

  it("hands out a copy, so a caller changing it cannot change the table", () => {
    const first = regionDefaultsForTimezone("Asia/Manila");
    if (!first) throw new Error("expected a suggestion");
    first.currency = "USD";
    first.callingCode = "999";
    expect(regionDefaultsForTimezone("Asia/Manila")).toMatchObject({ currency: "PHP", callingCode: "63" });
  });
});
