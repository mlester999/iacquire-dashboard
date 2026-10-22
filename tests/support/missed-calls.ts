// Fixtures for the missed-call tests. Synthetic workspaces only: nothing here contacts a provider, and every number is a made-up test number.
import crypto from "node:crypto";
import { withSystem } from "@/server/db";
import { memberActor, type CrmActor } from "@/server/crm/actor";
import { recordVoiceEvent } from "@/server/crm/calls";
import { createContact } from "@/server/crm/contacts";
import { activatePolicy, savePolicy } from "@/server/missed-calls/policy";
import type { VoiceCallEvent } from "@/server/integrations/voice/types";
import { messagingOrg, recordingProvider, type MessagingOrg } from "./messaging";

export const T0 = new Date("2026-10-22T15:00:00.000Z"); // a Thursday afternoon, UTC
export const BUSINESS = "+15555550100";
const used = new Set<string>();
/** A made-up E.164 number nobody else in this test process has been given (the provider id of a message is unique across workspaces). */
export const callerNumber = () => {
  for (;;) {
    const n = `+1555${String(1_000_000 + Math.floor(Math.random() * 8_999_999))}`;
    if (!used.has(n)) {
      used.add(n);
      return n;
    }
  }
};
export const minutesAfter = (m: number, from = T0) => new Date(from.getTime() + m * 60_000);

export function voice(over: Partial<VoiceCallEvent> = {}): VoiceCallEvent {
  const callId = over.callId ?? `call_${crypto.randomBytes(5).toString("hex")}`;
  return {
    provider: "vapi", eventType: "end-of-call-report", receiptKey: `${callId}:end`, callId, externalIds: ["asst_1"], direction: "inbound", status: "no_answer", final: true,
    customerNumber: callerNumber(), businessNumber: BUSINESS, startedAt: T0, endedAt: null, durationSeconds: null, disposition: null, summary: null, recordingUrl: null, hasTranscript: false,
    ...over,
    ...(over.endedAt === undefined ? { endedAt: new Date((over.startedAt ?? T0).getTime() + 20_000) } : {}),
  };
}

export const recordCall = (orgId: string, ev: VoiceCallEvent, now = T0) => withSystem((db) => recordVoiceEvent(db, { orgId, storeRecordings: false }, ev, now));
export const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;
export const count = async (sql: string, params: unknown[] = []) => Number((await rows<{ n: string }>(sql, params))[0].n);

export interface CaseSnapshot {
  id: string; state: string; state_reason: string | null; attempts: number; contact_id: string | null; conversation_id: string | null; call_count: number; next_action_at: Date | null;
  owner_kind: string; owner_user_id: string | null; owner_version: number; paused_at: Date | null; recovered_via: string | null; response_deadline_at: Date | null; version: number; first_action_at: Date | null;
}
export const caseOf = async (orgId: string, caller: string) =>
  (await rows<CaseSnapshot>("select * from missed_call_cases where org_id = $1 and caller_number = $2 order by created_at desc", [orgId, caller]))[0];
export const actionsOf = (caseId: string) => rows<{ id: string; kind: string; status: string; reason: string | null; message_id: string | null; task_id: string | null; attempt_no: number; draft_body: string | null; channel: string | null }>(
  "select id, kind, status, reason, message_id, task_id, attempt_no, draft_body, channel from missed_call_actions where case_id = $1 order by created_at, id", [caseId]);
export const eventsOf = (caseId: string) => rows<{ kind: string; from_state: string | null; to_state: string | null; detail: Record<string, unknown> }>(
  "select kind, from_state, to_state, detail from missed_call_case_events where case_id = $1 order by id", [caseId]);
export const messagesFor = (contactId: string) => rows<{ id: string; status: string; body: string; scope: string; author_kind: string; dedupe_key: string | null; blocked_reason: string | null }>(
  `select m.id, m.status, m.body, m.scope, m.author_kind, m.dedupe_key, m.blocked_reason from conversation_messages m join conversations c on c.id = m.conversation_id
   where c.contact_id = $1 and m.direction = 'outbound' order by m.created_at, m.id`, [contactId]);

export interface RecoveryWorkspace {
  w: MessagingOrg;
  owner: CrmActor;
  manager: CrmActor;
  viewer: CrmActor;
  transport: ReturnType<typeof recordingProvider>;
  version: number;
}

/** A workspace on a native text provider with the policy saved (and, for the sending modes, activated). */
export async function recoveryWorkspace(opts: {
  mode?: "manual" | "assisted" | "automatic"; activate?: boolean; policy?: Record<string, unknown>; messaging?: Parameters<typeof messagingOrg>[0];
} = {}): Promise<RecoveryWorkspace> {
  const w = await messagingOrg({ provider: { sms: "twilio" }, ...opts.messaging });
  const owner = memberActor(w.ctx("owner"));
  const sends = (opts.mode ?? "manual") !== "manual";
  let policy = await savePolicy(owner, {
    expectedVersion: 0, enabled: true, mode: opts.mode ?? "manual", actionMessage: sends, assignUserId: w.people.sales.id, ...opts.policy,
  });
  if (sends && opts.activate !== false) policy = await activatePolicy(owner, policy.version);
  return { w, owner, manager: memberActor(w.ctx("manager")), viewer: memberActor(w.ctx("viewer")), transport: recordingProvider("twilio"), version: policy.version };
}

/** A contact with consent to be texted, and a missed call from them. */
export async function missedCallFrom(r: RecoveryWorkspace, opts: { consent?: boolean; name?: string; at?: Date; over?: Partial<VoiceCallEvent> } = {}) {
  const caller = callerNumber();
  const contact = await createContact(r.owner, { displayName: opts.name ?? "Dana Lee", phone: caller });
  if (opts.consent !== false) {
    await withSystem((db) => db.query(
      "insert into contact_consent_events (org_id, contact_id, channel, purpose, status, source, evidence) values ($1, $2, 'sms', 'service', 'granted', 'test', 'Test consent.')",
      [r.w.org.id, contact.id],
    ));
  }
  const call = await recordCall(r.w.org.id, voice({ customerNumber: caller, startedAt: opts.at ?? T0, ...opts.over }), opts.at ?? T0);
  return { caller, contact, call, caseRow: await caseOf(r.w.org.id, caller) };
}
