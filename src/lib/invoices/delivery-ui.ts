// What the invoice's send section offers and says, as plain functions. Pure: the server decides every one of these again and refuses what it should; this only keeps the screen
// from offering what will be refused and from saying more than the record holds. The words after a send (queued is not sent; sent means the provider accepted it) are the
// proposal deliveries' own (src/lib/proposals/delivery-ui.ts).

import type { InvoicePaymentStatus, InvoiceStatus } from "@/lib/invoices/state";
import { MAX_INVOICE_DELIVERIES_PER_LINK } from "@/lib/invoices/delivery-text";
import type { DeliveryVerdict, DeliveryView } from "@/lib/proposals/delivery-state";

export { confirmLabelFor, DELIVERY_BADGE_TONE, outcomeText, type SendOutcome } from "@/lib/proposals/delivery-ui";

export interface InvoiceSendFacts {
  status: InvoiceStatus;
  paymentStatus: InvoicePaymentStatus;
  writtenOff: boolean;
  balanceMinor: number;
  isTest: boolean;
  /** The person may send invoices (invoices.send). */
  canSend: boolean;
}

export interface SendSection {
  /** The "Send it to the customer" section is on the page. */
  show: boolean;
  /** Why it is not, when a person might look for it. Null when there is nothing worth saying. */
  note: string | null;
}

/** Whether the invoice offers sending at all, and why not when it does not. The server refuses the same cases whatever this says. */
export function sendSectionFor(f: InvoiceSendFacts): SendSection {
  if (!f.canSend || f.status !== "issued") return { show: false, note: null };
  if (f.isTest) return { show: false, note: "A test invoice is never sent to a customer: nothing is owed on it." };
  if (f.writtenOff) return { show: false, note: "This invoice was written off, so it is not sent to the customer." };
  if (f.paymentStatus === "disputed") return { show: false, note: "A payment on this invoice is disputed, so it is not sent to the customer." };
  if (f.paymentStatus === "paid" || f.balanceMinor <= 0) return { show: false, note: "This invoice is paid, so there is nothing to send." };
  return { show: true, note: null };
}

/** The parts of a preview the screen decides on (the server's InvoiceDeliveryPreview has them all). */
export interface InvoiceOfferFacts {
  verdict: Pick<DeliveryVerdict, "kind" | "text">;
  standing: Pick<DeliveryView, "label" | "explain" | "channelLabel"> | null;
  remaining: number;
}

export interface InvoiceOffer {
  /** The Send button is offered. */
  canSend: boolean;
  /** Why it is not, in a sentence the sender can act on. */
  why: string | null;
}

export function invoiceOfferFor(f: InvoiceOfferFacts): InvoiceOffer {
  if (f.standing) return { canSend: false, why: `${f.standing.channelLabel}: ${f.standing.label}. ${f.standing.explain} To send it again, replace the customer's link first.` };
  if (f.remaining <= 0) return { canSend: false, why: `This link has already had ${MAX_INVOICE_DELIVERIES_PER_LINK} messages. Copy the link and give it to the customer yourself.` };
  if (f.verdict.kind === "refused") return { canSend: false, why: f.verdict.text };
  return { canSend: true, why: null };
}
