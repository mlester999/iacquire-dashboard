// The publisher on embedded Postgres with the simulated platform: once-only publication, retries, lost answers, a worker that dies, revocation, cancellation.
// The simulated platform posts nothing anywhere. What these tests count is what it was asked to create.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { sealCredentials } from "@/server/social/credentials";
import { revokeByProviderUser } from "@/server/social/accounts";
import { cancelPost, createPost, resolveUnknown, retryPost, schedulePost, submitForApproval, decide } from "@/server/social/posts";
import { recoverExpiredLeases, RECONCILE_GRACE_MS } from "@/server/social/publisher";
import { ProviderError } from "@/server/social/providers/types";
import { simulated } from "@/server/social/providers/simulated";
import { simulatedProvider } from "@/server/social/providers/simulated";
import { addAsset, approvedPost, connect, LATER, MEDIA_URL, minutes, NOW, rows, scheduledPost, socialOrg, textPost, tick } from "./support/social";

const postRow = async (id: string) => (await rows<{ status: string; failure_code: string | null; provider_post_id: string | null; version: number }>("select status, failure_code, provider_post_id, version from social_posts where id = $1", [id]))[0];
const jobRows = (postId: string) => rows<{ id: string; status: string; attempt: number; state: Record<string, unknown>; run_at: Date; last_error_kind: string | null }>("select id, status, attempt, state, run_at, last_error_kind from social_publish_jobs where post_id = $1 order by created_at", [postId]);
const eventKinds = async (postId: string) => (await rows<{ kind: string }>("select kind from social_post_events where post_id = $1 order by id", [postId])).map((r) => r.kind);

describe("publishing once, at the right time", () => {
  it("publishes a scheduled post at its time, exactly once, and records the history", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const post = await scheduledPost(s, acc.id);
    expect((await tick(s, minutes(NOW, 30))).claimed).toBe(0); // not yet
    expect(simulated.posts(acc.externalId)).toHaveLength(0);
    expect(await tick(s, LATER)).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    expect(await postRow(post.id)).toMatchObject({ status: "published" });
    expect(simulated.published(acc.externalId)).toHaveLength(1);
    expect((await tick(s, minutes(LATER, 5))).claimed).toBe(0); // nothing left to do
    expect(await eventKinds(post.id)).toEqual(expect.arrayContaining(["created", "submitted", "approved", "scheduled", "publish_started", "published"]));
    const audit = await rows("select action from audit_logs where org_id = $1 and action in ('social.post_approved', 'social.post_scheduled', 'social.post_published') order by created_at", [s.m.org.id]);
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["social.post_approved", "social.post_scheduled", "social.post_published"]));
  });

  it("does not publish twice when two workers run at the same moment", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    await scheduledPost(s, acc.id);
    const [a, b] = await Promise.all([tick(s, LATER, { workerId: "worker-a" }), tick(s, LATER, { workerId: "worker-b" })]);
    expect(a.claimed + b.claimed).toBe(1);
    expect(simulated.published(acc.externalId)).toHaveLength(1);
  });

  it("scheduling the same post for the same time twice makes one job", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const p = await approvedPost(s, acc.id);
    await schedulePost(s.manager, p.id, { at: LATER }, { now: NOW });
    await schedulePost(s.manager, p.id, { at: LATER }, { now: NOW });
    expect(await jobRows(p.id)).toHaveLength(1);
  });

  it("publishes a picture post with the file's address, once", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const asset = await addAsset(s);
    const p = await scheduledPost(s, acc.id, { kind: "image", mediaAssetIds: [asset] });
    expect(await tick(s, LATER, { mediaUrl: MEDIA_URL })).toMatchObject({ succeeded: 1 });
    expect(simulated.published(acc.externalId)).toHaveLength(1);
    expect((await postRow(p.id)).status).toBe("published");
  });
});

describe("retries never duplicate", () => {
  it("resumes a half-finished post after a temporary failure instead of creating another", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const post = await scheduledPost(s, acc.id);
    simulated.failNext("publish", new ProviderError("transient", "The platform had a temporary problem."));
    expect(await tick(s, LATER)).toMatchObject({ claimed: 1, requeued: 1, succeeded: 0 });
    expect((await postRow(post.id)).status).toBe("publishing");
    expect(simulated.posts(acc.externalId)).toHaveLength(1); // the prepared object, still unpublished
    expect(simulated.published(acc.externalId)).toHaveLength(0);
    expect((await tick(s, minutes(LATER, 0.5))).claimed).toBe(0); // backing off for a minute
    expect(await tick(s, minutes(LATER, 2))).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(simulated.posts(acc.externalId)).toHaveLength(1); // the same object, now published
    expect(simulated.published(acc.externalId)).toHaveLength(1);
    expect((await jobRows(post.id))[0]).toMatchObject({ status: "succeeded", attempt: 2 });
  });

  it("waits out a rate limit for as long as the platform asked", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    await scheduledPost(s, acc.id);
    simulated.failNext("create", new ProviderError("rate_limited", "Slow down.", { retryAfterSec: 1800 }));
    expect(await tick(s, LATER)).toMatchObject({ requeued: 1 });
    expect((await tick(s, minutes(LATER, 20))).claimed).toBe(0);
    expect(await tick(s, minutes(LATER, 31))).toMatchObject({ succeeded: 1 });
    expect(simulated.published(acc.externalId)).toHaveLength(1);
  });

  it("gives up after the allowed attempts and says why", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const post = await scheduledPost(s, acc.id);
    for (let i = 0; i < 5; i++) simulated.failNext("create", new ProviderError("transient", "Temporary."));
    let t = LATER;
    for (let i = 0; i < 5; i++) {
      await tick(s, t);
      t = minutes(t, 20 * 60); // far past any backoff
    }
    expect(await postRow(post.id)).toMatchObject({ status: "failed", failure_code: "gave_up" });
    expect(simulated.posts(acc.externalId)).toHaveLength(0);
    expect((await tick(s, minutes(t, 60))).claimed).toBe(0);
  });

  it("does not retry a post the platform refused, and tells the owner", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const post = await scheduledPost(s, acc.id);
    simulated.failNext("create", new ProviderError("invalid_content", "The platform refused this post."));
    expect(await tick(s, LATER)).toMatchObject({ failed: 1, requeued: 0 });
    expect(await postRow(post.id)).toMatchObject({ status: "failed", failure_code: "invalid_content" });
    const n = await rows("select kind from notifications where org_id = $1 and kind = 'social_post_failed'", [s.m.org.id]);
    expect(n.length).toBeGreaterThan(0);
    // The person can retry once they have fixed it; the retry is a new job, and only one can be live.
    const again = await retryPost(s.manager, post.id, { now: minutes(LATER, 10) });
    expect(again.status).toBe("scheduled");
    await expect(retryPost(s.manager, post.id, { now: minutes(LATER, 10) })).rejects.toThrow(/Only a failed post/);
  });
});

describe("when the platform's answer is lost", () => {
  it("checks instead of resending, and records the post once when it is found", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const asset = await addAsset(s);
    const post = await scheduledPost(s, acc.id, { kind: "image", mediaAssetIds: [asset] });
    simulated.loseResponseNext("send"); // the platform makes the post, then never answers
    expect(await tick(s, LATER, { mediaUrl: MEDIA_URL })).toMatchObject({ unknown: 1, succeeded: 0 });
    expect((await postRow(post.id)).status).toBe("needs_reconciliation");
    expect(simulated.published(acc.externalId)).toHaveLength(1);
    // The check runs on the next pass. Nothing is sent again.
    expect(await tick(s, minutes(LATER, 2), { mediaUrl: MEDIA_URL })).toMatchObject({ reconciled: 1 });
    expect(await postRow(post.id)).toMatchObject({ status: "published" });
    expect(simulated.posts(acc.externalId)).toHaveLength(1);
    expect(await eventKinds(post.id)).toEqual(expect.arrayContaining(["outcome_unknown", "reconciled_published"]));
  });

  it("only believes 'not found' after the platform has had time, then lets a person retry", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const asset = await addAsset(s);
    const post = await scheduledPost(s, acc.id, { kind: "image", mediaAssetIds: [asset] });
    simulated.failNext("send", new ProviderError("unknown_outcome", "No answer.")); // nothing was made
    expect(await tick(s, LATER, { mediaUrl: MEDIA_URL })).toMatchObject({ unknown: 1 });
    // Too early to believe the platform's "not found": it is checked again, still not failed.
    await tick(s, minutes(LATER, 2), { mediaUrl: MEDIA_URL });
    expect((await postRow(post.id)).status).toBe("needs_reconciliation");
    // A person cannot retry it while it is being checked.
    await expect(retryPost(s.manager, post.id)).rejects.toThrow(/Only a failed post/);
    // After the grace period it is confirmed not posted, and retry is offered.
    const late = new Date(LATER.getTime() + RECONCILE_GRACE_MS + 6 * 60_000);
    expect(await tick(s, late, { mediaUrl: MEDIA_URL })).toMatchObject({ reconciled: 1 });
    expect(await postRow(post.id)).toMatchObject({ status: "failed", failure_code: "confirmed_not_posted" });
    await retryPost(s.manager, post.id, { now: late });
    expect(await tick(s, minutes(late, 1), { mediaUrl: MEDIA_URL })).toMatchObject({ succeeded: 1 });
    expect(simulated.published(acc.externalId)).toHaveLength(1);
  });

  it("lets a person settle it by looking at the Page", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const asset = await addAsset(s);
    const post = await scheduledPost(s, acc.id, { kind: "image", mediaAssetIds: [asset] });
    simulated.loseResponseNext("send");
    await tick(s, LATER, { mediaUrl: MEDIA_URL });
    await expect(resolveUnknown(s.sales, post.id, { outcome: "posted" })).rejects.toThrow(/Your role/); // a sales rep cannot
    const done = await resolveUnknown(s.manager, post.id, { outcome: "posted", permalink: "https://example.test/p/1" });
    expect(done.status).toBe("published");
    expect(done.permalink).toBe("https://example.test/p/1");
    expect((await tick(s, minutes(LATER, 30), { mediaUrl: MEDIA_URL })).claimed).toBe(0);
    expect(simulated.published(acc.externalId)).toHaveLength(1);
  });
});

describe("a worker that dies", () => {
  async function stuck(withSendIntent: boolean) {
    const s = await socialOrg();
    const acc = await connect(s);
    const asset = await addAsset(s);
    const post = await scheduledPost(s, acc.id, { kind: "image", mediaAssetIds: [asset] });
    const job = (await jobRows(post.id))[0];
    const state = withSendIntent ? { sendingAt: LATER.toISOString() } : {};
    await withSystem(async (db) => {
      await db.query("update social_publish_jobs set status = 'running', claimed_by = 'dead-worker', attempt = 1, lease_until = $2, state = $3::jsonb where id = $1", [job.id, minutes(LATER, -1), JSON.stringify(state)]);
      await db.query("update social_posts set status = 'publishing' where id = $1", [post.id]);
    });
    return { s, acc, post, job, asset };
  }

  it("resumes a job that had not started sending", async () => {
    const { s, acc, post } = await stuck(false);
    expect(await tick(s, minutes(LATER, 5), { mediaUrl: MEDIA_URL })).toMatchObject({ recovered: 1, succeeded: 1 });
    expect((await postRow(post.id)).status).toBe("published");
    expect(simulated.published(acc.externalId)).toHaveLength(1);
  });

  it("checks, rather than resends, a job that may already have sent", async () => {
    const { s, acc, post, job } = await stuck(true);
    // The platform did make the post before the worker died.
    await simulatedProvider.step({ accessToken: "sim_valid" }, { platform: "facebook", externalId: acc.externalId, kind: "image", message: "x", linkUrl: null, media: [], idempotencyKey: (await rows<{ idempotency_key: string }>("select idempotency_key from social_publish_jobs where id = $1", [job.id]))[0].idempotency_key }, {});
    expect(await tick(s, minutes(LATER, 5), { mediaUrl: MEDIA_URL })).toMatchObject({ recovered: 1, succeeded: 0 });
    expect((await postRow(post.id)).status).toBe("needs_reconciliation");
    expect(await tick(s, minutes(LATER, 8), { mediaUrl: MEDIA_URL })).toMatchObject({ reconciled: 1 });
    expect((await postRow(post.id)).status).toBe("published");
    expect(simulated.posts(acc.externalId)).toHaveLength(1); // never a second one
  });

  it("is safe to run the recovery twice", async () => {
    const { post } = await stuck(false);
    await withSystem((db) => recoverExpiredLeases(db, minutes(LATER, 5)));
    await withSystem((db) => recoverExpiredLeases(db, minutes(LATER, 5)));
    expect((await jobRows(post.id))).toHaveLength(1);
  });
});

describe("accounts that stop working", () => {
  it("stops the account's other waiting posts when the platform refuses its sign-in", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const first = await scheduledPost(s, acc.id, { caption: "First" });
    const second = await scheduledPost(s, acc.id, { caption: "Second" }, minutes(LATER, 60));
    simulated.failNext("create", new ProviderError("auth", "Reconnect.", { needsReauth: true }));
    await tick(s, LATER);
    expect(await postRow(first.id)).toMatchObject({ status: "failed", failure_code: "auth" });
    expect(await postRow(second.id)).toMatchObject({ status: "failed", failure_code: "account_unavailable" });
    const [a] = await rows<{ status: string }>("select status from social_accounts where id = $1", [acc.id]);
    expect(a.status).toBe("needs_reauth");
    expect((await tick(s, minutes(LATER, 120))).claimed).toBe(0);
    expect(simulated.published(acc.externalId)).toHaveLength(0);
    await expect(retryPost(s.manager, second.id, { now: minutes(LATER, 130) })).rejects.toThrow(/reconnected/);
  });

  it("stops publishing the moment the platform reports the app was removed", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    await withSystem((db) => db.query("update social_accounts set provider_user_id = 'fb-user-1' where id = $1", [acc.id]));
    const post = await scheduledPost(s, acc.id);
    expect(await revokeByProviderUser("fb-user-1", "deauthorized")).toBe(1);
    const [a] = await rows<{ status: string; credentials: string | null }>("select status, credentials from social_accounts where id = $1", [acc.id]);
    expect(a).toMatchObject({ status: "revoked", credentials: null });
    expect(await postRow(post.id)).toMatchObject({ status: "failed", failure_code: "account_unavailable" });
    expect((await tick(s, LATER)).claimed).toBe(0);
    expect(simulated.posts(acc.externalId)).toHaveLength(0);
    const n = await rows("select kind from notifications where org_id = $1 and kind = 'social_account_attention'", [s.m.org.id]);
    expect(n.length).toBeGreaterThan(0);
  });

  it("does not claim a real account's job while live publishing is off, and publishes it when it is on", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    await withSystem((db) => db.query("update social_accounts set adapter = 'meta', credentials = $2 where id = $1", [acc.id, sealCredentials({ accessToken: "real-looking-token" })]));
    const post = await scheduledPost(s, acc.id);
    expect((await tick(s, LATER, { liveEnabled: () => false, provider: () => simulatedProvider })).claimed).toBe(0);
    expect((await postRow(post.id)).status).toBe("scheduled"); // waiting, not failed
    expect(await tick(s, minutes(LATER, 1), { liveEnabled: () => true, provider: () => simulatedProvider })).toMatchObject({ succeeded: 1 });
  });
});

describe("stopping a post safely", () => {
  it("cancels a scheduled post and its job, and nothing is ever sent", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const post = await scheduledPost(s, acc.id);
    const cancelled = await cancelPost(s.manager, post.id);
    expect(cancelled.status).toBe("cancelled");
    expect((await jobRows(post.id))[0].status).toBe("cancelled");
    expect((await tick(s, LATER)).claimed).toBe(0);
    expect(simulated.posts(acc.externalId)).toHaveLength(0);
  });

  it("refuses to cancel a post a worker is sending, rather than pretend", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const post = await scheduledPost(s, acc.id);
    await withSystem(async (db) => {
      await db.query("update social_publish_jobs set status = 'running', claimed_by = 'w', lease_until = $2 where post_id = $1", [post.id, minutes(LATER, 5)]);
      await db.query("update social_posts set status = 'publishing' where id = $1", [post.id]);
    });
    await expect(cancelPost(s.manager, post.id)).rejects.toThrow(/being sent or checked/);
  });

  it("stands a job down when the post moved on after it was queued", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const post = await scheduledPost(s, acc.id);
    // A change that bypassed the normal path (for example a restore) leaves the job for an older version.
    await withSystem((db) => db.query("update social_posts set version = version + 1 where id = $1", [post.id]));
    expect(await tick(s, LATER)).toMatchObject({ claimed: 1, succeeded: 0 });
    expect(simulated.posts(acc.externalId)).toHaveLength(0);
    expect((await jobRows(post.id))[0].status).toBe("cancelled");
  });

  it("does not publish a version that was approved before it was changed", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const post = await scheduledPost(s, acc.id);
    // Even if the edit path were bypassed, so the post and its job both name a version nobody approved, the approval check holds.
    await withSystem(async (db) => {
      await db.query("update social_posts set version = version + 1 where id = $1", [post.id]);
      await db.query("update social_publish_jobs set post_version = post_version + 1 where post_id = $1", [post.id]);
    });
    expect(await tick(s, LATER)).toMatchObject({ claimed: 1, failed: 1 });
    expect(await postRow(post.id)).toMatchObject({ status: "failed", failure_code: "approval_stale" });
    expect(simulated.posts(acc.externalId)).toHaveLength(0);
  });
});

describe("what an unapproved post cannot do", () => {
  it("cannot be scheduled by going around the approval", async () => {
    const s = await socialOrg();
    const acc = await connect(s);
    const draft = await createPost(s.sales, textPost(acc.id));
    await expect(schedulePost(s.manager, draft.id, { at: LATER }, { now: NOW })).rejects.toThrow(/approved/);
    const pending = await submitForApproval(s.sales, draft.id);
    await expect(schedulePost(s.manager, pending.id, { at: LATER }, { now: NOW })).rejects.toThrow(/approved/);
    expect((await tick(s, LATER)).claimed).toBe(0);
    // And approving a version that is no longer the current one is refused.
    await expect(decide(s.manager, pending.id, { decision: "approve", version: pending.version + 1 })).rejects.toThrow(/changed while you were reviewing/);
  });
});
