import { AI_GROWTH_PARTNER_ROLE_KEY, type WorkforceRoleKey } from "@/lib/agents";
import { describeBusinessHours, validateBusinessHours, type BusinessHours, type Weekday } from "@/lib/messaging";

export type WorkforceChatMessagingHoursIntent =
  | { kind: "none" }
  | { kind: "clarification"; message: string }
  | { kind: "update"; businessHours: BusinessHours; summary: string };

const NOOP: WorkforceChatMessagingHoursIntent = { kind: "none" };
const HELP = "I can update Messaging hours, which control follow-up windows and replies when business-hours-only is enabled. Calendar host availability is separate. Use one explicit update such as “Set messaging business hours to Mon-Fri 09:00-17:00; Sat-Sun closed.” Use 24-hour times; days not listed are closed. List at least one open window; use “24/7” for always open.";
const DAY_ORDER: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_ALIASES: Record<string, Weekday> = {
  mon: "mon", monday: "mon", mondays: "mon",
  tue: "tue", tues: "tue", tuesday: "tue", tuesdays: "tue",
  wed: "wed", weds: "wed", wednesday: "wed", wednesdays: "wed",
  thu: "thu", thur: "thu", thurs: "thu", thursday: "thu", thursdays: "thu",
  fri: "fri", friday: "fri", fridays: "fri",
  sat: "sat", saturday: "sat", saturdays: "sat",
  sun: "sun", sunday: "sun", sundays: "sun",
};
function clarification(): WorkforceChatMessagingHoursIntent {
  return { kind: "clarification", message: HELP };
}

function parseDaySelector(raw: string): Weekday[] | null {
  const selector = raw.trim().toLocaleLowerCase("en-US").replace(/^the\s+/, "").trim();
  if (["weekday", "weekdays", "business days"].includes(selector)) return ["mon", "tue", "wed", "thu", "fri"];
  if (["weekend", "weekends"].includes(selector)) return ["sat", "sun"];
  if (["every day", "all days", "daily"].includes(selector)) return DAY_ORDER;

  const range = selector.match(/^([a-z]+)\s*(?:-|–|—|\bto\b|\bthrough\b)\s*([a-z]+)$/);
  if (range) {
    const start = DAY_ALIASES[range[1]];
    const end = DAY_ALIASES[range[2]];
    if (!start || !end) return null;
    const startIndex = DAY_ORDER.indexOf(start);
    const endIndex = DAY_ORDER.indexOf(end);
    if (startIndex > endIndex) return null;
    return DAY_ORDER.slice(startIndex, endIndex + 1);
  }

  const tokens = selector.split(/\s*(?:,|&|\band\b)\s*|\s+/).filter(Boolean);
  const days = tokens.map((token) => DAY_ALIASES[token]);
  if (!days.length || days.some((day) => !day)) return null;
  return [...new Set(days as Weekday[])].sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));
}

function parseClause(raw: string): { days: Weekday[]; hours: [string, string] | null } | null {
  const clause = raw.trim();
  const closed = clause.match(/(?:\s+|:\s*)closed$/i);
  if (closed?.index !== undefined) {
    const selector = clause.slice(0, closed.index).trim().replace(/:\s*$/, "");
    const days = parseDaySelector(selector);
    return days ? { days, hours: null } : null;
  }

  const range = clause.match(/((?:[01]\d|2[0-3]):[0-5]\d)\s*(?:-|–|—|\bto\b)\s*((?:[01]\d|2[0-3]):[0-5]\d)$/i);
  if (!range || range.index === undefined || range[1] >= range[2]) return null;
  const selector = clause.slice(0, range.index).trim().replace(/:\s*$/, "");
  const days = parseDaySelector(selector);
  if (!days) return null;
  return { days, hours: [range[1], range[2]] };
}

/** Parses one fully specified, 24-hour Messaging schedule; ambiguous hours never reach the backend. */
export function parseWorkforceChatMessagingHoursIntent(role: WorkforceRoleKey, content: string): WorkforceChatMessagingHoursIntent {
  if (role !== AI_GROWTH_PARTNER_ROLE_KEY) return NOOP;
  const text = content.trim();
  if (!/\b(?:business|messaging|opening)\s+hours?\b/i.test(text)) return NOOP;
  if (/^(?:how|what|where|why)\b/i.test(text)) return NOOP;
  if (!/\b(?:set|change|update|edit)\b/i.test(text)) return NOOP;

  const command = text.match(/^(?:please\s+)?(?:set|change|update|edit)\s+(?:(?:our|the)\s+)?messaging\s+(?:(?:business|opening)\s+)?hours?\s*(?::\s*|\bto\b\s*|\bas\b\s*)([\s\S]+)$/i);
  if (!command || command[1].length > 2000) return clarification();
  const valueText = command[1].trim().replace(/[.!?]+$/, "").trim();
  if (/^(?:24\s*\/\s*7|always open)$/i.test(valueText)) {
    return { kind: "update", businessHours: {}, summary: "24/7" };
  }

  const intervals: Partial<Record<Weekday, Array<[string, string]>>> = {};
  const closedDays = new Set<Weekday>();
  const clauses = valueText.split(";").map((part) => part.trim()).filter(Boolean);
  if (!clauses.length || clauses.length > 14) return clarification();
  for (const clause of clauses) {
    const parsed = parseClause(clause);
    if (!parsed) return clarification();
    if (!parsed.hours) {
      for (const day of parsed.days) {
        if (intervals[day]?.length) return clarification();
        closedDays.add(day);
      }
      continue;
    }
    for (const day of parsed.days) {
      if (closedDays.has(day)) return clarification();
      (intervals[day] ??= []).push(parsed.hours);
    }
  }

  for (const day of DAY_ORDER) {
    const dayIntervals = intervals[day];
    if (!dayIntervals) continue;
    dayIntervals.sort((a, b) => a[0].localeCompare(b[0]));
    if (dayIntervals.length > 4 || dayIntervals.some((interval, index) => index > 0 && dayIntervals[index - 1][1] > interval[0])) return clarification();
  }
  const businessHours = Object.fromEntries(DAY_ORDER.filter((day) => intervals[day]?.length).map((day) => [day, intervals[day]])) as BusinessHours;
  if (!DAY_ORDER.some((day) => intervals[day]?.length)) return clarification();
  if (!validateBusinessHours(businessHours)) return clarification();
  return { kind: "update", businessHours, summary: describeBusinessHours(businessHours) };
}
