import "server-only";
import type { Queryable } from "@/server/db";

// A privacy request for one contact (src/server/messaging/contacts.ts redactContact) reaches missed-call recovery and lead scoring here. Plain SQL on
// purpose, with no import of the case or policy modules, so the contact service can call it without a circular dependency.
//
// What goes: the caller's phone number on every case and call record of the contact, the summary, notes and recording or transcript references of
// those calls, every drafted or queued text, every lead assessment, override and queue row, and the contact's priority columns. What stays: the case
// shell (state, class, times, counts), its history of ids and enums, and the audit trail, so the workspace's numbers and accountability survive.

const OPEN = "('detected', 'awaiting_eligibility', 'eligible', 'suppressed', 'scheduled', 'in_progress', 'awaiting_response')";

export async function eraseRecoveryAndScoring(db: Queryable, orgId: string, contactId: string): Promise<{ casesClosed: number; assessments: number }> {
  // Open cases end, with the reason in their history; nothing queued for this person may still go out.
  const open = await db.query<{ id: string; state: string }>(`select id, state from missed_call_cases where org_id = $1 and contact_id = $2 and state in ${OPEN} for update`, [orgId, contactId]);
  for (const c of open.rows) {
    await db.query(
      `insert into missed_call_case_events (org_id, case_id, kind, from_state, to_state, actor_kind, detail) values ($1, $2, 'state_changed', $3, 'canceled', 'system', '{"reason":"privacy_request"}'::jsonb)`,
      [orgId, c.id, c.state],
    );
  }
  if (open.rows.length) {
    await db.query(
      `update missed_call_cases set state = 'canceled', state_reason = 'privacy_request', state_changed_at = now(), version = version + 1, resolved_at = coalesce(resolved_at, now()),
         next_action_at = null, lease_owner = null, lease_expires_at = null where org_id = $1 and id = any($2::uuid[])`,
      [orgId, open.rows.map((c) => c.id)],
    );
  }
  await db.query(
    `update conversation_messages set status = 'blocked', blocked_reason = 'privacy_request', status_detail = 'Stopped before sending.'
     where org_id = $1 and status in ('draft', 'queued') and id in (select message_id from missed_call_actions a join missed_call_cases c on c.id = a.case_id and c.org_id = a.org_id
                                                                    where a.org_id = $1 and c.contact_id = $2 and a.message_id is not null)`,
    [orgId, contactId],
  );
  await db.query(
    `update missed_call_actions set draft_body = null, status = case when status in ('planned', 'awaiting_approval', 'queued') then 'canceled' else status end,
       reason = case when status in ('planned', 'awaiting_approval', 'queued') then 'privacy_request' else reason end
     where org_id = $1 and case_id in (select id from missed_call_cases where org_id = $1 and contact_id = $2)`,
    [orgId, contactId],
  );
  await db.query("update missed_call_cases set caller_number = null where org_id = $1 and contact_id = $2", [orgId, contactId]);
  // The calls themselves: the customer's number and anything said on them.
  await db.query(
    `update crm_call_records set from_number = case when direction = 'inbound' then null else from_number end, to_number = case when direction = 'outbound' then null else to_number end,
       summary = null, notes = null, recording_ref = null, transcript_ref = null where org_id = $1 and contact_id = $2`,
    [orgId, contactId],
  );

  const assessments = await db.query("delete from lead_score_assessments where org_id = $1 and contact_id = $2 returning id", [orgId, contactId]);
  await db.query("delete from lead_score_overrides where org_id = $1 and contact_id = $2", [orgId, contactId]);
  await db.query("delete from lead_score_queue where org_id = $1 and contact_id = $2", [orgId, contactId]);
  await db.query(
    "update contacts set priority_score = null, priority_label = null, priority_source = null, priority_assessment_id = null, priority_evaluated_at = null, priority_reason = null where org_id = $1 and id = $2",
    [orgId, contactId],
  );
  return { casesClosed: open.rows.length, assessments: assessments.rows.length };
}
