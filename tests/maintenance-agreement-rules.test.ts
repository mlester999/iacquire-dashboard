import { describe, expect, it } from "vitest";
import {
  AGREEMENT_STATUSES, chargeVerdict, isTerminalAgreement, moveAgreement, paymentModeLabel, statusFromPaypal,
  type AgreementFacts, type AgreementStatus, type ChargeFacts,
} from "@/lib/maintenance-agreement";

const at = (iso: string) => new Date(iso);
const agreement = (over: Partial<AgreementFacts> = {}): AgreementFacts => ({ status: "active", livemode: false, amountMinor: 29_900, currency: "USD", hold: null, ...over });
const charge = (over: Partial<ChargeFacts> = {}): ChargeFacts => ({ providerPaymentId: "SALE-1", amountMinor: 29_900, currency: "USD", livemode: false, alreadyRecorded: false, ...over });

describe("provider statuses", () => {
  it("maps PayPal's subscription statuses and nothing else", () => {
    expect(statusFromPaypal("APPROVAL_PENDING")).toBe("approval_pending");
    expect(statusFromPaypal("ACTIVE")).toBe("active");
    expect(statusFromPaypal("SUSPENDED")).toBe("suspended");
    expect(statusFromPaypal("CANCELLED")).toBe("cancelled");
    expect(statusFromPaypal("EXPIRED")).toBe("expired");
    expect(statusFromPaypal("active")).toBeNull();
    expect(statusFromPaypal("PAID")).toBeNull();
    expect(statusFromPaypal(null)).toBeNull();
    expect(statusFromPaypal(42)).toBeNull();
  });
});

describe("moving an agreement", () => {
  const none = { at: null, lastAt: null };

  it("follows a healthy life: approval, approved, active, suspended, active again, cancelled", () => {
    let s: AgreementStatus = "approval_pending";
    for (const next of ["approved", "active", "suspended", "active", "cancelled"] as const) {
      const move = moveAgreement(s, next, none);
      expect(move.changed, `${s} -> ${next}`).toBe(true);
      s = move.status;
    }
    expect(s).toBe("cancelled");
  });

  it("treats a repeat as a repeat", () => {
    expect(moveAgreement("active", "active", none)).toEqual({ status: "active", changed: false, ignored: "same" });
  });

  it("never revives an agreement that ended, whatever arrives late", () => {
    for (const ended of ["cancelled", "expired", "abandoned"] as const) {
      for (const incoming of AGREEMENT_STATUSES) {
        if (incoming === ended) continue;
        const move = moveAgreement(ended, incoming, none);
        expect(move.status, `${ended} <- ${incoming}`).toBe(ended);
        expect(move.changed).toBe(false);
        expect(move.ignored).toBe("terminal");
      }
    }
  });

  it("lets any open status end", () => {
    for (const open of ["approval_pending", "approved", "active", "suspended"] as const) {
      expect(moveAgreement(open, "cancelled", none).status).toBe("cancelled");
      expect(moveAgreement(open, "expired", none).status).toBe("expired");
    }
  });

  it("ignores news dated before news already applied (a delivery that crossed another)", () => {
    const move = moveAgreement("suspended", "active", { at: at("2026-10-01T10:00:00Z"), lastAt: at("2026-10-01T11:00:00Z") });
    expect(move).toEqual({ status: "suspended", changed: false, ignored: "stale" });
    const same = moveAgreement("suspended", "active", { at: at("2026-10-01T11:00:00Z"), lastAt: at("2026-10-01T11:00:00Z") });
    expect(same.changed).toBe(true);
  });

  it("ignores an earlier stage after a later one (approved after active)", () => {
    expect(moveAgreement("active", "approved", none)).toEqual({ status: "active", changed: false, ignored: "older_stage" });
    expect(moveAgreement("active", "approval_pending", none).changed).toBe(false);
    expect(moveAgreement("suspended", "approved", none).changed).toBe(false);
  });

  it("ends an agreement even on stale-dated news: an end is never undone by timing", () => {
    const move = moveAgreement("active", "cancelled", { at: at("2026-10-01T10:00:00Z"), lastAt: at("2026-10-01T11:00:00Z") });
    expect(move.status).toBe("cancelled");
  });

  it("knows which statuses are terminal", () => {
    expect(AGREEMENT_STATUSES.filter(isTerminalAgreement)).toEqual(["cancelled", "expired", "abandoned"]);
  });
});

describe("what a reported charge may do", () => {
  it("applies a charge that is exactly what the agreement asked for", () => {
    expect(chargeVerdict(agreement(), charge())).toEqual({ action: "apply" });
  });

  it("does not need an active agreement: a verified final charge after a cancellation is still money", () => {
    expect(chargeVerdict(agreement({ status: "cancelled" }), charge()).action).toBe("apply");
    expect(chargeVerdict(agreement({ status: "suspended" }), charge()).action).toBe("apply");
  });

  it("recognises a charge it already recorded", () => {
    expect(chargeVerdict(agreement(), charge({ alreadyRecorded: true }))).toEqual({ action: "duplicate" });
  });

  it("refuses a charge that names no payment", () => {
    expect(chargeVerdict(agreement(), charge({ providerPaymentId: null })).action).toBe("reject");
  });

  it("refuses a charge from the other mode", () => {
    expect(chargeVerdict(agreement({ livemode: true }), charge({ livemode: false })).action).toBe("reject");
    expect(chargeVerdict(agreement({ livemode: false }), charge({ livemode: true })).action).toBe("reject");
  });

  it("does not apply a charge for another amount or currency, in either direction", () => {
    expect(chargeVerdict(agreement(), charge({ amountMinor: 29_800 })).action).toBe("mismatch");
    expect(chargeVerdict(agreement(), charge({ amountMinor: 59_800 })).action).toBe("mismatch");
    expect(chargeVerdict(agreement(), charge({ currency: "PHP" })).action).toBe("mismatch");
    expect(chargeVerdict(agreement(), charge({ amountMinor: null })).action).toBe("mismatch");
    expect(chargeVerdict(agreement(), charge({ amountMinor: 0 })).action).toBe("mismatch");
    expect(chargeVerdict(agreement(), charge({ currency: null })).action).toBe("mismatch");
  });

  it("records but does not apply a charge on an agreement held after a refund or a dispute", () => {
    for (const hold of ["refunded", "disputed"] as const) {
      const v = chargeVerdict(agreement({ hold }), charge());
      expect(v.action).toBe("record_held");
    }
  });

  it("checks the amount before the hold: a wrong amount on a held agreement is still a mismatch", () => {
    expect(chargeVerdict(agreement({ hold: "disputed" }), charge({ amountMinor: 1 })).action).toBe("mismatch");
  });
});

describe("how the plan says it is paid", () => {
  it("says a plan with no agreement is paid by hand", () => {
    const l = paymentModeLabel(null);
    expect(l.mode).toBe("manual");
    expect(l.headline).toMatch(/by hand/i);
  });

  it("says a cancelled or expired agreement means by hand again, and names the stop", () => {
    const base = { provider: "paypal", nextBillingAt: null, failedPayments: 0, hold: null };
    expect(paymentModeLabel({ ...base, status: "cancelled" }).mode).toBe("manual");
    expect(paymentModeLabel({ ...base, status: "cancelled" }).detail).toMatch(/stopped/i);
    expect(paymentModeLabel({ ...base, status: "expired" }).mode).toBe("manual");
    expect(paymentModeLabel({ ...base, status: "abandoned" }).mode).toBe("manual");
  });

  it("does not call an unapproved agreement automatic", () => {
    const base = { provider: "paypal", nextBillingAt: null, failedPayments: 0, hold: null };
    for (const status of ["approval_pending", "approved"] as const) {
      const l = paymentModeLabel({ ...base, status });
      expect(l.mode).toBe("manual");
      expect(l.detail).toMatch(/paid by hand/i);
    }
  });

  it("says automatic only for an active or suspended agreement, and says a charge counts only when confirmed", () => {
    const base = { provider: "paypal", nextBillingAt: "2026-11-26T00:00:00Z", failedPayments: 0, hold: null };
    const on = paymentModeLabel({ ...base, status: "active" });
    expect(on.mode).toBe("automatic");
    expect(on.detail).toMatch(/2026-11-26/);
    expect(on.detail).toMatch(/only when PayPal confirms/i);
  });

  it("says so on the page when the last charge failed but the agreement is still on, and what that means for the plan", () => {
    const base = { provider: "paypal", nextBillingAt: "2026-11-26T00:00:00Z", hold: null, status: "active" as const };
    const one = paymentModeLabel({ ...base, failedPayments: 1 });
    expect(one.mode).toBe("automatic");
    expect(one.headline).toMatch(/did not go through/i);
    expect(one.detail).toMatch(/could not collect the last charge/);
    expect(one.detail).toMatch(/exactly as paid as it was/);
    expect(one.detail).toMatch(/pauses the agreement/);
    expect(paymentModeLabel({ ...base, failedPayments: 2 }).detail).toMatch(/the last 2 charges/);
    // Nothing failed: the ordinary wording. A hold keeps its own wording whatever failed before it.
    expect(paymentModeLabel({ ...base, failedPayments: 0 }).headline).toBe("Automatic payments are on");
    expect(paymentModeLabel({ ...base, failedPayments: 2, hold: "disputed" }).headline).toMatch(/on hold/i);
  });

  it("says when an agreement is paused or on hold", () => {
    const base = { provider: "paypal", nextBillingAt: null, hold: null };
    expect(paymentModeLabel({ ...base, status: "suspended", failedPayments: 2 }).detail).toMatch(/after 2 failed charges/);
    expect(paymentModeLabel({ ...base, status: "suspended", failedPayments: 1 }).detail).toMatch(/after 1 failed charge\./);
    const held = paymentModeLabel({ ...base, status: "active", failedPayments: 0, hold: "disputed" });
    expect(held.headline).toMatch(/on hold/i);
    expect(held.detail).toMatch(/reviews them before the plan is extended/i);
  });
});
