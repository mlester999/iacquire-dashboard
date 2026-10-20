import "server-only";
import type { Queryable } from "@/server/db";
import { isClientVisibleEvent, type EventKind } from "@/lib/support/lifecycle";

export interface TicketEventInput {
  ticketId: string;
  orgId: string;
  kind: EventKind;
  actorUserId?: string | null;
  actorKind: "client" | "agency" | "system";
  from?: string | null;
  to?: string | null;
  detail?: string | null;
  /** Defaults to the kind's usual audience (see CLIENT_VISIBLE_EVENTS). Pass "internal" to keep a normally public kind private. */
  visibility?: "client" | "internal";
}

/**
 * Writes one line of a request's timeline. Status, priority, assignment and escalation history live here and in the audit log;
 * only the events marked "client" are ever shown to the client (row-level security enforces it as well).
 */
export async function recordTicketEvent(db: Queryable, e: TicketEventInput): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into support_ticket_events (ticket_id, org_id, kind, visibility, actor_user_id, actor_kind, from_value, to_value, detail)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [
      e.ticketId, e.orgId, e.kind, e.visibility ?? (isClientVisibleEvent(e.kind) ? "client" : "internal"), e.actorUserId ?? null, e.actorKind,
      e.from?.slice(0, 80) ?? null, e.to?.slice(0, 80) ?? null, e.detail?.slice(0, 500) ?? null,
    ],
  );
  return rows[0].id;
}
