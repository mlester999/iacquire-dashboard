// The nine sections of a workspace's company knowledge, and how complete that knowledge is. Pure, so the Knowledge Center, the employee readiness checklist and the snapshot an
// employee is given all count the same way. "Some approved knowledge exists" (the readiness flag) is the minimum an employee needs to work; it is not the same as complete.

export const KNOWLEDGE_SECTIONS = [
  { key: "business_description", label: "Business description", hint: "Explain what your business does, who it serves, and what makes it different. Your authorized AI employees may use this as business context." },
  { key: "products_services", label: "Products and services", hint: "List the products or services you provide. Include important limitations or conditions." },
  { key: "faq", label: "Frequently asked questions", hint: "Add questions customers commonly ask, along with the answers your employees are allowed to provide." },
  { key: "approved_pricing", label: "Approved prices", hint: "Only prices your AI team may quote. Leave empty if no AI employee should quote prices." },
  { key: "business_hours", label: "Business hours", hint: "Opening hours, holidays and response times." },
  { key: "policies", label: "Policies", hint: "Refunds, cancellations, guarantees and terms customers ask about." },
  { key: "customer_service", label: "Customer service procedures", hint: "How you handle complaints, follow-ups and special requests." },
  { key: "brand_voice", label: "Brand voice", hint: "Words you love, words you avoid, and how you sound." },
  { key: "escalation", label: "Escalation instructions", hint: "When and how a human should take over." },
] as const;
export type KnowledgeSection = (typeof KNOWLEDGE_SECTIONS)[number]["key"];

/** What is stored for one section: whether it holds text, and whether that text has been approved for employees to use (held text waits for an agency review). */
export interface KnowledgeSectionState {
  section: string;
  filled: boolean;
  review_status: string;
}

export interface KnowledgeSummary {
  /** How many sections the Knowledge Center asks for. */
  total: number;
  /** Sections with approved text, the only ones an employee may use. */
  supplied: number;
  /** Sections with text that is still waiting for review, so not yet used. */
  heldForReview: number;
  /** Plain names of the sections that hold nothing. */
  missing: string[];
  /** Plain names of the sections that are supplied. */
  suppliedNames: string[];
}

export function summarizeKnowledge(rows: readonly KnowledgeSectionState[]): KnowledgeSummary {
  const byKey = new Map(rows.map((row) => [row.section, row]));
  const suppliedNames: string[] = [];
  const missing: string[] = [];
  let heldForReview = 0;
  for (const { key, label } of KNOWLEDGE_SECTIONS) {
    const row = byKey.get(key);
    if (!row?.filled) missing.push(label);
    else if (row.review_status === "approved") suppliedNames.push(label);
    else heldForReview += 1;
  }
  return { total: KNOWLEDGE_SECTIONS.length, supplied: suppliedNames.length, heldForReview, missing, suppliedNames };
}

/** One honest sentence about how complete the knowledge is. It never calls a partial set complete. */
export function knowledgeCompletenessText(summary: KnowledgeSummary): string {
  const { supplied, total, heldForReview, missing } = summary;
  if (supplied === 0) {
    return heldForReview > 0
      ? `No company knowledge is approved yet (0 of ${total} sections); ${heldForReview} waiting for review.`
      : `No company knowledge has been supplied yet (0 of ${total} sections).`;
  }
  if (supplied === total) return `All ${total} knowledge sections are supplied.`;
  const held = heldForReview > 0 ? ` ${heldForReview} more ${heldForReview === 1 ? "is" : "are"} waiting for review and not used yet.` : "";
  return `${supplied} of ${total} knowledge sections are supplied, so this is partial, not a complete company profile.${held} Still empty: ${missing.join(", ")}.`;
}
