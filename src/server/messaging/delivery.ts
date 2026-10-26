import "server-only";
import type { Queryable } from "@/server/db";
import { releaseReservation } from "@/server/billing/ledger";
import { evaluateSend, queueOutbound, type SendDecision, type SendRequest } from "@/server/messaging/send";
import type { Channel } from "@/lib/messaging";

// The first delivery of a document to a customer (a proposal's link; an invoice later), through the same consent-gated send chain as every other message (send.ts, scope "delivery").
// This file is the part every document shares: which conversation the message goes in, whether the chain would take it (a probe that leaves nothing behind), queueing it so that
// a refusal leaves no half-made rows, and withdrawing what has not gone out. What the message says, which document it is about and what is recorded about it belong to the
// document's own module (src/server/proposals/delivery.ts).
//
// The message is authored by the system on behalf of the person who pressed Send, like an invoice reminder, because a message that has to wait for a sending window is sent later
// without anyone present, and the chain records a refusal of such a message instead of throwing.

export interface DeliveryMessage {
  orgId: string;
  contactId: string;
  channel: Channel;
  /**
   * A conversation of its own for this document (email only; the key names it). One thread per document gives the email its own subject, and the customer's reply joins it.
   * Null uses the customer's existing open conversation on the channel (a text thread is one conversation, and a new message belongs in it).
   */
  threadKey: string | null;
  /** The subject a conversation of its own is created with. */
  subject: string | null;
  /** The person who pressed Send. */
  userId: string;
  /** The stored text: the customer's link is a placeholder, never a link. */
  body: string;
  now: Date;
}

/** The conversation a delivery goes in, made when there is none. A new conversation is the team's, not an AI employee's: a customer who replies reaches a person. */
export async function deliveryConversation(db: Queryable, m: Pick<DeliveryMessage, "orgId" | "contactId" | "channel" | "threadKey" | "subject">): Promise<string> {
  if (m.threadKey) {
    return (await db.query<{ id: string }>(
      `insert into conversations (org_id, contact_id, channel, thread_key, status, subject, owner_kind) values ($1, $2, $3, $4, 'open', $5, 'unassigned')
       on conflict (org_id, contact_id, channel, thread_key) do update set updated_at = now() returning id`,
      [m.orgId, m.contactId, m.channel, m.threadKey.slice(0, 120), (m.subject ?? "").slice(0, 300) || null],
    )).rows[0].id;
  }
  const existing = (await db.query<{ id: string }>(
    "select id from conversations where org_id = $1 and contact_id = $2 and channel = $3 and status <> 'closed' order by last_message_at desc nulls last, created_at limit 1", [m.orgId, m.contactId, m.channel],
  )).rows[0];
  if (existing) return existing.id;
  return (await db.query<{ id: string }>(
    `insert into conversations (org_id, contact_id, channel, status, subject, owner_kind) values ($1, $2, $3, 'open', $4, 'unassigned')
     on conflict (org_id, contact_id, channel, thread_key) do update set updated_at = now() returning id`,
    [m.orgId, m.contactId, m.channel, (m.subject ?? "").slice(0, 300) || null],
  )).rows[0].id;
}

const requestFor = (m: DeliveryMessage, conversationId: string): SendRequest => ({
  orgId: m.orgId, conversationId, scope: "delivery", purpose: "service", actor: { kind: "system", userId: m.userId }, body: m.body, now: m.now, businessHoursOnly: false,
});

/**
 * What the send chain would say to this message right now, without leaving anything behind: the conversation it would go in is made and unmade inside a savepoint. The answer is
 * the chain's own (consent, opt-out, a person's hold, a paused workspace, credits, the channel, quiet hours), so a preview can never promise what the send would refuse.
 */
export async function probeDelivery(db: Queryable, m: DeliveryMessage): Promise<SendDecision> {
  await db.query("savepoint delivery_probe");
  try {
    return await evaluateSend(db, requestFor(m, await deliveryConversation(db, m)));
  } finally {
    await db.query("rollback to savepoint delivery_probe");
    await db.query("release savepoint delivery_probe");
  }
}

export type DeliveryQueued =
  | { ok: true; messageId: string; conversationId: string; channel: Channel; /** Set when the message waits for a sending window. */ waitingUntil: Date | null }
  | { ok: false; reason: string; detail: string };

/**
 * Hands the message to the send chain. "Not yet" (quiet hours) queues it for the next window; any other refusal leaves nothing behind (no conversation, no message, no credit
 * hold) and comes back as the chain's reason and words. `dedupeKey` makes the message at-most-once at the database.
 */
export async function queueDelivery(db: Queryable, m: DeliveryMessage, dedupeKey: string): Promise<DeliveryQueued> {
  await db.query("savepoint delivery_queue");
  const undo = async () => {
    await db.query("rollback to savepoint delivery_queue");
    await db.query("release savepoint delivery_queue");
  };
  try {
    const conversationId = await deliveryConversation(db, m);
    const send = requestFor(m, conversationId);
    const decision = await evaluateSend(db, send);
    // "Not yet" is fine: the message is queued for the next window. Anything else is final.
    const waiting = !decision.allow && Boolean(decision.retryAt) && !decision.permanent;
    if (!decision.allow && !waiting) {
      await undo();
      return { ok: false, reason: decision.reason, detail: decision.detail };
    }
    const queued = await queueOutbound(db, { ...send, dedupeKey });
    if (queued.status !== "queued") {
      await undo();
      return { ok: false, reason: queued.reason ?? "blocked", detail: queued.detail ?? "The message could not be queued." };
    }
    await db.query("release savepoint delivery_queue");
    return { ok: true, messageId: queued.messageId, conversationId, channel: m.channel, waitingUntil: !decision.allow && decision.retryAt ? decision.retryAt : null };
  } catch (e) {
    await undo();
    throw e;
  }
}

/**
 * Stops a delivery message that has not gone out and gives its credit hold back. The dispatcher claims a message with the same status check, so exactly one side wins: a message
 * already on its way is not stopped. True when this call stopped it.
 */
export async function stopQueuedMessage(db: Queryable, p: { orgId: string; messageId: string; reason: string; detail: string }): Promise<boolean> {
  const m = (await db.query<{ reservation_id: string | null }>(
    "update conversation_messages set status = 'blocked', blocked_reason = $3, status_detail = $4 where id = $1 and org_id = $2 and status in ('draft', 'queued') returning reservation_id",
    [p.messageId, p.orgId, p.reason.slice(0, 60), p.detail.slice(0, 300)],
  )).rows[0];
  if (!m) return false;
  if (m.reservation_id) await releaseReservation(db, { orgId: p.orgId, reservationId: m.reservation_id, reason: `Stopped: ${p.reason}` });
  return true;
}

const HELD_DETAIL = "Stopped before sending: a person on your team excluded this customer from automatic messages.";

/**
 * A person's hold on automatic messages to one customer (src/server/retention/service.ts setRetentionPaused) stops the delivery messages already queued for them, the ones waiting
 * out quiet hours. The dispatcher checks the hold again right before sending, so a message this does not reach is still stopped; this gives the credit hold back at once and makes the
 * Delivery tab say so. Returns how many were stopped.
 */
export async function withdrawQueuedDeliveriesForContact(db: Queryable, orgId: string, contactId: string): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    `select m.id from conversation_messages m join conversations c on c.id = m.conversation_id and c.org_id = m.org_id
     where m.org_id = $1 and c.contact_id = $2 and m.scope = 'delivery' and m.direction = 'outbound' and m.status in ('draft', 'queued')`,
    [orgId, contactId],
  );
  let n = 0;
  for (const r of rows) if (await stopQueuedMessage(db, { orgId, messageId: r.id, reason: "held_by_person", detail: HELD_DETAIL })) n += 1;
  return n;
}
