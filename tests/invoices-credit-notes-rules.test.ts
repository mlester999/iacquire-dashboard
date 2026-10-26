import { describe, expect, it } from "vitest";
import {
  CREDIT_STATUSES, CREDIT_STATUS_EXPLAIN, CREDIT_STATUS_LABELS, canEditCredit, canTransitionCredit, creditAmountProblem, creditApproveBlockedReason, creditBlockedReason, creditReasonProblem, creditSummary, creditTaxPortion, formatCreditNumber, isFinalCredit,
} from "@/lib/invoices/credit-notes";
import { creditNoteContentHash } from "@/lib/invoices/credit-hash";
import { PAYMENT_STATUSES, balanceMinor, derivePaymentStatus, overpaidMinor, voidBlockedReason } from "@/lib/invoices/state";
import { invoiceBanner } from "@/lib/invoices/public-status";

// A credit note takes money off what a customer owes. It is not a payment: the invoice arithmetic, the statuses and the words keep the two apart.

describe("what the payments and credits add up to", () => {
  const base = { totalMinor: 100_000, hasDispute: false };

  it("is unchanged for an invoice with no credit", () => {
    expect(derivePaymentStatus({ ...base, paidMinor: 0 })).toBe("unpaid");
    expect(derivePaymentStatus({ ...base, paidMinor: 40_000 })).toBe("partially_paid");
    expect(derivePaymentStatus({ ...base, paidMinor: 100_000 })).toBe("paid");
    expect(derivePaymentStatus({ ...base, paidMinor: 130_000 })).toBe("paid");
    expect(derivePaymentStatus({ ...base, paidMinor: 40_000, hasDispute: true })).toBe("disputed");
  });

  it("is still unpaid or partly paid while a credit leaves something owed", () => {
    expect(derivePaymentStatus({ ...base, paidMinor: 0, creditedMinor: 30_000 })).toBe("unpaid");
    expect(derivePaymentStatus({ ...base, paidMinor: 20_000, creditedMinor: 30_000 })).toBe("partially_paid");
  });

  it("is credited, not paid, when the whole invoice is credited and nothing was paid", () => {
    expect(derivePaymentStatus({ ...base, paidMinor: 0, creditedMinor: 100_000 })).toBe("credited");
  });

  it("is paid when some money arrived and the credit covers the rest", () => {
    expect(derivePaymentStatus({ ...base, paidMinor: 60_000, creditedMinor: 40_000 })).toBe("paid");
    expect(derivePaymentStatus({ ...base, paidMinor: 1, creditedMinor: 99_999 })).toBe("paid");
  });

  it("a credit alone never reads as paid, and a dispute still wins", () => {
    for (const credited of [1, 50_000, 100_000]) expect(derivePaymentStatus({ ...base, paidMinor: 0, creditedMinor: credited })).not.toBe("paid");
    expect(derivePaymentStatus({ ...base, paidMinor: 60_000, creditedMinor: 40_000, hasDispute: true })).toBe("disputed");
  });

  it("owes the total less the credit less what was paid, never below zero, and overpays against the credited total", () => {
    expect(balanceMinor(100_000, 0, 0)).toBe(100_000);
    expect(balanceMinor(100_000, 20_000, 30_000)).toBe(50_000);
    expect(balanceMinor(100_000, 0, 100_000)).toBe(0);
    expect(balanceMinor(100_000, 90_000, 30_000)).toBe(0);
    expect(overpaidMinor(100_000, 100_000, 0)).toBe(0);
    expect(overpaidMinor(100_000, 90_000, 30_000)).toBe(20_000);
    expect(overpaidMinor(100_000, 70_000, 30_000)).toBe(0);
  });

  it("knows the new status by name", () => {
    expect(PAYMENT_STATUSES).toContain("credited");
  });

  it("cannot void an invoice that was credited, and says why", () => {
    expect(voidBlockedReason({ status: "issued", paidMinor: 0, creditedMinor: 100, hasOpenPayment: false })).toMatch(/credit note was issued/);
    expect(voidBlockedReason({ status: "issued", paidMinor: 0, creditedMinor: 0, hasOpenPayment: false })).toBeNull();
    expect(voidBlockedReason({ status: "issued", paidMinor: 0, creditedMinor: 100, hasOpenPayment: false, isTest: true })).toBeNull();
  });

  it("tells a customer of a fully credited invoice that nothing is due, and does not say paid", () => {
    const banner = invoiceBanner({ paymentStatus: "credited", balanceMinor: 0, hasPendingPayment: false, canPayOnline: false, overdue: false });
    expect(banner.kind).toBe("credited");
    expect(invoiceBanner({ paymentStatus: "paid", balanceMinor: 0, hasPendingPayment: false, canPayOnline: false, overdue: false }).kind).toBe("paid");
  });
});

describe("the life of a credit note", () => {
  it("moves draft, submitted, issued and cancelled only the way the database allows", () => {
    expect(canTransitionCredit("draft", "pending_approval")).toBe(true);
    expect(canTransitionCredit("draft", "issued")).toBe(true);
    expect(canTransitionCredit("draft", "cancelled")).toBe(true);
    expect(canTransitionCredit("pending_approval", "draft")).toBe(true);
    expect(canTransitionCredit("pending_approval", "issued")).toBe(true);
    expect(canTransitionCredit("pending_approval", "cancelled")).toBe(true);
  });

  it("makes issued and cancelled final: no way back, no void", () => {
    for (const s of ["issued", "cancelled"] as const) {
      expect(isFinalCredit(s)).toBe(true);
      for (const to of CREDIT_STATUSES) expect(canTransitionCredit(s, to), `${s} -> ${to}`).toBe(false);
    }
    expect(CREDIT_STATUSES).not.toContain("void");
  });

  it("has words for every status and never makes an issued credit sound reversible", () => {
    for (const s of CREDIT_STATUSES) {
      expect(CREDIT_STATUS_LABELS[s].length).toBeGreaterThan(2);
      expect(CREDIT_STATUS_EXPLAIN[s].length).toBeGreaterThan(20);
    }
    expect(CREDIT_STATUS_EXPLAIN.issued).toMatch(/no longer be changed, deleted or voided/);
    expect(CREDIT_STATUS_EXPLAIN.draft).toMatch(/nothing is taken off the invoice/i);
  });
});

describe("when a credit can be written", () => {
  const ok = { invoiceStatus: "issued" as const, isTest: false, writtenOff: false, paymentStatus: "unpaid" as const, balanceMinor: 50_000, hasOpenPayment: false };

  it("allows an issued, real invoice that still owes something", () => {
    expect(creditBlockedReason(ok)).toBeNull();
    expect(creditBlockedReason({ ...ok, paymentStatus: "partially_paid" })).toBeNull();
  });

  it("refuses every other case with a sentence a person can act on", () => {
    expect(creditBlockedReason({ ...ok, invoiceStatus: "draft" })).toMatch(/Only an issued invoice/);
    expect(creditBlockedReason({ ...ok, invoiceStatus: "pending_approval" })).toMatch(/Only an issued invoice/);
    expect(creditBlockedReason({ ...ok, invoiceStatus: "void" })).toMatch(/void/);
    expect(creditBlockedReason({ ...ok, isTest: true })).toMatch(/test invoice/);
    expect(creditBlockedReason({ ...ok, writtenOff: true })).toMatch(/written off/);
    expect(creditBlockedReason({ ...ok, paymentStatus: "disputed" })).toMatch(/dispute/);
    expect(creditBlockedReason({ ...ok, balanceMinor: 0 })).toMatch(/record a refund instead/);
    expect(creditBlockedReason({ ...ok, hasOpenPayment: true })).toMatch(/may be paying/);
  });

  it("takes only whole minor units, more than zero, and no more than is still owed", () => {
    expect(creditAmountProblem(1, 50_000)).toBeNull();
    expect(creditAmountProblem(50_000, 50_000)).toBeNull();
    expect(creditAmountProblem(50_001, 50_000, "PHP")).toMatch(/PHP 500\.00/);
    expect(creditAmountProblem(50_001, 50_000, "PHP")).toMatch(/refund instead/);
    for (const bad of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(creditAmountProblem(bad, 50_000), String(bad)).toMatch(/Enter the amount/);
  });

  it("wants a reason of five characters to four hundred", () => {
    expect(creditReasonProblem("ok")).toMatch(/at least 5/);
    expect(creditReasonProblem("    ab   ")).toMatch(/at least 5/);
    expect(creditReasonProblem("Goodwill discount")).toBeNull();
    expect(creditReasonProblem("x".repeat(401))).toMatch(/400/);
    expect(creditReasonProblem(undefined)).toMatch(/Say why/);
  });
});

describe("who can approve a credit note", () => {
  const f = { status: "pending_approval" as const, canApprove: true, isAuthor: false, isOwner: false };

  it("lets an approver who did not write it approve and issue it", () => {
    expect(creditApproveBlockedReason(f)).toBeNull();
    expect(creditApproveBlockedReason({ ...f, status: "draft" })).toBeNull();
  });

  it("keeps a second pair of eyes: the author cannot approve their own unless they are the owner", () => {
    expect(creditApproveBlockedReason({ ...f, isAuthor: true })).toMatch(/owner or another manager/);
    expect(creditApproveBlockedReason({ ...f, isAuthor: true, isOwner: true })).toBeNull();
  });

  it("refuses someone who may not approve, and a note that is already final", () => {
    expect(creditApproveBlockedReason({ ...f, canApprove: false })).toMatch(/Only the business owner or a manager/);
    expect(creditApproveBlockedReason({ ...f, status: "issued" })).toMatch(/already issued/);
    expect(creditApproveBlockedReason({ ...f, status: "cancelled" })).toMatch(/cancelled/);
  });

  it("lets the author or an approver edit a draft, and nobody without the credit permission", () => {
    expect(canEditCredit({ canCredit: true, canApprove: false, isAuthor: true })).toBe(true);
    expect(canEditCredit({ canCredit: true, canApprove: false, isAuthor: false })).toBe(false);
    expect(canEditCredit({ canCredit: true, canApprove: true, isAuthor: false })).toBe(true);
    expect(canEditCredit({ canCredit: false, canApprove: true, isAuthor: true })).toBe(false);
  });
});

describe("the number, the tax and the fingerprint", () => {
  it("numbers from one with the prefix and grows past four digits", () => {
    expect(formatCreditNumber("CN-", 1)).toBe("CN-0001");
    expect(formatCreditNumber("CN-", 12345)).toBe("CN-12345");
    expect(formatCreditNumber("", 7)).toBe("0007");
    expect(() => formatCreditNumber("CN-", 0)).toThrow();
  });

  it("takes the invoice's tax in proportion, rounded once, and none when there is none", () => {
    expect(creditTaxPortion(56_000, 6_000, 112_000)).toBe(3_000);
    expect(creditTaxPortion(112_000, 12_000, 112_000)).toBe(12_000);
    expect(creditTaxPortion(1, 1, 3)).toBe(0);
    expect(creditTaxPortion(50_000, 0, 112_000)).toBe(0);
  });

  it("fingerprints exactly what the document says: any change to it is visible", () => {
    const doc = { number: "CN-0001", invoiceNumber: "INV-0001", currency: "PHP", amountMinor: 50_000, taxPortionMinor: 0, reason: "Goodwill", issuedOn: "2026-10-26", billFrom: { name: "Co" }, billTo: { name: "Ann" } };
    const a = creditNoteContentHash(doc);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(creditNoteContentHash({ ...doc, billTo: { name: "Ann" }, billFrom: { name: "Co" } })).toBe(a);
    expect(creditNoteContentHash({ ...doc, amountMinor: 50_001 })).not.toBe(a);
    expect(creditNoteContentHash({ ...doc, reason: "Other" })).not.toBe(a);
    expect(creditNoteContentHash({ ...doc, number: "CN-0002" })).not.toBe(a);
  });

  it("summarises owed as total less credit less paid", () => {
    expect(creditSummary(100_000, 30_000, 20_000)).toEqual({ totalMinor: 100_000, creditedMinor: 30_000, paidMinor: 20_000, owedMinor: 50_000 });
    expect(creditSummary(100_000, 100_000, 0).owedMinor).toBe(0);
  });
});
