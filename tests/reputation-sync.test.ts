// Reading a review site into the mirror: that reading twice changes nothing, that a review is announced once and only when it is news, that a review the site stops returning is
// marked removed only after a pass that reached the end and read as many as the site reports, that a pass cut off continues where it stopped, what each kind of failure does,
// and that one workspace never reads or touches another's reviews. The review site is the in-process simulated one; nothing reaches a real service.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { agencyActor, startSupportSession } from "@/server/crm/actor";
import { loadConnection } from "@/server/reputation/connections";
import { decideReply, postReply, startReply, submitReply } from "@/server/reputation/replies";
import { REVIEWS_NOT_ENABLED_MESSAGE } from "@/server/reputation/entitlement";
import { simulatedReviews } from "@/server/reputation/providers/simulated";
import { ProviderError } from "@/server/reputation/providers/types";
import { MANUAL_SYNC_MIN_SECONDS, PASS_MAX_AGE_HOURS, SYNC_EVERY_MINUTES, SYNC_PAGE_SIZE, dueConnectionIds, runReviewSync, syncConnection, syncDueConnections, syncNow } from "@/server/reputation/sync";
import { agencyPeople } from "./support/crm";
import { all, CALM_REPLY, connectSim, count, mirrorCount, mirrored, one, reviewsShop, setReviews, simReview } from "./support/reputation";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

async function expectError(p: Promise<unknown>, code: string, message?: RegExp) {
  const err = await p.then(() => null, (e: unknown) => e as { code?: string; message?: string });
  expect(err, "expected a refusal").not.toBeNull();
  expect(err?.code).toBe(code);
  if (message) expect(err?.message).toMatch(message);
}

const T0 = new Date();
const later = (hours: number) => new Date(T0.getTime() + hours * 3_600_000);

beforeEach(() => simulatedReviews.reset());

const conn = (id: string) => one<{
  status: string; status_detail: string | null; last_sync_at: Date | null; last_success_at: Date | null; last_complete_at: Date | null; reported_rating: string | null; reported_review_count: number | null;
  sync_cursor: { pageToken?: string; passStartedAt?: string; pages?: number }; sync_lease_until: Date | null;
}>("select status, status_detail, last_sync_at, last_success_at, last_complete_at, reported_rating::text as reported_rating, reported_review_count, sync_cursor, sync_lease_until from review_connections where id = $1", [id]);
const events = (orgId: string, type = "review.external_received") => all<{ payload: Record<string, unknown>; dedupe_key: string; contact_id: string | null }>("select payload, dedupe_key, contact_id from crm_events where org_id = $1 and type = $2", [orgId, type]);
const notes = (orgId: string) => count("select count(*)::text as n from notifications where org_id = $1 and kind = 'review_needs_reply'", [orgId]);

/** A fresh workspace with one made-up Google location holding the given reviews. */
async function world(name: string, reviews = [simReview("r1", { rating: 5 }), simReview("r2", { rating: 2, comment: "Waited far too long." }), simReview("r3", { rating: 4, anonymous: true, comment: null })], reported?: { count?: number | null; rating?: number | null }) {
  const shop = await reviewsShop(name);
  const c = await connectSim(shop, "google", reviews, reported);
  return { shop, c };
}

describe("reading a site", () => {
  it("stores what the site returned, as it said it, marks every row as a sample, and records the site's own totals apart", async () => {
    const { shop, c } = await world("Basic Sync Shop", undefined, { count: 5, rating: 4.2 });
    const r = await syncConnection(c.id, { now: T0 });
    // The site says it has five and three were read, so no review would be marked removed even if one were missing.
    expect(r).toMatchObject({ status: "synced", pages: 1, seen: 3, inserted: 3, updated: 0, removed: 0, complete: true, skippedEntries: 0, removalWithheld: true });
    expect(await mirrorCount(c.id)).toBe(3);
    expect(await mirrored(c.id, "r1")).toMatchObject({ rating: 5, recommends: null, comment: "Sample comment r1", reviewer_name: "Reviewer r1", reviewer_anonymous: false, removed_at: null, simulated: true, contact_id: null });
    expect(await mirrored(c.id, "r2")).toMatchObject({ rating: 2, comment: "Waited far too long." });
    // An anonymous reviewer has no name stored at all.
    expect(await mirrored(c.id, "r3")).toMatchObject({ rating: 4, reviewer_name: null, reviewer_anonymous: true, comment: null });
    const stored = await conn(c.id);
    expect(stored).toMatchObject({ status: "connected", reported_rating: "4.20", reported_review_count: 5, sync_cursor: {}, sync_lease_until: null });
    expect(new Date(stored.last_complete_at as Date).getTime()).toBe(T0.getTime());
    expect(new Date(stored.last_success_at as Date).getTime()).toBe(T0.getTime());
    // The totals the site reports are not counted as reviews: three were read, five are reported.
    expect(await mirrorCount(c.id)).not.toBe(stored.reported_review_count);
    expect(shop.m.org.id).toBeTruthy();
  });

  it("changes nothing when it reads the same reviews again: no new rows, no second event, no second notice", async () => {
    const { shop, c } = await world("Idempotent Sync Shop", [simReview("a", { rating: 1, daysAgo: 0 }), simReview("b", { rating: 5, daysAgo: 0 })]);
    await syncConnection(c.id, { now: T0 });
    await syncConnection(c.id, { now: later(1) }); // the first pass was a backfill; a recent one-star review is still news
    const before = { rows: await mirrorCount(c.id), events: (await events(shop.m.org.id)).length, notes: await notes(shop.m.org.id) };
    for (let i = 2; i < 6; i += 1) {
      const again = await syncConnection(c.id, { now: later(i) });
      expect(again).toMatchObject({ status: "synced", inserted: 0, updated: 0, removed: 0, restored: 0, announced: 0, complete: true });
    }
    expect({ rows: await mirrorCount(c.id), events: (await events(shop.m.org.id)).length, notes: await notes(shop.m.org.id) }).toEqual(before);
    expect(before.rows).toBe(2);
  });

  it("keeps a reviewer's words as text: control characters are dropped, long text is cut to what the table holds, and an entry with no rating is not stored", async () => {
    const { c } = await world("Hygiene Sync Shop", [
      simReview("clean", { rating: 3, comment: `Fine.\u0000\u0007 Really\r\nfine.`, name: `  ${"N".repeat(300)}  ` }),
      simReview("long", { rating: 4, comment: "x".repeat(9000) }),
      simReview("unrated", { rating: null }),
      simReview("wild", { rating: 9 }),
      simReview("thumbs", { rating: null, recommends: false }),
    ]);
    const r = await syncConnection(c.id, { now: T0 });
    expect(r).toMatchObject({ status: "synced", seen: 3, inserted: 3, skippedEntries: 2 });
    expect((await mirrored(c.id, "clean")).comment).toBe("Fine. Really\nfine.");
    expect((await mirrored(c.id, "clean")).reviewer_name).toHaveLength(200);
    expect((await mirrored(c.id, "long")).comment).toHaveLength(4096);
    expect(await mirrored(c.id, "thumbs")).toMatchObject({ rating: null, recommends: false });
    expect(await mirrorCount(c.id, "provider_review_id in ('unrated', 'wild')")).toBe(0);
  });

  it("keeps the totals a site reported earlier when a later read does not report them", async () => {
    const { c } = await world("Totals Kept Shop", [simReview("k1")], { count: 1, rating: 4.5 });
    await syncConnection(c.id, { now: T0 });
    expect(await conn(c.id)).toMatchObject({ reported_rating: "4.50", reported_review_count: 1 });
    simulatedReviews.seed(c.externalLocationId, [simReview("k1")], { count: null, rating: null });
    expect(await syncConnection(c.id, { now: later(2) })).toMatchObject({ status: "synced", complete: true });
    expect(await conn(c.id)).toMatchObject({ reported_rating: "4.50", reported_review_count: 1 });
  });

  it("stores a reply the business already has on the site, whoever wrote it", async () => {
    const { c } = await world("Site Reply Shop", [simReview("a", { rating: 4, reply: { text: "Thanks, see you again." } }), simReview("b", { rating: 4 })]);
    await syncConnection(c.id, { now: T0 });
    expect((await mirrored(c.id, "a")).provider_reply_text).toBe("Thanks, see you again.");
    expect((await mirrored(c.id, "b")).provider_reply_text).toBeNull();
    simulatedReviews.setReply(c.externalLocationId, "b", "Added on the site itself.");
    simulatedReviews.setReply(c.externalLocationId, "a", null);
    const r = await syncConnection(c.id, { now: later(2) });
    expect(r.updated).toBe(2);
    expect((await mirrored(c.id, "b")).provider_reply_text).toBe("Added on the site itself.");
    expect((await mirrored(c.id, "a")).provider_reply_text).toBeNull();
  });
});

describe("what is announced", () => {
  it("tells automations about a new review once, with the site and the stars but never the reviewer's name or words, and tells the team about a low one once", async () => {
    const { shop, c } = await world("Announce Shop", []);
    await syncConnection(c.id, { now: T0 }); // an empty first pass completes the backfill
    simulatedReviews.add(c.externalLocationId, simReview("low", { rating: 2, name: "Pat Reviewer", comment: "Rude staff, secret detail 12345.", daysAgo: 0 }));
    simulatedReviews.add(c.externalLocationId, simReview("high", { rating: 5, name: "Sam Happy", comment: "Wonderful.", daysAgo: 0 }));
    const r = await syncConnection(c.id, { now: later(1) });
    expect(r).toMatchObject({ inserted: 2, announced: 2 });
    const evs = await events(shop.m.org.id);
    expect(evs).toHaveLength(2);
    for (const e of evs) {
      expect(Object.keys(e.payload).sort()).toEqual(["connectionId", "provider", "rating", "recommends", "reviewId", "simulated"]);
      expect(JSON.stringify(e.payload)).not.toMatch(/Pat Reviewer|Sam Happy|Rude staff|Wonderful|12345/);
      expect(e.contact_id).toBeNull();
      expect(e.dedupe_key).toMatch(/^review\.external_received:/);
    }
    // Only the low one reached the team, and what they were told names neither the reviewer nor their words.
    const lowRow = await mirrored(c.id, "low");
    expect(lowRow.alerted_at).not.toBeNull();
    expect((await mirrored(c.id, "high")).alerted_at).toBeNull();
    const told = await all<{ title: string; body: string | null; link: string | null; user_id: string }>("select title, body, link, user_id from notifications where org_id = $1 and kind = 'review_needs_reply'", [shop.m.org.id]);
    expect(told.length).toBeGreaterThanOrEqual(2); // the owner and the manager
    for (const n of told) {
      expect(n.title).toBe("A 2-star review arrived on Google");
      expect(`${n.title} ${n.body}`).not.toMatch(/Pat Reviewer|Rude staff|12345/);
      expect(n.link).toBe(`/crm/reviews?tab=public&review=${lowRow.id}`);
    }
    expect(new Set(told.map((n) => n.user_id)).size).toBe(told.length);
    // Reading again announces nothing more.
    await syncConnection(c.id, { now: later(2) });
    expect((await events(shop.m.org.id)).length).toBe(2);
    expect(await notes(shop.m.org.id)).toBe(told.length);
  });

  it("treats the first read of a connection as history: old reviews are stored without being announced, a review from the last two days still is", async () => {
    const { shop, c } = await world("Backfill Shop", [simReview("old1", { rating: 1, daysAgo: 40 }), simReview("old2", { rating: 2, daysAgo: 10 }), simReview("fresh", { rating: 1, daysAgo: 0.5 })]);
    const r = await syncConnection(c.id, { now: T0 });
    expect(r).toMatchObject({ inserted: 3, announced: 1 });
    expect((await events(shop.m.org.id)).map((e) => e.payload.reviewId)).toEqual([(await mirrored(c.id, "fresh")).id]);
    expect((await mirrored(c.id, "old1")).alerted_at).toBeNull();
    expect(await notes(shop.m.org.id)).toBeGreaterThanOrEqual(2);
    // After the first complete pass, a new old-dated review (the site back-fills nothing) is news again.
    simulatedReviews.add(c.externalLocationId, simReview("late", { rating: 5, daysAgo: 60 }));
    expect((await syncConnection(c.id, { now: later(3) })).announced).toBe(1);
  });

  it("announces a withdrawn Facebook recommendation as low, and a positive one without a notice", async () => {
    const shop = await reviewsShop("Recommendation Shop");
    const c = await connectSim(shop, "facebook", []);
    await syncConnection(c.id, { now: T0 });
    simulatedReviews.add(c.externalLocationId, simReview("no", { rating: null, recommends: false, daysAgo: 0 }));
    simulatedReviews.add(c.externalLocationId, simReview("yes", { rating: null, recommends: true, daysAgo: 0 }));
    await syncConnection(c.id, { now: later(1) });
    expect((await mirrored(c.id, "no")).alerted_at).not.toBeNull();
    expect((await mirrored(c.id, "yes")).alerted_at).toBeNull();
    const told = await all<{ title: string }>("select title from notifications where org_id = $1 and kind = 'review_needs_reply'", [shop.m.org.id]);
    expect(told[0].title).toBe("A recommendation that says no arrived on Facebook");
  });
});

describe("a review that changes or goes away", () => {
  it("follows a reviewer who edits their review, and sends a reply written for the old words back to a draft with its approval withdrawn", async () => {
    const { shop, c } = await world("Edit Shop", [simReview("e1", { rating: 2, comment: "Slow service." })]);
    await syncConnection(c.id, { now: T0 });
    const review = await mirrored(c.id, "e1");
    const author = shop.m.people.owner.id;
    const reply = await withSystem(async (db) => {
      const id = (await db.query<{ id: string }>("insert into review_replies (org_id, review_id, body, status, version, approved_version, approved_hash, approved_by, approved_at, author_id) values ($1, $2, 'Thank you for telling us.', 'approved', 1, 1, $3, $4, now(), $4) returning id", [shop.m.org.id, review.id, "b".repeat(64), author])).rows[0].id;
      return id;
    });
    simulatedReviews.edit(c.externalLocationId, "e1", { rating: 4, comment: "Slow at first, then they fixed it." });
    const r = await syncConnection(c.id, { now: later(2) });
    expect(r.updated).toBe(1);
    expect(await mirrored(c.id, "e1")).toMatchObject({ rating: 4, comment: "Slow at first, then they fixed it." });
    expect(await one("select status, approved_version, approved_hash, approved_by, decision_note from review_replies where id = $1", [reply])).toMatchObject({
      status: "draft", approved_version: null, approved_hash: null, approved_by: null, decision_note: expect.stringMatching(/review changed/),
    });
    expect((await all<{ kind: string }>("select kind from review_reply_events where reply_id = $1", [reply])).map((e) => e.kind)).toEqual(["review_changed"]);
    // A change that is not to the words (here, nothing) leaves a reply alone.
    await withSystem((db) => db.query("update review_replies set status = 'pending_approval' where id = $1", [reply]));
    await syncConnection(c.id, { now: later(3) });
    expect((await one<{ status: string }>("select status from review_replies where id = $1", [reply])).status).toBe("pending_approval");
  });

  it("marks a review removed only after a pass that reached the end of the list and read as many reviews as the site reports", async () => {
    const { c } = await world("Removal Shop", [simReview("k1"), simReview("k2"), simReview("gone", { rating: 1 })]);
    await syncConnection(c.id, { now: T0 });
    simulatedReviews.remove(c.externalLocationId, "gone");
    const r = await syncConnection(c.id, { now: later(2) });
    expect(r).toMatchObject({ complete: true, removed: 1, removalWithheld: false });
    expect((await mirrored(c.id, "gone")).removed_at).not.toBeNull();
    expect((await mirrored(c.id, "k1")).removed_at).toBeNull();
    // It stays in the mirror (marked), and the count of live reviews drops.
    expect(await mirrorCount(c.id)).toBe(3);
    expect(await mirrorCount(c.id, "removed_at is null")).toBe(2);
    // Removing it again changes nothing.
    expect((await syncConnection(c.id, { now: later(3) })).removed).toBe(0);
  });

  it("restores a removed review that the site returns again", async () => {
    const { c } = await world("Restore Shop", [simReview("k1"), simReview("back", { rating: 3 })]);
    await syncConnection(c.id, { now: T0 });
    simulatedReviews.remove(c.externalLocationId, "back");
    await syncConnection(c.id, { now: later(2) });
    expect((await mirrored(c.id, "back")).removed_at).not.toBeNull();
    simulatedReviews.add(c.externalLocationId, simReview("back", { rating: 3 }));
    const r = await syncConnection(c.id, { now: later(4) });
    expect(r.restored).toBe(1);
    expect((await mirrored(c.id, "back")).removed_at).toBeNull();
  });

  it("marks nothing removed when the pass read fewer reviews than the site says it has, because the list may have shifted while it was read", async () => {
    const { c } = await world("Withheld Shop", [simReview("k1"), simReview("k2"), simReview("k3")], { count: 3 });
    await syncConnection(c.id, { now: T0 });
    // The site now reports ten reviews but its list returns only two of the three we had.
    simulatedReviews.seed(c.externalLocationId, [simReview("k1"), simReview("k2")], { count: 10 });
    const r = await syncConnection(c.id, { now: later(2) });
    expect(r).toMatchObject({ complete: true, removed: 0, removalWithheld: true });
    expect((await mirrored(c.id, "k3")).removed_at).toBeNull();
    // Once what it reports matches what it returns, the removal goes through.
    simulatedReviews.seed(c.externalLocationId, [simReview("k1"), simReview("k2")], { count: 2 });
    expect(await syncConnection(c.id, { now: later(4) })).toMatchObject({ removed: 1, removalWithheld: false });
  });

  it("marks nothing removed by a pass that did not finish, and continues where it stopped (140 reviews over three pages)", async () => {
    const many = Array.from({ length: 140 }, (_, i) => simReview(`m${String(i).padStart(3, "0")}`, { rating: 1 + (i % 5), daysAgo: 100 + i }));
    const { c } = await world("Partial Shop", many);
    expect(SYNC_PAGE_SIZE).toBe(50);
    const first = await syncConnection(c.id, { now: T0 }); // all three pages in one run
    expect(first).toMatchObject({ pages: 3, seen: 140, inserted: 140, complete: true });
    // Two reviews go away; the next pass is read one page per run.
    simulatedReviews.remove(c.externalLocationId, "m000");
    simulatedReviews.remove(c.externalLocationId, "m139");
    const started = later(10);
    const a = await syncConnection(c.id, { now: started, maxPages: 1 });
    expect(a).toMatchObject({ status: "partial", pages: 1, complete: false, removed: 0 });
    const mid = await conn(c.id);
    expect(mid.sync_cursor.pageToken).toBeTruthy();
    expect(new Date(mid.sync_cursor.passStartedAt as string).getTime()).toBe(started.getTime());
    expect(await mirrorCount(c.id, "removed_at is not null")).toBe(0);
    const b = await syncConnection(c.id, { now: later(10.5), maxPages: 1 });
    expect(b).toMatchObject({ status: "partial", pages: 1, complete: false, removed: 0 });
    expect(new Date((await conn(c.id)).sync_cursor.passStartedAt as string).getTime()).toBe(started.getTime()); // the same pass
    const done = await syncConnection(c.id, { now: later(11), maxPages: 1 });
    expect(done).toMatchObject({ status: "synced", complete: true, removed: 2, removalWithheld: false });
    expect((await conn(c.id)).sync_cursor).toEqual({});
    expect(await mirrorCount(c.id, "removed_at is not null")).toBe(2);
    expect(await mirrorCount(c.id, "removed_at is null")).toBe(138);
    // Every review seen in that pass carries the pass's own start time, whichever run read it.
    expect(await mirrorCount(c.id, `last_seen_at = '${started.toISOString()}' and removed_at is null`)).toBe(138);
  });

  it("marks nothing removed by a pass that did not finish even when the site reports no total to compare against", async () => {
    const many = Array.from({ length: 120 }, (_, i) => simReview(`t${String(i).padStart(3, "0")}`, { daysAgo: 100 + i }));
    const { c } = await world("Partial No Total Shop", many, { count: null });
    expect(await syncConnection(c.id, { now: T0 })).toMatchObject({ complete: true, inserted: 120, removalWithheld: false });
    simulatedReviews.remove(c.externalLocationId, "t000");
    const part = await syncConnection(c.id, { now: later(10), maxPages: 1 });
    expect(part).toMatchObject({ status: "partial", complete: false, removed: 0 });
    expect(await mirrorCount(c.id, "removed_at is not null")).toBe(0);
    expect(await syncConnection(c.id, { now: later(11), maxPages: 5 })).toMatchObject({ status: "synced", complete: true, removed: 1 });
    expect((await mirrored(c.id, "t000")).removed_at).not.toBeNull();
  });

  it("starts a pass over when an unfinished one is more than a day old", async () => {
    const many = Array.from({ length: 120 }, (_, i) => simReview(`s${String(i).padStart(3, "0")}`));
    const { c } = await world("Stale Pass Shop", many);
    await syncConnection(c.id, { now: T0, maxPages: 1 });
    const first = new Date((await conn(c.id)).sync_cursor.passStartedAt as string).getTime();
    expect(first).toBe(T0.getTime());
    const resumed = later(PASS_MAX_AGE_HOURS + 1);
    await syncConnection(c.id, { now: resumed, maxPages: 1 });
    const cursor = (await conn(c.id)).sync_cursor;
    expect(new Date(cursor.passStartedAt as string).getTime()).toBe(resumed.getTime());
    expect(cursor.pages).toBe(1);
  });
});

describe("what a failure does", () => {
  it("marks a refused sign-in as needing to be reconnected, stores nothing from that call, and does not keep trying", async () => {
    const { shop, c } = await world("Auth Failure Shop");
    simulatedReviews.failNext("fetch", new ProviderError("auth", "The review site no longer accepts this sign-in. Reconnect it.", { needsReauth: true }));
    const r = await syncConnection(c.id, { now: T0 });
    expect(r).toMatchObject({ status: "failed", reason: expect.stringMatching(/no longer accepts/), inserted: 0 });
    expect(await conn(c.id)).toMatchObject({ status: "needs_reauth", last_complete_at: null });
    expect(await mirrorCount(c.id)).toBe(0);
    expect(await count("select count(*)::text as n from notifications where org_id = $1 and kind = 'review_connection_attention'", [shop.m.org.id])).toBeGreaterThanOrEqual(2);
    // A connection that needs reconnecting is not read again, by anyone, until it is reconnected.
    expect(await syncConnection(c.id, { now: later(2) })).toMatchObject({ status: "skipped", reason: expect.stringMatching(/reconnected/) });
    expect(await dueConnectionIds(later(5), 50, shop.m.org.id)).not.toContain(c.id);
  });

  it("leaves the status alone for a site that could not be reached, keeps the place in the list, and says why it did not read", async () => {
    const many = Array.from({ length: 120 }, (_, i) => simReview(`f${String(i).padStart(3, "0")}`));
    const { c } = await world("Transient Shop", many);
    await syncConnection(c.id, { now: T0, maxPages: 1 });
    const saved = (await conn(c.id)).sync_cursor;
    simulatedReviews.failNext("fetch", new ProviderError("transient", "The review site could not be reached. It is tried again automatically."));
    const r = await syncConnection(c.id, { now: later(1) });
    expect(r).toMatchObject({ status: "failed", reason: expect.stringMatching(/could not be reached/) });
    expect(await conn(c.id)).toMatchObject({ status: "connected" });
    expect((await conn(c.id)).sync_cursor).toEqual(saved);
    expect(await mirrorCount(c.id)).toBe(SYNC_PAGE_SIZE);
    // The next run carries on from the saved place.
    const next = await syncConnection(c.id, { now: later(2) });
    expect(next).toMatchObject({ status: "synced", complete: true });
    expect(await mirrorCount(c.id)).toBe(120);
  });

  it("starts over, without blaming the connection, when the site no longer accepts the saved place in its list", async () => {
    const many = Array.from({ length: 120 }, (_, i) => simReview(`g${String(i).padStart(3, "0")}`));
    const { c } = await world("Stale Token Shop", many);
    await syncConnection(c.id, { now: T0, maxPages: 1 });
    simulatedReviews.failNext("fetch", new ProviderError("invalid_content", "The site could not find that page of reviews."));
    const r = await syncConnection(c.id, { now: later(1) });
    expect(r).toMatchObject({ status: "failed", reason: expect.stringMatching(/read again from the start/) });
    expect(await conn(c.id)).toMatchObject({ status: "connected", sync_cursor: {} });
    expect(await syncConnection(c.id, { now: later(2) })).toMatchObject({ status: "synced", complete: true, seen: 120 });
  });

  it("marks a definite refusal on the first page as an error, shown as a problem reading it, and tries again next time", async () => {
    const { c } = await world("Refusal Shop");
    simulatedReviews.failNext("fetch", new ProviderError("invalid_content", "The review site could not find that location."));
    await syncConnection(c.id, { now: T0 });
    expect(await conn(c.id)).toMatchObject({ status: "error" });
    // An error is retried (unlike a connection that needs reconnecting), and a good read clears it.
    const r = await syncConnection(c.id, { now: later(2) });
    expect(r.status).toBe("synced");
    expect(await conn(c.id)).toMatchObject({ status: "connected", status_detail: null });
  });
});

describe("whether a connection is read at all", () => {
  it("skips a connection that is being read, until its lease runs out", async () => {
    const { c } = await world("Lease Shop");
    await withSystem((db) => db.query("update review_connections set sync_lease_until = now() + interval '1 minute' where id = $1", [c.id]));
    expect(await syncConnection(c.id, { now: new Date() })).toMatchObject({ status: "skipped", reason: expect.stringMatching(/being read right now/) });
    await withSystem((db) => db.query("update review_connections set sync_lease_until = now() - interval '1 minute' where id = $1", [c.id]));
    expect((await syncConnection(c.id, { now: new Date() })).status).toBe("synced");
    expect((await conn(c.id)).sync_lease_until).toBeNull();
  });

  it("skips a disconnected connection, a suspended workspace and a workspace that switched public reviews off", async () => {
    const { shop, c } = await world("Gated Shop");
    await withSystem((db) => db.query("update organizations set status = 'suspended' where id = $1", [shop.m.org.id]));
    expect(await syncConnection(c.id, { now: T0 })).toMatchObject({ status: "skipped", reason: "The workspace is not active." });
    await withSystem((db) => db.query("update organizations set status = 'active' where id = $1", [shop.m.org.id]));
    await setReviews(shop.m.org.id, false);
    expect(await syncConnection(c.id, { now: T0 })).toMatchObject({ status: "skipped", reason: REVIEWS_NOT_ENABLED_MESSAGE });
    expect(await dueConnectionIds(later(5), 50, shop.m.org.id)).toEqual([]);
    await setReviews(shop.m.org.id, true);
    await withSystem((db) => db.query("update review_connections set status = 'disconnected', credentials = null where id = $1", [c.id]));
    expect(await syncConnection(c.id, { now: T0 })).toMatchObject({ status: "skipped", reason: "It is disconnected." });
    expect(await mirrorCount(c.id)).toBe(0);
    expect(await syncConnection("00000000-0000-4000-8000-000000000000", { now: T0 })).toMatchObject({ status: "skipped", reason: "That connection was not found." });
  });

  it("does not read a real site while its switch is off in this deployment, and does not blame the connection for it", async () => {
    const shop = await reviewsShop("Real Site Shop");
    const id = (await one<{ id: string }>(
      `insert into review_connections (org_id, provider, adapter, external_account_id, external_location_id, name, credentials, status) values ($1, 'google', 'google', 'accounts/1', $2, 'Real Location', 'sealed-not-used', 'connected') returning id`,
      [shop.m.org.id, `locations/real-${Date.now()}`],
    )).id;
    const r = await syncConnection(id, { now: T0 });
    expect(r).toMatchObject({ status: "skipped", reason: expect.stringMatching(/isn't switched on for iAcquire/) });
    expect(await conn(id)).toMatchObject({ status: "connected", status_detail: null, last_sync_at: null });
    expect(await dueConnectionIds(later(5), 50, shop.m.org.id)).toContain(id); // due, but the run above skipped it without writing anything
  });
});

describe("the scheduler's pass", () => {
  it("reads the connections that are due, the least recently read first, and no others", async () => {
    const shop = await reviewsShop("Due Shop");
    const a = await connectSim(shop, "google", [simReview("a1")]);
    const b = await connectSim(shop, "google", [simReview("b1")]);
    const never = await connectSim(shop, "google", [simReview("n1")]);
    const base = new Date("2026-10-24T08:00:00Z");
    await withSystem(async (db) => {
      await db.query("update review_connections set last_sync_at = $2 where id = $1", [a.id, new Date(base.getTime() - 3 * 3_600_000)]);
      await db.query("update review_connections set last_sync_at = $2 where id = $1", [b.id, new Date(base.getTime() - (SYNC_EVERY_MINUTES - 10) * 60_000)]);
    });
    const ids = await dueConnectionIds(base, 10, shop.m.org.id);
    expect(ids).toEqual([never.id, a.id]); // never read first, then the oldest; b was read too recently
    const out = await syncDueConnections({ now: base, orgId: shop.m.org.id });
    expect(out).toMatchObject({ connections: 2, inserted: 2, failed: 0 });
    expect(await mirrorCount(b.id)).toBe(0);
    // And now none is due.
    expect(await dueConnectionIds(base, 10, shop.m.org.id)).toEqual([]);
  });

  it("stops when its time is used up, and takes the limit it is given", async () => {
    const shop = await reviewsShop("Budget Shop");
    for (let i = 0; i < 3; i += 1) await connectSim(shop, "google", [simReview(`x${i}`)]);
    expect((await syncDueConnections({ now: T0, orgId: shop.m.org.id, limit: 1 })).connections).toBe(1);
    expect((await syncDueConnections({ now: T0, orgId: shop.m.org.id, budgetMs: -1 })).connections).toBe(0);
    expect((await syncDueConnections({ now: T0, orgId: shop.m.org.id })).connections).toBe(2);
  });

  it("is the whole job: it reads, it checks replies whose result is unknown, and it reports how much changed", async () => {
    const shop = await reviewsShop("Job Shop");
    const c = await connectSim(shop, "google", [simReview("j1"), simReview("j2")]);
    expect(await runReviewSync({ now: T0 })).toBeGreaterThanOrEqual(2);
    expect(await mirrorCount(c.id)).toBe(2);
    expect(await runReviewSync({ now: T0 })).toBeGreaterThanOrEqual(0);
  });

  it("settles, in the same run, a reply the site took but never confirmed, from what the site shows, and sends nothing itself", async () => {
    const shop = await reviewsShop("Job Reply Shop");
    const c = await connectSim(shop, "google", [simReview("q1", { rating: 2, daysAgo: 0 })]);
    await syncConnection(c.id, { now: T0 });
    const review = await mirrored(c.id, "q1");
    const { id } = await startReply(shop.sales, review.id, { body: CALM_REPLY });
    await submitReply(shop.sales, id, { version: 1 });
    await decideReply(shop.owner, id, { decision: "approve", version: 1 });
    simulatedReviews.loseResponseNext("reply");
    expect((await postReply(shop.owner, id, { now: T0 })).status).toBe("needs_reconciliation");
    const sent = simulatedReviews.replyCalls().length;
    await runReviewSync({ now: later(1) });
    expect((await one<{ status: string }>("select status from review_replies where id = $1", [id])).status).toBe("posted");
    expect(simulatedReviews.replyCalls().length).toBe(sent);
  });
});

describe("a person asking for the site to be read now", () => {
  it("lets the client's owner and managers, not twice within a minute, and nobody else", async () => {
    const { shop, c } = await world("Manual Shop");
    const first = await syncNow(shop.owner, c.id, { now: T0 });
    expect(first.status).toBe("synced");
    await expectError(syncNow(shop.owner, c.id, { now: new Date(T0.getTime() + (MANUAL_SYNC_MIN_SECONDS - 5) * 1000) }), "conflict", /a moment ago/);
    expect((await syncNow(shop.manager, c.id, { now: new Date(T0.getTime() + (MANUAL_SYNC_MIN_SECONDS + 5) * 1000) })).status).toBe("synced");
    for (const who of [shop.sales, shop.support, shop.viewer]) await expectError(syncNow(who, c.id, { now: later(5) }), "forbidden");
    const { superAdmin } = await agencyPeople();
    await startSupportSession(superAdmin, shop.m.org.id, { mode: "write", reason: "Looking at review sites" });
    await expectError(syncNow(await agencyActor(superAdmin, shop.m.org.id), c.id, { now: later(5) }), "forbidden");
  });

  it("cannot read another workspace's connection", async () => {
    const a = await world("Manual Mine");
    const b = await world("Manual Theirs");
    await expectError(syncNow(a.shop.owner, b.c.id, { now: T0 }), "not_found");
    expect(await mirrorCount(b.c.id)).toBe(0);
    expect(await withSystem((db) => loadConnection(db, a.shop.m.org.id, b.c.id))).toBeNull();
  });
});

describe("two workspaces never share reviews", () => {
  it("keeps each workspace's rows, events and notices to itself, even when both read the same review ids", async () => {
    const same = [simReview("shared-1", { rating: 1, daysAgo: 0 }), simReview("shared-2", { rating: 5, daysAgo: 0 })];
    const a = await world("Iso Alpha", same);
    const b = await world("Iso Beta", same);
    await syncConnection(a.c.id, { now: T0 });
    await syncConnection(b.c.id, { now: T0 });
    expect(await mirrorCount(a.c.id)).toBe(2);
    expect(await mirrorCount(b.c.id)).toBe(2);
    expect((await mirrored(a.c.id, "shared-1")).id).not.toBe((await mirrored(b.c.id, "shared-1")).id);
    expect(await count("select count(*)::text as n from external_reviews where org_id = $1 and connection_id <> $2", [a.shop.m.org.id, a.c.id])).toBe(0);
    for (const x of [a, b]) {
      const evs = await events(x.shop.m.org.id);
      expect(evs).toHaveLength(2); // both reviews are from the last two days, so both are news
      expect(await one<{ n: string }>("select count(*)::text as n from crm_events where org_id = $1 and (payload ->> 'connectionId') <> $2", [x.shop.m.org.id, x.c.id])).toMatchObject({ n: "0" });
    }
    // Removing a review for one leaves the other's alone.
    simulatedReviews.reset();
    simulatedReviews.seed(a.c.externalLocationId, [same[1]]);
    simulatedReviews.seed(b.c.externalLocationId, same);
    await syncConnection(a.c.id, { now: later(2) });
    await syncConnection(b.c.id, { now: later(2) });
    expect((await mirrored(a.c.id, "shared-1")).removed_at).not.toBeNull();
    expect((await mirrored(b.c.id, "shared-1")).removed_at).toBeNull();
  });
});
