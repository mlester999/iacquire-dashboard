import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { readSupabasePublicConfig, resolveAuthProvider } from "@/lib/supabase-config";

/**
 * Edge-of-app request handling.
 *
 *  1. With Supabase Auth, refreshes the session cookie on every request (getClaims verifies the
 *     token and renews it when it is close to expiry) so Server Components always see a valid token.
 *  2. Redirects signed-out visitors to the sign-in page. This is a UX shortcut, not a security
 *     boundary: every page, server action and route handler still validates the session and the
 *     tenant membership on the server.
 *  3. Issues a per-request nonce for the Content-Security-Policy. Next.js reads the policy from the
 *     request headers and applies the nonce to its own scripts; the root layout applies it to the
 *     theme script.
 */
const PUBLIC = [
  /^\/login/,
  /^\/forgot-password/,
  /^\/reset-password/,
  /^\/verify-email/,
  /^\/auth\//,
  /^\/invite\//,
  /^\/get-started/,
  /^\/api\/health/,
  /^\/api\/public\//,
  /^\/api\/webhooks\//,
  /^\/api\/internal\//,
  /^\/dev\//,
];

function contentSecurityPolicy(nonce: string, supabaseOrigin: string | null) {
  const dev = process.env.NODE_ENV !== "production";
  // Realtime opens a WebSocket straight to the project; nothing else talks to Supabase from the browser.
  const supabaseConnect = supabaseOrigin ? ` ${supabaseOrigin} ${supabaseOrigin.replace(/^http/, "ws")}` : "";
  return [
    "default-src 'self'",
    // 'strict-dynamic' lets nonce'd Next.js scripts load their chunks; development needs eval for HMR.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    // Inline style attributes come from animation and layout code; no remote stylesheets are used.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${supabaseConnect}${dev ? " ws: wss:" : ""}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    ...(dev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

export async function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const isPublic = PUBLIC.some((re) => re.test(pathname));
  const provider = resolveAuthProvider(process.env);
  const supabase = provider === "supabase" ? readSupabasePublicConfig(process.env) : null;

  const nonce = btoa(crypto.randomUUID());
  const csp = contentSecurityPolicy(nonce, supabase ? new URL(supabase.url).origin : null);

  // Built from the *current* request headers so cookies refreshed below are visible downstream.
  const buildResponse = () => {
    const requestHeaders = new Headers(req.headers);
    requestHeaders.set("x-nonce", nonce);
    requestHeaders.set("Content-Security-Policy", csp);
    const next = NextResponse.next({ request: { headers: requestHeaders } });
    next.headers.set("Content-Security-Policy", csp);
    return next;
  };
  let res = buildResponse();

  let signedIn: boolean;
  if (provider === "supabase") {
    if (supabase) {
      const client = createServerClient(supabase.url, supabase.publishableKey, {
        cookieOptions: { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/" },
        cookies: {
          getAll: () => req.cookies.getAll(),
          setAll(cookiesToSet, cacheHeaders) {
            for (const { name, value } of cookiesToSet) req.cookies.set(name, value);
            res = buildResponse();
            for (const { name, value, options } of cookiesToSet) res.cookies.set(name, value, options);
            // Keeps CDNs from caching a response that carries a fresh session cookie.
            for (const [key, value] of Object.entries(cacheHeaders)) res.headers.set(key, value);
          },
        },
      });
      const { data } = await client.auth.getClaims();
      signedIn = Boolean(data?.claims?.sub);
    } else {
      // Misconfigured: the sign-in page explains what is missing.
      signedIn = false;
    }
  } else {
    signedIn = req.cookies.has("__Host-iaq_session") || req.cookies.has("iaq_session");
  }

  if (!isPublic && !signedIn && !pathname.startsWith("/api/")) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname + search)}`;
    const redirect = NextResponse.redirect(url);
    // Carry over any cookies the refresh wrote (e.g. clearing an expired session).
    for (const cookie of res.cookies.getAll()) redirect.cookies.set(cookie);
    for (const header of ["cache-control", "expires", "pragma", "Content-Security-Policy"]) {
      const value = res.headers.get(header);
      if (value) redirect.headers.set(header, value);
    }
    return redirect;
  }
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|brand/|mascots/|.*\\.(?:svg|png|webp|jpg|ico)$).*)"],
};
