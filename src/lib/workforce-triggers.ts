import type { CapabilityKey } from "@/lib/workforce-capabilities";

/**
 * Reviewed event types that may start a read-only AI review, and the capability each one uses.
 * Anything not listed here is refused by the trigger service. This is deliberately narrow: a
 * reviewed exceptional event, not a firehose of every CRM change.
 */
export const TRIGGER_EVENT_CAPABILITIES: Record<string, CapabilityKey> = {
  "appointment.cancelled": "appointment_review",
  "appointment.no_show": "appointment_review",
  "opportunity.lost": "pipeline_review",
};

export const TRIGGER_EVENT_LABELS: Record<string, string> = {
  "appointment.cancelled": "Appointment cancelled",
  "appointment.no_show": "Appointment no-show",
  "opportunity.lost": "Deal marked lost",
};

export const TRIGGER_EVENT_TYPES = Object.keys(TRIGGER_EVENT_CAPABILITIES);
