import { CURRENCY_CODES } from "@/lib/money";

// The amounts a text states, and whether an approved text backs them. Kept apart from the generator so the claim check (src/server/social/claims.ts) can use it
// without importing the generator back.

const CODES = CURRENCY_CODES.join("|");

/**
 * Money-like amounts: a sign or a currency code beside digits, with or without a space ("$5", "USD 5", "Php500", "P500"); digits and then a currency word or
 * code ("5 pesos", "1 peso", "2000 JPY", "50 bucks"); or a bare number straight after a cost word ("we charge 700"). The cost-word form is the last to be tried, so
 * "costs 30 euros" is read as "30 euros".
 */
const MONEY = new RegExp(
  String.raw`(?:[$€£₱¥]|\b(?:${CODES})|\bP(?=\d))\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:${CODES}|dollars?|pesos?|euros?|pounds?|yen|bucks?)\b|(?<=\b(?:costs?|charg(?:e|es|ed)|priced? at|price is|fees? (?:is|are)|rates? (?:is|are))\s+(?:(?:about|around|only|just|roughly|approximately)\s+)?)\d[\d,]*(?:\.\d+)?`,
  "gi",
);

/** A whole number, wherever it stands in a text: not part of a longer run of digits, so the 12 in "120" and the 20 in "2020" are not numbers of their own. */
export const NUMBER_TOKEN = /(?<![\d.,])\d[\d,]*(?:\.\d+)?(?!\d)/g;

/** A number as a plain value, so "1,200", "1200" and "1200.00" are the same amount and "12" is never "120". */
export function plainNumber(raw: string): string {
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? String(n) : raw;
}

// Clock times and percentages say nothing about a price: "open 9am-5pm" does not make "$5" a stated amount.
const TIME_OR_PERCENT = /\b\d{1,2}(?::\d{2})?\s?(?:am|pm|a\.m\.|p\.m\.)|\b\d{1,2}:\d{2}\b|\d+(?:\.\d+)?\s?(?:%|percent)/gi;

/** The amounts an approved text states: figures beside a currency, and bare numbers (a price list may leave the sign off) other than times and percentages. */
function statedAmounts(knowledge: string): Set<string> {
  const out = new Set<string>();
  for (const m of knowledge.match(MONEY) ?? []) out.add(plainNumber(m.match(/\d[\d,]*(?:\.\d+)?/)?.[0] ?? ""));
  for (const n of knowledge.replace(TIME_OR_PERCENT, " ").match(NUMBER_TOKEN) ?? []) out.add(plainNumber(n));
  return out;
}

/**
 * Amounts a reply states that the approved text does not contain. An amount is grounded only by the same whole number in the text ($12 is not backed by
 * "$120", and $1,200 is backed by 1200). An empty list means every figure was grounded (or none was stated).
 */
export function ungroundedAmounts(reply: string, knowledge: string): string[] {
  const stated = statedAmounts(knowledge);
  const bad: string[] = [];
  for (const m of reply.match(MONEY) ?? []) {
    const digits = m.match(/\d[\d,]*(?:\.\d+)?/)?.[0] ?? "";
    if (digits && !stated.has(plainNumber(digits))) bad.push(m.trim().replace(/,$/, ""));
  }
  return bad;
}
