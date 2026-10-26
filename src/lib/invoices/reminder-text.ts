import { formatMinor, type CurrencyCode } from "@/lib/money";

// What an invoice reminder says, and the fingerprint the owner's authorization is bound to. Pure.
//
// The wording is fixed in code: no AI writes it, and nothing a customer or a teammate typed ends up in it except the customer's first name, the business's name, the invoice
// number, its total and its due date. The customer's link is never part of the text: where it goes the text holds {{invoice.link}}, and the link is derived again and filled
// in only for the provider call (src/server/messaging/send.ts), the way a review request's link is.
//
// PROPOSED WORDING. Nobody has approved this text: the owner authorizes it in the product before any reminder goes out, and counsel has not reviewed it. It deliberately says
// nothing about fees, interest, collections or consequences, and claims nothing the product does not know.

/** The version of the wording below. Any change to the text, the subject or the way the days are described is a new version, which withdraws every authorization. */
export const REMINDER_WORDING_VERSION = "draft-2026-10-23";

/** Where the customer's link goes in a stored message. */
export const INVOICE_LINK_PLACEHOLDER = "{{invoice.link}}";
const PLACEHOLDER_RE = /\{\{\s*invoice\.link\s*\}\}/g;

/** What a preview shows in its place. */
export const INVOICE_LINK_PREVIEW = "[the customer's own link to the invoice]";

export type ReminderPhase = "before_due" | "on_due" | "after_due";
export const REMINDER_PHASES: readonly ReminderPhase[] = ["before_due", "on_due", "after_due"];

export const REMINDER_CHANNELS = ["email", "sms", "whatsapp"] as const;
export type ReminderChannel = (typeof REMINDER_CHANNELS)[number];
export const REMINDER_CHANNEL_LABELS: Record<ReminderChannel, string> = { email: "Email", sms: "Text message", whatsapp: "WhatsApp" };

/** The text of each kind of reminder. {greeting}, {business}, {number}, {amount} and {due} are filled in; nothing else is. */
export const REMINDER_TEMPLATES: Record<ReminderPhase, string> = {
  before_due: "{greeting}this is a reminder from {business} that invoice {number} for {amount} is due on {due}. You can view it and pay it here: {{invoice.link}}",
  on_due: "{greeting}invoice {number} from {business} for {amount} is due today. You can view it and pay it here: {{invoice.link}}",
  after_due: "{greeting}invoice {number} from {business} for {amount} was due on {due} and is not paid in full yet. If you have already paid, thank you, and please ignore this message. You can view it and pay it here: {{invoice.link}}",
};

export const REMINDER_SUBJECT_TEMPLATE = "Reminder: invoice {number} from {business}";

/** A reminder is never longer than this, link included once it is filled in (a link is about 90 characters). */
export const MAX_REMINDER_LENGTH = 480;
const MAX_NAME = 40;
const MAX_BUSINESS = 60;
const MAX_NUMBER = 40;

export const phaseOfStepKey = (stepKey: string): ReminderPhase | null => {
  const phase = stepKey.split(":")[0];
  return (REMINDER_PHASES as readonly string[]).includes(phase) ? (phase as ReminderPhase) : null;
};

/** Text that goes into a message: one line, no braces (so nothing typed can look like a placeholder), no longer than `max`. */
function plain(value: string | null | undefined, max: number): string {
  const v = (value ?? "").replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
  return v.length > max ? `${v.slice(0, max - 1).trimEnd()}…` : v;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 2026-11-06 as 6 Nov 2026 (the same wherever the reader is: no month-first or day-first guess). */
export function dayWords(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return day;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

export interface ReminderFacts {
  phase: ReminderPhase;
  /** The customer's first name, when there is one. */
  firstName: string | null;
  business: string;
  number: string;
  totalMinor: number;
  currency: CurrencyCode;
  dueOn: string;
}

export interface RenderedReminder {
  subject: string;
  /** Holds {{invoice.link}} exactly once, at the end. */
  body: string;
}

const fill = (template: string, values: Record<string, string>) => template.replace(/\{(greeting|business|number|amount|due)\}/g, (_m, k: string) => values[k] ?? "");

/** The reminder for an invoice as it is stored: the customer's link is the placeholder, never a link. */
export function renderReminder(f: ReminderFacts): RenderedReminder {
  const name = plain(f.firstName, MAX_NAME);
  const values = {
    greeting: name ? `Hi ${name}, ` : "Hello, ",
    business: plain(f.business, MAX_BUSINESS) || "us",
    number: plain(f.number, MAX_NUMBER),
    amount: formatMinor(f.totalMinor, f.currency, "code"),
    due: dayWords(f.dueOn),
  };
  return { subject: fill(REMINDER_SUBJECT_TEMPLATE, values).slice(0, 200), body: fill(REMINDER_TEMPLATES[f.phase], values) };
}

export function linkPlaceholderCount(text: string): number {
  return [...text.matchAll(PLACEHOLDER_RE)].length;
}

/** What a stored reminder must be: one placeholder, no web address, short enough to send. A reminder that fails this is never queued. */
export function reminderTextProblem(body: string): string | null {
  if (linkPlaceholderCount(body) !== 1) return "The reminder must carry the customer's invoice link exactly once.";
  if (/https?:\/\/|www\./i.test(body)) return "A reminder must not carry a web address of its own: the link is added when it is sent.";
  if (body.length > MAX_REMINDER_LENGTH) return "The reminder is too long.";
  return null;
}

/** The text with the placeholder replaced by words, for showing a person what will be sent. */
export const previewReminderBody = (body: string) => body.replace(PLACEHOLDER_RE, INVOICE_LINK_PREVIEW);

export interface ReminderSetup {
  offsetsDays: readonly number[];
  max: number;
  channels: readonly ReminderChannel[];
}

/** Days and channels in the order the fingerprint uses: sorted, each once. */
export function normalizeSetup(s: ReminderSetup): { offsetsDays: number[]; max: number; channels: ReminderChannel[] } {
  return {
    offsetsDays: [...new Set(s.offsetsDays)].sort((a, b) => a - b),
    max: s.max,
    channels: REMINDER_CHANNELS.filter((c) => s.channels.includes(c)),
  };
}

/** How long an owner's authorization lasts before it must be given again, like the standing authorizations of the other automatic messages. */
export const REMINDER_AUTHORIZATION_DAYS = 90;
