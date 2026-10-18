import "server-only";
import type { Queryable } from "@/server/db";
import { eventActor, type CrmActor } from "@/server/crm/actor";

/**
 * Transactional outbox. Call these with the same `db` as the change itself, so the change and its event commit (or roll back)
 * together. The scheduler dispatches events later (src/server/crm/dispatch.ts: workflows, lead assignment, follow-ups and outbound
 * webhooks); nothing here calls out.
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
  /** The customer themselves acted (an inbound message): recorded as actor kind "contact" instead of the actor's own kind. */
  byContact?: boolean;
}

/** An event automations caused at this depth or deeper is not recorded (emitEvent returns a null id), which ends a loop. */
export const MAX_EVENT_DEPTH = 8;

/** An event as the dispatcher hands it to every subscriber (workflows, assignment, follow-ups, webhooks). */
export interface CrmEventRow {
  id: number;
  orgId: string;
  type: string;
  entityType: string;
  entityId: string | null;
  contactId: string | null;
  payload: Record<string, unknown>;
  depth: number;
  actorKind: string;
  occurredAt: string;
}

/** Columns to select for toCrmEventRow. */
export const CRM_EVENT_COLUMNS = "id, org_id, type, entity_type, entity_id, contact_id, payload, depth, actor_kind, occurred_at";

export interface CrmEventDbRow {
  id: string | number;
  org_id: string;
  type: string;
  entity_type: string;
  entity_id: string | null;
  contact_id: string | null;
  payload: Record<string, unknown> | null;
  depth: number;
  actor_kind: string;
  occurred_at: Date | string;
}

export function toCrmEventRow(r: CrmEventDbRow): CrmEventRow {
  return {
    id: Number(r.id), orgId: r.org_id, type: r.type, entityType: r.entity_type, entityId: r.entity_id, contactId: r.contact_id, payload: r.payload ?? {},
    depth: Number(r.depth), actorKind: r.actor_kind, occurredAt: new Date(r.occurred_at).toISOString(),
  };
}

/** One event of one workspace, or null. */
export async function loadEvent(db: Queryable, orgId: string, id: number): Promise<CrmEventRow | null> {
  const { rows } = await db.query<CrmEventDbRow>(`select ${CRM_EVENT_COLUMNS} from crm_events where id = $1 and org_id = $2`, [id, orgId]);
  return rows[0] ? toCrmEventRow(rows[0]) : null;
}

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
      e.byContact ? "contact" : actor.kind === "system" && e.causedBy ? "workflow" : a.kind, e.byContact ? null : a.id, e.causedBy?.eventId ?? null, depth,
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
