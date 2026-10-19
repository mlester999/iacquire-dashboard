// Small, deterministic helpers that make the support flow smarter without calling an AI provider: finding similar wording, suggesting
// where a request belongs, and keeping secrets out of anything that does reach a provider. Everything here is advisory: a suggestion
// is shown to a person, who decides; nothing is filed, changed or sent because of it.

import type { RequestType } from "@/lib/support/lifecycle";

// ---------------------------------------------------------------------------
// Similar requests
// ---------------------------------------------------------------------------

const STOP = new Set(
  "a an the and or but if then so of to in on at by for with from as is are was were be been being it its this that these those i me my we our you your they them their can could would should will do does did not no yes please help need needs want have has had get got just also very".split(" "),
);

export function significantWords(text: string): string[] {
  return text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
}

function trigrams(text: string): Set<string> {
  const t = ` ${significantWords(text).join(" ")} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= t.length; i += 1) out.add(t.slice(i, i + 3));
  return out;
}

/** 0 (nothing in common) to 1 (the same words): the better of word overlap and spelling-tolerant trigram overlap. */
export function similarity(a: string, b: string): number {
  const wa = new Set(significantWords(a));
  const wb = new Set(significantWords(b));
  if (!wa.size || !wb.size) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  const jaccard = shared / (wa.size + wb.size - shared);
  const ta = trigrams(a);
  const tb = trigrams(b);
  let tshared = 0;
  for (const t of ta) if (tb.has(t)) tshared += 1;
  const dice = ta.size + tb.size ? (2 * tshared) / (ta.size + tb.size) : 0;
  return Math.max(jaccard, dice * 0.9);
}

export function rankSimilar<T extends { subject: string }>(subject: string, candidates: readonly T[], opts: { min?: number; limit?: number } = {}): Array<T & { score: number }> {
  const min = opts.min ?? 0.5;
  if (significantWords(subject).length < 2) return [];
  return candidates
    .map((c) => ({ ...c, score: Math.round(similarity(subject, c.subject) * 100) / 100 }))
    .filter((c) => c.score >= min)
    .sort((x, y) => y.score - x.score)
    .slice(0, opts.limit ?? 3);
}

// ---------------------------------------------------------------------------
// Suggesting a kind and category
// ---------------------------------------------------------------------------

export interface KindSuggestion {
  requestType: RequestType;
  category: string;
  confidence: "low" | "medium" | "high";
  reason: string;
}

const AREAS: Array<{ category: string; re: RegExp; label: string }> = [
  { category: "crm", re: /\b(contacts?|pipelines?|deals?|opportunit\w+|crm|smart lists?|tags?|tasks?)\b/i, label: "mentions CRM" },
  { category: "ai_employees", re: /\b(ai (employee|assistant|agent)s?|lead hunter|sales assistant|aqi|chatbot|hermes|knowledge)\b/i, label: "mentions your AI employees" },
  { category: "integrations", re: /\b(integrat\w+|connect(ed|ion)?|google|calendar|gohighlevel|ghl|n8n|zapier|whatsapp|twilio|resend|webhook)\b/i, label: "mentions a connected service" },
  { category: "website", re: /\b(website|web site|domain|landing page|site editor|published site)\b/i, label: "mentions your website" },
  { category: "billing", re: /\b(bill\w*|invoice|credits?|usage|payment|charge[sd]?|plan|subscription)\b/i, label: "mentions billing or usage" },
  { category: "account", re: /\b(password|log ?in|sign ?in|invite|team members?|roles?|permissions?|account)\b/i, label: "mentions your account" },
];
const PROBLEM = /\b(not working|doesn'?t work|isn'?t working|broken|error|fails?|failed|failing|can'?t|cannot|won'?t|unable|stuck|crash\w*|wrong|missing|spinning|freez\w+|disappeared)\b/i;
const FEEDBACK = /\b(suggest\w*|would be (nice|great|helpful)|it would help|feature request|wish|idea|could you add|please add|would love|love (it|this|the)|great job|thank(s| you))\b/i;
const POSITIVE = /\b(love|great job|thank(s| you)|works (great|well)|happy with|really like)\b/i;
const SLOW = /\b(slow|loading|spinning|freez\w+|timeout|takes forever)\b/i;
const ACCESS = /\b(no access|access denied|not allowed|forbidden|permission|can'?t (open|see|view)|locked out)\b/i;
const INCORRECT = /\b(wrong|incorrect|doesn'?t match|shows the wrong|not right)\b/i;
const EASE = /\b(confusing|hard to find|unclear|awkward|difficult to use|too many clicks)\b/i;

/**
 * A starting point for the form: what kind of request this sounds like and where it belongs. It is based on the person's own words
 * and shown as a suggestion they can change; confidence is "low" whenever the signals are weak or mixed.
 */
export function suggestRequestKind(subject: string, text: string): KindSuggestion {
  const all = `${subject}\n${text}`;
  const area = AREAS.find((a) => a.re.test(all));
  if (FEEDBACK.test(all) && !PROBLEM.test(all)) {
    const category = POSITIVE.test(all) ? "positive_feedback" : EASE.test(all) ? "ux_feedback" : /\b(improv\w+|better|easier)\b/i.test(all) ? "improvement" : "feature_suggestion";
    return { requestType: "feedback", category, confidence: "medium", reason: "This reads like a suggestion or comment." };
  }
  if (PROBLEM.test(all) || SLOW.test(all) || ACCESS.test(all)) {
    const category = SLOW.test(all) ? "performance" : ACCESS.test(all) ? "access" : INCORRECT.test(all) ? "incorrect_information" : area && area.category !== "account" && area.category !== "billing" ? area.category : "feature_not_working";
    return { requestType: "issue", category, confidence: area || SLOW.test(all) || ACCESS.test(all) ? "high" : "medium", reason: `Something sounds broken${area ? ` and it ${area.label}` : ""}.` };
  }
  if (area) return { requestType: "support", category: area.category, confidence: "medium", reason: `It ${area.label}.` };
  return { requestType: "support", category: "general", confidence: "low", reason: "We couldn't tell what this is about from the words so far." };
}

// ---------------------------------------------------------------------------
// Keeping secrets out of AI prompts
// ---------------------------------------------------------------------------

/** Removes only credentials: URLs with embedded passwords, API keys, JWTs and long token-like strings. Used wherever text is shared, not just sent to an AI. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@[^\s]+/gi, "[link removed]")
    .replace(/\b(?:sk|pk|rk|whsec|xox[bap]|ghp|gho)[-_][A-Za-z0-9_-]{8,}\b/g, "[secret removed]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, "[secret removed]")
    .replace(/\b[A-Za-z0-9+/_-]{32,}={0,2}\b/g, "[secret removed]");
}

/**
 * Removes the kinds of values that should not leave the portal inside a prompt: email addresses, phone numbers, long digit runs (card
 * or account numbers), URLs with credentials, and anything that looks like an API key or token. It errs on the side of removing.
 */
export function redactForAi(text: string): string {
  return redactSecrets(text)
    .replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, "[email removed]")
    .replace(/\b(?:\d[ -]?){13,19}\b/g, "[number removed]")
    .replace(/(?<!\d)(?:\+?\d{1,3}[ .-]?)?(?:\(\d{2,4}\)|\d{2,4})[ .-]?\d{3,4}[ .-]?\d{3,4}(?!\d)/g, "[phone removed]");
}

// ---------------------------------------------------------------------------
// Advice for the team (rules, not AI)
// ---------------------------------------------------------------------------

export interface EscalationAdvice {
  recommend: boolean;
  /** What the team might set the priority to, as a suggestion. */
  suggestedPriority: "low" | "normal" | "high" | "urgent";
  reasons: string[];
}

const UPSET = /\b(cancel\w*|refund|angry|furious|unacceptable|lawyer|legal action|chargeback|disappointed|fed up|worst)\b/i;
const OUTAGE = /\b(down|outage|everything|all (my )?(customers|leads|messages)|nobody can|no one can|completely broken)\b/i;

/**
 * Signals a human might want to look at before deciding on priority or escalation. It reads only what is already on the request,
 * lists the reasons it found, and changes nothing.
 */
export function escalationAdvice(input: { clientUrgency: string | null; status: string; priority: string; reopenedCount: number; overdue: boolean; clientMessages: number; text: string }): EscalationAdvice {
  const reasons: string[] = [];
  const blocking = input.clientUrgency === "blocking";
  const outage = OUTAGE.test(input.text);
  if (blocking) reasons.push("The client says this is blocking their work.");
  if (outage) reasons.push("The wording suggests a wide or complete failure.");
  if (input.overdue) reasons.push("The reply is past its response target.");
  if (input.reopenedCount > 0) reasons.push(`It has been reopened ${input.reopenedCount === 1 ? "once" : `${input.reopenedCount} times`}.`);
  if (UPSET.test(input.text)) reasons.push("The client sounds frustrated or mentions cancelling.");
  if (input.clientMessages >= 6 && !["resolved", "closed"].includes(input.status)) reasons.push("The conversation has gone back and forth many times without a resolution.");
  const suggestedPriority = (blocking && outage) ? "urgent" : (blocking || input.overdue || input.reopenedCount > 0 || outage) ? "high" : "normal";
  return { recommend: reasons.length >= 2 || (blocking && suggestedPriority !== "normal"), suggestedPriority, reasons };
}

const RISKY: Array<[RegExp, string]> = [
  [/\b(refund\w*|reimburs\w+|compensat\w+|credit(ed)? (back|your)|money back)\b/i, "Mentions a refund or compensation. Include it only if it has been approved."],
  [/\b(guarantee\w*|promise\w*|definitely|100%|for sure)\b/i, "Contains a guarantee or promise the team may not be able to keep."],
  [/\b(within|by|in) (the next )?\d+\s?(minutes?|hours?|days?)\b/i, "States a timeframe. Check it is accurate before sending."],
  [/\b(password|api key|token|card number|cvv|secret)\b/i, "Mentions credentials or payment details. Never ask a client to send these in a message."],
  [/\b(we (have|'ve) (fixed|resolved|deleted|changed|reset|refunded))\b/i, "Says something was already done. Confirm it was before sending."],
];

/** Things in a drafted reply a person should check before sending it. */
export function draftWarnings(text: string): string[] {
  return RISKY.filter(([re]) => re.test(text)).map(([, message]) => message);
}
