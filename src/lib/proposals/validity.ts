// How long a proposal can be accepted, in the workspace's own calendar. A date "valid until the 30th" means the whole of the 30th where the business is, not where the
// server is: UTC would let a proposal be accepted for hours after it expired for a business east of Greenwich, and close it hours early for one in the Americas.

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day written YYYY-MM-DD (2026-02-30 is not one). */
export function isDay(value: unknown): value is string {
  if (typeof value !== "string" || !DAY_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Today's date where the workspace is. An unknown time zone name falls back to UTC rather than failing a page. */
export function todayIn(timeZone: string, now: Date): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** The day n days after (or before) a day, as a calendar day. */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whole days from one day to another (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export type Validity = "none" | "valid" | "last_day" | "expired";

/** A proposal with no date never expires. On its last day it still can be accepted; the day after, it cannot. */
export function validityOn(validUntil: string | null, now: Date, timeZone: string): Validity {
  if (!validUntil) return "none";
  const today = todayIn(timeZone, now);
  if (today > validUntil) return "expired";
  return today === validUntil ? "last_day" : "valid";
}

export const isExpired = (validUntil: string | null, now: Date, timeZone: string): boolean => validityOn(validUntil, now, timeZone) === "expired";

/** "November 30, 2026" for a calendar day (a day has no time zone, so it is written from its own digits). */
export function formatDay(day: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" }).format(new Date(`${day}T12:00:00Z`));
}
