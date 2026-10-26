import "server-only";
import crypto from "node:crypto";
import { env } from "@/server/env";

// The secrets behind a customer's proposal link. A link is a credential: its token is derived from a server key and the link's id (so staff can be shown the address again
// without it being stored), and only the sha256 of the token is kept. The emailed code is stored only as a keyed hash of the code with the challenge's id, and the customer's
// session cookie only as the sha256 of a random value. Nothing in here is ever logged, put in an audit row, an AI prompt, an export or a message body.

/** 32 bytes, base64url: 43 characters, like a random token and like a review link. */
export const PROPOSAL_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const looksLikeProposalToken = (t: unknown): t is string => typeof t === "string" && PROPOSAL_TOKEN_RE.test(t);

function keyFrom(secret: string, label: string): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.from("iacquire", "utf8"), Buffer.from(label, "utf8"), 32));
}

/** The key now in use first, then retired keys a link issued before a key change may still have been made with. */
function keys(label: string): Buffer[] {
  const e = env();
  const current = e.APP_ENCRYPTION_KEY;
  // env() refuses to start production without APP_ENCRYPTION_KEY; this fallback only exists for local development and tests.
  if (!current && e.NODE_ENV === "production") throw new Error("APP_ENCRYPTION_KEY is required to issue proposal links.");
  const previous = (e.APP_ENCRYPTION_KEY_PREVIOUS ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  return [current ?? "iacquire-local-development-only-key", ...previous].map((k) => keyFrom(k, label));
}

/** The same derivation for another secret that is shown again without being stored (the signing webhook's address, src/server/esign/webhook-token.ts): its own label, the same key rotation. */
export const derivedKeys = keys;

const LINK_LABEL = "proposal-link-v1";
const CODE_LABEL = "proposal-code-v1";

const tokenWith = (key: Buffer, linkId: string): string => crypto.createHmac("sha256", key).update(`proposal-link:${linkId}`).digest("base64url");

/** What is stored for a token: its sha256, hex. */
export const hashLinkToken = (token: string): string => crypto.createHash("sha256").update(token, "utf8").digest("hex");

/** A link's token, derived from its id. */
export const linkTokenFor = (linkId: string): string => tokenWith(keys(LINK_LABEL)[0], linkId);

/**
 * The token a stored link was made with, found by deriving it again and checking it against the stored hash, so a link made with a retired key still shows. Null when no key
 * in use makes it (the key was lost): the link then cannot be shown again, and a new one has to be made.
 */
export function tokenForStoredLink(linkId: string, tokenHash: string): string | null {
  for (const key of keys(LINK_LABEL)) {
    const token = tokenWith(key, linkId);
    if (hashLinkToken(token) === tokenHash) return token;
  }
  return null;
}

/** The customer's address for a token. */
export const proposalUrl = (token: string): string => new URL(`/proposal/${token}`, env().APP_URL).toString();

// ---------------------------------------------------------------------------
// The emailed code
// ---------------------------------------------------------------------------

/** Six digits, from the system's secure random source. */
export const newCode = (): string => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");

/** A keyed hash of the code bound to its challenge, so a database copy does not reveal codes and a code cannot be moved to another challenge. */
export function hashCode(challengeId: string, code: string): string {
  return crypto.createHmac("sha256", keys(CODE_LABEL)[0]).update(`proposal-code:${challengeId}:${code}`).digest("hex");
}

/** Compares two equal-length hex digests without leaking where they differ. */
export function sameDigest(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------------------------------------------------------------------------
// The customer's session
// ---------------------------------------------------------------------------

export const newSessionToken = (): string => crypto.randomBytes(32).toString("base64url");
export const hashSession = (token: string): string => crypto.createHash("sha256").update(`proposal-session:${token}`, "utf8").digest("hex");
export const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** The cookie that carries a link's session. One per link, so a customer with two proposals open keeps two sessions; the name holds a few characters of the token's hash, never the token. */
export const sessionCookieName = (token: string): string => `pls_${hashLinkToken(token).slice(0, 12)}`;
