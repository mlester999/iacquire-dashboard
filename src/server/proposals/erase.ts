import "server-only";
import type { Queryable } from "@/server/db";
import { addEvent } from "@/server/proposals/core";
import { eraseDeliveriesInTx } from "@/server/proposals/delivery";
import { voidLiveRequestsInTx } from "@/server/esign/lifecycle";

// What a privacy request does to proposals (called from redactContact, inside its transaction). It is the part that can be done without a decision the founder has not made.
//
// Done now: every proposal for the person that is not yet final is withdrawn and its customer link stops working (nothing more is offered to someone who asked to be forgotten);
// their emailed-code challenges and sessions are deleted; the address and name kept on each link are removed; and the person's name, company and address are removed from each
// proposal's working copy. The name the system itself put elsewhere goes too: a title that carries the person's or their company's name (the default is "Proposal for <name>") is reset
// to "Proposal <number>", and the notices that quoted the title or a signer's name lose their text.
//
// LEFT for the business to review, and counted in typedTextKept: what staff typed. The internal notes, the written sections and the terms are the business's own wording (the working
// copy holds placeholders such as {{client.name}} that are filled in only when a version is frozen, so a name appears there only if somebody typed it). Rewriting wording could change
// what was agreed, so the person processing the request reads those proposals and edits what names the person. A typed title that does not contain the name stays as typed.
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
  /** Proposals whose title carried the person's (or their company's) name and now reads "Proposal <number>". */
  titlesReset: number;
  /** Proposals that still hold text staff typed (internal notes, written sections or terms): not changed, left for the business to review for the person's name. */
  typedTextKept: number;
}

const OPEN = ["draft", "pending_approval", "changes_requested", "approved", "sent"];

export async function eraseProposalsForContact(db: Queryable, orgId: string, contactId: string): Promise<ProposalErasure> {
  const nothing: ProposalErasure = { withdrawn: 0, redacted: 0, retainedRecords: 0, signingEnded: 0, titlesReset: 0, typedTextKept: 0 };
  // A database that has not had the proposals migration applied yet has nothing to erase, and a privacy request must still complete.
  if (!(await db.query<{ t: string | null }>("select to_regclass('public.proposals')::text as t")).rows[0]?.t) return nothing;
  const own = (await db.query<{ id: string; version: number; status: string; title: string; client_name: string; client_company: string; typed: boolean }>(
    `select id, version, status, title, client_name, client_company,
       (coalesce(btrim(internal_notes), '') <> '' or (case when jsonb_typeof(doc -> 'sections') = 'array' then jsonb_array_length(doc -> 'sections') else 0 end) > 0 or coalesce(btrim(doc ->> 'terms'), '') <> '') as typed
     from proposals where org_id = $1 and contact_id = $2 for update`,
    [orgId, contactId],
  )).rows;
  if (!own.length) return nothing;
  const ids = own.map((p) => p.id);
  // The contact is still whole here (redactContact blanks it afterwards), so its name can be looked for in what was derived from it.
  const contactName = (await db.query<{ display_name: string }>("select display_name from contacts where org_id = $1 and id = $2", [orgId, contactId])).rows[0]?.display_name ?? "";
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
  // A message that carries the link and has not gone out is stopped, and the masked address each delivery kept goes (the messages themselves are made unreadable with the
  // customer's conversations). A delivery table that the migration has not created yet has nothing to stop.
  if ((await db.query<{ t: string | null }>("select to_regclass('public.proposal_deliveries')::text as t")).rows[0]?.t) await eraseDeliveriesInTx(db, orgId, ids);
  // The link's address and name are the person's; the link itself is a credential and stops working.
  await db.query("update proposal_share_links set revoked_at = coalesce(revoked_at, now()), recipient_email = null, recipient_name = null where org_id = $1 and proposal_id = any($2::uuid[])", [orgId, ids]);
  await db.query("delete from proposal_link_challenges where org_id = $1 and link_id in (select id from proposal_share_links where org_id = $1 and proposal_id = any($2::uuid[]))", [orgId, ids]);
  await db.query("delete from proposal_link_sessions where org_id = $1 and link_id in (select id from proposal_share_links where org_id = $1 and proposal_id = any($2::uuid[]))", [orgId, ids]);
  // The title is derived from the name when none was typed ("Proposal for Maria Santos"), and the list, the detail page, the search and the notices all show it. A title that holds
  // the person's name, their company's or the name they were proposed to is reset to the proposal's own number, on a finished proposal as much as a draft (its frozen version, a record, keeps its copy).
  const names = [contactName, ...own.flatMap((p) => [p.client_name, p.client_company])].map((n) => n.trim().toLowerCase()).filter((n) => n.length >= 2);
  const named = own.filter((p) => names.some((n) => p.title.toLowerCase().includes(n))).map((p) => p.id);
  if (named.length) await db.query("update proposals set title = 'Proposal ' || number where org_id = $1 and id = any($2::uuid[])", [orgId, named]);
  // Notices copied the title (an approval waiting, an expiry coming, an answer) and the signer's name (a declined or expired signing request). Their text goes; the headline, which
  // holds only the proposal number, stays.
  await db.query("update notifications set body = null where org_id = $1 and body is not null and split_part(link, '?', 1) = any($2::text[])", [orgId, ids.map((id) => `/proposals/${id}`)]);
  const redacted = await db.query("update proposals set client_name = '', client_company = '', client_email = null where org_id = $1 and id = any($2::uuid[])", [orgId, ids]);
  const kept = (await db.query<{ n: string }>(
    `select ((select count(*) from proposal_versions where org_id = $1 and proposal_id = any($2::uuid[]))
           + (select count(*) from proposal_decisions where org_id = $1 and proposal_id = any($2::uuid[]) and (decided_name is not null or decided_email is not null))
           ${signing ? "+ (select count(*) from signature_requests where org_id = $1 and proposal_id = any($2::uuid[]))" : ""})::text as n`,
    [orgId, ids],
  )).rows[0];
  return { withdrawn, redacted: redacted.rowCount ?? 0, retainedRecords: Number(kept?.n ?? 0), signingEnded, titlesReset: named.length, typedTextKept: own.filter((p) => p.typed).length };
}
