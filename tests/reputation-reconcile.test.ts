// Two things about replies whose result is unknown and about reading a review site on the scheduler's clock. (1) The notice that tells the owner and managers to look at the review
// site themselves after a whole day must not depend on the site being able to answer: a site that is down, a sign-in that cannot be opened and a connection a person ended all leave
// a reply "checking" for good unless the day-clock runs without the read. (2) A site that never answers must cost a pass its time budget, not the whole scheduler tick. The review site
// is the in-process simulated one or a stand-in written here; nothing reaches a real service.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { simulatedReviewProvider, simulatedReviews } from "@/server/reputation/providers/simulated";
import { ProviderError, type ReviewProvider } from "@/server/reputation/providers/types";
import { RECONCILE_GIVE_UP_HOURS, decideReply, reconcileDueReplies, reconcileReply, resolveReply, startReply, submitReply } from "@/server/reputation/replies";
import { runReviewSync, syncConnection, syncDueConnections } from "@/server/reputation/sync";
import { disconnectConnection } from "@/server/reputation/connections";
import { all, CALM_REPLY, connectSim, count, mirrored, one, replyEvents, reviewsShop, simReview, type ReputationShop } from "./support/reputation";
import type { ConnectionView } from "@/server/reputation/connections";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const HOUR = 3_600_000;
const T0 = new Date();
let s: ReputationShop;
let c: ConnectionView;
let used = 0;

beforeAll(async () => {
  simulatedReviews.reset();
  s = await reviewsShop("Reconcile Shop");
  c = await connectSim(s, "google", Array.from({ length: 40 }, (_, i) => simReview(`rc${String(i).padStart(2, "0")}`, { rating: 1 + (i % 5), daysAgo: 2 + i / 10 })));
  await syncConnection(c.id, { now: T0 });
});

/** A reply a person approved, started sending 30 minutes ago and never heard back about: the site is asked and nothing settles it. */
async function stuck(conn: ConnectionView = c, sentAgoMs = 30 * 60_000): Promise<{ replyId: string; sentAt: Date }> {
  const providerId = `rc${String(used++).padStart(2, "0")}`;
  const review = await mirrored(conn.id, providerId);
  const { id } = await startReply(s.sales, review.id, { body: CALM_REPLY });
  await submitReply(s.sales, id, { version: 1 });
  await decideReply(s.owner, id, { decision: "approve", version: 1 });
  const sentAt = new Date(Date.now() - sentAgoMs);
  await withSystem((db) => db.query("update review_replies set status = 'needs_reconciliation', sending_at = $2, failure_code = 'unknown_outcome' where id = $1", [id, sentAt]));
  return { replyId: id, sentAt };
}
const status = async (replyId: string) => (await one<{ status: string }>("select status from review_replies where id = $1", [replyId])).status;
const asked = (replyId: string) => count("select count(*)::text as n from notifications where org_id = $1 and dedupe_key like $2", [s.m.org.id, `review-reply-check:${replyId}:%`]);
const siteDown: ReviewProvider = { ...simulatedReviewProvider, readReply: async () => { throw new ProviderError("transient", "The review site could not be reached."); } };
const notFound: ReviewProvider = { ...simulatedReviewProvider, readReply: async () => { throw new ProviderError("invalid_content", "The review site no longer has that review."); } };

describe("the day-clock on a reply whose result is unknown does not depend on the site answering", () => {
  it("tells the owner and managers to look at the site themselves once a day has passed, when every read of the site fails", async () => {
    const r = await stuck();
    expect(await reconcileReply(s.m.org.id, r.replyId, { now: new Date(r.sentAt.getTime() + 2 * HOUR), provider: siteDown })).toBe("waiting");
    expect(await asked(r.replyId)).toBe(0);
    const day = new Date(r.sentAt.getTime() + (RECONCILE_GIVE_UP_HOURS + 1) * HOUR);
    expect(await reconcileReply(s.m.org.id, r.replyId, { now: day, provider: siteDown })).toBe("needs_person");
    const told = await asked(r.replyId);
    expect(told).toBeGreaterThanOrEqual(2); // the owner and a manager
    const note = await one<{ title: string; body: string; kind: string; link: string }>("select title, body, kind, link from notifications where org_id = $1 and dedupe_key like $2 limit 1", [s.m.org.id, `review-reply-check:${r.replyId}:%`]);
    expect(note).toMatchObject({ kind: "review_reply_failed", title: "Check whether a reply was posted" });
    expect(note.link).toContain("/crm/reviews?tab=public&review=");
    // Not told again by the next pass, and never sent again on a guess.
    expect(await reconcileReply(s.m.org.id, r.replyId, { now: new Date(day.getTime() + HOUR), provider: siteDown })).toBe("needs_person");
    expect(await asked(r.replyId)).toBe(told);
    expect(await status(r.replyId)).toBe("needs_reconciliation");
    expect(simulatedReviews.replyCalls()).toHaveLength(0);
    // The history says once that the owner and managers were asked.
    expect((await replyEvents(r.replyId)).filter((e) => e.kind === "check_requested")).toHaveLength(1);
  });

  it("does the same when the site says it no longer has the review", async () => {
    const r = await stuck();
    const day = new Date(r.sentAt.getTime() + (RECONCILE_GIVE_UP_HOURS + 2) * HOUR);
    expect(await reconcileReply(s.m.org.id, r.replyId, { now: day, provider: notFound })).toBe("needs_person");
    expect(await asked(r.replyId)).toBeGreaterThanOrEqual(2);
  });

  it("does the same when the saved sign-in can no longer be opened", async () => {
    const t = await connectSim(s, "google", [simReview("rcx0")]);
    await syncConnection(t.id, { now: T0 });
    const review = await mirrored(t.id, "rcx0");
    const { id } = await startReply(s.sales, review.id, { body: CALM_REPLY });
    await submitReply(s.sales, id, { version: 1 });
    await decideReply(s.owner, id, { decision: "approve", version: 1 });
    const sentAt = new Date(Date.now() - 30 * 60_000);
    await withSystem((db) => db.query("update review_replies set status = 'needs_reconciliation', sending_at = $2, failure_code = 'unknown_outcome' where id = $1", [id, sentAt]));
    await withSystem((db) => db.query("update review_connections set credentials = 'not-a-sealed-value' where id = $1", [t.id]));
    expect(await reconcileReply(s.m.org.id, id, { now: new Date(sentAt.getTime() + 2 * HOUR) })).toBe("waiting");
    expect(await asked(id)).toBe(0);
    expect(await reconcileReply(s.m.org.id, id, { now: new Date(sentAt.getTime() + (RECONCILE_GIVE_UP_HOURS + 1) * HOUR) })).toBe("needs_person");
    expect(await asked(id)).toBeGreaterThanOrEqual(2);
    expect(await status(id)).toBe("needs_reconciliation");
  });

  it("does the same when a person ended the connection meanwhile: it is no longer skipped for ever", async () => {
    const t = await connectSim(s, "google", [simReview("rcd0")]);
    await syncConnection(t.id, { now: T0 });
    const review = await mirrored(t.id, "rcd0");
    const { id } = await startReply(s.sales, review.id, { body: CALM_REPLY });
    await submitReply(s.sales, id, { version: 1 });
    await decideReply(s.owner, id, { decision: "approve", version: 1 });
    const sentAt = new Date(Date.now() - 30 * 60_000);
    await withSystem((db) => db.query("update review_replies set status = 'needs_reconciliation', sending_at = $2, failure_code = 'unknown_outcome' where id = $1", [id, sentAt]));
    await disconnectConnection(s.owner, t.id);
    expect(await reconcileReply(s.m.org.id, id, { now: new Date(sentAt.getTime() + 2 * HOUR) })).toBe("waiting");
    expect(await reconcileReply(s.m.org.id, id, { now: new Date(sentAt.getTime() + (RECONCILE_GIVE_UP_HOURS + 1) * HOUR) })).toBe("needs_person");
    expect(await asked(id)).toBeGreaterThanOrEqual(2);
    // A person can still settle it by hand, and then the notice is not repeated.
    await resolveReply(s.owner, id, { outcome: "not_posted" });
    expect(await status(id)).toBe("failed");
    expect(await reconcileReply(s.m.org.id, id, { now: new Date(sentAt.getTime() + (RECONCILE_GIVE_UP_HOURS + 5) * HOUR) })).toBe("skipped");
  });

  it("does not tell anyone about a reply a person settled while the site was being asked", async () => {
    const r = await stuck();
    const day = new Date(r.sentAt.getTime() + (RECONCILE_GIVE_UP_HOURS + 1) * HOUR);
    const settlesWhileAsked: ReviewProvider = {
      ...simulatedReviewProvider,
      readReply: async () => {
        await resolveReply(s.owner, r.replyId, { outcome: "not_posted" });
        throw new ProviderError("transient", "The review site could not be reached.");
      },
    };
    expect(await reconcileReply(s.m.org.id, r.replyId, { now: day, provider: settlesWhileAsked })).toBe("skipped");
    expect(await asked(r.replyId)).toBe(0);
  });

  it("looks first at replies nobody has been asked to check, so replies stuck for good cannot crowd the pass", async () => {
    const old = await stuck(c, 30 * 60_000);
    const newer = await stuck(c, 20 * 60_000);
    const day = new Date(old.sentAt.getTime() + (RECONCILE_GIVE_UP_HOURS + 1) * HOUR);
    expect(await reconcileReply(s.m.org.id, old.replyId, { now: day, provider: siteDown })).toBe("needs_person");
    // The older reply is already with a person; with room for one, the pass takes the newer one (the site now answers: nothing is on it, so it settles as not posted).
    await withSystem((db) => db.query("update review_replies set status = 'cancelled', approved_version = null, approved_hash = null, approved_by = null, approved_at = null where org_id = $1 and status = 'needs_reconciliation' and id not in ($2, $3)", [s.m.org.id, old.replyId, newer.replyId]));
    const out = await reconcileDueReplies({ limit: 1, now: new Date(newer.sentAt.getTime() + 30 * 60_000) });
    expect(out.checked).toBe(1);
    expect(await status(newer.replyId)).toBe("failed");
    expect(await status(old.replyId)).toBe("needs_reconciliation");
  });
});

// A site that never answers: the stand-in below accepts every call and never resolves, so any code that waits for it without a limit hangs the test.
const neverReads: ReviewProvider & { calls: number } = {
  ...simulatedReviewProvider, calls: 0,
  async readReply() { this.calls += 1; return new Promise<never>(() => {}); },
  async fetchPage() { this.calls += 1; return new Promise<never>(() => {}); },
};

describe("a review site that never answers costs a pass its budget, not the scheduler's whole run", () => {
  it("stops checking replies when the time given is used up, abandons the read that was waiting, and settles nothing on a guess", async () => {
    neverReads.calls = 0;
    const stuckOnes = [await stuck(), await stuck(), await stuck()];
    const began = Date.now();
    const out = await reconcileDueReplies({ budgetMs: 300, limit: 50, provider: neverReads, now: new Date(Date.now() + HOUR) });
    const took = Date.now() - began;
    expect(took).toBeLessThan(5_000);
    expect(neverReads.calls).toBeGreaterThanOrEqual(1);
    expect(neverReads.calls).toBeLessThan(3 + 10); // the read that was waiting is abandoned and the pass moves to the end, not into every reply
    expect(out.posted + out.failed).toBe(0);
    for (const r of stuckOnes) expect(["needs_reconciliation"]).toContain(await status(r.replyId));
    expect(simulatedReviews.replyCalls()).toHaveLength(0);
  });

  it("gives a read nothing to wait on at all once the budget is already gone", async () => {
    neverReads.calls = 0;
    const r = await stuck();
    const out = await reconcileDueReplies({ budgetMs: 0, limit: 50, provider: neverReads });
    expect(neverReads.calls).toBe(0);
    expect(out.checked).toBe(0);
    expect(await status(r.replyId)).toBe("needs_reconciliation");
  });

  it("stops reading a connection's reviews at the deadline, releases it, and leaves its status and the pass it was in the middle of alone", async () => {
    const t = await connectSim(s, "google", [simReview("rcs0"), simReview("rcs1")]);
    neverReads.calls = 0;
    const began = Date.now();
    const out = await syncConnection(t.id, { now: T0, provider: neverReads, deadline: Date.now() + 250 });
    expect(Date.now() - began).toBeLessThan(5_000);
    expect(out.status).toBe("skipped");
    expect(out.reason).toMatch(/time/i);
    expect(neverReads.calls).toBe(1);
    expect(await one("select status, sync_lease_until from review_connections where id = $1", [t.id])).toEqual({ status: "connected", sync_lease_until: null });
    // Nothing was marked failed or removed, and the next run reads it normally.
    expect(await count("select count(*)::text as n from external_reviews where connection_id = $1", [t.id])).toBe(0);
    expect((await syncConnection(t.id, { now: new Date(T0.getTime() + HOUR) })).status).toBe("synced");
  });

  it("does not start a connection once the deadline has passed, and the scheduler's pass over connections honours its budget", async () => {
    const t = await connectSim(s, "google", [simReview("rcb0")]);
    neverReads.calls = 0;
    const out = await syncConnection(t.id, { now: T0, provider: neverReads, deadline: Date.now() - 1 });
    expect(out.status).toBe("skipped");
    expect(neverReads.calls).toBe(0);
    const began = Date.now();
    await syncDueConnections({ now: new Date(T0.getTime() + 24 * HOUR), budgetMs: 300, provider: neverReads });
    expect(Date.now() - began).toBeLessThan(5_000);
  });

  it("bounds the scheduler's job as a whole: reading and checking together stay inside the time given when the site never answers", async () => {
    neverReads.calls = 0;
    await stuck();
    const began = Date.now();
    const work = await runReviewSync({ now: new Date(Date.now() + 24 * HOUR), budgetMs: 600, provider: neverReads });
    expect(Date.now() - began).toBeLessThan(5_000);
    expect(work).toBe(0);
    expect(await all("select 1 from review_connections where sync_lease_until is not null and org_id = $1", [s.m.org.id])).toEqual([]);
  });
});
