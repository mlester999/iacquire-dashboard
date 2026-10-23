import "server-only";
import type { Queryable } from "@/server/db";
import { addEvent } from "@/server/proposals/core";
import { voidLiveRequestsInTx } from "@/server/esign/lifecycle";

// What a privacy request does to proposals (called from redactContact, inside its transaction). It is the part that can be done without a decision the founder has not made.
//
// Done now: every proposal for the person that is not yet final is withdrawn and its customer link stops working (nothing more is offered to someone who asked to be forgotten);
// their emailed-code challenges and sessions are deleted; the address and name kept on each link are removed; and the person's name, company and address are removed from each
// proposal's working copy.
//
// A signing request that is still out for one of those proposals is ended with it (a signature that arrives afterwards is not applied). One that is over is a record of what the
// signer was asked and what they did, and is kept like the answers below.
//
// NOT done, on purpose: the frozen version of a proposal, the recorded answer (with the name and address it was recorded with), the signing requests and the history are
// append-only records of what was sent and what was agreed, bound to a hash. Editing them would destroy the evidence they exist to be, and whether an accepted proposal must be kept, for how long, or erased
// regardless is a legal question for counsel and the founder (docs/roadmap/phases-3-to-7/blockers.md). Until that is decided they are kept and the count is returned, so the
// person processing the request can say exactly what was and was not removed.

export interface ProposalErasure {
  /** Proposals that were open and are now withdrawn. */
  withdrawn: number;
  /** Proposals whose working copy no longer holds the person's name, company or address. */
  redacted: number;
  /** Frozen versions, recorded answers and signing requests that still hold the person's details because they are records. */
  retainedRecords: number;
  /** Signing requests that were still out and are now ended (a signature that arrives for one is not applied). */
  signingEnded: number;
}

const OPEN = ["draft", "pending_approval", "changes_requested", "approved", "sent"];

export async function eraseProposalsForContact(db: Queryable, orgId: string, contactId: string): Promise<ProposalErasure> {
  const nothing: ProposalErasure = { withdrawn: 0, redacted: 0, retainedRecords: 0, signingEnded: 0 };
  // A database that has not had the proposals migration applied yet has nothing to erase, and a privacy request must still complete.
  if (!(await db.query<{ t: string | null }>("select to_regclass('public.proposals')::text as t")).rows[0]?.t) return nothing;
  const own = (await db.query<{ id: string; version: number; status: string }>("select id, version, status from proposals where org_id = $1 and contact_id = $2 for update", [orgId, contactId])).rows;
  if (!own.length) return nothing;
  const ids = own.map((p) => p.id);
  // The signing tables come with the next migration; a database that is one step behind has no requests to end or keep.
  const signing = Boolean((await db.query<{ t: string | null }>("select to_regclass('public.signature_requests')::text as t")).rows[0]?.t);
  let withdrawn = 0;
  let signingEnded = 0;
  for (const p of own.filter((x) => OPEN.includes(x.status))) {
    await db.query("update proposals set status = 'withdrawn', closed_at = now() where id = $1 and org_id = $2", [p.id, orgId]);
    // A signing request still out is ended with the proposal: the signer must not be asked again, and a signature that arrives afterwards is not applied.
    if (signing) signingEnded += await voidLiveRequestsInTx(db, orgId, p.id, "voided", "The customer asked for their data to be erased.", { userId: null });
    await addEvent(db, orgId, p.id, p.version, "withdrawn", { id: null, kind: "system" }, { reason: "privacy_request", wasSent: p.status === "sent" });
    withdrawn += 1;
  }
  // The link's address and name are the person's; the link itself is a credential and stops working.
  await db.query("update proposal_share_links set revoked_at = coalesce(revoked_at, now()), recipient_email = null, recipient_name = null where org_id = $1 and proposal_id = any($2::uuid[])", [orgId, ids]);
  await db.query("delete from proposal_link_challenges where org_id = $1 and link_id in (select id from proposal_share_links where org_id = $1 and proposal_id = any($2::uuid[]))", [orgId, ids]);
  await db.query("delete from proposal_link_sessions where org_id = $1 and link_id in (select id from proposal_share_links where org_id = $1 and proposal_id = any($2::uuid[]))", [orgId, ids]);
  const redacted = await db.query("update proposals set client_name = '', client_company = '', client_email = null where org_id = $1 and id = any($2::uuid[])", [orgId, ids]);
  const kept = (await db.query<{ n: string }>(
    `select ((select count(*) from proposal_versions where org_id = $1 and proposal_id = any($2::uuid[]))
           + (select count(*) from proposal_decisions where org_id = $1 and proposal_id = any($2::uuid[]) and (decided_name is not null or decided_email is not null))
           ${signing ? "+ (select count(*) from signature_requests where org_id = $1 and proposal_id = any($2::uuid[]))" : ""})::text as n`,
    [orgId, ids],
  )).rows[0];
  return { withdrawn, redacted: redacted.rowCount ?? 0, retainedRecords: Number(kept?.n ?? 0), signingEnded };
}
