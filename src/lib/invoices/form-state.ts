import type { CurrencyCode } from "@/lib/money";
import type { LineFormInput } from "@/lib/invoices/lines";
import { filledLines } from "@/lib/invoices/screens";

// What the invoice form starts from. Kept out of the form component because the new and edit pages build it on the server, and a function exported from a "use client"
// file cannot be called there.

export interface InvoiceFormState {
  contact: { id: string; name: string } | null;
  deal: { id: string; name: string } | null;
  currency: CurrencyCode;
  taxInclusive: boolean;
  lines: LineFormInput[];
  dueOn: string;
  billTo: { name: string; company: string; email: string; phone: string; address: string; taxId: string };
  paymentInstructions: string;
  notes: string;
  terms: string;
  closesDeal: boolean;
  /** A test invoice: made to try the payment account in test mode. Nothing is owed on it and no money moves. */
  isTest: boolean;
}

export function emptyFormState(over: Partial<InvoiceFormState> & { currency: CurrencyCode }): InvoiceFormState {
  return {
    contact: null, deal: null, taxInclusive: false, lines: [{ description: "", quantity: "1", unitPrice: "", discountPercent: "", discountAmount: "", taxPercent: "" }], dueOn: "",
    billTo: { name: "", company: "", email: "", phone: "", address: "", taxId: "" }, paymentInstructions: "", notes: "", terms: "", closesDeal: false, isTest: false, ...over,
  };
}

// Whether two form states say the same thing, the way the server will store them: it collapses the spaces in a description, drops empty lines and address rows, and writes an
// amount in its own form. Used to tell a teammate's newer version apart from this person's own text coming back.
const flat = (s: string) => s.replace(/\s+/g, " ").trim();
const block = (s: string) => s.replace(/\r\n/g, "\n").trim();
const rows = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean).join("\n");
const amount = (s: string | null | undefined) => {
  const t = (s ?? "").trim();
  const n = Number(t);
  return t !== "" && Number.isFinite(n) ? String(n) : t;
};

export function sameFormState(a: InvoiceFormState, b: InvoiceFormState): boolean {
  const la = filledLines(a.lines);
  const lb = filledLines(b.lines);
  return (a.contact?.id ?? null) === (b.contact?.id ?? null) && (a.deal?.id ?? null) === (b.deal?.id ?? null) && a.currency === b.currency && a.taxInclusive === b.taxInclusive
    && la.length === lb.length
    && la.every((l, i) => flat(l.description) === flat(lb[i].description) && amount(l.quantity) === amount(lb[i].quantity) && amount(l.unitPrice) === amount(lb[i].unitPrice)
      && amount(l.discountPercent) === amount(lb[i].discountPercent) && amount(l.discountAmount) === amount(lb[i].discountAmount) && amount(l.taxPercent) === amount(lb[i].taxPercent))
    && a.dueOn.trim() === b.dueOn.trim()
    && flat(a.billTo.name) === flat(b.billTo.name) && flat(a.billTo.company) === flat(b.billTo.company) && a.billTo.email.trim() === b.billTo.email.trim() && a.billTo.phone.trim() === b.billTo.phone.trim()
    && rows(a.billTo.address) === rows(b.billTo.address) && flat(a.billTo.taxId) === flat(b.billTo.taxId)
    && block(a.paymentInstructions) === block(b.paymentInstructions) && block(a.notes) === block(b.notes) && block(a.terms) === block(b.terms)
    && (a.deal ? a.closesDeal : false) === (b.deal ? b.closesDeal : false)
    && a.isTest === b.isTest;
}
