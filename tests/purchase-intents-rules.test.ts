import { describe, expect, it } from "vitest";
import {
  canBuyerStart, canCancel, canProvision, canRotateLink, canVerifyPayment, effectiveStatus, formatUsdCents, priceSnapshot,
  PURCHASE_LINK_DAYS,
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

  it("lets a person withdraw only an unpaid purchase, and prohibits reopening a cancelled one with a link", () => {
    expect(canCancel(state("invited"), NOW).ok).toBe(true);
    expect(canCancel(state("started"), NOW).ok).toBe(true);
    expect(canCancel(state("payment_verified"), NOW).ok).toBe(false);
    expect(canCancel(state("provisioned"), NOW).ok).toBe(false);
    expect(canRotateLink(state("expired", -1), NOW).ok).toBe(true);
    expect(canRotateLink(state("cancelled"), NOW).ok).toBe(false);
    expect(canRotateLink(state("provisioned"), NOW).ok).toBe(false);
  });
});
