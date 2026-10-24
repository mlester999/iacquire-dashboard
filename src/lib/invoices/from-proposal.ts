// Making a draft invoice from an accepted proposal. Pure: the server reads the rows and writes the draft; every decision about what may be copied, and what the copy says, is here.
//
// What is copied, and what is not:
//  * Only the lines the customer pays once. A monthly or yearly line is a promise of future billing, and nothing in this product bills on a schedule, so those lines are listed for
//    the owner and left off the invoice: whether and when to invoice them is the owner's call. An invoice never carries a recurring line by itself.
//  * The figures are the frozen version's, worked out again with src/lib/money from the same quantity, price, discount and tax rate, and compared with the version's own totals. If
//    they do not agree nothing is made (a proposal's figures and an invoice's can only differ if something is wrong).
//  * Nothing else: not the proposal's terms (an invoice's terms are the owner's own), not its sections or notes, not a customer's name typed on it. The customer, company and deal
//    are the proposal's links; the invoice's due date, payment instructions and numbering come from the invoice settings when it is issued, exactly as for any other invoice.
//
// Which proposals count as accepted for this: the status must be accepted and a recorded answer must say so for the version that was sent. A proposal that asked for a signature
// counts only when its record says it was signed (through a signing service) or that a person recorded the signing as done offline; an answer recorded by a person for a
// proposal that never asked for a signature counts too, and is labelled as the person's word, not the customer's.

import { isCurrency, lineAmounts, MoneyError, sumLines, toDecimalString, type CurrencyCode, type LineAmounts, type Totals } from "@/lib/money";
import type { Billing } from "@/lib/proposals/doc";
import type { ProposalSnapshot, SnapshotLine } from "@/lib/proposals/snapshot";
import { freeTextProblem } from "@/lib/invoices/guards";
import { lineToForm, MAX_DESCRIPTION, MAX_LINES, type LineFormInput } from "@/lib/invoices/lines";

// ---------------------------------------------------------------------------
// Whether the proposal counts as accepted
// ---------------------------------------------------------------------------

export type SignatureState = "none" | "requested" | "completed" | "failed" | "recorded_offline";
export type DecisionMethod = "verified_acknowledgement" | "provider_signature" | "recorded_by_staff";

export interface AcceptanceFacts {
  status: string;
  /** The version the working copy is at, and the version that went out. An accepted proposal has them equal. */
  version: number;
  sentVersion: number | null;
  requiresSignature: boolean;
  signatureState: SignatureState;
  /** The recorded acceptance of the version that was sent, if there is one. */
  decision: { decision: string; method: DecisionMethod; version: number; contentHash: string } | null;
  /** The saved version's fingerprint. */
  versionContentHash: string | null;
}

export type AcceptanceBasis = "acknowledged_online" | "signed_through_service" | "signing_recorded_offline" | "answer_recorded_by_person";

/** How the acceptance happened, in the words the screen and the proposal's history use. Nothing here calls anything an electronic signature unless a signing service said so. */
export const ACCEPTANCE_BASIS_TEXT: Record<AcceptanceBasis, string> = {
  acknowledged_online: "The customer accepted online with a verified email address.",
  signed_through_service: "A signing service reported that the customer signed.",
  signing_recorded_offline: "A person on your team recorded that the customer signed outside the product. A signing service did not verify it.",
  answer_recorded_by_person: "A person on your team recorded that the customer accepted. The customer did not verify it.",
};

export type NotAcceptedReason = "not_accepted" | "no_answer_on_record" | "signature_not_recorded";

export type Acceptance = { ok: true; basis: AcceptanceBasis; text: string } | { ok: false; reason: NotAcceptedReason; text: string };

export function acceptedForInvoicing(f: AcceptanceFacts): Acceptance {
  if (f.status !== "accepted") return { ok: false, reason: "not_accepted", text: "Only an accepted proposal can be invoiced." };
  const d = f.decision;
  if (!d || d.decision !== "accepted" || f.sentVersion === null || d.version !== f.sentVersion || f.sentVersion !== f.version || !f.versionContentHash || d.contentHash !== f.versionContentHash) {
    return { ok: false, reason: "no_answer_on_record", text: "This proposal is marked accepted, but there is no recorded answer for the version that was sent, so no invoice is made from it." };
  }
  if (f.requiresSignature) {
    if (f.signatureState === "completed" && d.method === "provider_signature") return basis("signed_through_service");
    if (f.signatureState === "recorded_offline" && d.method === "recorded_by_staff") return basis("signing_recorded_offline");
    return { ok: false, reason: "signature_not_recorded", text: "This proposal asked for a signature, and its record does not say it was signed through a signing service or recorded as signed outside the product, so no invoice is made from it." };
  }
  if (d.method === "provider_signature") {
    return f.signatureState === "completed" ? basis("signed_through_service") : { ok: false, reason: "signature_not_recorded", text: "The record of this acceptance says it was signed through a signing service, but the proposal does not, so no invoice is made from it." };
  }
  return basis(d.method === "recorded_by_staff" ? "answer_recorded_by_person" : "acknowledged_online");
}

function basis(b: AcceptanceBasis): Acceptance {
  return { ok: true, basis: b, text: ACCEPTANCE_BASIS_TEXT[b] };
}

// ---------------------------------------------------------------------------
// What the invoice would hold
// ---------------------------------------------------------------------------

export type PlanProblemCode = "currency_unsupported" | "no_one_time_lines" | "too_many_lines" | "line_text" | "figures_differ" | "zero_total";

export interface PlanProblem {
  code: PlanProblemCode;
  text: string;
}

/** A line the owner has to decide about: the customer pays it every month or every year, so it is not on the invoice. */
export interface RecurringLine {
  name: string;
  billing: Exclude<Billing, "one_time">;
  billingLabel: string;
  quantityMilli: number;
  /** What the customer pays for the line each time, tax included. */
  totalMinor: number;
}

export interface PlannedLine {
  /** The line as the invoice form holds it, which the server parses with the same rules as any typed invoice. */
  form: LineFormInput;
  /** Where it was on the proposal (1-based, among all its lines), for a message. */
  proposalLine: number;
  description: string;
  quantityMilli: number;
  unitPriceMinor: number;
  discountMinor: number;
  taxRateBps: number | null;
  /** What the customer pays for the line, tax included. */
  totalMinor: number;
  amounts: LineAmounts;
}

export interface InvoicePlan {
  currency: CurrencyCode;
  lines: PlannedLine[];
  totals: Totals;
  recurring: RecurringLine[];
  /** Things the owner should know that did not stop the copy: a description that was shortened. */
  notes: string[];
}

export type PlanResult = { ok: true; plan: InvoicePlan } | { ok: false; problem: PlanProblem };

const BILLING_WORDS: Record<Exclude<Billing, "one_time">, string> = { monthly: "every month", yearly: "every year" };

const sameAmounts = (a: LineAmounts, b: LineAmounts): boolean => a.gross === b.gross && a.discount === b.discount && a.net === b.net && a.tax === b.tax && a.total === b.total && a.exTax === b.exTax;
const sameTotals = (a: Totals, b: Totals): boolean => a.gross === b.gross && a.discount === b.discount && a.subtotal === b.subtotal && a.tax === b.tax && a.total === b.total;

/** An invoice line's description from a proposal line: its name, and its description after a dash when both fit. Longer than an invoice line holds, only the name is used. */
export function invoiceDescription(line: Pick<SnapshotLine, "name" | "description">): { text: string; shortened: boolean } {
  const name = line.name.replace(/\s+/g, " ").trim();
  const detail = line.description.replace(/\s+/g, " ").trim();
  if (!detail) return { text: name.slice(0, MAX_DESCRIPTION), shortened: name.length > MAX_DESCRIPTION };
  const both = `${name} - ${detail}`;
  if (both.length <= MAX_DESCRIPTION) return { text: both, shortened: false };
  return { text: name.slice(0, MAX_DESCRIPTION), shortened: true };
}

/** What an invoice made from this frozen version would hold, or why none can be made. */
export function planInvoiceFromSnapshot(snapshot: ProposalSnapshot): PlanResult {
  const fail = (code: PlanProblemCode, text: string): PlanResult => ({ ok: false, problem: { code, text } });
  if (!isCurrency(snapshot.currency)) return fail("currency_unsupported", `This proposal is in ${snapshot.currency}, which invoices do not support, so no invoice is made from it.`);
  const currency = snapshot.currency;

  const recurring: RecurringLine[] = [];
  const picked: Array<{ line: SnapshotLine; proposalLine: number }> = [];
  snapshot.lines.forEach((line, i) => {
    // Only one-time lines are copied. A monthly or yearly line is a future billing decision for the owner, never an invoice line by itself.
    if (line.billing === "one_time") picked.push({ line, proposalLine: i + 1 });
    else recurring.push({ name: line.name.replace(/\s+/g, " ").trim(), billing: line.billing, billingLabel: BILLING_WORDS[line.billing], quantityMilli: line.quantityMilli, totalMinor: line.amounts.total });
  });
  if (picked.length === 0) {
    return fail("no_one_time_lines", recurring.length
      ? "This proposal has only monthly or yearly lines, so there is nothing the customer pays once to put on an invoice. Whether and when to bill those lines is yours to decide."
      : "This proposal has no lines, so there is nothing to put on an invoice.");
  }
  if (picked.length > MAX_LINES) return fail("too_many_lines", `This proposal has ${picked.length} one-time lines, and an invoice holds at most ${MAX_LINES}.`);

  const lines: PlannedLine[] = [];
  const notes: string[] = [];
  for (const { line, proposalLine } of picked) {
    const desc = invoiceDescription(line);
    const problem = freeTextProblem(`Line ${proposalLine} of the proposal`, desc.text);
    if (problem) return fail("line_text", `${problem} It can't be copied onto an invoice.`);
    let amounts: LineAmounts;
    try {
      amounts = lineAmounts({ quantityMilli: line.quantityMilli, unitPriceMinor: line.unitPriceMinor, discount: line.discount, taxBps: line.taxBps > 0 ? line.taxBps : null }, false);
    } catch (e) {
      return fail("figures_differ", e instanceof MoneyError ? `Line ${proposalLine} of the proposal can't be worked out again: ${e.message}` : `Line ${proposalLine} of the proposal can't be worked out again.`);
    }
    if (!sameAmounts(amounts, line.amounts)) return fail("figures_differ", `The figures of line ${proposalLine} of the proposal are not what its saved version says, so no invoice is made from it. Contact support.`);
    if (desc.shortened) notes.push(`Line ${proposalLine} of the proposal ("${desc.text.length > 60 ? `${desc.text.slice(0, 59)}…` : desc.text}") has a longer description than an invoice line holds, so only the name was copied.`);
    const taxRateBps = line.taxBps > 0 ? line.taxBps : null;
    const discountBps = line.discount?.kind === "percent" ? line.discount.bps : null;
    lines.push({
      form: lineToForm({ description: desc.text, quantityMilli: line.quantityMilli, unitPriceMinor: line.unitPriceMinor, discountBps, discountMinor: amounts.discount, taxRateBps }, currency, toDecimalString),
      proposalLine, description: desc.text, quantityMilli: line.quantityMilli, unitPriceMinor: line.unitPriceMinor, discountMinor: amounts.discount, taxRateBps, totalMinor: amounts.total, amounts,
    });
  }
  const totals = sumLines(lines.map((l) => l.amounts));
  // The version's own total for what is paid once is a sum of the same rounded lines: if the two disagree something is wrong, and nothing is made.
  if (!sameTotals(totals, snapshot.groups.one_time)) return fail("figures_differ", "The one-time total of this proposal's saved version is not what its lines add up to, so no invoice is made from it. Contact support.");
  if (totals.total <= 0) return fail("zero_total", "The lines the customer pays once come to nothing, so there is nothing to invoice.");
  if (recurring.length) notes.push(`${recurring.length === 1 ? "One line is" : `${recurring.length} lines are`} billed every month or every year and ${recurring.length === 1 ? "was" : "were"} not copied. Decide whether and when to invoice ${recurring.length === 1 ? "it" : "them"} yourself.`);
  return { ok: true, plan: { currency, lines, totals, recurring, notes } };
}

/** The idempotency key of the first invoice made from a version of a proposal, and of each further one the owner explicitly asks for. */
export function invoiceKeyFor(proposalId: string, version: number, ordinal: number): string {
  const base = `proposal-invoice:${proposalId}:${version}`;
  return ordinal <= 0 ? base : `${base}:${ordinal}`;
}
