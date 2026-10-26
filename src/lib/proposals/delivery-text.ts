// What the message that carries a proposal to the customer says. Pure.
//
// The wording is fixed in code: no AI writes it, and nothing a customer typed ends up in it except what the CRM already holds for them (their first name). It carries the business's
// name, the proposal's number and, when there is one, the date it is open until. It never carries a price, a promise or a claim about the customer's rights. The customer's link
// is never part of the text either: where it goes the text holds {{proposal.link}}, and the link is derived again and filled in only for the provider call
// (src/server/messaging/send.ts), the way a review request's and an invoice's links are.
//
// PROPOSED WORDING. Nobody has approved this text and counsel has not reviewed it. The person who sends reads the exact message first and the server refuses to send anything
// other than what they read (the fingerprint in delivery-hash.ts), so a change to the wording below is a new version and is always shown again before it goes.

import { formatDay } from "@/lib/proposals/validity";

/** The version of the wording below. Any change to a template here is a new version. */
export const DELIVERY_WORDING_VERSION = "draft-2026-10-24";

/** Where the customer's link goes in a stored message. */
export const PROPOSAL_LINK_PLACEHOLDER = "{{proposal.link}}";
const PLACEHOLDER_RE = /\{\{\s*proposal\.link\s*\}\}/g;

/** What a preview shows in its place. */
export const PROPOSAL_LINK_PREVIEW = "[the customer's own link to the proposal]";

export const DELIVERY_CHANNELS = ["email", "sms", "whatsapp"] as const;
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];
export const isDeliveryChannel = (v: unknown): v is DeliveryChannel => typeof v === "string" && (DELIVERY_CHANNELS as readonly string[]).includes(v);
export const DELIVERY_CHANNEL_LABELS: Record<DeliveryChannel, string> = { email: "Email", sms: "Text message", whatsapp: "WhatsApp" };
/** How a channel reads inside a sentence: "sent by email". */
export const DELIVERY_CHANNEL_WORDS: Record<DeliveryChannel, string> = { email: "email", sms: "text message", whatsapp: "WhatsApp" };

/** The most deliveries one version of a proposal can have, on every channel together, whatever became of the earlier ones. A person who needs more copies the link. */
export const MAX_DELIVERIES_PER_VERSION = 6;

/** A message is never longer than this, link included once it is filled in (a link is about 90 characters). */
export const MAX_DELIVERY_LENGTH = 700;
const MAX_NAME = 40;
const MAX_BUSINESS = 60;
const MAX_NUMBER = 40;

/**
 * {greeting}, {from}, {number} and {until} are filled in; nothing else is. The wording does not say how the proposal is answered (a proposal that asks for a signature is answered at the
 * signing service, not on its page): the page says that itself.
 */
const EMAIL_TEMPLATE = "{greeting}\n\nProposal {number}{from} is ready for you.\n\nYou can read it here:\n{{proposal.link}}{until}\n\nIf you did not expect this message, you can ignore it.";
const SHORT_TEMPLATE = "{greeting} Proposal {number}{from} is ready for you. You can read it here: {{proposal.link}}{until}";
export const DELIVERY_TEMPLATES: Record<DeliveryChannel, string> = { email: EMAIL_TEMPLATE, sms: SHORT_TEMPLATE, whatsapp: SHORT_TEMPLATE };
export const DELIVERY_SUBJECT_TEMPLATE = "Proposal {number}{from}";

/** Text that goes into a message: one line, no braces (so nothing typed can look like a placeholder), no longer than `max`. */
function plain(value: string | null | undefined, max: number): string {
  const v = (value ?? "").replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
  return v.length > max ? `${v.slice(0, max - 1).trimEnd()}…` : v;
}

// One word made of letters, with an apostrophe or hyphen inside it. A name that is anything else (an email address a contact was filed under, a web address, a number) is not
// used: the greeting falls back to "Hello,". One character class with one quantifier, so a long input cannot make it slow.
const NAME_WORD = /^\p{L}[\p{L}\p{M}'-]*$/u;

/** The word to greet a customer by, from a name as it was typed: its first word, when that is a plain name. Null otherwise. */
export function greetingName(name: string | null | undefined): string | null {
  const first = (name ?? "").trim().slice(0, 200).split(/\s+/, 1)[0] ?? "";
  return first.length >= 1 && first.length <= MAX_NAME && NAME_WORD.test(first) ? first : null;
}

export interface DeliveryTextFacts {
  channel: DeliveryChannel;
  /** The customer's first name, when there is one (greetingName has already checked it is a plain name). */
  firstName: string | null;
  business: string;
  number: string;
  /** The last day the proposal can be answered (YYYY-MM-DD), when it has one. */
  validUntil: string | null;
}

export interface RenderedDelivery {
  /** Email only: the other channels have no subject. */
  subject: string | null;
  /** Holds {{proposal.link}} exactly once. */
  body: string;
}

const fill = (template: string, values: Record<string, string>) => template.replace(/\{(greeting|from|number|until)\}/g, (_m, k: string) => values[k] ?? "");

/** The message for a proposal as it is stored: the customer's link is the placeholder, never a link. */
export function renderDelivery(f: DeliveryTextFacts): RenderedDelivery {
  const name = plain(f.firstName, MAX_NAME);
  const business = plain(f.business, MAX_BUSINESS);
  const day = f.validUntil && /^\d{4}-\d{2}-\d{2}$/.test(f.validUntil) ? formatDay(f.validUntil) : null;
  const values = {
    greeting: name ? `Hi ${name},` : "Hello,",
    from: business ? ` from ${business}` : "",
    number: plain(f.number, MAX_NUMBER),
    until: day ? (f.channel === "email" ? `\n\nIt is open until ${day}.` : ` It is open until ${day}.`) : "",
  };
  return { subject: f.channel === "email" ? fill(DELIVERY_SUBJECT_TEMPLATE, values).slice(0, 200) : null, body: fill(DELIVERY_TEMPLATES[f.channel], values) };
}

export function linkPlaceholderCount(text: string): number {
  return [...text.matchAll(PLACEHOLDER_RE)].length;
}

/** What a stored message must be: one placeholder, no web address of its own, short enough to send. A message that fails this is never queued. */
export function deliveryTextProblem(body: string): string | null {
  if (linkPlaceholderCount(body) !== 1) return "The message must carry the customer's proposal link exactly once.";
  if (/https?:\/\/|www\./i.test(body)) return "The message must not carry a web address of its own: the link is added when it is sent.";
  if (body.length > MAX_DELIVERY_LENGTH) return "The message is too long.";
  return null;
}

/** The text with the placeholder replaced by words, for showing a person what will be sent. */
export const previewDeliveryBody = (body: string): string => body.replace(PLACEHOLDER_RE, PROPOSAL_LINK_PREVIEW);
