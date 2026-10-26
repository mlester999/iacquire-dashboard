import "server-only";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { assertCan, auditActor, crmWrite, type CrmActor } from "@/server/crm/actor";
import { contactAddress } from "@/server/messaging/contacts";
import { probeDelivery, queueDelivery, stopQueuedMessage, type DeliveryMessage } from "@/server/messaging/delivery";
import {
  DELIVERY_WORDING_VERSION, MAX_DELIVERIES_PER_VERSION, deliveryTextProblem, greetingName, isDeliveryChannel, previewDeliveryBody, renderDelivery, type DeliveryChannel, type RenderedDelivery,
} from "@/lib/proposals/delivery-text";
import { deliveryWordingHash } from "@/lib/proposals/delivery-hash";
import {
  channelLabel, deliveryVerdict, describeDelivery, maskAddress, refusalReasonText, WITHDRAWN_REASON_TEXT, type DeliveryVerdict, type DeliveryView, type WithdrawReason,
} from "@/lib/proposals/delivery-state";
import { validityOn } from "@/lib/proposals/validity";
import { addEvent, iso, loadProposalRow, memberUserId, type ProposalRow } from "@/server/proposals/core";
import { assertProposalsEnabled, featureOn, PROPOSALS_FEATURE } from "@/server/proposals/features";
import { proposalUrl, tokenForStoredLink } from "@/server/proposals/link-token";

// Carrying a sent proposal to the customer, through the same consent-gated send chain as every other message (src/server/messaging/send.ts, message scope "delivery").
//
//  * A person with the send permission picks a channel, reads the exact message and confirms. Nothing goes out before that. What they read is fingerprinted (delivery-hash.ts) and the
//    server renders the message again when they confirm and refuses to send anything else. The wording is fixed in code (src/lib/proposals/delivery-text.ts): no AI, nothing a customer
//    typed except a first name that is a plain name. It is a single message, sent by the person in front of the screen, so a per-send preview is what reuses the existing
//    version-bound pattern; the invoice reminders' standing authorization exists because those go out on a schedule with nobody present.
//  * The customer's link is a bearer secret. The stored message holds {{proposal.link}}; the link is derived again at the moment of sending (proposalLinkForMessage, called by the
//    dispatcher) and exists only in the provider's request. It is never stored in a message, a history line, an audit row, a log or an export.
//  * The chain decides every rule: consent on the channel, opt-outs, quiet hours, a person's hold on the customer, a paused or suspended workspace, credits. A refusal leaves
//    nothing behind and comes back with the chain's own reason. What the screen says afterwards comes from the message's own status and never goes beyond "the provider
//    accepted it": iAcquire cannot know a message was delivered or read.
//  * One message per proposal version and channel at a time: the proposal row is locked, an earlier message that is queued, being sent or accepted is returned instead of
//    sending another (a double click sends once), and the chain's own dedupe key makes the database refuse a second one. A new version has a new link and needs a new send.
//  * Anything that ends the link (withdrawing, revising, an answer, expiry, a new link, an erasure request) stops a message that has not gone out yet; the dispatcher checks the
//    same facts again right before it sends.

const DEDUPE_PREFIX = "proposal-delivery";
const LIST_LIMIT = 30;

/** What a message about a proposal is made of once it can be offered: the working link, the customer's record, the exact words and where they would go. */
interface Prepared {
  row: ProposalRow;
  link: { id: string; recipientEmail: string | null };
  contactId: string;
  message: RenderedDelivery;
  /** Where a message on this channel would go, masked. Null when there is no address. */
  addressMask: string | null;
  notes: string[];
}

type Blocked = { blocked: { reason: string; text: string } };

const blocked = (reason: string, text: string): Blocked => ({ blocked: { reason, text } });

const notSent = (what: string) => `Only a proposal that has been sent and not answered can be ${what}.`;

/** Everything that has to be true for a message about this proposal, on this channel, to be offered at all. The send chain's own rules come after. */
async function prepare(db: Queryable, row: ProposalRow, channel: DeliveryChannel, now: Date): Promise<Prepared | Blocked> {
  if (row.status !== "sent" || row.sent_version !== row.version) return blocked("not_sent", notSent("sent to the customer"));
  const link = (await db.query<{ id: string; recipient_email: string | null }>(
    "select id, recipient_email::text as recipient_email from proposal_share_links where proposal_id = $1 and org_id = $2 and version = $3 and revoked_at is null and expires_at > $4::timestamptz order by created_at desc limit 1",
    [row.id, row.org_id, row.version, now.toISOString()],
  )).rows[0];
  if (!link) return blocked("no_link", "This proposal has no working link. Make a new link on this tab first.");
  const org = (await db.query<{ name: string; timezone: string }>("select name, timezone from organizations where id = $1", [row.org_id])).rows[0];
  if (!org) return blocked("not_sent", "The workspace was not found.");
  if (validityOn(row.valid_until, now, org.timezone) === "expired") return blocked("proposal_expired", "The date this proposal is valid until has passed, so the customer can no longer answer it.");
  if (!row.contact_id) return blocked("no_customer", "This proposal is not linked to a customer record, so there is no address to send it to. Copy the link instead.");
  const contact = (await db.query<{ first_name: string | null; display_name: string }>(
    "select first_name, display_name from contacts where id = $1 and org_id = $2 and deleted_at is null and archived_at is null", [row.contact_id, row.org_id],
  )).rows[0];
  if (!contact) return blocked("contact_unreachable", "The customer's record was removed or archived, so there is nowhere to send it. Copy the link instead.");
  const address = await contactAddress(db, row.org_id, row.contact_id, channel);
  const notes: string[] = [];
  if (channel === "email" && address && link.recipient_email && address.toLowerCase() !== link.recipient_email.toLowerCase()) {
    // The emailed code that lets the customer answer goes to the address on the proposal; the link would go to a different mailbox.
    return blocked("address_differs", `The email address on the proposal (${maskAddress("email", link.recipient_email)}) is not the one on the customer's record (${maskAddress("email", address)}). Make them the same, or copy the link.`);
  }
  if (!link.recipient_email) notes.push("There is no email address on the proposal, so the customer can read it but cannot answer it online.");
  // The proposal is addressed to the name staff typed on it; the customer's own record is the fallback. A name that is anything but a plain name is left out of the greeting.
  const message = renderDelivery({ channel, firstName: greetingName(row.client_name) ?? greetingName(contact.first_name) ?? greetingName(contact.display_name), business: org.name, number: row.number, validUntil: row.valid_until });
  const problem = deliveryTextProblem(message.body);
  if (problem) return blocked("message_invalid", `${problem} Check the business name and the proposal number.`);
  return { row, link: { id: link.id, recipientEmail: link.recipient_email }, contactId: row.contact_id, message, addressMask: address ? maskAddress(channel, address) : null, notes };
}

const isBlocked = (p: Prepared | Blocked): p is Blocked => "blocked" in p;

interface DeliveryRow {
  id: string;
  version: number;
  link_id: string;
  channel: DeliveryChannel;
  address_mask: string | null;
  requested_by: string | null;
  requested_by_name: string | null;
  created_at: Date;
  withdrawn_at: Date | null;
  withdrawn_reason: string | null;
  message_status: string | null;
  blocked_reason: string | null;
  status_detail: string | null;
  failure_kind: string | null;
  send_after: Date | null;
  sent_at: Date | null;
}

const DELIVERY_SQL = `select d.id, d.version, d.link_id, d.channel, d.address_mask, d.requested_by, coalesce(nullif(u.full_name, ''), u.email::text) as requested_by_name, d.created_at, d.withdrawn_at, d.withdrawn_reason,
    m.status as message_status, m.blocked_reason, m.status_detail, m.failure_kind, m.send_after, m.sent_at
  from proposal_deliveries d left join conversation_messages m on m.id = d.message_id and m.org_id = d.org_id left join users u on u.id = d.requested_by`;

function toView(r: DeliveryRow, now: Date): DeliveryView {
  const d = describeDelivery({
    channel: r.channel, addressMask: r.address_mask, messageStatus: r.message_status, blockedReason: r.blocked_reason, statusDetail: r.status_detail, failureKind: r.failure_kind,
    sendAfter: r.send_after, sentAt: r.sent_at, withdrawnAt: r.withdrawn_at, withdrawnReason: r.withdrawn_reason, now,
  });
  return {
    ...d, id: r.id, version: r.version, channel: r.channel, channelLabel: channelLabel(r.channel), requestedByName: r.requested_by_name, requestedAt: new Date(r.created_at).toISOString(),
    addressMask: r.address_mask, sendAfter: d.state === "waiting" ? iso(r.send_after) : null, sentAt: iso(r.sent_at),
  };
}

/** The messages that were sent about a proposal, newest first, each with its honest state. Reads the send chain's rows, so it runs as trusted code. */
export async function deliveriesFor(db: Queryable, orgId: string, proposalId: string, now = new Date()): Promise<DeliveryView[]> {
  const { rows } = await db.query<DeliveryRow>(`${DELIVERY_SQL} where d.org_id = $1 and d.proposal_id = $2 order by d.created_at desc, d.id limit ${LIST_LIMIT}`, [orgId, proposalId]);
  return rows.map((r) => toView(r, now));
}

/** The deliveries that stand in the way of another one on this channel for the link: a message still on its way, or one the provider accepted. */
async function standingOn(db: Queryable, row: ProposalRow, linkId: string, channel: DeliveryChannel, now: Date): Promise<DeliveryView | null> {
  const { rows } = await db.query<DeliveryRow>(
    `${DELIVERY_SQL} where d.org_id = $1 and d.proposal_id = $2 and d.version = $3 and d.link_id = $4 and d.channel = $5 order by d.created_at desc, d.id`,
    [row.org_id, row.id, row.version, linkId, channel],
  );
  for (const r of rows) {
    const v = toView(r, now);
    if (!v.ended) return v;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The preview: exactly what would be sent, and what the send chain says about it
// ---------------------------------------------------------------------------

export interface DeliveryPreview {
  available: true;
  version: number;
  channel: DeliveryChannel;
  channelLabel: string;
  /** Email only. */
  subject: string | null;
  /** What the customer will read, with their own link shown as words. */
  body: string;
  wordingVersion: string;
  /** Nobody has approved this wording: counsel has not reviewed it. */
  wordingIsDraft: boolean;
  /** What the sender is reading: send it back with the confirmation. A change to the message since then is refused. */
  wordingHash: string;
  /** Where it would go, masked. Null when the customer has no address on this channel. */
  addressMask: string | null;
  /** A text or WhatsApp message uses the business's prepaid service credits. */
  usesCredits: boolean;
  verdict: DeliveryVerdict;
  /** A message on this channel for this version is already on its way or was accepted by the provider: another is not offered. */
  standing: DeliveryView | null;
  notes: string[];
  /** How many more messages this version can have. */
  remaining: number;
}

function actorFor(actor: CrmActor): string {
  assertCan(actor, "proposals.send", "Your role can't send proposals.");
  return memberUserId(actor);
}

function asChannel(value: unknown): DeliveryChannel {
  if (!isDeliveryChannel(value)) throw new AppError("invalid_input", "Choose email, text message or WhatsApp.");
  return value;
}

async function lock(db: Queryable, actor: CrmActor, id: string): Promise<ProposalRow> {
  const row = await loadProposalRow(db, actor.orgId, id, true);
  if (!row) throw new AppError("not_found", "That proposal was not found.");
  return row;
}

async function usedBy(db: Queryable, row: ProposalRow): Promise<number> {
  return Number((await db.query<{ n: string }>("select count(*)::text as n from proposal_deliveries where org_id = $1 and proposal_id = $2 and version = $3", [row.org_id, row.id, row.version])).rows[0].n);
}

const deliveryMessage = (p: Prepared, channel: DeliveryChannel, userId: string, now: Date): DeliveryMessage => ({
  orgId: p.row.org_id, contactId: p.contactId, channel, threadKey: channel === "email" ? `proposal:${p.row.id}` : null, subject: p.message.subject, userId, body: p.message.body, now,
});

/** The reason a message cannot be offered at all (before the send chain is asked), in words the sender can act on. */
export interface DeliveryUnavailable {
  available: false;
  version: number;
  channel: DeliveryChannel;
  channelLabel: string;
  reason: string;
  text: string;
}

/**
 * What a message about this proposal would say, where it would go, and what the send chain would do with it right now. Nothing is written: the probe makes and unmakes its
 * conversation inside a savepoint. Needs the permission to send proposals.
 */
export async function previewDelivery(actor: CrmActor, proposalId: string, channelInput: unknown, deps: { now?: Date } = {}): Promise<DeliveryPreview | DeliveryUnavailable> {
  await assertProposalsEnabled(actor.orgId);
  const userId = actorFor(actor);
  const channel = asChannel(channelInput);
  const now = deps.now ?? new Date();
  return crmWrite(actor, async (db) => {
    const row = await loadProposalRow(db, actor.orgId, proposalId);
    if (!row) throw new AppError("not_found", "That proposal was not found.");
    const p = await prepare(db, row, channel, now);
    if (isBlocked(p)) return { available: false, version: row.version, channel, channelLabel: channelLabel(channel), reason: p.blocked.reason, text: p.blocked.text };
    const remaining = Math.max(0, MAX_DELIVERIES_PER_VERSION - (await usedBy(db, row)));
    const standing = await standingOn(db, row, p.link.id, channel, now);
    const decision = await probeDelivery(db, deliveryMessage(p, channel, userId, now));
    const verdict = deliveryVerdict(decision.allow ? { allow: true } : { allow: false, reason: decision.reason, detail: decision.detail, retryAt: decision.retryAt, permanent: decision.permanent }, channel, p.addressMask);
    return {
      available: true, version: row.version, channel, channelLabel: channelLabel(channel), subject: p.message.subject, body: previewDeliveryBody(p.message.body), wordingVersion: DELIVERY_WORDING_VERSION,
      wordingIsDraft: DELIVERY_WORDING_VERSION.startsWith("draft"), wordingHash: deliveryWordingHash(channel, p.message), addressMask: p.addressMask, usesCredits: channel !== "email",
      verdict, standing, notes: p.notes, remaining,
    };
  });
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export interface SendDeliveryInput {
  channel: unknown;
  /** The version the sender was looking at. */
  version: number;
  /** The fingerprint of the message the sender read (DeliveryPreview.wordingHash). */
  wordingHash: unknown;
}

export type SendDeliveryResult =
  | { status: "queued"; delivery: DeliveryView; waitingUntil: string | null }
  | { status: "already"; delivery: DeliveryView }
  | { status: "refused"; reason: string; text: string };

/**
 * Hands the message the sender read to the send chain. Refused, with nothing left behind but an audit line, when the proposal is not out with the customer any more, when the
 * message is not the one they read, or when the chain says no (no consent, an opt-out, a person's hold, a paused workspace, credits, the channel). A second request while the first
 * is on its way, or after the provider accepted it, returns that message instead of sending another.
 */
export async function sendDelivery(actor: CrmActor, proposalId: string, input: SendDeliveryInput, deps: { now?: Date } = {}): Promise<SendDeliveryResult> {
  await assertProposalsEnabled(actor.orgId);
  const userId = actorFor(actor);
  const channel = asChannel(input.channel);
  if (!Number.isInteger(input.version) || input.version < 1) throw new AppError("invalid_input", "Look at the proposal again before you send it.");
  if (typeof input.wordingHash !== "string" || !/^[0-9a-f]{64}$/.test(input.wordingHash)) throw new AppError("invalid_input", "Read the message again before you send it.");
  const hash = input.wordingHash;
  const now = deps.now ?? new Date();
  return crmWrite(actor, async (db): Promise<SendDeliveryResult> => {
    const row = await lock(db, actor, proposalId);
    if (row.version !== input.version) throw new AppError("conflict", "The proposal changed. Look at the new version before you send it.");
    const refuse = async (reason: string, text: string): Promise<SendDeliveryResult> => {
      await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "proposals.delivery_refused", targetType: "proposal", targetId: row.id, result: "denied", metadata: { version: row.version, channel, reason } }, db);
      return { status: "refused", reason, text };
    };
    const p = await prepare(db, row, channel, now);
    if (isBlocked(p)) return refuse(p.blocked.reason, p.blocked.text);
    if (deliveryWordingHash(channel, p.message) !== hash) throw new AppError("conflict", "The message changed since you read it. Read it again before you send it.");
    // A double click, or a second person pressing the same button: the first message is the answer.
    const standing = await standingOn(db, row, p.link.id, channel, now);
    if (standing) return { status: "already", delivery: standing };
    if ((await usedBy(db, row)) >= MAX_DELIVERIES_PER_VERSION) {
      return refuse("too_many", `This version has already had ${MAX_DELIVERIES_PER_VERSION} messages. Copy the link and give it to the customer yourself.`);
    }
    // One message per request. The key names the proposal, the version and the channel, and a request after an earlier one ended without reaching the provider takes the next
    // number, because the key of the earlier message is spent.
    const base = `${DEDUPE_PREFIX}:${row.id}:${row.version}:${channel}`;
    const spent = Number((await db.query<{ n: string }>("select count(*)::text as n from conversation_messages where org_id = $1 and (dedupe_key = $2 or dedupe_key like $2 || ':%')", [row.org_id, base])).rows[0].n);
    const queued = await queueDelivery(db, deliveryMessage(p, channel, userId, now), spent ? `${base}:${spent}` : base);
    if (!queued.ok) return refuse(queued.reason, refusalReasonText(queued.reason, queued.detail));
    const mask = p.addressMask;
    const made = (await db.query<{ id: string }>(
      `insert into proposal_deliveries (org_id, proposal_id, version, link_id, channel, message_id, wording_version, wording_hash, address_mask, requested_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
      [row.org_id, row.id, row.version, p.link.id, channel, queued.messageId, DELIVERY_WORDING_VERSION, hash, mask, userId],
    )).rows[0];
    const waitingUntil = queued.waitingUntil ? queued.waitingUntil.toISOString() : null;
    // The history and the audit line say which channel and which delivery, not where it went: the masked address is kept on the delivery only, which a privacy request can clear
    // (the history and the audit trail are records that stay).
    await addEvent(db, row.org_id, row.id, row.version, "delivery_queued", { id: userId, kind: "user" }, { channel, deliveryId: made.id, waitingUntil });
    await recordAudit({
      orgId: actor.orgId, ...auditActor(actor), action: "proposals.delivery_queued", targetType: "proposal", targetId: row.id, result: "success",
      metadata: { version: row.version, channel, deliveryId: made.id, wordingVersion: DELIVERY_WORDING_VERSION, wordingFingerprint: hash, waitingUntil },
    }, db);
    const view = (await db.query<DeliveryRow>(`${DELIVERY_SQL} where d.id = $1 and d.org_id = $2`, [made.id, row.org_id])).rows[0];
    return { status: "queued", delivery: toView(view, now), waitingUntil };
  });
}

// ---------------------------------------------------------------------------
// Right before the provider call
// ---------------------------------------------------------------------------

/**
 * The customer's link for the message the dispatcher is about to send, derived again from the proposal's own link and used for the provider call only. Null when the message is
 * not a delivery of a proposal, or the proposal can no longer be read through that link: not sent any more, answered, withdrawn, replaced by a newer version, expired, its link
 * closed or replaced, the module switched off. The address the message goes to is recorded (masked) on the delivery, so the screen says where it really went.
 */
export async function proposalLinkForMessage(db: Queryable, orgId: string, messageId: string, address: string, channel: DeliveryChannel, now: Date): Promise<string | null> {
  const d = (await db.query<{
    id: string; link_id: string; version: number; channel: string; withdrawn_at: Date | null; status: string; p_version: number; sent_version: number | null; valid_until: string | null;
    token_hash: string; revoked_at: Date | null; expires_at: Date; timezone: string;
  }>(
    `select d.id, d.link_id, d.version, d.channel, d.withdrawn_at, p.status, p.version as p_version, p.sent_version, to_char(p.valid_until, 'YYYY-MM-DD') as valid_until,
            l.token_hash, l.revoked_at, l.expires_at, o.timezone
     from proposal_deliveries d
     join proposals p on p.id = d.proposal_id and p.org_id = d.org_id
     join proposal_share_links l on l.id = d.link_id and l.org_id = d.org_id
     join organizations o on o.id = d.org_id
     where d.org_id = $1 and d.message_id = $2`,
    [orgId, messageId],
  )).rows[0];
  if (!d || d.withdrawn_at || d.channel !== channel) return null;
  if (d.status !== "sent" || d.p_version !== d.version || d.sent_version !== d.version) return null;
  if (d.revoked_at || new Date(d.expires_at).getTime() <= now.getTime()) return null;
  if (validityOn(d.valid_until, now, d.timezone) === "expired") return null;
  if (!(await featureOn(orgId, PROPOSALS_FEATURE, db))) return null;
  const token = tokenForStoredLink(d.link_id, d.token_hash);
  if (!token) return null;
  await db.query("update proposal_deliveries set address_mask = $3 where id = $1 and org_id = $2", [d.id, orgId, maskAddress(channel, address)]);
  return proposalUrl(token);
}

// ---------------------------------------------------------------------------
// Stopping what has not gone out
// ---------------------------------------------------------------------------

/**
 * Stops the messages about a proposal that have not gone out (queued, or waiting for sending hours): the message is stopped, its credit hold given back, and the delivery says
 * why. A message already on its way or accepted is left alone; the dispatcher claims a message with the same status check, so exactly one side wins. Called by whatever ends the
 * customer's link, inside that change's own transaction. Returns how many were stopped.
 */
export async function withdrawDeliveriesInTx(db: Queryable, orgId: string, proposalId: string, reason: WithdrawReason): Promise<number> {
  const { rows } = await db.query<{ id: string; message_id: string; version: number }>(
    `select d.id, d.message_id, d.version from proposal_deliveries d join conversation_messages m on m.id = d.message_id and m.org_id = d.org_id
     where d.org_id = $1 and d.proposal_id = $2 and d.withdrawn_at is null and m.status in ('draft', 'queued') order by d.created_at`,
    [orgId, proposalId],
  );
  const stoppedVersions: number[] = [];
  for (const r of rows) {
    // The message first, then the delivery: the dispatcher takes them in that order too.
    if (!(await stopQueuedMessage(db, { orgId, messageId: r.message_id, reason, detail: WITHDRAWN_REASON_TEXT[reason] }))) continue;
    await db.query("update proposal_deliveries set withdrawn_at = now(), withdrawn_reason = $3 where id = $1 and org_id = $2", [r.id, orgId, reason]);
    stoppedVersions.push(r.version);
  }
  // The history line is of the version the stopped message was about (a revision has already moved the proposal on to the next one).
  if (stoppedVersions.length) await addEvent(db, orgId, proposalId, Math.max(...stoppedVersions), "delivery_withdrawn", { id: null, kind: "system" }, { count: stoppedVersions.length, reason });
  return stoppedVersions.length;
}

/**
 * A privacy request for the customer: what has not gone out is stopped, and the masked addresses kept on the deliveries are removed. The message rows themselves (their
 * text and subject) are made unreadable by the erasure of the customer's conversations.
 */
export async function eraseDeliveriesInTx(db: Queryable, orgId: string, proposalIds: string[]): Promise<number> {
  let stopped = 0;
  for (const id of proposalIds) stopped += await withdrawDeliveriesInTx(db, orgId, id, "privacy_request");
  if (proposalIds.length) await db.query("update proposal_deliveries set address_mask = null where org_id = $1 and proposal_id = any($2::uuid[])", [orgId, proposalIds]);
  return stopped;
}
