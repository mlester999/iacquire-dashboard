// Pure helpers for the scheduling settings screens: time labels, weekly-hours editing and the arithmetic behind "away part of the day".
// No React and no I/O, so the rules the forms check are tested directly.

export interface Range {
  startMinute: number;
  endMinute: number;
}
export interface WeeklyRange extends Range {
  weekday: number;
}

/** Monday first, the way most of our customers read a week. 0 = Sunday, as stored. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
export const WORKDAYS = [1, 2, 3, 4, 5] as const;

/** "9:00 AM", "12:30 PM"; the end of the day (1440) reads "Midnight". */
export function minuteLabel(m: number): string {
  if (m >= 1440) return "Midnight";
  const h = Math.floor(m / 60);
  const min = m % 60;
  const suffix = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(min).padStart(2, "0")} ${suffix}`;
}

export const rangeLabel = (r: Range) => `${minuteLabel(r.startMinute)} – ${minuteLabel(r.endMinute)}`;

/** Choices for a time select, every `step` minutes. Starts run 0..1439, ends 1..1440. A value off the step is kept so nothing is lost. */
export function timeOptions(kind: "start" | "end", step = 15, keep?: number): number[] {
  const out: number[] = [];
  for (let m = kind === "start" ? 0 : step; kind === "start" ? m < 1440 : m <= 1440; m += step) out.push(m);
  if (keep !== undefined && !out.includes(keep)) {
    out.push(keep);
    out.sort((a, b) => a - b);
  }
  return out;
}

/** What's wrong with one day's ranges, or null: each range starts before it ends, and ranges don't overlap. */
export function dayProblem(ranges: Range[]): string | null {
  for (const r of ranges) if (r.endMinute <= r.startMinute) return "Each range has to end after it starts.";
  const sorted = [...ranges].sort((a, b) => a.startMinute - b.startMinute);
  for (let i = 1; i < sorted.length; i++) if (sorted[i].startMinute < sorted[i - 1].endMinute) return "These ranges overlap. Merge them or change the times.";
  return null;
}

/** The weekly ranges with one day's ranges copied onto every workday (Monday to Friday). Weekends are left as they are. */
export function copyToWorkdays(rules: WeeklyRange[], fromWeekday: number): WeeklyRange[] {
  const source = rules.filter((r) => r.weekday === fromWeekday);
  const kept = rules.filter((r) => !(WORKDAYS as readonly number[]).includes(r.weekday) || r.weekday === fromWeekday);
  const copies = (WORKDAYS as readonly number[]).filter((d) => d !== fromWeekday).flatMap((d) => source.map((r) => ({ weekday: d, startMinute: r.startMinute, endMinute: r.endMinute })));
  return sortRules([...kept, ...copies]);
}

export function sortRules(rules: WeeklyRange[]): WeeklyRange[] {
  return [...rules].sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute);
}

/** Whether two sets of weekly ranges are the same hours, whatever their order. */
export function sameRules(a: WeeklyRange[], b: WeeklyRange[]): boolean {
  const key = (r: WeeklyRange[]) => sortRules(r).map((x) => `${x.weekday}:${x.startMinute}-${x.endMinute}`).join(",");
  return key(a) === key(b);
}

/**
 * The hours left on a day when someone is away from `away.startMinute` to `away.endMinute`: their usual ranges for that weekday with
 * the away time cut out. An empty result means the absence covers the whole working day.
 */
export function hoursAroundAbsence(dayRanges: Range[], away: Range): Range[] {
  const out: Range[] = [];
  for (const r of [...dayRanges].sort((a, b) => a.startMinute - b.startMinute)) {
    if (away.endMinute <= r.startMinute || away.startMinute >= r.endMinute) {
      out.push({ ...r });
      continue;
    }
    if (away.startMinute > r.startMinute) out.push({ startMinute: r.startMinute, endMinute: away.startMinute });
    if (away.endMinute < r.endMinute) out.push({ startMinute: away.endMinute, endMinute: r.endMinute });
  }
  return out.filter((r) => r.endMinute > r.startMinute);
}

/** The weekday of a YYYY-MM-DD date (0 = Sunday), independent of the browser's time zone. */
export function weekdayOfDate(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** "Mon, 20 Oct 2026" for a YYYY-MM-DD date, independent of the browser's time zone. */
export function dateLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** "30 min", "1 hr", "1 hr 30 min", "2 days". */
export function durationLabel(minutes: number): string {
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440} ${minutes === 1440 ? "day" : "days"}`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

export type TimeUnit = "minutes" | "hours" | "days";
export const UNIT_MINUTES: Record<TimeUnit, number> = { minutes: 1, hours: 60, days: 1440 };

/** The largest whole unit for a number of minutes, for a "number + unit" field. */
export function splitMinutes(minutes: number): { value: number; unit: TimeUnit } {
  if (minutes > 0 && minutes % 1440 === 0) return { value: minutes / 1440, unit: "days" };
  if (minutes > 0 && minutes % 60 === 0) return { value: minutes / 60, unit: "hours" };
  return { value: minutes, unit: "minutes" };
}

/**
 * A question's stored key from its label: lowercase letters, digits and underscores, starting with a letter, unique among `taken`.
 * Answers are saved under this key, so a saved question keeps its key even when its label changes.
 */
export function questionKey(label: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  let base = label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32)
    .replace(/_+$/g, "");
  if (!/^[a-z]/.test(base)) base = `q_${base}`.replace(/_+$/g, "") || "question";
  if (base === "q") base = "question";
  let key = base;
  for (let i = 2; used.has(key); i++) key = `${base.slice(0, 36)}_${i}`;
  return key;
}
