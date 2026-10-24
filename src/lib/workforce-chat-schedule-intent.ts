import type { AgentRoleKey } from "@/lib/agents";
import { capabilityDefinition, type CapabilityKey } from "@/lib/workforce-capabilities";
import type { Weekday } from "@/lib/messaging";
import { parseResearchAssignment } from "@/lib/research-intent";
import type { WorkforceScheduleRule } from "@/lib/workforce-schedule-recurrence";

export type WorkforceScheduleCadence = "hourly" | "daily" | "weekly";

export type WorkforceChatScheduleIntent =
  | { kind: "none" }
  | { kind: "clarification"; message: string }
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
const RECURRING_SIGNAL = /\b(?:every|each|daily|weekly|hourly|recurring)\b/i;
const TIME_12_HOUR = /\b(?:at\s+)?(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)\b/i;
const TIME_24_HOUR = /\bat\s+(\d{2}):([0-5]\d)\b/;
const SCHEDULED_WRITE = /\b(?:send|email|text|call|message|book|confirm|reschedule|cancel|merge|delete|import|export|update|assign|reassign|follow[ -]?up)\b/i;

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

function unsupportedWrite(): WorkforceChatScheduleIntent {
  return {
    kind: "clarification",
    message: "Chat-created schedules can run only approved read-only reviews and Lead Hunter research. I can’t schedule messages, bookings, CRM changes, assignments or follow-up drafts.",
  };
}

function capabilityFor(role: AgentRoleKey, task: string): { capability: CapabilityKey; payload: Record<string, unknown> } | null {
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
export function parseWorkforceChatScheduleIntent(role: AgentRoleKey, content: string): WorkforceChatScheduleIntent {
  const text = content.replace(/\s+/g, " ").trim().slice(0, 2000);
  if (!text || !RECURRING_SIGNAL.test(text)) return { kind: "none" };

  if (SCHEDULED_WRITE.test(text)) return unsupportedWrite();

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
    return { kind: "clarification", message: "What approved review or Lead Hunter research assignment should I schedule? I’ll only save it after you review and confirm the preview." };
  }
  const match = capabilityFor(role, task);
  if (!match) {
    return { kind: "clarification", message: "I can schedule only work supported by this employee’s role. Please describe a read-only review or, for Lead Hunter, a complete research assignment." };
  }
  if (Array.isArray(match.payload.clarification)) {
    return {
      kind: "clarification",
      message: `To prepare this Lead Hunter schedule, I still need ${match.payload.clarification.join(", ")}. No schedule was saved.`,
    };
  }
  const definition = capabilityDefinition(match.capability);
  if (!definition || (definition.risk !== "read_only" && match.capability !== "lead_research")) return unsupportedWrite();

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
