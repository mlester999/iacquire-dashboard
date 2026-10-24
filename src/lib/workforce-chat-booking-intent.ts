import type { AgentRoleKey } from "@/lib/agents";

export type WorkforceChatBookingIntent =
  | { kind: "none" }
  | { kind: "clarification"; message: string }
  | { kind: "proposal"; contactName: string; startAt: string }
  | { kind: "confirm" | "cancel" };

const ISO_INSTANT = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2}))\s*[.!]?\s*$/i;
const LOCAL_DATETIME = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}\s*[.!]?\s*$/i;
const ACTION = /\b(?:book|schedule|arrange|set up)\b/i;
const APPOINTMENT = /\b(?:appointment|meeting|call|calendar slot|booking)\b/i;
const RECURRING = /\b(?:every|each|daily|weekly|hourly|recurring)\b/i;
const GENERIC_CONTACT = /^(?:an?\s+)?(?:appointment|meeting|call|calendar slot|booking)$/i;

function cleanName(value: string): string {
  return value
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/\s+/g, " ");
}

function parseInstant(value: string): string | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(Z|([+-])(\d{2}):(\d{2}))$/i);
  if (!match) return null;
  const year = match[1], month = match[2], day = match[3], hour = match[4], minute = match[5];
  const sign = match[7], offsetHour = match[8], offsetMinute = match[9];
  const y = Number(year), m = Number(month), d = Number(day), h = Number(hour), min = Number(minute);
  const date = new Date(Date.UTC(y, m - 1, d, h, min));
  if (
    date.getUTCFullYear() !== y || date.getUTCMonth() + 1 !== m || date.getUTCDate() !== d
    || h > 23 || min > 59
  ) return null;
  if (sign) {
    const oh = Number(offsetHour), om = Number(offsetMinute);
    if (oh > 14 || om > 59 || (oh === 14 && om !== 0)) return null;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

/**
 * Parse only one appointment request with one exact contact name and an explicit ISO 8601 offset.
 * The preview is read-only; the caller must obtain a separate, explicit confirmation before it
 * invokes the calendar booking service.
 */
export function parseWorkforceChatBookingIntent(role: AgentRoleKey, content: string): WorkforceChatBookingIntent {
  if (role !== "appointment_setter") return { kind: "none" };
  const text = content.replace(/\s+/g, " ").trim().slice(0, 2000);
  if (!text) return { kind: "none" };

  const command = text.toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (/^(?:confirm|confirm this) (?:the )?(?:appointment )?booking$/.test(command)) return { kind: "confirm" };
  if (/^(?:cancel|discard|cancel this) (?:the )?(?:appointment )?booking(?: preview)?$/.test(command)) return { kind: "cancel" };

  if (!ACTION.test(text) || RECURRING.test(text)) return { kind: "none" };
  const hasAvailabilityRequest = /\b(?:availability|available slots?|available times?|open slots?)\b/i.test(text);
  const explicitAppointment = APPOINTMENT.test(text);
  const instantMatch = text.match(ISO_INSTANT);
  const hasTimestamp = Boolean(instantMatch || LOCAL_DATETIME.test(text));

  // An availability request is its own read-only workflow, even when the person says they want
  // help scheduling. Let the availability job run first; a booking still needs a later exact
  // contact, time and explicit confirmation.
  if (hasAvailabilityRequest && !hasTimestamp) return { kind: "none" };

  // Preserve the existing read-only availability route for requests such as “check the calendar
  // and schedule an appointment for an available time”; choosing a customer or slot is still
  // required before a booking preview can be made.
  if (!explicitAppointment && !(hasTimestamp && /\b(?:with|for)\b/i.test(text))) return { kind: "none" };
  if (hasAvailabilityRequest && /\b(?:for|at)\s+(?:an?\s+)?(?:available|open)\b/i.test(text) && !/\bwith\s+[\p{L}]/iu.test(text)) {
    return { kind: "none" };
  }

  if (!instantMatch) {
    return {
      kind: "clarification",
      message: "I can prepare a booking preview after you name the contact exactly as it appears in the CRM and give one exact time with a timezone offset, for example: “Book an appointment with Jane Doe at 2026-11-02T09:00+08:00.” A local time without an offset is ambiguous, so no booking was requested.",
    };
  }

  const startAt = parseInstant(instantMatch[1]);
  if (!startAt) {
    return { kind: "clarification", message: "That date, time or timezone offset is invalid. Use a valid ISO time such as 2026-11-02T09:00+08:00. No booking was requested." };
  }

  const before = text.slice(0, instantMatch.index).trim().replace(/[,:;.!?]+$/, "").trim();
  const actionRemoved = before.replace(/^\s*(?:please\s+)?(?:book|schedule|arrange|set\s+up)\s+/i, "");
  const contactName = cleanName(actionRemoved
    .replace(/^(?:(?:an?|the)\s+)?(?:appointment|meeting|call|calendar slot|booking)\s+(?:with|for)\s+/i, "")
    .replace(/\s+(?:at|on|for)\s*$/i, ""));

  if (!contactName || GENERIC_CONTACT.test(contactName)) {
    return {
      kind: "clarification",
      message: "Name one contact exactly as it appears in the CRM, then give the exact time with its timezone offset. I haven't created a booking preview.",
    };
  }
  if (contactName.length > 200) {
    return { kind: "clarification", message: "Use a CRM contact display name of 200 characters or fewer. No booking preview was created." };
  }

  return { kind: "proposal", contactName, startAt };
}
