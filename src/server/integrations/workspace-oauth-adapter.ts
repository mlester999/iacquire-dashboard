import "server-only";
import { z } from "zod";
import { WORKSPACE_OAUTH_LABEL, type WorkspaceOAuthProvider } from "@/lib/integrations/workspace-oauth";
import { providerRequest, type HttpRequest } from "@/server/calendars/adapters/http";
import { env } from "@/server/env";

export const NOTION_API = "https://api.notion.com";
const AIRTABLE_AUTH = "https://airtable.com";
export const AIRTABLE_API = "https://api.airtable.com";
export const NOTION_VERSION = "2026-03-11";
const AIRTABLE_METADATA_SCOPE = "schema.bases:read";
export const AIRTABLE_RECORD_SCOPE = "schema.bases:read data.records:read";
const TIMEOUT_MS = 5_000;

type OAuthFailureKind = "auth" | "permission" | "missing" | "rate_limit" | "unavailable" | "invalid_response";

export class WorkspaceOAuthError extends Error {
  constructor(readonly kind: OAuthFailureKind, readonly retryAfter?: number) {
    super("The provider connection check did not succeed.");
  }
}

export interface OAuthConfig {
  provider: WorkspaceOAuthProvider;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export const workspaceTokensSchema = z.object({
  accessToken: z.string().min(1).max(16_384).regex(/^[\x21-\x7e]+$/),
  refreshToken: z.string().min(1).max(16_384).regex(/^[\x21-\x7e]+$/),
  expiresAt: z.number().int().positive().nullable(),
  refreshExpiresAt: z.number().int().positive().nullable(),
  airtableScope: z.enum([AIRTABLE_METADATA_SCOPE, AIRTABLE_RECORD_SCOPE]).optional(),
}).strict();

export type WorkspaceTokens = z.infer<typeof workspaceTokensSchema>;

export function workspaceOAuthConfig(provider: WorkspaceOAuthProvider): OAuthConfig | null {
  const e = env();
  const [clientId, clientSecret] = provider === "notion"
    ? [e.NOTION_WORKSPACE_OAUTH_CLIENT_ID, e.NOTION_WORKSPACE_OAUTH_CLIENT_SECRET]
    : [e.AIRTABLE_WORKSPACE_OAUTH_CLIENT_ID, e.AIRTABLE_WORKSPACE_OAUTH_CLIENT_SECRET];
  if (!clientId || !clientSecret) return null;
  const redirectUri = new URL(`/api/integrations/workspace-oauth/${provider}/callback`, e.APP_URL);
  const localHttp = e.NODE_ENV !== "production" && redirectUri.protocol === "http:"
    && ["127.0.0.1", "localhost", "[::1]"].includes(redirectUri.hostname);
  if (redirectUri.username || redirectUri.password || (redirectUri.protocol !== "https:" && !localHttp)) return null;
  return { provider, clientId, clientSecret, redirectUri: redirectUri.toString() };
}

export function workspaceAuthorizeUrl(cfg: OAuthConfig, state: string, challenge?: string): string {
  const url = cfg.provider === "notion" ? new URL("/v1/oauth/authorize", NOTION_API) : new URL("/oauth2/v1/authorize", AIRTABLE_AUTH);
  url.search = new URLSearchParams({ client_id: cfg.clientId, state, redirect_uri: cfg.redirectUri, response_type: "code" }).toString();
  if (cfg.provider === "notion") url.searchParams.set("owner", "user");
  else {
    if (!challenge) throw new WorkspaceOAuthError("invalid_response");
    url.searchParams.set("scope", AIRTABLE_RECORD_SCOPE);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

export async function workspaceProviderRequest(cfg: OAuthConfig, origin: string, path: string, init: HttpRequest) {
  // The caller chooses these fixed provider paths; no client-supplied URLs or redirect hopping.
  const response = await providerRequest(null, `${origin}${path}`, [origin], {
    ...init, timeoutMs: TIMEOUT_MS, maxBytes: init.maxBytes ?? 65_536,
  }, WORKSPACE_OAUTH_LABEL[cfg.provider]).catch(() => { throw new WorkspaceOAuthError("unavailable"); });
  let json: unknown = null;
  try {
    if (response.text) json = JSON.parse(response.text);
  } catch {
    if (response.status >= 200 && response.status < 300) throw new WorkspaceOAuthError("invalid_response");
  }
  const code = json && typeof json === "object" && "error" in json ? json.error : undefined;
  if (response.status === 401 || code === "invalid_grant") throw new WorkspaceOAuthError("auth");
  if (response.status === 403) throw new WorkspaceOAuthError("permission");
  if (response.status === 404) throw new WorkspaceOAuthError("missing");
  if (response.status === 429) {
    const retry = Number(response.headers.get("retry-after"));
    throw new WorkspaceOAuthError("rate_limit", Number.isFinite(retry) && retry > 0 ? Math.min(Math.ceil(retry), 86_400) : 60);
  }
  if (response.status === 409 || response.status >= 500) throw new WorkspaceOAuthError("unavailable");
  if (response.status < 200 || response.status >= 300) throw new WorkspaceOAuthError("invalid_response");
  return json;
}

function basic(cfg: OAuthConfig): string {
  const encoding = cfg.provider === "airtable" ? "base64url" : "base64";
  return `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`, "utf8").toString(encoding)}`;
}

function notionOauthRequest(cfg: OAuthConfig, path: string, payload: Record<string, string>) {
  return workspaceProviderRequest(cfg, NOTION_API, path, {
    method: "POST", body: JSON.stringify(payload),
    headers: { Authorization: basic(cfg), "Content-Type": "application/json", "Notion-Version": NOTION_VERSION },
  });
}

const tokenResponse = z.object({
  access_token: workspaceTokensSchema.shape.accessToken,
  refresh_token: workspaceTokensSchema.shape.refreshToken,
  token_type: z.string().trim().toLowerCase().pipe(z.literal("bearer")),
  expires_in: z.number().int().positive().max(366 * 86400).optional(),
  refresh_expires_in: z.number().int().positive().max(366 * 86400).optional(),
  scope: z.string().max(2048).optional(),
});

async function tokenRequest(
  cfg: OAuthConfig,
  payload: Record<string, string>,
  expectedScope: NonNullable<WorkspaceTokens["airtableScope"]> = AIRTABLE_RECORD_SCOPE,
): Promise<WorkspaceTokens> {
  const data = cfg.provider === "notion"
    ? await notionOauthRequest(cfg, "/v1/oauth/token", payload)
    : await workspaceProviderRequest(cfg, AIRTABLE_AUTH, "/oauth2/v1/token", {
      method: "POST", body: new URLSearchParams(payload).toString(),
      headers: { Authorization: basic(cfg), "Content-Type": "application/x-www-form-urlencoded" },
    });
  const parsed = tokenResponse.safeParse(data);
  if (!parsed.success) throw new WorkspaceOAuthError("invalid_response");
  const { access_token, refresh_token, expires_in, refresh_expires_in, scope } = parsed.data;
  const reportedScopes = scope?.trim().split(/\s+/).sort().join(" ");
  if (cfg.provider === "airtable" && (!expires_in || reportedScopes !== expectedScope.split(" ").sort().join(" "))) {
    throw new WorkspaceOAuthError("permission");
  }
  const now = Date.now();
  return {
    accessToken: access_token, refreshToken: refresh_token,
    expiresAt: expires_in ? now + expires_in * 1000 : null,
    refreshExpiresAt: refresh_expires_in ? now + refresh_expires_in * 1000 : null,
    ...(cfg.provider === "airtable" ? { airtableScope: expectedScope } : {}),
  };
}

export function exchangeWorkspaceCode(cfg: OAuthConfig, code: string, verifier: string | null) {
  if (cfg.provider === "airtable" && !verifier) throw new WorkspaceOAuthError("invalid_response");
  return tokenRequest(cfg, {
    grant_type: "authorization_code", code, redirect_uri: cfg.redirectUri,
    ...(verifier && cfg.provider === "airtable" ? { code_verifier: verifier } : {}),
  });
}

export function refreshWorkspaceToken(cfg: OAuthConfig, previous: WorkspaceTokens) {
  const scope = previous.airtableScope ?? AIRTABLE_METADATA_SCOPE;
  return tokenRequest(cfg, {
    grant_type: "refresh_token", refresh_token: previous.refreshToken, ...(cfg.provider === "airtable" ? { scope } : {}),
  }, scope);
}

/** Verifies the account grant without importing customer records or names. */
export async function verifyWorkspaceToken(cfg: OAuthConfig, accessToken: string): Promise<{ hasSharedResources: boolean | null }> {
  if (cfg.provider === "notion") {
    const result = z.object({ active: z.boolean() }).safeParse(await notionOauthRequest(cfg, "/v1/oauth/introspect", { token: accessToken }));
    if (!result.success) throw new WorkspaceOAuthError("invalid_response");
    if (!result.data.active) throw new WorkspaceOAuthError("auth");
    return { hasSharedResources: null };
  }
  const result = z.object({
    bases: z.array(z.object({ id: z.string().min(1).max(128) })).max(1000),
    offset: z.string().min(1).max(2048).optional(),
  }).safeParse(
    await workspaceProviderRequest(cfg, AIRTABLE_API, "/v0/meta/bases", { headers: { Authorization: `Bearer ${accessToken}` }, maxBytes: 524_288 }),
  );
  if (!result.success) throw new WorkspaceOAuthError("invalid_response");
  return { hasSharedResources: result.data.bases.length > 0 ? true : result.data.offset ? null : false };
}

/** Notion's API revokes its access token. Airtable requires revoking the grant in Airtable. */
export async function revokeWorkspaceAccessToken(cfg: OAuthConfig, token: string): Promise<boolean> {
  if (cfg.provider !== "notion") return false;
  await notionOauthRequest(cfg, "/v1/oauth/revoke", { token });
  return true;
}
