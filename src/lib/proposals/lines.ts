// Comparing a proposal's lines before and after an edit, to decide whether the person making it needed the discount permission. Pure.
import type { DocDiscount, DocLine } from "@/lib/proposals/doc";

export function sameDiscount(a: DocDiscount | null, b: DocDiscount | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === "percent" && b.kind === "percent") return a.bps === b.bps;
  if (a.kind === "fixed" && b.kind === "fixed") return a.minor === b.minor;
  return false;
}

export interface PriceChanges {
  /** Lines whose discount was added, changed or removed. */
  discounts: string[];
  /** Lines now priced differently from the price book that were not priced that way before. */
  overrides: string[];
}

/**
 * What an edit changed about pricing. A line that was already saved and is left as it was changes nothing, even if the price book has moved since: only a discount that was
 * touched, or a price that was set to something other than the price book's, counts. Both need the discount permission; a line typed by hand (no catalog price) is the
 * author's own and is not an override.
 */
export function priceChanges(before: readonly DocLine[], after: readonly DocLine[]): PriceChanges {
  const prior = new Map(before.map((l) => [l.id, l]));
  const out: PriceChanges = { discounts: [], overrides: [] };
  for (const line of after) {
    const was = prior.get(line.id);
    if (!sameDiscount(was?.discount ?? null, line.discount)) out.discounts.push(line.id);
    const overridden = line.catalogPriceMinor !== null && line.unitPriceMinor !== line.catalogPriceMinor;
    const alreadySo = was !== undefined && was.unitPriceMinor === line.unitPriceMinor && was.catalogPriceMinor === line.catalogPriceMinor;
    if (overridden && !alreadySo) out.overrides.push(line.id);
  }
  return out;
}

export const needsDiscountPermission = (c: PriceChanges): boolean => c.discounts.length > 0 || c.overrides.length > 0;
