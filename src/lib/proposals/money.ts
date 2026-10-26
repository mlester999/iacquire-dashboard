// A proposal's figures. Everything is src/lib/money underneath (integer minor units, per-line rounding, totals are plain sums of the rounded lines), so what a person adds up
// from the lines on the page is exactly the total. One-time, monthly and yearly amounts are totalled apart: "USD 1,500 once plus USD 99 a month" is never "USD 1,599".
import { lineAmounts, sumLines, ZERO_TOTALS, type LineAmounts, type Totals } from "@/lib/money";
import { BILLINGS, type Billing, type DocLine } from "@/lib/proposals/doc";

export type GroupTotals = Record<Billing, Totals>;

export const zeroGroups = (): GroupTotals => ({ one_time: { ...ZERO_TOTALS }, monthly: { ...ZERO_TOTALS }, yearly: { ...ZERO_TOTALS } });

/** One line's amounts. Throws a MoneyError when the figures cannot be right (a fixed discount above the line, an amount too large to add up). */
export function lineFigures(line: Pick<DocLine, "quantityMilli" | "unitPriceMinor" | "discount" | "taxBps">): LineAmounts {
  return lineAmounts({ quantityMilli: line.quantityMilli, unitPriceMinor: line.unitPriceMinor, discount: line.discount, taxBps: line.taxBps });
}

export function computeDocTotals(lines: readonly DocLine[]): { lines: LineAmounts[]; groups: GroupTotals } {
  const figures = lines.map(lineFigures);
  const groups = zeroGroups();
  for (const billing of BILLINGS) groups[billing] = sumLines(figures.filter((_, i) => lines[i].billing === billing));
  return { lines: figures, groups };
}

/** What the customer pays in each group, tax included: the three numbers kept on the proposal. */
export const groupGrandTotals = (g: GroupTotals): Record<Billing, number> => ({ one_time: g.one_time.total, monthly: g.monthly.total, yearly: g.yearly.total });

/** The billing groups that actually hold something, in a fixed order. */
export const usedGroups = (lines: readonly Pick<DocLine, "billing">[]): Billing[] => BILLINGS.filter((b) => lines.some((l) => l.billing === b));

/** A discount of any kind, or a unit price below the price book's: both are the same thing to a reviewer, a customer's price lowered by a person. */
export function lowersPrice(line: Pick<DocLine, "discount" | "unitPriceMinor" | "catalogPriceMinor">): boolean {
  return line.discount !== null || (line.catalogPriceMinor !== null && line.unitPriceMinor < line.catalogPriceMinor);
}

/** A rate in basis points as the percentage a person writes: 1200 is "12%", 1250 is "12.5%", 5 is "0.05%". */
export const bpsLabel = (bps: number): string => `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
