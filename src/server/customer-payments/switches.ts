import "server-only";
import { env } from "@/server/env";
import type { Switches } from "@/lib/invoices/connection-rules";

// The environment's say over customer payments. Both switches are off by default and a founder-approved decision to turn on; the simulated provider is never
// available in production, whatever else is set.

/** False in production: the simulated provider does not exist there. */
export const simulatedAllowed = (): boolean => env().NODE_ENV !== "production";

export function paymentSwitches(): Switches {
  const e = env();
  return { writesEnabled: e.CUSTOMER_PAYMENTS_WRITES_ENABLED, liveEnabled: e.CUSTOMER_PAYMENTS_LIVE_ENABLED, simulatedAllowed: simulatedAllowed() };
}
