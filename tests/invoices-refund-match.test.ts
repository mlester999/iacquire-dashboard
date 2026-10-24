// When a refund the provider reported and a refund recorded by hand are the same money: the rule the refund dialog shows and the server enforces. Pure.
import { describe, expect, it } from "vitest";
import { providerRefundTwin, REFUND_MATCH_DAYS } from "@/lib/invoices/refund-match";

const NOW = new Date("2026-10-24T12:00:00Z");
const at = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();
const refund = (over: Partial<Parameters<typeof providerRefundTwin>[0][number]> = {}) => ({ paymentId: "pay_1", amountMinor: 40000, source: "provider_event", status: "succeeded", createdAt: at(1), ...over });

describe("a refund the provider already reported", () => {
  it("is found for the same payment and exactly the same amount, within a fortnight", () => {
    const theirs = refund();
    expect(providerRefundTwin([theirs], "pay_1", 40000, NOW)).toBe(theirs);
    expect(REFUND_MATCH_DAYS).toBe(14);
    expect(providerRefundTwin([refund({ createdAt: at(13) })], "pay_1", 40000, NOW)).not.toBeNull();
    expect(providerRefundTwin([refund({ createdAt: at(15) })], "pay_1", 40000, NOW)).toBeNull();
  });

  it("is not another payment's, another amount's, one recorded by hand, a chargeback, or one that did not succeed", () => {
    expect(providerRefundTwin([refund({ paymentId: "pay_2" })], "pay_1", 40000, NOW)).toBeNull();
    expect(providerRefundTwin([refund({ amountMinor: 40001 })], "pay_1", 40000, NOW)).toBeNull();
    for (const source of ["manual_record", "chargeback", "api_initiated"]) expect(providerRefundTwin([refund({ source })], "pay_1", 40000, NOW), source).toBeNull();
    for (const status of ["pending", "failed"]) expect(providerRefundTwin([refund({ status })], "pay_1", 40000, NOW), status).toBeNull();
    expect(providerRefundTwin([], "pay_1", 40000, NOW)).toBeNull();
  });
});
