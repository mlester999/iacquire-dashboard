import "server-only";
import type { Queryable } from "@/server/db";
import { emitEvent } from "@/server/crm/events";
import { systemActor } from "@/server/crm/actor";
import type { ConversationEventKind } from "@/lib/inbox";

/** Who did it. `workflow` is an Automation Studio / CRM workflow step, never a person and never an AI employee. */
export type ConversationEventActor =
  | { kind: "user"; userId: string }
  | { kind: "ai"; agentId: string | null }
  | { kind: "system" }
  | { kind: "workflow" }
  | { kind: "agency"; userId: string };

export interface ConversationEventInput {
  orgId: string;
  conversationId: string;
  kind: ConversationEventKind;
  actor: ConversationEventActor;
  /** Ids, enums and short labels only. Never message text, names or contact details (the table is not redacted when a contact is erased). */
  detail?: Record<string, unknown>;
  /** The CRM event that caused this one (a workflow step), so automation chains stop at the loop limit. */
  causedBy?: { eventId: number; depth: number } | null;
}

/** The CRM event type a lifecycle event starts workflows with, when it has one. Quiet changes (a priority change to "low") start nothing. */
function workflowTrigger(kind: ConversationEventKind, detail: Record<string, unknown>): string | null {
  switch (kind) {
    case "assigned":
      return detail.to ? "conversation.assigned" : null;
    case "status_changed":
      return detail.to === "closed" ? "conversation.resolved" : null;
    case "priority_changed":
      return detail.to === "urgent" ? "conversation.urgent" : null;
    case "handoff_requested":
      return "conversation.handoff_requested";
    default:
      return null;
  }
}

/**
 * Appends one lifecycle event to the conversation's trail and, for the few that automations can react to, records the matching CRM event in
 * the same transaction (the outbox the workflow dispatcher reads). The CRM event's key is this event's id, so it is announced exactly once.
 * Call it with the `db` of the change itself so the change and its event commit together.
 */
export async function recordConversationEvent(db: Queryable, e: ConversationEventInput): Promise<{ id: number }> {
  const detail = e.detail ?? {};
  const { rows } = await db.query<{ id: string }>(
    `insert into conversation_events (org_id, conversation_id, kind, actor_kind, actor_user_id, agent_id, detail)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [
      e.orgId, e.conversationId, e.kind, e.actor.kind,
      e.actor.kind === "user" || e.actor.kind === "agency" ? e.actor.userId : null,
      e.actor.kind === "ai" ? e.actor.agentId : null,
      JSON.stringify(detail),
    ],
  );
  const id = Number(rows[0].id);
  const trigger = workflowTrigger(e.kind, detail);
  if (trigger) {
    const { rows: c } = await db.query<{ contact_id: string; channel: string }>("select contact_id, channel from conversations where id = $1 and org_id = $2", [e.conversationId, e.orgId]);
    if (c[0]) {
      await emitEvent(db, systemActor({ id: e.orgId }), {
        type: trigger,
        entityType: "conversation",
        entityId: e.conversationId,
        contactId: c[0].contact_id,
        payload: { conversationId: e.conversationId, channel: c[0].channel, ...detail },
        dedupeKey: `${trigger}:${id}`,
        causedBy: e.causedBy ?? null,
      });
    }
  }
  return { id };
}
