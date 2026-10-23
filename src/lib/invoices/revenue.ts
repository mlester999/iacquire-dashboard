import { exponentOf, isCurrency } from "@/lib/money";

// What counts as VERIFIED REVENUE in the Lead Sources report, as pure rules. src/server/invoices/revenue.ts reads the rows and applies the same rules in SQL; the tests keep
// the two in step.
//
// A payment is verified revenue when, and only when, the payment provider said so about real money:
//   * the provider confirmed it (a verified event, or an authenticated read of the provider's own record), not a person's word;
//   * it was LIVE money: a provider's test mode moves none, and the simulated provider never does;
//   * it was received (succeeded, or partly or fully refunded since), and not held out by a dispute that is still open;
//   * it was received on or before the moment the report is made ("as of").
// Revenue is what was KEPT and EARNED: the payment less the tax in it (the owner's tax is not revenue), less what was refunded (and the tax in the refund). Currencies are never
// added together and nothing is converted. A payment somebody recorded by hand is that person's word: it is shown on its own line and counted as verified only if the owner
// chose to count it, which the report says.

export const REVENUE_PROVIDERS = ["paymongo", "paypal"] as const;
export const COUNTED_PAYMENT_STATUSES = ["succeeded", "partially_refunded", "refunded"] as const;

export type PaymentStatus = "succeeded" | "pending" | "failed" | "needs_review" | "partially_refunded" | "refunded" | "disputed";

export interface PaymentFacts {
  provider: "paymongo" | "paypal" | "simulated" | "manual";
  verification: "provider_confirmed" | "manual";
  livemode: boolean;
  status: PaymentStatus;
  receivedAt: Date;
}

/**
 * verified:  a live payment the provider confirmed, received.
 * by_hand:   a payment a person recorded, received.
 * test:      a provider-confirmed payment that moved no real money (a provider's test mode, or the simulated provider).
 * held:      a payment under an open dispute: held out until it is settled.
 * not_money: pending, failed, kept for review, or not received yet as of the report.
 */
export type RevenueClass = "verified" | "by_hand" | "test" | "held" | "not_money";

export function classifyPayment(p: PaymentFacts, asOf: Date): RevenueClass {
  if (p.receivedAt.getTime() > asOf.getTime()) return "not_money";
  if (p.status === "disputed") return "held";
  if (!(COUNTED_PAYMENT_STATUSES as readonly string[]).includes(p.status)) return "not_money";
  if (p.verification === "manual") return "by_hand";
  if (p.livemode && (REVENUE_PROVIDERS as readonly string[]).includes(p.provider)) return "verified";
  return "test";
}

export interface PaymentAmounts {
  amountMinor: number;
  /** The invoice's tax in this payment, worked out once when it was recorded. */
  taxPortionMinor: number;
  refunds: Array<{ amountMinor: number; taxPortionMinor: number }>;
}

export interface PaymentRevenue {
  /** The payment less its tax. */
  paidExTaxMinor: number;
  /** What was refunded of it, less the tax in the refunds. Never more than the payment less its tax. */
  refundedExTaxMinor: number;
  /** What was kept: paidExTax less refundedExTax. Never negative. */
  netMinor: number;
}

/**
 * The revenue of one payment. Each refund carries a rounded share of the payment's tax, so several small refunds can add up to a little more tax than the payment held:
 * the tax taken off in refunds is capped at the tax the payment held, and what was refunded can never exceed what was kept, so a fully refunded payment is exactly zero.
 */
export function paymentRevenue(p: PaymentAmounts): PaymentRevenue {
  const paidExTax = BigInt(p.amountMinor) - BigInt(p.taxPortionMinor);
  const refunded = p.refunds.reduce((t, r) => t + BigInt(r.amountMinor), 0n);
  const refundTax = p.refunds.reduce((t, r) => t + BigInt(r.taxPortionMinor), 0n);
  const heldTax = BigInt(p.taxPortionMinor);
  const rawRefundedExTax = refunded - (refundTax < heldTax ? refundTax : heldTax);
  const refundedExTax = rawRefundedExTax < paidExTax ? rawRefundedExTax : paidExTax;
  const net = paidExTax - refundedExTax;
  return { paidExTaxMinor: Number(paidExTax), refundedExTaxMinor: Number(refundedExTax), netMinor: Number(net) };
}

export interface MoneyLine {
  currency: string;
  /** In major units, for display, made from the exact digits in `minor`. */
  amount: number;
  /** The exact amount in the currency's minor unit, as text. Every sum is made from this, never from `amount`. */
  minor: string;
}

/** "123450" (minor units) in a currency -> 1234.5. Exact: the decimal text is built from the integer, never by dividing. Null for a currency this product does not invoice in. */
export function minorTextToMoney(minorText: string, currency: string): MoneyLine | null {
  if (!isCurrency(currency) || !/^-?\d+$/.test(minorText)) return null;
  const exponent = exponentOf(currency);
  const n = BigInt(minorText);
  const negative = n < 0n;
  const digits = (negative ? -n : n).toString().padStart(exponent + 1, "0");
  const whole = exponent ? digits.slice(0, -exponent) : digits;
  const fraction = exponent ? digits.slice(-exponent) : "";
  return { currency, amount: Number(`${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`), minor: n.toString() };
}

export interface RevenueRow {
  currency: string;
  verification: "provider_confirmed" | "manual";
  /** Sums of minor units, as text (a database bigint). */
  paidExTax: string;
  refundedExTax: string;
}

/** What a source, or the part of the report that is not tied to a source, shows. */
export interface RevenueFigures {
  /** Net of refunds, excluding tax. Provider-confirmed live payments, plus payments recorded by hand when the owner counts them. */
  verifiedRevenue: MoneyLine[];
  /** What was refunded (excluding tax) and is already taken off verifiedRevenue. */
  refunded: MoneyLine[];
  /** Payments a person recorded, net of refunds, excluding tax. Counted in verifiedRevenue only when the owner chose to. */
  recordedByHand: MoneyLine[];
}

export const emptyFigures = (): RevenueFigures => ({ verifiedRevenue: [], refunded: [], recordedByHand: [] });

/** Adds up per-currency sums into the figures a report shows. Pure, in BigInt: nothing is rounded and no currency meets another. */
export function figuresFromRows(rows: RevenueRow[], manualCounted: boolean): RevenueFigures {
  const verified = new Map<string, bigint>();
  const refunded = new Map<string, bigint>();
  const byHand = new Map<string, bigint>();
  const add = (m: Map<string, bigint>, currency: string, by: bigint) => m.set(currency, (m.get(currency) ?? 0n) + by);
  for (const r of rows) {
    if (!isCurrency(r.currency)) continue;
    const paid = BigInt(r.paidExTax);
    const back = BigInt(r.refundedExTax);
    if (r.verification === "manual") {
      add(byHand, r.currency, paid - back);
      if (manualCounted) {
        add(verified, r.currency, paid - back);
        add(refunded, r.currency, back);
      }
    } else {
      add(verified, r.currency, paid - back);
      add(refunded, r.currency, back);
    }
  }
  return { verifiedRevenue: lines(verified), refunded: lines(refunded).filter((l) => l.amount !== 0), recordedByHand: lines(byHand) };
}

function lines(m: Map<string, bigint>): MoneyLine[] {
  return [...m.entries()]
    .map(([currency, minor]) => minorTextToMoney(minor.toString(), currency))
    .filter((l): l is MoneyLine => l !== null)
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

/** Adds the figures of several parts together, per currency, in BigInt-exact decimal text. */
export function sumMoney(parts: MoneyLine[][]): MoneyLine[] {
  const sums = new Map<string, bigint>();
  for (const part of parts) {
    for (const l of part) {
      if (!isCurrency(l.currency)) continue;
      sums.set(l.currency, (sums.get(l.currency) ?? 0n) + BigInt(l.minor));
    }
  }
  return lines(sums);
}
