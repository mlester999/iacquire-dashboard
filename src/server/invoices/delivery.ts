import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import type { OrgContext } from "@/server/tenancy/context";
import { contactAddress } from "@/server/messaging/contacts";
import { probeDelivery, queueDelivery, stopQueuedMessage, type DeliveryMessage } from "@/server/messaging/delivery";
import {
  INVOICE_DELIVERY_WORDING_VERSION, MAX_INVOICE_DELIVERIES_PER_LINK, greetingName, invoiceDeliveryTextProblem, isDeliveryChannel, previewInvoiceDeliveryBody, renderInvoiceDelivery,
  type DeliveryChannel, type RenderedInvoiceDelivery,
} from "@/lib/invoices/delivery-text";
import { invoiceDeliveryWordingHash } from "@/lib/invoices/delivery-hash";
import {
  channelLabel, describeInvoiceDelivery, INVOICE_WITHDRAWN_REASON_TEXT, invoiceDeliveryVerdict, invoiceRefusalReasonText, maskAddress, type DeliveryVerdict, type InvoiceDeliveryView, type InvoiceWithdrawReason,
} from "@/lib/invoices/delivery-state";
import { assertInvoicesAvailable, invoicesEnabledIn } from "@/server/invoices/feature";
import { invoiceLinkUrl, tokenForStoredHash } from "@/server/invoices/links";
import { addInvoiceEvent, iso, loadInvoiceRow, toMinor, type InvoiceRow } from "@/server/invoices/core";
import { invoicesPublicDisabled } from "@/server/invoices/workspace-gate";

// Carrying an issued invoice's link to the customer, through the same consent-gated send chain as every other message (src/server/messaging/send.ts, message scope "delivery").
// It is the invoice's twin of src/server/proposals/delivery.ts, and the choices are the same ones:
//
//  * A person with the send permission picks a channel, reads the exact message and confirms. Nothing goes out before that. What they read is fingerprinted (delivery-hash.ts) and
//    the server renders the message again when they confirm and refuses to send anything else. The wording is fixed in code (src/lib/invoices/delivery-text.ts): no AI, nothing a
//    customer typed except a first name that is a plain name. It is one message sent by the person at the screen, so a per-send preview is what reuses the existing hash-bound
//    pattern; the owner's standing authorization of the reminders exists because those go out on a schedule with nobody present.
//  * The customer's link is a bearer secret. The stored message holds {{invoice.link}}; the link is derived again at the moment of sending (invoiceLinkForDelivery, called by the
//    dispatcher) and exists only in the provider's request. It is never stored in a message, a history line, an audit row, a log or an export.
//  * The chain decides every rule: consent on the channel, opt-outs, quiet hours, a person's hold on the customer, a paused or suspended workspace, credits. A refusal leaves
//    nothing behind and comes back with the chain's own reason. What the screen says afterwards comes from the message's own status and never goes beyond "the provider accepted
//    it": iAcquire cannot know a message was delivered or read.
//  * A test invoice is never sent, and neither is a draft, a void, a written-off, a paid or a disputed one. The database refuses the first three too.
//  * One message per version of the invoice's link and channel at a time: the invoice row is locked, an earlier message that is queued, being sent or accepted is returned instead
//    of sending another (a double click sends once), and the chain's own dedupe key makes the database refuse a second one. Replacing the link makes a new version, which ends a
//    message about the old one and is the way to send again.
//  * Anything that ends the link or the debt (voiding, a payment in full, a dispute, a write-off, a new link, an erasure request) stops a message that has not gone out yet; the
//    dispatcher checks the same facts again right before it sends.

const DEDUPE_PREFIX = "invoice-delivery";
const LIST_LIMIT = 30;

/** What a message about an invoice is made of once it can be offered: the customer's record, the exact words and where they would go. */
interface Prepared {
  row: InvoiceRow;
  contactId: string;
  message: RenderedInvoiceDelivery;
  /** Where a message on this channel would go, masked. Null when there is no address. */
  addressMask: string | null;
}

type Blocked = { blocked: { reason: string; text: string } };

const blocked = (reason: string, text: string): Blocked => ({ blocked: { reason, text } });
const isBlocked = (p: Prepared | Blocked): p is Blocked => "blocked" in p;

/** Everything that has to be true for a message about this invoice, on this channel, to be offered at all. The send chain's own rules come after. */
async function prepare(db: Queryable, row: InvoiceRow, channel: DeliveryChannel): Promise<Prepared | Blocked> {
  if (invoicesPublicDisabled()) return blocked("public_pages_off", "Invoice links are switched off for the whole platform right now, so a link sent now would not open. Try again when they are back.");
  if (row.is_test) return blocked("test_invoice", "A test invoice is never sent to a customer: nothing is owed on it.");
  if (row.status !== "issued") return blocked("not_issued", row.status === "void" ? "This invoice is void, so it is not sent to the customer." : "An invoice is sent to the customer after it is issued.");
  if (row.written_off_at) return blocked("written_off", "This invoice was written off, so it is not sent to the customer.");
  if (row.payment_status === "disputed") return blocked("disputed", "A payment on this invoice is disputed, so it is not sent to the customer.");
  if (row.payment_status === "paid" || toMinor(row.balance_minor) <= 0) return blocked("paid", "This invoice is paid, so there is nothing to send.");
  if (!row.number || !row.due_on) return blocked("not_issued", "An invoice is sent to the customer after it is issued.");
  const stored = (await db.query<{ public_token_hash: string | null }>("select public_token_hash from customer_invoices where id = $1 and org_id = $2", [row.id, row.org_id])).rows[0];
  if (!tokenForStoredHash(row.id, row.public_token_version, stored?.public_token_hash ?? null)) return blocked("no_link", "This invoice's link can no longer be shown. Replace the link first, then send it.");
  if (!row.contact_id) return blocked("no_customer", "This invoice is not linked to a customer record, so there is no address to send it to. Copy the link instead.");
  const contact = (await db.query<{ first_name: string | null; display_name: string }>(
    "select first_name, display_name from contacts where id = $1 and org_id = $2 and deleted_at is null and archived_at is null", [row.contact_id, row.org_id],
  )).rows[0];
  if (!contact) return blocked("contact_unreachable", "The customer's record was removed or archived, so there is nowhere to send it. Copy the link instead.");
  const org = (await db.query<{ name: string }>("select name from organizations where id = $1", [row.org_id])).rows[0];
  const address = await contactAddress(db, row.org_id, row.contact_id, channel);
  const business = typeof row.bill_from.name === "string" ? row.bill_from.name : org?.name ?? "";
  // The greeting is the person the message goes to, by the first name on their record; a name that is anything but a plain name is left out.
  const message = renderInvoiceDelivery({
    channel, firstName: greetingName(contact.first_name) ?? greetingName(contact.display_name), business, number: row.number, totalMinor: toMinor(row.total_minor), currency: row.currency, dueOn: row.due_on,
  });
  const problem = invoiceDeliveryTextProblem(message.body);
  if (problem) return blocked("message_invalid", `${problem} Check the business name in the invoice settings.`);
  return { row, contactId: row.contact_id, message, addressMask: address ? maskAddress(channel, address) : null };
}

interface DeliveryRow {
  id: string;
  link_version: number;
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

const DELIVERY_SQL = `select d.id, d.link_version, d.channel, d.address_mask, d.requested_by, coalesce(nullif(u.full_name, ''), u.email::text) as requested_by_name, d.created_at, d.withdrawn_at, d.withdrawn_reason,
    m.status as message_status, m.blocked_reason, m.status_detail, m.failure_kind, m.send_after, m.sent_at
  from customer_invoice_deliveries d left join conversation_messages m on m.id = d.message_id and m.org_id = d.org_id left join users u on u.id = d.requested_by`;

function toView(r: DeliveryRow, now: Date): InvoiceDeliveryView {
  const d = describeInvoiceDelivery({
    channel: r.channel, addressMask: r.address_mask, messageStatus: r.message_status, blockedReason: r.blocked_reason, statusDetail: r.status_detail, failureKind: r.failure_kind,
    sendAfter: r.send_after, sentAt: r.sent_at, withdrawnAt: r.withdrawn_at, withdrawnReason: r.withdrawn_reason, now,
  });
  return {
    ...d, id: r.id, linkVersion: r.link_version, channel: r.channel, channelLabel: channelLabel(r.channel), requestedByName: r.requested_by_name, requestedAt: new Date(r.created_at).toISOString(),
    addressMask: r.address_mask, sendAfter: d.state === "waiting" ? iso(r.send_after) : null, sentAt: iso(r.sent_at),
  };
}

/** The messages that were sent about an invoice, newest first, each with its honest state. Reads the send chain's rows, so it runs as trusted code. */
export async function invoiceDeliveriesFor(db: Queryable, orgId: string, invoiceId: string, now = new Date()): Promise<InvoiceDeliveryView[]> {
  const { rows } = await db.query<DeliveryRow>(`${DELIVERY_SQL} where d.org_id = $1 and d.invoice_id = $2 order by d.created_at desc, d.id limit ${LIST_LIMIT}`, [orgId, invoiceId]);
  return rows.map((r) => toView(r, now));
}

/** The deliveries that stand in the way of another one on this channel for this link: a message still on its way, or one the provider accepted. */
async function standingOn(db: Queryable, row: InvoiceRow, channel: DeliveryChannel, now: Date): Promise<InvoiceDeliveryView | null> {
  const { rows } = await db.query<DeliveryRow>(
    `${DELIVERY_SQL} where d.org_id = $1 and d.invoice_id = $2 and d.link_version = $3 and d.channel = $4 order by d.created_at desc, d.id`,
    [row.org_id, row.id, row.public_token_version, channel],
  );
  for (const r of rows) {
    const v = toView(r, now);
    if (!v.ended) return v;
  }
  return null;
}

async function usedBy(db: Queryable, row: InvoiceRow): Promise<number> {
  return Number((await db.query<{ n: string }>("select count(*)::text as n from customer_invoice_deliveries where org_id = $1 and invoice_id = $2 and link_version = $3", [row.org_id, row.id, row.public_token_version])).rows[0].n);
}

const deliveryMessage = (p: Prepared, channel: DeliveryChannel, userId: string, now: Date): DeliveryMessage => ({
  orgId: p.row.org_id, contactId: p.contactId, channel, threadKey: channel === "email" ? `invoice:${p.row.id}` : null, subject: p.message.subject, userId, body: p.message.body, now,
});

function asChannel(value: unknown): DeliveryChannel {
  if (!isDeliveryChannel(value)) throw new AppError("invalid_input", "Choose email, text message or WhatsApp.");
  return value;
}

const mustSend = (ctx: OrgContext) => {
  if (!ctx.can("invoices.send")) throw new AppError("forbidden", "Only the business owner or a manager can send an invoice to a customer.");
};

const notFound = () => new AppError("not_found", "That invoice was not found.");

// ---------------------------------------------------------------------------
// The preview: exactly what would be sent, and what the send chain says about it
// ---------------------------------------------------------------------------

export interface InvoiceDeliveryPreview {
  available: true;
  /** The version of the customer's link when the sender looked: a replaced link makes what they read stale. */
  linkVersion: number;
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
  /** A message on this channel for this link is already on its way or was accepted by the provider: another is not offered. */
  standing: InvoiceDeliveryView | null;
  /** How many more messages this link can have. */
  remaining: number;
}

/** The reason a message cannot be offered at all (before the send chain is asked), in words the sender can act on. */
export interface InvoiceDeliveryUnavailable {
  available: false;
  linkVersion: number;
  channel: DeliveryChannel;
  channelLabel: string;
  reason: string;
  text: string;
}

/**
 * What a message about this invoice would say, where it would go, and what the send chain would do with it right now. Nothing is written: the probe makes and unmakes its
 * conversation inside a savepoint. Needs the permission to send invoices.
 */
export async function previewInvoiceDelivery(ctx: OrgContext, invoiceId: string, channelInput: unknown, deps: { now?: Date } = {}): Promise<InvoiceDeliveryPreview | InvoiceDeliveryUnavailable> {
  const now = deps.now ?? new Date();
  return withSystem(async (db) => {
    await assertInvoicesAvailable(db, ctx);
    mustSend(ctx);
    const channel = asChannel(channelInput);
    const row = await loadInvoiceRow(db, ctx.org.orgId, invoiceId);
    if (!row) throw notFound();
    const p = await prepare(db, row, channel);
    if (isBlocked(p)) return { available: false, linkVersion: row.public_token_version, channel, channelLabel: channelLabel(channel), reason: p.blocked.reason, text: p.blocked.text };
    const remaining = Math.max(0, MAX_INVOICE_DELIVERIES_PER_LINK - (await usedBy(db, row)));
    const standing = await standingOn(db, row, channel, now);
    const decision = await probeDelivery(db, deliveryMessage(p, channel, ctx.user.id, now));
    const verdict = invoiceDeliveryVerdict(decision.allow ? { allow: true } : { allow: false, reason: decision.reason, detail: decision.detail, retryAt: decision.retryAt, permanent: decision.permanent }, channel, p.addressMask);
    return {
      available: true, linkVersion: row.public_token_version, channel, channelLabel: channelLabel(channel), subject: p.message.subject, body: previewInvoiceDeliveryBody(p.message.body),
      wordingVersion: INVOICE_DELIVERY_WORDING_VERSION, wordingIsDraft: INVOICE_DELIVERY_WORDING_VERSION.startsWith("draft"), wordingHash: invoiceDeliveryWordingHash(channel, p.message),
      addressMask: p.addressMask, usesCredits: channel !== "email", verdict, standing, remaining,
    };
  });
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export interface SendInvoiceDeliveryInput {
  channel: unknown;
  /** The version of the customer's link the sender was looking at. */
  linkVersion: number;
  /** The fingerprint of the message the sender read (InvoiceDeliveryPreview.wordingHash). */
  wordingHash: unknown;
}

export type SendInvoiceDeliveryResult =
  | { status: "queued"; delivery: InvoiceDeliveryView; waitingUntil: string | null }
  | { status: "already"; delivery: InvoiceDeliveryView }
  | { status: "refused"; reason: string; text: string };

/**
 * Hands the message the sender read to the send chain. Refused, with nothing left behind but an audit line, when the invoice is not payable any more, when the message is not the
 * one they read, or when the chain says no (no consent, an opt-out, a person's hold, a paused workspace, credits, the channel). A second request while the first is on its way, or
 * after the provider accepted it, returns that message instead of sending another.
 */
export async function sendInvoiceDelivery(ctx: OrgContext, invoiceId: string, input: SendInvoiceDeliveryInput, deps: { now?: Date } = {}): Promise<SendInvoiceDeliveryResult> {
  const now = deps.now ?? new Date();
  return withSystem(async (db): Promise<SendInvoiceDeliveryResult> => {
    await assertInvoicesAvailable(db, ctx);
    mustSend(ctx);
    const channel = asChannel(input.channel);
    if (!Number.isInteger(input.linkVersion) || input.linkVersion < 1) throw new AppError("invalid_input", "Look at the invoice again before you send it.");
    if (typeof input.wordingHash !== "string" || !/^[0-9a-f]{64}$/.test(input.wordingHash)) throw new AppError("invalid_input", "Read the message again before you send it.");
    const hash = input.wordingHash;
    const row = await loadInvoiceRow(db, ctx.org.orgId, invoiceId, true);
    if (!row) throw notFound();
    if (row.public_token_version !== input.linkVersion) throw new AppError("conflict", "The customer's link was replaced. Look at the invoice again before you send it.");
    const refuse = async (reason: string, text: string): Promise<SendInvoiceDeliveryResult> => {
      await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "invoice.delivery_refused", targetType: "customer_invoice", targetId: row.id, result: "denied", metadata: { number: row.number, linkVersion: row.public_token_version, channel, reason } }, db);
      return { status: "refused", reason, text };
    };
    const p = await prepare(db, row, channel);
    if (isBlocked(p)) return refuse(p.blocked.reason, p.blocked.text);
    if (invoiceDeliveryWordingHash(channel, p.message) !== hash) throw new AppError("conflict", "The message changed since you read it. Read it again before you send it.");
    // A double click, or a second person pressing the same button: the first message is the answer.
    const standing = await standingOn(db, row, channel, now);
    if (standing) return { status: "already", delivery: standing };
    if ((await usedBy(db, row)) >= MAX_INVOICE_DELIVERIES_PER_LINK) {
      return refuse("too_many", `This link has already had ${MAX_INVOICE_DELIVERIES_PER_LINK} messages. Copy the link and give it to the customer yourself.`);
    }
    // One message per request. The key names the invoice, the version of its link and the channel, and a request after an earlier one ended without reaching the provider takes the
    // next number, because the key of the earlier message is spent.
    const base = `${DEDUPE_PREFIX}:${row.id}:${row.public_token_version}:${channel}`;
    const spent = Number((await db.query<{ n: string }>("select count(*)::text as n from conversation_messages where org_id = $1 and (dedupe_key = $2 or dedupe_key like $2 || ':%')", [row.org_id, base])).rows[0].n);
    const queued = await queueDelivery(db, deliveryMessage(p, channel, ctx.user.id, now), spent ? `${base}:${spent}` : base);
    if (!queued.ok) return refuse(queued.reason, invoiceRefusalReasonText(queued.reason, queued.detail));
    const made = (await db.query<{ id: string }>(
      `insert into customer_invoice_deliveries (org_id, invoice_id, link_version, channel, message_id, wording_version, wording_hash, address_mask, requested_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [row.org_id, row.id, row.public_token_version, channel, queued.messageId, INVOICE_DELIVERY_WORDING_VERSION, hash, p.addressMask, ctx.user.id],
    )).rows[0];
    const waitingUntil = queued.waitingUntil ? queued.waitingUntil.toISOString() : null;
    // The history and the audit line say which channel and which delivery, not where it went: the masked address is kept on the delivery only, which a privacy request can clear
    // (the history and the audit trail are records that stay).
    await addInvoiceEvent(db, row.org_id, row.id, "delivery_queued", { id: ctx.user.id, kind: "user" }, { channel, deliveryId: made.id, waitingUntil });
    await recordAudit({
      orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "invoice.delivery_queued", targetType: "customer_invoice", targetId: row.id, result: "success",
      metadata: { number: row.number, linkVersion: row.public_token_version, channel, deliveryId: made.id, wordingVersion: INVOICE_DELIVERY_WORDING_VERSION, wordingFingerprint: hash, waitingUntil },
    }, db);
    const view = (await db.query<DeliveryRow>(`${DELIVERY_SQL} where d.id = $1 and d.org_id = $2`, [made.id, row.org_id])).rows[0];
    return { status: "queued", delivery: toView(view, now), waitingUntil };
  });
}

// ---------------------------------------------------------------------------
// Right before the provider call
// ---------------------------------------------------------------------------

/**
 * The customer's link for the message the dispatcher is about to send, derived again from the invoice and used for the provider call only. Null when the message is not a delivery
 * of an invoice, or the invoice can no longer be paid through that link: not issued, a test, written off, paid, disputed, its link replaced, the module switched off, or the
 * platform's emergency stop for invoice links on. The address the message goes to is recorded (masked) on the delivery, so the screen says where it really went.
 */
export async function invoiceLinkForDelivery(db: Queryable, orgId: string, messageId: string, address: string, channel: DeliveryChannel): Promise<string | null> {
  const d = (await db.query<{
    id: string; invoice_id: string; link_version: number; channel: string; withdrawn_at: Date | null; status: string; payment_status: string; written_off_at: Date | null; is_test: boolean;
    balance_minor: string; public_token_version: number; public_token_hash: string | null;
  }>(
    `select d.id, d.invoice_id, d.link_version, d.channel, d.withdrawn_at, i.status, i.payment_status, i.written_off_at, i.is_test, i.balance_minor::text as balance_minor,
            i.public_token_version, i.public_token_hash
     from customer_invoice_deliveries d join customer_invoices i on i.id = d.invoice_id and i.org_id = d.org_id
     where d.org_id = $1 and d.message_id = $2`,
    [orgId, messageId],
  )).rows[0];
  if (!d || d.withdrawn_at || d.channel !== channel) return null;
  if (d.status !== "issued" || d.is_test || d.written_off_at || !["unpaid", "partially_paid"].includes(d.payment_status) || toMinor(d.balance_minor) <= 0) return null;
  if (d.public_token_version !== d.link_version) return null;
  if (invoicesPublicDisabled() || !(await invoicesEnabledIn(db, orgId))) return null;
  const token = tokenForStoredHash(d.invoice_id, d.public_token_version, d.public_token_hash);
  if (!token) return null;
  await db.query("update customer_invoice_deliveries set address_mask = $3 where id = $1 and org_id = $2", [d.id, orgId, maskAddress(channel, address)]);
  return invoiceLinkUrl(token);
}

// ---------------------------------------------------------------------------
// Stopping what has not gone out
// ---------------------------------------------------------------------------

/**
 * Stops the messages about an invoice that have not gone out (queued, or waiting for sending hours): the message is stopped, its credit hold given back, and the delivery says why. A
 * message already on its way or accepted is left alone; the dispatcher claims a message with the same status check, so exactly one side wins. Called by whatever ends the customer's
 * link or the debt, inside that change's own transaction. Returns how many were stopped.
 */
export async function withdrawInvoiceDeliveriesInTx(db: Queryable, orgId: string, invoiceId: string, reason: InvoiceWithdrawReason): Promise<number> {
  const { rows } = await db.query<{ id: string; message_id: string }>(
    `select d.id, d.message_id from customer_invoice_deliveries d join conversation_messages m on m.id = d.message_id and m.org_id = d.org_id
     where d.org_id = $1 and d.invoice_id = $2 and d.withdrawn_at is null and m.status in ('draft', 'queued') order by d.created_at`,
    [orgId, invoiceId],
  );
  let stopped = 0;
  for (const r of rows) {
    // The message first, then the delivery: the dispatcher takes them in that order too.
    if (!(await stopQueuedMessage(db, { orgId, messageId: r.message_id, reason, detail: INVOICE_WITHDRAWN_REASON_TEXT[reason] }))) continue;
    await db.query("update customer_invoice_deliveries set withdrawn_at = now(), withdrawn_reason = $3 where id = $1 and org_id = $2", [r.id, orgId, reason]);
    stopped += 1;
  }
  if (stopped) await addInvoiceEvent(db, orgId, invoiceId, "delivery_withdrawn", { id: null, kind: "system" }, { count: stopped, reason });
  return stopped;
}

/**
 * A privacy request for the customer: what has not gone out is stopped, and the masked addresses kept on the deliveries are removed. The message rows themselves (their text and
 * subject) are made unreadable by the erasure of the customer's conversations.
 */
export async function eraseInvoiceDeliveriesInTx(db: Queryable, orgId: string, invoiceIds: string[]): Promise<number> {
  let stopped = 0;
  for (const id of invoiceIds) stopped += await withdrawInvoiceDeliveriesInTx(db, orgId, id, "privacy_request");
  if (invoiceIds.length) await db.query("update customer_invoice_deliveries set address_mask = null where org_id = $1 and invoice_id = any($2::uuid[])", [orgId, invoiceIds]);
  return stopped;
}
