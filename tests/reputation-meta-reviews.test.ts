// The Facebook Page recommendations adapter, against a REPLACED GRAPH LAYER. Nothing here reaches Meta: every answer is written by the test. That is all this proves. The edge
// and field names (ratings, recommendation_type, review_text, comments) and the permission names come from memory of Meta's public reference and have never run against the real
// service; whether a Page can read recommendations or reply to them at all depends on Meta's app review and must be checked against Meta's current documentation first.
import { describe, expect, it } from "vitest";
import { createMetaReviewProvider, META_READ_SCOPE, META_REPLY_SCOPE, metaRepliesReady, metaReviewsReady } from "@/server/reputation/providers/meta-reviews";
import { siteEnvironment } from "@/server/reputation/providers";
import type { GraphCall, GraphRequest, GraphResponse, MetaSettings } from "@/server/social/providers/meta";
import type { LocationRef } from "@/server/reputation/providers/types";

async function expectError(p: Promise<unknown>, kind: string) {
  const err = await p.then(() => null, (e: unknown) => e as { kind?: string; message?: string; needsReauth?: boolean; retryAfterSec?: number | null });
  expect(err, "expected a refusal").not.toBeNull();
  expect(err?.kind).toBe(kind);
  return err as { kind: string; message: string; needsReauth: boolean; retryAfterSec: number | null };
}

const SETTINGS: MetaSettings = { appId: "app-1", appSecret: "secret-1", version: "v26.0", writesEnabled: false };
const PAGE: LocationRef = { provider: "facebook", accountId: null, locationId: "100200300" };
const creds = { accessToken: "page-token-abc" };

type Handler = (req: GraphRequest, n: number) => Partial<GraphResponse> | Error;
/** A replaced Graph layer: answers by method and path, records every request, and fails loudly for a request nobody planned. */
function fakeGraph(routes: Record<string, Handler>) {
  const calls: GraphRequest[] = [];
  const counts = new Map<string, number>();
  const graph: GraphCall = async (req) => {
    calls.push(req);
    const key = `${req.method} ${req.path}`;
    const handler = routes[key];
    if (!handler) throw new Error(`unplanned request: ${key}`);
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    const out = handler(req, n);
    if (out instanceof Error) throw out;
    return { status: 200, json: null, retryAfter: null, ...out };
  };
  return { graph, calls };
}
const provider = (routes: Record<string, Handler>, over: { ready?: boolean; repliesReady?: boolean } = {}) => {
  const f = fakeGraph(routes);
  return { f, p: createMetaReviewProvider({ graph: f.graph, settings: () => SETTINGS, ready: () => over.ready ?? true, repliesReady: () => over.repliesReady ?? true }) };
};
const RATINGS = "GET 100200300/ratings";
const SUMMARY = "GET 100200300";
const error = (code: number, over: Record<string, unknown> = {}) => ({ status: 400, json: { error: { message: "Graph said no", code, ...over } } });

describe("while Meta has not approved iAcquire", () => {
  it("reads and writes nothing, whichever way it is called, and says why in words", async () => {
    const { f, p } = provider({}, { ready: false, repliesReady: false });
    for (const call of [() => p.health(creds, PAGE), () => p.fetchPage(creds, PAGE, null, 10), () => p.postReply(creds, PAGE, "c1", "Thanks."), () => p.readReply(creds, PAGE, "c1", "Thanks.")]) {
      const e = await expectError(call(), "blocked");
      expect(e.message).toMatch(/not switched on in this environment/);
    }
    expect(f.calls).toHaveLength(0);
    expect(p.replySupport()).toMatchObject({ ok: false, reason: expect.stringMatching(/isn't switched on for iAcquire yet/) });
    // The real deployment's switches are off: nothing can be connected, and the screen names what is missing without naming a setting.
    expect(metaReviewsReady()).toBe(false);
    expect(metaRepliesReady()).toBe(false);
    const env = siteEnvironment("facebook");
    expect(env).toMatchObject({ ready: false, repliesReady: false });
    expect(env.missing).toMatch(/Meta hasn't approved iAcquire to read recommendations/);
    expect(env.missing).not.toMatch(/META_|_ENABLED/);
    expect([META_READ_SCOPE, META_REPLY_SCOPE]).toEqual(["pages_read_user_content", "pages_manage_engagement"]);
  });

  it("will read but not reply while the reply switch is off", async () => {
    const { f, p } = provider({ [RATINGS]: () => ({ json: { data: [] } }), [SUMMARY]: () => ({ json: {} }) }, { repliesReady: false });
    await p.fetchPage(creds, PAGE, null, 10);
    await expectError(p.postReply(creds, PAGE, "c1", "Thanks."), "blocked");
    expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect((await provider({ [SUMMARY]: () => ({ json: { id: "1" } }) }, { repliesReady: false }).p.health(creds, PAGE)).canReply).toBe(false);
  });
});

describe("reading recommendations", () => {
  it("asks the Page's ratings edge with its own token in the request's token field, and reads positive and negative recommendations and old star ratings as Facebook said them", async () => {
    const { f, p } = provider({
      [RATINGS]: () => ({
        json: {
          data: [
            { open_graph_story: { id: "story-1" }, recommendation_type: "positive", review_text: "Lovely people.", created_time: "2026-10-01T10:00:00+0000", reviewer: { id: "u1", name: "Alex Doe" } },
            { open_graph_story: { id: "story-2" }, recommendation_type: "negative", review_text: "Slow.", created_time: "2026-10-02T10:00:00+0000", reviewer: { id: "u2", name: "Sam Roe" } },
            { open_graph_story: { id: "story-3" }, rating: 4, review_text: "Old style.", created_time: "2026-09-01T10:00:00+0000", reviewer: { id: "u3" } },
            { recommendation_type: "positive", created_time: "2026-10-03T10:00:00+0000", reviewer: { id: "u4", name: "No Story" } },
            { recommendation_type: "positive", reviewer: { id: "u5" } }, { open_graph_story: { id: "story-6" } }, { open_graph_story: { id: "story-7" }, rating: 9 },
          ],
          paging: { next: "https://graph.example.test/next", cursors: { after: "cursor-2" } },
        },
      }),
      [SUMMARY]: () => ({ json: { overall_star_rating: 4.6, rating_count: 33 } }),
    });
    const out = await p.fetchPage(creds, PAGE, null, 500);
    const ratings = f.calls.find((c) => c.path === "100200300/ratings") as GraphRequest;
    expect(ratings).toMatchObject({ method: "GET", token: "page-token-abc", sent: false });
    expect(ratings.params).toMatchObject({ limit: "50" });
    expect(ratings.params?.fields).toContain("recommendation_type");
    expect(ratings.params).not.toHaveProperty("after");
    expect(out.reviews.map((r) => [r.providerReviewId, r.rating, r.recommends])).toEqual([["story-1", null, true], ["story-2", null, false], ["story-3", 4, null], [`u4:${Date.parse("2026-10-03T10:00:00Z")}`, null, true]]);
    expect(out.reviews[0]).toMatchObject({ reviewerName: "Alex Doe", reviewerAnonymous: false, comment: "Lovely people.", reply: null });
    expect(out.reviews[2]).toMatchObject({ reviewerName: null, reviewerAnonymous: true });
    // Entries with no id, or neither a recommendation nor stars, are skipped and counted, never invented.
    expect(out.skipped).toBe(3);
    expect(out).toMatchObject({ nextPageToken: "cursor-2", reportedRating: 4.6, reportedCount: 33 });
  });

  it("asks the Page's own summary only with the first page, and does without it when it cannot be had", async () => {
    const { f, p } = provider({ [RATINGS]: () => ({ json: { data: [] } }), [SUMMARY]: () => error(100) });
    expect(await p.fetchPage(creds, PAGE, null, 10)).toMatchObject({ reportedRating: null, reportedCount: null, nextPageToken: null });
    await p.fetchPage(creds, PAGE, "cursor-2", 10);
    expect(f.calls.filter((c) => c.path === "100200300")).toHaveLength(1);
    expect(f.calls.at(-1)?.params).toMatchObject({ after: "cursor-2" });
    const odd = provider({ [RATINGS]: () => ({ json: { data: [] } }), [SUMMARY]: () => ({ json: { overall_star_rating: 7, rating_count: -1 } }) });
    expect(await odd.p.fetchPage(creds, PAGE, null, 10)).toMatchObject({ reportedRating: null, reportedCount: null });
  });

  it("says plainly what went wrong, and whether only a reconnection helps", async () => {
    const cases: Array<[Partial<GraphResponse> | Error, string, boolean]> = [
      [error(190), "auth", true], [error(200), "permission", true], [error(4), "rate_limited", false], [{ status: 429, retryAfter: "60" }, "rate_limited", false],
      [error(100), "invalid_content", false], [{ status: 503, json: { error: { message: "down", code: 2 } } }, "transient", false], [new Error("socket hang up"), "transient", false],
    ];
    for (const [answer, kind, reauth] of cases) {
      const { p } = provider({ [RATINGS]: () => answer });
      const e = await expectError(p.fetchPage(creds, PAGE, null, 10), kind);
      expect(e.needsReauth, JSON.stringify(answer)).toBe(reauth);
      expect(JSON.stringify(e)).not.toContain("page-token-abc");
    }
  });

  it("checks a Page by asking for its summary: working, needing a reconnection, or missing the permission to read recommendations", async () => {
    const ok = provider({ [SUMMARY]: () => ({ json: { id: "100200300" } }) });
    expect(await ok.p.health(creds, PAGE)).toEqual({ status: "connected", detail: "Connected.", scopes: [], canReply: true });
    expect(ok.f.calls[0].params).toMatchObject({ fields: "id,overall_star_rating,rating_count" });
    expect(await provider({ [SUMMARY]: () => error(190) }).p.health(creds, PAGE)).toMatchObject({ status: "needs_reauth", canReply: false });
    expect(await provider({ [SUMMARY]: () => error(200) }).p.health(creds, PAGE)).toMatchObject({ status: "needs_permission", canReply: false });
    await expectError(provider({ [SUMMARY]: () => ({ status: 500, json: { error: { code: 2, message: "down" } } }) }).p.health(creds, PAGE), "transient");
  });
});

describe("replying", () => {
  const POST = "POST story-1/comments";

  it("adds the words as a comment on that one recommendation, once, and says when Facebook took it", async () => {
    const { f, p } = provider({ [POST]: () => ({ json: { id: "comment-1" } }) });
    const out = await p.postReply(creds, PAGE, "story-1", "Thank you for writing.");
    expect(out.postedAt).toBeInstanceOf(Date);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ method: "POST", path: "story-1/comments", token: "page-token-abc", sent: true, params: { message: "Thank you for writing." } });
  });

  it("treats an answer with no comment id, a server error or a lost answer as unknown, and a refusal as a refusal", async () => {
    for (const answer of [{ json: {} }, { status: 500, json: { error: { message: "down", code: 2 } } }, new Error("socket hang up")] as const) {
      const e = await expectError(provider({ [POST]: () => answer }).p.postReply(creds, PAGE, "story-1", "Thanks."), "unknown_outcome");
      expect(e.message).toMatch(/will not be sent again until that is known/);
    }
    await expectError(provider({ [POST]: () => error(190) }).p.postReply(creds, PAGE, "story-1", "Thanks."), "auth");
    await expectError(provider({ [POST]: () => error(200) }).p.postReply(creds, PAGE, "story-1", "Thanks."), "permission");
    await expectError(provider({ [POST]: () => error(100) }).p.postReply(creds, PAGE, "story-1", "Thanks."), "invalid_content");
  });

  it("looks for the Page's own comment word for word, accepts no one else's, and says when it cannot be sure", async () => {
    const COMMENTS = "GET story-1/comments";
    const comments = (data: unknown[], more = false) => provider({ [COMMENTS]: () => ({ json: { data, ...(more ? { paging: { next: "https://graph.example.test/more" } } : {}) } }) });
    const own = (message: string) => ({ from: { id: "100200300" }, message, created_time: "2026-10-04T09:00:00+0000" });
    const theirs = { from: { id: "someone-else" }, message: "Thanks for writing.", created_time: "2026-10-04T09:00:00+0000" };
    const hit = await comments([theirs, own("  Thanks  for\nwriting. ")]).p.readReply(creds, PAGE, "story-1", "Thanks for writing.");
    expect(hit).toMatchObject({ state: "found", text: "Thanks for writing." });
    // Someone else's comment with the same words is not the Page's reply.
    expect(await comments([theirs]).p.readReply(creds, PAGE, "story-1", "Thanks for writing.")).toEqual({ state: "absent" });
    // A different comment from the Page itself is reported as it is, so the caller can see it is not this reply.
    expect(await comments([own("Something else entirely.")]).p.readReply(creds, PAGE, "story-1", "Thanks for writing.")).toMatchObject({ state: "found", text: "Something else entirely." });
    // A list that goes on past what was read cannot prove the reply is absent.
    expect(await comments([theirs], true).p.readReply(creds, PAGE, "story-1", "Thanks for writing.")).toEqual({ state: "uncertain" });
    const asked = comments([]);
    await asked.p.readReply(creds, PAGE, "story-1", "x");
    expect(asked.f.calls[0]).toMatchObject({ method: "GET", sent: false, params: { filter: "stream", limit: "50" } });
  });
});
