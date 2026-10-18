// How appointments read on screen: status words and tones, how they were booked, their colour, and times in a chosen zone. No I/O.

export const STATUS_LABEL: Record<string, string> = {
  new: "Unconfirmed",
  confirmed: "Confirmed",
  showed: "Showed",
  noshow: "No-show",
  cancelled: "Cancelled",
  invalid: "Invalid",
};

export const STATUS_TONE: Record<string, "primary" | "success" | "violet" | "warning" | "danger" | "neutral"> = {
  new: "primary",
  confirmed: "success",
  showed: "violet",
  noshow: "warning",
  cancelled: "danger",
  invalid: "neutral",
};

export const VIA_LABEL: Record<string, string> = {
  booking_page: "Booking page",
  website: "Website",
  staff: "Booked by your team",
  agent: "AI employee",
  api: "API",
  import: "Import",
  ghl_migration: "Moved from GoHighLevel",
};

/** Fallback colours for calendars and types without one, chosen to stay readable as a tint in light and dark themes. */
export const PALETTE = ["#4f6bed", "#0f9d76", "#d97706", "#7c3aed", "#db2777", "#0891b2", "#65a30d", "#dc2626"];

const HEX = /^#[0-9a-f]{6}$/i;
function hashed(key: string) {
  let n = 0;
  for (const ch of key) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[n % PALETTE.length];
}

/** An appointment's colour: its type's, else its calendar's, else a stable colour for the calendar. */
export function colorFor(a: { type: { id: string; color: string | null } | null; calendar: { id: string; color: string | null } | null }): string {
  if (a.type?.color && HEX.test(a.type.color)) return a.type.color;
  if (a.calendar?.color && HEX.test(a.calendar.color)) return a.calendar.color;
  return hashed(a.calendar?.id ?? a.type?.id ?? "appointment");
}

function fmt(timeZone: string, opts: Intl.DateTimeFormatOptions) {
  try {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone });
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" });
  }
}

// Node and Chromium ICU builds can return different narrow no-break spaces for the same en-US format. Use one stable form so
// server-rendered appointment times hydrate identically in every browser.
const stableDateText = (value: string) => value.replace(/[\u00a0\u2007\u2009\u202f]/g, " ");

export const timeIn = (iso: string, timeZone: string) => stableDateText(fmt(timeZone, { hour: "numeric", minute: "2-digit" }).format(new Date(iso)));

/** "10:00 – 11:00 AM" (or "11:30 AM – 12:30 PM"). */
export function timeRangeIn(startIso: string, endIso: string, timeZone: string): string {
  try {
    return stableDateText(fmt(timeZone, { hour: "numeric", minute: "2-digit" }).formatRange(new Date(startIso), new Date(endIso)));
  } catch {
    return `${timeIn(startIso, timeZone)} – ${timeIn(endIso, timeZone)}`;
  }
}

/** "Tue, Oct 20, 10:00 AM". */
export const dateTimeIn = (iso: string, timeZone: string) => stableDateText(fmt(timeZone, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso)));

/** "Tuesday, October 20, 2026". */
export const longDateIn = (iso: string, timeZone: string) => stableDateText(fmt(timeZone, { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(new Date(iso)));

/** "Asia/Manila" → "Manila". */
export const zoneCity = (timeZone: string) => (timeZone.split("/").pop() ?? timeZone).replace(/_/g, " ");

/** "GMT+8" for a zone at an instant. */
export function zoneOffset(timeZone: string, at: number): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" }).formatToParts(new Date(at)).find((p) => p.type === "timeZoneName")?.value ?? timeZone;
  } catch {
    return timeZone;
  }
}

/** A minute of the day as "9 AM" or "9:30 AM". */
export function minuteLabel(minute: number): string {
  const h = Math.floor(minute / 60) % 24;
  const m = minute % 60;
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`;
}

/** Whether an appointment can still be changed by staff (it holds time and hasn't been cancelled). */
export const isUpcomingStatus = (status: string) => status === "new" || status === "confirmed";
