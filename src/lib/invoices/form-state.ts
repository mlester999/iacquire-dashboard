import type { CurrencyCode } from "@/lib/money";
import type { LineFormInput } from "@/lib/invoices/lines";

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
}

export function emptyFormState(over: Partial<InvoiceFormState> & { currency: CurrencyCode }): InvoiceFormState {
  return {
    contact: null, deal: null, taxInclusive: false, lines: [{ description: "", quantity: "1", unitPrice: "", discountPercent: "", discountAmount: "", taxPercent: "" }], dueOn: "",
    billTo: { name: "", company: "", email: "", phone: "", address: "", taxId: "" }, paymentInstructions: "", notes: "", terms: "", closesDeal: false, ...over,
  };
}
