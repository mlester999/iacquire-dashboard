import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { notifyOrgRoles } from "@/server/notifications";
import { systemActor, type CrmActor } from "@/server/crm/actor";
import { emitEvent } from "@/server/crm/events";
import { externalReviewsEnabledIn, REVIEWS_NOT_ENABLED_MESSAGE } from "@/server/reputation/entitlement";
import { assertManageSites, connectionCredentials, loadConnection, locationOf, recordProviderFailure, type ConnectionRow } from "@/server/reputation/connections";
import { reviewProviderFor, siteEnvironment } from "@/server/reputation/providers";
import { BudgetExceeded, ProviderError, squashReply, within, type ProviderReview, type ReviewProvider } from "@/server/reputation/providers/types";
import { reconcileDueReplies } from "@/server/reputation/replies";
import { loadSettings } from "@/server/reputation/settings";
import { isLowPublicReview, PROVIDER_LABELS } from "@/lib/reputation/external";

// Reading a review site's reviews into the mirror. This is the ONLY code that writes a review: nothing takes a review or a rating as input, the application role cannot insert,
// update or delete one, and a review exists here only because a site returned it. The mirror keeps what the site said, apart from what the site says about its own totals.
//
// A pass goes through the site's list page by page. Each page is stored together with the place to resume from, in one transaction, so a pass that is cut off continues where it
// stopped and a page is never half stored. A review the site no longer returns is marked removed only when a pass reached the end of the list AND read at least as many reviews
// as the site reports having: a list that was cut short, or that shifted under the reader, never marks anything removed. A removed review that comes back is restored.
//
// Reading twice changes nothing: rows are matched by the site's own id, the automation event and the team's notice for a review are keyed by the review, and a review whose
// words changed sends any reply written for the old words back to a draft.

export const SYNC_PAGE_SIZE = 50;
/** Pages read in one run: 300 reviews. A longer list is finished by the next run. */
export const SYNC_MAX_PAGES_PER_RUN = 6;
export const SYNC_LEASE_SECONDS = 120;
/** A connection is due when it was last read at least this long ago (the job runs hourly). */
export const SYNC_EVERY_MINUTES = 55;
/** A pass left unfinished for this long starts over: the site's list has moved on too far to resume from. */
export const PASS_MAX_AGE_HOURS = 24;
/** A review the first read of a connection finds is announced only if it is this recent; older ones are history, not news. */
export const ANNOUNCE_WITHIN_HOURS = 48;
export const MAX_CONNECTIONS_PER_RUN = 20;
/** "Read now" is refused when the site was read less than this long ago. */
export const MANUAL_SYNC_MIN_SECONDS = 60;

export interface SyncDeps {
  provider?: ReviewProvider;
  now?: Date;
  maxPages?: number;
  /** Epoch milliseconds after which the site is no longer waited on (the scheduler's budget). A page that was stored stays stored; the pass resumes where it stopped. */
  deadline?: number;
}

export interface SyncOutcome {
  status: "synced" | "partial" | "skipped" | "failed";
  /** Plain words for a skip or a failure. */
  reason: string | null;
  pages: number;
  /** Reviews the pages held that could be stored. */
  seen: number;
  inserted: number;
  updated: number;
  removed: number;
  restored: number;
  /** Entries the site returned that could not be stored (no rating and no recommendation, no id). */
  skippedEntries: number;
  /** New reviews announced to automations and, when low, to the team. */
  announced: number;
  /** The pass reached the end of the site's list. */
  complete: boolean;
  /** The pass reached the end but read fewer reviews than the site reports, so no review was marked removed. */
  removalWithheld: boolean;
}

const empty = (status: SyncOutcome["status"], reason: string | null = null): SyncOutcome => ({
  status, reason, pages: 0, seen: 0, inserted: 0, updated: 0, removed: 0, restored: 0, skippedEntries: 0, announced: 0, complete: false, removalWithheld: false,
});

interface Cursor {
  pageToken?: string | null;
  passStartedAt?: string;
  pages?: number;
  seen?: number;
  skipped?: number;
}

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const text = (v: string | null | undefined, max: number): string | null => {
  const t = String(v ?? "").replace(CONTROL, "").replace(/\r\n?/g, "\n").trim();
  return t ? t.slice(0, max) : null;
};

interface StoredReview {
  id: string;
  provider_review_id: string;
  rating: number | null;
  recommends: boolean | null;
  reviewer_name: string | null;
  reviewer_anonymous: boolean;
  comment: string | null;
  provider_reply_text: string | null;
  removed_at: Date | null;
}

interface PageResult {
  /** Reviews on the page that were stored or matched. */
  seen: number;
  /** Entries with neither a star rating nor a recommendation: not stored, because the mirror holds what the site said and not a guess. */
  unusable: number;
  inserted: number;
  updated: number;
  restored: number;
  announced: number;
}

/** Stores one page and the place to resume from, in the caller's transaction. */
async function storePage(
  db: Queryable, c: ConnectionRow, orgName: string, page: { reviews: ProviderReview[]; nextPageToken: string | null; reportedRating: number | null; reportedCount: number | null; skipped: number },
  pass: { startedAt: Date; first: boolean; now: Date; pages: number; seen: number; skipped: number; alertAtOrBelow: number },
): Promise<PageResult> {
  const unique = new Map<string, ProviderReview>();
  for (const r of page.reviews) if (r.providerReviewId && !unique.has(r.providerReviewId)) unique.set(r.providerReviewId, r);
  const ids = [...unique.keys()];
  const existing = new Map<string, StoredReview>();
  if (ids.length) {
    const { rows } = await db.query<StoredReview>(
      `select id, provider_review_id, rating, recommends, reviewer_name, reviewer_anonymous, comment, provider_reply_text, removed_at
       from external_reviews where connection_id = $1 and org_id = $2 and provider_review_id = any($3::text[])`,
      [c.id, c.org_id, ids],
    );
    for (const r of rows) existing.set(r.provider_review_id, r);
  }
  const result: PageResult = { seen: unique.size, unusable: 0, inserted: 0, updated: 0, restored: 0, announced: 0 };
  const simulated = c.adapter === "simulated";
  const actor = systemActor({ id: c.org_id });
  for (const r of unique.values()) {
    const rating = r.rating !== null && Number.isInteger(r.rating) && r.rating >= 1 && r.rating <= 5 ? r.rating : null;
    const recommends = rating === null ? r.recommends : null;
    if (rating === null && recommends === null) {
      result.unusable += 1;
      result.seen -= 1;
      continue;
    }
    const name = r.reviewerAnonymous ? null : text(r.reviewerName, 200);
    const comment = text(r.comment, 4096);
    const reply = r.reply ? text(r.reply.text, 4096) : null;
    const replyAt = reply && r.reply?.at ? r.reply.at : null;
    const prev = existing.get(r.providerReviewId);
    if (!prev) {
      const { rows } = await db.query<{ id: string }>(
        `insert into external_reviews (org_id, connection_id, provider_review_id, rating, recommends, reviewer_name, reviewer_anonymous, comment, provider_created_at, provider_updated_at,
           first_seen_at, last_seen_at, provider_reply_text, provider_reply_at, simulated)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, $12, $13, $14)
         on conflict (connection_id, provider_review_id) do nothing returning id`,
        [c.org_id, c.id, r.providerReviewId.slice(0, 200), rating, recommends, name, r.reviewerAnonymous || !name, comment, r.createdAt, r.updatedAt, pass.startedAt, reply, replyAt, simulated],
      );
      // Two readers at once: the other stored it first. It is theirs to announce.
      if (!rows[0]) continue;
      result.inserted += 1;
      const recent = r.createdAt ? pass.now.getTime() - new Date(r.createdAt).getTime() < ANNOUNCE_WITHIN_HOURS * 3_600_000 : false;
      if (!pass.first || recent) {
        result.announced += 1;
        await announceReview(db, actor, c, orgName, { id: rows[0].id, rating, recommends, simulated }, pass.alertAtOrBelow);
      }
      continue;
    }
    const changedWords = prev.rating !== rating || prev.recommends !== recommends || (prev.comment ?? null) !== comment;
    const changed = changedWords || prev.reviewer_name !== name || prev.reviewer_anonymous !== (r.reviewerAnonymous || !name) || (prev.provider_reply_text ?? null) !== reply;
    const restored = prev.removed_at !== null;
    if (restored) result.restored += 1;
    if (changed) result.updated += 1;
    await db.query(
      `update external_reviews set rating = $3, recommends = $4, reviewer_name = $5, reviewer_anonymous = $6, comment = $7, provider_updated_at = $8, last_seen_at = $9, removed_at = null,
         provider_reply_text = $10, provider_reply_at = case when $10::text is null then null else coalesce($11::timestamptz, provider_reply_at) end
       where id = $1 and org_id = $2`,
      [prev.id, c.org_id, rating, recommends, name, r.reviewerAnonymous || !name, comment, r.updatedAt, pass.startedAt, reply, replyAt],
    );
    if (changedWords) await voidRepliesForChangedReview(db, c.org_id, prev.id);
    if (reply) {
      // A posted reply that is now on the site, word for word, is confirmed by the site's own answer.
      await db.query(
        `update review_replies set verified_at = $4 where review_id = $1 and org_id = $2 and status = 'posted' and verified_at is null and regexp_replace(btrim(body), '\\s+', ' ', 'g') = $3`,
        [prev.id, c.org_id, squashReply(reply), pass.now],
      );
    }
  }
  const cursor: Cursor = page.nextPageToken
    ? { pageToken: page.nextPageToken, passStartedAt: pass.startedAt.toISOString(), pages: pass.pages + 1, seen: pass.seen + result.seen, skipped: pass.skipped + page.skipped + result.unusable }
    : {};
  await db.query(
    `update review_connections set sync_cursor = $3::jsonb, last_sync_at = $4,
       reported_rating = coalesce($5::numeric, reported_rating), reported_review_count = coalesce($6::integer, reported_review_count),
       reported_at = case when $5::numeric is null and $6::integer is null then reported_at else $4 end
     where id = $1 and org_id = $2`,
    [c.id, c.org_id, JSON.stringify(cursor), pass.now, page.reportedRating, page.reportedCount],
  );
  return result;
}

/** A review whose words changed after a reply was written: the approval was of the old words, so the reply goes back to a draft with a note, and its history says why. */
async function voidRepliesForChangedReview(db: Queryable, orgId: string, reviewId: string): Promise<void> {
  const { rows } = await db.query<{ id: string }>(
    `update review_replies set status = 'draft', approved_version = null, approved_hash = null, approved_by = null, approved_at = null,
       decision_note = 'The review changed after this reply was written. Read the review again, then send the reply for approval.'
     where review_id = $1 and org_id = $2 and status in ('pending_approval', 'approved', 'failed', 'changes_requested') returning id`,
    [reviewId, orgId],
  );
  for (const r of rows) {
    await db.query("insert into review_reply_events (org_id, reply_id, kind, actor_kind, detail) values ($1, $2, 'review_changed', 'system', '{}'::jsonb)", [orgId, r.id]);
  }
}

/**
 * A review that is new to the mirror: announced to automations once (the event is keyed by the review, and carries the site and the stars but no name or words), and, when it
 * is low, to the owner and managers once. The notice does not repeat the reviewer's words or name: it can be emailed.
 */
async function announceReview(db: Queryable, actor: CrmActor, c: ConnectionRow, orgName: string, r: { id: string; rating: number | null; recommends: boolean | null; simulated: boolean }, alertAtOrBelow: number): Promise<void> {
  await emitEvent(db, actor, {
    type: "review.external_received", entityType: "external_review", entityId: r.id,
    payload: { provider: c.provider, connectionId: c.id, reviewId: r.id, rating: r.rating, recommends: r.recommends, simulated: r.simulated },
    dedupeKey: `review.external_received:${r.id}`,
  });
  if (!isLowPublicReview(r, alertAtOrBelow)) return;
  const site = PROVIDER_LABELS[c.provider];
  await notifyOrgRoles(db, c.org_id, ["owner", "admin"], {
    kind: "review_needs_reply", severity: "warning", title: r.rating !== null ? `A ${r.rating}-star review arrived on ${site}` : `A recommendation that says no arrived on ${site}`,
    body: `${orgName}${r.simulated ? " (a test connection: this review is a sample)" : ""}. Read it and decide whether to reply.`,
    link: `/crm/reviews?tab=public&review=${r.id}`, dedupeKey: `review-low:${r.id}`,
  });
  await db.query("update external_reviews set alerted_at = now() where id = $1 and org_id = $2 and alerted_at is null", [r.id, c.org_id]);
}

interface Claim {
  row: ConnectionRow;
  orgName: string;
  alertAtOrBelow: number;
}

/** Takes the connection's lease, if it may be read now. Returns why not, in words, when it may not. */
async function claim(connectionId: string, now: Date, opts: { manual?: boolean }): Promise<{ ok: true; claim: Claim } | { ok: false; reason: string }> {
  return withSystem(async (db) => {
    const { rows } = await db.query<ConnectionRow & { org_name: string; org_status: string; sync_lease_until: Date | null; last_sync_at: Date | null }>(
      `select c.id, c.org_id, c.provider, c.adapter, c.external_account_id, c.external_location_id, c.name, c.social_account_id, c.credentials, c.status, c.can_reply, c.sync_cursor, c.last_complete_at,
              c.sync_lease_until, c.last_sync_at, o.name as org_name, o.status as org_status
       from review_connections c join organizations o on o.id = c.org_id where c.id = $1 for update of c`,
      [connectionId],
    );
    const c = rows[0];
    if (!c) return { ok: false, reason: "That connection was not found." };
    if (c.status !== "connected" && c.status !== "error") return { ok: false, reason: c.status === "disconnected" ? "It is disconnected." : "It needs to be reconnected before it can be read." };
    if (c.org_status === "suspended" || c.org_status === "archived") return { ok: false, reason: "The workspace is not active." };
    if (!(await externalReviewsEnabledIn(db, c.org_id))) return { ok: false, reason: REVIEWS_NOT_ENABLED_MESSAGE };
    if (c.adapter !== "simulated" && !siteEnvironment(c.provider).ready) return { ok: false, reason: "Reading this site isn't switched on for iAcquire yet." };
    if (c.sync_lease_until && new Date(c.sync_lease_until).getTime() > now.getTime()) return { ok: false, reason: "It is being read right now." };
    if (opts.manual && c.last_sync_at && now.getTime() - new Date(c.last_sync_at).getTime() < MANUAL_SYNC_MIN_SECONDS * 1000 && !c.sync_cursor?.pageToken) {
      return { ok: false, reason: "Reviews were read a moment ago. Try again in a minute." };
    }
    await db.query("update review_connections set sync_lease_until = $2::timestamptz + make_interval(secs => $3::int) where id = $1", [connectionId, now.toISOString(), SYNC_LEASE_SECONDS]);
    const settings = await loadSettings(db, c.org_id);
    return { ok: true, claim: { row: c, orgName: c.org_name, alertAtOrBelow: settings.publicReviewAlertAtOrBelow } };
  });
}

const release = (c: ConnectionRow) => withSystem((db) => db.query("update review_connections set sync_lease_until = null where id = $1 and org_id = $2", [c.id, c.org_id]));

/**
 * Reads one connection's reviews now. Safe to run twice and from two places at once (the connection's lease lets one reader in). Never throws for a site that is down: it
 * says what happened. Only an answer from the site changes what the connection is shown as (see recordProviderFailure).
 */
export async function syncConnection(connectionId: string, deps: SyncDeps & { manual?: boolean } = {}): Promise<SyncOutcome> {
  const now = deps.now ?? new Date();
  const got = await claim(connectionId, now, { manual: deps.manual });
  if (!got.ok) return empty("skipped", got.reason);
  const { row, orgName, alertAtOrBelow } = got.claim;
  const out = empty("synced");
  try {
    let provider: ReviewProvider;
    try {
      provider = deps.provider ?? reviewProviderFor(row.adapter);
    } catch {
      return empty("skipped", "This kind of connection isn't available here.");
    }
    const creds = await withSystem((db) => connectionCredentials(db, row));
    if (!creds.ok) {
      await withSystem((db) => recordProviderFailure(db, row, new ProviderError("auth", creds.reason, { needsReauth: true }), now));
      return { ...empty("failed", creds.reason) };
    }
    const saved: Cursor = row.sync_cursor ?? {};
    const stale = saved.passStartedAt ? now.getTime() - new Date(saved.passStartedAt).getTime() > PASS_MAX_AGE_HOURS * 3_600_000 : true;
    const resuming = Boolean(saved.pageToken) && !stale;
    const startedAt = resuming ? new Date(saved.passStartedAt as string) : now;
    let token: string | null = resuming ? (saved.pageToken as string) : null;
    let pages = resuming ? saved.pages ?? 0 : 0;
    let seen = resuming ? saved.seen ?? 0 : 0;
    let skipped = resuming ? saved.skipped ?? 0 : 0;
    // The first pass of a connection is a backfill: reviews older than a couple of days are history, and are stored without being announced.
    const first = row.last_complete_at === null;
    let reportedCount: number | null = null;
    const maxPages = Math.max(1, deps.maxPages ?? SYNC_MAX_PAGES_PER_RUN);
    // The time the scheduler gave this pass ran out: what was stored stays stored and the next run resumes. It says nothing about the site, so nothing is recorded against it.
    let timeUp = false;
    for (let i = 0; i < maxPages; i += 1) {
      if (deps.deadline !== undefined && Date.now() >= deps.deadline) {
        timeUp = true;
        break;
      }
      let page;
      try {
        page = await within(() => provider.fetchPage(creds.creds, locationOf(row), token, SYNC_PAGE_SIZE), deps.deadline);
      } catch (e) {
        if (e instanceof BudgetExceeded) {
          timeUp = true;
          break;
        }
        if (e instanceof ProviderError && e.kind === "blocked") return { ...out, status: "skipped", reason: e.message };
        if (token && e instanceof ProviderError && e.kind === "invalid_content") {
          // The place in the list is no longer valid: start over next time. This says nothing about the connection itself.
          await withSystem((db) => db.query("update review_connections set sync_cursor = '{}'::jsonb, last_sync_at = $3 where id = $1 and org_id = $2", [row.id, row.org_id, now]));
          return { ...out, status: "failed", reason: "The site's list changed while it was being read, so it will be read again from the start." };
        }
        await withSystem((db) => recordProviderFailure(db, row, e, now));
        return { ...out, status: "failed", reason: e instanceof ProviderError ? e.message : "The review site could not be reached." };
      }
      const stored = await withSystem((db) => storePage(db, row, orgName, page, { startedAt, first, now, pages, seen, skipped, alertAtOrBelow }));
      pages += 1;
      seen += stored.seen;
      skipped += page.skipped + stored.unusable;
      out.pages += 1;
      out.seen += stored.seen;
      out.inserted += stored.inserted;
      out.updated += stored.updated;
      out.restored += stored.restored;
      out.announced += stored.announced;
      out.skippedEntries += page.skipped + stored.unusable;
      if (page.reportedCount !== null) reportedCount = page.reportedCount;
      token = page.nextPageToken;
      if (!token) {
        out.complete = true;
        break;
      }
    }
    if (timeUp && out.pages === 0) return { ...out, status: "skipped", reason: "The time for this run was used up before it could be read." };
    await withSystem(async (db) => {
      if (out.complete) {
        // The totals the site reported while this pass ran (stored with the page that carried them) decide whether the list can be trusted to mark removals.
        const reported = reportedCount ?? (await db.query<{ n: number | null }>("select reported_review_count as n from review_connections where id = $1 and org_id = $2", [row.id, row.org_id])).rows[0]?.n ?? null;
        out.removalWithheld = reported !== null && seen + skipped < reported;
        if (!out.removalWithheld) {
          const gone = await db.query("update external_reviews set removed_at = $3 where connection_id = $1 and org_id = $2 and removed_at is null and last_seen_at < $4", [row.id, row.org_id, now, startedAt]);
          out.removed = gone.rowCount ?? 0;
        }
        await db.query(
          "update review_connections set last_complete_at = $3, last_success_at = $3, status = 'connected', status_detail = null where id = $1 and org_id = $2 and status in ('connected', 'error')",
          [row.id, row.org_id, now],
        );
      } else {
        await db.query("update review_connections set last_success_at = $3, status = 'connected', status_detail = null where id = $1 and org_id = $2 and status in ('connected', 'error')", [row.id, row.org_id, now]);
      }
    });
    out.status = out.complete ? "synced" : "partial";
    if (timeUp && !out.complete) out.reason = "The time for this run was used up; the rest is read next time.";
    return out;
  } finally {
    await release(row).catch(() => undefined);
  }
}

/** The connections that are due: switched on for their workspace, in an active workspace, read least recently first. */
export async function dueConnectionIds(now: Date, limit: number, orgId: string | null = null): Promise<string[]> {
  const { rows } = await withSystem((db) => db.query<{ id: string }>(
    `select c.id from review_connections c
     join organizations o on o.id = c.org_id and o.status not in ('suspended', 'archived')
     join org_features f on f.org_id = c.org_id and f.feature = 'reputation_reviews' and f.enabled
     where c.status in ('connected', 'error') and (c.sync_lease_until is null or c.sync_lease_until < $1) and ($3::uuid is null or c.org_id = $3)
       and (c.last_sync_at is null or c.last_sync_at <= $1::timestamptz - make_interval(mins => $4::int))
     order by c.last_sync_at nulls first, c.id limit $2`,
    [now.toISOString(), limit, orgId, SYNC_EVERY_MINUTES],
  ));
  return rows.map((r) => r.id);
}

export interface DueSyncResult {
  connections: number;
  inserted: number;
  updated: number;
  removed: number;
  failed: number;
}

/** The scheduler's pass: every due connection, one at a time, stopping early when the time given is used up (a site still being waited on then is abandoned, not waited for). */
export async function syncDueConnections(opts: { now?: Date; budgetMs?: number; limit?: number; orgId?: string | null; provider?: ReviewProvider } = {}): Promise<DueSyncResult> {
  const now = opts.now ?? new Date();
  const started = Date.now();
  const deadline = opts.budgetMs === undefined ? undefined : started + opts.budgetMs;
  const total: DueSyncResult = { connections: 0, inserted: 0, updated: 0, removed: 0, failed: 0 };
  for (const id of await dueConnectionIds(now, opts.limit ?? MAX_CONNECTIONS_PER_RUN, opts.orgId ?? null)) {
    if (deadline !== undefined && Date.now() >= deadline) break;
    const r = await syncConnection(id, { now, provider: opts.provider, deadline });
    if (r.status === "skipped") continue;
    total.connections += 1;
    total.inserted += r.inserted;
    total.updated += r.updated;
    total.removed += r.removed;
    if (r.status === "failed") total.failed += 1;
  }
  return total;
}

/** The most time the reviewSync job may take in all, reading and checking together. The scheduler's tick has 120 seconds for every job it runs. */
export const REVIEW_SYNC_BUDGET_MS = 60_000;

/**
 * The scheduler's job (reviewSync): read every due connection, then check the replies whose result is unknown. It posts nothing: a reply is posted only by a person pressing Post,
 * and the check only ever settles a reply a person already started posting. Both parts share one time budget (two thirds for reading, the rest for checking); a review site that never
 * answers costs the budget and no more. Returns the amount of work done, which the job's heartbeat shows.
 */
export async function runReviewSync(opts: { now?: Date; budgetMs?: number; provider?: ReviewProvider } = {}): Promise<number> {
  const budget = opts.budgetMs ?? REVIEW_SYNC_BUDGET_MS;
  const started = Date.now();
  const synced = await syncDueConnections({ now: opts.now, budgetMs: Math.floor((budget * 2) / 3), provider: opts.provider });
  const checked = await reconcileDueReplies({ now: opts.now, budgetMs: Math.max(0, budget - (Date.now() - started)), provider: opts.provider });
  return synced.inserted + synced.updated + synced.removed + checked.posted + checked.failed;
}

/** A person asks for the site to be read now (Reviews, Settings). Owners and managers of the client's own workspace; refused when it was read a moment ago. */
export async function syncNow(actor: CrmActor, connectionId: string, deps: SyncDeps = {}): Promise<SyncOutcome> {
  assertManageSites(actor);
  const c = await withSystem((db) => loadConnection(db, actor.orgId, connectionId));
  if (!c || c.status === "disconnected") throw new AppError("not_found", "That connection was not found.");
  const r = await syncConnection(connectionId, { ...deps, manual: true });
  if (r.status === "skipped") throw new AppError("conflict", r.reason ?? "It can't be read right now.");
  return r;
}
