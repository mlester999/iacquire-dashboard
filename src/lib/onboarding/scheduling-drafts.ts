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

/**
 * What the booking-policy answers mean for every drafted type. An unanswered question keeps what a hand-made appointment type starts with (no gap, confirmed automatically,
 * customers may change a booking, no video tool): nothing is assumed on the client's behalf.
 */
export const BUFFER_MINUTES: Record<string, number> = { none: 0, "10m": 10, "15m": 15, "30m": 30 };
export const CUSTOMER_CHANGES: Record<string, { allow: boolean; cutoffMinutes: number }> = {
  free: { allow: true, cutoffMinutes: 0 },
  "24h": { allow: true, cutoffMinutes: 1440 },
  "2h": { allow: true, cutoffMinutes: 120 },
  none: { allow: false, cutoffMinutes: 0 },
};
/** "own" means the client sends their own link: it becomes a custom_link type only when they gave a valid https address (planSchedulingDrafts), otherwise it stays "none". */
export const VIDEO_PROVIDER: Record<string, DraftMeetingProvider> = { google_meet: "google_meet", microsoft_teams: "microsoft_teams", own: "none" };
/** The calendar the client keeps their appointments in today. Exposed on the plan only: nothing stores it and nothing connects to it here. */
export type BusyCalendarChoice = "google" | "microsoft" | "none";
export type HostChoice = "owner" | "team";
const SLOT_INTERVAL_MAX = 240;
const MEETING_LINK_MAX = 500;

/** The limits of a stored appointment type (src/server/calendars/setup.ts and the table in migration 0029). */
const NAME_MAX = 80;
const MINUTES_MIN = 5;
const MINUTES_MAX = 720;
const MAX_RULES = 50;
const MAX_TYPES = 10;

export type DraftLocationKind = "in_person" | "phone" | "video";
/** A fixed link is drafted only from the client's own valid https address (the database refuses custom_link without one). */
export type DraftMeetingProvider = "none" | "google_meet" | "microsoft_teams" | "custom_link";

export interface DraftAppointmentType {
  name: string;
  durationMinutes: number;
  locationKind: DraftLocationKind;
  minNoticeMinutes: number;
  bufferAfterMinutes: number;
  /** A person confirms the booking before it counts. */
  requiresConfirmation: boolean;
  allowCustomerChanges: boolean;
  changeCutoffMinutes: number;
  /** Only ever set on a video type, from the client's own choice. */
  meetingProvider: DraftMeetingProvider;
  /** The client's own https address; set exactly when meetingProvider is custom_link. */
  meetingLink: string | null;
  /** Start times every N minutes; null keeps the type's own length as the step (see slotIntervalFor). */
  slotIntervalMinutes: number | null;
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
  /** Who the client said takes the appointments; null when they did not say. Recorded as a host only through proposeHostFromAnswers, and never with hours. */
  hostChoice: HostChoice | null;
  /** The outside calendar whose busy times should block bookings, as the client said; null when they did not say. Not stored here. */
  busyCalendar: BusyCalendarChoice | null;
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

/**
 * Start times for a type whose length is not a multiple of 15: the length plus the gap after it, rounded up to 5 and never under 15, so a 50-minute type with a 10-minute gap
 * offers a time every hour instead of at 9:20, 10:10 and so on. A type whose length is a multiple of 15 keeps the type's own step (null), as does a result the database refuses.
 */
export function slotIntervalFor(durationMinutes: number, bufferAfterMinutes: number): number | null {
  if (!Number.isInteger(durationMinutes) || durationMinutes <= 0 || durationMinutes % 15 === 0) return null;
  const interval = Math.max(15, Math.ceil((durationMinutes + Math.max(0, bufferAfterMinutes)) / 5) * 5);
  return interval > SLOT_INTERVAL_MAX ? null : interval;
}

/** The client's own meeting link, only when it is a real https address the database accepts. Anything else is not a link. */
export function validMeetingLink(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const link = raw.trim();
  if (!link || link.length > MEETING_LINK_MAX || /\s/.test(link) || !/^https:\/\/[^/]/.test(link)) return null;
  try {
    const url = new URL(link);
    return url.protocol === "https:" && url.hostname.includes(".") && !url.username && !url.password ? link : null;
  } catch {
    return null;
  }
}

const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | null => allowed.find((v) => v === value) ?? null;

const hasDays = (value: unknown): value is BusinessHours => Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length > 0;

/** What the booking answers say a draft calendar should hold. Only the answers given: nothing is invented. */
export function planSchedulingDrafts(a: Answers): SchedulingDraftPlan {
  const timezone = typeof a["a.timezone"] === "string" && isValidTimeZone(a["a.timezone"] as string) ? (a["a.timezone"] as string) : null;
  const empty = (reason: string, skipped: SchedulingDraftPlan["skipped"] = []): SchedulingDraftPlan => ({
    reason, calendarName: DRAFT_CALENDAR_NAME, description: DRAFT_CALENDAR_DESCRIPTION, timezone, hoursTemplate: [], hoursSource: "none", types: [], skipped, hostChoice: null, busyCalendar: null,
  });
  if (a["b.appointments"] === false) return empty("You said you don't book appointments, so no booking calendar was drafted.");
  if (a["b.appointments"] !== true) return empty("You did not say whether you book appointments, so no booking calendar was drafted.");

  const notice = typeof a["d.appt_notice"] === "string" && a["d.appt_notice"] in NOTICE_MINUTES ? NOTICE_MINUTES[a["d.appt_notice"] as string] : DEFAULT_NOTICE_MINUTES;
  const rows = Array.isArray(a["d.appt_types"]) ? (a["d.appt_types"] as Array<Record<string, string>>) : [];
  if (!rows.length) return empty("No appointment types were listed, so no booking calendar was drafted.");
  const pick = <T>(id: string, table: Record<string, T>, fallback: T): T => (typeof a[id] === "string" && Object.hasOwn(table, a[id] as string) ? table[a[id] as string] : fallback);
  const buffer = pick("d.appt_buffer", BUFFER_MINUTES, 0);
  const confirmation = a["d.appt_confirmation"] === "manual";
  const changes = pick("d.appt_changes", CUSTOMER_CHANGES, { allow: true, cutoffMinutes: 0 });
  const ownLink = a["d.appt_video"] === "own" ? validMeetingLink(a["d.appt_video_link"]) : null;
  const video: DraftMeetingProvider = ownLink ? "custom_link" : pick<DraftMeetingProvider>("d.appt_video", VIDEO_PROVIDER, "none");

  const types: DraftAppointmentType[] = [];
  const skipped: SchedulingDraftPlan["skipped"] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const name = String(row?.name ?? "").trim();
    if (!name) continue;
    const minutes = Number(row.minutes);
    // The left-out name is echoed to the owner, so a name too long to store is shown cut short.
    if (name.length > NAME_MAX) skipped.push({ name: `${name.slice(0, NAME_MAX)}…`, why: `A name is up to ${NAME_MAX} characters.` });
    else if (seen.has(name.toLowerCase())) skipped.push({ name, why: "Already listed with the same name." });
    else if (!Number.isInteger(minutes) || minutes < MINUTES_MIN || minutes > MINUTES_MAX) skipped.push({ name, why: "A length is 5 minutes to 12 hours." });
    else if (types.length >= MAX_TYPES) skipped.push({ name, why: `A calendar drafts up to ${MAX_TYPES} types.` });
    else {
      seen.add(name.toLowerCase());
      const locationKind = LOCATION[row.mode] ?? "phone";
      const meetingProvider = locationKind === "video" ? video : "none";
      types.push({
        name, durationMinutes: minutes, locationKind, minNoticeMinutes: notice, bufferAfterMinutes: buffer, requiresConfirmation: confirmation,
        allowCustomerChanges: changes.allow, changeCutoffMinutes: changes.cutoffMinutes, meetingProvider,
        meetingLink: meetingProvider === "custom_link" ? ownLink : null, slotIntervalMinutes: slotIntervalFor(minutes, buffer),
      });
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
    hostChoice: oneOf(a["d.appt_host"], ["owner", "team"]),
    busyCalendar: oneOf(a["d.appt_busy_calendar"], ["google", "microsoft", "none"]),
  };
}

/** What a submission did about the host the client chose. "assigned" means a person was added to the draft calendar, without any working hours. */
export interface SchedulingHostOutcome {
  choice: HostChoice;
  /** assigned: the submitter was added. unchanged: they already were, or were deliberately taken off. waiting: the client's team members become hosts when they accept their invitation. skipped: nobody was added (see reason). */
  state: "assigned" | "unchanged" | "waiting" | "skipped";
  reason?: string;
}

/** What a submission did about the draft calendar, for the server to return and the screen to say. */
export interface SchedulingDraftOutcome {
  /** created: a new draft calendar. updated: types added to the draft made earlier. unchanged: the draft already had everything. skipped: nothing was drafted. */
  state: "created" | "updated" | "unchanged" | "skipped";
  reason?: string;
  calendarId?: string;
  typesAdded: number;
  skipped: Array<{ name: string; why: string }>;
  /** The host the client chose, when they chose one. Never carries hours: hours are written only by the launch step the client approves. */
  host?: SchedulingHostOutcome;
  /** The weekly hours the client's answers suggest. Shown for the client to approve; nothing here applies them to anyone. */
  proposedHours?: WeeklyRule[];
  /** Only when the calendar is already live: how the answers now differ from it, in plain words. Empty when they agree. A live calendar is never edited from here. */
  drift?: string[];
}

/** The appointment type of the live onboarding calendar, as the server read it, for answerDrift. */
export interface LiveAppointmentType {
  name: string;
  durationMinutes: number;
  minNoticeMinutes: number;
  bufferAfterMinutes: number;
  requiresConfirmation: boolean;
  allowCustomerChanges: boolean;
  changeCutoffMinutes: number;
  meetingProvider: DraftMeetingProvider;
  meetingLink: string | null;
}

const minutesPhrase = (m: number) => (m >= 60 && m % 60 === 0 ? `${m / 60} hour${m === 60 ? "" : "s"}` : `${m} minutes`);
const PROVIDER_PHRASE: Record<DraftMeetingProvider, string> = { none: "no meeting tool", google_meet: "Google Meet", microsoft_teams: "Microsoft Teams", custom_link: "your own meeting link" };

const noticePhrase = (m: number) => (m === 0 ? "no notice needed" : `${minutesPhrase(m)} notice`);
const gapPhrase = (m: number) => (m === 0 ? "no gap after appointments" : `a ${m}-minute gap after appointments`);
const confirmationPhrase = (manual: boolean) => (manual ? "a person confirms each booking" : "bookings are confirmed automatically");
const changesPhrase = (allow: boolean, cutoff: number) => (!allow ? "customers may not change a booking themselves" : cutoff > 0 ? `customers may change a booking until ${minutesPhrase(cutoff)} before` : "customers may change a booking any time");
const videoPhrase = (provider: DraftMeetingProvider, link: string | null) => `${PROVIDER_PHRASE[provider]}${provider === "custom_link" && link ? ` (${link})` : ""}`;
const answeredIn = (id: string, table: Record<string, unknown>) => (a: Answers) => typeof a[id] === "string" && Object.hasOwn(table, a[id] as string);

interface DriftField {
  /** Whether the client's answers say anything about it; an unanswered question never counts as a difference. */
  answered: (a: Answers) => boolean;
  planned: (t: DraftAppointmentType) => string;
  live: (t: LiveAppointmentType) => string;
}

const DRIFT_FIELDS: DriftField[] = [
  { answered: () => true, planned: (t) => `${t.durationMinutes} minutes long`, live: (t) => `${t.durationMinutes} minutes long` },
  { answered: answeredIn("d.appt_notice", NOTICE_MINUTES), planned: (t) => noticePhrase(t.minNoticeMinutes), live: (t) => noticePhrase(t.minNoticeMinutes) },
  { answered: answeredIn("d.appt_buffer", BUFFER_MINUTES), planned: (t) => gapPhrase(t.bufferAfterMinutes), live: (t) => gapPhrase(t.bufferAfterMinutes) },
  { answered: (a) => a["d.appt_confirmation"] === "manual" || a["d.appt_confirmation"] === "auto", planned: (t) => confirmationPhrase(t.requiresConfirmation), live: (t) => confirmationPhrase(t.requiresConfirmation) },
  { answered: answeredIn("d.appt_changes", CUSTOMER_CHANGES), planned: (t) => changesPhrase(t.allowCustomerChanges, t.changeCutoffMinutes), live: (t) => changesPhrase(t.allowCustomerChanges, t.changeCutoffMinutes) },
];

const joinNames = (names: string[]) => (names.length < 3 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/**
 * How the booking answers now differ from the live onboarding calendar, in plain words, for a client who changed an answer after the calendar went live. Pure: it compares the
 * plan the answers describe with the live appointment types, by name, and only on the points the client actually answered. A type that exists live but not in the answers is
 * not a difference (the client may have added it), and nothing here says anything about hours (a person's hours belong to that person). Empty when they agree.
 */
export function answerDrift(answers: Answers, live: LiveAppointmentType[]): string[] {
  const plan = planSchedulingDrafts(answers);
  if (plan.reason) return [];
  const byName = new Map(live.map((t) => [t.name.trim().toLowerCase(), t]));
  const missing: string[] = [];
  const groups = new Map<string, { names: string[]; planned: string; live: string }>();
  const note = (name: string, planned: string, liveText: string) => {
    const key = `${planned}\u0000${liveText}`;
    const group = groups.get(key) ?? { names: [], planned, live: liveText };
    group.names.push(name);
    groups.set(key, group);
  };
  const video = answers["d.appt_video"];
  // "I send my own link" with no link yet plans "no meeting tool", and the question tells the client to add the link in calendar settings later. That is the expected end state,
  // not a difference, so it is compared only once the answers carry a link.
  const videoAnswered = typeof video === "string" && Object.hasOwn(VIDEO_PROVIDER, video) && !(video === "own" && !validMeetingLink(answers["d.appt_video_link"]));
  for (const t of plan.types) {
    const l = byName.get(t.name.trim().toLowerCase());
    if (!l) {
      missing.push(t.name);
      continue;
    }
    for (const f of DRIFT_FIELDS) if (f.answered(answers) && f.planned(t) !== f.live(l)) note(t.name, f.planned(t), f.live(l));
    if (t.locationKind === "video" && videoAnswered) {
      const planned = videoPhrase(t.meetingProvider, t.meetingLink);
      const current = videoPhrase(l.meetingProvider, l.meetingLink);
      if (planned !== current) note(t.name, planned, current);
    }
  }
  const out = [...groups.values()].map((g) => `${joinNames(g.names)}: your answers now say ${g.planned}, your live calendar has ${g.live}.`);
  for (const name of missing) out.push(`${name}: your answers list this appointment type, your live calendar has none with that name.`);
  return out.slice(0, 20);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One honest sentence for the owner, or null when nothing changed that they need to hear about. */
export function schedulingDraftMessage(o: SchedulingDraftOutcome): string | null {
  // Being named as the host is news even when no appointment type was added, and it never says hours were set: they were not.
  const host = o.host?.state === "assigned" ? " You are now the host of this calendar. No working hours are set for you yet: you confirm them in your launch checklist before it can go live." : "";
  if (o.state !== "created" && o.state !== "updated") return host ? host.trim() : null;
  const left = o.skipped.length ? ` We left out ${o.skipped.map((s) => s.name).join(", ")}: add ${o.skipped.length === 1 ? "it" : "them"} by hand in Calendars & Types.` : "";
  if (o.state === "created") {
    return `We drafted a booking calendar with ${plural(o.typesAdded, "appointment type", "appointment types")} from your answers. It takes no bookings until you assign a host and activate it.${left}${host}`;
  }
  return `We added ${plural(o.typesAdded, "appointment type", "appointment types")} to your draft booking calendar. It still takes no bookings until you activate it.${left}${host}`;
}
