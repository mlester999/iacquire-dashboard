import "server-only";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { assertCan, auditActor, crmRead, crmWrite, type CrmActor } from "@/server/crm/actor";
import { notifyOrgRoles } from "@/server/notifications";
import { recordConversationEvent } from "@/server/messaging/events";
import { evaluateEligibility } from "@/lib/missed-calls/eligibility";
import { wordingProblem } from "@/lib/missed-calls/policy";
import {
  caseStatusLabel, isFinishedState, CALL_CLASS_LABELS, type ActionKind, type ActionStatus, type CallClass, type CaseActor, type CaseState,
} from "@/lib/missed-calls/state";
import { addCaseEvent, emitCaseEvent, emitRecovered, loadCase, transitionCase, type CaseRow } from "@/server/missed-calls/cases";
import { sendRecoveryMessage } from "@/server/missed-calls/engine";
import { loadEligibilityFacts } from "@/server/missed-calls/facts";
import { getPolicy } from "@/server/missed-calls/policy";

// What people do to a case: read it, own it, pause it, approve or reject a drafted text, settle it by hand. Every change is a validated,
// versioned transition (or an owner change that moves `owner_version`), written with the person as the actor, and an action prepared for
// one owner is refused if the case has changed hands since.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

export function caseActorOf(actor: CrmActor): CaseActor {
  if (actor.kind === "member" && actor.userId) return { kind: "user", userId: actor.userId };
  if (actor.kind === "agency" && actor.userId) return { kind: "agency", userId: actor.userId };
  if (actor.kind === "agent" && actor.agentId) return { kind: "ai", agentId: actor.agentId };
  return { kind: "system" };
}

function assertCanRead(actor: CrmActor) {
  assertCan(actor, "calls.view", "Your role doesn't include call records.");
}
function assertCanWork(actor: CrmActor) {
  assertCan(actor, "calls.view", "Your role doesn't include call records.");
  assertCan(actor, "contacts.edit", "Working a missed call needs permission to edit contacts.");
}
const requireId = (id: string) => {
  if (!UUID.test(id)) throw new AppError("not_found", "Missed call not found.");
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface CaseActionView {
  id: string;
  kind: ActionKind;
  channel: "sms" | "email" | null;
  status: ActionStatus;
  reason: string | null;
  attemptNo: number;
  draftBody: string | null;
  scheduledFor: string | null;
  executedAt: string | null;
  messageId: string | null;
  taskId: string | null;
  createdAt: string;
}

export interface CaseEventView {
  id: number;
  kind: string;
  fromState: CaseState | null;
  toState: CaseState | null;
  actor: { kind: string; name: string | null };
  detail: Record<string, unknown>;
  at: string;
}

export interface CaseView {
  id: string;
  state: CaseState;
  stateReason: string | null;
  statusLabel: string;
  classification: CallClass;
  classificationLabel: string;
  afterHours: boolean;
  provider: "vapi" | "retell" | "manual";
  callerNumber: string | null;
  businessNumber: string | null;
  contact: { id: string; name: string } | null;
  conversationId: string | null;
  owner: { kind: "unassigned" | "human" | "ai"; userId: string | null; name: string | null };
  ownerVersion: number;
  version: number;
  paused: boolean;
  firstCalledAt: string;
  lastCalledAt: string;
  callCount: number;
  attempts: number;
  nextActionAt: string | null;
  responseDeadlineAt: string | null;
  firstActionAt: string | null;
  recoveredVia: string | null;
  recoveredAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

interface CaseViewRow extends CaseRow {
  contact_name: string | null;
  owner_name: string | null;
}

const CASE_SELECT = `select c.*, k.display_name as contact_name, coalesce(nullif(u.full_name, ''), u.email::text) as owner_name
  from missed_call_cases c
  left join contacts k on k.id = c.contact_id and k.org_id = c.org_id and k.deleted_at is null
  left join users u on u.id = c.owner_user_id`;

function toView(r: CaseViewRow): CaseView {
  return {
    id: r.id, state: r.state, stateReason: r.state_reason, statusLabel: caseStatusLabel(r.state, r.state_reason), classification: r.classification,
    classificationLabel: CALL_CLASS_LABELS[r.classification], afterHours: r.after_hours, provider: r.provider, callerNumber: r.caller_number, businessNumber: r.business_number,
    contact: r.contact_id ? { id: r.contact_id, name: r.contact_name || "Unnamed contact" } : null, conversationId: r.conversation_id,
    owner: { kind: r.owner_kind, userId: r.owner_user_id, name: r.owner_name }, ownerVersion: r.owner_version, version: r.version, paused: Boolean(r.paused_at),
    firstCalledAt: iso(r.first_called_at)!, lastCalledAt: iso(r.last_called_at)!, callCount: r.call_count, attempts: r.attempts, nextActionAt: iso(r.next_action_at),
    responseDeadlineAt: iso(r.response_deadline_at), firstActionAt: iso(r.first_action_at), recoveredVia: r.recovered_via, recoveredAt: iso(r.recovered_at), resolvedAt: iso(r.resolved_at),
    createdAt: iso(r.created_at)!,
  };
}

export const CASE_GROUPS = ["open", "needs_you", "waiting", "recovered", "closed", "all"] as const;
export type CaseGroup = (typeof CASE_GROUPS)[number];
const GROUP_STATES: Record<Exclude<CaseGroup, "all" | "needs_you">, readonly CaseState[]> = {
  open: ["detected", "awaiting_eligibility", "eligible", "suppressed", "scheduled", "in_progress", "awaiting_response"],
  waiting: ["scheduled", "in_progress", "awaiting_response"],
  recovered: ["recovered"],
  closed: ["completed_without_recovery", "failed", "canceled"],
};

export interface CaseFilters {
  group?: CaseGroup;
  classification?: CallClass | "all";
  mine?: boolean;
  contactId?: string;
  days?: number | null;
  page?: number;
  pageSize?: number;
}

export async function listCases(actor: CrmActor, f: CaseFilters = {}): Promise<{ rows: CaseView[]; total: number; page: number; pageSize: number; counts: Record<CaseGroup, number> }> {
  assertCanRead(actor);
  const pageSize = Math.min(100, Math.max(5, f.pageSize ?? 25));
  const page = Math.max(1, Math.floor(f.page ?? 1));
  if (f.contactId && !UUID.test(f.contactId)) throw new AppError("not_found", "Contact not found.");
  return crmRead(actor, async (db) => {
    const params: unknown[] = [actor.orgId];
    const where = ["c.org_id = $1"];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace("?", `$${params.length}`));
    };
    if (f.classification && f.classification !== "all") add("c.classification = ?", f.classification);
    if (f.mine && actor.userId) add("c.owner_user_id = ?", actor.userId);
    if (f.contactId) add("c.contact_id = ?", f.contactId);
    if (f.days && [1, 7, 30, 90, 365].includes(f.days)) add("c.last_called_at >= now() - make_interval(days => ?::int)", f.days);
    const base = where.join(" and ");
    const countRows = (await db.query<{ state: CaseState; owner_kind: string; n: string }>(`select c.state, c.owner_kind, count(*)::text as n from missed_call_cases c where ${base} group by c.state, c.owner_kind`, params)).rows;
    const counts = { open: 0, needs_you: 0, waiting: 0, recovered: 0, closed: 0, all: 0 } as Record<CaseGroup, number>;
    for (const r of countRows) {
      const n = Number(r.n);
      counts.all += n;
      for (const g of ["open", "waiting", "recovered", "closed"] as const) if (GROUP_STATES[g].includes(r.state)) counts[g] += n;
      if (GROUP_STATES.open.includes(r.state) && ["detected", "awaiting_eligibility", "eligible", "suppressed"].includes(r.state)) counts.needs_you += n;
    }
    const group = f.group ?? "open";
    let listWhere = base;
    const listParams = [...params];
    if (group === "needs_you") {
      listParams.push(["detected", "awaiting_eligibility", "eligible", "suppressed"]);
      listWhere += ` and c.state = any($${listParams.length}::text[])`;
    } else if (group !== "all") {
      listParams.push(GROUP_STATES[group]);
      listWhere += ` and c.state = any($${listParams.length}::text[])`;
    }
    const total = counts[group];
    listParams.push(pageSize, (page - 1) * pageSize);
    const { rows } = await db.query<CaseViewRow>(`${CASE_SELECT} where ${listWhere} order by c.last_called_at desc, c.id limit $${listParams.length - 1} offset $${listParams.length}`, listParams);
    return { rows: rows.map(toView), total, page, pageSize, counts };
  });
}

export interface CaseDetail extends CaseView {
  calls: Array<{ id: string; classification: CallClass; afterHours: boolean; calledAt: string; counted: boolean; callRecordId: string }>;
  actions: CaseActionView[];
  events: CaseEventView[];
}

export async function getCase(actor: CrmActor, id: string): Promise<CaseDetail> {
  assertCanRead(actor);
  requireId(id);
  return crmRead(actor, async (db) => {
    const row = (await db.query<CaseViewRow>(`${CASE_SELECT} where c.id = $1 and c.org_id = $2`, [id, actor.orgId])).rows[0];
    if (!row) throw new AppError("not_found", "Missed call not found.");
    const calls = (await db.query<{ id: string; call_record_id: string; classification: CallClass; after_hours: boolean; called_at: Date; counted: boolean }>(
      "select id::text as id, call_record_id, classification, after_hours, called_at, counted from missed_call_case_calls where case_id = $1 and org_id = $2 order by called_at desc", [id, actor.orgId],
    )).rows;
    const actions = (await db.query<{
      id: string; kind: ActionKind; channel: "sms" | "email" | null; status: ActionStatus; reason: string | null; attempt_no: number; draft_body: string | null;
      scheduled_for: Date | null; executed_at: Date | null; message_id: string | null; task_id: string | null; created_at: Date;
    }>(
      "select id, kind, channel, status, reason, attempt_no, draft_body, scheduled_for, executed_at, message_id, task_id, created_at from missed_call_actions where case_id = $1 and org_id = $2 order by created_at, id", [id, actor.orgId],
    )).rows;
    const events = (await db.query<{ id: string; kind: string; from_state: CaseState | null; to_state: CaseState | null; actor_kind: string; actor_name: string | null; detail: Record<string, unknown>; created_at: Date }>(
      `select e.id::text as id, e.kind, e.from_state, e.to_state, e.actor_kind, coalesce(nullif(u.full_name, ''), u.email::text) as actor_name, e.detail, e.created_at
       from missed_call_case_events e left join users u on u.id = e.actor_user_id where e.case_id = $1 and e.org_id = $2 order by e.id`, [id, actor.orgId],
    )).rows;
    return {
      ...toView(row),
      calls: calls.map((c) => ({ id: c.id, callRecordId: c.call_record_id, classification: c.classification, afterHours: c.after_hours, calledAt: iso(c.called_at)!, counted: c.counted })),
      actions: actions.map((a) => ({
        id: a.id, kind: a.kind, channel: a.channel, status: a.status, reason: a.reason, attemptNo: a.attempt_no, draftBody: a.draft_body, scheduledFor: iso(a.scheduled_for),
        executedAt: iso(a.executed_at), messageId: a.message_id, taskId: a.task_id, createdAt: iso(a.created_at)!,
      })),
      events: events.map((e) => ({ id: Number(e.id), kind: e.kind, fromState: e.from_state, toState: e.to_state, actor: { kind: e.actor_kind, name: e.actor_name }, detail: e.detail, at: iso(e.created_at)! })),
    };
  });
}

/** The open case for a conversation or a contact, for the Inbox and the contact page. Null when there is none. */
export async function openCaseFor(actor: CrmActor, by: { conversationId?: string; contactId?: string }): Promise<CaseView | null> {
  if (!actor.can("calls.view")) return null;
  const key = by.conversationId ? ["c.conversation_id", by.conversationId] : by.contactId ? ["c.contact_id", by.contactId] : null;
  if (!key || !UUID.test(key[1])) return null;
  return crmRead(actor, async (db) => {
    const row = (await db.query<CaseViewRow>(
      `${CASE_SELECT} where c.org_id = $1 and ${key[0]} = $2 and c.state not in ('recovered', 'completed_without_recovery', 'canceled') order by c.last_called_at desc limit 1`, [actor.orgId, key[1]],
    )).rows[0];
    return row ? toView(row) : null;
  });
}

// ---------------------------------------------------------------------------
// Working a case
// ---------------------------------------------------------------------------

async function lockOpen(db: Parameters<Parameters<typeof crmWrite>[1]>[0], actor: CrmActor, id: string): Promise<CaseRow> {
  const c = await loadCase(db, actor.orgId, id, { lock: true });
  if (!c) throw new AppError("not_found", "Missed call not found.");
  if (isFinishedState(c.state)) throw new AppError("conflict", "This missed call is already finished.");
  return c;
}

const audit = (actor: CrmActor, action: string, id: string, metadata: Record<string, unknown>, db: Parameters<Parameters<typeof crmWrite>[1]>[0]) =>
  recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: `missed_call.${action}`, targetType: "missed_call_case", targetId: id, result: "success", metadata }, db);

/**
 * Gives the case to a teammate, or takes the owner off it. The change names the owner version the person was looking at: if the case changed
 * hands in the meantime the change is refused instead of overwriting it.
 */
export async function assignCase(actor: CrmActor, id: string, userId: string | null, expectedOwnerVersion: number): Promise<void> {
  assertCanWork(actor);
  requireId(id);
  if (userId !== null && !UUID.test(userId)) throw new AppError("invalid_input", "Choose a teammate.");
  await crmWrite(actor, async (db) => {
    const c = await lockOpen(db, actor, id);
    if (c.owner_version !== expectedOwnerVersion) throw new AppError("conflict", "Someone else changed who owns this missed call. Reload and try again.");
    if (userId) {
      const ok = await db.query("select 1 from organization_memberships where org_id = $1 and user_id = $2 and status = 'active'", [actor.orgId, userId]);
      if (!ok.rows.length) throw new AppError("invalid_input", "Choose an active member of this workspace.");
    }
    await db.query(
      "update missed_call_cases set owner_kind = $3, owner_user_id = $4, owner_agent_id = null, owner_version = owner_version + 1 where id = $1 and org_id = $2",
      [id, actor.orgId, userId ? "human" : "unassigned", userId],
    );
    await addCaseEvent(db, { orgId: actor.orgId, caseId: id, kind: userId ? "owner_assigned" : "owner_cleared", actor: caseActorOf(actor), detail: { userId, by: "person" } });
    if (c.conversation_id) await recordConversationEvent(db, { orgId: actor.orgId, conversationId: c.conversation_id, kind: "recovery_update", actor: actor.userId ? { kind: "user", userId: actor.userId } : { kind: "system" }, detail: { caseId: id, stage: "assigned" } });
    await audit(actor, "assigned", id, { to: userId }, db);
  });
}

/** Stops automatic follow-up on a case. A queued text that has not left yet is stopped; a drafted text is kept for when it resumes. */
export async function pauseCase(actor: CrmActor, id: string, expectedOwnerVersion: number): Promise<void> {
  assertCanWork(actor);
  requireId(id);
  await crmWrite(actor, async (db) => {
    const c = await lockOpen(db, actor, id);
    if (c.owner_version !== expectedOwnerVersion) throw new AppError("conflict", "Someone else changed this missed call. Reload and try again.");
    if (c.paused_at) return;
    await db.query("update missed_call_cases set paused_at = now(), paused_by = $3, owner_version = owner_version + 1, lease_owner = null, lease_expires_at = null where id = $1 and org_id = $2", [id, actor.orgId, actor.userId]);
    await stopQueuedMessages(db, actor.orgId, id, "paused");
    await addCaseEvent(db, { orgId: actor.orgId, caseId: id, kind: "paused", actor: caseActorOf(actor) });
    if (c.conversation_id) await recordConversationEvent(db, { orgId: actor.orgId, conversationId: c.conversation_id, kind: "recovery_update", actor: actor.userId ? { kind: "user", userId: actor.userId } : { kind: "system" }, detail: { caseId: id, stage: "paused" } });
    await audit(actor, "paused", id, {}, db);
  });
}

export async function resumeCase(actor: CrmActor, id: string, expectedOwnerVersion: number): Promise<void> {
  assertCanWork(actor);
  requireId(id);
  await crmWrite(actor, async (db) => {
    const c = await lockOpen(db, actor, id);
    if (c.owner_version !== expectedOwnerVersion) throw new AppError("conflict", "Someone else changed this missed call. Reload and try again.");
    if (!c.paused_at) return;
    await db.query("update missed_call_cases set paused_at = null, paused_by = null, owner_version = owner_version + 1, next_action_at = now() where id = $1 and org_id = $2", [id, actor.orgId]);
    await addCaseEvent(db, { orgId: actor.orgId, caseId: id, kind: "resumed", actor: caseActorOf(actor) });
    await audit(actor, "resumed", id, {}, db);
  });
}

async function stopQueuedMessages(db: Parameters<Parameters<typeof crmWrite>[1]>[0], orgId: string, caseId: string, reason: string) {
  const queued = await db.query<{ id: string; message_id: string }>(
    "select id, message_id from missed_call_actions where org_id = $1 and case_id = $2 and kind = 'message' and status = 'queued' and message_id is not null for update", [orgId, caseId],
  );
  for (const a of queued.rows) {
    const stopped = await db.query<{ reservation_id: string | null }>(
      "update conversation_messages set status = 'blocked', blocked_reason = $3, status_detail = 'Stopped before sending.' where id = $1 and org_id = $2 and status = 'queued' returning reservation_id",
      [a.message_id, orgId, reason],
    );
    if (stopped.rows.length) {
      const { releaseReservation } = await import("@/server/billing/ledger");
      if (stopped.rows[0].reservation_id) await releaseReservation(db, { orgId, reservationId: stopped.rows[0].reservation_id, reason: `Stopped: ${reason}` });
      await db.query("update missed_call_actions set status = 'canceled', reason = $2 where id = $1", [a.id, reason]);
    }
  }
}

/** Closes a case a person is done with. */
export async function closeCase(actor: CrmActor, id: string, outcome: "recovered" | "no_recovery" | "canceled", note?: string): Promise<void> {
  assertCanWork(actor);
  requireId(id);
  const text = (note ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, 200);
  await crmWrite(actor, async (db) => {
    const c = await lockOpen(db, actor, id);
    const to: CaseState = outcome === "recovered" ? "recovered" : outcome === "canceled" ? "canceled" : "completed_without_recovery";
    const r = await transitionCase(db, {
      orgId: actor.orgId, caseId: id, to, actor: caseActorOf(actor), reason: outcome === "recovered" ? "marked_recovered" : outcome === "canceled" ? "canceled_by_person" : "closed_by_person",
      patch: outcome === "recovered" ? { recoveredVia: "manual" } : {}, detail: text ? { note: text.length } : undefined, expectedVersion: c.version,
    });
    if (!r.ok) throw new AppError("conflict", "This missed call changed while you were closing it. Reload and try again.");
    if (outcome === "recovered") await emitRecovered(db, actor.orgId, r.row, "manual");
    else await emitCaseEvent(db, actor.orgId, r.row, "recovery.completed", { outcome: to, reason: outcome });
    if (c.conversation_id) await recordConversationEvent(db, { orgId: actor.orgId, conversationId: c.conversation_id, kind: "recovery_update", actor: actor.userId ? { kind: "user", userId: actor.userId } : { kind: "system" }, detail: { caseId: id, stage: outcome === "recovered" ? "recovered" : "closed" } });
    await audit(actor, "closed", id, { outcome, hasNote: text.length > 0 }, db);
  });
}

/** Puts a failed case back in the queue. Only a person can: the engine never reopens what failed. */
export async function retryCase(actor: CrmActor, id: string): Promise<void> {
  assertCanWork(actor);
  requireId(id);
  await crmWrite(actor, async (db) => {
    const c = await loadCase(db, actor.orgId, id, { lock: true });
    if (!c) throw new AppError("not_found", "Missed call not found.");
    if (c.state !== "failed") throw new AppError("conflict", "Only a failed missed call can be retried.");
    const r = await transitionCase(db, { orgId: actor.orgId, caseId: id, to: "awaiting_eligibility", actor: caseActorOf(actor), reason: "retried_by_person", patch: { nextActionAt: new Date(), lastError: null }, expectedVersion: c.version });
    if (!r.ok) throw new AppError("conflict", r.code === "illegal" ? "This missed call can't be retried now." : "This missed call changed. Reload and try again.");
    await audit(actor, "retried", id, {}, db);
  });
}

/** Tells the owners and managers this one needs a person now. */
export async function escalateCase(actor: CrmActor, id: string): Promise<void> {
  assertCanWork(actor);
  requireId(id);
  await crmWrite(actor, async (db) => {
    await lockOpen(db, actor, id);
    await notifyOrgRoles(db, actor.orgId, ["owner", "admin"], {
      kind: "missed_call_follow_up", severity: "warning", title: "A missed call needs a person now", body: "A teammate escalated it. Open the missed call to take it.",
      link: `/crm/calls?tab=recovery&case=${id}`, dedupeKey: `mcc:${id}:escalated`,
    });
    await addCaseEvent(db, { orgId: actor.orgId, caseId: id, kind: "escalated", actor: caseActorOf(actor) });
    await audit(actor, "escalated", id, {}, db);
  });
}

// ---------------------------------------------------------------------------
// Drafted texts: a person decides
// ---------------------------------------------------------------------------

/**
 * Sends the drafted text, or the person's edited version of it. This is the explicit approval a sensitive action needs: the person is named
 * on the action, the case must still be the one they looked at, and the rules are read again now. Consent, opt-out and the conversation's
 * owner are checked by the send chain itself.
 */
export async function approveDraft(actor: CrmActor, caseId: string, actionId: string, input: { body?: string | null; expectedOwnerVersion: number }, opts: { now?: Date } = {}): Promise<{ status: "queued" | "blocked" | "draft"; reason?: string }> {
  const now = opts.now ?? new Date();
  assertCanWork(actor);
  requireId(caseId);
  requireId(actionId);
  const approver = actor.userId;
  if (!approver) throw new AppError("forbidden", "A person has to approve a drafted text.");
  const edited = input.body?.trim() || null;
  if (edited) {
    const problem = wordingProblem(edited);
    if (problem) throw new AppError("invalid_input", problem);
  }
  return crmWrite(actor, async (db) => {
    const c = await lockOpen(db, actor, caseId);
    if (c.owner_version !== input.expectedOwnerVersion) throw new AppError("conflict", "Someone else changed this missed call. Reload and try again.");
    if (c.paused_at) throw new AppError("conflict", "Automatic follow-up is paused on this missed call. Resume it first.");
    const a = (await db.query<{ id: string; status: string; channel: "sms" | "email" | null; attempt_no: number; draft_body: string | null }>(
      "select id, status, channel, attempt_no, draft_body from missed_call_actions where id = $1 and org_id = $2 and case_id = $3 and kind = 'message' for update", [actionId, actor.orgId, caseId],
    )).rows[0];
    if (!a) throw new AppError("not_found", "That draft was not found.");
    if (a.status !== "awaiting_approval" || !a.channel) throw new AppError("conflict", "This draft is no longer waiting for approval.");
    const policy = await getPolicy(db, actor.orgId);
    const facts = await loadEligibilityFacts(db, c, policy, now);
    const elig = evaluateEligibility(facts);
    if (elig.close) throw new AppError("conflict", "This missed call is already settled, so nothing was sent.");
    // A teammate may send now what the rules would otherwise hold for a moment (quiet hours, the gap between attempts); they may not send what a rule forbids.
    if (!elig.message.allowed && (elig.message.block.kind === "block" || !["quiet_hours", "attempt_gap", "outside_business_hours", "delay"].includes(elig.message.block.reason))) {
      const reason = elig.message.block.reason;
      throw new AppError("conflict", `This can't be sent: ${reason.replace(/_/g, " ")}.`);
    }
    const body = edited ?? a.draft_body;
    if (!body) throw new AppError("conflict", "This draft has no text.");
    await db.query("update missed_call_actions set approved_by = $2, approved_at = now(), draft_body = $3 where id = $1", [a.id, approver, body]);
    const sent = await sendRecoveryMessage(db, c, policy, {
      channel: a.channel, afterHoursWording: facts.case.afterHours && !facts.timing.withinBusinessHours, attemptNo: a.attempt_no, body,
      recordInboundCallConsent: elig.message.allowed ? elig.message.recordInboundCallConsent : false, by: { kind: "human", userId: approver }, actionId: a.id, now,
    });
    await addCaseEvent(db, { orgId: actor.orgId, caseId, kind: "draft_approved", actor: caseActorOf(actor), detail: { actionId, edited: Boolean(edited), result: sent.status } });
    await db.query("update missed_call_cases set next_action_at = $3 where id = $1 and org_id = $2", [caseId, actor.orgId, now]);
    await audit(actor, "draft_approved", caseId, { actionId, edited: Boolean(edited), result: sent.status }, db);
    return { status: sent.status, reason: sent.reason };
  });
}

export async function rejectDraft(actor: CrmActor, caseId: string, actionId: string, expectedOwnerVersion: number): Promise<void> {
  assertCanWork(actor);
  requireId(caseId);
  requireId(actionId);
  await crmWrite(actor, async (db) => {
    const c = await lockOpen(db, actor, caseId);
    if (c.owner_version !== expectedOwnerVersion) throw new AppError("conflict", "Someone else changed this missed call. Reload and try again.");
    const r = await db.query("update missed_call_actions set status = 'canceled', reason = 'rejected_by_person' where id = $1 and org_id = $2 and case_id = $3 and status = 'awaiting_approval' returning id", [actionId, actor.orgId, caseId]);
    if (!r.rows.length) throw new AppError("conflict", "This draft is no longer waiting for approval.");
    await addCaseEvent(db, { orgId: actor.orgId, caseId, kind: "draft_rejected", actor: caseActorOf(actor), detail: { actionId } });
    await audit(actor, "draft_rejected", caseId, { actionId }, db);
  });
}
