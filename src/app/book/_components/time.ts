// Date and time wording for the public booking pages. Pure, and pinned to en-US so the server and the browser render the same text
// for the same time zone (no hydration surprises from a visitor's locale).

const LOCALE = "en-US";
const cache = new Map<string, Intl.DateTimeFormat>();

function fmt(key: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(LOCALE, opts);
    cache.set(key, f);
  }
  return f;
}

function safe(tz: string): string {
  try {
    new Intl.DateTimeFormat(LOCALE, { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

/** "10:30 AM" in the zone. */
export function formatTime(iso: string, tz: string): string {
  const z = safe(tz);
  return fmt(`t:${z}`, { hour: "numeric", minute: "2-digit", timeZone: z }).format(new Date(iso));
}

/** "Tuesday, October 20, 2026" in the zone. */
export function formatDate(iso: string, tz: string): string {
  const z = safe(tz);
  return fmt(`d:${z}`, { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: z }).format(new Date(iso));
}

/** "Tue, Oct 20" in the zone. */
export function formatShortDate(iso: string, tz: string): string {
  const z = safe(tz);
  return fmt(`sd:${z}`, { weekday: "short", month: "short", day: "numeric", timeZone: z }).format(new Date(iso));
}

/** "10:00 – 11:00 AM" in the zone. */
export function formatTimeRange(startIso: string, endIso: string, tz: string): string {
  const z = safe(tz);
  const f = fmt(`t:${z}`, { hour: "numeric", minute: "2-digit", timeZone: z });
  try {
    return f.formatRange(new Date(startIso), new Date(endIso));
  } catch {
    return `${f.format(new Date(startIso))} – ${f.format(new Date(endIso))}`;
  }
}

/** A calendar date (YYYY-MM-DD) as words, with no time zone involved: "Tuesday, October 20". */
export function formatDayHeading(date: string): string {
  return fmt("dh", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
}

export function formatMonth(year: number, month0: number): string {
  return fmt("m", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, month0, 15)));
}

/** "GMT+8" for the zone at that moment. */
export function zoneOffset(tz: string, at: number = Date.now()): string {
  const z = safe(tz);
  try {
    const part = fmt(`o:${z}`, { timeZone: z, timeZoneName: "shortOffset" }).formatToParts(new Date(at)).find((p) => p.type === "timeZoneName");
    return part?.value ?? z;
  } catch {
    return z;
  }
}

/** "Manila" from "Asia/Manila"; "UTC" stays "UTC". */
export function zoneCity(tz: string): string {
  const last = tz.split("/").pop() ?? tz;
  return last.replace(/_/g, " ");
}

/** "Manila time (GMT+8)". */
export function zoneLabel(tz: string, at?: number): string {
  return tz === "UTC" ? "UTC" : `${zoneCity(tz)} time (${zoneOffset(tz, at)})`;
}

export function durationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

/** "1 day" / "3 hours" / "30 minutes": how long before the start changes close. */
export function cutoffLabel(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} ${minutes === 1440 ? "day" : "days"}`;
  if (minutes % 60 === 0) return `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`;
  return `${minutes} minutes`;
}
