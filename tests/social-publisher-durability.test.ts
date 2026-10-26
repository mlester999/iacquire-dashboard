// What keeps the publisher honest when things go wrong around it: a worker that dies after the platform answered, a workspace that is stopped, an account the
// platform could not be reached to check, a file that cannot be fetched, a post that is hours late, and a pass that runs out of time. Embedded Postgres and the
// simulated platform: nothing is posted anywhere, and what these tests count is what the platform was asked to create.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { disconnectAccount } from "@/server/social/accounts";
import { cancelPost, retryPost } from "@/server/social/posts";
import { MISSED_WINDOW_MS, processDueSocialPosts, reconcileUnknownJobs, runClaimedJob, type JobRow } from "@/server/social/publisher";
import { ProviderError } from "@/server/social/providers/types";
import { simulated, simulatedProvider } from "@/server/social/providers/simulated";
import { createOrg } from "./support/fixtures";
import { addAsset, connect, LATER, MEDIA_URL, minutes, rows, scheduledPost, socialOrg, tick, type SocialOrg } from "./support/social";

const postRow = async (id: string) => (await rows<{ status: string; failure_code: string | null; failure_message: string | null; provider_post_id: string | null }>("select status, failure_code, failure_message, provider_post_id from social_posts where id = $1", [id]))[0];
const jobRow = async (postId: string) => (await rows<JobRow>("select * from social_publish_jobs where post_id = $1 order by created_at desc limit 1", [postId]))[0];
const failureNotes = (userId: string) => rows("select id from notifications where user_id = $1 and kind = 'social_post_failed'", [userId]);

describe("an answer that was saved is never sent again", () => {
  /** The platform made the post and answered, the worker saved the answer, and then it died before it could record the publication. */
  async function answeredButNotRecorded(status: "running" | "queued") {
    const s = await socialOrg();
    const acc = await connect(s);
    const asset = await addAsset(s);
    const post = await scheduledPost(s, acc.id, { kind: "image", mediaAssetIds: [asset] });
    const job = await jobRow(post.id);
    const sent = await simulatedProvider.step({ accessToken: "sim_valid" }, { platform: "facebook", externalId: acc.externalId, kind: "image", message: "x", linkUrl: null, media: [], idempotencyKey: job.idempotency_key }, {});
    const state = { sendingAt: LATER.toISOString(), ...sent.state };
    await withSystem(async (db) => {
      await db.query("update social_publish_jobs set status = $4, claimed_by = $5, attempt = 1, lease_until = $2, state = $3::jsonb where id = $1", [job.id, status === "running" ? minutes(LATER, -1) : null, JSON.stringify(state), status, status === "running" ? "dead-worker" : null]);
      await db.query("update social_posts set status = 'publishing' where id = $1", [post.id]);
    });
    return { s, acc, post, state };
  }

  it("records the publication when the worker died with the answer saved, and does not send a second post", async () => {
    const { s, acc, post, state } = await answeredButNotRecorded("running");
    expect(simulated.calls("send")).toBe(1);
    expect(await tick(s, minutes(LATER, 5), { mediaUrl: MEDIA_URL })).toMatchObject({ recovered: 1, claimed: 0 });
    expect(await postRow(post.id)).toMatchObject({ status: "published", provider_post_id: state.providerPostId });
    expect((await jobRow(post.id)).status).toBe("succeeded");
    expect(simulated.published(acc.externalId)).toHaveLength(1);
    expect(simulated.calls("send")).toBe(1);
    expect((await tick(s, minutes(LATER, 10), { mediaUrl: MEDIA_URL })).claimed).toBe(0);
  });

  it("finishes a queued job that already holds the answer instead of stepping it again", async () => {
    const { s, acc, post, state } = await answeredButNotRecorded("queued");
    expect(await tick(s, minutes(LATER, 5), { mediaUrl: MEDIA_URL })).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(await postRow(post.id)).toMatchObject({ status: "published", provider_post_id: state.providerPostId });
    expect(simulated.published(acc.externalId)).toHaveLength(1);
    expect(simulated.calls("send")).toBe(1);
  });

  it("keeps a person from cancelling the post, even when the queued job lost the note of when it was sent", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const { post, state } = await answerSaved(s, acc, "queued");
    await withSystem((db) => db.query("update social_publish_jobs set state = state - 'sendingAt' where post_id = $1", [post.id]));
    await expect(cancelPost(s.manager, post.id)).rejects.toThrow(/being sent or checked/);
    expect(await postRow(post.id)).toMatchObject({ status: "publishing" });
    expect((await jobRow(post.id)).status).toBe("queued");
    expect(await tick(s, minutes(LATER, 5))).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(await postRow(post.id)).toMatchObject({ status: "published", provider_post_id: state.providerPostId });
  });

  it("records the publication once when a slow worker and the one that took over its job both reach it", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const { post, state } = await answerSaved(s, acc, "running");
    const job = await jobRow(post.id);
    const first = await runClaimedJob(job, { now: () => LATER, workerId: "busy-worker" });
    const second = await runClaimedJob(job, { now: () => minutes(LATER, 3), workerId: "the-one-that-took-over" });
    expect([first, second]).toEqual(["succeeded", "succeeded"]);
    expect(await postRow(post.id)).toMatchObject({ status: "published", provider_post_id: state.providerPostId });
    expect(await rows("select 1 from social_post_events where post_id = $1 and kind = 'published'", [post.id])).toHaveLength(1);
    expect(await rows("select 1 from audit_logs where target_id = $1 and action = 'social.post_published'", [post.id])).toHaveLength(1);
    expect(simulated.published(acc.externalId)).toHaveLength(1);
  });

  it("finishes the record on the next pass when recording the publication failed once", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const asset = await addAsset(s);
    const post = await scheduledPost(s, acc.id, { kind: "image", mediaAssetIds: [asset] });
    // The first attempt to mark the post published fails inside the database, after the platform has already made the post. A sequence is not rolled back, so
    // it fails exactly once.
    await withSystem(async (db) => {
      await db.query("create sequence crash_once_seq");
      await db.query("create function crash_once() returns trigger language plpgsql as $$ begin if new.status = 'published' and nextval('crash_once_seq') = 1 then raise exception 'simulated failure while recording'; end if; return new; end $$");
      await db.query("create trigger crash_once before update on social_posts for each row execute function crash_once()");
    });
    try {
      expect(await tick(s, LATER, { mediaUrl: MEDIA_URL })).toMatchObject({ claimed: 1, succeeded: 0, requeued: 1 });
      expect(await postRow(post.id)).toMatchObject({ status: "publishing", provider_post_id: null });
      expect(await jobRow(post.id)).toMatchObject({ status: "queued", attempt: 0 }); // not stuck running, and the attempt is not used up
      expect(simulated.published(acc.externalId)).toHaveLength(1);
      expect(await tick(s, minutes(LATER, 1), { mediaUrl: MEDIA_URL })).toMatchObject({ claimed: 1, succeeded: 1 });
      expect((await postRow(post.id)).status).toBe("published");
      expect(simulated.published(acc.externalId)).toHaveLength(1);
      expect(simulated.calls("send")).toBe(1);
    } finally {
      await withSystem(async (db) => {
        await db.query("drop trigger crash_once on social_posts");
        await db.query("drop function crash_once()");
        await db.query("drop sequence crash_once_seq");
      });
    }
  });

  it("still checks, and does not resend, a request whose answer never arrived", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const asset = await addAsset(s);
    const post = await scheduledPost(s, acc.id, { kind: "image", mediaAssetIds: [asset] });
    simulated.loseResponseNext("send");
    expect(await tick(s, LATER, { mediaUrl: MEDIA_URL })).toMatchObject({ unknown: 1 });
    expect(await tick(s, minutes(LATER, 2), { mediaUrl: MEDIA_URL })).toMatchObject({ reconciled: 1 });
    expect((await postRow(post.id)).status).toBe("published");
    expect(simulated.calls("send")).toBe(1);
    expect(simulated.published(acc.externalId)).toHaveLength(1);
  });
});

describe("a stopped workspace publishes nothing", () => {
  const setStatus = (s: SocialOrg, status: string) => withSystem((db) => db.query("update organizations set status = $2 where id = $1", [s.m.org.id, status]));
  const setPause = (orgId: string, scope: string, active: boolean) => withSystem((db) => db.query("insert into automation_pauses (org_id, scope, active) values ($1, $2, $3) on conflict (org_id, scope) do update set active = excluded.active", [orgId, scope, active]));
  // An agency pause set on the agency's own workspace stops every client workspace, so it is lifted again as soon as a test is done with it.
  let agency: ReturnType<typeof createOrg> | null = null;
  const agencyOrgId = async () => (agency ??= createOrg({ kind: "agency", name: "Agency for the pause tests" })).then((o) => o.id);

  const stops: Array<{ name: string; stop: (s: SocialOrg) => Promise<unknown>; lift: (s: SocialOrg) => Promise<unknown> }> = [
    { name: "suspended", stop: (s) => setStatus(s, "suspended"), lift: (s) => setStatus(s, "active") },
    { name: "archived", stop: (s) => setStatus(s, "archived"), lift: (s) => setStatus(s, "active") },
    { name: "paused by iAcquire", stop: (s) => setPause(s.m.org.id, "agency", true), lift: (s) => setPause(s.m.org.id, "agency", false) },
    { name: "paused for outbound automation", stop: (s) => setPause(s.m.org.id, "outbound", true), lift: (s) => setPause(s.m.org.id, "outbound", false) },
    { name: "covered by an agency-wide pause", stop: async () => setPause(await agencyOrgId(), "agency", true), lift: async () => setPause(await agencyOrgId(), "agency", false) },
  ];

  for (const c of stops) {
    it(`leaves a due post queued while the workspace is ${c.name}, and publishes it when that is lifted`, async () => {
      const s = await socialOrg();
      const acc = await connect(s);
      const post = await scheduledPost(s, acc.id);
      await c.stop(s);
      try {
        expect(await tick(s, LATER)).toMatchObject({ claimed: 0, succeeded: 0 });
        expect(await tick(s, minutes(LATER, 30))).toMatchObject({ claimed: 0 });
        expect(await postRow(post.id)).toMatchObject({ status: "scheduled" }); // held, not failed
        expect(await jobRow(post.id)).toMatchObject({ status: "queued", attempt: 0 });
        expect(simulated.posts(acc.externalId)).toHaveLength(0);
      } finally {
        await c.lift(s);
      }
      expect(await tick(s, minutes(LATER, 31))).toMatchObject({ claimed: 1, succeeded: 1 });
      expect(simulated.published(acc.externalId)).toHaveLength(1);
    });
  }

  it("puts a job back, untouched, when the workspace is stopped after the job was claimed", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const post = await scheduledPost(s, acc.id);
    // The job was claimed (the workspace was fine then); the pause arrives before the first request to the platform.
    await withSystem((db) => db.query("update social_publish_jobs set status = 'running', claimed_by = 'test-worker', attempt = 1, lease_until = $2 where post_id = $1", [post.id, minutes(LATER, 2)]));
    await withSystem((db) => db.query("insert into automation_pauses (org_id, scope, active) values ($1, 'agency', true)", [s.m.org.id]));
    const outcome = await runClaimedJob(await jobRow(post.id), { now: () => LATER, workerId: "test-worker", jitter: () => 0 });
    expect(outcome).toBe("requeued");
    expect(await jobRow(post.id)).toMatchObject({ status: "queued", attempt: 0 });
    expect(await postRow(post.id)).toMatchObject({ status: "scheduled" });
    expect(simulated.posts(acc.externalId)).toHaveLength(0);
    expect(simulated.calls("create")).toBe(0);
  });

  it("does not send a held post late once the workspace is back: it goes to a person instead", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const post = await scheduledPost(s, acc.id);
    await setStatus(s, "suspended");
    const back = minutes(LATER, 8 * 60);
    expect(await tick(s, back)).toMatchObject({ claimed: 0 });
    await setStatus(s, "active");
    expect(await tick(s, back)).toMatchObject({ claimed: 1, failed: 1, succeeded: 0 });
    expect(await postRow(post.id)).toMatchObject({ status: "failed", failure_code: "missed_window" });
    expect(simulated.posts(acc.externalId)).toHaveLength(0);
  });
});

describe("a post that is hours late is not sent", () => {
  it("fails it for a person, with the reason and a notice, and a person can schedule it again", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const post = await scheduledPost(s, acc.id);
    const late = new Date(LATER.getTime() + MISSED_WINDOW_MS + 60_000);
    expect(await tick(s, late)).toMatchObject({ claimed: 1, failed: 1, succeeded: 0 });
    expect(await postRow(post.id)).toMatchObject({ status: "failed", failure_code: "missed_window" });
    expect((await postRow(post.id)).failure_message).toBe("This post was due more than 6 hours ago and was not sent, so nothing out of date goes out. Check it and schedule it again.");
    expect(simulated.posts(acc.externalId)).toHaveLength(0);
    expect(await failureNotes(s.m.people.owner.id)).toHaveLength(1);
    // A person's retry is a new time, so it goes out.
    await retryPost(s.manager, post.id, { now: late });
    expect(await tick(s, minutes(late, 1))).toMatchObject({ succeeded: 1 });
    expect(simulated.published(acc.externalId)).toHaveLength(1);
  });

  it("still sends a post that is only a little late", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    await scheduledPost(s, acc.id);
    expect(await tick(s, new Date(LATER.getTime() + MISSED_WINDOW_MS - 60_000))).toMatchObject({ succeeded: 1 });
    expect(simulated.published(acc.externalId)).toHaveLength(1);
  });

  it("keeps retrying a post that was already underway, however late the retry is", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const post = await scheduledPost(s, acc.id);
    simulated.failNext("create", new ProviderError("transient", "The platform had a temporary problem."));
    expect(await tick(s, LATER)).toMatchObject({ requeued: 1 });
    expect(await tick(s, new Date(LATER.getTime() + MISSED_WINDOW_MS * 2))).toMatchObject({ claimed: 1, succeeded: 1 });
    expect((await postRow(post.id)).status).toBe("published");
  });
});

describe("an account the platform could not be reached to check", () => {
  const setAccount = (id: string, status: string) => withSystem((db) => db.query("update social_accounts set status = $2 where id = $1", [id, status]));

  it("does not fail a due post: it waits, and publishes once the account checks out", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const post = await scheduledPost(s, acc.id);
    await setAccount(acc.id, "error");
    expect(await tick(s, LATER)).toMatchObject({ claimed: 1, requeued: 1, failed: 0 });
    expect(await postRow(post.id)).toMatchObject({ status: "scheduled" });
    expect(await jobRow(post.id)).toMatchObject({ status: "queued", attempt: 1, last_error_kind: "transient" });
    expect(simulated.posts(acc.externalId)).toHaveLength(0);
    await setAccount(acc.id, "connected");
    expect(await tick(s, minutes(LATER, 5))).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(simulated.published(acc.externalId)).toHaveLength(1);
  });

  it("fails it plainly, without telling anyone to reconnect, when the account never checks out", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const post = await scheduledPost(s, acc.id);
    await setAccount(acc.id, "error");
    let t = LATER;
    for (let i = 0; i < 5; i++) {
      await tick(s, t);
      t = minutes(t, 20 * 60);
    }
    expect(await postRow(post.id)).toMatchObject({ status: "failed", failure_code: "gave_up" });
    expect((await postRow(post.id)).failure_message).not.toMatch(/reconnect/i);
    expect((await jobRow(post.id)).status).toBe("failed");
    expect(await failureNotes(s.m.people.owner.id)).toHaveLength(1);
    expect(simulated.posts(acc.externalId)).toHaveLength(0);
  });

  it("still fails at once for an account whose sign-in is gone", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const post = await scheduledPost(s, acc.id);
    await setAccount(acc.id, "needs_reauth");
    expect(await tick(s, LATER)).toMatchObject({ claimed: 1, failed: 1 });
    expect(await postRow(post.id)).toMatchObject({ status: "failed", failure_code: "account_unavailable" });
  });
});

describe("an account that cannot publish", () => {
  it("holds the account's other posts while the platform has it blocked, and does not send them stale afterwards", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const first = await scheduledPost(s, acc.id, { caption: "First" });
    const second = await scheduledPost(s, acc.id, { caption: "Second" }, minutes(LATER, 60));
    simulated.failNext("create", new ProviderError("blocked", "The platform has temporarily blocked this account from posting."));
    expect(await tick(s, LATER)).toMatchObject({ claimed: 1, failed: 1 });
    expect(await postRow(first.id)).toMatchObject({ status: "failed", failure_code: "blocked" });
    // The next post waits for the block to end, untouched and still scheduled.
    expect(await tick(s, minutes(LATER, 61))).toMatchObject({ claimed: 1, requeued: 1, failed: 0 });
    expect(new Date((await jobRow(second.id)).run_at).getTime()).toBe(minutes(LATER, 24 * 60).getTime());
    expect(await postRow(second.id)).toMatchObject({ status: "scheduled" });
    expect(simulated.published(acc.externalId)).toHaveLength(0);
    // When the block ends it is a day late: it is not sent, a person decides.
    expect(await tick(s, minutes(LATER, 25 * 60))).toMatchObject({ claimed: 1, failed: 1 });
    expect(await postRow(second.id)).toMatchObject({ status: "failed", failure_code: "missed_window" });
    expect(simulated.published(acc.externalId)).toHaveLength(0);
  });

  it("fails a post and asks for a reconnect when the saved sign-in can no longer be opened", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const post = await scheduledPost(s, acc.id);
    await withSystem((db) => db.query("update social_accounts set credentials = null where id = $1", [acc.id]));
    expect(await tick(s, LATER)).toMatchObject({ claimed: 1, failed: 1 });
    expect(await postRow(post.id)).toMatchObject({ status: "failed", failure_code: "auth" });
    expect((await rows<{ status: string }>("select status from social_accounts where id = $1", [acc.id]))[0].status).toBe("needs_reauth");
    expect(simulated.posts(acc.externalId)).toHaveLength(0);
  });
});

describe("a problem outside the platform's answers cannot strand a job", () => {
  async function pictureAt() {
    const s = await socialOrg();
    const acc = await connect(s);
    const asset = await addAsset(s);
    const post = await scheduledPost(s, acc.id, { kind: "image", mediaAssetIds: [asset] });
    return { s, acc, asset, post };
  }

  it("fails the post, not the whole pass, when a picture's stored file is gone", async () => {
    const { s, acc, asset, post } = await pictureAt();
    // The asset still says ready, but its stored file was removed: the real signer finds no file.
    await withSystem((db) => db.query("update private_files set status = 'deleted' where id = (select private_file_id from social_media_assets where id = $1)", [asset]));
    expect(await tick(s, LATER)).toMatchObject({ claimed: 1, failed: 1 });
    expect(await postRow(post.id)).toMatchObject({ status: "failed", failure_code: "media_unavailable" });
    expect((await jobRow(post.id)).status).toBe("failed");
    expect(simulated.posts(acc.externalId)).toHaveLength(0);
    expect((await rows("select 1 from social_publish_jobs where status = 'running'")).length).toBe(0);
  });

  it("tries again when storage does not answer, counts the attempt, and gives up plainly", async () => {
    const { s, acc, post } = await pictureAt();
    const down = async () => {
      throw new AppError("integration_unavailable", "Private storage could not create a link for the platform.");
    };
    expect(await tick(s, LATER, { mediaUrl: down })).toMatchObject({ claimed: 1, requeued: 1, failed: 0 });
    expect(await jobRow(post.id)).toMatchObject({ status: "queued", attempt: 1 });
    expect(await postRow(post.id)).toMatchObject({ status: "scheduled" });
    // Storage comes back.
    expect(await tick(s, minutes(LATER, 5), { mediaUrl: MEDIA_URL })).toMatchObject({ succeeded: 1 });
    expect(simulated.published(acc.externalId)).toHaveLength(1);

    const again = await pictureAt();
    let t = LATER;
    for (let i = 0; i < 5; i++) {
      await tick(again.s, t, { mediaUrl: down });
      t = minutes(t, 20 * 60);
    }
    expect(await postRow(again.post.id)).toMatchObject({ status: "failed", failure_code: "gave_up" });
    expect((await jobRow(again.post.id)).status).toBe("failed");
  });

  it("fails a job whose workers keep dying before anything is sent, instead of starting it again for ever", async () => {
    const { s, acc, post } = await pictureAt();
    await withSystem(async (db) => {
      await db.query("update social_publish_jobs set status = 'running', claimed_by = 'dead-worker', attempt = max_attempts, lease_until = $2 where post_id = $1", [post.id, minutes(LATER, -1)]);
      await db.query("update social_posts set status = 'publishing' where id = $1", [post.id]);
    });
    expect(await tick(s, minutes(LATER, 5), { mediaUrl: MEDIA_URL })).toMatchObject({ recovered: 1, claimed: 0 });
    expect(await postRow(post.id)).toMatchObject({ status: "failed", failure_code: "gave_up" });
    expect((await jobRow(post.id)).status).toBe("failed");
    expect(await failureNotes(s.m.people.owner.id)).toHaveLength(1);
    expect(simulated.posts(acc.externalId)).toHaveLength(0);
  });

  it("puts a job back where it can be tried again when something unexpected throws", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const post = await scheduledPost(s, acc.id);
    const broken = () => {
      throw new Error("an unexpected failure");
    };
    expect(await tick(s, LATER, { provider: broken })).toMatchObject({ claimed: 1, requeued: 1 });
    expect(await jobRow(post.id)).toMatchObject({ status: "queued", attempt: 1 });
    expect(await postRow(post.id)).toMatchObject({ status: "scheduled" });
    expect(await tick(s, minutes(LATER, 5))).toMatchObject({ succeeded: 1 });
    expect(simulated.published(acc.externalId)).toHaveLength(1);
  });
});

describe("one pass does not run past its time budget", () => {
  it("stops taking new work when the budget is spent, and the work waits for the next pass", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const post = await scheduledPost(s, acc.id);
    const spent = await processDueSocialPosts({ now: () => LATER, jitter: () => 0, liveEnabled: () => false, workerId: "test-worker", orgId: s.m.org.id, budgetMs: 0 });
    expect(spent.claimed).toBe(0);
    expect(await jobRow(post.id)).toMatchObject({ status: "queued" });
    expect(await tick(s, LATER)).toMatchObject({ claimed: 1, succeeded: 1 });
  });

  it("stops checking unknown outcomes when the budget is spent, and the checks wait", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const asset = await addAsset(s);
    const post = await scheduledPost(s, acc.id, { kind: "image", mediaAssetIds: [asset] });
    simulated.loseResponseNext("send");
    expect(await tick(s, LATER, { mediaUrl: MEDIA_URL })).toMatchObject({ unknown: 1 });
    const deps = { now: () => minutes(LATER, 2), jitter: () => 0, orgId: s.m.org.id };
    expect(await reconcileUnknownJobs({ ...deps, budgetMs: 0 })).toMatchObject({ checked: 0, published: 0 });
    expect((await postRow(post.id)).status).toBe("needs_reconciliation");
    expect(await reconcileUnknownJobs(deps)).toMatchObject({ checked: 1, published: 1 });
    expect((await postRow(post.id)).status).toBe("published");
  });
});

/** A text post the platform has already made and answered for, with the answer saved on its job; only the record that it is published is still to be made. */
async function answerSaved(s: SocialOrg, acc: { id: string; externalId: string }, status: "running" | "queued", caption = "Spring tune-up special: book this week.") {
  const post = await scheduledPost(s, acc.id, { caption });
  const job = await jobRow(post.id);
  // A text post is made in two requests (an unpublished post, then publishing it); the answer is there after the second.
  const input = { platform: "facebook" as const, externalId: acc.externalId, kind: "text" as const, message: caption, linkUrl: null, media: [], idempotencyKey: job.idempotency_key };
  const first = await simulatedProvider.step({ accessToken: "sim_valid" }, input, {});
  const sent = await simulatedProvider.step({ accessToken: "sim_valid" }, input, first.state);
  const state = { sendingAt: LATER.toISOString(), ...sent.state };
  expect(state.providerPostId).toBeTruthy();
  await withSystem(async (db) => {
    await db.query("update social_publish_jobs set status = $4, claimed_by = $5, attempt = 1, lease_until = $2, state = $3::jsonb where id = $1", [job.id, status === "running" ? minutes(LATER, 1) : null, JSON.stringify(state), status, status === "running" ? "busy-worker" : null]);
    await db.query("update social_posts set status = 'publishing' where id = $1", [post.id]);
  });
  return { post, state };
}

describe("an account that is disconnected while the platform's answer is saved but not yet recorded", () => {
  const answered = async (status: "running" | "queued") => {
    const s = await socialOrg();
    const acc = await connect(s);
    return { s, acc, ...(await answerSaved(s, acc, status)) };
  };

  it("does not fail or cancel a post that is already live, and the publisher records it as published", async () => {
    const { s, acc, post, state } = await answered("running");
    expect((await disconnectAccount(s.owner, acc.id)).stopped).toBe(0);
    expect(await postRow(post.id)).toMatchObject({ status: "publishing", failure_code: null });
    expect((await jobRow(post.id)).status).toBe("running");
    expect(await tick(s, minutes(LATER, 5))).toMatchObject({ recovered: 1, claimed: 0 });
    expect(await postRow(post.id)).toMatchObject({ status: "published", provider_post_id: state.providerPostId, failure_code: null });
    expect((await jobRow(post.id)).status).toBe("succeeded");
    expect(simulated.published(acc.externalId)).toHaveLength(1);
  });

  it("does the same for a job that was put back in the queue with its answer", async () => {
    const { s, acc, post, state } = await answered("queued");
    expect((await disconnectAccount(s.owner, acc.id)).stopped).toBe(0);
    expect((await jobRow(post.id)).status).toBe("queued");
    expect(await tick(s, minutes(LATER, 5))).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(await postRow(post.id)).toMatchObject({ status: "published", provider_post_id: state.providerPostId });
    expect(simulated.published(acc.externalId)).toHaveLength(1);
  });

  it("records it even while the workspace is stopped, because recording sends nothing", async () => {
    const { s, acc, post, state } = await answered("queued");
    await disconnectAccount(s.owner, acc.id);
    await withSystem((db) => db.query("insert into automation_pauses (org_id, scope, active) values ($1, 'agency', true)", [s.m.org.id]));
    await withSystem((db) => db.query("update organizations set status = 'suspended' where id = $1", [s.m.org.id]));
    expect(await tick(s, minutes(LATER, 5))).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(await postRow(post.id)).toMatchObject({ status: "published", provider_post_id: state.providerPostId, failure_code: null });
    expect((await jobRow(post.id)).status).toBe("succeeded");
    expect(simulated.published(acc.externalId)).toHaveLength(1); // the one the platform made before the worker was lost, and no second
  });

  it("records it for a real account while publishing to real accounts is switched off, and an unanswered job still waits", async () => {
    const { s, acc, post, state } = await answered("queued");
    const waiting = await scheduledPost(s, acc.id, { caption: "Not sent yet" }, minutes(LATER, 1));
    await withSystem((db) => db.query("update social_accounts set adapter = 'meta' where id = $1", [acc.id]));
    expect(await tick(s, minutes(LATER, 5))).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(await postRow(post.id)).toMatchObject({ status: "published", provider_post_id: state.providerPostId });
    expect(await postRow(waiting.id)).toMatchObject({ status: "scheduled" });
    expect((await jobRow(waiting.id)).status).toBe("queued");
  });
});

describe("one lost job that cannot be put right does not stop the rest of the pass", () => {
  it("takes over the other lost jobs and publishes what is due, and tries the stuck one again next time", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const stuck = await answerSaved(s, acc, "running", "The one that cannot be recorded");
    const fine = await answerSaved(s, acc, "running", "The one that can");
    const due = await scheduledPost(s, acc.id, { caption: "Due a little later" }, minutes(LATER, 2));
    // The database refuses to record the first one as published, as it would for any row it cannot write.
    await withSystem(async (db) => {
      await db.query(`create function refuse_one_post() returns trigger language plpgsql as $$ begin if new.status = 'published' and new.id = '${stuck.post.id}' then raise exception 'simulated refusal'; end if; return new; end $$`);
      await db.query("create trigger refuse_one_post before update on social_posts for each row execute function refuse_one_post()");
    });
    const lift = () => withSystem(async (db) => {
      await db.query("drop trigger refuse_one_post on social_posts");
      await db.query("drop function refuse_one_post()");
    });
    try {
      expect(await tick(s, minutes(LATER, 5))).toMatchObject({ recovered: 2, claimed: 1, succeeded: 1 });
      expect(await postRow(fine.post.id)).toMatchObject({ status: "published", provider_post_id: fine.state.providerPostId });
      expect(await postRow(due.id)).toMatchObject({ status: "published" });
      expect(await postRow(stuck.post.id)).toMatchObject({ status: "publishing" });
      expect((await jobRow(stuck.post.id)).status).toBe("running");
    } finally {
      await lift();
    }
    // The refusal is gone: the next pass finishes it, and nothing was sent a second time.
    expect(await tick(s, minutes(LATER, 10))).toMatchObject({ recovered: 1 });
    expect(await postRow(stuck.post.id)).toMatchObject({ status: "published", provider_post_id: stuck.state.providerPostId });
    expect(simulated.published(acc.externalId)).toHaveLength(3);
  });
});
