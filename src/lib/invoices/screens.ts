import { MoneyError, type CurrencyCode } from "@/lib/money";
import { InvoiceInputError } from "@/lib/invoices/errors";
import { parseLine, parseLines, type LineFormInput } from "@/lib/invoices/lines";
import { canEditDraft, issueBlockedReason, type InvoicePaymentStatus, type InvoiceStatus } from "@/lib/invoices/state";

// What the invoice screens decide for themselves, kept out of the components so it can be tested: which list a filter means, what the form's lines come to as the person types,
// and which buttons an invoice offers a person. The server decides every one of these again; this only decides what to offer.

export const LIST_FILTERS = ["open", "overdue", "draft", "waiting", "paid", "void", "all"] as const;
export type ListFilter = (typeof LIST_FILTERS)[number];

export const LIST_FILTER_LABELS: Record<ListFilter, string> = {
  open: "Owed", overdue: "Overdue", draft: "Drafts", waiting: "Waiting for approval", paid: "Paid", void: "Void", all: "Everything",
};

export function parseListFilter(v: string | string[] | undefined): ListFilter {
  const one = Array.isArray(v) ? v[0] : v;
  return (LIST_FILTERS as readonly string[]).includes(one ?? "") ? (one as ListFilter) : "open";
}

export interface ListQuery {
  status?: InvoiceStatus[];
  paymentStatus?: InvoicePaymentStatus[];
  overdueOnly?: boolean;
}

/** The query a filter stands for. Overdue is checked when the list is read (it is not live: the scheduler's sweep only raises the notice). */
export function filterQuery(f: ListFilter): ListQuery {
  switch (f) {
    case "open": return { status: ["issued"], paymentStatus: ["unpaid", "partially_paid", "disputed"] };
    case "overdue": return { overdueOnly: true };
    case "draft": return { status: ["draft"] };
    case "waiting": return { status: ["pending_approval"] };
    case "paid": return { status: ["issued"], paymentStatus: ["paid"] };
    case "void": return { status: ["void"] };
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
  | "edit" | "submit" | "withdraw" | "approve_issue" | "request_changes" | "issue" | "discard" | "link" | "record_payment" | "void" | "write_off" | "test_payment";

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
    if (f.can.recordPayment && f.balanceMinor > 0) offered.push("record_payment");
    if (f.can.void && f.paidMinor === 0) offered.push("void");
    else if (f.can.void) notes.push("An invoice with a payment cannot be voided. Record a refund instead.");
    if (f.can.refund && f.balanceMinor > 0 && !f.writtenOff) offered.push("write_off");
    if (f.can.connect && f.hasTestConnection && f.balanceMinor > 0 && !f.writtenOff && f.paymentStatus !== "disputed") offered.push("test_payment");
  }
  return { offered, notes };
}
