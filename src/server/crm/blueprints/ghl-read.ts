import "server-only";
import { AppError } from "@/server/errors";
import {
  GHL_API_ORIGIN, GHL_KIND_INFO, GHL_LOCATION_RE, GHL_READ_ORDER, emptyGhlInventory, isProtectedGhlLocation, normalizeGhlLocation, normalizeGhlPage,
  type GhlApiVersion, type GhlInventory, type GhlKind, type GhlKindResult, type GhlRecordKind,
} from "@/lib/crm/blueprints/ghl/inventory";

// Reading a GoHighLevel location's configuration through GoHighLevel's official, documented API — and nothing else.
//
//   * GET only, to exactly https://services.leadconnectorhq.com (the host is a constant: no setting, request or response can change it),
//     with redirects refused, the documented Version header per endpoint, and a timeout on every request.
//   * The protected locations (Aster Homes, and iAcquire's own agency location) are refused before any request is made.
//   * The location's identity is verified once, first: GET /locations/{locationId} must name exactly that location, or nothing else is read.
//   * Each kind is read on its own and ends ok / forbidden / unavailable / error; one failing kind never fails the others.
//   * Rows that name another location are dropped. Pagination is bounded, and so is the total number of requests.
//   * 429 (and 503) are retried a bounded number of times, honouring Retry-After.
//   * The token is only ever placed in the Authorization header. It is never logged, stored, thrown, or put in a result.

export interface GhlReadSource {
  locationId: string;
  token: string;
}

export interface GhlReaderOptions {
  /** Waits between retries (tests pass a fake). */
  sleep?: (ms: number) => Promise<void>;
  /** Retries after a 429 or 503, per request. Default 2. */
  maxRetries?: number;
  /** Per-request timeout. Default 15 s. */
  timeoutMs?: number;
  /** Total requests one read may make (identity included). Default 60. */
  maxRequests?: number;
  /** Longest wait a Retry-After may ask for. Default 10 s. */
  maxRetryWaitMs?: number;
}

export type GhlReadFailure = "forbidden" | "unavailable" | "error";

/** A failed GET, with a reason that is safe to show (never the token, never the raw response). */
export class GhlReadError extends Error {
  constructor(readonly failure: GhlReadFailure, message: string, readonly httpStatus: number | null = null) {
    super(message);
    this.name = "GhlReadError";
  }
}

/** Refuses a location iAcquire must never read, before anything is fetched. */
export function assertImportableLocation(locationId: string): void {
  if (isProtectedGhlLocation(locationId)) throw new AppError("forbidden", "That GoHighLevel location is protected and is never read by iAcquire.");
  if (!GHL_LOCATION_RE.test(locationId)) throw new AppError("invalid_input", "That isn't a valid GoHighLevel location ID.");
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function retryAfterMs(res: Response, attempt: number, cap: number): number {
  const header = res.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(cap, Math.round(seconds * 1000));
    const at = Date.parse(header);
    if (!Number.isNaN(at)) return Math.min(cap, Math.max(0, at - Date.now()));
  }
  return Math.min(cap, 1000 * 2 ** attempt);
}

export interface GhlReader {
  get(path: string, query: Record<string, string>, version: GhlApiVersion | null): Promise<Record<string, unknown>>;
  /** Requests made so far. */
  readonly requests: number;
}

/** A GET-only client for one location. */
export function createGhlReader(source: GhlReadSource, opts: GhlReaderOptions = {}): GhlReader {
  assertImportableLocation(source.locationId);
  if (typeof source.token !== "string" || source.token.length < 16 || /\s/.test(source.token)) throw new AppError("integration_unavailable", "The stored GoHighLevel token can't be used. Save the source's token again.");
  const sleep = opts.sleep ?? defaultSleep;
  const maxRetries = opts.maxRetries ?? 2;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxRequests = opts.maxRequests ?? 60;
  const maxWait = opts.maxRetryWaitMs ?? 10_000;
  let requests = 0;

  async function get(path: string, query: Record<string, string>, version: GhlApiVersion | null): Promise<Record<string, unknown>> {
    const url = new URL(path, GHL_API_ORIGIN);
    // The origin is fixed: a path can never point the request (and its token) anywhere else.
    if (url.origin !== GHL_API_ORIGIN || !path.startsWith("/")) throw new GhlReadError("error", "Refused a request outside GoHighLevel's official API host.");
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const headers: Record<string, string> = { Authorization: `Bearer ${source.token}`, Accept: "application/json" };
    if (version) headers.Version = version;
    for (let attempt = 0; ; attempt++) {
      if (requests >= maxRequests) throw new GhlReadError("error", "Stopped: this import reached its limit of requests to GoHighLevel.");
      requests++;
      let res: Response;
      try {
        res = await fetch(url.toString(), { method: "GET", headers, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
      } catch {
        throw new GhlReadError("error", "GoHighLevel couldn't be reached or didn't answer in time.");
      }
      if ((res.status === 429 || res.status === 503) && attempt < maxRetries) {
        await res.body?.cancel().catch(() => undefined);
        await sleep(retryAfterMs(res, attempt, maxWait));
        continue;
      }
      if (res.status === 401 || res.status === 403) throw new GhlReadError("forbidden", "GoHighLevel refused the token for this request (a missing scope, or a revoked token).", res.status);
      if (res.status === 404) throw new GhlReadError("unavailable", "GoHighLevel doesn't offer this for the location (HTTP 404).", 404);
      if (res.status === 429) throw new GhlReadError("error", "GoHighLevel kept rate-limiting the requests. Try again in a minute.", 429);
      if (!res.ok) throw new GhlReadError("error", `GoHighLevel answered HTTP ${res.status}.`, res.status);
      // The body is parsed and kept in memory only; it is never logged or returned as is.
      const body: unknown = await res.json().catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new GhlReadError("error", "GoHighLevel returned a response iAcquire doesn't recognise.");
      return body as Record<string, unknown>;
    }
  }

  return {
    get,
    get requests() {
      return requests;
    },
  };
}

const fill = (template: string, locationId: string) => template.replaceAll("{locationId}", encodeURIComponent(locationId));

/**
 * Verifies the token belongs to the location (one GET). A body naming another location is refused as "forbidden" with a mismatch message:
 * nothing more is read from a token that doesn't belong to the location it was saved for.
 */
export async function verifyGhlLocation(reader: GhlReader, locationId: string): Promise<{ name: string | null; timezone: string | null }> {
  let body: Record<string, unknown>;
  try {
    body = await reader.get(fill("/locations/{locationId}", locationId), {}, "2021-07-28");
  } catch (e) {
    if (e instanceof GhlReadError && e.failure === "forbidden") throw new AppError("forbidden", "GoHighLevel refused the token for this location. Check that the token is active and has the locations.readonly scope.");
    if (e instanceof GhlReadError && e.failure === "unavailable") throw new AppError("not_found", "GoHighLevel doesn't know this location ID.");
    throw new AppError("upstream_error", e instanceof GhlReadError ? e.message : "GoHighLevel couldn't be reached.");
  }
  const identity = normalizeGhlLocation(body, locationId);
  if (!identity) throw new AppError("forbidden", "GoHighLevel location mismatch: this token belongs to a different location than the one saved. Nothing else was read.");
  return identity;
}

/** Reads one kind, all its pages (bounded). Never throws: the result says what happened. */
async function readKind<K extends GhlRecordKind>(reader: GhlReader, kind: K, locationId: string, probe: boolean): Promise<{ result: GhlKindResult; records: unknown[] }> {
  const info = GHL_KIND_INFO[kind];
  const result: GhlKindResult = { kind, status: "ok", reason: null, count: 0, truncated: false, droppedForeign: 0, malformed: 0 };
  const endpoint = info.endpoint;
  if (!endpoint) return { result: { ...result, status: "unavailable", reason: info.limitation }, records: [] };
  const records: unknown[] = [];
  const base = Object.fromEntries(Object.entries(endpoint.query).map(([k, v]) => [k, fill(v, locationId)]));
  const p = endpoint.pagination;
  const pages = p.mode === "none" || probe ? 1 : p.maxPages;
  try {
    for (let page = 0; page < pages; page++) {
      const query = p.mode === "skip" ? { ...base, skip: String(page * p.limit), limit: String(probe ? 1 : p.limit) }
        : p.mode === "offset" ? { ...base, offset: String(page * p.limit), limit: String(probe ? 1 : p.limit) }
          : base;
      const body = await reader.get(fill(endpoint.path, locationId), query, endpoint.version);
      const n = normalizeGhlPage(kind, body, locationId);
      if (!n.records) return { result: { ...result, status: "error", reason: `GoHighLevel's ${info.label.toLowerCase()} response didn't have the documented shape, so none were read.` }, records: [] };
      records.push(...n.records);
      result.droppedForeign += n.droppedForeign;
      result.malformed += n.malformed;
      if (p.mode === "none" || probe) break;
      const seen = (page + 1) * p.limit;
      const more = n.total !== null ? n.total > seen : n.rawCount >= p.limit;
      if (!more) break;
      if (page === pages - 1) result.truncated = true;
    }
  } catch (e) {
    if (e instanceof GhlReadError) {
      const scope = info.scope ? ` (scope ${info.scope})` : "";
      const reason = e.failure === "forbidden" ? `The token isn't allowed to read ${info.label.toLowerCase()}${scope}.` : e.failure === "unavailable" ? `${info.label}: ${e.message}` : `${info.label} couldn't be read: ${e.message}`;
      // What was read before a later page failed is kept, and the kind says it is incomplete.
      if (records.length && e.failure === "error") return { result: { ...result, status: "ok", truncated: true, count: records.length, reason }, records };
      return { result: { ...result, status: e.failure, reason }, records: [] };
    }
    return { result: { ...result, status: "error", reason: `${info.label} couldn't be read.` }, records: [] };
  }
  result.count = records.length;
  return { result, records };
}

export interface ReadInventoryOptions extends GhlReaderOptions {
  /** Read only these kinds (default: every readable kind). */
  kinds?: readonly GhlKind[];
  /** One small page per kind: enough to learn which scopes work (the source test). */
  probe?: boolean;
}

/**
 * Reads a location's configuration: refuses protected locations before any request, verifies the identity once, then reads each kind on
 * its own. Throws only when the location itself can't be used (protected, wrong identity, token refused); per-kind problems are recorded.
 */
export async function readGhlInventory(source: GhlReadSource, opts: ReadInventoryOptions = {}): Promise<{ inventory: GhlInventory; requests: number }> {
  assertImportableLocation(source.locationId);
  const reader = createGhlReader(source, opts);
  const identity = await verifyGhlLocation(reader, source.locationId);
  const inventory = emptyGhlInventory(source.locationId, { locationName: identity.name, timezone: identity.timezone });
  const wanted = new Set(opts.kinds ?? GHL_READ_ORDER);
  for (const kind of GHL_READ_ORDER) {
    if (!wanted.has(kind)) continue;
    const { result, records } = await readKind(reader, kind as GhlRecordKind, source.locationId, Boolean(opts.probe));
    inventory.kinds[kind] = result;
    (inventory[kind as GhlRecordKind] as unknown[]) = records;
  }
  return { inventory, requests: reader.requests };
}
