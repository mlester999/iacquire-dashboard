import "server-only";
import type { Queryable } from "@/server/db";
import { externalReviewsEnabledIn } from "@/server/reputation/entitlement";
import { loadSettings } from "@/server/reputation/settings";
import { reasonText } from "@/lib/retention";
import { MIN_RESPONSES } from "@/lib/reputation/scores";
import { runReadOnlyReviewJob, reviewFinding, type ReviewCheck, type ReviewMetric } from "@/server/workforce/read-only-review";
import type { WorkJobRow } from "@/server/workforce/jobs";

// The Performance Analyst's read-only look at the business's reputation: private feedback that is waiting for a person, public reviews that nobody has answered, replies that are
// stuck, review sites that need reconnecting, and why requests for reviews did not go out. It reads stored records only. It drafts nothing, posts nothing, contacts no customer,
// approves nothing, and never writes, edits or counts a review or a rating. It names no customer and quotes no review: a finding says how many, and where to look.
//
// It never says why a review was written, never claims a request produced a review, and says plainly when there are too few answers to read anything into.

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const REPLY_WAIT_HOURS = 24;

/** Low private feedback nobody has acknowledged within the workspace's time. */
export const lowFeedbackWaiting: ReviewCheck = async (db, job) => {
  const settings = await loadSettings(db, job.org_id);
  const { rows } = await db.query<{ count: number; oldest_hours: number | null }>(
    `select count(*)::int as count, max(extract(epoch from (now() - f.received_at)) / 3600)::int as oldest_hours
     from customer_feedback f where f.org_id = $1 and f.low_score and f.acknowledged_at is null and f.follow_up_status in ('new', 'escalated') and f.received_at <= now() - make_interval(hours => $2::int)`,
    [job.org_id, settings.acknowledgeWithinHours],
  );
  const count = Number(rows[0]?.count ?? 0);
  if (!count) return null;
  return reviewFinding({
    key: "reputation_feedback_waiting", severity: "critical", count,
    title: `${plural(count, "customer")} left low private feedback that nobody has acknowledged within ${plural(settings.acknowledgeWithinHours, "hour")}`,
    detail: `The oldest has waited about ${plural(Number(rows[0]?.oldest_hours ?? 0), "hour")}. Private feedback stays with your team; it changes nothing about who is asked for a review or which review links anyone sees.`,
    evidenceHref: "/crm/reviews?tab=feedback", recommendedAction: "Open each one, follow up with the customer, then mark it acknowledged or resolved.", requiresApproval: false,
  });
};

/** Complaints raised from private feedback that still sit in the inbox queue with nobody on them. */
export const escalationsUnclaimed: ReviewCheck = async (db, job) => {
  const { rows } = await db.query<{ count: number }>(
    `select count(*)::int as count from human_escalations e
     where e.org_id = $1 and e.status in ('awaiting_owner', 'open') and e.created_at <= now() - interval '1 day'
       and exists (select 1 from customer_feedback f where f.org_id = e.org_id and f.escalation_id = e.id)`,
    [job.org_id],
  );
  const count = Number(rows[0]?.count ?? 0);
  if (!count) return null;
  return reviewFinding({
    key: "reputation_escalations_unclaimed", severity: "warning", count,
    title: `${plural(count, "complaint")} raised from private feedback ${count === 1 ? "has" : "have"} waited over a day for someone to take ${count === 1 ? "it" : "them"}`,
    detail: "Each one is a conversation in the inbox that nobody has claimed.",
    evidenceHref: "/inbox", recommendedAction: "Open the inbox, claim each one and write to the customer.", requiresApproval: false,
  });
};

const publicEnabled = (check: ReviewCheck): ReviewCheck => async (db, job) => ((await externalReviewsEnabledIn(db, job.org_id)) ? check(db, job) : null);

/** Public reviews at or below the workspace's alert level that have no reply on the site and none posted from here. */
export const lowReviewsUnanswered: ReviewCheck = publicEnabled(async (db, job) => {
  const settings = await loadSettings(db, job.org_id);
  const { rows } = await db.query<{ count: number }>(
    `select count(*)::int as count from external_reviews r
     where r.org_id = $1 and r.removed_at is null and r.provider_reply_text is null and ((r.rating is not null and r.rating <= $2) or r.recommends = false)
       and not exists (select 1 from review_replies p where p.review_id = r.id and p.org_id = r.org_id and p.status = 'posted')`,
    [job.org_id, settings.publicReviewAlertAtOrBelow],
  );
  const count = Number(rows[0]?.count ?? 0);
  if (!count) return null;
  return reviewFinding({
    key: "reputation_low_reviews_unanswered", severity: "warning", count,
    title: `${plural(count, "public review")} at ${plural(settings.publicReviewAlertAtOrBelow, "star")} or lower ${count === 1 ? "has" : "have"} no reply`,
    detail: "These are reviews your review site returned. Nothing was written, changed or hidden: a reply goes out only after the owner or a manager approves it.",
    evidenceHref: "/crm/reviews?tab=public&filter=low", recommendedAction: "Open each one and write a short, calm reply for the owner or a manager to approve.", requiresApproval: false,
  });
});

/** Replies sent for approval that have waited more than a day. */
export const repliesWaiting: ReviewCheck = publicEnabled(async (db, job) => {
  const { rows } = await db.query<{ count: number }>(
    `select count(*)::int as count from review_replies p where p.org_id = $1 and p.status = 'pending_approval'
       and (select max(e.at) from review_reply_events e where e.reply_id = p.id and e.org_id = p.org_id and e.kind = 'submitted') < now() - make_interval(hours => $2::int)`,
    [job.org_id, REPLY_WAIT_HOURS],
  );
  const count = Number(rows[0]?.count ?? 0);
  if (!count) return null;
  return reviewFinding({
    key: "reputation_replies_waiting", severity: "warning", count,
    title: `${plural(count, "reply")} to public reviews ${count === 1 ? "has" : "have"} been waiting for approval for over a day`,
    detail: "Nothing is posted until the owner or a manager has read the exact reply and approved it.",
    evidenceHref: "/crm/reviews?tab=public", recommendedAction: "Approve, ask for changes, or reject each one.", requiresApproval: false,
  });
});

/** Replies that did not go out, or whose result is still being checked. */
export const repliesStuck: ReviewCheck = publicEnabled(async (db, job) => {
  const { rows } = await db.query<{ failed: number; checking: number }>(
    `select count(*) filter (where p.status = 'failed')::int as failed, count(*) filter (where p.status in ('needs_reconciliation', 'posting'))::int as checking
     from review_replies p where p.org_id = $1 and p.status in ('failed', 'needs_reconciliation', 'posting')`,
    [job.org_id],
  );
  const failed = Number(rows[0]?.failed ?? 0);
  const checking = Number(rows[0]?.checking ?? 0);
  const count = failed + checking;
  if (!count) return null;
  return reviewFinding({
    key: "reputation_replies_stuck", severity: checking ? "critical" : "warning", count,
    title: `${plural(count, "reply")} to public reviews ${count === 1 ? "is" : "are"} not posted${checking ? " or not confirmed" : ""}`,
    detail: `${failed ? `${plural(failed, "reply")} failed to post. ` : ""}${checking ? `${plural(checking, "reply")} may or may not be on the review site; ${checking === 1 ? "it is" : "they are"} checked automatically and not sent again until that is known.` : ""}`.trim(),
    evidenceHref: "/crm/reviews?tab=public", recommendedAction: "Open each one, read the reason, then try again, or say whether it is on the review site.", requiresApproval: false,
  });
});

/** Review sites whose connection needs a person. */
export const connectionsNeedAttention: ReviewCheck = async (db, job) => {
  const { rows } = await db.query<{ count: number; names: string[] }>(
    `select count(*)::int as count, coalesce((array_agg(name order by name))[1:3], '{}') as names
     from review_connections where org_id = $1 and status in ('needs_reauth', 'error', 'revoked')`,
    [job.org_id],
  );
  const count = Number(rows[0]?.count ?? 0);
  if (!count) return null;
  return reviewFinding({
    key: "reputation_connections_attention", severity: "critical", count, samples: rows[0]?.names ?? [],
    title: `${plural(count, "review site connection")} ${count === 1 ? "needs" : "need"} attention`,
    detail: "No new reviews are read through these until they are fixed. The reviews already read stay where they are.",
    evidenceHref: "/crm/reviews?tab=settings", recommendedAction: "Ask the owner or a manager to reconnect each one.", requiresApproval: false,
  });
};

/** Customer programs the owner switched on that are not sending: the approval lapsed. */
export const programsLapsed: ReviewCheck = async (db, job) => {
  const { rows } = await db.query<{ count: number; names: string[] }>(
    `select count(*)::int as count, coalesce((array_agg(p.name order by p.name))[1:3], '{}') as names
     from retention_programs p left join approval_requests a on a.id = p.approval_id and a.org_id = p.org_id
     where p.org_id = $1 and p.enabled and p.approved_hash = p.content_hash and not (a.status = 'approved' and (a.expires_at is null or a.expires_at > now()))`,
    [job.org_id],
  );
  const count = Number(rows[0]?.count ?? 0);
  if (!count) return null;
  return reviewFinding({
    key: "reputation_programs_lapsed", severity: "warning", count, samples: rows[0]?.names ?? [],
    title: `${plural(count, "customer program")} ${count === 1 ? "is" : "are"} switched on but ${count === 1 ? "its" : "their"} approval has lapsed`,
    detail: "No message from a lapsed program goes to a customer until the owner approves its wording again.",
    evidenceHref: "/retention", recommendedAction: "Ask the owner to read each program and approve it again.", requiresApproval: false,
  });
};

/** Why review requests and surveys were not sent in the last 14 days, by the reason the send rules gave. */
export const requestsNotSent: ReviewCheck = async (db, job) => {
  const { rows } = await db.query<{ reason: string | null; n: number }>(
    `select m.blocked_reason as reason, count(*)::int as n
     from crm_review_requests r join conversation_messages m on m.id = r.message_id and m.org_id = r.org_id
     where r.org_id = $1 and r.created_at > now() - interval '14 days' and m.status in ('failed', 'blocked')
     group by 1 order by n desc`,
    [job.org_id],
  );
  const count = rows.reduce((t, r) => t + Number(r.n), 0);
  if (!count) return null;
  return reviewFinding({
    key: "reputation_requests_not_sent", severity: "info", count, samples: rows.slice(0, 3).map((r) => `${plural(Number(r.n), "request")}: ${reasonText(r.reason) || "not sent"}`),
    title: `${plural(count, "review request")} could not be sent in the last 14 days`,
    detail: "The rules every message to a customer follows stopped them: for example no consent on record, an opted-out address, no service credits, or quiet hours that ran out. They were not forced through.",
    evidenceHref: "/crm/reviews?tab=requests&filter=failed", recommendedAction: "Fix what each reason says, or contact those customers yourself.", requiresApproval: false,
  });
};

/** A plain caution about how little there is to read, so nothing above is taken for a trend. */
export const smallSample: ReviewCheck = async (db, job) => {
  const { rows } = await db.query<{ answers: number; public_reviews: number }>(
    `select (select count(*)::int from customer_feedback f where f.org_id = $1 and f.received_at > now() - interval '90 days' and (f.rating is not null or f.nps_score is not null)) as answers,
            (select count(*)::int from external_reviews r where r.org_id = $1 and r.removed_at is null) as public_reviews`,
    [job.org_id],
  );
  const answers = Number(rows[0]?.answers ?? 0);
  const reviews = Number(rows[0]?.public_reviews ?? 0);
  if (answers === 0 && reviews === 0) return null;
  if (answers >= MIN_RESPONSES.csat5 && (reviews === 0 || reviews >= MIN_RESPONSES.csat5)) return null;
  return reviewFinding({
    key: "reputation_small_sample", severity: "info", count: 1,
    title: "There are too few answers and reviews to read a trend",
    detail: `${plural(answers, "private answer")} in the last 90 days and ${plural(reviews, "public review")} read. A score needs at least ${MIN_RESPONSES.csat5} answers, and a handful of reviews can swing an average by a whole star.`,
    evidenceHref: "/crm/reviews?tab=satisfaction", recommendedAction: "Keep asking every customer the same way, and look again when there are more.", requiresApproval: false,
  });
};

export const metrics = async (db: Queryable, job: WorkJobRow): Promise<ReviewMetric[]> => {
  const { rows } = await db.query<{ low_open: number; answers: number; live: number; rated: number; avg: string | null; unanswered: number }>(
    `select (select count(*)::int from customer_feedback f where f.org_id = $1 and f.low_score and f.follow_up_status in ('new', 'escalated')) as low_open,
            (select count(*)::int from customer_feedback f where f.org_id = $1 and f.received_at > now() - interval '30 days' and (f.rating is not null or f.nps_score is not null)) as answers,
            (select count(*)::int from external_reviews r where r.org_id = $1 and r.removed_at is null) as live,
            (select count(*)::int from external_reviews r where r.org_id = $1 and r.removed_at is null and r.rating is not null) as rated,
            (select round(avg(r.rating), 1)::text from external_reviews r where r.org_id = $1 and r.removed_at is null and r.rating is not null) as avg,
            (select count(*)::int from external_reviews r where r.org_id = $1 and r.removed_at is null and r.provider_reply_text is null
               and not exists (select 1 from review_replies p where p.review_id = r.id and p.org_id = r.org_id and p.status = 'posted')) as unanswered`,
    [job.org_id],
  );
  const r = rows[0] ?? { low_open: 0, answers: 0, live: 0, rated: 0, avg: null, unanswered: 0 };
  const out: ReviewMetric[] = [
    { key: "reputation_low_feedback_open", label: "Low private feedback still open", value: r.low_open, period: "Now", definition: "Private feedback judged low when it arrived that has not been resolved.", source: "Private feedback" },
    { key: "reputation_private_answers", label: "Private answers", value: r.answers, period: "Last 30 days", definition: "Ratings and recommend scores customers gave privately. Not public reviews.", source: "Private feedback" },
  ];
  if (await externalReviewsEnabledIn(db, job.org_id)) {
    out.push(
      { key: "reputation_public_reviews", label: "Public reviews read", value: r.live, period: "Now", definition: `Reviews a connected review site returned and still returns. ${r.rated ? `${r.rated} have a star rating; their average is ${r.avg}.` : "None has a star rating."} A site's own total may be higher.`, source: "Review sites" },
      { key: "reputation_reviews_without_reply", label: "Public reviews without a reply", value: r.unanswered, period: "Now", definition: "Reviews read that have no reply on the site and none posted from here.", source: "Review sites" },
    );
  }
  return out;
};

export async function runReputationReviewJob(job: WorkJobRow, _context: { workerId: string; controller: AbortController }): Promise<void> {
  return runReadOnlyReviewJob(job, {
    capability: "reputation_review",
    allowedRoles: ["performance_analyst"],
    scanningMessage: "Reading private feedback, public reviews, replies, connections and review requests…",
    analyzingMessage: "Working out what is waiting for a person and what the evidence supports…",
    checks: [connectionsNeedAttention, lowFeedbackWaiting, escalationsUnclaimed, repliesStuck, lowReviewsUnanswered, repliesWaiting, programsLapsed, requestsNotSent, smallSample],
    metrics,
    limitations: "Only stored records in this workspace were read. Nothing was written, posted, approved or sent, no customer was contacted and no review site was asked anything. Public reviews are what a connected site last returned, not a live count, and the site's own total may be higher. No customer or reviewer is named and no review is quoted. A request for a review is never described as the cause of a review, and a small number of answers is never read as a trend.",
    subject: "Reputation",
  });
}
