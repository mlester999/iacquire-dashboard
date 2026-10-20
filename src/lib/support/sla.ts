// Response-expectation arithmetic for Support & Requests. Pure functions: given a configured timezone, weekly opening hours and
// holidays, they add or measure *business* minutes correctly across weekends, holidays and daylight-saving changes. Nothing here
// talks about what the team "promises": it only does the clock maths for whatever the Super Admin configured.

import { WEEKDAYS, type BusinessHours, type TicketPriority, type Weekday } from "@/lib/support/lifecycle";

export interface ScheduleConfig {
  timezone: string;
  hours: BusinessHours;
  /** Calendar days (YYYY-MM-DD in `timezone`) with no support hours. */
  holidays: readonly string[];
  /** false = the clock runs around the clock (hours and holidays are ignored). */
  businessHoursOnly: boolean;
}

const MINUTE = 60_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function formatter(timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    formatters.set(timeZone, f);
  }
  return f;
}

interface LocalParts { y: number; m: number; d: number; h: number; mi: number; s: number }

function localParts(date: Date, timeZone: string): LocalParts {
  const out: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(date)) if (part.type !== "literal") out[part.type] = Number(part.value);
  return { y: out.year, m: out.month, d: out.day, h: out.hour === 24 ? 0 : out.hour, mi: out.minute, s: out.second };
}

/** The instant at which the wall clock in `timeZone` shows the given date and time. A time skipped by a clock change maps to the next valid instant. */
export function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, timeZone: string): Date {
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  let guess = naive;
  for (let i = 0; i < 4; i += 1) {
    const p = localParts(new Date(guess), timeZone);
    const shown = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi);
    const diff = naive - shown;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}

const pad = (n: number) => String(n).padStart(2, "0");
const dayKey = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

function parseHm(value: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function weekdayOf(y: number, m: number, d: number): Weekday {
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return WEEKDAYS[(dow + 6) % 7];
}

/** Validates and normalises weekly hours: sorted, non-overlapping, at most three windows a day. Returns an error message instead of throwing. */
export function normalizeBusinessHours(input: unknown): { ok: true; hours: BusinessHours } | { ok: false; error: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, error: "Opening hours must be a list of days." };
  const hours: BusinessHours = {};
  for (const [day, windows] of Object.entries(input as Record<string, unknown>)) {
    if (!(WEEKDAYS as readonly string[]).includes(day)) return { ok: false, error: `“${day}” is not a day of the week.` };
    if (!Array.isArray(windows)) return { ok: false, error: "Each day needs a list of opening windows." };
    if (windows.length > 3) return { ok: false, error: "Use at most three opening windows per day." };
    const parsed: Array<[number, number]> = [];
    for (const w of windows) {
      if (!Array.isArray(w) || w.length !== 2 || typeof w[0] !== "string" || typeof w[1] !== "string") return { ok: false, error: "Each opening window needs a start and an end time." };
      const a = parseHm(w[0]);
      const b = parseHm(w[1]);
      if (a === null || b === null) return { ok: false, error: "Times must look like 09:00." };
      if (b <= a) return { ok: false, error: "Each window must end after it starts." };
      parsed.push([a, b]);
    }
    parsed.sort((x, y) => x[0] - y[0]);
    for (let i = 1; i < parsed.length; i += 1) if (parsed[i][0] < parsed[i - 1][1]) return { ok: false, error: "Opening windows on the same day can't overlap." };
    if (parsed.length) hours[day as Weekday] = parsed.map(([a, b]) => [`${pad(Math.floor(a / 60))}:${pad(a % 60)}`, `${pad(Math.floor(b / 60))}:${pad(b % 60)}`]);
  }
  return { ok: true, hours };
}

export function normalizeHolidays(input: unknown): { ok: true; holidays: string[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: "Holidays must be a list of dates." };
  if (input.length > 366) return { ok: false, error: "That is too many holidays." };
  const out = new Set<string>();
  for (const v of input) {
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return { ok: false, error: "Holidays must look like 2026-12-25." };
    const [y, m, d] = v.split("-").map(Number);
    const check = new Date(Date.UTC(y, m - 1, d));
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return { ok: false, error: `${v} is not a real date.` };
    out.add(v);
  }
  return { ok: true, holidays: [...out].sort() };
}

/** True when no opening window exists on any day: a business-hours clock would never advance. */
export const hasNoOpeningHours = (hours: BusinessHours) => !WEEKDAYS.some((day) => (hours[day]?.length ?? 0) > 0);

interface Window { start: Date; end: Date }

/** The opening windows of one local calendar day, as instants. */
function windowsOn(y: number, m: number, d: number, cfg: ScheduleConfig): Window[] {
  if (cfg.holidays.includes(dayKey(y, m, d))) return [];
  const list = cfg.hours[weekdayOf(y, m, d)] ?? [];
  const out: Window[] = [];
  for (const [open, close] of list) {
    const a = parseHm(open);
    const b = parseHm(close);
    if (a === null || b === null) continue;
    out.push({ start: zonedToUtc(y, m, d, Math.floor(a / 60), a % 60, cfg.timezone), end: zonedToUtc(y, m, d, Math.floor(b / 60), b % 60, cfg.timezone) });
  }
  return out;
}

const MAX_DAYS = 800;

function nextDay(y: number, m: number, d: number): { y: number; m: number; d: number } {
  const n = new Date(Date.UTC(y, m - 1, d + 1));
  return { y: n.getUTCFullYear(), m: n.getUTCMonth() + 1, d: n.getUTCDate() };
}

/**
 * The instant `minutes` of support time after `start`. With business hours the clock only runs inside opening windows (so a request
 * received at 16:50 on Friday with a 30-minute target is due 09:20 on Monday); otherwise it is plain elapsed time.
 * If no opening hours exist at all the result falls back to elapsed time rather than never ending.
 */
export function addSupportMinutes(start: Date, minutes: number, cfg: ScheduleConfig): Date {
  if (!(minutes > 0)) return new Date(start);
  if (!cfg.businessHoursOnly || hasNoOpeningHours(cfg.hours)) return new Date(start.getTime() + minutes * MINUTE);
  let remaining = minutes * MINUTE;
  let { y, m, d } = localParts(start, cfg.timezone);
  for (let i = 0; i < MAX_DAYS; i += 1) {
    for (const w of windowsOn(y, m, d, cfg)) {
      const from = Math.max(start.getTime(), w.start.getTime());
      if (from >= w.end.getTime()) continue;
      const room = w.end.getTime() - from;
      if (remaining <= room) return new Date(from + remaining);
      remaining -= room;
    }
    ({ y, m, d } = nextDay(y, m, d));
  }
  // Holidays or hours made the clock unreachable within a sensible horizon: fall back to elapsed time.
  return new Date(start.getTime() + minutes * MINUTE);
}

/** Minutes of support time between two instants (negative when `to` is before `from`). */
export function supportMinutesBetween(from: Date, to: Date, cfg: ScheduleConfig): number {
  if (to.getTime() < from.getTime()) return -supportMinutesBetween(to, from, cfg);
  if (!cfg.businessHoursOnly || hasNoOpeningHours(cfg.hours)) return (to.getTime() - from.getTime()) / MINUTE;
  let total = 0;
  let { y, m, d } = localParts(from, cfg.timezone);
  const last = localParts(to, cfg.timezone);
  const lastKey = dayKey(last.y, last.m, last.d);
  for (let i = 0; i < MAX_DAYS; i += 1) {
    for (const w of windowsOn(y, m, d, cfg)) {
      const a = Math.max(from.getTime(), w.start.getTime());
      const b = Math.min(to.getTime(), w.end.getTime());
      if (b > a) total += b - a;
    }
    if (dayKey(y, m, d) >= lastKey) break;
    ({ y, m, d } = nextDay(y, m, d));
  }
  return total / MINUTE;
}

/** Whether the team is inside an opening window at this instant (always true when the clock is not limited to business hours). */
export function isWithinSupportHours(at: Date, cfg: ScheduleConfig): boolean {
  if (!cfg.businessHoursOnly || hasNoOpeningHours(cfg.hours)) return true;
  const p = localParts(at, cfg.timezone);
  return windowsOn(p.y, p.m, p.d, cfg).some((w) => at.getTime() >= w.start.getTime() && at.getTime() < w.end.getTime());
}

// ---------------------------------------------------------------------------
// States and wording
// ---------------------------------------------------------------------------

export type SlaState = "none" | "on_track" | "approaching" | "overdue" | "waiting_on_client" | "resolved";

export const SLA_STATE_LABELS: Record<SlaState, string> = {
  none: "No response target",
  on_track: "Within target",
  approaching: "Target approaching",
  overdue: "Overdue",
  waiting_on_client: "Waiting on client",
  resolved: "Finished",
};

/**
 * Where a request stands against its response target. `dueAt` is null when no target applies (nothing configured, or waiting on the client).
 * "Approaching" starts once `approachingPercent` of the target window (measured in support time) has elapsed.
 */
export function computeSlaState(input: {
  status: string;
  dueAt: Date | string | null;
  startedAt: Date | string | null;
  now: Date;
  approachingPercent: number;
  cfg: ScheduleConfig;
}): SlaState {
  if (input.status === "resolved" || input.status === "closed") return "resolved";
  if (input.status === "waiting_for_client") return "waiting_on_client";
  if (!input.dueAt) return "none";
  const due = new Date(input.dueAt);
  if (input.now.getTime() >= due.getTime()) return "overdue";
  if (!input.startedAt) return "on_track";
  const started = new Date(input.startedAt);
  const total = supportMinutesBetween(started, due, input.cfg);
  if (total <= 0) return "on_track";
  const elapsed = supportMinutesBetween(started, input.now, input.cfg);
  return elapsed / total >= input.approachingPercent / 100 ? "approaching" : "on_track";
}

/** Minutes in a typical opening day (the longest configured day), used to word targets as days. */
function longestDayMinutes(hours: BusinessHours): number {
  let best = 0;
  for (const day of WEEKDAYS) {
    let sum = 0;
    for (const [a, b] of hours[day] ?? []) sum += (parseHm(b) ?? 0) - (parseHm(a) ?? 0);
    best = Math.max(best, sum);
  }
  return best;
}

/** "within 2 business hours", "within 1 business day". Only worded from what is configured; never rounds a target up. */
export function describeTarget(minutes: number, cfg: Pick<ScheduleConfig, "hours" | "businessHoursOnly">): string {
  const unit = cfg.businessHoursOnly && !hasNoOpeningHours(cfg.hours) ? "business " : "";
  const day = cfg.businessHoursOnly && !hasNoOpeningHours(cfg.hours) ? longestDayMinutes(cfg.hours) : 1440;
  const plural = (n: number, word: string) => `${n} ${unit}${word}${n === 1 ? "" : "s"}`;
  if (minutes < 60) return `within ${minutes} minute${minutes === 1 ? "" : "s"}`;
  if (day > 0 && minutes >= day && minutes % day === 0) return `within ${plural(minutes / day, "day")}`;
  if (minutes % 60 === 0) return `within ${plural(minutes / 60, "hour")}`;
  const hours = Math.floor(minutes / 60);
  return `within ${hours} ${unit}hour${hours === 1 ? "" : "s"} ${minutes % 60} minutes`;
}

/** Targets by priority, in support minutes. Missing priorities mean "no target for that priority". */
export type TargetMinutes = Partial<Record<TicketPriority, number>>;

export function targetFor(targets: TargetMinutes | null | undefined, priority: string): number | null {
  const v = (targets as Record<string, unknown> | null | undefined)?.[priority];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
}

export function normalizeTargets(input: unknown): { ok: true; targets: TargetMinutes } | { ok: false; error: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, error: "Targets must be a list of priorities." };
  const out: TargetMinutes = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!["low", "normal", "high", "urgent"].includes(key)) return { ok: false, error: `“${key}” is not a priority.` };
    if (value === null || value === "" || value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 60 * 24 * 30) return { ok: false, error: "Targets must be whole minutes between 1 and 43,200." };
    out[key as TicketPriority] = value;
  }
  return { ok: true, targets: out };
}
