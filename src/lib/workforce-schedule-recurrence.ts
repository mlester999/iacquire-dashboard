import { WEEKDAYS, type Weekday } from "@/lib/messaging";

const LOCAL_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

export type WorkforceScheduleRule =
  | { kind: "daily"; localTime: string }
  | { kind: "weekly"; localTime: string; weekdays: Weekday[] };

type LocalDateTime = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function formatter(timeZone: string): Intl.DateTimeFormat {
  const existing = FORMATTERS.get(timeZone);
  if (existing) return existing;
  const created = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  FORMATTERS.set(timeZone, created);
  return created;
}

function partsAt(instant: Date, timeZone: string): LocalDateTime & { weekday: Weekday } {
  const fmt = formatter(timeZone);
  const parts = fmt.formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "0";
  const weekday = get("weekday").slice(0, 3).toLowerCase() as Weekday;
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: WEEKDAYS.includes(weekday) ? weekday : "sun",
  };
}

export function validateWorkforceScheduleRule(value: unknown): WorkforceScheduleRule | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (typeof input.localTime !== "string" || !LOCAL_TIME.test(input.localTime)) return null;
  if (input.kind === "daily") return { kind: "daily", localTime: input.localTime };
  if (input.kind !== "weekly" || !Array.isArray(input.weekdays) || input.weekdays.length < 1 || input.weekdays.length > 7) return null;
  const weekdays = input.weekdays;
  if (weekdays.some((day) => typeof day !== "string" || !(WEEKDAYS as readonly string[]).includes(day))) return null;
  if (new Set(weekdays).size !== weekdays.length) return null;
  return {
    kind: "weekly",
    localTime: input.localTime,
    weekdays: WEEKDAYS.filter((day) => weekdays.includes(day)),
  };
}

function localDateKey(parts: Pick<LocalDateTime, "year" | "month" | "day">): string {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function localDateAt(instant: Date, timeZone: string): string {
  return localDateKey(partsAt(instant, timeZone));
}

function offsetMinutesAt(instantMs: number, timeZone: string): number {
  const minuteMs = Math.floor(instantMs / 60_000) * 60_000;
  const parts = partsAt(new Date(minuteMs), timeZone);
  const wallAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((wallAsUtc - minuteMs) / 60_000);
}

function matchesLocal(instantMs: number, target: LocalDateTime, timeZone: string): boolean {
  const actual = partsAt(new Date(instantMs), timeZone);
  return actual.year === target.year && actual.month === target.month && actual.day === target.day
    && actual.hour === target.hour && actual.minute === target.minute && actual.second === 0;
}

/**
 * Convert a wall-clock minute to UTC using IANA time-zone rules. During a fall-back overlap,
 * choose the earlier instant. During a spring-forward gap, move to the first valid local minute.
 */
function localWallTimeToInstant(target: LocalDateTime, timeZone: string): Date {
  const naiveUtc = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute);
  const offsets = new Set<number>();
  for (const hours of [-36, -24, -12, -6, 0, 6, 12, 24, 36]) {
    offsets.add(offsetMinutesAt(naiveUtc + hours * 60 * 60 * 1000, timeZone));
  }

  const candidatesFor = (wall: LocalDateTime) => {
    const wallUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
    return [...offsets]
      .map((offset) => wallUtc - offset * 60_000)
      .filter((candidate) => matchesLocal(candidate, wall, timeZone))
      .sort((a, b) => a - b);
  };

  const exact = candidatesFor(target);
  if (exact.length) return new Date(exact[0]);

  // A local time inside a DST gap does not exist. Move forward by the smallest number of
  // wall-clock minutes that resolves to a real instant (normally 30 or 60 minutes).
  for (let offset = 1; offset <= 180; offset += 1) {
    const shifted = new Date(naiveUtc + offset * 60_000);
    const wall: LocalDateTime = {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: shifted.getUTCHours(),
      minute: shifted.getUTCMinutes(),
      second: 0,
    };
    const candidates = candidatesFor(wall);
    if (candidates.length) return new Date(candidates[0]);
  }
  throw new RangeError("Could not resolve the scheduled local time in this timezone.");
}

function dateFromKeyAndTime(dateKey: string, time: string): LocalDateTime {
  const [year, month, day] = dateKey.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  return { year, month, day, hour, minute, second: 0 };
}

/** Return the first recurrence strictly after `after`, using the requested IANA timezone. */
export function nextWorkforceScheduleOccurrence(
  ruleInput: unknown,
  timeZone: string,
  after: Date,
): Date {
  const rule = validateWorkforceScheduleRule(ruleInput);
  if (!rule) throw new TypeError("The workforce schedule recurrence is invalid.");
  if (!Number.isFinite(after.getTime())) throw new TypeError("The recurrence reference time is invalid.");
  // Constructing the formatter validates the IANA zone; never silently fall back to UTC.
  formatter(timeZone).format(after);

  const start = localDateAt(after, timeZone);
  const [startYear, startMonth, startDay] = start.split("-").map(Number);
  const dayCursor = new Date(Date.UTC(startYear, startMonth - 1, startDay));
  for (let dayOffset = 0; dayOffset <= 370; dayOffset += 1) {
    const localDate = new Date(dayCursor.getTime() + dayOffset * DAY_MS);
    const key = `${String(localDate.getUTCFullYear()).padStart(4, "0")}-${String(localDate.getUTCMonth() + 1).padStart(2, "0")}-${String(localDate.getUTCDate()).padStart(2, "0")}`;
    const weekday = WEEKDAYS[localDate.getUTCDay()];
    if (rule.kind === "weekly" && !rule.weekdays.includes(weekday)) continue;
    let occurrence: Date;
    try {
      occurrence = localWallTimeToInstant(dateFromKeyAndTime(key, rule.localTime), timeZone);
    } catch {
      // A few time zones have skipped a complete local date after a date-line change. Skip that
      // impossible date and continue to the next matching recurrence.
      continue;
    }
    if (occurrence.getTime() > after.getTime()) return occurrence;
  }
  throw new RangeError("No workforce schedule occurrence was found in the next year.");
}

export function legacyScheduleIntervalMinutes(cadence: string): number {
  if (cadence === "hourly") return 60;
  if (cadence === "daily") return 1440;
  if (cadence === "weekly") return 10080;
  throw new TypeError("Unsupported legacy schedule cadence.");
}

export interface WorkforceScheduleOccurrenceRange {
  cadence: string;
  intervalMinutes?: number;
  recurrenceRule?: unknown;
  timezone: string;
  nextRunAt: Date | string;
  from: Date;
  to: Date;
  maxOccurrences?: number;
}

export interface WorkforceScheduleOccurrenceProjection {
  occurrences: Date[];
  truncated: boolean;
}

/**
 * Projects one saved schedule into a half-open calendar range. The persisted next-run time is
 * the anchor, so a projection cannot invent an earlier event. The returned dates are still
 * projections; callers must keep them distinct from persisted jobs.
 */
export function projectWorkforceScheduleOccurrences(
  input: WorkforceScheduleOccurrenceRange,
): WorkforceScheduleOccurrenceProjection {
  const anchor = new Date(input.nextRunAt);
  const fromMs = input.from.getTime();
  const toMs = input.to.getTime();
  const anchorMs = anchor.getTime();
  const maxOccurrences = input.maxOccurrences ?? 2000;
  const maxRangeMs = 370 * DAY_MS;
  if (
    !Number.isFinite(fromMs)
    || !Number.isFinite(toMs)
    || !Number.isFinite(anchorMs)
    || fromMs >= toMs
    || toMs - fromMs > maxRangeMs
    || !Number.isInteger(maxOccurrences)
    || maxOccurrences < 1
    || maxOccurrences > 5000
  ) {
    throw new TypeError("The workforce schedule projection range is invalid.");
  }

  const threshold = Math.max(fromMs, anchorMs);
  if (threshold >= toMs) return { occurrences: [], truncated: false };

  const hasRule = input.recurrenceRule !== undefined && input.recurrenceRule !== null;
  if (hasRule) {
    const rule = validateWorkforceScheduleRule(input.recurrenceRule);
    if (!rule) throw new TypeError("The workforce schedule recurrence is invalid.");
    const occurrences: Date[] = [];
    let next = nextWorkforceScheduleOccurrence(rule, input.timezone, new Date(threshold - 1));
    while (next.getTime() < toMs) {
      if (occurrences.length >= maxOccurrences) return { occurrences, truncated: true };
      occurrences.push(next);
      next = nextWorkforceScheduleOccurrence(rule, input.timezone, next);
    }
    return { occurrences, truncated: false };
  }

  const intervalMinutes = input.intervalMinutes ?? legacyScheduleIntervalMinutes(input.cadence);
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 60 || intervalMinutes > 10080) {
    throw new TypeError("The legacy workforce schedule interval is invalid.");
  }
  const intervalMs = intervalMinutes * 60_000;
  const firstOffset = Math.max(0, Math.ceil((fromMs - anchorMs) / intervalMs));
  let nextMs = anchorMs + firstOffset * intervalMs;
  const occurrences: Date[] = [];
  while (nextMs < toMs) {
    if (occurrences.length >= maxOccurrences) return { occurrences, truncated: true };
    occurrences.push(new Date(nextMs));
    nextMs += intervalMs;
  }
  return { occurrences, truncated: false };
}
