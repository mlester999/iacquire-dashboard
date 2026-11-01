/**
 * Finds the places where a language model's reply says an action was already done ("I've booked Jane for 2pm", "the email has been sent"). A client's AI employee has no tool that
 * books, sends, changes or charges anything (its toolset is memory, search, to-do and vision), so such a sentence is untrue by construction: the only thing that can make it true is
 * a person confirming the action in the chat, which iAcquire records itself. The check never changes the model's words. It only reports which kinds of action were claimed, so the
 * caller can add a plain correction line and record that a claim was made.
 *
 * Deliberately conservative about what counts: a first-person completion ("I've booked", "we sent"), or a passive completion ("has been sent", "was cancelled").
 * Not claims: a negation ("I haven't booked", "nothing was sent"), a plan or offer ("I can book", "I'll send"), a condition ("once it's booked ..."), a question, anything the
 * reply is quoting from the customer, and a past passive that only says when an existing record is for ("Jane's consultation was booked for Friday at 2pm"), which is how a reply
 * reads a booking back from the calendar and says nothing about this reply having done it.
 *
 * Pure: no server code, so it can be tested and imported anywhere (tests/client-bundle-safety.test.ts). The result lists the categories only, never the sentence, so a caller can
 * audit the claim without storing what the model said.
 */
export const ACTION_CLAIM_CATEGORIES = ["book", "schedule", "reschedule", "cancel", "confirm", "send", "call", "update", "create", "charge", "refund", "delete"] as const;
export type ActionClaimCategory = (typeof ACTION_CLAIM_CATEGORIES)[number];

/** The line appended to a reply that claimed an action. It states what is true, so it never names or repeats the claim. */
export const ACTION_CLAIM_CORRECTION = "Nothing was booked, sent or changed by this reply. iAcquire records those only when you confirm them in this chat.";

interface ClaimVerb {
  category: ActionClaimCategory;
  /** Past-participle forms, as a regex alternation. */
  forms: string;
  /** The words right after the verb must match this, or the verb is not an action on the business's records (for example "I've confirmed that the hours are ..."). */
  after?: RegExp;
  /** Words right after the verb that make it something else (for example "updated my wording"). */
  unless?: RegExp;
}

/** A word or two of a thing a person books or changes: "your appointment", "the 2pm booking", "Jane's consultation". */
const BOOKABLE = /^\s+(?:your|the|his|her|their|that|this|an?)?\s*(?:[\w'’-]+\s+){0,2}?(?:appointment|booking|reservation|meeting|call|visit|slot|consultation)/i;

const CLAIM_VERBS: readonly ClaimVerb[] = [
  { category: "book", forms: "booked" },
  { category: "reschedule", forms: "rescheduled|moved", after: BOOKABLE },
  { category: "schedule", forms: "scheduled" },
  { category: "cancel", forms: "cancell?ed" },
  { category: "confirm", forms: "confirmed", after: /^\s+(?:your|the|his|her|their|that|this|an?)?\s*(?:[\w'’-]+\s+){0,2}?(?:appointment|booking|reservation|meeting|call|visit|slot|consultation|order)/i },
  { category: "send", forms: "sent|emailed|e-mailed|texted|messaged|forwarded|dispatched" },
  { category: "call", forms: "called|phoned|rang", after: /^\s+(?:up\s+)?(?:[A-Z][a-z]+|him\b|her\b|them\b|the\s+(?:customer|client|lead|contact|prospect|office|clinic)\b|[+\d(])/ },
  { category: "update", forms: "updated|changed|edited|modified", unless: /^\s+(?:my|the)\s+(?:wording|tone|answer|reply|response|draft|summary|explanation)\b/i },
  { category: "update", forms: "added|saved|logged|recorded", after: /^(?:\s+[\w'’.-]+){0,6}?\s+(?:to|in|into|on)\s+(?:your|the)\s+(?:crm|contacts?|pipeline|calendar|records?|system|database|account|notes?|inbox|appointments?|tasks?)/i },
  { category: "create", forms: "created|set up|opened|made", after: /^\s+(?:an?|the|your|new)\s+(?:[\w'’-]+\s+){0,2}?(?:appointment|booking|reservation|contact|deal|opportunity|task|ticket|invoice|order|account|record|lead|campaign|workflow|automation|reminder|follow-?up)/i },
  { category: "charge", forms: "charged|billed", after: /^\s+(?:you|your|the|his|her|their|them|him|\$|[A-Z]{3}\b|\d)/ },
  { category: "refund", forms: "refunded" },
  { category: "delete", forms: "deleted|removed", unless: /^\s+(?:the\s+)?(?:word|text|line|sentence|paragraph|filter)\b/i },
];

const STARTERS_OF_A_CONDITION = /^(?:if|when|whenever|once|after|before|until|unless|should|in case|as soon as|assuming|provided)\b/i;
/** A negation right before the verb turns a completion into its opposite ("Nothing was booked", "No appointment was booked"). It must run up to the verb, so "No problem, I've booked it" still counts. */
const NEGATION_BEFORE = /(?:\bnothing|\bno(?:\s+\w+){1,2}|\bnone|\bnobody|\bnot|\bnever|n['’]t|\bcannot|\bunable to|\bfailed to|\byet to)(?:\s+\w+){0,2}\s*$/i;
const ADVERBS = "(?:\\s+(?:just|already|now|successfully|also|finally|gone ahead and))*";
const FIRST_PERSON = (forms: string) => new RegExp(`\\b(?:I|we)(?:['’]ve|\\s+have|\\s+had)?${ADVERBS}\\s+(?:${forms})\\b`, "gi");
const PASSIVE_PERFECT = (forms: string) => new RegExp(`\\b(?:has|have|had)${ADVERBS}\\s+been${ADVERBS}\\s+(?:${forms})\\b`, "gi");
/** "I booked the slot and emailed the invoice": the second verb shares the first one's subject. */
const COORDINATED = (forms: string) => new RegExp(`\\b(?:I|we)(?:['’]ve|\\s+have|\\s+had)?[^.!?]{0,80}?(?:,|\\band\\b|\\bthen\\b)\\s*(?:then\\s+)?${ADVERBS}\\s*(?:${forms})\\b`, "gi");
const PASSIVE_PAST = (forms: string) => new RegExp(`\\b(?:was|were|got|(?:is|are)\\s+now)${ADVERBS}\\s+(?:${forms})\\b`, "gi");
/** "was booked by someone else" describes a slot that was taken, not an action this reply performed. */
const TAKEN_BY_OTHERS = /^\s+by\s+(?:someone|somebody|another|other|a\s+different|an?\s+earlier)/i;
/** "was booked for Friday at 2pm": the words after a past passive that say when the existing record is for. */
const STATES_WHEN = /^\s+(?:for|on|at|from|between)\b[^.!?]*?(?:\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b\d{1,2}:\d{2}\b|\b(?:mon|tues?|wednes|thurs?|fri|satur|sun)day\b|\btomorrow\b|\btonight\b|\bnoon\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}[/-]\d{1,2}\b)/i;

/** The text with what is quoted taken out: fenced code, block quotes and anything inside quotation marks is somebody else's wording (usually the customer's), not the model's claim. */
function withoutQuoted(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n")
    .replace(/"[^"\n]*"/g, " ")
    .replace(/“[^”\n]*”/g, " ");
}

function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).map((sentence) => sentence.trim()).filter(Boolean);
}

/**
 * The kinds of completed action the text claims, in the order they first appear, each once. An empty list means nothing in it reads as "this was done". It never throws and keeps
 * no copy of the text.
 */
export function findUnbackedActionClaims(text: string): ActionClaimCategory[] {
  if (typeof text !== "string" || !text.trim()) return [];
  const found: ActionClaimCategory[] = [];
  for (const sentence of sentencesOf(withoutQuoted(text))) {
    if (sentence.endsWith("?") || STARTERS_OF_A_CONDITION.test(sentence)) continue;
    for (const verb of CLAIM_VERBS) {
      if (found.includes(verb.category)) continue;
      for (const build of [FIRST_PERSON, COORDINATED, PASSIVE_PERFECT, PASSIVE_PAST]) {
        const pattern = build(verb.forms);
        for (let match = pattern.exec(sentence); match; match = pattern.exec(sentence)) {
          const before = sentence.slice(Math.max(0, match.index - 48), match.index);
          if (NEGATION_BEFORE.test(before)) continue;
          if (build === COORDINATED && /\b(?:not|never)\b|n['’]t\b/i.test(match[0])) continue;
          const after = sentence.slice(match.index + match[0].length);
          if (verb.after && !verb.after.test(after)) continue;
          if (verb.unless?.test(after)) continue;
          if ((build === PASSIVE_PERFECT || build === PASSIVE_PAST) && TAKEN_BY_OTHERS.test(after)) continue;
          if (build === PASSIVE_PAST && STATES_WHEN.test(after)) continue;
          found.push(verb.category);
          break;
        }
        if (found.includes(verb.category)) break;
      }
    }
  }
  return found;
}

/** The reply with the correction line added once. A reply that already carries it is returned unchanged, so a retry or a second pass never doubles it. */
export function withActionClaimCorrection(text: string): string {
  if (text.includes(ACTION_CLAIM_CORRECTION)) return text;
  return `${text.trimEnd()}\n\n${ACTION_CLAIM_CORRECTION}`;
}
