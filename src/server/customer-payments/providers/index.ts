import "server-only";
import { AppError } from "@/server/errors";
import { PROVIDER_LABELS, type PaymentProviderId } from "@/lib/invoices/connection-rules";
import { simulatedAllowed } from "@/server/customer-payments/switches";
import { paymongoProvider } from "@/server/customer-payments/providers/paymongo";
import { paypalProvider } from "@/server/customer-payments/providers/paypal";
import { simulatedProvider } from "@/server/customer-payments/providers/simulated";
import type { PaymentProviderAdapter } from "@/server/customer-payments/providers/types";

// Which adapter speaks for a provider. The simulated one does not exist in production. PayMongo and PayPal are built and unverified: neither has run against its provider.

export type ProviderResolver = (id: PaymentProviderId) => PaymentProviderAdapter;

const overrides: Partial<Record<PaymentProviderId, PaymentProviderAdapter>> = {};

/** Tests only: speaks for a provider with an adapter whose network layer is a recorded fixture. Pass null to put the real one back. Refuses to run anywhere but a test. */
export function setAdapterForTests(id: PaymentProviderId, adapter: PaymentProviderAdapter | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("setAdapterForTests is for tests only.");
  if (adapter) overrides[id] = adapter;
  else delete overrides[id];
}

export const providerFor: ProviderResolver = (id) => {
  if (id === "simulated") {
    if (!simulatedAllowed()) throw new AppError("forbidden", "The simulated payment provider is not available in production.");
    return overrides.simulated ?? simulatedProvider;
  }
  if (id === "paymongo") return overrides.paymongo ?? paymongoProvider;
  if (id === "paypal") return overrides.paypal ?? paypalProvider;
  throw new AppError("unavailable", `${PROVIDER_LABELS[id]} is not available in this release.`);
};
