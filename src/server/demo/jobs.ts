import "server-only";
import { withSystem } from "@/server/db";
import { LINK_EMAIL_KEEP_MINUTES, retentionAction, type ProspectStatus } from "@/lib/demo/rules";
import { releaseStaleReservations } from "@/server/demo/chat";
import { deleteUnconfirmedInTx, eraseProspectInTx } from "@/server/demo/erase";
import { readDemoSettings } from "@/server/demo/settings";

// The two scheduled jobs of the demo funnel. Like every job they run only when the scheduler does and, in a staged start, only when SCHEDULER_JOBS_ONLY names them. Neither sends
// anything to anyone and neither calls a provider; neither reads the demo switches (what a prospect already has is kept in step whether the demo is open or not), and both do
// nothing on an installation where nobody ever asked for a demo.
//
//   demoExpiry     every 15 minutes: persists the end of windows that ended (access never depends on this: it is decided from the clock whenever a prospect is read), gives back
//                  messages whose process died, removes spent links and sessions, and removes the outbox copy of each link email an hour after it was sent (the link is in its text).
//   demoRetention  daily: removes someone who never confirmed their address after 7 days, erases the details and conversation of a prospect whose demo ended (or who last visited)
//                  longer ago than the retention period in the settings, and drops daily counters older than a year. A converted or blocked prospect is left alone.

export const DEMO_EXPIRY_BUDGET_MS = 15_000;
export const DEMO_RETENTION_BUDGET_MS = 30_000;
const BATCH = 200;
const DAY_MS = 86_400_000;
/** Spent links and ended sessions are kept this long, so a prospect who pressed an old link is told it was used rather than that it never existed. */
const SPENT_KEEP_MS = DAY_MS;
const USAGE_KEEP_DAYS = 400;

export interface DemoExpiryResult {
  expired: number;
  released: number;
  sessions: number;
  links: number;
  emails: number;
}

export async function runDemoExpiry(opts: { now?: Date; budgetMs?: number } = {}): Promise<DemoExpiryResult> {
  const now = opts.now ?? new Date();
  const deadline = Date.now() + (opts.budgetMs ?? DEMO_EXPIRY_BUDGET_MS);
  let expired = 0;
  // Windows that ended: the status follows, with a timeline line dated the moment the window ended. A prospect who asked for a consultation or to buy keeps that status (it is the
  // latest thing they asked for); their access ended all the same.
  for (;;) {
    const moved = await withSystem((db) =>
      db.query(
        `with moved as (
           update demo_prospects set status = 'expired'
           where id in (select id from demo_prospects where status = 'active' and erased_at is null and window_ends_at <= $1::timestamptz order by window_ends_at limit $2 for update skip locked)
           returning id, window_ends_at)
         insert into demo_events (prospect_id, kind, actor_kind, at, detail) select id, 'expired', 'system', window_ends_at, '{}'::jsonb from moved returning prospect_id`,
        [now.toISOString(), BATCH],
      ),
    );
    expired += moved.rowCount;
    if (moved.rowCount < BATCH || Date.now() >= deadline) break;
  }
  const released = Date.now() < deadline ? await releaseStaleReservations(now, BATCH) : 0;
  const cutoff = new Date(now.getTime() - SPENT_KEEP_MS).toISOString();
  const emailCutoff = new Date(now.getTime() - LINK_EMAIL_KEEP_MINUTES * 60_000).toISOString();
  const cleaned = await withSystem(async (db) => ({
    sessions: (await db.query("delete from demo_sessions where expires_at < $1::timestamptz or revoked_at < $1::timestamptz", [cutoff])).rowCount,
    links: (await db.query("delete from demo_verifications where expires_at < $1::timestamptz or consumed_at < $1::timestamptz", [cutoff])).rowCount,
    emails: (await db.query("delete from email_outbox where template = 'demo_link' and created_at < $1::timestamptz", [emailCutoff])).rowCount,
  }));
  return { expired, released, ...cleaned };
}

export interface DemoRetentionResult {
  deleted: number;
  erased: number;
  usageDays: number;
}

interface Candidate {
  id: string;
  status: ProspectStatus;
  verified_at: Date | null;
  window_ends_at: Date | null;
  last_seen_at: Date | null;
  created_at: Date;
  erased_at: Date | null;
}

const asDate = (v: Date | null) => (v === null ? null : new Date(v));

export async function runDemoRetention(opts: { now?: Date; budgetMs?: number } = {}): Promise<DemoRetentionResult> {
  const now = opts.now ?? new Date();
  const deadline = Date.now() + (opts.budgetMs ?? DEMO_RETENTION_BUDGET_MS);
  const { settings } = await withSystem((db) => readDemoSettings(db));
  const retentionMs = settings.retentionDays * DAY_MS;
  let deleted = 0;
  let erased = 0;
  let after = "00000000-0000-0000-0000-000000000000";
  // The database narrows the candidates to those that could be due; the same pure rule the tests walk then decides each one, so the boundary is in one place.
  while (Date.now() < deadline) {
    const batch = await withSystem((db) =>
      db.query<Candidate>(
        `select id, status, verified_at, window_ends_at, last_seen_at, created_at, erased_at from demo_prospects
         where id > $1::uuid and erased_at is null and status not in ('converted', 'blocked')
           and ((verified_at is null and created_at <= $2::timestamptz - interval '7 days')
             or (verified_at is not null and greatest(created_at, coalesce(window_ends_at, created_at), coalesce(last_seen_at, created_at)) <= $2::timestamptz - ($3::bigint * interval '1 millisecond')))
         order by id limit $4`,
        [after, now.toISOString(), retentionMs, BATCH],
      ),
    );
    if (!batch.rows.length) break;
    for (const c of batch.rows) {
      after = c.id;
      const action = retentionAction(
        { status: c.status, verifiedAt: asDate(c.verified_at), windowEndsAt: asDate(c.window_ends_at), lastSeenAt: asDate(c.last_seen_at), createdAt: new Date(c.created_at), erasedAt: asDate(c.erased_at) },
        now,
        settings.retentionDays,
      );
      if (action === "delete") {
        if (await withSystem((db) => deleteUnconfirmedInTx(db, c.id))) deleted += 1;
      } else if (action === "erase") {
        if (await withSystem((db) => eraseProspectInTx(db, c.id, { kind: "system" }, "retention", now))) erased += 1;
      }
    }
    if (batch.rows.length < BATCH) break;
  }
  const usageDays = (await withSystem((db) => db.query("delete from demo_usage_days where day < ($1::timestamptz - ($2::int * interval '1 day'))::date", [now.toISOString(), USAGE_KEEP_DAYS]))).rowCount;
  return { deleted, erased, usageDays };
}
