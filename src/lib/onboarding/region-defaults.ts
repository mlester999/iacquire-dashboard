// Pure rules that suggest a workspace's currency and phone country from the client's own time zone. A suggestion, never a fact: a Manila business may well bill in US dollars, so
// nothing here writes anything (src/server/onboarding/workspace-drafts.ts applies it only when the client confirms). Only zones that belong to exactly one country are listed; a zone
// that several countries share, one the table does not know, or UTC gives null, because guessing a currency would put the wrong symbol on a client's proposals and invoices.

/** The currencies a workspace may use (the invoice table's own check, supabase/migrations/0093_customer_invoices_payments.sql). */
export const REGION_CURRENCIES = ["USD", "PHP", "EUR", "GBP", "AUD", "CAD", "SGD", "JPY"] as const;
export type RegionCurrency = (typeof REGION_CURRENCIES)[number];

export interface RegionDefaults {
  currency: RegionCurrency;
  /** Digits only, as the workspace setting stores it (no plus sign). */
  callingCode: string;
  /** The country's name, for saying where the suggestion came from. */
  country: string;
}

const US: RegionDefaults = { currency: "USD", callingCode: "1", country: "United States" };
const CA: RegionDefaults = { currency: "CAD", callingCode: "1", country: "Canada" };
const AU: RegionDefaults = { currency: "AUD", callingCode: "61", country: "Australia" };

const ZONES: ReadonlyArray<readonly [RegionDefaults, readonly string[]]> = [
  [US, ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Phoenix", "America/Anchorage", "America/Detroit", "America/Boise", "America/Indiana/Indianapolis", "America/Kentucky/Louisville", "America/Juneau", "Pacific/Honolulu"]],
  [CA, ["America/Toronto", "America/Vancouver", "America/Edmonton", "America/Winnipeg", "America/Halifax", "America/St_Johns", "America/Regina"]],
  [AU, ["Australia/Sydney", "Australia/Melbourne", "Australia/Brisbane", "Australia/Perth", "Australia/Adelaide", "Australia/Hobart", "Australia/Darwin", "Australia/Canberra"]],
  [{ currency: "PHP", callingCode: "63", country: "Philippines" }, ["Asia/Manila"]],
  [{ currency: "SGD", callingCode: "65", country: "Singapore" }, ["Asia/Singapore"]],
  [{ currency: "JPY", callingCode: "81", country: "Japan" }, ["Asia/Tokyo"]],
  [{ currency: "GBP", callingCode: "44", country: "United Kingdom" }, ["Europe/London"]],
  [{ currency: "EUR", callingCode: "49", country: "Germany" }, ["Europe/Berlin"]],
  [{ currency: "EUR", callingCode: "33", country: "France" }, ["Europe/Paris"]],
  [{ currency: "EUR", callingCode: "34", country: "Spain" }, ["Europe/Madrid"]],
  [{ currency: "EUR", callingCode: "39", country: "Italy" }, ["Europe/Rome"]],
  [{ currency: "EUR", callingCode: "31", country: "the Netherlands" }, ["Europe/Amsterdam"]],
  [{ currency: "EUR", callingCode: "32", country: "Belgium" }, ["Europe/Brussels"]],
  [{ currency: "EUR", callingCode: "43", country: "Austria" }, ["Europe/Vienna"]],
  [{ currency: "EUR", callingCode: "353", country: "Ireland" }, ["Europe/Dublin"]],
  [{ currency: "EUR", callingCode: "351", country: "Portugal" }, ["Europe/Lisbon"]],
  [{ currency: "EUR", callingCode: "358", country: "Finland" }, ["Europe/Helsinki"]],
  [{ currency: "EUR", callingCode: "30", country: "Greece" }, ["Europe/Athens"]],
];

// A Map, not an object: a zone called "constructor" or "__proto__" must not find anything.
const BY_ZONE: ReadonlyMap<string, RegionDefaults> = new Map(ZONES.flatMap(([defaults, zones]) => zones.map((zone) => [zone, defaults] as const)));

/** The currency and calling code for an exact, unambiguous IANA time zone, or null for every other value (unknown, shared, empty, not a string). The match is exact, never partial. */
export function regionDefaultsForTimezone(timezone: unknown): RegionDefaults | null {
  if (typeof timezone !== "string") return null;
  const found = BY_ZONE.get(timezone.trim());
  return found ? { ...found } : null;
}

/** The suggestion in the client's words, for the launch checklist. */
export function describeRegionDefaults(defaults: RegionDefaults): string {
  return `${defaults.currency} and +${defaults.callingCode} (${defaults.country})`;
}
