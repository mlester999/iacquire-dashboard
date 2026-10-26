import "server-only";
import crypto from "node:crypto";
import { withSystem } from "@/server/db";
import { env } from "@/server/env";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { addressKey } from "@/server/demo/core";
import { registerProspect, type DemoContext, type RegisterResult } from "@/server/demo/public";
import { demoPublicDisabled } from "@/server/demo/switch";

// The signed server-to-server door from the separate marketing website into the existing prospect funnel: POST /api/public/demo/register.
//
// It is NOT a second registration system. A verified request is handed to registerProspect (public.ts), the same service the demo's own form uses: same pending prospect, same
// verification email, same one-demo-per-mailbox rule, same rate limits. What this file adds is how the call is trusted: a shared secret, an HMAC over the exact bytes sent, a
// short clock window, and a request id the database remembers, so a captured request cannot be replayed. Nothing here creates a user, a workspace, an invitation or a sign-in,
// starts the 24-hour clock, or returns anything about a prospect. Every accepted answer is the same, whether the address was new, known, or deliberately ignored.
//
// The contract (headers, canonical string, error codes) is written down for the landing-page developer in docs/demo-external-registration.md.

export const REGISTRATION_PATH = "/api/public/demo/register";

/** A registration body is four short fields. Anything larger is refused before it is parsed. */
export const MAX_REGISTRATION_BODY_BYTES = 8_192;

/** `[A-Za-z0-9_-]`, 16 to 64 characters: a UUID without dashes, a ULID or any random token the caller makes. */
const REQUEST_ID = /^[A-Za-z0-9_-]{16,64}$/;
/** A SHA-256 HMAC in lower-case hex. */
const HEX_64 = /^[0-9a-f]{64}$/;

export const SIGNATURE_HEADER = "iacquireos-signature";
export const TIMESTAMP_HEADER = "iacquireos-timestamp";
export const REQUEST_ID_HEADER = "iacquireos-request-id";

const NO_STORE = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
} as const;

// No Access-Control-Allow-* header is ever sent: this endpoint is for a server, and a browser on another site cannot read an answer. The absence is deliberate (no wildcard CORS).

export type RefusalCode =
  | "unauthorized"
  | "origin_forbidden"
  | "replayed_request"
  | "payload_too_large"
  | "unsupported_media_type"
  | "bad_request"
  | "invalid"
  | "rate_limited"
  | "capacity"
  | "unavailable";

export interface RegistrationRefusal {
  ok: false;
  status: number;
  code: RefusalCode;
  message: string;
  retryAfterSeconds?: number;
  fields?: Record<string, string | undefined>;
}

const refuse = (status: number, code: RefusalCode, message: string, extra: Partial<RegistrationRefusal> = {}): RegistrationRefusal => ({
  ok: false, status, code, message, ...extra,
});

/**
 * The exact string that is signed. The body is signed as the bytes that were sent (not a re-serialized object), so key order and spacing matter and a proxy cannot change
 * anything without breaking the signature.
 *
 *   `${timestamp}.${requestId}.${rawBody}`
 *
 * HMAC-SHA256, lower-case hex, one `v1` value.
 */
export function registrationSignaturePayload(timestamp: string, requestId: string, rawBody: string): string {
  return `${timestamp}.${requestId}.${rawBody}`;
}

/** The signature a caller sends, for the landing page's own code and for the tests. */
export function signRegistrationRequest(secret: string, timestamp: number | string, requestId: string, rawBody: string): string {
  return crypto.createHmac("sha256", secret).update(registrationSignaturePayload(String(timestamp), requestId, rawBody)).digest("hex");
}

export interface ParsedSignature {
  timestamp: string;
  signatures: string[];
}

/**
 * `t=<unix seconds>,v1=<hex>`, with any number of `v1` values (a rotation can publish two for a while). A malformed header is null, never an exception.
 */
export function parseSignatureHeader(value: string | null): ParsedSignature | null {
  if (!value) return null;
  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const part of value.split(",")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const key = part.slice(0, i).trim().toLowerCase();
    const val = part.slice(i + 1).trim();
    if (key === "t" && /^\d{10,13}$/.test(val)) timestamp = val;
    else if (key === "v1" && HEX_64.test(val)) signatures.push(val);
  }
  return timestamp && signatures.length ? { timestamp, signatures } : null;
}

/** Constant-time comparison of two hex digests. A length difference is answered by the same work, not by an early return. */
export function signatureMatches(expectedHex: string, candidateHex: string): boolean {
  const a = Buffer.from(expectedHex, "hex");
  const b = Buffer.from(candidateHex, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** The origins a browser may call from, normalized. Empty unless configured: a server-to-server call carries no Origin at all. */
export function allowedRegistrationOrigins(): string[] {
  return (env().DEMO_REGISTRATION_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      try {
        return new URL(s).origin.toLowerCase();
      } catch {
        return "";
      }
    })
    .filter(Boolean);
}

const clientIp = (req: Request): string | null => req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || null;

const json = (status: number, body: unknown, extra: Record<string, string> = {}) => Response.json(body, { status, headers: { ...NO_STORE, ...extra } });

function refused(r: RegistrationRefusal): Response {
  const retry: Record<string, string> = r.retryAfterSeconds ? { "Retry-After": String(r.retryAfterSeconds) } : {};
  return json(r.status, { ok: false, error: { code: r.code, message: r.message }, ...(r.fields ? { fields: r.fields } : {}) }, retry);
}

/** Reads the body in pieces and abandons it the moment it passes the limit, so a false Content-Length cannot make the server hold more than the limit. */
async function readBounded(req: Request): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_REGISTRATION_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

// ---------------------------------------------------------------------------
// Replay ledger
// ---------------------------------------------------------------------------

type Claim = "new" | "duplicate" | "conflict";

const requestHash = (requestId: string) => crypto.createHash("sha256").update(requestId).digest("hex");
const bodyHash = (rawBody: string) => crypto.createHash("sha256").update(rawBody).digest("hex");

/**
 * Records the request id before any email is sent. A second call with the same id and the same body is the caller retrying after a timeout, and is answered as accepted without
 * sending another email; the same id with a different body is refused. A claim that never completed (the process died after claiming, before the email) is taken over after two
 * minutes, so a retry is not lost. Rows are kept for a day (the clock window is minutes), so the table cannot grow without bound.
 */
async function claimRequest(requestId: string, raw: string): Promise<Claim> {
  const idHash = requestHash(requestId);
  const hash = bodyHash(raw);
  return withSystem(async (db) => {
    const insert = () =>
      db.query<{ request_id_hash: string }>(
        `insert into demo_registration_requests (request_id_hash, body_sha256) values ($1, $2)
         on conflict (request_id_hash) do nothing returning request_id_hash`,
        [idHash, hash],
      );
    let inserted = await insert();
    if (!inserted.rows[0]) {
      const existing = (await db.query<{ body_sha256: string; completed_at: Date | null; received_at: Date }>(
        "select body_sha256, completed_at, received_at from demo_registration_requests where request_id_hash = $1",
        [idHash],
      )).rows[0];
      if (!existing) return "new"; // Removed by the sweep between the two statements: treat this attempt as the first.
      if (existing.body_sha256 !== hash) return "conflict";
      if (existing.completed_at !== null) return "duplicate";
      if (Date.now() - new Date(existing.received_at).getTime() < 120_000) return "duplicate";
      // An unfinished claim older than two minutes is a crashed attempt, not a live twin. Take it over once.
      await db.query("delete from demo_registration_requests where request_id_hash = $1 and completed_at is null", [idHash]);
      inserted = await insert();
      if (!inserted.rows[0]) return "duplicate";
    }
    // Opportunistic cleanup, like the rate-limit buckets: bounded retention without another scheduled job.
    if (Math.random() < 0.02) await db.query("delete from demo_registration_requests where received_at < now() - interval '24 hours'");
    return "new";
  });
}

/** Marks an accepted claim, so a later retry with the same id is answered without sending again. */
async function completeRequest(requestId: string, raw: string): Promise<void> {
  await withSystem((db) =>
    db.query("update demo_registration_requests set completed_at = now() where request_id_hash = $1 and body_sha256 = $2", [requestHash(requestId), bodyHash(raw)]),
  ).catch(() => undefined);
}

/** Gives the id back when nothing was accepted, so a corrected request or a transient failure can be retried with the same id. */
async function releaseRequest(requestId: string, raw: string): Promise<void> {
  await withSystem((db) =>
    db.query("delete from demo_registration_requests where request_id_hash = $1 and body_sha256 = $2", [requestHash(requestId), bodyHash(raw)]),
  ).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// The endpoint
// ---------------------------------------------------------------------------

export interface RegistrationDeps {
  now?: Date;
  ip?: string | null;
}

/**
 * Everything POST /api/public/demo/register does. The order matters: the method and the switch first (no body is read while the endpoint is closed), then the media type and
 * the bound, the signature and the clock, the origin, the pace, the replay ledger, and only then the existing prospect service.
 */
export async function handleDemoRegistration(req: Request, deps: RegistrationDeps = {}): Promise<Response> {
  if (req.method.toUpperCase() !== "POST") return json(405, { ok: false, error: { code: "bad_request", message: "Use POST." } }, { Allow: "POST" });

  const secret = env().DEMO_REGISTRATION_SIGNING_SECRET;
  if (!env().DEMO_REGISTRATION_ENABLED || !secret) {
    return refused(refuse(503, "unavailable", "Registration is not available right now."));
  }
  // The demo's own emergency stop closes this door too, before anything is read.
  if (demoPublicDisabled()) return refused(refuse(503, "unavailable", "Registration is not available right now.", { retryAfterSeconds: 300 }));

  const type = (req.headers.get("content-type") ?? "").toLowerCase();
  if (!type.startsWith("application/json")) return refused(refuse(415, "unsupported_media_type", "Send application/json."));
  if (Number(req.headers.get("content-length") ?? 0) > MAX_REGISTRATION_BODY_BYTES) {
    return refused(refuse(413, "payload_too_large", "The request body is too large."));
  }

  const raw = await readBounded(req);
  if (raw === null) return refused(refuse(413, "payload_too_large", "The request body is too large."));

  const timestampHeader = req.headers.get(TIMESTAMP_HEADER);
  const requestId = req.headers.get(REQUEST_ID_HEADER);
  const parsed = parseSignatureHeader(req.headers.get(SIGNATURE_HEADER));
  if (!timestampHeader || !/^\d{10,13}$/.test(timestampHeader) || !requestId || !REQUEST_ID.test(requestId) || !parsed || parsed.timestamp !== timestampHeader) {
    return refused(refuse(401, "unauthorized", "This request could not be verified."));
  }

  const now = deps.now ?? new Date();
  const sentAtMs = timestampHeader.length === 13 ? Number(timestampHeader) : Number(timestampHeader) * 1000;
  if (!Number.isSafeInteger(sentAtMs) || Math.abs(now.getTime() - sentAtMs) > env().DEMO_REGISTRATION_MAX_SKEW_SECONDS * 1000) {
    return refused(refuse(401, "unauthorized", "This request could not be verified."));
  }

  const expected = signRegistrationRequest(secret, timestampHeader, requestId, raw);
  if (!parsed.signatures.some((candidate) => signatureMatches(expected, candidate))) {
    return refused(refuse(401, "unauthorized", "This request could not be verified."));
  }

  // Only an authenticated caller is told whether an origin is welcome; before this point every refusal is the same 401.
  const origin = req.headers.get("origin");
  if (origin !== null) {
    let normalized = "";
    if (origin !== "null") {
      try {
        normalized = new URL(origin).origin.toLowerCase();
      } catch {
        normalized = "";
      }
    }
    if (!normalized || !allowedRegistrationOrigins().includes(normalized)) {
      return refused(refuse(403, "origin_forbidden", "This origin is not allowed to register prospects."));
    }
  }

  // Only a caller that proved it holds the secret reaches these buckets. The caller bucket bounds a broken backend; the address bucket bounds one machine.
  const callerPace = await consumeRateLimit(RATE_LIMITS.demoRegisterByCaller, "marketing");
  if (!callerPace.allowed) return refused(refuse(429, "rate_limited", "Too many registrations just now. Please retry shortly.", { retryAfterSeconds: callerPace.retryAfterSeconds }));
  const ip = deps.ip ?? clientIp(req);
  const addressPace = await consumeRateLimit(RATE_LIMITS.demoRegisterByIp, addressKey(ip));
  if (!addressPace.allowed) return refused(refuse(429, "rate_limited", "Too many registrations just now. Please retry shortly.", { retryAfterSeconds: addressPace.retryAfterSeconds }));

  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return refused(refuse(400, "bad_request", "The request body is not valid JSON."));
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return refused(refuse(400, "bad_request", "The request body must be an object."));
  const data = body as Record<string, unknown>;

  const claim = await claimRequest(requestId, raw);
  if (claim === "duplicate") return json(202, { ok: true });
  if (claim === "conflict") return refused(refuse(409, "replayed_request", "This request id was already used for a different request."));

  // The signed backend attests that the visitor saw the notice with its form; the body may still carry `consent: false` to say they did not tick it.
  const consent = data.consent === undefined ? true : data.consent === true;
  const ctx: DemoContext = { ip, userAgent: req.headers.get("user-agent"), now, trustedCaller: "marketing" };

  let result: RegisterResult;
  try {
    result = await registerProspect(
      {
        name: data.name,
        email: data.email,
        business: data.business,
        industry: data.industry,
        consent,
        marketingOptIn: data.marketingOptIn,
        // The campaign tags the form carried (utm_source, utm_medium, …), never arbitrary keys.
        utm: data,
        // The hidden field a bot fills; the landing page uses the field name the demo form uses.
        trap: data.company_website,
      },
      ctx,
    );
  } catch {
    // A transient failure is not an accepted registration: give the id back so the caller can retry, and say only that it is unavailable.
    await releaseRequest(requestId, raw);
    return refused(refuse(503, "unavailable", "Registration is not available right now.", { retryAfterSeconds: 30 }));
  }

  if (result.ok) {
    await completeRequest(requestId, raw);
    return json(202, { ok: true });
  }

  switch (result.reason) {
    case "invalid":
      await releaseRequest(requestId, raw);
      return refused(refuse(422, "invalid", result.message, { fields: result.fields }));
    case "rate_limited":
      await releaseRequest(requestId, raw);
      return refused(refuse(429, "rate_limited", result.message, { retryAfterSeconds: result.retryAfterSeconds }));
    case "daily_cap":
      await releaseRequest(requestId, raw);
      return refused(refuse(503, "capacity", "Registration is full for today. Please try again tomorrow.", { retryAfterSeconds: 3600 }));
    case "email_failed":
      await releaseRequest(requestId, raw);
      return refused(refuse(503, "unavailable", "Registration is not available right now.", { retryAfterSeconds: 60 }));
    case "not_available":
    case "unavailable":
      await releaseRequest(requestId, raw);
      return refused(refuse(503, "unavailable", "Registration is not available right now.", { retryAfterSeconds: 300 }));
    case "blocked_domain":
      // Deliberately indistinguishable from an accepted registration: the blocked-domain list is not a public fact, and an answer would let a caller probe it.
      await completeRequest(requestId, raw);
      return json(202, { ok: true });
    default:
      await releaseRequest(requestId, raw);
      return refused(refuse(400, "bad_request", "The request could not be accepted."));
  }
}
