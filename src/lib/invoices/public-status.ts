import type { InvoicePaymentStatus, InvoiceStatus } from "@/lib/invoices/state";

// What the customer's pages say about a payment. Pure. The one rule: nothing here says the customer has paid until a payment row the database counted says so. A browser
// returning from the provider's page, a success flag in an address, an attempt that merely exists: none of them is a payment, so none of them reads as one.

/** How long after the checkout opened a missing confirmation is still "on its way" rather than "taking longer than it should". */
export const CONFIRMING_WINDOW_MINUTES = 30;

export type PaymentRowState = "succeeded" | "pending" | "failed" | "needs_review" | "partially_refunded" | "refunded" | "disputed";
export type AttemptState = "created" | "redirected" | "succeeded" | "failed" | "expired" | "cancelled" | "needs_review";

const COUNTED: readonly PaymentRowState[] = ["succeeded", "partially_refunded", "refunded", "disputed"];
export const paymentIsCounted = (s: PaymentRowState) => COUNTED.includes(s);

export type ReturnState = "received" | "confirming" | "taking_longer" | "failed" | "not_completed" | "review" | "unavailable";

export interface ReturnFacts {
  attemptStatus: AttemptState;
  /** The payment recorded against this checkout, if the database has one. */
  payment: { status: PaymentRowState } | null;
  invoiceStatus: InvoiceStatus;
  /** Minutes since the checkout opened. */
  ageMinutes: number;
  /** The address said the customer pressed cancel. It only changes the wording of "not completed"; it never changes the state. */
  saidCancelled?: boolean;
  /** The checkout was for a test invoice: whatever happened, it moved no money. */
  isTest?: boolean;
}

export interface ReturnDescription {
  state: ReturnState;
  headline: string;
  detail: string;
  /** The page should keep asking the server: an answer is still expected. */
  polling: boolean;
  tone: "ok" | "wait" | "problem";
}

/** What to tell a customer who has come back from the provider's page. */
export function describeReturn(f: ReturnFacts): ReturnDescription {
  if (f.payment && paymentIsCounted(f.payment.status)) {
    if (f.isTest) {
      return { state: "received", headline: "The test payment went through", detail: "This was a test invoice: no money moved and nothing is owed. A record of the test is on the invoice.", polling: false, tone: "ok" };
    }
    return { state: "received", headline: "We have received your payment", detail: "Thank you. A record of it is on your invoice. You do not need to do anything else.", polling: false, tone: "ok" };
  }
  if (f.payment?.status === "needs_review") {
    return {
      state: "review", headline: "We received a notice about your payment", detail: "The business needs to check it before it is counted on your invoice. You do not need to pay again. If you have a question, contact the business and give them the reference below.",
      polling: false, tone: "wait",
    };
  }
  if (f.payment?.status === "failed" || f.attemptStatus === "failed") {
    return { state: "failed", headline: "Your payment did not go through", detail: "Nothing was charged on this attempt. You can go back to the invoice and try again, or use another way to pay.", polling: false, tone: "problem" };
  }
  if (f.invoiceStatus === "void") {
    return { state: "unavailable", headline: "This invoice is no longer payable", detail: "The business cancelled it. If you were charged, contact the business with the reference below.", polling: false, tone: "problem" };
  }
  if (f.attemptStatus === "cancelled" || f.attemptStatus === "expired") {
    return {
      state: "not_completed", headline: "The payment was not completed",
      detail: f.saidCancelled ? "You cancelled before paying, so nothing was charged. You can go back to the invoice to pay." : "This checkout is closed and no payment has been confirmed. If you were charged, contact the business with the reference below. Otherwise go back to the invoice to pay.",
      polling: false, tone: "wait",
    };
  }
  // A checkout that is open (or that the provider says succeeded, though we hold no payment for it yet): the answer has not reached us.
  if (f.ageMinutes < CONFIRMING_WINDOW_MINUTES) {
    return {
      state: "confirming", headline: "We are confirming your payment",
      detail: f.payment?.status === "pending" ? "Your payment provider says it is still being processed. This page will update when it is confirmed. Please do not pay again." : "This can take a minute. This page will update when your payment provider confirms it. Please do not pay again.",
      polling: true, tone: "wait",
    };
  }
  return {
    state: "taking_longer", headline: "We have not been told about a payment yet", detail: "Confirmation is taking longer than usual. If you completed the payment, it will be recorded when your payment provider tells us; if you were charged and nothing changes, contact the business with the reference below.",
    polling: false, tone: "wait",
  };
}

export interface InvoiceBannerFacts {
  paymentStatus: InvoicePaymentStatus;
  balanceMinor: number;
  hasPendingPayment: boolean;
  canPayOnline: boolean;
  overdue: boolean;
  /** A test invoice says so first, whatever its payment state. */
  isTest?: boolean;
}

export type InvoiceBannerKind = "test" | "paid" | "credited" | "partly_paid" | "under_review" | "pending" | "overdue" | "pay_online" | "pay_other_way";

export interface InvoiceBanner {
  kind: InvoiceBannerKind;
  tone: "ok" | "wait" | "problem" | "info";
}

/** The one line at the top of an invoice page, chosen only from what the database holds. "Paid" is the database's word for it. */
export function invoiceBanner(f: InvoiceBannerFacts): InvoiceBanner {
  // A test invoice is never "overdue" or "pay online": nothing is owed on it, and a test is the first thing anybody who opens it should read.
  if (f.isTest) return { kind: "test", tone: "info" };
  if (f.paymentStatus === "paid") return { kind: "paid", tone: "ok" };
  // Credited in full: nothing is due, and it is not said to be paid because nothing was.
  if (f.paymentStatus === "credited") return { kind: "credited", tone: "ok" };
  if (f.paymentStatus === "disputed") return { kind: "under_review", tone: "wait" };
  if (f.hasPendingPayment) return { kind: "pending", tone: "wait" };
  if (f.paymentStatus === "partially_paid") return { kind: "partly_paid", tone: "info" };
  if (f.overdue) return { kind: "overdue", tone: "problem" };
  return f.canPayOnline ? { kind: "pay_online", tone: "info" } : { kind: "pay_other_way", tone: "info" };
}
