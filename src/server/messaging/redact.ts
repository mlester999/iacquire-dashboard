import "server-only";

// A customer's manage link (/book/manage/<token>) is a bearer secret: whoever has it can see, move or cancel the booking. Reminders no
// longer store one (the message keeps the {{appointment.manage_link}} placeholder and the link is issued only for the provider call), but
// rows written before that change may still hold a live link. Everything that shows or exports message text to people other than the
// customer passes it through here, so neither an old link nor the raw placeholder is ever shown. A review request's private link
// (/r/<token>) is handled the same way: its message stores {{review.link}} and the dispatcher fills it in for the provider call.

/** What a reader sees in place of a customer's booking link. */
export const CUSTOMER_LINK_LABEL = "[customer booking link]";

/** The placeholder a reminder stores where the customer's link goes. Filled in only for the provider call, never written back. */
export const MANAGE_LINK_PLACEHOLDER = "{{appointment.manage_link}}";

const PLACEHOLDER = /\{\{\s*appointment\.manage_link\s*\}\}/g;
// An absolute or relative manage link, with or without percent-encoding, up to the end of the token.
const MANAGE_LINK = /(?:https?:\/\/[^\s/<>"']+)?\/book\/manage\/[A-Za-z0-9_%.~-]+/g;

/** What a reader sees in place of a customer's private review-request link (/r/<token>, src/server/crm/reviews.ts). */
export const REVIEW_LINK_LABEL = "[customer review link]";
// A review request's link: /r/ and its 43-character token, absolute or relative. A longer path (such as a review site's own /r/…/review) isn't one.
const REVIEW_LINK = /(?:https?:\/\/[^\s/<>"']+)?\/r\/[A-Za-z0-9_-]{43}(?![A-Za-z0-9_\-/])/g;

/**
 * The placeholder a review request's message stores where the customer's private link goes. Like the manage link, the link is a bearer
 * secret (whoever has it can answer as the customer), so it is filled in only for the provider call and never written back.
 */
export const REVIEW_LINK_PLACEHOLDER = "{{review.link}}";
const REVIEW_PLACEHOLDER = /\{\{\s*review\.link\s*\}\}/g;

/**
 * An invoice reminder's link to the customer's invoice page (/pay/<token>, src/server/invoices/links.ts) is a bearer secret too: whoever holds it can see the invoice and
 * start a payment. The reminder's message stores {{invoice.link}} and the dispatcher fills the link in for the provider call only.
 */
export const INVOICE_LINK_LABEL = "[customer invoice link]";
// The invoice page's link: /pay/ and its 43-character token, absolute or relative. The page a payment provider sends the payer back to (/pay/return/<reference>) is not one.
const INVOICE_LINK = /(?:https?:\/\/[^\s/<>"']+)?\/pay\/[A-Za-z0-9_-]{43}(?![A-Za-z0-9_\-/])/g;
export { INVOICE_LINK_PLACEHOLDER } from "@/lib/invoices/reminder-text";
const INVOICE_PLACEHOLDER = /\{\{\s*invoice\.link\s*\}\}/g;

/** Message text with every customer booking link, review-request link, invoice link and link placeholder replaced by a neutral label. */
export function maskCustomerLinks(text: string): string;
export function maskCustomerLinks(text: string | null): string | null;
export function maskCustomerLinks(text: string | null): string | null {
  if (!text) return text;
  if (!text.includes("/book/manage/") && !text.includes("manage_link") && !text.includes("/r/") && !text.includes("review.link") && !text.includes("/pay/") && !text.includes("invoice.link")) return text;
  return text
    .replace(PLACEHOLDER, CUSTOMER_LINK_LABEL)
    .replace(MANAGE_LINK, CUSTOMER_LINK_LABEL)
    .replace(REVIEW_PLACEHOLDER, REVIEW_LINK_LABEL)
    .replace(REVIEW_LINK, REVIEW_LINK_LABEL)
    .replace(INVOICE_PLACEHOLDER, INVOICE_LINK_LABEL)
    .replace(INVOICE_LINK, INVOICE_LINK_LABEL);
}

/** True when the text carries the invoice-link placeholder. */
export function hasInvoiceLinkPlaceholder(text: string): boolean {
  INVOICE_PLACEHOLDER.lastIndex = 0;
  return INVOICE_PLACEHOLDER.test(text);
}

/** Fills the invoice-link placeholder for the provider call (never written back). Callers send nothing when there is no link. */
export function fillInvoiceLink(body: string, link: string): string {
  return body.replace(INVOICE_PLACEHOLDER, () => link);
}

/** True when the text carries the review-link placeholder. */
export function hasReviewLinkPlaceholder(text: string): boolean {
  REVIEW_PLACEHOLDER.lastIndex = 0;
  return REVIEW_PLACEHOLDER.test(text);
}

/** Fills the review-link placeholder for the provider call (never written back). Callers send nothing when there is no link. */
export function fillReviewLink(body: string, link: string): string {
  return body.replace(REVIEW_PLACEHOLDER, () => link);
}

/** True when the text carries the manage-link placeholder. */
export function hasManageLinkPlaceholder(text: string): boolean {
  PLACEHOLDER.lastIndex = 0;
  return PLACEHOLDER.test(text);
}

/**
 * Fills the manage-link placeholder for the provider call. With a link every placeholder becomes it. Without one (the booking can no longer
 * be changed online, or the message is not a reminder) the placeholder is never sent raw: each line that carries it is dropped, and within
 * a single-line message only the sentence that carries it.
 */
export function fillManageLink(body: string, link: string | null): string {
  if (!hasManageLinkPlaceholder(body)) return body;
  if (link) return body.replace(PLACEHOLDER, () => link);
  const lines = body.split("\n");
  if (lines.length > 1) {
    return lines
      .filter((line) => !hasManageLinkPlaceholder(line))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  const sentences = body.split(/(?<=[.!?])\s+/);
  return sentences
    .filter((s) => !hasManageLinkPlaceholder(s))
    .join(" ")
    .trim();
}
