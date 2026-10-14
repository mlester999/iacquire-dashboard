import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { buildSchedule, DEFAULT_FOLLOWUP_TEXT, type Channel, type CustomFollowUp, type FollowUpPreset } from "@/lib/messaging";
import { queueOutbound } from "@/server/messaging/send";
import { cancelRetention } from "@/server/retention/cancel";

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

async function refreshPlan(db: Queryable, planId: string) {
  const { rows } = await db.query<{ open: string }>("select count(*)::text as open from follow_up_steps where plan_id = $1 and status in ('scheduled', 'queued')", [planId]);
  if (Number(rows[0].open) === 0) await db.query("update follow_up_plans set status = 'completed', closed_at = now() where id = $1 and status = 'active'", [planId]);
}

export interface FollowUpDeps {
  now?: Date;
  /** Writes the message text. The default is a short, plain template that names the AI and offers STOP. */
  compose?: (input: { businessName: string; step: number }) => string | Promise<string>;
}

/**
 * Worker entry point: turns due follow-up steps into messages. Each step goes through the full send rule chain, so quiet hours,
 * consent, opt-outs, pauses, ownership and credits are all checked at the moment of sending, not when the plan was made.
 */
export async function processDueFollowUps(deps: FollowUpDeps = {}, limit = 50): Promise<{ processed: number }> {
  const now = deps.now ?? new Date();
  const { rows } = await withSystem((db) => db.query<{ id: string }>("select id from follow_up_steps where status = 'scheduled' and due_at <= $1 order by due_at limit $2", [now.toISOString(), limit]));
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
      const { rows: org } = await db.query<{ name: string }>("select name from organizations where id = $1", [step.org_id]);
      const body = await (deps.compose ?? (({ businessName, step: n }) => DEFAULT_FOLLOWUP_TEXT(businessName, n)))({ businessName: org[0]?.name ?? "our team", step: step.step_number });
      const { rows: businessHours } = await db.query<{ followup_custom: CustomFollowUp | null; followup_preset: string }>("select followup_custom, followup_preset from messaging_settings where org_id = $1", [step.org_id]);
      const result = await queueOutbound(db, {
        orgId: step.org_id,
        conversationId: plan[0].conversation_id,
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
  return { processed };
}

/** After a follow-up message is finally sent or fails, close the plan once no steps remain. */
export async function settlePlansForStep(db: Queryable, stepId: string) {
  const { rows } = await db.query<{ plan_id: string }>("select plan_id from follow_up_steps where id = $1", [stepId]);
  if (rows[0]) await refreshPlan(db, rows[0].plan_id);
}

