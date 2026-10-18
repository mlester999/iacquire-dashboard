import "server-only";
import crypto from "node:crypto";
import { z } from "zod";
import { withSystem, type Queryable } from "@/server/db";
import { toPublicError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { hashIp, sha256 } from "@/server/security/crypto";
import { authenticateApiKey, type ApiKeyIdentity, type ApiScope } from "@/server/crm/api-keys";
import { DuplicateContactError } from "@/server/crm/contacts";
import type { CrmActor } from "@/server/crm/actor";

// Shared plumbing for the public CRM API (/api/v1/crm/*, docs/crm-api.md): authentication by API key, scope checks, JSON bodies,
// consistent errors, rate-limit headers and idempotent creates. The organization always comes from the key.

export const API_VERSION = "2026-10-01";
const MAX_BODY = 64_000;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface ApiContext {
  actor: CrmActor;
  key: ApiKeyIdentity;
  req: Request;
  requestId: string;
}

export interface ApiResult {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

const APP_ERROR_CODES: Record<string, string> = {
  unauthenticated: "unauthorized", forbidden: "forbidden", not_found: "not_found", invalid_input: "invalid_request", conflict: "conflict", rate_limited: "rate_limited",
  usage_limit: "rate_limited", integration_unavailable: "unavailable", agent_unavailable: "unavailable", upstream_error: "unavailable", internal: "internal_error",
};

function baseHeaders(requestId: string): Record<string, string> {
  return { "Cache-Control": "no-store", "iAcquire-Api-Version": API_VERSION, "X-Request-Id": requestId };
}

function errorResponse(requestId: string, status: number, code: string, message: string, extra: { details?: Record<string, unknown>; headers?: Record<string, string> } = {}): Response {
  return Response.json({ error: { code, message, requestId, ...(extra.details ? { details: extra.details } : {}) } }, { status, headers: { ...baseHeaders(requestId), ...extra.headers } });
}

/** Turns anything a handler throws into the API's error shape, without leaking internals. */
function toErrorResponse(requestId: string, err: unknown, headers: Record<string, string>): Response {
  if (err instanceof ApiError) return errorResponse(requestId, err.status, err.code, err.message, { details: err.details, headers });
  if (err instanceof z.ZodError) {
    const issues = err.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message }));
    return errorResponse(requestId, 400, "validation_failed", issues[0] ? `${issues[0].path ? `${issues[0].path}: ` : ""}${issues[0].message}` : "The request body isn't valid.", { details: { issues }, headers });
  }
  if (err instanceof DuplicateContactError) return errorResponse(requestId, 409, "duplicate_contact", err.message, { details: { existingContactId: err.existingContactId }, headers });
  const e = toPublicError(err);
  const extra: Record<string, string> = e.retryAfterSeconds ? { "Retry-After": String(e.retryAfterSeconds) } : {};
  return errorResponse(requestId, e.status, APP_ERROR_CODES[e.code] ?? "internal_error", e.message, { headers: { ...headers, ...extra } });
}

/**
 * Runs one API request: authenticates the key, checks that it holds at least one of `scopes`, and serializes the result or the error.
 * Every response carries the request id, the API version and the key's rate-limit state.
 */
export async function apiHandler(req: Request, scopes: ApiScope[], fn: (ctx: ApiContext) => Promise<ApiResult>): Promise<Response> {
  const requestId = `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const requested = req.headers.get("iacquire-version");
  if (requested && requested.trim() !== API_VERSION) return errorResponse(requestId, 400, "unsupported_version", `This API speaks version ${API_VERSION}. Remove the iAcquire-Version header or send that value.`);
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || null;
  let auth: Awaited<ReturnType<typeof authenticateApiKey>>;
  try {
    auth = await authenticateApiKey(req.headers.get("authorization"), { ipHash: hashIp(ip) });
  } catch (err) {
    return toErrorResponse(requestId, err, {});
  }
  if (!auth.ok) {
    const headers: Record<string, string> = auth.status === 401 ? { "WWW-Authenticate": 'Bearer realm="iAcquire CRM API"' } : {};
    if (auth.retryAfterSeconds) headers["Retry-After"] = String(auth.retryAfterSeconds);
    return errorResponse(requestId, auth.status, auth.code, auth.message, { headers });
  }
  const rateHeaders = { "X-RateLimit-Limit": String(auth.rateLimit.limit), "X-RateLimit-Remaining": String(auth.rateLimit.remaining), "X-RateLimit-Reset": String(auth.rateLimit.resetSeconds) };
  if (!scopes.some((s) => auth.key.scopes.includes(s))) {
    const suspended = scopes.filter((s) => auth.key.suspendedScopes.includes(s));
    const message = suspended.length
      ? `This API key's ${suspended.map((s) => `“${s}”`).join(" or ")} permission is suspended: the person who created the key no longer has that access in the workspace. Ask an owner to restore it, or to create a new key.`
      : `This API key doesn't have the ${scopes.map((s) => `“${s}”`).join(" or ")} permission. Create a key with it in CRM Settings → API & Webhooks.`;
    return errorResponse(requestId, 403, "insufficient_scope", message, { headers: rateHeaders, details: { required: scopes, granted: auth.key.scopes, ...(suspended.length ? { suspended } : {}) } });
  }
  try {
    const out = await fn({ actor: auth.actor, key: auth.key, req, requestId });
    return Response.json(out.body, { status: out.status ?? 200, headers: { ...baseHeaders(requestId), ...rateHeaders, ...out.headers } });
  } catch (err) {
    return toErrorResponse(requestId, err, rateHeaders);
  }
}

/** Requires one more scope inside a handler (for example tags on a contact create). */
export function requireScope(ctx: ApiContext, scope: ApiScope, what: string) {
  if (!ctx.key.scopes.includes(scope)) throw new ApiError(403, "insufficient_scope", `${what} needs the “${scope}” permission on the API key.`, { required: [scope], granted: ctx.key.scopes });
}

/** Reads a JSON body (application/json, 64 KB at most) and validates it with a strict schema. */
export async function readJson<S extends z.ZodType>(req: Request, schema: S): Promise<z.output<S>> {
  if (!/^application\/json\b/i.test(req.headers.get("content-type") ?? "")) throw new ApiError(415, "unsupported_media_type", "Send the body as JSON with Content-Type: application/json.");
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) throw new ApiError(413, "payload_too_large", "The request body is too large (64 KB at most).");
  const text = await req.text();
  if (text.length > MAX_BODY) throw new ApiError(413, "payload_too_large", "The request body is too large (64 KB at most).");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", "The request body isn't valid JSON.");
  }
  return schema.parse(raw);
}

export const uuidParam = (value: string, what: string) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new ApiError(404, "not_found", `${what} not found.`);
  return value.toLowerCase();
};

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export function pageLimit(url: URL): number {
  const raw = url.searchParams.get("limit");
  if (raw === null) return 25;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 100) throw new ApiError(400, "invalid_request", "limit must be a whole number from 1 to 100.");
  return n;
}

/** A timestamp exactly as PostgreSQL prints it (microseconds and offset), or an ISO 8601 one. */
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)?$/;

/**
 * An opaque keyset cursor: the last row's sort timestamp as the database printed it (`<column>::text`, so microseconds survive; a
 * JavaScript Date would round them to milliseconds and skip rows created within the same millisecond) and its id.
 */
export function encodeCursor(sortValue: string, id: string): string {
  return Buffer.from(JSON.stringify([sortValue, id])).toString("base64url");
}

export function decodeCursor(url: URL): { sortValue: string; id: string } | null {
  const raw = url.searchParams.get("cursor");
  if (!raw) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "string" && CURSOR_TIME.test(v[0]) && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v[1])) {
      return { sortValue: v[0], id: v[1] };
    }
  } catch {
    // fall through
  }
  throw new ApiError(400, "invalid_request", "That cursor isn't valid. Use nextCursor from the previous page.");
}

export function dateParam(url: URL, name: string): Date | null {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new ApiError(400, "invalid_request", `${name} must be an ISO 8601 date and time, for example 2026-10-16T09:00:00Z.`);
  return d;
}

// ---------------------------------------------------------------------------
// Idempotent creates
// ---------------------------------------------------------------------------

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((k) => [k, stable((value as Record<string, unknown>)[k])]));
  return value;
}

/**
 * Creates a record once per Idempotency-Key (per API key, for 24 hours). A repeat with the same key and the same body returns the record
 * the first request made; the same key with a different body is refused. Requests with one key are serialized, so two concurrent retries
 * can't both create. The create and its audit entry (which carries the key's hash) commit together.
 */
export async function createOnce(ctx: ApiContext, input: { auditAction: string; targetType: string; body: unknown; create: (db: Queryable) => Promise<{ id: string }> }): Promise<{ id: string; replayed: boolean }> {
  const header = ctx.req.headers.get("idempotency-key");
  if (header !== null && (!header.trim() || header.length > 255 || /[^\x21-\x7e]/.test(header))) {
    throw new ApiError(400, "invalid_request", "Idempotency-Key must be 1 to 255 visible ASCII characters, for example a UUID.");
  }
  const idem = header ? sha256(`${ctx.key.id}:${header}`) : null;
  const bodyHash = sha256(JSON.stringify(stable(input.body)));
  return withSystem(async (db) => {
    if (idem) {
      await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`crm-api:${idem}`]);
      const prior = await db.query<{ target_id: string; body_hash: string | null }>(
        `select target_id, metadata->>'bodyHash' as body_hash from audit_logs
         where org_id = $1 and action = $2 and metadata->>'idem' = $3 and created_at > now() - interval '24 hours' order by id desc limit 1`,
        [ctx.actor.orgId, input.auditAction, idem],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].body_hash !== bodyHash) throw new ApiError(422, "idempotency_key_reused", "This Idempotency-Key was already used with a different request body. Use a new key for a new request.");
        return { id: prior.rows[0].target_id, replayed: true };
      }
    }
    const r = await input.create(db);
    await recordAudit({
      orgId: ctx.actor.orgId, actorKind: "system", action: input.auditAction, targetType: input.targetType, targetId: r.id, result: "success",
      metadata: { via: "api", keyRef: ctx.key.prefix, keyName: ctx.key.name, requestId: ctx.requestId, ...(idem ? { idem, bodyHash } : {}) },
    }, db);
    return { id: r.id, replayed: false };
  });
}
