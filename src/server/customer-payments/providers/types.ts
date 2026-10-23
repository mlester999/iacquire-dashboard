import type { CurrencyCode } from "@/lib/money";
import type { Canonical, NormalizedEvent } from "@/lib/invoices/payment-events";
import type { ConnectionMode, PaymentProviderId } from "@/lib/invoices/connection-rules";
import type { ProviderCredentials } from "@/server/customer-payments/credentials";

// The contract between the payment services and a payment provider. The services know nothing about PayMongo: they hand an adapter a connection's credentials and
// get back facts. An adapter never decides what a fact means (that is src/lib/invoices/payment-events.ts), never touches the database, and is the only code that
// speaks a provider's wire format. Every adapter here has only ever run against a replaced HTTP layer and recorded fixtures: `contractVerified` stays false until a
// run against the provider's own test account is recorded.

/** A failure talking to a provider, with a message that is safe to show: it never contains a key, a response body or a URL. */
export class ProviderCallError extends Error {
  constructor(
    /** rejected: the provider answered and refused (a bad key, a bad request). unreachable: no answer; what happened is unknown. blocked: not attempted, a switch is off. invalid_response: it answered with something unreadable. */
    readonly kind: "rejected" | "unreachable" | "blocked" | "invalid_response",
    message: string,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = "ProviderCallError";
  }
}

export interface CheckoutInput {
  /** Ours, unguessable; the provider echoes it so a payment is tied to its attempt. */
  reference: string;
  amountMinor: number;
  currency: CurrencyCode;
  /** Shown on the provider's page. Never a customer's details: the invoice number only. */
  description: string;
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutResult {
  checkoutId: string;
  /** The provider-hosted page. Always https, always on the provider's own domain. */
  checkoutUrl: string;
}

export type CredentialCheck =
  | { ok: true; accountLabel: string | null; /** Whether a webhook pointing at this connection's address was seen at the provider; null when the provider cannot say. */ webhookFound: boolean | null }
  | { ok: false; reason: "rejected" | "unreachable"; message: string };

/** The provider's own record of a checkout and the payments made through it: the authenticated read-back. */
export interface CanonicalCheckout {
  checkoutId: string;
  reference: string | null;
  status: "open" | "expired" | "paid" | "other";
  payments: Array<{ id: string; status: Canonical["status"]; amountMinor: number | null; currency: string | null; feeMinor: number | null; livemode: boolean | null }>;
}

export type SignatureCheck = { ok: true; livemode: boolean | null } | { ok: false; reason: string };

export interface ParsedWebhook {
  event: NormalizedEvent;
}

export interface HeaderReader {
  get(name: string): string | null;
}

export interface PaymentProviderAdapter {
  readonly id: PaymentProviderId;
  /** Always false in this release: nothing has run against the provider itself. */
  readonly contractVerified: false;
  /**
   * A delivery is checked by asking the provider (PayPal), with the business's own credentials, so every delivery that reaches the check costs the business two calls to the
   * provider whoever sent it. The webhook route limits those per connection before it asks (src/server/customer-payments/webhooks.ts).
   */
  readonly verifiesRemotely?: true;
  readonly supportedCurrencies: readonly CurrencyCode[];
  /** The mode a key belongs to, read from the key itself; null when it is not a key of this provider. */
  modeOf(credentials: ProviderCredentials): ConnectionMode | null;
  /** A read-only call that proves the provider accepts the key. */
  verifyCredentials(credentials: ProviderCredentials, opts: { webhookUrl: string }): Promise<CredentialCheck>;
  /** Starts a hosted checkout. The only call that creates something at the provider. */
  createCheckout(credentials: ProviderCredentials, input: CheckoutInput): Promise<CheckoutResult>;
  /** The authenticated read-back of a checkout, or null when the provider does not know it. Optional: an adapter without one leaves the signed event to stand alone. */
  fetchCheckout?(credentials: ProviderCredentials, checkoutId: string): Promise<CanonicalCheckout | null>;
  /**
   * For a provider where the customer's approval does not take the money by itself (PayPal): asks it to take the payment the customer approved, and returns its record of
   * the checkout afterwards. The answer is a fact from the provider, not a payment: money is counted only through the same receipt a webhook leaves (read-back.ts).
   */
  completeCheckout?(credentials: ProviderCredentials, checkoutId: string, opts: { reference: string }): Promise<CanonicalCheckout | null>;
  /**
   * Checks a delivery against the connection's own secret. Never throws. May be asynchronous: a provider whose signature is checked by asking the provider (PayPal) cannot
   * answer at once. `credentials` is the connection's own opened keys, for such a provider.
   */
  verifyWebhook(input: { rawBody: string; headers: HeaderReader; secret: string; now: number; credentials?: ProviderCredentials }): SignatureCheck | Promise<SignatureCheck>;
  /** Reads a delivery into facts, or null when it is not an event this adapter can read. Never throws. `connectionLive` is for a provider whose events do not say which mode they are in. */
  parseEvent(rawBody: string, ctx?: { connectionLive: boolean }): ParsedWebhook | null;
}
