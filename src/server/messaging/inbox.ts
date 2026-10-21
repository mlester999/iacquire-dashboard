import "server-only";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { reserveCredits, releaseReservation, BillingBlockedError } from "@/server/billing/ledger";
import { createApproval } from "@/server/approvals/service";
import { assignConversation, ensureHumanOwner } from "@/server/messaging/handoff";
import { assertConversationVisible } from "@/server/messaging/access";
import { recordConversationEvent } from "@/server/messaging/events";
import { evaluateSend, queueOutbound } from "@/server/messaging/send";
import { maskCustomerLinks } from "@/server/messaging/redact";
import { getConversationListItem, listConversationsPage, type ConversationFilters, type ConversationListItem } from "@/server/messaging/inbox-list";
import { TRANSPORT_LABELS, type TransportName } from "@/server/messaging/transports/types";
import { unconfirmedOutcome, validateBusinessHours, type BusinessHours, type Channel, type CustomFollowUp, type FollowUpPreset, type MessageStatus } from "@/lib/messaging";
import { describeConversationEvent, isConversationOutcome, type ConversationOutcome } from "@/lib/inbox";
import type { OrgContext } from "@/server/tenancy/context";
import type { SessionUser } from "@/server/auth/service";

export type { ConversationFilters, ConversationListItem } from "@/server/messaging/inbox-list";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Conversations the signed-in person is allowed to see. Row-level security decides visibility, not this query. */
export async function listConversations(ctx: OrgContext, f: ConversationFilters = {}): Promise<ConversationListItem[]> {
  return (await listConversationsPage(ctx, f)).items;
}

/** The conversation's own list row, under the same row-level security as the list (so opening an old one doesn't depend on it being listed). */
const conversationItems = async (ctx: OrgContext, _f: ConversationFilters, onlyId: string): Promise<ConversationListItem[]> => {
  const item = await getConversationListItem(ctx, onlyId);
  return item ? [item] : [];
};

export interface MessageView {
  id: string;
  direction: "inbound" | "outbound" | "internal";
  authorKind: "contact" | "ai" | "human" | "system";
  authorName: string | null;
  body: string;
  status: MessageStatus;
  statusDetail: string | null;
  blockedReason: string | null;
  scope: string | null;
  createdAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
  /** failed only: "rejected" (the provider refused it, so the customer has nothing) or "unconfirmed" (no answer, so they might already have it). */
  failureKind: "rejected" | "unconfirmed" | null;
  /** The message this one re-sent, and the one that re-sent this. */
  retryOf: string | null;
  retriedBy: string | null;
}

/** A conversation opens with at most its newest this-many messages (oldest first), so a years-long SMS thread is not sent whole. */
export const CONVERSATION_MESSAGE_PAGE = 200;
/** Drafts still waiting for approval that are older than the newest page are added to it (so they can still be approved), up to this many. */
const HELD_DRAFTS_LIMIT = 50;

type MessageRow = { id: string; direction: MessageView["direction"]; author_kind: MessageView["authorKind"]; author_name: string | null; body: string; status: MessageStatus; status_detail: string | null; blocked_reason: string | null; scope: string | null; created_at: Date; sent_at: Date | null; delivered_at: Date | null; failure_kind: "rejected" | "unconfirmed" | null; retry_of: string | null; retried_by: string | null };
const MESSAGE_COLUMNS = "m.id, m.direction, m.author_kind, u.full_name as author_name, m.body, m.status, m.status_detail, m.blocked_reason, m.scope, m.created_at, m.sent_at, m.delivered_at, m.failure_kind, m.retry_of, (select r.id from conversation_messages r where r.retry_of = m.id limit 1) as retried_by";
const toMessageView = (m: MessageRow): MessageView => ({
  id: m.id, direction: m.direction, authorKind: m.author_kind, authorName: m.author_name, body: maskCustomerLinks(m.body), status: m.status, statusDetail: m.status_detail, blockedReason: m.blocked_reason,
  scope: m.scope, createdAt: new Date(m.created_at).toISOString(), sentAt: m.sent_at ? new Date(m.sent_at).toISOString() : null, deliveredAt: m.delivered_at ? new Date(m.delivered_at).toISOString() : null,
  failureKind: m.status === "failed" ? m.failure_kind : null, retryOf: m.retry_of, retriedBy: m.retried_by,
});

export interface ConversationDetail {
  conversation: ConversationListItem & { subject: string | null; lastInboundAt: string | null; whatsappWindowOpen: boolean | null };
  contact: { id: string; name: string; lifecycleStage: string; temperature: string | null; source: string; identities: Array<{ kind: string; value: string; verified: boolean }>; consent: Array<{ channel: string; purpose: string; status: string }> };
  /** Oldest first: the newest CONVERSATION_MESSAGE_PAGE messages, plus any older drafts still waiting for approval. */
  messages: MessageView[];
  /**
   * Present only when the thread has older messages than those in `messages`: the oldest message of the newest page, where a read of older
   * messages would continue (before it, by created_at then id).
   */
  olderMessages?: { beforeId: string };
  timeline: Array<{ at: string; text: string }>;
  /** Ownership changes and lifecycle events only (no message lines): what the thread shows between the messages, in time order. */
  events: Array<{ id: string; at: string; text: string; after?: boolean }>;
  memories: Array<{ id: string; kind: "confirmed_fact" | "ai_summary"; content: string; createdAt: string }>;
  followUp: { status: string; nextDueAt: string | null; remaining: number } | null;
  escalation: { id: string; category: string; urgency: string; status: string; summary: string; ownerResponse: string; ownerDeadlineAt: string | null; claimedByName: string | null } | null;
}

/** What the thread says about a change of who handles a conversation, from what the ownership trail recorded (no names beyond the new owner's). */
function ownershipText(e: { from_kind: string; to_kind: string; reason: string | null; to_name: string | null }): string {
  const reason = e.reason?.trim() || null;
  if (e.to_kind === "human") return reason && /^(Handed to|Assigned to)/.test(reason) ? reason : `${e.to_name ?? "A teammate"} took over${reason ? ` · ${reason}` : ""}`;
  if (e.to_kind === "ai") return reason && /^(Assigned to|Handed back)/.test(reason) ? reason : `Handed to the AI${reason ? ` · ${reason}` : ""}`;
  return "Nobody owns this conversation now";
}

export async function getConversationDetail(ctx: OrgContext, conversationId: string): Promise<ConversationDetail> {
  if (!ctx.can("inbox.view")) throw new AppError("forbidden", "You can't view the inbox.");
  // The conversation's own list row, under the same row-level security as the list (not the first 200 listed, so older ones open too).
  const [base] = UUID.test(conversationId) ? await conversationItems(ctx, {}, conversationId) : [];
  if (!base) throw new AppError("not_found", "Conversation not found.");
  return withUser(ctx.user.id, async (db) => {
    const conv = await db.query<{ subject: string | null; last_inbound_at: Date | null }>("select subject, last_inbound_at from conversations where id = $1", [conversationId]);
    const k = await db.query<{ id: string; display_name: string; lifecycle_stage: string; temperature: string | null; source: string }>("select id, display_name, lifecycle_stage, temperature, source from contacts where id = $1", [base.contactId]);
    const ids = await db.query<{ kind: string; value: string; verified: boolean }>("select kind, value, verified from contact_identities where contact_id = $1 order by kind", [base.contactId]);
    const consent = await db.query<{ channel: string; purpose: string; status: string }>(
      "select distinct on (channel, purpose) channel, purpose, status from contact_consent_events where contact_id = $1 order by channel, purpose, id desc",
      [base.contactId],
    );
    // The newest page (one extra row tells whether older messages exist), read newest first on the thread index and returned oldest first.
    const newest = await db.query<MessageRow>(
      `select * from (select ${MESSAGE_COLUMNS} from conversation_messages m left join users u on u.id = m.author_user_id
                      where m.conversation_id = $1 order by m.created_at desc, m.id desc limit $2) t
       order by t.created_at, t.id`,
      [conversationId, CONVERSATION_MESSAGE_PAGE + 1],
    );
    const hasOlder = newest.rows.length > CONVERSATION_MESSAGE_PAGE;
    const page = hasOlder ? newest.rows.slice(1) : newest.rows;
    const held = hasOlder
      ? await db.query<MessageRow>(
          `select * from (select ${MESSAGE_COLUMNS} from conversation_messages m left join users u on u.id = m.author_user_id
                          where m.conversation_id = $1 and m.status = 'draft' and m.id <> all($2::uuid[]) order by m.created_at desc, m.id desc limit $3) t
           order by t.created_at, t.id`,
          [conversationId, page.map((m) => m.id), HELD_DRAFTS_LIMIT],
        )
      : { rows: [] as MessageRow[] };
    const msgs = { rows: [...held.rows, ...page] };
    const events = await db.query<{ id: string; created_at: Date; from_kind: string; to_kind: string; actor_kind: string; reason: string | null; to_name: string | null }>(
      `select e.id, e.created_at, e.from_kind, e.to_kind, e.actor_kind, e.reason, u.full_name as to_name from conversation_ownership_events e left join users u on u.id = e.to_user_id where e.conversation_id = $1 order by e.id`,
      [conversationId],
    );
    const mem = await db.query<{ id: string; kind: "confirmed_fact" | "ai_summary"; content: string; created_at: Date }>("select id, kind, content, created_at from contact_memories where contact_id = $1 order by created_at desc limit 30", [base.contactId]);
    const plan = await db.query<{ status: string }>("select status from follow_up_plans where contact_id = $1 and status = 'active'", [base.contactId]).catch(() => ({ rows: [] as Array<{ status: string }> }));
    const steps = plan.rows[0]
      ? await db.query<{ next: Date | null; remaining: string }>("select min(due_at) filter (where status = 'scheduled') as next, count(*) filter (where status in ('scheduled', 'queued'))::text as remaining from follow_up_steps where contact_id = $1 and plan_id in (select id from follow_up_plans where contact_id = $1 and status = 'active')", [base.contactId])
      : null;
    const esc = await db.query<{ id: string; category: string; urgency: string; status: string; summary: string; owner_response: string; owner_deadline_at: Date | null; claimed_name: string | null }>(
      `select e.id, e.category, e.urgency, e.status, e.summary, e.owner_response, e.owner_deadline_at, u.full_name as claimed_name
       from human_escalations e left join users u on u.id = e.claimed_by where e.conversation_id = $1 and e.status in ('awaiting_owner', 'open', 'claimed') limit 1`,
      [conversationId],
    ).catch(() => ({ rows: [] as never[] }));
    const policy = await db.query<{ whatsapp_window_hours: number }>("select whatsapp_window_hours from messaging_policy");
    const lastIn = conv.rows[0]?.last_inbound_at ? new Date(conv.rows[0].last_inbound_at) : null;
    const timeline: Array<{ at: string; text: string }> = [];
    // What the thread shows between messages: ownership changes first read, then lifecycle events, each with a stable id for the client.
    const eventLines: Array<{ id: string; at: string; text: string; after?: boolean }> = [];
    for (const e of events.rows) eventLines.push({ id: `own-${e.id}`, at: new Date(e.created_at).toISOString(), text: ownershipText(e) });
    // Lifecycle events (assignment, AI chosen or paused, status, priority, archive, handoff request, re-sent message), named from ids at read time.
    const life = await db.query<{ id: string; created_at: Date; kind: string; actor_kind: string; detail: Record<string, unknown>; actor_name: string | null; target_name: string | null; agent_name: string | null }>(
      `select e.id, e.created_at, e.kind, e.actor_kind, e.detail, au.full_name as actor_name, tu.full_name as target_name, ag.display_name as agent_name
       from conversation_events e
       left join users au on au.id = e.actor_user_id
       left join users tu on tu.id = (case when e.kind = 'assigned' and e.detail->>'to' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (e.detail->>'to')::uuid end)
       left join agent_instances ag on ag.id = coalesce(e.agent_id, (case when e.detail->>'agentId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (e.detail->>'agentId')::uuid end))
       where e.conversation_id = $1 and e.org_id = $2 order by e.id`,
      [conversationId, ctx.org.orgId],
    );
    for (const e of life.rows) {
      // A hand-over already shows as a change of owner just above; the event stays on the trail for automations and the audit.
      if (e.kind === "assigned" && e.detail?.transfer === true) continue;
      const actor = e.actor_kind === "ai" ? (e.agent_name ?? "AI") : e.actor_kind === "workflow" ? "An automation" : e.actor_kind === "system" ? "iAcquire" : (e.actor_name ?? "A teammate");
      // A change a person makes happens before the message they send in the same moment; a request for a person is a reaction to the message that caused it.
      eventLines.push({ id: `ev-${e.id}`, at: new Date(e.created_at).toISOString(), text: describeConversationEvent(e.kind, e.detail ?? {}, { actor, target: e.target_name, agent: e.agent_name }), ...(e.kind === "handoff_requested" || e.detail?.reason === "handoff" ? { after: true } : {}) });
    }
    eventLines.sort((a, b) => a.at.localeCompare(b.at));
    for (const e of eventLines) timeline.push({ at: e.at, text: e.text });
    for (const m of msgs.rows) {
      if (m.direction === "outbound" && m.author_kind === "ai") timeline.push({ at: new Date(m.created_at).toISOString(), text: m.status === "draft" ? "AI drafted a reply for approval" : m.status === "blocked" ? `AI reply was blocked (${m.blocked_reason ?? "policy"})` : `AI ${m.status === "queued" ? "queued" : "sent"} a ${m.scope === "followup" ? "follow-up" : "reply"}` });
    }
    timeline.sort((a, b) => a.at.localeCompare(b.at));
    return {
      conversation: { ...base, subject: conv.rows[0]?.subject ?? null, lastInboundAt: lastIn ? lastIn.toISOString() : null, whatsappWindowOpen: base.channel === "whatsapp" ? Boolean(lastIn && Date.now() - lastIn.getTime() <= policy.rows[0].whatsapp_window_hours * 3600_000) : null },
      contact: { id: k.rows[0].id, name: k.rows[0].display_name || "Unknown contact", lifecycleStage: k.rows[0].lifecycle_stage, temperature: k.rows[0].temperature, source: k.rows[0].source, identities: ids.rows, consent: consent.rows },
      messages: msgs.rows.map(toMessageView),
      ...(hasOlder ? { olderMessages: { beforeId: page[0].id } } : {}),
      timeline,
      events: eventLines,
      memories: mem.rows.map((m) => ({ id: m.id, kind: m.kind, content: m.content, createdAt: new Date(m.created_at).toISOString() })),
      followUp: plan.rows[0] && steps ? { status: "active", nextDueAt: steps.rows[0].next ? new Date(steps.rows[0].next).toISOString() : null, remaining: Number(steps.rows[0].remaining) } : null,
      escalation: esc.rows[0] ? { id: esc.rows[0].id, category: esc.rows[0].category, urgency: esc.rows[0].urgency, status: esc.rows[0].status, summary: esc.rows[0].summary, ownerResponse: esc.rows[0].owner_response, ownerDeadlineAt: esc.rows[0].owner_deadline_at ? new Date(esc.rows[0].owner_deadline_at).toISOString() : null, claimedByName: esc.rows[0].claimed_name } : null,
    };
  });
}

/** A page of a conversation's older messages, oldest first, for the inbox's "Load older messages". */
export interface OlderMessagesPage {
  messages: MessageView[];
  /** Present only when still older messages exist: where the next read continues (the oldest message of this page). */
  olderMessages?: { beforeId: string };
}

/**
 * The CONVERSATION_MESSAGE_PAGE messages just before `beforeId` (by created_at, then id), oldest first: what "Load older messages" adds
 * above the thread. The same visibility as getConversationDetail: the conversation must be one the person can open (its own list row, under
 * row-level security), every message is read as the person, and `beforeId` must be a message of this conversation in this workspace that
 * the person can see. One extra row tells whether there is more.
 */
export async function getOlderMessages(ctx: OrgContext, conversationId: string, beforeId: string): Promise<OlderMessagesPage> {
  if (!ctx.can("inbox.view")) throw new AppError("forbidden", "You can't view the inbox.");
  const [base] = UUID.test(conversationId) ? await conversationItems(ctx, {}, conversationId) : [];
  if (!base) throw new AppError("not_found", "Conversation not found.");
  if (!UUID.test(beforeId)) throw new AppError("not_found", "That message isn't part of this conversation.");
  return withUser(ctx.user.id, async (db) => {
    const anchor = await db.query("select 1 from conversation_messages where id = $1 and org_id = $2 and conversation_id = $3", [beforeId, ctx.org.orgId, conversationId]);
    if (!anchor.rows.length) throw new AppError("not_found", "That message isn't part of this conversation.");
    const { rows } = await db.query<MessageRow>(
      `select * from (select ${MESSAGE_COLUMNS} from conversation_messages m left join users u on u.id = m.author_user_id
                      where m.conversation_id = $1 and m.org_id = $3
                        and (m.created_at, m.id) < (select b.created_at, b.id from conversation_messages b where b.id = $2 and b.org_id = $3 and b.conversation_id = $1)
                      order by m.created_at desc, m.id desc limit $4) t
       order by t.created_at, t.id`,
      [conversationId, beforeId, ctx.org.orgId, CONVERSATION_MESSAGE_PAGE + 1],
    );
    const hasOlder = rows.length > CONVERSATION_MESSAGE_PAGE;
    const page = hasOlder ? rows.slice(1) : rows;
    return { messages: page.map(toMessageView), ...(hasOlder ? { olderMessages: { beforeId: page[0].id } } : {}) };
  });
}

/** At most this many messages are re-read by id at once: as many as the older drafts a conversation opens with. */
export const MESSAGES_BY_ID_LIMIT = HELD_DRAFTS_LIMIT;

/**
 * The current version of the given messages of one conversation, oldest first. The inbox re-reads a draft it loaded with an older page once
 * the conversation stops listing it (approved or discarded, in the inbox, the Approval Center or by a teammate), so the message keeps its
 * place in the history with its real status instead of dropping out. The same visibility as getOlderMessages: the conversation must be one
 * the person can open, and every message is read as the person. Ids of other conversations or workspaces, and rows that no longer exist,
 * are simply not returned. Read only.
 */
export async function getMessagesByIds(ctx: OrgContext, conversationId: string, ids: string[]): Promise<MessageView[]> {
  if (!ctx.can("inbox.view")) throw new AppError("forbidden", "You can't view the inbox.");
  const [base] = UUID.test(conversationId) ? await conversationItems(ctx, {}, conversationId) : [];
  if (!base) throw new AppError("not_found", "Conversation not found.");
  const unique = [...new Set(ids)];
  if (unique.some((m) => typeof m !== "string" || !UUID.test(m))) throw new AppError("invalid_input", "Choose valid messages.");
  if (unique.length > MESSAGES_BY_ID_LIMIT) throw new AppError("invalid_input", `At most ${MESSAGES_BY_ID_LIMIT} messages can be read at once.`);
  if (!unique.length) return [];
  return withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<MessageRow>(
      `select ${MESSAGE_COLUMNS} from conversation_messages m left join users u on u.id = m.author_user_id
       where m.conversation_id = $1 and m.org_id = $2 and m.id = any($3::uuid[]) order by m.created_at, m.id`,
      [conversationId, ctx.org.orgId, unique],
    );
    return rows.map(toMessageView);
  });
}

/** A message as the inbox thread shows it: with the provider that carried it and its delivery events, oldest first. */
export interface DeliveredMessageView extends MessageView {
  /** The messaging provider's name (ghl, resend, twilio, meta_whatsapp); null before the message was handed to one. */
  provider: string | null;
  providerLabel: string | null;
  deliveryEvents: Array<{ status: string; rawStatus: string | null; detail: string | null; at: string }>;
}

/** At most this many delivery events are read for one page of messages. */
const DELIVERY_EVENTS_LIMIT = 1000;

/**
 * Adds to each message the provider that actually carried it and its delivery events (the provider's own status word and any failure
 * detail), so the thread can say exactly what happened. Read as the person: row-level security limits it to messages they can already see.
 * When a page has more events than the cap, the newest are kept (they belong to the newest messages, the ones people look at); each
 * message's events are then listed oldest first.
 */
export async function withDeliveryDetail(userId: string, messages: MessageView[]): Promise<DeliveredMessageView[]> {
  const ids = messages.filter((m) => m.direction !== "internal").map((m) => m.id);
  const { providers, events } = await withUser(userId, async (db) => ({
    providers: ids.length ? (await db.query<{ id: string; provider: string | null }>("select id, provider from conversation_messages where id = any($1::uuid[])", [ids])).rows : [],
    events: ids.length
      ? (await db.query<{ message_id: string; status: string; raw_status: string | null; detail: string | null; occurred_at: Date }>(
          "select message_id, status, raw_status, detail, occurred_at from message_delivery_events where message_id = any($1::uuid[]) order by occurred_at desc, id desc limit $2",
          [ids, DELIVERY_EVENTS_LIMIT],
        )).rows
      : [],
  }));
  const providerOf = new Map(providers.map((p) => [p.id, p.provider]));
  const eventsOf = new Map<string, DeliveredMessageView["deliveryEvents"]>();
  // Newest first from the database; walking it backwards lists each message's events oldest first (by occurred_at, then id).
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const list = eventsOf.get(e.message_id) ?? [];
    list.push({ status: e.status, rawStatus: e.raw_status, detail: e.detail, at: new Date(e.occurred_at).toISOString() });
    eventsOf.set(e.message_id, list);
  }
  const label = (p: string | null) => (p ? (TRANSPORT_LABELS[p as TransportName] ?? p) : null);
  return messages.map((m) => ({ ...m, provider: providerOf.get(m.id) ?? null, providerLabel: label(providerOf.get(m.id) ?? null), deliveryEvents: eventsOf.get(m.id) ?? [] }));
}

/** Opening a conversation marks it read for everyone. Only people who can see it can do this. */
export async function markConversationRead(ctx: OrgContext, conversationId: string) {
  const visible = await withUser(ctx.user.id, (db) => db.query("select 1 from conversations where id = $1", [conversationId]));
  if (!visible.rows[0]) throw new AppError("not_found", "Conversation not found.");
  await withSystem((db) => db.query("update conversations set unread_count = 0 where id = $1 and org_id = $2", [conversationId, ctx.org.orgId]));
}

/**
 * A person's own reply. If the AI owns the conversation they take it over first (stopping the AI), then the message goes through
 * the same rule chain as any other. A reply that cannot be sent is refused with the reason instead of being left as a failed row.
 */
export async function sendHumanReply(ctx: OrgContext, conversationId: string, body: string, opts: { templateId?: string | null } = {}) {
  const text = body.trim();
  if (!text || text.length > 5000) throw new AppError("invalid_input", "Write a message of up to 5,000 characters.");
  return withSystem(async (db) => {
    await ensureHumanOwner(db, ctx, conversationId, "Replied from the inbox");
    const result = await queueOutbound(db, { orgId: ctx.org.orgId, conversationId, scope: "human", actor: { kind: "human", userId: ctx.user.id }, body: text, templateId: opts.templateId ?? null });
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "message.queued", targetType: "conversation", targetId: conversationId, result: "success", metadata: { scope: "human" } }, db);
    return result;
  });
}

export async function addInternalNote(ctx: OrgContext, conversationId: string, body: string) {
  if (!ctx.can("inbox.notes")) throw new AppError("forbidden", "Your role can't add notes.");
  const text = body.trim();
  if (!text || text.length > 2000) throw new AppError("invalid_input", "Write a note of up to 2,000 characters.");
  const visible = await withUser(ctx.user.id, (db) => db.query("select 1 from conversations where id = $1", [conversationId]));
  if (!visible.rows[0]) throw new AppError("not_found", "Conversation not found.");
  const { rows } = await withSystem((db) =>
    db.query<{ id: string }>(
      "insert into conversation_messages (org_id, conversation_id, direction, author_kind, author_user_id, body, status) values ($1, $2, 'internal', 'human', $3, $4, 'note') returning id",
      [ctx.org.orgId, conversationId, ctx.user.id, text],
    ),
  );
  return rows[0].id;
}

/**
 * Turns an approved AI draft into queued work. Both the inbox and the Approval Center end up here, and the draft goes through the
 * full rule chain again with that approval, so a pause, opt-out, takeover or lack of credit still stops it.
 */
export async function queueApprovedDraft(db: Queryable, input: { orgId: string; messageId: string; approvalId: string }): Promise<{ status: "succeeded" | "blocked"; detail: string }> {
  const { rows } = await db.query<{ id: string; conversation_id: string; body: string; agent_id: string | null; scope: "reply" | "followup" | "human" | null; status: string; template_id: string | null }>(
    "select id, conversation_id, body, agent_id, scope, status, template_id from conversation_messages where id = $1 and org_id = $2 and direction = 'outbound' and author_kind = 'ai' for update",
    [input.messageId, input.orgId],
  );
  const m = rows[0];
  if (!m) return { status: "blocked", detail: "The draft no longer exists." };
  if (m.status !== "draft") return { status: "blocked", detail: "The draft was already handled, so nothing more was sent." };
  const decision = await evaluateSend(db, { orgId: input.orgId, conversationId: m.conversation_id, scope: m.scope ?? "reply", actor: { kind: "ai", agentId: m.agent_id, approvalId: input.approvalId }, body: m.body, templateId: m.template_id });
  if (!decision.allow) {
    await db.query("update conversation_messages set status = 'blocked', blocked_reason = $2, status_detail = $3, approval_id = $4 where id = $1", [m.id, decision.reason, decision.detail.slice(0, 300), input.approvalId]);
    return { status: "blocked", detail: `Approved, but it cannot be sent right now. ${decision.detail}` };
  }
  try {
    const hold = await reserveCredits(db, { orgId: input.orgId, estimateMicros: Math.max(1, decision.estimateMicros), purpose: `${decision.channel} message`, jobReference: `msg:${m.id}`, ttlSeconds: 6 * 3600 });
    // A person approving it is a decision about the conversation as it is now, so the fence is taken again here (evaluateSend has just passed).
    await db.query(
      `update conversation_messages set status = 'queued', queued_at = now(), approval_id = $2, reservation_id = $3, blocked_reason = null, status_detail = null,
         ownership_fence = (select ownership_version from conversations where id = conversation_messages.conversation_id) where id = $1`,
      [m.id, input.approvalId, hold.id],
    );
  } catch (err) {
    if (err instanceof BillingBlockedError) return { status: "blocked", detail: err.message };
    throw err;
  }
  return { status: "succeeded", detail: "Queued for sending." };
}

/** A person approves an AI draft from the inbox. The approval is recorded in the Approval Center like any other. */
export async function approveDraft(ctx: OrgContext, messageId: string) {
  if (!ctx.can("inbox.reply")) throw new AppError("forbidden", "Your role cannot approve messages to customers.");
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; conversation_id: string; agent_id: string | null; scope: string | null; status: string; approval_id: string | null }>(
      "select id, conversation_id, agent_id, scope, status, approval_id from conversation_messages where id = $1 and org_id = $2 and direction = 'outbound' and author_kind = 'ai' for update",
      [messageId, ctx.org.orgId],
    );
    const m = rows[0];
    if (!m) throw new AppError("not_found", "Draft not found.");
    if (m.status !== "draft") throw new AppError("conflict", "This message is not waiting for approval.");
    const visible = await db.query("select 1 from conversations c where c.id = $1 and c.org_id = $2 and ($3::boolean or c.assigned_user_id = $4 or c.owner_user_id = $4)", [m.conversation_id, ctx.org.orgId, ctx.can("inbox.view_all"), ctx.user.id]);
    if (!visible.rows[0]) throw new AppError("not_found", "Draft not found.");

    let approvalId = m.approval_id;
    let decided = false;
    if (approvalId) {
      // Compare-and-set so a second approver, or the Approval Center, cannot approve the same draft twice.
      const res = await db.query("update approval_requests set status = 'approved', decided_by = $2, decided_at = now(), execution_status = 'running' where id = $1 and org_id = $3 and status = 'pending' and (expires_at is null or expires_at > now())", [approvalId, ctx.user.id, ctx.org.orgId]);
      decided = res.rowCount > 0;
    }
    if (!approvalId || !decided) {
      approvalId = await createApproval(db, { orgId: ctx.org.orgId, agentId: m.agent_id, kind: "follow_up_message", title: "Send AI reply to a customer", action: { messageId: m.id }, targetType: "conversation", targetId: m.conversation_id, reason: "AI prepared a customer message for approval.", expectedEffect: "The message is sent to the customer.", risk: "medium", actorKind: "agent" });
      if (!approvalId) throw new AppError("conflict", "Could not record the approval.");
      await db.query("update approval_requests set status = 'approved', decided_by = $2, decided_at = now(), execution_status = 'running' where id = $1", [approvalId, ctx.user.id]);
    }
    await db.query("insert into approval_events (approval_id, org_id, actor_user_id, actor_kind, event) values ($1, $2, $3, 'user', 'approved')", [approvalId, ctx.org.orgId, ctx.user.id]);
    const outcome = await queueApprovedDraft(db, { orgId: ctx.org.orgId, messageId: m.id, approvalId });
    await db.query("update approval_requests set execution_status = $2, execution_detail = $3, executed_at = case when $2 = 'succeeded' then now() end where id = $1", [approvalId, outcome.status, outcome.detail]);
    if (outcome.status === "blocked") throw new AppError("conflict", outcome.detail);
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "message.draft_approved", targetType: "message", targetId: m.id, approvalId, result: "success" }, db);
    return { messageId: m.id, approvalId };
  });
}

export async function discardDraft(ctx: OrgContext, messageId: string) {
  if (!ctx.can("inbox.reply")) throw new AppError("forbidden", "Your role can't manage drafts.");
  await withSystem(async (db) => {
    const res = await db.query<{ reservation_id: string | null }>(
      "update conversation_messages set status = 'blocked', blocked_reason = 'discarded', status_detail = 'Discarded by a teammate.' where id = $1 and org_id = $2 and author_kind = 'ai' and status = 'draft' returning reservation_id",
      [messageId, ctx.org.orgId],
    );
    if (!res.rowCount) throw new AppError("not_found", "Draft not found.");
    if (res.rows[0].reservation_id) await releaseReservation(db, { orgId: ctx.org.orgId, reservationId: res.rows[0].reservation_id, reason: "Draft discarded" });
  });
}

export interface ConversationStateInput {
  status?: "open" | "closed";
  priority?: "low" | "normal" | "high" | "urgent";
  /** How a resolved conversation ended. Only recorded when resolving. */
  outcome?: ConversationOutcome | null;
  /** Archive (only a resolved conversation) or bring it back. */
  archived?: boolean;
  /** Resolving: the customer's newest message the person had seen. A newer one arrived since, so resolving is refused until they look. */
  seenInboundAt?: string | null;
}

/**
 * Changes a conversation's status, priority or archive state, as a person who can see it and reply. Each change leaves a lifecycle event
 * (which is also what starts "resolved" / "urgent" automations). Resolving refuses two things a person would regret: closing over a customer
 * message they have not seen (the conversation moved since their screen loaded), and closing while a person is still being asked to take over.
 */
export async function setConversationState(ctx: OrgContext, conversationId: string, input: ConversationStateInput) {
  if (!ctx.can("inbox.reply")) throw new AppError("forbidden", "Your role can't change conversations.");
  await assertConversationVisible(ctx, conversationId);
  if (input.outcome != null && !isConversationOutcome(input.outcome)) throw new AppError("invalid_input", "Choose how this ended.");
  await withSystem(async (db) => {
    const { rows } = await db.query<{ status: "open" | "snoozed" | "closed"; priority: string; archived_at: Date | null; last_inbound_at: Date | null }>(
      "select status, priority, archived_at, last_inbound_at from conversations where id = $1 and org_id = $2 for update",
      [conversationId, ctx.org.orgId],
    );
    const cur = rows[0];
    if (!cur) throw new AppError("not_found", "Conversation not found.");
    const actor = { kind: "user", userId: ctx.user.id } as const;
    const closing = input.status === "closed" && cur.status !== "closed";
    const reopening = input.status === "open" && cur.status === "closed";
    if (closing) {
      if (input.seenInboundAt && cur.last_inbound_at && new Date(cur.last_inbound_at).getTime() > new Date(input.seenInboundAt).getTime()) {
        throw new AppError("conflict", "The customer wrote again while you were looking. Read the new message before resolving this.");
      }
      const open = await db.query("select 1 from human_escalations where conversation_id = $1 and status in ('awaiting_owner', 'open')", [conversationId]);
      if (open.rows[0]) throw new AppError("conflict", "A person is still being asked to take over this conversation. Accept it or let a teammate take it before resolving.");
    }
    if (input.archived === true && !(cur.status === "closed" || closing)) throw new AppError("conflict", "Resolve a conversation before archiving it.");
    if (input.status && input.status !== cur.status) {
      await db.query("update conversations set status = $3, resolved_by = case when $3 = 'closed' then $4::uuid else null end, outcome = case when $3 = 'closed' then $5 else null end where id = $1 and org_id = $2", [conversationId, ctx.org.orgId, input.status, ctx.user.id, input.outcome ?? null]);
      await recordConversationEvent(db, { orgId: ctx.org.orgId, conversationId, kind: "status_changed", actor, detail: { from: cur.status, to: input.status, ...(closing && input.outcome ? { outcome: input.outcome } : {}) } });
    } else if (input.status === "closed" && input.outcome !== undefined && cur.status === "closed") {
      await db.query("update conversations set outcome = $3 where id = $1 and org_id = $2", [conversationId, ctx.org.orgId, input.outcome]);
    }
    if (input.priority && input.priority !== cur.priority) {
      await db.query("update conversations set priority = $3 where id = $1 and org_id = $2", [conversationId, ctx.org.orgId, input.priority]);
      await recordConversationEvent(db, { orgId: ctx.org.orgId, conversationId, kind: "priority_changed", actor, detail: { from: cur.priority, to: input.priority } });
    }
    if (input.archived === true && !cur.archived_at) {
      await db.query("update conversations set archived_at = now(), archived_by = $3 where id = $1 and org_id = $2", [conversationId, ctx.org.orgId, ctx.user.id]);
      await recordConversationEvent(db, { orgId: ctx.org.orgId, conversationId, kind: "archived", actor });
    } else if (input.archived === false && cur.archived_at && !reopening) {
      await db.query("update conversations set archived_at = null, archived_by = null where id = $1 and org_id = $2", [conversationId, ctx.org.orgId]);
      await recordConversationEvent(db, { orgId: ctx.org.orgId, conversationId, kind: "unarchived", actor });
    }
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "conversation.state_changed", targetType: "conversation", targetId: conversationId, result: "success", metadata: { status: input.status, priority: input.priority, archived: input.archived, outcome: input.outcome } }, db);
  });
}

/** Marks a conversation unread again for the team (the unread count is shared by everyone who can see it). */
export async function markConversationUnread(ctx: OrgContext, conversationId: string) {
  await assertConversationVisible(ctx, conversationId);
  await withSystem((db) => db.query("update conversations set unread_count = greatest(unread_count, 1) where id = $1 and org_id = $2", [conversationId, ctx.org.orgId]));
}

/**
 * Sends a failed message again, as the person pressing the button. A new message goes through the whole rule chain (consent, opt-out,
 * window, credits) like any other; the failed one stays as it was and is marked as re-sent. If the first attempt was never confirmed the
 * customer may already have it, so the person must say they know (`acknowledgeUnconfirmed`). One failed message can be re-sent once.
 * Only a conversation reply can be re-sent by hand: follow-ups, reminders and program messages follow their own rules.
 */
export async function retryFailedMessage(ctx: OrgContext, messageId: string, opts: { acknowledgeUnconfirmed?: boolean } = {}): Promise<{ messageId: string; conversationId: string }> {
  if (!ctx.can("inbox.reply")) throw new AppError("forbidden", "Your role can't send messages to customers.");
  if (!UUID.test(messageId)) throw new AppError("not_found", "Message not found.");
  const found = await withUser(ctx.user.id, (db) => db.query<{ conversation_id: string }>("select conversation_id from conversation_messages where id = $1 and org_id = $2 and direction = 'outbound'", [messageId, ctx.org.orgId]));
  if (!found.rows[0]) throw new AppError("not_found", "Message not found.");
  const conversationId = found.rows[0].conversation_id;
  await assertConversationVisible(ctx, conversationId);
  return withSystem(async (db) => {
    const { rows } = await db.query<{ status: MessageStatus; body: string; scope: string | null; template_id: string | null; purpose: "service" | "marketing"; failure_kind: "rejected" | "unconfirmed" | null; status_detail: string | null }>(
      "select status, body, scope, template_id, purpose, failure_kind, status_detail from conversation_messages where id = $1 and org_id = $2 for update",
      [messageId, ctx.org.orgId],
    );
    const m = rows[0];
    if (!m) throw new AppError("not_found", "Message not found.");
    if (m.status !== "failed") throw new AppError("conflict", "Only a message that failed can be sent again.");
    if (m.scope !== "reply" && m.scope !== "human") throw new AppError("conflict", "Follow-ups, reminders and program messages are not sent again by hand. They follow their own schedule and limits.");
    const again = await db.query("select 1 from conversation_messages where retry_of = $1", [messageId]);
    if (again.rows[0]) throw new AppError("conflict", "This message was already sent again.");
    const unconfirmed = m.failure_kind === "unconfirmed" || (m.failure_kind === null && unconfirmedOutcome(m.status_detail));
    if (unconfirmed && !opts.acknowledgeUnconfirmed) {
      throw new AppError("conflict", "The first attempt was never confirmed, so the customer may already have this message. Confirm that you want to send it again.");
    }
    // Sending as a person means that person owns the conversation from here (the AI stops), like any reply typed in the inbox.
    await ensureHumanOwner(db, ctx, conversationId, "Sent a failed message again");
    const queued = await queueOutbound(db, { orgId: ctx.org.orgId, conversationId, scope: "human", actor: { kind: "human", userId: ctx.user.id }, body: m.body, templateId: m.template_id, purpose: m.purpose, dedupeKey: `retry:${messageId}` });
    await db.query("update conversation_messages set retry_of = $2 where id = $1", [queued.messageId, messageId]);
    await recordConversationEvent(db, { orgId: ctx.org.orgId, conversationId, kind: "message_retried", actor: { kind: "user", userId: ctx.user.id }, detail: { messageId, unconfirmed } });
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "message.retried", targetType: "message", targetId: messageId, result: "success", metadata: { newMessageId: queued.messageId, unconfirmed } }, db);
    return { messageId: queued.messageId, conversationId };
  });
}

export type BulkAction =
  | { kind: "mark_read" }
  | { kind: "mark_unread" }
  | { kind: "resolve"; outcome?: ConversationOutcome | null }
  | { kind: "reopen" }
  | { kind: "archive" }
  | { kind: "unarchive" }
  | { kind: "priority"; priority: "low" | "normal" | "high" | "urgent" }
  | { kind: "assign"; userId: string | null };

export const BULK_LIMIT = 50;

/**
 * Applies one safe action to several conversations. There is deliberately no bulk send: nothing here can message a customer. Every
 * conversation is handled by the same single-conversation function a person would use, so permissions, visibility, guards and lifecycle
 * events are identical; a conversation that refuses (not visible, escalation open, …) is reported with its reason and the rest carry on.
 */
export async function bulkUpdateConversations(ctx: OrgContext, ids: string[], action: BulkAction): Promise<{ done: number; skipped: Array<{ id: string; reason: string }> }> {
  const unique = [...new Set(ids)];
  if (!unique.length) throw new AppError("invalid_input", "Choose at least one conversation.");
  if (unique.length > BULK_LIMIT) throw new AppError("invalid_input", `Choose at most ${BULK_LIMIT} conversations at once.`);
  if (unique.some((i) => !UUID.test(i))) throw new AppError("invalid_input", "Choose valid conversations.");
  const needed = action.kind === "assign" ? "inbox.assign" : action.kind === "mark_read" || action.kind === "mark_unread" ? "inbox.view" : "inbox.reply";
  if (!ctx.can(needed)) throw new AppError("forbidden", "Your role can't do that to conversations.");
  const out = { done: 0, skipped: [] as Array<{ id: string; reason: string }> };
  for (const id of unique) {
    try {
      switch (action.kind) {
        case "mark_read": await markConversationRead(ctx, id); break;
        case "mark_unread": await markConversationUnread(ctx, id); break;
        case "resolve": await setConversationState(ctx, id, { status: "closed", outcome: action.outcome ?? null }); break;
        case "reopen": await setConversationState(ctx, id, { status: "open" }); break;
        case "archive": await setConversationState(ctx, id, { archived: true }); break;
        case "unarchive": await setConversationState(ctx, id, { archived: false }); break;
        case "priority": await setConversationState(ctx, id, { priority: action.priority }); break;
        case "assign": await assignConversation(ctx, id, action.userId); break;
      }
      out.done += 1;
    } catch (err) {
      out.skipped.push({ id, reason: err instanceof AppError ? err.message : "That didn't work." });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface MessagingSettingsView {
  autoReplyEnabled: boolean;
  replyBusinessHoursOnly: boolean;
  businessHours: BusinessHours;
  followUpPreset: FollowUpPreset;
  followUpCustom: CustomFollowUp | null;
  ownerTimeoutUrgentSeconds: number;
  ownerTimeoutNormalSeconds: number;
  channels: Array<{
    channel: Channel;
    enabled: boolean;
    senderIdentity: string | null;
    verified: boolean;
    registrationStatus: string;
    detail: string | null;
    /** Who carries the channel: GoHighLevel, or iAcquire's own Resend, Twilio or WhatsApp Business connection. */
    provider: TransportName;
    providerLabel: string;
    /** A native channel's last authenticated test passed at this time. */
    testedAt: string | null;
  }>;
  agencyLimits: { maxFollowupAttempts: number; maxFollowupsPer30Days: number; quietHoursStart: string; quietHoursEnd: string; whatsappWindowHours: number; minHoursBetweenFollowups: number };
}

export async function getMessagingSettings(ctx: OrgContext): Promise<MessagingSettingsView> {
  if (!ctx.can("inbox.view")) throw new AppError("forbidden", "You can't view messaging settings.");
  return withUser(ctx.user.id, async (db) => {
    const s = await db.query<{ auto_reply_enabled: boolean; reply_business_hours_only: boolean; business_hours: unknown; followup_preset: FollowUpPreset; followup_custom: CustomFollowUp | null; owner_timeout_urgent_seconds: number; owner_timeout_normal_seconds: number }>(
      "select auto_reply_enabled, reply_business_hours_only, business_hours, followup_preset, followup_custom, owner_timeout_urgent_seconds, owner_timeout_normal_seconds from messaging_settings where org_id = $1",
      [ctx.org.orgId],
    );
    const ch = await db.query<{ channel: Channel; enabled: boolean; sender_identity: string | null; sender_verified_at: Date | null; registration_status: string; detail: string | null; provider: string; capability_tested_at: Date | null }>(
      "select channel, enabled, sender_identity, sender_verified_at, registration_status, detail, provider, capability_tested_at from messaging_channels where org_id = $1",
      [ctx.org.orgId],
    );
    const p = await db.query<{ max_followup_attempts: number; max_followups_per_contact_30d: number; quiet_hours_start: string; quiet_hours_end: string; whatsapp_window_hours: number; min_hours_between_followups: number }>("select * from messaging_policy");
    const row = s.rows[0];
    return {
      autoReplyEnabled: row?.auto_reply_enabled ?? false,
      replyBusinessHoursOnly: row?.reply_business_hours_only ?? false,
      businessHours: validateBusinessHours(row?.business_hours ?? {}) ?? {},
      followUpPreset: row?.followup_preset ?? "balanced",
      followUpCustom: row?.followup_custom ?? null,
      ownerTimeoutUrgentSeconds: row?.owner_timeout_urgent_seconds ?? 120,
      ownerTimeoutNormalSeconds: row?.owner_timeout_normal_seconds ?? 300,
      channels: (["sms", "whatsapp", "email"] as const).map((channel) => {
        const c = ch.rows.find((r) => r.channel === channel);
        const provider: TransportName = c && c.provider in TRANSPORT_LABELS ? (c.provider as TransportName) : "ghl";
        return {
          channel,
          enabled: c?.enabled ?? false,
          senderIdentity: c?.sender_identity ?? null,
          verified: Boolean(c?.sender_verified_at),
          registrationStatus: c?.registration_status ?? "not_started",
          detail: c?.detail ?? null,
          provider,
          providerLabel: TRANSPORT_LABELS[provider],
          testedAt: c?.capability_tested_at ? new Date(c.capability_tested_at).toISOString() : null,
        };
      }),
      agencyLimits: { maxFollowupAttempts: p.rows[0].max_followup_attempts, maxFollowupsPer30Days: p.rows[0].max_followups_per_contact_30d, quietHoursStart: String(p.rows[0].quiet_hours_start).slice(0, 5), quietHoursEnd: String(p.rows[0].quiet_hours_end).slice(0, 5), whatsappWindowHours: p.rows[0].whatsapp_window_hours, minHoursBetweenFollowups: p.rows[0].min_hours_between_followups },
    };
  });
}

export interface MessagingSettingsInput {
  autoReplyEnabled?: boolean;
  replyBusinessHoursOnly?: boolean;
  businessHours?: unknown;
  followUpPreset?: string;
  followUpCustom?: unknown;
  ownerTimeoutUrgentSeconds?: number;
  ownerTimeoutNormalSeconds?: number;
}

/** Clients tune these within the agency's safety limits; the limits themselves cannot be changed here. */
export async function updateMessagingSettings(ctx: OrgContext, input: MessagingSettingsInput) {
  if (!ctx.can("messaging.configure")) throw new AppError("forbidden", "Only owners and managers can change messaging settings.");
  if (input.autoReplyEnabled === true && ctx.role !== "owner") throw new AppError("forbidden", "Only the business owner can switch on automatic replies.");
  const hours = input.businessHours === undefined ? undefined : validateBusinessHours(input.businessHours);
  if (input.businessHours !== undefined && hours === null) throw new AppError("invalid_input", "Business hours look wrong. Use times like 09:00 to 17:00.");
  if (input.followUpPreset !== undefined && !["gentle", "balanced", "persistent", "off", "custom"].includes(input.followUpPreset)) throw new AppError("invalid_input", "Choose a follow-up style.");
  let custom: CustomFollowUp | null | undefined;
  if (input.followUpCustom !== undefined) {
    const c = input.followUpCustom as Partial<CustomFollowUp> | null;
    if (c === null) custom = null;
    else {
      if (!c || !Number.isInteger(c.attempts) || (c.attempts as number) < 1 || (c.attempts as number) > 10 || !Array.isArray(c.daysBetween) || c.daysBetween.length < 1 || c.daysBetween.length > 10 || c.daysBetween.some((d) => !Number.isInteger(d) || d < 1 || d > 30)) throw new AppError("invalid_input", "A custom schedule needs 1 to 10 attempts and 1 to 30 days between them.");
      custom = { attempts: c.attempts as number, daysBetween: c.daysBetween, channel: (["sms", "whatsapp", "email", "same"] as const).includes(c.channel as never) ? (c.channel as CustomFollowUp["channel"]) : "same", businessHoursOnly: c.businessHoursOnly !== false };
    }
  }
  for (const [label, v, lo, hi] of [["urgent", input.ownerTimeoutUrgentSeconds, 30, 3600], ["normal", input.ownerTimeoutNormalSeconds, 30, 7200]] as const) {
    if (v !== undefined && (!Number.isInteger(v) || v < lo || v > hi)) throw new AppError("invalid_input", `The ${label} owner window must be between ${lo} and ${hi} seconds.`);
  }
  await withSystem(async (db) => {
    await db.query("insert into messaging_settings (org_id) values ($1) on conflict do nothing", [ctx.org.orgId]);
    await db.query(
      `update messaging_settings set auto_reply_enabled = coalesce($2, auto_reply_enabled), reply_business_hours_only = coalesce($3, reply_business_hours_only),
         business_hours = coalesce($4::jsonb, business_hours), followup_preset = coalesce($5, followup_preset),
         followup_custom = case when $6::boolean then $7::jsonb else followup_custom end,
         owner_timeout_urgent_seconds = coalesce($8, owner_timeout_urgent_seconds), owner_timeout_normal_seconds = coalesce($9, owner_timeout_normal_seconds), updated_by = $10
       where org_id = $1`,
      [ctx.org.orgId, input.autoReplyEnabled ?? null, input.replyBusinessHoursOnly ?? null, hours ? JSON.stringify(hours) : null, input.followUpPreset ?? null, input.followUpCustom !== undefined, custom ? JSON.stringify(custom) : null, input.ownerTimeoutUrgentSeconds ?? null, input.ownerTimeoutNormalSeconds ?? null, ctx.user.id],
    );
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "messaging.settings_changed", targetType: "messaging_settings", targetId: ctx.org.orgId, result: "success", metadata: { autoReply: input.autoReplyEnabled, preset: input.followUpPreset } }, db);
  });
}

/**
 * The owner or a manager switches a verified channel on or off. An unverified channel cannot be enabled (the database refuses it too).
 * A channel carried by iAcquire's own provider connection (Resend, Twilio, WhatsApp Business) can always be switched off here, but only
 * iAcquire switches it on, after its authenticated test passes (src/server/messaging/channels.ts).
 */
export async function setChannelEnabled(ctx: OrgContext, channel: Channel, enabled: boolean) {
  if (!ctx.can("messaging.configure")) throw new AppError("forbidden", "Only owners and managers can change channels.");
  await withSystem(async (db) => {
    const { rows } = await db.query<{ sender_verified_at: Date | null; registration_status: string; provider: string }>("select sender_verified_at, registration_status, provider from messaging_channels where org_id = $1 and channel = $2", [ctx.org.orgId, channel]);
    const provider = rows[0]?.provider;
    if (enabled && provider && provider !== "ghl") {
      throw new AppError("forbidden", `${provider in TRANSPORT_LABELS ? TRANSPORT_LABELS[provider as TransportName] : "This provider"} is switched on by your iAcquire team after they test the connection. Ask them to switch it on.`);
    }
    if (enabled && !rows[0]?.sender_verified_at) throw new AppError("conflict", "iAcquire has not verified this channel's sender yet.");
    if (enabled && channel !== "email" && !["not_required", "approved"].includes(rows[0].registration_status)) throw new AppError("conflict", "Sender registration for this channel is not approved yet.");
    await db.query("update messaging_channels set enabled = $3 where org_id = $1 and channel = $2", [ctx.org.orgId, channel, enabled]);
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: enabled ? "messaging.channel_enabled" : "messaging.channel_disabled", targetType: "messaging_channel", targetId: channel, result: "success", metadata: { provider: provider ?? "ghl" } }, db);
  });
}

/**
 * Agency step for a GoHighLevel channel: records that a sender (number, WhatsApp number or email domain) has been checked in
 * GoHighLevel. It is an attestation by named agency staff, and it says so; it never claims the provider confirmed anything. A channel
 * carried by a native provider is verified only by that provider's authenticated test (runChannelCapabilityTest), so it is refused here.
 */
export async function attestChannelSender(user: Pick<SessionUser, "id" | "platformRole">, input: { orgId: string; channel: Channel; senderIdentity: string; registrationStatus: "not_required" | "pending" | "approved" | "rejected"; verified: boolean; evidence: string }) {
  if (user.platformRole === "none") throw new AppError("forbidden", "Agency access is required.");
  if (input.evidence.trim().length < 5) throw new AppError("invalid_input", "Record what you checked, for example where you confirmed the sender.");
  await withSystem(async (db) => {
    if (user.platformRole !== "agency_super_admin") {
      const a = await db.query("select 1 from staff_assignments where org_id = $1 and user_id = $2", [input.orgId, user.id]);
      if (!a.rows[0]) throw new AppError("forbidden", "You are not assigned to this client.");
    }
    const existing = await db.query<{ provider: string }>("select provider from messaging_channels where org_id = $1 and channel = $2 for update", [input.orgId, input.channel]);
    const provider = existing.rows[0]?.provider;
    if (provider && provider !== "ghl") {
      throw new AppError("conflict", `This channel sends through ${provider in TRANSPORT_LABELS ? TRANSPORT_LABELS[provider as TransportName] : "a native provider"}. Run its channel test instead; attestation is for GoHighLevel senders.`);
    }
    await db.query("insert into messaging_settings (org_id) values ($1) on conflict do nothing", [input.orgId]);
    await db.query(
      `insert into messaging_channels (org_id, channel, sender_identity, sender_verified_at, registration_status, last_checked_at, detail)
       values ($1, $2, $3, case when $4 then now() end, $5, now(), $6)
       on conflict (org_id, channel) do update set sender_identity = excluded.sender_identity, sender_verified_at = excluded.sender_verified_at,
         registration_status = excluded.registration_status, last_checked_at = now(), detail = excluded.detail,
         enabled = case when excluded.sender_verified_at is null or excluded.registration_status not in ('not_required', 'approved') and $2 <> 'email' then false else messaging_channels.enabled end`,
      [input.orgId, input.channel, input.senderIdentity.trim().slice(0, 200), input.verified, input.registrationStatus, `Attested by agency staff: ${input.evidence.trim().slice(0, 240)}`],
    );
    await recordAudit({ orgId: input.orgId, actorUserId: user.id, actorKind: "agency", action: "messaging.sender_attested", targetType: "messaging_channel", targetId: input.channel, result: "success", metadata: { verified: input.verified, registrationStatus: input.registrationStatus } }, db);
  });
}

