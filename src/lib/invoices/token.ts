import crypto from "node:crypto";
import { INVOICE_TOKEN_RE, looksLikeInvoiceToken } from "@/lib/invoices/token-shape";

export { INVOICE_TOKEN_RE, looksLikeInvoiceToken };

// The customer's link to an invoice is a bearer credential: whoever holds it can see the invoice and start a payment. So it is derived, never stored; only its
// sha256 is. The token is an HMAC of the invoice id and the link's version with a server key (43 characters of base64url, like a random one), derived again just
// before it is shown or sent, and checked against the stored hash. Bumping the version gives a new link and kills the old one. Pure: the keys come in as arguments
// (src/server/invoices/links.ts reads them from the environment).

const CONTEXT = "customer-invoice-link-v1";

export function invoiceKeyFrom(secret: string): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.from("iacquire", "utf8"), Buffer.from(CONTEXT, "utf8"), 32));
}

export function invoiceTokenWith(key: Buffer, invoiceId: string, version: number): string {
  return crypto.createHmac("sha256", key).update(`customer-invoice:${invoiceId}:${version}`).digest("base64url");
}

/** What is stored for a token: its sha256, hex. The token itself is never stored. */
export function hashInvoiceToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time comparison of a presented token's hash with the stored one. */
export function tokenMatches(presented: string, storedHash: string | null | undefined): boolean {
  if (!storedHash || !looksLikeInvoiceToken(presented)) return false;
  const a = Buffer.from(hashInvoiceToken(presented), "utf8");
  const b = Buffer.from(storedHash, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
