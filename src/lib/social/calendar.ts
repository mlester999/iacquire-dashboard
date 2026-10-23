import { addDays, isValidTimeZone, weekdayOf, zonedDate, zonedToInstant } from "@/lib/calendars/slots";

// The content calendar's arithmetic: which days a month or week shows, which instants bound them, and which day a post sits on, all in the CLIENT's time zone
// (a business in Manila must not see its 11pm post on the next day because the server is in UTC). Pure.

export type CalendarView = "month" | "week" | "list";
export const CALENDAR_VIEWS: readonly CalendarView[] = ["month", "week", "list"];

const DAY = /^\d{4}-\d{2}-\d{2}$/;
export function isDay(v: unknown): v is string {
  if (typeof v !== "string" || !DAY.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  // A day that does not exist (February 31) would roll over into the next month, so it is compared back.
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export const parseView = (v: unknown): CalendarView => (CALENDAR_VIEWS.includes(v as CalendarView) ? (v as CalendarView) : "month");

/** The anchor day for a view: the requested day, or today in the client's time zone. */
export function anchorDay(requested: unknown, now: Date, tz: string): string {
  return isDay(requested) ? requested : zonedDate(now.getTime(), isValidTimeZone(tz) ? tz : "UTC");
}

export interface Grid {
  /** Rows of day keys, Sunday first. */
  weeks: string[][];
  /** The first and last day shown (inclusive). */
  firstDay: string;
  lastDay: string;
  /** The instants that bound the grid in the client's time zone: [from, to). */
  from: Date;
  to: Date;
  /** The days that belong to the anchor's month (a month grid also shows the edges of its neighbours). */
  inMonth: (day: string) => boolean;
  label: string;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthOf = (day: string) => Number(day.slice(5, 7));
const startOfWeek = (day: string) => addDays(day, -weekdayOf(day));

function bound(firstDay: string, lastDay: string, tz: string) {
  return { from: new Date(zonedToInstant(firstDay, 0, tz)), to: new Date(zonedToInstant(addDays(lastDay, 1), 0, tz)) };
}

export function monthGrid(anchor: string, tz: string): Grid {
  const first = `${anchor.slice(0, 8)}01`;
  const last = addDays(`${addMonth(first, 1)}`, -1);
  const gridStart = startOfWeek(first);
  const gridEnd = addDays(startOfWeek(last), 6);
  const weeks: string[][] = [];
  for (let d = gridStart; d <= gridEnd; d = addDays(d, 7)) weeks.push(Array.from({ length: 7 }, (_, i) => addDays(d, i)));
  return { weeks, firstDay: gridStart, lastDay: gridEnd, ...bound(gridStart, gridEnd, tz), inMonth: (day) => day.slice(0, 7) === first.slice(0, 7), label: `${MONTHS[monthOf(first) - 1]} ${first.slice(0, 4)}` };
}

export function weekGrid(anchor: string, tz: string): Grid {
  const start = startOfWeek(anchor);
  const end = addDays(start, 6);
  const sameMonth = start.slice(0, 7) === end.slice(0, 7);
  const label = sameMonth ? `${MONTHS[monthOf(start) - 1]} ${Number(start.slice(8))}–${Number(end.slice(8))}, ${start.slice(0, 4)}` : `${MONTHS[monthOf(start) - 1].slice(0, 3)} ${Number(start.slice(8))} – ${MONTHS[monthOf(end) - 1].slice(0, 3)} ${Number(end.slice(8))}, ${end.slice(0, 4)}`;
  return { weeks: [Array.from({ length: 7 }, (_, i) => addDays(start, i))], firstDay: start, lastDay: end, ...bound(start, end, tz), inMonth: () => true, label };
}

/** The list view shows the anchor's month, as a plain agenda. */
export function listRange(anchor: string, tz: string): Grid {
  const g = monthGrid(anchor, tz);
  const first = `${anchor.slice(0, 8)}01`;
  const last = addDays(addMonth(first, 1), -1);
  return { ...g, firstDay: first, lastDay: last, ...bound(first, last, tz), inMonth: g.inMonth };
}

/** The first day of the month `n` months from a day's month. */
export function addMonth(day: string, n: number): string {
  const [y, m] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/** The previous and next anchor for a view's arrows. */
export function neighbours(view: CalendarView, anchor: string): { prev: string; next: string } {
  if (view === "week") return { prev: addDays(anchor, -7), next: addDays(anchor, 7) };
  return { prev: addMonth(anchor, -1), next: addMonth(anchor, 1) };
}

export interface Placed {
  scheduledAt: string | null;
  publishedAt: string | null;
  createdAt: string;
}

/** The instant a post is shown at: when it was published, else when it will be, else when it was written. */
export const placedAt = (p: Placed): string => p.publishedAt ?? p.scheduledAt ?? p.createdAt;

/** Posts grouped by the day they sit on in the client's time zone, each day's posts in time order. */
export function groupByDay<T extends Placed>(posts: readonly T[], tz: string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const p of posts) {
    const key = zonedDate(Date.parse(placedAt(p)), tz);
    out.set(key, [...(out.get(key) ?? []), p]);
  }
  for (const list of out.values()) list.sort((a, b) => Date.parse(placedAt(a)) - Date.parse(placedAt(b)));
  return out;
}

/** "3:30 PM" in the client's time zone. */
export const formatTime = (iso: string, tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(iso));

/** "Thu, Oct 23, 3:30 PM" in the client's time zone. */
export const formatWhen = (iso: string, tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));

/** "Thursday, October 23" for a day key. */
export const formatDay = (day: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" }).format(new Date(`${day}T12:00:00Z`));

/** The value for a `datetime-local` input: the instant as wall-clock time in the client's zone. */
export function toLocalInput(iso: string, tz: string): string {
  const d = new Date(iso);
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** The instant for a `datetime-local` value read as wall-clock time in the client's zone. Null when it is not a valid local time. */
export function fromLocalInput(value: string, tz: string): Date | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m || !isDay(m[1]) || !isValidTimeZone(tz)) return null;
  const minute = Number(m[2]) * 60 + Number(m[3]);
  return minute < 1440 ? new Date(zonedToInstant(m[1], minute, tz)) : null;
}
