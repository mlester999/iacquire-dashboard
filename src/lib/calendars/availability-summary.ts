import { isValidTimeZone, weekdayOf, zonedDate } from "@/lib/calendars/slots";

// Turns a list of bookable start times into what a person can read at a glance: how many open times each day has, and a short list that reaches across the week instead of
// filling one afternoon. Pure functions over the slots the booking service already offered; nothing here adds, moves or holds a time.

/** One calendar day of open start times, read in `timeZone`. */
export interface AvailabilityDay {
  /** YYYY-MM-DD in the zone the result is read in. */
  date: string;
  /** Sun, Mon, ... for that date. */
  weekday: string;
  count: number;
  /** ISO instants of the earliest and the latest open start time that day. */
  firstStart: string;
  lastStart: string;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** The slots that are real instants, earliest first. (A start that is not a time has no place in an order; sorting with one in the list would scramble the rest.) */
const inTimeOrder = <T extends { start: string }>(slots: readonly T[]): T[] => slots.filter((slot) => Number.isFinite(Date.parse(slot.start))).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));

/** The zone a result is read in: the one given when it is a real IANA zone, otherwise UTC. A person's zone is never guessed. */
export function readableTimeZone(timeZone: string | null | undefined): string {
  return timeZone && isValidTimeZone(timeZone) ? timeZone : "UTC";
}

/** Counts the open start times of every day in `timeZone`, in time order. A day with no open time has no entry. */
export function summarizeSlotsByDay(slots: ReadonlyArray<{ start: string }>, timeZone: string | null | undefined): AvailabilityDay[] {
  const zone = readableTimeZone(timeZone);
  const days = new Map<string, AvailabilityDay>();
  for (const slot of inTimeOrder(slots)) {
    const date = zonedDate(Date.parse(slot.start), zone);
    const day = days.get(date);
    if (day) {
      day.count += 1;
      day.lastStart = slot.start;
    } else {
      days.set(date, { date, weekday: WEEKDAYS[weekdayOf(date)], count: 1, firstStart: slot.start, lastStart: slot.start });
    }
  }
  return [...days.values()];
}

/** The earliest `perDay` open start times of every day, at most `limit` in all, in time order. */
export function sampleSlotsPerDay<T extends { start: string }>(slots: readonly T[], timeZone: string | null | undefined, perDay: number, limit: number): T[] {
  const zone = readableTimeZone(timeZone);
  const taken = new Map<string, number>();
  const out: T[] = [];
  for (const slot of inTimeOrder(slots)) {
    const date = zonedDate(Date.parse(slot.start), zone);
    const n = (taken.get(date) ?? 0) + 1;
    taken.set(date, n);
    if (n <= perDay) out.push(slot);
    if (out.length >= limit) break;
  }
  return out;
}
