import "server-only";
import { NUMBER_TOKEN, plainNumber, ungroundedAmounts } from "@/server/webchat/generator";

// What an AI suggestion may state. The model is told never to invent a price, a review, a statistic, an award, a deadline or an offer; this is the safety net
// behind that instruction. A suggestion is dropped when it states any of the claims below that the business's approved knowledge does not itself state. It is a
// net for the common phrasings, not a guarantee: a person still reads and approves every draft before it can be scheduled.

type Backing = "phrase" | "numbers" | "percent" | "digits";

interface ClaimRule {
  re: RegExp;
  /**
   * How the approved knowledge backs a match. phrase: it uses the same words. numbers: every number in the match is stated there as a whole number (so "since 2012"
   * is backed by "Established 2012", never by "$120"). percent: the same percentage is stated. digits: the same telephone digits are written there.
   */
  by: Backing;
}

const NOUN = String.raw`(?:customers?|clients?|families|homeowners|households|patients|businesses|reviews|homes|jobs|projects|installations|installs|neighbou?rs)`;
const ADJ = String.raw`(?:happy|satisfied|local|loyal|repeat|returning|new|five[- ]star|5[- ]star)`;
const QUALIFIER = String.raw`(?:over|more than|nearly|almost|around|about|upwards of)`;
// Two digits or more ("a small number of projects" is not a claim), and never a year ("2026 projects").
const BIG_NUMBER = String.raw`(?!(?:19|20)\d\d\b)(?:\d{2,}|\d,\d{3})[\d,]*`;

const RULES: ClaimRule[] = [
  // Reviews, awards and rankings.
  { by: "phrase", re: /\b(?:testimonials?|five[- ]star|5[- ]star|award[- ]winning|awards?|awarded|top[- ]rated|best[- ]rated|highest[- ]rated|highly[- ]rated|voted|trusted by|recommended by|number (?:one|1)|rated (?:#|number )?1|best (?:[\w-]+ ){0,3}(?:in|around|near|of) (?:the )?(?:town|area|city|region|county|state|country|business|industry|valley|neighbou?rhood)|most (?:trusted|recommended|reliable|requested)|(?:our )?(?:customers?|clients?|families|homeowners|patients|neighbou?rs) (?:say|said|love|loved|rave|trust|recommend)|(?:we(?:'|’)re|we are|our [\w-]+ (?:is|are)) (?:the )?(?:best|#1|top|finest|premier|fastest|cheapest))\b/gi },
  { by: "phrase", re: /(?<!\w)#1\b/g },
  { by: "numbers", re: /\b(?:rated|rating of)\s+\d(?:\.\d+)?\b|\b\d(?:\.\d+)?[- ]?stars?\b|\b\d(?:\.\d+)?\s*(?:\/|out of)\s*(?:5|10)\b/gi },
  { by: "numbers", re: /\b\d+\s+(?:out of|in)\s+(?:\d+|ten)\s+(?:customers?|clients?|homeowners|people|families|patients|owners|users)\b/gi },
  // How many people the business has served.
  { by: "numbers", re: new RegExp(String.raw`\b(?:${QUALIFIER}\s+\d[\d,]*|${BIG_NUMBER})\+?\s+(?:${ADJ}\s+)*${NOUN}\b|\b\d[\d,]*\+?\s+(?:happy|satisfied|loyal|repeat|returning|five[- ]star|5[- ]star)\s+(?:${ADJ}\s+)*${NOUN}\b`, "gi") },
  { by: "phrase", re: /\b(?:hundreds|thousands|millions|dozens) of (?:happy |satisfied |local )?(?:customers?|clients?|families|homeowners|homes|jobs|projects)\b/gi },
  { by: "numbers", re: /\bwe(?:'|’)?(?:ve| have) (?:helped|served|completed|installed|repaired|fixed) (?:over |more than )?\d[\d,]*/gi },
  // Experience, founding and credentials.
  { by: "numbers", re: /\b\d[\d,]*\+?[- ]years?(?:[- ]old)?\s+(?:of\s+(?:experience|service|trusted service|combined experience)|in\s+business|serving)\b|\bfor\s+(?:over|more than|nearly|almost)\s+\d+\s+years\b|\b(?:since|established(?: in)?|est\.?|founded(?: in)?)\s+(?:19|20)\d{2}\b/gi },
  { by: "phrase", re: /\b(?:years|decades) of (?:experience|service)\b|\b(?:family[- ](?:owned|run|operated)|locally[- ]owned)\b|(?<=\bwe(?:'|’)re |\bwe are )(?:fully |all )?(?:licensed|insured|bonded|certified|accredited)\b|\blicensed (?:and|&) insured\b/gi },
  // Offers and prices. Amounts with a currency are checked separately (ungroundedAmounts).
  { by: "phrase", re: /(?<![\w-])free(?:\s+of\s+charge|\s+(?!(?:time|up|to|from|of|will|and|for|or|the|a|your|you)\b)[a-z]+)|\b(?:complimentary|no[- ](?:cost|charge|obligation|fee)s?|at no (?:extra )?(?:cost|charge)|no (?:hidden|extra) (?:fees?|charges?|costs?)|half[- ]off|(?:two|2)[- ]for[- ](?:one|1)|buy (?:one|1),? get (?:one|1)|bogo|discount(?:s|ed)?|coupons?|promo(?:tion)?(?: codes?)?|special offers?|exclusive offers?|limited offers?|lowest prices?|best prices?|price[- ]match(?:ing)?|financing (?:available|options)|0% apr|save (?:big|money))\b/gi },
  { by: "numbers", re: /\bsave(?:\s+up\s+to|\s+as\s+much\s+as)?\s+[$€£₱]?\d[\d,]*/gi },
  { by: "percent", re: /\b\d{1,3}(?:\.\d+)?\s?(?:%|percent\b)/gi },
  { by: "phrase", re: /\b(?:guarantee[ds]?|guaranteeing|money[- ]back|risk[- ]free|(?:lifetime|extended)\s+warranty|\d+[- ](?:year|month|day)s?\s+warranty|satisfaction (?:guaranteed|promise)|100% (?:satisfaction|guaranteed|satisfied))\b/gi },
  // Deadlines and scarcity.
  { by: "phrase", re: /\b(?:limited[- ]time|for a limited time|today only|(?:this )?(?:week|weekend|month|season) only|ends (?:tonight|tomorrow|soon|today|this \w+|(?:on )?(?:mon|tues|wednes|thurs|fri|satur|sun)day)|offer (?:ends|expires)|only \d+ (?:spots?|slots?|appointments?|left|remaining)|while supplies last|last chance)\b/gi },
  // Contact details the business did not give.
  { by: "phrase", re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g },
  { by: "digits", re: /(?<![\w.$])(?:\+?\d{1,3}[\s.-])?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?!\d)|(?<![\w.$])\d{3}[\s.-]\d{4}(?!\d)/g },
];

interface Grounding {
  words: string;
  numbers: Set<string>;
  percents: Set<string>;
  digits: string;
  compact: string;
}

/** Lower-case words only, with a plural "s" dropped, so "Free Estimates!" and "free estimate" read the same. */
const wordsOf = (s: string) =>
  s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean).map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w)).join(" ");

function groundingOf(knowledge: string): Grounding {
  return {
    words: ` ${wordsOf(knowledge)} `,
    numbers: new Set((knowledge.match(NUMBER_TOKEN) ?? []).map(plainNumber)),
    percents: new Set([...knowledge.matchAll(/(\d+(?:\.\d+)?)\s?(?:%|percent\b)/gi)].map((m) => plainNumber(m[1]))),
    digits: knowledge.replace(/\D/g, ""),
    compact: knowledge.toLowerCase().replace(/[^a-z0-9]+/g, ""),
  };
}

function backed(by: Backing, match: string, g: Grounding): boolean {
  if (by === "phrase") return g.words.includes(` ${wordsOf(match)} `);
  if (by === "digits") {
    const d = match.replace(/\D/g, "");
    return d.length >= 7 && g.digits.includes(d);
  }
  const ns = (match.match(NUMBER_TOKEN) ?? []).map(plainNumber);
  return ns.length > 0 && ns.every((n) => (by === "percent" ? g.percents : g.numbers).has(n));
}

/** What a suggestion states that the approved knowledge does not back. Empty when it stays within what the business has approved. */
export function unsupportedClaims(text: string, knowledge: string): string[] {
  const found: string[] = [...ungroundedAmounts(text, knowledge)];
  const g = groundingOf(knowledge);
  for (const rule of RULES) for (const m of text.match(rule.re) ?? []) if (!backed(rule.by, m, g)) found.push(m);
  return [...new Set(found.map((f) => f.trim()))];
}

// Hashtags are claims too (#AwardWinning, #50PercentOff), written without spaces. A model usually capitalises each word, which is split back out; a hashtag in
// lower case is read as one run of letters against the same phrases.
const COMPACT_CLAIMS =
  /awardwinning|awardwinner|voted|guarantee|moneyback|riskfree|discount|coupon|halfoff|twoforone|bogo|limitedtime|trustedby|toprated|bestrated|fivestar|5star|numberone|number1|^no1$|bestin(?:town|thearea|city|class|business|industry)|\d+percentoff|^free(?:quote|estimate|consult|inspection|install|shipping|gift|service|diagnostic|checkup|trial|delivery|parts|repair|tuneup|visit|callout|appraisal|assessment|sample)|^since(?:19|20)\d\d$|^\d+yearsof/;

/** The claims a set of hashtags makes that the approved knowledge does not back. */
export function unsupportedHashtags(hashtags: readonly string[], knowledge: string): string[] {
  const spaced = hashtags.map((h) => h.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/(\d)([A-Za-z])/g, "$1 $2").replace(/([A-Za-z])(\d)/g, "$1 $2")).join(" | ");
  const found = unsupportedClaims(spaced, knowledge);
  const compact = groundingOf(knowledge).compact;
  for (const h of hashtags) {
    const m = h.toLowerCase().match(COMPACT_CLAIMS);
    if (m && !compact.includes(m[0])) found.push(`#${h}`);
  }
  return [...new Set(found)];
}
