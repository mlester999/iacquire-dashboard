/**
 * What every payment provider adapter gives the shared webhook handler: a way to check that a delivery is genuine, and one normalised shape for the event inside it.
 * The handler never reads a provider's own payload, so a second provider (PayPal, not built) is one more adapter and changes no matching rule: the organisation always
 * comes from OUR stored payment row, the reference, amount, currency and mode must all match, and the event id ledger makes retries harmless.
 */
export type PaymentProviderId = "paymongo" | "paypal";

export interface NormalizedPaidPayment {
  /** The provider's id for this payment. */
  id: string;
  /** Null when the provider's payload carried no usable number: such an event can never clear a payment. */
  amountMinor: number | null;
  currency: string | null;
  feeMinor: number | null;
}

export interface NormalizedPaymentEvent {
  provider: PaymentProviderId;
  /** The provider's event id, or a stable fallback derived from the resource; the key of the event ledger. */
  id: string;
  /** The provider's own event name, kept for the ledger and the alarms. */
  type: string;
  /** A refund or dispute is reported, never applied: it is recorded, a person is told, and nothing is revoked (see applyReported in payments.ts). */
  kind: "payment_paid" | "payment_failed" | "payment_refunded" | "payment_disputed" | "other";
  livemode: boolean;
  /** The provider's checkout or order id that OUR stored payment row names. */
  checkoutId: string | null;
  /** The reference we sent, as the provider echoes it back. */
  reference: string | null;
  /** The payments the provider reports as paid inside this event. */
  paidPayments: NormalizedPaidPayment[];
  /** Free text that may carry our reference (a failed-payment event names no checkout). */
  description: string | null;
  /** Refund and dispute events: the provider's id of the payment concerned, as it was reported when that payment was paid. Absent or null when the payload names none. */
  providerPaymentId?: string | null;
  /** Refund events: what the provider reported. Any part may be null when the payload did not carry it. */
  refund?: { id: string | null; amountMinor: number | null; currency: string | null; status: string | null } | null;
}

export type VerifyResult = { ok: true; livemode: boolean } | { ok: false; reason: string };

export interface PaymentProviderAdapter {
  readonly id: PaymentProviderId;
  /** Why deliveries cannot be verified yet (a missing secret), or null when they can. */
  notReady(): string | null;
  /** The mode (live or test) this environment's keys are for; null until a key is set. */
  expectedLivemode(): boolean | null;
  /** Checks the delivery against the raw body and the provider's headers (names in lower case). Never reads the payload's contents. */
  verify(input: { rawBody: string; headers: Record<string, string | null | undefined>; now?: number }): Promise<VerifyResult> | VerifyResult;
  /** Normalises the payload, or null when it is not a recognisable event. */
  parse(rawBody: string): NormalizedPaymentEvent | null;
}
