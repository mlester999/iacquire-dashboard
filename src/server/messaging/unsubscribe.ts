import "server-only";
import crypto from "node:crypto";
import { withSystem } from "@/server/db";
import { env } from "@/server/env";
import { recordAudit } from "@/server/audit";
import { consumeRateLimit, type RateLimitRule } from "@/server/security/rate-limit";
import { contactAddress, getConsent, recordConsent } from "@/server/messaging/contacts";
import { CHANNELS, type Channel } from "@/lib/messaging";

// Unsubscribe links for marketing messages (RFC 8058 one-click, plus a page a person can open).
//
// The link carries a signed token: who (workspace and contact), which channel, what purpose, and when it was issued. Verifying it needs
// no database lookup, so a forged or tampered link is refused before anything is read, and a link keeps working without any stored state.
// The key is derived from APP_ENCRYPTION_KEY (HKDF, its own purpose label), never the raw key, so this signature can't be confused with
// any other use of that key. Retired keys in APP_ENCRYPTION_KEY_PREVIOUS still verify, so links in emails already sent survive a rotation.
//
// Unsubscribing revokes marketing consent for that channel only. It is deliberately not a suppression: a suppressed address gets nothing
// at all, and a person who leaves a newsletter still needs their appointment confirmations.

const VERSION = 1;
const CHANNEL_CODE: Record<Channel, number> = { email: 1, sms: 2, whatsapp: 3 };
const PURPOSE_CODE = { marketing: 1 } as const;
export type UnsubscribePurpose = keyof typeof PURPOSE_CODE;

/** How long a link works. Long enough for anyone reading an old email (CAN-SPAM asks for at least 30 days), short enough that a leaked link dies. */
export const UNSUBSCRIBE_TTL_DAYS = 365;
const FUTURE_SKEW_MS = 10 * 60_000;

// version(1) org(16) contact(16) channel(1) purpose(1) issuedAt seconds(4) | mac(16)
const BODY_BYTES = 39;
const MAC_BYTES = 16;
const TOKEN_LENGTH = Math.ceil(((BODY_BYTES + MAC_BYTES) * 4) / 3);
const TOKEN_RE = new RegExp(`^[A-Za-z0-9_-]{${TOKEN_LENGTH}}$`);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface UnsubscribeClaims {
  orgId: string;
  contactId: string;
  channel: Channel;
  purpose: UnsubscribePurpose;
  issuedAt: Date;
}

export type UnsubscribeCheck =
  | { ok: true; claims: UnsubscribeClaims }
  /** malformed: not a token at all. forged: the signature doesn't match. expired: genuine but too old. wrong_org: genuine, for another workspace. */
  | { ok: false; reason: "malformed" | "forged" | "expired" | "wrong_org"; claims?: UnsubscribeClaims };

function keyFrom(secret: string): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.from("iacquire", "utf8"), Buffer.from("messaging-unsubscribe-v1", "utf8"), 32));
}

/** The signing key, then any retired keys that may still verify. */
function keys(): Buffer[] {
  const e = env();
  const current = e.APP_ENCRYPTION_KEY;
  // env() refuses to start production without APP_ENCRYPTION_KEY; this fallback only exists for local development and tests.
  if (!current && e.NODE_ENV === "production") throw new Error("APP_ENCRYPTION_KEY is required to sign unsubscribe links.");
  const previous = (e.APP_ENCRYPTION_KEY_PREVIOUS ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  return [current ?? "iacquire-local-development-only-key", ...previous].map(keyFrom);
}

const mac = (key: Buffer, body: Buffer) => crypto.createHmac("sha256", key).update(body).digest().subarray(0, MAC_BYTES);
const uuidBytes = (id: string) => Buffer.from(id.replace(/-/g, ""), "hex");
const uuidString = (b: Buffer) => {
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

/**
 * Signs an unsubscribe token. The same inputs always give the same token, so a retried send carries an identical link (Resend's
 * idempotency key only deduplicates an identical payload): pass the message's creation time as `issuedAt` when sending.
 */
export function createUnsubscribeToken(input: { orgId: string; contactId: string; channel: Channel; purpose?: UnsubscribePurpose; issuedAt?: Date }): string {
  if (!UUID_RE.test(input.orgId) || !UUID_RE.test(input.contactId)) throw new Error("Unsubscribe tokens need a workspace id and a contact id.");
  if (!CHANNELS.includes(input.channel)) throw new Error("Unknown channel.");
  const issued = Math.floor((input.issuedAt ?? new Date()).getTime() / 1000);
  if (!Number.isFinite(issued) || issued <= 0 || issued > 0xffffffff) throw new Error("Invalid issue time.");
  const body = Buffer.alloc(BODY_BYTES);
  body.writeUInt8(VERSION, 0);
  uuidBytes(input.orgId).copy(body, 1);
  uuidBytes(input.contactId).copy(body, 17);
  body.writeUInt8(CHANNEL_CODE[input.channel], 33);
  body.writeUInt8(PURPOSE_CODE[input.purpose ?? "marketing"], 34);
  body.writeUInt32BE(issued, 35);
  return Buffer.concat([body, mac(keys()[0], body)]).toString("base64url");
}

/** The start of the UTC day: the default issue time, so links built for the same message on the same day are identical. */
const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/**
 * The List-Unsubscribe URL (and the link in a marketing email's footer). A GET shows a confirmation page; a POST unsubscribes in one
 * click. Pass the message's creation time as `issuedAt` when sending: every attempt of the message then carries the identical link, which
 * Resend's idempotency key requires (the same key with a different body is refused). Without it, the start of today (UTC) is used.
 */
export function buildUnsubscribeUrl(orgId: string, contactId: string, channel: Channel, opts: { purpose?: UnsubscribePurpose; issuedAt?: Date } = {}): string {
  const url = new URL("/api/public/unsubscribe", env().APP_URL);
  url.searchParams.set("t", createUnsubscribeToken({ orgId, contactId, channel, purpose: opts.purpose, issuedAt: opts.issuedAt ?? startOfUtcDay(new Date()) }));
  return url.toString();
}

/** The page a person sees after opening the link. The token is already verified to be token-shaped before anyone builds this. */
export function unsubscribePagePath(token: string): string {
  return `/unsubscribe/${TOKEN_RE.test(token) ? token : "invalid"}`;
}

export const looksLikeUnsubscribeToken = (token: string | null | undefined): token is string => typeof token === "string" && TOKEN_RE.test(token);

/**
 * Checks a token's signature and age. No database access: a forged token costs one HMAC. Pass `orgId` to also require that the token
 * belongs to that workspace.
 */
export function verifyUnsubscribeToken(token: string | null | undefined, opts: { now?: Date; orgId?: string } = {}): UnsubscribeCheck {
  if (!looksLikeUnsubscribeToken(token)) return { ok: false, reason: "malformed" };
  const raw = Buffer.from(token, "base64url");
  if (raw.length !== BODY_BYTES + MAC_BYTES || raw.toString("base64url") !== token) return { ok: false, reason: "malformed" };
  const body = raw.subarray(0, BODY_BYTES);
  const given = raw.subarray(BODY_BYTES);
  if (!keys().some((k) => crypto.timingSafeEqual(mac(k, body), given))) return { ok: false, reason: "forged" };
  if (body.readUInt8(0) !== VERSION) return { ok: false, reason: "malformed" };
  const channel = CHANNELS.find((c) => CHANNEL_CODE[c] === body.readUInt8(33));
  const purpose = (Object.keys(PURPOSE_CODE) as UnsubscribePurpose[]).find((p) => PURPOSE_CODE[p] === body.readUInt8(34));
  if (!channel || !purpose) return { ok: false, reason: "malformed" };
  const claims: UnsubscribeClaims = {
    orgId: uuidString(body.subarray(1, 17)),
    contactId: uuidString(body.subarray(17, 33)),
    channel,
    purpose,
    issuedAt: new Date(body.readUInt32BE(35) * 1000),
  };
  const now = (opts.now ?? new Date()).getTime();
  const age = now - claims.issuedAt.getTime();
  if (age < -FUTURE_SKEW_MS || age > UNSUBSCRIBE_TTL_DAYS * 86_400_000) return { ok: false, reason: "expired", claims };
  if (opts.orgId && opts.orgId.toLowerCase() !== claims.orgId) return { ok: false, reason: "wrong_org", claims };
  return { ok: true, claims };
}

// ---------------------------------------------------------------------------
// Acting on a link
// ---------------------------------------------------------------------------

/** Per link, so one person's link can't be hammered, without limiting by IP: mail providers send one-click requests for many people from shared addresses. */
const PER_TOKEN: RateLimitRule = { name: "unsubscribe:token", limit: 20, windowSeconds: 3600 };
const tokenKey = (token: string) => crypto.createHash("sha256").update(token).digest("hex").slice(0, 40);

export type UnsubscribeOutcome = "unsubscribed" | "already" | "not_found" | "invalid" | "expired" | "rate_limited";

/**
 * Revokes marketing consent for the token's contact and channel. Idempotent: a second request (mail providers do send duplicates)
 * records nothing new. A contact that no longer exists in that workspace changes nothing.
 */
export async function performUnsubscribe(token: string | null | undefined, meta: { method: "one_click" | "page"; now?: Date }): Promise<{ outcome: UnsubscribeOutcome }> {
  const check = verifyUnsubscribeToken(token, { now: meta.now });
  if (!check.ok) return { outcome: check.reason === "expired" ? "expired" : "invalid" };
  const limit = await consumeRateLimit(PER_TOKEN, tokenKey(token as string));
  if (!limit.allowed) return { outcome: "rate_limited" };
  const { orgId, contactId, channel, purpose } = check.claims;
  return withSystem(async (db) => {
    // Locking the contact serializes duplicate requests, so two at once still record one revocation. A deleted contact is still
    // unsubscribed: it costs nothing, and the choice stands if the record is ever restored.
    const found = await db.query<{ id: string }>("select id from contacts where org_id = $1 and id = $2 for update", [orgId, contactId]);
    if (!found.rows[0]) return { outcome: "not_found" as const };
    if ((await getConsent(db, orgId, contactId, channel, purpose)) === "revoked") return { outcome: "already" as const };
    await recordConsent(db, {
      orgId,
      contactId,
      channel,
      purpose,
      status: "revoked",
      source: meta.method === "one_click" ? "list_unsubscribe" : "unsubscribe_link",
      evidence: meta.method === "one_click" ? "One-click unsubscribe from the recipient's mail app (RFC 8058)." : "The recipient confirmed on the unsubscribe page.",
    });
    await recordAudit({ orgId, actorKind: "system", action: "consent.unsubscribed", targetType: "contact", targetId: contactId, result: "success", metadata: { channel, purpose, method: meta.method } }, db);
    return { outcome: "unsubscribed" as const };
  });
}

export interface UnsubscribePageView {
  state: "subscribed" | "unsubscribed" | "not_found" | "invalid" | "expired" | "rate_limited";
  channel: Channel | null;
  business: { name: string; brandColor: string | null; contactEmail: string | null; contactPhone: string | null } | null;
  /** The address the link is for, partly hidden ("ma•••@example.com"). */
  maskedAddress: string | null;
}

const PAGE_VIEWS: RateLimitRule = { name: "unsubscribe:page", limit: 60, windowSeconds: 3600 };

/** What the unsubscribe page shows for a link. Reads only; opening the page never unsubscribes anyone (link scanners open pages too). */
export async function loadUnsubscribePage(token: string, opts: { now?: Date } = {}): Promise<UnsubscribePageView> {
  const check = verifyUnsubscribeToken(token, opts);
  const empty = (state: UnsubscribePageView["state"]): UnsubscribePageView => ({ state, channel: null, business: null, maskedAddress: null });
  if (!check.ok && check.reason !== "expired") return empty("invalid");
  if (!(await consumeRateLimit(PAGE_VIEWS, tokenKey(token))).allowed) return empty("rate_limited");
  const claims = check.claims as UnsubscribeClaims;
  return withSystem(async (db) => {
    const org = await db.query<{ name: string; brand_color: string | null; contact_email: string | null; contact_phone: string | null }>(
      `select o.name, p.brand_color, p.contact_email, p.contact_phone from organizations o left join company_profiles p on p.org_id = o.id where o.id = $1`,
      [claims.orgId],
    );
    if (!org.rows[0]) return empty(check.ok ? "not_found" : "expired");
    const business = { name: org.rows[0].name, brandColor: org.rows[0].brand_color, contactEmail: org.rows[0].contact_email, contactPhone: org.rows[0].contact_phone };
    if (!check.ok) return { state: "expired" as const, channel: claims.channel, business, maskedAddress: null };
    const contact = await db.query<{ id: string }>("select id from contacts where org_id = $1 and id = $2 and deleted_at is null", [claims.orgId, claims.contactId]);
    if (!contact.rows[0]) return { state: "not_found" as const, channel: claims.channel, business, maskedAddress: null };
    const address = await contactAddress(db, claims.orgId, claims.contactId, claims.channel);
    const consent = await getConsent(db, claims.orgId, claims.contactId, claims.channel, claims.purpose);
    return { state: consent === "revoked" ? ("unsubscribed" as const) : ("subscribed" as const), channel: claims.channel, business, maskedAddress: address ? maskAddress(address) : null };
  });
}

/** "maria@example.com" → "ma•••@example.com"; "+639171234567" → "•••••••••4567". Enough to recognize, not enough to harvest. */
export function maskAddress(address: string): string {
  const at = address.lastIndexOf("@");
  if (at > 0) {
    const local = address.slice(0, at);
    return `${local.slice(0, Math.min(2, Math.max(1, local.length - 1)))}•••${address.slice(at)}`;
  }
  return `${"•".repeat(Math.max(0, address.length - 4))}${address.slice(-4)}`;
}
