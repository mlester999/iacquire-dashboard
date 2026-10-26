// Change orders on an agreed custom project: the pure rules shared by the server, the database tests and the screens. Nothing here reads the database or the
// environment. supabase/migrations/0098_requests_completion.sql mirrors the transition table below, and tests/project-change-orders.test.ts walks every pair of states
// so the two cannot drift apart.
//
// A change order is something the client asked for after the project was agreed. Staff look at it and decide: a revision the agreed terms already include, or
// something outside them that needs a quote. Nothing is priced here, no date is promised, and a quote is the staff's own text and numbers: the client's acceptance is a
// recorded answer to that exact quote, not an electronic signature.

import { isCurrency, formatMinor, type CurrencyCode } from "@/lib/money";
import { todayIn } from "@/lib/invoices/state";
import { freeTextProblem } from "@/lib/invoices/guards";

export const CHANGE_ORDER_STATUSES = ["submitted", "under_review", "needs_info", "quoted", "accepted", "declined", "withdrawn", "applied"] as const;
export type ChangeOrderStatus = (typeof CHANGE_ORDER_STATUSES)[number];

export const CHANGE_ORDER_CLASSIFICATIONS = ["undetermined", "in_scope_revision", "out_of_scope"] as const;
export type ChangeOrderClassification = (typeof CHANGE_ORDER_CLASSIFICATIONS)[number];

/** Allowed moves. Declined, withdrawn and applied are final; an accepted change waits only to be applied. */
export const CHANGE_ORDER_TRANSITIONS: Record<ChangeOrderStatus, readonly ChangeOrderStatus[]> = {
  submitted: ["under_review", "declined", "withdrawn"],
  under_review: ["needs_info", "quoted", "applied", "declined", "withdrawn"],
  needs_info: ["under_review", "declined", "withdrawn"],
  quoted: ["under_review", "accepted", "declined", "withdrawn"],
  accepted: ["applied"],
  declined: [],
  withdrawn: [],
  applied: [],
};

export const canMoveChangeOrder = (from: ChangeOrderStatus, to: ChangeOrderStatus) => CHANGE_ORDER_TRANSITIONS[from].includes(to);

/** Still being worked out: the client can withdraw it, the team can decline it, and it counts toward the cap on open requests. */
export const OPEN_CHANGE_STATUSES = ["submitted", "under_review", "needs_info", "quoted"] as const satisfies readonly ChangeOrderStatus[];
export const isOpenChange = (status: string) => (OPEN_CHANGE_STATUSES as readonly string[]).includes(status);
export const isFinalChange = (status: string) => status === "declined" || status === "withdrawn" || status === "applied";

/** A cap on changes waiting at once on one project, so a form cannot be used to bury the team. Proposed; one number to change. */
export const MAX_OPEN_CHANGE_ORDERS = 10;

/**
 * Statuses in which a change can be asked of a project: agreed and live. A project still being scoped has its quote and conversation for that, a project on hold waits for
 * the team, and a finished or cancelled one takes a new request (or, for a defect inside the support period, an issue report).
 */
export const CHANGEABLE_PROJECT_STATUSES = ["approved", "in_development", "testing", "ready_for_review"] as const;

export function projectTakesChangeOrder(status: string): { ok: true } | { ok: false; reason: string } {
  if ((CHANGEABLE_PROJECT_STATUSES as readonly string[]).includes(status)) return { ok: true };
  if (status === "completed") return { ok: false, reason: "This project is finished. Report an issue with it if something is wrong, or start a new project request for new work." };
  if (status === "on_hold") return { ok: false, reason: "This project is on hold, so a change can't be added right now. Message the team in the conversation." };
  if (status === "cancelled") return { ok: false, reason: "This project was cancelled." };
  return { ok: false, reason: "Changes can be asked for once the project is agreed. Until then, use the conversation or the quote." };
}

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

/** What the client reads. */
export const CHANGE_ORDER_STATUS_LABEL: Record<ChangeOrderStatus | "expired", string> = {
  submitted: "Received",
  under_review: "Being reviewed",
  needs_info: "We need more from you",
  quoted: "Quote ready for your decision",
  accepted: "Accepted",
  declined: "Declined",
  withdrawn: "Withdrawn",
  applied: "Done",
  expired: "Quote expired",
};

/** What the team reads. */
export const CHANGE_ORDER_STATUS_LABEL_AGENCY: Record<ChangeOrderStatus, string> = {
  submitted: "New",
  under_review: "In review",
  needs_info: "Waiting for the client",
  quoted: "Quote sent",
  accepted: "Accepted, to be made",
  declined: "Declined",
  withdrawn: "Withdrawn",
  applied: "Made",
};

export const CHANGE_ORDER_STATUS_EXPLAIN: Record<ChangeOrderStatus | "expired", string> = {
  submitted: "We have your request. The team has not looked at it yet.",
  under_review: "The team is deciding whether this is covered by what was agreed or needs a quote. This is not a promise to do it.",
  needs_info: "The team asked a question. Answer it in the conversation below so the request can move on.",
  quoted: "The team sent a price and terms for this change. Nothing is charged by accepting here.",
  accepted: "You accepted the quote. The change is added to what was agreed. The team will confirm how and when it is paid separately.",
  declined: "This change will not be made.",
  withdrawn: "This request was withdrawn and nothing was changed.",
  applied: "The change was made and is now part of your project.",
  expired: "The quote was not decided in time. Ask the team for an updated one.",
};

export const CLASSIFICATION_LABEL_FOR_CLIENT: Record<ChangeOrderClassification, string | null> = {
  undetermined: null,
  in_scope_revision: "Counts as one of the revisions your agreement includes.",
  out_of_scope: "Outside what was agreed, so it needs a quote.",
};

/** Draft wording for counsel to confirm, like the quote's own. It says plainly what the click does and does not do. */
export const CHANGE_ACCEPT_ACKNOWLEDGEMENT =
  "I confirm I have reviewed this change, its price and its terms. Accepting records my decision against my account and the time it was made, for exactly this version. It is not an electronic signature, and no payment is taken. iAcquire will confirm how and when it is paid separately.";
export const CHANGE_DECLINE_ACKNOWLEDGEMENT = "I decline this change.";

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

/** A quote is good through its valid-until day (in the workspace's calendar) and expired from the next day. No date means it does not expire. */
export function isQuoteExpired(validUntil: string | null, today: string): boolean {
  return validUntil !== null && validUntil < today;
}

/** The status to show: a quote past its date reads as expired although the row still says quoted (nothing writes it; the date decides, in the viewer's workspace calendar). */
export function displayStatus(order: { status: ChangeOrderStatus; validUntil: string | null }, today: string): ChangeOrderStatus | "expired" {
  return order.status === "quoted" && isQuoteExpired(order.validUntil, today) ? "expired" : order.status;
}

export const workspaceToday = (timeZone: string, now: Date = new Date()) => todayIn(now, timeZone);

/** A date-only value ("2026-12-31") as a person reads it. The day is the day: no time zone moves it a day earlier or later. */
export function formatDay(day: string | null | undefined): string {
  const m = day ? /^(\d{4})-(\d{2})-(\d{2})/.exec(day) : null;
  if (!m) return "—";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))));
}

// ---------------------------------------------------------------------------
// The quote the team writes
// ---------------------------------------------------------------------------

export const MAX_ADDITIONAL_MINOR = 100_000_000;
export const MAX_ADDITIONAL_WEEKS = 104;

export interface ChangeQuoteInput {
  additionalMinor: number;
  currency: string;
  weeksMin?: number | null;
  weeksMax?: number | null;
  termsText: string;
  validUntil?: string | null;
  /** Something a person must confirm before the change is treated as agreed work, such as a deposit. Optional. */
  prerequisiteLabel?: string | null;
}

export interface ChangeQuote {
  additionalMinor: number;
  currency: CurrencyCode;
  weeksMin: number | null;
  weeksMax: number | null;
  termsText: string;
  validUntil: string | null;
  prerequisiteLabel: string | null;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
function realDay(value: string): boolean {
  const m = DAY.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/** Checks what staff typed for a quote. The price and the weeks are theirs; nothing is filled in. */
export function validateChangeQuote(input: ChangeQuoteInput, today: string, projectCurrency: string): { ok: true; value: ChangeQuote } | { ok: false; error: string } {
  if (!isCurrency(input.currency)) return { ok: false, error: "Choose one of the supported currencies." };
  if (input.currency !== projectCurrency) return { ok: false, error: `A change to this project is quoted in ${projectCurrency}, the currency it was agreed in.` };
  if (!Number.isSafeInteger(input.additionalMinor) || input.additionalMinor < 0 || input.additionalMinor > MAX_ADDITIONAL_MINOR) {
    return { ok: false, error: `The extra cost must be a whole amount from 0 to ${formatMinor(MAX_ADDITIONAL_MINOR, input.currency)}. Use 0 for no extra charge.` };
  }
  let weeksMin = input.weeksMin ?? null;
  let weeksMax = input.weeksMax ?? null;
  for (const w of [weeksMin, weeksMax]) {
    if (w !== null && (!Number.isInteger(w) || w < 1 || w > MAX_ADDITIONAL_WEEKS)) return { ok: false, error: `The extra weeks must be whole numbers from 1 to ${MAX_ADDITIONAL_WEEKS}.` };
  }
  if (weeksMin === null && weeksMax !== null) weeksMin = weeksMax;
  if (weeksMax === null && weeksMin !== null) weeksMax = weeksMin;
  if (weeksMin !== null && weeksMax !== null && weeksMax < weeksMin) return { ok: false, error: "The latest estimate can't be earlier than the earliest." };
  const terms = input.termsText.trim();
  if (terms.length < 10) return { ok: false, error: "Write what this change includes and any conditions (at least a sentence)." };
  if (terms.length > 2000) return { ok: false, error: "The terms can be up to 2,000 characters." };
  const problem = freeTextProblem("The terms", terms);
  if (problem) return { ok: false, error: problem };
  let validUntil: string | null = null;
  if (input.validUntil) {
    if (!realDay(input.validUntil)) return { ok: false, error: "Use a real date for valid until." };
    if (input.validUntil < today) return { ok: false, error: "The valid-until date is in the past." };
    validUntil = input.validUntil;
  }
  const label = (input.prerequisiteLabel ?? "").trim();
  if (label && (label.length < 3 || label.length > 160)) return { ok: false, error: "Say in 3 to 160 characters what has to be confirmed first." };
  return { ok: true, value: { additionalMinor: input.additionalMinor, currency: input.currency, weeksMin, weeksMax, termsText: terms, validUntil, prerequisiteLabel: label || null } };
}

/**
 * The exact text a quote's hash is made of: the change (its id, the version, what was asked) and every term the client sees. The server hashes it when the quote is sent
 * and again when the client decides; an answer is recorded only if the two agree, so a decision is always tied to the terms that were shown.
 */
export function changeQuoteCanonical(q: {
  changeId: string;
  version: number;
  title: string;
  description: string;
  additionalMinor: number;
  currency: string;
  weeksMin: number | null;
  weeksMax: number | null;
  termsText: string;
  validUntil: string | null;
}): string {
  return JSON.stringify(["change-quote", 1, q.changeId, q.version, q.title, q.description, q.additionalMinor, q.currency, q.weeksMin, q.weeksMax, q.termsText, q.validUntil]);
}

/** What an accepted change adds to the agreed scope. The title and the quoted terms are both inside the hash the client accepted. */
export function amendmentScope(title: string, termsText: string): string {
  return `${title.trim()}\n\n${termsText.trim()}`.slice(0, 4000);
}

/** "$1,200.00 and 2 to 3 more weeks (an estimate, not a delivery date)". Never a promise. */
export function describeQuote(q: { additionalCents: number | null; currency: string | null; weeksMin: number | null; weeksMax: number | null }): string {
  const price = q.additionalCents !== null && q.currency && isCurrency(q.currency) ? (q.additionalCents === 0 ? "No extra charge" : formatMinor(q.additionalCents, q.currency, "symbol")) : "No price yet";
  if (q.weeksMin === null || q.weeksMax === null) return price;
  const weeks = q.weeksMin === q.weeksMax ? `${q.weeksMin} more ${q.weeksMin === 1 ? "week" : "weeks"}` : `${q.weeksMin} to ${q.weeksMax} more weeks`;
  return `${price} and ${weeks} (an estimate, not a delivery date)`;
}

// ---------------------------------------------------------------------------
// Revisions the agreement includes
// ---------------------------------------------------------------------------

/** Revisions left, or null when no number was agreed (nothing is invented: without a number the revision count is only a count). */
export function revisionsLeft(included: number | null, used: number): number | null {
  return included === null ? null : Math.max(0, included - used);
}

/** A revision beyond the number included is not free: it needs a quote. With no number recorded, the team's judgement stands and the count only records it. */
export function canUseRevision(included: number | null, used: number): boolean {
  return included === null || used < included;
}
