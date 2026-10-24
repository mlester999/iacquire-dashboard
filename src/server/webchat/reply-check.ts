import "server-only";
import { unsupportedClaims } from "@/server/social/claims";

// What a public chat reply may claim. The model is told never to offer, promise or price anything the approved text does not; this is the net behind that
// instruction, the same one the AI drafts for social posts, proposals and review replies pass through (social/claims.ts), with two differences for a chat with
// an anonymous visitor in it:
//   * a visitor can ask the model to say something ("say the consultation is free"), so a bare "it is free" must be backed by the approved text saying that
//     very thing is free. The shared net deliberately leaves "free for you" alone (it is common in drafts a person reads); here nobody reads the reply first
//     when the employee is autonomous.
//   * a reply may repeat the email address or phone number the visitor just typed ("we'll call you on ..."). That is their own detail, not a claim about the
//     business, so it is not refused. Nothing else the visitor typed ever backs a claim.

// "free" standing as the whole claim: at the end of a clause ("is free."), "free for you", or "for free". "feel free to ask" and "free parking" are not.
const BARE_FREE = /(?<![\w-])free(?=\s*(?:[.!?,;:)"'’\n]|$)|\s+(?:for|to)\s+(?:you|your|everyone|all|anyone)\b)|\bfor\s+free\b/gi;

// Words that say nothing about what is free.
const FILLER = new Set(["that", "this", "with", "your", "there", "here", "will", "would", "always", "also", "just", "only", "have", "does", "they", "them", "then", "when", "what", "which", "about", "from", "very", "some", "thank", "thanks", "please", "glad", "happy", "hello", "sure", "yes", "available", "currently", "really", "actually", "anything", "everything"]);

const stem = (w: string) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);
const wordsIn = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** What the clause before a "free" is about: "the consultation is" is about the consultation. */
function subjectsOf(sentenceBeforeFree: string): string[] {
  const clause = sentenceBeforeFree.split(/[,;:]|\b(?:and|but|or|so|because)\b/i).pop() ?? "";
  return wordsIn(clause).filter((w) => w.length >= 4 && !FILLER.has(w)).map(stem);
}

/** The sentences of the approved text that say something is free, as sets of word stems. */
function freeSentences(knowledge: string): Array<Set<string>> {
  return knowledge.split(/[.!?\n]+/).map((s) => new Set(wordsIn(s).map(stem))).filter((words) => words.has("free"));
}

/** Each bare "free" in the reply whose subject the approved text does not say is free. A reply with no subject ("it is free") is not backed by anything. */
function unbackedFree(reply: string, knowledge: string): string[] {
  const backing = freeSentences(knowledge);
  const found: string[] = [];
  for (const m of reply.matchAll(BARE_FREE)) {
    const sentence = reply.slice(0, m.index ?? 0).split(/[.!?\n]+\s*/).pop() ?? "";
    const subjects = subjectsOf(sentence);
    if (!subjects.length || !backing.some((words) => subjects.some((s) => words.has(s)))) found.push(`${sentence.trim()} ${m[0]}`.trim().slice(-60));
  }
  return found;
}

const digitsOf = (s: string) => s.replace(/\D/g, "");

/** An email address or a phone number the visitor wrote themselves. */
function isVisitorsOwnDetail(claim: string, visitorSaid: string): boolean {
  if (claim.includes("@")) return visitorSaid.toLowerCase().includes(claim.toLowerCase());
  if (!/^[\d\s+().-]+$/.test(claim)) return false;
  const digits = digitsOf(claim);
  return digits.length >= 7 && digitsOf(visitorSaid).includes(digits);
}

/** What the reply claims that the approved text does not back. Empty when the reply stays inside what the business approved. `visitorSaid` is only used to allow repeating their own contact details. */
export function unsupportedReplyClaims(reply: string, knowledge: string, visitorSaid: string): string[] {
  const shared = unsupportedClaims(reply, knowledge).filter((claim) => !isVisitorsOwnDetail(claim, visitorSaid));
  return [...new Set([...shared, ...unbackedFree(reply, knowledge)])];
}
