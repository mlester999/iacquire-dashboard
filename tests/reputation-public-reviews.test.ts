// Reading the mirror for the Public reviews screen: the list and its filters, the numbers computed from what was read beside what the site reports, who may look and who may
// reply, and the one way a review ever gets a customer (a person links it by hand, and erasure and merge follow the customer). Synthetic workspaces on embedded Postgres; the
// review site is the in-process simulated one.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { agencyActor, startSupportSession } from "@/server/crm/actor";
import { mergeContacts, redactContact } from "@/server/messaging/contacts";
import { createContact } from "@/server/crm/contacts";
import { saveReputationSettings } from "@/server/reputation/settings";
import { simulatedReviews } from "@/server/reputation/providers/simulated";
import { getConnectionSummaries, getPublicReview, linkReviewContact, listPublicReviews, publicReviewsData, publicReviewsStatus, replyFactsFor, REVIEWS_PAGE_SIZE } from "@/server/reputation/public-reviews";
import { decideReply, startReply, submitReply } from "@/server/reputation/replies";
import { syncConnection } from "@/server/reputation/sync";
import { agencyPeople } from "./support/crm";
import { all, CALM_REPLY, connectSim, count, mirrored, one, replyOf, reviewsShop, setReviews, shopCustomer, simReview, type ReputationShop } from "./support/reputation";
import type { ConnectionView } from "@/server/reputation/connections";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

async function expectError(p: Promise<unknown>, code: string, message?: RegExp) {
  const err = await p.then(() => null, (e: unknown) => e as { code?: string; message?: string });
  expect(err, "expected a refusal").not.toBeNull();
  expect(err?.code).toBe(code);
  if (message) expect(err?.message).toMatch(message);
}

const T0 = new Date();
let s: ReputationShop;
let other: ReputationShop;
let c: ConnectionView;
let co: ConnectionView;

beforeAll(async () => {
  simulatedReviews.reset();
  s = await reviewsShop("Public Reviews Shop");
  other = await reviewsShop("Other Public Reviews Shop");
  c = await connectSim(s, "google", [
    simReview("newest", { rating: 5, daysAgo: 1, name: "Nina Newest" }),
    simReview("low-open", { rating: 2, daysAgo: 2, comment: "Waited far too long." }),
    simReview("low-site", { rating: 1, daysAgo: 3, reply: { text: "We are sorry about this." } }),
    simReview("middle", { rating: 3, daysAgo: 4 }),
    simReview("anon", { rating: 4, daysAgo: 5, anonymous: true, comment: null }),
    simReview("gone", { rating: 1, daysAgo: 6 }),
  ], { count: 6, rating: 3.1 });
  co = await connectSim(other, "google", [simReview("theirs-1", { rating: 1, daysAgo: 1 }), simReview("theirs-2", { rating: 5, daysAgo: 2 })]);
  await syncConnection(c.id, { now: T0 });
  await syncConnection(co.id, { now: T0 });
  // One review the site stopped returning.
  simulatedReviews.remove(c.externalLocationId, "gone");
  await syncConnection(c.id, { now: new Date(T0.getTime() + 2 * 3_600_000) });
});

describe("the list", () => {
  it("shows the newest first, with the filters' counts, and keeps a review the site no longer returns under 'removed from the site' alone", async () => {
    const { page, counts } = await listPublicReviews(s.owner);
    expect(page.rows.map((r) => r.id)).toEqual((await Promise.all(["newest", "low-open", "low-site", "middle", "anon"].map((id) => mirrored(c.id, id)))).map((r) => r.id));
    expect(counts).toEqual({ all: 5, needs_reply: 4, low: 3, replied: 1, removed: 1 });
    expect(page).toMatchObject({ total: 5, page: 1, pageSize: REVIEWS_PAGE_SIZE });
    expect((await listPublicReviews(s.owner, { filter: "removed" })).page.rows).toHaveLength(1);
    expect((await listPublicReviews(s.owner, { filter: "removed" })).page.rows[0].removedAt).not.toBeNull();
    expect((await listPublicReviews(s.owner, { filter: "replied" })).page.rows.map((r) => r.providerReply?.text)).toEqual(["We are sorry about this."]);
    expect((await listPublicReviews(s.owner, { filter: "low" })).page.rows.map((r) => r.rating)).toEqual([2, 1, 3]);
    expect((await listPublicReviews(s.owner, { filter: "needs_reply" })).page.rows).toHaveLength(4);
  });

  it("reads each review as the site gave it: stars in words, an anonymous reviewer without a name, a reply on the site, and the connection it came from", async () => {
    const { page } = await listPublicReviews(s.owner);
    const by = Object.fromEntries(page.rows.map((r) => [r.comment ?? "(none)", r]));
    const newest = page.rows[0];
    expect(newest).toMatchObject({ rating: 5, ratingText: "5 of 5 stars", reviewerName: "Nina Newest", provider: "google", providerLabel: "Google", word: "review", connectionName: c.name, simulated: true, removedAt: null, low: false, live: true, contactId: null, contactName: null });
    expect(page.rows.find((r) => r.reviewerName === null)).toMatchObject({ rating: 4, comment: null });
    expect(by["Waited far too long."]).toMatchObject({ low: true, rating: 2, providerReply: null, reply: null });
    expect(page.rows.find((r) => r.providerReply)?.providerReply).toMatchObject({ text: "We are sorry about this." });
    // Newest first by the date the reviewer wrote it, not the date it was read.
    const times = page.rows.map((r) => new Date(r.at).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("splits into pages and says how many there are", async () => {
    const t = await reviewsShop("Paging Shop");
    const tc = await connectSim(t, "google", Array.from({ length: 23 }, (_, i) => simReview(`pg${String(i).padStart(2, "0")}`, { rating: 4, daysAgo: 1 + i / 10 })));
    await syncConnection(tc.id, { now: T0 });
    const first = await listPublicReviews(t.owner, { pageSize: 10 });
    const third = await listPublicReviews(t.owner, { pageSize: 10, page: 3 });
    expect(first.page).toMatchObject({ total: 23, page: 1, pageSize: 10 });
    expect(first.page.rows).toHaveLength(10);
    expect(third.page.rows).toHaveLength(3);
    expect(new Set([...first.page.rows, ...third.page.rows].map((r) => r.id)).size).toBe(13);
    expect((await listPublicReviews(t.owner, { pageSize: 500 })).page.pageSize).toBe(50);
    expect((await listPublicReviews(t.owner, { page: -4 })).page.page).toBe(1);
  });

  it("marks a review low by the workspace's own level, and shows the reply in progress with its history", async () => {
    const t = await reviewsShop("Level Shop");
    const tc = await connectSim(t, "google", [simReview("l1", { rating: 4 }), simReview("l2", { rating: 5 })]);
    await syncConnection(tc.id, { now: T0 });
    expect((await listPublicReviews(t.owner)).page.rows.some((r) => r.low)).toBe(false);
    await saveReputationSettings(t.owner, { publicReviewAlertAtOrBelow: 4 }, 0);
    const rows = (await listPublicReviews(t.owner)).page.rows;
    expect(rows.filter((r) => r.low).map((r) => r.rating)).toEqual([4]);
    const { id } = await startReply(t.sales, (await mirrored(tc.id, "l1")).id, { body: CALM_REPLY });
    await submitReply(t.sales, id, { version: 1 });
    const withReply = (await listPublicReviews(t.owner)).page.rows.find((r) => r.rating === 4);
    expect(withReply?.reply).toMatchObject({ id, status: "pending_approval", version: 1, origin: "human", body: CALM_REPLY, authorName: expect.any(String), ai: null });
    expect(withReply?.reply?.events.map((e) => e.kind)).toEqual(["created", "submitted"]);
    expect(withReply?.reply?.events[0].actorName).toBeTruthy();
  });

  it("says a review cannot be answered when its connection needs attention, and why a reply cannot be posted from here", async () => {
    const t = await reviewsShop("Postable Display Shop");
    const tc = await connectSim(t, "google", [simReview("d1")]);
    await syncConnection(tc.id, { now: T0 });
    const ok = (await listPublicReviews(t.owner)).page.rows[0];
    expect(ok).toMatchObject({ live: true, postable: { ok: true } });
    simulatedReviews.setReplySupport(false);
    expect((await listPublicReviews(t.owner)).page.rows[0].postable).toMatchObject({ ok: false, reason: expect.stringMatching(/set not to take replies/) });
    simulatedReviews.setReplySupport(true);
    await withSystem((db) => db.query("update review_connections set status = 'needs_reauth' where id = $1", [tc.id]));
    expect((await listPublicReviews(t.owner)).page.rows[0]).toMatchObject({ live: false, postable: { ok: false } });
  });

  it("opens one review by its address, even from another page, and returns nothing for an id that is not this workspace's", async () => {
    const mine = await mirrored(c.id, "middle");
    expect((await getPublicReview(s.owner, mine.id))?.rating).toBe(3);
    const theirs = await mirrored(co.id, "theirs-1");
    expect(await getPublicReview(s.owner, theirs.id)).toBeNull();
    expect(await getPublicReview(s.owner, "not-a-uuid")).toBeNull();
    expect(await getPublicReview(s.owner, "00000000-0000-4000-8000-000000000000")).toBeNull();
    const data = await publicReviewsData(s.owner, { focusId: (await mirrored(c.id, "anon")).id });
    expect(data.focus).toBeNull(); // it is on the first page already
    const t = await reviewsShop("Focus Shop");
    const tc = await connectSim(t, "google", Array.from({ length: 30 }, (_, i) => simReview(`fc${String(i).padStart(2, "0")}`, { daysAgo: 1 + i / 10 })));
    await syncConnection(tc.id, { now: T0 });
    const far = (await mirrored(tc.id, "fc29")).id;
    const deep = await publicReviewsData(t.owner, { focusId: far });
    expect(deep.focus?.id).toBe(far);
    expect(deep.page.rows.some((r) => r.id === far)).toBe(false);
  });
});

describe("the numbers", () => {
  it("computes the average and the counts from the reviews read, and sets what the site reports beside them, never mixed in", async () => {
    const { summaries } = await getConnectionSummaries(s.owner);
    const sum = summaries.find((x) => x.connectionId === c.id);
    expect(sum).toMatchObject({ provider: "google", label: "Google", simulated: true, status: "connected", reportedRating: 3.1, reportedCount: 5 });
    // Five are live: 5, 2, 1, 3, 4 stars. Their average is 3.0 and not the 3.1 the site reports; one more was read earlier and is no longer returned.
    expect(sum?.summary).toEqual({ live: 5, removed: 1, rated: 5, average: 3, byRating: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 }, recommended: 0, notRecommended: 0 });
    expect(sum?.line).toBe("5 reviews read, the same as Google reports.");
    expect(sum?.ago).toMatch(/just now|minutes? ago|hours? ago|days? ago/);
    expect(sum?.lastSuccessAt).not.toBeNull();
  });

  it("shows only this workspace's connections and reviews, and keeps a disconnected connection's reviews until they are cleared", async () => {
    const mine = (await getConnectionSummaries(s.owner)).summaries.map((x) => x.connectionId);
    expect(mine).toContain(c.id);
    expect(mine).not.toContain(co.id);
    const t = await reviewsShop("Disconnected Summary Shop");
    const tc = await connectSim(t, "google", [simReview("k1")]);
    const empty = await connectSim(t, "google");
    await syncConnection(tc.id, { now: T0 });
    await withSystem((db) => db.query("update review_connections set status = 'disconnected', credentials = null, disconnected_at = now() where id = any($1::uuid[])", [[tc.id, empty.id]]));
    const ids = (await getConnectionSummaries(t.owner)).summaries.map((x) => x.connectionId);
    expect(ids).toEqual([tc.id]); // the one with reviews stays visible; the empty one is history only
  });

  it("counts new reviews per week for the last twelve weeks, with every week present", async () => {
    const { weekly } = await getConnectionSummaries(s.owner);
    expect(weekly).toHaveLength(12);
    expect(weekly.reduce((n, w) => n + w.count, 0)).toBe(5);
    expect(weekly.map((w) => w.weekStart)).toEqual([...weekly.map((w) => w.weekStart)].sort());
  });

  it("says whether the workspace has public reviews switched on and anything to show", async () => {
    expect(await publicReviewsStatus(s.owner)).toEqual({ enabled: true, any: true });
    const fresh = await reviewsShop("Status Shop");
    expect(await publicReviewsStatus(fresh.owner)).toEqual({ enabled: true, any: false });
    const never = await reviewsShop("Status Never Shop", { reviews: false });
    expect(await publicReviewsStatus(never.owner)).toEqual({ enabled: false, any: false });
    const tc = await connectSim(fresh, "google", [simReview("s1")]);
    await syncConnection(tc.id, { now: T0 });
    await setReviews(fresh.m.org.id, false);
    expect(await publicReviewsStatus(fresh.owner)).toEqual({ enabled: false, any: true }); // what was read stays visible
  });
});

describe("who may look and who may reply", () => {
  it("lets the client's people who can see reviews read them, and gives each only the rights their role has", async () => {
    await saveReputationSettings(s.owner, { aiRepliesEnabled: true }, 0);
    for (const who of [s.owner, s.manager, s.sales, s.support, s.viewer]) expect((await listPublicReviews(who)).counts.all).toBe(5);
    expect(await replyFactsFor(s.owner)).toMatchObject({ canDraft: true, canPublish: true, canAi: true, aiEnabled: true });
    expect(await replyFactsFor(s.manager)).toMatchObject({ canDraft: true, canPublish: true, canAi: true });
    expect(await replyFactsFor(s.sales)).toMatchObject({ canDraft: true, canPublish: false, canAi: true });
    expect(await replyFactsFor(s.support)).toMatchObject({ canDraft: true, canPublish: false });
    expect(await replyFactsFor(s.viewer)).toMatchObject({ canDraft: false, canPublish: false, canAi: false });
    await saveReputationSettings(s.owner, { aiRepliesEnabled: false }, 1);
    expect(await replyFactsFor(s.owner)).toMatchObject({ canAi: false, aiEnabled: false });
  });

  it("lets iAcquire support look, and in a write session write a reply, never approve, post or ask the AI", async () => {
    const { superAdmin } = await agencyPeople();
    await startSupportSession(superAdmin, s.m.org.id, { mode: "read", reason: "Looking at reviews (read)" });
    const read = await agencyActor(superAdmin, s.m.org.id);
    expect((await listPublicReviews(read)).counts.all).toBe(5);
    expect(await replyFactsFor(read)).toMatchObject({ canDraft: false, canPublish: false, canAi: false });
    await startSupportSession(superAdmin, s.m.org.id, { mode: "write", reason: "Helping with reviews (write)" });
    const write = await agencyActor(superAdmin, s.m.org.id);
    expect(await replyFactsFor(write)).toMatchObject({ canDraft: true, canPublish: false, canAi: false, userId: superAdmin.id });
  });

  it("never shows one workspace another's reviews", async () => {
    const all1 = (await listPublicReviews(other.owner)).page.rows;
    expect(all1.map((r) => r.comment)).toEqual(["Sample comment theirs-1", "Sample comment theirs-2"]);
    expect(all1.every((r) => r.connectionId === co.id)).toBe(true);
    expect((await listPublicReviews(s.owner)).page.rows.some((r) => r.connectionId === co.id)).toBe(false);
  });
});

describe("linking a review to a customer", () => {
  it("is done by hand by the owner or a manager, audited, shown on the review, and never done for a reviewer who shares a customer's name", async () => {
    const t = await reviewsShop("Link Shop");
    const named = await createContact(t.owner, { firstName: "Nina", lastName: "Newest", email: "nina-newest@example.test" });
    const tc = await connectSim(t, "google", [simReview("n1", { rating: 5, name: "Nina Newest" })]);
    await syncConnection(tc.id, { now: T0 });
    await syncConnection(tc.id, { now: new Date(T0.getTime() + 3_600_000) });
    const review = await mirrored(tc.id, "n1");
    // The same name is not evidence of the same person: after reading twice, there is still no link.
    expect(review.contact_id).toBeNull();
    for (const who of [t.sales, t.support, t.viewer]) await expectError(linkReviewContact(who, review.id, named.id), "forbidden");
    await expectError(linkReviewContact(t.owner, review.id, "00000000-0000-4000-8000-000000000000"), "invalid_input", /one of your customers/);
    await expectError(linkReviewContact(t.owner, "00000000-0000-4000-8000-000000000000", named.id), "not_found");
    await linkReviewContact(t.manager, review.id, named.id);
    const linked = await one<{ contact_id: string; contact_linked_by: string; contact_linked_at: Date }>("select contact_id, contact_linked_by, contact_linked_at from external_reviews where id = $1", [review.id]);
    expect(linked).toMatchObject({ contact_id: named.id, contact_linked_by: t.manager.userId });
    expect((await listPublicReviews(t.owner)).page.rows[0]).toMatchObject({ contactId: named.id, contactName: expect.stringContaining("Nina") });
    expect(await count("select count(*)::text as n from audit_logs where org_id = $1 and action = 'reputation.review_linked' and target_id = $2", [t.m.org.id, review.id])).toBe(1);
    // Reading again keeps the link; unlinking removes it, with who did it.
    await syncConnection(tc.id, { now: new Date(T0.getTime() + 7_200_000) });
    expect((await mirrored(tc.id, "n1")).contact_id).toBe(named.id);
    await linkReviewContact(t.owner, review.id, null);
    expect((await mirrored(tc.id, "n1")).contact_id).toBeNull();
    expect(await count("select count(*)::text as n from audit_logs where org_id = $1 and action = 'reputation.review_unlinked'", [t.m.org.id])).toBe(1);
  });

  it("cannot link another workspace's customer, or be done by iAcquire support", async () => {
    const t = await reviewsShop("Link Iso Shop");
    const u = await reviewsShop("Link Iso Other");
    const tc = await connectSim(t, "google", [simReview("i1")]);
    await syncConnection(tc.id, { now: T0 });
    const theirs = await shopCustomer(u);
    await expectError(linkReviewContact(t.owner, (await mirrored(tc.id, "i1")).id, theirs), "invalid_input", /one of your customers/);
    const { superAdmin } = await agencyPeople();
    await startSupportSession(superAdmin, t.m.org.id, { mode: "write", reason: "Looking at links" });
    await expectError(linkReviewContact(await agencyActor(superAdmin, t.m.org.id), (await mirrored(tc.id, "i1")).id, await shopCustomer(t)), "forbidden");
  });

  it("follows the customer when two records are merged, and is removed when the customer is erased, while the review itself stays", async () => {
    const t = await reviewsShop("Link Merge Shop");
    const tc = await connectSim(t, "google", [simReview("m1"), simReview("m2")]);
    await syncConnection(tc.id, { now: T0 });
    const kept = await shopCustomer(t, { firstName: "Kept" });
    const merged = await shopCustomer(t, { firstName: "Merged" });
    const erased = await shopCustomer(t, { firstName: "Erased" });
    const m1 = (await mirrored(tc.id, "m1")).id;
    const m2 = (await mirrored(tc.id, "m2")).id;
    await linkReviewContact(t.owner, m1, merged);
    await linkReviewContact(t.owner, m2, erased);
    await mergeContacts(t.owner, { keptId: kept, mergedId: merged, reason: "Same person" });
    expect((await mirrored(tc.id, "m1")).contact_id).toBe(kept);
    await redactContact(t.owner, erased, "Privacy request received by email");
    const after = await mirrored(tc.id, "m2");
    expect(after.contact_id).toBeNull();
    expect(after).toMatchObject({ rating: 5, comment: "Sample comment m2" }); // what the site said is the site's
    expect(await one("select contact_linked_by, contact_linked_at from external_reviews where id = $1", [m2])).toEqual({ contact_linked_by: null, contact_linked_at: null });
    expect(await all("select 1 from external_reviews where connection_id = $1", [tc.id])).toHaveLength(2);
  });
});

describe("a reply seen from the list follows its life", () => {
  it("shows an approved reply as approved, with who approved it, and a posted one as answered", async () => {
    const t = await reviewsShop("Reply Display Shop");
    const tc = await connectSim(t, "google", [simReview("x1", { rating: 2 }), simReview("x2", { rating: 2 })]);
    await syncConnection(tc.id, { now: T0 });
    const a = (await mirrored(tc.id, "x1")).id;
    const made = await startReply(t.sales, a, { body: CALM_REPLY });
    await submitReply(t.sales, made.id, { version: 1 });
    await decideReply(t.manager, made.id, { decision: "approve", version: 1 });
    const row = (await listPublicReviews(t.owner)).page.rows.find((r) => r.id === a);
    expect(row?.reply).toMatchObject({ status: "approved", approvedVersion: 1, approvedByName: expect.any(String), authorName: expect.any(String) });
    expect((await replyOf(a)).status).toBe("approved");
    expect((await listPublicReviews(t.owner, { filter: "replied" })).page.total).toBe(0); // approved is not posted: it is still unanswered on the site
  });
});
