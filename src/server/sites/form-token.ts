import "server-only";
import crypto from "node:crypto";
import { env } from "@/server/env";

// A signed timestamp embedded in every enquiry form. A submission without a valid, not-too-fresh token is refused, which
// stops simple bots that post directly or fill the form instantly. It is a speed bump, not an authentication mechanism.
const MIN_AGE_MS = 2_500;
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

function secret(): string {
  const e = env();
  const s = e.SITES_FORM_SECRET ?? e.APP_ENCRYPTION_KEY;
  if (!s) throw new Error("SITES_FORM_SECRET (or APP_ENCRYPTION_KEY) is required to serve website forms.");
  return s;
}
const sign = (host: string, ts: number) => crypto.createHmac("sha256", secret()).update(`site-form:${host}:${ts}`).digest("base64url");

export function issueFormToken(host: string, now = Date.now()): string {
  return `${now}.${sign(host, now)}`;
}

export type TokenCheck = { ok: true } | { ok: false; reason: "missing" | "malformed" | "forged" | "too_fast" | "expired" };

export function checkFormToken(host: string, token: string | null | undefined, now = Date.now()): TokenCheck {
  if (!token) return { ok: false, reason: "missing" };
  const [tsRaw, mac] = token.split(".");
  const ts = Number(tsRaw);
  if (!mac || !Number.isFinite(ts) || ts <= 0) return { ok: false, reason: "malformed" };
  const expected = Buffer.from(sign(host, ts));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return { ok: false, reason: "forged" };
  const age = now - ts;
  if (age < MIN_AGE_MS) return { ok: false, reason: "too_fast" };
  if (age > MAX_AGE_MS) return { ok: false, reason: "expired" };
  return { ok: true };
}

/** A keyed hash of the visitor's address, so abuse can be limited without storing the address itself. */
export function hashClient(value: string): string {
  return crypto.createHmac("sha256", secret()).update(`site-client:${value}`).digest("hex").slice(0, 40);
}
