import type { EscalationCategory } from "@/lib/escalation";

/**
 * The topics a client told us a person must handle ("Which topics need a person?" and "May your AI share prices?" in the questionnaire), turned into something the server can act on
 * BEFORE a model is asked. Until now those answers were only words in the employee's instructions, so an employee that ignored them (or an autonomous one nobody was reading) could
 * still answer. A hit never produces wording for the customer: it becomes a real escalation whose summary names the topic and nothing the customer wrote.
 *
 * Deliberately conservative and blunt, like the safety net in src/server/messaging/ingest.ts: whole-word patterns for unmistakable phrasings only. A miss is covered by the claims check
 * on the reply itself and by the employee's own instructions; a false hit only asks a person to look, which is the safe direction. Pure: no server code.
 */
export const RESTRICTED_TOPICS = ["pricing", "refunds", "legal", "medical", "complaints", "warranty", "safety"] as const;
export type RestrictedTopic = (typeof RESTRICTED_TOPICS)[number];

export const isRestrictedTopic = (value: unknown): value is RestrictedTopic =>
  typeof value === "string" && (RESTRICTED_TOPICS as readonly string[]).includes(value);

/** The escalation each topic becomes. Legal, medical, warranty and safety questions are the "unsafe or uncertain" kind: nobody but a person may answer them. */
export const TOPIC_ESCALATION: Record<RestrictedTopic, EscalationCategory> = {
  pricing: "sensitive_negotiation",
  refunds: "refund_concern",
  legal: "unsafe_or_uncertain",
  medical: "unsafe_or_uncertain",
  complaints: "complaint",
  warranty: "unsafe_or_uncertain",
  safety: "unsafe_or_uncertain",
};

/** The topic in the client's own words (the questionnaire's option labels), used only in the summary a team member reads. */
export const TOPIC_LABEL: Record<RestrictedTopic, string> = {
  pricing: "exact prices and quotes",
  refunds: "refunds and billing disputes",
  legal: "legal or contract questions",
  medical: "medical or health advice",
  complaints: "complaints",
  warranty: "warranties and guarantees",
  safety: "safety concerns",
};

/** When one message touches several selected topics, the most serious one decides the escalation. */
const PRIORITY: readonly RestrictedTopic[] = ["safety", "legal", "medical", "complaints", "refunds", "warranty", "pricing"];

const PATTERNS: Record<RestrictedTopic, RegExp> = {
  pricing: /\b(prices?|pricing|priced|how much|costs?|quotes?|quoted|estimates?|fees?|discounts?|ballpark|what do you charge|what does it cost)\b|[$€£₱]\s?\d/i,
  refunds: /\b(refunds?|refunded|money back|chargebacks?|dispute (?:the|a|this) charge|billing disputes?|overcharged|charged twice|double charged)\b/i,
  legal: /\b(lawyers?|attorneys?|lawsuits?|sue you|suing|legal action|legally|contracts?|liability|liable|subpoena)\b/i,
  medical: /\b(medical|medications?|prescriptions?|diagnos(?:e|is|ed)|symptoms?|dosage|side effects?|pregnan(?:t|cy)|allergic reaction|infections?|should i take)\b/i,
  complaints: /\b(complain(?:t|ts|ing|ed)?|unacceptable|terrible|awful|worst|disgusting|rip(?:ped)? off|bad service|poor service|not happy|unhappy|very disappointed|fed up|never again)\b/i,
  warranty: /\b(warrant(?:y|ies)|guarantee[ds]?|covered under)\b/i,
  safety: /\b(unsafe|dangerous|danger|hazards?|hazardous|injur(?:y|ed|ies)|emergency|gas leak|carbon monoxide|electric(?:al)? shock|caught fire|on fire|burning smell)\b/i,
};

/**
 * The restricted topics from the stored answers: the multi-choice "Which topics need a person?" list, plus pricing when the client said their AI may not share prices. Unknown values are
 * dropped (an answer from a newer questionnaire never turns into a guess), and the result is in the fixed order of RESTRICTED_TOPICS with no repeats.
 */
export function restrictedTopicsOf(answers: { sensitiveTopics?: unknown; pricingPolicy?: unknown }): RestrictedTopic[] {
  const chosen = new Set<RestrictedTopic>();
  if (Array.isArray(answers.sensitiveTopics)) for (const item of answers.sensitiveTopics) if (isRestrictedTopic(item)) chosen.add(item);
  if (answers.pricingPolicy === "never") chosen.add("pricing");
  return RESTRICTED_TOPICS.filter((topic) => chosen.has(topic));
}

/** The selected topics a customer's message touches, most serious first. Empty when none was selected or none matches. */
export function detectRestrictedTopics(text: string, selected: readonly RestrictedTopic[]): RestrictedTopic[] {
  if (!selected.length || !text.trim()) return [];
  return PRIORITY.filter((topic) => selected.includes(topic) && PATTERNS[topic].test(text));
}

/** What the team reads: the topic only. Never a word the customer wrote. */
export function restrictedTopicSummary(topic: RestrictedTopic): string {
  return `The customer's message is about ${TOPIC_LABEL[topic]}, a topic this business asked to handle with a person. The AI employee did not answer.`;
}
