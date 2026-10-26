import "server-only";
import { env } from "@/server/env";
import type { PaymentProviderId } from "@/lib/invoices/connection-rules";

// The addresses this product gives a payment provider.

const origin = () => env().APP_URL.replace(/\/+$/, "");

/** Where a provider delivers webhooks for one connection. Not a secret: a delivery is trusted by its signature, checked against this connection's own secret. */
export const webhookUrlFor = (provider: PaymentProviderId, publicKey: string) => `${origin()}/api/webhooks/customer-payments/${provider}/${publicKey}`;

/**
 * Where the provider sends a customer after a checkout. It carries our reference, never the invoice's link: the link is a bearer credential and does not belong in a
 * provider's dashboard or logs. The page it names shows "we are confirming your payment" until the database says paid, whatever the address said.
 */
export const returnUrlsFor = (reference: string) => ({
  successUrl: `${origin()}/pay/return/${reference}`,
  cancelUrl: `${origin()}/pay/return/${reference}?result=cancelled`,
});
