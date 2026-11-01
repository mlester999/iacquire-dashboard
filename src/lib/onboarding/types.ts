// Shared shapes for the adaptive onboarding questionnaire. Pure types: no I/O.
import type { AgentRoleKey } from "@/lib/agents";

export const ONBOARDING_SECTIONS = [
  { id: "A", slug: "business", title: "Business profile", short: "Business", blurb: "Who you are and where you operate." },
  { id: "B", slug: "goals", title: "Business goals", short: "Goals", blurb: "What you want your AI team to achieve." },
  { id: "C", slug: "communication", title: "AI communication", short: "Voice", blurb: "How your AI employees talk to customers." },
  { id: "D", slug: "sales", title: "Sales and appointments", short: "Sales", blurb: "How leads become appointments and customers." },
  { id: "E", slug: "knowledge", title: "Company knowledge and branding", short: "Knowledge", blurb: "What your team should know, and how you look." },
  { id: "F", slug: "review", title: "Review and approval", short: "Review", blurb: "Check everything and approve it." },
] as const;
export type SectionId = (typeof ONBOARDING_SECTIONS)[number]["id"];

export interface ChoiceOption {
  value: string;
  label: string;
  description?: string;
}

export interface ListField {
  key: string;
  label: string;
  type: "text" | "email" | "select" | "number" | "longtext";
  options?: ChoiceOption[];
  max?: number;
  required?: boolean;
  placeholder?: string;
  /** Adaptive rule for the field inside a row. Omitted means always shown. A hidden field keeps whatever was saved but is not asked. */
  show?: (a: Answers) => boolean;
}

export type QuestionKind =
  | { type: "text"; max: number; placeholder?: string }
  | { type: "longtext"; max: number; placeholder?: string; rows?: number }
  | { type: "email" }
  | { type: "phone" }
  /** `httpsOnly`: a link a customer will be sent to (a meeting room). It must start with https://, and a query string is kept because a room link may need it. */
  | { type: "url"; httpsOnly?: boolean }
  | { type: "timezone" }
  | { type: "choice"; options: ChoiceOption[] }
  | { type: "multi"; options: ChoiceOption[]; max?: number }
  | { type: "yesno" }
  | { type: "hours" }
  | { type: "list"; fields: ListField[]; maxRows: number; addLabel: string }
  | { type: "color" }
  | { type: "files"; assetKind: "logo" | "image" | "reference" | "document"; max: number }
  | { type: "review" };

/** Values stored per question. The shape depends on the question kind (see `engine.validateAnswer`). */
export type AnswerValue = string | boolean | string[] | Array<Record<string, string>> | { primary: string; accent: string } | Record<string, unknown> | null;
export type Answers = Record<string, AnswerValue | undefined>;

export type AssistKind = "draft" | "choice" | "list";

export interface QuestionDef {
  id: string;
  section: SectionId;
  title: string;
  help: string;
  /** Concrete example shown beside the input so nobody has to guess what a good answer looks like. */
  example?: string;
  required?: boolean;
  /** Required only while this is true (for example, opening hours once replies are limited to them). A question that is `required` is always required. */
  requiredWhen?: (a: Answers) => boolean;
  kind: QuestionKind;
  /** Adaptive rule. Omitted means always shown. */
  show?: (a: Answers) => boolean;
  /** Asked only when at least one of these employees is in the plan. Omitted means asked whatever the plan is. */
  roles?: AgentRoleKey[];
  /** The optional AI assistant can suggest an answer for this question. */
  assist?: AssistKind;
  /**
   * Policy-like content (prices, policies, FAQs, hand-off rules). AI or website-derived text for these
   * must be confirmed by the owner before it can become approved knowledge.
   */
  sensitive?: boolean;
  /** Short label used in the review summary; defaults to the title. */
  reviewLabel?: string;
}

/** What the plan changes about the questionnaire. Omitted everywhere means every employee is in the plan. */
export interface QuestionScope {
  roles: readonly AgentRoleKey[];
}

export type AnswerSource = "user" | "ai_suggestion" | "website_analysis" | "prefill";

export interface StoredAnswer {
  value: AnswerValue;
  skipped: boolean;
  source: AnswerSource;
  needsConfirmation: boolean;
  updatedAt: string;
}
export type StoredAnswers = Record<string, StoredAnswer>;
