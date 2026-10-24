import "server-only";
import crypto from "node:crypto";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { notifyAgency, notifyOrgRoles } from "@/server/notifications";
import { automationGate, checkOrgAutomation } from "@/server/automation/gate";
import { createApproval } from "@/server/approvals/service";
import { BillingBlockedError, chargeUsage, reserveCredits, releaseReservation, settleReservation, monthToDateSpendMicros, getBalance } from "@/server/billing/ledger";
import { isSwitching } from "@/server/crm/workspace";
import { nativeAutomationRefusal } from "@/server/crm/provider-guard";
import { contactAddress, getConsent, isSuppressed, suppressAddress } from "@/server/messaging/contacts";
import { identityFacts, latestConsentSource } from "@/server/messaging/consent-identity";
import { dispatchGate } from "@/server/messaging/dispatch-gate";
import { TYPED_CONSENT_SOURCE, unverifiedIdentityRefusal } from "@/lib/webchat/identity";
import type { ChannelProvider } from "@/server/messaging/provider";
import { fillInvoiceLink, fillManageLink, fillReviewLink, hasInvoiceLinkPlaceholder, hasManageLinkPlaceholder, hasReviewLinkPlaceholder, maskCustomerLinks } from "@/server/messaging/redact";
import { buildUnsubscribeUrl } from "@/server/messaging/unsubscribe";
import { transportFromProvider, type GhlTransportRequest } from "@/server/messaging/transports/ghl";
import { isTransportName, transportFor } from "@/server/messaging/transports";
import { TRANSPORT_LABELS, type ChannelTransport, type TransportName, type TransportResult, type TransportSender } from "@/server/messaging/transports/types";
import { queueWebChatOutbound } from "@/server/messaging/web-chat-send";
import {
  advancesDelivery,
  unconfirmedOutcome,
  isQuietHours,
  isWithinBusinessHours,
  nextSendWindow,
  smsSegments,
  validateBusinessHours,
  type BusinessHours,
  type Channel,
  type MessageStatus,
} from "@/lib/messaging";
import type { UnitType } from "@/lib/billing";

/**
 * reminder: a service message about an appointment the customer already has. Not a reply, and not counted against the follow-up allowance.
 * retention: an approved program message to an existing customer (welcome, check-in, feedback request, re-engagement). It has its own frequency
 * limit, counted across every channel and program for the contact.
 * billing: a reminder about an invoice the business has already sent the customer (src/server/invoices/reminders.ts). A service message the owner authorized in its exact
 * wording; it stops at once for a paused or suspended workspace and waits out quiet hours like a reminder does.
 */
export type SendScope = "reply" | "followup" | "human" | "reminder" | "retention" | "billing";
/** service: about something the customer has or asked for. marketing: promotional, and needs the customer's explicit marketing consent. */
export type SendPurpose = "service" | "marketing";
/**
 * system: work the server does on a person's explicit, recorded decision without any AI involved (an owner-approved campaign). It never
 * passes the AI gate, and like an AI send a refusal is recorded (or waits) instead of being thrown. `userId` is the person whose approval it acts on.
 */
export type SendActor = { kind: "ai"; agentId: string | null; approvalId?: string | null } | { kind: "human"; userId: string } | { kind: "system"; userId: string | null };

export interface SendRequest {
  orgId: string;
  conversationId: string;
  scope: SendScope;
  actor: SendActor;
  body: string;
  templateId?: string | null;
  now?: Date;
  /** The message already holds a credit reservation (re-checked at dispatch), so only credit already held is relied on. */
  hasReservation?: boolean;
  /** Follow-ups default to business hours; a custom schedule can opt out. */
  businessHoursOnly?: boolean;
  /** Scheduled follow-ups ask for quiet hours and rate limits; manual and reply sends do not. */
  followupStepId?: string | null;
  /** Makes the send at-most-once: a second request with the same key is refused by the database. */
  dedupeKey?: string | null;
  purpose?: SendPurpose;
  /**
   * AI sends only: the conversation's ownership_version the message was prepared under. If a takeover, pause, resume or another employee
   * changed it since, the message is stale and is refused (stale_ownership), both when queued and again right before it is sent.
   */
  fenceVersion?: number | null;
}

/** An approved WhatsApp template the message is sent with (whatsapp_templates, for the channel's provider). */
export interface DecisionTemplate {
  templateId: string;
  name: string;
  language: string;
  body: string;
}

export type SendDecision =
  | {
      allow: true;
      unit: UnitType;
      quantity: number;
      estimateMicros: number;
      wholesalePerUnitMicros: number;
      address: string;
      contactRef: string | null;
      fromIdentity: string | null;
      channel: Channel;
      /** The provider that carries this workspace's channel (messaging_channels.provider); its published rate priced the message. */
      provider: TransportName;
      sender: TransportSender;
      template: DecisionTemplate | null;
    }
  | { allow: false; reason: string; detail: string; retryAt?: Date; permanent?: boolean; needsApproval?: boolean };

const UNIT_FOR: Record<Channel, UnitType> = { sms: "sms_segment", whatsapp: "whatsapp_message", email: "email_send" };

/** How long a message's credit hold lasts beyond the time it is due. Expired holds are released by the scheduler (expireStaleReservations). */
const HOLD_TTL_SECONDS = 6 * 3600;
const holdTtlSeconds = (sendAfter: Date | undefined, now: Date) => HOLD_TTL_SECONDS + Math.max(0, Math.ceil(((sendAfter?.getTime() ?? now.getTime()) - now.getTime()) / 1000));

/** Keeps a still-held reservation alive until HOLD_TTL_SECONDS after the message's new due time. Never shortens it, never revives a released one. */
async function extendHold(db: Queryable, orgId: string, reservationId: string | null, sendAfter: Date) {
  if (!reservationId) return;
  await db.query(
    "update usage_reservations set expires_at = greatest(expires_at, $3::timestamptz + ($4 || ' seconds')::interval) where id = $1 and org_id = $2 and status = 'held'",
    [reservationId, orgId, sendAfter.toISOString(), String(HOLD_TTL_SECONDS)],
  );
}

/** Reasons that mean "not yet": the message keeps its reservation and is tried again at retryAt. */
const WAITING_REASONS = new Set(["quiet_hours", "outside_business_hours", "followup_too_soon", "retention_too_soon", "provider_switching"]);
/** How long a message waits while the workspace's provider switch is cutting over before it is checked again. */
const SWITCHING_RETRY_MS = 10 * 60_000;

const deny = (reason: string, detail: string, extra: Partial<Extract<SendDecision, { allow: false }>> = {}): SendDecision => ({ allow: false, reason, detail, ...extra });

interface ChannelRow {
  enabled: boolean;
  provider: string;
  sender_identity: string | null;
  provider_sender_id: string | null;
  provider_account_id: string | null;
  credential_id: string | null;
}

/** The provider of a workspace's channel. A channel that was never set up belongs to GoHighLevel, the column default. */
async function channelProvider(db: Queryable, orgId: string, channel: Channel): Promise<TransportName> {
  const { rows } = await db.query<{ provider: string }>("select provider from messaging_channels where org_id = $1 and channel = $2", [orgId, channel]);
  return rows[0] && isTransportName(rows[0].provider) ? rows[0].provider : "ghl";
}

interface WhatsappTemplateRow {
  template_id: string;
  name: string;
  language: string;
  body: string;
  status: string;
  category: string | null;
  variables: unknown;
}

/**
 * The WhatsApp template a message names, as the provider that carries the channel knows it: a template approved in GoHighLevel is not
 * approved in Meta's account, and the other way round. Any status; the caller decides what it may be used for.
 */
async function loadWhatsappTemplate(db: Queryable, orgId: string, templateId: string, provider: TransportName): Promise<WhatsappTemplateRow | null> {
  const { rows } = await db.query<WhatsappTemplateRow>(
    "select template_id, name, language, body, status, category, variables from whatsapp_templates where org_id = $1 and template_id = $2 and provider = $3",
    [orgId, templateId, provider === "meta_whatsapp" ? "meta_whatsapp" : "ghl"],
  );
  return rows[0] ?? null;
}

/** A MARKETING template is promotional whatever the sender chose, so the message is held to the marketing consent rule and recorded as such. */
const purposeWith = (requested: SendPurpose | undefined, template: Pick<WhatsappTemplateRow, "category"> | null): SendPurpose => (template?.category === "marketing" ? "marketing" : requested ?? "service");

/** The purpose a message is recorded with: what was asked for, or marketing when it is sent with a WhatsApp MARKETING template. */
async function recordedPurpose(db: Queryable, req: SendRequest): Promise<SendPurpose> {
  if (!req.templateId) return req.purpose ?? "service";
  const { rows } = await db.query<{ channel: Channel }>("select channel from conversations where id = $1 and org_id = $2", [req.conversationId, req.orgId]);
  if (rows[0]?.channel !== "whatsapp") return req.purpose ?? "service";
  return purposeWith(req.purpose, await loadWhatsappTemplate(db, req.orgId, req.templateId, await channelProvider(db, req.orgId, "whatsapp")));
}

const PLACEHOLDER = /\{\{\s*\d{1,2}\s*\}\}/;

/**
 * Whether a message can be sent with an approved Meta template so that the customer receives exactly the text the inbox records. Meta
 * delivers the template's own wording, filled with the values passed: a template without values must be sent word for word, and one with
 * values must be followed exactly, with every value filled in (whatsappTemplateParams reads them back from the text).
 */
export function templateFit(template: { name: string; body: string; variableCount: number }, text: string): { ok: true; params: string[] } | { ok: false; detail: string } {
  const quoted = `“${template.name}”`;
  // The values the template needs: as the sync recorded them, and never fewer than its body's numbered placeholders.
  const needed = Math.max(template.variableCount, new Set([...template.body.matchAll(/\{\{\s*(\d{1,2})\s*\}\}/g)].map((x) => Number(x[1]))).size);
  if (needed === 0) {
    if (squash(text) === squash(template.body)) return { ok: true, params: [] };
    const wording = squash(template.body);
    return { ok: false, detail: `The template ${quoted} has fixed wording, and WhatsApp delivers only that. Send its text exactly as approved: “${wording.length > 160 ? `${wording.slice(0, 157)}…` : wording}”` };
  }
  const params = whatsappTemplateParams(template.body, text);
  if (params.length !== needed) {
    return { ok: false, detail: `The message doesn't follow the template ${quoted}. Keep its wording and replace each {{1}}, {{2}} … with a value: WhatsApp delivers the template's text, not other wording.` };
  }
  if (params.some((p) => PLACEHOLDER.test(p))) return { ok: false, detail: `Replace every {{1}}, {{2}} … in the template ${quoted} with its value before sending.` };
  return { ok: true, params };
}

/** The latest published unit rate for a provider. Rates are published by an iAcquire admin and never invented here. */
async function publishedRate(db: Queryable, provider: TransportName, unit: UnitType): Promise<{ wholesale: number; client: number } | null> {
  const { rows } = await db.query<{ w: string; c: string }>(
    `select r.wholesale_micros_per_unit::text as w, r.client_micros_per_unit::text as c from usage_unit_rates r
     join usage_rate_versions v on v.id = r.rate_version_id where r.provider = $1 and r.unit_type = $2 order by v.version desc limit 1`,
    [provider, unit],
  );
  return rows[0] ? { wholesale: Number(rows[0].w), client: Number(rows[0].c) } : null;
}

interface ConversationRow {
  id: string;
  contact_id: string;
  channel: Channel;
  owner_kind: "ai" | "human" | "unassigned";
  owner_user_id: string | null;
  ownership_version: number;
  ai_paused_at: Date | null;
  last_inbound_at: Date | null;
  subject: string | null;
  contact_deleted: Date | null;
  ghl_contact_id: string | null;
  contact_tz: string | null;
  org_tz: string;
  org_name: string;
}

/**
 * The one rule chain every outbound message passes, both when it is queued and again immediately before it is sent.
 * It reads current state each time, so a takeover, pause, opt-out or credit change that happens in between always wins.
 */
export async function evaluateSend(db: Queryable, req: SendRequest): Promise<SendDecision> {
  const now = req.now ?? new Date();
  const { rows } = await db.query<ConversationRow>(
    `select c.id, c.contact_id, c.channel, c.owner_kind, c.owner_user_id, c.ownership_version, c.ai_paused_at, c.last_inbound_at, c.subject,
            k.deleted_at as contact_deleted, k.ghl_contact_id, k.timezone as contact_tz, o.timezone as org_tz, o.name as org_name
     from conversations c join contacts k on k.id = c.contact_id and k.org_id = c.org_id join organizations o on o.id = c.org_id
     where c.id = $1 and c.org_id = $2`,
    [req.conversationId, req.orgId],
  );
  const conv = rows[0];
  if (!conv) throw new AppError("not_found", "Conversation not found.");
  // A website chat is never sent through a provider; its replies take queueWebChatOutbound. Anything else that reaches this chain with one is refused.
  if ((conv.channel as string) === "web_chat") return deny("channel_not_ready", "A website chat reply appears in the visitor's open chat window; it is not sent as a message.", { permanent: true });
  const channel = conv.channel;
  if (conv.contact_deleted) return deny("contact_unreachable", "This contact was removed.", { permanent: true });
  // An invoice reminder is automatic and goes to the business's customer about money: a pause or a suspension of the workspace stops it, both when it is queued and right
  // before it is sent. (Other system sends are held to the same rule by the caller that starts them; this one is held here so no caller can forget.)
  if (req.scope === "billing") {
    for (const gateScope of ["messaging", "outbound"] as const) {
      const gate = await checkOrgAutomation(db, req.orgId, gateScope);
      if (!gate.allowed) return deny(gate.reason === "org_inactive" ? "org_inactive" : "automation_paused", gate.detail, { permanent: true });
    }
  }
  // A missed-call follow-up (its key starts with "mcc:") is automation sent by the system, and a person who has taken the conversation over wins: it is
  // refused when it is queued and again when it is about to be sent, so a takeover in between stops it.
  if (req.actor.kind === "system" && req.dedupeKey?.startsWith("mcc:") && conv.owner_kind === "human") {
    return deny("human_owner", "A person has taken over this conversation.", { permanent: true });
  }

  if (req.actor.kind === "ai") {
    // A person owns the conversation: the AI never sends, and queued sends stay blocked after retries and restarts.
    if (conv.owner_kind !== "ai") return deny("human_owner", "A person has taken over this conversation.", { permanent: true });
    // The ownership revision this message was prepared under is the fence: a takeover that was handed straight back, a pause, or another
    // employee being assigned all move it, so a reply written for the earlier situation never goes out afterwards.
    if (req.fenceVersion != null && req.fenceVersion !== conv.ownership_version) {
      return deny("stale_ownership", "This conversation changed hands after the reply was prepared, so it was not sent.", { permanent: true });
    }
    // A paused conversation keeps its AI employee but stops automatic replies. A message a person approved by name is theirs to send.
    if (conv.ai_paused_at && !req.actor.approvalId) return deny("ai_paused", "AI replies are paused for this conversation.", { permanent: true });
    // While someone is being asked to take over, the AI holds off so it cannot promise a human reply that nobody has accepted.
    const pending = await db.query("select 1 from human_escalations where conversation_id = $1 and status in ('awaiting_owner', 'open')", [req.conversationId]);
    if (pending.rows[0]) return deny("escalation_pending", "A person is being asked to take over this conversation.");
    const gate = await automationGate(db, { orgId: req.orgId, agentId: req.actor.agentId, scope: req.scope === "followup" || req.scope === "reminder" || req.scope === "retention" ? "followup" : "reply", approvalId: req.actor.approvalId ?? null });
    if (gate.decision === "blocked") {
      const reason = gate.reason === "org_inactive" ? "org_inactive" : ["agent_not_ready", "agent_missing", "agent_disabled"].includes(gate.reason) ? "agent_not_ready" : "automation_paused";
      return deny(reason, gate.detail, { permanent: true });
    }
    if (gate.decision === "needs_approval") return deny("needs_approval", gate.detail, { needsApproval: true });
    const { rows: settings } = await db.query<{ auto_reply_enabled: boolean }>("select auto_reply_enabled from messaging_settings where org_id = $1", [req.orgId]);
    // Autopilot is something the owner turns on. Until then the AI prepares drafts for a person to approve.
    if (!settings[0]?.auto_reply_enabled && !req.actor.approvalId) return deny("needs_approval", "Automatic replies are not switched on for this workspace yet.", { needsApproval: true });
  }

  const address = await contactAddress(db, req.orgId, conv.contact_id, channel);
  if (!address) return deny("contact_unreachable", `There is no ${channel === "email" ? "email address" : "phone number"} on file for this contact.`, { permanent: true });
  const { rows: chan } = await db.query<ChannelRow>(
    "select enabled, provider, sender_identity, provider_sender_id, provider_account_id, credential_id from messaging_channels where org_id = $1 and channel = $2",
    [req.orgId, channel],
  );
  const provider: TransportName = chan[0] && isTransportName(chan[0].provider) ? chan[0].provider : "ghl";
  // GoHighLevel addresses its own contact record; native providers send to the address itself, so only GoHighLevel needs the link.
  if (transportFor(provider).requiresContactRef && !conv.ghl_contact_id) return deny("contact_unreachable", "This contact is not linked to your CRM yet, so the provider cannot deliver to them.");

  if (await isSuppressed(db, req.orgId, channel, address)) return deny("suppressed", "This address opted out or bounced, so nothing can be sent to it.", { permanent: true });
  // A WhatsApp template is looked up with the provider carrying the channel. Its category can make the message marketing.
  const waTemplate = channel === "whatsapp" && req.templateId ? await loadWhatsappTemplate(db, req.orgId, req.templateId, provider) : null;
  const purpose: SendPurpose = purposeWith(req.purpose, waTemplate);
  // A number or address that only a website visitor typed is not reachable by anything automated or promotional until it is confirmed (see src/lib/webchat/identity.ts).
  // The mark is on the address, not on the contact: a merge into a contact the chat did not create moves the address, and it stays typed.
  const refusal = unverifiedIdentityRefusal(await identityFacts(db, req.orgId, conv.contact_id, channel, address), {
    actor: req.actor.kind, approvedByPerson: req.actor.kind === "ai" && Boolean(req.actor.approvalId), scope: req.scope, purpose,
  });
  if (refusal) return deny(refusal.reason, refusal.detail, { permanent: true });
  const consent = await getConsent(db, req.orgId, conv.contact_id, channel, purpose);
  if (consent === "revoked") return deny("no_consent", "This customer withdrew consent on this channel.", { permanent: true });
  // Promotional messages need an explicit yes. Anything else needs one on record, or the customer having written to us first.
  if (purpose === "marketing" && consent !== "granted") {
    return deny("no_consent", waTemplate?.category === "marketing" && req.purpose !== "marketing" ? "This WhatsApp template is a marketing template, and this customer has not agreed to promotional messages on WhatsApp." : "This customer has not agreed to promotional messages on this channel.", { permanent: true });
  }
  // The box offering promotional messages was ticked by whoever typed the details, possibly before the address was confirmed as theirs. Confirming the address later does not
  // make that tick the customer's own, so it does not count until the customer or a person of the business records the agreement again. The grant keeps its source when a
  // merge carries it to another contact, so this holds for whichever contact now owns it.
  if (purpose === "marketing" && (await latestConsentSource(db, req.orgId, conv.contact_id, channel, "marketing")) === TYPED_CONSENT_SOURCE) {
    return deny("no_consent", "The only promotional agreement on record was ticked in the website chat, before this customer confirmed the address. It needs to be recorded again.", { permanent: true });
  }
  if (consent === "unknown" && (req.scope === "followup" || !conv.last_inbound_at)) return deny("no_consent", "There is no consent on record to message this person.", { permanent: true });

  // While the workspace's provider switch is cutting over, a message could go out twice or through the wrong provider. It waits instead.
  if (await isSwitching(db, req.orgId)) {
    return deny("provider_switching", "This workspace is switching providers. The message waits until the switch is finished.", { retryAt: new Date(now.getTime() + SWITCHING_RETRY_MS) });
  }
  // Hybrid CRM: when GoHighLevel owns conversations, its own automations message these customers, so iAcquire never sends through its
  // own providers too (only the GoHighLevel transport, which sends through the owner itself, may carry the message).
  if (provider !== "ghl") {
    const ghlOwned = await nativeAutomationRefusal(db, req.orgId, "conversations");
    if (ghlOwned) return deny("provider_owned", ghlOwned);
  }

  if (!chan[0]?.enabled) return deny("channel_not_ready", `${channel === "sms" ? "SMS" : channel === "whatsapp" ? "WhatsApp" : "Email"} is not verified and enabled for this workspace yet.`);

  const { rows: policyRows } = await db.query<{ max_followups_per_contact_30d: number; min_hours_between_followups: number; max_retention_per_contact_30d: number; min_hours_between_retention: number; quiet_hours_start: string; quiet_hours_end: string; whatsapp_window_hours: number }>("select * from messaging_policy");
  const policy = policyRows[0];
  let template: DecisionTemplate | null = null;
  if (channel === "whatsapp") {
    if (req.templateId) {
      // A template is approved by the provider that will send it: one approved in GoHighLevel is not approved in Meta's account.
      const t = waTemplate;
      if (!t || t.status !== "approved") return deny("whatsapp_window_closed", "That WhatsApp template is not approved.");
      if (provider === "meta_whatsapp") {
        // Meta delivers the template's own words, so the message must be exactly the template (filled in), or the inbox would record one
        // text while the customer got another. Checked when it is queued and again before it is sent.
        const fit = templateFit({ name: t.name, body: t.body, variableCount: Array.isArray(t.variables) ? t.variables.length : 0 }, req.body);
        if (!fit.ok) return deny("template_mismatch", fit.detail, { permanent: true });
      }
      template = { templateId: t.template_id, name: t.name, language: t.language, body: t.body };
    } else if (!conv.last_inbound_at || now.getTime() - new Date(conv.last_inbound_at).getTime() > policy.whatsapp_window_hours * 3600_000) {
      return deny("whatsapp_window_closed", `WhatsApp only allows free-form messages within ${policy.whatsapp_window_hours} hours of the customer's last message. Use an approved template.`);
    }
  }

  if (req.scope === "followup") {
    // The allowance belongs to the contact, not the channel, so SMS, WhatsApp and email can never multiply it.
    const sent = await db.query<{ n: string; last: Date | null }>(
      `select count(*)::text as n, max(m.sent_at) as last from conversation_messages m join conversations c on c.id = m.conversation_id
       where m.org_id = $1 and c.contact_id = $2 and m.scope = 'followup' and m.status in ('sent', 'delivered', 'read') and m.sent_at > $3::timestamptz - interval '30 days'`,
      [req.orgId, conv.contact_id, now.toISOString()],
    );
    if (Number(sent.rows[0].n) >= policy.max_followups_per_contact_30d) return deny("followup_limit", "This contact has reached the follow-up limit for the last 30 days.", { permanent: true });
    const lastAt = sent.rows[0].last ? new Date(sent.rows[0].last).getTime() : null;
    if (lastAt && now.getTime() - lastAt < policy.min_hours_between_followups * 3600_000) {
      return deny("followup_too_soon", "A follow-up went to this contact very recently.", { retryAt: new Date(lastAt + policy.min_hours_between_followups * 3600_000) });
    }
  }

  if (req.scope === "retention") {
    // One allowance per customer for all retention programs together, whatever channel each message uses.
    const sent = await db.query<{ n: string; last: Date | null }>(
      `select count(*)::text as n, max(m.sent_at) as last from conversation_messages m join conversations c on c.id = m.conversation_id
       where m.org_id = $1 and c.contact_id = $2 and m.scope = 'retention' and m.status in ('sent', 'delivered', 'read') and m.sent_at > $3::timestamptz - interval '30 days'`,
      [req.orgId, conv.contact_id, now.toISOString()],
    );
    if (Number(sent.rows[0].n) >= policy.max_retention_per_contact_30d) return deny("retention_limit", "This customer has reached the limit for program messages in the last 30 days.", { permanent: true });
    const lastAt = sent.rows[0].last ? new Date(sent.rows[0].last).getTime() : null;
    if (lastAt && now.getTime() - lastAt < policy.min_hours_between_retention * 3600_000) {
      return deny("retention_too_soon", "A program message went to this customer very recently.", { retryAt: new Date(lastAt + policy.min_hours_between_retention * 3600_000) });
    }
  }

  const quantity = channel === "sms" ? Math.max(1, smsSegments(req.body)) : 1;
  const unit = UNIT_FOR[channel];
  const rate = await publishedRate(db, provider, unit);
  if (!rate) return deny("rate_not_published", "iAcquire has not published a usage rate for this channel yet, so it cannot be billed.");
  const estimate = Math.ceil(rate.client * quantity);
  if (!req.hasReservation) {
    const bal = await getBalance(db, req.orgId);
    if (estimate > bal.availableMicros) return deny("credits", "There are not enough service credits to send this.");
    const { rows: budget } = await db.query<{ monthly_budget_micros: string | null; hard_stop: boolean }>("select monthly_budget_micros, hard_stop from billing_settings where org_id = $1", [req.orgId]);
    if (budget[0]?.monthly_budget_micros && budget[0].hard_stop && (await monthToDateSpendMicros(db, req.orgId)) + bal.reservedMicros + estimate > Number(budget[0].monthly_budget_micros)) {
      return deny("budget", "This would go over the monthly spending limit.");
    }
  }

  // Time rules last: everything else is already known to pass, so waiting is meaningful.
  const tz = conv.contact_tz ?? conv.org_tz;
  if (req.scope === "followup" || req.scope === "reminder" || req.scope === "retention" || req.scope === "billing") {
    const { rows: s } = await db.query<{ business_hours: unknown }>("select business_hours from messaging_settings where org_id = $1", [req.orgId]);
    const hours = validateBusinessHours(s[0]?.business_hours ?? {});
    // Follow-ups and program messages default to business hours. A reminder about a booked appointment is useful at any waking hour, so only quiet hours hold it back.
    const bhOnly = (req.scope === "followup" || req.scope === "retention") && req.businessHoursOnly !== false;
    const quiet = isQuietHours(policy.quiet_hours_start, policy.quiet_hours_end, now, tz);
    const closed = bhOnly && !isWithinBusinessHours(hours, now, conv.org_tz);
    if (quiet || closed) {
      return deny(quiet ? "quiet_hours" : "outside_business_hours", quiet ? "Follow-ups are not sent during quiet hours." : "Follow-ups are only sent during business hours.", {
        retryAt: nextSendWindow({ from: now, timeZone: tz, quietStart: policy.quiet_hours_start, quietEnd: policy.quiet_hours_end, businessHours: hours as BusinessHours | null, businessHoursOnly: bhOnly }),
      });
    }
  } else if (req.scope === "reply" && req.actor.kind === "ai") {
    const { rows: s } = await db.query<{ reply_business_hours_only: boolean; business_hours: unknown }>("select reply_business_hours_only, business_hours from messaging_settings where org_id = $1", [req.orgId]);
    if (s[0]?.reply_business_hours_only) {
      const hours = validateBusinessHours(s[0].business_hours ?? {});
      if (!isWithinBusinessHours(hours, now, conv.org_tz)) {
        return deny("outside_business_hours", "Replies are limited to business hours for this workspace.", {
          retryAt: nextSendWindow({ from: now, timeZone: conv.org_tz, quietStart: "00:00", quietEnd: "00:00", businessHours: hours as BusinessHours | null, businessHoursOnly: true }),
        });
      }
    }
  }

  const c = chan[0];
  return {
    allow: true,
    unit,
    quantity,
    estimateMicros: estimate,
    wholesalePerUnitMicros: rate.wholesale,
    address,
    contactRef: conv.ghl_contact_id,
    fromIdentity: c.sender_identity,
    channel,
    provider,
    sender: { identity: c.sender_identity, senderId: c.provider_sender_id, accountId: c.provider_account_id, credentialId: c.credential_id },
    template,
  };
}

export interface QueueResult {
  messageId: string;
  status: "queued" | "draft" | "blocked";
  reason?: string;
  detail?: string;
}

/**
 * Records an outbound message and, when every rule passes, reserves credit and queues it for the dispatcher.
 * AI sends that cannot go are kept visibly (draft for approval, or blocked with the reason). A person's own send that
 * cannot go is refused with an explanation instead of leaving a failed row behind.
 */
export async function queueOutbound(db: Queryable, req: SendRequest & { agentId?: string | null; approvalId?: string | null }): Promise<QueueResult> {
  // A website chat has no provider: its reply is stored for the visitor's open widget (see web-chat-send.ts). Every other channel takes the chain below.
  const kind = await db.query<{ channel: string }>("select channel from conversations where id = $1 and org_id = $2", [req.conversationId, req.orgId]);
  if (kind.rows[0]?.channel === "web_chat") return queueWebChatOutbound(db, req);
  const decision = await evaluateSend(db, req);
  const messageId = crypto.randomUUID();
  const author = req.actor.kind === "ai" ? { kind: "ai", userId: null, agentId: req.actor.agentId } : { kind: req.actor.kind, userId: req.actor.userId, agentId: null };
  // Recorded with the message so every later check (at dispatch, after a wait) applies the same consent rule.
  const purpose = await recordedPurpose(db, req);
  // An AI message carries the ownership revision it was prepared under (see SendRequest.fenceVersion); evaluateSend has just confirmed it is current.
  const fence = req.actor.kind === "ai" ? (req.fenceVersion ?? (await db.query<{ v: number }>("select ownership_version as v from conversations where id = $1 and org_id = $2", [req.conversationId, req.orgId])).rows[0]?.v ?? null) : null;
  const insert = (status: string, extra: { reason?: string; detail?: string; sendAfter?: Date; reservationId?: string | null }) =>
    db.query(
      `insert into conversation_messages (id, org_id, conversation_id, direction, author_kind, author_user_id, agent_id, body, status, status_detail, blocked_reason, scope,
         template_id, approval_id, followup_step_id, reservation_id, send_after, dedupe_key, purpose, ownership_fence, queued_at)
       values ($1, $2, $3, 'outbound', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, case when $8 = 'queued' then now() end)`,
      [messageId, req.orgId, req.conversationId, author.kind, author.userId, author.agentId, req.body, status, extra.detail?.slice(0, 300) ?? null, extra.reason ?? null, req.scope,
        req.templateId ?? null, req.approvalId ?? (req.actor.kind === "ai" ? req.actor.approvalId ?? null : null), req.followupStepId ?? null, extra.reservationId ?? null, extra.sendAfter ?? req.now ?? new Date(), req.dedupeKey ?? null, purpose, fence],
    );

  if (!decision.allow) {
    if (req.actor.kind === "human") throw new AppError("conflict", decision.detail);
    if (decision.needsApproval) {
      await insert("draft", { reason: "needs_approval", detail: decision.detail });
      // The draft also appears in the Approval Center, so it can be approved or rejected from either place.
      const approvalId = await createApproval(db, {
        orgId: req.orgId,
        agentId: req.actor.kind === "ai" ? req.actor.agentId : null,
        kind: "follow_up_message",
        title: req.scope === "followup" ? "Send AI follow-up to a customer" : req.scope === "retention" ? "Send a program message to a customer" : req.scope === "reminder" ? "Send an appointment reminder" : "Send AI reply to a customer",
        action: { messageId },
        targetType: "conversation",
        targetId: req.conversationId,
        reason: "Your AI employee prepared this message and needs a person to approve it before it is sent.",
        expectedEffect: "The message is sent to the customer.",
        risk: "medium",
        idempotencyKey: `draft:${messageId}`,
        actorKind: "agent",
      });
      if (approvalId) await db.query("update conversation_messages set approval_id = $2 where id = $1", [messageId, approvalId]);
      return { messageId, status: "draft", reason: "needs_approval", detail: decision.detail };
    }
    // Time rules (and a provider switch in progress) wait; everything else is final for now and is recorded so it is visible.
    if (decision.retryAt && !decision.permanent && WAITING_REASONS.has(decision.reason)) {
      return queueWithReservation(db, req, messageId, insert, { retryAt: decision.retryAt });
    }
    await insert("blocked", { reason: decision.reason, detail: decision.detail });
    if (["credits", "budget"].includes(decision.reason)) {
      await notifyOrgRoles(db, req.orgId, ["owner", "admin"], { kind: "message_blocked", severity: "warning", title: "A message was held because credits are low", body: "Add service credits to resume automatic replies and follow-ups.", link: "/settings/billing", dedupeKey: `blocked_credits:${new Date().toISOString().slice(0, 10)}` });
    }
    return { messageId, status: "blocked", reason: decision.reason, detail: decision.detail };
  }
  return queueWithReservation(db, req, messageId, insert, { decision });
}

async function queueWithReservation(
  db: Queryable,
  req: SendRequest,
  messageId: string,
  insert: (status: string, extra: { reason?: string; detail?: string; sendAfter?: Date; reservationId?: string | null }) => Promise<unknown>,
  opts: { decision?: Extract<SendDecision, { allow: true }>; retryAt?: Date },
): Promise<QueueResult> {
  // Reserve before the message exists as sendable work, using the rate that applied when it was queued.
  const { rows: conv } = await db.query<{ channel: Channel }>("select channel from conversations where id = $1 and org_id = $2", [req.conversationId, req.orgId]);
  const channel = conv[0].channel;
  let estimate = opts.decision?.estimateMicros;
  if (estimate === undefined) {
    // A message that waits (quiet hours, spacing, a provider switch) was not priced yet: price it at the channel provider's rate.
    const quantity = channel === "sms" ? Math.max(1, smsSegments(req.body)) : 1;
    const rate = await publishedRate(db, await channelProvider(db, req.orgId, channel), UNIT_FOR[channel]);
    if (!rate) {
      const detail = "iAcquire has not published a usage rate for this channel yet, so it cannot be billed.";
      await insert("blocked", { reason: "rate_not_published", detail });
      return { messageId, status: "blocked", reason: "rate_not_published", detail };
    }
    estimate = Math.ceil(rate.client * quantity);
  }
  try {
    // The hold must outlive the wait: a message held back by quiet hours or a provider switch keeps its credit until it is sent.
    const ttlSeconds = holdTtlSeconds(opts.retryAt, req.now ?? new Date());
    const hold = await reserveCredits(db, { orgId: req.orgId, estimateMicros: Math.max(1, estimate), purpose: `${channel} message`, jobReference: `msg:${messageId}`, ttlSeconds });
    await insert("queued", { sendAfter: opts.retryAt, reservationId: hold.id });
    return { messageId, status: "queued" };
  } catch (err) {
    if (err instanceof BillingBlockedError) {
      if (req.actor.kind === "human") throw err;
      await insert("blocked", { reason: err.reason === "budget_exceeded" ? "budget" : "credits", detail: err.message });
      return { messageId, status: "blocked", reason: err.reason === "budget_exceeded" ? "budget" : "credits", detail: err.message };
    }
    throw err;
  }
}

interface MessageRow {
  id: string;
  org_id: string;
  conversation_id: string;
  author_kind: "ai" | "human" | "system";
  author_user_id: string | null;
  agent_id: string | null;
  body: string;
  scope: SendScope;
  purpose: SendPurpose;
  template_id: string | null;
  approval_id: string | null;
  followup_step_id: string | null;
  reservation_id: string | null;
  ownership_fence: number | null;
  attempt_count: number;
  created_at: Date;
  dedupe_key: string | null;
  channel: Channel;
  subject: string | null;
  contact_id: string;
}

function requestFor(m: MessageRow, now: Date): SendRequest {
  return {
    orgId: m.org_id,
    conversationId: m.conversation_id,
    scope: m.scope,
    purpose: m.purpose,
    actor: m.author_kind === "ai" ? { kind: "ai", agentId: m.agent_id, approvalId: m.approval_id } : m.author_kind === "system" ? { kind: "system", userId: m.author_user_id } : { kind: "human", userId: m.author_user_id ?? "" },
    body: m.body,
    templateId: m.template_id,
    now,
    hasReservation: Boolean(m.reservation_id),
    fenceVersion: m.author_kind === "ai" ? m.ownership_fence : null,
    dedupeKey: m.dedupe_key,
  };
}

const PERMANENT_STEP_REASONS = new Set(["human_owner", "ai_paused", "stale_ownership", "suppressed", "no_consent", "identity_unverified", "automation_paused", "org_inactive", "agent_not_ready", "followup_limit", "contact_unreachable"]);

async function finishBlocked(db: Queryable, m: Pick<MessageRow, "id" | "org_id" | "reservation_id" | "followup_step_id">, reason: string, detail: string) {
  await db.query("update conversation_messages set status = 'blocked', blocked_reason = $2, status_detail = $3 where id = $1", [m.id, reason, detail.slice(0, 300)]);
  if (m.reservation_id) await releaseReservation(db, { orgId: m.org_id, reservationId: m.reservation_id, reason: `Not sent: ${reason}` });
  if (m.followup_step_id) {
    await db.query("update follow_up_steps set status = 'blocked', reason = $2 where id = $1", [m.followup_step_id, reason]);
    if (PERMANENT_STEP_REASONS.has(reason)) {
      const { cancelFollowUpsForContactOfStep } = await import("@/server/messaging/followups");
      await cancelFollowUpsForContactOfStep(db, m.followup_step_id, reason);
    }
  }
}

/** Test and tooling hooks for dispatch. In production nothing is passed and each channel's registered transport is used. */
export interface DispatchDeps {
  /**
   * A provider written against the original contract (ghlProvider, a test recorder). It replaces the transport of the same name only, so a
   * GoHighLevel recorder never receives a message for a channel that a native provider carries.
   */
  provider?: ChannelProvider;
  /** A transport that replaces the registered transport of the same name. */
  transport?: ChannelTransport;
  now?: Date;
}

function transportForDispatch(name: TransportName, deps: DispatchDeps): ChannelTransport {
  if (deps.transport && deps.transport.name === name) return deps.transport;
  if (deps.provider && deps.provider.name === name) return { ...transportFromProvider(deps.provider), name };
  return transportFor(name);
}

/** How many earlier Message-IDs a reply carries in References (RFC 5322 3.6.4); the provider shortens the header further if it must. */
const MAX_REFERENCES = 20;

/**
 * Email threading for a reply: In-Reply-To is the Message-ID of the customer's latest email in this conversation, and References lists the
 * thread's known Message-IDs up to it, oldest first. Without an inbound Message-ID the email starts a new thread.
 */
async function emailThread(db: Queryable, conversationId: string): Promise<{ inReplyTo: string | null; references: string[] }> {
  const { rows } = await db.query<{ ref: string; direction: string }>(
    `select provider_thread_ref as ref, direction from conversation_messages
     where conversation_id = $1 and provider_thread_ref is not null and direction in ('inbound', 'outbound') order by created_at desc, id desc limit $2`,
    [conversationId, MAX_REFERENCES],
  );
  const parent = rows.findIndex((r) => r.direction === "inbound");
  if (parent < 0) return { inReplyTo: null, references: [] };
  const refs = rows.slice(parent).map((r) => r.ref).reverse();
  return { inReplyTo: rows[parent].ref, references: refs.filter((r, i) => refs.indexOf(r) === i) };
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The positional parameters of an approved WhatsApp template, read back from the message text that was written from it: the template body
 * with {{1}}, {{2}} … is matched against the message, and each placeholder's text becomes its parameter. A template without placeholders
 * has none. When the message does not follow the template (or a repeated placeholder has two values) no parameters are sent, and the
 * provider refuses the message rather than sending something other than what the inbox shows.
 */
export function whatsappTemplateParams(templateBody: string, text: string): string[] {
  const body = squash(templateBody);
  const marks = [...body.matchAll(/\{\{\s*(\d{1,2})\s*\}\}/g)];
  if (!marks.length) return [];
  let pattern = "^";
  let last = 0;
  const order: number[] = [];
  for (const mark of marks) {
    pattern += `${escapeRegExp(body.slice(last, mark.index ?? 0))}(.+?)`;
    order.push(Number(mark[1]));
    last = (mark.index ?? 0) + mark[0].length;
  }
  pattern += `${escapeRegExp(body.slice(last))}$`;
  const match = new RegExp(pattern, "s").exec(squash(text));
  if (!match) return [];
  const values = new Map<number, string>();
  for (let i = 0; i < order.length; i += 1) {
    const value = match[i + 1].trim();
    if (!value || (values.has(order[i]) && values.get(order[i]) !== value)) return [];
    values.set(order[i], value);
  }
  const params: string[] = [];
  for (let n = 1; n <= Math.max(...order); n += 1) {
    const value = values.get(n);
    if (value === undefined) return [];
    params.push(value);
  }
  return params;
}

/** Owners hear that sending stopped; for a native provider (whose credential only iAcquire can replace) the agency hears it too. */
async function notifyReconnect(db: Queryable, orgId: string, provider: TransportName) {
  const label = TRANSPORT_LABELS[provider];
  const day = new Date().toISOString().slice(0, 10);
  await notifyOrgRoles(db, orgId, ["owner", "admin"], {
    kind: "integration_reconnect_required",
    severity: "warning",
    title: `Reconnect ${label} to send messages`,
    body: provider === "ghl" ? "Messages are held until the connection is restored." : `Messages are held until iAcquire reconnects ${label} for this workspace.`,
    link: provider === "ghl" ? "/settings/integrations" : "/settings/messaging",
    dedupeKey: `reconnect:${provider}:${day}`,
  });
  if (provider !== "ghl") {
    await notifyAgency(db, orgId, {
      kind: "integration_reconnect_required",
      severity: "warning",
      title: `${label} needs reconnecting for a client`,
      body: `${label} refused this workspace's stored credential or sender, so its messages are held. Check the channel and run its test again.`,
      link: `/admin/clients/${orgId}/integrations`,
      dedupeKey: `reconnect:${provider}:${orgId}:${day}`,
    });
  }
}

interface Prepared {
  m: MessageRow;
  decision: Extract<SendDecision, { allow: true }>;
  /** The credit hold the message is sent under: its own, or a fresh one taken because its own lapsed while it waited. */
  reservationId: string | null;
  /** The text the provider receives: the stored body with a reminder's manage link filled in (never written back). */
  body: string;
  quantity: number;
  /** A manage link issued for this attempt, withdrawn again if the provider did not take the message at all. */
  manageLink: { appointmentId: string; token: string } | null;
  thread: { inReplyTo: string | null; references: string[] };
}

/** What the provider accepted, for recording the message as sent. */
interface Accepted {
  m: Pick<MessageRow, "id" | "org_id" | "conversation_id" | "body" | "followup_step_id">;
  provider: TransportName;
  unit: UnitType;
  quantity: number;
  wholesalePerUnitMicros: number;
  reservationId: string | null;
  providerMessageId: string | null;
  providerThreadRef?: string | null;
  segments?: number | null;
  providerConversationId?: string | null;
}

/**
 * Records a message the provider accepted: sent (a delivery status a callback already recorded is kept), the conversation's last activity,
 * the follow-up step, and the usage. The usage settles the message's hold; if the hold is no longer held (it expired, or the scheduler
 * released it) the usage is charged directly instead, so a message the provider took is always recorded as sent and billed once.
 */
async function recordAccepted(db: Queryable, a: Accepted): Promise<void> {
  const pmid = a.providerMessageId && a.providerMessageId.length <= 160 ? a.providerMessageId : null;
  await db.query(
    `update conversation_messages set status = case when status in ('delivered', 'read', 'failed') then status else 'sent' end,
       sent_at = coalesce(sent_at, now()), provider = $2, provider_message_id = coalesce($3, provider_message_id),
       status_detail = case when status in ('delivered', 'read', 'failed') then status_detail else null end,
       provider_thread_ref = coalesce($4, provider_thread_ref), segments_actual = coalesce(segments_actual, $5)
     where id = $1`,
    [a.m.id, a.provider, pmid, a.providerThreadRef && a.providerThreadRef.length <= 998 ? a.providerThreadRef : null, a.segments ?? null],
  );
  await db.query(
    `update conversations set last_outbound_at = now(), last_message_at = now(), last_message_preview = left($2, 200), ghl_conversation_id = coalesce(ghl_conversation_id, $3) where id = $1`,
    [a.m.conversation_id, maskCustomerLinks(a.m.body), a.provider === "ghl" ? (a.providerConversationId ?? null) : null],
  );
  if (a.m.followup_step_id) {
    await db.query("update follow_up_steps set status = 'sent', message_id = $2 where id = $1", [a.m.followup_step_id, a.m.id]);
    const { settlePlansForStep } = await import("@/server/messaging/followups");
    await settlePlansForStep(db, a.m.followup_step_id);
  }
  if (!a.reservationId) return;
  const usage = {
    provider: a.provider,
    unitType: a.unit,
    quantity: a.quantity,
    wholesaleMicros: Math.ceil(a.wholesalePerUnitMicros * a.quantity),
    providerReference: `${a.provider}:${pmid ?? a.m.id}`,
    jobReference: `msg:${a.m.id}`,
    messageId: a.m.id,
  };
  const hold = await db.query<{ status: string }>("select status from usage_reservations where id = $1 and org_id = $2", [a.reservationId, a.m.org_id]);
  if (hold.rows[0]?.status === "held") await settleReservation(db, { orgId: a.m.org_id, reservationId: a.reservationId, usage });
  else await chargeUsage(db, { orgId: a.m.org_id, usage });
}

/**
 * Sends one queued message. The claim and the final rule check happen in one transaction, the provider call happens outside
 * any transaction, and the result is recorded in a second one. A send whose outcome is unknown is never repeated automatically.
 * The channel's provider (messaging_channels.provider) carries it; deps can replace a transport by name for tests.
 */
export async function dispatchMessage(messageId: string, deps: DispatchDeps = {}): Promise<{ status: MessageStatus | "skipped" }> {
  const now = deps.now ?? new Date();
  const claim = await withSystem(async (db): Promise<Prepared | { done: "queued" | "blocked" } | null> => {
    const { rows } = await db.query<MessageRow>(
      `update conversation_messages set status = 'sending', attempt_count = attempt_count + 1, claimed_at = now()
       where id = $1 and status = 'queued' and send_after <= $2
       returning id, org_id, conversation_id, author_kind, author_user_id, agent_id, body, scope, purpose, template_id, approval_id, followup_step_id, reservation_id, ownership_fence, attempt_count, created_at, dedupe_key,
         (select channel from conversations where id = conversation_id) as channel, (select subject from conversations where id = conversation_id) as subject,
         (select contact_id from conversations where id = conversation_id) as contact_id`,
      [messageId, now.toISOString()],
    );
    const m = rows[0];
    if (!m) return null;
    // The message's credit hold may have lapsed while it waited (quiet hours, a provider switch). Then it is checked like a new send: the
    // balance and budget are read again, and a fresh hold is taken below before anything leaves.
    const holdStatus = m.reservation_id
      ? (await db.query<{ status: string }>("select status from usage_reservations where id = $1 and org_id = $2 for update", [m.reservation_id, m.org_id])).rows[0]?.status ?? null
      : null;
    const held = holdStatus === "held";
    // The checks that need the message itself (src/server/messaging/dispatch-gate.ts): a paused or inactive workspace holds a program message, and a person's hold on the customer stops
    // an automatic one.
    const gate = await dispatchGate(db, m, now);
    if (gate?.action === "hold") {
      await db.query("update conversation_messages set status = 'queued', send_after = $2, status_detail = $3, attempt_count = attempt_count - 1 where id = $1", [m.id, gate.retryAt, gate.detail.slice(0, 300)]);
      if (held) await extendHold(db, m.org_id, m.reservation_id, gate.retryAt);
      return { done: "queued" };
    }
    if (gate?.action === "block") {
      await finishBlocked(db, m, gate.reason, gate.detail);
      const { settleHeldAsks } = await import("@/server/retention/hold");
      await settleHeldAsks(db, m.org_id, [m.id]);
      return { done: "blocked" };
    }
    const decision = await evaluateSend(db, { ...requestFor(m, now), hasReservation: held });
    if (!decision.allow) {
      if (decision.retryAt && !decision.permanent && WAITING_REASONS.has(decision.reason)) {
        await db.query("update conversation_messages set status = 'queued', send_after = $2, attempt_count = attempt_count - 1 where id = $1", [m.id, decision.retryAt]);
        if (held) await extendHold(db, m.org_id, m.reservation_id, decision.retryAt);
        return { done: "queued" };
      }
      await finishBlocked(db, m, decision.reason, decision.detail);
      return { done: "blocked" };
    }
    let reservationId = m.reservation_id;
    if (m.reservation_id && !held) {
      try {
        const hold = await reserveCredits(db, {
          orgId: m.org_id,
          estimateMicros: Math.max(1, decision.estimateMicros),
          purpose: `${m.channel} message`,
          jobReference: `msg:${m.id}:${crypto.randomUUID().slice(0, 8)}`,
          ttlSeconds: HOLD_TTL_SECONDS,
        });
        reservationId = hold.id;
        await db.query("update conversation_messages set reservation_id = $2 where id = $1", [m.id, hold.id]);
      } catch (err) {
        if (!(err instanceof BillingBlockedError)) throw err;
        const reason = err.reason === "budget_exceeded" ? "budget" : "credits";
        await finishBlocked(db, { ...m, reservation_id: null }, reason, err.message);
        return { done: "blocked" };
      }
    }
    // A hold that is still held is kept alive past this attempt, so the scheduler can't release it while the provider is being called.
    if (held) await extendHold(db, m.org_id, m.reservation_id, now);

    // A reminder's link to manage the booking is a bearer secret, so the stored body only holds a placeholder. A fresh link is issued for
    // this attempt and exists only in the provider payload; when the booking can no longer be changed online the sentence is left out.
    let body = m.body;
    let manageLink: Prepared["manageLink"] = null;
    if (hasManageLinkPlaceholder(body)) {
      let url: string | null = null;
      if (m.scope === "reminder") {
        const { issueReminderManageLink } = await import("@/server/appointments/reminders");
        const issued = await issueReminderManageLink(db, m.org_id, m.id, now);
        if (issued) {
          url = issued.url;
          manageLink = { appointmentId: issued.appointmentId, token: issued.token };
        }
      }
      body = fillManageLink(body, url);
      if (!body.trim()) {
        await finishBlocked(db, { ...m, reservation_id: reservationId }, "appointment_changed", "Nothing was left to send once the booking link was removed.");
        return { done: "blocked" };
      }
    }
    // A review request's private link is a bearer secret too: the stored body holds {{review.link}}, and the link (derived again from the
    // request, src/server/crm/reviews.ts) exists only in the provider payload. Without its request the message isn't sent at all.
    if (hasReviewLinkPlaceholder(body)) {
      const { reviewLinkForMessage } = await import("@/server/crm/reviews");
      const link = await reviewLinkForMessage(db, m.org_id, m.id);
      if (!link) {
        await finishBlocked(db, { ...m, reservation_id: reservationId }, "review_link_unavailable", "The customer's review link couldn't be issued (the request was cancelled or no longer exists), so nothing was sent.");
        return { done: "blocked" };
      }
      body = fillReviewLink(body, link);
    }
    // An invoice reminder's link to the customer's invoice page is a bearer secret as well. It is derived again here, from the invoice the reminder belongs to, and only while that
    // invoice can still be paid online (issued, owing, not written off). Any other message that carries the placeholder, or a reminder for an invoice paid in the meantime, is not sent.
    if (hasInvoiceLinkPlaceholder(body)) {
      const { invoiceLinkForMessage } = await import("@/server/invoices/reminders");
      const link = await invoiceLinkForMessage(db, m.org_id, m.id);
      if (!link) {
        await finishBlocked(db, { ...m, reservation_id: reservationId }, "invoice_link_unavailable", "The invoice can no longer be paid online (it was paid, voided or written off), so the reminder was not sent.");
        return { done: "blocked" };
      }
      body = fillInvoiceLink(body, link);
    }
    // Billing follows what is actually sent: a filled-in link can add an SMS segment.
    const quantity = m.channel === "sms" ? Math.max(1, smsSegments(body)) : decision.quantity;
    const thread = m.channel === "email" ? await emailThread(db, m.conversation_id) : { inReplyTo: null, references: [] };
    return { m, decision, reservationId, body, quantity, manageLink, thread };
  });
  if (!claim) return { status: "skipped" };
  if ("done" in claim) return { status: claim.done };
  const { m, decision, reservationId, body, quantity, manageLink, thread } = claim;

  const transport = transportForDispatch(decision.provider, deps);
  const template = decision.template;
  const request: GhlTransportRequest = {
    orgId: m.org_id,
    channel: m.channel,
    messageId: m.id,
    to: decision.address,
    contactRef: decision.contactRef,
    body,
    subject: m.subject,
    inReplyTo: thread.inReplyTo,
    references: thread.references,
    // Marketing email carries a one-click unsubscribe; issued at the message's creation time so every attempt carries the same link.
    unsubscribeUrl: m.channel === "email" && m.purpose === "marketing" ? buildUnsubscribeUrl(m.org_id, m.contact_id, "email", { purpose: "marketing", issuedAt: new Date(m.created_at) }) : null,
    template: template ? { name: template.name, language: template.language, params: whatsappTemplateParams(template.body, body) } : null,
    sender: decision.sender,
    // GoHighLevel addresses its template by our template id; the other transports ignore this field.
    templateId: m.template_id,
  };

  let result: TransportResult;
  try {
    result = await transport.send(request);
  } catch (err) {
    // A transport that throws gives no answer either way. Like a timeout, that is "not confirmed sent", never safe to repeat.
    console.error("[iacquire] messaging transport threw", { provider: transport.name, messageId: m.id, error: err instanceof Error ? err.name : "unknown" });
    result = { ok: false, retryable: false, error: `${TRANSPORT_LABELS[decision.provider] ?? "The provider"} did not answer. The message was not confirmed sent.` };
  }
  const providerName = decision.provider;
  const accepted = (providerMessageId: string | null, extra: Partial<Accepted> = {}): Accepted => ({
    m,
    provider: providerName,
    unit: decision.unit,
    quantity,
    wholesalePerUnitMicros: decision.wholesalePerUnitMicros,
    reservationId,
    providerMessageId,
    ...extra,
  });

  return withSystem(async (db) => {
    if (result.ok) {
      // A delivery callback may have arrived while the call was in flight (it is matched by our message id): keep what it recorded.
      const segments = m.channel === "sms" && result.quantity && Number.isInteger(result.quantity) && result.quantity >= 1 && result.quantity <= 50 ? result.quantity : null;
      await recordAccepted(db, accepted(result.providerMessageId, { providerThreadRef: result.providerThreadRef, segments, providerConversationId: result.providerConversationId }));
      return { status: "sent" as const };
    }
    // The provider's own status callback (matched by our message id) can arrive while our call is still waiting, and our call can then
    // time out. If a callback already recorded the provider's id or moved the row past "sending", the provider took the message: it is
    // recorded as sent and billed, never failed, re-queued or reported as undeliverable.
    const current = (await db.query<{ status: MessageStatus; provider_message_id: string | null }>("select status, provider_message_id from conversation_messages where id = $1 for update", [m.id])).rows[0];
    if (current && (current.provider_message_id || ["sent", "delivered", "read"].includes(current.status))) {
      await recordAccepted(db, accepted(current.provider_message_id));
      const after = (await db.query<{ status: MessageStatus }>("select status from conversation_messages where id = $1", [m.id])).rows[0];
      return { status: after?.status ?? ("sent" as const) };
    }
    // Something else already finished this attempt (the stuck-send recovery, a person): nothing more to do here.
    if (!current || current.status !== "sending") return { status: current?.status ?? ("skipped" as const) };
    // The provider did not take the message at all, so a link issued for it can be withdrawn. After any other failure the outcome may be
    // unknown (a timeout), and the customer may hold the link, so it stays valid until it expires.
    if (result.blocked && manageLink) {
      const { revokeManageLinks } = await import("@/server/calendars/booking");
      await revokeManageLinks(db, m.org_id, manageLink.appointmentId, { token: manageLink.token });
    }
    const row = { ...m, reservation_id: reservationId };
    if (result.suppress) {
      // The provider refused because of the address itself (opted out with the carrier, invalid, bouncing): nothing more goes to it.
      await suppressAddress(db, { orgId: m.org_id, channel: m.channel, address: decision.address, reason: result.suppress, source: `${providerName}_send` });
      await finishBlocked(db, row, "suppressed", result.error);
      return { status: "blocked" as const };
    }
    if (result.windowClosed) {
      await finishBlocked(db, row, "whatsapp_window_closed", result.error);
      return { status: "blocked" as const };
    }
    if (result.blocked) {
      await finishBlocked(db, row, "provider_not_enabled", result.error);
      if (result.reconnectRequired) await notifyReconnect(db, m.org_id, providerName);
      return { status: "blocked" as const };
    }
    if (result.retryable && m.attempt_count < 3) {
      const retryAt = new Date(now.getTime() + 2 ** m.attempt_count * 60_000);
      await db.query("update conversation_messages set status = 'queued', send_after = $2, status_detail = $3 where id = $1 and status = 'sending'", [m.id, retryAt, result.error.slice(0, 300)]);
      await extendHold(db, m.org_id, reservationId, retryAt);
      return { status: "queued" as const };
    }
    // "rejected": the provider refused it, so the customer has nothing. "unconfirmed": we never heard back, so they might (see unconfirmedOutcome).
    await db.query("update conversation_messages set status = 'failed', failed_at = now(), status_detail = $2, blocked_reason = 'provider_error', failure_kind = $3 where id = $1 and status = 'sending'", [m.id, result.error.slice(0, 300), unconfirmedOutcome(result.error) ? "unconfirmed" : "rejected"]);
    if (reservationId) await releaseReservation(db, { orgId: m.org_id, reservationId, reason: "Send failed" });
    if (m.followup_step_id) await db.query("update follow_up_steps set status = 'blocked', reason = 'provider_error' where id = $1", [m.followup_step_id]);
    await notifyOrgRoles(db, m.org_id, ["owner", "admin"], { kind: "message_failed", severity: "warning", title: "A message could not be sent", body: result.error.slice(0, 200), link: "/inbox", dedupeKey: `failed:${m.id}` });
    if (result.reconnectRequired) await notifyReconnect(db, m.org_id, providerName);
    return { status: "failed" as const };
  });
}

/** How long a claimed send may stay unconfirmed before the worker stops waiting for it. */
const STUCK_AFTER = "10 minutes";

/**
 * Settles the hold of a message the provider took although its send result was never recorded: a status callback recorded the provider's id
 * or moved the row past "sending", and then the worker stopped (crash, timeout). It is billed at the provider's published rate for what
 * was sent; without a published rate the hold is released instead of inventing a price.
 */
async function settleOrphanedSend(db: Queryable, r: { id: string; org_id: string; conversation_id: string; body: string; followup_step_id: string | null; reservation_id: string; provider: string | null; provider_message_id: string | null; segments_actual: number | null; channel: Channel }) {
  const provider: TransportName = isTransportName(r.provider) ? r.provider : await channelProvider(db, r.org_id, r.channel);
  const unit = UNIT_FOR[r.channel];
  const quantity = r.channel === "sms" ? (r.segments_actual ?? Math.max(1, smsSegments(r.body))) : 1;
  const rate = await publishedRate(db, provider, unit);
  if (!rate) {
    await releaseReservation(db, { orgId: r.org_id, reservationId: r.reservation_id, reason: "Sent, but no published rate to bill it at" });
    return;
  }
  await recordAccepted(db, { m: r, provider, unit, quantity, wholesalePerUnitMicros: rate.wholesale, reservationId: r.reservation_id, providerMessageId: r.provider_message_id });
}

/**
 * Worker entry point: sends due queued messages, and fails sends whose outcome was never recorded instead of repeating them. A send whose
 * provider confirmed it through a callback is recorded as sent and billed instead. One message failing never stops the others.
 */
export async function dispatchDue(deps: DispatchDeps & { limit?: number } = {}): Promise<{ attempted: number; recovered: number }> {
  const now = deps.now ?? new Date();
  const recovered = await withSystem(async (db) => {
    const res = await db.query<{ id: string; org_id: string; reservation_id: string | null }>(
      `update conversation_messages set status = 'failed', failed_at = now(), blocked_reason = 'provider_error', failure_kind = 'unconfirmed',
         status_detail = 'The send was started but never confirmed. It was not repeated automatically, to avoid messaging the customer twice.'
       where status = 'sending' and provider_message_id is null and claimed_at < $1::timestamptz - interval '${STUCK_AFTER}' returning id, org_id, reservation_id`,
      [now.toISOString()],
    );
    for (const r of res.rows) if (r.reservation_id) await releaseReservation(db, { orgId: r.org_id, reservationId: r.reservation_id, reason: "Unconfirmed send" });
    return res.rows.length;
  });
  const { rows: orphans } = await withSystem((db) =>
    db.query<{ id: string }>(
      `select m.id from conversation_messages m join usage_reservations r on r.id = m.reservation_id and r.org_id = m.org_id and r.status = 'held'
       where m.direction = 'outbound' and m.claimed_at < $1::timestamptz - interval '${STUCK_AFTER}' and (m.provider_message_id is not null or m.status in ('sent', 'delivered', 'read'))
       order by m.claimed_at limit 100`,
      [now.toISOString()],
    ),
  );
  let settled = 0;
  for (const { id } of orphans) {
    try {
      const done = await withSystem(async (db) => {
        const { rows } = await db.query<Parameters<typeof settleOrphanedSend>[1] & { status: string; hold: string | null }>(
          `select m.id, m.org_id, m.conversation_id, m.body, m.followup_step_id, m.reservation_id, m.provider, m.provider_message_id, m.segments_actual, m.status, c.channel,
                  (select r.status from usage_reservations r where r.id = m.reservation_id) as hold
           from conversation_messages m join conversations c on c.id = m.conversation_id where m.id = $1 for update of m`,
          [id],
        );
        const r = rows[0];
        // Re-checked under the lock: the dispatcher may have recorded it in the meantime.
        if (!r || r.hold !== "held" || !(r.provider_message_id || ["sent", "delivered", "read"].includes(r.status))) return false;
        await settleOrphanedSend(db, r);
        return true;
      });
      if (done) settled += 1;
    } catch (err) {
      console.error("[iacquire] settling a confirmed send failed", { messageId: id, error: err instanceof Error ? err.name : "unknown" });
    }
  }
  const { rows } = await withSystem((db) => db.query<{ id: string }>("select id from conversation_messages where status = 'queued' and send_after <= $1 order by send_after limit $2", [now.toISOString(), deps.limit ?? 25]));
  for (const row of rows) {
    try {
      await dispatchMessage(row.id, deps);
    } catch (err) {
      // One message whose result couldn't be recorded must not hold back the rest of the batch. Its row stays "sending" and the recovery
      // above deals with it on a later run.
      console.error("[iacquire] dispatching a message failed", { messageId: row.id, error: err instanceof Error ? err.name : "unknown" });
    }
  }
  return { attempted: rows.length, recovered: recovered + settled };
}

/**
 * Stops every not-yet-sent AI message in a conversation (used when a person takes over or automation is stopped). `queuedOnly` leaves the
 * drafts waiting for a person's approval alone: a paused AI keeps its drafts, because approving one is that person's own decision.
 */
export async function cancelPendingAiMessages(db: Queryable, orgId: string, conversationId: string, reason: string, opts: { queuedOnly?: boolean } = {}) {
  const { rows } = await db.query<{ id: string; reservation_id: string | null; followup_step_id: string | null }>(
    `update conversation_messages set status = 'blocked', blocked_reason = $3, status_detail = 'Stopped before sending.'
     where org_id = $1 and conversation_id = $2 and (author_kind = 'ai' or dedupe_key like 'mcc:%') and direction = 'outbound' and status = any($4::text[])
     returning id, reservation_id, followup_step_id`,
    [orgId, conversationId, reason, opts.queuedOnly ? ["queued"] : ["draft", "queued"]],
  );
  for (const m of rows) {
    if (m.reservation_id) await releaseReservation(db, { orgId, reservationId: m.reservation_id, reason: `Stopped: ${reason}` });
    if (m.followup_step_id) await db.query("update follow_up_steps set status = 'cancelled', reason = $2 where id = $1", [m.followup_step_id, reason]);
  }
  return rows.length;
}

export type DeliveryStatus = "sent" | "delivered" | "read" | "failed" | "undelivered";
export type DeliverySuppression = "bounce" | "complaint" | "invalid" | "opt_out";

export interface DeliveryEventInput {
  provider: string;
  providerEventId: string;
  providerMessageId: string;
  status: DeliveryStatus;
  /** The provider's own status word (Resend "delivery_delayed", Twilio "undelivered"), kept next to the normalized status. */
  rawStatus?: string | null;
  occurredAt?: Date;
  detail?: string;
  /** The provider says the address is bad, the recipient complained or opted out; the address is suppressed. */
  suppress?: DeliverySuppression;
  /** Billable units the provider reports for the message (Twilio NumSegments), kept for reconciliation. */
  segments?: number | null;
}

export type DeliveryResult = { result: "applied" | "duplicate" | "unknown_message" | "no_change"; status?: MessageStatus };

interface DeliveryTarget {
  id: string;
  org_id: string;
  status: MessageStatus;
  conversation_id: string;
}

/** Records the event against one locked message row and moves its status forward if the event allows. */
async function recordDelivery(db: Queryable, m: DeliveryTarget, e: Omit<DeliveryEventInput, "providerMessageId">): Promise<DeliveryResult> {
  const inserted = await db.query(
    `insert into message_delivery_events (org_id, message_id, provider, provider_event_id, status, raw_status, detail, occurred_at) values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (provider, provider_event_id) do nothing returning id`,
    [m.org_id, m.id, e.provider, e.providerEventId, e.status, e.rawStatus?.slice(0, 60) || null, e.detail?.slice(0, 300) ?? null, e.occurredAt ?? new Date()],
  );
  if (!inserted.rows[0]) return { result: "duplicate" };
  if (e.segments && Number.isInteger(e.segments) && e.segments >= 1 && e.segments <= 50) {
    await db.query("update conversation_messages set segments_actual = $2 where id = $1", [m.id, e.segments]);
  }
  if (e.suppress) {
    const conv = await db.query<{ channel: Channel; contact_id: string }>("select channel, contact_id from conversations where id = $1", [m.conversation_id]);
    const address = conv.rows[0] ? await contactAddress(db, m.org_id, conv.rows[0].contact_id, conv.rows[0].channel) : null;
    if (address && conv.rows[0]) await suppressAddress(db, { orgId: m.org_id, channel: conv.rows[0].channel, address, reason: e.suppress, source: "delivery_event" });
  }
  const next = advancesDelivery(m.status, e.status);
  if (!next) return { result: "no_change", status: m.status };
  await db.query(
    `update conversation_messages set status = $2, status_detail = $3,
       delivered_at = case when $2 in ('delivered', 'read') then coalesce(delivered_at, $4) else delivered_at end,
       failed_at = case when $2 = 'failed' then $4 else failed_at end,
       failure_kind = case when $2 = 'failed' then 'rejected' else failure_kind end where id = $1`,
    [m.id, next, e.detail?.slice(0, 300) ?? null, e.occurredAt ?? new Date()],
  );
  return { result: "applied", status: next };
}

/**
 * Applies a provider delivery event found by the provider's message id. "Delivered" exists only because a provider said so, status never
 * moves backwards, and the same event delivered twice changes nothing.
 */
export async function applyDeliveryEvent(db: Queryable, e: DeliveryEventInput): Promise<DeliveryResult> {
  const { rows } = await db.query<DeliveryTarget>(
    "select id, org_id, status, conversation_id from conversation_messages where provider = $1 and provider_message_id = $2 for update",
    [e.provider, e.providerMessageId],
  );
  const m = rows[0];
  if (!m) return { result: "unknown_message" };
  return recordDelivery(db, m, e);
}

export interface MessageDeliveryEventInput extends Omit<DeliveryEventInput, "providerMessageId"> {
  /** Our conversation_messages id, which the provider echoes back (Twilio status callback URL, Resend tag, Meta callback data). */
  messageId: string;
  /** The provider's id for the message, when the event carries it. Recorded if the send has not returned yet. */
  providerMessageId?: string | null;
  /** The workspace the webhook belongs to, when it knows (it found the tenant by sender). The message must be that workspace's. */
  orgId?: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Applies a delivery event correlated by our own message id, so a status callback that arrives before the send call returned (and before
 * the provider's id was stored) is still recorded. The workspace comes from the message row, never from the event. An event is refused
 * as unknown when the message went through a different provider, or when it names a provider id other than the one already stored.
 * The provider id is recorded when it was not yet; the dispatcher writes the same value when the call returns. Idempotent per event id.
 */
export async function applyDeliveryEventForMessage(db: Queryable, e: MessageDeliveryEventInput): Promise<DeliveryResult> {
  if (!UUID.test(e.messageId)) return { result: "unknown_message" };
  const { rows } = await db.query<DeliveryTarget & { provider: string | null; provider_message_id: string | null; channel_provider: string | null }>(
    `select m.id, m.org_id, m.status, m.conversation_id, m.provider, m.provider_message_id,
            (select mc.provider from messaging_channels mc where mc.org_id = m.org_id and mc.channel = c.channel) as channel_provider
     from conversation_messages m join conversations c on c.id = m.conversation_id
     where m.id = $1 and m.direction = 'outbound' for update of m`,
    [e.messageId],
  );
  const m = rows[0];
  if (!m || (e.orgId && e.orgId !== m.org_id)) return { result: "unknown_message" };
  // Before the send returned, the message has no provider yet: the event must come from the provider that carries its channel.
  if ((m.provider ?? m.channel_provider ?? "ghl") !== e.provider) return { result: "unknown_message" };
  const pmid = e.providerMessageId?.trim() || null;
  if (pmid && m.provider_message_id && m.provider_message_id !== pmid) return { result: "unknown_message" };
  if (pmid && pmid.length <= 160 && !m.provider_message_id) {
    await db.query(
      `update conversation_messages set provider = $2, provider_message_id = $3 where id = $1 and provider_message_id is null
         and not exists (select 1 from conversation_messages x where x.provider = $2 and x.provider_message_id = $3)`,
      [m.id, e.provider, pmid],
    );
  }
  return recordDelivery(db, m, e);
}
