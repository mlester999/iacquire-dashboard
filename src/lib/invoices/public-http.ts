import { INVOICE_TOKEN_RE } from "@/lib/invoices/token-shape";
import { REFERENCE_RE } from "@/lib/invoices/connection-rules";

// What the customer's page and its server share about how they talk. Pure. The invoice's link is a bearer credential, so it travels in a request header, never in a
// request address (an address ends up in server logs, the browser's history and a provider's dashboard).

export const TOKEN_HEADER = "x-invoice-token";
export const REFERENCE_HEADER = "x-payment-reference";
export const PAY_ENDPOINT = "/api/public/invoices/pay";
export const STATUS_ENDPOINT = "/api/public/invoices/status";
export const CAPTURE_ENDPOINT = "/api/public/invoices/capture";

/** Where the page remembers, in the customer's own browser tab, which invoice page they left to pay, so the return page can offer a way back. Never sent anywhere. */
export const BACK_STORAGE_KEY = "iaq-invoice-page";

/** The way back is offered only if it is exactly the shape of an invoice page of this site: a stored value is never trusted as an address. */
export function safeBackPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /^\/pay\/([A-Za-z0-9_-]{43})$/.exec(value);
  return m && INVOICE_TOKEN_RE.test(m[1]) ? value : null;
}

export const looksLikeReference = (v: unknown): v is string => typeof v === "string" && REFERENCE_RE.test(v);

export type PayFailure = "invalid" | "rate_limited" | "paid" | "unavailable" | "disabled" | "try_again";

/** What a customer reads when the invoice they opened cannot be shown: the business is not taking customers right now, or the whole side is switched off. Neither says why. */
export const INVOICE_UNAVAILABLE_NOTICE = { title: "This invoice isn't available right now", body: "Please contact the business directly." } as const;
export const INVOICES_DISABLED_NOTICE = { title: "Invoices are temporarily unavailable", body: "Please try again later, or contact the business directly." } as const;
/** The sentence for the pay button and the status check, in the same two cases. */
export const PAY_UNAVAILABLE_MESSAGE = "Online payment is not available for this invoice right now. Please contact the business to arrange payment.";
export const PAY_DISABLED_MESSAGE = "Invoices are temporarily unavailable. Please try again later, or contact the business directly.";

export interface PayResponse {
  url?: string;
  error?: PayFailure;
  message?: string;
}

/** How long the return page keeps asking, in milliseconds between asks. About two and a half minutes in all; after that it says confirmation is taking longer and offers a button. */
export const POLL_DELAYS_MS: readonly number[] = [2500, 2500, 3000, 3000, 4000, 4000, 5000, 5000, 6000, 6000, 8000, 8000, 10_000, 10_000, 12_000, 12_000, 15_000, 15_000, 20_000];
