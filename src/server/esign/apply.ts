import "server-only";
import type { Queryable } from "@/server/db";
import { recordAudit } from "@/server/audit";
import { notifyOrgRoles, notifyUser } from "@/server/notifications";
import { sanitizeErrorText } from "@/lib/ops";
import { systemActor, type CrmActor } from "@/server/crm/actor";
import { emitEvent, recordActivity } from "@/server/crm/events";
import {
  applyFact, completionVerdict, maskedEmail, NOT_APPLIED_TEXT, PROVIDER_LABELS, type NotAppliedReason, type ProviderFact, type RequestStatus,
} from "@/lib/esign/state";
import type { FailureKind } from "@/lib/esign/errors";
import { contentHash } from "@/lib/proposals/hash";
import { validityOn } from "@/lib/proposals/validity";
import { addEvent as addProposalEvent, loadProposalRow, loadVersionRow, readSettings, type ProposalRow } from "@/server/proposals/core";
import { applyEffects } from "@/server/proposals/crm-effects";
import { withdrawDeliveriesInTx } from "@/server/proposals/delivery";
import { addSigEvent, loadRequest, type EventSource, type RequestRow } from "@/server/esign/core";
import { refreshSignatureState } from "@/server/esign/lifecycle";

// What the signing service's word does to a request and to the proposal. Everything here runs in the caller's transaction, takes the proposal's row lock before the request's
// (the order every writer uses), and is idempotent: a delivery that was already recorded changes nothing, and a fact that would move a request backwards is recorded and ignored.
//
// A signature is the service's fact. It becomes an ACCEPTANCE of the proposal only when completionVerdict says so (src/lib/esign/state.ts): the proposal is still sent, on the very
// version the signer was asked to sign, unanswered and not past its date. Otherwise it is kept as the service's fact and set aside with its reason; it is never applied to a newer
// version, and it never reopens a closed proposal.

export type FactOutcome =
  | { kind: "duplicate" }
  | { kind: "ignored"; why: "no_change" | "behind" | "conflict" }
  | { kind: "changed"; status: RequestStatus; applied?: boolean; notApplied?: NotAppliedReason };

export interface FactOptions {
  source: EventSource;
  /** The delivery's event id; null for something read by polling. */
  eventId: string | null;
  now: Date;
}

interface OrgFacts {
  name: string;
  timezone: string;
}

async function orgFacts(db: Queryable, orgId: string): Promise<OrgFacts> {
  const r = (await db.query<{ name: string; timezone: string }>("select name, timezone from organizations where id = $1", [orgId])).rows[0];
  return { name: r?.name ?? "", timezone: r?.timezone ?? "UTC" };
}

/** Runs one side effect in its own savepoint. A failure is written on the request's history and swallowed: a fact the service reported is never lost to a notification that failed. */
async function guarded(db: Queryable, req: Pick<RequestRow, "id" | "org_id">, effect: string, fn: () => Promise<void>): Promise<void> {
  await db.query("savepoint esign_effect");
  try {
    await fn();
    await db.query("release savepoint esign_effect");
  } catch (e) {
    await db.query("rollback to savepoint esign_effect");
    await db.query("release savepoint esign_effect");
    await addSigEvent(db, req.org_id, req.id, "effect_failed", "system", { effect, message: sanitizeErrorText(e).slice(0, 300) });
  }
}

export { refreshSignatureState, voidLiveRequestsInTx, type VoidKind } from "@/server/esign/lifecycle";

// ---------------------------------------------------------------------------
// The service's word
// ---------------------------------------------------------------------------

const FACT_TEXT: Record<"declined" | "expired", { title: (n: string) => string; body: (who: string) => string }> = {
  declined: { title: (n) => `The signer declined ${n}`, body: (who) => `${who} declined to sign. The proposal is still open; you can ask again or contact them.` },
  expired: { title: (n) => `The signing request for ${n} ran out`, body: (who) => `${who} did not sign before the request ran out. The proposal is still open; you can ask again.` },
};

/**
 * Applies one fact the service reported (a verified webhook delivery, or a status read with the client's own key). Forward only; a delivery already recorded is a no-op. Returns
 * what happened, or null when the request is not in this workspace. The caller owns the transaction.
 */
export async function applyProviderFact(db: Queryable, orgId: string, requestId: string, fact: ProviderFact, o: FactOptions): Promise<FactOutcome | null> {
  const peek = await loadRequest(db, orgId, requestId);
  if (!peek) return null;
  const proposal = await loadProposalRow(db, orgId, peek.proposal_id, true);
  const req = await loadRequest(db, orgId, requestId, true);
  if (!proposal || !req) return null;

  const verdict = applyFact(req.status, fact);
  if ("ignore" in verdict) {
    // A delivery that changes nothing is still written down once, so a replay of it is recognised; a status read by polling that shows nothing new leaves no trace.
    if (o.eventId && !(await addSigEvent(db, orgId, req.id, "delivery_ignored", o.source, { fact, why: verdict.ignore, status: req.status }, o.eventId))) return { kind: "duplicate" };
    return { kind: "ignored", why: verdict.ignore };
  }
  if (!(await addSigEvent(db, orgId, req.id, fact, o.source, { from: req.status }, o.eventId))) return { kind: "duplicate" };

  const org = await orgFacts(db, orgId);
  const label = PROVIDER_LABELS[req.provider];
  const next = verdict.change;
  switch (fact) {
    case "sent":
    case "viewed":
      await db.query(
        `update signature_requests set status = $3, sent_at = coalesce(sent_at, $4::timestamptz), lease_until = null, claimed_by = null,
           provider_state = (provider_state - 'sendingAt' - 'step') || '{"ready": true, "sent": true}'::jsonb, last_error = null, last_error_kind = null
         where id = $1 and org_id = $2`,
        [req.id, orgId, next, o.now.toISOString()],
      );
      await refreshSignatureState(db, orgId, proposal.id);
      return { kind: "changed", status: next };
    case "declined":
    case "expired":
      await db.query("update signature_requests set status = $3, finished_at = $4::timestamptz, lease_until = null, claimed_by = null where id = $1 and org_id = $2", [req.id, orgId, next, o.now.toISOString()]);
      await refreshSignatureState(db, orgId, proposal.id);
      await announceEnded(db, systemActor({ id: orgId, name: org.name, timezone: org.timezone }, label), proposal, req, fact);
      return { kind: "changed", status: next };
    case "voided":
      // Someone withdrew the document in the signing service itself.
      await db.query(
        "update signature_requests set status = 'voided', void_reason = 'The document was withdrawn at the signing service.', cancel_state = 'done', finished_at = $3::timestamptz, lease_until = null, claimed_by = null where id = $1 and org_id = $2",
        [req.id, orgId, o.now.toISOString()],
      );
      await refreshSignatureState(db, orgId, proposal.id);
      return { kind: "changed", status: "voided" };
    case "completed":
      return completeRequest(db, proposal, req, org, o);
  }
}

/** Tells the team a request ended without a signature, once per request, and lets workflows know. */
async function announceEnded(db: Queryable, actor: CrmActor, proposal: ProposalRow, req: RequestRow, why: "declined" | "expired" | "failed", message?: string): Promise<void> {
  const who = req.signer_name;
  const text = why === "failed"
    ? { title: `A signing request for ${proposal.number} could not be sent`, body: message ?? "The signing service did not accept the request. Nothing was sent to the signer." }
    : { title: FACT_TEXT[why].title(proposal.number), body: FACT_TEXT[why].body(who) };
  await addProposalEvent(db, proposal.org_id, proposal.id, req.proposal_version, `signature_${why}`, { id: null, kind: "provider" }, { requestId: req.id, signer: maskedEmail(req.signer_email) });
  await guarded(db, req, "notify", async () => {
    const note = { kind: "signature_failed" as const, severity: "warning" as const, title: text.title, body: text.body.slice(0, 300), link: `/proposals/${proposal.id}?tab=signature`, dedupeKey: `signature-${why}:${req.id}` };
    await notifyOrgRoles(db, proposal.org_id, ["owner", "admin"], note);
    if (req.created_by) await notifyUser(db, req.created_by, proposal.org_id, note);
  });
  await guarded(db, req, "event", async () => {
    await emitEvent(db, actor, {
      type: "signature.failed", entityType: "proposal", entityId: proposal.id, contactId: proposal.contact_id, dedupeKey: `signature.failed:${req.id}`,
      payload: { proposalId: proposal.id, number: proposal.number, version: req.proposal_version, requestId: req.id, reason: why, opportunityId: proposal.opportunity_id },
    });
  });
  if (proposal.contact_id || proposal.company_id || proposal.opportunity_id) {
    await guarded(db, req, "timeline", () => recordActivity(db, actor, {
      kind: "proposal.signature_failed",
      summary: why === "declined" ? `${who} declined to sign proposal ${proposal.number}` : why === "expired" ? `The signing request for proposal ${proposal.number} ran out` : `The signing request for proposal ${proposal.number} could not be sent`,
      contactId: proposal.contact_id, companyId: proposal.company_id, opportunityId: proposal.opportunity_id, refType: "proposal", refId: proposal.id, metadata: { number: proposal.number, version: req.proposal_version },
    }));
  }
}

/** A request that could not be made or sent (a definite answer). Final; the person is told and may ask again. */
export async function failRequest(db: Queryable, orgId: string, requestId: string, message: string, kind: FailureKind | null, now: Date): Promise<void> {
  const peek = await loadRequest(db, orgId, requestId);
  if (!peek) return;
  const proposal = await loadProposalRow(db, orgId, peek.proposal_id, true);
  const req = await loadRequest(db, orgId, requestId, true);
  if (!proposal || !req || !["queued", "sending", "unknown"].includes(req.status)) return;
  // A document the service may already hold stays there: the business is asked to look at it (`manual`), because iAcquire cannot tell whether it can be withdrawn.
  await db.query(
    `update signature_requests set status = 'failed', last_error = $3, last_error_kind = $4, finished_at = $5::timestamptz, lease_until = null, claimed_by = null,
       cancel_state = case when cancel_state = 'none' and (provider_document_id is not null or jsonb_exists(provider_state, 'documentId')) then 'manual' else cancel_state end
     where id = $1 and org_id = $2`,
    [req.id, orgId, message.slice(0, 400), kind, now.toISOString()],
  );
  await addSigEvent(db, orgId, req.id, "failed", "system", { kind, message: message.slice(0, 300) });
  await refreshSignatureState(db, orgId, proposal.id);
  const org = await orgFacts(db, orgId);
  await announceEnded(db, systemActor({ id: orgId, name: org.name, timezone: org.timezone }, PROVIDER_LABELS[req.provider]), proposal, req, "failed", message);
  await recordAudit({ orgId, actorKind: "system", action: "proposals.signature_failed", targetType: "proposal", targetId: proposal.id, result: "failure", metadata: { requestId: req.id, kind } }, db);
}

// ---------------------------------------------------------------------------
// A signature
// ---------------------------------------------------------------------------

async function completeRequest(db: Queryable, proposal: ProposalRow, req: RequestRow, org: OrgFacts, o: FactOptions): Promise<FactOutcome> {
  const orgId = proposal.org_id;
  const label = PROVIDER_LABELS[req.provider];
  const wasStatus = req.status;
  const version = await loadVersionRow(db, orgId, proposal.id, req.proposal_version);
  const intact = Boolean(version) && contentHash(version?.snapshot) === version?.content_hash && version?.content_hash === req.version_hash;
  const answered = (await db.query("select 1 from proposal_decisions where proposal_id = $1 and org_id = $2 and version = $3 and decision in ('accepted', 'declined')", [proposal.id, orgId, req.proposal_version])).rows.length > 0;
  const verdict = completionVerdict({
    requestStatus: wasStatus, requestVersion: req.proposal_version, proposalStatus: proposal.status, proposalVersion: proposal.version, sentVersion: proposal.sent_version,
    versionIntact: intact, alreadyAnswered: answered, pastDate: validityOn(proposal.valid_until, o.now, org.timezone) === "expired",
  });
  const common = "status = 'completed', completed_at = $3::timestamptz, finished_at = coalesce(finished_at, $3::timestamptz), lease_until = null, claimed_by = null, copy_next_at = $3::timestamptz";
  if (!verdict.apply) {
    await db.query(`update signature_requests set ${common}, not_applied_reason = $4 where id = $1 and org_id = $2`, [req.id, orgId, o.now.toISOString(), verdict.reason]);
    await addSigEvent(db, orgId, req.id, "signature_not_applied", "system", { reason: verdict.reason });
    await addProposalEvent(db, orgId, proposal.id, req.proposal_version, "signature_not_applied", { id: null, kind: "provider" }, { requestId: req.id, reason: verdict.reason });
    await refreshSignatureState(db, orgId, proposal.id);
    await guarded(db, req, "notify", async () => {
      const note = {
        kind: "signature_completed" as const, severity: "warning" as const, title: `${proposal.number} was signed, but the signature was not applied`, body: NOT_APPLIED_TEXT[verdict.reason].slice(0, 300),
        link: `/proposals/${proposal.id}?tab=signature`, dedupeKey: `signature-not-applied:${req.id}`,
      };
      await notifyOrgRoles(db, orgId, ["owner", "admin"], note);
      if (req.created_by) await notifyUser(db, req.created_by, orgId, note);
    });
    return { kind: "changed", status: "completed", applied: false, notApplied: verdict.reason };
  }

  const inserted = await db.query<{ id: string }>(
    `insert into proposal_decisions (org_id, proposal_id, version, content_hash, decision, method, decided_name, decided_email, signature_request_id, decided_at)
     values ($1, $2, $3, $4, 'accepted', 'provider_signature', $5, $6, $7, $8::timestamptz)
     on conflict (proposal_id, version) where decision in ('accepted', 'declined') do nothing returning id`,
    [orgId, proposal.id, req.proposal_version, req.version_hash, req.signer_name, req.signer_email, req.id, o.now.toISOString()],
  );
  if (!inserted.rows[0]) {
    // Another answer landed between the check and the write (the proposal is locked, so this should not happen); the signature is kept and set aside.
    await db.query(`update signature_requests set ${common}, not_applied_reason = 'already_answered' where id = $1 and org_id = $2`, [req.id, orgId, o.now.toISOString()]);
    await addSigEvent(db, orgId, req.id, "signature_not_applied", "system", { reason: "already_answered" });
    await refreshSignatureState(db, orgId, proposal.id);
    return { kind: "changed", status: "completed", applied: false, notApplied: "already_answered" };
  }
  // The customer's link is left as it is, like an acceptance on the page: it now shows their answer ("signed through a signing service") instead of "no longer active".
  await db.query("update proposals set status = 'accepted', closed_at = $3::timestamptz, signature_state = 'completed' where id = $1 and org_id = $2", [proposal.id, orgId, o.now.toISOString()]);
  // A message that carries the link and is still waiting for sending hours would tell a customer who has signed that the proposal is ready for them.
  await withdrawDeliveriesInTx(db, orgId, proposal.id, "proposal_answered");
  await db.query(`update signature_requests set ${common}, applied_at = $3::timestamptz where id = $1 and org_id = $2`, [req.id, orgId, o.now.toISOString()]);
  await addSigEvent(db, orgId, req.id, "signature_applied", "system", { version: req.proposal_version });
  await addProposalEvent(db, orgId, proposal.id, req.proposal_version, "accepted", { id: null, kind: "provider" }, { method: "provider_signature", requestId: req.id, provider: req.provider, signer: maskedEmail(req.signer_email) });
  await recordAudit({ orgId, actorKind: "system", action: "proposals.signature_applied", targetType: "proposal", targetId: proposal.id, result: "success", metadata: { version: req.proposal_version, requestId: req.id, provider: req.provider, mode: req.mode } }, db);
  const after = (await loadProposalRow(db, orgId, proposal.id)) as ProposalRow;
  await applyEffects(db, systemActor({ id: orgId, name: org.name, timezone: org.timezone }, label), after, "accepted", await readSettings(db, orgId), { viaSignature: { requestId: req.id, providerLabel: label }, byName: label, byCustomer: true });
  return { kind: "changed", status: "completed", applied: true };
}
