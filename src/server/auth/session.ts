import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { SESSION_ABSOLUTE_DAYS, validateSessionToken, type SessionUser } from "@/server/auth/service";
import { supabaseSessionUser, supabaseSessionUserStrict } from "@/server/auth/supabase";

export function sessionCookieName() {
  // __Host- cookies must be Secure, host-only and path=/, which blocks subdomain overwrites.
  return env().NODE_ENV === "production" ? "__Host-iaq_session" : "iaq_session";
}

export const ORG_COOKIE = "iaq_org";

export async function setSessionCookie(token: string) {
  const jar = await cookies();
  jar.set(sessionCookieName(), token, {
    httpOnly: true,
    secure: env().NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_ABSOLUTE_DAYS * 24 * 60 * 60,
  });
}

export async function clearSessionCookie() {
  const jar = await cookies();
  jar.delete(sessionCookieName());
  jar.delete(ORG_COOKIE);
}

export async function readSessionToken(): Promise<string | undefined> {
  const jar = await cookies();
  return jar.get(sessionCookieName())?.value;
}

/** Resolves the signed-in user once per request. */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  if (env().AUTH_PROVIDER === "supabase") return supabaseSessionUser();
  return validateSessionToken(await readSessionToken());
});

/** For pages: redirects to sign-in when there is no valid session. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

/** For route handlers and server actions: throws instead of redirecting. */
export async function requireUserOrThrow(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) throw new AppError("unauthenticated", "Your session has ended. Please sign in again.");
  return user;
}

/**
 * For high-risk actions (credentials, activation). With Supabase Auth this asks the Auth server
 * whether the account still exists and is not banned instead of trusting a token that may be up
 * to an hour old. The built-in auth already checks the database on every request.
 */
export async function requireFreshUserOrThrow(): Promise<SessionUser> {
  const user = env().AUTH_PROVIDER === "supabase" ? await supabaseSessionUserStrict() : await getCurrentUser();
  if (!user) throw new AppError("unauthenticated", "Your session has ended. Please sign in again.");
  return user;
}

export async function requestMeta(): Promise<{ ip: string | null; userAgent: string | null }> {
  const h = await headers();
  // Behind a trusted reverse proxy the first X-Forwarded-For entry is the client address.
  const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return { ip: forwarded || h.get("x-real-ip") || null, userAgent: h.get("user-agent") };
}

/**
 * Rejects cross-site requests to JSON route handlers. Server Actions already get an equivalent
 * origin check from Next.js; SameSite=Lax cookies add a second layer.
 */
export async function assertSameOrigin() {
  const h = await headers();
  const origin = h.get("origin");
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!origin || !host) throw new AppError("forbidden", "Request origin could not be verified.");
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new AppError("forbidden", "Request origin could not be verified.");
  }
  if (originHost !== host) throw new AppError("forbidden", "Cross-site requests are not allowed.");
}
