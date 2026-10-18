import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { saveCredential, revokeCredential } from "@/server/security/credentials";
import { assertCan, auditActor, crmRead, crmWrite, systemActor, type CrmActor } from "@/server/crm/actor";
import { emitEvent, recordActivity } from "@/server/crm/events";
import { createTaskInTx } from "@/server/crm/tasks";
import { assertAssignable } from "@/server/crm/contacts";
import {
  CALL_STATUSES, E164, e164, httpsUrl, isCallStatus, isFinalCallStatus, isVoiceProvider, providerId, VOICE_PROVIDER_LABELS,
  type CallStatus, type VoiceCallEvent, type VoiceProvider,
} from "@/server/integrations/voice/types";
import { encodeVapiSecret, isVapiAuthMode, VAPI_AUTH_LABELS, type VapiAuthMode } from "@/server/integrations/voice/vapi";
import { encodeRetellSecret } from "@/server/integrations/voice/retell";

// Call activity. Every call record comes from one of two places, and nowhere else:
//
//  * the voice provider's own signed webhook (Vapi, Retell), matched to this workspace through crm_voice_connections.external_ids
//    (assistant / agent / phone-number ids) and to a contact by the caller's exact E.164 number, never by a name or a fuzzy match;
//  * a person in the team logging a call they made or took.
//
// Recordings and transcripts are kept only as references (a link to the provider's copy), only when the workspace's connection keeps
// them (store_recordings, switched on by an agency super admin who confirmed the assistant tells callers they are recorded), and the
// basis is written on the record (recording_consent). The transcript text itself is never stored.

export type CallProvider = VoiceProvider | "manual";
export const CALL_PROVIDER_LABELS: Record<CallProvider, string> = { ...VOICE_PROVIDER_LABELS, manual: "Logged by the team" };
export type RecordingConsent = "unknown" | "announced" | "granted" | "not_recorded";
export const MANUAL_CALL_STATUSES: readonly CallStatus[] = ["completed", "no_answer", "busy", "voicemail", "failed"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const STATUS_WORDS: Record<CallStatus, string> = {
  ringing: "ringing", in_progress: "in progress", completed: "completed", no_answer: "not answered", busy: "busy", failed: "failed", voicemail: "went to voicemail", cancelled: "cancelled",
};

/** "3 min 12 s", "45 s". */
export function durationText(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m ? `${m} min${s ? ` ${s} s` : ""}` : `${s} s`;
}

// ---------------------------------------------------------------------------
// Matching and recording provider events
// ---------------------------------------------------------------------------

/**
 * The contact whose phone number is exactly this E.164 number in this workspace, or null. Exactly one contact must hold it: a number
 * shared by two contacts (before they are merged) matches nobody, and nothing is ever matched by name.
 */
export async function matchContactByPhone(db: Queryable, orgId: string, phone: string | null): Promise<string | null> {
  if (!phone || !E164.test(phone)) return null;
  const { rows } = await db.query<{ id: string }>(
    `select distinct c.id from contacts c
     where c.org_id = $1 and c.deleted_at is null
       and (c.phone = $2 or exists (select 1 from contact_identities i where i.org_id = c.org_id and i.contact_id = c.id and i.kind = 'phone' and i.value = $2))
     limit 2`,
    [orgId, phone],
  );
  return rows.length === 1 ? rows[0].id : null;
}

const STATUS_RANK = (s: CallStatus) => (s === "ringing" ? 0 : s === "in_progress" ? 1 : 2);
const CONSENT_RANK: Record<RecordingConsent, number> = { not_recorded: 0, unknown: 1, granted: 2, announced: 2 };

interface CallRow {
  id: string; org_id: string; status: CallStatus; direction: "inbound" | "outbound"; from_number: string | null; to_number: string | null; contact_id: string | null;
  started_at: Date | null; ended_at: Date | null; duration_seconds: number | null; disposition: string | null; summary: string | null; recording_ref: string | null;
  transcript_ref: string | null; recording_consent: RecordingConsent;
}

export type VoiceEventOutcome =
  | { outcome: "created" | "updated"; recordId: string; completed: boolean; contactId: string | null }
  | { outcome: "rejected"; detail: string };

/**
 * Records one verified provider event: creates the call record, or merges into the one with the same (provider, provider_call_id).
 * Redelivered and out-of-order events are safe: a call never moves back from ended to ringing, a later event never wipes what an earlier
 * one recorded, and `call.completed` is emitted once, when the call first reaches a final status. A provider call id already recorded
 * for another workspace is refused, never overwritten.
 */
export async function recordVoiceEvent(db: Queryable, conn: { orgId: string; storeRecordings: boolean }, e: VoiceCallEvent, now = new Date()): Promise<VoiceEventOutcome> {
  const orgId = conn.orgId;
  const customer = e.customerNumber && E164.test(e.customerNumber) ? e.customerNumber : null;
  const business = e.businessNumber && E164.test(e.businessNumber) ? e.businessNumber : null;
  const from = e.direction === "inbound" ? customer : business;
  const to = e.direction === "inbound" ? business : customer;
  const recordingRef = conn.storeRecordings && e.final ? httpsUrl(e.recordingUrl) : null;
  const transcriptRef = conn.storeRecordings && e.final && e.hasTranscript ? `${e.provider}:call/${e.callId}/transcript`.slice(0, 500) : null;
  const consentNow: RecordingConsent | null = !e.final ? null : recordingRef || transcriptRef ? "announced" : e.recordingUrl || e.hasTranscript ? "unknown" : "not_recorded";
  // The provider's summary is a synopsis of what was said on the call, so it is call content like the transcript: kept only when the
  // workspace chose to keep call content (store_recordings, after confirming callers are told). Otherwise only the call's facts are kept.
  const summary = conn.storeRecordings ? e.summary : null;
  const matched = await matchContactByPhone(db, orgId, customer);

  const ins = await db.query<{ id: string }>(
    `insert into crm_call_records (org_id, provider, provider_call_id, direction, status, from_number, to_number, contact_id, started_at, ended_at, duration_seconds,
       disposition, summary, recording_ref, transcript_ref, recording_consent)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     on conflict (provider, provider_call_id) where provider_call_id is not null do nothing returning id`,
    [orgId, e.provider, e.callId, e.direction, e.status, from, to, matched, e.startedAt, e.endedAt, e.durationSeconds, e.disposition, summary, recordingRef, transcriptRef, consentNow ?? "unknown"],
  );
  let recordId: string;
  let wasFinal: boolean;
  let contactId: string | null;
  let status: CallStatus;
  let duration: number | null;
  let direction: "inbound" | "outbound";
  if (ins.rows[0]) {
    recordId = ins.rows[0].id;
    wasFinal = false;
    contactId = matched;
    status = e.status;
    duration = e.durationSeconds;
    direction = e.direction;
  } else {
    const cur = (await db.query<CallRow>(
      `select id, org_id, status, direction, from_number, to_number, contact_id, started_at, ended_at, duration_seconds, disposition, summary, recording_ref, transcript_ref, recording_consent
       from crm_call_records where provider = $1 and provider_call_id = $2 for update`,
      [e.provider, e.callId],
    )).rows[0];
    if (!cur) throw new AppError("conflict", "The call record changed while it was being saved. The provider will retry.");
    if (cur.org_id !== orgId) return { outcome: "rejected", detail: "This call id is recorded for another workspace." };
    wasFinal = isFinalCallStatus(cur.status);
    // Forward only. Between two final statuses the more specific one wins: "completed" is the fallback, so it never replaces "voicemail".
    status = STATUS_RANK(e.status) < STATUS_RANK(cur.status) ? cur.status : wasFinal && e.final && e.status === "completed" && cur.status !== "completed" ? cur.status : e.status;
    const recRef = cur.recording_ref ?? recordingRef;
    const trRef = cur.transcript_ref ?? transcriptRef;
    let consent = cur.recording_consent;
    if (consentNow) consent = !wasFinal ? consentNow : CONSENT_RANK[consentNow] > CONSENT_RANK[cur.recording_consent] ? consentNow : cur.recording_consent;
    if (recRef || trRef) consent = "announced";
    contactId = cur.contact_id ?? matched;
    duration = e.durationSeconds ?? cur.duration_seconds;
    direction = cur.direction;
    await db.query(
      `update crm_call_records set status = $2, from_number = coalesce(from_number, $3), to_number = coalesce(to_number, $4), contact_id = $5, started_at = coalesce($6, started_at),
         ended_at = coalesce($7, ended_at), duration_seconds = $8, disposition = coalesce($9, disposition), summary = coalesce($10, summary), recording_ref = $11, transcript_ref = $12,
         recording_consent = $13
       where id = $1`,
      [cur.id, status, from, to, contactId, e.startedAt, e.endedAt, duration, e.disposition, summary, recRef, trRef, consent],
    );
    recordId = cur.id;
  }
  const completed = !wasFinal && isFinalCallStatus(status);
  if (completed) await callCompleted(db, orgId, { recordId, provider: e.provider, direction, status, duration, disposition: e.disposition, contactId, now });
  return { outcome: ins.rows[0] ? "created" : "updated", recordId, completed, contactId };
}

/** The once-per-call event and timeline entry when a call ends (a provider's final event, or a person logging it). */
async function callCompleted(db: Queryable, orgId: string, c: { recordId: string; provider: CallProvider; direction: "inbound" | "outbound"; status: CallStatus; duration: number | null; disposition: string | null; contactId: string | null; now: Date; actor?: CrmActor }) {
  const org = (await db.query<{ name: string; timezone: string }>("select name, timezone from organizations where id = $1", [orgId])).rows[0];
  const actor = c.actor ?? systemActor({ id: orgId, name: org?.name, timezone: org?.timezone }, CALL_PROVIDER_LABELS[c.provider]);
  await emitEvent(db, actor, {
    type: "call.completed", entityType: "call", entityId: c.recordId, contactId: c.contactId,
    payload: { callId: c.recordId, provider: c.provider, direction: c.direction, status: c.status, durationSeconds: c.duration, disposition: c.disposition, contactMatched: Boolean(c.contactId) },
    dedupeKey: `call.completed:${c.recordId}`,
  });
  if (c.contactId) {
    const via = c.provider === "manual" ? "" : ` with the ${VOICE_PROVIDER_LABELS[c.provider]} assistant`;
    await recordActivity(db, actor, {
      kind: c.provider === "manual" ? "call.logged" : "call.completed",
      summary: `${c.direction === "inbound" ? "Inbound" : "Outbound"} call${via} ${STATUS_WORDS[c.status]}${c.duration ? ` (${durationText(c.duration)})` : ""}`,
      contactId: c.contactId, refType: "call", refId: c.recordId, metadata: { provider: c.provider, status: c.status, durationSeconds: c.duration }, occurredAt: c.now,
    });
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface CallRecordView {
  id: string;
  provider: CallProvider;
  providerCallId: string | null;
  direction: "inbound" | "outbound";
  status: CallStatus;
  fromNumber: string | null;
  toNumber: string | null;
  /** The customer's number on the call (from for inbound, to for outbound). */
  customerNumber: string | null;
  contact: { id: string; name: string } | null;
  owner: { id: string; name: string } | null;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  disposition: string | null;
  summary: string | null;
  notes: string | null;
  recordingRef: string | null;
  transcriptRef: string | null;
  recordingConsent: RecordingConsent;
  followUpTaskId: string | null;
  createdAt: string;
}

interface CallViewRow {
  id: string; provider: CallProvider; provider_call_id: string | null; direction: "inbound" | "outbound"; status: CallStatus; from_number: string | null; to_number: string | null;
  contact_id: string | null; contact_name: string | null; owner_id: string | null; owner_name: string | null; started_at: Date | null; ended_at: Date | null; duration_seconds: number | null;
  disposition: string | null; summary: string | null; notes: string | null; recording_ref: string | null; transcript_ref: string | null; recording_consent: RecordingConsent;
  follow_up_task_id: string | null; created_at: Date;
}

const CALL_SELECT = `select r.id, r.provider, r.provider_call_id, r.direction, r.status, r.from_number, r.to_number, c.id as contact_id, c.display_name as contact_name,
    u.id as owner_id, coalesce(nullif(u.full_name, ''), u.email::text) as owner_name, r.started_at, r.ended_at, r.duration_seconds, r.disposition, r.summary, r.notes,
    r.recording_ref, r.transcript_ref, r.recording_consent, r.follow_up_task_id, r.created_at
  from crm_call_records r
  left join contacts c on c.id = r.contact_id and c.org_id = r.org_id and c.deleted_at is null
  left join users u on u.id = r.owner_user_id`;

function toView(r: CallViewRow): CallRecordView {
  return {
    id: r.id, provider: r.provider, providerCallId: r.provider_call_id, direction: r.direction, status: r.status, fromNumber: r.from_number, toNumber: r.to_number,
    customerNumber: r.direction === "inbound" ? r.from_number : r.to_number, contact: r.contact_id ? { id: r.contact_id, name: r.contact_name || "Unnamed contact" } : null,
    owner: r.owner_id ? { id: r.owner_id, name: r.owner_name ?? "Teammate" } : null, startedAt: iso(r.started_at), endedAt: iso(r.ended_at), durationSeconds: r.duration_seconds,
    disposition: r.disposition, summary: r.summary, notes: r.notes, recordingRef: r.recording_ref, transcriptRef: r.transcript_ref, recordingConsent: r.recording_consent,
    followUpTaskId: r.follow_up_task_id, createdAt: iso(r.created_at)!,
  };
}

export const CALL_STATUS_FILTERS = ["all", "completed", "missed", "failed", "live"] as const;
export type CallStatusFilter = (typeof CALL_STATUS_FILTERS)[number];
const STATUS_GROUPS: Record<Exclude<CallStatusFilter, "all">, CallStatus[]> = {
  completed: ["completed"], missed: ["no_answer", "busy", "voicemail"], failed: ["failed", "cancelled"], live: ["ringing", "in_progress"],
};

export interface CallFilters {
  provider?: CallProvider | "all";
  direction?: "inbound" | "outbound" | "all";
  status?: CallStatusFilter;
  /** matched: linked to a contact; unmatched: the number belongs to no contact (or to more than one). */
  match?: "all" | "matched" | "unmatched";
  days?: number | null;
  contactId?: string;
  page?: number;
  pageSize?: number;
}

/** Calls, newest first, with filters. Read under the member's own access (calls.view), as the row-level security policy does. */
export async function listCalls(actor: CrmActor, f: CallFilters = {}): Promise<{ rows: CallRecordView[]; total: number; page: number; pageSize: number; counts: Record<CallStatusFilter, number> }> {
  assertCan(actor, "calls.view", "Your role doesn't include call records.");
  const pageSize = Math.min(100, Math.max(5, f.pageSize ?? 25));
  const page = Math.max(1, Math.floor(f.page ?? 1));
  if (f.contactId && !UUID.test(f.contactId)) throw new AppError("not_found", "Contact not found.");
  return crmRead(actor, async (db) => {
    const params: unknown[] = [actor.orgId];
    const where = ["r.org_id = $1"];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace("?", `$${params.length}`));
    };
    if (f.provider && f.provider !== "all" && (isVoiceProvider(f.provider) || f.provider === "manual")) add("r.provider = ?", f.provider);
    if (f.direction === "inbound" || f.direction === "outbound") add("r.direction = ?", f.direction);
    if (f.match === "matched") where.push("r.contact_id is not null");
    if (f.match === "unmatched") where.push("r.contact_id is null");
    if (f.contactId) add("r.contact_id = ?", f.contactId);
    if (f.days && [1, 7, 30, 90, 365].includes(f.days)) add("coalesce(r.started_at, r.created_at) >= now() - make_interval(days => ?::int)", f.days);
    const base = where.join(" and ");
    const countRows = (await db.query<{ status: CallStatus; n: string }>(`select r.status, count(*)::text as n from crm_call_records r where ${base} group by r.status`, params)).rows;
    const counts = { all: 0, completed: 0, missed: 0, failed: 0, live: 0 } as Record<CallStatusFilter, number>;
    for (const c of countRows) {
      counts.all += Number(c.n);
      for (const [k, list] of Object.entries(STATUS_GROUPS) as Array<[Exclude<CallStatusFilter, "all">, CallStatus[]]>) if (list.includes(c.status)) counts[k] += Number(c.n);
    }
    const status = f.status && f.status !== "all" && f.status in STATUS_GROUPS ? f.status : null;
    const listParams = [...params];
    let listWhere = base;
    if (status) {
      listParams.push(STATUS_GROUPS[status]);
      listWhere += ` and r.status = any($${listParams.length}::text[])`;
    }
    const total = status ? counts[status] : counts.all;
    listParams.push(pageSize, (page - 1) * pageSize);
    const { rows } = await db.query<CallViewRow>(
      `${CALL_SELECT} where ${listWhere} order by coalesce(r.started_at, r.created_at) desc, r.id limit $${listParams.length - 1} offset $${listParams.length}`,
      listParams,
    );
    return { rows: rows.map(toView), total, page, pageSize, counts };
  });
}

export async function listContactCalls(actor: CrmActor, contactId: string, limit = 20): Promise<CallRecordView[]> {
  if (!actor.can("calls.view")) return [];
  return (await listCalls(actor, { contactId, pageSize: Math.min(50, Math.max(5, limit)) })).rows;
}

// ---------------------------------------------------------------------------
// People logging and annotating calls
// ---------------------------------------------------------------------------

export interface ManualCallInput {
  contactId: string;
  direction: "inbound" | "outbound";
  status: CallStatus;
  /** When the call started (ISO 8601). */
  startedAt: string;
  durationSeconds?: number | null;
  /** The number used, in E.164. Defaults to the contact's phone number. */
  phone?: string | null;
  disposition?: string | null;
  summary?: string | null;
  recordingConsent?: RecordingConsent;
  /** An https link to where the recording is kept. Only with consent recorded as announced or granted. */
  recordingUrl?: string | null;
  followUp?: { title?: string | null; dueAt?: string | null; assigneeId?: string | null } | null;
}

function cleanText(v: string | null | undefined, max: number, what: string): string | null {
  const s = (v ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (s.length > max) throw new AppError("invalid_input", `${what} can be at most ${max.toLocaleString("en-US")} characters.`);
  return s || null;
}

function assertCanLog(actor: CrmActor) {
  assertCan(actor, "calls.view", "Your role doesn't include call records.");
  assertCan(actor, "contacts.edit", "Logging calls needs permission to edit contacts.");
}

/** A person records a call they made or took. It completes at once (emits call.completed) and can create a follow-up task. */
export async function logCall(actor: CrmActor, input: ManualCallInput, opts: { now?: Date } = {}): Promise<{ id: string; taskId: string | null }> {
  assertCanLog(actor);
  if (input.followUp) assertCan(actor, "tasks.manage", "Creating a follow-up task needs the task permission.");
  const now = opts.now ?? new Date();
  if (!UUID.test(input.contactId)) throw new AppError("not_found", "Contact not found.");
  if (input.direction !== "inbound" && input.direction !== "outbound") throw new AppError("invalid_input", "Choose whether the call was incoming or outgoing.");
  if (!isCallStatus(input.status) || !MANUAL_CALL_STATUSES.includes(input.status)) throw new AppError("invalid_input", "Choose how the call ended.");
  const started = Date.parse(input.startedAt);
  if (!Number.isFinite(started)) throw new AppError("invalid_input", "Enter when the call took place.");
  if (started > now.getTime() + 5 * 60_000) throw new AppError("invalid_input", "A call can't be logged in the future.");
  if (started < now.getTime() - 366 * 86_400_000) throw new AppError("invalid_input", "Calls more than a year old can't be logged.");
  const duration = input.durationSeconds ?? null;
  if (duration !== null && (!Number.isInteger(duration) || duration < 0 || duration > 86_400)) throw new AppError("invalid_input", "The duration must be between 0 seconds and 24 hours.");
  if (input.status !== "completed" && duration) throw new AppError("invalid_input", "Only a call that was answered has a duration.");
  const consent: RecordingConsent = input.recordingConsent ?? "not_recorded";
  if (!["unknown", "announced", "granted", "not_recorded"].includes(consent)) throw new AppError("invalid_input", "Choose whether the call was recorded.");
  let recording: string | null = null;
  if (input.recordingUrl?.trim()) {
    if (consent !== "announced" && consent !== "granted") throw new AppError("invalid_input", "Only keep a recording link when the caller was told the call was recorded or agreed to it.");
    recording = httpsUrl(input.recordingUrl, 500);
    if (!recording) throw new AppError("invalid_input", "The recording link must be a full https:// address.");
  }
  const disposition = cleanText(input.disposition, 60, "The outcome");
  const summary = cleanText(input.summary, 4000, "The summary");
  return crmWrite(actor, async (db) => {
    const contact = (await db.query<{ id: string; display_name: string; phone: string | null }>("select id, display_name, phone from contacts where id = $1 and org_id = $2 and deleted_at is null", [input.contactId, actor.orgId])).rows[0];
    if (!contact) throw new AppError("not_found", "Contact not found.");
    const phone = input.phone?.trim() ? e164(input.phone) : contact.phone && E164.test(contact.phone) ? contact.phone : null;
    if (input.phone?.trim() && !phone) throw new AppError("invalid_input", "Enter the number in international format, for example +639171234567.");
    const startedAt = new Date(started);
    const endedAt = duration !== null ? new Date(started + duration * 1000) : null;
    const { rows } = await db.query<{ id: string }>(
      `insert into crm_call_records (org_id, provider, direction, status, from_number, to_number, contact_id, owner_user_id, started_at, ended_at, duration_seconds, disposition, summary,
         recording_ref, recording_consent)
       values ($1, 'manual', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning id`,
      [actor.orgId, input.direction, input.status, input.direction === "inbound" ? phone : null, input.direction === "outbound" ? phone : null, contact.id, actor.userId, startedAt, endedAt, duration, disposition, summary, recording, consent],
    );
    const id = rows[0].id;
    await callCompleted(db, actor.orgId, { recordId: id, provider: "manual", direction: input.direction, status: input.status, duration, disposition, contactId: contact.id, now, actor });
    let taskId: string | null = null;
    if (input.followUp) taskId = await followUpTask(db, actor, id, contact, input.followUp);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.call_logged", targetType: "crm_call_record", targetId: id, result: "success", metadata: { direction: input.direction, status: input.status, recording: Boolean(recording), followUp: Boolean(taskId) } }, db);
    return { id, taskId };
  });
}

async function followUpTask(db: Queryable, actor: CrmActor, callId: string, contact: { id: string; display_name: string }, f: NonNullable<ManualCallInput["followUp"]>): Promise<string> {
  const title = cleanText(f.title, 200, "The task title") ?? `Follow up on the call with ${contact.display_name || "this contact"}`.slice(0, 200);
  const t = await createTaskInTx(db, actor, { title, dueAt: f.dueAt ?? null, assigneeId: f.assigneeId ?? null, contactId: contact.id, priority: "normal" });
  await db.query("update crm_call_records set follow_up_task_id = $3 where id = $1 and org_id = $2", [callId, actor.orgId, t.id]);
  return t.id;
}

async function loadCallForChange(db: Queryable, orgId: string, id: string) {
  if (!UUID.test(id)) throw new AppError("not_found", "Call not found.");
  const r = (await db.query<{ id: string; contact_id: string | null; follow_up_task_id: string | null; notes: string | null; disposition: string | null; provider: CallProvider; from_number: string | null; to_number: string | null; direction: "inbound" | "outbound" }>(
    "select id, contact_id, follow_up_task_id, notes, disposition, provider, from_number, to_number, direction from crm_call_records where id = $1 and org_id = $2 for update",
    [id, orgId],
  )).rows[0];
  if (!r) throw new AppError("not_found", "Call not found.");
  return r;
}

/**
 * The team's own notes on a call, its outcome label, and (for a call no contact matched) the contact a person says it was with. The
 * provider's facts (times, status, summary) are never edited, and a call already linked to a contact isn't moved to another one.
 */
export async function updateCall(actor: CrmActor, id: string, input: { notes?: string | null; disposition?: string | null; contactId?: string | null }): Promise<void> {
  assertCanLog(actor);
  await crmWrite(actor, async (db) => {
    const cur = await loadCallForChange(db, actor.orgId, id);
    const notes = input.notes !== undefined ? cleanText(input.notes, 4000, "Notes") : cur.notes;
    // A provider's call keeps the provider's own ended reason; only a call a person logged has an outcome a person chose.
    if (cur.provider !== "manual" && input.disposition !== undefined && (input.disposition ?? null) !== cur.disposition) {
      throw new AppError("invalid_input", "The outcome of a call the voice provider reported is the provider's own. Add your notes instead.");
    }
    const disposition = input.disposition !== undefined && cur.provider === "manual" ? cleanText(input.disposition, 60, "The outcome") : cur.disposition;
    let contactId = cur.contact_id;
    if (input.contactId && input.contactId !== cur.contact_id) {
      if (cur.contact_id) throw new AppError("conflict", "This call is already linked to a contact.");
      if (!UUID.test(input.contactId) || !(await db.query("select 1 from contacts where id = $1 and org_id = $2 and deleted_at is null", [input.contactId, actor.orgId])).rows.length) throw new AppError("not_found", "Contact not found.");
      contactId = input.contactId;
    }
    await db.query("update crm_call_records set notes = $3, disposition = $4, contact_id = $5 where id = $1 and org_id = $2", [id, actor.orgId, notes, disposition, contactId]);
    if (contactId && contactId !== cur.contact_id) {
      await recordActivity(db, actor, { kind: "call.linked", summary: `${cur.direction === "inbound" ? "Inbound" : "Outbound"} call linked to this contact by hand`, contactId, refType: "call", refId: id });
    }
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.call_updated", targetType: "crm_call_record", targetId: id, result: "success", metadata: { notes: input.notes !== undefined, disposition: input.disposition !== undefined, linked: contactId !== cur.contact_id } }, db);
  });
}

/** Creates one follow-up task for a call (linked to its contact when there is one). */
export async function createCallFollowUp(actor: CrmActor, id: string, input: { title?: string | null; dueAt?: string | null; assigneeId?: string | null } = {}): Promise<{ taskId: string }> {
  assertCan(actor, "calls.view", "Your role doesn't include call records.");
  assertCan(actor, "tasks.manage", "Creating a follow-up task needs the task permission.");
  return crmWrite(actor, async (db) => {
    const cur = await loadCallForChange(db, actor.orgId, id);
    if (cur.follow_up_task_id && (await db.query("select 1 from tasks where id = $1 and org_id = $2", [cur.follow_up_task_id, actor.orgId])).rows.length) {
      throw new AppError("conflict", "This call already has a follow-up task.");
    }
    if (input.assigneeId) await assertAssignable(db, actor.orgId, input.assigneeId);
    const contact = cur.contact_id ? (await db.query<{ id: string; display_name: string }>("select id, display_name from contacts where id = $1 and org_id = $2", [cur.contact_id, actor.orgId])).rows[0] : null;
    const number = cur.direction === "inbound" ? cur.from_number : cur.to_number;
    const title = cleanText(input.title, 200, "The task title") ?? `Follow up on the call with ${contact?.display_name || number || "an unknown caller"}`.slice(0, 200);
    const t = await createTaskInTx(db, actor, { title, dueAt: input.dueAt ?? null, assigneeId: input.assigneeId ?? null, contactId: contact?.id ?? null, priority: "normal" });
    await db.query("update crm_call_records set follow_up_task_id = $3 where id = $1 and org_id = $2", [id, actor.orgId, t.id]);
    return { taskId: t.id };
  });
}

// ---------------------------------------------------------------------------
// Voice provider connections
// ---------------------------------------------------------------------------

export interface VoiceConnectionView {
  provider: VoiceProvider;
  providerLabel: string;
  configured: boolean;
  status: "credentials_saved" | "connected" | "error" | "disconnected" | "not_set_up";
  externalIds: string[];
  storeRecordings: boolean;
  credentialSaved: boolean;
  credentialSavedAt: string | null;
  /** Vapi only: how Vapi authenticates its requests (stored with the credential, never the secret). */
  vapiAuthMode: VapiAuthMode | null;
  lastEventAt: string | null;
  /** Where the provider sends its events. */
  webhookUrl: string;
}

export function voiceWebhookUrl(provider: VoiceProvider): string {
  return new URL(`/api/webhooks/${provider}`, env().APP_URL).toString();
}

/** Each provider's connection for this workspace (or that it isn't set up). Never a secret: only whether one is saved. */
export async function listVoiceConnections(actor: CrmActor): Promise<VoiceConnectionView[]> {
  assertCan(actor, "calls.view", "Your role doesn't include call records.");
  return withSystem(async (db) => {
    const { rows } = await db.query<{ provider: VoiceProvider; external_ids: string[]; store_recordings: boolean; status: VoiceConnectionView["status"]; last_event_at: Date | null; cred_live: boolean | null; cred_at: Date | null; scopes: string[] | null }>(
      `select v.provider, v.external_ids, v.store_recordings, v.status, v.last_event_at, (c.id is not null and c.revoked_at is null) as cred_live, c.created_at as cred_at, c.scopes
       from crm_voice_connections v left join integration_credentials c on c.id = v.credential_id and c.org_id = v.org_id where v.org_id = $1`,
      [actor.orgId],
    );
    return (["vapi", "retell"] as const).map((provider) => {
      const r = rows.find((x) => x.provider === provider);
      const mode = (r?.scopes ?? []).map((s) => s.replace(/^auth:/, "")).find(isVapiAuthMode) ?? null;
      return {
        provider, providerLabel: VOICE_PROVIDER_LABELS[provider], configured: Boolean(r), status: r?.status ?? "not_set_up", externalIds: r?.external_ids ?? [],
        storeRecordings: r?.store_recordings ?? false, credentialSaved: Boolean(r?.cred_live), credentialSavedAt: r?.cred_live ? iso(r.cred_at) : null,
        vapiAuthMode: provider === "vapi" ? mode : null, lastEventAt: iso(r?.last_event_at), webhookUrl: voiceWebhookUrl(provider),
      };
    });
  });
}

/** Connections hold a provider credential, so only an agency super admin in a write support session sets them up. */
function assertConnectionAdmin(actor: CrmActor) {
  if (actor.kind !== "agency" || actor.supportMode !== "write" || !actor.userId) {
    throw new AppError("forbidden", "Voice connections are set up by an iAcquire agency super admin in a write support session, because they hold a provider credential.");
  }
}

export interface VoiceConnectionInput {
  provider: string;
  /** Assistant / agent / phone-number ids, one per line or comma-separated. */
  externalIds: string[] | string;
  /** Vapi: Bearer token, X-Vapi-Secret or HMAC. */
  vapiAuthMode?: string | null;
  /** The shared secret (Vapi) or the API key with the webhook badge (Retell). Leave empty to keep the saved one. */
  secret?: string | null;
  storeRecordings: boolean;
  /** Required to keep recordings: the assistant tells every caller the call is recorded. */
  recordingAnnounced?: boolean;
}

export function parseExternalIds(v: string[] | string): string[] {
  const list = (Array.isArray(v) ? v : String(v ?? "").split(/[\s,]+/)).map((s) => String(s).trim()).filter(Boolean);
  const out: string[] = [];
  for (const s of list) {
    const id = providerId(s, 120);
    if (!id) throw new AppError("invalid_input", `"${s.slice(0, 40)}" isn't a valid id. Copy the id exactly as the provider shows it.`);
    if (!out.includes(id)) out.push(id);
  }
  if (!out.length) throw new AppError("invalid_input", "Add at least one assistant, agent or phone-number id.");
  if (out.length > 20) throw new AppError("invalid_input", "A connection can list at most 20 ids.");
  return out;
}

/**
 * Creates or changes a workspace's connection to Vapi or Retell: which assistant / agent / phone-number ids are this workspace's (an id
 * can belong to one workspace only), the credential that authenticates the provider's requests (stored in the vault, replace-only), and
 * whether recording and transcript references are kept.
 */
export async function saveVoiceConnection(actor: CrmActor, input: VoiceConnectionInput): Promise<VoiceConnectionView> {
  assertConnectionAdmin(actor);
  if (!isVoiceProvider(input.provider)) throw new AppError("invalid_input", "Choose Vapi or Retell AI.");
  const provider = input.provider;
  const externalIds = parseExternalIds(input.externalIds);
  if (input.storeRecordings && !input.recordingAnnounced) {
    throw new AppError("invalid_input", "Recordings can only be kept when the assistant tells every caller the call is recorded. Confirm that first.");
  }
  const mode = provider === "vapi" ? input.vapiAuthMode ?? null : null;
  if (provider === "vapi" && !isVapiAuthMode(mode)) throw new AppError("invalid_input", "Choose how Vapi authenticates its requests.");
  const secretText = input.secret?.trim()
    ? provider === "vapi" ? encodeVapiSecret({ mode: mode as VapiAuthMode, secret: input.secret }) : encodeRetellSecret(input.secret)
    : null;
  await withSystem(async (db) => {
    const clash = await db.query<{ n: string }>(
      "select count(*)::text as n from crm_voice_connections where provider = $1 and org_id <> $2 and status <> 'disconnected' and external_ids && $3::text[]",
      [provider, actor.orgId, externalIds],
    );
    if (Number(clash.rows[0].n) > 0) throw new AppError("conflict", "One of those ids is already connected to another workspace. Each assistant, agent or number can report calls to one workspace only.");
    const cur = (await db.query<{ credential_id: string | null; cred_live: boolean; scopes: string[] | null; store_recordings: boolean }>(
      `select v.credential_id, (c.id is not null and c.revoked_at is null) as cred_live, c.scopes, v.store_recordings
       from crm_voice_connections v left join integration_credentials c on c.id = v.credential_id where v.org_id = $1 and v.provider = $2 for update of v`,
      [actor.orgId, provider],
    )).rows[0];
    const keep = cur?.cred_live ? cur.credential_id : null;
    const currentMode = (cur?.scopes ?? []).map((s) => s.replace(/^auth:/, "")).find(isVapiAuthMode) ?? null;
    if (!secretText && !keep) throw new AppError("invalid_input", provider === "vapi" ? "Enter the secret from the Vapi credential." : "Enter the Retell API key that has the webhook badge.");
    if (!secretText && provider === "vapi" && currentMode !== mode) throw new AppError("invalid_input", "Changing how Vapi authenticates needs its secret again. Enter it.");
    let credentialId = keep;
    if (secretText) {
      const saved = await saveCredential(db, {
        orgId: actor.orgId, provider, label: `${VOICE_PROVIDER_LABELS[provider]} webhook`, secret: secretText, scopes: mode ? [`auth:${mode}`] : [], actorId: actor.userId!, replaces: keep,
      });
      credentialId = saved.id;
    }
    await db.query(
      `insert into crm_voice_connections (org_id, provider, external_ids, credential_id, store_recordings, status, created_by)
       values ($1, $2, $3, $4, $5, 'credentials_saved', $6)
       on conflict (org_id, provider) do update set external_ids = excluded.external_ids, credential_id = excluded.credential_id, store_recordings = excluded.store_recordings,
         status = case when crm_voice_connections.credential_id is distinct from excluded.credential_id or crm_voice_connections.status in ('disconnected', 'error') then 'credentials_saved' else crm_voice_connections.status end`,
      [actor.orgId, provider, externalIds, credentialId, input.storeRecordings, actor.userId],
    );
    await recordAudit({
      orgId: actor.orgId, ...auditActor(actor), action: "crm.voice_connection_saved", targetType: "crm_voice_connection", targetId: provider, result: "success",
      metadata: { provider, ids: externalIds.length, credentialReplaced: Boolean(secretText), storeRecordings: input.storeRecordings, recordingsChanged: (cur?.store_recordings ?? false) !== input.storeRecordings, auth: mode },
    }, db);
  });
  return (await listVoiceConnections(actor)).find((c) => c.provider === provider)!;
}

/** Stops a provider's events reaching this workspace: the connection is marked disconnected and its credential revoked. Past calls stay. */
export async function disconnectVoiceConnection(actor: CrmActor, providerInput: string): Promise<void> {
  assertConnectionAdmin(actor);
  if (!isVoiceProvider(providerInput)) throw new AppError("invalid_input", "Choose Vapi or Retell AI.");
  const provider = providerInput;
  await withSystem(async (db) => {
    const cur = (await db.query<{ credential_id: string | null }>("select credential_id from crm_voice_connections where org_id = $1 and provider = $2 for update", [actor.orgId, provider])).rows[0];
    if (!cur) throw new AppError("not_found", "That provider isn't connected.");
    if (cur.credential_id) {
      const live = await db.query("select 1 from integration_credentials where id = $1 and revoked_at is null", [cur.credential_id]);
      if (live.rows.length) await revokeCredential(db, cur.credential_id, actor.orgId, provider, actor.userId!);
    }
    await db.query("update crm_voice_connections set status = 'disconnected', credential_id = null where org_id = $1 and provider = $2", [actor.orgId, provider]);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.voice_connection_disconnected", targetType: "crm_voice_connection", targetId: provider, result: "success", metadata: { provider } }, db);
  });
}

export { CALL_STATUSES, VAPI_AUTH_LABELS };
