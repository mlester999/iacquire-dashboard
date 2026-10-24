import "server-only";
import type { Queryable } from "@/server/db";
import { recordAudit } from "@/server/audit";
import { releaseReservation } from "@/server/billing/ledger";
import { cancelLinkRequests } from "@/server/retention/cancel";
import { refreshBatchCounts } from "@/server/reputation/batch-state";

// A person's hold on automatic messages to one customer (contacts.retention_paused, src/server/retention/service.ts setRetentionPaused) must stop what was already planned, not
// only what has not been made yet. An automatic review ask (a workflow, the API, a batch) can be queued days ahead, waiting for a sending window; the hold is checked when the
// ask is made and, here, again when it is placed, and by the dispatcher right before sending (src/server/messaging/dispatch-gate.ts). A person pressing Send is never stopped.

/** The reason a message stopped by the hold is recorded with (BLOCK_REASON_LABELS has its words). */
export const HELD_BY_PERSON = "held_by_person";

const STOPPED_DETAIL = "Stopped before sending: a person on your team excluded this customer from automatic messages.";

/**
 * Stops one customer's automatic review asks (not a person's own) that have not gone out: the message is stopped and its credit hold given back, and what follows from that
 * (settleHeldAsks). Called in the same transaction that sets the hold. Returns how many asks were withdrawn.
 */
export async function withdrawAutomaticReviewAsks(db: Queryable, orgId: string, contactId: string): Promise<number> {
  const { rows } = await db.query<{ id: string; reservation_id: string | null }>(
    `update conversation_messages m set status = 'blocked', blocked_reason = $3, status_detail = $4
     from crm_review_requests r
     where r.org_id = $1 and r.contact_id = $2 and r.message_id = m.id and m.org_id = r.org_id and r.requested_via <> 'manual' and r.status in ('pending', 'queued') and m.status in ('draft', 'queued')
     returning m.id, m.reservation_id`,
    [orgId, contactId, HELD_BY_PERSON, STOPPED_DETAIL],
  );
  for (const m of rows) if (m.reservation_id) await releaseReservation(db, { orgId, reservationId: m.reservation_id, reason: "Stopped: held by a person" });
  await settleHeldAsks(db, orgId, rows.map((m) => m.id));
  return rows.length;
}

/**
 * What follows once the messages of automatic review asks are stopped because of a person's hold: each request is audited the way a held ask is anywhere else (so the Reviews
 * numbers count it) and cancelled (its link stops taking feedback), and a batch's item for it is left out as held, with the batch's counts brought up to date. The dispatcher calls
 * this for a message it refused at the last moment; a message with no review request behind it changes nothing here.
 */
export async function settleHeldAsks(db: Queryable, orgId: string, messageIds: string[]): Promise<void> {
  if (!messageIds.length) return;
  const asks = await db.query<{ contact_id: string; requested_via: string }>(
    "select contact_id, requested_via from crm_review_requests where org_id = $1 and message_id = any($2::uuid[]) and status in ('pending', 'queued')",
    [orgId, messageIds],
  );
  for (const a of asks.rows) {
    await recordAudit({ orgId, actorKind: "system", action: "crm.review_request_held", targetType: "contact", targetId: a.contact_id, result: "denied", metadata: { via: a.requested_via, reason: HELD_BY_PERSON, withdrawn: true } }, db);
  }
  await cancelLinkRequests(db, orgId, messageIds);
  const items = await db.query<{ batch_id: string }>(
    `update review_request_batch_items i set status = 'excluded', reason = $3, updated_at = now()
     from crm_review_requests r where r.id = i.request_id and r.org_id = i.org_id and i.org_id = $1 and r.message_id = any($2::uuid[]) and i.status = 'queued'
     returning i.batch_id`,
    [orgId, messageIds, HELD_BY_PERSON],
  );
  for (const batchId of new Set(items.rows.map((i) => i.batch_id))) await refreshBatchCounts(db, { id: batchId, org_id: orgId, counts: null });
}
