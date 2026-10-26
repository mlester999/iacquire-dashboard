// Whether a request that changes something came from a page on this very site (the check that stops another site posting a form to a customer's link).
//
// A browser sends Origin on every POST, but when the page was served with Referrer-Policy: no-referrer (every page that carries a secret in its address, as the customer
// proposal and invoice pages do) it sends the literal Origin: null for a form submitted from the same page. Sec-Fetch-Site still says "same-origin" there, so that is
// what decides. A request with neither header is not from a browser form on another site (a script, a test); a request that says cross-site never passes.

export interface SameSiteFacts {
  origin: string | null;
  host: string | null;
  secFetchSite: string | null;
}

export function isSameSite({ origin, host, secFetchSite }: SameSiteFacts): boolean {
  const fetchSite = secFetchSite?.trim().toLowerCase() || null;
  if (origin && origin !== "null") {
    try {
      return host !== null && new URL(origin).host.toLowerCase() === host.toLowerCase();
    } catch {
      return false;
    }
  }
  if (origin === "null") return fetchSite === "same-origin";
  if (fetchSite) return fetchSite === "same-origin" || fetchSite === "none";
  return true;
}

export function sameSiteRequest(req: Request): boolean {
  return isSameSite({
    origin: req.headers.get("origin"),
    host: req.headers.get("x-forwarded-host") ?? req.headers.get("host"),
    secFetchSite: req.headers.get("sec-fetch-site"),
  });
}
