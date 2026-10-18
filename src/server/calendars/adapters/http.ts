import "server-only";
import dns from "node:dns";
import net from "node:net";
import { isPublicAddress } from "@/server/onboarding/website";
import { CalendarProviderError, kindForStatus, type AuthSession } from "@/server/calendars/adapters/types";

// HTTP for calendar providers. Google and Microsoft are called only at their fixed official origins, with redirects refused so a bearer
// token can never follow a redirect elsewhere. CalDAV servers and ICS feeds are addresses a person typed, so every hop is checked: HTTPS
// on the standard port, a public host name, and DNS answers that are all public addresses (no loopback, private, link-local or cloud
// metadata ranges; IPv6 is parsed to numbers, so IPv4-mapped and NAT64 forms such as [::ffff:7f00:1] are judged by the IPv4 address they
// reach). Credentials are only sent to hosts the connection trusts. Responses are size-capped and time-limited.
//
// Known gap (docs/calendar-integrations.md): the DNS check and the connection `fetch` opens are separate lookups, so a hostile DNS server
// that answers differently seconds apart (DNS rebinding) isn't fully excluded. Node's built-in fetch has no supported way to pin the
// checked address (that needs an undici dispatcher, which isn't a dependency). HTTPS on port 443 with certificate checks limits what such
// a connection could do to a TLS handshake with an internal port-443 service.

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_BYTES = 5_000_000;

/** DNS lookups for user-supplied hosts. An object so tests can replace it; nothing else should. */
export const hostResolver = {
  async lookup(hostname: string): Promise<string[]> {
    const list = await dns.promises.lookup(hostname, { all: true, verbatim: true });
    return list.map((a) => a.address);
  },
};

export interface HttpRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface HttpResult {
  status: number;
  headers: Headers;
  text: string;
  url: string;
}

async function readLimited(res: Response, maxBytes: number, service: string): Promise<string> {
  if (!res.body) return "";
  const declared = Number(res.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) throw new CalendarProviderError("invalid", `${service} sent more data than we accept.`);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new CalendarProviderError("invalid", `${service} sent more data than we accept.`);
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
}

async function send(url: URL, req: HttpRequest, headers: Record<string, string>, redirect: RequestRedirect, service: string): Promise<{ res: Response; text: string }> {
  let res: Response;
  try {
    res = await fetch(url, { method: req.method ?? "GET", headers, body: req.body, redirect, cache: "no-store", signal: AbortSignal.timeout(req.timeoutMs ?? DEFAULT_TIMEOUT_MS) });
  } catch {
    throw new CalendarProviderError("unavailable", `${service} could not be reached or took too long.`);
  }
  const text = res.status >= 300 && res.status < 400 ? "" : await readLimited(res, req.maxBytes ?? DEFAULT_MAX_BYTES, service);
  return { res, text };
}

/**
 * A request to a provider's fixed official origin. On a 401 the session gets one chance to refresh and the request is retried once.
 * Never follows redirects. Returns every status to the caller, which decides what an error means for that endpoint.
 */
export async function providerRequest(auth: AuthSession | null, rawUrl: string, allowedOrigins: readonly string[], req: HttpRequest, service: string): Promise<HttpResult> {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" || !allowedOrigins.includes(url.origin)) throw new CalendarProviderError("invalid", `${service} returned an address outside its official service.`);
  for (let attempt = 0; ; attempt++) {
    const headers = { Accept: "application/json", ...(auth ? await auth.headers() : {}), ...req.headers };
    const { res, text } = await send(url, req, headers, "error", service);
    if (res.status === 401 && auth && attempt === 0 && (await auth.refresh())) continue;
    return { status: res.status, headers: res.headers, text, url: url.toString() };
  }
}

// ---------------------------------------------------------------------------
// User-supplied hosts (CalDAV servers, ICS feeds)
// ---------------------------------------------------------------------------

const BLOCKED_SUFFIXES = [".local", ".internal", ".localhost", ".localdomain", ".home.arpa", ".lan", ".intranet", ".corp"];

/** Refuses anything that isn't plain HTTPS to a public host on port 443, including every address its name resolves to. */
export async function assertPublicHttps(url: URL): Promise<void> {
  const refuse = (msg: string) => new CalendarProviderError("forbidden", msg, { code: "unsafe_address" });
  if (url.protocol !== "https:") throw refuse("Use an https:// address.");
  if (url.username || url.password) throw refuse("Remove the username or password from the address; enter them in their own fields.");
  if (url.port && url.port !== "443") throw refuse("Only the standard HTTPS port (443) is supported.");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (!isPublicAddress(host)) throw refuse("That address is on a private or local network, which iAcquire can't reach.");
    return;
  }
  if (!host.includes(".") || host === "localhost" || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) throw refuse("Use the calendar's public internet address.");
  let addresses: string[];
  try {
    addresses = await hostResolver.lookup(host);
  } catch {
    throw new CalendarProviderError("not_found", "That server name couldn't be found. Check the address.", { code: "dns" });
  }
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a))) throw refuse("That address points to a private or local network, which iAcquire can't reach.");
}

export interface PublicRequest extends HttpRequest {
  /** Headers that carry credentials; only sent to hosts `trustHost` accepts. */
  authHeaders?: Record<string, string>;
  trustHost?: (host: string) => boolean;
  maxRedirects?: number;
}

/**
 * A request to an address a person supplied. Redirects are followed by hand (at most three), and each destination is checked again;
 * credentials are dropped for any host the connection doesn't trust. 301/302/307/308 keep the method (WebDAV methods aren't
 * downgraded); 303 becomes GET.
 */
export async function publicRequest(rawUrl: string, req: PublicRequest, service: string): Promise<HttpResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new CalendarProviderError("invalid", "That address doesn't look right.");
  }
  let method = req.method ?? "GET";
  let body = req.body;
  for (let hop = 0; hop <= (req.maxRedirects ?? 3); hop++) {
    await assertPublicHttps(url);
    const trusted = !req.trustHost || req.trustHost(url.hostname.toLowerCase());
    const headers = { ...req.headers, ...(trusted ? req.authHeaders : {}) };
    const { res, text } = await send(url, { ...req, method, body }, headers, "manual", service);
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && res.status !== 304 && location) {
      try {
        url = new URL(location, url);
      } catch {
        throw new CalendarProviderError("invalid", `${service} redirected to an invalid address.`);
      }
      if (res.status === 303) {
        method = "GET";
        body = undefined;
      }
      continue;
    }
    return { status: res.status, headers: res.headers, text, url: url.toString() };
  }
  throw new CalendarProviderError("invalid", `${service} redirected too many times.`);
}

/** Turns a non-success response into a safe error. `code` is a short provider error code, never a body. */
export function errorFor(status: number, service: string, headers?: Headers, code?: string | null): CalendarProviderError {
  const kind = kindForStatus(status);
  const retry = Number(headers?.get("retry-after") ?? NaN);
  const msg =
    kind === "auth" ? `${service} no longer accepts the saved sign-in.`
    : kind === "forbidden" ? `${service} refused access (HTTP 403).`
    : kind === "rate_limited" ? `${service} asked us to slow down.`
    : kind === "unavailable" ? `${service} is having trouble (HTTP ${status}).`
    : kind === "not_found" ? `${service} couldn't find that calendar or event.`
    : `${service} returned HTTP ${status}.`;
  return new CalendarProviderError(kind, code ? `${msg} (${code.slice(0, 60)})` : msg, { status, retryAfterSeconds: Number.isFinite(retry) ? retry : null, code: code ?? null });
}

export function parseJson<T>(text: string, service: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new CalendarProviderError("invalid", `${service} returned a response we couldn't read.`);
  }
}
