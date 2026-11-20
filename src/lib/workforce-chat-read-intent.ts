import type { WorkforceRoleKey } from "@/lib/agents";
import { addDays, isValidTimeZone, weekdayOf, zonedDate } from "@/lib/calendars/slots";

/** Local calendar dates. `endDateExclusive` is the first date outside the requested window. */
export interface WorkforceChatReadWindow {
  startDate: string;
  endDateExclusive: string;
  label: string;
}

export type WorkforceChatReadIntent =
  | { kind: "none" }
  | { kind: "new_leads"; window: WorkforceChatReadWindow }
  | { kind: "followup_ranking" }
  | { kind: "appointments_on"; date: string }
  | { kind: "approvals_waiting" }
  | { kind: "completed_activity"; window: WorkforceChatReadWindow }
  | { kind: "clarify"; question: string };

type DateResolution = { kind: "date"; date: string } | { kind: "clarify"; question: string } | { kind: "none" };

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const NONE: WorkforceChatReadIntent = { kind: "none" };
const DATE_CLARIFICATION = "Which exact date should I check? Give a weekday, today or tomorrow, or an ISO date such as 2026-11-16. I won't guess.";
const WINDOW_CLARIFICATION = "Which date or period should I use? Give a weekday, today or yesterday, this week, last week, or an ISO date such as 2026-11-16. I won't guess.";

function dateIsValid(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

function dateFromText(text: string, today: string): DateResolution {
  // Without a locale there is no safe way to choose whether 03/04 means March 4 or April 3.
  if (/(?<![\d-])\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?(?![\d-])/.test(text)) {
    return { kind: "clarify", question: "That date could mean more than one day. Please use an ISO date such as 2026-11-16; I won't guess." };
  }

  const isoDates = [...text.matchAll(/(?:^|[^\d])(\d{4}-\d{2}-\d{2})(?=$|[^\d])/g)].map((match) => match[1]);
  if (isoDates.length > 1) return { kind: "clarify", question: "Please give one date at a time, using an ISO date such as 2026-11-16. I won't choose between dates." };
  const otherDatePhrases = [
    ...text.matchAll(/\bday before yesterday\b|\byesterday\b|\btoday\b|\btomorrow\b/g),
    ...text.matchAll(/\b(?:(?:next|this|last)\s+)?(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/g),
    ...text.matchAll(/\b(?:this|last|next)\s+(?:week|month)\b/g),
    ...text.matchAll(/\b(?:last|past)\s+(?:7|30)\s+days\b/g),
  ];
  if (otherDatePhrases.length + isoDates.length > 1) {
    return { kind: "clarify", question: "Please give one date or period at a time. I won't choose between multiple date references." };
  }
  if (isoDates.length === 1) {
    return dateIsValid(isoDates[0])
      ? { kind: "date", date: isoDates[0] }
      : { kind: "clarify", question: "That ISO date isn't a valid calendar date. Please give a valid date such as 2026-11-16." };
  }

  if (/\bday before yesterday\b/.test(text)) return { kind: "date", date: addDays(today, -2) };
  if (/\byesterday\b/.test(text)) return { kind: "date", date: addDays(today, -1) };
  if (/\btoday\b/.test(text)) return { kind: "date", date: today };
  if (/\btomorrow\b/.test(text)) return { kind: "date", date: addDays(today, 1) };

  const namedDay = text.match(/\b(?:(next|this|last)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (namedDay) {
    const modifier = namedDay[1];
    const targetDay = WEEKDAYS[namedDay[2]];
    const currentDay = weekdayOf(today);
    if (modifier === "this") {
      const mondayOffset = currentDay === 0 ? -6 : 1 - currentDay;
      return { kind: "date", date: addDays(today, mondayOffset + (targetDay === 0 ? 6 : targetDay - 1)) };
    }
    if (modifier === "last") {
      let delta = (targetDay - currentDay + 7) % 7;
      if (delta === 0) delta = 7;
      return { kind: "date", date: addDays(today, delta - 7) };
    }
    let delta = (targetDay - currentDay + 7) % 7;
    if (delta === 0) delta = 7;
    return { kind: "date", date: addDays(today, delta) };
  }

  // Other explicit date formats (for example, “November 16”) are not silently interpreted.
  if (/\b(?:on|for|by)\s+(?:the\s+)?\d{1,2}(?:st|nd|rd|th)?\b/.test(text)
    || /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/.test(text)) {
    return { kind: "clarify", question: "Please give that date as an ISO date such as 2026-11-16 so I can resolve it without guessing." };
  }
  return { kind: "none" };
}

function mondayOf(date: string): string {
  const day = weekdayOf(date);
  return addDays(date, day === 0 ? -6 : 1 - day);
}

function monthStart(date: string, delta: number): string {
  const [year, month] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1 + delta, 1)).toISOString().slice(0, 10);
}

function windowFromDates(startDate: string, endDateExclusive: string, label: string): WorkforceChatReadWindow {
  return { startDate, endDateExclusive, label };
}

function readWindow(text: string, today: string): { kind: "window"; window: WorkforceChatReadWindow } | { kind: "clarify"; question: string } {
  const hasExplicitTimeRange = /\b(?:today|yesterday|day before yesterday|this week|last week|next week|this month|last month|next month|last 7 days|past 7 days|last 30 days|past 30 days|sunday|monday|tuesday|wednesday|thursday|friday|saturday|\d{4}-\d{2}-\d{2})\b|(?<![\d-])\d{1,2}[/-]\d{1,2}(?![\d-])/.test(text);
  const date = dateFromText(text, today);
  if (date.kind === "clarify") return date;
  if (date.kind === "date") return { kind: "window", window: windowFromDates(date.date, addDays(date.date, 1), date.date) };

  if (/\bthis week\b/.test(text)) {
    const start = mondayOf(today);
    return { kind: "window", window: windowFromDates(start, addDays(start, 7), "this week") };
  }
  if (/\blast week\b/.test(text)) {
    const start = addDays(mondayOf(today), -7);
    return { kind: "window", window: windowFromDates(start, addDays(start, 7), "last week") };
  }
  if (/\bnext week\b/.test(text)) {
    const start = addDays(mondayOf(today), 7);
    return { kind: "window", window: windowFromDates(start, addDays(start, 7), "next week") };
  }
  if (/\bthis month\b/.test(text)) {
    const start = monthStart(today, 0);
    return { kind: "window", window: windowFromDates(start, monthStart(today, 1), "this month") };
  }
  if (/\blast month\b/.test(text)) {
    const start = monthStart(today, -1);
    return { kind: "window", window: windowFromDates(start, monthStart(today, 0), "last month") };
  }
  if (/\bnext month\b/.test(text)) {
    const start = monthStart(today, 1);
    return { kind: "window", window: windowFromDates(start, monthStart(today, 2), "next month") };
  }
  const rolling = text.match(/\b(?:last|past)\s+(7|30)\s+days\b/);
  if (rolling) {
    const days = Number(rolling[1]);
    const start = addDays(today, -(days - 1));
    return { kind: "window", window: windowFromDates(start, addDays(today, 1), `last ${days} days`) };
  }

  if (hasExplicitTimeRange) return { kind: "clarify", question: WINDOW_CLARIFICATION };
  // An unqualified “new leads” or “completed activity” request uses the current local day.
  return { kind: "window", window: windowFromDates(today, addDays(today, 1), "today") };
}

/**
 * Deterministic, read-only Growth Partner questions. Uses workspace-local dates for every range.
 * “Review my appointments” / “booking risks” and “review operations” are intentionally left to
 * the existing reviewed-job routes; this parser only handles listing appointments on a date.
 */
export function parseWorkforceChatReadIntent(
  role: WorkforceRoleKey,
  content: string,
  options: { now: Date | number; timeZone: string },
): WorkforceChatReadIntent {
  if (role !== "growth_partner") return NONE;
  const text = content.replace(/\s+/g, " ").trim().slice(0, 2000).toLocaleLowerCase("en-US");
  if (!text) return NONE;

  // Keep the existing queued reviews intact. The intent hook runs before assignment routing, so
  // this explicit exclusion is what preserves the legacy review job for these requests.
  if (/\breview\b.{0,60}\b(?:operations?|appointments?|booking requests?|booking risks?)\b/.test(text)) return NONE;
  if (/\b(?:availability|available slots?|available times?|open slots?)\b/.test(text)) return NONE;

  const researchReview = /\b(?:lead|leads|prospect|prospects)\s+research\b|\bresearch candidates?\b/.test(text);
  if (!researchReview && (/\b(?:new|recent|latest)\s+(?:crm\s+)?(?:leads?|prospects?)\b/.test(text)
    || /\b(?:leads?|prospects?)\b.{0,40}\b(?:created|added|came in|arrived)\b/.test(text))) {
    if (!isValidTimeZone(options.timeZone)) return { kind: "clarify", question: "The workspace time zone isn't valid, so I can't safely choose a local date. Ask an owner to check workspace settings." };
    const today = zonedDate(typeof options.now === "number" ? options.now : options.now.getTime(), options.timeZone);
    const parsed = readWindow(text, today);
    return parsed.kind === "clarify" ? parsed : { kind: "new_leads", window: parsed.window };
  }

  if ((/\b(?:which|what|who)\b.{0,80}\b(?:leads?|prospects?)\b.{0,60}\b(?:follow[ -]?ups?|contact|prioriti[sz]e)\b/.test(text)
      || /\b(?:follow[ -]?ups?|contact)\b.{0,60}\b(?:which|who|leads?|prospects?)\b/.test(text))
    && !/\b(?:review|audit)\b.{0,40}\b(?:hot leads?|lead priorities|promising leads?)\b/.test(text)) {
    return { kind: "followup_ranking" };
  }

  if (/\b(?:which tasks? need|tasks? awaiting|approvals? (?:waiting|pending)|(?:waiting|pending) approvals?|what approvals? (?:are )?(?:waiting|pending)|approvals? for me)\b/.test(text)) {
    return { kind: "approvals_waiting" };
  }

  if (/\b(?:activities?|activity|work|jobs?)\b.{0,50}\b(?:completed|finished|done)\b/.test(text)
    || /\b(?:completed|finished|done)\s+(?:activities?|activity|work|jobs?)\b/.test(text)
    || /\b(?:what|which)\b.{0,50}\b(?:completed|finished|done)\b.{0,40}\b(?:this week|today|yesterday|activity|work|jobs?)\b/.test(text)
    || /\b(?:what did|what have) (?:you|we|i) (?:complete|finish|do)\b/.test(text)) {
    if (!isValidTimeZone(options.timeZone)) return { kind: "clarify", question: "The workspace time zone isn't valid, so I can't safely choose a local date. Ask an owner to check workspace settings." };
    const today = zonedDate(typeof options.now === "number" ? options.now : options.now.getTime(), options.timeZone);
    const parsed = readWindow(text, today);
    return parsed.kind === "clarify" ? parsed : { kind: "completed_activity", window: parsed.window };
  }

  const mentionsAppointments = /\b(?:appointments?|bookings?)\b/.test(text);
  const asksForAppointmentList = /\b(?:show|list|find|when|what|which|how many|any|check|appointments?|bookings?)\b/.test(text);
  if (mentionsAppointments && asksForAppointmentList) {
    if (!isValidTimeZone(options.timeZone)) return { kind: "clarify", question: "The workspace time zone isn't valid, so I can't safely choose a local date. Ask an owner to check workspace settings." };
    const today = zonedDate(typeof options.now === "number" ? options.now : options.now.getTime(), options.timeZone);
    const parsed = dateFromText(text, today);
    if (parsed.kind === "clarify") return parsed;
    if (parsed.kind === "date") return { kind: "appointments_on", date: parsed.date };
    return { kind: "clarify", question: DATE_CLARIFICATION };
  }

  return NONE;
}
