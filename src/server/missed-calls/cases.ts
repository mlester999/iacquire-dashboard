import "server-only";
import type { Queryable } from "@/server/db";
import { releaseReservation } from "@/server/billing/ledger";
import { systemActor } from "@/server/crm/actor";
import { emitEvent, recordActivity } from "@/server/crm/events";
import { recordConversationEvent } from "@/server/messaging/events";
import { isWithinBusinessHours, validateBusinessHours, type BusinessHours } from "@/lib/messaging";
import { classifyCall } from "@/lib/missed-calls/classify";
import { E164 } from "@/server/integrations/voice/types";
import { getPolicy } from "@/server/missed-calls/policy";
import {
  canTransition, isFinishedState, isPersonOnlyMove, actorIsPerson, CALL_CLASS_LABELS,
  type CallClass, type CaseActor, type CaseState,
} from "@/lib/missed-calls/state";

// The case: one caller who was missed and is owed an answer. This module is the only place a case is created, joined, reclassified or moved
// between states. Everything it does is idempotent for a call id (a redelivered or corrected provider event finds its case again), every
// state change is a validated, versioned transition with an actor and a history row, and a finished case is never reopened by the engine.

export interface CaseRow {
  id: string;
  org_id: string;
  contact_id: string | null;
  conversation_id: string | null;
  caller_number: string | null;
  business_number: string | null;
  classification: CallClass;
  after_hours: boolean;
  provider: "vapi" | "retell" | "manual";
  first_called_at: Date;
  last_called_at: Date;
  call_count: number;
  state: CaseState;
  state_reason: string | null;
  state_changed_at: Date;
  version: number;
  next_action_at: Date | null;
  attempts: number;
  last_attempt_at: Date | null;
  first_action_at: Date | null;
  response_deadline_at: Date | null;
  owner_kind: "unassigned" | "human" | "ai";
  owner_user_id: string | null;
  owner_agent_id: string | null;
  owner_version: number;
  paused_at: Date | null;
  paused_by: string | null;
  recovered_via: "customer_reply" | "appointment_booked" | "callback_completed" | "manual" | null;
  recovered_at: Date | null;
  resolved_at: Date | null;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  process_attempts: number;
  last_error: string | null;
  created_at: Date;
}

export async function loadCase(db: Queryable, orgId: string, id: string, opts: { lock?: boolean } = {}): Promise<CaseRow | null> {
  const { rows } = await db.query<CaseRow>(`select * from missed_call_cases where id = $1 and org_id = $2${opts.lock ? " for update" : ""}`, [id, orgId]);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export async function addCaseEvent(
  db: Queryable,
  e: { orgId: string; caseId: string; kind: string; from?: CaseState | null; to?: CaseState | null; actor: CaseActor; detail?: Record<string, unknown> },
): Promise<void> {
  const a = e.actor;
  await db.query(
    `insert into missed_call_case_events (org_id, case_id, kind, from_state, to_state, actor_kind, actor_user_id, agent_id, detail)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      e.orgId, e.caseId, e.kind, e.from ?? null, e.to ?? null, a.kind, a.kind === "user" || a.kind === "agency" ? a.userId : null, a.kind === "ai" ? a.agentId : null,
      JSON.stringify(e.detail ?? {}),
    ],
  );
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/** Columns a transition may set alongside the state. Anything else is not writable through it. */
const PATCHABLE = {
  nextActionAt: "next_action_at", attempts: "attempts", lastAttemptAt: "last_attempt_at", firstActionAt: "first_action_at", responseDeadlineAt: "response_deadline_at",
  ownerKind: "owner_kind", ownerUserId: "owner_user_id", ownerAgentId: "owner_agent_id", pausedAt: "paused_at", pausedBy: "paused_by", recoveredVia: "recovered_via",
  recoveredAt: "recovered_at", contactId: "contact_id", conversationId: "conversation_id", lastError: "last_error",
} as const;
export type CasePatch = Partial<Record<keyof typeof PATCHABLE, unknown>>;

export type TransitionResult =
  | { ok: true; row: CaseRow; from: CaseState }
  | { ok: false; code: "not_found" | "version_conflict" | "illegal" | "person_only"; from?: CaseState };

export interface TransitionInput {
  orgId: string;
  caseId: string;
  to: CaseState;
  actor: CaseActor;
  reason: string;
  /** The version the caller read. A stale caller is refused instead of overwriting a newer change. */
  expectedVersion?: number;
  /** For an engine pass: the case must still be in this state (the case may have moved while the pass was working). */
  expectedState?: CaseState;
  patch?: CasePatch;
  detail?: Record<string, unknown>;
}

/**
 * Moves a case to another state, atomically with its history row. Locks the case, checks the move against the table, the caller's version
 * and (for the few moves reserved for people) the actor, then writes. A finished case clears its due time and lease so the worker leaves it alone.
 */
export async function transitionCase(db: Queryable, t: TransitionInput): Promise<TransitionResult> {
  const cur = await loadCase(db, t.orgId, t.caseId, { lock: true });
  if (!cur) return { ok: false, code: "not_found" };
  if (t.expectedVersion !== undefined && cur.version !== t.expectedVersion) return { ok: false, code: "version_conflict", from: cur.state };
  if (t.expectedState !== undefined && cur.state !== t.expectedState) return { ok: false, code: "version_conflict", from: cur.state };
  if (!canTransition(cur.state, t.to)) return { ok: false, code: "illegal", from: cur.state };
  if (isPersonOnlyMove(cur.state, t.to) && !actorIsPerson(t.actor)) return { ok: false, code: "person_only", from: cur.state };

  const sets: string[] = ["state = $3", "state_reason = $4", "state_changed_at = now()", "version = version + 1"];
  const params: unknown[] = [t.caseId, t.orgId, t.to, t.reason.slice(0, 60)];
  const set = (col: string, value: unknown) => {
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  };
  for (const [key, value] of Object.entries(t.patch ?? {})) {
    const col = PATCHABLE[key as keyof typeof PATCHABLE];
    // A finished case has no due time: the transition clears it below, so a patch for it would assign the column twice.
    if (isFinishedState(t.to) && (col === "next_action_at")) continue;
    if (col && value !== undefined) set(col, value);
  }
  if (isFinishedState(t.to)) {
    sets.push("resolved_at = now()", "next_action_at = null", "lease_owner = null", "lease_expires_at = null");
    if (t.to === "recovered" && !("recoveredAt" in (t.patch ?? {}))) sets.push("recovered_at = now()");
  }
  if (t.actor.kind === "user" || t.actor.kind === "agency") {
    // A person moving the case makes the case theirs to answer for: automation stops waiting on a timer that was set before they acted.
    if (!("nextActionAt" in (t.patch ?? {})) && !isFinishedState(t.to)) sets.push("lease_owner = null", "lease_expires_at = null");
  }
  const { rows } = await db.query<CaseRow>(`update missed_call_cases set ${sets.join(", ")} where id = $1 and org_id = $2 returning *`, params);
  await addCaseEvent(db, { orgId: t.orgId, caseId: t.caseId, kind: "state_changed", from: cur.state, to: t.to, actor: t.actor, detail: { reason: t.reason.slice(0, 60), ...(t.detail ?? {}) } });
  if (isFinishedState(t.to)) await cancelOpenActions(db, t.orgId, t.caseId, `case_${t.to}`);
  return { ok: true, row: rows[0], from: cur.state };
}

// ---------------------------------------------------------------------------
// Actions left open when a case finishes
// ---------------------------------------------------------------------------

/**
 * A case that finished (the caller was reached, it was cancelled, the call turned out to be answered) must not go on to text anyone: its
 * planned and awaiting actions are cancelled, and a text that is queued but not yet being sent is stopped and its credit released. A text
 * already handed to the provider cannot be recalled, and is left as it is.
 */
export async function cancelOpenActions(db: Queryable, orgId: string, caseId: string, reason: string): Promise<number> {
  const open = await db.query<{ id: string; status: string; message_id: string | null }>(
    "select id, status, message_id from missed_call_actions where org_id = $1 and case_id = $2 and status in ('planned', 'awaiting_approval', 'queued') for update",
    [orgId, caseId],
  );
  let canceled = 0;
  for (const a of open.rows) {
    if (a.message_id) {
      const stopped = await db.query<{ id: string; reservation_id: string | null }>(
        `update conversation_messages set status = 'blocked', blocked_reason = 'case_closed', status_detail = 'Stopped before sending.'
         where id = $1 and org_id = $2 and status in ('draft', 'queued') returning id, reservation_id`,
        [a.message_id, orgId],
      );
      if (stopped.rows[0]?.reservation_id) await releaseReservation(db, { orgId, reservationId: stopped.rows[0].reservation_id, reason: `Stopped: ${reason}` });
      // The message is already on its way: leave the action to be reconciled with what actually happened.
      if (!stopped.rows.length) continue;
    }
    await db.query("update missed_call_actions set status = 'canceled', reason = $3 where id = $1 and org_id = $2", [a.id, orgId, reason.slice(0, 60)]);
    canceled += 1;
  }
  return canceled;
}

// ---------------------------------------------------------------------------
// Syncing a case from a call record
// ---------------------------------------------------------------------------

export type SyncOutcome = "not_missed" | "created" | "joined" | "unchanged" | "reclassified" | "canceled" | "recovered";
export interface SyncResult {
  outcome: SyncOutcome;
  caseId: string | null;
}

interface CallRow {
  id: string; provider: "vapi" | "retell" | "manual"; direction: "inbound" | "outbound"; status: "ringing" | "in_progress" | "completed" | "no_answer" | "busy" | "failed" | "voicemail" | "cancelled";
  from_number: string | null; to_number: string | null; contact_id: string | null; started_at: Date | null; created_at: Date; duration_seconds: number | null;
  disposition: string | null; summary: string | null; transcript_ref: string | null;
}

/** The contacts that hold this exact number. Zero, one, or "more than one" (two or more are never guessed between). */
async function contactsForNumber(db: Queryable, orgId: string, phone: string): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `select distinct c.id from contacts c
     where c.org_id = $1 and c.deleted_at is null
       and (c.phone = $2 or exists (select 1 from contact_identities i where i.org_id = c.org_id and i.contact_id = c.id and i.kind = 'phone' and i.value = $2))
     limit 3`,
    [orgId, phone],
  );
  return rows.map((r) => r.id);
}

/**
 * Called inside the transaction that saved a call record (and after a person edits one), so the case and the call can't disagree. Safe to
 * call any number of times for the same call: the result depends only on the call's latest state.
 */
export async function syncCaseForCall(db: Queryable, orgId: string, callRecordId: string, now = new Date()): Promise<SyncResult> {
  const call = (await db.query<CallRow>(
    `select id, provider, direction, status, from_number, to_number, contact_id, started_at, created_at, duration_seconds, disposition, summary, transcript_ref
     from crm_call_records where id = $1 and org_id = $2`,
    [callRecordId, orgId],
  )).rows[0];
  if (!call) return { outcome: "not_missed", caseId: null };

  const policy = await getPolicy(db, orgId);
  const verdict = classifyCall(
    { direction: call.direction, status: call.status, durationSeconds: call.duration_seconds, disposition: call.disposition, hasContent: Boolean(call.summary || call.transcript_ref) },
    { abandonedMaxSeconds: policy.abandonedMaxSeconds },
  );
  const link = (await db.query<{ id: string; case_id: string; counted: boolean; classification: CallClass }>(
    "select id, case_id, counted, classification from missed_call_case_calls where org_id = $1 and call_record_id = $2 for update",
    [orgId, callRecordId],
  )).rows[0];

  if (!verdict.missed) {
    if (link?.counted) return reclassifiedAsAnswered(db, orgId, link, verdict.reason, now);
    if (call.direction === "outbound" && call.status === "completed" && (call.duration_seconds ?? 0) > 0) return callbackCompleted(db, orgId, call, now);
    return { outcome: "not_missed", caseId: link?.case_id ?? null };
  }

  const calledAt = call.started_at ?? call.created_at;
  const callerNumber = call.from_number && E164.test(call.from_number) ? call.from_number : null;
  const businessNumber = call.to_number && E164.test(call.to_number) ? call.to_number : null;
  const org = (await db.query<{ name: string; timezone: string }>("select name, timezone from organizations where id = $1", [orgId])).rows[0];
  const hoursRow = (await db.query<{ business_hours: unknown }>("select business_hours from messaging_settings where org_id = $1", [orgId])).rows[0];
  const afterHours = !isWithinBusinessHours(validateBusinessHours(hoursRow?.business_hours ?? {}) as BusinessHours | null, calledAt, org?.timezone ?? "UTC");

  if (link) {
    // The same call again (a redelivery, or the provider correcting its report): update what it says and leave the case alone.
    const changed = link.classification !== verdict.class || !link.counted;
    if (changed) {
      await db.query("update missed_call_case_calls set classification = $2, counted = true, after_hours = $3 where id = $1", [link.id, verdict.class, afterHours]);
      await recountCase(db, orgId, link.case_id);
      await addCaseEvent(db, { orgId, caseId: link.case_id, kind: "call_reclassified", actor: { kind: "provider" }, detail: { callId: callRecordId, class: verdict.class, counted: true } });
      return { outcome: "reclassified", caseId: link.case_id };
    }
    return { outcome: "unchanged", caseId: link.case_id };
  }

  const actor = systemActor({ id: orgId, name: org?.name, timezone: org?.timezone }, call.provider === "manual" ? "Call log" : call.provider);

  // One open case per caller number: take a lock on the pair so two calls handled at once can't both create one.
  if (callerNumber) await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`mcc:${orgId}:${callerNumber}`]);
  const open = callerNumber
    ? (await db.query<CaseRow>(
        "select * from missed_call_cases where org_id = $1 and caller_number = $2 and state not in ('recovered', 'completed_without_recovery', 'canceled', 'failed') for update",
        [orgId, callerNumber],
      )).rows[0]
    : undefined;

  let caseId: string;
  let outcome: SyncOutcome;
  let contactId: string | null = open?.contact_id ?? call.contact_id ?? null;
  let conversationId: string | null = open?.conversation_id ?? null;

  if (open) {
    caseId = open.id;
    outcome = "joined";
    await db.query(
      "update missed_call_cases set call_count = call_count + 1, last_called_at = greatest(last_called_at, $3), first_called_at = least(first_called_at, $3), next_action_at = case when state in ('suppressed', 'awaiting_response') then now() else next_action_at end where id = $1 and org_id = $2",
      [open.id, orgId, calledAt],
    );
    await addCaseEvent(db, { orgId, caseId, kind: "call_added", actor: { kind: "provider" }, detail: { callId: callRecordId, class: verdict.class, afterHours } });
  } else {
    if (!contactId && callerNumber) {
      const found = await contactsForNumber(db, orgId, callerNumber);
      // Exactly one contact holds the number: link it. Two or more: link nobody (a person decides). None: create one only when the workspace
      // switched recovery on, so a workspace that never asked for it doesn't fill with contacts from every wrong number.
      if (found.length === 1) contactId = found[0];
      else if (found.length === 0 && policy.enabled) contactId = await createCallerContact(db, orgId, callerNumber);
    }
    if (contactId && policy.enabled) conversationId = await ensureConversation(db, orgId, contactId);
    const created = await db.query<{ id: string }>(
      `insert into missed_call_cases (org_id, contact_id, conversation_id, caller_number, business_number, classification, after_hours, provider, first_called_at, last_called_at,
         state, state_reason, next_action_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, 'detected', 'call_detected', $10) returning id`,
      [orgId, contactId, conversationId, callerNumber, businessNumber, verdict.class, afterHours, call.provider, calledAt, now],
    );
    caseId = created.rows[0].id;
    outcome = "created";
    await addCaseEvent(db, { orgId, caseId, kind: "case_created", to: "detected", actor: { kind: "provider" }, detail: { callId: callRecordId, class: verdict.class, afterHours, contactLinked: Boolean(contactId) } });
  }

  await db.query(
    "insert into missed_call_case_calls (org_id, case_id, call_record_id, classification, after_hours, called_at) values ($1, $2, $3, $4, $5, $6)",
    [orgId, caseId, callRecordId, verdict.class, afterHours, calledAt],
  );
  if (contactId && !call.contact_id) await db.query("update crm_call_records set contact_id = $3 where id = $1 and org_id = $2 and contact_id is null", [callRecordId, orgId, contactId]);

  // Where people will see it: the contact's timeline, the conversation (new inbox), and the event outbox (Automation Studio).
  if (contactId) {
    await recordActivity(db, actor, {
      kind: "call.missed", summary: `Missed call: ${CALL_CLASS_LABELS[verdict.class].toLowerCase()}${afterHours ? " (after hours)" : ""}`, contactId, refType: "call", refId: callRecordId,
      metadata: { caseId, class: verdict.class, afterHours, provider: call.provider }, occurredAt: calledAt,
    });
  }
  if (conversationId) {
    await db.query(
      `update conversations set last_message_at = greatest(coalesce(last_message_at, 'epoch'), $3), last_message_preview = $4, unread_count = unread_count + 1, status = 'open'
       where id = $1 and org_id = $2`,
      [conversationId, orgId, calledAt, `Missed call${afterHours ? " (after hours)" : ""}`],
    );
    await recordConversationEvent(db, { orgId, conversationId, kind: "missed_call", actor: { kind: "system" }, detail: { caseId, callId: callRecordId, class: verdict.class, afterHours } });
  }
  await emitEvent(db, actor, {
    type: "call.missed", entityType: "call", entityId: callRecordId, contactId,
    payload: { caseId, callId: callRecordId, provider: call.provider, class: verdict.class, afterHours, contactMatched: Boolean(contactId), joinedExisting: outcome === "joined" },
    dedupeKey: `call.missed:${callRecordId}`,
  });
  return { outcome, caseId };
}

/** The case's counts follow its calls: how many still count as missed, and when the last one was. */
async function recountCase(db: Queryable, orgId: string, caseId: string): Promise<number> {
  const { rows } = await db.query<{ n: string; last: Date | null; first: Date | null }>(
    "select count(*)::text as n, max(called_at) as last, min(called_at) as first from missed_call_case_calls where org_id = $1 and case_id = $2 and counted",
    [orgId, caseId],
  );
  const n = Number(rows[0].n);
  if (n > 0) await db.query("update missed_call_cases set call_count = $3, last_called_at = $4, first_called_at = $5 where id = $1 and org_id = $2", [caseId, orgId, n, rows[0].last, rows[0].first]);
  return n;
}

/** A call that looked missed turned out to have been answered (a late correction). Without another missed call the case is cancelled. */
async function reclassifiedAsAnswered(db: Queryable, orgId: string, link: { id: string; case_id: string }, reason: string, now: Date): Promise<SyncResult> {
  await db.query("update missed_call_case_calls set counted = false where id = $1", [link.id]);
  await addCaseEvent(db, { orgId, caseId: link.case_id, kind: "call_reclassified", actor: { kind: "provider" }, detail: { counted: false, reason } });
  const remaining = await recountCase(db, orgId, link.case_id);
  if (remaining > 0) return { outcome: "reclassified", caseId: link.case_id };
  const cur = await loadCase(db, orgId, link.case_id, { lock: true });
  if (cur && !isFinishedState(cur.state)) {
    const r = await transitionCase(db, { orgId, caseId: link.case_id, to: "canceled", actor: { kind: "provider" }, reason: "answered_later" });
    if (r.ok) return { outcome: "canceled", caseId: link.case_id };
  }
  void now;
  return { outcome: "reclassified", caseId: link.case_id };
}

/** A person's outbound call to the caller was answered: the caller has been reached. */
async function callbackCompleted(db: Queryable, orgId: string, call: CallRow, now: Date): Promise<SyncResult> {
  const number = call.to_number && E164.test(call.to_number) ? call.to_number : null;
  if (!number) return { outcome: "not_missed", caseId: null };
  const open = (await db.query<CaseRow>(
    "select * from missed_call_cases where org_id = $1 and caller_number = $2 and state not in ('recovered', 'completed_without_recovery', 'canceled', 'failed') for update",
    [orgId, number],
  )).rows[0];
  if (!open) return { outcome: "not_missed", caseId: null };
  const calledAt = call.started_at ?? call.created_at;
  // Only a call made after the missed one answers it (a late-arriving record of an earlier outbound call does not).
  if (calledAt.getTime() < open.last_called_at.getTime()) return { outcome: "not_missed", caseId: open.id };
  const r = await transitionCase(db, { orgId, caseId: open.id, to: "recovered", actor: { kind: "system" }, reason: "callback_completed", patch: { recoveredVia: "callback_completed", recoveredAt: now }, detail: { callId: call.id } });
  if (r.ok) await emitRecovered(db, orgId, r.row, "callback_completed");
  return { outcome: r.ok ? "recovered" : "unchanged", caseId: open.id };
}

/**
 * The Automation Studio triggers for a case's life: `recovery.eligible` (a follow-up is allowed), `recovery.failed`, `recovery.responded` (the
 * caller wrote back) and `recovery.completed` (the case finished, with how). Each is announced once per case and attempt (the key says which).
 */
export type RecoveryEventType = "recovery.eligible" | "recovery.failed" | "recovery.responded" | "recovery.completed";
export async function emitCaseEvent(db: Queryable, orgId: string, c: Pick<CaseRow, "id" | "contact_id" | "classification" | "attempts">, type: RecoveryEventType, extra: Record<string, unknown> = {}, keySuffix = ""): Promise<void> {
  const org = (await db.query<{ name: string; timezone: string }>("select name, timezone from organizations where id = $1", [orgId])).rows[0];
  await emitEvent(db, systemActor({ id: orgId, name: org?.name, timezone: org?.timezone }, "Missed-call recovery"), {
    type, entityType: "missed_call_case", entityId: c.id, contactId: c.contact_id,
    payload: { caseId: c.id, attempts: c.attempts, class: c.classification, ...extra },
    dedupeKey: `${type}:${c.id}${keySuffix}`,
  });
}

/** A settled case: `recovery.completed`, and `recovery.responded` as well when the caller wrote back. */
export async function emitRecovered(db: Queryable, orgId: string, c: CaseRow, via: string): Promise<void> {
  if (via === "customer_reply") await emitCaseEvent(db, orgId, c, "recovery.responded");
  await emitCaseEvent(db, orgId, c, "recovery.completed", { outcome: "recovered", via });
}

async function createCallerContact(db: Queryable, orgId: string, phone: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "insert into contacts (org_id, display_name, phone, source, created_via) values ($1, '', $2, 'missed_call', 'call') returning id",
    [orgId, phone],
  );
  // The number came from caller ID, which can be faked: the identity is recorded, not verified.
  await db.query("insert into contact_identities (org_id, contact_id, kind, value, verified, verified_via) values ($1, $2, 'phone', $3, false, null) on conflict do nothing", [orgId, rows[0].id, phone]);
  return rows[0].id;
}

/** The contact's main SMS conversation, created if it doesn't exist (so the missed call has somewhere to appear). */
export async function ensureConversation(db: Queryable, orgId: string, contactId: string, channel: "sms" | "email" = "sms"): Promise<string> {
  const existing = await db.query<{ id: string }>("select id from conversations where org_id = $1 and contact_id = $2 and channel = $3 and thread_key = 'main'", [orgId, contactId, channel]);
  if (existing.rows[0]) return existing.rows[0].id;
  const agent = await db.query<{ id: string }>("select id from agent_instances where org_id = $1 and role_key = 'sales_assistant' and enabled", [orgId]);
  const created = await db.query<{ id: string }>(
    `insert into conversations (org_id, contact_id, channel, thread_key, ai_agent_id, owner_kind) values ($1, $2, $3, 'main', $4, $5)
     on conflict do nothing returning id`,
    [orgId, contactId, channel, agent.rows[0]?.id ?? null, agent.rows[0] ? "ai" : "unassigned"],
  );
  if (created.rows[0]) return created.rows[0].id;
  return (await db.query<{ id: string }>("select id from conversations where org_id = $1 and contact_id = $2 and channel = $3 and thread_key = 'main'", [orgId, contactId, channel])).rows[0].id;
}
