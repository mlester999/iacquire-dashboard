// What the message that carries an issued invoice to the customer says. Pure.
//
// The wording is fixed in code: no AI writes it, and nothing a customer typed ends up in it except what the CRM already holds for them (their first name). It carries the
// business's name, the invoice's number, its total and its due date, which are the same facts an invoice reminder carries (src/lib/invoices/reminder-text.ts), and never a balance
// (a message can wait for sending hours while a part payment arrives), a fee, interest or a consequence. The customer's link is never part of the text: where it goes the text
// holds {{invoice.link}}, and the link is derived again and filled in only for the provider call (src/server/messaging/send.ts), the way a reminder's is.
//
// PROPOSED WORDING. Nobody has approved this text and counsel has not reviewed it. The person who sends reads the exact message first and the server refuses to send anything
// other than what they read (the fingerprint in delivery-hash.ts), so a change to the wording below is a new version and is always shown again before it goes.

import { formatMinor, type CurrencyCode } from "@/lib/money";
import { dayWords, INVOICE_LINK_PLACEHOLDER } from "@/lib/invoices/reminder-text";
import type { DeliveryChannel } from "@/lib/proposals/delivery-text";

export { INVOICE_LINK_PLACEHOLDER };
// The channels, their words and the rule for a name that may be greeted are the same for every document the send chain carries to a customer.
export { DELIVERY_CHANNELS, DELIVERY_CHANNEL_LABELS, DELIVERY_CHANNEL_WORDS, greetingName, isDeliveryChannel, type DeliveryChannel } from "@/lib/proposals/delivery-text";

/** The version of the wording below. Any change to a template here is a new version. */
export const INVOICE_DELIVERY_WORDING_VERSION = "draft-2026-10-24";

const PLACEHOLDER_RE = /\{\{\s*invoice\.link\s*\}\}/g;

/** What a preview shows in its place. */
export const INVOICE_DELIVERY_LINK_PREVIEW = "[the customer's own link to the invoice]";

/** The most deliveries one version of an invoice's link can have, on every channel together, whatever became of the earlier ones. A person who needs more copies the link. */
export const MAX_INVOICE_DELIVERIES_PER_LINK = 6;

/** A message is never longer than this, link included once it is filled in (a link is about 90 characters). */
export const MAX_INVOICE_DELIVERY_LENGTH = 700;
const MAX_NAME = 40;
const MAX_BUSINESS = 60;
const MAX_NUMBER = 40;

/**
 * {greeting}, {from}, {number}, {amount} and {due} are filled in; nothing else is. The wording says the customer can see the invoice and how to pay it, not that they can pay
 * it online: the page says whether the business takes payment online.
 */
const EMAIL_TEMPLATE = "{greeting}\n\nInvoice {number}{from} for {amount} is ready for you. It is due on {due}.\n\nYou can see it, and how to pay it, here:\n{{invoice.link}}\n\nIf you did not expect this message, you can ignore it.";
const SHORT_TEMPLATE = "{greeting} Invoice {number}{from} for {amount}, due on {due}, is ready for you. You can see it, and how to pay it, here: {{invoice.link}}";
export const INVOICE_DELIVERY_TEMPLATES = { email: EMAIL_TEMPLATE, sms: SHORT_TEMPLATE, whatsapp: SHORT_TEMPLATE } as const;
export const INVOICE_DELIVERY_SUBJECT_TEMPLATE = "Invoice {number}{from}";

/** Text that goes into a message: one line, no braces (so nothing typed can look like a placeholder), no longer than `max`. */
function plain(value: string | null | undefined, max: number): string {
  const v = (value ?? "").replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
  return v.length > max ? `${v.slice(0, max - 1).trimEnd()}…` : v;
}

export interface InvoiceDeliveryFacts {
  channel: DeliveryChannel;
  /** The customer's first name, when there is one (greetingName has already checked it is a plain name). */
  firstName: string | null;
  business: string;
  number: string;
  totalMinor: number;
  currency: CurrencyCode;
  /** The invoice's due date (YYYY-MM-DD). */
  dueOn: string;
}

export interface RenderedInvoiceDelivery {
  /** Email only: the other channels have no subject. */
  subject: string | null;
  /** Holds {{invoice.link}} exactly once. */
  body: string;
}

const fill = (template: string, values: Record<string, string>) => template.replace(/\{(greeting|from|number|amount|due)\}/g, (_m, k: string) => values[k] ?? "");

/** The message for an invoice as it is stored: the customer's link is the placeholder, never a link. */
export function renderInvoiceDelivery(f: InvoiceDeliveryFacts): RenderedInvoiceDelivery {
  const name = plain(f.firstName, MAX_NAME);
  const business = plain(f.business, MAX_BUSINESS);
  const values = {
    greeting: name ? `Hi ${name},` : "Hello,",
    from: business ? ` from ${business}` : "",
    number: plain(f.number, MAX_NUMBER),
    amount: formatMinor(f.totalMinor, f.currency, "code"),
    due: dayWords(f.dueOn),
  };
  return { subject: f.channel === "email" ? fill(INVOICE_DELIVERY_SUBJECT_TEMPLATE, values).slice(0, 200) : null, body: fill(INVOICE_DELIVERY_TEMPLATES[f.channel], values) };
}

export function invoiceLinkPlaceholderCount(text: string): number {
  return [...text.matchAll(PLACEHOLDER_RE)].length;
}

/** What a stored message must be: one placeholder, no web address of its own, short enough to send. A message that fails this is never queued. */
export function invoiceDeliveryTextProblem(body: string): string | null {
  if (invoiceLinkPlaceholderCount(body) !== 1) return "The message must carry the customer's invoice link exactly once.";
  if (/https?:\/\/|www\./i.test(body)) return "The message must not carry a web address of its own: the link is added when it is sent.";
  if (body.length > MAX_INVOICE_DELIVERY_LENGTH) return "The message is too long.";
  return null;
}

/** The text with the placeholder replaced by words, for showing a person what will be sent. */
export const previewInvoiceDeliveryBody = (body: string): string => body.replace(PLACEHOLDER_RE, INVOICE_DELIVERY_LINK_PREVIEW);
