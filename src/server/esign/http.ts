import "server-only";

// HTTP to a signing service, for documents: it sends a request body as bytes (a PDF upload) and reads an answer as bytes (a signed PDF). The text-only helpers elsewhere in the
// product (src/server/calendars/adapters/http.ts, src/server/security/pinned-https.ts) decode every answer as UTF-8, which would damage a PDF.
//
// A signing service is only ever called at a fixed, official https origin that the adapter names; a redirect is never followed (so a key or a document can never be carried to
// another host), an address with a user name or password in it is refused, the request and the answer both have a size cap, and a request has a time limit. The caller's
// credentials go in headers that this file never logs. No address, header or body is ever written to a log or put into an error message.

export const DEFAULT_TIMEOUT_MS = 25_000;
/** The largest request body sent: a proposal PDF is far smaller (src/lib/pdf/writer.ts caps it at 4 MB), so this is a ceiling for a bug, not a target. */
export const MAX_REQUEST_BYTES = 12 * 1024 * 1024;
/** The largest answer read. A signed PDF with its audit trail is a few megabytes at most. */
export const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;

export type ProviderHttpFailure = "refused" | "redirect" | "timeout" | "unreachable" | "too_large";

/** The request never reached the service, or its answer could not be used. `kind` says which; the message is safe to show a person. */
export class ProviderHttpError extends Error {
  readonly kind: ProviderHttpFailure;
  constructor(kind: ProviderHttpFailure, message: string) {
    super(message);
    this.name = "ProviderHttpError";
    this.kind = kind;
  }
}

export interface BinaryRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** The whole address. Its origin must be one of `allowedOrigins`. */
  url: string;
  allowedOrigins: readonly string[];
  headers?: Record<string, string>;
  body?: Buffer | string | null;
  timeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
}

export interface BinaryResponse {
  status: number;
  headers: Headers;
  body: Buffer;
}

export interface BinaryDeps {
  /** Tests replace the network. Nothing else should. */
  fetch?: typeof fetch;
}

const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,60}$/;

function checkRequest(req: BinaryRequest): { url: URL; body: Buffer | null } {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    throw new ProviderHttpError("refused", "The signing service's address is not valid, so nothing was sent.");
  }
  if (url.protocol !== "https:") throw new ProviderHttpError("refused", "Only https addresses are called, so nothing was sent.");
  if (url.username || url.password) throw new ProviderHttpError("refused", "An address with a user name or password in it is not called.");
  if (!req.allowedOrigins.includes(url.origin)) throw new ProviderHttpError("refused", "That address is outside the signing service's official address, so nothing was sent.");
  for (const [name, value] of Object.entries(req.headers ?? {})) {
    if (!HEADER_NAME_RE.test(name) || /[\r\n]/.test(value)) throw new ProviderHttpError("refused", "A request header is not valid, so nothing was sent.");
  }
  const body = req.body == null ? null : typeof req.body === "string" ? Buffer.from(req.body, "utf8") : req.body;
  if (body && body.length > (req.maxRequestBytes ?? MAX_REQUEST_BYTES)) throw new ProviderHttpError("refused", "The document is larger than the signing service call allows, so nothing was sent.");
  if (body && (req.method === "GET")) throw new ProviderHttpError("refused", "A GET request carries no body.");
  return { url, body };
}

/** Reads an answer as it arrives and gives up the moment it passes the cap, whatever its headers claimed. */
async function readCapped(res: Response, cap: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > cap) {
    await res.body?.cancel().catch(() => undefined);
    throw new ProviderHttpError("too_large", "The signing service sent more data than iAcquire accepts.");
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > cap) {
        await reader.cancel().catch(() => undefined);
        throw new ProviderHttpError("too_large", "The signing service sent more data than iAcquire accepts.");
      }
      chunks.push(Buffer.from(value));
    }
  } catch (e) {
    if (e instanceof ProviderHttpError) throw e;
    throw new ProviderHttpError("unreachable", "The signing service's answer was cut off.");
  }
  return Buffer.concat(chunks);
}

/**
 * One call. Resolves with the status, headers and body of the answer, whatever the status is (the caller decides what an error status means for that endpoint). Rejects with a
 * ProviderHttpError when the call was refused before it left, was redirected, timed out, could not be made or was answered with more than the cap.
 */
export async function providerBinaryRequest(req: BinaryRequest, deps: BinaryDeps = {}): Promise<BinaryResponse> {
  const { url, body } = checkRequest(req);
  const doFetch = deps.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, {
      method: req.method,
      headers: req.headers,
      body: body ? new Uint8Array(body) : undefined,
      // A redirect comes back as an answer with a 3xx status instead of being followed; it is refused below, unread.
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(req.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    throw new ProviderHttpError(timedOut ? "timeout" : "unreachable", timedOut ? "The signing service took too long to answer." : "The signing service could not be reached.");
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => undefined);
    throw new ProviderHttpError("redirect", "The signing service tried to send iAcquire somewhere else, which is never followed.");
  }
  return { status: res.status, headers: res.headers, body: await readCapped(res, req.maxResponseBytes ?? MAX_RESPONSE_BYTES) };
}
