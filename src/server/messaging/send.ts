import "server-only";
import crypto from "node:crypto";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { notifyOrgRoles } from "@/server/notifications";
import { automationGate } from "@/server/automation/gate";
import { createApproval } from "@/server/approvals/service";
import { BillingBlockedError, reserveCredits, releaseReservation, settleReservation, monthToDateSpendMicros, getBalance } from "@/server/billing/ledger";
import { contactAddress, getConsent, isSuppressed } from "@/server/messaging/contacts";
import { ghlProvider, type ChannelProvider } from "@/server/messaging/provider";
import {
  advancesDelivery,
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

export type SendScope = "reply" | "followup" | "human";
export type SendActor = { kind: "ai"; agentId: string | null; approvalId?: string | null } | { kind: "human"; userId: string };

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
}

export type SendDecision =
  | { allow: true; unit: UnitType; quantity: number; estimateMicros: number; wholesalePerUnitMicros: number; address: string; contactRef: string | null; fromIdentity: string | null; channel: Channel }
  | { allow: false; reason: string; detail: string; retryAt?: Date; permanent?: boolean; needsApproval?: boolean };

const UNIT_FOR: Record<Channel, UnitType> = { sms: "sms_segment", whatsapp: "whatsapp_message", email: "email_send" };

const deny = (reason: string, detail: string, extra: Partial<Extract<SendDecision, { allow: false }>> = {}): SendDecision => ({ allow: false, reason, detail, ...extra });

interface ConversationRow {
  id: string;
  contact_id: string;
  channel: Channel;
  owner_kind: "ai" | "human" | "unassigned";
  owner_user_id: string | null;
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
    `select c.id, c.contact_id, c.channel, c.owner_kind, c.owner_user_id, c.last_inbound_at, c.subject,
            k.deleted_at as contact_deleted, k.ghl_contact_id, k.timezone as contact_tz, o.timezone as org_tz, o.name as org_name
     from conversations c join contacts k on k.id = c.contact_id and k.org_id = c.org_id join organizations o on o.id = c.org_id
     where c.id = $1 and c.org_id = $2`,
    [req.conversationId, req.orgId],
  );
  const conv = rows[0];
  if (!conv) throw new AppError("not_found", "Conversation not found.");
  const channel = conv.channel;
  if (conv.contact_deleted) return deny("contact_unreachable", "This contact was removed.", { permanent: true });

  if (req.actor.kind === "ai") {
    // A person owns the conversation: the AI never sends, and queued sends stay blocked after retries and restarts.
    if (conv.owner_kind !== "ai") return deny("human_owner", "A person has taken over this conversation.", { permanent: true });
    // While someone is being asked to take over, the AI holds off so it cannot promise a human reply that nobody has accepted.
    const pending = await db.query("select 1 from human_escalations where conversation_id = $1 and status in ('awaiting_owner', 'open')", [req.conversationId]);
    if (pending.rows[0]) return deny("escalation_pending", "A person is being asked to take over this conversation.");
    const gate = await automationGate(db, { orgId: req.orgId, agentId: req.actor.agentId, scope: req.scope === "followup" ? "followup" : "reply", approvalId: req.actor.approvalId ?? null });
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
  if (!conv.ghl_contact_id) return deny("contact_unreachable", "This contact is not linked to your CRM yet, so the provider cannot deliver to them.");

  if (await isSuppressed(db, req.orgId, channel, address)) return deny("suppressed", "This address opted out or bounced, so nothing can be sent to it.", { permanent: true });
  const consent = await getConsent(db, req.orgId, conv.contact_id, channel, "service");
  if (consent === "revoked") return deny("no_consent", "This customer withdrew consent on this channel.", { permanent: true });
  if (consent === "unknown" && (req.scope === "followup" || !conv.last_inbound_at)) return deny("no_consent", "There is no consent on record to message this person.", { permanent: true });

  const { rows: chan } = await db.query<{ enabled: boolean; sender_identity: string | null }>("select enabled, sender_identity from messaging_channels where org_id = $1 and channel = $2", [req.orgId, channel]);
  if (!chan[0]?.enabled) return deny("channel_not_ready", `${channel === "sms" ? "SMS" : channel === "whatsapp" ? "WhatsApp" : "Email"} is not verified and enabled for this workspace yet.`);

  const { rows: policyRows } = await db.query<{ max_followups_per_contact_30d: number; min_hours_between_followups: number; quiet_hours_start: string; quiet_hours_end: string; whatsapp_window_hours: number }>("select * from messaging_policy");
  const policy = policyRows[0];
  if (channel === "whatsapp") {
    if (req.templateId) {
      const t = await db.query("select 1 from whatsapp_templates where org_id = $1 and template_id = $2 and status = 'approved'", [req.orgId, req.templateId]);
      if (!t.rows[0]) return deny("whatsapp_window_closed", "That WhatsApp template is not approved.");
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

  const quantity = channel === "sms" ? Math.max(1, smsSegments(req.body)) : 1;
  const unit = UNIT_FOR[channel];
  const { rows: rate } = await db.query<{ w: string; c: string }>(
    `select r.wholesale_micros_per_unit::text as w, r.client_micros_per_unit::text as c from usage_unit_rates r
     join usage_rate_versions v on v.id = r.rate_version_id where r.provider = 'ghl' and r.unit_type = $1 order by v.version desc limit 1`,
    [unit],
  );
  if (!rate[0]) return deny("rate_not_published", "iAcquire has not published a usage rate for this channel yet, so it cannot be billed.");
  const estimate = Math.ceil(Number(rate[0].c) * quantity);
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
  if (req.scope === "followup") {
    const { rows: s } = await db.query<{ business_hours: unknown }>("select business_hours from messaging_settings where org_id = $1", [req.orgId]);
    const hours = validateBusinessHours(s[0]?.business_hours ?? {});
    const bhOnly = req.businessHoursOnly !== false;
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

  return { allow: true, unit, quantity, estimateMicros: estimate, wholesalePerUnitMicros: Number(rate[0].w), address, contactRef: conv.ghl_contact_id, fromIdentity: chan[0].sender_identity, channel };
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
  const decision = await evaluateSend(db, req);
  const messageId = crypto.randomUUID();
  const author = req.actor.kind === "ai" ? { kind: "ai", userId: null, agentId: req.actor.agentId } : { kind: "human", userId: req.actor.userId, agentId: null };
  const insert = (status: string, extra: { reason?: string; detail?: string; sendAfter?: Date; reservationId?: string | null }) =>
    db.query(
      `insert into conversation_messages (id, org_id, conversation_id, direction, author_kind, author_user_id, agent_id, body, status, status_detail, blocked_reason, scope,
         template_id, approval_id, followup_step_id, reservation_id, send_after, dedupe_key, queued_at)
       values ($1, $2, $3, 'outbound', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, case when $8 = 'queued' then now() end)`,
      [messageId, req.orgId, req.conversationId, author.kind, author.userId, author.agentId, req.body, status, extra.detail?.slice(0, 300) ?? null, extra.reason ?? null, req.scope,
        req.templateId ?? null, req.approvalId ?? (req.actor.kind === "ai" ? req.actor.approvalId ?? null : null), req.followupStepId ?? null, extra.reservationId ?? null, extra.sendAfter ?? new Date(), req.dedupeKey ?? null],
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
        title: req.scope === "followup" ? "Send AI follow-up to a customer" : "Send AI reply to a customer",
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
    // Time rules wait; everything else is final for now and is recorded so it is visible.
    if (decision.retryAt && !decision.permanent && ["quiet_hours", "outside_business_hours", "followup_too_soon"].includes(decision.reason)) {
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
  const quantity = channel === "sms" ? Math.max(1, smsSegments(req.body)) : 1;
  const { rows: rate } = await db.query<{ c: string }>(
    `select r.client_micros_per_unit::text as c from usage_unit_rates r join usage_rate_versions v on v.id = r.rate_version_id
     where r.provider = 'ghl' and r.unit_type = $1 order by v.version desc limit 1`,
    [UNIT_FOR[channel]],
  );
  const estimate = opts.decision?.estimateMicros ?? Math.ceil(Number(rate[0].c) * quantity);
  try {
    const hold = await reserveCredits(db, { orgId: req.orgId, estimateMicros: Math.max(1, estimate), purpose: `${channel} message`, jobReference: `msg:${messageId}`, ttlSeconds: 6 * 3600 });
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
  template_id: string | null;
  approval_id: string | null;
  followup_step_id: string | null;
  reservation_id: string | null;
  attempt_count: number;
  channel: Channel;
  subject: string | null;
}

function requestFor(m: MessageRow, now: Date): SendRequest {
  return {
    orgId: m.org_id,
    conversationId: m.conversation_id,
    scope: m.scope,
    actor: m.author_kind === "ai" ? { kind: "ai", agentId: m.agent_id, approvalId: m.approval_id } : { kind: "human", userId: m.author_user_id ?? "" },
    body: m.body,
    templateId: m.template_id,
    now,
    hasReservation: Boolean(m.reservation_id),
  };
}

const PERMANENT_STEP_REASONS = new Set(["human_owner", "suppressed", "no_consent", "automation_paused", "org_inactive", "agent_not_ready", "followup_limit", "contact_unreachable"]);

async function finishBlocked(db: Queryable, m: MessageRow, reason: string, detail: string) {
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

/**
 * Sends one queued message. The claim and the final rule check happen in one transaction, the provider call happens outside
 * any transaction, and the result is recorded in a second one. A send whose outcome is unknown is never repeated automatically.
 */
export async function dispatchMessage(messageId: string, deps: { provider?: ChannelProvider; now?: Date } = {}): Promise<{ status: MessageStatus | "skipped" }> {
  const provider = deps.provider ?? ghlProvider;
  const now = deps.now ?? new Date();
  const claim = await withSystem(async (db) => {
    const { rows } = await db.query<MessageRow>(
      `update conversation_messages set status = 'sending', attempt_count = attempt_count + 1, claimed_at = now()
       where id = $1 and status = 'queued' and send_after <= $2
       returning id, org_id, conversation_id, author_kind, author_user_id, agent_id, body, scope, template_id, approval_id, followup_step_id, reservation_id, attempt_count,
         (select channel from conversations where id = conversation_id) as channel, (select subject from conversations where id = conversation_id) as subject`,
      [messageId, now.toISOString()],
    );
    const m = rows[0];
    if (!m) return null;
    const decision = await evaluateSend(db, requestFor(m, now));
    if (!decision.allow) {
      if (decision.retryAt && !decision.permanent && ["quiet_hours", "outside_business_hours", "followup_too_soon"].includes(decision.reason)) {
        await db.query("update conversation_messages set status = 'queued', send_after = $2, attempt_count = attempt_count - 1 where id = $1", [m.id, decision.retryAt]);
        return { done: "queued" as const };
      }
      await finishBlocked(db, m, decision.reason, decision.detail);
      return { done: "blocked" as const };
    }
    return { m, decision };
  });
  if (!claim) return { status: "skipped" };
  if (claim.done) return { status: claim.done };
  const { m, decision } = claim;

  const result = await provider.send({ orgId: m.org_id, channel: m.channel, contactRef: decision.contactRef ?? "", body: m.body, subject: m.subject, templateId: m.template_id, fromIdentity: decision.fromIdentity, messageId: m.id });

  return withSystem(async (db) => {
    if (result.ok) {
      await db.query("update conversation_messages set status = 'sent', sent_at = now(), provider = $2, provider_message_id = $3, status_detail = null where id = $1", [m.id, provider.name, result.providerMessageId]);
      await db.query(
        `update conversations set last_outbound_at = now(), last_message_at = now(), last_message_preview = left($2, 200), ghl_conversation_id = coalesce(ghl_conversation_id, $3) where id = $1`,
        [m.conversation_id, m.body, result.providerConversationId ?? null],
      );
      if (m.followup_step_id) {
        await db.query("update follow_up_steps set status = 'sent', message_id = $2 where id = $1", [m.followup_step_id, m.id]);
        const { settlePlansForStep } = await import("@/server/messaging/followups");
        await settlePlansForStep(db, m.followup_step_id);
      }
      if (m.reservation_id) {
        await settleReservation(db, {
          orgId: m.org_id,
          reservationId: m.reservation_id,
          usage: {
            provider: "ghl",
            unitType: decision.unit,
            quantity: decision.quantity,
            wholesaleMicros: Math.ceil(decision.wholesalePerUnitMicros * decision.quantity),
            providerReference: `${provider.name}:${result.providerMessageId}`,
            jobReference: `msg:${m.id}`,
            messageId: m.id,
          },
        });
      }
      return { status: "sent" as const };
    }
    if (result.blocked) {
      await finishBlocked(db, m, "provider_not_enabled", result.error);
      if (result.reconnectRequired) {
        await notifyOrgRoles(db, m.org_id, ["owner", "admin"], { kind: "integration_reconnect_required", severity: "warning", title: "Reconnect GoHighLevel to send messages", body: "Messages are held until the connection is restored.", link: "/settings/integrations", dedupeKey: `reconnect:ghl:${new Date().toISOString().slice(0, 10)}` });
      }
      return { status: "blocked" as const };
    }
    if (result.retryable && m.attempt_count < 3) {
      const wait = 2 ** m.attempt_count * 60_000;
      await db.query("update conversation_messages set status = 'queued', send_after = $2, status_detail = $3 where id = $1", [m.id, new Date(now.getTime() + wait), result.error.slice(0, 300)]);
      return { status: "queued" as const };
    }
    await db.query("update conversation_messages set status = 'failed', failed_at = now(), status_detail = $2, blocked_reason = 'provider_error' where id = $1", [m.id, result.error.slice(0, 300)]);
    if (m.reservation_id) await releaseReservation(db, { orgId: m.org_id, reservationId: m.reservation_id, reason: "Send failed" });
    if (m.followup_step_id) await db.query("update follow_up_steps set status = 'blocked', reason = 'provider_error' where id = $1", [m.followup_step_id]);
    await notifyOrgRoles(db, m.org_id, ["owner", "admin"], { kind: "message_failed", severity: "warning", title: "A message could not be sent", body: result.error.slice(0, 200), link: "/inbox", dedupeKey: `failed:${m.id}` });
    if (result.reconnectRequired) {
      await notifyOrgRoles(db, m.org_id, ["owner", "admin"], { kind: "integration_reconnect_required", severity: "warning", title: "Reconnect GoHighLevel to send messages", link: "/settings/integrations", dedupeKey: `reconnect:ghl:${new Date().toISOString().slice(0, 10)}` });
    }
    return { status: "failed" as const };
  });
}

/** Worker entry point: sends due queued messages, and fails sends whose outcome was never recorded instead of repeating them. */
export async function dispatchDue(deps: { provider?: ChannelProvider; now?: Date; limit?: number } = {}): Promise<{ attempted: number; recovered: number }> {
  const now = deps.now ?? new Date();
  const recovered = await withSystem(async (db) => {
    const res = await db.query<{ id: string; org_id: string; reservation_id: string | null }>(
      `update conversation_messages set status = 'failed', failed_at = now(), blocked_reason = 'provider_error',
         status_detail = 'The send was started but never confirmed. It was not repeated automatically, to avoid messaging the customer twice.'
       where status = 'sending' and claimed_at < $1::timestamptz - interval '10 minutes' returning id, org_id, reservation_id`,
      [now.toISOString()],
    );
    for (const r of res.rows) if (r.reservation_id) await releaseReservation(db, { orgId: r.org_id, reservationId: r.reservation_id, reason: "Unconfirmed send" });
    return res.rows.length;
  });
  const { rows } = await withSystem((db) => db.query<{ id: string }>("select id from conversation_messages where status = 'queued' and send_after <= $1 order by send_after limit $2", [now.toISOString(), deps.limit ?? 25]));
  for (const row of rows) await dispatchMessage(row.id, deps);
  return { attempted: rows.length, recovered };
}

/** Stops every not-yet-sent AI message in a conversation (used when a person takes over or automation is stopped). */
export async function cancelPendingAiMessages(db: Queryable, orgId: string, conversationId: string, reason: string) {
  const { rows } = await db.query<MessageRow>(
    `update conversation_messages set status = 'blocked', blocked_reason = $3, status_detail = 'Stopped before sending.'
     where org_id = $1 and conversation_id = $2 and author_kind = 'ai' and direction = 'outbound' and status in ('draft', 'queued')
     returning id, org_id, conversation_id, author_kind, author_user_id, agent_id, body, scope, template_id, approval_id, followup_step_id, reservation_id, attempt_count, 'sms' as channel, null as subject`,
    [orgId, conversationId, reason],
  );
  for (const m of rows) {
    if (m.reservation_id) await releaseReservation(db, { orgId, reservationId: m.reservation_id, reason: `Stopped: ${reason}` });
    if (m.followup_step_id) await db.query("update follow_up_steps set status = 'cancelled', reason = $2 where id = $1", [m.followup_step_id, reason]);
  }
  return rows.length;
}

export interface DeliveryEventInput {
  provider: string;
  providerEventId: string;
  providerMessageId: string;
  status: "sent" | "delivered" | "read" | "failed" | "undelivered";
  occurredAt?: Date;
  detail?: string;
  /** The provider says the address is bad or the recipient complained; the address is suppressed. */
  suppress?: "bounce" | "complaint" | "invalid";
}

/**
 * Applies a provider delivery event. "Delivered" exists only because a provider said so, status never moves backwards, and
 * the same event delivered twice changes nothing.
 */
export async function applyDeliveryEvent(db: Queryable, e: DeliveryEventInput): Promise<{ result: "applied" | "duplicate" | "unknown_message" | "no_change"; status?: MessageStatus }> {
  const { rows } = await db.query<{ id: string; org_id: string; status: MessageStatus; conversation_id: string }>(
    "select id, org_id, status, conversation_id from conversation_messages where provider = $1 and provider_message_id = $2 for update",
    [e.provider, e.providerMessageId],
  );
  const m = rows[0];
  if (!m) return { result: "unknown_message" };
  const inserted = await db.query(
    "insert into message_delivery_events (org_id, message_id, provider, provider_event_id, status, detail, occurred_at) values ($1, $2, $3, $4, $5, $6, $7) on conflict (provider, provider_event_id) do nothing returning id",
    [m.org_id, m.id, e.provider, e.providerEventId, e.status, e.detail?.slice(0, 300) ?? null, e.occurredAt ?? new Date()],
  );
  if (!inserted.rows[0]) return { result: "duplicate" };
  const next = advancesDelivery(m.status, e.status);
  if (e.suppress) {
    const conv = await db.query<{ channel: Channel; contact_id: string }>("select channel, contact_id from conversations where id = $1", [m.conversation_id]);
    const address = conv.rows[0] ? await contactAddress(db, m.org_id, conv.rows[0].contact_id, conv.rows[0].channel) : null;
    if (address && conv.rows[0]) {
      const { suppressAddress } = await import("@/server/messaging/contacts");
      await suppressAddress(db, { orgId: m.org_id, channel: conv.rows[0].channel, address, reason: e.suppress, source: "delivery_event" });
    }
  }
  if (!next) return { result: "no_change", status: m.status };
  await db.query(
    `update conversation_messages set status = $2, status_detail = $3,
       delivered_at = case when $2 in ('delivered', 'read') then coalesce(delivered_at, $4) else delivered_at end,
       failed_at = case when $2 = 'failed' then $4 else failed_at end where id = $1`,
    [m.id, next, e.detail?.slice(0, 300) ?? null, e.occurredAt ?? new Date()],
  );
  return { result: "applied", status: next };
}
