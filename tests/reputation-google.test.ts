// The Google Business Profile adapter and the sign-in that connects it, against a REPLACED HTTP LAYER. Nothing here reaches Google: every answer is written by the test. That is all
// this proves. The endpoint and field names the adapter uses come from memory of Google's public reference and have never run against the real service (Google has not approved
// iAcquire's access); they must be re-read against Google's current documentation before approval is applied for.
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { decryptSecret } from "@/server/security/crypto";
import {
  GOOGLE_SCOPE, GOOGLE_TOKEN, createGoogleProvider, googleReady, googleRedirectUri, type GoogleSettings, type HttpCall, type HttpRequest, type HttpResponse,
} from "@/server/reputation/providers/google";
import { siteEnvironment } from "@/server/reputation/providers";
import type { LocationRef } from "@/server/reputation/providers/types";
import { completeGoogleConnect, connectChosenLocation, pendingLocations, safeReturn, startGoogleConnect, listConnections, STATE_MINUTES } from "@/server/reputation/connections";
import { setReviews, reviewsShop, one, all, type ReputationShop } from "./support/reputation";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

async function expectError(p: Promise<unknown>, code?: string, message?: RegExp) {
  const err = await p.then(() => null, (e: unknown) => e as { code?: string; kind?: string; message?: string });
  expect(err, "expected a refusal").not.toBeNull();
  if (code) expect(err?.code ?? err?.kind).toBe(code);
  if (message) expect(err?.message).toMatch(message);
  return err as { code?: string; kind?: string; message?: string; needsReauth?: boolean; retryAfterSec?: number | null; httpStatus?: number | null };
}

const ON: GoogleSettings = { approved: true, clientId: "client-123.apps.example.test", clientSecret: "client-secret-xyz", repliesEnabled: true };
const READ_ONLY: GoogleSettings = { ...ON, repliesEnabled: false };
const LOC: LocationRef = { provider: "google", accountId: "accounts/111", locationId: "locations/222" };
const REVIEWS = "https://mybusiness.googleapis.com/v4/accounts/111/locations/222/reviews";
const creds = { refreshToken: "1//refresh-token-abc" };

type Handler = (req: HttpRequest, n: number) => Partial<HttpResponse> | Error;
/** A replaced HTTP layer: answers by method and path (the query is ignored), records every request, and fails loudly for a request nobody planned. */
function fakeHttp(routes: Record<string, Handler>) {
  const calls: HttpRequest[] = [];
  const counts = new Map<string, number>();
  const http: HttpCall = async (req) => {
    calls.push(req);
    const key = `${req.method} ${req.url.split("?")[0]}`;
    const handler = routes[key];
    if (!handler) throw new Error(`unplanned request: ${key}`);
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    const out = handler(req, n);
    if (out instanceof Error) throw out;
    return { status: 200, json: null, retryAfter: null, ...out };
  };
  return { http, calls, count: (key: string) => counts.get(key) ?? 0 };
}
const TOKEN_OK: Handler = () => ({ json: { access_token: "access-1", expires_in: 3600 } });
const TOKEN = `POST ${GOOGLE_TOKEN}`;
const bearer = (req: HttpRequest) => req.headers?.Authorization;

const page = (reviews: Array<Record<string, unknown> | null>, extra: Record<string, unknown> = {}) => ({ reviews, averageRating: 4.5, totalReviewCount: 41, ...extra });
const rev = (id: string, stars: string, over: Record<string, unknown> = {}) => ({
  reviewId: id, starRating: stars, comment: `Comment for ${id}`, reviewer: { displayName: `Person ${id}`, isAnonymous: false }, createTime: "2026-10-01T10:00:00Z", updateTime: "2026-10-02T10:00:00Z", ...over,
});

describe("while Google has not approved iAcquire", () => {
  it("asks Google nothing at all, whichever way it is called, and says why in words", async () => {
    const off: GoogleSettings = { approved: false, clientId: null, clientSecret: null, repliesEnabled: false };
    const f = fakeHttp({});
    const g = createGoogleProvider({ http: f.http, settings: () => off });
    for (const call of [() => g.health(creds, LOC), () => g.fetchPage(creds, LOC, null, 10), () => g.postReply(creds, LOC, "r1", "Thanks."), () => g.readReply(creds, LOC, "r1", "Thanks."), () => g.listLocations("x"), () => g.exchangeCode("c", "v")]) {
      const e = await expectError(call(), "blocked");
      expect(e.message).toMatch(/not switched on in this environment|not switched on/);
    }
    expect(() => g.authorizeUrl("state", "challenge")).toThrow(/not set up/);
    expect(f.calls).toHaveLength(0);
    expect(googleReady(off)).toBe(false);
    expect(googleReady({ approved: true, clientId: "a", clientSecret: null, repliesEnabled: true })).toBe(false);
    expect(googleReady({ approved: false, clientId: "a", clientSecret: "b", repliesEnabled: true })).toBe(false);
    expect(googleReady(ON)).toBe(true);
    // The real deployment's switches are off: nothing can be connected, and the screen says what is missing without naming a setting.
    const env = siteEnvironment("google");
    expect(env.ready).toBe(false);
    expect(env.missing).toMatch(/hasn't approved iAcquire's access to Business Profile reviews/);
    expect(env.missing).not.toMatch(/GOOGLE_|_ENABLED|_APPROVED/);
  });

  it("will read but not reply while the reply switch is off", async () => {
    const f = fakeHttp({ [TOKEN]: TOKEN_OK, [`GET ${REVIEWS}`]: () => ({ json: page([]) }) });
    const g = createGoogleProvider({ http: f.http, settings: () => READ_ONLY });
    expect(g.replySupport()).toMatchObject({ ok: false, reason: expect.stringMatching(/isn't switched on for iAcquire yet/) });
    await g.fetchPage(creds, LOC, null, 10);
    await expectError(g.postReply(creds, LOC, "r1", "Thanks."), "blocked", /switched off/);
    expect(f.calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    expect((await g.health(creds, LOC)).canReply).toBe(false);
    expect(createGoogleProvider({ http: f.http, settings: () => ON }).replySupport()).toEqual({ ok: true });
  });
});

describe("reading reviews", () => {
  it("signs in with the saved refresh token, asks for one page of the newest reviews, and reads what Google returned as Google said it", async () => {
    const f = fakeHttp({
      [TOKEN]: TOKEN_OK,
      [`GET ${REVIEWS}`]: () => ({
        json: page([
          rev("r1", "FIVE"), rev("r2", "TWO", { reviewReply: { comment: "Thanks, we'll look into it.", updateTime: "2026-10-03T10:00:00Z" } }),
          rev("r3", "FOUR", { reviewer: { displayName: "A Google user", isAnonymous: true }, comment: undefined }), rev("r4", "STAR_RATING_UNSPECIFIED"), { reviewId: "r5" }, null,
        ], { nextPageToken: "tok-2" }),
      }),
    });
    const g = createGoogleProvider({ http: f.http, settings: () => ON });
    const out = await g.fetchPage(creds, LOC, null, 200);
    // The refresh token is exchanged with the project's client; the access token travels in a header; the page is asked for newest first and never larger than 50.
    const t = f.calls[0];
    expect(t.method).toBe("POST");
    const form = new URLSearchParams(t.body);
    expect(Object.fromEntries(form)).toEqual({ client_id: ON.clientId, client_secret: ON.clientSecret, refresh_token: creds.refreshToken, grant_type: "refresh_token" });
    const r = f.calls[1];
    expect(bearer(r)).toBe("Bearer access-1");
    expect(r.url).not.toContain("access-1");
    const u = new URL(r.url);
    expect(u.searchParams.get("pageSize")).toBe("50");
    expect(u.searchParams.get("orderBy")).toBe("updateTime desc");
    expect(u.searchParams.has("pageToken")).toBe(false);
    expect(out.reviews.map((x) => [x.providerReviewId, x.rating, x.recommends])).toEqual([["r1", 5, null], ["r2", 2, null], ["r3", 4, null]]);
    expect(out.reviews[0]).toMatchObject({ reviewerName: "Person r1", reviewerAnonymous: false, comment: "Comment for r1", reply: null });
    expect(out.reviews[0].createdAt?.toISOString()).toBe("2026-10-01T10:00:00.000Z");
    expect(out.reviews[1].reply).toEqual({ text: "Thanks, we'll look into it.", at: new Date("2026-10-03T10:00:00Z") });
    expect(out.reviews[2]).toMatchObject({ reviewerName: null, reviewerAnonymous: true, comment: null });
    // Entries without stars are skipped and counted, not invented: the mirror holds what Google said.
    expect(out.skipped).toBe(3);
    expect(out).toMatchObject({ nextPageToken: "tok-2", reportedRating: 4.5, reportedCount: 41 });
    await g.fetchPage(creds, LOC, "tok-2", 0);
    const second = new URL(f.calls.at(-1)?.url as string);
    expect(second.searchParams.get("pageToken")).toBe("tok-2");
    expect(second.searchParams.get("pageSize")).toBe("1");
  });

  it("reports totals only when Google gives sensible ones", async () => {
    const f = fakeHttp({ [TOKEN]: TOKEN_OK, [`GET ${REVIEWS}`]: (_r, n) => ({ json: n === 1 ? { reviews: [] } : n === 2 ? { reviews: [], averageRating: 9, totalReviewCount: -3 } : { reviews: [], averageRating: 4.333, totalReviewCount: 12.4 } }) });
    const g = createGoogleProvider({ http: f.http, settings: () => ON });
    expect(await g.fetchPage(creds, LOC, null, 10)).toMatchObject({ reviews: [], reportedRating: null, reportedCount: null, nextPageToken: null });
    expect(await g.fetchPage(creds, LOC, null, 10)).toMatchObject({ reportedRating: null, reportedCount: null });
    expect(await g.fetchPage(creds, LOC, null, 10)).toMatchObject({ reportedRating: 4.33, reportedCount: 12 });
  });

  it("uses one access token for a whole pass and gets a new one when it has run out", async () => {
    let clock = 1_000_000;
    const f = fakeHttp({ [TOKEN]: (_r, n) => ({ json: { access_token: `access-${n}`, expires_in: 3600 } }), [`GET ${REVIEWS}`]: () => ({ json: page([]) }) });
    const g = createGoogleProvider({ http: f.http, settings: () => ON, now: () => clock });
    for (let i = 0; i < 4; i += 1) await g.fetchPage(creds, LOC, null, 10);
    expect(f.count(TOKEN)).toBe(1);
    clock += 3_000_000; // fifty minutes later: still valid (it is renewed two minutes early)
    await g.fetchPage(creds, LOC, null, 10);
    expect(f.count(TOKEN)).toBe(1);
    clock += 600_000; // an hour in total
    await g.fetchPage(creds, LOC, null, 10);
    expect(f.count(TOKEN)).toBe(2);
    expect(bearer(f.calls.at(-1) as HttpRequest)).toBe("Bearer access-2");
    // A different refresh token never gets another's access token.
    await g.fetchPage({ refreshToken: "1//another-token" }, LOC, null, 10);
    expect(f.count(TOKEN)).toBe(3);
  });

  it("says plainly what went wrong, and whether only a reconnection helps", async () => {
    const answers: Array<[Partial<HttpResponse> | Error, string, boolean, number | null]> = [
      [{ status: 401 }, "auth", true, null], [{ status: 403 }, "permission", true, null], [{ status: 404 }, "invalid_content", false, null],
      [{ status: 429, retryAfter: "120" }, "rate_limited", false, 120], [{ status: 429 }, "rate_limited", false, 900], [{ status: 429, retryAfter: "999999" }, "rate_limited", false, 86_400],
      [{ status: 503 }, "transient", false, null], [{ status: 400 }, "invalid_content", false, null], [new Error("socket hang up"), "transient", false, null],
    ];
    for (const [answer, kind, reauth, retry] of answers) {
      const f = fakeHttp({ [TOKEN]: TOKEN_OK, [`GET ${REVIEWS}`]: () => answer });
      const e = await expectError(createGoogleProvider({ http: f.http, settings: () => ON }).fetchPage(creds, LOC, null, 10), kind);
      expect(e.needsReauth, JSON.stringify(answer)).toBe(reauth);
      if (retry !== null) expect(e.retryAfterSec).toBe(retry);
      expect(e.message).not.toMatch(/socket|stack|undefined/);
      expect(JSON.stringify(e)).not.toContain("access-1");
    }
  });

  it("needs the saved sign-in, treats a refused refresh token as a connection to make again, and calls a sick Google unwell", async () => {
    const f0 = fakeHttp({});
    const g0 = createGoogleProvider({ http: f0.http, settings: () => ON });
    expect((await expectError(g0.fetchPage({}, LOC, null, 10), "auth")).needsReauth).toBe(true);
    expect(f0.calls).toHaveLength(0);
    for (const status of [400, 401]) {
      const f = fakeHttp({ [TOKEN]: () => ({ status, json: { error: "invalid_grant" } }) });
      const e = await expectError(createGoogleProvider({ http: f.http, settings: () => ON }).fetchPage(creds, LOC, null, 10), "auth", /no longer accepts the saved sign-in/);
      expect(e.needsReauth).toBe(true);
      expect(JSON.stringify(e)).not.toContain("invalid_grant");
    }
    const down = fakeHttp({ [TOKEN]: () => ({ status: 500 }) });
    expect((await expectError(createGoogleProvider({ http: down.http, settings: () => ON }).fetchPage(creds, LOC, null, 10), "transient")).needsReauth).toBe(false);
    const empty = fakeHttp({ [TOKEN]: () => ({ json: {} }) });
    await expectError(createGoogleProvider({ http: empty.http, settings: () => ON }).fetchPage(creds, LOC, null, 10), "transient", /did not return an access token/);
    const unreachable = fakeHttp({ [TOKEN]: () => new Error("ECONNRESET") });
    await expectError(createGoogleProvider({ http: unreachable.http, settings: () => ON }).fetchPage(creds, LOC, null, 10), "transient", /could not be reached/);
  });

  it("checks a connection by reading one review: working, needing a reconnection, or missing permission", async () => {
    const ok = createGoogleProvider({ http: fakeHttp({ [TOKEN]: TOKEN_OK, [`GET ${REVIEWS}`]: () => ({ json: page([]) }) }).http, settings: () => ON });
    expect(await ok.health(creds, LOC)).toEqual({ status: "connected", detail: "Connected.", scopes: [GOOGLE_SCOPE], canReply: true });
    const denied = createGoogleProvider({ http: fakeHttp({ [TOKEN]: TOKEN_OK, [`GET ${REVIEWS}`]: () => ({ status: 403 }) }).http, settings: () => ON });
    expect(await denied.health(creds, LOC)).toMatchObject({ status: "needs_permission", canReply: false });
    const expired = createGoogleProvider({ http: fakeHttp({ [TOKEN]: TOKEN_OK, [`GET ${REVIEWS}`]: () => ({ status: 401 }) }).http, settings: () => ON });
    expect(await expired.health(creds, LOC)).toMatchObject({ status: "needs_reauth" });
    // A Google that is only unwell is not a verdict on the connection: the error goes up and the status stays as it was.
    const sick = createGoogleProvider({ http: fakeHttp({ [TOKEN]: TOKEN_OK, [`GET ${REVIEWS}`]: () => ({ status: 503 }) }).http, settings: () => ON });
    await expectError(sick.health(creds, LOC), "transient");
  });
});

describe("replying", () => {
  const REPLY = `PUT ${REVIEWS}/r1/reply`;

  it("puts the words as the reply to that one review, once, and says when Google took it", async () => {
    const f = fakeHttp({ [TOKEN]: TOKEN_OK, [REPLY]: () => ({ json: { comment: "Thanks.", updateTime: "2026-10-04T09:00:00Z" } }) });
    const g = createGoogleProvider({ http: f.http, settings: () => ON });
    expect(await g.postReply(creds, LOC, "r1", "Thank you for writing.")).toEqual({ postedAt: new Date("2026-10-04T09:00:00Z") });
    const put = f.calls.find((c) => c.method === "PUT") as HttpRequest;
    expect(JSON.parse(put.body as string)).toEqual({ comment: "Thank you for writing." });
    expect(put.headers?.["Content-Type"]).toBe("application/json");
    expect(bearer(put)).toBe("Bearer access-1");
    expect(f.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  it("never lets a review id steer the request somewhere else", async () => {
    const f = fakeHttp({ [TOKEN]: TOKEN_OK });
    const g = createGoogleProvider({ http: f.http, settings: () => ON });
    for (const id of ["../reviews", "r1/reply", "r 1", "r1?x=1", "", "a".repeat(201)]) {
      await expectError(g.postReply(creds, LOC, id, "Thanks."), "invalid_content", /identifier/);
      await expectError(g.readReply(creds, LOC, id, "Thanks."), "invalid_content", /identifier/);
    }
    expect(f.calls).toHaveLength(0);
  });

  it("treats a lost or server-error answer to a reply as unknown, and a refusal as a refusal", async () => {
    for (const answer of [new Error("socket hang up"), { status: 500 }, { status: 502 }] as const) {
      const f = fakeHttp({ [TOKEN]: TOKEN_OK, [REPLY]: () => answer });
      const e = await expectError(createGoogleProvider({ http: f.http, settings: () => ON }).postReply(creds, LOC, "r1", "Thanks."), "unknown_outcome");
      expect(e.message).toMatch(/will not be sent again until that is known/);
    }
    for (const [status, kind] of [[400, "invalid_content"], [401, "auth"], [403, "permission"], [404, "invalid_content"], [429, "rate_limited"]] as const) {
      const f = fakeHttp({ [TOKEN]: TOKEN_OK, [REPLY]: () => ({ status }) });
      await expectError(createGoogleProvider({ http: f.http, settings: () => ON }).postReply(creds, LOC, "r1", "Thanks."), kind);
    }
  });

  it("reads back whether a review carries a reply, with the words squashed the way sites compare them", async () => {
    const REVIEW = `GET ${REVIEWS}/r1`;
    const g = (reply: unknown) => createGoogleProvider({ http: fakeHttp({ [TOKEN]: TOKEN_OK, [REVIEW]: () => ({ json: reply === undefined ? rev("r1", "FIVE") : rev("r1", "FIVE", { reviewReply: reply }) }) }).http, settings: () => ON });
    expect(await g(undefined).readReply(creds, LOC, "r1", "x")).toEqual({ state: "absent" });
    expect(await g({ comment: "  Thanks   for\nwriting. ", updateTime: "2026-10-04T09:00:00Z" }).readReply(creds, LOC, "r1", "x")).toEqual({ state: "found", text: "Thanks for writing.", at: new Date("2026-10-04T09:00:00Z") });
    expect(await g({ comment: "" }).readReply(creds, LOC, "r1", "x")).toEqual({ state: "absent" });
  });
});

describe("the sign-in and the choice of a location", () => {
  const FORM = (req: HttpRequest) => Object.fromEntries(new URLSearchParams(req.body));

  it("builds an address that asks for the business.manage scope only, offline, with a state and a PKCE challenge, and is unavailable when the project is not set up", () => {
    const g = createGoogleProvider({ http: fakeHttp({}).http, settings: () => ON });
    const u = new URL(g.authorizeUrl("state-1", "challenge-1"));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: ON.clientId, redirect_uri: googleRedirectUri(), response_type: "code", scope: GOOGLE_SCOPE, access_type: "offline", prompt: "consent", include_granted_scopes: "false",
      state: "state-1", code_challenge: "challenge-1", code_challenge_method: "S256",
    });
    expect(googleRedirectUri()).toMatch(/\/api\/reputation\/oauth\/google\/callback$/);
    expect(() => createGoogleProvider({ http: fakeHttp({}).http, settings: () => ({ ...ON, clientId: null }) }).authorizeUrl("s", "c")).toThrow(/not set up/);
  });

  it("exchanges the code with the verifier, and accepts it only if Google gave lasting access to reviews", async () => {
    const answer = (json: Record<string, unknown>, status = 200) => fakeHttp({ [TOKEN]: () => ({ status, json }) });
    const f = answer({ access_token: "a", refresh_token: "r", scope: `openid ${GOOGLE_SCOPE}` });
    const out = await createGoogleProvider({ http: f.http, settings: () => ON }).exchangeCode("code-1", "verifier-1");
    expect(out).toEqual({ refreshToken: "r", accessToken: "a" });
    expect(FORM(f.calls[0])).toEqual({ client_id: ON.clientId, client_secret: ON.clientSecret, code: "code-1", code_verifier: "verifier-1", grant_type: "authorization_code", redirect_uri: googleRedirectUri() });
    const bad: Array<[Record<string, unknown>, number, RegExp]> = [
      [{ access_token: "a", scope: GOOGLE_SCOPE }, 200, /lasting access/], [{ refresh_token: "r", scope: GOOGLE_SCOPE }, 200, /lasting access/],
      [{ access_token: "a", refresh_token: "r", scope: "openid email" }, 200, /did not grant access to your business profile reviews/], [{ error: "invalid_grant" }, 400, /did not accept the sign-in/],
    ];
    for (const [json, status, message] of bad) await expectError(createGoogleProvider({ http: answer(json, status).http, settings: () => ON }).exchangeCode("c", "v"), undefined, message);
    await expectError(createGoogleProvider({ http: fakeHttp({ [TOKEN]: () => new Error("down") }).http, settings: () => ON }).exchangeCode("c", "v"), "transient");
  });

  it("lists the accounts and locations the person manages, keeps only well-formed names, and stops at 200", async () => {
    const ACCOUNTS = "GET https://mybusinessaccountmanagement.googleapis.com/v1/accounts";
    const hundred = (from: number) => Array.from({ length: 150 }, (_, i) => ({ name: `locations/${from + i}`, title: `Branch ${from + i}` }));
    const f = fakeHttp({
      [TOKEN]: TOKEN_OK,
      [ACCOUNTS]: () => ({ json: { accounts: [{ name: "accounts/1" }, { name: "accounts/../evil" }, { name: "accounts/2" }, { name: 7 }, null, { name: "accounts/3" }] } }),
      "GET https://mybusinessbusinessinformation.googleapis.com/v1/accounts/1/locations": () => ({ json: { locations: [{ name: "locations/10", title: "Harbor Dental" }, { name: "locations/11" }, { name: "places/12", title: "Wrong kind" }, { name: "locations/13?x=1", title: "Odd" }, null] } }),
      "GET https://mybusinessbusinessinformation.googleapis.com/v1/accounts/2/locations": () => ({ json: { locations: hundred(100) } }),
      "GET https://mybusinessbusinessinformation.googleapis.com/v1/accounts/3/locations": () => ({ json: { locations: hundred(300) } }),
    });
    const out = await createGoogleProvider({ http: f.http, settings: () => ON }).listLocations("1//refresh");
    expect(out.slice(0, 2)).toEqual([{ accountId: "accounts/1", locationId: "locations/10", title: "Harbor Dental" }, { accountId: "accounts/1", locationId: "locations/11", title: "locations/11" }]);
    expect(out).toHaveLength(200);
    expect(out.every((l) => /^accounts\/\w+$/.test(l.accountId) && /^locations\/[\w-]+$/.test(l.locationId))).toBe(true);
    expect(f.calls.some((c) => c.url.includes("evil"))).toBe(false);
  });

  describe("end to end, with a replaced Google", () => {
    let s: ReputationShop;
    let other: ReputationShop;
    const saved = { ...process.env };

    beforeAll(async () => {
      process.env.GOOGLE_BUSINESS_API_APPROVED = "true";
      process.env.GOOGLE_BUSINESS_CLIENT_ID = ON.clientId as string;
      process.env.GOOGLE_BUSINESS_CLIENT_SECRET = ON.clientSecret as string;
      resetEnvCache();
      s = await reviewsShop("Google Flow Shop");
      other = await reviewsShop("Other Google Flow Shop");
    });
    afterAll(() => {
      for (const k of ["GOOGLE_BUSINESS_API_APPROVED", "GOOGLE_BUSINESS_CLIENT_ID", "GOOGLE_BUSINESS_CLIENT_SECRET"]) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      resetEnvCache();
    });

    const stateIn = async (url: string) => new URL(url).searchParams.get("state") as string;
    const google = (over: Record<string, Handler> = {}) => {
      const f = fakeHttp({
        [TOKEN]: (req) => ({ json: FORM(req).grant_type === "authorization_code" ? { access_token: "a1", refresh_token: "1//the-refresh-token", scope: GOOGLE_SCOPE, expires_in: 3600 } : { access_token: "a2", expires_in: 3600 } }),
        "GET https://mybusinessaccountmanagement.googleapis.com/v1/accounts": () => ({ json: { accounts: [{ name: "accounts/777" }] } }),
        "GET https://mybusinessbusinessinformation.googleapis.com/v1/accounts/777/locations": () => ({ json: { locations: [{ name: "locations/881", title: "Harbor Dental, Main Street" }, { name: "locations/882", title: "Harbor Dental, Pier" }] } }),
        "GET https://mybusiness.googleapis.com/v4/accounts/777/locations/881/reviews": () => ({ json: page([]) }),
        ...over,
      });
      return { f, provider: createGoogleProvider({ http: f.http, settings: () => ON }) };
    };

    it("sees the real deployment's switches turned on only by the test's own environment", () => {
      const env = siteEnvironment("google");
      expect(env.ready).toBe(true);
      expect(env.repliesReady).toBe(false); // the reply switch is still off
    });

    it("starts a sign-in only for the client's owner or a manager, stores a hash of the state and a sealed verifier for ten minutes, and sends them to Google", async () => {
      const g = google();
      for (const who of [s.sales, s.support, s.viewer]) await expectError(startGoogleConnect(who, null, { google: g.provider }), "forbidden");
      const { url } = await startGoogleConnect(s.owner, "/crm/reviews?tab=settings", { google: g.provider });
      const state = await stateIn(url);
      expect(state.length).toBeGreaterThanOrEqual(32);
      const u = new URL(url);
      const challenge = u.searchParams.get("code_challenge") as string;
      const row = await one<{ state_hash: string; code_verifier: string; return_path: string; used_at: Date | null; pending: string | null; seconds: string }>(
        "select state_hash, code_verifier, return_path, used_at, pending, extract(epoch from (expires_at - created_at))::text as seconds from review_oauth_states where user_id = $1 order by created_at desc limit 1", [s.owner.userId],
      );
      expect(row.state_hash).toBe(crypto.createHash("sha256").update(state).digest("hex"));
      expect(row.state_hash).not.toContain(state);
      expect(row.code_verifier).not.toBe(row.state_hash);
      expect(crypto.createHash("sha256").update(decryptSecret(row.code_verifier)).digest("base64url")).toBe(challenge);
      expect(Math.round(Number(row.seconds))).toBe(STATE_MINUTES * 60);
      expect(row).toMatchObject({ return_path: "/crm/reviews?tab=settings", used_at: null, pending: null });
      expect(g.f.calls).toHaveLength(0); // nothing was asked of Google yet
      expect(safeReturn("https://evil.test/")).toBe("/crm/reviews?tab=settings");
      expect(safeReturn("/crm/reviews?tab=public")).toBe("/crm/reviews?tab=public");
      expect(safeReturn("//evil.test")).toBe("/crm/reviews?tab=settings");
    });

    it("does not start where public reviews are off", async () => {
      const t = await reviewsShop("Google Flow Off Shop", { reviews: false });
      await expectError(startGoogleConnect(t.owner, null, { google: google().provider }), "not_enabled");
      await setReviews(t.m.org.id, true);
    });

    it("finishes the sign-in for the person who started it, within its time, once: the choices are sealed and the code is exchanged with the verifier", async () => {
      const g = google();
      const { url } = await startGoogleConnect(s.owner, null, { google: g.provider });
      const state = await stateIn(url);
      const owner = { id: s.owner.userId as string };
      // Nobody else can finish it: not a colleague, not a stranger, not a made-up state.
      await expectError(completeGoogleConnect({ id: s.manager.userId as string }, { state, code: "c" }, { google: g.provider }), "invalid_input", /expired or was not started by you/);
      await expectError(completeGoogleConnect({ id: other.owner.userId as string }, { state, code: "c" }, { google: g.provider }), "invalid_input");
      await expectError(completeGoogleConnect(owner, { state: "made-up", code: "c" }, { google: g.provider }), "invalid_input");
      await expectError(completeGoogleConnect(owner, { state: null, code: "c" }, { google: g.provider }), "invalid_input", /did not start from iAcquire/);
      expect(g.f.calls).toHaveLength(0);
      const out = await completeGoogleConnect(owner, { state, code: "auth-code-1" }, { google: g.provider });
      expect(out).toMatchObject({ outcome: "choose", returnPath: "/crm/reviews?tab=settings" });
      const exchange = g.f.calls.find((c) => c.url === GOOGLE_TOKEN && FORM(c).grant_type === "authorization_code") as HttpRequest;
      expect(FORM(exchange)).toMatchObject({ code: "auth-code-1" });
      const sealed = await one<{ pending: string }>("select pending from review_oauth_states where id = $1", [out.stateId]);
      expect(sealed.pending).not.toMatch(/refresh|881|Harbor/);
      expect(JSON.parse(decryptSecret(sealed.pending))).toMatchObject({ refreshToken: "1//the-refresh-token" });
      // The same address cannot be used again once its code was exchanged.
      await expectError(completeGoogleConnect(owner, { state, code: "auth-code-2" }, { google: g.provider }), "invalid_input");
      expect(g.f.calls.filter((c) => c.url === GOOGLE_TOKEN && FORM(c).grant_type === "authorization_code")).toHaveLength(1);
    });

    it("treats a cancelled sign-in, a person who lost their role meanwhile, a switched-off workspace and an expired state as nothing connected", async () => {
      const g = google();
      const owner = { id: s.owner.userId as string };
      const denied = await startGoogleConnect(s.owner, null, { google: g.provider });
      expect(await completeGoogleConnect(owner, { state: await stateIn(denied.url), error: "access_denied" }, { google: g.provider })).toMatchObject({ outcome: "denied", stateId: null });
      expect(g.f.calls).toHaveLength(0);
      const lapsed = await startGoogleConnect(s.owner, null, { google: g.provider });
      await withSystem((db) => db.query("update review_oauth_states set expires_at = now() - interval '1 minute' where state_hash = $1", [crypto.createHash("sha256").update(new URL(lapsed.url).searchParams.get("state") as string).digest("hex")]));
      await expectError(completeGoogleConnect(owner, { state: await stateIn(lapsed.url), code: "c" }, { google: g.provider }), "invalid_input");
      const demoted = await startGoogleConnect(s.owner, null, { google: g.provider });
      await withSystem((db) => db.query("update organization_memberships set role = 'viewer' where org_id = $1 and user_id = $2", [s.m.org.id, s.owner.userId]));
      await expectError(completeGoogleConnect(owner, { state: await stateIn(demoted.url), code: "c" }, { google: g.provider }), "forbidden", /Only the business owner or a manager/);
      await withSystem((db) => db.query("update organization_memberships set role = 'owner' where org_id = $1 and user_id = $2", [s.m.org.id, s.owner.userId]));
      const off = await startGoogleConnect(s.owner, null, { google: g.provider });
      await setReviews(s.m.org.id, false);
      await expectError(completeGoogleConnect(owner, { state: await stateIn(off.url), code: "c" }, { google: g.provider }), "forbidden", /aren't switched on/);
      await setReviews(s.m.org.id, true);
      expect(g.f.calls).toHaveLength(0); // none of these reached Google
    });

    it("reports a Google that would not exchange the code, and spends the state", async () => {
      const g = google({ [TOKEN]: () => ({ status: 400, json: { error: "invalid_grant" } }) });
      const { url } = await startGoogleConnect(s.owner, null, { google: g.provider });
      const e = await expectError(completeGoogleConnect({ id: s.owner.userId as string }, { state: await stateIn(url), code: "stale-code" }, { google: g.provider }), "upstream_error", /did not accept the sign-in/);
      expect(JSON.stringify(e)).not.toContain("invalid_grant");
      const hash = crypto.createHash("sha256").update(await stateIn(url)).digest("hex");
      expect(await one("select used_at is not null as used, pending is null as cleared from review_oauth_states where state_hash = $1", [hash])).toEqual({ used: true, cleared: true });
    });

    it("connects the one location the person picks, saves its sign-in sealed, tests it first, spends the state, and shows the location only once to one workspace", async () => {
      const g = google();
      const { url } = await startGoogleConnect(s.owner, null, { google: g.provider });
      const done = await completeGoogleConnect({ id: s.owner.userId as string }, { state: await stateIn(url), code: "c" }, { google: g.provider });
      const stateId = done.stateId as string;
      // Only the person (in the workspace) who started it can see the choices, and they carry no token.
      expect(await pendingLocations(s.owner, stateId)).toEqual([
        { accountId: "accounts/777", locationId: "locations/881", title: "Harbor Dental, Main Street", alreadyConnected: false }, { accountId: "accounts/777", locationId: "locations/882", title: "Harbor Dental, Pier", alreadyConnected: false },
      ]);
      await expectError(pendingLocations(s.manager, stateId), "not_found", /expired/);
      await expectError(pendingLocations(other.owner, stateId), "not_found");
      await expectError(pendingLocations(s.owner, "not-a-uuid"), "not_found");
      // A location that was not in the list cannot be connected, and neither can one by someone who may not connect.
      await expectError(connectChosenLocation(s.owner, stateId, { accountId: "accounts/777", locationId: "locations/999" }, { google: g.provider }), "invalid_input", /not in your list/);
      await expectError(connectChosenLocation(s.sales, stateId, { accountId: "accounts/777", locationId: "locations/881" }, { google: g.provider }), "forbidden");
      await expectError(connectChosenLocation(other.owner, stateId, { accountId: "accounts/777", locationId: "locations/881" }, { google: g.provider }), "not_found");
      const connected = await connectChosenLocation(s.owner, stateId, { accountId: "accounts/777", locationId: "locations/881" }, { google: g.provider });
      expect(connected).toMatchObject({ provider: "google", adapter: "google", simulated: false, name: "Harbor Dental, Main Street", externalAccountId: "accounts/777", externalLocationId: "locations/881", status: "connected" });
      expect(JSON.stringify(connected)).not.toMatch(/the-refresh-token|credentials/);
      const stored = await one<{ credentials: string; scopes: string[]; can_reply: boolean }>("select credentials, scopes, can_reply from review_connections where id = $1", [connected.id]);
      expect(stored.credentials).not.toContain("the-refresh-token");
      expect(JSON.parse(decryptSecret(stored.credentials))).toEqual({ refreshToken: "1//the-refresh-token" });
      expect(stored).toMatchObject({ scopes: [GOOGLE_SCOPE], can_reply: true });
      // It was tested with a read before it was saved, and the state is spent: the token is no longer kept anywhere but the connection.
      expect(g.f.calls.some((c) => c.url.includes("/accounts/777/locations/881/reviews"))).toBe(true);
      expect(await one("select used_at is not null as used, pending is null as cleared from review_oauth_states where id = $1", [stateId])).toEqual({ used: true, cleared: true });
      await expectError(pendingLocations(s.owner, stateId), "not_found");
      await expectError(connectChosenLocation(s.owner, stateId, { accountId: "accounts/777", locationId: "locations/882" }, { google: g.provider }), "not_found");
      // The location now belongs to this workspace alone: another workspace sees it as taken and cannot connect it.
      const second = await startGoogleConnect(other.owner, null, { google: g.provider });
      const theirs = await completeGoogleConnect({ id: other.owner.userId as string }, { state: await stateIn(second.url), code: "c" }, { google: g.provider });
      expect((await pendingLocations(other.owner, theirs.stateId as string)).find((l) => l.locationId === "locations/881")?.alreadyConnected).toBe(true);
      await expectError(connectChosenLocation(other.owner, theirs.stateId as string, { accountId: "accounts/777", locationId: "locations/881" }, { google: g.provider }), "conflict", /already connected to a workspace/);
      expect((await listConnections(other.owner)).filter((c) => c.provider === "google")).toHaveLength(0);
    });

    it("does not save a location Google will not let it read, and still spends the state", async () => {
      const g = google({ "GET https://mybusiness.googleapis.com/v4/accounts/777/locations/881/reviews": () => ({ status: 403 }) });
      const { url } = await startGoogleConnect(other.owner, null, { google: g.provider });
      const done = await completeGoogleConnect({ id: other.owner.userId as string }, { state: await stateIn(url), code: "c" }, { google: g.provider });
      await expectError(connectChosenLocation(other.owner, done.stateId as string, { accountId: "accounts/777", locationId: "locations/881" }, { google: g.provider }), "forbidden");
      expect((await listConnections(other.owner)).filter((c) => c.provider === "google")).toHaveLength(0);
      expect(await one("select pending is null as cleared from review_oauth_states where id = $1", [done.stateId])).toEqual({ cleared: true });
      expect(await all("select 1 from review_connections where org_id = $1", [other.m.org.id])).toEqual([]);
    });
  });
});
