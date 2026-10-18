import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { buildSchedule, DEFAULT_FOLLOWUP_TEXT, validateBusinessHours, type BusinessHours, type Channel, type CustomFollowUp, type FollowUpPreset } from "@/lib/messaging";
import { queueOutbound } from "@/server/messaging/send";
import { contactAddress } from "@/server/messaging/contacts";
import { cancelRetention } from "@/server/retention/cancel";
import { assertCan, auditActor, crmWrite, type CrmActor } from "@/server/crm/actor";
import { recordActivity } from "@/server/crm/events";
import { switchingSql } from "@/server/crm/provider-guard";
import { isTransportName } from "@/server/messaging/transports";
import { TRANSPORT_LABELS, type TransportName } from "@/server/messaging/transports/types";
import { customFollowUpIssues, isFollowUpPreset, type FollowUpLimits } from "@/components/crm/followups/sequence";

/**
 * Follow-up sequences: when the AI team answered someone and they went quiet, a few spaced, polite follow-ups (the workspace's style:
 * Off, Gentle, Balanced (the default: up to three over about ten days), Persistent or Custom), always inside iAcquire's limits. One active
 * plan per person, shared by SMS, WhatsApp and email. Every step goes through the full send rule chain when it falls due.
 *
 * When a plan starts (the design in this file and src/lib/messaging.ts: "days after the last customer-visible message", "follows up with
 * people who have not replied", and startFollowUps only for AI-owned conversations): after the AI employee's answer to a customer has been
 * sent in a conversation the AI owns and the customer has not written since. planFollowUps finds those conversations; it runs at the start
 * of every processDueFollowUps (the scheduler's followUpsPrepared job). Booking confirmations, conversations a person owns, people with an
 * upcoming or just-made appointment, open escalations and workspaces with follow-ups Off are left alone.
 *
 * What stops a plan: a reply (ingest), an opt-out (ingest and the send chain), a person taking over (handoff), a booking from any source
 * (onBooking: the GoHighLevel ledger directly, native bookings through followUpsOnEvent on appointment.booked), consent withdrawn
 * (followUpsOnEvent on contact.consent_changed), a pause, missing credit or a limit (the send chain), and a person stopping it by hand.
 */

/** Reasons a follow-up must stop for good rather than wait. */
export type StopReason =
  | "customer_replied"
  | "customer_booked"
  | "customer_opted_out"
  | "consent_invalid"
  | "human_took_over"
  | "budget_exhausted"
  | "automation_paused"
  | "window_expired"
  | "conversation_closed"
  | "contact_merged"
  | "privacy_request"
  | "stopped_by_team"
  | "followups_turned_off"
  | string;

const STOP_ON_BLOCK = new Set(["human_owner", "suppressed", "no_consent", "automation_paused", "org_inactive", "agent_not_ready", "followup_limit", "contact_unreachable", "credits", "budget"]);

/** Cancels the contact's active plan, its scheduled steps and any follow-up message that has not been sent yet. */
export async function cancelFollowUps(db: Queryable, input: { orgId: string; contactId: string; reason: StopReason }): Promise<{ cancelledPlans: number; cancelledMessages: number }> {
  // The same stop conditions end a customer's retention programs (a reply, an opt-out, a person taking over, a pause).
  await cancelRetention(db, input.orgId, input.contactId, input.reason);
  const plans = await db.query<{ id: string; conversation_id: string }>(
    "update follow_up_plans set status = 'cancelled', cancel_reason = $3, closed_at = now() where org_id = $1 and contact_id = $2 and status = 'active' returning id, conversation_id",
    [input.orgId, input.contactId, input.reason],
  );
  let cancelledMessages = 0;
  for (const plan of plans.rows) {
    await db.query("update follow_up_steps set status = 'cancelled', reason = $2 where plan_id = $1 and status in ('scheduled', 'queued')", [plan.id, input.reason]);
    // Messages already queued or waiting for approval for this plan must not slip out afterwards.
    const stopped = await db.query<{ id: string }>(
      `select m.id from conversation_messages m join follow_up_steps s on s.id = m.followup_step_id
       where s.plan_id = $1 and m.status in ('draft', 'queued')`,
      [plan.id],
    );
    if (stopped.rows.length) cancelledMessages += await cancelFollowUpMessages(db, input.orgId, stopped.rows.map((r) => r.id), input.reason);
  }
  return { cancelledPlans: plans.rowCount, cancelledMessages };
}

async function cancelFollowUpMessages(db: Queryable, orgId: string, ids: string[], reason: string) {
  const { releaseReservation } = await import("@/server/billing/ledger");
  const res = await db.query<{ id: string; reservation_id: string | null }>(
    "update conversation_messages set status = 'blocked', blocked_reason = $3, status_detail = 'Stopped before sending.' where org_id = $1 and id = any($2::uuid[]) and status in ('draft', 'queued') returning id, reservation_id",
    [orgId, ids, reason.slice(0, 60)],
  );
  for (const m of res.rows) if (m.reservation_id) await releaseReservation(db, { orgId, reservationId: m.reservation_id, reason: `Stopped: ${reason}` });
  return res.rows.length;
}

export async function cancelFollowUpsForContactOfStep(db: Queryable, stepId: string, reason: StopReason) {
  const { rows } = await db.query<{ org_id: string; contact_id: string }>("select org_id, contact_id from follow_up_steps where id = $1", [stepId]);
  if (rows[0]) await cancelFollowUps(db, { orgId: rows[0].org_id, contactId: rows[0].contact_id, reason });
}

/** Call when a booking is created for the contact, from any source. */
export async function onBooking(db: Queryable, orgId: string, contactId: string) {
  return cancelFollowUps(db, { orgId, contactId, reason: "customer_booked" });
}

// ---------------------------------------------------------------------------
// CRM events
// ---------------------------------------------------------------------------

/** The fields of a CRM outbox event this module reads. The event dispatcher's row type (CrmEventRow) satisfies it. */
export interface FollowUpEvent {
  id: number;
  orgId: string;
  type: string;
  contactId: string | null;
  payload: Record<string, unknown>;
}

export interface FollowUpEventResult {
  action: "stopped" | "none";
  reason: StopReason | null;
  cancelledPlans: number;
  cancelledMessages: number;
}

const NOTHING: FollowUpEventResult = { action: "none", reason: null, cancelledPlans: 0, cancelledMessages: 0 };

/**
 * Event dispatcher subscriber, in the event's own transaction:
 *  - appointment.booked: the customer booked (a native booking page, the AI employee, a teammate), so follow-ups and retention messages stop,
 *    exactly as a GoHighLevel booking does through the appointment ledger.
 *  - contact.consent_changed to revoked: someone recorded that the customer withdrew consent, so nothing more is scheduled for them. Any
 *    withdrawal stops the sequence, whatever the channel or purpose: a follow-up is never worth messaging someone who just said no.
 * Both are idempotent: a contact without an active plan is left as it is.
 */
export async function followUpsOnEvent(db: Queryable, event: FollowUpEvent): Promise<FollowUpEventResult> {
  if (!event.contactId) return NOTHING;
  let reason: StopReason | null = null;
  if (event.type === "appointment.booked") reason = "customer_booked";
  else if (event.type === "contact.consent_changed" && event.payload?.status === "revoked") reason = "consent_invalid";
  if (!reason) return NOTHING;
  const r = reason === "customer_booked" ? await onBooking(db, event.orgId, event.contactId) : await cancelFollowUps(db, { orgId: event.orgId, contactId: event.contactId, reason });
  return { action: "stopped", reason, ...r };
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

interface PolicyRow {
  max_followup_attempts: number;
  max_followups_per_contact_30d: number;
}

/**
 * Starts a follow-up plan for a contact using the workspace's preset, never exceeding the agency's maximums. A contact has at
 * most one active plan, so SMS, WhatsApp and email can never each run their own copy of the allowance.
 */
export async function startFollowUps(db: Queryable, input: { orgId: string; conversationId: string; now?: Date }): Promise<{ planId: string | null; steps: number; reason?: string }> {
  const now = input.now ?? new Date();
  const { rows: convRows } = await db.query<{ contact_id: string; channel: Channel; ai_agent_id: string | null; owner_kind: string }>(
    "select contact_id, channel, ai_agent_id, owner_kind from conversations where id = $1 and org_id = $2",
    [input.conversationId, input.orgId],
  );
  const conv = convRows[0];
  if (!conv) return { planId: null, steps: 0, reason: "conversation_missing" };
  if (conv.owner_kind !== "ai") return { planId: null, steps: 0, reason: "human_owner" };
  const existing = await db.query<{ id: string }>("select id from follow_up_plans where org_id = $1 and contact_id = $2 and status = 'active'", [input.orgId, conv.contact_id]);
  if (existing.rows[0]) return { planId: existing.rows[0].id, steps: 0, reason: "already_active" };

  const { rows: s } = await db.query<{ followup_preset: FollowUpPreset; followup_custom: CustomFollowUp | null }>("select followup_preset, followup_custom from messaging_settings where org_id = $1", [input.orgId]);
  const { rows: p } = await db.query<PolicyRow>("select max_followup_attempts, max_followups_per_contact_30d from messaging_policy");
  const preset = s[0]?.followup_preset ?? "balanced";
  const schedule = buildSchedule(preset, s[0]?.followup_custom ?? null, p[0].max_followup_attempts);
  if (!schedule) return { planId: null, steps: 0, reason: "off" };

  // The 30-day cap counts what this contact already received across every channel.
  const sent = await db.query<{ n: string }>(
    `select count(*)::text as n from conversation_messages m join conversations c on c.id = m.conversation_id
     where m.org_id = $1 and c.contact_id = $2 and m.scope = 'followup' and m.status in ('sent', 'delivered', 'read') and m.sent_at > $3::timestamptz - interval '30 days'`,
    [input.orgId, conv.contact_id, now.toISOString()],
  );
  const remaining = Math.max(0, p[0].max_followups_per_contact_30d - Number(sent.rows[0].n));
  const days = schedule.days.slice(0, remaining);
  if (!days.length) return { planId: null, steps: 0, reason: "followup_limit" };

  const plan = await db.query<{ id: string }>(
    "insert into follow_up_plans (org_id, contact_id, conversation_id, agent_id, preset, max_attempts) values ($1, $2, $3, $4, $5, $6) returning id",
    [input.orgId, conv.contact_id, input.conversationId, conv.ai_agent_id, preset === "off" ? "balanced" : preset, days.length],
  );
  const channel = schedule.channel === "same" ? conv.channel : schedule.channel;
  for (const [index, day] of days.entries()) {
    await db.query("insert into follow_up_steps (org_id, plan_id, contact_id, step_number, channel, due_at) values ($1, $2, $3, $4, $5, $6)", [
      input.orgId,
      plan.rows[0].id,
      conv.contact_id,
      index + 1,
      channel,
      new Date(now.getTime() + day * 86_400_000),
    ]);
  }
  return { planId: plan.rows[0].id, steps: days.length };
}

/** How far back an AI answer can be and still start a sequence. A planner that was down for a while catches up within this window. */
const PLAN_LOOKBACK_DAYS = 7;

/**
 * Conversations whose latest AI answer was sent and the customer hasn't written since, one per person (their most recent such answer).
 * Everything that would stop a plan straight away is excluded here, so the planner never starts a plan only to cancel it.
 */
const PLAN_CANDIDATES = `
  select * from (
    select distinct on (c.contact_id) c.org_id, c.id as conversation_id, c.contact_id, m.sent_at as anchor
    from conversation_messages m
    join conversations c on c.id = m.conversation_id and c.org_id = m.org_id
    join contacts k on k.id = c.contact_id and k.org_id = c.org_id
    left join messaging_settings s on s.org_id = c.org_id
    where m.direction = 'outbound' and m.author_kind = 'ai' and m.scope = 'reply' and m.status in ('sent', 'delivered', 'read')
      and m.sent_at > $1::timestamptz - make_interval(days => ${PLAN_LOOKBACK_DAYS}) and m.sent_at <= $1::timestamptz
      and coalesce(m.dedupe_key, '') not like 'booking-confirm:%'
      and c.owner_kind = 'ai' and c.status <> 'closed' and c.ai_agent_id is not null
      and k.deleted_at is null and k.archived_at is null
      and coalesce(s.followup_preset, 'balanced') <> 'off'
      and not exists (select 1 from conversations c2 where c2.org_id = c.org_id and c2.contact_id = c.contact_id and c2.last_inbound_at >= m.sent_at)
      and not exists (select 1 from follow_up_plans p where p.org_id = c.org_id and p.contact_id = c.contact_id and (p.status = 'active' or p.created_at >= m.sent_at))
      and not exists (select 1 from appointment_refs a where a.org_id = c.org_id and a.contact_id = c.contact_id and a.status not in ('cancelled', 'invalid')
                        and (a.start_at >= m.sent_at or a.created_at >= m.sent_at - interval '1 day'))
      and not exists (select 1 from human_escalations e where e.org_id = c.org_id and e.contact_id = c.contact_id and e.status in ('awaiting_owner', 'open', 'claimed'))
    order by c.contact_id, m.sent_at desc
  ) candidates order by anchor limit $2`;

/**
 * Starts follow-up plans for people who went quiet after the AI employee answered them. Each plan is dated from that answer (the last
 * message they received), so a planner that runs late does not push the sequence back. Each person is handled in its own transaction with
 * their contact row locked, so overlapping runs never start two plans. When the 30-day allowance is already used up, a closed plan records
 * that (reason followup_limit), so the person is not checked again for the same answer.
 */
export async function planFollowUps(opts: { now?: Date; limit?: number } = {}): Promise<{ planned: number; considered: number }> {
  const now = opts.now ?? new Date();
  const { rows } = await withSystem((db) =>
    db.query<{ org_id: string; conversation_id: string; contact_id: string; anchor: Date }>(PLAN_CANDIDATES, [now.toISOString(), Math.min(200, Math.max(1, opts.limit ?? 50))]),
  );
  let planned = 0;
  for (const c of rows) {
    try {
      await withSystem(async (db) => {
        const locked = await db.query("select 1 from contacts where id = $1 and org_id = $2 and deleted_at is null for update", [c.contact_id, c.org_id]);
        if (!locked.rows[0]) return;
        const anchor = new Date(c.anchor);
        // Re-checked under the lock: another run may have just planned for this person.
        const again = await db.query("select 1 from follow_up_plans where org_id = $1 and contact_id = $2 and (status = 'active' or created_at >= $3)", [c.org_id, c.contact_id, anchor]);
        if (again.rows[0]) return;
        const r = await startFollowUps(db, { orgId: c.org_id, conversationId: c.conversation_id, now: anchor });
        if (r.planId && r.steps > 0) planned += 1;
        else if (r.reason === "followup_limit") {
          const { rows: s } = await db.query<{ followup_preset: FollowUpPreset; agent: string | null }>(
            "select coalesce(s.followup_preset, 'balanced') as followup_preset, c.ai_agent_id as agent from conversations c left join messaging_settings s on s.org_id = c.org_id where c.id = $1",
            [c.conversation_id],
          );
          const preset = s[0]?.followup_preset && s[0].followup_preset !== "off" ? s[0].followup_preset : "balanced";
          await db.query(
            `insert into follow_up_plans (org_id, contact_id, conversation_id, agent_id, preset, max_attempts, status, cancel_reason, closed_at)
             values ($1, $2, $3, $4, $5, 1, 'cancelled', 'followup_limit', now())`,
            [c.org_id, c.contact_id, c.conversation_id, s[0]?.agent ?? null, preset],
          );
        }
      });
    } catch (err) {
      // One person's problem must not stop the others; the next run looks again.
      console.error("[iacquire] follow-up planning failed", { orgId: c.org_id, contactId: c.contact_id, error: err instanceof Error ? err.message.slice(0, 200) : "unknown" });
    }
  }
  return { planned, considered: rows.length };
}

async function refreshPlan(db: Queryable, planId: string) {
  const { rows } = await db.query<{ open: string }>("select count(*)::text as open from follow_up_steps where plan_id = $1 and status in ('scheduled', 'queued')", [planId]);
  if (Number(rows[0].open) === 0) await db.query("update follow_up_plans set status = 'completed', closed_at = now() where id = $1 and status = 'active'", [planId]);
}

export interface FollowUpDeps {
  now?: Date;
  /** Writes the message text. The default is a short, plain template that names the AI and offers STOP. */
  compose?: (input: { businessName: string; step: number }) => string | Promise<string>;
  /** Start plans for people who went quiet before preparing due steps (the default). */
  plan?: boolean;
}

/**
 * The conversation a step goes out on. A custom sequence can prefer another channel than the one the person wrote on: the person's
 * conversation on that channel is used (opened for them, owned by the AI like the original, when there is an address for it). Without an
 * address on the preferred channel the step goes out where the person wrote, and the step records the channel actually used.
 */
async function conversationForStep(db: Queryable, step: { id: string; org_id: string; contact_id: string; channel: Channel }, plan: { conversation_id: string; agent_id: string | null }): Promise<string> {
  const { rows } = await db.query<{ channel: Channel; subject: string | null }>("select channel, subject from conversations where id = $1", [plan.conversation_id]);
  const own = rows[0];
  if (!own || own.channel === step.channel) return plan.conversation_id;
  if (await contactAddress(db, step.org_id, step.contact_id, step.channel)) {
    const existing = await db.query<{ id: string }>(
      "select id from conversations where org_id = $1 and contact_id = $2 and channel = $3 and status <> 'closed' order by last_message_at desc nulls last, created_at limit 1",
      [step.org_id, step.contact_id, step.channel],
    );
    if (existing.rows[0]) return existing.rows[0].id;
    const created = await db.query<{ id: string }>(
      `insert into conversations (org_id, contact_id, channel, status, subject, ai_agent_id, owner_kind)
       values ($1, $2, $3, 'open', $4, $5, 'ai') on conflict (org_id, contact_id, channel, thread_key) do update set updated_at = now() returning id`,
      [step.org_id, step.contact_id, step.channel, own.subject, plan.agent_id],
    );
    return created.rows[0].id;
  }
  await db.query("update follow_up_steps set channel = $2, reason = 'preferred_channel_unreachable' where id = $1", [step.id, own.channel]);
  return plan.conversation_id;
}

/**
 * Worker entry point: starts plans for people who went quiet (planFollowUps), then turns due follow-up steps into messages. Each step goes
 * through the full send rule chain, so quiet hours, consent, opt-outs, pauses, ownership and credits are all checked at the moment of
 * sending, not when the plan was made.
 */
export async function processDueFollowUps(deps: FollowUpDeps = {}, limit = 50): Promise<{ processed: number; planned: number }> {
  const now = deps.now ?? new Date();
  const planned = deps.plan === false ? 0 : (await planFollowUps({ now, limit })).planned;
  // A workspace switching CRM providers holds its due steps where they are (still scheduled); they go out once the switch finishes. Leaving
  // them out of this pick also keeps one switching workspace's backlog from crowding out everyone else's follow-ups.
  const { rows } = await withSystem((db) =>
    db.query<{ id: string }>(`select id from follow_up_steps where status = 'scheduled' and due_at <= $1 and not ${switchingSql("follow_up_steps.org_id")} order by due_at limit $2`, [now.toISOString(), limit]),
  );
  let processed = 0;
  for (const row of rows) {
    await withSystem(async (db) => {
      const { rows: locked } = await db.query<{ id: string; org_id: string; plan_id: string; contact_id: string; step_number: number; channel: Channel }>(
        "select id, org_id, plan_id, contact_id, step_number, channel from follow_up_steps where id = $1 and status = 'scheduled' for update skip locked",
        [row.id],
      );
      const step = locked[0];
      if (!step) return;
      const { rows: plan } = await db.query<{ status: string; conversation_id: string; agent_id: string | null }>("select status, conversation_id, agent_id from follow_up_plans where id = $1", [step.plan_id]);
      if (!plan[0] || plan[0].status !== "active") {
        await db.query("update follow_up_steps set status = 'cancelled', reason = 'plan_closed' where id = $1", [step.id]);
        return;
      }
      const { rows: businessHours } = await db.query<{ followup_custom: CustomFollowUp | null; followup_preset: string }>("select followup_custom, followup_preset from messaging_settings where org_id = $1", [step.org_id]);
      // Follow-ups were switched off after this sequence started (from any settings screen): nothing more goes out for it.
      if (businessHours[0]?.followup_preset === "off") {
        await cancelFollowUpPlansOnly(db, step.org_id, step.contact_id, "followups_turned_off");
        processed += 1;
        return;
      }
      const { rows: org } = await db.query<{ name: string }>("select name from organizations where id = $1", [step.org_id]);
      const body = await (deps.compose ?? (({ businessName, step: n }) => DEFAULT_FOLLOWUP_TEXT(businessName, n)))({ businessName: org[0]?.name ?? "our team", step: step.step_number });
      const conversationId = await conversationForStep(db, step, plan[0]);
      const result = await queueOutbound(db, {
        orgId: step.org_id,
        conversationId,
        scope: "followup",
        actor: { kind: "ai", agentId: plan[0].agent_id },
        body,
        now,
        businessHoursOnly: businessHours[0]?.followup_preset === "custom" ? businessHours[0].followup_custom?.businessHoursOnly !== false : true,
        followupStepId: step.id,
      });
      if (result.status === "queued") await db.query("update follow_up_steps set status = 'queued', message_id = $2 where id = $1", [step.id, result.messageId]);
      else if (result.status === "draft") await db.query("update follow_up_steps set status = 'queued', message_id = $2, reason = 'awaiting_approval' where id = $1", [step.id, result.messageId]);
      else {
        await db.query("update follow_up_steps set status = 'blocked', reason = $2, message_id = $3 where id = $1", [step.id, result.reason ?? "blocked", result.messageId]);
        if (result.reason && STOP_ON_BLOCK.has(result.reason)) await cancelFollowUps(db, { orgId: step.org_id, contactId: step.contact_id, reason: result.reason === "automation_paused" ? "automation_paused" : result.reason === "credits" || result.reason === "budget" ? "budget_exhausted" : result.reason });
      }
      await refreshPlan(db, step.plan_id);
      processed += 1;
    });
  }
  return { processed, planned };
}

/** After a follow-up message is finally sent or fails, close the plan once no steps remain. */
export async function settlePlansForStep(db: Queryable, stepId: string) {
  const { rows } = await db.query<{ plan_id: string }>("select plan_id from follow_up_steps where id = $1", [stepId]);
  if (rows[0]) await refreshPlan(db, rows[0].plan_id);
}

// ---------------------------------------------------------------------------
// Follow-up Sequences screen (/crm/follow-ups)
// ---------------------------------------------------------------------------

const UNIT_FOR: Record<Channel, "sms_segment" | "whatsapp_message" | "email_send"> = { sms: "sms_segment", whatsapp: "whatsapp_message", email: "email_send" };

export interface FollowUpChannelView {
  channel: Channel;
  enabled: boolean;
  provider: TransportName;
  providerLabel: string;
  /** Service credit per unit (micro-dollars) from the latest rate iAcquire published for this provider, or null when none is published. */
  clientMicrosPerUnit: number | null;
}

export interface FollowUpUpcomingView {
  stepId: string;
  contactId: string;
  contactName: string;
  conversationId: string;
  stepNumber: number;
  maxAttempts: number;
  channel: Channel;
  dueAt: string;
  status: "scheduled" | "queued";
  /** For a queued step: the message's state (queued, draft waiting for approval). */
  messageStatus: string | null;
  sendAfter: string | null;
}

export interface FollowUpDeliveryView {
  stepId: string;
  contactId: string;
  contactName: string;
  conversationId: string | null;
  stepNumber: number;
  channel: Channel;
  at: string;
  stepStatus: "sent" | "blocked" | "cancelled" | "skipped";
  reason: string | null;
  messageId: string | null;
  messageStatus: string | null;
  messageDetail: string | null;
}

export interface FollowUpStats {
  active: number;
  started30d: number;
  completed30d: number;
  stopped30d: number;
  /** People who went quiet but had no follow-ups left in their 30-day allowance, so no sequence started. */
  notStarted30d: number;
  stopReasons: Array<{ reason: string; count: number }>;
  sent30d: number;
  awaitingApproval: number;
}

export interface FollowUpWorkspaceView {
  preset: FollowUpPreset;
  custom: CustomFollowUp | null;
  limits: FollowUpLimits;
  businessHours: BusinessHours;
  timezone: string;
  businessName: string;
  channels: FollowUpChannelView[];
  stats: FollowUpStats;
  /** Upcoming steps and delivery history name customers, so they need the permission to see every conversation. */
  canSeePeople: boolean;
  upcoming: FollowUpUpcomingView[];
  history: FollowUpDeliveryView[];
}

async function loadLimits(db: Queryable): Promise<FollowUpLimits> {
  const { rows } = await db.query<{ max_followup_attempts: number; max_followups_per_contact_30d: number; min_hours_between_followups: number; quiet_hours_start: string; quiet_hours_end: string; whatsapp_window_hours: number }>(
    "select max_followup_attempts, max_followups_per_contact_30d, min_hours_between_followups, quiet_hours_start::text, quiet_hours_end::text, whatsapp_window_hours from messaging_policy",
  );
  const p = rows[0];
  return {
    maxAttempts: p.max_followup_attempts, maxPer30Days: p.max_followups_per_contact_30d, minHoursBetween: p.min_hours_between_followups,
    quietHoursStart: String(p.quiet_hours_start).slice(0, 5), quietHoursEnd: String(p.quiet_hours_end).slice(0, 5), whatsappWindowHours: p.whatsapp_window_hours,
  };
}

const CONTACT_NAME = "coalesce(nullif(k.display_name, ''), k.email::text, k.phone, 'A contact')";

/**
 * Everything the Follow-up Sequences screen shows: the workspace's style and iAcquire's limits, each channel's provider and published
 * rate (for the cost estimate), sequence counts, and (for people who can see every conversation) upcoming steps and recent deliveries.
 * Read through the trusted path after the permission check: the policy and published rates are iAcquire's, not the workspace's rows.
 */
export async function getFollowUpWorkspace(actor: CrmActor, opts: { now?: Date } = {}): Promise<FollowUpWorkspaceView> {
  assertCan(actor, "inbox.view", "Follow-up sequences need access to the inbox.");
  const now = opts.now ?? new Date();
  const canSeePeople = actor.can("inbox.view_all");
  return withSystem(async (db) => {
    const { rows: s } = await db.query<{ followup_preset: FollowUpPreset; followup_custom: CustomFollowUp | null; business_hours: unknown }>(
      "select followup_preset, followup_custom, business_hours from messaging_settings where org_id = $1",
      [actor.orgId],
    );
    const { rows: org } = await db.query<{ name: string; timezone: string }>("select name, timezone from organizations where id = $1", [actor.orgId]);
    const limits = await loadLimits(db);
    const { rows: ch } = await db.query<{ channel: Channel; enabled: boolean; provider: string }>("select channel, enabled, provider from messaging_channels where org_id = $1", [actor.orgId]);
    const channels: FollowUpChannelView[] = [];
    for (const channel of ["sms", "whatsapp", "email"] as const) {
      const row = ch.find((c) => c.channel === channel);
      const provider: TransportName = row && isTransportName(row.provider) ? row.provider : "ghl";
      const rate = await db.query<{ c: string }>(
        `select r.client_micros_per_unit::text as c from usage_unit_rates r join usage_rate_versions v on v.id = r.rate_version_id
         where r.provider = $1 and r.unit_type = $2 order by v.version desc limit 1`,
        [provider, UNIT_FOR[channel]],
      );
      channels.push({ channel, enabled: row?.enabled ?? false, provider, providerLabel: TRANSPORT_LABELS[provider], clientMicrosPerUnit: rate.rows[0] ? Number(rate.rows[0].c) : null });
    }
    // A plan the planner closed in the same moment it recorded it (closed_at = created_at) never started: the person's 30-day allowance was used up.
    const { rows: st } = await db.query<{ active: string; started: string; completed: string; stopped: string; not_started: string; sent: string; drafts: string }>(
      `select (select count(*) from follow_up_plans where org_id = $1 and status = 'active')::text as active,
              (select count(*) from follow_up_plans where org_id = $1 and created_at > $2::timestamptz - interval '30 days' and closed_at is distinct from created_at)::text as started,
              (select count(*) from follow_up_plans where org_id = $1 and status = 'completed' and closed_at > $2::timestamptz - interval '30 days')::text as completed,
              (select count(*) from follow_up_plans where org_id = $1 and status = 'cancelled' and closed_at > $2::timestamptz - interval '30 days' and closed_at <> created_at)::text as stopped,
              (select count(*) from follow_up_plans where org_id = $1 and status = 'cancelled' and closed_at > $2::timestamptz - interval '30 days' and closed_at = created_at)::text as not_started,
              (select count(*) from conversation_messages where org_id = $1 and scope = 'followup' and status in ('sent', 'delivered', 'read') and sent_at > $2::timestamptz - interval '30 days')::text as sent,
              (select count(*) from conversation_messages m join follow_up_steps fs on fs.id = m.followup_step_id where m.org_id = $1 and m.status = 'draft' and fs.status = 'queued')::text as drafts`,
      [actor.orgId, now.toISOString()],
    );
    const { rows: reasons } = await db.query<{ reason: string; n: string }>(
      `select coalesce(cancel_reason, 'unknown') as reason, count(*)::text as n from follow_up_plans
       where org_id = $1 and status = 'cancelled' and closed_at > $2::timestamptz - interval '30 days' and closed_at <> created_at group by 1 order by count(*) desc limit 8`,
      [actor.orgId, now.toISOString()],
    );
    let upcoming: FollowUpUpcomingView[] = [];
    let history: FollowUpDeliveryView[] = [];
    if (canSeePeople) {
      const up = await db.query<{ id: string; contact_id: string; name: string; conversation_id: string; step_number: number; max_attempts: number; channel: Channel; due_at: Date; status: "scheduled" | "queued"; message_status: string | null; send_after: Date | null }>(
        `select fs.id, fs.contact_id, ${CONTACT_NAME} as name, coalesce(m.conversation_id, p.conversation_id) as conversation_id, fs.step_number, p.max_attempts, fs.channel, fs.due_at, fs.status,
                m.status as message_status, m.send_after
         from follow_up_steps fs join follow_up_plans p on p.id = fs.plan_id and p.status = 'active'
         join contacts k on k.id = fs.contact_id and k.org_id = fs.org_id
         left join conversation_messages m on m.id = fs.message_id
         where fs.org_id = $1 and fs.status in ('scheduled', 'queued') order by fs.due_at, fs.step_number limit 100`,
        [actor.orgId],
      );
      upcoming = up.rows.map((r) => ({
        stepId: r.id, contactId: r.contact_id, contactName: r.name, conversationId: r.conversation_id, stepNumber: r.step_number, maxAttempts: r.max_attempts, channel: r.channel,
        dueAt: new Date(r.due_at).toISOString(), status: r.status, messageStatus: r.message_status, sendAfter: r.send_after ? new Date(r.send_after).toISOString() : null,
      }));
      const hist = await db.query<{ id: string; contact_id: string; name: string; conversation_id: string | null; step_number: number; channel: Channel; at: Date; status: FollowUpDeliveryView["stepStatus"]; reason: string | null; message_id: string | null; message_status: string | null; message_detail: string | null }>(
        `select fs.id, fs.contact_id, ${CONTACT_NAME} as name, coalesce(m.conversation_id, p.conversation_id) as conversation_id, fs.step_number, fs.channel,
                coalesce(m.sent_at, fs.updated_at) as at, fs.status, fs.reason, m.id as message_id, m.status as message_status, coalesce(m.status_detail, m.blocked_reason) as message_detail
         from follow_up_steps fs join follow_up_plans p on p.id = fs.plan_id
         join contacts k on k.id = fs.contact_id and k.org_id = fs.org_id
         left join conversation_messages m on m.id = fs.message_id
         where fs.org_id = $1 and fs.status in ('sent', 'blocked', 'cancelled', 'skipped') and fs.updated_at > $2::timestamptz - interval '30 days'
         order by coalesce(m.sent_at, fs.updated_at) desc limit 100`,
        [actor.orgId, now.toISOString()],
      );
      history = hist.rows.map((r) => ({
        stepId: r.id, contactId: r.contact_id, contactName: r.name, conversationId: r.conversation_id, stepNumber: r.step_number, channel: r.channel, at: new Date(r.at).toISOString(),
        stepStatus: r.status, reason: r.reason, messageId: r.message_id, messageStatus: r.message_status, messageDetail: r.message_detail,
      }));
    }
    const row = s[0];
    return {
      preset: row?.followup_preset ?? "balanced",
      custom: row?.followup_custom ?? null,
      limits,
      businessHours: validateBusinessHours(row?.business_hours ?? {}) ?? {},
      timezone: org[0]?.timezone ?? "UTC",
      businessName: org[0]?.name ?? "",
      channels,
      stats: {
        active: Number(st[0].active), started30d: Number(st[0].started), completed30d: Number(st[0].completed), stopped30d: Number(st[0].stopped), notStarted30d: Number(st[0].not_started),
        stopReasons: reasons.map((r) => ({ reason: r.reason, count: Number(r.n) })), sent30d: Number(st[0].sent), awaitingApproval: Number(st[0].drafts),
      },
      canSeePeople,
      upcoming,
      history,
    };
  });
}

export interface FollowUpSettingsInput {
  preset: string;
  custom?: Partial<CustomFollowUp> | null;
}

/**
 * Saves the workspace's follow-up style. Owners and managers decide (messaging.configure), inside iAcquire's limits: a custom sequence is
 * refused when it asks for more attempts, closer spacing or a longer gap than the limits allow. Changing the style applies to sequences that
 * start afterwards; switching follow-ups Off also stops every sequence that is running, with the reason recorded.
 */
export async function saveFollowUpSettings(actor: CrmActor, input: FollowUpSettingsInput): Promise<{ stoppedPlans: number }> {
  assertCan(actor, "messaging.configure", "Only owners and managers can change how follow-ups work.");
  if (!isFollowUpPreset(input.preset)) throw new AppError("invalid_input", "Choose a follow-up style.");
  const preset = input.preset;
  return crmWrite(actor, async (db) => {
    const limits = await loadLimits(db);
    let custom: CustomFollowUp | null | undefined;
    if (preset === "custom") {
      const issues = customFollowUpIssues(input.custom ?? null, limits);
      if (issues.length) throw new AppError("invalid_input", issues[0]);
      const c = input.custom as CustomFollowUp;
      custom = { attempts: c.attempts, daysBetween: c.daysBetween.slice(0, Math.max(1, Math.min(c.daysBetween.length, c.attempts))), channel: c.channel, businessHoursOnly: c.businessHoursOnly };
    }
    await db.query("insert into messaging_settings (org_id) values ($1) on conflict do nothing", [actor.orgId]);
    const { rows: before } = await db.query<{ followup_preset: FollowUpPreset }>("select followup_preset from messaging_settings where org_id = $1 for update", [actor.orgId]);
    await db.query(
      "update messaging_settings set followup_preset = $2, followup_custom = case when $3::boolean then $4::jsonb else followup_custom end, updated_by = $5 where org_id = $1",
      [actor.orgId, preset, custom !== undefined, custom ? JSON.stringify(custom) : null, actor.userId],
    );
    let stoppedPlans = 0;
    if (preset === "off") {
      const { rows: active } = await db.query<{ contact_id: string }>("select contact_id from follow_up_plans where org_id = $1 and status = 'active'", [actor.orgId]);
      for (const p of active) stoppedPlans += (await cancelFollowUpPlansOnly(db, actor.orgId, p.contact_id, "followups_turned_off")).cancelledPlans;
    }
    await recordAudit({
      orgId: actor.orgId, ...auditActor(actor), action: "messaging.followups_changed", targetType: "messaging_settings", targetId: actor.orgId, result: "success",
      metadata: { from: before[0]?.followup_preset ?? "balanced", to: preset, custom: custom ?? null, stoppedPlans },
    }, db);
    return { stoppedPlans };
  });
}

/** Stops follow-ups only (retention programs are separate and keep their own switch). */
async function cancelFollowUpPlansOnly(db: Queryable, orgId: string, contactId: string, reason: StopReason) {
  const plans = await db.query<{ id: string }>(
    "update follow_up_plans set status = 'cancelled', cancel_reason = $3, closed_at = now() where org_id = $1 and contact_id = $2 and status = 'active' returning id",
    [orgId, contactId, reason],
  );
  let cancelledMessages = 0;
  for (const plan of plans.rows) {
    await db.query("update follow_up_steps set status = 'cancelled', reason = $2 where plan_id = $1 and status in ('scheduled', 'queued')", [plan.id, reason]);
    const pending = await db.query<{ id: string }>("select m.id from conversation_messages m join follow_up_steps s on s.id = m.followup_step_id where s.plan_id = $1 and m.status in ('draft', 'queued')", [plan.id]);
    if (pending.rows.length) cancelledMessages += await cancelFollowUpMessages(db, orgId, pending.rows.map((r) => r.id), reason);
  }
  return { cancelledPlans: plans.rowCount, cancelledMessages };
}

/** A person stops one customer's follow-ups (anything scheduled or queued, including a draft waiting for approval). Recorded on the timeline. */
export async function stopContactFollowUps(actor: CrmActor, contactId: string): Promise<{ cancelledPlans: number; cancelledMessages: number }> {
  assertCan(actor, "messaging.configure", "Only owners and managers can stop a customer's follow-ups.");
  return crmWrite(actor, async (db) => {
    const { rows } = await db.query<{ id: string }>("select id from contacts where id = $1 and org_id = $2 for update", [contactId, actor.orgId]);
    if (!rows[0]) throw new AppError("not_found", "Contact not found.");
    const r = await cancelFollowUpPlansOnly(db, actor.orgId, contactId, "stopped_by_team");
    if (!r.cancelledPlans) throw new AppError("conflict", "This person has no follow-ups scheduled any more.");
    await recordActivity(db, actor, { kind: "follow_up.stopped", summary: `Follow-ups stopped by ${actor.label}`, contactId, metadata: { cancelledMessages: r.cancelledMessages } });
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "messaging.followups_stopped", targetType: "contact", targetId: contactId, result: "success", metadata: r }, db);
    return r;
  });
}
