import "server-only";
import type { Queryable } from "@/server/db";
import { paymongoStatus } from "@/server/billing/paymongo";
import { paypalStatus } from "@/server/billing/providers/paypal";

export type CheckoutProvider = "paymongo" | "paypal";
export const CHECKOUT_PROVIDERS: readonly CheckoutProvider[] = ["paymongo", "paypal"];
export const PROVIDER_LABEL: Record<CheckoutProvider, string> = { paymongo: "PayMongo", paypal: "PayPal" };

/**
 * Whether a buyer can be sent to an online checkout right now, and what an attempt would be charged. Every condition is one the Super Admin or the deployment controls, so the
 * public page never offers a button that would only fail, and nothing is ever charged by accident:
 *
 *   * the agency's own switch (agency_billing_settings.purchase_checkout_enabled), off until a Super Admin turns it on;
 *   * PayMongo's secret key, its webhook secret and at least one payment method are set (a payment could not be confirmed without the webhook);
 *   * an exchange rate exists (PayMongo charges Philippine pesos; the US$ price is converted at the agency's published rate and the rate is stored with the checkout);
 *   * for a live key, the agency confirmed its payment and tax review (the same gate every other live checkout has).
 *
 * This file imports nothing from the purchase service, so the service can use it without a cycle.
 */

export interface CheckoutSettings {
  enabled: boolean;
  usdPhpRate: number | null;
  fxSource: string | null;
  fxUpdatedAt: Date | null;
  liveReviewedAt: Date | null;
}

export interface CheckoutAvailability {
  available: boolean;
  /** Why not, for the Super Admin. The buyer is only ever told "not open yet". */
  reason: string | null;
  livemode: boolean | null;
  settings: CheckoutSettings;
}

/**
 * Whether the payment provider can take and CONFIRM a payment right now (keys, webhook secret, an exchange rate for PayMongo, and the live review for a live key), independent of any
 * one product's switch. The maintenance plan's online payment uses this directly; a purchase checkout adds its own switch on top (checkoutAvailability). PayMongo is the default;
 * PayPal charges the US-dollar price as it is, so it needs no exchange rate.
 */
export async function providerReadiness(db: Queryable, provider: CheckoutProvider = "paymongo"): Promise<CheckoutAvailability> {
  const row = (await db.query<{ purchase_checkout_enabled: boolean; usd_php_rate: string | null; fx_source: string | null; fx_updated_at: Date | null; live_payments_review_at: Date | null }>(
    "select purchase_checkout_enabled, usd_php_rate, fx_source, fx_updated_at, live_payments_review_at from agency_billing_settings limit 1",
  )).rows[0];
  const settings: CheckoutSettings = {
    enabled: row?.purchase_checkout_enabled === true,
    usdPhpRate: row?.usd_php_rate ? Number(row.usd_php_rate) : null,
    fxSource: row?.fx_source ?? null,
    fxUpdatedAt: row?.fx_updated_at ?? null,
    liveReviewedAt: row?.live_payments_review_at ?? null,
  };
  if (provider === "paypal") {
    const paypal = paypalStatus();
    const livePaypal = paypal.livemode;
    const noPaypal = (reason: string): CheckoutAvailability => ({ available: false, reason, livemode: livePaypal, settings });
    if (!paypal.configured) return noPaypal("PayPal is not connected yet (client ID or secret missing).");
    if (!paypal.webhookConfigured) return noPaypal("The PayPal webhook id is not set, so a payment could not be confirmed.");
    if (livePaypal === true && !settings.liveReviewedAt) return noPaypal("Live payments are switched off until iAcquire confirms the payment and tax review.");
    return { available: true, reason: null, livemode: livePaypal, settings };
  }
  const status = paymongoStatus();
  const livemode = status.livemode;
  const no = (reason: string): CheckoutAvailability => ({ available: false, reason, livemode, settings });
  if (!status.configured) return no("PayMongo is not connected yet (secret key or payment methods missing).");
  if (!status.webhookConfigured) return no("The PayMongo webhook secret is not set, so a payment could not be confirmed.");
  if (!settings.usdPhpRate || !(settings.usdPhpRate > 0)) return no("No exchange rate is set, so the price cannot be converted for PayMongo.");
  if (livemode === true && !settings.liveReviewedAt) return no("Live payments are switched off until iAcquire confirms the payment and tax review.");
  return { available: true, reason: null, livemode, settings };
}

/** A buyer may be sent to a purchase checkout only when the Super Admin switched purchase checkouts on AND the provider is ready. */
export async function checkoutAvailability(db: Queryable, provider: CheckoutProvider = "paymongo"): Promise<CheckoutAvailability> {
  const readiness = await providerReadiness(db, provider);
  if (!readiness.settings.enabled) return { ...readiness, available: false, reason: "Online checkout for purchases is switched off in the billing settings." };
  return readiness;
}

/** Every provider a buyer could pay with right now (the switch is on and that provider is ready), in the order they are offered. */
export async function availableCheckoutProviders(db: Queryable): Promise<Array<{ provider: CheckoutProvider; label: string; availability: CheckoutAvailability }>> {
  const out: Array<{ provider: CheckoutProvider; label: string; availability: CheckoutAvailability }> = [];
  for (const provider of CHECKOUT_PROVIDERS) {
    const availability = await checkoutAvailability(db, provider);
    if (availability.available) out.push({ provider, label: PROVIDER_LABEL[provider], availability });
  }
  return out;
}
