import { describe, expect, it } from "vitest";
import {
  canBuyerStart, canCancel, canProvision, canReleaseHold, canRotateLink, canVerifyPayment, checkoutReturnText, effectiveStatus, formatUsdCents, noPaymentYetText, paymentHeldEventText, priceSnapshot,
  providerNameText, PURCHASE_EVENT_TEXT, PURCHASE_LINK_DAYS, PURCHASE_STATUSES, SANDBOX_PAYMENT_TEXT,
} from "@/lib/purchase-intents/rules";
import { MAINTENANCE_MONTHLY_USD, SETUP_FEE_USD } from "@/lib/billing";

// The approved commercial model and the purchase transitions are pure: no clock, no database. 1,499 and 299 are the founder's stated prices and must not be inferred
// from a form field.

const NOW = new Date("2026-10-25T12:00:00Z");
const state = (status: "invited" | "started" | "payment_verified" | "provisioned" | "cancelled" | "expired", days = 2) => ({
  status,
  expiresAt: new Date(NOW.getTime() + days * 86_400_000).toISOString(),
});

describe("the frozen purchase price", () => {
  it("is US$1,499 setup and US$299/month, with the two-decimal cents the database stores", () => {
    const snapshot = priceSnapshot(true);
    expect(snapshot).toEqual({
      setupFeeCents: 149900,
      maintenanceMonthlyCents: 29900,
      currency: "USD",
      maintenanceSelected: true,
      productVersion: "launch-2026-10",
    });
    expect(SETUP_FEE_USD).toBe(1499);
    expect(MAINTENANCE_MONTHLY_USD).toBe(299);
    expect(priceSnapshot(false).maintenanceSelected).toBe(false);
    expect(formatUsdCents(149900)).toBe("$1,499");
    expect(formatUsdCents(29900)).toBe("$299");
  });
});

describe("what a buyer and the team may do", () => {
  it("allows a buyer to confirm an open invitation and treats a repeat as the same state", () => {
    expect(canBuyerStart(state("invited"), NOW)).toEqual({ ok: true });
    expect(canBuyerStart(state("started"), NOW)).toEqual({ ok: true });
    expect(canBuyerStart(state("payment_verified"), NOW).ok).toBe(false);
    expect(canBuyerStart(state("cancelled"), NOW).ok).toBe(false);
    expect(canBuyerStart(state("expired", -1), NOW).ok).toBe(false);
  });

  it("moves an invitation past its day to expired even before a job writes the row", () => {
    expect(effectiveStatus(state("invited", -1), NOW)).toBe("expired");
    expect(effectiveStatus(state("started", -1), NOW)).toBe("expired");
    expect(effectiveStatus(state("payment_verified", -1), NOW)).toBe("payment_verified");
    expect(effectiveStatus(state("invited", PURCHASE_LINK_DAYS), NOW)).toBe("invited");
  });

  it("requires the buyer's confirmation before payment evidence, and verified payment before a workspace", () => {
    expect(canVerifyPayment(state("invited"), NOW).ok).toBe(false);
    expect(canVerifyPayment(state("started"), NOW)).toEqual({ ok: true });
    expect(canVerifyPayment(state("payment_verified"), NOW).ok).toBe(false);
    expect(canProvision(state("started"), null, NOW).ok).toBe(false);
    expect(canProvision(state("payment_verified"), null, NOW)).toEqual({ ok: true });
    expect(canProvision(state("provisioned"), "client-org", NOW)).toEqual({ ok: true });
  });

  it("tells the team the buyer has confirmed exactly when a payment may be recorded, never that a confirmed buyer has not", () => {
    // Found on the live Purchase intent page of a buyer who had confirmed: the card said "The buyer has not confirmed, or the payment has not been verified."
    for (const status of PURCHASE_STATUSES) {
      const text = noPaymentYetText(status);
      expect(text.startsWith("The buyer has confirmed."), status).toBe(canVerifyPayment(state(status), NOW).ok);
      if (status !== "invited") expect(text, status).not.toMatch(/has not confirmed/i);
    }
    expect(noPaymentYetText("invited")).toMatch(/^The buyer has not confirmed yet\./);
    expect(noPaymentYetText("started")).toMatch(/No payment has been verified yet/);
    expect(noPaymentYetText("expired")).toMatch(/expired/);
    expect(noPaymentYetText("cancelled")).toMatch(/cancelled before any payment/);
  });

  it("never provisions a payment made in a provider's sandbox on the live site, lets it be closed as the test it was, and leaves every other case as it was", () => {
    // paid in the sandbox, seen on the live site: no real money moved
    expect(canProvision(state("payment_verified"), null, NOW, null, true)).toEqual({ ok: false, reason: SANDBOX_PAYMENT_TEXT });
    expect(canCancel(state("payment_verified"), NOW, null, true).ok).toBe(true);
    // the isolated route (a developer's machine, a preview, the tests): a test payment goes all the way
    expect(canProvision(state("payment_verified"), null, NOW, null, false)).toEqual({ ok: true });
    expect(canCancel(state("payment_verified"), NOW, null, false).ok).toBe(false);
    // a workspace that already exists is never undone, and a held payment keeps its own words
    expect(canProvision(state("provisioned"), "client-org", NOW, null, true)).toEqual({ ok: true });
    expect(canProvision(state("payment_verified"), null, NOW, "disputed", true).reason).toMatch(/dispute/);
    expect(canCancel(state("provisioned"), NOW, null, true).ok).toBe(false);
    expect(canCancel(state("cancelled"), NOW, null, true).ok).toBe(false);
    expect(SANDBOX_PAYMENT_TEXT).toMatch(/no real money moved/);
  });

  it("does not tell a buyer a sandbox payment on the live site was confirmed, and promises no workspace", () => {
    const sandbox = checkoutReturnText("paid", "payment_verified", false, true);
    expect(sandbox).toMatchObject({ tone: "neutral", title: "Test payment recorded" });
    expect(sandbox.body).toMatch(/No real money moved, and no workspace will be created/);
    // anything else reads as before
    expect(checkoutReturnText("paid", "payment_verified", false, false).title).toBe("Payment confirmed");
    expect(checkoutReturnText("paid", "payment_verified").title).toBe("Payment confirmed");
    expect(checkoutReturnText("refunded", "payment_verified", false, true).title).toBe("Your payment needs a person to look at it");
    expect(checkoutReturnText("pending", "started", false, true).title).toBe("Waiting for the payment provider");
  });

  it("lets a person withdraw only an unpaid purchase, and prohibits reopening a cancelled one with a link", () => {
    expect(canCancel(state("invited"), NOW).ok).toBe(true);
    expect(canCancel(state("started"), NOW).ok).toBe(true);
    expect(canCancel(state("payment_verified"), NOW).ok).toBe(false);
    // A verified payment can be closed without a workspace only while the provider's report holds it.
    for (const hold of ["refunded", "disputed", "mismatch"] as const) expect(canCancel(state("payment_verified"), NOW, hold).ok, hold).toBe(true);
    expect(canCancel(state("provisioned"), NOW, "refunded").ok).toBe(false);
    expect(canCancel(state("cancelled"), NOW, "refunded").ok).toBe(false);
    expect(canCancel(state("provisioned"), NOW).ok).toBe(false);
    expect(canRotateLink(state("expired", -1), NOW).ok).toBe(true);
    expect(canRotateLink(state("cancelled"), NOW).ok).toBe(false);
    expect(canRotateLink(state("provisioned"), NOW).ok).toBe(false);
  });

  it("lets a person release a hold only while the purchase is open, and never when there is none", () => {
    expect(canReleaseHold(state("payment_verified"), null, NOW).ok).toBe(false);
    for (const hold of ["refunded", "disputed", "mismatch"] as const) {
      expect(canReleaseHold(state("payment_verified"), hold, NOW).ok, `verified ${hold}`).toBe(true);
      expect(canReleaseHold(state("started"), hold, NOW).ok, `started ${hold}`).toBe(true);
      expect(canReleaseHold(state("provisioned"), hold, NOW).ok, `provisioned ${hold}`).toBe(false);
      expect(canReleaseHold(state("cancelled"), hold, NOW).ok, `cancelled ${hold}`).toBe(false);
      expect(canReleaseHold(state("expired", -1), hold, NOW).ok, `expired ${hold}`).toBe(false);
    }
  });
});

describe("the words a Super Admin reads about a payment and a hold", () => {
  it("names the provider that reported it, and says 'the payment provider' when it does not know", () => {
    expect(providerNameText("paypal")).toBe("PayPal");
    expect(providerNameText("paymongo")).toBe("PayMongo");
    for (const unknown of [null, undefined, "", "stripe"]) expect(providerNameText(unknown)).toBe("the payment provider");
  });

  it("says what a refund notice named: who, how much, and whether it went through", () => {
    const refund = (over: Record<string, unknown> = {}) => ({ what: "refund", provider: "paypal", event: "PAYMENT.CAPTURE.REFUNDED", refund: { amountMinor: 149900, currency: "USD", status: "succeeded", ...over } });
    expect(paymentHeldEventText(refund())).toBe("PayPal reported a refund of USD 1,499.00: provisioning is on hold");
    // A part of the money is told as the part it was: the hold is the same, the amount is not hidden.
    expect(paymentHeldEventText(refund({ amountMinor: 10000 }))).toBe("PayPal reported a refund of USD 100.00: provisioning is on hold");
    expect(paymentHeldEventText({ ...refund({ amountMinor: 250000, currency: "PHP" }), provider: "paymongo" })).toBe("PayMongo reported a refund of PHP 2,500.00: provisioning is on hold");
    expect(paymentHeldEventText(refund({ status: "pending" }))).toBe("PayPal reported a refund of USD 1,499.00 that is still being processed: provisioning is on hold");
    expect(paymentHeldEventText(refund({ status: "failed" }))).toBe("PayPal reported a refund of USD 1,499.00 that could not be completed: provisioning is on hold");
    // A notice that carried no usable amount says no amount, never a guess.
    for (const bad of [{ amountMinor: null }, { amountMinor: 0 }, { amountMinor: -5 }, { amountMinor: 1.5 }, { amountMinor: "100" }, { currency: "XXX" }, { currency: null }]) {
      expect(paymentHeldEventText(refund(bad)), JSON.stringify(bad)).toBe("PayPal reported a refund: provisioning is on hold");
    }
  });

  it("tells a dispute as a dispute, and keeps the older, less specific entries readable", () => {
    expect(paymentHeldEventText({ what: "dispute", provider: "paypal", event: "CUSTOMER.DISPUTE.CREATED" })).toBe("PayPal reported a dispute: provisioning is on hold");
    // A dispute never shows a refund amount, even if one were stored beside it.
    expect(paymentHeldEventText({ what: "dispute", provider: "paypal", refund: { amountMinor: 100, currency: "USD", status: "succeeded" } })).toBe("PayPal reported a dispute: provisioning is on hold");
    // Written before the provider and amount were kept (the Sandbox test purchase of 2026-11-03 is one): the kind is known, the provider is not.
    expect(paymentHeldEventText({ reference: "IAQ-X", what: "refund", event: "PAYMENT.CAPTURE.REFUNDED" })).toBe("The payment provider reported a refund: provisioning is on hold");
    expect(paymentHeldEventText({})).toBe(PURCHASE_EVENT_TEXT.payment_held);
    expect(paymentHeldEventText({ what: "something else" })).toBe(PURCHASE_EVENT_TEXT.payment_held);
  });

  it("does not claim that every confirmed payment came from a signed notice", () => {
    // PayPal's answer to the server's own capture records the payment first; the signed notice that follows is a repeat.
    expect(PURCHASE_EVENT_TEXT.payment_received).toBe("Payment confirmed by the payment provider");
    expect(PURCHASE_EVENT_TEXT.payment_received).not.toMatch(/signed notice/);
  });
});
