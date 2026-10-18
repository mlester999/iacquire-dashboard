// Native forms and surveys: the contract a form definition follows. The builder edits a draft of this shape, publishing freezes it into
// an immutable version (crm_form_versions: fields, actions, consent, settings, content_hash), and every submission is validated against the
// exact version it answered. Pure (no I/O), so the builder, the hosted page, the website renderer and the server apply the same rules.
//
//   * Questions have a stable key (the answer's key), a type, validation, optional conditional visibility (shown when an earlier answer
//     equals / contains / is set), and optionally where the answer is saved: a contact field or a contact custom field.
//   * Hidden attribution fields record a value that was actually present when the visitor came (a URL parameter, the referring page, the
//     landing page). They are never filled with a guess.
//   * Consent wording is stored exactly as shown, per version, so every submission records the words the person agreed to.
//   * Actions say what a processed submission does: tags, a deal in a pipeline stage, an assignment rule, team notifications, and what the
//     visitor sees afterwards.
import { z } from "zod";
import { sha256Hex } from "@/lib/crm/workflow/sha256";
import type { FieldType } from "@/lib/crm/types";
import { namedChannels } from "@/lib/crm/forms/consent";
import { HIDDEN_VALUE_MAX } from "@/lib/crm/forms/visit";

/** JSON with object keys sorted and undefined dropped, so equal content always serializes (and hashes) identically. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** crm_forms.key: lower-case letters, digits and single hyphens inside, up to 48 characters. Used in hosted URLs and website elements. */
export const FORM_KEY_RE = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
/** A question's answer key. Stable across versions so reports and mappings keep working when a label changes. */
export const QUESTION_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
/** A URL parameter a hidden field reads, such as utm_source or gclid. */
export const PARAM_RE = /^[A-Za-z0-9_.-]{1,40}$/;

export const FORM_LIMITS = {
  questions: 60,
  options: 50,
  conditions: 5,
  tags: 20,
  /** The longest answer to a long-text question. */
  longText: 5000,
  /** The longest answer to a short-text question. */
  shortText: 500,
  /** The longest value a hidden field keeps. */
  hidden: HIDDEN_VALUE_MAX,
  /** All answers of one submission, serialized (the database allows 32 KB). */
  answersChars: 30_000,
  consentText: 600,
  successMessage: 600,
  intro: 1000,
} as const;

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const FORM_KINDS = ["form", "survey"] as const;
export type FormKind = (typeof FORM_KINDS)[number];
export const FORM_KIND_LABELS: Record<FormKind, string> = { form: "Form", survey: "Survey" };

export const FORM_PURPOSES = ["contact", "consultation", "qualification", "quote", "appointment_request", "newsletter", "inquiry", "survey"] as const;
export type FormPurpose = (typeof FORM_PURPOSES)[number];
export const FORM_PURPOSE_LABELS: Record<FormPurpose, string> = {
  contact: "Contact us",
  consultation: "Consultation request",
  qualification: "Lead qualification",
  quote: "Quote request",
  appointment_request: "Appointment request",
  newsletter: "Newsletter sign-up",
  inquiry: "General enquiry",
  survey: "Survey",
};

export const FORM_STATUSES = ["draft", "published", "archived"] as const;
export type FormStatus = (typeof FORM_STATUSES)[number];

export const QUESTION_TYPES = ["short_text", "long_text", "email", "phone", "number", "date", "single_choice", "multiple_choice", "checkbox", "hidden"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];
export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  short_text: "Short answer",
  long_text: "Paragraph",
  email: "Email",
  phone: "Phone",
  number: "Number",
  date: "Date",
  single_choice: "Single choice",
  multiple_choice: "Multiple choice",
  checkbox: "Checkbox",
  hidden: "Hidden (attribution)",
};
export const QUESTION_TYPE_HINTS: Record<QuestionType, string> = {
  short_text: "One line of text, such as a name or a city.",
  long_text: "Several lines, for a message or details.",
  email: "An email address, checked for the right format.",
  phone: "A phone number. Without a country code, your workspace's calling code is used.",
  number: "A number, with an optional minimum and maximum.",
  date: "A calendar date.",
  single_choice: "One answer from a list, as a dropdown or as buttons.",
  multiple_choice: "Any number of answers from a list.",
  checkbox: "A single tick box, such as “I'm a returning customer”.",
  hidden: "Not shown. Records a value that came with the visit: a link parameter, the referring page or the landing page.",
};

/** Answers as stored (and as a workflow reads them): text, a number, a list of option values, or a tick. */
export type AnswerValue = string | number | boolean | string[];
export type Answers = Record<string, AnswerValue>;

export interface ChoiceOption {
  /** Stable value stored in the answer. */
  value: string;
  label: string;
}

export const CONDITION_OPS = ["equals", "not_equals", "contains", "is_set", "is_not_set"] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];
export const CONDITION_OP_LABELS: Record<ConditionOp, string> = {
  equals: "is",
  not_equals: "is not",
  contains: "contains",
  is_set: "is answered",
  is_not_set: "is not answered",
};

export interface Condition {
  /** An earlier question's key. */
  question: string;
  op: ConditionOp;
  /** The compared value: an option value for choice questions, "true"/"false" for a checkbox, text otherwise. */
  value?: string;
}

export interface Visibility {
  match: "all" | "any";
  conditions: Condition[];
}

export type HiddenSource = { kind: "param"; param: string } | { kind: "referrer" } | { kind: "landing_page" };

export interface QuestionValidation {
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  /** Whole numbers only. */
  integer?: boolean;
  /** YYYY-MM-DD bounds for date questions. */
  minDate?: string;
  maxDate?: string;
  /** Multiple choice: how many may be chosen. */
  minChoices?: number;
  maxChoices?: number;
}

/** Built-in contact fields a question can fill. Custom fields are "custom:<key>". */
export const CONTACT_TARGETS = {
  "contact.first_name": { label: "First name", accepts: ["short_text", "hidden"] },
  "contact.last_name": { label: "Last name", accepts: ["short_text", "hidden"] },
  "contact.full_name": { label: "Full name", accepts: ["short_text"] },
  "contact.email": { label: "Email", accepts: ["email"] },
  "contact.phone": { label: "Phone", accepts: ["phone"] },
  "contact.address_line1": { label: "Street address", accepts: ["short_text"] },
  "contact.city": { label: "City", accepts: ["short_text", "hidden"] },
  "contact.region": { label: "State or region", accepts: ["short_text", "hidden"] },
  "contact.postal_code": { label: "Postal code", accepts: ["short_text"] },
} as const satisfies Record<string, { label: string; accepts: readonly QuestionType[] }>;
export type ContactTarget = keyof typeof CONTACT_TARGETS;
export const CONTACT_TARGET_KEYS = Object.keys(CONTACT_TARGETS) as ContactTarget[];
export const isContactTarget = (v: unknown): v is ContactTarget => typeof v === "string" && v in CONTACT_TARGETS;
/** The answers that identify a person: a contact is only created or matched from one of these. */
export const IDENTITY_TARGETS: readonly ContactTarget[] = ["contact.email", "contact.phone"];

/** Which question types can fill a custom field of each type. Values are converted and checked with the CRM's own field rules. */
export const CUSTOM_FIELD_ACCEPTS: Record<FieldType, readonly QuestionType[]> = {
  text: ["short_text", "email", "phone", "number", "date", "single_choice", "hidden"],
  textarea: ["short_text", "long_text", "hidden"],
  number: ["number"],
  currency: ["number"],
  date: ["date"],
  datetime: [],
  boolean: ["checkbox"],
  select: ["single_choice"],
  multiselect: ["multiple_choice"],
  email: ["email"],
  phone: ["phone"],
  url: ["short_text", "hidden"],
};

export interface FormQuestion {
  key: string;
  type: QuestionType;
  label: string;
  help?: string;
  placeholder?: string;
  required: boolean;
  /** Single and multiple choice. */
  options?: ChoiceOption[];
  /** Single choice: a dropdown, or buttons (radio) for short lists. */
  display?: "dropdown" | "radio";
  /** Half-width questions sit side by side on wider screens. */
  width?: "full" | "half";
  validation?: QuestionValidation;
  /** Shown only when these conditions on earlier answers hold. A hidden question's answer is not kept. */
  visibleWhen?: Visibility | null;
  /** Hidden fields only: where the value comes from. */
  source?: HiddenSource;
  /** Where the answer is saved on the contact: a ContactTarget or "custom:<field key>". */
  map?: string | null;
}

export interface FormConsent {
  /** The exact words next to the required consent tick box. Required when the form collects an email address or phone number. */
  text: string;
  /** An optional, separate, unticked box for offers and news. */
  marketing: { enabled: boolean; text: string };
}

export const NOTIFY_ROLES = ["owner", "admin", "sales_rep", "support", "appointment_setter"] as const;
export type NotifyRole = (typeof NOTIFY_ROLES)[number];

export interface FormActions {
  tagIds: string[];
  opportunity: null | {
    pipelineId: string;
    stageId: string;
    /** The deal's name. Placeholders: {{contact.first_name}}, {{contact.last_name}}, {{contact.full_name}}, {{form.name}}, {{answer.<key>}}. */
    name: string;
    /** A number question whose answer becomes the deal's value. */
    valueQuestion?: string | null;
  };
  /** An active lead assignment rule: a contact rule assigns the contact, a deal rule assigns the deal. */
  assignmentRuleId: string | null;
  notify: { roles: NotifyRole[]; contactOwner: boolean };
  /** What the visitor sees after sending. A redirect is used on the hosted page; a website shows its own thank-you page. */
  after: { kind: "message"; message: string } | { kind: "redirect"; url: string };
}

export interface FormSettings {
  /** The hosted page's heading. Empty: the form's name. */
  title: string;
  intro: string;
  submitLabel: string;
}

/** What the builder edits and publishing freezes. */
export interface FormDraft {
  questions: FormQuestion[];
  consent: FormConsent;
  actions: FormActions;
  settings: FormSettings;
}

// ---------------------------------------------------------------------------
// Schemas (structure only; references and cross-field rules are in validateDraft)
// ---------------------------------------------------------------------------

const text = (max: number) => z.string().max(max);
const optionSchema = z.strictObject({ value: z.string().trim().min(1).max(60), label: z.string().trim().min(1).max(120) });
const conditionSchema = z.strictObject({ question: z.string().max(40), op: z.enum(CONDITION_OPS), value: text(200).optional() });
const visibilitySchema = z.strictObject({ match: z.enum(["all", "any"]), conditions: z.array(conditionSchema).max(FORM_LIMITS.conditions) });
const hiddenSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("param"), param: z.string() }),
  z.strictObject({ kind: z.literal("referrer") }),
  z.strictObject({ kind: z.literal("landing_page") }),
]);
const validationSchema = z.strictObject({
  minLength: z.number().int().min(0).max(FORM_LIMITS.longText).optional(),
  maxLength: z.number().int().min(1).max(FORM_LIMITS.longText).optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  integer: z.boolean().optional(),
  minDate: z.string().optional(),
  maxDate: z.string().optional(),
  minChoices: z.number().int().min(0).max(FORM_LIMITS.options).optional(),
  maxChoices: z.number().int().min(1).max(FORM_LIMITS.options).optional(),
});

export const questionSchema = z.strictObject({
  key: z.string(),
  type: z.enum(QUESTION_TYPES),
  label: text(200),
  help: text(300).optional(),
  placeholder: text(120).optional(),
  required: z.boolean(),
  options: z.array(optionSchema).max(FORM_LIMITS.options).optional(),
  display: z.enum(["dropdown", "radio"]).optional(),
  width: z.enum(["full", "half"]).optional(),
  validation: validationSchema.optional(),
  visibleWhen: visibilitySchema.nullable().optional(),
  source: hiddenSourceSchema.optional(),
  map: z.string().max(60).nullable().optional(),
});

const consentSchema = z.strictObject({
  text: text(FORM_LIMITS.consentText),
  marketing: z.strictObject({ enabled: z.boolean(), text: text(FORM_LIMITS.consentText) }),
});

const actionsSchema = z.strictObject({
  tagIds: z.array(z.string()).max(FORM_LIMITS.tags),
  opportunity: z.strictObject({ pipelineId: z.string(), stageId: z.string(), name: text(200), valueQuestion: z.string().max(40).nullable().optional() }).nullable(),
  assignmentRuleId: z.string().nullable(),
  notify: z.strictObject({ roles: z.array(z.enum(NOTIFY_ROLES)).max(NOTIFY_ROLES.length), contactOwner: z.boolean() }),
  after: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("message"), message: text(FORM_LIMITS.successMessage) }),
    z.strictObject({ kind: z.literal("redirect"), url: text(500) }),
  ]),
});

const settingsSchema = z.strictObject({ title: text(120), intro: text(FORM_LIMITS.intro), submitLabel: text(40) });

export const draftSchema = z.strictObject({
  questions: z.array(questionSchema).max(FORM_LIMITS.questions * 2),
  consent: consentSchema,
  actions: actionsSchema,
  settings: settingsSchema,
});

// ---------------------------------------------------------------------------
// Starting points
// ---------------------------------------------------------------------------

export const DEFAULT_CONSENT_TEXT = "I agree to be contacted by email, phone or text message about my enquiry.";
// Consent counts only for the channels its words name (./consent), so the defaults name theirs.
export const DEFAULT_MARKETING_TEXT = "Email me occasional news and offers. I can unsubscribe at any time.";
export const DEFAULT_SUCCESS_MESSAGE = "Thank you. We've received your details and will be in touch soon.";

export function emptyDraft(kind: FormKind = "form"): FormDraft {
  const contactQuestions: FormQuestion[] = [
    { key: "first_name", type: "short_text", label: "First name", required: true, width: "half", map: "contact.first_name" },
    { key: "last_name", type: "short_text", label: "Last name", required: false, width: "half", map: "contact.last_name" },
    { key: "email", type: "email", label: "Email", required: true, width: "half", map: "contact.email" },
    { key: "phone", type: "phone", label: "Phone", required: false, width: "half", map: "contact.phone" },
    { key: "message", type: "long_text", label: "How can we help?", required: false, width: "full" },
  ];
  const surveyQuestions: FormQuestion[] = [
    { key: "rating", type: "single_choice", label: "How would you rate your experience?", required: true, display: "radio", options: ["Excellent", "Good", "Okay", "Poor"].map((l) => ({ value: slugValue(l), label: l })) },
    { key: "comments", type: "long_text", label: "Anything you'd like to tell us?", required: false },
  ];
  return {
    questions: kind === "survey" ? surveyQuestions : contactQuestions,
    consent: { text: kind === "survey" ? "" : DEFAULT_CONSENT_TEXT, marketing: { enabled: false, text: DEFAULT_MARKETING_TEXT } },
    // A survey asks nothing that identifies a person, so there's no contact (and no contact owner) to tell.
    actions: { tagIds: [], opportunity: null, assignmentRuleId: null, notify: { roles: ["owner", "admin"], contactOwner: kind !== "survey" }, after: { kind: "message", message: DEFAULT_SUCCESS_MESSAGE } },
    settings: { title: "", intro: "", submitLabel: kind === "survey" ? "Send answers" : "Send" },
  };
}

/** A stable option value from a label ("Kitchen remodel" → "kitchen_remodel"). */
export function slugValue(label: string): string {
  const s = label.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
  return s || "option";
}

/** A question key from a label, unique among `taken`. */
export function questionKeyFrom(label: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  let base = slugValue(label).slice(0, 34);
  if (!/^[a-z]/.test(base)) base = `q_${base}`.slice(0, 34);
  if (!used.has(base)) return base;
  for (let i = 2; i < 1000; i++) if (!used.has(`${base}_${i}`)) return `${base}_${i}`;
  return `${base}_${Date.now() % 100000}`;
}

/** A blank question of a type, ready for the builder. */
export function newQuestion(type: QuestionType, taken: Iterable<string>): FormQuestion {
  const label = type === "hidden" ? "UTM source" : QUESTION_TYPE_LABELS[type];
  const key = questionKeyFrom(type === "hidden" ? "utm_source" : label, taken);
  const q: FormQuestion = { key, type, label, required: false, width: "full" };
  if (type === "single_choice" || type === "multiple_choice") {
    q.options = [{ value: "option_1", label: "Option 1" }, { value: "option_2", label: "Option 2" }];
    if (type === "single_choice") q.display = "radio";
  }
  if (type === "hidden") q.source = { kind: "param", param: "utm_source" };
  if (type === "checkbox") q.label = "Yes, this applies to me";
  return q;
}

/** Normalizes a draft read from storage: anything missing gets its default, so an older or partial draft still opens. */
export function readDraft(raw: unknown, kind: FormKind = "form"): FormDraft {
  const base = emptyDraft(kind);
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<FormDraft>;
  const parsed = draftSchema.safeParse({
    questions: Array.isArray(r.questions) ? r.questions : base.questions,
    consent: { ...base.consent, ...(r.consent ?? {}), marketing: { ...base.consent.marketing, ...(r.consent?.marketing ?? {}) } },
    actions: { ...base.actions, ...(r.actions ?? {}), notify: { ...base.actions.notify, ...(r.actions?.notify ?? {}) } },
    settings: { ...base.settings, ...(r.settings ?? {}) },
  });
  if (parsed.success) return parsed.data as FormDraft;
  // A draft that no longer reads keeps whatever parts still do.
  const keep = <T>(schema: z.ZodType<T>, value: unknown, fallback: T): T => {
    const p = schema.safeParse(value);
    return p.success ? p.data : fallback;
  };
  return {
    questions: Array.isArray(r.questions) ? r.questions.flatMap((q) => { const p = questionSchema.safeParse(q); return p.success ? [p.data as FormQuestion] : []; }) : base.questions,
    consent: keep(consentSchema, r.consent, base.consent),
    actions: keep(actionsSchema, r.actions, base.actions) as FormActions,
    settings: keep(settingsSchema, r.settings, base.settings),
  };
}

// ---------------------------------------------------------------------------
// Validation for saving and publishing
// ---------------------------------------------------------------------------

export interface FormIssue {
  level: "error" | "warning";
  code: string;
  message: string;
  /** The question it is about. */
  question?: string;
  /** Which part of the form: "questions", "consent", "actions", "settings". */
  area: "questions" | "consent" | "actions" | "settings";
}

/** What the workspace has that a form can refer to. The server loads it; the builder passes the same lists it shows. */
export interface FormContext {
  tags: ReadonlySet<string>;
  pipelines: ReadonlyMap<string, { stages: ReadonlyMap<string, { kind: "open" | "won" | "lost" }> }>;
  /** Contact custom fields by key. */
  contactFields: ReadonlyMap<string, { type: FieldType; label: string; options: ReadonlyArray<{ value: string; label: string }> }>;
  /** Active assignment rules. */
  assignmentRules: ReadonlyMap<string, { entity: "contact" | "opportunity" }>;
}

export function formContextFrom(o: {
  tags: Array<{ id: string }>;
  pipelines: Array<{ id: string; stages: Array<{ id: string; kind: "open" | "won" | "lost" }> }>;
  contactFields: Array<{ key: string; type: FieldType; label: string; options: Array<{ value: string; label: string }> }>;
  assignmentRules: Array<{ id: string; entity: "contact" | "opportunity"; active?: boolean }>;
}): FormContext {
  return {
    tags: new Set(o.tags.map((t) => t.id)),
    pipelines: new Map(o.pipelines.map((p) => [p.id, { stages: new Map(p.stages.map((s) => [s.id, { kind: s.kind }])) }])),
    contactFields: new Map(o.contactFields.map((f) => [f.key, { type: f.type, label: f.label, options: f.options }])),
    assignmentRules: new Map(o.assignmentRules.filter((r) => r.active !== false).map((r) => [r.id, { entity: r.entity }])),
  };
}

const NAME_TOKENS = ["contact.first_name", "contact.last_name", "contact.full_name", "form.name"] as const;
const TOKEN_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** The placeholders in a deal name template that aren't known (with answer keys checked against the questions). */
export function unknownNameTokens(template: string, questionKeys: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const m of template.matchAll(TOKEN_RE)) {
    const key = m[1];
    if ((NAME_TOKENS as readonly string[]).includes(key)) continue;
    if (key.startsWith("answer.") && questionKeys.has(key.slice(7))) continue;
    out.push(m[0]);
  }
  return out;
}

export const isHttpsUrl = (raw: string): boolean => {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && Boolean(u.hostname.includes(".")) && !u.username && !u.password && raw.length <= 500;
  } catch {
    return false;
  }
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Ops that make sense for a question type (as the subject of a condition). */
export function opsFor(type: QuestionType): ConditionOp[] {
  switch (type) {
    case "single_choice":
    case "checkbox":
    case "number":
    case "date":
      return ["equals", "not_equals", "is_set", "is_not_set"];
    case "multiple_choice":
      return ["contains", "is_set", "is_not_set"];
    case "hidden":
      return ["equals", "not_equals", "contains", "is_set", "is_not_set"];
    default:
      return ["equals", "not_equals", "contains", "is_set", "is_not_set"];
  }
}

/** Whether the form collects something that identifies a person (an email or phone question saved to the contact). */
export const collectsIdentity = (questions: readonly FormQuestion[]) => questions.some((q) => q.map && (IDENTITY_TARGETS as readonly string[]).includes(q.map));

/**
 * Every problem with a draft: structure, question rules, conditions (only on earlier questions), mappings (types and the CRM's field rules),
 * consent wording, actions and settings. With `ctx`, references to tags, pipelines, stages, custom fields and rules are checked against
 * the workspace. A draft with any "error" can't be published.
 */
export function validateDraft(input: unknown, ctx: FormContext | null, opts: { kind?: FormKind } = {}): FormIssue[] {
  const out: FormIssue[] = [];
  const add = (level: FormIssue["level"], area: FormIssue["area"], code: string, message: string, question?: string) => out.push({ level, area, code, message, ...(question ? { question } : {}) });
  const parsed = draftSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const area = (["questions", "consent", "actions", "settings"].includes(String(first?.path[0])) ? first!.path[0] : "questions") as FormIssue["area"];
    add("error", area, "invalid_draft", "Some settings of this form are missing or not valid. Check each section, or start from a fresh draft.");
    return out;
  }
  const d = parsed.data as FormDraft;
  const kind = opts.kind ?? "form";
  const qs = d.questions;
  if (!qs.length) add("error", "questions", "no_questions", "Add at least one question.");
  if (qs.length > FORM_LIMITS.questions) add("error", "questions", "too_many", `A form can have at most ${FORM_LIMITS.questions} questions.`);
  if (qs.length && qs.every((q) => q.type === "hidden")) add("error", "questions", "no_visible", "Add at least one question people can see.");

  const seen = new Map<string, FormQuestion>();
  const mapped = new Map<string, string>();
  qs.forEach((q, index) => {
    const label = q.label.trim() || `Question ${index + 1}`;
    if (!QUESTION_KEY_RE.test(q.key)) add("error", "questions", "invalid_key", `“${label}” needs an answer key of lower-case letters, numbers and _ (starting with a letter, up to 40).`, q.key);
    else if (seen.has(q.key)) add("error", "questions", "duplicate_key", `Two questions use the answer key “${q.key}”. Each needs its own.`, q.key);
    if (!q.label.trim()) add("error", "questions", "no_label", `Question ${index + 1} needs a label.`, q.key);

    // Options
    if (q.type === "single_choice" || q.type === "multiple_choice") {
      const opts = q.options ?? [];
      if (!opts.length) add("error", "questions", "no_options", `“${label}” needs at least one choice.`, q.key);
      const values = new Set<string>();
      for (const o of opts) {
        if (values.has(o.value)) add("error", "questions", "duplicate_option", `“${label}” has two choices with the same value (“${o.value}”).`, q.key);
        values.add(o.value);
      }
    } else if (q.options?.length) add("error", "questions", "invalid_options", `“${label}” isn't a choice question, so it can't have choices.`, q.key);

    // Validation bounds
    const v = q.validation ?? {};
    if (v.minLength !== undefined && v.maxLength !== undefined && v.minLength > v.maxLength) add("error", "questions", "invalid_bounds", `“${label}”: the minimum length is more than the maximum.`, q.key);
    if (q.type === "short_text" && v.maxLength !== undefined && v.maxLength > FORM_LIMITS.shortText) add("error", "questions", "invalid_bounds", `“${label}”: a short answer can be at most ${FORM_LIMITS.shortText} characters.`, q.key);
    if (v.min !== undefined && v.max !== undefined && v.min > v.max) add("error", "questions", "invalid_bounds", `“${label}”: the minimum is more than the maximum.`, q.key);
    if ((v.minDate && !isValidDate(v.minDate)) || (v.maxDate && !isValidDate(v.maxDate))) add("error", "questions", "invalid_bounds", `“${label}”: use dates like 2026-10-31.`, q.key);
    else if (v.minDate && v.maxDate && v.minDate > v.maxDate) add("error", "questions", "invalid_bounds", `“${label}”: the earliest date is after the latest.`, q.key);
    if (v.minChoices !== undefined && v.maxChoices !== undefined && v.minChoices > v.maxChoices) add("error", "questions", "invalid_bounds", `“${label}”: the minimum number of choices is more than the maximum.`, q.key);

    // Hidden fields
    if (q.type === "hidden") {
      if (!q.source) add("error", "questions", "no_source", `Choose where the hidden field “${label}” gets its value.`, q.key);
      else if (q.source.kind === "param" && !PARAM_RE.test(q.source.param)) add("error", "questions", "invalid_source", `“${label}”: the link parameter is letters, numbers, _ . and - (up to 40), such as utm_source.`, q.key);
      if (q.required) add("error", "questions", "hidden_required", `A hidden field can't be required: it only records a value when the visit had one.`, q.key);
      if (q.visibleWhen?.conditions.length) add("error", "questions", "hidden_condition", `A hidden field isn't shown, so it can't have conditions.`, q.key);
    } else if (q.source) add("error", "questions", "invalid_source", `Only hidden fields read values from the visit.`, q.key);

    // Conditions: only on earlier questions, with ops and values that fit them.
    for (const c of q.visibleWhen?.conditions ?? []) {
      const subject = seen.get(c.question);
      if (!subject) {
        add("error", "questions", "invalid_condition", qs.some((x) => x.key === c.question) ? `“${label}” can only depend on questions above it.` : `“${label}” depends on a question that no longer exists.`, q.key);
        continue;
      }
      if (!opsFor(subject.type).includes(c.op)) add("error", "questions", "invalid_condition", `“${label}”: “${subject.label}” can't be compared that way.`, q.key);
      const needsValue = c.op === "equals" || c.op === "not_equals" || c.op === "contains";
      if (needsValue && !(c.value ?? "").trim()) add("error", "questions", "invalid_condition", `“${label}”: say which answer to “${subject.label}” shows it.`, q.key);
      if (needsValue && (subject.type === "single_choice" || subject.type === "multiple_choice") && c.value && !(subject.options ?? []).some((o) => o.value === c.value)) {
        add("error", "questions", "invalid_condition", `“${label}” depends on a choice of “${subject.label}” that no longer exists.`, q.key);
      }
      if (needsValue && subject.type === "checkbox" && c.value !== "true" && c.value !== "false") add("error", "questions", "invalid_condition", `“${label}”: choose ticked or not ticked.`, q.key);
      if (needsValue && subject.type === "number" && c.value !== undefined && !Number.isFinite(Number(c.value))) add("error", "questions", "invalid_condition", `“${label}”: compare “${subject.label}” with a number.`, q.key);
      if (needsValue && subject.type === "date" && c.value !== undefined && !isValidDate(c.value)) add("error", "questions", "invalid_condition", `“${label}”: compare “${subject.label}” with a date like 2026-10-31.`, q.key);
    }

    // Mapping
    if (q.map) {
      if (mapped.has(q.map)) add("error", "questions", "duplicate_map", `“${label}” and “${mapped.get(q.map)}” are both saved to the same field. Choose one.`, q.key);
      mapped.set(q.map, label);
      if (isContactTarget(q.map)) {
        const t = CONTACT_TARGETS[q.map];
        if (!(t.accepts as readonly string[]).includes(q.type)) add("error", "questions", "invalid_map", `A ${QUESTION_TYPE_LABELS[q.type].toLowerCase()} question can't fill the contact's ${t.label.toLowerCase()}.`, q.key);
      } else if (q.map.startsWith("custom:")) {
        const fieldKey = q.map.slice(7);
        const field = ctx?.contactFields.get(fieldKey);
        if (ctx && !field) add("error", "questions", "missing_field", `“${label}” is saved to a custom field that no longer exists.`, q.key);
        else if (field) {
          if (!CUSTOM_FIELD_ACCEPTS[field.type].includes(q.type)) add("error", "questions", "invalid_map", `“${field.label}” can't hold the answer to a ${QUESTION_TYPE_LABELS[q.type].toLowerCase()} question.`, q.key);
          else if ((field.type === "select" || field.type === "multiselect") && q.options?.length) {
            const known = (o: ChoiceOption) => field.options.some((f) => f.value.toLowerCase() === o.value.toLowerCase() || f.label.toLowerCase() === o.label.toLowerCase());
            const unknown = q.options.filter((o) => !known(o));
            if (unknown.length) add("error", "questions", "invalid_map", `“${unknown[0].label}” isn't one of the choices of “${field.label}”. Use the field's own choices.`, q.key);
          }
        }
      } else add("error", "questions", "invalid_map", `“${label}” is saved to a field that doesn't exist.`, q.key);
    }
    seen.set(q.key, q);
  });

  const identity = collectsIdentity(qs);
  if (kind === "form" && !identity) {
    add("warning", "questions", "no_identity", "Nothing on this form identifies the person, so submissions won't create or update contacts. Save an email or phone question to the contact to change that.");
  }

  // Consent
  const consentText = d.consent.text.trim();
  if (identity && consentText.length < 10) add("error", "consent", "consent_required", "This form collects contact details, so it needs consent wording (at least 10 characters) that people tick to send it.");
  else if (identity && !namedChannels(consentText).length) {
    add("warning", "consent", "consent_channels", "The consent wording doesn't name a channel, so ticking it records no consent to be contacted. Say how you'll reply, for example “by email or text message”.");
  }
  if (d.consent.marketing.enabled) {
    const m = d.consent.marketing.text.trim();
    if (m.length < 10) add("error", "consent", "marketing_text", "Write the wording for the marketing opt-in (at least 10 characters).");
    else if (m === consentText) add("error", "consent", "marketing_text", "The marketing opt-in must have its own wording, separate from the consent to be contacted.");
    else if (!namedChannels(m).length) {
      add("warning", "consent", "marketing_channels", "The marketing opt-in doesn't name a channel, so ticking it records no marketing consent. Name it, for example “Email me news and offers” or “Text me offers”.");
    }
    if (!identity) add("error", "consent", "marketing_identity", "A marketing opt-in needs an email or phone question saved to the contact.");
  }

  // Actions
  const a = d.actions;
  const needsContact = (what: string) => {
    if (!identity) add("error", "actions", "needs_contact", `${what} needs an email or phone question saved to the contact, so there is a contact to act on.`);
  };
  if (a.tagIds.length) {
    needsContact("Adding tags");
    for (const id of a.tagIds) {
      if (!UUID_RE.test(id)) add("error", "actions", "missing_tag", "One of the tags isn't valid. Choose it again.");
      else if (ctx && !ctx.tags.has(id)) add("error", "actions", "missing_tag", "One of the tags no longer exists. Remove it or choose another.");
    }
  }
  if (a.opportunity) {
    needsContact("Creating a deal");
    const o = a.opportunity;
    if (!UUID_RE.test(o.pipelineId) || !UUID_RE.test(o.stageId)) add("error", "actions", "missing_stage", "Choose the pipeline and stage for new deals.");
    else if (ctx) {
      const pipe = ctx.pipelines.get(o.pipelineId);
      const stage = pipe?.stages.get(o.stageId);
      if (!pipe) add("error", "actions", "missing_pipeline", "That pipeline no longer exists. Choose another.");
      else if (!stage) add("error", "actions", "missing_stage", "That stage isn't in the pipeline any more. Choose another.");
      else if (stage.kind !== "open") add("error", "actions", "closed_stage", "New deals start in an open stage, not a won or lost one.");
    }
    if (!o.name.trim()) add("error", "actions", "deal_name", "Give new deals a name, such as {{contact.full_name}} – {{form.name}}.");
    const unknown = unknownNameTokens(o.name, new Set(qs.map((q) => q.key)));
    if (unknown.length) add("error", "actions", "deal_name", `${unknown[0]} isn't a placeholder this form knows.`);
    if (o.valueQuestion) {
      const vq = seen.get(o.valueQuestion);
      if (!vq) add("error", "actions", "deal_value", "The deal's value comes from a question that no longer exists.");
      else if (vq.type !== "number") add("error", "actions", "deal_value", "The deal's value must come from a number question.");
    }
  }
  if (a.assignmentRuleId) {
    if (!UUID_RE.test(a.assignmentRuleId)) add("error", "actions", "missing_rule", "Choose an assignment rule.");
    else {
      const rule = ctx?.assignmentRules.get(a.assignmentRuleId);
      if (ctx && !rule) add("error", "actions", "missing_rule", "That assignment rule is switched off or no longer exists.");
      else if (rule?.entity === "opportunity" && !a.opportunity) add("error", "actions", "rule_needs_deal", "That rule assigns deals: turn on “Create a deal” too, or choose a rule for contacts.");
      else if (rule) needsContact("Assigning an owner");
    }
  }
  if (a.notify.contactOwner && !identity) add("warning", "actions", "notify_owner", "Without a contact there's no contact owner to notify.");
  if (a.after.kind === "message" && !a.after.message.trim()) add("error", "actions", "after_message", "Write the message people see after sending.");
  if (a.after.kind === "redirect" && !isHttpsUrl(a.after.url.trim())) add("error", "actions", "after_redirect", "Send people to a full https:// address, such as https://www.example.com/thank-you.");

  // Settings
  if (!d.settings.submitLabel.trim()) add("error", "settings", "submit_label", "Give the send button a label.");
  return out;
}

export const hasErrors = (issues: readonly FormIssue[]) => issues.some((i) => i.level === "error");

/** Cleans a valid draft for freezing: trims text, drops editor-only noise, and keeps only what applies to each question type. */
export function normalizeDraft(d: FormDraft): FormDraft {
  const questions = d.questions.map((q): FormQuestion => {
    const out: FormQuestion = { key: q.key, type: q.type, label: q.label.trim(), required: q.type === "hidden" ? false : q.required };
    if (q.help?.trim()) out.help = q.help.trim();
    if (q.placeholder?.trim() && !["checkbox", "hidden", "single_choice", "multiple_choice", "date"].includes(q.type)) out.placeholder = q.placeholder.trim();
    if (q.type === "single_choice" || q.type === "multiple_choice") out.options = (q.options ?? []).map((o) => ({ value: o.value.trim(), label: o.label.trim() }));
    if (q.type === "single_choice") out.display = q.display ?? "dropdown";
    if (q.type !== "hidden") out.width = q.width ?? "full";
    const v = cleanValidation(q.type, q.validation);
    if (v) out.validation = v;
    if (q.type !== "hidden" && q.visibleWhen?.conditions.length) out.visibleWhen = { match: q.visibleWhen.match, conditions: q.visibleWhen.conditions.map((c) => ({ question: c.question, op: c.op, ...(c.op === "is_set" || c.op === "is_not_set" ? {} : { value: (c.value ?? "").trim() }) })) };
    if (q.type === "hidden" && q.source) out.source = q.source.kind === "param" ? { kind: "param", param: q.source.param.trim() } : q.source;
    if (q.map) out.map = q.map;
    return out;
  });
  const a = d.actions;
  return {
    questions,
    consent: { text: d.consent.text.trim(), marketing: { enabled: d.consent.marketing.enabled, text: d.consent.marketing.text.trim() } },
    actions: {
      tagIds: [...new Set(a.tagIds)],
      opportunity: a.opportunity ? { pipelineId: a.opportunity.pipelineId, stageId: a.opportunity.stageId, name: a.opportunity.name.trim(), valueQuestion: a.opportunity.valueQuestion || null } : null,
      assignmentRuleId: a.assignmentRuleId || null,
      notify: { roles: NOTIFY_ROLES.filter((r) => a.notify.roles.includes(r)), contactOwner: a.notify.contactOwner },
      after: a.after.kind === "message" ? { kind: "message", message: a.after.message.trim() } : { kind: "redirect", url: a.after.url.trim() },
    },
    settings: { title: d.settings.title.trim(), intro: d.settings.intro.trim(), submitLabel: d.settings.submitLabel.trim() },
  };
}

function cleanValidation(type: QuestionType, v: QuestionValidation | undefined): QuestionValidation | null {
  if (!v) return null;
  const out: QuestionValidation = {};
  if (type === "short_text" || type === "long_text") {
    if (v.minLength) out.minLength = v.minLength;
    if (v.maxLength) out.maxLength = v.maxLength;
  }
  if (type === "number") {
    if (v.min !== undefined) out.min = v.min;
    if (v.max !== undefined) out.max = v.max;
    if (v.integer) out.integer = true;
  }
  if (type === "date") {
    if (v.minDate) out.minDate = v.minDate;
    if (v.maxDate) out.maxDate = v.maxDate;
  }
  if (type === "multiple_choice") {
    if (v.minChoices) out.minChoices = v.minChoices;
    if (v.maxChoices) out.maxChoices = v.maxChoices;
  }
  return Object.keys(out).length ? out : null;
}

/** The content a version is identified by: everything that changes what people see or what a submission does. */
export function draftHash(d: FormDraft): string {
  return sha256Hex(canonicalJson({ questions: d.questions, consent: d.consent, actions: d.actions, settings: d.settings }));
}

// ---------------------------------------------------------------------------
// What visitors may see
// ---------------------------------------------------------------------------

export interface PublicQuestion {
  key: string;
  type: QuestionType;
  label: string;
  help: string | null;
  placeholder: string | null;
  required: boolean;
  options: ChoiceOption[];
  display: "dropdown" | "radio" | null;
  width: "full" | "half";
  validation: QuestionValidation;
  visibleWhen: Visibility | null;
  /** The browser's autofill hint for what the answer is (given-name, email…), so people can fill the form quickly. */
  autocomplete: string | null;
}

/** Autofill hints for answers saved to the contact's own fields (WCAG 1.3.5: the purpose of personal fields is identifiable). */
const AUTOCOMPLETE: Partial<Record<ContactTarget, string>> = {
  "contact.first_name": "given-name", "contact.last_name": "family-name", "contact.full_name": "name", "contact.email": "email", "contact.phone": "tel",
  "contact.address_line1": "address-line1", "contact.city": "address-level2", "contact.region": "address-level1", "contact.postal_code": "postal-code",
};

function autocompleteFor(q: FormQuestion): string | null {
  if (q.map && isContactTarget(q.map)) return AUTOCOMPLETE[q.map] ?? null;
  if (q.type === "email") return "email";
  if (q.type === "phone") return "tel";
  return null;
}

/**
 * A hidden attribution field a condition depends on, as the browser needs it to show questions exactly as the server will decide: where
 * its value comes from (a link parameter, the referring page, the landing page), never where it is saved.
 */
export interface PublicHiddenField {
  key: string;
  type: "hidden";
  label: string;
  source: HiddenSource;
}

/**
 * A published version as a visitor's browser receives it: questions, consent wording and labels. Never the field mappings, tags, deal or
 * assignment settings, notification choices or ids. Hidden fields aren't drawn and their values are always read on the server from the
 * visit; the ones a condition depends on are described in `hidden`, so the browser works out the same values to decide what to show.
 */
export interface PublicFormDef {
  key: string;
  name: string;
  kind: FormKind;
  version: number;
  title: string;
  intro: string;
  submitLabel: string;
  questions: PublicQuestion[];
  /** Hidden attribution fields that conditions depend on (empty for most forms). */
  hidden: PublicHiddenField[];
  consent: { text: string; marketing: string | null };
  /** Question keys of which at least one must be answered (the email and phone saved to the contact). Empty: no such rule. */
  requireOneOf: string[];
  /** The thank-you message (null when the form sends people to another page). */
  successMessage: string | null;
}

export function publicDefinition(form: { key: string; name: string; kind: FormKind }, version: { version: number; fields: FormQuestion[]; consent: FormConsent; settings: FormSettings; actions: FormActions }): PublicFormDef {
  const visible = version.fields.filter((q) => q.type !== "hidden");
  const subjects = new Set(visible.flatMap((q) => (q.visibleWhen?.conditions ?? []).map((c) => c.question)));
  const hidden: PublicHiddenField[] = version.fields
    .filter((q): q is FormQuestion & { source: HiddenSource } => q.type === "hidden" && Boolean(q.source) && subjects.has(q.key))
    .map((q) => ({ key: q.key, type: "hidden", label: q.label, source: q.source }));
  return {
    key: form.key,
    name: form.name,
    kind: form.kind,
    version: version.version,
    title: version.settings.title || form.name,
    intro: version.settings.intro,
    submitLabel: version.settings.submitLabel || "Send",
    questions: visible.map((q) => ({
      key: q.key, type: q.type, label: q.label, help: q.help ?? null, placeholder: q.placeholder ?? null, required: q.required, options: q.options ?? [],
      display: q.type === "single_choice" ? (q.display ?? "dropdown") : null, width: q.width ?? "full", validation: q.validation ?? {}, visibleWhen: q.visibleWhen ?? null,
      autocomplete: autocompleteFor(q),
    })),
    hidden,
    consent: { text: version.consent.text, marketing: version.consent.marketing.enabled ? version.consent.marketing.text : null },
    requireOneOf: version.fields.filter((q) => q.map && (IDENTITY_TARGETS as readonly string[]).includes(q.map)).map((q) => q.key),
    successMessage: version.actions.after.kind === "message" ? version.actions.after.message : null,
  };
}
