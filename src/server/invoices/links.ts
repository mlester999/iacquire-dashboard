import "server-only";
import { env } from "@/server/env";
import { hashInvoiceToken, invoiceKeyFrom, invoiceTokenWith, tokenMatches } from "@/lib/invoices/token";

// The customer's link to an invoice. The token is derived from the invoice id with the server's key (see src/lib/invoices/token.ts), never stored, never written
// into a message body, a log line, an audit row, an export or anything an AI sees; only its sha256 is stored (customer_invoices.public_token_hash, a column the
// application role cannot read). A link made with a retired key still matches while APP_ENCRYPTION_KEY_PREVIOUS lists that key.

function keys(): Buffer[] {
  const e = env();
  const current = e.APP_ENCRYPTION_KEY;
  // env() refuses to start production without APP_ENCRYPTION_KEY; the fallback only exists for local development and tests.
  if (!current && e.NODE_ENV === "production") throw new Error("APP_ENCRYPTION_KEY is required to issue invoice links.");
  const previous = (e.APP_ENCRYPTION_KEY_PREVIOUS ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  return [current ?? "iacquire-local-development-only-key", ...previous].map(invoiceKeyFrom);
}

/** The token for an invoice and link version, made with the current key. */
export function invoiceTokenFor(invoiceId: string, version: number): string {
  return invoiceTokenWith(keys()[0], invoiceId, version);
}

/** The hash to store for an invoice and link version. */
export function invoiceTokenHashFor(invoiceId: string, version: number): string {
  return hashInvoiceToken(invoiceTokenFor(invoiceId, version));
}

/**
 * The token that goes with a stored hash, derived again: tried with the current key, then with each retired one. Null when none of them makes that hash (the key it was
 * made with is gone), in which case the invoice needs a new link.
 */
export function tokenForStoredHash(invoiceId: string, version: number, storedHash: string | null): string | null {
  if (!storedHash) return null;
  for (const key of keys()) {
    const token = invoiceTokenWith(key, invoiceId, version);
    if (hashInvoiceToken(token) === storedHash) return token;
  }
  return null;
}

/** True when `token` is the link of this invoice at this version, under the current key or a retired one. */
export function tokenIsFor(token: string, invoiceId: string, version: number, storedHash: string | null): boolean {
  if (!tokenMatches(token, storedHash)) return false;
  return keys().some((k) => invoiceTokenWith(k, invoiceId, version) === token);
}

/** The customer's page for a token: <APP_URL>/pay/<token>. */
export function invoiceLinkUrl(token: string): string {
  return new URL(`/pay/${token}`, env().APP_URL).toString();
}
