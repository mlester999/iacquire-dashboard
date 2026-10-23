import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { sendEmail, type OutgoingEmail } from "@/server/email";
import { notifyOrgRoles } from "@/server/notifications";
import { assertCan, auditActor, crmWrite, type CrmActor } from "@/server/crm/actor";
import { emitEvent, recordActivity } from "@/server/crm/events";
import { createTaskInTx } from "@/server/crm/tasks";
import { assertAssignable } from "@/server/crm/contacts";
import { createEscalation } from "@/server/messaging/handoff";
import { recordConversationEvent } from "@/server/messaging/events";
import { cancelRetention } from "@/server/retention/cancel";
import type { EscalationCategory } from "@/lib/escalation";
import type { ReputationSettings } from "@/lib/reputation/settings";

// What happens after a customer gives low private feedback. Everything here ADDS a person's follow-up; nothing here touches who is asked for a public review, which review
// links a customer sees, or what they are told to do before posting one (those never depend on a rating: see src/server/crm/reviews.ts and the guard test).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

export type FollowUpStatus = "new" | "acknowledged" | "escalated" | "resolved";

export interface LowFeedbackInput {
  feedbackId: string;
  /** The review request or survey link the answer came through; null for an answer given in a survey form. */
  reviewRequestId: string | null;
  contact: { id: string; name: string; assigneeId: string | null };
  /** The message the review request went out in: its conversation is where the customer's reply (and the escalation) belongs. Null for a survey form: there is none. */
  requestMessageId: string | null;
  /** Where the answer came from. A survey form knows who someone is only by the email or phone they typed, and the task says so. */
  source?: { kind: "review_request" } | { kind: "survey"; formName: string };
  /** "2 of 5", or null when the customer gave a comment but no score. */
  scoreText: string | null;
  /** The customer's own words, for the task only (a task is read inside the portal). They are never put in a notification, an email, an event or an audit row. */
  comment: string | null;
  /** Complaint unless the comment itself named something else (a refund, a request for a call). */
  category?: EscalationCategory;
  settings: ReputationSettings;
  now: Date;
}

export interface FollowThroughResult {
  taskId: string;
  /** The inbox escalation this raised or joined; null when the request has no conversation or raising it failed (the task and notice exist either way). */
  escalationId: string | null;
  /** Send these after the surrounding transaction commits. */
  emails: OutgoingEmail[];
}

/**
 * Reopens the conversation a review request lives in when it was resolved or archived, so the escalation is somewhere a person will see it. An open or snoozed
 * conversation is left alone.
 */
async function reopenIfClosed(db: Queryable, orgId: string, conversationId: string): Promise<void> {
  const c = (await db.query<{ status: string }>("select status from conversations where id = $1 and org_id = $2 for update", [conversationId, orgId])).rows[0];
  if (!c || c.status !== "closed") return;
  await db.query("update conversations set status = 'open', resolved_by = null, outcome = null, archived_at = null, archived_by = null where id = $1 and org_id = $2", [conversationId, orgId]);
  await recordConversationEvent(db, { orgId, conversationId, kind: "status_changed", actor: { kind: "system" }, detail: { from: "closed", to: "open", via: "low_feedback" } });
}

/**
 * The follow-up for one piece of low feedback, inside the transaction that stored it, so nothing is left half done:
 *   1. a high-priority task for the contact's owner (or unassigned), due when the team's acknowledgement time ends;
 *   2. a notice to the owner and managers;
 *   3. an inbox escalation in the conversation the request lives in, so the unhappy customer reaches a person who can reply (the summary holds the score, never their words);
 *   4. the customer's remaining automatic program messages stop, so they are not sent a cheerful check-in the next day;
 *   5. a `feedback.escalated` event, without the rating or the comment.
 * The escalation is best effort: if raising it fails the task and the notice still exist, and the failure is audited.
 */
export async function followThroughLowFeedback(db: Queryable, actor: CrmActor, i: LowFeedbackInput): Promise<FollowThroughResult> {
  const orgId = actor.orgId;
  const name = i.contact.name || "A customer";
  let assigneeId = i.contact.assigneeId;
  if (assigneeId) await assertAssignable(db, orgId, assigneeId).catch(() => { assigneeId = null; });
  const due = new Date(i.now.getTime() + i.settings.acknowledgeWithinHours * 3_600_000);
  const survey = i.source?.kind === "survey" ? i.source : null;
  const where = survey ? `in the survey “${survey.formName.slice(0, 80)}”` : "through their review request";
  const task = await createTaskInTx(db, actor, {
    title: `Follow up on ${name}'s feedback${i.scoreText ? ` (${i.scoreText})` : ""}`.slice(0, 200),
    description: [
      i.scoreText ? `${name} rated their experience ${i.scoreText} ${where}.` : `${name} left private feedback ${where}.`,
      i.comment ? `They wrote: "${i.comment.slice(0, 600)}"` : "They didn't leave a comment.",
      survey
        ? "This is private feedback. The survey knows who they are only from the email address or phone number they typed, so check it is really them before acting on it."
        : "This is private feedback. Their public review links were shown to them as usual.",
    ].join("\n\n"),
    priority: "high", dueAt: due.toISOString(), assigneeId, contactId: i.contact.id,
  }, { source: "system" });
  await db.query("update customer_feedback set follow_up_status = 'escalated', escalated_task_id = $3, low_score = true where id = $1 and org_id = $2", [i.feedbackId, orgId, task.id]);
  // The notice names the customer and the score, never what they wrote: notifications can be emailed, and email is outside the portal's access controls.
  await notifyOrgRoles(db, orgId, ["owner", "admin"], {
    kind: "retention_attention", severity: "warning", title: `Low feedback from ${name}${i.scoreText ? ` (${i.scoreText})` : ""}`.slice(0, 200),
    body: i.requestMessageId
      ? "A follow-up task was created and the conversation was flagged for a person. Open the contact to read what they wrote."
      : "A follow-up task was created. Open the contact to read what they wrote.",
    link: `/crm/contacts/${i.contact.id}`, dedupeKey: `feedback-low:${i.feedbackId}`,
  });

  let escalationId: string | null = null;
  const emails: OutgoingEmail[] = [];
  const conversationId = i.requestMessageId
    ? (await db.query<{ conversation_id: string }>("select conversation_id from conversation_messages where id = $1 and org_id = $2", [i.requestMessageId, orgId])).rows[0]?.conversation_id ?? null
    : null;
  if (conversationId) {
    await db.query("savepoint feedback_escalation");
    try {
      await reopenIfClosed(db, orgId, conversationId);
      const esc = await createEscalation(db, {
        orgId, conversationId, category: i.category ?? "complaint", urgency: "urgent", now: i.now,
        summary: `Private feedback${i.scoreText ? ` (${i.scoreText})` : ""} after a review request. The details are on the contact and in Reviews.`,
      });
      escalationId = esc.escalationId;
      emails.push(...esc.emails);
      await db.query("update customer_feedback set escalation_id = $3 where id = $1 and org_id = $2", [i.feedbackId, orgId, escalationId]);
      await db.query("release savepoint feedback_escalation");
    } catch (err) {
      await db.query("rollback to savepoint feedback_escalation").catch(() => undefined);
      escalationId = null;
      emails.length = 0;
      await recordAudit({ orgId, ...auditActor(actor), action: "crm.feedback_escalation_failed", targetType: "customer_feedback", targetId: i.feedbackId, result: "failure", metadata: { error: err instanceof Error ? err.message : "unknown" } }, db);
    }
  }

  const stopped = await cancelRetention(db, orgId, i.contact.id, "negative_feedback");
  await emitEvent(db, actor, {
    type: "feedback.escalated", entityType: "customer_feedback", entityId: i.feedbackId, contactId: i.contact.id,
    payload: { feedbackId: i.feedbackId, reviewRequestId: i.reviewRequestId, taskId: task.id, escalationId, programMessagesStopped: stopped.enrollments > 0 },
    dedupeKey: `feedback.escalated:${i.feedbackId}`,
  });
  await recordActivity(db, actor, {
    kind: "feedback.escalated", summary: "Low private feedback opened a follow-up for the team", contactId: i.contact.id, refType: "customer_feedback", refId: i.feedbackId,
    metadata: { taskId: task.id, escalationId, programMessagesStopped: stopped.enrollments }, occurredAt: i.now,
  });
  return { taskId: task.id, escalationId, emails };
}

/** Sends the emails a follow-up produced, after the transaction that made them committed. One that fails never undoes the customer's saved feedback. */
export async function sendFollowThroughEmails(emails: OutgoingEmail[]): Promise<void> {
  await Promise.all(emails.map((e) => sendEmail(e).catch(() => undefined)));
}

// ---------------------------------------------------------------------------
// Acknowledging and resolving
// ---------------------------------------------------------------------------

export interface FollowUpChange {
  status: "new" | "acknowledged" | "resolved";
  /** What was done, for a resolution (at most 600 characters). */
  note?: string | null;
}

/**
 * Marks where the team is with a piece of feedback: new, acknowledged or resolved ("escalated" is set by the escalation itself). Owners and managers can always;
 * so can the person the follow-up task is assigned to, who is the one actually doing the work. Every change is audited with who and when.
 */
export async function changeFeedbackFollowUp(actor: CrmActor, id: string, change: FollowUpChange): Promise<void> {
  assertCan(actor, "contacts.view");
  if (change.status !== "new" && change.status !== "acknowledged" && change.status !== "resolved") throw new AppError("invalid_input", "Choose new, acknowledged or resolved.");
  if (!UUID.test(id)) throw new AppError("not_found", "Feedback not found.");
  const note = change.status === "resolved" ? (change.note ?? "").replace(/\s+/g, " ").trim() : "";
  if (note.length > 600) throw new AppError("invalid_input", "Keep the note to 600 characters.");
  await crmWrite(actor, async (db) => {
    const r = (await db.query<{ contact_id: string | null; follow_up_status: FollowUpStatus; assignee: string | null }>(
      `select f.contact_id, f.follow_up_status, t.assigned_user_id as assignee from customer_feedback f
       left join tasks t on t.id = f.escalated_task_id and t.org_id = f.org_id where f.id = $1 and f.org_id = $2 for update of f`,
      [id, actor.orgId],
    )).rows[0];
    if (!r) throw new AppError("not_found", "Feedback not found.");
    const assignee = actor.kind === "member" && actor.userId !== null && r.assignee === actor.userId;
    if (!actor.can("reviews.manage") && !(assignee && actor.can("contacts.view"))) {
      assertCan(actor, "reviews.manage", "Updating feedback needs the review management permission, or being the person its follow-up task is assigned to.");
    }
    if (r.follow_up_status === change.status) return;
    const by = actor.userId;
    await db.query(
      `update customer_feedback set follow_up_status = $3,
         acknowledged_at = case when $3 = 'new' then null else coalesce(acknowledged_at, now()) end,
         acknowledged_by = case when $3 = 'new' then null else coalesce(acknowledged_by, $4::uuid) end,
         resolved_at = case when $3 = 'resolved' then now() else null end,
         resolved_by = case when $3 = 'resolved' then $4::uuid else null end,
         resolution_note = case when $3 = 'resolved' then $5 else null end
       where id = $1 and org_id = $2`,
      [id, actor.orgId, change.status, by, note || null],
    );
    if (r.contact_id) await recordActivity(db, actor, { kind: "feedback.follow_up", summary: `Feedback marked ${change.status}`, contactId: r.contact_id, refType: "customer_feedback", refId: id });
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.feedback_follow_up", targetType: "customer_feedback", targetId: id, result: "success", metadata: { from: r.follow_up_status, to: change.status, asAssignee: assignee && !actor.can("reviews.manage") } }, db);
  });
}

// ---------------------------------------------------------------------------
// The contact's feedback card
// ---------------------------------------------------------------------------

export interface ContactFeedbackItem {
  id: string;
  rating: number | null;
  npsScore: number | null;
  scale: "csat5" | "nps10";
  comment: string | null;
  receivedAt: string;
  followUpStatus: FollowUpStatus;
  lowScore: boolean;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  /** The follow-up task and the inbox conversation to open, when there are any. */
  taskId: string | null;
  conversationId: string | null;
}

export interface ContactReputationView {
  feedback: ContactFeedbackItem[];
  /** The newest low feedback nobody has resolved, or null. */
  open: ContactFeedbackItem | null;
  total: number;
}

/**
 * What this customer privately told the business, newest first, and the follow-up still open. Read after the permission check with trusted access, like the Reviews screen,
 * so every reader sees the same record. Never exposes anything about public reviews: there is no link between a person's feedback and what they post elsewhere.
 */
export async function getContactReputation(actor: CrmActor, contactId: string): Promise<ContactReputationView> {
  assertCan(actor, "contacts.view");
  if (!UUID.test(contactId)) throw new AppError("not_found", "Contact not found.");
  return withSystem(async (db) => {
    type Row = {
      id: string; rating: number | null; nps_score: number | null; scale: "csat5" | "nps10"; comment: string | null; received_at: Date; follow_up_status: FollowUpStatus; low_score: boolean;
      acknowledged_at: Date | null; resolved_at: Date | null; resolution_note: string | null; escalated_task_id: string | null; conversation_id: string | null;
    };
    const select = (where: string, limit: number) => db.query<Row>(
      `select f.id, f.rating, f.nps_score, f.scale, f.comment, f.received_at, f.follow_up_status, f.low_score, f.acknowledged_at, f.resolved_at, f.resolution_note,
              f.escalated_task_id, e.conversation_id
       from customer_feedback f left join human_escalations e on e.id = f.escalation_id and e.org_id = f.org_id
       where f.org_id = $1 and f.contact_id = $2 ${where} order by f.received_at desc, f.id limit ${limit}`,
      [actor.orgId, contactId],
    );
    const item = (r: Row): ContactFeedbackItem => ({
      id: r.id, rating: r.rating, npsScore: r.nps_score, scale: r.scale, comment: r.comment, receivedAt: iso(r.received_at)!, followUpStatus: r.follow_up_status, lowScore: r.low_score,
      acknowledgedAt: iso(r.acknowledged_at), resolvedAt: iso(r.resolved_at), resolutionNote: r.resolution_note, taskId: r.escalated_task_id, conversationId: r.conversation_id,
    });
    const latest = (await select("", 5)).rows.map(item);
    // The open follow-up is looked for on its own, so a low answer older than the latest few is not lost.
    const open = (await select("and f.low_score and f.follow_up_status <> 'resolved'", 1)).rows.map(item)[0] ?? null;
    const total = Number((await db.query<{ n: string }>("select count(*)::text as n from customer_feedback where org_id = $1 and contact_id = $2", [actor.orgId, contactId])).rows[0].n);
    return { feedback: latest, open, total };
  });
}
