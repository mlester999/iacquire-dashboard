// Rule R4: nothing offered in return for a review, and no asking for one particular rating. Review sites forbid both, and so do consumer-protection rules for reviews. This is a
// plain word list, deliberately blunt: it BLOCKS (a template with these words can't be saved or approved, a program step can't be saved, a request using them isn't sent), and a person
// rewords it. Pure: no I/O, so the editors, the server and the tests use the same check. The list is a proposal a lawyer should confirm.

export type WordingFindingKind = "incentive" | "steering";

export interface WordingFinding {
  kind: WordingFindingKind;
  /** The words found, as the person wrote them. */
  term: string;
  /** What is wrong with them, in plain words. */
  message: string;
}

// Each pattern matches the offer, not every use of a common word: "feel free to reply" and "hassle-free" are fine, "a free coffee" is not.
const INCENTIVES: RegExp[] = [
  /\bdiscounts?\b/i,
  /\bcoupons?\b/i,
  /(?<![\w-])free\b(?!\s+(?:to|from|of)\b)/i,
  /\bfree of charge\b/i,
  /\bgifts?\b/i,
  /\bvouchers?\b/i,
  /\brewards?\b|\brewarded\b/i,
  /\bin exchange\b|\bin return for\b/i,
  /\boff (?:of )?your next\b/i,
  /\b\d+\s*%\s*off\b|\bpercent off\b|[$€£]\s?\d+(?:\.\d+)?\s*off\b/i,
  /\bpromo(?:tion(?:al)?)? codes?\b|\bdiscount codes?\b/i,
  /\bstore credit\b|\bcash ?back\b/i,
  /\bprizes?\b|\bgiveaways?\b|\braffles?\b|\bsweepstakes\b/i,
  /\b(?:enter|entered|entry) (?:to|into|for) (?:a |the )?(?:win|draw|raffle|giveaway)\b|\bchance to win\b|\bwin an?\b/i,
  /\bbonus(?:es)?\b|\bfreebies?\b|\bcomplimentary\b/i,
];

// Asking for a particular rating ("leave a five-star review") is soliciting only the good ones, which is the same wrong from the other side.
const STEERING: RegExp[] = [
  /\b(?:5|five)[- ]stars?\s+(?:review|rating)s?\b/i,
  /\b(?:positive|good|great|glowing|favou?rable|excellent|perfect)\s+(?:review|rating)s?\b/i,
  /\b(?:review|rate|give|leave|award) us (?:with |a |an )?(?:5|five)[- ]stars?\b/i,
];

const MESSAGES: Record<WordingFindingKind, (term: string) => string> = {
  incentive: (t) => `Remove “${t}”. Offering anything in return for feedback or a review isn't allowed.`,
  steering: (t) => `Remove “${t}”. Ask for an honest review, not for a particular rating.`,
};

/**
 * Every offer or steer toward a rating in a piece of wording, each once, in the order they appear. An empty list means the wording is fine. The subject and the body of a
 * message are both checked by passing them together.
 */
export function reviewIncentiveFindings(text: string | null | undefined): WordingFinding[] {
  const s = text ?? "";
  if (!s.trim()) return [];
  const found: Array<WordingFinding & { at: number }> = [];
  const seen = new Set<string>();
  for (const [kind, list] of [["incentive", INCENTIVES], ["steering", STEERING]] as const) {
    for (const re of list) {
      const m = re.exec(s);
      if (!m) continue;
      const term = m[0].replace(/\s+/g, " ").trim();
      const key = `${kind}:${term.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ kind, term, message: MESSAGES[kind](term), at: m.index });
    }
  }
  return found.sort((a, b) => a.at - b.at).map((f) => ({ kind: f.kind, term: f.term, message: f.message }));
}
