import "server-only";
import type { Queryable } from "@/server/db";
import type { CrmEventRow } from "@/server/crm/events";
import { requestReassessment } from "@/server/lead-scoring/queue";

/**
 * The CRM event dispatcher's subscriber for lead scoring: something happened to a contact that could change how they score, so a new look is
 * asked for (debounced, deduplicated, one queue row per contact). It never scores anything itself.
 *
 * Loop protection: events the scoring engine and the recovery engine emit (`lead.*`, `recovery.*`) never ask for a reassessment, so a workflow
 * that reacts to a score change can't set the engine off again by that route; the same holds for the ones an assessment is the result of.
 */
export const SCORING_TRIGGERS: ReadonlySet<string> = new Set([
  "contact.created", "contact.updated", "contact.tag_added", "contact.tag_removed", "contact.consent_changed",
  "opportunity.created", "opportunity.stage_changed", "opportunity.won", "opportunity.lost", "opportunity.reopened",
  "appointment.booked", "appointment.rescheduled", "appointment.cancelled", "appointment.no_show", "appointment.showed", "appointment.confirmed",
  "conversation.message_received", "call.completed", "call.missed", "form.submitted",
]);

/** Contact changes that cannot change a score (who owns the contact, the hand-entered score). */
const IRRELEVANT_FIELDS = new Set(["leadScore", "lead_score", "ownerId", "assignedUserId", "assigned_user_id", "owner"]);

export async function leadScoringOnEvent(db: Queryable, event: CrmEventRow, now: Date): Promise<number> {
  if (!event.contactId || !SCORING_TRIGGERS.has(event.type)) return 0;
  if (event.type === "contact.updated") {
    const changed = Array.isArray(event.payload.changedFields) ? (event.payload.changedFields as unknown[]).filter((f): f is string => typeof f === "string") : [];
    if (changed.length && changed.every((f) => IRRELEVANT_FIELDS.has(f))) return 0;
  }
  await requestReassessment(db, event.orgId, event.contactId, event.type, { now });
  return 1;
}
