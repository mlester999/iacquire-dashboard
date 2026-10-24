import { MAINTENANCE_MONTHLY_USD, SETUP_FEE_USD } from "@/lib/billing";
import { CURRENCY_CODES } from "@/lib/money";
import { hasWebAddress, spelledAmounts, unbackedPromises } from "@/lib/proposals/ai";
import { cleanMessage } from "@/lib/demo/rules";
import { PRICE_FACTS } from "@/server/demo/prompt";
import { plainNumber, ungroundedAmounts } from "@/server/webchat/amounts";
import { unsupportedReplyClaims } from "@/server/webchat/reply-check";

// The net behind the demo chat's instructions. The model is told never to state a price other than the two published ones, never to promise or claim anything, and never to say it did
// something; here every answer is checked against that BEFORE a prospect sees it, and an answer that fails is held back (the message is given back, not counted). Nobody reads the
// reply first, and a prospect can talk a model into saying things, so this is the last word. The checks are pattern lists in English, written from the review of the other public
// chat and tested against stub model output only: they can hold back a harmless answer (the prospect is told, and can ask again) and they can miss a phrasing. They are a net, not
// a guarantee, and no real model has been evaluated against them.
//
// Every pattern here is linear on its input, and the input is cut to MAX_CHECKED characters first.

export const MAX_CHECKED = 6000;

export type ReplyProblem = "empty" | "leak" | "web_address" | "amount" | "amount_in_words" | "percent" | "claim" | "promise" | "action_claim";

export type ReplyCheck = { ok: true; text: string } | { ok: false; problem: ReplyProblem; detail: string };

const FOREIGN_CODES = CURRENCY_CODES.filter((c) => c !== "USD").join("|");
const FOREIGN_MONEY = new RegExp(String.raw`[€£₱¥]\s?\d|\b(?:${FOREIGN_CODES})\s?\d|\d[\d,]*(?:\.\d+)?\s?(?:${FOREIGN_CODES}|euros?|pesos?|pounds?|yen)\b`, "i");
// "P1499" is how pesos are often written; case matters here ("p2p" is not a price).
const P_PREFIX = /\bP\d/;
const LEAK = /<\/?(?:prospect_details|conversation)>|##\s*(?:rules|facts)\b|\buntrusted text\b|\bsystem prompt\b|\bmy instructions\b|\bmy rules\b/i;
const PERCENT = /%|\bper[\s-]?cent\b/i;

// "I have sent", "I've booked": the demo can do none of it, so saying it did is false. Past-tense claims by the assistant, and a statement that the prospect's own booking, order or
// payment exists.
const ACTION_CLAIM = new RegExp(
  [
    String.raw`\b(?:i(?:'|’)?ve|i have|i just|i already|i)\s+(?:already\s+|just\s+)?(?:sent|booked|scheduled|emailed|texted|called|created|charged|refunded|updated|added|reserved|confirmed|cancel+ed|signed you up|set up)\b`,
    String.raw`\byour\s+(?:appointment|booking|order|payment|account|workspace|trial|demo)\s+(?:is|has been|was)\s+(?:booked|confirmed|scheduled|created|set up|paid|processed|ready)\b`,
  ].join("|"),
  "i",
);

// A promise made for the team or for the assistant: "we will call you", "I'll send".
const PROMISE = new RegExp(
  [
    String.raw`\b(?:we|someone|somebody|a (?:team member|person|representative|specialist|consultant)|the team|our team|they)\s+(?:will|shall|(?:'|’)ll)\s+(?:call|contact|email|text|reach|get back|follow up|be in touch|send|reply|respond|book|schedule)\b`,
    String.raw`\bi(?:'|’)ll\s+(?:send|book|schedule|email|call|text|set up|create|check|reach out|get back)\b`,
    String.raw`\bi\s+will\s+(?:send|book|schedule|email|call|text|set up|create|check|reach out|get back)\b`,
  ].join("|"),
  "i",
);

// An amount with a sign or a currency word beside it. Used only to see WHICH published price is named and what it is said to be; whether an amount is allowed at all is
// ungroundedAmounts' question.
const AMOUNT = /[$€£₱¥]\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:usd|dollars?)\b/gi;
const SAID_MONTHLY_AFTER = /^\W*(?:per|a|each|every)\s+month\b|^\W*\/\s?mo\b|^\W*monthly\b/i;
const SAID_ONE_TIME_AFTER = /^\W*(?:one[\s-]?time|once\b|up[\s-]?front)/i;
const MONTHLY_LABEL_BEFORE = /monthly\s+(?:plan|fee|price|cost|subscription|charge)[^.$€£₱¥\d]{0,25}$/i;
const SETUP_LABEL_BEFORE = /(?:set[\s-]?up|one[\s-]?time)\s+(?:fee|price|cost|charge)[^.$€£₱¥\d]{0,25}$/i;

/** A published price attached to the wrong thing: the setup fee called monthly, or the monthly plan called one-time. */
function swappedPrice(text: string): string | null {
  for (const m of text.matchAll(AMOUNT)) {
    const n = Number(plainNumber(m[0].replace(/[^\d.,]/g, "")));
    const at = m.index ?? 0;
    const after = text.slice(at + m[0].length, at + m[0].length + 24);
    const before = text.slice(Math.max(0, at - 60), at);
    if (n === SETUP_FEE_USD && (SAID_MONTHLY_AFTER.test(after) || MONTHLY_LABEL_BEFORE.test(before))) return `${m[0].trim()} is the one-time setup, not a monthly price`;
    if (n === MAINTENANCE_MONTHLY_USD && (SAID_ONE_TIME_AFTER.test(after) || SETUP_LABEL_BEFORE.test(before))) return `${m[0].trim()} is the monthly plan, not the setup`;
  }
  return null;
}

/**
 * Whether an answer may be shown. `grounding` is the facts text the model was given (prompt.ts): the prices, the employees' descriptions and the published catalog by name. The
 * answer must stay inside it. On success the cleaned text is returned (unsafe characters removed, tidy lines); on failure, the first problem found and a short note of what tripped it.
 */
export function checkDemoReply(reply: string, grounding: string): ReplyCheck {
  const text = cleanMessage(reply.slice(0, MAX_CHECKED));
  if (!text) return { ok: false, problem: "empty", detail: "" };
  if (LEAK.test(text)) return { ok: false, problem: "leak", detail: "repeats the rules" };
  if (hasWebAddress(text)) return { ok: false, problem: "web_address", detail: "a web address, email address or phone number" };
  if (PERCENT.test(text)) return { ok: false, problem: "percent", detail: "a percentage" };
  // The prices are in US dollars. The same digits in another currency ("EUR 299", "299 euros", "P1499") are a different price, which the digit check below would let through.
  if (FOREIGN_MONEY.test(text) || P_PREFIX.test(text)) return { ok: false, problem: "amount", detail: "an amount in a currency other than US dollars" };
  // Amounts: only the two published prices, as digits, on the right thing. Only the price lines back an amount (not the rest of the facts, which may hold other numbers), and the
  // same whole number is all that does: $14 is not backed by $1,499.
  const bad = ungroundedAmounts(text, PRICE_FACTS.join("\n"));
  if (bad.length) return { ok: false, problem: "amount", detail: bad.slice(0, 2).join(", ") };
  const swapped = swappedPrice(text);
  if (swapped) return { ok: false, problem: "amount", detail: swapped };
  const spelled = spelledAmounts(text);
  if (spelled.length) return { ok: false, problem: "amount_in_words", detail: spelled.slice(0, 2).join("; ") };
  if (ACTION_CLAIM.test(text)) return { ok: false, problem: "action_claim", detail: (ACTION_CLAIM.exec(text)?.[0] ?? "").slice(0, 60) };
  if (PROMISE.test(text)) return { ok: false, problem: "promise", detail: (PROMISE.exec(text)?.[0] ?? "").slice(0, 60) };
  const promises = unbackedPromises(text, grounding);
  if (promises.length) return { ok: false, problem: "promise", detail: promises.slice(0, 2).join("; ").slice(0, 80) };
  // Offers, discounts, guarantees, testimonials, awards, counts of customers and a bare "it is free": nothing the facts do not say. The prospect's own words never back a claim.
  const claims = unsupportedReplyClaims(text, grounding, "");
  if (claims.length) return { ok: false, problem: "claim", detail: claims.slice(0, 2).join("; ").slice(0, 80) };
  return { ok: true, text };
}
