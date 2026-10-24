import type { AgentRoleKey } from "@/lib/agents";

export type WorkforceChatAppointmentChangeIntent =
  | { kind: "none" }
  | { kind: "clarification"; message: string }
  | { kind: "proposal"; operation: "cancel" | "reschedule"; contactName: string; appointmentAt: string; newStartAt: string | null }
  | { kind: "confirm" | "discard" };

const ISO = "(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?:Z|[+-]\\d{2}:\\d{2}))";
const CANCEL_APPOINTMENT = new RegExp(`^(?:please\\s+)?cancel\\s+(?:the\\s+)?(?:appointment|meeting|call)\\s+(?:for|with)\\s+(.+?)\\s+(?:at|on)\\s+${ISO}[.!]?\\s*$`, "i");
const CANCEL_NAME_FIRST = new RegExp(`^(?:please\\s+)?cancel\\s+(.+?)(?:'s)?\\s+(?:appointment|meeting|call)\\s+(?:at|on)\\s+${ISO}[.!]?\\s*$`, "i");
const RESCHEDULE_APPOINTMENT = new RegExp(`^(?:please\\s+)?(?:reschedule|move)\\s+(?:the\\s+)?(?:appointment|meeting|call)\\s+(?:for|with)\\s+(.+?)\\s+from\\s+${ISO}\\s+to\\s+${ISO}[.!]?\\s*$`, "i");
const RESCHEDULE_NAME_FIRST = new RegExp(`^(?:please\\s+)?(?:reschedule|move)\\s+(.+?)(?:'s)?\\s+(?:appointment|meeting|call)\\s+from\\s+${ISO}\\s+to\\s+${ISO}[.!]?\\s*$`, "i");
const CHANGE_REQUEST = /\b(?:cancel|reschedule|move|change)\b/i;
const APPOINTMENT = /\b(?:appointment|meeting|call|booking)\b/i;

function parseInstant(value: string): string | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(Z|([+-])(\d{2}):(\d{2}))$/i);
  if (!match) return null;
  const [, year, month, day, hour, minute, , sign, offsetHour, offsetMinute] = match;
  const y = Number(year), m = Number(month), d = Number(day), h = Number(hour), min = Number(minute);
  const local = new Date(Date.UTC(y, m - 1, d, h, min));
  if (local.getUTCFullYear() !== y || local.getUTCMonth() + 1 !== m || local.getUTCDate() !== d || h > 23 || min > 59) return null;
  if (sign) {
    const oh = Number(offsetHour), om = Number(offsetMinute);
    if (oh > 14 || om > 59 || (oh === 14 && om !== 0)) return null;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function cleanName(value: string): string {
  return value.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").replace(/\s+/g, " ").replace(/'s$/i, "").trim();
}

function makeProposal(operation: "cancel" | "reschedule", contactName: string, oldValue: string, newValue?: string): WorkforceChatAppointmentChangeIntent {
  const name = cleanName(contactName);
  const appointmentAt = parseInstant(oldValue);
  const newStartAt = newValue === undefined ? null : parseInstant(newValue);
  if (!name || name.length > 200) return { kind: "clarification", message: "Use the contact's exact CRM display name (200 characters or fewer) and the appointment's exact start time with a timezone offset. No appointment was changed." };
  if (!appointmentAt || (newValue !== undefined && !newStartAt)) return { kind: "clarification", message: "Those date, time, or timezone values are invalid. Use exact ISO times with offsets, such as 2026-11-02T09:00+08:00. No appointment was changed." };
  return { kind: "proposal", operation, contactName: name, appointmentAt, newStartAt };
}

/** Parse only an exact upcoming appointment change request. A separate chat confirmation and owner/admin approval are required. */
export function parseWorkforceChatAppointmentChangeIntent(role: AgentRoleKey, content: string): WorkforceChatAppointmentChangeIntent {
  if (role !== "appointment_setter") return { kind: "none" };
  const text = content.replace(/\s+/g, " ").trim().slice(0, 2000);
  if (!text) return { kind: "none" };
  const command = text.toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (/^confirm (?:the )?(?:appointment )?(?:change|cancellation|reschedule)$/.test(command)) return { kind: "confirm" };
  if (/^(?:discard|cancel) (?:the )?(?:appointment )?(?:change|cancellation|reschedule) preview$/.test(command)) return { kind: "discard" };

  const cancel = text.match(CANCEL_APPOINTMENT) ?? text.match(CANCEL_NAME_FIRST);
  if (cancel) return makeProposal("cancel", cancel[1], cancel[2]);
  const reschedule = text.match(RESCHEDULE_APPOINTMENT) ?? text.match(RESCHEDULE_NAME_FIRST);
  if (reschedule) return makeProposal("reschedule", reschedule[1], reschedule[2], reschedule[3]);

  if (CHANGE_REQUEST.test(text) && APPOINTMENT.test(text)) {
    return {
      kind: "clarification",
      message: "To prepare a cancellation, give the contact's exact CRM name and the appointment's exact start time with its timezone offset. To reschedule, include both the current and requested start times. Example: “Reschedule the appointment for Jane Doe from 2026-11-02T09:00+08:00 to 2026-11-03T10:00+08:00.” Nothing changes until an owner or admin approves the request.",
    };
  }
  return { kind: "none" };
}
