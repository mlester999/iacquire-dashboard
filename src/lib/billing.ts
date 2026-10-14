// Money helpers shared by the server and the interface. Amounts are integer micro-dollars
// (1 USD = 1,000,000 micros) so fractional-cent provider costs are exact. Never use floats for balances.

export const MICROS_PER_USD = 1_000_000;

/** Approved commercial terms (see the product blueprint). Change them here and in the catalog, never in components. */
export const SETUP_FEE_USD = 1499;
export const MAINTENANCE_MONTHLY_USD = 299;
/** Internal planning reserve, not a customer charge. */
export const OPERATING_RESERVE_PER_SETUP_USD = 200;
/** Approved model: eligible provider wholesale consumption x 1.30, expressed in basis points of wholesale. */
export const APPROVED_MARKUP_BPS = 13000;
export const NO_MARKUP_BPS = 10000;

export const CREDIT_PRESETS_USD = [25, 50, 100] as const;

export const usdToMicros = (usd: number): number => Math.round(usd * MICROS_PER_USD);
export const centsToMicros = (cents: number): number => Math.round(cents) * 10_000;
export const microsToCents = (micros: number): number => Math.round(micros / 10_000);

/**
 * Client charge for eligible metered usage: wholesale x markup, rounded up to the next micro-dollar so
 * the agency never under-recovers a fraction. Fixed provider fees and taxes use NO_MARKUP_BPS.
 */
export function applyMarkup(wholesaleMicros: number, markupBps: number): number {
  if (!Number.isInteger(wholesaleMicros) || wholesaleMicros < 0) throw new RangeError("Wholesale amount must be a non-negative integer of micro-dollars.");
  if (!Number.isInteger(markupBps) || markupBps < NO_MARKUP_BPS) throw new RangeError("Markup cannot be below the wholesale cost.");
  return Number((BigInt(wholesaleMicros) * BigInt(markupBps) + 9999n) / 10000n);
}

/** The margin over wholesale, which is gross contribution and not profit. */
export const grossMarkup = (wholesaleMicros: number, markupBps: number) => applyMarkup(wholesaleMicros, markupBps) - wholesaleMicros;

/**
 * Amount to charge in a foreign currency's minor units for a USD value, rounded up so the credit granted
 * is always fully covered. `rate` is units of the charge currency per 1 USD (for example PHP per USD).
 */
export function usdToChargeMinor(usdMicros: number, rate: number): number {
  if (!(rate > 0) || !Number.isFinite(rate)) throw new RangeError("Exchange rate must be a positive number.");
  const rateMicros = BigInt(Math.round(rate * 1_000_000));
  // usd = micros / 1e6; charge units = usd * rate; minor units = charge * 100.
  const numerator = BigInt(usdMicros) * rateMicros;
  const denominator = 10_000_000_000n; // 1e6 (micros) * 1e6 (rate micros) / 100 (minor units)
  return Number((numerator + denominator - 1n) / denominator);
}

export function formatUsd(micros: number, opts: { precise?: boolean } = {}): string {
  const dollars = micros / MICROS_PER_USD;
  const small = Math.abs(dollars) < 0.01 && dollars !== 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: opts.precise || small ? 4 : 2,
  }).format(dollars);
}

export function formatMinor(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amountMinor / 100);
}

export const UNIT_LABELS: Record<string, string> = {
  ai_tokens_in: "AI input tokens",
  ai_tokens_out: "AI output tokens",
  ai_research_call: "AI research calls",
  sms_segment: "SMS segments",
  whatsapp_message: "WhatsApp messages",
  email_send: "Emails sent",
  premium_api_call: "Premium API calls",
  automation_execution: "Automation runs",
  other: "Other usage",
};

export type UnitType = keyof typeof UNIT_LABELS;
export const isUnitType = (value: unknown): value is UnitType => typeof value === "string" && value in UNIT_LABELS;
