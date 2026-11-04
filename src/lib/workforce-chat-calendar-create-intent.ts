import type { WorkforceRoleKey } from "@/lib/agents";

export type WorkforceChatCalendarCreateIntent =
  | { kind: "none" }
  | { kind: "clarification"; message: string }
  | {
      kind: "create";
      calendarName: string;
      hostTarget: string | null;
      appointmentTypeName: string;
      durationMinutes: number;
    };

const NONE: WorkforceChatCalendarCreateIntent = { kind: "none" };

/** Parses only direct, explicit calendar creation requests; all host identities are resolved against active workspace members later. */
export function parseWorkforceChatCalendarCreateIntent(role: WorkforceRoleKey, content: string): WorkforceChatCalendarCreateIntent {
  if (role !== "growth_partner") return NONE;
  const text = content.replace(/\s+/g, " ").trim();
  if (!/^(?:please\s+)?(?:create|make|set\s+up)\b/i.test(text) || !/\bcalendar\b/i.test(text)) return NONE;

  const named = text.match(/\bcalendar\s+(?:named|called)\s+(.+?)(?=\s+for\b|\s+with\b|[.;]|$)/i)?.[1]?.trim();
  const implied = text.match(/^(?:please\s+)?(?:create|make|set\s+up)\s+(?:a\s+|an\s+|the\s+|new\s+)?(.+?)\s+calendar\b/i)?.[1]?.trim();
  const calendarName = (named ?? implied ?? "").replace(/^(?:a\s+|an\s+|new\s+)/i, "").trim();
  if (!calendarName || /^(?:a|an|the|new)$/i.test(calendarName) || calendarName.length > 80) {
    return { kind: "clarification", message: "What should I name the calendar? I haven't changed any calendar settings." };
  }

  const hostTarget = text.match(/\bfor\s+(.+?)(?=\s+with\s+(?:a\s+)?(?:appointment|type|\d+)\b|\s+lasting\b|\s+(?:appointment\s+)?duration\b|[.;]|$)/i)?.[1]?.trim() ?? null;
  const durationMatch = text.match(/\b(?:lasting|(?:appointment\s+)?duration(?:\s+of)?)\s+(\d+)\s*(minutes?|mins?|hours?|hrs?)\b|\bwith\s+a\s+(\d+)\s*[- ]\s*(minutes?|mins?|hours?|hrs?)\s+appointment\b/i);
  const rawDuration = Number(durationMatch?.[1] ?? durationMatch?.[3] ?? 30);
  const durationUnit = (durationMatch?.[2] ?? durationMatch?.[4] ?? "minutes").toLowerCase();
  const durationMinutes = /^(?:hours?|hrs?)$/.test(durationUnit) ? rawDuration * 60 : rawDuration;
  if (!Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 720) {
    return { kind: "clarification", message: "Appointment duration must be from 5 minutes to 12 hours. I haven't changed any calendar settings." };
  }

  const explicitType = text.match(/\bwith\s+(?:an?\s+)?appointment\s+type\s+(?:named\s+|called\s+)?([^.;,]+?)(?=\s+(?:lasting|duration)\b|$)/i)?.[1]?.trim();
  const appointmentTypeName = (explicitType || calendarName).replace(/[.!?]+$/, "").trim();
  if (!appointmentTypeName || appointmentTypeName.length > 80) {
    return { kind: "clarification", message: "What should I call the appointment type? I haven't changed any calendar settings." };
  }

  return { kind: "create", calendarName, hostTarget, appointmentTypeName, durationMinutes };
}
