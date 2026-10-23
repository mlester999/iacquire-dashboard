import "server-only";
import crypto from "node:crypto";
import { env } from "@/server/env";
import { classifyProviderFailure, type ProviderErrorBody } from "@/lib/social/errors";
import { graphCall, metaSettings, type GraphCall, type MetaSettings } from "@/server/social/providers/meta";
import { ProviderError } from "@/server/social/providers/types";
import type { Platform } from "@/lib/social/rules";

// Signing a person in with Facebook so they can choose which of their Pages to connect, and reading Meta's deauthorization and data-deletion callbacks.
// Like meta.ts, this has only run against a replaced HTTP layer: no Meta app exists for this deployment.
//
// The permissions asked for are the ones Meta documents for publishing to Pages and to a linked Instagram professional account through Facebook Login. They
// are the least this feature needs: reading the list of Pages, reading Page engagement, publishing posts, and for Instagram its basic read and content
// publishing. Insights permissions are not requested: this build collects only likes, comments and shares. Re-read Meta's current permission names and App Review
// requirements before submitting the app: they change, and a permission not approved for the live app only works for the app's own testers.

export const META_SCOPES: Record<Platform, readonly string[]> = {
  facebook: ["pages_show_list", "pages_read_engagement", "pages_manage_posts"],
  instagram: ["pages_show_list", "pages_read_engagement", "pages_manage_posts", "instagram_basic", "instagram_content_publish"],
};

export const metaConfigured = (s: MetaSettings = metaSettings()) => Boolean(s.appId && s.appSecret);

export const redirectUri = () => `${env().APP_URL.replace(/\/+$/, "")}/api/social/oauth/meta/callback`;

export function authorizeUrl(state: string, platform: Platform, s: MetaSettings = metaSettings()): string {
  if (!s.appId) throw new ProviderError("transient", "The Meta app is not configured in this deployment.");
  const u = new URL(`https://www.facebook.com/${s.version}/dialog/oauth`);
  u.searchParams.set("client_id", s.appId);
  u.searchParams.set("redirect_uri", redirectUri());
  u.searchParams.set("state", state);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", META_SCOPES[platform].join(","));
  // A permission someone declined once is not offered again unless it is asked for again; without this, "reconnect and allow it" could loop. Harmless on a
  // first connection, where nothing has been declined.
  u.searchParams.set("auth_type", "rerequest");
  return u.toString();
}

async function app(graph: GraphCall, path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  let res;
  try {
    res = await graph({ method: "GET", path, params, token: "", sent: false });
  } catch {
    throw new ProviderError("transient", "Meta could not be reached. Try again in a moment.");
  }
  if (res.status >= 400 || (res.json && "error" in res.json)) {
    const error = res.json && typeof res.json.error === "object" ? (res.json.error as ProviderErrorBody) : null;
    const c = classifyProviderFailure({ httpStatus: res.status, error, sent: false });
    throw new ProviderError(c.kind === "invalid_content" ? "auth" : c.kind, c.kind === "invalid_content" ? "Meta did not accept the sign-in. Start again." : c.message, { needsReauth: false });
  }
  return res.json ?? {};
}

export interface ConnectedPage {
  id: string;
  name: string;
  token: string;
  /** Meta lists what the person may do on the Page; posting needs CREATE_CONTENT (or full control). */
  tasks: string[];
  instagram: { id: string; username: string | null; name: string | null } | null;
}

export interface MetaIdentity {
  userId: string;
  userName: string | null;
  pages: ConnectedPage[];
}

/** Exchanges the sign-in code for a long-lived token and reads which Pages the person manages (each with the Page's own token). */
export async function resolveSignIn(code: string, deps: { graph?: GraphCall; settings?: MetaSettings } = {}): Promise<MetaIdentity> {
  const s = deps.settings ?? metaSettings();
  if (!s.appId || !s.appSecret) throw new ProviderError("transient", "The Meta app is not configured in this deployment.");
  const graph = deps.graph ?? graphCall(s.version);
  const short = await app(graph, "oauth/access_token", { client_id: s.appId, client_secret: s.appSecret, redirect_uri: redirectUri(), code });
  const shortToken = typeof short.access_token === "string" ? short.access_token : null;
  if (!shortToken) throw new ProviderError("auth", "Meta did not accept the sign-in. Start again.");
  const long = await app(graph, "oauth/access_token", { grant_type: "fb_exchange_token", client_id: s.appId, client_secret: s.appSecret, fb_exchange_token: shortToken });
  const userToken = typeof long.access_token === "string" ? long.access_token : shortToken;
  const me = await graph({ method: "GET", path: "me", params: { fields: "id,name" }, token: userToken, sent: false }).catch(() => null);
  const userId = me?.json && typeof me.json.id === "string" ? me.json.id : null;
  if (!userId) throw new ProviderError("auth", "Meta did not say who signed in. Start again.");
  const accounts = await graph({ method: "GET", path: "me/accounts", params: { fields: "id,name,access_token,tasks,instagram_business_account{id,username,name}", limit: "100" }, token: userToken, sent: false }).catch(() => null);
  if (!accounts || accounts.status >= 400 || !accounts.json) throw new ProviderError("transient", "Meta did not return your Pages. Try again.");
  const pages: ConnectedPage[] = [];
  for (const p of Array.isArray(accounts.json.data) ? accounts.json.data : []) {
    const r = p as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.access_token !== "string") continue;
    const ig = r.instagram_business_account && typeof r.instagram_business_account === "object" ? (r.instagram_business_account as Record<string, unknown>) : null;
    pages.push({
      id: r.id, name: typeof r.name === "string" ? r.name : r.id, token: r.access_token,
      tasks: Array.isArray(r.tasks) ? r.tasks.filter((t): t is string => typeof t === "string") : [],
      instagram: ig && typeof ig.id === "string" ? { id: ig.id, username: typeof ig.username === "string" ? ig.username : null, name: typeof ig.name === "string" ? ig.name : null } : null,
    });
  }
  return { userId, userName: me?.json && typeof me.json.name === "string" ? me.json.name : null, pages };
}

/** Whether the person's role on the Page lets them publish to it. A list that does not say is read as "cannot": better to ask them to fix it than to fail later. */
export const canPostTo = (page: ConnectedPage) => page.tasks.includes("CREATE_CONTENT") || page.tasks.includes("MANAGE");

// ---------------------------------------------------------------------------
// Signed requests: the deauthorization and data-deletion callbacks
// ---------------------------------------------------------------------------

/**
 * Reads a `signed_request` Meta sends to the callback addresses: `<signature>.<payload>`, both base64url, the signature an HMAC-SHA256 of the payload text
 * made with the app secret. Returns the payload only when the signature is right (compared in constant time) and the algorithm is the expected one.
 */
export function parseSignedRequest(signed: string, appSecret: string): { user_id?: string; algorithm?: string; issued_at?: number } | null {
  const [sig, payload, ...rest] = signed.split(".");
  if (!sig || !payload || rest.length) return null;
  let given: Buffer;
  let body: { user_id?: string; algorithm?: string; issued_at?: number };
  try {
    given = Buffer.from(sig, "base64url");
    body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || String(body.algorithm ?? "").toUpperCase() !== "HMAC-SHA256") return null;
  const expected = crypto.createHmac("sha256", appSecret).update(payload).digest();
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  return body;
}

/** Builds a signed request the way Meta does. Used only by tests and the local QA harness. */
export function signRequestForTests(payload: Record<string, unknown>, appSecret: string): string {
  const body = Buffer.from(JSON.stringify({ algorithm: "HMAC-SHA256", issued_at: 1, ...payload })).toString("base64url");
  const sig = crypto.createHmac("sha256", appSecret).update(body).digest("base64url");
  return `${sig}.${body}`;
}
