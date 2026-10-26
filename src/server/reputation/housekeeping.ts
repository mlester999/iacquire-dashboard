import "server-only";
import { withSystem } from "@/server/db";

// The daily clean-up for public reviews and their replies (registered as reputationRetention). It removes what has outlived its use, a bounded amount at a time:
//
//   * a review site sign-in that nobody finished: its sealed choices are cleared as soon as its ten minutes are up, and the row is deleted a day later;
//   * the reviews read through a connection that was disconnected, once the retention period after the disconnection is over (their replies and the replies' history go with them);
//   * reviews the site stopped returning, once they have been gone for the retention period;
//   * the history of replies that are finished (posted, rejected or cancelled), once it is old.
//
// The periods are proposals for the product owner to confirm (the audit lists the retention of the mirror as an open decision), and each is one constant here. Neither a connection's
// row nor the audit log is touched, and a review linked to a customer is removed with the rest: its link is a convenience, not a record the business must keep.

export const MIRROR_DAYS_AFTER_DISCONNECT = 90;
export const REMOVED_REVIEW_DAYS = 90;
export const FINISHED_REPLY_EVENT_DAYS = 730;
export const PURGE_BATCH = 500;

export interface PurgeResult {
  signIns: number;
  disconnectedReviews: number;
  removedReviews: number;
  replyEvents: number;
}

export async function purgeReputationRecords(opts: { now?: Date } = {}): Promise<PurgeResult> {
  const now = (opts.now ?? new Date()).toISOString();
  return withSystem(async (db) => {
    // The sealed choices and refresh token of a sign-in that expired.
    const cleared = await db.query("update review_oauth_states set pending = null, code_verifier = null where pending is not null and (expires_at < $1::timestamptz or used_at is not null)", [now]);
    const deleted = await db.query("delete from review_oauth_states where expires_at < $1::timestamptz - interval '1 day'", [now]);
    const disconnected = await db.query(
      `delete from external_reviews where id in (
         select r.id from external_reviews r join review_connections c on c.id = r.connection_id and c.org_id = r.org_id
         where c.status = 'disconnected' and c.disconnected_at < $1::timestamptz - make_interval(days => $2::int) limit $3)`,
      [now, MIRROR_DAYS_AFTER_DISCONNECT, PURGE_BATCH],
    );
    const removed = await db.query(
      `delete from external_reviews where id in (
         select r.id from external_reviews r where r.removed_at is not null and r.removed_at < $1::timestamptz - make_interval(days => $2::int)
           and not exists (select 1 from review_replies p where p.review_id = r.id and p.org_id = r.org_id and p.status in ('draft', 'pending_approval', 'changes_requested', 'approved', 'posting', 'failed', 'needs_reconciliation')) limit $3)`,
      [now, REMOVED_REVIEW_DAYS, PURGE_BATCH],
    );
    const events = await db.query(
      `delete from review_reply_events where id in (
         select e.id from review_reply_events e join review_replies p on p.id = e.reply_id and p.org_id = e.org_id
         where p.status in ('posted', 'rejected', 'cancelled') and e.at < $1::timestamptz - make_interval(days => $2::int) limit $3)`,
      [now, FINISHED_REPLY_EVENT_DAYS, PURGE_BATCH],
    );
    return { signIns: (cleared.rowCount ?? 0) + (deleted.rowCount ?? 0), disconnectedReviews: disconnected.rowCount ?? 0, removedReviews: removed.rowCount ?? 0, replyEvents: events.rowCount ?? 0 };
  });
}
