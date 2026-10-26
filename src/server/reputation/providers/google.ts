import "server-only";
import crypto from "node:crypto";
import { env } from "@/server/env";
import { providerRequest } from "@/server/calendars/adapters/http";
import { ProviderError, squashReply, type LocationRef, type ProviderReview, type ReplyRead, type ReviewCredentials, type ReviewHealth, type ReviewPage, type ReviewProvider } from "@/server/reputation/providers/types";

// Google Business Profile reviews: reading a location's reviews and replying to them, through the Business Profile APIs with the OAuth scope business.manage.
//
// NOT tested against the real service. It has only ever run against a replaced HTTP layer (tests/reputation-google.test.ts), because Google has not approved iAcquire's Cloud
// project for these APIs and nothing may be read from or posted to a real business profile without that approval. The endpoint and field names below come from memory of
// Google's public reference (accounts from the Account Management API, locations from the Business Information API, reviews and replies from the v4 reviews resource:
// `accounts/{a}/locations/{l}/reviews`, `starRating` as ONE..FIVE, `reviewReply.comment`, `PUT .../reply`). They MUST be re-read against Google's current documentation before
// approval is applied for. Reading needs GOOGLE_BUSINESS_API_APPROVED; posting a reply additionally needs GOOGLE_BUSINESS_REPLIES_ENABLED. Both are off by default.

export const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/business.manage";
const ACCOUNTS_URL = "https://mybusinessaccountmanagement.googleapis.com/v1/accounts";
const LOCATIONS_URL = (account: string) => `https://mybusinessbusinessinformation.googleapis.com/v1/${account}/locations`;
const REVIEWS_URL = (loc: LocationRef) => `https://mybusiness.googleapis.com/v4/${loc.accountId}/${loc.locationId}/reviews`;
const ORIGINS = ["https://oauth2.googleapis.com", "https://mybusinessaccountmanagement.googleapis.com", "https://mybusinessbusinessinformation.googleapis.com", "https://mybusiness.googleapis.com"] as const;

export interface GoogleSettings {
  approved: boolean;
  clientId: string | null;
  clientSecret: string | null;
  repliesEnabled: boolean;
}

export const googleSettings = (): GoogleSettings => {
  const e = env();
  return { approved: e.GOOGLE_BUSINESS_API_APPROVED, clientId: e.GOOGLE_BUSINESS_CLIENT_ID ?? null, clientSecret: e.GOOGLE_BUSINESS_CLIENT_SECRET ?? null, repliesEnabled: e.GOOGLE_BUSINESS_REPLIES_ENABLED };
};

/** Reading is offered only when Google approved the project AND the project's client ID and secret are set. */
export const googleReady = (s: GoogleSettings = googleSettings()) => s.approved && Boolean(s.clientId && s.clientSecret);

export const googleRedirectUri = () => `${env().APP_URL.replace(/\/+$/, "")}/api/reputation/oauth/google/callback`;

export interface HttpRequest {
  method: "GET" | "POST" | "PUT";
  url: string;
  headers?: Record<string, string>;
  body?: string;
}
export interface HttpResponse {
  status: number;
  json: Record<string, unknown> | null;
  retryAfter: string | null;
}
export type HttpCall = (req: HttpRequest) => Promise<HttpResponse>;

/** The real HTTP layer: fixed official origins, no redirects, a time limit and a size cap (the calendar integrations' provider request). */
export const googleHttp: HttpCall = async (req) => {
  const res = await providerRequest(null, req.url, ORIGINS, { method: req.method, headers: req.headers, body: req.body, timeoutMs: 25_000, maxBytes: 2_000_000 }, "Google");
  let json: Record<string, unknown> | null = null;
  try {
    json = res.text ? (JSON.parse(res.text) as Record<string, unknown>) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, retryAfter: res.headers.get("retry-after") };
};

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const date = (v: unknown): Date | null => {
  const t = typeof v === "string" ? new Date(v) : null;
  return t && !Number.isNaN(t.getTime()) ? t : null;
};

const STARS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

/** A failure the person can understand, from an answer (or from silence). `sent` says whether the request could already have changed something at Google. */
function failure(res: HttpResponse | null, sent: boolean): ProviderError {
  if (!res) {
    return sent
      ? new ProviderError("unknown_outcome", "Google did not confirm whether it took the reply. It is being checked and will not be sent again until that is known.")
      : new ProviderError("transient", "Google could not be reached. It is tried again automatically.");
  }
  const retry = Number(res.retryAfter ?? NaN);
  const retryAfterSec = Number.isFinite(retry) && retry > 0 ? Math.min(retry, 86_400) : null;
  const status = res.status;
  if (status === 401) return new ProviderError("auth", "Google no longer accepts the saved sign-in. Reconnect your Google location.", { needsReauth: true, httpStatus: status });
  if (status === 403) return new ProviderError("permission", "Google says this sign-in does not have permission for that. Reconnect your Google location and allow the access it asks for.", { needsReauth: true, httpStatus: status });
  if (status === 404) return new ProviderError("invalid_content", "Google could not find that location or review. It may have been removed.", { httpStatus: status });
  if (status === 429) return new ProviderError("rate_limited", "Google is limiting how often this can be read. It is tried again later.", { retryAfterSec: retryAfterSec ?? 900, httpStatus: status });
  if (status >= 500) return sent ? new ProviderError("unknown_outcome", "Google did not confirm whether it took the reply. It is being checked and will not be sent again until that is known.", { httpStatus: status }) : new ProviderError("transient", "Google is having trouble. It is tried again automatically.", { retryAfterSec, httpStatus: status });
  return new ProviderError("invalid_content", "Google refused the request.", { httpStatus: status });
}

export interface GoogleDeps {
  http?: HttpCall;
  settings?: () => GoogleSettings;
  now?: () => number;
}

interface CachedToken {
  token: string;
  until: number;
}

export function createGoogleProvider(deps: GoogleDeps = {}): ReviewProvider & {
  authorizeUrl(state: string, challenge: string): string;
  exchangeCode(code: string, verifier: string): Promise<{ refreshToken: string; accessToken: string }>;
  listLocations(refreshToken: string): Promise<Array<{ accountId: string; locationId: string; title: string }>>;
} {
  const http = deps.http ?? googleHttp;
  const settings = deps.settings ?? googleSettings;
  const now = deps.now ?? Date.now;
  // Access tokens last an hour; one refresh serves a whole pass over a location's pages. Held in memory only, keyed by a digest of the refresh token.
  const cache = new Map<string, CachedToken>();

  const assertReady = () => {
    if (!googleReady(settings())) throw new ProviderError("blocked", "Reading Google reviews is not switched on in this environment: Google has not approved iAcquire's access yet.");
  };
  const call = async (req: HttpRequest, sent = false): Promise<Record<string, unknown>> => {
    let res: HttpResponse;
    try {
      res = await http(req);
    } catch {
      throw failure(null, sent);
    }
    if (res.status >= 400) throw failure(res, sent);
    return res.json ?? {};
  };
  const accessToken = async (creds: ReviewCredentials): Promise<string> => {
    const refresh = creds.refreshToken;
    if (!refresh) throw new ProviderError("auth", "The saved Google sign-in can no longer be used. Reconnect your Google location.", { needsReauth: true });
    const key = crypto.createHash("sha256").update(refresh).digest("hex");
    const hit = cache.get(key);
    if (hit && hit.until > now()) return hit.token;
    const s = settings();
    let res: HttpResponse;
    try {
      res = await http({
        method: "POST", url: GOOGLE_TOKEN, headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: s.clientId ?? "", client_secret: s.clientSecret ?? "", refresh_token: refresh, grant_type: "refresh_token" }).toString(),
      });
    } catch {
      throw new ProviderError("transient", "Google could not be reached. It is tried again automatically.");
    }
    // A refresh token Google rejects (revoked, expired, the password changed) is a connection that must be made again; anything else is Google being unwell.
    if (res.status === 400 || res.status === 401) throw new ProviderError("auth", "Google no longer accepts the saved sign-in. Reconnect your Google location.", { needsReauth: true, httpStatus: res.status });
    if (res.status >= 400) throw failure(res, false);
    const token = str(res.json?.access_token);
    if (!token) throw new ProviderError("transient", "Google did not return an access token. It is tried again automatically.");
    cache.set(key, { token, until: now() + Math.max(60, Math.min(num(res.json?.expires_in) ?? 3600, 3600) - 120) * 1000 });
    return token;
  };
  const authed = async (creds: ReviewCredentials, req: Omit<HttpRequest, "headers"> & { headers?: Record<string, string> }, sent = false) => {
    const token = await accessToken(creds);
    return call({ ...req, headers: { ...req.headers, Authorization: `Bearer ${token}` } }, sent);
  };

  const toReview = (r: Record<string, unknown>): ProviderReview | null => {
    const id = str(r.reviewId) ?? str(r.name)?.split("/").pop() ?? null;
    const rating = typeof r.starRating === "string" ? (STARS[r.starRating] ?? null) : null;
    // A review with no stars (the site did not say) cannot be stored: the mirror holds a rating or a recommendation, never a guess.
    if (!id || rating === null) return null;
    const reviewer = (r.reviewer ?? {}) as Record<string, unknown>;
    const anonymous = reviewer.isAnonymous === true;
    const reply = (r.reviewReply ?? null) as Record<string, unknown> | null;
    const replyText = reply ? str(reply.comment) : null;
    return {
      providerReviewId: id, rating, recommends: null, reviewerName: anonymous ? null : str(reviewer.displayName), reviewerAnonymous: anonymous, comment: str(r.comment),
      createdAt: date(r.createTime), updatedAt: date(r.updateTime), reply: replyText ? { text: replyText, at: date(reply?.updateTime) } : null,
    };
  };

  return {
    adapter: "google",

    replySupport() {
      return settings().repliesEnabled && googleReady(settings())
        ? { ok: true }
        : { ok: false, reason: "Posting replies to Google isn't switched on for iAcquire yet. You can still write and approve a reply, then post it on Google yourself." };
    },

    authorizeUrl(state, challenge) {
      const s = settings();
      if (!s.clientId) throw new ProviderError("blocked", "The Google project is not set up in this deployment.");
      const u = new URL(GOOGLE_AUTHORIZE);
      u.searchParams.set("client_id", s.clientId);
      u.searchParams.set("redirect_uri", googleRedirectUri());
      u.searchParams.set("response_type", "code");
      u.searchParams.set("scope", GOOGLE_SCOPE);
      // Offline access gives the long-lived refresh token the hourly read needs; consent is asked every time so a refresh token is always returned.
      u.searchParams.set("access_type", "offline");
      u.searchParams.set("prompt", "consent");
      u.searchParams.set("include_granted_scopes", "false");
      u.searchParams.set("state", state);
      u.searchParams.set("code_challenge", challenge);
      u.searchParams.set("code_challenge_method", "S256");
      return u.toString();
    },

    async exchangeCode(code, verifier) {
      assertReady();
      const s = settings();
      let res: HttpResponse;
      try {
        res = await http({
          method: "POST", url: GOOGLE_TOKEN, headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id: s.clientId ?? "", client_secret: s.clientSecret ?? "", code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: googleRedirectUri() }).toString(),
        });
      } catch {
        throw new ProviderError("transient", "Google could not be reached. Start the connection again in a moment.");
      }
      if (res.status >= 400) throw new ProviderError("auth", "Google did not accept the sign-in. Start the connection again.", { httpStatus: res.status });
      const access = str(res.json?.access_token);
      const refresh = str(res.json?.refresh_token);
      const granted = str(res.json?.scope) ?? "";
      if (!access || !refresh) throw new ProviderError("auth", "Google did not give iAcquire lasting access. Start the connection again and allow it.");
      if (!granted.split(/\s+/).includes(GOOGLE_SCOPE)) throw new ProviderError("permission", "Google did not grant access to your business profile reviews. Start the connection again and allow it.");
      return { refreshToken: refresh, accessToken: access };
    },

    async listLocations(refreshToken) {
      assertReady();
      const creds: ReviewCredentials = { refreshToken };
      const out: Array<{ accountId: string; locationId: string; title: string }> = [];
      const accounts = await authed(creds, { method: "GET", url: `${ACCOUNTS_URL}?pageSize=20` });
      for (const a of (Array.isArray(accounts.accounts) ? accounts.accounts : []).slice(0, 20) as Array<Record<string, unknown> | null>) {
        const account = a && typeof a === "object" ? str(a.name) : null;
        if (!account || !/^accounts\/[\w-]+$/.test(account)) continue;
        const locs = await authed(creds, { method: "GET", url: `${LOCATIONS_URL(account)}?readMask=name,title&pageSize=100` });
        for (const l of (Array.isArray(locs.locations) ? locs.locations : []).slice(0, 100) as Array<Record<string, unknown> | null>) {
          if (!l || typeof l !== "object") continue;
          const name = str(l.name);
          if (!name || !/^locations\/[\w-]+$/.test(name)) continue;
          out.push({ accountId: account, locationId: name, title: (str(l.title) ?? name).slice(0, 200) });
          if (out.length >= 200) return out;
        }
      }
      return out;
    },

    async health(creds, loc): Promise<ReviewHealth> {
      assertReady();
      try {
        await authed(creds, { method: "GET", url: `${REVIEWS_URL(loc)}?pageSize=1` });
      } catch (e) {
        if (e instanceof ProviderError && (e.needsReauth || e.kind === "auth" || e.kind === "permission")) {
          return { status: e.kind === "permission" ? "needs_permission" : "needs_reauth", detail: e.message, scopes: [], canReply: false };
        }
        throw e;
      }
      const reply = settings().repliesEnabled;
      return { status: "connected", detail: "Connected.", scopes: [GOOGLE_SCOPE], canReply: reply };
    },

    async fetchPage(creds, loc, pageToken, pageSize): Promise<ReviewPage> {
      assertReady();
      const u = new URL(REVIEWS_URL(loc));
      u.searchParams.set("pageSize", String(Math.max(1, Math.min(pageSize, 50))));
      u.searchParams.set("orderBy", "updateTime desc");
      if (pageToken) u.searchParams.set("pageToken", pageToken);
      const j = await authed(creds, { method: "GET", url: u.toString() });
      const reviews: ProviderReview[] = [];
      let skipped = 0;
      for (const raw of Array.isArray(j.reviews) ? j.reviews : []) {
        const r = raw && typeof raw === "object" ? toReview(raw as Record<string, unknown>) : null;
        if (r) reviews.push(r);
        else skipped += 1;
      }
      const avg = num(j.averageRating);
      return { reviews, nextPageToken: str(j.nextPageToken), reportedRating: avg !== null && avg >= 1 && avg <= 5 ? Math.round(avg * 100) / 100 : null, reportedCount: num(j.totalReviewCount) !== null && (num(j.totalReviewCount) as number) >= 0 ? Math.round(num(j.totalReviewCount) as number) : null, skipped };
    },

    async postReply(creds, loc, providerReviewId, text) {
      assertReady();
      if (!settings().repliesEnabled) throw new ProviderError("blocked", "Posting replies to Google is switched off in this environment.");
      if (!/^[\w-]{1,200}$/.test(providerReviewId)) throw new ProviderError("invalid_content", "That review's identifier is not one Google would accept.");
      // PUT replaces the reply: sending the same reply twice leaves one reply, so a lost answer is safe to check and, if need be, repeat.
      const j = await authed(creds, { method: "PUT", url: `${REVIEWS_URL(loc)}/${providerReviewId}/reply`, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ comment: text }) }, true);
      return { postedAt: date(j.updateTime) };
    },

    async readReply(creds, loc, providerReviewId): Promise<ReplyRead> {
      assertReady();
      if (!/^[\w-]{1,200}$/.test(providerReviewId)) throw new ProviderError("invalid_content", "That review's identifier is not one Google would accept.");
      const j = await authed(creds, { method: "GET", url: `${REVIEWS_URL(loc)}/${providerReviewId}` });
      const reply = (j.reviewReply ?? null) as Record<string, unknown> | null;
      const text = reply ? str(reply.comment) : null;
      return text ? { state: "found", text: squashReply(text), at: date(reply?.updateTime) } : { state: "absent" };
    },
  };
}

export const googleReviewProvider = createGoogleProvider();
