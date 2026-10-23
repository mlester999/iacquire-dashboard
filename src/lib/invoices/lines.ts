import { MoneyError, formatQuantity, lineAmounts, parseAmount, parseQuantity, sumLines, type CurrencyCode, type LineAmounts, type Totals } from "@/lib/money";
import { InvoiceInputError } from "@/lib/invoices/errors";
import { freeTextProblem } from "@/lib/invoices/guards";

// From what a person typed in the invoice form to the lines the database stores. Every amount goes through src/lib/money: integers in the currency's minor unit,
// each line rounded once, the totals the sums of the rounded lines. No floating point touches an amount. Pure.

export const MAX_LINES = 100;
export const MAX_DESCRIPTION = 300;

/** A line as the form holds it: all text, as typed. */
export interface LineFormInput {
  description: string;
  quantity: string;
  unitPrice: string;
  /** A percentage ("10", "7.5") or an amount ("25.00"), not both. */
  discountPercent?: string | null;
  discountAmount?: string | null;
  /** The tax rate for this line as a percentage ("12", "7.25"); empty means no tax on the line. */
  taxPercent?: string | null;
}

export interface ParsedLine {
  position: number;
  description: string;
  quantityMilli: number;
  unitPriceMinor: number;
  discountBps: number | null;
  taxRateBps: number | null;
  amounts: LineAmounts;
}

const blank = (v: string | null | undefined) => v == null || v.trim() === "";

/** "12" -> 1200, "7.25" -> 725, "0.5" -> 50. At most two decimals, between 0 and 100 percent. */
export function parsePercentToBps(input: string, what: string): number {
  const text = input.trim().replace(/%$/, "").trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text)) throw new InvoiceInputError(`${what} must be a percentage such as 12 or 7.25 (at most two decimals).`);
  const [whole, fraction = ""] = text.split(".");
  const bps = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (bps > 10_000) throw new InvoiceInputError(`${what} cannot be more than 100%.`);
  return bps;
}

export const formatBps = (bps: number): string => {
  const whole = Math.floor(bps / 100);
  const frac = String(bps % 100).padStart(2, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
};

export function cleanDescription(raw: string, index: number): string {
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  const where = `Line ${index + 1}`;
  if (!text) throw new InvoiceInputError(`${where} needs a description.`, `lines.${index}.description`);
  if (text.length > MAX_DESCRIPTION) throw new InvoiceInputError(`${where}: the description can't be longer than ${MAX_DESCRIPTION} characters.`, `lines.${index}.description`);
  const problem = freeTextProblem(`${where}'s description`, text);
  if (problem) throw new InvoiceInputError(problem, `lines.${index}.description`);
  return text;
}

/** One typed line to its stored form. `index` is only for the message. */
export function parseLine(input: LineFormInput, index: number, currency: CurrencyCode, taxInclusive: boolean): ParsedLine {
  const where = `Line ${index + 1}`;
  const wrap = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof MoneyError || e instanceof InvoiceInputError) throw new InvoiceInputError(`${where}: ${e.message}`, `lines.${index}`);
      throw e;
    }
  };
  const description = cleanDescription(input.description, index);
  const quantityMilli = wrap(() => parseQuantity(input.quantity));
  const unitPriceMinor = wrap(() => parseAmount(input.unitPrice, currency));
  if (!blank(input.discountPercent) && !blank(input.discountAmount)) throw new InvoiceInputError(`${where}: give a discount as a percentage or as an amount, not both.`, `lines.${index}.discount`);
  const discountBps = blank(input.discountPercent) ? null : wrap(() => parsePercentToBps(input.discountPercent as string, "The discount"));
  const discountMinor = blank(input.discountAmount) ? null : wrap(() => parseAmount(input.discountAmount as string, currency));
  const taxRateBps = blank(input.taxPercent) ? null : wrap(() => parsePercentToBps(input.taxPercent as string, "The tax rate"));
  const discount = discountBps !== null ? ({ kind: "percent", bps: discountBps } as const) : discountMinor !== null ? ({ kind: "fixed", minor: discountMinor } as const) : null;
  const amounts = wrap(() => lineAmounts({ quantityMilli, unitPriceMinor, discount, taxBps: taxRateBps }, taxInclusive));
  return { position: index + 1, description, quantityMilli, unitPriceMinor, discountBps, taxRateBps, amounts };
}

export function parseLines(inputs: readonly LineFormInput[], currency: CurrencyCode, taxInclusive: boolean): { lines: ParsedLine[]; totals: Totals } {
  if (inputs.length > MAX_LINES) throw new InvoiceInputError(`An invoice can have at most ${MAX_LINES} lines.`, "lines");
  const lines = inputs.map((l, i) => parseLine(l, i, currency, taxInclusive));
  try {
    return { lines, totals: sumLines(lines.map((l) => l.amounts)) };
  } catch (e) {
    if (e instanceof MoneyError) throw new InvoiceInputError(e.message, "lines");
    throw e;
  }
}

/** A stored line back to what the form shows, so editing a draft round-trips exactly. */
export function lineToForm(l: { description: string; quantityMilli: number; unitPriceMinor: number; discountBps: number | null; discountMinor: number; taxRateBps: number | null }, currency: CurrencyCode, toText: (minor: number, code: CurrencyCode) => string): LineFormInput {
  return {
    description: l.description,
    quantity: formatQuantity(l.quantityMilli),
    unitPrice: toText(l.unitPriceMinor, currency),
    discountPercent: l.discountBps !== null ? formatBps(l.discountBps) : null,
    discountAmount: l.discountBps === null && l.discountMinor > 0 ? toText(l.discountMinor, currency) : null,
    taxPercent: l.taxRateBps !== null ? formatBps(l.taxRateBps) : null,
  };
}
