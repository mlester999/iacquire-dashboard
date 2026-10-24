// Days, availability and the workload calendar. Pure: every function takes the day it is asked about, so a test can fix "today" and the same answer comes back. Days are
// calendar days (YYYY-MM-DD) in the agency's time zone; an instant is turned into a day only here, with an explicit zone, never with the server's.

import { addDays, isValidTimeZone, weekdayOf, zonedDate } from "@/lib/calendars/slots";
import { isDay, isOverdue, type WorkItem } from "@/lib/staff-workload/sources";

/** Monday is 1 and Sunday is 7, the numbering the database column working_days uses. */
export function isoWeekday(day: string): number {
  const w = weekdayOf(day);
  return w === 0 ? 7 : w;
}

export const DEFAULT_WORKING_DAYS: readonly number[] = [1, 2, 3, 4, 5];

/** Today in the agency's time zone. An unknown zone name falls back to UTC rather than failing a page. */
export function todayIn(now: Date, timeZone: string): string {
  return zonedDate(now.getTime(), isValidTimeZone(timeZone) ? timeZone : "UTC");
}

/** The calendar day of a moment in a time zone. */
export function dayOf(instant: string, timeZone: string): string | null {
  const t = Date.parse(instant);
  return Number.isFinite(t) ? zonedDate(t, isValidTimeZone(timeZone) ? timeZone : "UTC") : null;
}

/** The next `count` weekdays (Monday to Friday) starting today, or on Monday when today is a weekend day. */
export function horizonDates(today: string, count: number): string[] {
  const out: string[] = [];
  let day = today;
  for (let guard = 0; out.length < count && guard < 400; guard += 1) {
    if (isoWeekday(day) <= 5) out.push(day);
    day = addDays(day, 1);
  }
  return out;
}

export interface TimeOffSpan {
  startsOn: string;
  endsOn: string;
  /** Half a day off. Only for a single day. */
  partDay: boolean;
}

/**
 * Half days a person can work on the given days: 2 for a day they work, 1 for a day with half a day off, 0 for a day they do not work or are off. Entries that overlap on one
 * day add up and stop at a full day, so two half days make a day off and a duplicated entry changes nothing.
 */
export function availableHalfDays(dates: readonly string[], workingDays: readonly number[], timeOff: readonly TimeOffSpan[]): number {
  let total = 0;
  for (const day of dates) {
    if (!workingDays.includes(isoWeekday(day))) continue;
    let off = 0;
    for (const span of timeOff) {
      if (span.startsOn <= day && day <= span.endsOn) off += span.partDay ? 1 : 2;
    }
    total += Math.max(0, 2 - off);
  }
  return total;
}

/** The earliest day an item is due, in the agency's zone, or null when it has no due date. */
export function dueDay(item: Pick<WorkItem, "dueAt" | "dueOn">, timeZone: string): string | null {
  const fromMoment = item.dueAt ? dayOf(item.dueAt, timeZone) : null;
  const fromDay = item.dueOn && isDay(item.dueOn) ? item.dueOn : null;
  if (fromMoment && fromDay) return fromMoment < fromDay ? fromMoment : fromDay;
  return fromMoment ?? fromDay;
}

export interface CalendarEntry {
  kind: "item" | "milestone";
  source: WorkItem["source"] | "milestone";
  id: string;
  orgId: string;
  assigneeId: string | null;
  title: string;
  /** For an item, whether it is already past due. For a milestone, whether it is past its day and still open. */
  overdue: boolean;
  day: string;
}

export interface CalendarMilestone {
  id: string;
  requestId: string;
  orgId: string;
  assigneeId: string | null;
  title: string;
  dueOn: string | null;
  status: string;
}

export interface WorkloadCalendar {
  from: string;
  to: string;
  /** Dated before the first day and still open. */
  overdue: CalendarEntry[];
  days: Array<{ day: string; entries: CalendarEntry[] }>;
  /** Open items nobody gave a date. Listed, never counted as on track. */
  undated: WorkItem[];
}

/**
 * Items and milestones on the days they are due, from `from` to `to` inclusive. Only things with a real date are placed; the rest are listed as having none. Milestones appear
 * here and in project health only: they carry no points.
 */
export function buildCalendar(
  items: readonly WorkItem[], milestones: readonly CalendarMilestone[], range: { from: string; to: string }, now: Date, timeZone: string,
): WorkloadCalendar {
  const today = todayIn(now, timeZone);
  const entries: CalendarEntry[] = [];
  const undated: WorkItem[] = [];
  for (const item of items) {
    const day = dueDay(item, timeZone);
    if (!day) {
      undated.push(item);
      continue;
    }
    entries.push({ kind: "item", source: item.source, id: item.itemId, orgId: item.orgId, assigneeId: item.assigneeId, title: item.title, overdue: isOverdue(item, now, today), day });
  }
  for (const m of milestones) {
    if (!m.dueOn || !isDay(m.dueOn) || m.status === "completed") continue;
    entries.push({ kind: "milestone", source: "milestone", id: m.id, orgId: m.orgId, assigneeId: m.assigneeId, title: m.title, overdue: m.dueOn < today, day: m.dueOn });
  }
  entries.sort((a, b) => (a.day === b.day ? a.title.localeCompare(b.title) || a.id.localeCompare(b.id) : a.day < b.day ? -1 : 1));
  const days: WorkloadCalendar["days"] = [];
  for (let day = range.from, guard = 0; day <= range.to && guard < 400; day = addDays(day, 1), guard += 1) {
    days.push({ day, entries: entries.filter((e) => e.day === day) });
  }
  return { from: range.from, to: range.to, overdue: entries.filter((e) => e.day < range.from), days, undated };
}
