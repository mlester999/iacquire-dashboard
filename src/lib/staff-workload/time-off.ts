// Time off and profile edits: what is accepted, in one place the form, the service and the tests share. Pure; "today" is an argument.

import { addDays } from "@/lib/calendars/slots";
import { isDay, isSkill, SKILLS, type Skill } from "@/lib/staff-workload/sources";

export const TIME_OFF_KINDS = ["leave", "sick", "holiday", "training", "other"] as const;
export type TimeOffKind = (typeof TIME_OFF_KINDS)[number];

export const TIME_OFF_KIND_TEXT: Record<TimeOffKind, string> = {
  leave: "Leave",
  sick: "Sick day",
  holiday: "Public holiday",
  training: "Training",
  other: "Other",
};

export const MAX_NOTE_CHARS = 200;
/** The longest one entry may be, in days. The database repeats it. */
export const MAX_TIME_OFF_DAYS = 366;
/** A day off can be recorded this far back (yesterday's sick day) and this far ahead. */
export const TIME_OFF_PAST_DAYS = 31;
export const TIME_OFF_AHEAD_DAYS = 730;
/** Entries that have not ended yet, per person. */
export const MAX_OPEN_TIME_OFF = 100;

export interface TimeOffInput {
  startsOn: unknown;
  endsOn: unknown;
  partDay?: unknown;
  kind?: unknown;
  note?: unknown;
}

export interface CleanTimeOff {
  startsOn: string;
  endsOn: string;
  partDay: boolean;
  kind: TimeOffKind;
  note: string | null;
}

const dayNumber = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
};

/** Control characters and the no-break space become a space, runs of spaces become one, the ends are trimmed. One pass, no pattern that backtracks, so it is safe on any length. */
export function cleanNote(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let out = "";
  let space = false;
  for (const ch of value.slice(0, 2000)) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 32 || (code >= 127 && code <= 160)) {
      space = out.length > 0;
      continue;
    }
    if (space) out += " ";
    space = false;
    out += ch;
  }
  out = out.slice(0, MAX_NOTE_CHARS).trimEnd();
  return out.length ? out : null;
}

export type TimeOffResult = { ok: true; value: CleanTimeOff } | { ok: false; message: string };

export function checkTimeOff(input: TimeOffInput, today: string): TimeOffResult {
  if (!isDay(input.startsOn) || !isDay(input.endsOn)) return { ok: false, message: "Choose the first and the last day." };
  if (input.endsOn < input.startsOn) return { ok: false, message: "The last day cannot be before the first day." };
  if (dayNumber(input.endsOn) - dayNumber(input.startsOn) + 1 > MAX_TIME_OFF_DAYS) return { ok: false, message: `Time off can be at most ${MAX_TIME_OFF_DAYS} days in one entry.` };
  if (input.endsOn < addDays(today, -TIME_OFF_PAST_DAYS)) return { ok: false, message: `Time off that ended more than ${TIME_OFF_PAST_DAYS} days ago cannot be recorded.` };
  if (input.startsOn > addDays(today, TIME_OFF_AHEAD_DAYS)) return { ok: false, message: "Time off more than two years ahead cannot be recorded yet." };
  const partDay = input.partDay === true;
  if (partDay && input.startsOn !== input.endsOn) return { ok: false, message: "Half a day off can only be one day." };
  const kind = input.kind === undefined ? "leave" : input.kind;
  if (typeof kind !== "string" || !(TIME_OFF_KINDS as readonly string[]).includes(kind)) return { ok: false, message: "Choose what kind of time off it is." };
  if (input.note !== undefined && input.note !== null && typeof input.note !== "string") return { ok: false, message: "The note must be text." };
  return { ok: true, value: { startsOn: input.startsOn, endsOn: input.endsOn, partDay, kind: kind as TimeOffKind, note: cleanNote(input.note) } };
}

export interface ProfileInput {
  capacityPoints?: unknown;
  workingDays?: unknown;
  skills?: unknown;
}

export interface CleanProfile {
  capacityPoints?: number | null;
  workingDays?: number[];
  skills?: Partial<Record<Skill, number>>;
}

export type ProfileResult = { ok: true; value: CleanProfile } | { ok: false; message: string };

export function checkProfile(input: ProfileInput): ProfileResult {
  const out: CleanProfile = {};
  if (input.capacityPoints !== undefined) {
    const c = input.capacityPoints;
    if (c !== null && (typeof c !== "number" || !Number.isInteger(c) || c < 1 || c > 200)) return { ok: false, message: "Capacity is a whole number of points from 1 to 200, or empty to use the team default." };
    out.capacityPoints = c as number | null;
  }
  if (input.workingDays !== undefined) {
    const d = input.workingDays;
    if (!Array.isArray(d) || d.length < 1 || d.length > 7 || d.some((x) => typeof x !== "number" || !Number.isInteger(x) || x < 1 || x > 7) || new Set(d).size !== d.length) {
      return { ok: false, message: "Choose the days the person works, at least one, from Monday (1) to Sunday (7)." };
    }
    out.workingDays = [...(d as number[])].sort((a, b) => a - b);
  }
  if (input.skills !== undefined) {
    const s = input.skills;
    if (typeof s !== "object" || s === null || Array.isArray(s)) return { ok: false, message: "Skills must be a list of skills with a level from 1 to 3." };
    const skills: Partial<Record<Skill, number>> = {};
    for (const [key, level] of Object.entries(s)) {
      if (level === null || level === 0) continue;
      if (!isSkill(key)) return { ok: false, message: `"${key.slice(0, 40)}" is not a skill. The skills are ${SKILLS.join(", ")}.` };
      if (level !== 1 && level !== 2 && level !== 3) return { ok: false, message: "A skill level is 1, 2 or 3." };
      skills[key] = level;
    }
    out.skills = skills;
  }
  return Object.keys(out).length ? { ok: true, value: out } : { ok: false, message: "Nothing to change." };
}
