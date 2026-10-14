// Shared shapes for the adaptive onboarding questionnaire. Pure types: no I/O.

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
}

export type QuestionKind =
  | { type: "text"; max: number; placeholder?: string }
  | { type: "longtext"; max: number; placeholder?: string; rows?: number }
  | { type: "email" }
  | { type: "phone" }
  | { type: "url" }
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
  kind: QuestionKind;
  /** Adaptive rule. Omitted means always shown. */
  show?: (a: Answers) => boolean;
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

export type AnswerSource = "user" | "ai_suggestion" | "website_analysis" | "prefill";

export interface StoredAnswer {
  value: AnswerValue;
  skipped: boolean;
  source: AnswerSource;
  needsConfirmation: boolean;
  updatedAt: string;
}
export type StoredAnswers = Record<string, StoredAnswer>;
