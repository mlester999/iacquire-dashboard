import { MoneyError, type CurrencyCode } from "@/lib/money";
import { InvoiceInputError } from "@/lib/invoices/errors";
import { parseLine, parseLines, type LineFormInput } from "@/lib/invoices/lines";
import { canEditDraft, issueBlockedReason, type InvoicePaymentStatus, type InvoiceStatus } from "@/lib/invoices/state";

// What the invoice screens decide for themselves, kept out of the components so it can be tested: which list a filter means, what the form's lines come to as the person types,
// and which buttons an invoice offers a person. The server decides every one of these again; this only decides what to offer.

export const LIST_FILTERS = ["open", "overdue", "draft", "waiting", "paid", "void", "test", "all"] as const;
export type ListFilter = (typeof LIST_FILTERS)[number];

export const LIST_FILTER_LABELS: Record<ListFilter, string> = {
  open: "Owed", overdue: "Overdue", draft: "Drafts", waiting: "Waiting for approval", paid: "Paid", void: "Void", test: "Test invoices", all: "Everything",
};

export function parseListFilter(v: string | string[] | undefined): ListFilter {
  const one = Array.isArray(v) ? v[0] : v;
  return (LIST_FILTERS as readonly string[]).includes(one ?? "") ? (one as ListFilter) : "open";
}

export interface ListQuery {
  status?: InvoiceStatus[];
  paymentStatus?: InvoicePaymentStatus[];
  overdueOnly?: boolean;
  /** Test invoices apart from the rest: only them, or none of them. Nothing is owed on a test invoice, so the lists of what is owed and what was paid leave them out. */
  tests?: "only" | "exclude";
}

/** The query a filter stands for. Overdue is checked when the list is read (it is not live: the scheduler's sweep only raises the notice). */
export function filterQuery(f: ListFilter): ListQuery {
  switch (f) {
    case "open": return { status: ["issued"], paymentStatus: ["unpaid", "partially_paid", "disputed"], tests: "exclude" };
    case "overdue": return { overdueOnly: true, tests: "exclude" };
    case "draft": return { status: ["draft"] };
    case "waiting": return { status: ["pending_approval"] };
    case "paid": return { status: ["issued"], paymentStatus: ["paid"], tests: "exclude" };
    case "void": return { status: ["void"] };
    case "test": return { tests: "only" };
    case "all": return {};
  }
}

export interface LinePreview {
  ok: boolean;
  /** Per line, the sentence to show beside it when it cannot be read yet. */
  errors: Array<string | null>;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  /** What is wrong with the invoice as a whole, if anything. */
  problem: string | null;
}

/** What the lines a person has typed come to, with the same money rules the server uses. A line that cannot be read yet is reported on its own; the rest still add up. */
export function previewLines(lines: readonly LineFormInput[], currency: CurrencyCode, taxInclusive: boolean): LinePreview {
  const errors: Array<string | null> = [];
  const readable: LineFormInput[] = [];
  lines.forEach((l, i) => {
    if (!(l.description.trim() || l.unitPrice.trim())) {
      errors.push(null);
      return;
    }
    try {
      parseLine(l, i, currency, taxInclusive);
      errors.push(null);
      readable.push(l);
    } catch (e) {
      errors.push(e instanceof InvoiceInputError || e instanceof MoneyError ? e.message : `Line ${i + 1} cannot be read.`);
    }
  });
  if (!readable.length) return { ok: false, errors, subtotalMinor: 0, taxMinor: 0, totalMinor: 0, problem: lines.some((l) => l.description.trim() || l.unitPrice.trim()) ? null : "Add at least one line." };
  try {
    const { totals } = parseLines(readable, currency, taxInclusive);
    return { ok: errors.every((e) => e === null), errors, subtotalMinor: totals.subtotal, taxMinor: totals.tax, totalMinor: totals.total, problem: totals.total <= 0 ? "The invoice total must be more than zero." : null };
  } catch (e) {
    return { ok: false, errors, subtotalMinor: 0, taxMinor: 0, totalMinor: 0, problem: e instanceof InvoiceInputError || e instanceof MoneyError ? e.message : "These lines cannot be added up." };
  }
}

export const blankLine = (): LineFormInput => ({ description: "", quantity: "1", unitPrice: "", discountPercent: "", discountAmount: "", taxPercent: "" });

/** The lines to send to the server: the ones the person filled in (a trailing empty row is not a line). */
export const filledLines = (lines: readonly LineFormInput[]): LineFormInput[] => lines.filter((l) => l.description.trim() || l.unitPrice.trim());

/**
 * The next invoice number as a settings save should carry it. `typed` is null until the person edits the field, and `current` is the counter the page knows. A number the person
 * did not type is not sent at all: issuing an invoice raises the counter without touching the settings' version, so sending an old one back would be refused as "lowered" and
 * stop a save that has nothing to do with numbering. The server checks again.
 */
export function nextNumberChange(typed: string | null, current: number): { send: number | undefined; problem: string | null } {
  if (typed === null) return { send: undefined, problem: null };
  const t = typed.trim();
  const n = Number(t);
  if (t === "" || !Number.isInteger(n) || n < 1) return { send: undefined, problem: "The next number is a whole number, 1 or more." };
  if (n < current) return { send: undefined, problem: `The next number can be raised but not lowered (it is ${current}).` };
  return { send: n, problem: null };
}

/** "-3, 0, 3, 10" -> the days. Whole numbers separated by commas or spaces; the server checks the range and the maximum again. */
export function parseOffsetsText(text: string): { ok: true; offsets: number[] } | { ok: false; error: string } {
  const parts = text.split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0) return { ok: false, error: "Enter at least one day, such as -3, 0, 3, 10." };
  const offsets: number[] = [];
  for (const p of parts) {
    if (!/^-?\d{1,3}$/.test(p)) return { ok: false, error: `"${p}" is not a whole number of days. Use numbers such as -3, 0, 3, 10.` };
    offsets.push(Number(p));
  }
  return { ok: true, offsets: [...new Set(offsets)].sort((a, b) => a - b) };
}

export const offsetsToText = (offsets: readonly number[]) => offsets.join(", ");

/** What a setting of the reminder days means, in a sentence a person can check against what they meant. */
export function describeOffsets(offsets: readonly number[]): string {
  if (!offsets.length) return "No reminder days are set.";
  const parts = [...offsets].sort((a, b) => a - b).map((d) => (d < 0 ? `${-d} ${-d === 1 ? "day" : "days"} before the due date` : d === 0 ? "on the due date" : `${d} ${d === 1 ? "day" : "days"} after the due date`));
  return parts.length === 1 ? `One reminder, ${parts[0]}.` : `Reminders ${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}.`;
}

export type InvoiceActionId =
  | "edit" | "submit" | "withdraw" | "approve_issue" | "request_changes" | "issue" | "discard" | "link" | "record_payment" | "void" | "write_off" | "test_payment" | "delete_test";

export interface ActionFacts {
  status: InvoiceStatus;
  paymentStatus: InvoicePaymentStatus;
  writtenOff: boolean;
  balanceMinor: number;
  paidMinor: number;
  createdVia: "manual" | "workflow" | "deal";
  isAuthor: boolean;
  approvalRequiredForCreators: boolean;
  can: { create: boolean; approve: boolean; send: boolean; recordPayment: boolean; void: boolean; refund: boolean; connect: boolean };
  /** A payment account in test mode is connected. */
  hasTestConnection: boolean;
  /** A test invoice: nothing is owed on it and no money moves. It is the only kind that is paid as a test, and the only kind a payment can be voided or deleted with. */
  isTest: boolean;
}

export interface OfferedActions {
  offered: InvoiceActionId[];
  /** Why something a person might look for is not offered. */
  notes: string[];
}

/** What an invoice offers the person looking at it. The server refuses anything that is not allowed whatever this says. */
export function invoiceActions(f: ActionFacts): OfferedActions {
  const offered: InvoiceActionId[] = [];
  const notes: string[] = [];
  const editor = canEditDraft({ canCreate: f.can.create, canApprove: f.can.approve, isAuthor: f.isAuthor });
  if (f.status === "draft") {
    if (editor) offered.push("edit", "submit");
    else if (f.can.create) notes.push("Only the person who wrote this draft, or the owner or a manager, can change it.");
    if (!issueBlockedReason({ status: f.status, canApprove: f.can.approve, canCreate: f.can.create, isAuthor: f.isAuthor, createdVia: f.createdVia, approvalRequiredForCreators: f.approvalRequiredForCreators })) offered.push("issue");
    if (editor) offered.push("discard");
  } else if (f.status === "pending_approval") {
    if (f.can.approve) offered.push("approve_issue", "request_changes");
    else notes.push("The owner or a manager has to approve this invoice before it can be issued.");
    if (editor) offered.push("withdraw");
  } else if (f.status === "issued") {
    if (f.can.send) offered.push("link");
    // Nothing is owed on a test invoice, so there is nothing to record, write off or refund: it is tried with a test payment, then voided or deleted.
    if (!f.isTest && f.can.recordPayment && f.balanceMinor > 0) offered.push("record_payment");
    if (f.can.void && (f.paidMinor === 0 || f.isTest)) offered.push("void");
    else if (f.can.void) notes.push("An invoice with a payment cannot be voided. Record a refund instead.");
    if (!f.isTest && f.can.refund && f.balanceMinor > 0 && !f.writtenOff) offered.push("write_off");
    if (f.isTest && f.can.connect && f.hasTestConnection && f.balanceMinor > 0 && !f.writtenOff && f.paymentStatus !== "disputed") offered.push("test_payment");
    if (f.isTest && f.can.connect) offered.push("delete_test");
    if (f.isTest) notes.push("This is a test invoice: nothing is owed on it and no money moves.");
  } else if (f.status === "void" && f.isTest && f.can.connect) {
    offered.push("delete_test");
  }
  return { offered, notes };
}
