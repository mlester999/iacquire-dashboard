import { nextWorkforceScheduleOccurrence, type WorkforceScheduleRule } from "@/lib/workforce-schedule-recurrence";

const DAY_MS = 24 * 60 * 60 * 1000;

export type WorkforceCalendarView = "month" | "week" | "day" | "agenda";

export interface WorkforceCalendarRange {
  /** Inclusive local calendar date shown at the start of the view. */
  visibleFrom: string;
  /** Exclusive local calendar date after the last date shown in the view. */
  visibleTo: string;
  /** UTC-padded bounds for querying jobs and projecting schedules across all IANA offsets. */
  from: Date;
  to: Date;
}

export function nextWorkforceScheduleAt(input: {
  enabled: boolean;
  nextRunAt: string;
  recurrenceRule: WorkforceScheduleRule | null;
  timezone: string;
}, referenceTime: string): string | null {
  const anchor = new Date(input.nextRunAt);
  const reference = new Date(referenceTime);
  if (!Number.isFinite(anchor.getTime()) || !Number.isFinite(reference.getTime())) return null;
  if (input.enabled) return anchor.toISOString();
  if (!input.recurrenceRule) return null;
  const after = new Date(Math.max(anchor.getTime(), reference.getTime()) - 1);
  try {
    return nextWorkforceScheduleOccurrence(input.recurrenceRule, input.timezone, after).toISOString();
  } catch {
    return null;
  }
}

function dateFromKey(key: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) throw new RangeError("The calendar date is invalid.");
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (calendarDateKeyFromUtc(date) !== key) throw new RangeError("The calendar date is invalid.");
  return date;
}

function calendarDateKeyFromUtc(date: Date): string {
  return `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function calendarDateKeyAt(instant: Date, timeZone: string): string {
  if (!Number.isFinite(instant.getTime())) throw new RangeError("The calendar instant is invalid.");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "0";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function addCalendarDays(key: string, days: number): string {
  if (!Number.isInteger(days)) throw new RangeError("Calendar day increments must be whole numbers.");
  return calendarDateKeyFromUtc(new Date(dateFromKey(key).getTime() + days * DAY_MS));
}

export function shiftCalendarMonth(key: string, months: number): string {
  if (!Number.isInteger(months)) throw new RangeError("Calendar month increments must be whole numbers.");
  const current = dateFromKey(key);
  const targetMonth = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(targetMonth.getUTCFullYear(), targetMonth.getUTCMonth() + 1, 0)).getUTCDate();
  targetMonth.setUTCDate(Math.min(current.getUTCDate(), lastDay));
  return calendarDateKeyFromUtc(targetMonth);
}

export function startOfCalendarWeek(key: string): string {
  const date = dateFromKey(key);
  const mondayOffset = (date.getUTCDay() + 6) % 7;
  return addCalendarDays(key, -mondayOffset);
}

export function getWorkforceCalendarRange(key: string, view: WorkforceCalendarView): WorkforceCalendarRange {
  let visibleFrom = key;
  let dayCount = 1;

  if (view === "month") {
    const date = dateFromKey(key);
    const monthStart = calendarDateKeyFromUtc(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)));
    visibleFrom = startOfCalendarWeek(monthStart);
    dayCount = 42;
  } else if (view === "week") {
    visibleFrom = startOfCalendarWeek(key);
    dayCount = 7;
  } else if (view === "agenda") {
    dayCount = 30;
  }

  const visibleTo = addCalendarDays(visibleFrom, dayCount);
  // The stored instants are UTC while calendar dates are interpreted in the workspace's IANA
  // zone. A full day of padding on either side safely covers all UTC offsets without expanding
  // the 42-day month grid beyond the service's 62-day range limit.
  const from = new Date(dateFromKey(visibleFrom).getTime() - DAY_MS);
  const to = new Date(dateFromKey(visibleTo).getTime() + DAY_MS);
  return { visibleFrom, visibleTo, from, to };
}

export function calendarDateKeys(from: string, to: string): string[] {
  const result: string[] = [];
  for (let key = from; key < to; key = addCalendarDays(key, 1)) result.push(key);
  return result;
}

export function formatCalendarDateKey(
  key: string,
  options: Intl.DateTimeFormatOptions,
  locale?: string,
): string {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(dateFromKey(key));
}

export function calendarMonthLabel(key: string, locale?: string): string {
  const date = dateFromKey(key);
  return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 15)));
}

export function calendarTimestampLabel(instant: string, timeZone: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(instant));
}

export function calendarTimeLabel(instant: string, timeZone: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(instant));
}
