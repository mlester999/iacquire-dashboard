import "server-only";
import type { Queryable } from "@/server/db";
import { eventActor, type CrmActor } from "@/server/crm/actor";

/**
 * Transactional outbox. Call these with the same `db` as the change itself, so the change and its event commit (or roll back)
 * together. The scheduler dispatches events to workflows and webhooks later; nothing here calls out.
 */

export interface CrmEventInput {
  type: string;
  entityType: string;
  entityId?: string | null;
  contactId?: string | null;
  payload?: Record<string, unknown>;
  /** Identifies the logical event. A retry with the same key (a double click, a redelivered webhook) records nothing new. */
  dedupeKey: string;
  /** The event that caused this one, when an automation acted. Its depth + 1 is recorded so loops stop. */
  causedBy?: { eventId: number; depth: number } | null;
}

export const MAX_EVENT_DEPTH = 8;

export async function emitEvent(db: Queryable, actor: CrmActor, e: CrmEventInput): Promise<{ id: number | null; duplicate: boolean }> {
  const a = eventActor(actor);
  const depth = e.causedBy ? e.causedBy.depth + 1 : 0;
  if (depth > MAX_EVENT_DEPTH) return { id: null, duplicate: false };
  const { rows } = await db.query<{ id: string }>(
    `insert into crm_events (org_id, type, entity_type, entity_id, contact_id, payload, dedupe_key, actor_kind, actor_id, causation_event_id, depth)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     on conflict (org_id, dedupe_key) do nothing returning id`,
    [
      actor.orgId, e.type, e.entityType, e.entityId ?? null, e.contactId ?? null, JSON.stringify(e.payload ?? {}), e.dedupeKey.slice(0, 300),
      actor.kind === "system" && e.causedBy ? "workflow" : a.kind, a.id, e.causedBy?.eventId ?? null, depth,
    ],
  );
  return rows[0] ? { id: Number(rows[0].id), duplicate: false } : { id: null, duplicate: true };
}

export interface ActivityInput {
  kind: string;
  summary: string;
  contactId?: string | null;
  companyId?: string | null;
  opportunityId?: string | null;
  refType?: string;
  refId?: string;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
}

/** Records something that happened on the timeline. Only call this for things that actually happened. */
export async function recordActivity(db: Queryable, actor: CrmActor, a: ActivityInput): Promise<void> {
  const who = eventActor(actor);
  const actorKind = who.kind === "api" ? "api" : who.kind;
  await db.query(
    `insert into crm_activities (org_id, contact_id, company_id, opportunity_id, kind, summary, actor_kind, actor_user_id, agent_id, ref_type, ref_id, metadata, occurred_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      actor.orgId, a.contactId ?? null, a.companyId ?? null, a.opportunityId ?? null, a.kind, a.summary.slice(0, 300) || a.kind, actorKind,
      actor.kind === "member" || actor.kind === "agency" ? actor.userId : null, actor.agentId, a.refType ?? null, a.refId ?? null,
      JSON.stringify(a.metadata ?? {}), a.occurredAt ?? new Date(),
    ],
  );
  if (a.contactId) await db.query("update contacts set last_activity_at = greatest(coalesce(last_activity_at, 'epoch'), $3) where id = $1 and org_id = $2", [a.contactId, actor.orgId, a.occurredAt ?? new Date()]);
}
