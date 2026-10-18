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

/** The transport. An object so tests can replace it; nothing else should. */
export const pinnedHttps = { post };
