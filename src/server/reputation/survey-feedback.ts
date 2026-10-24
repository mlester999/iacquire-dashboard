import "server-only";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyOrgRoles } from "@/server/notifications";
import { assertCan, auditActor, crmWrite, systemActor, type CrmActor } from "@/server/crm/actor";
import { emitEvent, recordActivity } from "@/server/crm/events";
import { cleanFeedbackComment } from "@/server/crm/reviews";
import { detectEscalationSignal } from "@/server/messaging/ingest";
import { surveysEnabledIn } from "@/server/reputation/entitlement";
import { followThroughLowFeedback } from "@/server/reputation/feedback";
import { loadSettings, thresholdsOf } from "@/server/reputation/settings";
import { describeScore, isLowScore, type FeedbackScale } from "@/lib/reputation/scores";
import { withoutNegatedComplaints } from "@/lib/reputation/signals";
import type { MappedFeedback } from "@/lib/crm/forms/mapping";

// A survey form's answers saved as private feedback (migration 0094: customer_feedback.form_submission_id). The score, the comment and what follows a low score are exactly
// those of an answer given through a review request's link; only where the answer came from, and who it is attributed to, differ. A survey form knows who someone is only by the
// email or phone they TYPED, and anyone can type anyone's, so:
//  * An answer is attributed to a customer (and a low one opens the same follow-up) only when the submission made that customer, or the address it typed is one the business has
//    verified for them (contact_identities.verified). There is no conversation to escalate in, so there is no inbox escalation: the task and the notice are the follow-up.
//  * An answer that matches an EXISTING customer only by an address nobody has verified is kept with no customer and the possible match beside it (migration 0095:
//    customer_feedback.possible_contact_id). Nothing is done about that customer until a person confirms the match: no timeline line, no event by them, no stop to their programs, no task in
//    their name, no named count. The owner and managers are told, for a low one, so a person can decide. Dismissing the match leaves the answer anonymous.
//  * An answer from someone who gave neither is kept and counted, attached to no one, and reported apart from the others. Nobody is told to follow up with no one.
// It runs inside the submission's own transaction, once per submission (a unique key on the submission).

export interface SurveyFeedbackInput {
  submissionId: string;
  formName: string;
  /** The customer the submission matched or made, by the email or phone typed; null when it gave neither. */
  contactId: string | null;
  /** The submission itself made that customer, so there was no one else's record to mistake the answer for. */
  contactCreated?: boolean;
  /** What was typed (normalized), to check against the addresses the business has verified. */
  typed?: { email: string | null; phone: string | null };
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
  /** Whose the answer is: a customer's own, a customer's only perhaps (waiting for a person), or nobody's. */
  attribution: "contact" | "possible" | "none";
}

/** Whether the business has verified an address the submission typed for this customer (a typed address alone proves nothing). */
async function typedAddressVerified(db: Queryable, orgId: string, contactId: string, typed: SurveyFeedbackInput["typed"]): Promise<boolean> {
  const { rows } = await db.query(
    "select 1 from contact_identities where org_id = $1 and contact_id = $2 and verified and ((kind = 'email' and value = $3::text) or (kind = 'phone' and value = $4::text)) limit 1",
    [orgId, contactId, typed?.email ?? null, typed?.phone ?? null],
  );
  return rows.length > 0;
}

interface AnswerFacts {
  feedbackId: string;
  submissionId: string | null;
  contactId: string;
  formName: string;
  rating: number | null;
  npsScore: number | null;
  scale: FeedbackScale;
  comment: string | null;
  low: boolean;
  receivedAt: Date;
  now: Date;
}

/** What an answer that is a customer's own sets going: the event workflows start from, the timeline line, and for a low one the usual follow-up. */
async function actOnAttributedAnswer(db: Queryable, actor: CrmActor, a: AnswerFacts): Promise<void> {
  const score = a.scale === "csat5" ? a.rating : a.npsScore;
  const scoreText = describeScore(a.scale, score);
  await emitEvent(db, actor, {
    type: "feedback.received", entityType: "customer_feedback", entityId: a.feedbackId, contactId: a.contactId,
    payload: { feedbackId: a.feedbackId, reviewRequestId: null, rating: a.rating, scale: a.scale, npsScore: a.npsScore, hasComment: Boolean(a.comment), source: "survey", submissionId: a.submissionId },
    dedupeKey: `feedback.received:${a.feedbackId}`, byContact: true,
  });
  await recordActivity(db, actor, {
    kind: "feedback.received", summary: scoreText ? `Left private feedback in a survey: ${scoreText}` : "Left private feedback in a survey", contactId: a.contactId,
    refType: "customer_feedback", refId: a.feedbackId, metadata: { rating: a.rating, scale: a.scale, npsScore: a.npsScore, submissionId: a.submissionId }, occurredAt: a.receivedAt,
  });
  if (!a.low) return;
  const orgId = actor.orgId;
  const settings = await loadSettings(db, orgId);
  const contact = (await db.query<{ display_name: string; assigned_user_id: string | null }>("select display_name, assigned_user_id from contacts where id = $1 and org_id = $2", [a.contactId, orgId])).rows[0];
  const signal = score === null && a.comment ? detectEscalationSignal(withoutNegatedComplaints(a.comment)) : null;
  await followThroughLowFeedback(db, actor, {
    feedbackId: a.feedbackId, reviewRequestId: null, contact: { id: a.contactId, name: contact?.display_name || "A customer", assigneeId: contact?.assigned_user_id ?? null }, requestMessageId: null,
    source: { kind: "survey", formName: a.formName }, scoreText, comment: a.comment, category: signal?.category, settings, now: a.now,
  });
}

/** Saves a survey submission's feedback. */
export async function saveSurveyFeedback(db: Queryable, actor: CrmActor, i: SurveyFeedbackInput): Promise<SurveyFeedbackResult> {
  const orgId = actor.orgId;
  // Saving a survey's answers as private feedback is dormant until a Super Admin switches surveys on for the workspace; the submission itself is kept either way.
  if (!(await surveysEnabledIn(db, orgId))) return { feedbackId: null, low: false, notes: ["The answers weren't saved as private feedback: satisfaction surveys aren't switched on for this workspace."], attribution: "none" };
  const notes = i.feedback.rejected.map((r) => `“${r.question}” wasn't saved as feedback: ${r.why}.`);
  const comment = cleanFeedbackComment(i.feedback.comment);
  const score = i.feedback.score;
  const scale = i.feedback.scale ?? "csat5";
  if (score === null && !comment) return { feedbackId: null, low: false, notes, attribution: "none" };

  const settings = await loadSettings(db, orgId);
  // As for a link: a comment with no score is judged by what it says; a comment next to a score is judged by the score alone.
  const signal = score === null && comment ? detectEscalationSignal(withoutNegatedComplaints(comment)) : null;
  const low = score !== null ? isLowScore(scale, score, thresholdsOf(settings)) : Boolean(signal);
  const rating = scale === "csat5" ? score : null;
  const npsScore = scale === "nps10" ? score : null;

  const attribution: SurveyFeedbackResult["attribution"] = !i.contactId ? "none" : i.contactCreated || (await typedAddressVerified(db, orgId, i.contactId, i.typed)) ? "contact" : "possible";
  const saved = await db.query<{ id: string }>(
    `insert into customer_feedback (org_id, rating, nps_score, comment, received_at, contact_id, possible_contact_id, source, follow_up_status, scale, low_score, form_submission_id)
     values ($1, $2, $3, $4, $5, $6, $7, 'survey', 'new', $8, $9, $10)
     on conflict (org_id, form_submission_id) where form_submission_id is not null do nothing returning id`,
    [orgId, rating, npsScore, comment, i.receivedAt.toISOString(), attribution === "contact" ? i.contactId : null, attribution === "possible" ? i.contactId : null, scale, low, i.submissionId],
  );
  const feedbackId = saved.rows[0]?.id;
  if (!feedbackId) return { feedbackId: null, low: false, notes, attribution };
  if (attribution === "none") return { feedbackId, low, notes, attribution };

  if (attribution === "possible") {
    // A person decides whose it is. For a low answer the owner and managers are told so (without what was written: a notice can be emailed); a good one waits in the list.
    if (low) {
      const name = (await db.query<{ display_name: string }>("select display_name from contacts where id = $1 and org_id = $2", [i.contactId, orgId])).rows[0]?.display_name || "a customer";
      const scoreText = describeScore(scale, score);
      await notifyOrgRoles(db, orgId, ["owner", "admin"], {
        kind: "retention_attention", severity: "warning", title: `A low survey answer may be from ${name}${scoreText ? ` (${scoreText})` : ""}`.slice(0, 200),
        body: "The survey knew them only from an email address or phone number that was typed, which nobody has confirmed, so nothing was done for them. Open the answer and say whether it is really them.",
        link: "/crm/reviews?tab=feedback", dedupeKey: `feedback-match:${feedbackId}`,
      });
    }
    return { feedbackId, low, notes, attribution };
  }

  await actOnAttributedAnswer(db, actor, { feedbackId, submissionId: i.submissionId, contactId: i.contactId as string, formName: i.formName, rating, npsScore, scale, comment, low, receivedAt: i.receivedAt, now: i.now });
  return { feedbackId, low, notes, attribution };
}

// ---------------------------------------------------------------------------
// A person decides whose a waiting answer is
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface WaitingAnswer {
  id: string;
  form_submission_id: string | null;
  possible_contact_id: string | null;
  rating: number | null;
  nps_score: number | null;
  scale: FeedbackScale;
  comment: string | null;
  received_at: Date;
  low_score: boolean;
  form_name: string | null;
}

/** Who may say whose a survey answer is: the client's own owners and managers. It decides whether a customer's programs stop, so iAcquire support can look but not decide. */
function assertCanDecide(actor: CrmActor) {
  assertCan(actor, "reviews.manage", "Saying whose a survey answer is needs the review management permission.");
  if (actor.kind !== "member" || !actor.userId) throw new AppError("forbidden", "Only someone in the client's own workspace can say whose a survey answer is. iAcquire support can look but not decide.");
}

async function loadWaiting(db: Queryable, orgId: string, id: string): Promise<WaitingAnswer> {
  if (!UUID.test(id)) throw new AppError("not_found", "Feedback not found.");
  const r = (await db.query<WaitingAnswer>(
    `select f.id, f.form_submission_id, f.possible_contact_id, f.rating, f.nps_score, f.scale, f.comment, f.received_at, f.low_score, fm.name as form_name
     from customer_feedback f left join crm_form_submissions s on s.id = f.form_submission_id and s.org_id = f.org_id left join crm_forms fm on fm.id = s.form_id and fm.org_id = s.org_id
     where f.id = $1 and f.org_id = $2 for update of f`,
    [id, orgId],
  )).rows[0];
  if (!r) throw new AppError("not_found", "Feedback not found.");
  if (!r.possible_contact_id) throw new AppError("conflict", "This answer isn't waiting for anyone to say whose it is.");
  return r;
}

/** The record the customer is now: the one they were merged into, when they were merged (a merge keeps its history), or null when they no longer exist. */
async function liveContact(db: Queryable, orgId: string, contactId: string): Promise<string | null> {
  let id = contactId;
  for (let hops = 0; hops < 6; hops += 1) {
    const c = (await db.query<{ deleted_at: Date | null }>("select deleted_at from contacts where id = $1 and org_id = $2", [id, orgId])).rows[0];
    if (!c) return null;
    if (!c.deleted_at) return id;
    const next = (await db.query<{ kept_contact_id: string }>("select kept_contact_id from contact_merges where merged_contact_id = $1 and org_id = $2 order by created_at desc limit 1", [id, orgId])).rows[0]?.kept_contact_id;
    if (!next) return null;
    id = next;
  }
  return null;
}

/**
 * A person says the survey answer really is from the customer it may be from. It becomes that customer's own answer, and only now does what an attributed answer does (the event
 * workflows start from, the line on their timeline and, for a low one, the follow-up task, the notice and the stop to their automatic program messages). Audited with who.
 */
export async function confirmSurveyMatch(actor: CrmActor, feedbackId: string): Promise<{ contactId: string }> {
  assertCanDecide(actor);
  return crmWrite(actor, async (db) => {
    const orgId = actor.orgId;
    const a = await loadWaiting(db, orgId, feedbackId);
    const contactId = await liveContact(db, orgId, a.possible_contact_id as string);
    if (!contactId) throw new AppError("conflict", "The customer this may be from was removed, so it can't be confirmed. Dismiss the match instead.");
    await db.query("update customer_feedback set contact_id = $3, possible_contact_id = null where id = $1 and org_id = $2", [a.id, orgId, contactId]);
    await recordAudit({ orgId, ...auditActor(actor), action: "crm.survey_match_confirmed", targetType: "customer_feedback", targetId: a.id, result: "success", metadata: { contactId } }, db);
    await actOnAttributedAnswer(db, systemActor({ id: orgId, name: actor.orgName, timezone: actor.timezone }, "Survey answer"), {
      feedbackId: a.id, submissionId: a.form_submission_id, contactId, formName: a.form_name ?? "a survey", rating: a.rating, npsScore: a.nps_score, scale: a.scale, comment: a.comment, low: a.low_score, receivedAt: new Date(a.received_at), now: new Date(),
    });
    return { contactId };
  });
}

/** A person says it is not the customer it may be from. The answer stays, counted and with no one attached, and nothing is done about that customer. Audited with who. */
export async function dismissSurveyMatch(actor: CrmActor, feedbackId: string): Promise<void> {
  assertCanDecide(actor);
  await crmWrite(actor, async (db) => {
    const a = await loadWaiting(db, actor.orgId, feedbackId);
    await db.query("update customer_feedback set possible_contact_id = null where id = $1 and org_id = $2", [a.id, actor.orgId]);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.survey_match_dismissed", targetType: "customer_feedback", targetId: a.id, result: "success", metadata: { contactId: a.possible_contact_id } }, db);
  });
}
