import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAdmin, requireSupabasePublic } from "@/server/supabase/config";

/**
 * Cookie settings for the Supabase session. The session cookie holds the refresh token, so it is
 * HttpOnly: page scripts (and therefore XSS) cannot read it. Browser code that needs an access
 * token (Realtime) obtains a short-lived one from /api/realtime/token instead.
 */
export function supabaseCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
  };
}

/**
 * A client bound to the visitor's cookies. Use for sign-in/out and for reading the current
 * session. Create one per request; never share it between requests.
 */
export async function createSupabaseServerClient(): Promise<SupabaseClient> {
  const { url, publishableKey } = requireSupabasePublic();
  const jar = await cookies();
  return createServerClient(url, publishableKey, {
    cookieOptions: supabaseCookieOptions(),
    cookies: {
      getAll() {
        return jar.getAll();
      },
      setAll(toSet) {
        try {
          for (const { name, value, options } of toSet) jar.set(name, value, options);
        } catch {
          // Server Components cannot set cookies. The proxy refreshes the session on every
          // request, so skipping the write here is safe.
        }
      },
    },
  });
}

/**
 * Privileged client using the secret key. It bypasses row-level security, so it is for the Auth
 * admin API and server-to-server Realtime publishing only. Never import this into a client
 * component and never return anything it produces without authorizing the caller first.
 */
export function createSupabaseAdminClient(): SupabaseClient {
  const { url, secretKey } = requireSupabaseAdmin();
  return createClient(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

/**
 * A stateless client with the publishable key and no cookies. Used to check a password without
 * touching the visitor's session.
 */
export function createSupabaseStatelessClient(): SupabaseClient {
  const { url, publishableKey } = requireSupabasePublic();
  return createClient(url, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}
