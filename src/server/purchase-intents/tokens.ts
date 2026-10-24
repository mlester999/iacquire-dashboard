import "server-only";
import crypto from "node:crypto";

// The public purchase link is a bearer credential. Only its SHA-256 hash is stored; the raw token is returned once, when the invitation is created or its link is
// rotated. A reference is a short, human-readable id for support and receipts, never a credential.

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function newPurchaseToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export const looksLikePurchaseToken = (value: unknown): value is string => typeof value === "string" && TOKEN.test(value);

export const hashPurchaseToken = (token: string): string => crypto.createHash("sha256").update(token, "utf8").digest("hex");

/** A non-secret reference shown to the buyer and the team; randomised so it cannot be guessed from an id. */
export function newPurchaseReference(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
  const bytes = crypto.randomBytes(10);
  return `PUR-${Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("")}`;
}
