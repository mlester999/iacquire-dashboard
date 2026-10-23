import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { notifyOrgRoles, notifyUser } from "@/server/notifications";
import { recordAudit } from "@/server/audit";
import { classifyProviderFailure, isRetryable, retryDelayMs, type FailureKind } from "@/lib/social/errors";
import { signAuthorizedPrivateFile } from "@/server/storage/private";
import { openCredentials } from "@/server/social/credentials";
import { addEvent, loadAccountRow, loadPostRow, messageFor, readSettings, type AccountRow, type PostRow } from "@/server/social/post-core";
import { livePublishingEnabled, providerFor } from "@/server/social/providers";
import { ProviderError, type Credentials, type PublishInput, type PublishState, type SocialProvider } from "@/server/social/providers/types";
import { markAccountNeedsReauth } from "@/server/social/accounts";

// Publishing, durably. A scheduled post has a job. A worker claims a due job for a short LEASE, does the next step at the platform, and saves what happened after
// EVERY step, so a worker that dies and the worker that takes over continue from the same place. The rules that keep a post from going out twice:
//
//   1. One live job per post (a database index), so a second worker, a double click or a retry cannot start a parallel publication.
//   2. A job is claimed by one worker at a time (`for update skip locked`, then a lease). A worker that loses its lease stops writing.
//   3. The intent to send is written BEFORE the request that could create the post leaves. If the worker dies, or the answer never arrives, the job is marked
//      "unknown" and the post "needs reconciliation": it is CHECKED with the platform, never re-sent on a guess.
//   4. What a step created (an unpublished Facebook object, an Instagram container) is saved and reused, so a retry resumes instead of creating another.
//   5. An approval is of one version. A job for any other version does not run.
//
// Nothing here posts to a real account unless the environment's write switch is on; jobs for real accounts simply wait while it is off.

export const LEASE_SECONDS = 120;
/** How long after sending before "I could not find it" is believed. Platforms can take a while to list a new post. */
export const RECONCILE_GRACE_MS = 10 * 60_000;
/** After this long without a way to check, a person decides. */
export const RECONCILE_GIVE_UP_MS = 24 * 3_600_000;
const MAX_STEPS_PER_RUN = 6;

export interface JobRow {
  id: string;
  org_id: string;
  post_id: string;
  account_id: string;
  post_version: number;
  idempotency_key: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";
  run_at: Date;
  attempt: number;
  max_attempts: number;
  lease_until: Date | null;
  claimed_by: string | null;
  state: PublishState;
  last_error: string | null;
  last_error_kind: FailureKind | null;
}

const JOB_COLUMNS = "id, org_id, post_id, account_id, post_version, idempotency_key, status, run_at, attempt, max_attempts, lease_until, claimed_by, state, last_error, last_error_kind";

export interface PublisherDeps {
  provider?: (adapter: "meta" | "simulated") => SocialProvider;
  now?: () => Date;
  workerId?: string;
  /** The address a platform can fetch a managed file from. */
  mediaUrl?: (fileId: string) => Promise<string>;
  /** Whether real platforms may be posted to. Simulated accounts are not affected. */
  liveEnabled?: () => boolean;
  /** A number in [0, 1) that spreads retry times. */
  jitter?: () => number;
}

const clock = (d: PublisherDeps) => (d.now ? d.now() : new Date());
const prov = (d: PublisherDeps, adapter: "meta" | "simulated") => (d.provider ? d.provider(adapter) : providerFor(adapter));

// ---------------------------------------------------------------------------
// Queueing and cancelling
// ---------------------------------------------------------------------------

/** One job for one publication. Asking twice for the same publication returns the first job. */
export async function enqueueJob(db: Queryable, post: Pick<PostRow, "id" | "org_id" | "account_id" | "version">, runAt: Date, ordinal = 0): Promise<{ jobId: string; created: boolean }> {
  const key = `${post.id}:${post.version}:${runAt.getTime()}:${ordinal}`;
  const ins = await db.query<{ id: string }>(
    "insert into social_publish_jobs (org_id, post_id, account_id, post_version, idempotency_key, run_at) values ($1, $2, $3, $4, $5, $6) on conflict (idempotency_key) do nothing returning id",
    [post.org_id, post.id, post.account_id, post.version, key, runAt],
  );
  if (ins.rows[0]) return { jobId: ins.rows[0].id, created: true };
  const ex = await db.query<{ id: string }>("select id from social_publish_jobs where idempotency_key = $1", [key]);
  return { jobId: ex.rows[0].id, created: false };
}

/**
 * Cancels a post's job if it has not started. Returns false when a worker holds it or it may already have sent: those cannot be cancelled safely, and the caller
 * must say so instead of pretending.
 */
export async function cancelQueuedJob(db: Queryable, postId: string): Promise<boolean> {
  await db.query("update social_publish_jobs set status = 'cancelled', finished_at = now() where post_id = $1 and status = 'queued' and not (state ? 'sendingAt')", [postId]);
  const live = await db.query<{ n: string }>("select count(*)::text as n from social_publish_jobs where post_id = $1 and status in ('queued', 'running', 'unknown')", [postId]);
  return live.rows[0].n === "0";
}

// ---------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------

/** A worker that stopped renewing its lease is taken over: resumed from its saved state, or sent to be checked when it may already have sent. */
export async function recoverExpiredLeases(db: Queryable, now: Date, orgId: string | null = null): Promise<number> {
  const { rows } = await db.query<JobRow>(`select ${JOB_COLUMNS} from social_publish_jobs where status = 'running' and lease_until < $1 and ($2::uuid is null or org_id = $2) for update skip locked`, [now, orgId]);
  for (const j of rows) {
    const maybeSent = Boolean(j.state?.sendingAt) && !j.state?.providerPostId;
    if (maybeSent) {
      await db.query("update social_publish_jobs set status = 'unknown', claimed_by = null, lease_until = null, run_at = $2, last_error_kind = 'unknown_outcome', last_error = $3 where id = $1", [j.id, new Date(now.getTime() + 60_000), "The worker stopped while sending; the result is being checked."]);
      await db.query("update social_posts set status = 'needs_reconciliation' where id = $1 and org_id = $2 and status in ('scheduled', 'publishing')", [j.post_id, j.org_id]);
      await addEvent(db, j.org_id, j.post_id, "worker_lost_while_sending", { kind: "system", id: null }, { attempt: j.attempt });
    } else {
      await db.query("update social_publish_jobs set status = 'queued', claimed_by = null, lease_until = null, run_at = $2 where id = $1", [j.id, now]);
      await addEvent(db, j.org_id, j.post_id, "worker_lost_resumed", { kind: "system", id: null }, { attempt: j.attempt });
    }
  }
  return rows.length;
}

async function claimNext(db: Queryable, workerId: string, now: Date, live: boolean, orgId: string | null): Promise<JobRow | null> {
  const { rows } = await db.query<JobRow>(
    `update social_publish_jobs j set status = 'running', attempt = j.attempt + 1, lease_until = $2, claimed_by = $1, started_at = coalesce(j.started_at, $3)
     where j.id = (
       select q.id from social_publish_jobs q join social_accounts a on a.id = q.account_id and a.org_id = q.org_id
       where q.status = 'queued' and q.run_at <= $3 and (a.adapter = 'simulated' or $4::boolean) and ($5::uuid is null or q.org_id = $5)
       order by q.run_at, q.created_at limit 1 for update of q skip locked
     )
     returning ${JOB_COLUMNS.split(", ").map((c) => `j.${c}`).join(", ")}`,
    [workerId, new Date(now.getTime() + LEASE_SECONDS * 1000), now, live, orgId],
  );
  return rows[0] ?? null;
}

/** Saves the job's state and extends its lease. False means this worker no longer holds the job (it was taken over), and it must stop. */
async function persist(jobId: string, workerId: string, state: PublishState, now: Date): Promise<boolean> {
  return withSystem(async (db) => {
    const r = await db.query("update social_publish_jobs set state = $3::jsonb, lease_until = $4 where id = $1 and claimed_by = $2 and status = 'running' returning id", [jobId, workerId, JSON.stringify(state), new Date(now.getTime() + LEASE_SECONDS * 1000)]);
    return r.rows.length === 1;
  });
}

async function requeue(jobId: string, workerId: string, state: PublishState, runAt: Date, error: { kind: FailureKind | null; message: string | null }, refundAttempt: boolean): Promise<void> {
  await withSystem((db) => db.query(
    `update social_publish_jobs set status = 'queued', state = $3::jsonb, run_at = $4, lease_until = null, claimed_by = null, last_error = $5, last_error_kind = $6, attempt = greatest(0, attempt - $7)
     where id = $1 and claimed_by = $2 and status = 'running'`,
    [jobId, workerId, JSON.stringify(state), runAt, error.message, error.kind, refundAttempt ? 1 : 0],
  ));
}

async function failJob(db: Queryable, job: JobRow, post: PostRow, code: string, message: string, kind: FailureKind | null, now: Date): Promise<void> {
  await db.query("update social_publish_jobs set status = 'failed', last_error = $2, last_error_kind = $3, lease_until = null, finished_at = $4 where id = $1", [job.id, message.slice(0, 400), kind, now]);
  await db.query("update social_posts set status = 'failed', failure_code = $2, failure_message = $3 where id = $1 and org_id = $4 and status in ('scheduled', 'publishing', 'needs_reconciliation')", [post.id, code.slice(0, 60), message.slice(0, 400), post.org_id]);
  await addEvent(db, post.org_id, post.id, "publish_failed", { kind: "system", id: null }, { code, attempt: job.attempt });
  await recordAudit({ orgId: post.org_id, actorKind: "system", action: "social.publish_failed", targetType: "social_post", targetId: post.id, result: "failure", metadata: { code } }, db);
  const title = "A social post could not be published";
  await notifyOrgRoles(db, post.org_id, ["owner", "admin"], { kind: "social_post_failed", severity: "warning", title, body: message.slice(0, 300), link: `/social/posts/${post.id}`, dedupeKey: `social-failed:${post.id}:${post.version}` });
  if (post.author_id) await notifyUser(db, post.author_id, post.org_id, { kind: "social_post_failed", severity: "warning", title, body: message.slice(0, 300), link: `/social/posts/${post.id}`, dedupeKey: `social-failed-author:${post.id}:${post.version}` });
}

async function succeedJob(db: Queryable, job: JobRow, post: PostRow, state: PublishState, now: Date, via: "published" | "reconciled_published"): Promise<void> {
  await db.query("update social_publish_jobs set status = 'succeeded', state = $2::jsonb, lease_until = null, finished_at = $3, last_error = null, last_error_kind = null where id = $1", [job.id, JSON.stringify(state), now]);
  await db.query(
    "update social_posts set status = 'published', provider_post_id = $2, permalink = $3, published_at = $4, failure_code = null, failure_message = null where id = $1 and org_id = $5",
    [post.id, state.providerPostId, state.permalink ?? null, now, post.org_id],
  );
  await addEvent(db, post.org_id, post.id, via, { kind: "system", id: null }, { providerPostId: state.providerPostId, attempt: job.attempt });
  await recordAudit({ orgId: post.org_id, actorKind: "system", action: "social.post_published", targetType: "social_post", targetId: post.id, result: "success", metadata: { providerPostId: state.providerPostId, approvedBy: post.approved_by } }, db);
}

interface Prepared {
  input: PublishInput;
  creds: Credentials;
  account: AccountRow;
  provider: SocialProvider;
}

type Outcome = "succeeded" | "failed" | "requeued" | "unknown" | "cancelled" | "lost";

/** Everything the job needs, or the reason it cannot run. A job that cannot run is finished here with a plain reason. */
async function prepare(job: JobRow, post: PostRow, deps: PublisherDeps, now: Date): Promise<{ ok: true; p: Prepared } | { ok: false; outcome: Outcome }> {
  const account = await withSystem((db) => loadAccountRow(db, job.org_id, job.account_id));
  const fail = async (code: string, message: string, kind: FailureKind | null): Promise<{ ok: false; outcome: Outcome }> => {
    await withSystem((db) => failJob(db, job, post, code, message, kind, now));
    return { ok: false, outcome: "failed" };
  };
  if (!account || account.status !== "connected") return fail("account_unavailable", "The account is not connected, so this was not published. Reconnect it and schedule the post again.", "auth");
  if (post.approved_version !== post.version) return fail("approval_stale", "The post was changed after it was approved, so it was not published. Approve it again.", "blocked");
  const blockedUntil = account.rate_state?.blockedUntil ? new Date(account.rate_state.blockedUntil) : null;
  if (blockedUntil && blockedUntil > now) {
    await requeue(job.id, deps.workerId ?? "worker", job.state, blockedUntil, { kind: "blocked", message: "The platform has blocked this account from posting for now." }, true);
    return { ok: false, outcome: "requeued" };
  }
  const creds = openCredentials(account.credentials);
  if (!creds) {
    await withSystem(async (db) => {
      await failJob(db, job, post, "auth", "The saved sign-in for this account can no longer be used. Reconnect it.", "auth", now);
      await markAccountNeedsReauth(db, job.org_id, account.id, "The saved sign-in can no longer be used. Reconnect the account.", now);
    });
    return { ok: false, outcome: "failed" };
  }
  const settings = await withSystem((db) => readSettings(db, post.org_id));
  const campaign = post.campaign_id ? (await withSystem((db) => db.query<{ utm_campaign: string }>("select utm_campaign from social_campaigns where id = $1 and org_id = $2", [post.campaign_id, post.org_id]))).rows[0]?.utm_campaign ?? null : null;
  const { message, linkUrl } = messageFor(post, account.platform, campaign, settings.trackingLinks);
  const media: PublishInput["media"] = [];
  for (const assetId of post.media_asset_ids) {
    const a = (await withSystem((db) => db.query<{ source: string; private_file_id: string | null; kind: "image" | "video"; mime_type: string; status: string }>(
      "select source, private_file_id, kind, mime_type, status from social_media_assets where id = $1 and org_id = $2", [assetId, post.org_id],
    ))).rows[0];
    if (!a || a.status !== "ready" || a.source !== "managed" || !a.private_file_id) return fail("media_unavailable", "A picture or video on this post is no longer available, so it was not published.", "invalid_content");
    media.push({ kind: a.kind, mimeType: a.mime_type, url: await (deps.mediaUrl ?? signAuthorizedPrivateFile)(a.private_file_id) });
  }
  return { ok: true, p: { input: { platform: account.platform, externalId: account.external_id, kind: post.kind, message, linkUrl, media, idempotencyKey: job.idempotency_key }, creds, account, provider: prov(deps, account.adapter) } };
}

/** Runs one claimed job as far as it can go. Never throws: every way it can end is recorded. */
export async function runClaimedJob(job: JobRow, deps: PublisherDeps = {}): Promise<Outcome> {
  const workerId = deps.workerId ?? "worker";
  const now = clock(deps);
  const post = await withSystem((db) => loadPostRow(db, job.org_id, job.post_id));
  // A job belongs to one version of one post. If the post moved on (edited, cancelled, resolved by a person), the job is simply stood down.
  if (!post || post.version !== job.post_version || (post.status !== "scheduled" && post.status !== "publishing")) {
    await withSystem((db) => db.query("update social_publish_jobs set status = 'cancelled', lease_until = null, finished_at = $2 where id = $1", [job.id, now]));
    return "cancelled";
  }
  const prep = await prepare(job, post, { ...deps, workerId }, now);
  if (!prep.ok) return prep.outcome;
  const { input, creds, account, provider } = prep.p;
  let state: PublishState = { ...job.state };

  await withSystem(async (db) => {
    if (post.status === "scheduled") {
      await db.query("update social_posts set status = 'publishing' where id = $1 and org_id = $2 and status = 'scheduled'", [post.id, post.org_id]);
      await addEvent(db, post.org_id, post.id, "publish_started", { kind: "system", id: null }, { attempt: job.attempt });
    }
  });

  for (let i = 0; i < MAX_STEPS_PER_RUN; i++) {
    // The intent to send is saved first. From here until the answer is saved, a crash means "possibly sent".
    if (provider.mayCreate(input, state) && !state.sendingAt) {
      state = { ...state, sendingAt: clock(deps).toISOString() };
      if (!(await persist(job.id, workerId, state, clock(deps)))) return "lost";
    }
    let result;
    try {
      result = await provider.step(creds, input, state);
    } catch (e) {
      return handleFailure(job, post, account, state, e, deps, workerId);
    }
    state = result.state;
    if (!(await persist(job.id, workerId, state, clock(deps)))) return "lost";
    if (state.done && state.providerPostId) {
      await withSystem((db) => succeedJob(db, job, post, state, clock(deps), "published"));
      await withSystem((db) => db.query("update social_accounts set last_success_at = $2 where id = $1", [account.id, clock(deps)]));
      return "succeeded";
    }
    if (result.waitSeconds && result.waitSeconds > 0) {
      await requeue(job.id, workerId, state, new Date(clock(deps).getTime() + result.waitSeconds * 1000), { kind: null, message: null }, true);
      return "requeued";
    }
  }
  // Too many steps in one run without finishing: come back to it rather than hold the worker.
  await requeue(job.id, workerId, state, new Date(clock(deps).getTime() + 15_000), { kind: null, message: null }, true);
  return "requeued";
}

async function handleFailure(job: JobRow, post: PostRow, account: AccountRow, state: PublishState, error: unknown, deps: PublisherDeps, workerId: string): Promise<Outcome> {
  const now = clock(deps);
  const e = error instanceof ProviderError ? error : new ProviderError(classifyProviderFailure({ httpStatus: null, error: null, sent: Boolean(state.sendingAt), }).kind, "The platform could not be reached.");
  if (e.kind === "unknown_outcome") {
    // Keep sendingAt: this is exactly the case it exists for.
    await withSystem(async (db) => {
      await db.query("update social_publish_jobs set status = 'unknown', state = $2::jsonb, lease_until = null, claimed_by = null, run_at = $3, last_error = $4, last_error_kind = 'unknown_outcome' where id = $1 and claimed_by = $5", [job.id, JSON.stringify(state), new Date(now.getTime() + 60_000), e.message.slice(0, 400), workerId]);
      await db.query("update social_posts set status = 'needs_reconciliation', failure_code = 'unknown_outcome', failure_message = $2 where id = $1 and org_id = $3 and status in ('scheduled', 'publishing')", [post.id, e.message.slice(0, 400), post.org_id]);
      await addEvent(db, post.org_id, post.id, "outcome_unknown", { kind: "system", id: null }, { attempt: job.attempt });
    });
    return "unknown";
  }
  // Every other kind is a definite answer: nothing was created by the step that failed, so the intent to send is withdrawn.
  const cleared: PublishState = { ...state };
  delete cleared.sendingAt;
  if (isRetryable(e.kind) && job.attempt < job.max_attempts) {
    await requeue(job.id, workerId, cleared, new Date(now.getTime() + retryDelayMs(job.attempt, e.retryAfterSec, (deps.jitter ?? Math.random)())), { kind: e.kind, message: e.message.slice(0, 400) }, false);
    await withSystem((db) => addEvent(db, post.org_id, post.id, "retry_scheduled", { kind: "system", id: null }, { attempt: job.attempt, kind: e.kind }));
    return "requeued";
  }
  if (e.kind === "blocked") {
    const until = new Date(now.getTime() + 24 * 3_600_000);
    await withSystem((db) => db.query("update social_accounts set rate_state = rate_state || $2::jsonb where id = $1", [account.id, JSON.stringify({ blockedUntil: until.toISOString() })]));
  }
  const code = e.kind === "rate_limited" || e.kind === "transient" ? "gave_up" : e.kind;
  await withSystem(async (db) => {
    await failJob(db, job, post, code, e.message, e.kind, now);
    if (e.needsReauth) await markAccountNeedsReauth(db, post.org_id, account.id, e.message, now);
  });
  return "failed";
}

// ---------------------------------------------------------------------------
// Checking what a lost answer did
// ---------------------------------------------------------------------------

/**
 * For every job whose outcome is unknown: asks the platform whether the post exists. Found: it is recorded as published (once). Not found and long enough since
 * sending: recorded as not posted, and the person may retry. Cannot be checked: tried again later, and after a day left for a person to decide.
 */
export async function reconcileUnknownJobs(deps: PublisherDeps & { orgId?: string | null } = {}): Promise<{ checked: number; published: number; notPosted: number }> {
  const now = clock(deps);
  const jobs = await withSystem(async (db) => (await db.query<JobRow>(`select ${JOB_COLUMNS} from social_publish_jobs where status = 'unknown' and run_at <= $1 and ($2::uuid is null or org_id = $2) order by run_at limit 25`, [now, deps.orgId ?? null])).rows);
  const out = { checked: 0, published: 0, notPosted: 0 };
  for (const job of jobs) {
    const post = await withSystem((db) => loadPostRow(db, job.org_id, job.post_id));
    const account = await withSystem((db) => loadAccountRow(db, job.org_id, job.account_id));
    if (!post || !account) continue;
    const sentAt = job.state.sendingAt ? new Date(job.state.sendingAt) : new Date(job.run_at);
    const creds = account.status === "connected" ? openCredentials(account.credentials) : null;
    const later = (ms: number, why: string) => withSystem((db) => db.query("update social_publish_jobs set run_at = $2, last_error = $3 where id = $1", [job.id, new Date(now.getTime() + ms), why.slice(0, 400)]));
    const giveUp = async () => {
      await withSystem(async (db) => {
        const msg = "The platform could not be asked whether this post went out. Look at the Page, then tell iAcquire whether it was posted.";
        await db.query("update social_publish_jobs set status = 'failed', finished_at = $2, last_error = $3 where id = $1", [job.id, now, msg]);
        await db.query("update social_posts set failure_code = 'unknown_outcome', failure_message = $2 where id = $1 and org_id = $3 and status = 'needs_reconciliation'", [post.id, msg, post.org_id]);
        await addEvent(db, post.org_id, post.id, "reconcile_gave_up", { kind: "system", id: null }, {});
        await notifyOrgRoles(db, post.org_id, ["owner", "admin"], { kind: "social_post_failed", severity: "warning", title: "A social post needs you to check the Page", body: msg, link: `/social/posts/${post.id}`, dedupeKey: `social-unknown:${post.id}:${post.version}` });
      });
    };
    if (!creds) {
      if (now.getTime() - sentAt.getTime() > RECONCILE_GIVE_UP_MS) await giveUp();
      else await later(3_600_000, "The account is not connected, so the post could not be checked yet.");
      continue;
    }
    out.checked += 1;
    try {
      const r = await prov(deps, account.adapter).reconcile(creds, { platform: account.platform, externalId: account.external_id, kind: post.kind, media: [], idempotencyKey: job.idempotency_key, ...(await inputFor(post, account)) }, job.state, sentAt);
      if (r.found && r.providerPostId) {
        const state: PublishState = { ...job.state, providerPostId: r.providerPostId, permalink: r.permalink ?? null, done: true };
        await withSystem((db) => succeedJob(db, job, post, state, now, "reconciled_published"));
        out.published += 1;
      } else if (now.getTime() - sentAt.getTime() >= RECONCILE_GRACE_MS) {
        await withSystem(async (db) => {
          const msg = "The platform confirmed this post was not published. You can try again.";
          await db.query("update social_publish_jobs set status = 'failed', finished_at = $2, last_error = $3, last_error_kind = 'unknown_outcome' where id = $1", [job.id, now, msg]);
          await db.query("update social_posts set status = 'failed', failure_code = 'confirmed_not_posted', failure_message = $2 where id = $1 and org_id = $3 and status = 'needs_reconciliation'", [post.id, msg, post.org_id]);
          await addEvent(db, post.org_id, post.id, "reconciled_not_posted", { kind: "system", id: null }, {});
        });
        out.notPosted += 1;
      } else {
        await later(5 * 60_000, "Not found yet; checking again shortly.");
      }
    } catch (e) {
      if (e instanceof ProviderError && e.needsReauth) await withSystem((db) => markAccountNeedsReauth(db, post.org_id, account.id, e.message, now));
      if (now.getTime() - sentAt.getTime() > RECONCILE_GIVE_UP_MS) await giveUp();
      else await later(30 * 60_000, e instanceof ProviderError ? e.message : "The platform could not be reached.");
    }
  }
  return out;
}

/** The request the platform was sent, rebuilt from the post, so a check can look for the same text. */
async function inputFor(post: PostRow, account: AccountRow): Promise<Pick<PublishInput, "message" | "linkUrl">> {
  const settings = await withSystem((db) => readSettings(db, post.org_id));
  const campaign = post.campaign_id ? (await withSystem((db) => db.query<{ utm_campaign: string }>("select utm_campaign from social_campaigns where id = $1 and org_id = $2", [post.campaign_id, post.org_id]))).rows[0]?.utm_campaign ?? null : null;
  return messageFor(post, account.platform, campaign, settings.trackingLinks);
}

// ---------------------------------------------------------------------------
// The scheduler's entry point
// ---------------------------------------------------------------------------

export interface TickResult {
  recovered: number;
  claimed: number;
  succeeded: number;
  failed: number;
  requeued: number;
  unknown: number;
  reconciled: number;
}

/** One pass of the publisher: take over dead workers' jobs, run what is due, check what is unknown. Safe to run from several workers at once. */
export async function processDueSocialPosts(deps: PublisherDeps & { limit?: number; /** Only this workspace's jobs (tests and per-tenant tooling); the scheduler passes none. */ orgId?: string | null } = {}): Promise<TickResult> {
  const workerId = deps.workerId ?? `w-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const live = (deps.liveEnabled ?? livePublishingEnabled)();
  const res: TickResult = { recovered: 0, claimed: 0, succeeded: 0, failed: 0, requeued: 0, unknown: 0, reconciled: 0 };
  res.recovered = await withSystem((db) => recoverExpiredLeases(db, clock(deps), deps.orgId ?? null));
  for (let i = 0; i < (deps.limit ?? 20); i++) {
    const job = await withSystem((db) => claimNext(db, workerId, clock(deps), live, deps.orgId ?? null));
    if (!job) break;
    res.claimed += 1;
    const o = await runClaimedJob(job, { ...deps, workerId });
    if (o === "succeeded") res.succeeded += 1;
    else if (o === "failed") res.failed += 1;
    else if (o === "requeued") res.requeued += 1;
    else if (o === "unknown") res.unknown += 1;
  }
  const r = await reconcileUnknownJobs(deps);
  res.reconciled = r.published + r.notPosted;
  return res;
}
