import "server-only";
import crypto from "node:crypto";
import { withSystem, type Queryable } from "@/server/db";
import { runJob } from "@/server/ops/jobs";
import { logSafeServerDiagnostic } from "@/server/diagnostics";
import { systemActor, type CrmActor } from "@/server/crm/actor";
import { recordActivity } from "@/server/crm/events";
import { createTaskInTx } from "@/server/crm/tasks";
import { notifyOrgRoles } from "@/server/notifications";
import { recordConversationEvent } from "@/server/messaging/events";
import { recordConsent } from "@/server/messaging/contacts";
import { queueOutbound } from "@/server/messaging/send";
import { evaluateEligibility, blockReasonText, type Eligibility } from "@/lib/missed-calls/eligibility";
import { ACTIVE_STATES, isFinishedState, pathTo, type CaseActor, type CaseState } from "@/lib/missed-calls/state";
import { policyWording, renderWording, type MissedCallPolicy, type RecoveryChannel } from "@/lib/missed-calls/policy";
import { syncCaseForCall, addCaseEvent, emitCaseEvent, emitRecovered, ensureConversation, loadCase, transitionCase, type CasePatch, type CaseRow } from "@/server/missed-calls/cases";
import { loadEligibilityFacts } from "@/server/missed-calls/facts";
import { routeToAppointmentSetter } from "@/server/missed-calls/routing";
import { getPolicy } from "@/server/missed-calls/policy";

// The recovery engine: works missed-call cases that are due. One pass over one case is one transaction under a row lock:
//
//   1. reconcile what earlier passes started (a queued text is sent, blocked or failed: the message row says which, never a guess);
//   2. read the facts and evaluate eligibility (src/lib/missed-calls/eligibility.ts);
//   3. settle the case if the caller was reached, booked, replied or the call turned out to be answered;
//   4. do the team's part once (owner, call-back task, notice, deal timeline, the AI call-back that is blocked until a verified capability exists);
//   5. text the caller only when every rule passes, through the same send chain as every other message, which checks them again at send time.
//
// Every effect has a dedupe key, so a retry, a second worker or a crash between steps repeats nothing. The engine never marks a message
// sent because it queued it, and never marks a call-back done that no provider confirmed.

export const SYSTEM_ACTOR: CaseActor = { kind: "system" };
const LEASE_MINUTES = 5;
const MAX_PROCESS_ATTEMPTS = 8;
const REVISIT_MINUTES = 30;
const RECONCILE_MINUTES = 2;

const minutes = (m: number) => m * 60_000;
const later = (now: Date, ms: number) => new Date(now.getTime() + ms);

export type CaseOutcome = "noop" | "closed" | "suppressed" | "waiting" | "queued" | "draft" | "awaiting_response" | "failed" | "timed_out" | "reconciled";

/** Moves a case through each state on the way to `target`, one validated transition at a time. The last step carries the patch. */
async function advance(db: Queryable, c: CaseRow, target: CaseState, reason: string, patch: CasePatch = {}, actor: CaseActor = SYSTEM_ACTOR, detail?: Record<string, unknown>): Promise<CaseRow> {
  if (c.state === target) {
    if (Object.keys(patch).length) await patchCase(db, c, patch);
    return (await loadCase(db, c.org_id, c.id))!;
  }
  const route = pathTo(c.state, target);
  if (!route) return c;
  let cur = c;
  for (const [i, state] of route.entries()) {
    const last = i === route.length - 1;
    const r = await transitionCase(db, { orgId: c.org_id, caseId: c.id, to: state, actor, reason: last ? reason : "progress", patch: last ? patch : { }, detail: last ? detail : undefined });
    if (!r.ok) return (await loadCase(db, c.org_id, c.id)) ?? cur;
    cur = r.row;
  }
  return cur;
}

async function patchCase(db: Queryable, c: CaseRow, patch: CasePatch): Promise<void> {
  const cols: Record<string, string> = { nextActionAt: "next_action_at", attempts: "attempts", lastAttemptAt: "last_attempt_at", firstActionAt: "first_action_at", responseDeadlineAt: "response_deadline_at", lastError: "last_error" };
  const sets: string[] = [];
  const params: unknown[] = [c.id, c.org_id];
  for (const [k, v] of Object.entries(patch)) {
    if (!cols[k] || v === undefined) continue;
    params.push(v);
    sets.push(`${cols[k]} = $${params.length}`);
  }
  if (sets.length) await db.query(`update missed_call_cases set ${sets.join(", ")} where id = $1 and org_id = $2`, params);
}

// ---------------------------------------------------------------------------
// Actions: at most once each
// ---------------------------------------------------------------------------

async function claimAction(db: Queryable, c: CaseRow, kind: string, dedupe: string, extra: { channel?: RecoveryChannel; attemptNo?: number; actor?: "system" | "user"; actorUserId?: string | null; status?: string; reason?: string; draft?: string; scheduledFor?: Date | null } = {}): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `insert into missed_call_actions (org_id, case_id, kind, channel, status, reason, dedupe_key, attempt_no, actor_kind, actor_user_id, draft_body, scheduled_for)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) on conflict (org_id, dedupe_key) do nothing returning id`,
    [c.org_id, c.id, kind, extra.channel ?? null, extra.status ?? "planned", extra.reason ?? null, dedupe, extra.attemptNo ?? 0, extra.actor ?? "system", extra.actorUserId ?? null, extra.draft ?? null, extra.scheduledFor ?? null],
  );
  return rows[0]?.id ?? null;
}

async function finishAction(db: Queryable, id: string, status: string, extra: { reason?: string; messageId?: string | null; taskId?: string | null; detail?: Record<string, unknown> } = {}): Promise<void> {
  await db.query(
    `update missed_call_actions set status = $2, reason = coalesce($3, reason), message_id = coalesce($4, message_id), task_id = coalesce($5, task_id),
       detail = detail || $6::jsonb, executed_at = case when $2 in ('sent', 'delivered', 'done', 'blocked', 'failed') then now() else executed_at end where id = $1`,
    [id, status, extra.reason?.slice(0, 60) ?? null, extra.messageId ?? null, extra.taskId ?? null, JSON.stringify(extra.detail ?? {})],
  );
}

// ---------------------------------------------------------------------------
// The team's part
// ---------------------------------------------------------------------------

interface ContactRow { display_name: string; assigned_user_id: string | null }

async function runTeamActions(db: Queryable, input: CaseRow, policy: MissedCallPolicy, elig: Eligibility, nextOpen: Date | null, withinHours: boolean, now: Date): Promise<CaseRow> {
  let c = input;
  const org = (await db.query<{ name: string; timezone: string }>("select name, timezone from organizations where id = $1", [c.org_id])).rows[0];
  const actor: CrmActor = systemActor({ id: c.org_id, name: org?.name, timezone: org?.timezone }, "Missed-call recovery");
  const contact = c.contact_id ? (await db.query<ContactRow>("select display_name, assigned_user_id from contacts where id = $1 and org_id = $2", [c.contact_id, c.org_id])).rows[0] : undefined;
  void elig;

  // Owner: the policy's named person, else the contact's own owner. A person already working the case is never replaced.
  if (c.owner_kind === "unassigned") {
    const candidate = policy.assignUserId ?? contact?.assigned_user_id ?? null;
    if (candidate) {
      const active = await db.query("select 1 from organization_memberships where org_id = $1 and user_id = $2 and status = 'active'", [c.org_id, candidate]);
      const id = active.rows.length ? await claimAction(db, c, "assign", `mcc:${c.id}:assign`) : null;
      if (id) {
        await db.query("update missed_call_cases set owner_kind = 'human', owner_user_id = $3, owner_version = owner_version + 1 where id = $1 and org_id = $2", [c.id, c.org_id, candidate]);
        await finishAction(db, id, "done", { detail: { userId: candidate } });
        await addCaseEvent(db, { orgId: c.org_id, caseId: c.id, kind: "owner_assigned", actor: SYSTEM_ACTOR, detail: { userId: candidate, by: "policy" } });
        c = (await loadCase(db, c.org_id, c.id))!;
      }
    }
  }

  const label = contact?.display_name?.trim() || c.caller_number || "an unknown caller";
  if (policy.actionTask) {
    const id = await claimAction(db, c, "task", `mcc:${c.id}:task`);
    if (id) {
      // A call that came in outside opening hours is due when the business opens, not in an hour while nobody is there.
      const due = new Date(Math.max(now.getTime() + minutes(policy.taskDueMinutes), !withinHours && nextOpen ? nextOpen.getTime() : 0));
      const task = await createTaskInTx(db, actor, {
        title: `Call back ${label}`.slice(0, 200),
        description: `Missed call${c.after_hours ? " (after hours)" : ""}${c.call_count > 1 ? `, ${c.call_count} calls` : ""}. Opened by missed-call recovery.`,
        dueAt: due.toISOString(), priority: "high", assigneeId: c.owner_user_id, contactId: c.contact_id,
      }, { source: "system" });
      await finishAction(db, id, "done", { taskId: task.id });
      await markFirstAction(db, c, now);
    }
  }
  if (policy.actionNotify) {
    const id = await claimAction(db, c, "notify", `mcc:${c.id}:notify`);
    if (id) {
      await notifyOrgRoles(db, c.org_id, policy.notifyRoles, {
        kind: "missed_call_follow_up", severity: "info", title: "A caller was missed", body: "Open the missed call to follow up.", link: `/crm/calls?tab=recovery&case=${c.id}`, dedupeKey: `mcc:${c.id}`,
      });
      await finishAction(db, id, "done");
      await markFirstAction(db, c, now);
    }
  }
  if (policy.actionOpportunity && c.contact_id) {
    const opp = (await db.query<{ id: string }>(
      "select id from crm_opportunities where org_id = $1 and contact_id = $2 and status = 'open' and provider = 'native' and archived_at is null order by stage_entered_at desc nulls last limit 1",
      [c.org_id, c.contact_id],
    )).rows[0];
    if (opp) {
      const id = await claimAction(db, c, "opportunity", `mcc:${c.id}:opportunity`);
      if (id) {
        await recordActivity(db, actor, { kind: "call.missed", summary: "This contact phoned and was missed while a deal is open", contactId: c.contact_id, opportunityId: opp.id, refType: "missed_call_case", refId: c.id });
        await finishAction(db, id, "done");
      }
    }
  }
  if (policy.routeAppointmentSetter && c.conversation_id) {
    const id = await claimAction(db, c, "appointment_setter", `mcc:${c.id}:appointment_setter`);
    if (id) {
      const r = await routeToAppointmentSetter(db, c);
      await finishAction(db, id, r.status === "done" ? "done" : r.status === "skipped" ? "skipped" : "blocked", { reason: r.reason, detail: r.agentId ? { agentId: r.agentId } : {} });
      await addCaseEvent(db, { orgId: c.org_id, caseId: c.id, kind: r.status === "done" ? "routed_to_ai" : "routing_not_done", actor: SYSTEM_ACTOR, detail: { reason: r.reason } });
    }
  }
  if (policy.actionAiCallback) {
    // No Vapi or Retell outbound-call credential exists in this platform, so a call-back can't be placed or confirmed. The action is recorded as
    // blocked, with the reason, and is never marked done.
    const id = await claimAction(db, c, "ai_callback", `mcc:${c.id}:ai_callback`, { status: "blocked", reason: "no_outbound_call_capability" });
    if (id) await addCaseEvent(db, { orgId: c.org_id, caseId: c.id, kind: "ai_callback_blocked", actor: SYSTEM_ACTOR, detail: { reason: "no_outbound_call_capability" } });
  }
  return (await loadCase(db, c.org_id, c.id))!;
}

async function markFirstAction(db: Queryable, c: CaseRow, now: Date): Promise<void> {
  await db.query("update missed_call_cases set first_action_at = coalesce(first_action_at, $3) where id = $1 and org_id = $2", [c.id, c.org_id, now]);
}

// ---------------------------------------------------------------------------
// Texting the caller
// ---------------------------------------------------------------------------

export interface SendParams {
  channel: RecoveryChannel;
  afterHoursWording: boolean;
  attemptNo: number;
  recordInboundCallConsent: boolean;
  /** The wording to use. Defaults to the policy's. A person may have edited a draft. */
  body?: string;
  by: { kind: "system"; userId: string | null } | { kind: "human"; userId: string };
  actionId?: string | null;
  now: Date;
}

/**
 * Queues one recovery text through the send chain. Returns what the chain decided; "queued" means accepted for sending, not sent. The case's
 * attempt counter moves, and the action records the message and its state.
 */
export async function sendRecoveryMessage(db: Queryable, c: CaseRow, policy: MissedCallPolicy, p: SendParams): Promise<{ status: "queued" | "blocked" | "draft"; messageId: string; reason?: string; actionId: string }> {
  if (!c.contact_id) throw new Error("no contact");
  const org = (await db.query<{ name: string }>("select name from organizations where id = $1", [c.org_id])).rows[0];
  const conversationId = await ensureConversation(db, c.org_id, c.contact_id, p.channel);
  if (p.recordInboundCallConsent) {
    await recordConsent(db, {
      orgId: c.org_id, contactId: c.contact_id, channel: p.channel, purpose: "service", status: "granted", source: "inbound_call",
      evidence: "The customer phoned the business. The business confirmed that callers may receive one service message about their call.",
    });
  }
  const body = p.body ?? renderWording(policyWording(policy, p.afterHoursWording), { businessName: org?.name ?? "" });
  const dedupe = `mcc:${c.id}:message:${p.attemptNo}`;
  const actionId = p.actionId ?? await claimAction(db, c, "message", dedupe, { channel: p.channel, attemptNo: p.attemptNo, actor: p.by.kind === "human" ? "user" : "system", actorUserId: p.by.userId });
  if (!actionId) throw new Error("already attempted");
  const result = await queueOutbound(db, {
    orgId: c.org_id, conversationId, scope: p.by.kind === "human" ? "human" : "followup", actor: p.by, body, dedupeKey: dedupe, purpose: "service",
    businessHoursOnly: !p.afterHoursWording, now: p.now,
  });
  if (result.status === "queued") {
    await finishAction(db, actionId, "queued", { messageId: result.messageId });
    await db.query(
      "update missed_call_cases set attempts = attempts + 1, last_attempt_at = $3, first_action_at = coalesce(first_action_at, $3) where id = $1 and org_id = $2",
      [c.id, c.org_id, p.now],
    );
  } else {
    await finishAction(db, actionId, "blocked", { messageId: result.messageId, reason: result.reason ?? "blocked", detail: { detail: (result.detail ?? "").slice(0, 200) } });
    await db.query("update missed_call_cases set attempts = attempts + 1, last_attempt_at = $3 where id = $1 and org_id = $2", [c.id, c.org_id, p.now]);
  }
  return { status: result.status, messageId: result.messageId, reason: result.reason, actionId };
}

// ---------------------------------------------------------------------------
// Reconciling what is in flight
// ---------------------------------------------------------------------------

/** Reasons that mean a rule (not the platform) stopped the message: the case is held back, not failed. */
const RULE_BLOCKS = new Set(["suppressed", "no_consent", "contact_unreachable", "human_owner", "stale_ownership", "ai_paused", "case_closed", "needs_approval", "followup_limit"]);

async function reconcile(db: Queryable, input: CaseRow, policy: MissedCallPolicy, now: Date): Promise<{ row: CaseRow; changed: boolean }> {
  let c = input;
  const { rows } = await db.query<{ id: string; status: string; message_id: string; m_status: string; blocked_reason: string | null; sent_at: Date | null }>(
    `select a.id, a.status, a.message_id, m.status as m_status, m.blocked_reason, m.sent_at
     from missed_call_actions a join conversation_messages m on m.id = a.message_id and m.org_id = a.org_id
     where a.org_id = $1 and a.case_id = $2 and a.kind = 'message' and a.status in ('queued', 'sent')`,
    [c.org_id, c.id],
  );
  let reached = false;
  let failure: { reason: string; rule: boolean } | null = null;
  for (const a of rows) {
    // A text recorded as sent earlier only ever moves on to delivered; it is not news about the case a second time.
    const wasQueued = a.status === "queued";
    if (a.m_status === "sent") { if (wasQueued) { await finishAction(db, a.id, "sent"); reached = true; } }
    else if (a.m_status === "delivered" || a.m_status === "read") { await finishAction(db, a.id, "delivered"); if (wasQueued) reached = true; }
    else if (!wasQueued) continue;
    else if (a.m_status === "failed") { await finishAction(db, a.id, "failed", { reason: "provider_failed" }); failure = { reason: "provider_failed", rule: false }; }
    else if (a.m_status === "blocked") {
      const reason = a.blocked_reason ?? "blocked";
      await finishAction(db, a.id, "blocked", { reason });
      failure = { reason, rule: RULE_BLOCKS.has(reason) };
    }
  }
  if (!rows.length) return { row: c, changed: false };
  if (reached && ["in_progress", "scheduled", "eligible", "awaiting_eligibility"].includes(c.state)) {
    const deadline = later(now, policy.responseWindowHours * 3_600_000);
    c = await advance(db, c, "awaiting_response", "message_sent", { responseDeadlineAt: deadline, nextActionAt: deadline });
    if (c.conversation_id) await recordConversationEvent(db, { orgId: c.org_id, conversationId: c.conversation_id, kind: "recovery_update", actor: { kind: "system" }, detail: { caseId: c.id, stage: "message_sent" } });
    return { row: c, changed: true };
  }
  if (failure && !reached && !isFinishedState(c.state) && ["in_progress", "scheduled", "eligible", "awaiting_eligibility", "awaiting_response"].includes(c.state)) {
    if (failure.rule) {
      c = await advance(db, c, "suppressed", `message_${failure.reason}`.slice(0, 60), { nextActionAt: later(now, minutes(REVISIT_MINUTES)) });
    } else {
      c = await advance(db, c, "failed", "message_failed", { lastError: failure.reason });
      await emitCaseEvent(db, c.org_id, c, "recovery.failed", { reason: failure.reason });
      await notifyOrgRoles(db, c.org_id, policy.notifyRoles, {
        kind: "missed_call_follow_up", severity: "warning", title: "A follow-up text could not be sent", body: "Call the customer back yourself. Open the missed call for details.",
        link: `/crm/calls?tab=recovery&case=${c.id}`, dedupeKey: `mcc:${c.id}:failed`,
      });
    }
    return { row: c, changed: true };
  }
  return { row: c, changed: false };
}

// ---------------------------------------------------------------------------
// One case
// ---------------------------------------------------------------------------

export async function processCase(db: Queryable, orgId: string, caseId: string, now: Date): Promise<CaseOutcome> {
  let c = await loadCase(db, orgId, caseId, { lock: true });
  if (!c || isFinishedState(c.state)) return "noop";
  if (c.paused_at) {
    await db.query("update missed_call_cases set lease_owner = null, lease_expires_at = null, next_action_at = null where id = $1", [c.id]);
    return "noop";
  }
  const policy = await getPolicy(db, orgId);

  const rec = await reconcile(db, c, policy, now);
  c = rec.row;
  // A message reached the caller (the case now waits for a reply), or failed or was held: that is this pass's whole job. The next pass, woken by the
  // caller's reply or the end of the window, looks at everything else.
  if (rec.changed || isFinishedState(c.state)) return "reconciled";

  const facts = await loadEligibilityFacts(db, c, policy, now);
  const elig = evaluateEligibility(facts);

  // 1. Settled.
  if (elig.close) {
    const close = elig.close;
    const patch: CasePatch = close.to === "recovered" ? { recoveredVia: close.via, recoveredAt: now } : {};
    const r = await transitionCase(db, { orgId, caseId, to: close.to, actor: SYSTEM_ACTOR, reason: close.reason.slice(0, 60).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || close.to, patch, expectedState: c.state });
    if (r.ok) {
      if (close.to === "recovered") await emitRecovered(db, orgId, r.row, close.via);
      else await emitCaseEvent(db, orgId, r.row, "recovery.completed", { outcome: close.to, reason: close.reason });
      if (r.row.conversation_id) await recordConversationEvent(db, { orgId, conversationId: r.row.conversation_id, kind: "recovery_update", actor: { kind: "system" }, detail: { caseId, stage: close.to === "recovered" ? "recovered" : "closed" } });
      return "closed";
    }
    return "noop";
  }

  // 2. Waiting for the caller. Inside the reply window the only thing to do is watch: a reply, a booking, a takeover or a callback settles or stops the
  // case through the checks above, and a case woken early by some other event goes back to waiting for the window's end instead of leaving this state.
  if (c.state === "awaiting_response" && c.response_deadline_at) {
    if (c.response_deadline_at.getTime() <= now.getTime()) return handleNoResponse(db, c, policy, elig, now);
    await patchCase(db, c, { nextActionAt: c.response_deadline_at });
    return "waiting";
  }

  // 3. The team's part (once). Only while the policy lets automation act.
  if (elig.team.allowed) c = await runTeamActions(db, c, policy, elig, facts.timing.nextOpen, facts.timing.withinBusinessHours, now);

  // 4. A message already on its way: look again soon.
  const inFlight = (await db.query("select 1 from missed_call_actions where org_id = $1 and case_id = $2 and kind = 'message' and status = 'queued'", [orgId, caseId])).rows.length > 0;
  if (inFlight) {
    c = await advance(db, c, "in_progress", "message_queued", { nextActionAt: later(now, minutes(RECONCILE_MINUTES)) });
    return "queued";
  }
  // A draft waiting for a person: nothing to do but keep watching for the case to settle or expire.
  const draft = (await db.query("select 1 from missed_call_actions where org_id = $1 and case_id = $2 and kind = 'message' and status = 'awaiting_approval'", [orgId, caseId])).rows.length > 0;
  if (draft && elig.message.allowed) {
    c = await advance(db, c, "eligible", "draft_ready", { nextActionAt: later(now, minutes(REVISIT_MINUTES)) });
    return "draft";
  }

  // 5. The message.
  if (!elig.team.allowed) {
    const reason = elig.team.reason;
    c = await advance(db, c, "suppressed", reason, { nextActionAt: later(now, minutes(REVISIT_MINUTES)) });
    return "suppressed";
  }
  if (elig.message.allowed) {
    const m = elig.message;
    const by = { kind: "system" as const, userId: policy.activatedBy };
    c = await advance(db, c, "eligible", "eligible", {}, SYSTEM_ACTOR);
    await emitCaseEvent(db, orgId, c, "recovery.eligible", { channel: m.channel }, `:${elig.attemptNo}`);
    if (policy.mode === "assisted") {
      const org = (await db.query<{ name: string }>("select name from organizations where id = $1", [orgId])).rows[0];
      const body = renderWording(policyWording(policy, m.afterHoursWording), { businessName: org?.name ?? "" });
      const id = await claimAction(db, c, "message", `mcc:${c.id}:draft:${elig.attemptNo}`, { channel: m.channel, attemptNo: elig.attemptNo, status: "awaiting_approval", draft: body });
      if (id) {
        await notifyOrgRoles(db, orgId, policy.notifyRoles, {
          kind: "missed_call_follow_up", severity: "info", title: "A follow-up text is ready to approve", body: "Review it and send it, or call the customer instead.",
          link: `/crm/calls?tab=recovery&case=${c.id}`, dedupeKey: `mcc:${c.id}:draft:${elig.attemptNo}`,
        });
        if (c.conversation_id) await recordConversationEvent(db, { orgId, conversationId: c.conversation_id, kind: "recovery_update", actor: { kind: "system" }, detail: { caseId: c.id, stage: "draft_ready" } });
      }
      await patchCase(db, c, { nextActionAt: later(now, minutes(REVISIT_MINUTES)) });
      return "draft";
    }
    // automatic
    const sent = await sendRecoveryMessage(db, c, policy, { channel: m.channel, afterHoursWording: m.afterHoursWording, attemptNo: elig.attemptNo, recordInboundCallConsent: m.recordInboundCallConsent, by, now });
    c = (await loadCase(db, orgId, caseId))!;
    if (sent.status === "queued") {
      await advance(db, c, "in_progress", "message_queued", { nextActionAt: later(now, minutes(RECONCILE_MINUTES)) });
      return "queued";
    }
    await advance(db, c, "suppressed", `message_${sent.reason ?? "blocked"}`.slice(0, 60), { nextActionAt: later(now, minutes(REVISIT_MINUTES)) });
    return "suppressed";
  }
  const block = elig.message.block;
  if (block.kind === "wait") {
    c = await advance(db, c, "scheduled", block.reason, { nextActionAt: new Date(Math.max(block.until.getTime(), now.getTime() + minutes(1))) });
    return "waiting";
  }
  // A rule that will not change by waiting (or one a person must change): held back, looked at again from time to time until the case expires.
  c = await advance(db, c, "suppressed", block.reason, { nextActionAt: later(now, minutes(block.permanent ? REVISIT_MINUTES * 4 : REVISIT_MINUTES)) });
  return "suppressed";
}

async function handleNoResponse(db: Queryable, c: CaseRow, policy: MissedCallPolicy, elig: Eligibility, now: Date): Promise<CaseOutcome> {
  if (policy.enabled && policy.actionMessage && policy.mode !== "manual" && c.attempts < policy.maxAttempts) {
    await advance(db, c, "awaiting_eligibility", "no_response_retry", { nextActionAt: later(c.last_attempt_at ?? now, minutes(policy.attemptGapMinutes)) });
    return "timed_out";
  }
  if (policy.enabled && policy.actionFollowUp) {
    const org = (await db.query<{ name: string; timezone: string }>("select name, timezone from organizations where id = $1", [c.org_id])).rows[0];
    const actor = systemActor({ id: c.org_id, name: org?.name, timezone: org?.timezone }, "Missed-call recovery");
    const id = await claimAction(db, c, "follow_up", `mcc:${c.id}:follow_up`);
    if (id) {
      const task = await createTaskInTx(db, actor, {
        title: "Try this caller again: no reply to the follow-up", description: "The caller did not answer the follow-up message. Call them back or close the case.",
        dueAt: later(now, minutes(60)).toISOString(), priority: "high", assigneeId: c.owner_user_id, contactId: c.contact_id,
      }, { source: "system" });
      await finishAction(db, id, "done", { taskId: task.id });
    }
  }
  const r = await transitionCase(db, { orgId: c.org_id, caseId: c.id, to: "completed_without_recovery", actor: SYSTEM_ACTOR, reason: "no_response", expectedState: "awaiting_response" });
  if (r.ok) await emitCaseEvent(db, c.org_id, r.row, "recovery.completed", { outcome: "completed_without_recovery", reason: "no_response" });
  void elig;
  return "timed_out";
}

// ---------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------

export interface RecoveryRun {
  claimed: number;
  closed: number;
  queued: number;
  drafts: number;
  waiting: number;
  suppressed: number;
  failed: number;
  errors: number;
  swept: number;
}

export interface RecoveryOptions {
  now?: Date;
  /** Cases handled in one run (default 50). */
  limit?: number;
  /** At most this many from one workspace in one run, so a busy workspace can't starve the others (default 10). */
  perOrgLimit?: number;
  /** Only this workspace (used by tests and by "work this case now"). */
  orgId?: string;
  worker?: string;
}

export async function processMissedCalls(opts: RecoveryOptions = {}): Promise<RecoveryRun> {
  const now = opts.now ?? new Date();
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const perOrg = Math.min(50, Math.max(1, opts.perOrgLimit ?? 10));
  const worker = opts.worker ?? `w-${crypto.randomBytes(4).toString("hex")}`;
  const run: RecoveryRun = { claimed: 0, closed: 0, queued: 0, drafts: 0, waiting: 0, suppressed: 0, failed: 0, errors: 0, swept: 0 };

  // The sweep is a safety net for a case that was not written when its call was. A scheduled run does it every ten minutes (its own heartbeat); a run for one
  // workspace, or for a test, does it at once.
  if (opts.orgId) run.swept = await sweepRecentCalls(now, 100, opts.orgId);
  else {
    const swept = await runJob("missedCallSweep", () => sweepRecentCalls(now, 100), (n) => ({ processed: n }), { everyMinutes: 10, now });
    run.swept = swept.ok && !("skipped" in swept) ? swept.value : 0;
  }

  const claimed = await withSystem(async (db) => {
    const candidates = await db.query<{ id: string; org_id: string }>(
      `select id, org_id from (
         select id, org_id, next_action_at, row_number() over (partition by org_id order by next_action_at) as rn
         from missed_call_cases
         where paused_at is null and state = any($1::text[]) and next_action_at <= $2 and (lease_owner is null or lease_expires_at <= $2) and ($3::uuid is null or org_id = $3)
       ) due where rn <= $4 order by next_action_at limit $5`,
      [ACTIVE_STATES, now, opts.orgId ?? null, perOrg, limit],
    );
    if (!candidates.rows.length) return [];
    // The update is the claim: a worker that loses the race finds the lease already taken and gets nothing back for that row.
    const got = await db.query<{ id: string; org_id: string }>(
      `update missed_call_cases set lease_owner = $1, lease_expires_at = $2, process_attempts = process_attempts + 1
       where id = any($3::uuid[]) and paused_at is null and state = any($4::text[]) and (lease_owner is null or lease_expires_at <= $5) returning id, org_id`,
      [worker, later(now, minutes(LEASE_MINUTES)), candidates.rows.map((r) => r.id), ACTIVE_STATES, now],
    );
    return got.rows;
  });
  run.claimed = claimed.length;

  for (const c of claimed) {
    try {
      const outcome = await withSystem(async (db) => {
        const o = await processCase(db, c.org_id, c.id, now);
        // Done for this pass: release the lease and forget earlier failures. A pass that set a new due time keeps it.
        await db.query("update missed_call_cases set lease_owner = null, lease_expires_at = null, process_attempts = 0, last_error = null where id = $1 and lease_owner = $2", [c.id, worker]);
        return o;
      });
      if (outcome === "closed" || outcome === "timed_out") run.closed += 1;
      else if (outcome === "queued") run.queued += 1;
      else if (outcome === "draft") run.drafts += 1;
      else if (outcome === "waiting") run.waiting += 1;
      else if (outcome === "suppressed") run.suppressed += 1;
      else if (outcome === "failed") run.failed += 1;
    } catch (err) {
      run.errors += 1;
      await recordFailure(c.org_id, c.id, worker, err, now);
    }
  }
  return run;
}

/** A pass that threw: back off, and after enough failures stop retrying and tell the team. */
async function recordFailure(orgId: string, caseId: string, worker: string, err: unknown, now: Date): Promise<void> {
  const message = (err instanceof Error ? err.name + (("code" in err && typeof (err as { code?: unknown }).code === "string") ? ` ${(err as { code: string }).code}` : "") : "Error").slice(0, 200);
  if (process.env.MCC_DEBUG) console.error("[iacquire] missed-call recovery failed (debug)", err);
  else if (process.env.NODE_ENV !== "test") logSafeServerDiagnostic("missed call recovery failed", err, "missed_call_recovery");
  await withSystem(async (db) => {
    const c = await loadCase(db, orgId, caseId, { lock: true });
    if (!c || isFinishedState(c.state)) return;
    if (c.process_attempts >= MAX_PROCESS_ATTEMPTS) {
      const r = await transitionCase(db, { orgId, caseId, to: "failed", actor: SYSTEM_ACTOR, reason: "processing_error", patch: { lastError: message } });
      if (r.ok) {
        await emitCaseEvent(db, orgId, r.row, "recovery.failed", { reason: "processing_error" });
        const policy = await getPolicy(db, orgId);
        await notifyOrgRoles(db, orgId, policy.notifyRoles, {
          kind: "missed_call_follow_up", severity: "warning", title: "A missed call could not be worked automatically", body: "Call the customer back yourself. Open the missed call for details.",
          link: `/crm/calls?tab=recovery&case=${caseId}`, dedupeKey: `mcc:${caseId}:error`,
        });
      }
      return;
    }
    const backoff = Math.min(60, 2 ** Math.min(6, c.process_attempts));
    await db.query(
      "update missed_call_cases set lease_owner = null, lease_expires_at = null, next_action_at = $3, last_error = $4 where id = $1 and org_id = $2 and (lease_owner = $5 or lease_owner is null)",
      [caseId, orgId, later(now, minutes(backoff)), message, worker],
    );
  });
}

/**
 * Picks up calls whose case sync did not happen (it ran in a savepoint that rolled back, or the process stopped between the call and its
 * case). Only recent, final, inbound calls with no case link that look like missed calls are looked at, so it stays cheap.
 */
export async function sweepRecentCalls(now: Date, limit: number, orgId?: string): Promise<number> {
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; org_id: string }>(
      `select r.id, r.org_id from crm_call_records r
       where r.direction = 'inbound' and r.created_at > $1 and ($3::uuid is null or r.org_id = $3)
         and (r.status in ('no_answer', 'voicemail', 'busy', 'failed', 'cancelled') or (r.status = 'completed' and coalesce(r.duration_seconds, 0) <= 60))
         and not exists (select 1 from missed_call_case_calls l where l.org_id = r.org_id and l.call_record_id = r.id)
       order by r.created_at desc limit $2`,
      [new Date(now.getTime() - 48 * 3_600_000), limit, orgId ?? null],
    );
    let n = 0;
    for (const r of rows) {
      await db.query("savepoint mcc_sweep");
      try {
        const res = await syncCaseForCall(db, r.org_id, r.id, now);
        await db.query("release savepoint mcc_sweep");
        if (res.outcome === "created" || res.outcome === "joined") n += 1;
      } catch {
        await db.query("rollback to savepoint mcc_sweep");
      }
    }
    return n;
  });
}

export { blockReasonText };
