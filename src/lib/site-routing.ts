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
  if (pathname.startsWith("/_a/")) return { kind: "site", host, target: `${SITE_PREFIX}/${h}/asset/${encodeURIComponent(pathname.slice(4).split("/")[0])}`, isForm: false };
  if (pathname === "/robots.txt") return { kind: "site", host, target: `${SITE_PREFIX}/${h}/robots`, isForm: false };
  if (pathname === "/sitemap.xml") return { kind: "site", host, target: `${SITE_PREFIX}/${h}/sitemap`, isForm: false };
  return { kind: "site", host, target: `${SITE_PREFIX}/${h}/p${pathname === "/" ? "" : pathname}`, isForm: false };
}

/** A strict policy for public sites: no third-party anything, no framing, forms only post back to the same site. */
export function siteContentSecurityPolicy(nonce: string, dev: boolean): string {
  return [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self'${dev ? " 'unsafe-inline'" : ""}`,
    // The renderer sets brand colours as CSS variables in style attributes, which need this and nothing more.
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self'${dev ? " ws: wss:" : ""}`,
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    ...(dev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}
