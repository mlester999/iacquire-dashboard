import "server-only";
import crypto from "node:crypto";
import { withSystem, type Queryable } from "@/server/db";
import { consumeRateLimit, type RateLimitRule } from "@/server/security/rate-limit";
import type { OutgoingEmail } from "@/server/email";
import { systemActor } from "@/server/crm/actor";
import { createContactInTx, findByIdentities } from "@/server/crm/contacts";
import { emitEvent } from "@/server/crm/events";
import { notifyOrgRoles } from "@/server/notifications";
import { cancelFollowUps } from "@/server/messaging/followups";
import { getConsent, recordConsent } from "@/server/messaging/contacts";
import { createEscalation } from "@/server/messaging/handoff";
import { detectEscalationSignal } from "@/server/messaging/ingest";
import { isWithinBusinessHours, validateBusinessHours, type BusinessHours } from "@/lib/messaging";
import {
  cleanQualificationAnswers, isSessionToken, qualificationComplete, readLandingVisit, readVisitorDetails, visitorText, VISITOR_LIMITS,
  type QualificationQuestion,
} from "@/lib/webchat/rules";
import type { WidgetSettings } from "@/server/webchat/config";
import { recordChatTouch } from "@/server/attribution/touches";

// ---------------------------------------------------------------------------
// Limits (abuse controls). Counted in Postgres so they hold across server instances. Keys are hashed, never a raw address.
// ---------------------------------------------------------------------------

export const RATE = {
  sessionPerAddress: { name: "webchat:session:ip", limit: 12, windowSeconds: 3600 },
  messagePerSession: { name: "webchat:msg:session", limit: 12, windowSeconds: 60 },
  messagePerAddress: { name: "webchat:msg:ip", limit: 150, windowSeconds: 3600 },
  leadPerSession: { name: "webchat:lead:session", limit: 6, windowSeconds: 3600 },
} as const satisfies Record<string, RateLimitRule>;

export type Refusal = { ok: false; reason: "rate_limited" | "daily_limit" | "message_limit" | "invalid" | "not_found" | "closed"; retryAfterSeconds?: number; message: string };
const refuse = (reason: Refusal["reason"], message: string, retryAfterSeconds?: number): Refusal => ({ ok: false, reason, message, retryAfterSeconds });

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface SessionRow {
  id: string;
  orgId: string;
  surface: "site" | "embed";
  originHost: string;
  contactId: string | null;
  conversationId: string | null;
  visitorName: string | null;
  visitorEmail: string | null;
  visitorPhone: string | null;
  leadCapturedAt: Date | null;
  privacyAckAt: Date | null;
  marketingOptIn: boolean;
  possibleMatchContactId: string | null;
  qualification: Record<string, string>;
  qualificationCompletedAt: Date | null;
  handoffRequestedAt: Date | null;
  status: "active" | "closed";
  messageCount: number;
  timezone: string | null;
  createdAt: Date;
}

type DbSession = {
  id: string; org_id: string; surface: "site" | "embed"; origin_host: string; contact_id: string | null; conversation_id: string | null; visitor_name: string | null; visitor_email: string | null;
  visitor_phone: string | null; lead_captured_at: Date | null; privacy_ack_at: Date | null; marketing_opt_in: boolean; possible_match_contact_id: string | null; qualification: Record<string, string>;
  qualification_completed_at: Date | null; handoff_requested_at: Date | null; status: "active" | "closed"; message_count: number; timezone: string | null; created_at: Date;
};
const SESSION_COLUMNS = `id, org_id, surface, origin_host, contact_id, conversation_id, visitor_name, visitor_email::text as visitor_email, visitor_phone, lead_captured_at, privacy_ack_at,
  marketing_opt_in, possible_match_contact_id, qualification, qualification_completed_at, handoff_requested_at, status, message_count, timezone, created_at`;
const mapSession = (r: DbSession): SessionRow => ({
  id: r.id, orgId: r.org_id, surface: r.surface, originHost: r.origin_host, contactId: r.contact_id, conversationId: r.conversation_id, visitorName: r.visitor_name, visitorEmail: r.visitor_email,
  visitorPhone: r.visitor_phone, leadCapturedAt: r.lead_captured_at, privacyAckAt: r.privacy_ack_at, marketingOptIn: r.marketing_opt_in, possibleMatchContactId: r.possible_match_contact_id,
  qualification: r.qualification ?? {}, qualificationCompletedAt: r.qualification_completed_at, handoffRequestedAt: r.handoff_requested_at, status: r.status, messageCount: r.message_count,
  timezone: r.timezone, createdAt: r.created_at,
});

const hashToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");
const newToken = () => crypto.randomBytes(32).toString("base64url");

/** A valid IANA time zone from the visitor's browser, or null. Used to show booking times in the visitor's own zone. */
export function cleanTimezone(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(raw)) return null;
  try {
    new Intl.DateTimeFormat("en", { timeZone: raw });
    return raw;
  } catch {
    return null;
  }
}

export async function sessionForToken(db: Queryable, orgId: string, token: unknown): Promise<SessionRow | null> {
  if (!isSessionToken(token)) return null;
  const { rows } = await db.query<DbSession>(`select ${SESSION_COLUMNS} from web_chat_sessions where org_id = $1 and token_hash = $2`, [orgId, hashToken(token)]);
  return rows[0] ? mapSession(rows[0]) : null;
}

export interface StartInput {
  widget: WidgetSettings;
  surface: "site" | "embed";
  originHost: string;
  token?: unknown;
  landing?: unknown;
  referrer?: unknown;
  timezone?: unknown;
  /** The keyed hash of the visitor's address (hashClient): used only for limits. */
  addressKey: string;
}

/**
 * Resumes the visitor's session when they hold a valid token for this workspace, or opens a new one. A new session is limited per address and per
 * day for the workspace. The workspace is the widget's, never anything the visitor sent.
 */
export async function startOrResumeSession(input: StartInput): Promise<{ ok: true; token: string; session: SessionRow; resumed: boolean } | Refusal> {
  const orgId = input.widget.orgId;
  const resumed = await withSystem(async (db) => {
    const s = await sessionForToken(db, orgId, input.token);
    if (s && s.status === "active") {
      await db.query("update web_chat_sessions set last_seen_at = now() where id = $1", [s.id]);
      return s;
    }
    return null;
  });
  if (resumed && isSessionToken(input.token)) return { ok: true, token: input.token, session: resumed, resumed: true };

  const rl = await consumeRateLimit(RATE.sessionPerAddress, input.addressKey);
  if (!rl.allowed) return refuse("rate_limited", "Too many chats were started from this connection. Please try again later.", rl.retryAfterSeconds);

  return withSystem(async (db) => {
    const today = await db.query<{ n: string }>("select count(*)::text as n from web_chat_sessions where org_id = $1 and created_at >= date_trunc('day', now())", [orgId]);
    if (Number(today.rows[0].n) >= input.widget.dailySessionLimit) return refuse("daily_limit", "Chat is very busy right now. Please try again later or leave your details through the website.");
    const token = newToken();
    const visit = readLandingVisit(input.landing, input.referrer, input.originHost);
    const { rows } = await db.query<DbSession>(
      `insert into web_chat_sessions (org_id, token_hash, surface, origin_host, landing_path, referrer, attribution, ip_hash, timezone)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning ${SESSION_COLUMNS}`,
      [orgId, hashToken(token), input.surface, input.originHost.slice(0, 253), visit.landingPath, visit.referrer, JSON.stringify(visit.attribution), input.addressKey.slice(0, 64), cleanTimezone(input.timezone)],
    );
    return { ok: true as const, token, session: mapSession(rows[0]), resumed: false };
  });
}

// ---------------------------------------------------------------------------
// The visitor's own messages
// ---------------------------------------------------------------------------

interface ConversationFacts {
  id: string;
  contactId: string;
  ownerKind: "ai" | "human" | "unassigned";
}

/** Whether the business is open now, by the workspace's own hours (no hours set means always open). */
export async function businessOpen(db: Queryable, orgId: string, now: Date): Promise<boolean> {
  const { rows } = await db.query<{ business_hours: unknown; timezone: string }>(
    "select s.business_hours, o.timezone from organizations o left join messaging_settings s on s.org_id = o.id where o.id = $1",
    [orgId],
  );
  const hours = validateBusinessHours(rows[0]?.business_hours ?? {});
  return isWithinBusinessHours(hours as BusinessHours | null, now, rows[0]?.timezone ?? "UTC");
}

/** Creates the visitor's contact and conversation on their first message. The contact is the chat's own: never an existing customer's record. */
async function ensureConversation(db: Queryable, widget: WidgetSettings, s: SessionRow, now: Date): Promise<ConversationFacts> {
  if (s.contactId && s.conversationId) {
    const c = await db.query<{ owner_kind: ConversationFacts["ownerKind"] }>("select owner_kind from conversations where id = $1 and org_id = $2", [s.conversationId, s.orgId]);
    if (c.rows[0]) return { id: s.conversationId, contactId: s.contactId, ownerKind: c.rows[0].owner_kind };
  }
  const actor = systemActor({ id: s.orgId });
  let contactId = s.contactId;
  if (!contactId) {
    const created = await createContactInTx(
      db, actor,
      { displayName: s.visitorName ?? "Website visitor", timezone: s.timezone ?? undefined, source: "Website chat", leadStatus: "new" },
      { via: "website_chat", onDuplicate: "error" },
    );
    contactId = created.id;
  }
  const open = await businessOpen(db, s.orgId, now);
  const aiAvailable = widget.aiEnabled && !(widget.offlineBehavior === "leave_message" && !open);
  const agent = aiAvailable ? await db.query<{ id: string }>("select id from agent_instances where org_id = $1 and role_key = $2 and enabled", [s.orgId, widget.aiRoleKey]) : { rows: [] as Array<{ id: string }> };
  const owner: ConversationFacts["ownerKind"] = agent.rows[0] ? "ai" : "unassigned";
  const conv = await db.query<{ id: string }>(
    `insert into conversations (org_id, contact_id, channel, thread_key, ai_agent_id, owner_kind) values ($1, $2, 'web_chat', $3, $4, $5)
     on conflict (org_id, contact_id, channel, thread_key) do update set updated_at = now() returning id`,
    [s.orgId, contactId, s.id, agent.rows[0]?.id ?? null, owner],
  );
  await db.query("update web_chat_sessions set contact_id = $2, conversation_id = $3 where id = $1", [s.id, contactId, conv.rows[0].id]);
  await emitEvent(db, actor, { type: "webchat.started", entityType: "conversation", entityId: conv.rows[0].id, contactId, byContact: true, payload: { conversationId: conv.rows[0].id, surface: s.surface }, dedupeKey: `webchat.started:${s.id}` });
  await recordChatTouch(db, { orgId: s.orgId, contactId, sessionId: s.id, surface: s.surface, originHost: s.originHost });
  if (owner === "unassigned") {
    await notifyOrgRoles(db, s.orgId, ["owner", "admin"], {
      kind: "web_chat_lead", severity: "info", title: "A website visitor started a chat and nobody is handling it",
      body: "The website assistant is not answering (it is switched off, the business is closed or no AI employee is ready). Open the conversation to take it.",
      link: `/inbox?conversation=${conv.rows[0].id}`, dedupeKey: `webchat-unhandled:${conv.rows[0].id}`,
    });
  }
  return { id: conv.rows[0].id, contactId, ownerKind: owner };
}

export type PostResult =
  | { ok: true; messageId: string; conversationId: string; duplicate: boolean; aiShouldRespond: boolean; handoff: boolean; emails: OutgoingEmail[] }
  | Refusal;

/**
 * Records one message from the visitor. It is safe to retry (the client's message id makes it at-most-once), limited per session and per address,
 * and it creates the visitor's contact and conversation on the first message. An unmistakable request for a person raises a handoff, as on every
 * other channel.
 */
export async function postVisitorMessage(input: { widget: WidgetSettings; session: SessionRow; text: unknown; clientMessageId: string; addressKey: string; now?: Date }): Promise<PostResult> {
  const text = visitorText(input.text, VISITOR_LIMITS.message);
  if (!text) return refuse("invalid", "Write a message first.");
  if (input.session.status !== "active") return refuse("closed", "This chat has ended. Start a new one.");
  if (input.session.messageCount >= input.widget.sessionMessageLimit) return refuse("message_limit", "This chat has reached its message limit. Leave your details and the team will follow up.");
  const bySession = await consumeRateLimit(RATE.messagePerSession, input.session.id);
  if (!bySession.allowed) return refuse("rate_limited", "You are sending messages too quickly. Please wait a moment.", bySession.retryAfterSeconds);
  const byAddress = await consumeRateLimit(RATE.messagePerAddress, input.addressKey);
  if (!byAddress.allowed) return refuse("rate_limited", "Too many messages from this connection. Please try again later.", byAddress.retryAfterSeconds);

  const now = input.now ?? new Date();
  return withSystem(async (db) => {
    // One writer at a time per session: the first message creates the contact and conversation, and a double-click must not create two.
    const locked = await db.query<DbSession>(`select ${SESSION_COLUMNS} from web_chat_sessions where id = $1 and org_id = $2 for update`, [input.session.id, input.widget.orgId]);
    if (!locked.rows[0]) return refuse("not_found", "This chat was not found.");
    const s = mapSession(locked.rows[0]);
    const dedupeKey = `inbound:web_chat:${s.id}:${input.clientMessageId}`;
    const dup = await db.query<{ id: string; conversation_id: string }>("select id, conversation_id from conversation_messages where org_id = $1 and dedupe_key = $2", [s.orgId, dedupeKey]);
    if (dup.rows[0]) return { ok: true as const, messageId: dup.rows[0].id, conversationId: dup.rows[0].conversation_id, duplicate: true, aiShouldRespond: false, handoff: false, emails: [] };

    const conv = await ensureConversation(db, input.widget, s, now);
    const inserted = await db.query<{ id: string }>(
      `insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status, provider, provider_message_id, dedupe_key, created_at)
       values ($1, $2, 'inbound', 'contact', $3, 'received', 'web_chat', $4, $5, $6) returning id`,
      [s.orgId, conv.id, text, `${s.id}:${input.clientMessageId}`, dedupeKey, now],
    );
    const messageId = inserted.rows[0].id;
    await db.query(
      `update conversations set unread_count = unread_count + 1, last_inbound_at = $2, last_message_at = $2, last_message_preview = left($3, 200), status = 'open' where id = $1`,
      [conv.id, now, text],
    );
    await db.query("update web_chat_sessions set message_count = message_count + 1, last_visitor_message_at = $2, last_seen_at = $2 where id = $1", [s.id, now]);
    // Any real message ends a follow-up sequence: the person is engaged.
    await cancelFollowUps(db, { orgId: s.orgId, contactId: conv.contactId, reason: "customer_replied" });
    await emitEvent(db, systemActor({ id: s.orgId }), {
      type: "conversation.message_received", entityType: "conversation", entityId: conv.id, contactId: conv.contactId, byContact: true,
      payload: { conversationId: conv.id, messageId, channel: "web_chat", keyword: null },
      dedupeKey: `conversation.message_received:web_chat:${s.id}:${input.clientMessageId}`.slice(0, 300),
    });

    let handoff = false;
    let emails: OutgoingEmail[] = [];
    const signal = detectEscalationSignal(text);
    if (signal && conv.ownerKind !== "human") {
      const agent = await db.query<{ ai_agent_id: string | null }>("select ai_agent_id from conversations where id = $1", [conv.id]);
      const esc = await createEscalation(db, { orgId: s.orgId, conversationId: conv.id, category: signal.category, summary: signal.summary, sourceMessageId: messageId, agentId: agent.rows[0]?.ai_agent_id ?? null, now });
      handoff = true;
      emails = esc.emails;
      await markHandoff(db, s, esc.escalationId);
    }
    return { ok: true as const, messageId, conversationId: conv.id, duplicate: false, aiShouldRespond: conv.ownerKind === "ai" && !handoff, handoff, emails };
  });
}

/** Records that a person was asked to join, tells the visitor once, and remembers when. */
async function markHandoff(db: Queryable, s: SessionRow, escalationId: string) {
  const { rows } = await db.query<{ conversation_id: string | null }>("update web_chat_sessions set handoff_requested_at = coalesce(handoff_requested_at, now()) where id = $1 returning conversation_id", [s.id]);
  if (rows[0]?.conversation_id) {
    await systemMessageToVisitor(db, s.orgId, rows[0].conversation_id, "I've asked a team member to join this chat. If you close the page, leave your details below so they can reach you.", `webchat:handoff:${escalationId}`);
  }
}

/** A message from the system to the visitor (shown in the chat, labelled as the system, never as a person). At most once per key. */
export async function systemMessageToVisitor(db: Queryable, orgId: string, conversationId: string, body: string, dedupeKey: string): Promise<void> {
  // Stamped after the conversation's latest message, whatever the transaction's own clock says (a transaction's now() is its start time, which can be
  // earlier than the message this one answers), so the visitor always reads it in the right place.
  await db.query(
    `insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status, provider, dedupe_key, scope, purpose, sent_at, created_at)
     values ($1, $2, 'outbound', 'system', $3, 'sent', 'web_chat', $4, 'reply', 'service', now(),
       greatest(clock_timestamp(), coalesce((select max(created_at) from conversation_messages where conversation_id = $2), clock_timestamp()) + interval '1 millisecond'))
     on conflict (org_id, dedupe_key) do nothing`,
    [orgId, conversationId, body.slice(0, 1000), dedupeKey.slice(0, 200)],
  );
  await db.query("update conversations set last_outbound_at = now(), last_message_at = now(), last_message_preview = left($2, 200) where id = $1", [conversationId, body]);
}

/** The visitor asks for a person. Same path as an unmistakable request in a message. */
export async function requestHandoff(input: { widget: WidgetSettings; session: SessionRow; now?: Date }): Promise<{ ok: true; emails: OutgoingEmail[] } | Refusal> {
  if (!input.session.conversationId || !input.session.contactId) return refuse("invalid", "Send a message first so the team knows what you need.");
  return withSystem(async (db) => {
    const conv = await db.query<{ owner_kind: string; ai_agent_id: string | null }>("select owner_kind, ai_agent_id from conversations where id = $1 and org_id = $2", [input.session.conversationId, input.session.orgId]);
    if (!conv.rows[0]) return refuse("not_found", "This chat was not found.");
    if (conv.rows[0].owner_kind === "human") return { ok: true as const, emails: [] };
    const esc = await createEscalation(db, {
      orgId: input.session.orgId, conversationId: input.session.conversationId as string, category: "human_requested", summary: "The website visitor asked to speak with a person.",
      agentId: conv.rows[0].ai_agent_id, now: input.now,
    });
    await markHandoff(db, input.session, esc.escalationId);
    return { ok: true as const, emails: esc.emails };
  });
}

// ---------------------------------------------------------------------------
// The lead form
// ---------------------------------------------------------------------------

export type LeadResult = { ok: true; contactId: string; possibleMatch: boolean; qualificationCompleted: boolean } | Refusal;

const LEAD_NOTICE = "A team member may contact you about your enquiry using the details you gave.";

/**
 * Saves the details a visitor typed into the lead form. They are stored as unverified. They are put on the chat's own contact when no other live contact
 * holds them; when one does, nothing is attached or merged and the session only remembers that a person should look (the visitor could have typed
 * anyone's address). Consent to be contacted at the details given is recorded with the wording shown; marketing consent only with the box ticked.
 */
export async function captureLead(input: {
  widget: WidgetSettings; session: SessionRow; details: { name?: unknown; email?: unknown; phone?: unknown }; answers?: unknown; privacyAck: boolean; marketingOptIn?: boolean; now?: Date;
}): Promise<LeadResult> {
  if (input.session.status !== "active") return refuse("closed", "This chat has ended. Start a new one.");
  if (!input.privacyAck) return refuse("invalid", "Please confirm the privacy notice before sending your details.");
  const limited = await consumeRateLimit(RATE.leadPerSession, input.session.id);
  if (!limited.allowed) return refuse("rate_limited", "Please wait before sending your details again.", limited.retryAfterSeconds);
  const read = readVisitorDetails(input.details);
  if (!read.ok) return refuse("invalid", read.error);
  const { name, email, phone } = read.details;
  const questions: QualificationQuestion[] = input.widget.qualificationQuestions;
  const answers = cleanQualificationAnswers(questions, input.answers);
  for (const q of questions) if (q.required && !answers[q.key]) return refuse("invalid", `Please answer: ${q.label}`);

  const now = input.now ?? new Date();
  return withSystem(async (db) => {
    const locked = await db.query<DbSession>(`select ${SESSION_COLUMNS} from web_chat_sessions where id = $1 and org_id = $2 for update`, [input.session.id, input.widget.orgId]);
    if (!locked.rows[0]) return refuse("not_found", "This chat was not found.");
    let s = mapSession(locked.rows[0]);
    const actor = systemActor({ id: s.orgId });
    // A lead can arrive before any message (the form comes first): the contact and conversation are created now.
    const conv = await ensureConversation(db, input.widget, { ...s, visitorName: name ?? s.visitorName }, now);
    s = { ...s, contactId: conv.contactId, conversationId: conv.id };

    const holders = await findByIdentities(db, s.orgId, email ? [email] : [], phone ? [phone] : [], conv.contactId);
    const emailTaken = holders.some((h) => h.kind === "email");
    const phoneTaken = holders.some((h) => h.kind === "phone");
    const possibleMatch = holders[0]?.contactId ?? null;

    const first = !s.leadCapturedAt;
    const merged = { ...s.qualification, ...answers };
    const completed = qualificationComplete(questions, merged);
    await db.query(
      `update web_chat_sessions set visitor_name = coalesce($2, visitor_name), visitor_email = coalesce($3::citext, visitor_email), visitor_phone = coalesce($4, visitor_phone),
         lead_captured_at = coalesce(lead_captured_at, $5), privacy_ack_at = coalesce(privacy_ack_at, $5), marketing_opt_in = $6, possible_match_contact_id = coalesce($7, possible_match_contact_id),
         qualification = $8, qualification_completed_at = case when $9 then coalesce(qualification_completed_at, $5) else qualification_completed_at end, last_seen_at = $5
       where id = $1`,
      [s.id, name, email, phone, now, input.widget.offerMarketingOptIn && input.marketingOptIn === true, possibleMatch, JSON.stringify(merged), completed],
    );

    // The chat's own contact receives what was typed, as unverified identities, unless another live contact already holds the address.
    if (name) {
      const [firstName, ...rest] = name.split(/\s+/);
      await db.query("update contacts set display_name = $3, first_name = $4, last_name = $5, version = version + 1 where id = $2 and org_id = $1", [s.orgId, conv.contactId, name, firstName.slice(0, 100), rest.join(" ").slice(0, 100) || null]);
    }
    if (email && !emailTaken) {
      await db.query("insert into contact_identities (org_id, contact_id, kind, value, verified) values ($1, $2, 'email', $3, false) on conflict do nothing", [s.orgId, conv.contactId, email]);
      await db.query("update contacts set email = $3, version = version + 1 where id = $2 and org_id = $1 and email is null", [s.orgId, conv.contactId, email]);
    }
    if (phone && !phoneTaken) {
      await db.query("insert into contact_identities (org_id, contact_id, kind, value, verified) values ($1, $2, 'phone', $3, false) on conflict do nothing", [s.orgId, conv.contactId, phone]);
      await db.query("update contacts set phone = $3, version = version + 1 where id = $2 and org_id = $1 and phone is null", [s.orgId, conv.contactId, phone]);
    }

    // Consent to be contacted at the details given, with the wording the visitor saw. Only for an address that is now on this contact.
    const evidence = `${LEAD_NOTICE} Website chat form on ${s.originHost}.`;
    const channels: Array<"email" | "sms"> = [...(email && !emailTaken ? ["email" as const] : []), ...(phone && !phoneTaken ? ["sms" as const] : [])];
    for (const channel of channels) {
      if ((await getConsent(db, s.orgId, conv.contactId, channel, "service")) !== "granted") {
        await recordConsent(db, { orgId: s.orgId, contactId: conv.contactId, channel, purpose: "service", status: "granted", source: "website_chat_form", evidence });
      }
      if (input.widget.offerMarketingOptIn && input.marketingOptIn === true && (await getConsent(db, s.orgId, conv.contactId, channel, "marketing")) !== "granted") {
        await recordConsent(db, { orgId: s.orgId, contactId: conv.contactId, channel, purpose: "marketing", status: "granted", source: "website_chat_form", evidence: `${evidence} The visitor ticked the box to receive offers.` });
      }
    }

    if (first) {
      await emitEvent(db, actor, {
        type: "webchat.lead_captured", entityType: "contact", entityId: conv.contactId, contactId: conv.contactId, byContact: true,
        payload: { conversationId: conv.id, sessionId: s.id, hasEmail: Boolean(email && !emailTaken), hasPhone: Boolean(phone && !phoneTaken), possibleMatch: Boolean(possibleMatch) },
        dedupeKey: `webchat.lead_captured:${s.id}`,
      });
      await notifyOrgRoles(db, s.orgId, ["owner", "admin"], {
        kind: "web_chat_lead", severity: "info", title: "A website visitor shared their details",
        body: possibleMatch ? "They may already be in your CRM. Open the conversation to check before you reply." : "Open the conversation to follow up.",
        link: `/inbox?conversation=${conv.id}`, dedupeKey: `webchat-lead:${s.id}`,
      });
    }
    if (completed && !s.qualificationCompletedAt) {
      await emitEvent(db, actor, {
        type: "webchat.qualification_completed", entityType: "contact", entityId: conv.contactId, contactId: conv.contactId, byContact: true,
        payload: { conversationId: conv.id, sessionId: s.id, answers: Object.keys(merged) }, dedupeKey: `webchat.qualification_completed:${s.id}`,
      });
    }
    return { ok: true as const, contactId: conv.contactId, possibleMatch: Boolean(possibleMatch), qualificationCompleted: completed };
  });
}

// ---------------------------------------------------------------------------
// What the visitor sees
// ---------------------------------------------------------------------------

export interface VisibleMessage {
  id: string;
  role: "visitor" | "assistant" | "team" | "system";
  text: string;
  at: string;
}

export interface VisitorView {
  messages: VisibleMessage[];
  /** assistant: the AI is answering. waiting: a person was asked and has not joined. team: a person owns the chat. closed: the team marked it resolved. */
  mode: "assistant" | "waiting" | "team";
  leadCaptured: boolean;
  qualificationCompleted: boolean;
}

/**
 * The conversation as the visitor may see it: their own messages, replies that were really sent, and the system's notices. Internal notes, drafts,
 * blocked replies and anything staff wrote privately never appear. Fetching a reply is the delivery event: a "sent" reply becomes "delivered" (and
 * "read" when the widget reports the window is open and visible).
 */
export async function visitorView(session: SessionRow, opts: { seen?: boolean } = {}): Promise<VisitorView> {
  return withSystem(async (db) => {
    if (!session.conversationId) return { messages: [], mode: "assistant" as const, leadCaptured: Boolean(session.leadCapturedAt), qualificationCompleted: Boolean(session.qualificationCompletedAt) };
    const { rows } = await db.query<{ id: string; direction: string; author_kind: string; body: string; status: string; created_at: Date }>(
      `select id, direction, author_kind, body, status, created_at from conversation_messages
       where conversation_id = $1 and org_id = $2 and direction in ('inbound', 'outbound') and (direction = 'inbound' or status in ('sent', 'delivered', 'read'))
       order by created_at, id limit 300`,
      [session.conversationId, session.orgId],
    );
    const undelivered = rows.filter((r) => r.direction === "outbound" && (r.status === "sent" || (opts.seen && r.status === "delivered"))).map((r) => r.id);
    if (undelivered.length) {
      await db.query(
        `update conversation_messages set status = case when $3 then 'read' else 'delivered' end, delivered_at = coalesce(delivered_at, now())
         where id = any($1::uuid[]) and org_id = $2 and direction = 'outbound' and status in ('sent', 'delivered')`,
        [undelivered, session.orgId, Boolean(opts.seen)],
      );
    }
    const conv = await db.query<{ owner_kind: string; ai_paused_at: Date | null; waiting: boolean }>(
      `select c.owner_kind, c.ai_paused_at, exists (select 1 from human_escalations e where e.conversation_id = c.id and e.status in ('awaiting_owner', 'open')) as waiting
       from conversations c where c.id = $1 and c.org_id = $2`,
      [session.conversationId, session.orgId],
    );
    const c = conv.rows[0];
    const mode: VisitorView["mode"] = c?.owner_kind === "human" ? "team" : c?.waiting || c?.owner_kind === "unassigned" || c?.ai_paused_at ? "waiting" : "assistant";
    const role = (r: { direction: string; author_kind: string }): VisibleMessage["role"] => (r.direction === "inbound" ? "visitor" : r.author_kind === "ai" ? "assistant" : r.author_kind === "human" ? "team" : "system");
    const fresh = await db.query<{ lead: Date | null; qual: Date | null }>("select lead_captured_at as lead, qualification_completed_at as qual from web_chat_sessions where id = $1", [session.id]);
    return {
      messages: rows.map((r) => ({ id: r.id, role: role(r), text: r.body, at: new Date(r.created_at).toISOString() })),
      mode,
      leadCaptured: Boolean(fresh.rows[0]?.lead),
      qualificationCompleted: Boolean(fresh.rows[0]?.qual),
    };
  });
}
