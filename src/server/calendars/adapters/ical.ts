import "server-only";
import { isValidTimeZone, zonedToInstant } from "@/lib/calendars/slots";

// iCalendar (RFC 5545) for connected calendars: reading feeds and CalDAV calendar data into busy instants, and writing the events this
// workspace adds to a CalDAV calendar. Only what busy-time and write-back need is modelled: VEVENT with DTSTART/DTEND/DURATION, RRULE
// (DAILY, WEEKLY, MONTHLY, YEARLY with INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY, BYMONTH, BYSETPOS, WKST), RDATE, EXDATE, RECURRENCE-ID
// overrides, STATUS and TRANSP. Time zones are IANA names where the TZID is (or ends with) one, a Windows zone name we know, or else the
// calendar's own VTIMEZONE rules. Everything is bounded: expansion only runs inside the window asked for, with hard caps.

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Civil dates as day numbers (days since 1970-01-01), so arithmetic never touches a time zone.
// ---------------------------------------------------------------------------

export function dayNumber(y: number, m: number, d: number): number {
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
}
export function civil(n: number): { y: number; m: number; d: number } {
  const dt = new Date(n * DAY_MS);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}
export const isoDay = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);
/** 0 = Sunday, as everywhere else in the calendar code. */
export const weekdayOfDay = (n: number) => (((n + 4) % 7) + 7) % 7;
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const daysInYear = (y: number) => (daysInMonth(y, 2) === 29 ? 366 : 365);

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface IcsProperty {
  name: string;
  params: Record<string, string[]>;
  value: string;
}

export interface IcsComponent {
  name: string;
  props: IcsProperty[];
  components: IcsComponent[];
}

export class IcsParseError extends Error {}

export interface ParseLimits {
  /** Characters of input (after unfolding nothing grows). */
  maxLength?: number;
  maxComponents?: number;
  maxDepth?: number;
}

/** Joins folded lines: a line that starts with a space or tab continues the previous one (RFC 5545 3.1). */
export function unfold(text: string): string[] {
  const raw = text.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/);
  const out: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length) out[out.length - 1] += line.slice(1);
    else out.push(line);
  }
  return out;
}

/** One content line: NAME;PARAM=a,"b:c";X=y:value. Parameter values may be quoted and then contain ; : and ,. */
export function parseContentLine(line: string): IcsProperty | null {
  let i = 0;
  while (i < line.length && line[i] !== ";" && line[i] !== ":") i++;
  const name = line.slice(0, i).trim().toUpperCase();
  if (!name || !/^[A-Z0-9-]+$/.test(name)) return null;
  const params: Record<string, string[]> = {};
  while (line[i] === ";") {
    i++;
    let j = i;
    while (j < line.length && line[j] !== "=" && line[j] !== ";" && line[j] !== ":") j++;
    const pname = line.slice(i, j).trim().toUpperCase();
    const values: string[] = [];
    if (line[j] === "=") {
      j++;
      for (;;) {
        let v: string;
        if (line[j] === '"') {
          const end = line.indexOf('"', j + 1);
          if (end < 0) return null;
          v = line.slice(j + 1, end);
          j = end + 1;
        } else {
          let k = j;
          while (k < line.length && line[k] !== "," && line[k] !== ";" && line[k] !== ":") k++;
          v = line.slice(j, k);
          j = k;
        }
        values.push(v);
        if (line[j] === ",") {
          j++;
          continue;
        }
        break;
      }
    }
    if (pname) params[pname] = values;
    i = j;
  }
  if (line[i] !== ":") return null;
  return { name, params, value: line.slice(i + 1) };
}

/** Parses iCalendar text into its top-level components (normally one VCALENDAR). Malformed lines are skipped, not fatal. */
export function parseIcs(text: string, limits: ParseLimits = {}): IcsComponent[] {
  const maxLength = limits.maxLength ?? 6_000_000;
  const maxComponents = limits.maxComponents ?? 60_000;
  const maxDepth = limits.maxDepth ?? 8;
  if (text.length > maxLength) throw new IcsParseError("The calendar is larger than we can read.");
  const roots: IcsComponent[] = [];
  const stack: IcsComponent[] = [];
  let count = 0;
  for (const line of unfold(text)) {
    if (!line.trim()) continue;
    const p = parseContentLine(line);
    if (!p) continue;
    if (p.name === "BEGIN") {
      const c: IcsComponent = { name: p.value.trim().toUpperCase(), props: [], components: [] };
      if (++count > maxComponents) throw new IcsParseError("The calendar has more entries than we can read.");
      if (stack.length >= maxDepth) throw new IcsParseError("The calendar is nested too deeply.");
      if (stack.length) stack[stack.length - 1].components.push(c);
      else roots.push(c);
      stack.push(c);
    } else if (p.name === "END") {
      const want = p.value.trim().toUpperCase();
      // Tolerate a missing END for an inner component: close up to the matching one.
      const at = stack.map((c) => c.name).lastIndexOf(want);
      if (at >= 0) stack.length = at;
    } else if (stack.length) {
      stack[stack.length - 1].props.push(p);
    }
  }
  return roots;
}

export const prop = (c: IcsComponent, name: string) => c.props.find((p) => p.name === name);
export const props = (c: IcsComponent, name: string) => c.props.filter((p) => p.name === name);
export const param = (p: IcsProperty | undefined, name: string) => p?.params[name]?.[0];

/** TEXT values: \\ \; \, and \n are escapes (RFC 5545 3.3.11). */
export function unescapeText(v: string): string {
  return v.replace(/\\([\\;,nN])/g, (_, ch: string) => (ch === "n" || ch === "N" ? "\n" : ch));
}
export function escapeText(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

export type IcsDateValue =
  | { type: "date"; day: number }
  | { type: "datetime"; day: number; seconds: number; utc: boolean; tzid: string | null };

const plausibleYear = (y: number) => y >= 1900 && y <= 2399;

/** A DATE or DATE-TIME value. TZID comes from the property's parameter; a trailing Z means UTC. */
export function parseDateValue(raw: string, tzid?: string | null, valueType?: string | null): IcsDateValue | null {
  const v = raw.trim();
  const d = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (d || valueType?.toUpperCase() === "DATE") {
    if (!d) return null;
    const [y, m, dd] = [Number(d[1]), Number(d[2]), Number(d[3])];
    if (!plausibleYear(y) || m < 1 || m > 12 || dd < 1 || dd > daysInMonth(y, m)) return null;
    return { type: "date", day: dayNumber(y, m, dd) };
  }
  const t = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z?)$/i.exec(v);
  if (!t) return null;
  const [y, m, dd, hh, mi] = [Number(t[1]), Number(t[2]), Number(t[3]), Number(t[4]), Number(t[5])];
  const ss = Math.min(59, Number(t[6] ?? 0));
  if (!plausibleYear(y) || m < 1 || m > 12 || dd < 1 || dd > daysInMonth(y, m) || hh > 23 || mi > 59) return null;
  const utc = t[7].toUpperCase() === "Z";
  return { type: "datetime", day: dayNumber(y, m, dd), seconds: hh * 3600 + mi * 60 + ss, utc, tzid: utc ? null : tzid?.trim() || null };
}

function dateValuesOf(p: IcsProperty): IcsDateValue[] {
  const tz = param(p, "TZID") ?? null;
  const vt = param(p, "VALUE") ?? null;
  if (vt?.toUpperCase() === "PERIOD") {
    return p.value.split(",").map((s) => parseDateValue(s.split("/")[0], tz)).filter((x): x is IcsDateValue => !!x);
  }
  return p.value.split(",").map((s) => parseDateValue(s, tz, vt)).filter((x): x is IcsDateValue => !!x);
}

export interface IcsDuration {
  sign: 1 | -1;
  weeks: number;
  days: number;
  /** Hours, minutes and seconds together. */
  seconds: number;
}

/** RFC 5545 3.3.6: P15DT5H0M20S, P7W, PT1H30M, -PT15M. */
export function parseDuration(raw: string): IcsDuration | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(raw.trim());
  if (!m || raw.trim().replace(/^[+-]/, "").toUpperCase() === "P" || /T$/i.test(raw.trim())) return null;
  const n = (s: string | undefined) => Number(s ?? 0);
  return { sign: m[1] === "-" ? -1 : 1, weeks: n(m[2]), days: n(m[3]), seconds: n(m[4]) * 3600 + n(m[5]) * 60 + n(m[6]) };
}

// ---------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------

/** Windows time zone names some Exchange and Outlook feeds use as TZID (CLDR windowsZones, territory 001). */
const WINDOWS_ZONES: Record<string, string> = {
  "UTC": "UTC", "Coordinated Universal Time": "UTC", "GMT Standard Time": "Europe/London", "Greenwich Standard Time": "Atlantic/Reykjavik",
  "W. Europe Standard Time": "Europe/Berlin", "Central Europe Standard Time": "Europe/Budapest", "Romance Standard Time": "Europe/Paris",
  "Central European Standard Time": "Europe/Warsaw", "E. Europe Standard Time": "Europe/Chisinau", "FLE Standard Time": "Europe/Kiev",
  "GTB Standard Time": "Europe/Bucharest", "Russian Standard Time": "Europe/Moscow", "Turkey Standard Time": "Europe/Istanbul",
  "Israel Standard Time": "Asia/Jerusalem", "South Africa Standard Time": "Africa/Johannesburg", "Egypt Standard Time": "Africa/Cairo",
  "Arabian Standard Time": "Asia/Dubai", "Arab Standard Time": "Asia/Riyadh", "Pakistan Standard Time": "Asia/Karachi",
  "India Standard Time": "Asia/Calcutta", "Bangladesh Standard Time": "Asia/Dhaka", "SE Asia Standard Time": "Asia/Bangkok",
  "Singapore Standard Time": "Asia/Singapore", "China Standard Time": "Asia/Shanghai", "Taipei Standard Time": "Asia/Taipei",
  "Tokyo Standard Time": "Asia/Tokyo", "Korea Standard Time": "Asia/Seoul", "W. Australia Standard Time": "Australia/Perth",
  "AUS Central Standard Time": "Australia/Darwin", "Cen. Australia Standard Time": "Australia/Adelaide", "E. Australia Standard Time": "Australia/Brisbane",
  "AUS Eastern Standard Time": "Australia/Sydney", "New Zealand Standard Time": "Pacific/Auckland", "Hawaiian Standard Time": "Pacific/Honolulu",
  "Alaskan Standard Time": "America/Anchorage", "Pacific Standard Time": "America/Los_Angeles", "US Mountain Standard Time": "America/Phoenix",
  "Mountain Standard Time": "America/Denver", "Central Standard Time": "America/Chicago", "Eastern Standard Time": "America/New_York",
  "Atlantic Standard Time": "America/Halifax", "Newfoundland Standard Time": "America/St_Johns", "E. South America Standard Time": "America/Sao_Paulo",
  "Argentina Standard Time": "America/Buenos_Aires", "SA Pacific Standard Time": "America/Bogota", "Central America Standard Time": "America/Guatemala",
  "Mexico Standard Time": "America/Mexico_City", "Central Standard Time (Mexico)": "America/Mexico_City", "Canada Central Standard Time": "America/Regina",
};

/** The IANA zone a TZID names: itself, the tail of a vendor path (/mozilla.org/20050126_1/America/New_York), or a known Windows name. */
export function ianaFromTzid(tzid: string): string | null {
  const t = tzid.trim().replace(/^"|"$/g, "");
  if (!t) return null;
  if (isValidTimeZone(t)) return t;
  const parts = t.split("/").filter(Boolean);
  for (let i = Math.max(0, parts.length - 3); i < parts.length - 1; i++) {
    const cand = parts.slice(i).join("/");
    if (isValidTimeZone(cand)) return cand;
  }
  return WINDOWS_ZONES[t] ?? null;
}

/** Converts a local wall-clock time (day number + seconds of day) to an instant. */
export type ZoneFn = (day: number, seconds: number) => number;

const ianaZone = (tz: string): ZoneFn => (day, seconds) => zonedToInstant(isoDay(day), Math.floor(seconds / 60), tz) + (seconds % 60) * 1000;

function parseOffset(v: string | undefined): number | null {
  const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec((v ?? "").trim());
  if (!m) return null;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4] ?? 0));
}

/**
 * An observance's DTSTART with its year raised to 1900 at the earliest. Outlook and Exchange always write onsets as 1601-01-01
 * (16010101T020000), which the date reader's plausibility check would drop, losing the whole zone. The onset only anchors the first
 * transition (the RRULE does the rest), so moving a 1601 anchor to 1900 changes nothing for any date we expand.
 */
export function observanceStart(raw: string | undefined): IcsDateValue | null {
  const clamped = (raw ?? "").trim().replace(/^(\d{4})/, (y) => String(Math.max(1900, Number(y))));
  return parseDateValue(clamped);
}

/**
 * A zone from a VTIMEZONE's own STANDARD/DAYLIGHT rules, for a TZID that isn't an IANA name. Each observance starts at its DTSTART (local
 * time in the offset before it) and repeats by its RRULE or RDATEs. In a spring-forward gap the offset before the gap is used, and in a
 * fall-back overlap the earlier instant (RFC 5545 3.3.5).
 */
export function vtimezoneZone(vtz: IcsComponent): ZoneFn | null {
  type Obs = { from: number; to: number; start: IcsDateValue & { type: "datetime" }; rule: RRule | null; rdates: Array<{ day: number; seconds: number }> };
  const observances: Obs[] = [];
  for (const c of vtz.components) {
    if (c.name !== "STANDARD" && c.name !== "DAYLIGHT") continue;
    const from = parseOffset(prop(c, "TZOFFSETFROM")?.value);
    const to = parseOffset(prop(c, "TZOFFSETTO")?.value);
    const start = observanceStart(prop(c, "DTSTART")?.value);
    if (from === null || to === null || !start || start.type !== "datetime") continue;
    const rr = prop(c, "RRULE");
    const rdates = props(c, "RDATE").flatMap(dateValuesOf).filter((d): d is IcsDateValue & { type: "datetime" } => d.type === "datetime").map((d) => ({ day: d.day, seconds: d.seconds }));
    observances.push({ from, to, start, rule: rr ? parseRRule(rr.value) : null, rdates });
  }
  if (!observances.length) return null;
  const cache = new Map<number, Array<{ at: number; to: number; from: number }>>();
  // Transition instants for one calendar year, from every observance.
  const transitions = (year: number) => {
    let list = cache.get(year);
    if (list) return list;
    list = [];
    const lo = dayNumber(year, 1, 1);
    const hi = dayNumber(year + 1, 1, 1);
    for (const o of observances) {
      const toUtc = (day: number, seconds: number) => (day * 86400 + seconds - o.from) * 1000;
      const onsets: Array<{ day: number; seconds: number }> = [];
      if (o.rule) {
        for (const occ of expandRRule(o.rule, { day: o.start.day, seconds: o.start.seconds }, { stopDay: hi, fromDay: lo, untilInstant: o.rule.until ? untilFn(o.rule.until, (d, s) => toUtc(d, s)) : null })) {
          if (occ.day >= lo && occ.day < hi) onsets.push(occ);
        }
      } else if (o.start.day >= lo && o.start.day < hi) onsets.push({ day: o.start.day, seconds: o.start.seconds });
      for (const r of o.rdates) if (r.day >= lo && r.day < hi) onsets.push(r);
      for (const on of onsets) list.push({ at: toUtc(on.day, on.seconds), to: o.to, from: o.from });
    }
    list.sort((a, b) => a.at - b.at);
    cache.set(year, list);
    return list;
  };
  const first = observances.reduce((a, b) => (a.start.day * 86400 + a.start.seconds <= b.start.day * 86400 + b.start.seconds ? a : b));
  const offsetAt = (instant: number): number => {
    const y = new Date(instant).getUTCFullYear();
    let best: { at: number; to: number } | null = null;
    for (const yy of [y - 1, y, y + 1]) for (const t of transitions(yy)) if (t.at <= instant && (!best || t.at > best.at)) best = t;
    return best ? best.to : first.from;
  };
  const candidates = [...new Set(observances.flatMap((o) => [o.from, o.to]))].sort((a, b) => b - a);
  return (day, seconds) => {
    const local = (day * 86400 + seconds) * 1000;
    // Largest offset first: in an overlap that is the earlier instant.
    for (const off of candidates) {
      const instant = local - off * 1000;
      if (offsetAt(instant) === off) return instant;
    }
    // A gap: use the offset in force just before it.
    const before = offsetAt(local - candidates[0] * 1000 - 3 * 3600_000);
    return local - before * 1000;
  };
}

/** Resolves TZIDs for one VCALENDAR. Unknown or missing zones are floating times in the fallback zone (the calendar owner's). */
export function zoneResolver(calendar: IcsComponent | null, fallbackTz: string): { zone: (tzid: string | null) => ZoneFn; floating: ZoneFn; unknownZones: Set<string> } {
  const wr = calendar ? prop(calendar, "X-WR-TIMEZONE")?.value.trim() : undefined;
  const floatingTz = wr && isValidTimeZone(wr) ? wr : isValidTimeZone(fallbackTz) ? fallbackTz : "UTC";
  const floating = ianaZone(floatingTz);
  const vtz = new Map<string, IcsComponent>();
  for (const c of calendar?.components ?? []) if (c.name === "VTIMEZONE") {
    const id = prop(c, "TZID")?.value.trim();
    if (id) vtz.set(id, c);
  }
  const cache = new Map<string, ZoneFn>();
  const unknownZones = new Set<string>();
  const zone = (tzid: string | null): ZoneFn => {
    if (!tzid) return floating;
    const hit = cache.get(tzid);
    if (hit) return hit;
    const iana = ianaFromTzid(tzid);
    let fn: ZoneFn | null = iana ? ianaZone(iana) : null;
    if (!fn && vtz.has(tzid)) fn = vtimezoneZone(vtz.get(tzid)!);
    if (!fn) {
      unknownZones.add(tzid);
      fn = floating;
    }
    cache.set(tzid, fn);
    return fn;
  };
  return { zone, floating, unknownZones };
}

export function instantOf(v: IcsDateValue, zone: (tzid: string | null) => ZoneFn): number {
  if (v.type === "date") return zone(null)(v.day, 0);
  if (v.utc) return (v.day * 86400 + v.seconds) * 1000;
  return zone(v.tzid)(v.day, v.seconds);
}

// ---------------------------------------------------------------------------
// Recurrence rules
// ---------------------------------------------------------------------------

export type Freq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

export interface RRule {
  freq: Freq;
  interval: number;
  count: number | null;
  until: IcsDateValue | null;
  byDay: Array<{ n: number | null; wd: number }> | null;
  byMonthDay: number[] | null;
  byMonth: number[] | null;
  bySetPos: number[] | null;
  wkst: number;
  /** Rule parts we don't expand (BYHOUR, BYWEEKNO, …). An event using them is counted, and only its listed dates are used. */
  unsupported: string[];
}

const intList = (v: string, min: number, max: number, allowNegative: boolean) => {
  const out: number[] = [];
  for (const s of v.split(",")) {
    const n = Number(s.trim());
    if (!Number.isInteger(n) || n === 0 || Math.abs(n) > max || Math.abs(n) < min || (!allowNegative && n < 0)) return null;
    out.push(n);
  }
  return out.length ? out : null;
};

/** Parses an RRULE value. Returns null for a rule we can't trust at all (no or unknown FREQ, nonsense values). */
export function parseRRule(value: string): RRule | null {
  const parts = new Map<string, string>();
  for (const kv of value.trim().split(";")) {
    const [k, v] = kv.split("=");
    if (k && v !== undefined) parts.set(k.trim().toUpperCase(), v.trim().toUpperCase());
  }
  const rawFreq = parts.get("FREQ");
  const unsupported: string[] = [];
  let freq: Freq;
  if (rawFreq === "DAILY" || rawFreq === "WEEKLY" || rawFreq === "MONTHLY" || rawFreq === "YEARLY") freq = rawFreq;
  else if (rawFreq === "SECONDLY" || rawFreq === "MINUTELY" || rawFreq === "HOURLY") {
    // Sub-daily repeats aren't expanded; the event's first occurrence and listed dates are still used.
    unsupported.push(`FREQ=${rawFreq}`);
    freq = "DAILY";
  } else return null;
  const interval = parts.has("INTERVAL") ? Number(parts.get("INTERVAL")) : 1;
  if (!Number.isInteger(interval) || interval < 1 || interval > 1000) return null;
  const count = parts.has("COUNT") ? Number(parts.get("COUNT")) : null;
  if (count !== null && (!Number.isInteger(count) || count < 1)) return null;
  const until = parts.has("UNTIL") ? parseDateValue(parts.get("UNTIL")!) : null;
  if (parts.has("UNTIL") && !until) return null;
  let byDay: RRule["byDay"] = null;
  if (parts.has("BYDAY")) {
    byDay = [];
    for (const s of parts.get("BYDAY")!.split(",")) {
      const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(s.trim());
      if (!m) return null;
      const n = m[1] ? Number(m[1]) : null;
      if (n !== null && (n === 0 || Math.abs(n) > 53)) return null;
      byDay.push({ n, wd: WEEKDAYS.indexOf(m[2]) });
    }
  }
  const byMonthDay = parts.has("BYMONTHDAY") ? intList(parts.get("BYMONTHDAY")!, 1, 31, true) : null;
  if (parts.has("BYMONTHDAY") && !byMonthDay) return null;
  const byMonth = parts.has("BYMONTH") ? intList(parts.get("BYMONTH")!, 1, 12, false) : null;
  if (parts.has("BYMONTH") && !byMonth) return null;
  const bySetPos = parts.has("BYSETPOS") ? intList(parts.get("BYSETPOS")!, 1, 366, true) : null;
  if (parts.has("BYSETPOS") && !bySetPos) return null;
  const wkst = parts.has("WKST") ? WEEKDAYS.indexOf(parts.get("WKST")!) : 1;
  for (const k of ["BYSECOND", "BYMINUTE", "BYHOUR", "BYYEARDAY", "BYWEEKNO"]) if (parts.has(k)) unsupported.push(k);
  return { freq, interval, count, until, byDay, byMonthDay, byMonth, bySetPos, wkst: wkst < 0 ? 1 : wkst, unsupported };
}

const addMonths = (y: number, m: number, n: number) => {
  const idx = y * 12 + (m - 1) + n;
  return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
};

function monthDays(y: number, m: number, byMonthDay: number[]): number[] {
  const dim = daysInMonth(y, m);
  const out: number[] = [];
  for (const md of byMonthDay) {
    const d = md > 0 ? md : dim + md + 1;
    if (d >= 1 && d <= dim) out.push(dayNumber(y, m, d));
  }
  return out;
}

/** Weekdays in a span [lo, hi) of day numbers; with an ordinal, only the nth (or nth from the end). */
function weekdaysIn(lo: number, hi: number, byDay: NonNullable<RRule["byDay"]>): number[] {
  const out: number[] = [];
  for (const { n, wd } of byDay) {
    const firstDay = lo + ((wd - weekdayOfDay(lo) + 7) % 7);
    const all: number[] = [];
    for (let d = firstDay; d < hi; d += 7) all.push(d);
    if (n === null) out.push(...all);
    else {
      const pick = n > 0 ? all[n - 1] : all[all.length + n];
      if (pick !== undefined) out.push(pick);
    }
  }
  return out;
}

/** Candidate days for the k-th period of a rule (before COUNT/UNTIL), sorted and unique. */
function periodDays(rule: RRule, k: number, start: number): number[] {
  const s = civil(start);
  let days: number[] = [];
  const iv = rule.interval * k;
  if (rule.freq === "DAILY") {
    const d = start + iv;
    const c = civil(d);
    const ok =
      (!rule.byMonth || rule.byMonth.includes(c.m)) &&
      (!rule.byMonthDay || monthDays(c.y, c.m, rule.byMonthDay).includes(d)) &&
      (!rule.byDay || rule.byDay.some((b) => b.wd === weekdayOfDay(d)));
    days = ok ? [d] : [];
  } else if (rule.freq === "WEEKLY") {
    const weekStart = start - ((weekdayOfDay(start) - rule.wkst + 7) % 7) + 7 * iv;
    const wds = rule.byDay ? rule.byDay.map((b) => b.wd) : [weekdayOfDay(start)];
    days = wds.map((wd) => weekStart + ((wd - rule.wkst + 7) % 7)).filter((d) => !rule.byMonth || rule.byMonth.includes(civil(d).m));
  } else if (rule.freq === "MONTHLY") {
    const { y, m } = addMonths(s.y, s.m, iv);
    if (!rule.byMonth || rule.byMonth.includes(m)) {
      const lo = dayNumber(y, m, 1);
      const hi = lo + daysInMonth(y, m);
      if (rule.byMonthDay) {
        days = monthDays(y, m, rule.byMonthDay);
        if (rule.byDay) days = days.filter((d) => rule.byDay!.some((b) => b.wd === weekdayOfDay(d)));
      } else if (rule.byDay) days = weekdaysIn(lo, hi, rule.byDay);
      else if (s.d <= daysInMonth(y, m)) days = [dayNumber(y, m, s.d)];
    }
  } else {
    const y = s.y + iv;
    if (rule.byMonth) {
      for (const m of rule.byMonth) {
        const lo = dayNumber(y, m, 1);
        const hi = lo + daysInMonth(y, m);
        if (rule.byMonthDay) {
          let ds = monthDays(y, m, rule.byMonthDay);
          if (rule.byDay) ds = ds.filter((d) => rule.byDay!.some((b) => b.wd === weekdayOfDay(d)));
          days.push(...ds);
        } else if (rule.byDay) days.push(...weekdaysIn(lo, hi, rule.byDay));
        else if (s.d <= daysInMonth(y, m)) days.push(dayNumber(y, m, s.d));
      }
    } else if (rule.byMonthDay) {
      for (let m = 1; m <= 12; m++) {
        let ds = monthDays(y, m, rule.byMonthDay);
        if (rule.byDay) ds = ds.filter((d) => rule.byDay!.some((b) => b.wd === weekdayOfDay(d)));
        days.push(...ds);
      }
    } else if (rule.byDay) {
      const lo = dayNumber(y, 1, 1);
      days = weekdaysIn(lo, lo + daysInYear(y), rule.byDay);
    } else if (s.d <= daysInMonth(y, s.m)) days = [dayNumber(y, s.m, s.d)];
  }
  days = [...new Set(days)].sort((a, b) => a - b);
  if (rule.bySetPos && days.length) {
    const picked = rule.bySetPos.map((p) => (p > 0 ? days[p - 1] : days[days.length + p])).filter((d): d is number => d !== undefined);
    days = [...new Set(picked)].sort((a, b) => a - b);
  }
  return days;
}

/** How many whole periods can be skipped to reach `fromDay` (only without COUNT, which must count from the start). */
function periodsToSkip(rule: RRule, start: number, fromDay: number): number {
  if (rule.count !== null || fromDay <= start) return 0;
  const s = civil(start);
  const f = civil(fromDay);
  const span = rule.freq === "DAILY" ? fromDay - start : rule.freq === "WEEKLY" ? Math.floor((fromDay - start) / 7) : rule.freq === "MONTHLY" ? (f.y - s.y) * 12 + (f.m - s.m) : f.y - s.y;
  return Math.max(0, Math.floor(span / rule.interval) - 1);
}

export function untilFn(until: IcsDateValue, toInstant: (day: number, seconds: number) => number): (day: number, seconds: number) => boolean {
  if (until.type === "date") return (day) => day <= until.day;
  if (until.utc) {
    const limit = (until.day * 86400 + until.seconds) * 1000;
    return (day, seconds) => toInstant(day, seconds) <= limit;
  }
  return (day, seconds) => day < until.day || (day === until.day && seconds <= until.seconds);
}

export interface ExpandRRuleOptions {
  /** Stop once a period starts after this day. */
  stopDay: number;
  /** Skip ahead to this day where the rule allows it. */
  fromDay?: number;
  /** True while an occurrence is not after UNTIL. */
  untilInstant: ((day: number, seconds: number) => boolean) | null;
  maxPeriods?: number;
}

/**
 * Occurrences of a rule as local (day, seconds) pairs, in order, starting with DTSTART itself (RFC 5545: DTSTART is always the first
 * occurrence and counts toward COUNT). Time of day comes from DTSTART. Invalid dates (31 February) are skipped, as the RFC says.
 */
export function* expandRRule(rule: RRule, start: { day: number; seconds: number }, o: ExpandRRuleOptions): Generator<{ day: number; seconds: number }> {
  const within = (day: number) => !o.untilInstant || o.untilInstant(day, start.seconds);
  if (!within(start.day)) return;
  yield { day: start.day, seconds: start.seconds };
  if (rule.unsupported.length) return;
  let produced = 1;
  const maxPeriods = o.maxPeriods ?? 50_000;
  for (let k = periodsToSkip(rule, start.day, o.fromDay ?? start.day), n = 0; n < maxPeriods; k++, n++) {
    const days = periodDays(rule, k, start.day);
    // Every candidate in a period is at least the period's first day, so once the earliest possible one passes the stop, we're done.
    const periodFloor = rule.freq === "DAILY" ? start.day + rule.interval * k : rule.freq === "WEEKLY" ? start.day - 6 + 7 * rule.interval * k : null;
    if (periodFloor !== null && periodFloor > o.stopDay) return;
    if (rule.freq === "MONTHLY" || rule.freq === "YEARLY") {
      const s = civil(start.day);
      const p = rule.freq === "MONTHLY" ? addMonths(s.y, s.m, rule.interval * k) : { y: s.y + rule.interval * k, m: 1 };
      if (dayNumber(p.y, p.m, 1) > o.stopDay) return;
    }
    for (const day of days) {
      if (day <= start.day) continue;
      if (!within(day)) return;
      if (rule.count !== null && produced >= rule.count) return;
      produced++;
      yield { day, seconds: start.seconds };
    }
  }
}

// ---------------------------------------------------------------------------
// Events into busy instances
// ---------------------------------------------------------------------------

export interface IcsInstance {
  uid: string;
  /** Exact start and end (epoch ms). */
  start: number;
  end: number;
  allDay: boolean;
  /** TRANSP:TRANSPARENT ("show me as available"). */
  transparent: boolean;
  /** CONFIRMED, TENTATIVE (cancelled instances are never returned). */
  status: string;
  /** The instance's original start (its RECURRENCE-ID), which stays the same when one instance is moved. */
  originalStart: number;
  recurring: boolean;
  /**
   * What an iAcquire workspace wrote on the event itself (X-IACQUIRE-APPOINTMENT / X-IACQUIRE-WORKSPACE), so a feed or CalDAV read can
   * leave out events this workspace added to the calendar. Each is null when the event carries no such marker.
   */
  marker: { appointmentId: string | null; workspaceId: string | null };
}

export interface ExpandOptions {
  from: number;
  to: number;
  /** For floating times and all-day events: the calendar owner's zone. */
  defaultTimeZone: string;
  maxInstances?: number;
}

export interface ExpandResult {
  instances: IcsInstance[];
  events: number;
  /** Events whose recurrence uses rule parts we don't expand (only their listed dates were used). */
  unsupported: number;
  /** Events we couldn't read (no usable start). */
  invalid: number;
  truncated: boolean;
  unknownZones: string[];
}

interface Timing {
  start: IcsDateValue;
  startMs: number;
  /** End rule: exact milliseconds (DTEND), or a nominal duration (DURATION), or nothing (zero length / one day). */
  end: { kind: "exact"; ms: number } | { kind: "days"; days: number } | { kind: "nominal"; d: IcsDuration } | { kind: "none" };
}

function timingOf(ev: IcsComponent, zone: (tzid: string | null) => ZoneFn): Timing | null {
  const ds = prop(ev, "DTSTART");
  if (!ds) return null;
  const start = parseDateValue(ds.value, param(ds, "TZID"), param(ds, "VALUE"));
  if (!start) return null;
  const startMs = instantOf(start, zone);
  const de = prop(ev, "DTEND");
  const du = prop(ev, "DURATION");
  if (de) {
    const end = parseDateValue(de.value, param(de, "TZID"), param(de, "VALUE"));
    if (!end) return null;
    if (start.type === "date" && end.type === "date") return { start, startMs, end: { kind: "days", days: end.day - start.day } };
    return { start, startMs, end: { kind: "exact", ms: instantOf(end, zone) - startMs } };
  }
  if (du) {
    const d = parseDuration(du.value);
    if (!d) return null;
    return { start, startMs, end: { kind: "nominal", d } };
  }
  return { start, startMs, end: start.type === "date" ? { kind: "days", days: 1 } : { kind: "none" } };
}

/** Start and end of one occurrence that starts at local (day, seconds). */
function occurrence(t: Timing, day: number, seconds: number, zone: (tzid: string | null) => ZoneFn): { start: number; end: number } {
  const s = t.start;
  const toInstant: ZoneFn = s.type === "date" ? (d) => zone(null)(d, 0) : s.utc ? (d, sec) => (d * 86400 + sec) * 1000 : zone(s.tzid);
  const start = toInstant(day, seconds);
  switch (t.end.kind) {
    case "exact": return { start, end: start + t.end.ms };
    case "days": return { start, end: zone(null)(day + t.end.days, 0) };
    case "nominal": {
      const d = t.end.d;
      const days = d.sign * (d.weeks * 7 + d.days);
      const base = days ? (s.type === "date" ? zone(null)(day + days, 0) : toInstant(day + days, seconds)) : start;
      return { start, end: base + d.sign * d.seconds * 1000 };
    }
    default: return { start, end: start };
  }
}

/** Rough length of one occurrence, for RDATEs given in another zone and for overrides that don't state their own end. */
function lengthMs(t: Timing): number {
  switch (t.end.kind) {
    case "exact": return t.end.ms;
    case "days": return t.end.days * DAY_MS;
    case "nominal": return t.end.d.sign * ((t.end.d.weeks * 7 + t.end.d.days) * DAY_MS + t.end.d.seconds * 1000);
    default: return 0;
  }
}

const statusOf = (ev: IcsComponent) => (prop(ev, "STATUS")?.value.trim().toUpperCase() || "CONFIRMED");
/** The iAcquire markers on an event (or, for an override that doesn't repeat them, on its series). Only id-shaped values are kept. */
function markerOf(ev: IcsComponent, master: IcsComponent | null): IcsInstance["marker"] {
  const read = (name: string) => {
    const v = (prop(ev, name) ?? (master ? prop(master, name) : undefined))?.value.trim() ?? "";
    return /^[0-9a-f-]{36}$/i.test(v) ? v.toLowerCase() : null;
  };
  return { appointmentId: read("X-IACQUIRE-APPOINTMENT"), workspaceId: read("X-IACQUIRE-WORKSPACE") };
}
const isTransparent = (ev: IcsComponent) => prop(ev, "TRANSP")?.value.trim().toUpperCase() === "TRANSPARENT";

/**
 * Every instance of every VEVENT that overlaps [from, to): recurrences expanded, EXDATEs removed, RECURRENCE-ID overrides applied,
 * cancelled events and instances dropped. Transparent instances are returned flagged so a caller can skip them for busy time.
 */
export function expandCalendar(input: string | IcsComponent[], o: ExpandOptions): ExpandResult {
  const roots = typeof input === "string" ? parseIcs(input) : input;
  const maxInstances = o.maxInstances ?? 20_000;
  const out: IcsInstance[] = [];
  let events = 0;
  let unsupported = 0;
  let invalid = 0;
  let truncated = false;
  const unknown = new Set<string>();
  const stopDay = Math.floor(o.to / DAY_MS) + 2;

  const push = (inst: IcsInstance) => {
    if (inst.end <= inst.start || inst.end <= o.from || inst.start >= o.to) return;
    if (out.length >= maxInstances) {
      truncated = true;
      return;
    }
    out.push(inst);
  };

  for (const cal of roots.filter((r) => r.name === "VCALENDAR")) {
    const zr = zoneResolver(cal, o.defaultTimeZone);
    const byUid = new Map<string, { master: IcsComponent | null; overrides: IcsComponent[] }>();
    let anon = 0;
    for (const ev of cal.components) {
      if (ev.name !== "VEVENT") continue;
      events++;
      const uid = prop(ev, "UID")?.value.trim() || `no-uid-${anon++}`;
      const g = byUid.get(uid) ?? { master: null, overrides: [] };
      if (prop(ev, "RECURRENCE-ID")) g.overrides.push(ev);
      else if (!g.master) g.master = ev;
      byUid.set(uid, g);
    }

    for (const [uid, g] of byUid) {
      // Overrides keyed by the original start they replace (and by day, for all-day series).
      const overrides = new Map<number, IcsComponent>();
      const overrideDays = new Map<number, IcsComponent>();
      for (const ov of g.overrides) {
        const rid = prop(ov, "RECURRENCE-ID")!;
        const v = parseDateValue(rid.value, param(rid, "TZID"), param(rid, "VALUE"));
        if (!v) {
          invalid++;
          continue;
        }
        overrides.set(instantOf(v, zr.zone), ov);
        if (v.type === "date") overrideDays.set(v.day, ov);
      }
      const used = new Set<IcsComponent>();
      const emitOverride = (ov: IcsComponent, originalStart: number, masterTiming: Timing | null) => {
        used.add(ov);
        if (statusOf(ov) === "CANCELLED") return;
        const t = timingOf(ov, zr.zone);
        if (!t && !masterTiming) {
          invalid++;
          return;
        }
        const start = t ? t.startMs : originalStart;
        const end = t && t.end.kind !== "none" ? occurrence(t, t.start.day, t.start.type === "datetime" ? t.start.seconds : 0, zr.zone).end : start + (masterTiming ? lengthMs(masterTiming) : 0);
        const allDay = (t ?? masterTiming)!.start.type === "date";
        push({ uid, start, end, allDay, transparent: isTransparent(ov), status: statusOf(ov), originalStart, recurring: true, marker: markerOf(ov, g.master) });
      };

      const master = g.master;
      if (master) {
        if (statusOf(master) === "CANCELLED") continue;
        const t = timingOf(master, zr.zone);
        if (!t) {
          invalid++;
          continue;
        }
        const rrProp = prop(master, "RRULE");
        const rule = rrProp ? parseRRule(rrProp.value) : null;
        if (rrProp && (!rule || rule.unsupported.length)) unsupported++;
        const startSecs = t.start.type === "datetime" ? t.start.seconds : 0;
        const exInstants = new Set<number>();
        const exDays = new Set<number>();
        for (const p of props(master, "EXDATE")) for (const v of dateValuesOf(p)) {
          if (v.type === "date") exDays.add(v.day);
          else exInstants.add(instantOf(v, zr.zone));
        }
        const occs: Array<{ start: number; end: number; day: number }> = [];
        if (rule && !rule.unsupported.length) {
          // Start far enough back that a long occurrence beginning before the window still counts.
          const fromDay = Math.floor((o.from - Math.max(0, lengthMs(t))) / DAY_MS) - 2;
          const until = rule.until ? untilFn(rule.until, (day, secs) => occurrence(t, day, secs, zr.zone).start) : null;
          let guard = 0;
          for (const occ of expandRRule(rule, { day: t.start.day, seconds: startSecs }, { stopDay, fromDay, untilInstant: until })) {
            if (occ.day > stopDay) break;
            if (++guard > 200_000) {
              truncated = true;
              break;
            }
            occs.push({ ...occurrence(t, occ.day, occ.seconds, zr.zone), day: occ.day });
          }
        } else occs.push({ ...occurrence(t, t.start.day, startSecs, zr.zone), day: t.start.day });
        for (const p of props(master, "RDATE")) for (const v of dateValuesOf(p)) {
          if (v.type === "date") occs.push({ ...occurrence(t, v.day, startSecs, zr.zone), day: v.day });
          else {
            const at = instantOf(v, zr.zone);
            occs.push({ start: at, end: at + lengthMs(t), day: v.day });
          }
        }
        const seen = new Set<number>();
        for (const occ of occs) {
          if (seen.has(occ.start)) continue;
          seen.add(occ.start);
          if (exInstants.has(occ.start) || exDays.has(occ.day)) continue;
          const ov = overrides.get(occ.start) ?? (t.start.type === "date" ? overrideDays.get(occ.day) : undefined);
          if (ov) {
            emitOverride(ov, occ.start, t);
            continue;
          }
          push({ uid, start: occ.start, end: occ.end, allDay: t.start.type === "date", transparent: isTransparent(master), status: statusOf(master), originalStart: occ.start, recurring: !!rule, marker: markerOf(master, null) });
        }
      }
      // Overrides that matched no generated instance (or whose series we were not given) still happen at their own time.
      for (const [originalStart, ov] of overrides) if (!used.has(ov)) emitOverride(ov, originalStart, null);
    }
    for (const z of zr.unknownZones) unknown.add(z);
  }
  out.sort((a, b) => a.start - b.start);
  return { instances: out, events, unsupported, invalid, truncated, unknownZones: [...unknown] };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Folds a content line at 75 octets without splitting a UTF-8 character (RFC 5545 3.1). */
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = "";
  let size = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    const limit = parts.length ? 74 : 75; // continuation lines start with a space
    if (size + n > limit) {
      parts.push(current);
      current = "";
      size = 0;
    }
    current += ch;
    size += n;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

const utcStamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

export interface OutboundIcsEvent {
  uid: string;
  start: Date;
  end: Date;
  summary: string;
  description?: string | null;
  location?: string | null;
  url?: string | null;
  status?: "CONFIRMED" | "TENTATIVE";
  sequence?: number;
  dtstamp?: Date;
  /** Extra X- properties, e.g. { "X-IACQUIRE-APPOINTMENT": id }. */
  extra?: Record<string, string>;
}

/** A complete VCALENDAR holding one event, times in UTC, CRLF line endings, folded and escaped. */
export function serializeEvent(ev: OutboundIcsEvent, prodId = "-//iAcquire//Native CRM//EN"): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${prodId}`,
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${ev.uid}`,
    `DTSTAMP:${utcStamp(ev.dtstamp ?? new Date())}`,
    `DTSTART:${utcStamp(ev.start)}`,
    `DTEND:${utcStamp(ev.end)}`,
    `SUMMARY:${escapeText(ev.summary)}`,
    ...(ev.description ? [`DESCRIPTION:${escapeText(ev.description)}`] : []),
    ...(ev.location ? [`LOCATION:${escapeText(ev.location)}`] : []),
    ...(ev.url && /^https:\/\//.test(ev.url) ? [`URL:${ev.url}`] : []),
    `STATUS:${ev.status ?? "CONFIRMED"}`,
    `SEQUENCE:${Math.max(0, Math.floor(ev.sequence ?? 0))}`,
    "TRANSP:OPAQUE",
    ...Object.entries(ev.extra ?? {}).filter(([k]) => /^X-[A-Z0-9-]+$/.test(k)).map(([k, v]) => `${k}:${escapeText(v)}`),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
