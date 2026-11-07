import type { WorkforceRoleKey } from "@/lib/agents";
import { capabilityDefinition, type CapabilityKey } from "@/lib/workforce-capabilities";
import type { Weekday } from "@/lib/messaging";
import { parseResearchAssignment } from "@/lib/research-intent";
import type { WorkforceScheduleRule } from "@/lib/workforce-schedule-recurrence";

export type WorkforceScheduleCadence = "hourly" | "daily" | "weekly";
export type WorkforceScheduleWindow = { startTime: string; endTime: string };

export type WorkforceChatScheduleIntent =
  | { kind: "none" }
  | { kind: "clarification"; message: string }
  | { kind: "set_existing_enabled"; capability: "lead_research"; enabled: boolean }
  | { kind: "update_existing"; capability: "lead_research"; localTime: string; cadence?: "daily" | "weekly"; weekdays?: Weekday[]; window?: WorkforceScheduleWindow }
  | {
      kind: "proposal";
      capability: CapabilityKey;
      title: string;
      cadence: WorkforceScheduleCadence;
      recurrenceRule: WorkforceScheduleRule | null;
      payload: Record<string, unknown>;
    };

const DAYS: ReadonlyArray<{ key: Weekday; pattern: RegExp }> = [
  { key: "mon", pattern: /\bmondays?\b/i },
  { key: "tue", pattern: /\btuesdays?\b/i },
  { key: "wed", pattern: /\bwednesdays?\b/i },
  { key: "thu", pattern: /\bthursdays?\b/i },
  { key: "fri", pattern: /\bfridays?\b/i },
  { key: "sat", pattern: /\bsaturdays?\b/i },
  { key: "sun", pattern: /\bsundays?\b/i },
];
const WEEKDAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri"];
const WEEKDAY_ORDER: Weekday[] = [...WEEKDAYS, "sat", "sun"];
// "every" and "each" start a schedule only when a period of time follows them ("every Friday", "each morning", "every 2 hours"). In "list every open time" or "check each blocked task" they
// mean "all of them": a question to answer now, which used to get "What local time should I use?" because it was read as a recurring request.
const PERIOD = "(?:weekdays?|days?|weeks?|hours?|mornings?|afternoons?|evenings?|nights?|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?)";
const RECURRING_SIGNAL = new RegExp(`\\b(?:every|each)\\s+(?:\\d+\\s+)?${PERIOD}\\b|\\b(?:daily|weekly|hourly|recurring)\\b`, "i");
const TIME_12_HOUR = /\b(?:at\s+)?(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/i;
const TIME_24_HOUR = /\bat\s+(\d{2}):([0-5]\d)\b/;
const SCHEDULED_WRITE = /\b(?:send|email|text|call|message|book|confirm|reschedule|cancel|merge|delete|import|export|update|assign|reassign|follow[ -]?up)\b/i;
const LEAD_SCHEDULE_TOGGLE = /^(?:please\s+)?(pause|disable|stop|resume|enable|restart)\s+(?:(?:my|our|the)\s+)?(?:lead[ -](?:research|hunting)|prospecting)\s+schedule[.!?]*$/i;
const LEAD_SCHEDULE_CHANGE = /^(?:please\s+)?(?:change|update|move|reschedule)\s+(?:(?:my|our|the)\s+)?(?:lead[\s-]*(?:hunting|research)|prospecting)\s+(?:(?:lead\s+)?research\s+)?(?:schedule\s+)?(?:(?:from\s+.+?\s+)?(?:to|for|at)\s+)(.+?)[.!?]*$/i;
const SCHEDULE_WINDOW_TIME = String.raw`(?:\b(?:1[0-2]|0?[1-9])(?::[0-5]\d)?\s*(?:a\.?m\.?|p\.?m\.?)(?![a-z])|\b(?:[01]\d|2[0-3]):[0-5]\d\b)`;
const SCHEDULE_WINDOW = new RegExp(`(${SCHEDULE_WINDOW_TIME})\\s*(?:-|–|—|\\bto\\b)\\s*(${SCHEDULE_WINDOW_TIME})`, "i");
const SCHEDULE_WINDOW_LIKE = /\b(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)\s*(?:-|–|—|\bto\b)\s*(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)/i;

function weekdaysIn(text: string): Weekday[] {
  return WEEKDAY_ORDER.filter((day) => DAYS.find((entry) => entry.key === day)?.pattern.test(text));
}

function parseLocalTime(text: string): { time: string | null; ambiguous: boolean } {
  const twelveHour = text.match(TIME_12_HOUR);
  if (twelveHour) {
    let hour = Number(twelveHour[1]) % 12;
    const suffix = twelveHour[3].toLocaleLowerCase("en-US").replaceAll(".", "");
    if (suffix === "pm") hour += 12;
    return { time: `${String(hour).padStart(2, "0")}:${twelveHour[2] ?? "00"}`, ambiguous: false };
  }
  const twentyFourHour = text.match(TIME_24_HOUR);
  if (twentyFourHour) return { time: `${twentyFourHour[1]}:${twentyFourHour[2]}`, ambiguous: false };
  const bareHour = text.match(/\bat\s+(\d{1,2})(?!\d)(?!\s*(?:a\.?m\.?|p\.?m\.?))/i);
  return { time: null, ambiguous: Boolean(bareHour) };
}

function parseScheduleWindow(text: string): { window: WorkforceScheduleWindow | null; issue: "ambiguous" | "invalid" | null } {
  const match = text.match(SCHEDULE_WINDOW);
  if (!match) {
    const broadMatch = text.match(SCHEDULE_WINDOW_LIKE);
    if (!broadMatch) return { window: null, issue: null };
    const unmarkedTwelveHourTime = (value: string) => !value.includes(":") && !/(?:a\.?m\.?|p\.?m\.?)/i.test(value);
    const ambiguous = unmarkedTwelveHourTime(broadMatch[1]) || unmarkedTwelveHourTime(broadMatch[2]);
    return { window: null, issue: ambiguous ? "ambiguous" : "invalid" };
  }
  const parseEndpoint = (value: string) => parseLocalTime(/^\d{2}:\d{2}$/.test(value.trim()) ? `at ${value.trim()}` : value);
  const start = parseEndpoint(match[1]);
  const end = parseEndpoint(match[2]);
  if (!start.time || !end.time || start.ambiguous || end.ambiguous) return { window: null, issue: "invalid" };
  if (start.time >= end.time) return { window: null, issue: "invalid" };
  return { window: { startTime: start.time, endTime: end.time }, issue: null };
}

function removeScheduleWording(text: string): string {
  return text
    .replace(/\b(?:every|each)\s+(?:weekdays?|days?|weeks?|hours?|mornings?|evenings?|nights?|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?)\b/gi, " ")
    .replace(/\b(?:daily|weekly|hourly|recurring)\b/gi, " ")
    .replace(/\b(?:at\s+)?(?:\d{1,2})(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b/gi, " ")
    .replace(/\bat\s+\d{2}:\d{2}\b/g, " ")
    .replace(/\b(?:please|could you|can you|would you|schedule|set up|create|run|every|each)\b/gi, " ")
    .replace(/[,.!?]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unsupportedWrite(researchOwner: string): WorkforceChatScheduleIntent {
  return {
    kind: "clarification",
    message: `Chat-created schedules can run only approved read-only reviews and ${researchOwner} research. I can’t schedule messages, bookings, CRM changes, assignments or follow-up drafts.`,
  };
}

function capabilityFor(role: WorkforceRoleKey, task: string): { capability: CapabilityKey; payload: Record<string, unknown> } | null {
  if (role === "growth_partner") {
    const research = parseResearchAssignment(task);
    if (research) {
      if (research.missing.length) {
        const needed = research.missing.map((field) => ({
          quantity: "how many businesses to research",
          target: "what kind of businesses to research",
          location: "which city or service area to cover",
        }[field]));
        return { capability: "lead_research", payload: { clarification: needed } };
      }
      return {
        capability: "lead_research",
        payload: { prompt: research.prompt, target: research.target, location: research.location, quantity: research.quantity },
      };
    }
    if (/\b(?:operations?|operational work|workforce|tasks?|blockers?|approvals?)\b/i.test(task)) return { capability: "proactive_review", payload: { sinceDays: 7 } };
    if (/\b(?:lead generation|research queue|research pipeline|coverage|lead pipeline)\b/i.test(task)) return { capability: "lead_generation_review", payload: {} };
    if (/\b(?:availability|available slots|available times|calendar slots)\b/i.test(task)) return { capability: "appointment_availability", payload: {} };
    if (/\b(?:appointments?|booking requests|bookings)\b/i.test(task)) return { capability: "appointment_review", payload: {} };
    if (/\bmissed calls?\b/i.test(task)) return { capability: "missed_call_review", payload: {} };
    if (/\b(?:hot leads?|lead priorities|promising leads?)\b/i.test(task)) return { capability: "lead_priority_review", payload: {} };
    if (/\b(?:sales pipeline|pipeline|opportunities|deals|stalled sales)\b/i.test(task)) return { capability: "pipeline_review", payload: {} };
    if (/\b(?:crm|records?|duplicates?|data quality|contacts?|companies)\b/i.test(task)) return { capability: "crm_quality_review", payload: {} };
    if (/\b(?:social|social media|posts?|engagement|tracked leads?)\b/i.test(task)) return { capability: "social_performance_review", payload: {} };
    if (/\b(?:receivables|invoices?|payments?|refunds?|overdue)\b/i.test(task)) return { capability: "receivables_review", payload: {} };
    if (/\b(?:reputation|reviews?|ratings?)\b/i.test(task)) return { capability: "reputation_review", payload: {} };
    if (/\b(?:performance|metrics?|kpis?|results?|trends?|report)\b/i.test(task)) return { capability: "performance_snapshot", payload: /\b(?:this month|month to date|monthly)\b/i.test(task) ? { period: "current_month" } : {} };
    return null;
  }
  if (role === "operations_manager" && /\b(?:operations?|operational work|workforce|tasks?|blockers?|approvals?)\b/i.test(task)) {
    return { capability: "proactive_review", payload: { sinceDays: 7 } };
  }
  if (role === "lead_hunter") {
    const research = parseResearchAssignment(task);
    if (research) {
      if (research.missing.length) {
        const needed = research.missing.map((field) => ({
          quantity: "how many businesses to research",
          target: "what kind of businesses to research",
          location: "which city or service area to cover",
        }[field]));
        return { capability: "lead_research", payload: { clarification: needed } };
      }
      return {
        capability: "lead_research",
        payload: { prompt: research.prompt, target: research.target, location: research.location, quantity: research.quantity },
      };
    }
    if (/\b(?:lead generation|research queue|research pipeline|coverage|lead pipeline)\b/i.test(task)) {
      return { capability: "lead_generation_review", payload: {} };
    }
  }
  if (role === "appointment_setter") {
    if (/\b(?:availability|available slots|available times|calendar slots)\b/i.test(task)) {
      return { capability: "appointment_availability", payload: {} };
    }
    if (/\b(?:appointments?|booking requests|bookings)\b/i.test(task)) {
      return { capability: "appointment_review", payload: {} };
    }
    if (/\bmissed calls?\b/i.test(task)) return { capability: "missed_call_review", payload: {} };
  }
  if (role === "sales_assistant") {
    if (/\b(?:hot leads?|lead priorities|promising leads?)\b/i.test(task)) {
      return { capability: "lead_priority_review", payload: {} };
    }
    if (/\b(?:pipeline|opportunities|deals|stalled sales)\b/i.test(task)) {
      return { capability: "pipeline_review", payload: {} };
    }
  }
  if (role === "crm_manager" && /\b(?:crm|records?|duplicates?|data quality|contacts?|companies)\b/i.test(task)) {
    return { capability: "crm_quality_review", payload: {} };
  }
  if (role === "performance_analyst" && /\b(?:performance|metrics?|kpis?|results?|trends?|report)\b/i.test(task)) {
    return { capability: "performance_snapshot", payload: /\b(?:this month|month to date|monthly)\b/i.test(task) ? { period: "current_month" } : {} };
  }
  return null;
}

/** Deterministic, role-scoped parser. A non-null result is a preview or clarification only. */
export function parseWorkforceChatScheduleIntent(role: WorkforceRoleKey, content: string): WorkforceChatScheduleIntent {
  const text = content.replace(/\s+/g, " ").trim().slice(0, 2000);
  const researchOwner = role === "growth_partner" ? "AI Growth Partner" : "Lead Hunter";
  if (!text) return { kind: "none" };

  const scheduleToggle = role === "growth_partner" ? text.match(LEAD_SCHEDULE_TOGGLE) : null;
  if (scheduleToggle) {
    const enabled = /^(?:resume|enable|restart)$/i.test(scheduleToggle[1]);
    return { kind: "set_existing_enabled", capability: "lead_research", enabled };
  }
  if (role === "growth_partner" && /^(?:please\s+)?(?:pause|disable|stop|resume|enable|restart)\b.*\b(?:schedule|scheduled work)\b/i.test(text)) {
    return { kind: "clarification", message: "Name the saved lead research schedule you want me to pause or resume. No schedule was changed." };
  }

  const scheduleChange = role === "growth_partner" ? text.match(LEAD_SCHEDULE_CHANGE) : null;
  if (scheduleChange) {
    const requested = scheduleChange[1];
    if (/\b(?:starting|beginning|effective)\s+(?:tomorrow|next\s+(?:week|month)|\d{4}-\d{2}-\d{2})\b/i.test(requested)) {
      return { kind: "clarification", message: "I can update a saved lead research schedule now, but it can't start on a future date yet. No schedule was changed." };
    }
    const parsedWindow = parseScheduleWindow(requested);
    if (parsedWindow.issue === "invalid") {
      return { kind: "clarification", message: "Give the work window as valid same-day times, such as 2 PM–5 PM or 14:00–17:00, with the end after the start. No schedule was changed." };
    }
    if (parsedWindow.issue === "ambiguous") {
      return { kind: "clarification", message: "Include AM/PM on both work-window times, such as 2 PM–5 PM, or use 24-hour times such as 14:00–17:00. No schedule was changed." };
    }
    const parsedTime = parsedWindow.window ? { time: parsedWindow.window.startTime, ambiguous: false } : parseLocalTime(requested);
    if (parsedTime.ambiguous) {
      return { kind: "clarification", message: "What local time should I use? Include AM/PM, such as 2 PM, or use an unambiguous 24-hour time such as 14:00." };
    }
    if (!parsedTime.time) {
      return { kind: "clarification", message: "What single local time should the lead research schedule run? Include AM/PM, such as 2 PM." };
    }
    const everyWeekday = /\b(?:every|each)\s+weekday\b|\bweekdays\b/i.test(requested);
    const weekdays = weekdaysIn(requested);
    const window = parsedWindow.window;
    if (everyWeekday) return { kind: "update_existing", capability: "lead_research", localTime: parsedTime.time, cadence: "weekly", weekdays: WEEKDAYS, ...(window ? { window } : {}) };
    if (weekdays.length) return { kind: "update_existing", capability: "lead_research", localTime: parsedTime.time, cadence: "weekly", weekdays, ...(window ? { window } : {}) };
    if (/\b(?:daily|every day|each day)\b/i.test(requested)) return { kind: "update_existing", capability: "lead_research", localTime: parsedTime.time, cadence: "daily", ...(window ? { window } : {}) };
    return { kind: "update_existing", capability: "lead_research", localTime: parsedTime.time, ...(window ? { window } : {}) };
  }

  if (!RECURRING_SIGNAL.test(text)) return { kind: "none" };

  if (SCHEDULED_WRITE.test(text)) return unsupportedWrite(researchOwner);

  const days = weekdaysIn(text);
  const everyWeekday = /\b(?:every|each)\s+weekday\b|\bweekdays\b/i.test(text);
  const hourly = /\b(?:hourly|every hour|each hour)\b/i.test(text);
  const daily = /\b(?:daily|every day|each day|every morning|every evening|every night)\b/i.test(text);
  const weekly = /\b(?:weekly|every week|each week)\b/i.test(text);
  let cadence: WorkforceScheduleCadence;
  if (hourly) cadence = "hourly";
  else if (everyWeekday || days.length || weekly) cadence = "weekly";
  else if (daily) cadence = "daily";
  else return { kind: "clarification", message: "I can prepare an hourly, daily or weekly schedule. Which cadence do you want?" };

  if (cadence === "weekly" && !everyWeekday && !days.length) {
    return { kind: "clarification", message: "Which weekday should this schedule run? You can name one day or several." };
  }
  const parsedTime = parseLocalTime(text);
  if (parsedTime.ambiguous) {
    return { kind: "clarification", message: "What local time should I use? Include AM/PM, such as 9 AM, or use an unambiguous 24-hour time such as 14:00." };
  }
  if (cadence !== "hourly" && !parsedTime.time) {
    return { kind: "clarification", message: "What local time should I use? Include AM/PM, such as 9 AM." };
  }

  const task = removeScheduleWording(text);
  if (!task || !/\b(?:review|check|audit|analy[sz]e|prepare|report|identify|monitor|research|find|show|list|compare|inspect)\b/i.test(task)) {
    return { kind: "clarification", message: `What approved review or ${researchOwner} research assignment should I schedule? I’ll only save it after you review and confirm the preview.` };
  }
  const match = capabilityFor(role, task);
  if (!match) {
    return { kind: "clarification", message: `I can schedule only work supported by this employee’s role. Please describe a read-only review or, for ${researchOwner}, a complete research assignment.` };
  }
  if (Array.isArray(match.payload.clarification)) {
    return {
      kind: "clarification",
      message: `To prepare this ${researchOwner} schedule, I still need ${match.payload.clarification.join(", ")}. No schedule was saved.`,
    };
  }
  const definition = capabilityDefinition(match.capability);
  if (!definition || (definition.risk !== "read_only" && match.capability !== "lead_research")) return unsupportedWrite(researchOwner);

  const recurrenceRule: WorkforceScheduleRule | null = cadence === "hourly"
    ? null
    : cadence === "daily"
      ? { kind: "daily", localTime: parsedTime.time as string }
      : { kind: "weekly", localTime: parsedTime.time as string, weekdays: everyWeekday ? WEEKDAYS : days };
  return {
    kind: "proposal",
    capability: match.capability,
    title: definition.label,
    cadence,
    recurrenceRule,
    payload: match.payload,
  };
}

export function isScheduleConfirmation(content: string): "confirm" | "cancel" | null {
  const text = content.toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (/^(?:confirm schedule|confirm this schedule|create this schedule)$/.test(text)) return "confirm";
  if (/^(?:cancel schedule|cancel this schedule|discard schedule)$/.test(text)) return "cancel";
  return null;
}
