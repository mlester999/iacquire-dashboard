import "server-only";
import type { LookupAddress, LookupOptions } from "node:dns";
import https from "node:https";
import net from "node:net";
import { hostResolver } from "@/server/calendars/adapters/http";
import { isPublicAddress } from "@/server/onboarding/website";

/**
 * HTTPS POSTs to addresses a client typed (outbound webhooks, agency n8n triggers), pinned to the DNS answer that was checked.
 *
 * The SSRF check alone (assertPublicHttps) and a later fetch() resolve the host name twice, so a hostile DNS server answering a public
 * address and then a private one seconds later (DNS rebinding) could make the connection reach an internal host. Here the connection's
 * own lookup is the check: the name is resolved once, every address must be public, and the socket connects only to those addresses.
 * TLS still verifies the certificate against the host name (SNI and Host stay the name, not the address). Redirects aren't followed and
 * every request opens its own connection (no shared pool whose sockets were looked up elsewhere).
 */

/** Refused before connecting: the host resolves (now) to a private, local or unknown address. */
export class UnsafeAddressError extends Error {
  readonly code = "ERR_IACQUIRE_UNSAFE_ADDRESS";
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** A lookup for one connection that resolves the name once and hands the socket only addresses that passed the check. */
export function checkedLookup(resolve: (host: string) => Promise<string[]> = (h) => hostResolver.lookup(h)) {
  return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    const all = typeof options === "object" && options !== null && options.all === true;
    resolve(hostname).then(
      (addresses) => {
        if (!addresses.length || addresses.some((a) => !isPublicAddress(a))) throw new UnsafeAddressError("That address points to a private or local network, so it wasn't called.");
        const family = (a: string) => (net.isIPv6(a) ? 6 : 4);
        const want = typeof options === "object" && options !== null && (options.family === 4 || options.family === 6) ? options.family : null;
        const usable = want ? addresses.filter((a) => family(a) === want) : addresses;
        if (!usable.length) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
        if (all) callback(null, usable.map((address) => ({ address, family: family(address) })));
        else callback(null, usable[0], family(usable[0]));
      },
    ).catch((err: NodeJS.ErrnoException) => callback(err, all ? [] : "", 0));
  };
}

export interface PinnedPost {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

/**
 * Sends one POST and answers with the status as soon as the response starts (the body is discarded). Rejects with UnsafeAddressError when
 * the address isn't public, or with the connection error (its `code`, such as ECONNREFUSED, or an AbortError on timeout).
 */
function post(input: PinnedPost): Promise<{ status: number }> {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return Promise.reject(new UnsafeAddressError("That address isn't valid, so it wasn't called."));
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password) return Promise.reject(new UnsafeAddressError("Only https addresses on the standard port are called."));
  // An address written as an IP is never looked up, so it is checked here.
  if (net.isIP(host) && !isPublicAddress(host)) return Promise.reject(new UnsafeAddressError("That address is on a private or local network, so it wasn't called."));
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        protocol: "https:", hostname: host, port: 443, path: `${url.pathname}${url.search}`, method: "POST", agent: false,
        headers: { ...input.headers, "Content-Length": String(Buffer.byteLength(input.body)) },
        lookup: checkedLookup() as unknown as net.LookupFunction,
        signal: AbortSignal.timeout(input.timeoutMs),
      },
      (res) => {
        res.resume();
        res.on("error", () => undefined);
        resolve({ status: res.statusCode ?? 0 });
      },
    );
    req.on("error", reject);
    req.end(input.body);
  });
}

// ---------------------------------------------------------------------------
// A general request (Automation Studio's HTTP and Slack steps)
// ---------------------------------------------------------------------------

export interface PinnedRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  /** The most of the answer that is read; the rest is dropped and the answer is marked truncated. */
  maxResponseBytes: number;
}

export interface PinnedResponse {
  status: number;
  contentType: string | null;
  retryAfterSeconds: number | null;
  /** Bytes read (never more than maxResponseBytes). */
  bytes: number;
  truncated: boolean;
  /** The part of the answer that was read, as text. Callers decide whether any of it may be kept. */
  body: string;
}

/**
 * A request that failed. `phase` says whether it could have reached the other side: "before_send" means the connection (name lookup, TCP, TLS) failed or
 * was refused here, so nothing was sent and trying again is safe; "after_send" means the request may have been delivered (a timeout or a reset after
 * the TLS handshake), so a request that changes something must not simply be repeated.
 */
export class PinnedRequestError extends Error {
  constructor(message: string, readonly code: string, readonly phase: "before_send" | "after_send") {
    super(message);
    this.name = "PinnedRequestError";
  }
}

/** The standard request headers the transport sets itself; a caller's versions of these are ignored. */
const OWN_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding", "accept-encoding", "upgrade", "expect"]);

function retryAfter(value: string | string[] | undefined, now = Date.now()): number | null {
  const v = Array.isArray(value) ? value[0] : value;
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return Math.min(3600, Math.ceil(n));
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, Math.min(3600, Math.ceil((at - now) / 1000))) : null;
}

/**
 * Sends one request to an https address on the standard port and reads a limited part of the answer. The same protections as `post` (the connection
 * only ever goes to the addresses that passed the public-address check, so DNS rebinding and private or metadata addresses are refused; redirects are
 * never followed; a connection of its own per request), plus a size limit on what is read, a decoded-body guarantee (no compression), and the phase
 * information above. `opts` is for tests only (a name lookup, a trusted certificate and a port for a local server): nothing in the application passes it.
 */
function request(input: PinnedRequest, opts: { lookup?: net.LookupFunction; ca?: string; port?: number } = {}): Promise<PinnedResponse> {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return Promise.reject(new PinnedRequestError("That address isn't valid, so it wasn't called.", "ERR_IACQUIRE_BAD_URL", "before_send"));
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password) {
    return Promise.reject(new PinnedRequestError("Only https addresses on the standard port are called.", "ERR_IACQUIRE_UNSAFE_ADDRESS", "before_send"));
  }
  if (net.isIP(host) && !isPublicAddress(host)) return Promise.reject(new PinnedRequestError("That address is on a private or local network, so it wasn't called.", "ERR_IACQUIRE_UNSAFE_ADDRESS", "before_send"));
  const headers: Record<string, string> = { "Accept-Encoding": "identity" };
  for (const [k, v] of Object.entries(input.headers)) if (!OWN_HEADERS.has(k.toLowerCase())) headers[k] = v;
  if (input.body !== undefined) headers["Content-Length"] = String(Buffer.byteLength(input.body));
  return new Promise((resolve, reject) => {
    let phase: "before_send" | "after_send" = "before_send";
    const fail = (err: unknown) => {
      if (err instanceof UnsafeAddressError) return reject(new PinnedRequestError(err.message, err.code, "before_send"));
      const code = (err as NodeJS.ErrnoException)?.code ?? (err as Error)?.name ?? "ERR_UNKNOWN";
      reject(new PinnedRequestError(`The request failed (${String(code).slice(0, 40)}).`, String(code).slice(0, 40), phase));
    };
    const req = https.request(
      {
        protocol: "https:", hostname: host, port: opts.port ?? 443, path: `${url.pathname}${url.search}`, method: input.method, agent: false, headers,
        lookup: (opts.lookup ?? (checkedLookup() as unknown as net.LookupFunction)),
        ...(opts.ca ? { ca: opts.ca } : {}),
        signal: AbortSignal.timeout(input.timeoutMs),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        let truncated = false;
        res.on("data", (chunk: Buffer) => {
          if (truncated) return;
          const room = input.maxResponseBytes - bytes;
          if (chunk.length >= room) {
            chunks.push(chunk.subarray(0, Math.max(0, room)));
            bytes += Math.max(0, room);
            truncated = true;
            // The rest isn't wanted: stop reading, but the request did get its answer.
            res.destroy();
            return;
          }
          chunks.push(chunk);
          bytes += chunk.length;
        });
        const finish = () => resolve({
          status: res.statusCode ?? 0, contentType: typeof res.headers["content-type"] === "string" ? res.headers["content-type"].slice(0, 120) : null,
          retryAfterSeconds: retryAfter(res.headers["retry-after"]), bytes, truncated, body: Buffer.concat(chunks).toString("utf8"),
        });
        res.on("end", finish);
        res.on("close", () => { if (truncated) finish(); });
        res.on("error", (e) => { if (truncated) finish(); else fail(e); });
      },
    );
    req.on("socket", (socket) => {
      socket.once("secureConnect", () => { phase = "after_send"; });
    });
    req.on("error", fail);
    if (input.body !== undefined) req.write(input.body);
    req.end();
  });
}

/** The transport. An object so tests can replace it; nothing else should. */
export const pinnedHttps = { post, request };

/** Only for tests that need a real socket to a local server: the same request, with the name lookup and the trusted certificate chosen by the test. */
export const pinnedRequestForTests = request;
