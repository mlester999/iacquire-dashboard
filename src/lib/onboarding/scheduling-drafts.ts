// Pure rules that turn the booking answers of the questionnaire into a plan for a DRAFT calendar and its appointment types, so a client does not type the same appointment
// types and hours again in CRM scheduling. A draft takes no bookings: it has no booking page, is never the default and no host, and goes live only when someone assigns hosts
// and activates it after the existing checks (src/server/calendars/activation.ts). Nothing here reads or writes anything.
import { toMinutes, WEEKDAYS, type BusinessHours } from "@/lib/messaging";
import { isValidTimeZone, type WeeklyRule } from "@/lib/calendars/slots";
import type { Answers } from "./types";

export const DRAFT_CALENDAR_NAME = "Appointments";
export const DRAFT_CALENDAR_DESCRIPTION = "Drafted from your onboarding answers. It takes no bookings until a team member is assigned to it and it has been checked and activated.";

/** What the notice answer means, in minutes. An unanswered question keeps the 2 hours a hand-made appointment type starts with. */
export const NOTICE_MINUTES: Record<string, number> = { none: 0, "2h": 120, "24h": 1440, "48h": 2880 };
export const DEFAULT_NOTICE_MINUTES = 120;

/** The limits of a stored appointment type (src/server/calendars/setup.ts and the table in migration 0029). */
const NAME_MAX = 80;
const MINUTES_MIN = 5;
const MINUTES_MAX = 720;
const MAX_RULES = 50;
const MAX_TYPES = 10;

export type DraftLocationKind = "in_person" | "phone" | "video";

export interface DraftAppointmentType {
  name: string;
  durationMinutes: number;
  locationKind: DraftLocationKind;
  minNoticeMinutes: number;
}

export interface SchedulingDraftPlan {
  /** Why nothing is drafted, in the owner's terms; null when there is a calendar to draft. */
  reason: string | null;
  calendarName: string;
  description: string;
  /** The workspace time zone the owner gave, only when it is a real one. */
  timezone: string | null;
  /** The weekly hours suggested for the people who will host it. Never applied to anyone by itself. */
  hoursTemplate: WeeklyRule[];
  hoursSource: "booking_hours" | "business_hours" | "none";
  types: DraftAppointmentType[];
  /** Types the owner listed that cannot be stored, with the reason. */
  skipped: Array<{ name: string; why: string }>;
}

const LOCATION: Record<string, DraftLocationKind> = { in_person: "in_person", phone: "phone", video: "video" };

/** Sunday is 0, minutes run from midnight. A range that overlaps an earlier one of the same day is dropped, as it is in a stored template. */
export function weeklyRulesFromHours(hours: BusinessHours | null | undefined): WeeklyRule[] {
  if (!hours || typeof hours !== "object") return [];
  const out: WeeklyRule[] = [];
  WEEKDAYS.forEach((day, weekday) => {
    const ranges = Array.isArray(hours[day]) ? [...hours[day]!].filter((r) => Array.isArray(r) && r.length === 2).sort((x, y) => toMinutes(x[0]) - toMinutes(y[0])) : [];
    const rules: WeeklyRule[] = [];
    for (const range of ranges) {
      if (!Array.isArray(range) || range.length !== 2) continue;
      const startMinute = toMinutes(range[0]);
      const endMinute = toMinutes(range[1]);
      if (endMinute <= startMinute || rules.some((r) => startMinute < r.endMinute && endMinute > r.startMinute)) continue;
      rules.push({ weekday, startMinute, endMinute });
    }
    out.push(...rules);
  });
  return out.slice(0, MAX_RULES);
}

const hasDays = (value: unknown): value is BusinessHours => Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length > 0;

/** What the booking answers say a draft calendar should hold. Only the answers given: nothing is invented. */
export function planSchedulingDrafts(a: Answers): SchedulingDraftPlan {
  const timezone = typeof a["a.timezone"] === "string" && isValidTimeZone(a["a.timezone"] as string) ? (a["a.timezone"] as string) : null;
  const empty = (reason: string, skipped: SchedulingDraftPlan["skipped"] = []): SchedulingDraftPlan => ({
    reason, calendarName: DRAFT_CALENDAR_NAME, description: DRAFT_CALENDAR_DESCRIPTION, timezone, hoursTemplate: [], hoursSource: "none", types: [], skipped,
  });
  if (a["b.appointments"] === false) return empty("You said you don't book appointments, so no booking calendar was drafted.");
  if (a["b.appointments"] !== true) return empty("You did not say whether you book appointments, so no booking calendar was drafted.");

  const notice = typeof a["d.appt_notice"] === "string" && a["d.appt_notice"] in NOTICE_MINUTES ? NOTICE_MINUTES[a["d.appt_notice"] as string] : DEFAULT_NOTICE_MINUTES;
  const rows = Array.isArray(a["d.appt_types"]) ? (a["d.appt_types"] as Array<Record<string, string>>) : [];
  if (!rows.length) return empty("No appointment types were listed, so no booking calendar was drafted.");

  const types: DraftAppointmentType[] = [];
  const skipped: SchedulingDraftPlan["skipped"] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const name = String(row?.name ?? "").trim();
    if (!name) continue;
    const minutes = Number(row.minutes);
    if (name.length > NAME_MAX) skipped.push({ name, why: `A name is up to ${NAME_MAX} characters.` });
    else if (seen.has(name.toLowerCase())) skipped.push({ name, why: "Already listed with the same name." });
    else if (!Number.isInteger(minutes) || minutes < MINUTES_MIN || minutes > MINUTES_MAX) skipped.push({ name, why: "A length is 5 minutes to 12 hours." });
    else if (types.length >= MAX_TYPES) skipped.push({ name, why: `A calendar drafts up to ${MAX_TYPES} types.` });
    else {
      seen.add(name.toLowerCase());
      types.push({ name, durationMinutes: minutes, locationKind: LOCATION[row.mode] ?? "phone", minNoticeMinutes: notice });
    }
  }
  if (!types.length) return empty("No usable appointment type was listed, so no booking calendar was drafted.", skipped);

  const booking = hasDays(a["d.appt_availability"]) ? weeklyRulesFromHours(a["d.appt_availability"] as BusinessHours) : [];
  const opening = !booking.length && hasDays(a["a.hours"]) ? weeklyRulesFromHours(a["a.hours"] as BusinessHours) : [];
  return {
    reason: null,
    calendarName: DRAFT_CALENDAR_NAME,
    description: DRAFT_CALENDAR_DESCRIPTION,
    timezone,
    hoursTemplate: booking.length ? booking : opening,
    hoursSource: booking.length ? "booking_hours" : opening.length ? "business_hours" : "none",
    types,
    skipped,
  };
}

/** What a submission did about the draft calendar, for the server to return and the screen to say. */
export interface SchedulingDraftOutcome {
  /** created: a new draft calendar. updated: types added to the draft made earlier. unchanged: the draft already had everything. skipped: nothing was drafted. */
  state: "created" | "updated" | "unchanged" | "skipped";
  reason?: string;
  calendarId?: string;
  typesAdded: number;
  skipped: Array<{ name: string; why: string }>;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One honest sentence for the owner, or null when nothing changed that they need to hear about. */
export function schedulingDraftMessage(o: SchedulingDraftOutcome): string | null {
  if (o.state !== "created" && o.state !== "updated") return null;
  const left = o.skipped.length ? ` We left out ${o.skipped.map((s) => s.name).join(", ")}: add ${o.skipped.length === 1 ? "it" : "them"} by hand in Calendars & Types.` : "";
  if (o.state === "created") {
    return `We drafted a booking calendar with ${plural(o.typesAdded, "appointment type", "appointment types")} from your answers. It takes no bookings until you assign a host and activate it.${left}`;
  }
  return `We added ${plural(o.typesAdded, "appointment type", "appointment types")} to your draft booking calendar. It still takes no bookings until you activate it.${left}`;
}
