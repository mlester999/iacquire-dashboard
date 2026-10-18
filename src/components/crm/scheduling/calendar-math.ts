// Date maths for the calendar workspace, shared by the server view (which loads the window) and the client (which draws it). Dates are
// "YYYY-MM-DD" keys in the time zone the person chose to see times in; instants are converted with the DST-correct helpers in
// src/lib/calendars/slots.ts. Pure functions, no I/O.
import { addDays, isValidTimeZone, weekdayOf, zonedDate, zonedParts, zonedToInstant } from "@/lib/calendars/slots";

export const CALENDAR_VIEWS = ["month", "week", "day", "agenda"] as const;
export type CalendarViewMode = (typeof CALENDAR_VIEWS)[number];
export const CALENDAR_VIEW_LABELS: Record<CalendarViewMode, string> = { month: "Month", week: "Week", day: "Day", agenda: "Agenda" };
/** The agenda shows this many days from its date. */
export const AGENDA_DAYS = 30;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isDateKey(s: unknown): s is string {
  if (typeof s !== "string" || !DATE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return y >= 2000 && y <= 2100 && dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export const todayIn = (timeZone: string, now: number = Date.now()) => zonedDate(now, timeZone);

/** The same day of another month, clamped to that month's last day (31 January + 1 month = 28 or 29 February). */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last))).toISOString().slice(0, 10);
}

/** The days a view shows. Weeks start on Sunday; the month grid is whole weeks. */
export function viewDays(view: CalendarViewMode, date: string): string[] {
  const span = (start: string, n: number) => Array.from({ length: n }, (_, i) => addDays(start, i));
  switch (view) {
    case "day":
      return [date];
    case "week":
      return span(addDays(date, -weekdayOf(date)), 7);
    case "agenda":
      return span(date, AGENDA_DAYS);
    case "month": {
      const first = `${date.slice(0, 8)}01`;
      const last = addDays(addMonths(first, 1), -1);
      const start = addDays(first, -weekdayOf(first));
      const end = addDays(last, 6 - weekdayOf(last));
      const out: string[] = [];
      for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
      return out;
    }
  }
}

/** The instants a view covers: from the first day's local midnight to the midnight after its last day. */
export function viewRange(view: CalendarViewMode, date: string, timeZone: string): { days: string[]; from: Date; to: Date } {
  const days = viewDays(view, date);
  return { days, from: new Date(zonedToInstant(days[0], 0, timeZone)), to: new Date(zonedToInstant(addDays(days[days.length - 1], 1), 0, timeZone)) };
}

export function shiftDate(view: CalendarViewMode, date: string, direction: 1 | -1): string {
  switch (view) {
    case "month":
      return addMonths(date, direction);
    case "week":
      return addDays(date, 7 * direction);
    case "day":
      return addDays(date, direction);
    case "agenda":
      return addDays(date, AGENDA_DAYS * direction);
  }
}

const utcNoon = (date: string) => new Date(`${date}T12:00:00Z`);
/** Formats a date key (not an instant), so the result never depends on the device's time zone. */
export function formatDay(date: string, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).format(utcNoon(date));
}

/** "October 2026", "Oct 18 – 24, 2026", "Tuesday, October 20, 2026". */
export function rangeLabel(view: CalendarViewMode, date: string): string {
  if (view === "month") return formatDay(date, { month: "long", year: "numeric" });
  if (view === "day") return formatDay(date, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const days = viewDays(view, date);
  const a = days[0];
  const b = days[days.length - 1];
  const sameYear = a.slice(0, 4) === b.slice(0, 4);
  const sameMonth = sameYear && a.slice(5, 7) === b.slice(5, 7);
  const left = formatDay(a, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
  // Intl has no "24, 2026" pattern (day and year alone), so the same-month case is assembled by hand.
  const right = sameMonth ? `${formatDay(b, { day: "numeric" })}, ${b.slice(0, 4)}` : formatDay(b, { month: "short", day: "numeric", year: "numeric" });
  return `${left} – ${right}`;
}

/** Minutes after local midnight of `day` (0–1440) for an instant, by the wall clock, so hour lines match the times printed on chips. */
export function minuteInDay(at: number, day: string, timeZone: string): number {
  const d = zonedDate(at, timeZone);
  if (d < day) return 0;
  if (d > day) return 1440;
  const p = zonedParts(at, timeZone);
  return p.hour * 60 + p.minute;
}

export interface DaySegment<T> {
  item: T;
  /** Minutes after midnight, clipped to the day. */
  top: number;
  bottom: number;
  /** Side-by-side placement for overlapping appointments. */
  col: number;
  cols: number;
  startsBefore: boolean;
  endsAfter: boolean;
}

/**
 * The part of each appointment that falls on one day, laid out so overlapping ones sit side by side: each cluster of overlapping
 * appointments shares its width equally, and an appointment takes the first column that is free when it starts.
 */
export function layoutDay<T extends { startAt: string; endAt: string }>(items: T[], day: string, timeZone: string): Array<DaySegment<T>> {
  const dayStart = zonedToInstant(day, 0, timeZone);
  const dayEnd = zonedToInstant(addDays(day, 1), 0, timeZone);
  const segs = items
    .map((item) => ({ item, s: new Date(item.startAt).getTime(), e: new Date(item.endAt).getTime() }))
    .filter((x) => x.s < dayEnd && x.e > dayStart)
    .map((x) => {
      const top = x.s <= dayStart ? 0 : minuteInDay(x.s, day, timeZone);
      let bottom = x.e >= dayEnd ? 1440 : minuteInDay(x.e, day, timeZone);
      if (bottom <= top) bottom = Math.min(1440, top + 15);
      return { item: x.item, top, bottom, col: 0, cols: 1, startsBefore: x.s < dayStart, endsAfter: x.e > dayEnd };
    })
    .sort((a, b) => a.top - b.top || b.bottom - a.bottom);
  let cluster: typeof segs = [];
  let clusterEnd = -1;
  const close = () => {
    const cols = Math.max(1, ...cluster.map((c) => c.col + 1));
    for (const c of cluster) c.cols = cols;
    cluster = [];
  };
  for (const seg of segs) {
    if (seg.top >= clusterEnd && cluster.length) close();
    const taken = new Set(cluster.filter((c) => c.bottom > seg.top).map((c) => c.col));
    let col = 0;
    while (taken.has(col)) col++;
    seg.col = col;
    cluster.push(seg);
    clusterEnd = Math.max(clusterEnd, seg.bottom);
  }
  if (cluster.length) close();
  return segs;
}

export const snapMinutes = (minutes: number, step = 15) => Math.max(0, Math.min(1440 - step, Math.round(minutes / step) * step));

export interface CalendarState {
  view: CalendarViewMode;
  date: string;
  /** The zone times are shown in: the workspace's, or the one the person picked. */
  timeZone: string;
  calendarId: string | null;
  hostId: string | null;
  showCancelled: boolean;
  appointmentId: string | null;
}

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Reads the calendar's URL state, falling back to safe defaults for anything missing or malformed. */
export function parseCalendarState(sp: SP, workspaceTimeZone: string, now: number = Date.now()): CalendarState {
  const view = one(sp.view);
  const tz = one(sp.tz);
  const timeZone = tz && tz.length <= 64 && isValidTimeZone(tz) ? tz : workspaceTimeZone;
  const date = one(sp.date);
  const id = (k: string) => {
    const v = one(sp[k]);
    return v && UUID.test(v) ? v : null;
  };
  return {
    view: CALENDAR_VIEWS.includes(view as CalendarViewMode) ? (view as CalendarViewMode) : "week",
    date: isDateKey(date) ? date : todayIn(timeZone, now),
    timeZone,
    calendarId: id("calendar"),
    hostId: id("host"),
    showCancelled: one(sp.cancelled) === "1",
    appointmentId: id("appointment"),
  };
}

/**
 * The query string for a calendar state; defaults are left out so links stay short. A link with an appointment open always names its
 * day: without one, the server treats it as a notification link and jumps to the appointment's day (and shows cancelled ones when it
 * is cancelled), which a refresh after moving or cancelling that appointment in the drawer must not do.
 */
export function calendarQuery(s: CalendarState, workspaceTimeZone: string, today: string): string {
  const p = new URLSearchParams();
  if (s.view !== "week") p.set("view", s.view);
  if (s.date !== today || s.appointmentId) p.set("date", s.date);
  if (s.timeZone !== workspaceTimeZone) p.set("tz", s.timeZone);
  if (s.calendarId) p.set("calendar", s.calendarId);
  if (s.hostId) p.set("host", s.hostId);
  if (s.showCancelled) p.set("cancelled", "1");
  if (s.appointmentId) p.set("appointment", s.appointmentId);
  const q = p.toString();
  return q ? `?${q}` : "";
}

/** Which appointment a drawer shows, and the server state object (one per page load) it was last checked against. */
export interface DrawerLink {
  seen: object;
  openId: string | null;
}

/**
 * The drawer after the page's data changes. Each navigation brings a new state object from the server, and that, not a changed id, is
 * the signal: following a link to an appointment (a notification, say) opens it, even the same link again after its drawer was closed.
 * A load that names no appointment (a refresh after the drawer closed or after an action in it) leaves the drawer as it is.
 */
export function followDrawerLink(cur: DrawerLink, state: { appointmentId: string | null }): DrawerLink {
  if (state === cur.seen) return cur;
  return { seen: state, openId: state.appointmentId ?? cur.openId };
}

export const LIST_WHEN = ["upcoming", "past", "range"] as const;
export type ListWhen = (typeof LIST_WHEN)[number];
export const LIST_STATUS_FILTERS = ["all", "new", "confirmed", "showed", "noshow", "cancelled"] as const;
export type ListStatusFilter = (typeof LIST_STATUS_FILTERS)[number];

export interface AppointmentListState {
  when: ListWhen;
  from: string | null;
  to: string | null;
  status: ListStatusFilter;
  calendarId: string | null;
  hostId: string | null;
  q: string;
  page: number;
  appointmentId: string | null;
}

/** Reads the appointments list's URL state. A range needs both dates in order; otherwise it falls back to upcoming. */
export function parseListState(sp: SP): AppointmentListState {
  const id = (k: string) => {
    const v = one(sp[k]);
    return v && UUID.test(v) ? v : null;
  };
  const from = one(sp.from);
  const to = one(sp.to);
  const whenRaw = one(sp.when);
  let when: ListWhen = LIST_WHEN.includes(whenRaw as ListWhen) ? (whenRaw as ListWhen) : "upcoming";
  const okRange = isDateKey(from) && isDateKey(to) && from <= to;
  if (when === "range" && !okRange) when = "upcoming";
  const status = one(sp.status);
  const page = Number(one(sp.page));
  return {
    when,
    from: when === "range" ? (from as string) : null,
    to: when === "range" ? (to as string) : null,
    status: LIST_STATUS_FILTERS.includes(status as ListStatusFilter) ? (status as ListStatusFilter) : "all",
    calendarId: id("calendar"),
    hostId: id("host"),
    q: (one(sp.q) ?? "").slice(0, 80).trim(),
    page: Number.isInteger(page) && page > 0 && page <= 10_000 ? page : 1,
    appointmentId: id("appointment"),
  };
}

export function listQuery(s: AppointmentListState, changes: Partial<AppointmentListState> = {}): string {
  const n = { ...s, ...changes };
  const p = new URLSearchParams();
  if (n.when !== "upcoming") p.set("when", n.when);
  if (n.when === "range" && n.from) p.set("from", n.from);
  if (n.when === "range" && n.to) p.set("to", n.to);
  if (n.status !== "all") p.set("status", n.status);
  if (n.calendarId) p.set("calendar", n.calendarId);
  if (n.hostId) p.set("host", n.hostId);
  if (n.q) p.set("q", n.q);
  if (n.page > 1) p.set("page", String(n.page));
  if (n.appointmentId) p.set("appointment", n.appointmentId);
  const q = p.toString();
  return q ? `?${q}` : "";
}
