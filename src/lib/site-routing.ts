// Decides, from the Host header and path alone, whether a request belongs to the authenticated portal or to a customer's
// public website, and which internal route serves it. Pure, so the rules are easy to test. The proxy applies the result.

export type DeploymentRole = "portal" | "sites" | "both";

export type SiteRoute =
  | { kind: "portal" }
  /** Internal routes are never reachable directly. */
  | { kind: "block" }
  | { kind: "pass" }
  | { kind: "site"; host: string; target: string; isForm: boolean };

export const SITE_PREFIX = "/site-runtime";

/** /_book, /_book/<calendar>, /_book/<calendar>/<type>: slugs only, so nothing else can be smuggled into the internal route. */
const BOOK_PATH = /^\/_book(\/[a-z0-9]+(?:-[a-z0-9]+)*)?(\/[a-z0-9]+(?:-[a-z0-9]+)*)?\/?$/;
/** /_booked/t/<manage token> or /_booked/a/<appointment id>/<signature>: the page a visitor lands on after booking. */
const BOOKED_PATH = /^\/_booked\/(t\/[A-Za-z0-9_-]{20,64}|a\/[0-9a-f-]{36}\/[0-9a-f]{40})\/?$/;

export function normalizeRequestHost(raw: string | null | undefined): string {
  return (raw ?? "").trim().toLowerCase().replace(/:\d{1,5}$/, "").replace(/\.$/, "");
}

export function routeRequest(input: { role: DeploymentRole; hostHeader: string | null; pathname: string; portalHosts: string[] }): SiteRoute {
  const { pathname } = input;
  // The internal prefix exists only as a rewrite destination. A visitor typing it would otherwise bypass host checks.
  if (pathname === SITE_PREFIX || pathname.startsWith(`${SITE_PREFIX}/`)) return { kind: "block" };
  if (input.role === "portal") return { kind: "portal" };
  const host = normalizeRequestHost(input.hostHeader);
  if (input.role === "both" && (host === "" || input.portalHosts.map((h) => h.toLowerCase()).includes(host) || host === "localhost" || host === "127.0.0.1" || host === "[::1]")) return { kind: "portal" };
  // Framework assets (scripts, styles) are served as they are on every host.
  if (pathname.startsWith("/_next/")) return { kind: "pass" };
  if (!host) return { kind: "block" };
  const h = encodeURIComponent(host);
  if (pathname === "/__iaq/form") return { kind: "site", host, target: `${SITE_PREFIX}/${h}/form`, isForm: true };
  // The site's own booking pages (see lib/website/booking.ts). Only well-formed addresses are routed; anything else is a missing page.
  if (pathname === "/__iaq/book") return { kind: "site", host, target: `${SITE_PREFIX}/${h}/book/submit`, isForm: true };
  const book = BOOK_PATH.exec(pathname);
  if (book) return { kind: "site", host, target: `${SITE_PREFIX}/${h}/book/p${book[1] ?? ""}${book[2] ?? ""}`, isForm: false };
  const booked = BOOKED_PATH.exec(pathname);
  if (booked) return { kind: "site", host, target: `${SITE_PREFIX}/${h}/book/done/${booked[1]}`, isForm: false };
  if (pathname.startsWith("/_a/")) return { kind: "site", host, target: `${SITE_PREFIX}/${h}/asset/${encodeURIComponent(pathname.slice(4).split("/")[0])}`, isForm: false };
  if (pathname === "/robots.txt") return { kind: "site", host, target: `${SITE_PREFIX}/${h}/robots`, isForm: false };
  if (pathname === "/sitemap.xml") return { kind: "site", host, target: `${SITE_PREFIX}/${h}/sitemap`, isForm: false };
  return { kind: "site", host, target: `${SITE_PREFIX}/${h}/p${pathname === "/" ? "" : pathname}`, isForm: false };
}

/**
 * A strict policy for public sites: no third-party anything, no framing, forms only post back to the same site.
 * The one addition is the portal's own origin for `connect-src`, so the website chat (loaded from the portal by a nonce'd script tag) can talk to its API.
 * Nothing else is opened, and only an http(s) origin with no path is accepted.
 */
export function siteContentSecurityPolicy(nonce: string, dev: boolean, chatOrigin?: string | null): string {
  const chat = chatOrigin && /^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/i.test(chatOrigin) ? ` ${chatOrigin}` : "";
  return [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self'${dev ? " 'unsafe-inline'" : ""}`,
    // The renderer sets brand colours as CSS variables in style attributes, which need this and nothing more.
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self'${chat}${dev ? " ws: wss:" : ""}`,
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    ...(dev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}
