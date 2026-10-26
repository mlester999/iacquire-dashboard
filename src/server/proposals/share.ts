import "server-only";
import crypto from "node:crypto";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { assertCan, auditActor, crmWrite, type CrmActor } from "@/server/crm/actor";
import { linkExpiresAt, seenLevel, type SeenLevel } from "@/lib/proposals/share";
import { addEvent, loadProposalRow, type ProposalRow } from "@/server/proposals/core";
import { assertProposalsEnabled } from "@/server/proposals/features";
import { withdrawDeliveriesInTx } from "@/server/proposals/delivery";
import { hashLinkToken, linkTokenFor, proposalUrl, tokenForStoredLink } from "@/server/proposals/link-token";

// The customer's link to a sent proposal, as the team sees and manages it. The link is made when the proposal is sent. Its address is derived from a server key, so the team
// can be shown it again (to copy into an email or a message) without it being stored; only a hash of it is kept. Nothing here sends the link to anyone: copying it is one way to
// give it to the customer, and a message through the consent-gated send chain (src/server/proposals/delivery.ts) is the other.

export interface ShareView {
  id: string;
  version: number;
  recipientEmail: string | null;
  recipientName: string | null;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  /** The link opens and, with the code, can be answered. */
  active: boolean;
  seen: SeenLevel;
  openCount: number;
  firstOpenedAt: string | null;
  lastOpenedAt: string | null;
  viewedCount: number;
  firstViewedAt: string | null;
  verifiedAt: string | null;
  downloadedAt: string | null;
  /** Whether the viewer may be given the address (getShareUrl): they can send proposals and the link is active. The address itself is never part of a proposal's detail. */
  canCopy: boolean;
}

interface LinkRow {
  id: string;
  version: number;
  recipient_email: string | null;
  recipient_name: string | null;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  open_count: number;
  first_opened_at: Date | null;
  last_opened_at: Date | null;
  viewed_count: number;
  first_viewed_at: Date | null;
  verified_at: Date | null;
  downloaded_at: Date | null;
}

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);

/**
 * The proposal's current link (the live one, else the newest), or null when none was ever made. It reads only what a team member may read: the hash of the link's address is
 * not among it, so this can run under the member's own access.
 */
export async function shareViewFor(db: Queryable, actor: Pick<CrmActor, "can">, row: Pick<ProposalRow, "id" | "org_id">, now = new Date()): Promise<ShareView | null> {
  const { rows } = await db.query<LinkRow>(
    `select id, version, recipient_email::text as recipient_email, recipient_name, created_at, expires_at, revoked_at, open_count, first_opened_at, last_opened_at, viewed_count,
            first_viewed_at, verified_at, downloaded_at
     from proposal_share_links where proposal_id = $1 and org_id = $2 order by (revoked_at is null) desc, created_at desc limit 1`,
    [row.id, row.org_id],
  );
  const l = rows[0];
  if (!l) return null;
  const active = !l.revoked_at && new Date(l.expires_at).getTime() > now.getTime();
  return {
    id: l.id, version: l.version, recipientEmail: l.recipient_email, recipientName: l.recipient_name, createdAt: new Date(l.created_at).toISOString(), expiresAt: new Date(l.expires_at).toISOString(),
    revokedAt: iso(l.revoked_at), active, seen: seenLevel({ openCount: l.open_count, viewedCount: l.viewed_count, verifiedAt: l.verified_at }), openCount: l.open_count,
    firstOpenedAt: iso(l.first_opened_at), lastOpenedAt: iso(l.last_opened_at), viewedCount: l.viewed_count, firstViewedAt: iso(l.first_viewed_at), verifiedAt: iso(l.verified_at),
    downloadedAt: iso(l.downloaded_at), canCopy: active && actor.can("proposals.send"),
  };
}

/**
 * Makes the link for a version that was just sent. The recipient is the customer's email address on the proposal; with none, the link can be opened but cannot be answered
 * (the emailed code needs an address), and the team records the answer instead. Runs inside the send's own transaction.
 */
export async function createShareLinkInTx(db: Queryable, row: Pick<ProposalRow, "id" | "org_id" | "client_email" | "client_name" | "valid_until">, version: number, userId: string, now: Date): Promise<{ id: string }> {
  const id = crypto.randomUUID();
  await db.query(
    `insert into proposal_share_links (id, org_id, proposal_id, version, token_hash, recipient_email, recipient_name, expires_at, delivery_channel, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'manual_link', $9)`,
    [id, row.org_id, row.id, version, hashLinkToken(linkTokenFor(id)), row.client_email ? row.client_email.toLowerCase() : null, row.client_name.trim() || null, linkExpiresAt(now, row.valid_until).toISOString(), userId],
  );
  await addEvent(db, row.org_id, row.id, version, "link_created", { id: userId, kind: "user" }, { linkId: id, hasEmail: Boolean(row.client_email) });
  return { id };
}

/** The address to give the customer, for someone who may send proposals. */
export async function getShareUrl(actor: CrmActor, proposalId: string, deps: { now?: Date } = {}): Promise<{ url: string; expiresAt: string }> {
  await assertProposalsEnabled(actor.orgId);
  assertCan(actor, "proposals.send", "Your role can't send proposals.");
  if (actor.kind !== "member") throw new AppError("forbidden", "Only a signed-in member of the workspace can do this.");
  return crmWrite(actor, async (db) => {
    const row = await loadProposalRow(db, actor.orgId, proposalId);
    if (!row) throw new AppError("not_found", "That proposal was not found.");
    return addressOf(db, row, deps.now ?? new Date());
  });
}

/** The live link's address and expiry: derived again and checked against the stored hash. Runs as trusted code, which may read the hash. */
async function addressOf(db: Queryable, row: Pick<ProposalRow, "id" | "org_id">, now: Date): Promise<{ url: string; expiresAt: string }> {
  const l = (await db.query<{ id: string; token_hash: string; expires_at: Date }>(
    "select id, token_hash, expires_at from proposal_share_links where proposal_id = $1 and org_id = $2 and revoked_at is null and expires_at > $3 order by created_at desc limit 1",
    [row.id, row.org_id, now.toISOString()],
  )).rows[0];
  if (!l) throw new AppError("conflict", "This proposal has no active link. Make a new one.");
  const token = tokenForStoredLink(l.id, l.token_hash);
  if (!token) throw new AppError("conflict", "This link can't be shown again. Make a new one.");
  return { url: proposalUrl(token), expiresAt: new Date(l.expires_at).toISOString() };
}

/**
 * A new link for a proposal that is out with the customer: the old one stops working at once and the new one is returned. For a link sent to the wrong place, or one that
 * expired before the customer answered. Only a sent proposal has a link to renew.
 */
export async function renewShareLink(actor: CrmActor, proposalId: string, deps: { now?: Date } = {}): Promise<{ url: string; expiresAt: string }> {
  await assertProposalsEnabled(actor.orgId);
  assertCan(actor, "proposals.send", "Your role can't send proposals.");
  if (actor.kind !== "member" || !actor.userId) throw new AppError("forbidden", "Only a signed-in member of the workspace can do this.");
  const userId = actor.userId;
  const now = deps.now ?? new Date();
  return crmWrite(actor, async (db) => {
    const row = await loadProposalRow(db, actor.orgId, proposalId, true);
    if (!row) throw new AppError("not_found", "That proposal was not found.");
    if (row.status !== "sent" || row.sent_version !== row.version) throw new AppError("conflict", "Only a proposal that has been sent and not answered has a link to renew.");
    await db.query("update proposal_share_links set revoked_at = now() where proposal_id = $1 and org_id = $2 and revoked_at is null", [proposalId, actor.orgId]);
    // A message that carries the old link and has not gone out yet would send a link that no longer opens: it is stopped (one already sent stays as it is).
    await withdrawDeliveriesInTx(db, actor.orgId, proposalId, "proposal_link_renewed");
    const made = await createShareLinkInTx(db, row, row.version, userId, now);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "proposals.link_renewed", targetType: "proposal", targetId: proposalId, result: "success", metadata: { version: row.version, linkId: made.id } }, db);
    return addressOf(db, row, now);
  });
}
