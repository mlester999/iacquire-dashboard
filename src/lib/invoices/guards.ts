import { detectSecret } from "@/lib/secrets";

// What must never be typed into an invoice, a payment record or a connection form. Pure.
//
// Card data never touches this product: a customer pays on the provider's own page. A card number typed into free text (a note, an instruction, the evidence of a
// payment) would be stored, shown to the team and printed on a document, so it is refused. A key or password typed into free text is refused for the same reason.

// Brand prefixes and lengths of the numbers cards actually carry. Combined with the Luhn check, an ordinary reference number is very unlikely to match.
const CARD_PATTERNS: Array<{ re: RegExp; lengths: number[] }> = [
  { re: /^4/, lengths: [13, 16, 19] },
  { re: /^(5[1-5]|2(2[2-9][1-9]|2[3-9]|[3-6]|7[01]|720))/, lengths: [16] },
  { re: /^3[47]/, lengths: [15] },
  { re: /^(6011|65|64[4-9])/, lengths: [16, 19] },
  { re: /^35(2[89]|[3-8])/, lengths: [16, 19] },
  { re: /^3(0[0-5]|[689])/, lengths: [14, 16, 19] },
  { re: /^62/, lengths: [16, 17, 18, 19] },
];

export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** True when the text holds a run of 13 to 19 digits (single spaces or dashes allowed between them) that reads as a payment card number. */
export function containsCardNumber(text: string | null | undefined): boolean {
  if (!text) return false;
  for (const m of text.matchAll(/\d(?:[ -]?\d){12,18}/g)) {
    const digits = m[0].replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 19) continue;
    if (!luhnValid(digits)) continue;
    if (CARD_PATTERNS.some((p) => p.re.test(digits) && p.lengths.includes(digits.length))) return true;
  }
  return false;
}

/** A sentence saying what is wrong with a piece of free text, or null. `what` names the field ("The notes"). */
export function freeTextProblem(what: string, text: string | null | undefined): string | null {
  if (!text) return null;
  if (containsCardNumber(text)) return `${what} looks like it holds a card number. Never type card details here: customers pay on the payment provider's own page.`;
  const secret = detectSecret(text);
  if (secret) return `${what} looks like it holds ${secret.label}. Keys and passwords do not belong in an invoice.`;
  return null;
}
