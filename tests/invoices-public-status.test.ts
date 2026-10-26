// What the customer's pages say about a payment, as pure rules. The one rule under all of them: nothing here says the customer has paid until a payment row that the
// database counted says so. A browser coming back from the provider, a success flag in an address, an attempt that merely exists: none of them reads as a payment.
import { describe, expect, it } from "vitest";
import {
  CONFIRMING_WINDOW_MINUTES, describeReturn, invoiceBanner, paymentIsCounted,
  type AttemptState, type InvoiceBannerFacts, type PaymentRowState, type ReturnFacts,
} from "@/lib/invoices/public-status";
import { BACK_STORAGE_KEY, POLL_DELAYS_MS, REFERENCE_HEADER, TOKEN_HEADER, looksLikeReference, safeBackPath } from "@/lib/invoices/public-http";
import { bannerText } from "@/components/invoices/public/invoice-document";
import type { InvoiceStatus } from "@/lib/invoices/state";

const ATTEMPTS: AttemptState[] = ["created", "redirected", "succeeded", "failed", "expired", "cancelled", "needs_review"];
const PAYMENTS: Array<PaymentRowState | null> = [null, "succeeded", "pending", "failed", "needs_review", "partially_refunded", "refunded", "disputed"];
const INVOICES: InvoiceStatus[] = ["draft", "pending_approval", "issued", "void"];
const AGES = [0, 1, CONFIRMING_WINDOW_MINUTES - 0.01, CONFIRMING_WINDOW_MINUTES, CONFIRMING_WINDOW_MINUTES + 1, 24 * 60];

function everyReturnCase(): ReturnFacts[] {
  const out: ReturnFacts[] = [];
  for (const attemptStatus of ATTEMPTS) for (const payment of PAYMENTS) for (const invoiceStatus of INVOICES) for (const ageMinutes of AGES) for (const saidCancelled of [false, true]) {
    out.push({ attemptStatus, payment: payment ? { status: payment } : null, invoiceStatus, ageMinutes, saidCancelled });
  }
  return out;
}

describe("what a customer is told after the provider's page", () => {
  it("says the payment was received for exactly one reason: the database holds a counted payment for the checkout", () => {
    const cases = everyReturnCase();
    expect(cases.length).toBeGreaterThan(2000);
    for (const f of cases) {
      const d = describeReturn(f);
      const counted = f.payment !== null && paymentIsCounted(f.payment.status);
      const label = JSON.stringify(f);
      expect(d.state === "received", label).toBe(counted);
      const words = `${d.headline} ${d.detail}`;
      if (!counted) {
        // However the customer got here, no other state thanks them, or says the invoice is paid or the payment is received.
        expect(words, label).not.toMatch(/have received your payment|thank you|paid in full|has been paid|was successful|successfully/i);
        expect(d.tone, label).not.toBe("ok");
      }
    }
  });

  it("never lets how the customer left the provider's page (the cancelled flag) change a state, only the wording of one", () => {
    for (const f of everyReturnCase()) {
      const a = describeReturn({ ...f, saidCancelled: false });
      const b = describeReturn({ ...f, saidCancelled: true });
      expect(b.state, JSON.stringify(f)).toBe(a.state);
      expect(b.polling).toBe(a.polling);
    }
  });

  it("counts only the payment statuses the invoice itself counts", () => {
    expect(PAYMENTS.filter((p): p is PaymentRowState => p !== null).filter(paymentIsCounted).sort()).toEqual(["disputed", "partially_refunded", "refunded", "succeeded"]);
  });

  it("says 'we are confirming' while an open checkout is young, keeps asking, and tells the truth when it is not heard of in time", () => {
    for (const attemptStatus of ["created", "redirected", "succeeded"] as const) {
      const young = describeReturn({ attemptStatus, payment: null, invoiceStatus: "issued", ageMinutes: CONFIRMING_WINDOW_MINUTES - 1 });
      expect(young).toMatchObject({ state: "confirming", headline: "We are confirming your payment", polling: true, tone: "wait" });
      expect(young.detail).toMatch(/Please do not pay again/);
      const old = describeReturn({ attemptStatus, payment: null, invoiceStatus: "issued", ageMinutes: CONFIRMING_WINDOW_MINUTES });
      expect(old).toMatchObject({ state: "taking_longer", polling: false });
      expect(old.detail).toMatch(/contact the business with the reference/);
    }
    // An attempt the database marks succeeded with no payment row is still not a payment.
    expect(describeReturn({ attemptStatus: "succeeded", payment: null, invoiceStatus: "issued", ageMinutes: 1 }).state).toBe("confirming");
  });

  it("holds a pending payment as 'still being processed' and does not count it", () => {
    const d = describeReturn({ attemptStatus: "redirected", payment: { status: "pending" }, invoiceStatus: "issued", ageMinutes: 3 });
    expect(d).toMatchObject({ state: "confirming", polling: true });
    expect(d.detail).toMatch(/still being processed/);
  });

  it("sends a payment kept for review to a person without asking the customer to pay again, and a failed one to try again", () => {
    expect(describeReturn({ attemptStatus: "needs_review", payment: { status: "needs_review" }, invoiceStatus: "issued", ageMinutes: 5 })).toMatchObject({ state: "review", polling: false, tone: "wait" });
    expect(describeReturn({ attemptStatus: "needs_review", payment: { status: "needs_review" }, invoiceStatus: "issued", ageMinutes: 5 }).detail).toMatch(/do not need to pay again/);
    expect(describeReturn({ attemptStatus: "redirected", payment: { status: "failed" }, invoiceStatus: "issued", ageMinutes: 5 })).toMatchObject({ state: "failed", tone: "problem", polling: false });
    expect(describeReturn({ attemptStatus: "failed", payment: null, invoiceStatus: "issued", ageMinutes: 5 }).state).toBe("failed");
  });

  it("says a voided invoice is no longer payable, and a cancelled or expired checkout was not completed, in words that depend on whether the customer said cancel", () => {
    expect(describeReturn({ attemptStatus: "redirected", payment: null, invoiceStatus: "void", ageMinutes: 1 })).toMatchObject({ state: "unavailable", polling: false });
    const cancelled = describeReturn({ attemptStatus: "cancelled", payment: null, invoiceStatus: "issued", ageMinutes: 1, saidCancelled: true });
    expect(cancelled).toMatchObject({ state: "not_completed", polling: false });
    expect(cancelled.detail).toMatch(/nothing was charged/);
    const closed = describeReturn({ attemptStatus: "expired", payment: null, invoiceStatus: "issued", ageMinutes: 1, saidCancelled: false });
    expect(closed.state).toBe("not_completed");
    expect(closed.detail).toMatch(/If you were charged, contact the business with the reference/);
  });

  it("polls only in the states where an answer is still expected", () => {
    for (const f of everyReturnCase()) {
      const d = describeReturn(f);
      expect(d.polling, JSON.stringify(f)).toBe(d.state === "confirming");
    }
  });
});

describe("the one line at the top of an invoice page", () => {
  const statuses: InvoiceBannerFacts["paymentStatus"][] = ["unpaid", "partially_paid", "paid", "disputed"];

  it("says paid for exactly one reason: the invoice's payment status is paid", () => {
    for (const paymentStatus of statuses) for (const hasPendingPayment of [false, true]) for (const canPayOnline of [false, true]) for (const overdue of [false, true]) for (const balanceMinor of [0, 1, 150000]) {
      const b = invoiceBanner({ paymentStatus, balanceMinor, hasPendingPayment, canPayOnline, overdue });
      expect(b.kind === "paid", JSON.stringify({ paymentStatus, hasPendingPayment, canPayOnline, overdue })).toBe(paymentStatus === "paid");
      if (b.kind !== "paid") expect(b.tone).not.toBe("ok");
    }
  });

  it("puts a dispute and a payment in progress above the offer to pay, and the offer to pay above 'pay another way'", () => {
    const base = { balanceMinor: 150000, hasPendingPayment: false, canPayOnline: true, overdue: false };
    expect(invoiceBanner({ ...base, paymentStatus: "disputed", hasPendingPayment: true }).kind).toBe("under_review");
    expect(invoiceBanner({ ...base, paymentStatus: "unpaid", hasPendingPayment: true }).kind).toBe("pending");
    expect(invoiceBanner({ ...base, paymentStatus: "partially_paid" }).kind).toBe("partly_paid");
    expect(invoiceBanner({ ...base, paymentStatus: "unpaid", overdue: true }).kind).toBe("overdue");
    expect(invoiceBanner({ ...base, paymentStatus: "unpaid" }).kind).toBe("pay_online");
    expect(invoiceBanner({ ...base, paymentStatus: "unpaid", canPayOnline: false }).kind).toBe("pay_other_way");
  });

  it("words each banner without promising what the database does not hold", () => {
    const facts = { balanceMinor: 50000, currency: "PHP" as const, dueOn: "2026-11-06", business: { name: "Santos Plumbing", brandColor: null, addressLines: [], taxLabel: null, taxId: null, email: null, phone: null } };
    expect(bannerText("paid", facts)).toBe("Paid in full. Thank you.");
    expect(bannerText("partly_paid", facts)).toMatch(/Partly paid\. .*500\.00 is still due\./);
    expect(bannerText("overdue", facts)).toBe("This invoice was due on Nov 6, 2026.");
    expect(bannerText("pending", facts)).toMatch(/Please do not pay again/);
    expect(bannerText("under_review", facts)).toMatch(/do not need to pay again/);
    expect(bannerText("pay_other_way", facts)).toBe("Online payment is not available for this invoice. Please follow the payment instructions below.");
    expect(bannerText("pay_other_way", { ...facts, business: { ...facts.business, email: "billing@example.test" } })).toMatch(/or contact the business/);
    // Only "paid" thanks the customer.
    for (const kind of ["partly_paid", "under_review", "pending", "overdue", "pay_online", "pay_other_way"] as const) expect(bannerText(kind, facts), kind).not.toMatch(/thank you|paid in full/i);
  });
});

describe("what the page and its server share", () => {
  it("accepts a way back only if it is exactly an invoice page of this site", () => {
    const token = "A".repeat(43);
    expect(safeBackPath(`/pay/${token}`)).toBe(`/pay/${token}`);
    for (const bad of [null, undefined, 42, "", "/pay/short", `/pay/${token}?x=1`, `/pay/${token}/`, `//evil.example/pay/${token}`, `https://evil.example/pay/${token}`, `javascript:alert(1)`, `/pay/${token}%0a`, `/pay/${"A".repeat(44)}`, `/pay/return/${token}`, `pay/${token}`]) {
      expect(safeBackPath(bad), String(bad)).toBeNull();
    }
    expect(BACK_STORAGE_KEY).toBeTruthy();
  });

  it("recognises a checkout reference only in the shape this product issues", () => {
    expect(looksLikeReference(`CP-${"a".repeat(20)}`)).toBe(true);
    expect(looksLikeReference(`CP-${"A1".repeat(20)}`)).toBe(true);
    for (const bad of [null, "", "CP-", `CP-${"a".repeat(19)}`, `CP-${"a".repeat(41)}`, `cp-${"a".repeat(20)}`, `CP-${"a".repeat(19)}!`, `XX-${"a".repeat(20)}`, 5]) expect(looksLikeReference(bad), String(bad)).toBe(false);
  });

  it("carries the invoice's link and the checkout's reference in headers, never in an address, and asks for about two and a half minutes", () => {
    expect(TOKEN_HEADER).toBe("x-invoice-token");
    expect(REFERENCE_HEADER).toBe("x-payment-reference");
    const total = POLL_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(120_000);
    expect(total).toBeLessThanOrEqual(200_000);
    // The delays never shrink, so a long wait costs the server less and less.
    for (let i = 1; i < POLL_DELAYS_MS.length; i += 1) expect(POLL_DELAYS_MS[i]).toBeGreaterThanOrEqual(POLL_DELAYS_MS[i - 1]);
    expect(POLL_DELAYS_MS[0]).toBeGreaterThanOrEqual(2000);
  });
});
