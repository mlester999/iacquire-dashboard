import "server-only";
import type { Queryable } from "@/server/db";
import type { CrmActor } from "@/server/crm/actor";
import { emitEvent, recordActivity } from "@/server/crm/events";
import { cleanFeedbackComment } from "@/server/crm/reviews";
import { detectEscalationSignal } from "@/server/messaging/ingest";
import { surveysEnabledIn } from "@/server/reputation/entitlement";
import { followThroughLowFeedback } from "@/server/reputation/feedback";
import { loadSettings, thresholdsOf } from "@/server/reputation/settings";
import { describeScore, isLowScore } from "@/lib/reputation/scores";
import { withoutNegatedComplaints } from "@/lib/reputation/signals";
import type { MappedFeedback } from "@/lib/crm/forms/mapping";

// A survey form's answers saved as private feedback (migration 0094: customer_feedback.form_submission_id). The score, the comment and what follows a low score are exactly
// those of an answer given through a review request's link; only where the answer came from, and who it is attributed to, differ:
//  * An answer whose submission knew the person (an email or phone that matched or made a contact) is attributed to that contact, and a low one opens the same follow-up.
//    The form identifies people only by what they typed, so the follow-up task says to check it is really them. There is no conversation to escalate in, so there is no
//    inbox escalation: the task and the notice are the follow-up.
//  * An answer from someone who gave neither is kept and counted, attached to no one, and reported apart from the others. Nobody is told to follow up with no one.
// It runs inside the submission's own transaction, once per submission (a unique key on the submission).

export interface SurveyFeedbackInput {
  submissionId: string;
  formName: string;
  contactId: string | null;
  feedback: MappedFeedback;
  receivedAt: Date;
  now: Date;
}

export interface SurveyFeedbackResult {
  /** Null when there was nothing to save (no usable score and no comment), or this submission's feedback was already saved. */
  feedbackId: string | null;
  low: boolean;
  /** Notes for the submission about answers that weren't usable. */
  notes: string[];
}

/** Saves a survey submission's feedback. */
export async function saveSurveyFeedback(db: Queryable, actor: CrmActor, i: SurveyFeedbackInput): Promise<SurveyFeedbackResult> {
  const orgId = actor.orgId;
  // Saving a survey's answers as private feedback is dormant until a Super Admin switches surveys on for the workspace; the submission itself is kept either way.
  if (!(await surveysEnabledIn(db, orgId))) return { feedbackId: null, low: false, notes: ["The answers weren't saved as private feedback: satisfaction surveys aren't switched on for this workspace."] };
  const notes = i.feedback.rejected.map((r) => `“${r.question}” wasn't saved as feedback: ${r.why}.`);
  const comment = cleanFeedbackComment(i.feedback.comment);
  const score = i.feedback.score;
  const scale = i.feedback.scale ?? "csat5";
  if (score === null && !comment) return { feedbackId: null, low: false, notes };

  const settings = await loadSettings(db, orgId);
  // As for a link: a comment with no score is judged by what it says; a comment next to a score is judged by the score alone.
  const signal = score === null && comment ? detectEscalationSignal(withoutNegatedComplaints(comment)) : null;
  const low = score !== null ? isLowScore(scale, score, thresholdsOf(settings)) : Boolean(signal);
  const rating = scale === "csat5" ? score : null;
  const npsScore = scale === "nps10" ? score : null;
  const saved = await db.query<{ id: string }>(
    `insert into customer_feedback (org_id, rating, nps_score, comment, received_at, contact_id, source, follow_up_status, scale, low_score, form_submission_id)
     values ($1, $2, $3, $4, $5, $6, 'survey', 'new', $7, $8, $9)
     on conflict (org_id, form_submission_id) where form_submission_id is not null do nothing returning id`,
    [orgId, rating, npsScore, comment, i.receivedAt.toISOString(), i.contactId, scale, low, i.submissionId],
  );
  const feedbackId = saved.rows[0]?.id;
  if (!feedbackId) return { feedbackId: null, low: false, notes };
  if (!i.contactId) return { feedbackId, low, notes };

  const scoreText = describeScore(scale, score);
  await emitEvent(db, actor, {
    type: "feedback.received", entityType: "customer_feedback", entityId: feedbackId, contactId: i.contactId,
    payload: { feedbackId, reviewRequestId: null, rating, scale, npsScore, hasComment: Boolean(comment), source: "survey", submissionId: i.submissionId },
    dedupeKey: `feedback.received:${feedbackId}`, byContact: true,
  });
  await recordActivity(db, actor, {
    kind: "feedback.received", summary: scoreText ? `Left private feedback in a survey: ${scoreText}` : "Left private feedback in a survey", contactId: i.contactId,
    refType: "customer_feedback", refId: feedbackId, metadata: { rating, scale, npsScore, submissionId: i.submissionId }, occurredAt: i.receivedAt,
  });
  if (low) {
    const contact = (await db.query<{ display_name: string; assigned_user_id: string | null }>("select display_name, assigned_user_id from contacts where id = $1 and org_id = $2", [i.contactId, orgId])).rows[0];
    await followThroughLowFeedback(db, actor, {
      feedbackId, reviewRequestId: null, contact: { id: i.contactId, name: contact?.display_name || "A customer", assigneeId: contact?.assigned_user_id ?? null }, requestMessageId: null,
      source: { kind: "survey", formName: i.formName }, scoreText, comment, category: signal?.category, settings, now: i.now,
    });
  }
  return { feedbackId, low, notes };
}
