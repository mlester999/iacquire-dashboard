// Facebook review access. The Social media sign-in has an option to ask Meta for the permissions to read (and reply to) a Page's recommendations, offered only while reading them is
// switched on; whether a Page may reply is decided by the permissions it was actually given, not by the environment alone; and a reply Facebook refuses for lack of permission
// switches off replies only, without stopping reading or marking the connection as needing to be reconnected. Meta is a replaced Graph layer: nothing reaches it.
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { sealCredentials } from "@/server/social/credentials";
import { startMetaConnect } from "@/server/social/accounts";
import { authorizeUrl } from "@/server/social/providers/meta-oauth";
import { checkConnection, connectFacebookPage, getSites, loadConnection, replyPostable } from "@/server/reputation/connections";
import { createMetaReviewProvider, META_READ_SCOPE, META_REPLY_SCOPE } from "@/server/reputation/providers/meta-reviews";
import { simulatedReviews } from "@/server/reputation/providers/simulated";
import { ProviderError } from "@/server/reputation/providers/types";
import { decideReply, postReply, startReply, submitReply } from "@/server/reputation/replies";
import { syncConnection } from "@/server/reputation/sync";
import { GET as startReviewAccess } from "@/app/api/reputation/oauth/meta/start/route";
import type { GraphCall } from "@/server/social/providers/meta";
import { all, CALM_REPLY, connectSim, count, mirrored, one, reviewsShop, simReview, type ReputationShop } from "./support/reputation";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const session = vi.hoisted(() => ({ ctx: null as unknown }));
vi.mock("@/server/tenancy/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/tenancy/context")>()),
  requireOrgContextOrThrow: async () => session.ctx,
}));

const SETTINGS = { appId: "app-1", appSecret: "secret-1", version: "v26.0", writesEnabled: false };
const BASE_SCOPES = ["pages_show_list", "pages_read_engagement", "pages_manage_posts"];
const saved = { ...process.env };
const ENV_KEYS = ["META_SOCIAL_APP_ID", "META_SOCIAL_APP_SECRET", "META_REVIEWS_ENABLED", "META_REVIEWS_REPLIES_ENABLED"];

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetEnvCache();
  }
}
const APP = { META_SOCIAL_APP_ID: "app-1", META_SOCIAL_APP_SECRET: "app-secret-0123456789" };
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetEnvCache();
});

let s: ReputationShop;
beforeAll(async () => {
  s = await reviewsShop("Meta Access Shop");
});
beforeEach(() => simulatedReviews.reset());

const scopeOf = (url: string) => (new URL(url).searchParams.get("scope") ?? "").split(",");

describe("the sign-in address", () => {
  it("asks for the three Social media permissions by default, and adds the review permissions only when asked, only for Facebook, and the reply permission only with replies", () => {
    const state = "s".repeat(32);
    expect(scopeOf(authorizeUrl(state, "facebook", SETTINGS))).toEqual(BASE_SCOPES);
    expect(scopeOf(authorizeUrl(state, "facebook", SETTINGS, { reviews: true }))).toEqual([...BASE_SCOPES, META_READ_SCOPE]);
    expect(scopeOf(authorizeUrl(state, "facebook", SETTINGS, { reviews: true, replies: true }))).toEqual([...BASE_SCOPES, META_READ_SCOPE, META_REPLY_SCOPE]);
    expect(scopeOf(authorizeUrl(state, "facebook", SETTINGS, { replies: true }))).toEqual(BASE_SCOPES);
    expect(scopeOf(authorizeUrl(state, "instagram", SETTINGS, { reviews: true, replies: true }))).toEqual([...BASE_SCOPES, "instagram_basic", "instagram_content_publish"]);
    // The rest of the address is the ordinary one: a declined permission is asked for again.
    expect(new URL(authorizeUrl(state, "facebook", SETTINGS, { reviews: true })).searchParams.get("auth_type")).toBe("rerequest");
  });
});

describe("starting the sign-in with review access", () => {
  it("is refused while reading Facebook recommendations is not switched on, and leaves no sign-in behind", async () => {
    await withEnv({ ...APP, META_REVIEWS_ENABLED: undefined, META_REVIEWS_REPLIES_ENABLED: undefined }, async () => {
      const before = await count("select count(*)::text as n from social_oauth_states where org_id = $1", [s.m.org.id]);
      await expect(startMetaConnect(s.m.ctx("owner"), "facebook", "/social/accounts", { reviews: true })).rejects.toMatchObject({ code: "unavailable", message: expect.stringMatching(/isn't switched on for iAcquire yet/) });
      expect(await count("select count(*)::text as n from social_oauth_states where org_id = $1", [s.m.org.id])).toBe(before);
      // The ordinary sign-in is not affected by that switch.
      expect(scopeOf((await startMetaConnect(s.m.ctx("owner"), "facebook", "/social/accounts")).url)).toEqual(BASE_SCOPES);
    });
  });

  it("adds the read permission when reading is switched on, the reply permission only when replying is too, and never to the ordinary sign-in", async () => {
    await withEnv({ ...APP, META_REVIEWS_ENABLED: "true", META_REVIEWS_REPLIES_ENABLED: undefined }, async () => {
      expect(scopeOf((await startMetaConnect(s.m.ctx("owner"), "facebook", "/social/accounts", { reviews: true })).url)).toEqual([...BASE_SCOPES, META_READ_SCOPE]);
      expect(scopeOf((await startMetaConnect(s.m.ctx("owner"), "facebook", "/social/accounts")).url)).toEqual(BASE_SCOPES);
    });
    await withEnv({ ...APP, META_REVIEWS_ENABLED: "true", META_REVIEWS_REPLIES_ENABLED: "true" }, async () => {
      expect(scopeOf((await startMetaConnect(s.m.ctx("owner"), "facebook", "/social/accounts", { reviews: true })).url)).toEqual([...BASE_SCOPES, META_READ_SCOPE, META_REPLY_SCOPE]);
      await expect(startMetaConnect(s.m.ctx("owner"), "instagram", "/social/accounts", { reviews: true })).rejects.toMatchObject({ code: "invalid_input" });
      await expect(startMetaConnect(s.m.ctx("sales"), "facebook", "/social/accounts", { reviews: true })).rejects.toMatchObject({ code: "forbidden" });
    });
  });

  it("is started from the Reviews settings by a route that sends the owner to Meta, or back to Settings with a plain reason", async () => {
    const go = (headers: Record<string, string> = {}) => startReviewAccess(new NextRequest("http://localhost:3000/api/reputation/oauth/meta/start", { headers }));
    await withEnv({ ...APP, META_REVIEWS_ENABLED: "true", META_REVIEWS_REPLIES_ENABLED: undefined }, async () => {
      session.ctx = s.m.ctx("owner");
      const ok = await go();
      expect(ok.status).toBe(302);
      const to = new URL(ok.headers.get("location") as string);
      expect(to.hostname).toBe("www.facebook.com");
      expect(scopeOf(to.toString())).toEqual([...BASE_SCOPES, META_READ_SCOPE]);
      expect(ok.headers.get("cache-control")).toBe("no-store");
      expect(ok.headers.get("referrer-policy")).toBe("no-referrer");
      // After Meta, the person lands on the Social media screens, where they choose the Page.
      expect(await one("select return_path from social_oauth_states order by created_at desc limit 1")).toEqual({ return_path: "/social/accounts" });
      const foreign = await go({ "sec-fetch-site": "cross-site" });
      expect(foreign.headers.get("location")).toBe("http://localhost:3000/crm/reviews?tab=settings&site=facebook_expired");
      session.ctx = s.m.ctx("sales");
      expect((await go()).headers.get("location")).toBe("http://localhost:3000/crm/reviews?tab=settings&site=forbidden");
    });
    await withEnv({ ...APP, META_REVIEWS_ENABLED: undefined, META_REVIEWS_REPLIES_ENABLED: undefined }, async () => {
      session.ctx = s.m.ctx("owner");
      const off = await go();
      expect(off.status).toBe(303);
      expect(off.headers.get("location")).toBe("http://localhost:3000/crm/reviews?tab=settings&site=facebook_unavailable");
    });
  });
});

describe("a real Facebook Page connected through the Social media sign-in", () => {
  const PAGE_ID = "100200300";
  const graph = (): GraphCall => async (req) => {
    if (req.method === "GET" && !req.path.includes("/")) return { status: 200, json: { id: req.path, overall_star_rating: 4.5, rating_count: 3 }, retryAfter: null };
    throw new Error(`unplanned request: ${req.method} ${req.path}`);
  };
  const provider = () => createMetaReviewProvider({ graph: graph(), settings: () => SETTINGS, ready: () => true, repliesReady: () => true });
  const addPage = async (shop: ReputationShop, externalId: string, scopes: string[]) =>
    (await one<{ id: string }>(
      `insert into social_accounts (org_id, platform, adapter, external_id, name, credentials, scopes, status, last_checked_at, last_success_at, connected_by, capabilities)
       values ($1, 'facebook', 'meta', $2, 'Harbor Home Page', $3, $4, 'connected', now(), now(), $5, '{}'::jsonb) returning id`,
      [shop.m.org.id, externalId, sealCredentials({ accessToken: "page-token-abc" }), scopes, shop.m.people.owner.id],
    )).id;
  const canReply = async (id: string) => (await one<{ can_reply: boolean }>("select can_reply from review_connections where id = $1", [id])).can_reply;

  it("cannot be connected without the read permission, and the message points to the step that asks for it", async () => {
    await withEnv({ ...APP, META_REVIEWS_ENABLED: "true", META_REVIEWS_REPLIES_ENABLED: "true" }, async () => {
      const id = await addPage(s, "9001", BASE_SCOPES);
      const page = (await getSites(s.owner)).find((x) => x.provider === "facebook")?.pages.find((p) => p.socialAccountId === id);
      expect(page).toMatchObject({ hasPermission: false, connected: false, reconnect: false });
      await expect(connectFacebookPage(s.owner, id, { provider: provider() })).rejects.toMatchObject({ code: "forbidden", message: expect.stringMatching(/Reconnect with review access/) });
      expect(await all("select 1 from review_connections where org_id = $1 and external_location_id = '9001'", [s.m.org.id])).toEqual([]);
    });
  });

  it("reaches 'connected' with the permissions the sign-in granted, and shows replies as postable only when the reply permission was granted too", async () => {
    await withEnv({ ...APP, META_REVIEWS_ENABLED: "true", META_REVIEWS_REPLIES_ENABLED: "true" }, async () => {
      const reads = await addPage(s, PAGE_ID, [...BASE_SCOPES, META_READ_SCOPE]);
      const c = await connectFacebookPage(s.owner, reads, { provider: provider() });
      expect(c).toMatchObject({ provider: "facebook", adapter: "meta", simulated: false, status: "connected", canReply: false });
      // Replies are switched on for iAcquire, but this Page was not given the permission: a check of the connection does not turn them on.
      expect(await checkConnection(s.owner, c.id, { provider: provider() })).toBe("connected");
      expect(await canReply(c.id)).toBe(false);
      const cached = await withSystem((db) => loadConnection(db, s.m.org.id, c.id));
      expect(replyPostable({ adapter: "meta", provider: "facebook", status: "connected", can_reply: cached?.can_reply ?? false })).toMatchObject({ ok: false, reason: expect.stringMatching(/Reconnect the Page with review access in Settings/) });
      // The Page is connected again in Social media with the reply permission; checking the connection now allows replies.
      await withSystem((db) => db.query("update social_accounts set scopes = $2 where id = $1", [reads, [...BASE_SCOPES, META_READ_SCOPE, META_REPLY_SCOPE]]));
      expect(await checkConnection(s.owner, c.id, { provider: provider() })).toBe("connected");
      expect(await canReply(c.id)).toBe(true);
      expect((await one<{ scopes: string[] }>("select scopes from review_connections where id = $1", [c.id])).scopes).toContain(META_REPLY_SCOPE);
      // And the permission being taken away again takes replies away again.
      await withSystem((db) => db.query("update social_accounts set scopes = $2 where id = $1", [reads, [...BASE_SCOPES, META_READ_SCOPE]]));
      await checkConnection(s.owner, c.id, { provider: provider() });
      expect(await canReply(c.id)).toBe(false);
    });
  });

  it("starts a connection able to reply only when the Page already holds the reply permission and replying is switched on", async () => {
    await withEnv({ ...APP, META_REVIEWS_ENABLED: "true", META_REVIEWS_REPLIES_ENABLED: "true" }, async () => {
      const both = await addPage(s, "9002", [...BASE_SCOPES, META_READ_SCOPE, META_REPLY_SCOPE]);
      const c = await connectFacebookPage(s.owner, both, { provider: provider() });
      expect(c.canReply).toBe(true);
    });
    await withEnv({ ...APP, META_REVIEWS_ENABLED: "true", META_REVIEWS_REPLIES_ENABLED: undefined }, async () => {
      const both = await addPage(s, "9003", [...BASE_SCOPES, META_READ_SCOPE, META_REPLY_SCOPE]);
      expect((await connectFacebookPage(s.owner, both, { provider: provider() })).canReply).toBe(false);
    });
  });
});

describe("a reply the site refuses for lack of permission", () => {
  const refused = async (shop: ReputationShop, kind: "permission" | "auth") => {
    const connection = await connectSim(shop, "google", [simReview("pr1", { rating: 2, daysAgo: 3 }), simReview("pr2", { rating: 5, daysAgo: 4 })]);
    await syncConnection(connection.id, { now: new Date() });
    const review = await mirrored(connection.id, "pr1");
    const { id } = await startReply(shop.sales, review.id, { body: CALM_REPLY });
    await submitReply(shop.sales, id, { version: 1 });
    await decideReply(shop.owner, id, { decision: "approve", version: 1 });
    simulatedReviews.failNext("reply", new ProviderError(kind, kind === "permission" ? "The access given to the review site does not allow this." : "The review site no longer accepts this sign-in.", { needsReauth: true }));
    return { connection, replyId: id, status: (await postReply(shop.owner, id)).status };
  };
  const conn = (id: string) => one<{ status: string; can_reply: boolean; status_detail: string | null }>("select status, can_reply, status_detail from review_connections where id = $1", [id]);

  it("switches off replies only: the connection stays connected, reading carries on, and nobody is told to reconnect", async () => {
    const t = await reviewsShop("Permission Reply Shop");
    const r = await refused(t, "permission");
    expect(r.status).toBe("failed");
    expect(await conn(r.connection.id)).toMatchObject({ status: "connected", can_reply: false });
    expect((await conn(r.connection.id)).status_detail).toMatch(/did not allow a reply.*Reviews are still being read/);
    expect(await count("select count(*)::text as n from notifications where org_id = $1 and kind = 'review_connection_attention'", [t.m.org.id])).toBe(0);
    // The reply says what happened, in words, and can be tried again once the access allows it.
    const reply = await one<{ status: string; failure_code: string; failure_message: string }>("select status, failure_code, failure_message from review_replies where id = $1", [r.replyId]);
    expect(reply).toMatchObject({ status: "failed", failure_code: "permission" });
    expect(reply.failure_message).toMatch(/did not allow this reply with the access it was given/);
    expect(await count("select count(*)::text as n from notifications where org_id = $1 and kind = 'review_reply_failed'", [t.m.org.id])).toBeGreaterThan(0);
    // Reading is still done: the next pass reads a new review.
    simulatedReviews.add(r.connection.externalLocationId, simReview("pr3", { rating: 4, daysAgo: 0 }));
    expect(await syncConnection(r.connection.id, { now: new Date(Date.now() + 2 * 3_600_000) })).toMatchObject({ status: "synced", inserted: 1 });
    // And the screen no longer offers to post through it.
    expect(replyPostable({ adapter: "simulated", provider: "google", status: "connected", can_reply: false })).toMatchObject({ ok: false });
  });

  it("still marks a connection whose sign-in the site rejected as needing to be reconnected", async () => {
    const t = await reviewsShop("Auth Reply Shop");
    const r = await refused(t, "auth");
    expect(r.status).toBe("failed");
    expect(await conn(r.connection.id)).toMatchObject({ status: "needs_reauth", can_reply: false });
    expect(await count("select count(*)::text as n from notifications where org_id = $1 and kind = 'review_connection_attention'", [t.m.org.id])).toBeGreaterThan(0);
  });
});
