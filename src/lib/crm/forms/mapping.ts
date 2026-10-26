// Where a submission's answers go: the contact's own fields, its custom fields, and a deal's value. Pure, so the builder can show
// exactly what processing will do. Values are only ever the person's own answers; nothing is guessed or split apart.
import { formatAnswer } from "@/lib/crm/forms/logic";
import { FEEDBACK_TARGETS, isContactTarget, isFeedbackTarget, type AnswerValue, type Answers, type ContactTarget, type FormActions, type FormQuestion } from "@/lib/crm/forms/spec";
import { parseScore, type FeedbackScale } from "@/lib/reputation/scores";
import type { FieldType } from "@/lib/crm/types";

export interface MappedContact {
  firstName?: string;
  lastName?: string;
  /** A "full name" answer, kept whole as the contact's display name. */
  displayName?: string;
  email?: string;
  phone?: string;
  addressLine1?: string;
  city?: string;
  region?: string;
  postalCode?: string;
}

export interface MappedCustomValue {
  fieldKey: string;
  question: FormQuestion;
  value: AnswerValue;
}

/** What a survey answered as private feedback: a score on one scale, a comment, or both. Null scale and score mean only a comment. */
export interface MappedFeedback {
  scale: FeedbackScale | null;
  score: number | null;
  comment: string | null;
  /** Answers saved to feedback that couldn't be used, and why, for the submission's notes. */
  rejected: Array<{ question: string; why: string }>;
}

export interface MappedSubmission {
  contact: MappedContact;
  custom: MappedCustomValue[];
  /** The deal's value, from the number question the actions name. */
  dealValue: number | null;
  /** Null when no answered question is saved as feedback. */
  feedback: MappedFeedback | null;
}

const TARGET_KEY: Record<ContactTarget, keyof MappedContact> = {
  "contact.first_name": "firstName",
  "contact.last_name": "lastName",
  "contact.full_name": "displayName",
  "contact.email": "email",
  "contact.phone": "phone",
  "contact.address_line1": "addressLine1",
  "contact.city": "city",
  "contact.region": "region",
  "contact.postal_code": "postalCode",
};

/** Sorts answered questions into contact fields and custom fields. Unanswered questions change nothing. */
export function mapSubmission(questions: readonly FormQuestion[], answers: Answers, actions?: Pick<FormActions, "opportunity"> | null): MappedSubmission {
  const contact: MappedContact = {};
  const custom: MappedCustomValue[] = [];
  let feedback: MappedFeedback | null = null;
  for (const q of questions) {
    const v = answers[q.key];
    if (v === undefined || v === "" || (Array.isArray(v) && !v.length) || !q.map) continue;
    if (isContactTarget(q.map)) {
      if (typeof v === "string" && v.trim()) contact[TARGET_KEY[q.map]] = v.trim();
    } else if (isFeedbackTarget(q.map)) {
      feedback ??= { scale: null, score: null, comment: null, rejected: [] };
      if (q.map === "feedback.comment") {
        if (typeof v === "string" && v.trim() && feedback.comment === null) feedback.comment = v.trim();
        continue;
      }
      const scale: FeedbackScale = q.map === "feedback.nps" ? "nps10" : "csat5";
      const t = FEEDBACK_TARGETS[q.map];
      const n = typeof v === "number" || typeof v === "string" ? parseScore(scale, v) : "invalid";
      if (n === "invalid" || n === null) feedback.rejected.push({ question: q.label, why: `it must be a whole number from ${t.min} to ${t.max}` });
      else if (feedback.score === null) {
        feedback.scale = scale;
        feedback.score = n;
      } else feedback.rejected.push({ question: q.label, why: "only one score is saved as feedback" });
    } else if (q.map.startsWith("custom:")) custom.push({ fieldKey: q.map.slice(7), question: q, value: v });
  }
  const vq = actions?.opportunity?.valueQuestion;
  const raw = vq ? answers[vq] : undefined;
  return { contact, custom, dealValue: typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : null, feedback };
}

/**
 * The value handed to the CRM's own field rules for a custom field. A choice is passed as the option's stored value, or, when the
 * field knows it by another value, as its label, so the field's rules (which match either) find the same option. A checkbox becomes
 * yes/no; everything else is passed as answered.
 */
export function customFieldInput(
  field: { type: FieldType; options: ReadonlyArray<{ value: string; label: string }> },
  question: Pick<FormQuestion, "type" | "options">,
  value: AnswerValue,
): unknown {
  const pick = (v: string) => {
    if (field.options.some((o) => o.value.toLowerCase() === v.toLowerCase())) return v;
    return question.options?.find((o) => o.value === v)?.label ?? v;
  };
  if (field.type === "select" && typeof value === "string") return pick(value);
  if (field.type === "multiselect" && Array.isArray(value)) return value.map(pick);
  if (field.type === "boolean") return value === true;
  if ((field.type === "text" || field.type === "textarea") && question.type === "single_choice" && typeof value === "string") return formatAnswer(question, value);
  if ((field.type === "text" || field.type === "textarea") && typeof value === "number") return String(value);
  return value;
}
