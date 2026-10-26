// When the refund a payment provider reported and a refund a person recorded by hand are the same money. Pure, so the refund dialog warns with the rule the server enforces.
//
// The owner refunds in the provider's dashboard and then records it here, and the provider reports the same refund by itself: left alone, one refund would be counted twice.
// The two are taken to be the same when they are for the same payment, for exactly the same amount, and came in within this many days of each other.

export const REFUND_MATCH_DAYS = 14;

export interface RefundFacts {
  paymentId: string;
  amountMinor: number;
  source: string;
  status: string;
  createdAt: string;
}

/** The refund the provider reported for this payment and exactly this amount, recently, if there is one: the one a refund recorded by hand for that amount would count twice. */
export function providerRefundTwin<T extends RefundFacts>(refunds: readonly T[], paymentId: string, amountMinor: number, now: Date): T | null {
  const since = now.getTime() - REFUND_MATCH_DAYS * 86_400_000;
  return refunds.find((r) => r.paymentId === paymentId && r.source === "provider_event" && r.status === "succeeded" && r.amountMinor === amountMinor && new Date(r.createdAt).getTime() >= since) ?? null;
}
