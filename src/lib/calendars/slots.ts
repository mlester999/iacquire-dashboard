// Native availability: turns weekly hours, day exceptions and busy times into bookable start times. Pure functions, no I/O, so the
// same rules decide what a booking page offers and what the server accepts. Times are exact instants (Date); "local" values are always
// interpreted in an explicit IANA time zone, which keeps daylight-saving changes correct.

export interface Interval {
  start: number; // epoch ms
  end: number; // epoch ms
}

export interface WeeklyRule {
  weekday: number; // 0 = Sunday
  startMinute: number;
  endMinute: number;
}

export interface DayOverride {
  date: string; // YYYY-MM-DD in the host's time zone
  /** Null window: closed all day. */
  startMinute: number | null;
  endMinute: number | null;
}

const partsCache = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let f = partsCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" });
    partsCache.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock parts of an instant in a time zone. */
export function zonedParts(at: number, timeZone: string) {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(at)).map((p) => [p.type, p.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second), weekday };
}

/** Offset of a time zone from UTC at an instant, in minutes (Manila: +480). */
export function offsetMinutes(at: number, timeZone: string): number {
  const p = zonedParts(at, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(at / 1000) * 1000) / 60_000);
}

/**
 * The instant for a wall-clock time in a time zone. In a spring-forward gap the time doesn't exist and moves forward by the gap; in a
 * fall-back overlap the earlier of the two instants is used.
 */
export function zonedToInstant(date: string, minuteOfDay: number, timeZone: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const naive = Date.UTC(y, m - 1, d, 0, minuteOfDay);
  let guess = naive - offsetMinutes(naive, timeZone) * 60_000;
  // Two passes settle the offset across a transition.
  for (let i = 0; i < 2; i++) guess = naive - offsetMinutes(guess, timeZone) * 60_000;
  const earlier = naive - offsetMinutes(guess - 3_600_000, timeZone) * 60_000;
  if (earlier < guess && localKey(earlier, timeZone) === localKey(guess, timeZone)) return earlier;
  return guess;
}

function localKey(at: number, tz: string) {
  const p = zonedParts(at, tz);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** YYYY-MM-DD of an instant in a time zone. */
export function zonedDate(at: number, timeZone: string): string {
  const p = zonedParts(at, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Merges overlapping or touching intervals. */
export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = [...list].filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

/** Removes busy time from open time. */
export function subtractIntervals(open: Interval[], busy: Interval[]): Interval[] {
  const blocks = mergeIntervals(busy);
  const out: Interval[] = [];
  for (const o of mergeIntervals(open)) {
    let cursor = o.start;
    for (const b of blocks) {
      if (b.end <= cursor || b.start >= o.end) continue;
      if (b.start > cursor) out.push({ start: cursor, end: Math.min(b.start, o.end) });
      cursor = Math.max(cursor, b.end);
      if (cursor >= o.end) break;
    }
    if (cursor < o.end) out.push({ start: cursor, end: o.end });
  }
  return out;
}

export function intersectIntervals(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  const A = mergeIntervals(a);
  const B = mergeIntervals(b);
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    const start = Math.max(A[i].start, B[j].start);
    const end = Math.min(A[i].end, B[j].end);
    if (end > start) out.push({ start, end });
    if (A[i].end < B[j].end) i++;
    else j++;
  }
  return out;
}

/**
 * When a person works between two instants: their weekly hours in their own time zone, with day exceptions applied (a person's own
 * exception wins over a workspace-wide one for the same day).
 */
export function workingIntervals(input: { from: number; to: number; timeZone: string; rules: WeeklyRule[]; overrides: DayOverride[] }): Interval[] {
  const { from, to, timeZone, rules, overrides } = input;
  const out: Interval[] = [];
  let date = addDays(zonedDate(from, timeZone), -1);
  const last = addDays(zonedDate(to, timeZone), 1);
  const byDate = new Map<string, DayOverride[]>();
  for (const o of overrides) byDate.set(o.date, [...(byDate.get(o.date) ?? []), o]);
  for (let guard = 0; date <= last && guard < 400; guard++, date = addDays(date, 1)) {
    const exceptions = byDate.get(date);
    const windows = exceptions?.length
      ? exceptions.filter((e) => e.startMinute !== null && e.endMinute !== null).map((e) => ({ startMinute: e.startMinute as number, endMinute: e.endMinute as number }))
      : rules.filter((r) => r.weekday === weekdayOf(date));
    if (exceptions?.some((e) => e.startMinute === null)) continue;
    for (const w of windows) {
      const start = zonedToInstant(date, w.startMinute, timeZone);
      const end = w.endMinute >= 1440 ? zonedToInstant(addDays(date, 1), 0, timeZone) : zonedToInstant(date, w.endMinute, timeZone);
      const s = Math.max(start, from);
      const e = Math.min(end, to);
      if (e > s) out.push({ start: s, end: e });
    }
  }
  return mergeIntervals(out);
}

export interface SlotOptions {
  durationMinutes: number;
  intervalMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  /** Start times are aligned to the interval in this time zone (so 30-minute slots start on :00 and :30 locally). */
  timeZone: string;
}

/**
 * Start times where the appointment fits: the meeting itself inside working hours, and the meeting plus its buffers clear of anything busy
 * (a buffer may run past the end of working hours, but never into another appointment).
 */
export function slotStarts(work: Interval[], busy: Interval[], o: SlotOptions): number[] {
  const dur = o.durationMinutes * 60_000;
  const step = Math.max(5, o.intervalMinutes) * 60_000;
  const before = o.bufferBeforeMinutes * 60_000;
  const after = o.bufferAfterMinutes * 60_000;
  const blocks = mergeIntervals(busy);
  const out: number[] = [];
  for (const w of mergeIntervals(work)) {
    // Align the first start to the step in local time.
    const offset = offsetMinutes(w.start, o.timeZone) * 60_000;
    let t = Math.ceil((w.start + offset) / step) * step - offset;
    for (; t + dur <= w.end; t += step) {
      const need = { start: t - before, end: t + dur + after };
      if (!blocks.some((b) => b.start < need.end && need.start < b.end)) out.push(t);
    }
  }
  return out;
}
