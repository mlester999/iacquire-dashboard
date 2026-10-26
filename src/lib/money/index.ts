/**
 * Money for documents a client sends to its own customers (proposals, invoices, payment records). Amounts are integers in a currency's minor unit
 * ("cents"), never floats, so a sum always equals the lines that make it up. A currency's exponent says how many decimal digits one major unit has (USD 2,
 * JPY 0); nothing here assumes 100.
 *
 * This is NOT iAcquire's own billing (src/lib/billing.ts, which charges in PHP/USD through PayMongo). It converts nothing between currencies: an amount and its
 * currency always travel together, and mixing two currencies is an error.
 *
 * Intermediate products (quantity x price) can pass 2^53, so they are computed as BigInt and brought back to a safe integer at the end.
 */

export const CURRENCIES = {
  USD: { exponent: 2, symbol: "$", name: "US dollar" },
  PHP: { exponent: 2, symbol: "₱", name: "Philippine peso" },
  EUR: { exponent: 2, symbol: "€", name: "Euro" },
  GBP: { exponent: 2, symbol: "£", name: "Pound sterling" },
  AUD: { exponent: 2, symbol: "A$", name: "Australian dollar" },
  CAD: { exponent: 2, symbol: "C$", name: "Canadian dollar" },
  SGD: { exponent: 2, symbol: "S$", name: "Singapore dollar" },
  JPY: { exponent: 0, symbol: "¥", name: "Japanese yen" },
} as const;

export type CurrencyCode = keyof typeof CURRENCIES;
export const CURRENCY_CODES = Object.keys(CURRENCIES) as CurrencyCode[];
export const isCurrency = (v: unknown): v is CurrencyCode => typeof v === "string" && Object.prototype.hasOwnProperty.call(CURRENCIES, v);
export const exponentOf = (code: CurrencyCode) => CURRENCIES[code].exponent;

/** An amount in the currency's minor unit: a non-negative safe integer unless a function says it may be negative. */
export type Minor = number;

export class MoneyError extends Error {
  constructor(public readonly code: "invalid_amount" | "invalid_quantity" | "overflow" | "currency_mismatch" | "invalid_rate" | "invalid_discount", message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

const MAX = BigInt(Number.MAX_SAFE_INTEGER);

function safe(n: bigint): number {
  if (n > MAX || n < -MAX) throw new MoneyError("overflow", "That amount is too large.");
  return Number(n);
}

/** Divides and rounds half away from zero, in integers. The denominator must be positive. */
export function roundDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new MoneyError("invalid_rate", "Cannot divide by zero.");
  const negative = numerator < 0n;
  const n = negative ? -numerator : numerator;
  const q = (n * 2n + denominator) / (denominator * 2n);
  return negative ? -q : q;
}

const assertMinor = (n: number, what: string) => {
  if (!Number.isSafeInteger(n) || n < 0) throw new MoneyError("invalid_amount", `${what} must be a whole number of minor units, zero or more.`);
};

/** "1,234.50" with a currency -> 123450. Strict: digits with optional valid thousands commas and at most the currency's decimals; no sign, no exponent, no spaces inside. */
export function parseAmount(input: string, code: CurrencyCode): Minor {
  const exponent = exponentOf(code);
  const text = String(input).trim();
  const pattern = exponent === 0 ? /^(\d{1,3}(,\d{3})+|\d+)$/ : new RegExp(`^(\\d{1,3}(,\\d{3})+|\\d+)(\\.\\d{1,${exponent}})?$`);
  if (!pattern.test(text)) throw new MoneyError("invalid_amount", exponent === 0 ? "Enter a whole amount, such as 1500." : `Enter an amount such as 1500 or 1500.${"0".repeat(exponent)}, with at most ${exponent} decimal places.`);
  const [whole, fraction = ""] = text.replace(/,/g, "").split(".");
  return safe(BigInt(whole + fraction.padEnd(exponent, "0")));
}

/** 123450 -> "1234.50" (the plain decimal string used in payloads and provider requests; no grouping, no symbol). */
export function toDecimalString(minor: Minor, code: CurrencyCode): string {
  if (!Number.isSafeInteger(minor)) throw new MoneyError("invalid_amount", "That amount is not a whole number of minor units.");
  const exponent = exponentOf(code);
  const negative = minor < 0;
  const digits = String(Math.abs(minor)).padStart(exponent + 1, "0");
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = digits.slice(digits.length - exponent);
  return `${negative ? "-" : ""}${whole}${exponent ? `.${fraction}` : ""}`;
}

/** 123450 USD -> "$1,234.50" (style "symbol") or "USD 1,234.50" (style "code", safe for a PDF set in a standard font). */
export function formatMinor(minor: Minor, code: CurrencyCode, style: "symbol" | "code" = "code"): string {
  const plain = toDecimalString(Math.abs(minor), code);
  const [whole, fraction] = plain.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const body = fraction ? `${grouped}.${fraction}` : grouped;
  const sign = minor < 0 ? "-" : "";
  return style === "symbol" ? `${sign}${CURRENCIES[code].symbol}${body}` : `${code} ${sign}${body}`;
}

/** "2.5" -> 2500. A quantity has at most three decimals (thousandths) and is between 0.001 and 999999. */
export function parseQuantity(input: string | number): number {
  const text = String(input).trim();
  if (!/^\d{1,6}(\.\d{1,3})?$/.test(text)) throw new MoneyError("invalid_quantity", "Enter a quantity such as 1, 2.5 or 0.25 (up to three decimals).");
  const [whole, fraction = ""] = text.split(".");
  const milli = Number(whole) * 1000 + Number(fraction.padEnd(3, "0"));
  if (milli < 1) throw new MoneyError("invalid_quantity", "The quantity must be more than zero.");
  return milli;
}
export const formatQuantity = (milli: number) => {
  const whole = Math.floor(milli / 1000);
  const frac = String(milli % 1000).padStart(3, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
};

export type Discount = { kind: "percent"; bps: number } | { kind: "fixed"; minor: Minor } | null;

export interface LineInput {
  /** Thousandths of a unit: 1000 is one, 2500 is two and a half. */
  quantityMilli: number;
  unitPriceMinor: Minor;
  discount?: Discount;
  /** Tax rate in basis points (1200 = 12%); null or 0 for none. */
  taxBps?: number | null;
}

export interface LineAmounts {
  /** quantity x unit price, rounded to a minor unit. */
  gross: Minor;
  discount: Minor;
  /** After the discount, before tax for an exclusive line; the tax-inclusive figure for an inclusive line. */
  net: Minor;
  tax: Minor;
  /** What the customer pays for this line. */
  total: Minor;
  /** The line's amount without tax (net for an exclusive line, net - tax for an inclusive one). */
  exTax: Minor;
}

const validBps = (bps: number, what: string, max = 10_000) => {
  if (!Number.isInteger(bps) || bps < 0 || bps > max) throw new MoneyError("invalid_rate", `${what} must be between 0% and ${max / 100}%.`);
};

/**
 * One line's amounts. Rounding happens per line (half away from zero) and totals are the sum of the rounded line figures, so what a person adds up from the lines
 * is exactly the total. An exclusive-tax line adds tax on the net; an inclusive line already contains it.
 */
export function lineAmounts(line: LineInput, taxInclusive = false): LineAmounts {
  if (!Number.isSafeInteger(line.quantityMilli) || line.quantityMilli < 1) throw new MoneyError("invalid_quantity", "The quantity must be more than zero.");
  assertMinor(line.unitPriceMinor, "The unit price");
  const gross = roundDiv(BigInt(line.quantityMilli) * BigInt(line.unitPriceMinor), 1000n);
  let discount = 0n;
  const d = line.discount ?? null;
  if (d?.kind === "percent") {
    validBps(d.bps, "A percentage discount", 10_000);
    discount = roundDiv(gross * BigInt(d.bps), 10_000n);
  } else if (d?.kind === "fixed") {
    assertMinor(d.minor, "A fixed discount");
    if (BigInt(d.minor) > gross) throw new MoneyError("invalid_discount", "A discount cannot be more than the line's amount.");
    discount = BigInt(d.minor);
  }
  const net = gross - discount;
  const rate = line.taxBps ?? 0;
  validBps(rate, "A tax rate");
  const bps = BigInt(rate);
  const tax = taxInclusive ? roundDiv(net * bps, 10_000n + bps) : roundDiv(net * bps, 10_000n);
  const total = taxInclusive ? net : net + tax;
  const exTax = taxInclusive ? net - tax : net;
  return { gross: safe(gross), discount: safe(discount), net: safe(net), tax: safe(tax), total: safe(total), exTax: safe(exTax) };
}

export interface Totals {
  /** Sum of the lines before discounts. */
  gross: Minor;
  discount: Minor;
  /** Sum of the lines' amounts without tax. */
  subtotal: Minor;
  tax: Minor;
  total: Minor;
}

export const ZERO_TOTALS: Totals = { gross: 0, discount: 0, subtotal: 0, tax: 0, total: 0 };

/** The totals of already-computed lines: plain sums, nothing re-rounded. */
export function sumLines(lines: LineAmounts[]): Totals {
  let gross = 0n, discount = 0n, subtotal = 0n, tax = 0n, total = 0n;
  for (const l of lines) {
    gross += BigInt(l.gross);
    discount += BigInt(l.discount);
    subtotal += BigInt(l.exTax);
    tax += BigInt(l.tax);
    total += BigInt(l.total);
  }
  return { gross: safe(gross), discount: safe(discount), subtotal: safe(subtotal), tax: safe(tax), total: safe(total) };
}

export function computeTotals(lines: LineInput[], taxInclusive = false): { lines: LineAmounts[]; totals: Totals } {
  const computed = lines.map((l) => lineAmounts(l, taxInclusive));
  return { lines: computed, totals: sumLines(computed) };
}

/** The part of a payment that is the invoice's tax, in proportion: payment x invoice tax / invoice total, rounded. Used to leave tax out of revenue. */
export function taxPortion(paymentMinor: Minor, invoiceTaxMinor: Minor, invoiceTotalMinor: Minor): Minor {
  assertMinor(paymentMinor, "A payment");
  assertMinor(invoiceTaxMinor, "Tax");
  if (invoiceTotalMinor <= 0) return 0;
  return safe(roundDiv(BigInt(paymentMinor) * BigInt(invoiceTaxMinor), BigInt(invoiceTotalMinor)));
}

/** Throws unless every amount names the same currency. */
export function sameCurrency(codes: Array<CurrencyCode | string>): CurrencyCode {
  const first = codes[0];
  if (!isCurrency(first) || codes.some((c) => c !== first)) throw new MoneyError("currency_mismatch", "Amounts in different currencies cannot be added together.");
  return first;
}
