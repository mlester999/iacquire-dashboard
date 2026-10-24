// Reconnecting a review site. The same location comes back to the workspace that had it: a connection that needs reconnecting has its sign-in replaced in place, and one a person
// disconnected gets its own connection back with the reviews it read and the replies written to them, so nothing is shown twice, nothing is announced twice and no reply is stranded.
// A different workspace never adopts another's reviews. The review site is the in-process simulated one; nothing reaches a real service.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { connectSimulatedAccount, disconnectAccount } from "@/server/social/accounts";
import { checkConnection, connectFacebookPage, connectSimulatedSite, disconnectConnection, getSites, listConnections } from "@/server/reputation/connections";
import { MIRROR_DAYS_AFTER_DISCONNECT, purgeReputationRecords } from "@/server/reputation/housekeeping";
import { getConnectionSummaries, listPublicReviews } from "@/server/reputation/public-reviews";
import { simulatedReviews } from "@/server/reputation/providers/simulated";
import { decideReply, postReply, startReply, submitReply } from "@/server/reputation/replies";
import { syncConnection } from "@/server/reputation/sync";
import { eventsFor } from "./support/crm";
import { all, CALM_REPLY, connectSim, count, mirrored, one, reviewsShop, simReview, type ReputationShop } from "./support/reputation";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const HOUR = 3_600_000;
const T0 = new Date();
let s: ReputationShop;
let other: ReputationShop;
beforeAll(async () => {
  s = await reviewsShop("Reconnect Shop");
  other = await reviewsShop("Other Reconnect Shop");
});
beforeEach(() => simulatedReviews.reset());

const row = (id: string) => one<{ status: string; status_detail: string | null; social_account_id: string | null; disconnected_at: Date | null; last_complete_at: Date | null; credentials: string | null; can_reply: boolean }>(
  "select status, status_detail, social_account_id, disconnected_at, last_complete_at, credentials, can_reply from review_connections where id = $1", [id],
);
const connections = (orgId: string) => count("select count(*)::text as n from review_connections where org_id = $1", [orgId]);
const alerts = (reviewId: string) => count("select count(*)::text as n from notifications where dedupe_key = $1", [`review-low:${reviewId}`]);
const announcements = async (orgId: string, reviewId: string) => (await eventsFor(orgId, "review.external_received")).filter((e) => e.entity_id === reviewId).length;

/** A Facebook Page connected for Social media (the simulated stand-in, with a Page id we choose so it can be connected again), and the review connection read through it. */
async function page(shop: ReputationShop, externalId: string, seed: ReturnType<typeof simReview>[]) {
  const social = await connectSimulatedAccount(shop.m.ctx("owner"), { platform: "facebook", name: `Page ${externalId}`, externalId });
  simulatedReviews.seed(externalId, seed);
  const connection = await connectFacebookPage(shop.owner, social.id);
  return { social, connection };
}

describe("a site a person disconnected, connected again", () => {
  it("gets the same connection back with its reviews and replies, and nothing is shown twice or announced twice", async () => {
    const { social, connection } = await page(s, "fb-again-1", [simReview("old-low", { rating: 1, daysAgo: 1 }), simReview("old-mid", { rating: 3, daysAgo: 3 }), simReview("old-high", { rating: 5, daysAgo: 10 })]);
    expect((await syncConnection(connection.id, { now: T0 })).inserted).toBe(3);
    const low = await mirrored(connection.id, "old-low");
    const mid = await mirrored(connection.id, "old-mid");
    // A reply is being written to one of them, and another was answered on the site itself.
    const { id: replyId } = await startReply(s.sales, mid.id, { body: CALM_REPLY });
    expect(await alerts(low.id)).toBeGreaterThan(0);
    const alertedBefore = await alerts(low.id);
    const eventsBefore = (await eventsFor(s.m.org.id, "review.external_received")).length;

    await disconnectConnection(s.owner, connection.id);
    simulatedReviews.add("fb-again-1", simReview("gap-low", { rating: 2, daysAgo: 1 })); // it arrived while the site was disconnected
    const back = await connectFacebookPage(s.owner, social.id);
    expect(back.id).toBe(connection.id);
    expect(back).toMatchObject({ status: "connected", disconnectedAt: null, socialAccountId: social.id });
    expect((await listConnections(s.owner, { includePast: true })).filter((c) => c.externalLocationId === "fb-again-1")).toHaveLength(1);

    const out = await syncConnection(back.id, { now: new Date(T0.getTime() + HOUR) });
    // Only the review that arrived in the gap is new; the three read before are the same rows, and they are not announced again.
    expect(out).toMatchObject({ status: "synced", inserted: 1 });
    expect(await count("select count(*)::text as n from external_reviews where org_id = $1 and connection_id = $2", [s.m.org.id, connection.id])).toBe(4);
    expect(await count("select count(*)::text as n from external_reviews where org_id = $1 and provider_review_id like 'old-%'", [s.m.org.id])).toBe(3);
    expect((await mirrored(connection.id, "old-low")).id).toBe(low.id);
    expect(await alerts(low.id)).toBe(alertedBefore);
    const gap = await mirrored(connection.id, "gap-low");
    expect(await announcements(s.m.org.id, gap.id)).toBe(1);
    expect(await announcements(s.m.org.id, low.id)).toBe(1);
    expect((await eventsFor(s.m.org.id, "review.external_received")).length).toBe(eventsBefore + 1);
    // The reply written before stays on its review and can still be worked on.
    expect(await one("select status, review_id from review_replies where id = $1", [replyId])).toMatchObject({ status: "draft", review_id: mid.id });
    await submitReply(s.sales, replyId, { version: 1 });
    await decideReply(s.owner, replyId, { decision: "approve", version: 1 });
    expect(await checkConnection(s.owner, back.id)).toBe("connected"); // a Facebook connection learns whether it may reply when it is checked
    expect((await postReply(s.owner, replyId)).status).toBe("posted");

    // What the screens count is not doubled: four reviews, one site, a weekly chart that adds up to four.
    const list = await listPublicReviews(s.owner, { filter: "all", pageSize: 50 });
    expect(list.counts.all).toBe(4);
    expect(list.page.rows.filter((r) => r.connectionId === connection.id)).toHaveLength(4);
    const sums = await getConnectionSummaries(s.owner);
    expect(sums.summaries.filter((x) => x.connectionId === connection.id)).toHaveLength(1);
    expect(sums.weekly.reduce((n, w) => n + w.count, 0)).toBe(4);
    expect((await getSites(s.owner)).find((x) => x.provider === "facebook")?.past).toEqual([]);
  });

  it("does the same through a Page that was disconnected and connected again in Social media, which comes back as a new account", async () => {
    const { social, connection } = await page(s, "fb-again-2", [simReview("p1", { rating: 4, daysAgo: 5 }), simReview("p2", { rating: 2, daysAgo: 6 })]);
    await syncConnection(connection.id, { now: T0 });
    await disconnectConnection(s.owner, connection.id);
    await disconnectAccount(s.m.ctx("owner"), social.id);
    const again = await connectSimulatedAccount(s.m.ctx("owner"), { platform: "facebook", name: "Page fb-again-2", externalId: "fb-again-2" });
    expect(again.id).not.toBe(social.id);
    const back = await connectFacebookPage(s.owner, again.id);
    expect(back).toMatchObject({ id: connection.id, status: "connected", socialAccountId: again.id });
    expect((await row(connection.id)).social_account_id).toBe(again.id);
    expect(await syncConnection(back.id, { now: new Date(T0.getTime() + HOUR) })).toMatchObject({ status: "synced", inserted: 0 });
    expect(await count("select count(*)::text as n from external_reviews where org_id = $1 and connection_id = $2", [s.m.org.id, connection.id])).toBe(2);
  });

  it("treats a site disconnected for longer than the reviews are kept as new: what was purged is history on the first read again, not news", async () => {
    const { social, connection } = await page(s, "fb-again-3", [simReview("q1", { rating: 1, daysAgo: 40 }), simReview("q2", { rating: 5, daysAgo: 60 })]);
    await syncConnection(connection.id, { now: T0 });
    expect((await row(connection.id)).last_complete_at).not.toBeNull();
    await disconnectConnection(s.owner, connection.id);
    const long = new Date(Date.now() - (MIRROR_DAYS_AFTER_DISCONNECT + 10) * 86_400_000);
    await withSystem((db) => db.query("update review_connections set disconnected_at = $2 where id = $1", [connection.id, long]));
    expect((await purgeReputationRecords()).disconnectedReviews).toBeGreaterThanOrEqual(2);
    const before = (await eventsFor(s.m.org.id, "review.external_received")).length;
    const back = await connectFacebookPage(s.owner, social.id);
    expect(back.id).toBe(connection.id);
    expect((await row(connection.id)).last_complete_at).toBeNull();
    // Both reviews come back as rows, but they are older than a couple of days, so the first read does not announce them as news.
    expect(await syncConnection(back.id, { now: new Date(T0.getTime() + HOUR) })).toMatchObject({ inserted: 2, announced: 0 });
    expect((await eventsFor(s.m.org.id, "review.external_received")).length).toBe(before);
  });
});

describe("a test site", () => {
  it("comes back as the same test site when the button that asks for it is used again, so its sample reviews are not listed twice, and is a new site for any other caller", async () => {
    const t = await reviewsShop("Test Site Again Shop");
    const first = await connectSim(t, "google", [simReview("ts1", { rating: 4, daysAgo: 5 }), simReview("ts2", { rating: 2, daysAgo: 6 })]);
    await syncConnection(first.id, { now: T0 });
    await disconnectConnection(t.owner, first.id);
    const back = await connectSimulatedSite(t.owner, { provider: "google", reuseEarlier: true });
    expect(back).toMatchObject({ id: first.id, status: "connected", externalLocationId: first.externalLocationId, simulated: true });
    expect(await syncConnection(back.id, { now: new Date(T0.getTime() + HOUR) })).toMatchObject({ status: "synced", inserted: 0 });
    expect((await listPublicReviews(t.owner, { filter: "all", pageSize: 50 })).counts.all).toBe(2);
    // A site that is live is never reopened over, another provider's is not this one's, and a caller that does not ask gets a new site each time.
    const other = await connectSimulatedSite(t.owner, { provider: "facebook", reuseEarlier: true });
    expect(other.id).not.toBe(first.id);
    await disconnectConnection(t.owner, first.id);
    const fresh = await connectSimulatedSite(t.owner, { provider: "google" });
    expect(fresh.id).not.toBe(first.id);
    expect(fresh.externalLocationId).not.toBe(first.externalLocationId);
  });
});

describe("a connection that needs reconnecting", () => {
  it("has its sign-in replaced in place when the same site is connected again: no refusal, no second connection, nothing lost", async () => {
    const { social, connection } = await page(s, "fb-broken-1", [simReview("b1", { rating: 2, daysAgo: 4 })]);
    await syncConnection(connection.id, { now: T0 });
    simulatedReviews.revoke("sim_valid");
    expect(await checkConnection(s.owner, connection.id)).toBe("needs_reauth");
    expect(await row(connection.id)).toMatchObject({ status: "needs_reauth" });
    simulatedReviews.reset();
    simulatedReviews.seed("fb-broken-1", [simReview("b1", { rating: 2, daysAgo: 4 }), simReview("b2", { rating: 5, daysAgo: 1 })]);
    // The Page offers itself for reconnecting, rather than showing as "connected".
    const option = (await getSites(s.owner)).find((x) => x.provider === "facebook")?.pages.find((p) => p.socialAccountId === social.id);
    expect(option).toMatchObject({ connected: false, reconnect: true });
    const before = await connections(s.m.org.id);
    const back = await connectFacebookPage(s.owner, social.id);
    expect(back).toMatchObject({ id: connection.id, status: "connected", statusDetail: null });
    expect(await connections(s.m.org.id)).toBe(before);
    expect(await syncConnection(back.id, { now: new Date(T0.getTime() + HOUR) })).toMatchObject({ status: "synced", inserted: 1 });
    expect(await count("select count(*)::text as n from audit_logs where org_id = $1 and action = 'reputation.connection_reconnected' and target_id = $2", [s.m.org.id, connection.id])).toBe(1);
    // A connection that works is not "reconnected" over the top of itself: connecting the same Page again is still refused.
    await expect(connectFacebookPage(s.owner, social.id)).rejects.toMatchObject({ code: "conflict" });
    expect((await getSites(s.owner)).find((x) => x.provider === "facebook")?.pages.find((p) => p.socialAccountId === social.id)).toMatchObject({ connected: true, reconnect: false });
  });
});

describe("two workspaces", () => {
  it("never adopt each other's connections or reviews, even for a site with the same address", async () => {
    const mine = await page(s, "fb-shared-1", [simReview("m1", { rating: 5, daysAgo: 8 })]);
    await syncConnection(mine.connection.id, { now: T0 });
    await disconnectConnection(s.owner, mine.connection.id);
    const theirs = await page(other, "fb-shared-1", [simReview("t1", { rating: 4, daysAgo: 9 })]);
    expect(theirs.connection.id).not.toBe(mine.connection.id);
    await syncConnection(theirs.connection.id, { now: T0 });
    expect(await count("select count(*)::text as n from external_reviews where connection_id = $1", [theirs.connection.id])).toBe(1);
    expect(await all("select 1 from external_reviews where org_id = $1 and provider_review_id = 'm1'", [other.m.org.id])).toEqual([]);
    expect(await count("select count(*)::text as n from external_reviews where connection_id = $1", [mine.connection.id])).toBe(1);
    expect((await row(mine.connection.id)).status).toBe("disconnected");
    // Coming back, the first workspace still gets its own.
    const back = await connectFacebookPage(s.owner, mine.social.id);
    expect(back.id).toBe(mine.connection.id);
    expect((await listPublicReviews(other.owner, { filter: "all" })).page.rows.map((r) => r.connectionId)).toEqual([theirs.connection.id]);
  });
});
