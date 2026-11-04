import type { WorkforceRoleKey } from "@/lib/agents";

export type AppointmentPolicyField = "durationMinutes" | "minNoticeMinutes" | "maxDaysAhead";
export type WorkforceChatAppointmentPolicyIntent =
  | { kind: "none" }
  | { kind: "clarification"; message: string }
  | { kind: "update"; field: AppointmentPolicyField; value: number; appointmentTypeName: string | null };

const NONE: WorkforceChatAppointmentPolicyIntent = { kind: "none" };
const GENERIC_TYPE = /^(?:our|the|all|workspace|appointment|appointments|booking|bookings|calendar|our calendar|all appointments|all bookings|appointment type|booking type)$/i;

function numberInMinutes(value: number, unit: string): number {
  if (/^(?:h|hr|hrs|hour|hours)$/i.test(unit)) return Math.round(value * 60);
  if (/^(?:d|day|days)$/i.test(unit)) return Math.round(value * 1440);
  return Math.round(value);
}

function requestedTypeName(text: string, fieldPattern: RegExp, valuePattern: RegExp): string | null {
  const afterFor = text.match(new RegExp(`\\bfor\\s+["“]?([^,;.!?]+?)["”]?\\s+${valuePattern.source}`, "i"))?.[1];
  if (afterFor) {
    const name = afterFor.trim().replace(/^(?:the|appointment type|booking type)\s+/i, "").replace(/["“”]/g, "").trim();
    if (name && !GENERIC_TYPE.test(name)) return name;
  }

  const beforeField = text.match(new RegExp(`^(?:please\\s+)?(?:can you\\s+)?(?:change|set|update|adjust)\\s+(?:the\\s+)?["“]?(.+?)["”]?\\s+${fieldPattern.source}\\s+(?:to|at)`, "i"))?.[1];
  if (beforeField) {
    const name = beforeField.trim().replace(/^(?:the|our|all)\s+/i, "").replace(/^(?:appointment|booking)\s+/i, "").replace(/["“”]/g, "").trim();
    if (name && !GENERIC_TYPE.test(name)) return name;
  }
  return null;
}

/** Parses only explicit setters for the booking rules used by the real calendar services. */
export function parseWorkforceChatAppointmentPolicyIntent(role: WorkforceRoleKey, content: string): WorkforceChatAppointmentPolicyIntent {
  if (role !== "growth_partner") return NONE;
  const text = content.replace(/\s+/g, " ").trim();
  if (!/^(?:please\s+)?(?:can you\s+)?(?:change|set|update|adjust)\b/i.test(text)) return NONE;

  const valuePattern = /\b(?:to|at)\s+(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?|days?)\b/i;
  const parsed = text.match(valuePattern);
  const unit = parsed?.[2]?.toLowerCase() ?? "";
  const rawValue = parsed ? Number(parsed[1]) : NaN;

  const durationPattern = /(?:appointment\s+)?(?:duration|length)|(?:duration|length)\s+(?:of|for)/i;
  const noticePattern = /(?:minimum|min(?:imum)?\s+booking|booking\s+minimum)\s+notice(?:\s+(?:period|time))?|notice\s+period|advance\s+notice/i;
  const horizonPattern = /(?:appointment|booking)?\s*(?:booking\s+)?window|how\s+far\s+ahead|advance\s+booking/i;

  let field: AppointmentPolicyField | null = null;
  let fieldPattern: RegExp | null = null;
  let allowedUnits: RegExp | null = null;
  if (durationPattern.test(text)) {
    field = "durationMinutes";
    fieldPattern = durationPattern;
    allowedUnits = /^(?:minutes?|mins?|hours?|hrs?)$/i;
  } else if (noticePattern.test(text)) {
    field = "minNoticeMinutes";
    fieldPattern = noticePattern;
    allowedUnits = /^(?:minutes?|mins?|hours?|hrs?|days?)$/i;
  } else if (horizonPattern.test(text)) {
    field = "maxDaysAhead";
    fieldPattern = horizonPattern;
    allowedUnits = /^(?:days?)$/i;
  } else if (/\b(?:appointment|booking)\s+hours?\b|\bworking hours\b/i.test(text)) {
    return { kind: "clarification", message: "I can update a named appointment type's booking rules here. To change working hours, specify the calendar, host, weekdays, time zone, and opening and closing times." };
  } else {
    return NONE;
  }

  if (!parsed || !allowedUnits.test(unit)) {
    return { kind: "clarification", message: field === "maxDaysAhead" ? "Please give the booking window in whole days, such as 30 days." : "Please give the new value and units, such as 45 minutes or 2 hours." };
  }
  const value = field === "maxDaysAhead" ? rawValue : numberInMinutes(rawValue, unit);
  const valid = field === "durationMinutes" ? Number.isInteger(value) && value >= 5 && value <= 720
    : field === "minNoticeMinutes" ? Number.isInteger(value) && value >= 0 && value <= 43200
      : Number.isInteger(value) && value >= 1 && value <= 365;
  if (!Number.isFinite(value) || !valid) {
    return { kind: "clarification", message: field === "durationMinutes" ? "Appointment duration must be from 5 minutes to 12 hours." : field === "minNoticeMinutes" ? "Minimum booking notice must be from 0 minutes to 30 days." : "Booking windows must be from 1 to 365 whole days." };
  }

  const appointmentTypeName = fieldPattern ? requestedTypeName(text, fieldPattern, valuePattern) : null;
  return { kind: "update", field, value, appointmentTypeName };
}
