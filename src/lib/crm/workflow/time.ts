// Time arithmetic for workflow waits and schedules, always in an explicit IANA time zone (the workspace's), so daylight-saving changes
// land on the wall-clock time people chose. Pure.
import { addDays, weekdayOf, zonedDate, zonedToInstant } from "@/lib/calendars/slots";
import { durationMinutes, type ScheduleConfig } from "@/lib/crm/workflow/spec";

const minuteOfDay = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

export function addDuration(from: Date, d: { amount: number; unit: "minutes" | "hours" | "days" }, direction: "before" | "after" = "after"): Date {
  const ms = durationMinutes(d) * 60_000;
  return new Date(from.getTime() + (direction === "after" ? ms : -ms));
}

/**
 * The first instant at or after `from` whose wall-clock time in `timeZone` is `time` (HH:MM), on one of `weekdays` (0 = Sunday) when given.
 * At most eight days ahead, which always contains an allowed weekday.
 */
export function nextTimeOfDay(from: Date, time: string, timeZone: string, weekdays?: readonly number[]): Date {
  const mod = minuteOfDay(time);
  const today = zonedDate(from.getTime(), timeZone);
  for (let i = 0; i <= 8; i++) {
    const day = addDays(today, i);
    if (weekdays?.length && !weekdays.includes(weekdayOf(day))) continue;
    const at = zonedToInstant(day, mod, timeZone);
    if (at >= from.getTime()) return new Date(at);
  }
  // Unreachable with a valid weekday list; fall back to a day later rather than never.
  return new Date(from.getTime() + 86_400_000);
}

/** The latest scheduled moment at or before `now` (looking back at most eight days), or null when there is none. */
export function latestScheduleSlot(now: Date, schedule: ScheduleConfig, timeZone: string): Date | null {
  const mod = minuteOfDay(schedule.time);
  const today = zonedDate(now.getTime(), timeZone);
  for (let i = 0; i <= 8; i++) {
    const day = addDays(today, -i);
    if (schedule.frequency === "weekly" && !(schedule.weekdays ?? []).includes(weekdayOf(day))) continue;
    const at = zonedToInstant(day, mod, timeZone);
    if (at <= now.getTime()) return new Date(at);
  }
  return null;
}

/** The next scheduled moment strictly after `now`. */
export function nextScheduleSlot(now: Date, schedule: ScheduleConfig, timeZone: string): Date {
  const next = nextTimeOfDay(new Date(now.getTime() + 60_000), schedule.time, timeZone, schedule.frequency === "weekly" ? schedule.weekdays : undefined);
  return next;
}
