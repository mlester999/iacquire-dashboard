// What an invoice link looks like, with no Node-only code, so a browser component (the pay page) can use it. The key derivation and the comparison are in token.ts.

/** 32 bytes, base64url: 43 characters. */
export const INVOICE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export const looksLikeInvoiceToken = (t: unknown): t is string => typeof t === "string" && INVOICE_TOKEN_RE.test(t);
