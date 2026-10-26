// How an invoice's message to the customer is described to the team. Pure.
//
// The status words, the property that they never say a message was delivered, read or received, and the chain's reasons are the proposal deliveries' own
// (src/lib/proposals/delivery-state.ts); this file only gives them the invoice's vocabulary: what stopped a message before it went out, and the reasons only an invoice has.

import {
  blockedReasonText, deliveryVerdict, describeDelivery, refusalReasonText, type DeliveryDescription, type DeliveryFacts, type DeliveryVerdict, type DeliveryView, type DeliveryVocab, type VerdictInput,
} from "@/lib/proposals/delivery-state";
import type { DeliveryChannel } from "@/lib/invoices/delivery-text";

export { maskAddress, channelLabel } from "@/lib/proposals/delivery-state";
export type { DeliveryDescription, DeliveryFacts, DeliveryVerdict };

/** The reasons a change to the invoice stops a queued message with (stored on the delivery, and on the message as its blocked reason). */
export type InvoiceWithdrawReason = "invoice_voided" | "invoice_paid" | "invoice_disputed" | "invoice_written_off" | "invoice_credited" | "invoice_link_replaced" | "privacy_request";

/** Why a message was stopped by the invoice's own changes. */
export const INVOICE_WITHDRAWN_REASON_TEXT: Record<InvoiceWithdrawReason, string> = {
  invoice_voided: "The invoice was voided before the message went out, so it was stopped.",
  invoice_paid: "The invoice was paid before the message went out, so it was stopped.",
  invoice_disputed: "A payment on the invoice was disputed before the message went out, so it was stopped.",
  invoice_written_off: "The invoice was written off before the message went out, so it was stopped.",
  invoice_credited: "The invoice was credited in full before the message went out, so nothing is owed and it was stopped.",
  invoice_link_replaced: "The customer's link was replaced before the message went out, so the message was stopped.",
  privacy_request: "The customer asked for their data to be erased, so the message was stopped.",
};

export const INVOICE_DELIVERY_VOCAB: DeliveryVocab = {
  withdrawn: INVOICE_WITHDRAWN_REASON_TEXT,
  linkUnavailable: {
    reason: "invoice_link_unavailable",
    text: "The invoice's link had stopped working when the message was due (the invoice was paid, voided, disputed or written off, or its link was replaced), so it was not sent.",
  },
  reasons: {
    no_customer: "The invoice is not linked to a customer record, so there is no address to send to",
    not_issued: "Only an issued invoice can be sent to a customer",
    test_invoice: "A test invoice is never sent to a customer",
    public_pages_off: "Invoice links are switched off for the whole platform right now",
  },
};

export const invoiceBlockedReasonText = (reason: string | null | undefined, detail: string | null | undefined): string => blockedReasonText(reason, detail, INVOICE_DELIVERY_VOCAB);
export const invoiceRefusalReasonText = (reason: string | null | undefined, detail: string | null | undefined): string => refusalReasonText(reason, detail, INVOICE_DELIVERY_VOCAB);
export const invoiceDeliveryVerdict = (d: VerdictInput, channel: DeliveryChannel, mask: string | null): DeliveryVerdict => deliveryVerdict(d, channel, mask, INVOICE_DELIVERY_VOCAB);
export const describeInvoiceDelivery = (f: DeliveryFacts): DeliveryDescription => describeDelivery(f, INVOICE_DELIVERY_VOCAB);

/** One delivery of an invoice as the screens read it: the same state words as a proposal's, and the version of the link the message carried. */
export interface InvoiceDeliveryView extends Omit<DeliveryView, "version"> {
  /** customer_invoices.public_token_version when the message was queued. */
  linkVersion: number;
}
