import "server-only";
import { env } from "@/server/env";
import { providerRequest } from "@/server/calendars/adapters/http";
import { classifyProviderFailure, type ProviderErrorBody } from "@/lib/social/errors";
import { ProviderError, type AccountRef, type Credentials, type HealthResult, type PublishInput, type PublishState, type Reconciliation, type SocialProvider, type StepResult } from "@/server/social/providers/types";

// Facebook Pages and Instagram professional accounts through Meta's Graph API. Endpoint and field names are the ones in Meta's own open-source SDK for Graph
// API v26.0 (facebook-python-business-sdk, September 2026): `POST /{page-id}/feed` (message, link, published), `POST /{page-id}/photos` (url, caption, published),
// `POST /{page-id}/videos` (file_url, description, published), `POST /{post-id}` (is_published), `POST /{ig-user-id}/media` (image_url, video_url, media_type,
// caption), `POST /{ig-user-id}/media_publish` (creation_id), `GET /{ig-user-id}/content_publishing_limit`.
//
// NOT tested against the real platform: this adapter has only ever been run against a replaced HTTP layer (tests/social-meta.test.ts), because no Meta app
// exists for this deployment and nothing may be posted to a real account without approval. Meta app review and business verification are needed before it can
// publish for real customers. Nothing here posts anywhere unless META_SOCIAL_WRITES_ENABLED is true.

const GRAPH_ORIGIN = "https://graph.facebook.com";

export interface GraphRequest {
  method: "GET" | "POST";
  /** Path after the version, without a leading slash: "123/feed". */
  path: string;
  params?: Record<string, string>;
  token: string;
  /** The request could create something at the platform, so a lost answer means "unknown outcome" rather than "failed". */
  sent: boolean;
}

export interface GraphResponse {
  status: number;
  json: Record<string, unknown> | null;
  retryAfter: string | null;
}

export type GraphCall = (req: GraphRequest) => Promise<GraphResponse>;

export interface MetaSettings {
  appId: string | null;
  appSecret: string | null;
  version: string;
  writesEnabled: boolean;
}

export const metaSettings = (): MetaSettings => {
  const e = env();
  return { appId: e.META_SOCIAL_APP_ID ?? null, appSecret: e.META_SOCIAL_APP_SECRET ?? null, version: e.META_GRAPH_VERSION, writesEnabled: e.META_SOCIAL_WRITES_ENABLED };
};

/** The real HTTP layer: a fixed official origin, no redirects, the token in a header (never in a URL), a time limit and a size cap. */
export function graphCall(version: string): GraphCall {
  return async (req) => {
    const url = new URL(`${GRAPH_ORIGIN}/${version}/${req.path}`);
    // An empty token is the app-level call that exchanges an authorization code: it has no bearer, and its own secrets travel in the query.
    const headers: Record<string, string> = req.token ? { Authorization: `Bearer ${req.token}` } : {};
    let body: string | undefined;
    if (req.method === "GET") for (const [k, v] of Object.entries(req.params ?? {})) url.searchParams.set(k, v);
    else {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(req.params ?? {}).toString();
    }
    const res = await providerRequest(null, url.toString(), [GRAPH_ORIGIN], { method: req.method, headers, body, timeoutMs: 25_000, maxBytes: 1_000_000 }, "Meta");
    let json: Record<string, unknown> | null = null;
    try {
      json = res.text ? (JSON.parse(res.text) as Record<string, unknown>) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json, retryAfter: res.headers.get("retry-after") };
  };
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Turns any failure into a ProviderError the publisher understands. A response with an `error` body is a definite answer; silence is not. */
function failure(res: GraphResponse | null, sent: boolean): ProviderError {
  const error = res && res.json && typeof res.json.error === "object" ? (res.json.error as ProviderErrorBody) : null;
  const c = classifyProviderFailure({ httpStatus: res?.status ?? null, error, sent, retryAfterHeader: res?.retryAfter ?? null });
  return new ProviderError(c.kind, c.message, { needsReauth: c.needsReauth, retryAfterSec: c.retryAfterSec, httpStatus: res?.status ?? null });
}

async function call(graph: GraphCall, req: GraphRequest): Promise<Record<string, unknown>> {
  let res: GraphResponse;
  try {
    res = await graph(req);
  } catch {
    throw failure(null, req.sent);
  }
  if (res.status >= 400 || (res.json && "error" in res.json)) throw failure(res, req.sent);
  return res.json ?? {};
}

const flag = (v: boolean) => (v ? "true" : "false");

export function createMetaProvider(deps: { graph?: GraphCall; settings?: () => MetaSettings } = {}): SocialProvider {
  const settings = deps.settings ?? metaSettings;
  const graphFor = () => deps.graph ?? graphCall(settings().version);
  const assertWrites = () => {
    if (!settings().writesEnabled) throw new ProviderError("blocked", "Publishing to Facebook and Instagram is switched off in this environment.");
  };
  const permalinkOf = async (graph: GraphCall, token: string, id: string, field: "permalink_url" | "permalink"): Promise<string | null> => {
    try {
      const j = await call(graph, { method: "GET", path: id, params: { fields: field }, token, sent: false });
      return str(j[field]);
    } catch {
      return null; // a missing link never turns a published post into a failure
    }
  };

  return {
    adapter: "meta",

    mayCreate(input, state) {
      if (input.platform === "facebook") return input.kind === "text" || input.kind === "link" ? Boolean(state.objectId) : true;
      return Boolean(state.ready); // Instagram: creating the container and checking it show nothing; media_publish does
    },

    async health(creds, account: AccountRef): Promise<HealthResult> {
      const s = settings();
      if (!s.appId || !s.appSecret) throw new ProviderError("transient", "The Meta app is not configured in this deployment.");
      const graph = graphFor();
      // debug_token is read with the app's own token (id|secret) in the header, naming the account's token as the input.
      const j = await call(graph, { method: "GET", path: "debug_token", params: { input_token: creds.accessToken }, token: `${s.appId}|${s.appSecret}`, sent: false });
      const d = (j.data ?? {}) as Record<string, unknown>;
      const scopes = Array.isArray(d.scopes) ? d.scopes.filter((x): x is string => typeof x === "string") : [];
      const exp = typeof d.expires_at === "number" && d.expires_at > 0 ? new Date(d.expires_at * 1000) : null;
      const dataExp = typeof d.data_access_expires_at === "number" && d.data_access_expires_at > 0 ? new Date(d.data_access_expires_at * 1000) : null;
      const valid = d.is_valid === true;
      const need = account.platform === "facebook" ? ["pages_manage_posts"] : ["instagram_content_publish"];
      const missing = need.filter((p) => !scopes.includes(p));
      const canPost = valid && missing.length === 0;
      let quota: HealthResult["quota"] = null;
      if (canPost && account.platform === "instagram") {
        try {
          const q = await call(graph, { method: "GET", path: `${account.externalId}/content_publishing_limit`, params: { fields: "quota_usage,config" }, token: creds.accessToken, sent: false });
          const row = Array.isArray(q.data) ? (q.data[0] as Record<string, unknown> | undefined) : undefined;
          const total = row && typeof row.config === "object" && row.config ? (row.config as Record<string, unknown>).quota_total : null;
          if (row && typeof row.quota_usage === "number" && typeof total === "number") quota = { usage: row.quota_usage, total };
        } catch {
          quota = null; // an unreadable limit is shown as unknown, never as plenty
        }
      }
      return {
        status: !valid ? "needs_reauth" : missing.length ? "needs_reauth" : "connected",
        detail: !valid ? "The platform says this sign-in is no longer valid." : missing.length ? `Missing permission: ${missing.join(", ")}. Reconnect and allow it.` : "Connected.",
        scopes, expiresAt: exp, dataAccessExpiresAt: dataExp,
        capabilities: {
          contentTypes: canPost ? (account.platform === "instagram" ? ["image", "video"] : ["text", "link", "image", "video"]) : [],
          insights: scopes.includes("pages_read_engagement") || scopes.includes("instagram_manage_insights"),
        },
        quota,
      };
    },

    async step(creds, input, state): Promise<StepResult> {
      assertWrites();
      const graph = graphFor();
      const t = creds.accessToken;
      const m = input.media[0];
      if (input.platform === "facebook") {
        if (input.kind === "text" || input.kind === "link") {
          if (!state.objectId) {
            const params: Record<string, string> = { message: input.message, published: flag(false) };
            if (input.linkUrl) params.link = input.linkUrl;
            const j = await call(graph, { method: "POST", path: `${input.externalId}/feed`, params, token: t, sent: false });
            const id = str(j.id);
            if (!id) throw new ProviderError("transient", "The platform did not return an identifier for the prepared post.");
            return { state: { ...state, objectId: id } };
          }
          await call(graph, { method: "POST", path: state.objectId, params: { is_published: flag(true) }, token: t, sent: true });
          return { state: { ...state, providerPostId: state.objectId, permalink: await permalinkOf(graph, t, state.objectId, "permalink_url"), done: true } };
        }
        if (!m) throw new ProviderError("invalid_content", "This post needs a picture or video.");
        if (input.kind === "image") {
          const j = await call(graph, { method: "POST", path: `${input.externalId}/photos`, params: { url: m.url, caption: input.message, published: flag(true) }, token: t, sent: true });
          const id = str(j.post_id) ?? str(j.id);
          if (!id) throw new ProviderError("unknown_outcome", "The platform did not confirm the post. It is being checked and will not be sent again until that is known.");
          return { state: { ...state, providerPostId: id, permalink: await permalinkOf(graph, t, id, "permalink_url"), done: true } };
        }
        const j = await call(graph, { method: "POST", path: `${input.externalId}/videos`, params: { file_url: m.url, description: input.message, published: flag(true) }, token: t, sent: true });
        const id = str(j.id);
        if (!id) throw new ProviderError("unknown_outcome", "The platform did not confirm the post. It is being checked and will not be sent again until that is known.");
        return { state: { ...state, providerPostId: id, permalink: await permalinkOf(graph, t, id, "permalink_url"), done: true } };
      }

      // Instagram: create a container, wait until it is ready, publish it.
      if (!m) throw new ProviderError("invalid_content", "Instagram posts need a picture or video.");
      if (!state.creationId) {
        const params: Record<string, string> = { caption: input.message };
        if (m.kind === "image") params.image_url = m.url;
        else {
          params.media_type = "REELS";
          params.video_url = m.url;
        }
        const j = await call(graph, { method: "POST", path: `${input.externalId}/media`, params, token: t, sent: false });
        const id = str(j.id);
        if (!id) throw new ProviderError("transient", "The platform did not return an identifier for the prepared post.");
        return { state: { ...state, creationId: id }, waitSeconds: m.kind === "video" ? 30 : 0 };
      }
      if (!state.ready) {
        const s = await call(graph, { method: "GET", path: state.creationId, params: { fields: "status_code" }, token: t, sent: false });
        const code = str(s.status_code);
        if (code === "IN_PROGRESS") return { state, waitSeconds: 30 };
        if (code === "ERROR" || code === "EXPIRED") throw new ProviderError("invalid_content", "Instagram could not process the picture or video.");
        return { state: { ...state, ready: true } };
      }
      const p = await call(graph, { method: "POST", path: `${input.externalId}/media_publish`, params: { creation_id: state.creationId }, token: t, sent: true });
      const id = str(p.id);
      if (!id) throw new ProviderError("unknown_outcome", "The platform did not confirm the post. It is being checked and will not be sent again until that is known.");
      return { state: { ...state, providerPostId: id, permalink: await permalinkOf(graph, t, id, "permalink"), done: true } };
    },

    async reconcile(creds, input, state, since): Promise<Reconciliation> {
      const graph = graphFor();
      const t = creds.accessToken;
      const text = input.message.slice(0, 80);
      const sinceUnix = Math.floor((since.getTime() - 120_000) / 1000);
      if (input.platform === "facebook") {
        if (state.objectId) {
          const j = await call(graph, { method: "GET", path: state.objectId, params: { fields: "is_published,permalink_url" }, token: t, sent: false });
          return j.is_published === true ? { found: true, providerPostId: state.objectId, permalink: str(j.permalink_url) } : { found: false };
        }
        const j = await call(graph, { method: "GET", path: `${input.externalId}/published_posts`, params: { fields: "id,message,created_time,permalink_url", since: String(sinceUnix), limit: "25" }, token: t, sent: false });
        const hit = (Array.isArray(j.data) ? j.data : []).find((p) => typeof p === "object" && p && String((p as Record<string, unknown>).message ?? "").startsWith(text)) as Record<string, unknown> | undefined;
        return hit && str(hit.id) ? { found: true, providerPostId: str(hit.id) as string, permalink: str(hit.permalink_url) } : { found: false };
      }
      // Instagram: a container that says PUBLISHED went out; its media id comes from the account's recent media.
      let published = false;
      if (state.creationId) {
        const s = await call(graph, { method: "GET", path: state.creationId, params: { fields: "status_code" }, token: t, sent: false });
        published = str(s.status_code) === "PUBLISHED";
      }
      const j = await call(graph, { method: "GET", path: `${input.externalId}/media`, params: { fields: "id,caption,timestamp,permalink", limit: "25" }, token: t, sent: false });
      const hit = (Array.isArray(j.data) ? j.data : []).find((p) => {
        const r = p as Record<string, unknown>;
        return String(r.caption ?? "").startsWith(text) && typeof r.timestamp === "string" && Date.parse(r.timestamp) >= since.getTime() - 120_000;
      }) as Record<string, unknown> | undefined;
      if (hit && str(hit.id)) return { found: true, providerPostId: str(hit.id) as string, permalink: str(hit.permalink) };
      return published && state.creationId ? { found: true, providerPostId: `container:${state.creationId}`, permalink: null } : { found: false };
    },

    async metrics(creds, account, providerPostId) {
      const graph = graphFor();
      const fields = account.platform === "facebook" ? "likes.summary(true).limit(0),comments.summary(true).limit(0),shares" : "like_count,comments_count";
      const j = await call(graph, { method: "GET", path: providerPostId, params: { fields }, token: creds.accessToken, sent: false });
      const out: Record<string, number> = {};
      const summary = (k: string) => {
        const v = j[k];
        const n = v && typeof v === "object" ? ((v as Record<string, unknown>).summary as Record<string, unknown> | undefined)?.total_count : undefined;
        return typeof n === "number" ? n : null;
      };
      if (account.platform === "facebook") {
        const likes = summary("likes");
        const comments = summary("comments");
        const shares = j.shares && typeof j.shares === "object" ? (j.shares as Record<string, unknown>).count : undefined;
        if (likes !== null) out.likes = likes;
        if (comments !== null) out.comments = comments;
        if (typeof shares === "number") out.shares = shares;
      } else {
        if (typeof j.like_count === "number") out.likes = j.like_count;
        if (typeof j.comments_count === "number") out.comments = j.comments_count;
      }
      return out;
    },
  };
}

export const metaProvider = createMetaProvider();
