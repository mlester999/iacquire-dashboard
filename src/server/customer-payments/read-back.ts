import "server-only";
import { emptyEvent } from "@/lib/invoices/payment-events";
import { sha256 } from "@/server/security/crypto";
import { processReceipt, runEffects, storeReceipt, type ProcessDeps } from "@/server/customer-payments/events";
import type { CanonicalCheckout } from "@/server/customer-payments/providers/types";

// The provider's own record of a checkout, turned into receipts. A payment the provider says it took is not recorded here directly: it becomes a receipt (the same row a
// webhook leaves) and goes through the same checks and the same transaction as a delivery, so there is one way for money to be counted, whoever noticed it first. The
// receipt's id comes from the provider's payment id, so a webhook, a poll and a capture for the same payment are one receipt.

export interface CheckoutTarget {
  connectionId: string;
  orgId: string;
  mode: "test" | "live";
  /** Ours, as the attempt stored it. */
  reference: string;
  providerCheckoutId: string;
}

/** Returns how many payments were recorded (a payment already recorded does not count again). */
export async function recordCheckoutPayments(target: CheckoutTarget, co: CanonicalCheckout, now: Date, deps: ProcessDeps = {}): Promise<number> {
  // The provider's own record must name our reference, or it is not this checkout.
  if (co.reference !== null && co.reference !== target.reference) return 0;
  let recorded = 0;
  for (const p of co.payments) {
    if (p.status !== "paid" || p.amountMinor === null || p.currency === null) continue;
    const facts = {
      ...emptyEvent("payment.succeeded", { eventId: `poll:${p.id}`, type: "poll.checkout", livemode: target.mode === "live" }),
      checkoutId: co.checkoutId, reference: target.reference, paymentId: p.id, amountMinor: p.amountMinor, currency: p.currency, feeMinor: p.feeMinor,
    };
    const stored = await storeReceipt({ id: target.connectionId, orgId: target.orgId }, facts, sha256(`poll:${target.providerCheckoutId}:${p.id}`));
    const r = await processReceipt(stored.receiptId, { now, providerFor: deps.providerFor });
    await runEffects(r.effects);
    if (r.outcome === "processed") recorded += 1;
  }
  return recorded;
}
