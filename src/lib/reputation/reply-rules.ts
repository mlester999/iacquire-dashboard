// What a public reply to a review may say. A reply goes out under the business's name where anyone can read it, so these rules BLOCK (a reply that breaks one cannot be saved,
// sent for approval or posted) and a person rewords it; they do not merely warn. Pure: no I/O, so the editor, the server and the tests use the same check, and an AI draft is held
// to exactly the rules a person's is.
//
// The rules exist for four reasons: a reply must not tell the world that the reviewer was a customer or a patient (it is not the business's to say, and for a clinic it can be
// a privacy breach); it must not offer anything in return for changing a review or ask for the review to change (review sites forbid both, and so does the law on consumer
// reviews); it must not carry contact details or links (they get copied, and a reply is not the place to settle a dispute); and it must not argue with the reviewer.
// The word lists are proposals a lawyer should confirm. They catch the common phrasings; a person still reads every reply before it is approved.

import { reviewIncentiveFindings } from "@/lib/reputation/incentives";

export const REPLY_MIN_CHARS = 5;
export const REPLY_MAX_CHARS = 1000;
/** A reply longer than this still passes but is flagged: people read short replies. */
export const REPLY_LONG_CHARS = 600;

export type ReplyRuleCode =
  | "empty" | "too_long" | "link" | "email" | "phone" | "address" | "incentive" | "steering" | "compensation" | "review_change" | "confirms_customer" | "private_details" | "argument" | "claim";

export interface ReplyProblem {
  code: ReplyRuleCode;
  /** What is wrong, in plain words, saying how to fix it. */
  message: string;
  /** The words found, when there are some to show. */
  term?: string;
}

/** A reply as stored: plain text, tidy line breaks, no control characters, no leading or trailing space. */
export function cleanReplyBody(raw: string | null | undefined): string {
  return (raw ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u2028\u2029\uFEFF]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const URL_RE = /\bhttps?:\/\/\S+|\bwww\.\S+|(?<![@\w.-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:com|net|org|io|co|us|ca|uk|au|biz|info|app|dev|ly|me|site|shop|store|online|ai|tv|xyz|club|today|page|link|ph)\b(?:\/\S*)?/i;
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
// A run of digits with the separators a phone number or an account number is written with. Seven digits or more in one run is a number someone could dial or quote.
const NUMBER_RUN_RE = /[+(]?\d[\d\s().-]{5,}\d/g;
const ADDRESS_RE = /\b\d{1,5}\s+(?:[A-Za-z][A-Za-z'.-]*\s+){0,3}(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|way|court|ct|suite|ste|unit|floor)\b\.?/i;

const COMPENSATION: RegExp[] = [
  /\brefund(?:ed|s|ing)?\b/i,
  /\breimburs\w*/i,
  /\bcompensat\w*/i,
  /\bmoney[- ]back\b/i,
  /\bon the house\b/i,
  /\bwaive[ds]?\b|\bwaiving\b/i,
  /\b(?:store |account )?credit(?:ed)?\s+(?:to|on|for)\s+(?:you|your)\b/i,
  /\bmake (?:it|this|things) up to you\b/i,
  /\b(?:replacement|redo|re-?do|re-?do the work|do it again)\b[^.!?\n]{0,40}\b(?:no (?:extra )?(?:charge|cost)|free)\b/i,
  /\bgoodwill (?:gesture|credit|payment|offer)\b/i,
  /\bpay (?:you|for your)\b/i,
];

// Asking the reviewer to change what they wrote, or to revisit their rating, is the same wrong as offering a reward for it.
const REVIEW_CHANGE: RegExp[] = [
  /\b(?:update|change|edit|revise|amend|remove|delete|take down|withdraw|retract|reconsider|re-?rate|raise|increase|upgrade|improve|revisit|re-?visit|bump)\s+(?:your|the|this|that|our)\s+(?:review|rating|stars?|score|post|feedback|comment)\b/i,
  /\b(?:please |kindly )?reconsider\b/i,
  /\bif you(?:'d| would| could| can)? (?:like to |were to |want to )?(?:update|change|edit|remove|revise|raise|upgrade)\b/i,
  /\b(?:give|leave|award) us (?:a |another |an )?(?:better|higher|new|second|fresh|5|five)\b/i,
  /\b(?:a|the) (?:better|higher|fairer|different) (?:rating|review|score)\b/i,
];

// Saying that this person was a customer, a patient or a guest. Whether someone used the business is theirs to say, not the business's.
const CONFIRMS_CUSTOMER: RegExp[] = [
  /\byour (?:visit|appointment|treatment|procedure|surgery|diagnosis|prescription|consultation|stay|order|purchase|booking|reservation|account|file|records?|case|claim|policy|service call|session|check-?up|cleaning|exam|examination|dental work|repair|installation|project|lease|loan)\b/i,
  /\bwhen you (?:came|visited|stayed|were here|were in|booked|called|ordered|bought|saw us|came in|walked in|dined)\b/i,
  /\b(?:as|being) (?:one of )?our (?:customer|client|patient|guest|member|resident|tenant|diner)s?\b/i,
  /\bthank(?:s| you)(?:[\w ,]{0,20})? for (?:being|becoming|visiting|coming|staying|dining|shopping|trusting us|choosing us|choosing|using|booking|calling|stopping|your business|your patronage|your custom)\b/i,
  /\bwe (?:treated|saw|served|helped|looked after|cared for|operated on|worked on|installed|fixed|repaired|cleaned|waited on|welcomed|hosted) you\b/i,
  /\b(?:we|I) (?:remember|recall|know) you\b/i,
  /\bour (?:records|files|system|notes|booking|bookings|calendar|logs?) (?:show|says?|indicates?|confirm|list)s?\b/i,
  /\b(?:we|I) (?:could|can|were able to|was able to|couldn'?t|can'?t|did not|didn'?t) (?:not )?find (?:you|your|any record|a record|a booking|an appointment)\b/i,
  /\b(?:you|you've|you have) (?:never|not) (?:been|visited|used|booked|stayed|ordered|dined|bought)\b/i,
];

// Health, money and identity details that must never appear in a public reply, whoever the reviewer is.
const PRIVATE_DETAILS: RegExp[] = [
  /\bdiagnos\w+/i,
  /\bprescri(?:bed|ption|ptions)\b|\bmedications?\b/i,
  /\bpregnan\w+/i,
  /\b(?:test|lab|blood|scan|x-?ray) results?\b/i,
  /\b(?:credit|debit) card\b|\bcard number\b|\bbank account\b|\bsocial security\b|\bpassport\b|\bdriver'?s licen[sc]e\b|\bdate of birth\b|\bpolicy number\b/i,
  /\binsurance (?:claim|company|provider|coverage|number)\b/i,
];

// Arguing, accusing or insulting the reviewer. Disagreeing politely is fine; calling someone a liar is not.
const ARGUMENT: RegExp[] = [
  /\byou(?:'re| are| were| have been| 've been)\s+(?:lying|a liar|wrong|mistaken|dishonest|making (?:this|it|things) up|being dishonest|confused|delusional|crazy|rude|unreasonable|out of line)\b/i,
  /\b(?:this|the|your|that)\s+(?:review|story|claim|account|complaint|post)\s+(?:is|was)\s+(?:fake|false|untrue|a lie|a fabrication|made up|fraudulent|defamatory|libel|nonsense|rubbish|ridiculous)\b/i,
  /\b(?:fake|bogus|fraudulent|false|fabricated) (?:review|reviews|story|complaint|claim)s?\b/i,
  /\b(?:liar|liars|lies|lied|lying|slander|defam\w+|libel\w*|sue you|legal action|lawyers?|attorneys?|report(?:ed)? you|competitor)\b/i,
  /\bmade (?:this|it) up\b|\bnot (?:true|accurate|correct) at all\b|\bcompletely (?:false|untrue|wrong)\b/i,
];

const firstMatch = (list: readonly RegExp[], text: string): string | null => {
  for (const re of list) {
    const m = re.exec(text);
    if (m) return m[0].replace(/\s+/g, " ").trim();
  }
  return null;
};

const MESSAGES: Record<Exclude<ReplyRuleCode, "claim" | "incentive" | "steering">, string> = {
  empty: "Write a reply.",
  too_long: `Keep the reply to ${REPLY_MAX_CHARS.toLocaleString("en-US")} characters or fewer.`,
  link: "Take out the web address. A public reply doesn't carry links.",
  email: "Take out the email address. Customers can find how to reach you on your listing.",
  phone: "Take out the phone number or other long number. Customers can find how to reach you on your listing.",
  address: "Take out the street address. Customers can find where you are on your listing.",
  compensation: "Take out the offer of money, a refund or something free. A public reply can't offer anything to settle a review.",
  review_change: "Take out the request to change, update or reconsider the review. A reply can't ask for the review or rating to change.",
  confirms_customer: "Take out the words that say this person was a customer or patient (a visit, an appointment, a treatment, an order). Whether they used your business is for them to say, not you.",
  private_details: "Take out the health, money or identity detail. A public reply never mentions personal details.",
  argument: "Take out the words that argue with or accuse the reviewer. Keep the reply calm and short, and invite them to contact you directly.",
};

/** Digits in the longest run of number-like text. */
const longestNumber = (text: string): string | null => {
  let best: string | null = null;
  let bestDigits = 0;
  for (const m of text.matchAll(NUMBER_RUN_RE)) {
    const digits = m[0].replace(/\D/g, "").length;
    if (digits >= 7 && digits > bestDigits) {
      best = m[0].trim();
      bestDigits = digits;
    }
  }
  return best;
};

/**
 * Every rule this reply breaks, each once, in a fixed order. Empty means it may be saved. `claims` are statements the business's approved knowledge does not back (found by
 * the server's claim check, which needs the knowledge); each blocks the same way.
 */
export function replyProblems(body: string | null | undefined, opts: { claims?: readonly string[] } = {}): ReplyProblem[] {
  const text = cleanReplyBody(body);
  const out: ReplyProblem[] = [];
  if (text.length < REPLY_MIN_CHARS) return [{ code: "empty", message: MESSAGES.empty }];
  if (text.length > REPLY_MAX_CHARS) out.push({ code: "too_long", message: MESSAGES.too_long });
  const add = (code: Exclude<ReplyRuleCode, "claim" | "incentive" | "steering">, term: string | null) => {
    if (term !== null) out.push({ code, message: MESSAGES[code], term });
  };
  add("link", URL_RE.exec(text)?.[0] ?? null);
  add("email", EMAIL_RE.exec(text)?.[0] ?? null);
  add("phone", longestNumber(text));
  add("address", ADDRESS_RE.exec(text)?.[0]?.trim() ?? null);
  for (const f of reviewIncentiveFindings(text)) out.push({ code: f.kind, message: f.message, term: f.term });
  add("compensation", firstMatch(COMPENSATION, text));
  add("review_change", firstMatch(REVIEW_CHANGE, text));
  add("confirms_customer", firstMatch(CONFIRMS_CUSTOMER, text));
  add("private_details", firstMatch(PRIVATE_DETAILS, text));
  add("argument", firstMatch(ARGUMENT, text));
  for (const c of opts.claims ?? []) out.push({ code: "claim", term: c, message: `Take out “${c}”. It states something your approved business information doesn't back.` });
  return out;
}

/** Things worth a second look that do not stop the reply. */
export function replyWarnings(body: string | null | undefined): string[] {
  const text = cleanReplyBody(body);
  const out: string[] = [];
  if (text.length > REPLY_LONG_CHARS) out.push("This is a long reply. Short, calm replies are read.");
  if ((text.match(/!/g) ?? []).length >= 3) out.push("Several exclamation marks can read as defensive or pushy.");
  const letters = text.replace(/[^A-Za-z]/g, "");
  if (letters.length >= 20 && letters.replace(/[^A-Z]/g, "").length / letters.length > 0.5) out.push("Most of this is in capital letters, which reads as shouting.");
  return out;
}

/** One line for the blocked state of an editor: the first problem's message. */
export const firstReplyProblem = (body: string | null | undefined, opts: { claims?: readonly string[] } = {}): string | null => replyProblems(body, opts)[0]?.message ?? null;
