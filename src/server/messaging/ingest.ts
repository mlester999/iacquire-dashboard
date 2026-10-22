import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { sendEmail, type OutgoingEmail } from "@/server/email";
import { cancelFollowUps } from "@/server/messaging/followups";
import { getConsent, KEYWORD_LIFTABLE_SUPPRESSIONS, liftSuppression, recordConsent, resolveContact, suppressAddress } from "@/server/messaging/contacts";
import { applyDeliveryEvent, cancelPendingAiMessages } from "@/server/messaging/send";
import { createEscalation } from "@/server/messaging/handoff";
import { inboxEnabledFor } from "@/server/messaging/inbox-rollout";
import { fetchGhlContact, parseGhlMessageEvent, verifyGhlWebhook, type GhlContactInfo } from "@/server/messaging/provider";
import { applyAppointmentEvent } from "@/server/appointments/ledger";
import { parseGhlAppointmentEvent } from "@/lib/appointments";
import { detectOptKeyword, normalizeEmail, normalizePhone, type Channel } from "@/lib/messaging";
import { emitEvent } from "@/server/crm/events";
import { notifyOrgRoles } from "@/server/notifications";
import { systemActor } from "@/server/crm/actor";
import type { EscalationCategory } from "@/lib/escalation";

/**
 * A deliberately blunt safety net. It only catches unmistakable requests, so a customer who plainly asks for a person is never
 * left talking to automation even if the AI is paused or misses it. Judgment calls stay with the AI and with people.
 */
export function detectEscalationSignal(text: string): { category: EscalationCategory; summary: string } | null {
  const t = text.toLowerCase();
  if (/\b(speak|talk|chat)\s+(to|with)\s+(a|an|the|your)?\s*(human|person|real person|agent|representative|rep|manager|owner|someone)\b|\b(real|live)\s+(person|human|agent)\b|\bhuman\b.*\bplease\b|\bnot a (bot|robot)\b/.test(t)) {
    return { category: "human_requested", summary: "The customer asked to speak with a person." };
  }
  if (/\b(refund|money back|chargeback|dispute the charge)\b/.test(t)) return { category: "refund_concern", summary: "The customer mentioned a refund or chargeback." };
  if (/\b(complain|complaint|unacceptable|terrible service|worst (service|experience)|lawyer|sue you|report you)\b/.test(t)) return { category: "complaint", summary: "The customer raised a complaint." };
  if (/\b(call me|give me a call|phone me|ring me|can we (talk|speak) on the phone)\b/.test(t)) return { category: "phone_consultation", summary: "The customer asked for a phone call." };
  return null;
}

export interface InboundInput {
  /**
   * The workspace. The GoHighLevel webhook knows it from its location mapping, and a native webhook that already located its tenant may
   * pass it. Without it, the workspace is found from the channel the message arrived on: the provider's sender id (senderId) or, for
   * email, the receiving address (toAddress). A message that matches no workspace is ignored.
   */
  orgId?: string;
  provider: string;
  channel: Channel;
  /** The customer's address, already normalized: E.164 for phone channels, lower-case for email. */
  address: string;
  /** Our side: the provider's id for the sender it reached (Twilio number or Messaging Service SID, Meta phone_number_id). */
  senderId?: string | null;
  /** Our side, for email: the address the customer wrote to. */
  toAddress?: string | null;
  name?: string;
  body: string;
  providerMessageId: string;
  subject?: string | null;
  /** Email: this message's own Message-ID, kept so a reply can answer it (In-Reply-To, References). */
  threadRef?: string | null;
  /** Email: the Message-ID this message answers, and the earlier ones in its thread. They find the conversation it belongs to. */
  inReplyTo?: string | null;
  references?: string[];
  /** What the customer attached, described only: attachments are not stored, and the inbox says so. */
  attachments?: Array<{ filename?: string | null; contentType?: string | null }>;
  receivedAt?: Date;
  threadKey?: string;
  /**
   * Whether the sender's address is proven. Phone channels are (the carrier or Meta delivered it from that number), and so is GoHighLevel's
   * own inbound, so it defaults to true. An inbound email is only proven when the receiving mail server authenticated its From domain
   * (the Resend handler sets this from DMARC/DKIM). An unproven message is recorded, but it never changes consent or suppressions through
   * a keyword, never counts as the customer asking to be contacted, and never gets an automatic reply.
   */
  senderVerified?: boolean;
  /** GoHighLevel only: its contact and conversation ids. */
  ghlContactId?: string | null;
  providerConversationId?: string | null;
}

export interface IngestResult {
  status: "created" | "duplicate";
  messageId: string;
  conversationId: string;
  contactId: string;
  optOut: "stop" | "start" | null;
  escalationId: string | null;
  /** True when the conversation is AI-owned and nothing blocks an automatic reply being prepared. */
  aiShouldRespond: boolean;
  emails: OutgoingEmail[];
}

/** A message that reached no workspace of ours (an unknown sender id or receiving address). Nothing was recorded. */
export interface IngestIgnored {
  status: "ignored";
  reason: "unknown_channel";
  detail: string;
  messageId?: undefined;
  conversationId?: undefined;
  contactId?: undefined;
  optOut: null;
  escalationId: null;
  aiShouldRespond: false;
  emails: OutgoingEmail[];
}

/** A workspace's channel as a native provider's webhook sees it. Never carries a secret. */
export interface ChannelMatch {
  orgId: string;
  channel: Channel;
  provider: string;
  senderId: string | null;
  senderIdentity: string | null;
  accountId: string | null;
  credentialId: string | null;
  inboundAddress: string | null;
  enabled: boolean;
}

type ChannelMatchRow = {
  org_id: string;
  channel: Channel;
  provider: string;
  provider_sender_id: string | null;
  sender_identity: string | null;
  provider_account_id: string | null;
  credential_id: string | null;
  inbound_address: string | null;
  enabled: boolean;
};
const CHANNEL_MATCH_COLUMNS = "org_id, channel, provider, provider_sender_id, sender_identity, provider_account_id, credential_id, inbound_address::text as inbound_address, enabled";
const toMatch = (r: ChannelMatchRow | undefined): ChannelMatch | null =>
  r
    ? { orgId: r.org_id, channel: r.channel, provider: r.provider, senderId: r.provider_sender_id, senderIdentity: r.sender_identity, accountId: r.provider_account_id, credentialId: r.credential_id, inboundAddress: r.inbound_address, enabled: r.enabled }
    : null;

/**
 * The workspace channel a native provider's sender belongs to: the role ghl_location_mappings plays for GoHighLevel. The pair
 * (provider, provider_sender_id) is unique, so at most one workspace matches. GoHighLevel never matches here.
 */
export async function resolveChannelByProviderSender(db: Queryable, provider: string, senderId: string): Promise<ChannelMatch | null> {
  const id = senderId.trim();
  if (!id || id.length > 200 || provider === "ghl") return null;
  const { rows } = await db.query<ChannelMatchRow>(`select ${CHANNEL_MATCH_COLUMNS} from messaging_channels where provider = $1 and provider_sender_id = $2`, [provider, id]);
  return toMatch(rows[0]);
}

/** The workspace channel that receives email at this address (messaging_channels.inbound_address is unique, case-insensitive). */
export async function resolveChannelByInboundAddress(db: Queryable, address: string): Promise<ChannelMatch | null> {
  const normalized = normalizeEmail(address);
  if (!normalized) return null;
  const { rows } = await db.query<ChannelMatchRow>(`select ${CHANNEL_MATCH_COLUMNS} from messaging_channels where inbound_address = $1::citext`, [normalized]);
  return toMatch(rows[0]);
}

/** A Message-ID as it appears in In-Reply-To and References: one <id@domain>. */
const MESSAGE_ID = /^<[^<>\s@]{1,400}@[^<>\s]{1,400}>$/;
const messageIds = (values: Array<string | null | undefined>) => [...new Set(values.map((v) => v?.trim() ?? "").filter((v) => v.length <= 998 && MESSAGE_ID.test(v)))].slice(-50);

/**
 * The email conversation a reply belongs to: the one holding a Message-ID it answers. Only a conversation with this same contact counts,
 * so a forwarded or forged header can never put a message into someone else's conversation.
 */
async function threadedConversation(db: Queryable, orgId: string, contactId: string, refs: string[]): Promise<string | null> {
  if (!refs.length) return null;
  const { rows } = await db.query<{ conversation_id: string }>(
    `select m.conversation_id from conversation_messages m join conversations c on c.id = m.conversation_id
     where m.org_id = $1 and m.provider_thread_ref = any($2::text[]) and c.contact_id = $3 and c.channel = 'email' order by m.created_at desc limit 1`,
    [orgId, refs, contactId],
  );
  return rows[0]?.conversation_id ?? null;
}

function withAttachmentNote(body: string, attachments: InboundInput["attachments"]): string {
  const n = attachments?.length ?? 0;
  if (!n) return body;
  const note = `[${n} attachment${n === 1 ? "" : "s"} received. Attachments aren't shown in the inbox yet.]`;
  return body.trim() ? `${body.trim()}\n\n${note}` : note;
}

const ignored = (detail: string): IngestIgnored => ({ status: "ignored", reason: "unknown_channel", detail, optOut: null, escalationId: null, aiShouldRespond: false, emails: [] });

type ConvRow = { id: string; owner_kind: "ai" | "human" | "unassigned"; ai_agent_id: string | null };

/**
 * Records one inbound customer message. It is idempotent on the provider's message id, matches the contact only by an exact
 * identifier, honours STOP and START, stops follow-ups because the customer replied, and raises an escalation for unmistakable requests.
 * It is the same for every provider; only how the workspace is found differs (see InboundInput.orgId).
 */
export async function ingestInbound(db: Queryable, input: InboundInput & { orgId: string }): Promise<IngestResult>;
export async function ingestInbound(db: Queryable, input: InboundInput): Promise<IngestResult | IngestIgnored>;
export async function ingestInbound(db: Queryable, input: InboundInput): Promise<IngestResult | IngestIgnored> {
  let orgId = input.orgId;
  if (!orgId) {
    const match = input.senderId
      ? await resolveChannelByProviderSender(db, input.provider, input.senderId)
      : input.toAddress && input.channel === "email"
        ? await resolveChannelByInboundAddress(db, input.toAddress)
        : null;
    // The channel must be this provider's and this channel's: a sender id or address set up for something else is not a match.
    if (!match || match.provider !== input.provider || match.channel !== input.channel) return ignored("No workspace receives messages through this sender.");
    orgId = match.orgId;
  }

  const dedupeKey = `inbound:${input.provider}:${input.providerMessageId}`;
  const existing = await db.query<{ id: string; conversation_id: string }>("select id, conversation_id from conversation_messages where org_id = $1 and dedupe_key = $2", [orgId, dedupeKey]);
  if (existing.rows[0]) {
    const c = await db.query<{ contact_id: string }>("select contact_id from conversations where id = $1", [existing.rows[0].conversation_id]);
    return { status: "duplicate", messageId: existing.rows[0].id, conversationId: existing.rows[0].conversation_id, contactId: c.rows[0]?.contact_id ?? "", optOut: null, escalationId: null, aiShouldRespond: false, emails: [] };
  }
  const when = input.receivedAt ?? new Date();
  const body = withAttachmentNote(input.body, input.attachments);
  const { contactId } = await resolveContact(db, { orgId, channel: input.channel, address: input.address, name: input.name, ghlContactId: input.ghlContactId, verifiedVia: "provider_inbound" });
  if (input.ghlContactId) {
    // Link the CRM record unless another contact already holds it (that would be a duplicate for a person to merge).
    await db.query(
      "update contacts set ghl_contact_id = $3 where org_id = $1 and id = $2 and ghl_contact_id is null and not exists (select 1 from contacts x where x.org_id = $1 and x.ghl_contact_id = $3 and x.deleted_at is null)",
      [orgId, contactId, input.ghlContactId],
    );
  }

  let conv: ConvRow | undefined;
  if (input.channel === "email") {
    // An email reply joins the conversation that holds the Message-ID it answers, whichever thread that is.
    const threaded = await threadedConversation(db, orgId, contactId, messageIds([...(input.references ?? []), input.inReplyTo]));
    if (threaded) conv = (await db.query<ConvRow>("select id, owner_kind, ai_agent_id from conversations where id = $1", [threaded])).rows[0];
  }
  const thread = (input.threadKey ?? "main").slice(0, 120);
  conv ??= (await db.query<ConvRow>("select id, owner_kind, ai_agent_id from conversations where org_id = $1 and contact_id = $2 and channel = $3 and thread_key = $4", [orgId, contactId, input.channel, thread])).rows[0];
  if (!conv) {
    const agent = await db.query<{ id: string }>("select id from agent_instances where org_id = $1 and role_key = 'sales_assistant' and enabled", [orgId]);
    const created = await db.query<ConvRow>(
      `insert into conversations (org_id, contact_id, channel, thread_key, subject, ai_agent_id, owner_kind, ghl_conversation_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id, owner_kind, ai_agent_id`,
      [orgId, contactId, input.channel, thread, input.subject?.slice(0, 300) ?? null, agent.rows[0]?.id ?? null, agent.rows[0] ? "ai" : "unassigned", input.providerConversationId ?? null],
    );
    conv = created.rows[0];
    // Nobody (no AI employee, no person) is set to handle this new conversation: the owners and managers hear about it once, without its content.
    // (Only for a workspace that has the new inbox: the notice is the new inbox's, and would point at a screen the workspace is not on. The conversation itself
    // is created and kept either way.)
    if (conv.owner_kind === "unassigned" && (await inboxEnabledFor(orgId, db))) {
      await notifyOrgRoles(db, orgId, ["owner", "admin"], {
        kind: "conversation_new_inquiry",
        severity: "info",
        title: "A new inquiry has nobody handling it",
        body: "No AI employee is switched on for this workspace. Open the conversation to take it or assign it.",
        link: `/inbox?conversation=${conv.id}`,
        dedupeKey: `inquiry:${conv.id}`,
      });
    }
  }

  // An inbound email keeps its own Message-ID, so the reply can carry In-Reply-To and References and stay in the customer's thread.
  const ownRef = input.channel === "email" ? (messageIds([input.threadRef])[0] ?? null) : null;
  const message = await db.query<{ id: string }>(
    `insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status, provider, provider_message_id, dedupe_key, provider_thread_ref, created_at)
     values ($1, $2, 'inbound', 'contact', $3, 'received', $4, $5, $6, $7, $8) returning id`,
    [orgId, conv.id, body.slice(0, 5000), input.provider, input.providerMessageId, dedupeKey, ownRef, when],
  );
  await db.query(
    `update conversations set unread_count = unread_count + 1, last_inbound_at = $2, last_message_at = $2, last_message_preview = left($3, 200), status = 'open',
       ghl_conversation_id = coalesce(ghl_conversation_id, $4), subject = coalesce(subject, $5) where id = $1`,
    [conv.id, when, body, input.providerConversationId ?? null, input.subject?.slice(0, 300) ?? null],
  );

  // Only a proven sender's message changes consent, suppressions or gets an automatic reply (see InboundInput.senderVerified).
  const senderVerified = input.senderVerified !== false;
  // A customer who writes to us is asking for service messages on that channel unless they have already opted out.
  if (senderVerified && (await getConsent(db, orgId, contactId, input.channel, "service")) === "unknown") {
    await recordConsent(db, { orgId, contactId, channel: input.channel, purpose: "service", status: "granted", source: "inbound_inquiry", evidence: "The customer contacted the business on this channel." });
  }

  const keyword = senderVerified ? detectOptKeyword(input.body) : null;
  // The CRM event outbox: workflows can start from a customer's message. Only a proven sender's message counts (an unverified email could
  // be forged to set automations off), and the key is the provider's message id, so a redelivered webhook records nothing new.
  if (senderVerified) {
    await emitEvent(db, systemActor({ id: orgId }), {
      type: "conversation.message_received", entityType: "conversation", entityId: conv.id, contactId, byContact: true,
      payload: { conversationId: conv.id, messageId: message.rows[0].id, channel: input.channel, keyword: keyword ?? null },
      dedupeKey: `conversation.message_received:${input.provider}:${input.providerMessageId}`.slice(0, 300),
    });
  }
  if (keyword === "stop") {
    for (const purpose of ["service", "marketing"] as const) {
      await recordConsent(db, { orgId, contactId, channel: input.channel, purpose, status: "revoked", source: "stop_keyword", evidence: "Customer replied with an opt-out keyword." });
    }
    await suppressAddress(db, { orgId, channel: input.channel, address: input.address, reason: "opt_out", source: "stop_keyword" });
    await cancelFollowUps(db, { orgId, contactId, reason: "customer_opted_out" });
    await cancelPendingAiMessages(db, orgId, conv.id, "suppressed");
    return { status: "created", messageId: message.rows[0].id, conversationId: conv.id, contactId, optOut: "stop", escalationId: null, aiShouldRespond: false, emails: [] };
  }
  if (keyword === "start") {
    await liftSuppression(db, { orgId, channel: input.channel, address: input.address, reasons: KEYWORD_LIFTABLE_SUPPRESSIONS });
    await recordConsent(db, { orgId, contactId, channel: input.channel, purpose: "service", status: "granted", source: "start_keyword", evidence: "Customer replied with an opt-in keyword." });
    return { status: "created", messageId: message.rows[0].id, conversationId: conv.id, contactId, optOut: "start", escalationId: null, aiShouldRespond: false, emails: [] };
  }

  // Any real reply ends the follow-up sequence: the customer is engaged, so a scheduled nudge would be wrong.
  await cancelFollowUps(db, { orgId, contactId, reason: "customer_replied" });

  let escalationId: string | null = null;
  let emails: OutgoingEmail[] = [];
  const signal = detectEscalationSignal(input.body);
  if (signal && conv.owner_kind !== "human") {
    // The owner's priority window runs from when we raise the escalation, not from the customer's (possibly delayed) message time.
    const esc = await createEscalation(db, { orgId, conversationId: conv.id, category: signal.category, summary: signal.summary, sourceMessageId: message.rows[0].id, agentId: conv.ai_agent_id });
    escalationId = esc.escalationId;
    emails = esc.emails;
  }
  const aiShouldRespond = senderVerified && conv.owner_kind === "ai" && !escalationId;
  return { status: "created", messageId: message.rows[0].id, conversationId: conv.id, contactId, optOut: null, escalationId, aiShouldRespond, emails };
}

// ---------------------------------------------------------------------------
// GoHighLevel webhook
// ---------------------------------------------------------------------------

export interface WebhookOutcome {
  httpStatus: number;
  outcome: "processed" | "duplicate" | "ignored" | "rejected";
  detail?: string;
  conversationId?: string;
  orgId?: string;
  aiShouldRespond?: boolean;
}

const DELIVERY_STATUS: Record<string, "sent" | "delivered" | "read" | "failed" | "undelivered"> = { sent: "sent", delivered: "delivered", read: "read", failed: "failed", undelivered: "undelivered" };

/**
 * Handles one GoHighLevel Inbound/OutboundMessage webhook. The signature and freshness are verified first, the webhook id
 * is recorded so a replay is ignored, the tenant comes only from our own location mapping, and contact details are looked up
 * with that tenant's credential (the payload carries only a contact id).
 */
export async function handleGhlWebhook(
  input: { rawBody: string; signature: string | null; now?: number },
  deps: { fetchContact?: (orgId: string, contactId: string) => Promise<GhlContactInfo | null> } = {},
): Promise<WebhookOutcome> {
  const check = verifyGhlWebhook({ rawBody: input.rawBody, signature: input.signature, now: input.now });
  if (!check.ok) return { httpStatus: check.reason === "signature" ? 401 : 400, outcome: "rejected", detail: `Webhook ${check.reason}.` };
  const event = parseGhlMessageEvent(check.payload);
  const appointment = event ? null : parseGhlAppointmentEvent(check.payload);

  const emails: OutgoingEmail[] = [];
  const outcome = await withSystem(async (db): Promise<WebhookOutcome> => {
    const receipt = await db.query("insert into webhook_receipts (provider, external_id, kind) values ('ghl', $1, $2) on conflict do nothing returning external_id", [check.webhookId, String(check.payload.type ?? "").slice(0, 80)]);
    if (!receipt.rows[0]) return { httpStatus: 200, outcome: "duplicate" };
    const finish = async (result: WebhookOutcome, orgId?: string) => {
      await db.query("update webhook_receipts set outcome = $3, detail = $4, org_id = $5 where provider = 'ghl' and external_id = $1 and kind = $2", [check.webhookId, String(check.payload.type ?? "").slice(0, 80), result.outcome === "duplicate" ? "ignored" : result.outcome, result.detail?.slice(0, 300) ?? null, orgId ?? null]);
      return result;
    };
    if (!event && !appointment) return finish({ httpStatus: 200, outcome: "ignored", detail: "Event type is not used." });
    // The tenant is whoever owns this location in our own mapping. An unmapped location (including protected ones) is ignored.
    const loc = await db.query<{ org_id: string; calendar_ids: string[] }>("select org_id, calendar_ids from ghl_location_mappings where location_id = $1 and status <> 'disabled'", [(event ?? appointment)!.locationId]);
    const orgId = loc.rows[0]?.org_id;
    if (!orgId) return finish({ httpStatus: 200, outcome: "ignored", detail: "Location is not connected to a workspace." });

    if (appointment) {
      // Only calendars this workspace has connected are recorded; an event for any other calendar in the location is not ours to track.
      const calendars = loc.rows[0].calendar_ids;
      if (calendars.length && appointment.calendarId && !calendars.includes(appointment.calendarId)) return finish({ httpStatus: 200, outcome: "ignored", detail: "That calendar isn't connected to this workspace." }, orgId);
      const r = await applyAppointmentEvent(db, { orgId, source: "webhook", providerEventId: check.webhookId, event: appointment });
      return finish({ httpStatus: 200, outcome: r.outcome === "duplicate" ? "duplicate" : r.outcome === "failed" ? "rejected" : r.outcome === "ignored" || r.outcome === "stale" ? "ignored" : "processed", detail: `Appointment ${r.outcome}.`, orgId }, orgId);
    }
    if (!event) return finish({ httpStatus: 200, outcome: "ignored", detail: "Event type is not used." }, orgId);

    if (event.kind === "outbound") {
      const status = DELIVERY_STATUS[(event.status ?? "").toLowerCase()];
      if (!status) return finish({ httpStatus: 200, outcome: "ignored", detail: "Status is not a delivery update." }, orgId);
      const applied = await applyDeliveryEvent(db, { provider: "ghl", providerEventId: `${event.messageId}:${status}`, providerMessageId: event.messageId, status, occurredAt: event.occurredAt });
      return finish({ httpStatus: 200, outcome: applied.result === "applied" ? "processed" : "ignored", detail: applied.result }, orgId);
    }

    if (!event.channel) return finish({ httpStatus: 200, outcome: "ignored", detail: "Channel is not supported." }, orgId);
    // Reuse a contact we already know by CRM id; otherwise ask GoHighLevel for the phone or email.
    let address: string | null = null;
    let name: string | undefined;
    const known = await db.query<{ value: string; display_name: string }>(
      `select i.value, c.display_name from contacts c join contact_identities i on i.contact_id = c.id and i.org_id = c.org_id
       where c.org_id = $1 and c.ghl_contact_id = $2 and c.deleted_at is null and i.kind = $3 limit 1`,
      [orgId, event.contactId, event.channel === "email" ? "email" : "phone"],
    );
    if (known.rows[0]) {
      address = known.rows[0].value;
      name = known.rows[0].display_name;
    } else {
      const info = await (deps.fetchContact ?? fetchGhlContact)(orgId, event.contactId);
      if (info) {
        address = event.channel === "email" ? normalizeEmail(info.email) : normalizePhone(info.phone);
        name = info.name;
      }
    }
    if (!address) return finish({ httpStatus: 200, outcome: "ignored", detail: "The contact has no usable address." }, orgId);
    const r = await ingestInbound(db, { orgId, provider: "ghl", channel: event.channel, address, name, body: event.body, providerMessageId: event.messageId, ghlContactId: event.contactId, providerConversationId: event.conversationId, receivedAt: event.occurredAt });
    emails.push(...r.emails);
    return finish({ httpStatus: 200, outcome: r.status === "duplicate" ? "duplicate" : "processed", conversationId: r.conversationId, orgId, aiShouldRespond: r.aiShouldRespond }, orgId);
  });
  await Promise.all(emails.map((e) => sendEmail(e)));
  return outcome;
}
