import "server-only";
import crypto from "node:crypto";
import { env } from "@/server/env";
import { randomToken } from "@/server/security/crypto";
import { errorFor, parseJson, providerRequest } from "@/server/calendars/adapters/http";
import { CalendarProviderError } from "@/server/calendars/adapters/types";

// OAuth 2.0 authorization-code sign-in with PKCE (S256) for Google and Microsoft. Endpoints come from each provider's published OpenID
// configuration (accounts.google.com/.well-known/openid-configuration, login.microsoftonline.com/{tenant}/v2.0/.well-known/...),
// read 2026-10-16. The client secret stays on the server; tokens are only ever held encrypted (see connections.ts).

export type OAuthProvider = "google" | "microsoft";

export const GOOGLE = {
  authorize: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  revoke: "https://oauth2.googleapis.com/revoke",
  userinfo: "https://openidconnect.googleapis.com/v1/userinfo",
  origins: ["https://oauth2.googleapis.com", "https://openidconnect.googleapis.com"],
} as const;

/**
 * Least privilege for what we do: list the calendars (calendarList.list), read availability on any of them (events.list / freeBusy.query
 * accept calendar.events.freebusy), and create, change and delete only the events we add on calendars the person owns
 * (calendar.events.owned). "openid email" identify the account for its label.
 */
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
  "https://www.googleapis.com/auth/calendar.events.owned",
] as const;
export const GOOGLE_REQUIRED_SCOPES = ["https://www.googleapis.com/auth/calendar.calendarlist.readonly", "https://www.googleapis.com/auth/calendar.events.freebusy"];
export const GOOGLE_WRITE_SCOPE = "https://www.googleapis.com/auth/calendar.events.owned";

export const MICROSOFT_SCOPES = ["openid", "offline_access", "https://graph.microsoft.com/User.Read", "https://graph.microsoft.com/Calendars.ReadWrite"] as const;
const microsoftBase = (tenant: string) => `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0`;

export interface OAuthConfig {
  provider: OAuthProvider;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authorizeUrl: string;
  tokenUrl: string;
  tokenOrigin: string;
  scopes: readonly string[];
}

/** The redirect URI registered with the provider: always the portal's own callback route. */
export function redirectUriFor(provider: OAuthProvider): string {
  return `${env().APP_URL.replace(/\/+$/, "")}/api/crm/calendar-oauth/${provider}/callback`;
}

/** The provider's app registration, or null when iAcquire hasn't set it up in this deployment. */
export function oauthConfig(provider: OAuthProvider): OAuthConfig | null {
  const e = env();
  if (provider === "google") {
    if (!e.GOOGLE_CALENDAR_CLIENT_ID || !e.GOOGLE_CALENDAR_CLIENT_SECRET) return null;
    return { provider, clientId: e.GOOGLE_CALENDAR_CLIENT_ID, clientSecret: e.GOOGLE_CALENDAR_CLIENT_SECRET, redirectUri: redirectUriFor(provider), authorizeUrl: GOOGLE.authorize, tokenUrl: GOOGLE.token, tokenOrigin: "https://oauth2.googleapis.com", scopes: GOOGLE_SCOPES };
  }
  if (!e.MICROSOFT_CALENDAR_CLIENT_ID || !e.MICROSOFT_CALENDAR_CLIENT_SECRET) return null;
  const base = microsoftBase(e.MICROSOFT_CALENDAR_TENANT);
  return { provider, clientId: e.MICROSOFT_CALENDAR_CLIENT_ID, clientSecret: e.MICROSOFT_CALENDAR_CLIENT_SECRET, redirectUri: redirectUriFor(provider), authorizeUrl: `${base}/authorize`, tokenUrl: `${base}/token`, tokenOrigin: "https://login.microsoftonline.com", scopes: MICROSOFT_SCOPES };
}

/** A PKCE pair (RFC 7636): a 64-character verifier and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken(48);
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function authorizeUrl(cfg: OAuthConfig, state: string, challenge: string): string {
  const u = new URL(cfg.authorizeUrl);
  const p = u.searchParams;
  p.set("client_id", cfg.clientId);
  p.set("redirect_uri", cfg.redirectUri);
  p.set("response_type", "code");
  p.set("scope", cfg.scopes.join(" "));
  p.set("state", state);
  p.set("code_challenge", challenge);
  p.set("code_challenge_method", "S256");
  if (cfg.provider === "google") {
    // A refresh token is only issued for offline access, and only re-issued on a fresh consent.
    p.set("access_type", "offline");
    p.set("prompt", "consent");
  } else {
    p.set("response_mode", "query");
    p.set("prompt", "select_account");
  }
  return u.toString();
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms. */
  expiresAt: number;
  scopes: string[];
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number | string;
  scope?: string;
  token_type?: string;
  error?: string;
}

async function tokenRequest(cfg: OAuthConfig, form: Record<string, string>, now: number): Promise<TokenSet> {
  const body = new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...form }).toString();
  const service = cfg.provider === "google" ? "Google" : "Microsoft";
  const res = await providerRequest(null, cfg.tokenUrl, [cfg.tokenOrigin], { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }, service);
  const json = res.text ? parseJson<TokenResponse>(res.text, service) : {};
  if (res.status >= 400 || !json.access_token) {
    const code = typeof json.error === "string" ? json.error : null;
    // invalid_grant: the code or refresh token was revoked, expired or already used. Only the person can fix that, by signing in again.
    if (code === "invalid_grant" || code === "interaction_required" || code === "consent_required") throw new CalendarProviderError("auth", `${service} no longer accepts the saved sign-in (${code}).`, { status: res.status, code });
    if (res.status >= 500 || res.status === 429) throw errorFor(res.status, service, res.headers, code);
    throw new CalendarProviderError("invalid", `${service} refused the sign-in${code ? ` (${code})` : ""}.`, { status: res.status, code });
  }
  const expiresIn = Number(json.expires_in ?? 3600);
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: now + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000,
    scopes: (json.scope ?? "").split(/\s+/).filter(Boolean),
  };
}

export function exchangeCode(cfg: OAuthConfig, code: string, verifier: string, now = Date.now()): Promise<TokenSet> {
  const form: Record<string, string> = { grant_type: "authorization_code", code, redirect_uri: cfg.redirectUri, code_verifier: verifier };
  if (cfg.provider === "microsoft") form.scope = cfg.scopes.join(" ");
  return tokenRequest(cfg, form, now);
}

/** Uses the refresh token. Microsoft rotates it (the new one replaces the old); Google keeps the same one. */
export async function refreshAccessToken(cfg: OAuthConfig, refreshToken: string, now = Date.now()): Promise<TokenSet> {
  const form: Record<string, string> = { grant_type: "refresh_token", refresh_token: refreshToken };
  if (cfg.provider === "microsoft") form.scope = cfg.scopes.join(" ");
  const t = await tokenRequest(cfg, form, now);
  return { ...t, refreshToken: t.refreshToken ?? refreshToken };
}

/** Revokes a Google grant (RFC 7009 endpoint). Microsoft has no per-app token revocation for delegated access; the person removes the app. */
export async function revokeToken(provider: OAuthProvider, token: string): Promise<boolean> {
  if (provider !== "google") return false;
  const res = await providerRequest(null, GOOGLE.revoke, ["https://oauth2.googleapis.com"], { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }).toString() }, "Google").catch(() => null);
  return !!res && res.status === 200;
}
