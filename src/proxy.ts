import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { readSupabasePublicConfig, resolveAuthProvider } from "@/lib/supabase-config";
import { routeRequest, siteContentSecurityPolicy, type DeploymentRole, type SiteRoute } from "@/lib/site-routing";

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
  // The embeddable website-chat script: a public file, the same for everyone, carrying no secret.
  /^\/widget\//,
  /^\/dev\//,
  // Public booking pages and the customer's manage link. They read only public-safe data; the manage pages authorize by their secret.
  /^\/book\//,
  // Unsubscribe confirmation pages for marketing messages. The signed link token in the URL is the only authorization.
  /^\/unsubscribe\//,
  // Hosted form pages (native CRM forms). They show only a published form's public questions and post to /api/public/forms/submit.
  /^\/f\//,
  // A customer's review request page. The random token in the URL is the only authorization; it can only add feedback to its own request.
  /^\/r\//,
  // A customer's proposal page and its PDF. The random token in the URL is the only authorization; answering needs a code emailed to the customer's address.
  /^\/proposal\//,
  // A customer's invoice page and the page a payment provider sends them back to. The invoice's private link (or a checkout's reference) in the URL is the only authorization;
  // the page can start a payment for the invoice's balance and show where it stands, nothing else.
  /^\/pay\//,
  // The prospect demo: asking for it, the emailed link's button and the demo room. A prospect is not a user; the emailed link (works once) and the demo's own cookie are the only
  // credentials, and they open nothing but that prospect's own demo. Its API is already public through /api/public/ above.
  /^\/demo(?:\/|$)/,
  // A purchase invitation: the random token in the URL is the only authorization. It shows one frozen offer and can only record that buyer's confirmation; no account,
  // payment or workspace is created by the public page.
  /^\/purchase\//,
];

/** Pages whose URL carries a customer's manage secret: never cached, indexed, or sent on as a referrer. */
const SECRET_URL = /^(?:\/book\/(?:manage\/|[^/]+\/[^/]+\/[^/]+\/confirmed\/?$)|\/proposal\/|\/api\/public\/proposals\/|\/pay\/|\/api\/public\/invoices\/|\/api\/webhooks\/esign\/|\/demo\/(?:verify|room)(?:\/|$)|\/api\/public\/demo\/|\/purchase\/)/;

function contentSecurityPolicy(nonce: string, supabaseOrigin: string | null, framable = false) {
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
    // Isolated website previews (/frame/*) may be shown inside the portal's own pages and nowhere else.
    framable ? "frame-ancestors 'self'" : "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    ...(dev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

/** The portal's own origin (from APP_URL), which a customer's site may call for its website chat. Null when APP_URL is missing or invalid. */
function appOrigin(): string | null {
  try {
    return new URL(process.env.APP_URL ?? "").origin;
  } catch {
    return null;
  }
}

/**
 * Public customer websites. They are served from the same codebase but never share a session, cookie or privilege with the
 * portal: every request to a site host is rewritten to the internal site routes and answered with a strict, site-only policy.
 */
function siteResponse(req: NextRequest, route: Extract<SiteRoute, { kind: "site" }>) {
  const notFound = () => new NextResponse("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  // A Server Function call can never be a legitimate request to a customer's website.
  if (req.headers.has("next-action")) return notFound();
  if (!["GET", "HEAD", "POST"].includes(req.method)) return new NextResponse(null, { status: 405, headers: { Allow: "GET, HEAD, POST" } });
  if (req.method === "POST" && !route.isForm) return new NextResponse(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  const nonce = btoa(crypto.randomUUID());
  const csp = siteContentSecurityPolicy(nonce, process.env.NODE_ENV !== "production", appOrigin());
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  requestHeaders.set("x-site-host", route.host);
  // Whatever cookies or credentials a visitor's browser sends are irrelevant to a public site; do not let them reach it.
  requestHeaders.delete("cookie");
  requestHeaders.delete("authorization");
  const url = req.nextUrl.clone();
  url.pathname = route.target;
  const res = NextResponse.rewrite(url, { request: { headers: requestHeaders } });
  res.headers.set("Content-Security-Policy", csp);
  return res;
}

export async function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const role = (["portal", "sites", "both"].includes(process.env.DEPLOYMENT_ROLE ?? "") ? process.env.DEPLOYMENT_ROLE : "portal") as DeploymentRole;
  let appHost = "";
  try {
    appHost = new URL(process.env.APP_URL ?? "http://localhost:3000").hostname;
  } catch {
    /* an invalid APP_URL is reported by the environment check elsewhere */
  }
  const routing = routeRequest({ role, hostHeader: req.headers.get("host"), pathname, portalHosts: [appHost] });
  if (routing.kind === "block") return new NextResponse("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  if (routing.kind === "pass") return NextResponse.next();
  if (routing.kind === "site") return siteResponse(req, routing);


  const isPublic = PUBLIC.some((re) => re.test(pathname));
  const provider = resolveAuthProvider(process.env);
  const supabase = provider === "supabase" ? readSupabasePublicConfig(process.env) : null;

  const nonce = btoa(crypto.randomUUID());
  const csp = contentSecurityPolicy(nonce, supabase ? new URL(supabase.url).origin : null, pathname.startsWith("/frame/") || pathname.startsWith("/dev/frame/"));

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
  if (SECRET_URL.test(pathname)) {
    res.headers.set("Cache-Control", "no-store");
    res.headers.set("X-Robots-Tag", "noindex, nofollow");
    res.headers.set("Referrer-Policy", "no-referrer");
  }
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|brand/|mascots/|.*\\.(?:svg|png|webp|jpg|ico)$).*)"],
};
