import "server-only";
import type { Queryable } from "@/server/db";
import type { CrmEventRow } from "@/server/crm/events";
import { ACTIVE_STATES } from "@/lib/missed-calls/state";

/**
 * The CRM event dispatcher's subscriber for missed-call recovery. Something happened to a contact that could settle or stop an open case (the
 * caller wrote back, an appointment was booked, a consent changed, a teammate took the conversation, a call ended): the case is made due now, so
 * the worker looks at it on its next run instead of when its own timer says. It decides nothing itself, and it is idempotent: waking a case twice
 * wakes it once. The worker re-reads the facts, so a stale event cannot cause a wrong action.
 */
export const WAKING_EVENTS: ReadonlySet<string> = new Set([
  "conversation.message_received",
  "conversation.assigned",
  "conversation.handoff_requested",
  "appointment.booked",
  "appointment.confirmed",
  "contact.consent_changed",
  "call.completed",
]);

export async function missedCallsOnEvent(db: Queryable, event: CrmEventRow, now: Date): Promise<number> {
  if (!event.contactId || !WAKING_EVENTS.has(event.type)) return 0;
  const r = await db.query<{ id: string }>(
    `update missed_call_cases set next_action_at = $3
     where org_id = $1 and contact_id = $2 and state = any($4::text[]) and paused_at is null and (next_action_at is null or next_action_at > $3) returning id`,
    [event.orgId, event.contactId, now, ACTIVE_STATES],
  );
  return r.rows.length;
}
