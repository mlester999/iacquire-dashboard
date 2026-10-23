import "server-only";
import type { Queryable } from "@/server/db";
import { PROVIDER_CAN_CANCEL } from "@/lib/esign/state";
import { addSigEvent, type RequestRow } from "@/server/esign/core";

// The two things every other part of proposals needs from signing, kept apart from the rest of src/server/esign so that a service which only has to END a request (a revision, a
// withdrawal, an expiry, a privacy request) does not pull in the notifications, the CRM and the worker. Both run in the caller's transaction, after the caller took the
// proposal's row lock (the order every writer uses: the proposal first, then its requests).

/**
 * Brings the proposal's signature_state into line with its requests: requested while one is out, failed when the latest ended without a signature, none otherwise. A signature that
 * was applied (completed) and a signing recorded by a person (recorded_offline) are never moved by this.
 */
export async function refreshSignatureState(db: Queryable, orgId: string, proposalId: string): Promise<void> {
  await db.query(
    `update proposals p set signature_state = case
       when p.signature_state in ('completed', 'recorded_offline') then p.signature_state
       when exists (select 1 from signature_requests r where r.proposal_id = p.id and r.org_id = p.org_id and r.status in ('queued', 'sending', 'sent', 'viewed', 'unknown')) then 'requested'
       when (select r.status from signature_requests r where r.proposal_id = p.id and r.org_id = p.org_id order by r.created_at desc, r.id desc limit 1) in ('failed', 'declined', 'expired') then 'failed'
       else 'none' end
     where p.id = $1 and p.org_id = $2`,
    [proposalId, orgId],
  );
}

export type VoidKind = "voided" | "superseded";

/**
 * Ends every request still out for a proposal (a revision, a withdrawal, an answer recorded by hand, an expiry, the customer's own decline). The caller already holds the proposal's
 * row lock. A request that reached the signing service is marked for withdrawal there (`wanted`) when the service allows it, and otherwise for the business to do by hand
 * (`manual`): iAcquire says so and ignores any signature that arrives later. A request that never reached it has nothing to withdraw. Returns how many were ended.
 */
export async function voidLiveRequestsInTx(
  db: Queryable, orgId: string, proposalId: string, kind: VoidKind, reason: string, o: { userId: string | null; now?: Date },
): Promise<number> {
  // The proposals migration can be applied a step before the signing one; until then there is nothing to end, and a withdrawal or a revision must still work.
  if (!(await db.query<{ t: string | null }>("select to_regclass('public.signature_requests')::text as t")).rows[0]?.t) return 0;
  const now = (o.now ?? new Date()).toISOString();
  const { rows } = await db.query<RequestRow>(
    `select id, provider, provider_document_id, provider_state from signature_requests where proposal_id = $1 and org_id = $2 and status in ('queued', 'sending', 'sent', 'viewed', 'unknown') for update`,
    [proposalId, orgId],
  );
  for (const r of rows) {
    // A document may exist at the service even when its id was not saved yet (a step in flight); the worker adopts it afterwards (see worker.ts).
    const hasDocument = Boolean(r.provider_document_id || r.provider_state?.documentId);
    const cancel = !hasDocument ? "none" : PROVIDER_CAN_CANCEL[r.provider] ? "wanted" : "manual";
    await db.query(
      "update signature_requests set status = $3, void_reason = $4, cancel_state = $5, finished_at = $6::timestamptz, lease_until = null, claimed_by = null where id = $1 and org_id = $2",
      [r.id, orgId, kind, reason.slice(0, 200), cancel, now],
    );
    await addSigEvent(db, orgId, r.id, kind, o.userId ? "user" : "system", { reason: reason.slice(0, 200), cancel });
  }
  if (rows.length) await refreshSignatureState(db, orgId, proposalId);
  return rows.length;
}
