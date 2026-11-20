import type { WorkforceRoleKey } from "@/lib/agents";
import { addDays, isValidTimeZone, weekdayOf, zonedDate, zonedToInstant } from "@/lib/calendars/slots";

export type WorkforceChatTaskIntent =
  | { kind: "none" }
  | { kind: "clarification"; message: string }
  | { kind: "proposal"; title: string; dueDate: string; dueAt: string; timezone: string; contactName: string | null }
  | { kind: "confirm" }
  | { kind: "cancel" };

const NONE: WorkforceChatTaskIntent = { kind: "none" };
const CLARIFY = "Tell me what the follow-up task should be and which future date it is due. For example: “Schedule a follow-up task to call Maya about the estimate for Friday.” No task was created.";
const TASK_PREFIX = /^(?:please\s+)?(?:schedule|create|add|set\s+up)\s+(?:(?:a|an|the)\s+)?(?:(?:new|follow[\s-]?up)\s+)*(?:crm\s+)?(?:task|to-?do)\b/i;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function validIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() + 1 === Number(match[2]) && date.getUTCDate() === Number(match[3]);
}

function resolveDueDate(value: string, today: string): string | null {
  const clean = value.trim().toLowerCase();
  if (clean === "today") return today;
  if (clean === "tomorrow") return addDays(today, 1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) return validIsoDate(clean) ? clean : null;
  const named = /^(?:(next|this)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/.exec(clean);
  if (!named) return null;
  const target = WEEKDAYS.indexOf(named[2]!);
  const current = weekdayOf(today);
  if (named[1] === "this") {
    const mondayOffset = current === 0 ? -6 : 1 - current;
    return addDays(today, mondayOffset + (target === 0 ? 6 : target - 1));
  }
  let delta = (target - current + 7) % 7;
  if (delta === 0) delta = 7;
  return addDays(today, delta);
}

/** Parses a deliberately narrow chat request for an internal task; confirmation is always separate. */
export function parseWorkforceChatTaskIntent(
  role: WorkforceRoleKey,
  content: string,
  options: { now?: Date; timeZone: string },
): WorkforceChatTaskIntent {
  if (role !== "growth_partner") return NONE;
  const text = content.replace(/\s+/g, " ").trim();
  if (/^(?:please\s+)?confirm\s+(?:the\s+)?(?:follow[\s-]?up\s+)?task[.!]?$/i.test(text)) return { kind: "confirm" };
  if (/^(?:please\s+)?cancel\s+(?:the\s+)?(?:follow[\s-]?up\s+)?task[.!]?$/i.test(text)) return { kind: "cancel" };
  const prefix = text.match(TASK_PREFIX);
  if (!prefix) return NONE;
  if (!isValidTimeZone(options.timeZone)) return { kind: "clarification", message: "I couldn't verify the workspace time zone, so I didn't prepare a task. Ask an owner or admin to check workspace settings." };

  const withoutIsoDates = text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, "");
  if (/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/.test(withoutIsoDates)) {
    return { kind: "clarification", message: "Please give one unambiguous date, such as Friday or 2026-11-20. I won't guess between numeric date formats. No task was created." };
  }
  const dateMatches = [...text.matchAll(/\b(?:(?:due(?:\s+on)?|for|by|on)\s+)?(today|tomorrow|(?:(?:next|this)\s+)?(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)|\d{4}-\d{2}-\d{2})\b/gi)];
  if (dateMatches.length !== 1) return { kind: "clarification", message: CLARIFY };
  const dateMatch = dateMatches[0]!;
  const dueDate = resolveDueDate(dateMatch[1]!, zonedDate((options.now ?? new Date()).getTime(), options.timeZone));
  if (!dueDate) return { kind: "clarification", message: "That date isn't valid. Give one future weekday or ISO date such as 2026-11-20. No task was created." };
  const today = zonedDate((options.now ?? new Date()).getTime(), options.timeZone);
  if (dueDate < today) return { kind: "clarification", message: "That date has already passed. Give a future date; no task was created." };
  if (!isValidTimeZone(options.timeZone)) return { kind: "clarification", message: "I couldn't verify the workspace time zone, so I didn't prepare a task. Ask an owner or admin to check workspace settings." };

  const dateStart = dateMatch.index ?? 0;
  let details = text.slice(prefix[0].length, dateStart).trim();
  const trailing = text.slice(dateStart + dateMatch[0].length).trim();
  if (trailing) details = `${details} ${trailing}`.trim();
  details = details.replace(/\b(?:due(?:\s+on)?|for|by|on)\s*$/i, "").trim();
  details = details.replace(/^(?:(?:to|titled|called|named)\s+|[:\-]\s*)/i, "").replace(/^['“`]+|['”`]+$/g, "").trim();
  let contactName: string | null = null;
  const contact = details.match(/\s+(?:for|with)\s+contact\s+(.+)$/i);
  if (contact) {
    contactName = contact[1]!.replace(/^['“`]+|['”`]+$/g, "").trim();
    details = details.slice(0, contact.index).trim();
  }
  const title = details.replace(/[.!?]+$/, "").trim();
  if (!title || title.length > 200 || /^(?:a\s+)?(?:follow[\s-]?up\s+)?task$/i.test(title)) {
    return { kind: "clarification", message: CLARIFY };
  }
  if (contactName && (!contactName || contactName.length > 80)) {
    return { kind: "clarification", message: "Give one exact CRM contact name after “for contact”. No task was created." };
  }
  const dueAt = new Date(zonedToInstant(dueDate, 17 * 60, options.timeZone)).toISOString();
  if (Date.parse(dueAt) <= (options.now ?? new Date()).getTime()) {
    return { kind: "clarification", message: "That task due time has already passed. Give a future weekday or date; no task was created." };
  }
  return {
    kind: "proposal",
    title,
    dueDate,
    dueAt,
    timezone: options.timeZone,
    contactName,
  };
}
