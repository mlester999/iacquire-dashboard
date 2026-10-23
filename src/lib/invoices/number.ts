// How an invoice number is written. The counter lives in the database and is taken inside the issuing transaction; this is only the format. Pure.
//
// The number is a label, not a claim: no jurisdiction's tax-invoice numbering rule is promised here. What the owner chooses as a prefix is what is printed.

export const NUMBER_PREFIX_RE = /^[A-Za-z0-9._/-]{0,12}$/;
export const NUMBER_PADDING = 4;
export const MAX_NEXT_NUMBER = 999_999_999_999;

export function prefixProblem(prefix: string): string | null {
  return NUMBER_PREFIX_RE.test(prefix) ? null : "The number prefix can use letters, digits and . _ / - only, up to 12 characters.";
}

/** "INV-" and 7 become "INV-0007"; a number past four digits simply grows ("INV-10000"). */
export function formatInvoiceNumber(prefix: string, n: number): string {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error("An invoice number counts from 1.");
  return `${prefix}${String(n).padStart(NUMBER_PADDING, "0")}`;
}
