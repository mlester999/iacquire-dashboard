import "server-only";
import type { Queryable } from "@/server/db";
import { releaseReservation } from "@/server/billing/ledger";
import { cancelRetention } from "@/server/retention/cancel";

// A privacy request for one contact (src/server/messaging/contacts.ts redactContact) reaches private feedback, review requests, survey answers and retention programs here.
//
// What goes: the words the customer wrote (the comment on every private feedback row, the answers of every form they submitted), the link between the feedback and the
// person, the follow-up task and notices that quote them, any review request still waiting (cancelled; a message not yet sent is stopped), and every customer program
// still running for them. What stays, so the workspace's numbers and accountability survive: the score on each feedback row (a count and a rating with no person
// attached), the request rows themselves (a status and a date, no address; the contact they point at is already 'Removed contact'), and the audit trail.

export interface ReputationErasure {
  feedbackRows: number;
  requestsCancelled: number;
  submissions: number;
  programsStopped: number;
  /** Public reviews a person had linked to this customer, now unlinked. */
  reviewLinks: number;
}

export async function eraseReputationRecords(db: Queryable, orgId: string, contactId: string): Promise<ReputationErasure> {
  // The follow-up task and the notices were written with the customer's name (and the task with their words): blanked first, while the rows still point at the contact.
  const feedback = await db.query<{ id: string; escalated_task_id: string | null }>("select id, escalated_task_id from customer_feedback where org_id = $1 and contact_id = $2", [orgId, contactId]);
  const taskIds = feedback.rows.map((f) => f.escalated_task_id).filter((id): id is string => Boolean(id));
  if (taskIds.length) {
    await db.query(
      `update tasks set title = 'Follow-up on removed feedback', description = null, contact_id = null, related_type = null, related_id = null,
         status = case when status in ('open', 'in_progress') then 'cancelled' else status end
       where org_id = $1 and id = any($2::uuid[])`,
      [orgId, taskIds],
    );
  }
  if (feedback.rows.length) {
    const keys = feedback.rows.flatMap((f) => [`feedback-low:${f.id}`, `feedback-sla:${f.id}`]);
    await db.query("update notifications set title = 'Low feedback (details removed on request)', body = null where org_id = $1 and dedupe_key = any($2::text[])", [orgId, keys]);
  }
  // The comment is customer-written text; the score has no person attached once the link is cut. The follow-up is closed: there is nobody left to follow up with.
  const cleared = await db.query(
    `update customer_feedback set comment = null, contact_id = null,
       follow_up_status = case when follow_up_status in ('new', 'escalated') then 'resolved' else follow_up_status end,
       resolved_at = case when follow_up_status in ('new', 'escalated') then coalesce(resolved_at, now()) else resolved_at end,
       resolution_note = case when follow_up_status in ('new', 'escalated') then 'The contact was removed on request.' else resolution_note end
     where org_id = $1 and contact_id = $2`,
    [orgId, contactId],
  );

  // A survey answer that only MAY be this customer's (typed next to their address, nobody confirmed it) is not their record, but it was typed in a submission that is erased below, and
  // it must not keep pointing at them: the link goes, and so do the words. The score stays for the counts, with no person attached.
  const possible = await db.query("update customer_feedback set comment = null, possible_contact_id = null where org_id = $1 and possible_contact_id = $2", [orgId, contactId]);

  // A review request that has not been answered stops taking feedback (the page still shows the public links, as for any closed request). A message that has not
  // gone out is stopped and its credit hold released.
  const waiting = await db.query<{ id: string; message_id: string | null }>(
    "update crm_review_requests set status = 'cancelled' where org_id = $1 and contact_id = $2 and status in ('pending', 'queued', 'sent', 'opened') returning id, message_id",
    [orgId, contactId],
  );
  const messageIds = waiting.rows.map((r) => r.message_id).filter((id): id is string => Boolean(id));
  if (messageIds.length) {
    const stopped = await db.query<{ reservation_id: string | null }>(
      `update conversation_messages set status = 'blocked', blocked_reason = 'privacy_request', status_detail = 'Stopped before sending.'
       where org_id = $1 and id = any($2::uuid[]) and status in ('draft', 'queued') returning reservation_id`,
      [orgId, messageIds],
    );
    for (const m of stopped.rows) if (m.reservation_id) await releaseReservation(db, { orgId, reservationId: m.reservation_id, reason: "Privacy request" });
  }

  // What the customer typed into a form (a satisfaction survey included) is theirs to have removed; the submission itself stays as a count.
  const submissions = await db.query("update crm_form_submissions set answers = '{}'::jsonb, consent_text = null, marketing_text = null, ip_hash = null where org_id = $1 and contact_id = $2", [orgId, contactId]);

  // A public review a person linked to this customer by hand: the link goes (the review itself is the review site's public data, not this customer's record, and stays).
  const links = await db.query("update external_reviews set contact_id = null, contact_linked_by = null, contact_linked_at = null where org_id = $1 and contact_id = $2", [orgId, contactId]);

  const programs = await cancelRetention(db, orgId, contactId, "contact_removed");
  return { feedbackRows: (cleared.rowCount ?? 0) + (possible.rowCount ?? 0), requestsCancelled: waiting.rows.length, submissions: submissions.rowCount ?? 0, programsStopped: programs.enrollments, reviewLinks: links.rowCount ?? 0 };
}
