import "server-only";
import type { Queryable } from "@/server/db";
import { paymongoStatus } from "@/server/billing/paymongo";

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

export async function checkoutAvailability(db: Queryable): Promise<CheckoutAvailability> {
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
  const status = paymongoStatus();
  const livemode = status.livemode;
  const no = (reason: string): CheckoutAvailability => ({ available: false, reason, livemode, settings });
  if (!settings.enabled) return no("Online checkout for purchases is switched off in the billing settings.");
  if (!status.configured) return no("PayMongo is not connected yet (secret key or payment methods missing).");
  if (!status.webhookConfigured) return no("The PayMongo webhook secret is not set, so a payment could not be confirmed.");
  if (!settings.usdPhpRate || !(settings.usdPhpRate > 0)) return no("No exchange rate is set, so the price cannot be converted for PayMongo.");
  if (livemode === true && !settings.liveReviewedAt) return no("Live payments are switched off until iAcquire confirms the payment and tax review.");
  return { available: true, reason: null, livemode, settings };
}
