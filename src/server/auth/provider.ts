import "server-only";
import { env } from "@/server/env";
import {
  acceptInvitationAsNewUser,
  authenticate,
  changePassword,
  listSessions,
  requestPasswordReset,
  revokeAllSessions,
  revokeSessionById,
  revokeSessionToken,
  sendVerificationEmail,
  type SessionUser,
} from "@/server/auth/service";
import { clearSessionCookie, readSessionToken, setSessionCookie } from "@/server/auth/session";
import {
  supabaseAcceptInvitationAsNewUser,
  supabaseChangePassword,
  supabaseListSessions,
  supabaseRequestPasswordReset,
  supabaseSendVerificationEmail,
  supabaseSignIn,
  supabaseSignOut,
  supabaseSignOutOthers,
} from "@/server/auth/supabase";

/**
 * One surface for identity operations. Server actions call this; it routes to Supabase Auth, or to the
 * built-in auth when `AUTH_PROVIDER=local` (synthetic local demos and tests only; production rejects it). Both paths share the
 * same invitation rules, password policy, rate limits and audit trail.
 */

export type ProviderLoginResult =
  | { ok: true; userId: string }
  | {
      ok: false;
      reason: "invalid" | "rate_limited" | "locked" | "unverified" | "disabled" | "no_profile";
      retryAfterSeconds?: number;
      userId?: string;
    };

export const usingSupabaseAuth = () => env().AUTH_PROVIDER === "supabase";

export async function signInWithPassword(input: {
  email: string;
  password: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<ProviderLoginResult> {
  if (usingSupabaseAuth()) return supabaseSignIn(input);
  const result = await authenticate(input);
  if (!result.ok) return result;
  await setSessionCookie(result.token);
  return { ok: true, userId: result.userId };
}

export async function signOutCurrent(): Promise<void> {
  if (usingSupabaseAuth()) {
    await supabaseSignOut("local");
    await clearSessionCookie();
    return;
  }
  const token = await readSessionToken();
  if (token) await revokeSessionToken(token);
  await clearSessionCookie();
}

export async function requestReset(email: string, ip?: string | null): Promise<{ rateLimited: boolean }> {
  return usingSupabaseAuth() ? supabaseRequestPasswordReset(email, ip) : requestPasswordReset(email, ip);
}

export async function acceptInviteAsNewUser(input: {
  token: string;
  fullName: string;
  password: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (usingSupabaseAuth()) {
    const res = await supabaseAcceptInvitationAsNewUser(input);
    return res.ok ? { ok: true } : res;
  }
  const res = await acceptInvitationAsNewUser(input);
  if (!res.ok) return res;
  await setSessionCookie(res.sessionToken);
  return { ok: true };
}

export async function resendVerification(userId: string): Promise<{ ok: boolean; rateLimited?: boolean }> {
  return usingSupabaseAuth() ? supabaseSendVerificationEmail(userId) : sendVerificationEmail(userId);
}

export async function changeOwnPassword(user: SessionUser, current: string, next: string) {
  return usingSupabaseAuth() ? supabaseChangePassword(user, current, next) : changePassword(user.id, user.sessionId, current, next);
}

export interface SessionSummary {
  id: string;
  current: boolean;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
}

export async function listOwnSessions(user: SessionUser): Promise<SessionSummary[]> {
  const rows = usingSupabaseAuth() ? await supabaseListSessions(user.id) : await listSessions(user.id);
  return rows.map((r) => ({
    id: r.id,
    current: r.id === user.sessionId,
    userAgent: r.user_agent,
    createdAt: new Date(r.created_at).toISOString(),
    lastSeenAt: new Date(r.last_seen_at).toISOString(),
  }));
}

export async function revokeOtherSessions(user: SessionUser): Promise<void> {
  if (usingSupabaseAuth()) await supabaseSignOutOthers();
  else await revokeAllSessions(user.id, user.sessionId);
}

/** Single-session revocation. Supabase Auth has no per-session admin API, so only the built-in auth supports it. */
export async function revokeOneSession(user: SessionUser, sessionId: string): Promise<boolean> {
  if (usingSupabaseAuth()) return false;
  return revokeSessionById(user.id, sessionId);
}

export const supportsPerSessionRevoke = () => !usingSupabaseAuth();
