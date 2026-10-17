/**
 * Verifies a browser write against the configured portal origin and the public
 * host Vercel received. iAcquire serves its production portal on both the apex
 * and www hostname; those two HTTPS origins are the only configured aliases.
 */
export function isTrustedPortalRequest(input: {
  origin: string | null;
  appUrl: string;
  host: string | null;
  forwardedHost: string | null;
  production: boolean;
}): boolean {
  const { origin, appUrl, host, forwardedHost, production } = input;
  if (!origin) return false;

  let configuredUrl: URL;
  let requestOrigin: URL;
  try {
    configuredUrl = new URL(appUrl);
    requestOrigin = new URL(origin);
  } catch {
    return false;
  }

  if (production && configuredUrl.protocol !== "https:") return false;
  // Browser Origin headers contain only the serialized scheme and authority.
  if (requestOrigin.origin !== origin || requestOrigin.username || requestOrigin.password) return false;

  const allowedOrigins = new Set([configuredUrl.origin]);
  if (
    configuredUrl.protocol === "https:" &&
    !configuredUrl.port &&
    (configuredUrl.hostname === "iacquire.online" || configuredUrl.hostname === "www.iacquire.online")
  ) {
    allowedOrigins.add("https://iacquire.online");
    allowedOrigins.add("https://www.iacquire.online");
  }
  if (!allowedOrigins.has(requestOrigin.origin)) return false;

  // On Vercel, Host and X-Forwarded-Host both describe the hostname the client
  // visited. Validate every supplied value so neither can disagree with Origin.
  const requestHosts = [host, forwardedHost].filter((value): value is string => value !== null);
  if (requestHosts.length === 0) return false;
  return requestHosts.every((value) => normalizeHost(value) === requestOrigin.host);
}

function normalizeHost(value: string): string | null {
  if (!value || value.trim() !== value || value.includes(",")) return null;
  try {
    const url = new URL(`https://${value}`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.host;
  } catch {
    return null;
  }
}
