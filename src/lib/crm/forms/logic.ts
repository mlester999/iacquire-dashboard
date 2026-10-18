// What happens to answers: conditional visibility, validating a submission against the exact version it answered, the attribution a visit
// actually carried, which channels the consent wording covers, deal names from a template, and the spam signs processing looks for.
// Pure, so the hosted page, the website runtime, the processing job and the browser enhancement apply the same rules.
import { normalizeEmail, normalizePhone } from "@/lib/messaging";
import { FORM_LIMITS, IDENTITY_TARGETS, isValidDate, type AnswerValue, type Answers, type FormConsent, type FormQuestion, type QuestionType } from "@/lib/crm/forms/spec";
import { isAnswered, isVisible, visibleKeys, type VisibilitySubject } from "@/lib/crm/forms/visibility";
import { hiddenValue, readVisit, type Attribution, type Visit } from "@/lib/crm/forms/visit";

// Conditional visibility lives in ./visibility (the browser enhancement ships only that); re-exported here for everything else.
export { conditionHolds, isAnswered, isVisible, looseAnswers, visibleKeys, describeVisibility } from "@/lib/crm/forms/visibility";

type Subject = VisibilitySubject;

// ---------------------------------------------------------------------------
// The visit: attribution that was actually present
// ---------------------------------------------------------------------------

// The visit and hidden values live in ./visit (the browser enhancement uses them too, to show questions exactly as the server decides).
export { ATTRIBUTION_PARAMS, hiddenAnswers, hiddenValue, readVisit, type Attribution, type Visit } from "@/lib/crm/forms/visit";

export const ATTRIBUTION_LABELS: Record<keyof Attribution, string> = {
  landing_page: "Landing page", referrer: "Came from", utm_source: "UTM source", utm_medium: "UTM medium", utm_campaign: "UTM campaign", utm_term: "UTM term",
  utm_content: "UTM content", gclid: "Google click id", fbclid: "Facebook click id", msclkid: "Microsoft click id",
};

const clean = (s: string, max: number) => s.replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, max);

// ---------------------------------------------------------------------------
// Validating a submission
// ---------------------------------------------------------------------------

/** Posted values by name. A multiple-choice question posts one value per ticked box under the same name. */
export type RawFields = ReadonlyMap<string, readonly string[]>;

export const answerName = (key: string) => `q.${key}`;

/** Collects form entries ([name, value] pairs) into RawFields, ignoring files and capping how much is read. */
export function collectFields(entries: Iterable<[string, unknown]>, maxEntries = 400): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let n = 0;
  for (const [k, v] of entries) {
    if (typeof v !== "string" || ++n > maxEntries) continue;
    const list = out.get(k) ?? [];
    if (list.length < 60) list.push(v);
    out.set(k, list);
  }
  return out;
}

export const firstValue = (raw: RawFields, name: string) => (raw.get(name) ?? []).find((v) => v.trim() !== "") ?? "";

export interface SubmissionInput {
  questions: readonly FormQuestion[];
  consent: FormConsent;
  kind?: "form" | "survey";
}

export type SubmissionCheck =
  | { ok: true; answers: Answers; consentGiven: boolean; marketing: boolean; attribution: Attribution }
  | { ok: false; errors: Record<string, string>; message: string };

const TICKED = new Set(["yes", "on", "true", "1"]);

/** Plain words for "please answer". */
const answerPrompt = (q: Pick<FormQuestion, "label" | "type">) =>
  q.type === "checkbox" ? `Please tick “${q.label}”.` : q.type === "single_choice" || q.type === "multiple_choice" ? `Please choose an answer for “${q.label}”.` : `Please answer “${q.label}”.`;

/** One answer checked and converted, or an error message. Blank input returns undefined (not answered). */
export function checkAnswer(q: FormQuestion, values: readonly string[], opts: { callingCode?: string | null } = {}): { value?: AnswerValue; error?: string } {
  const v = q.validation ?? {};
  const first = clean(values.find((x) => x.trim() !== "") ?? "", FORM_LIMITS.longText + 10);
  switch (q.type as QuestionType) {
    case "short_text":
    case "long_text": {
      const max = Math.min(v.maxLength ?? (q.type === "short_text" ? 300 : 2000), q.type === "short_text" ? FORM_LIMITS.shortText : FORM_LIMITS.longText);
      // Paragraphs keep their line breaks; short answers are one line.
      const raw = q.type === "long_text" ? (values.find((x) => x.trim() !== "") ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "").trim() : first.replace(/\s+/g, " ");
      if (!raw) return {};
      if (raw.length > max) return { error: `“${q.label}” can be at most ${max.toLocaleString("en-US")} characters.` };
      if (v.minLength && raw.length < v.minLength) return { error: `“${q.label}” needs at least ${v.minLength} characters.` };
      return { value: raw };
    }
    case "email": {
      if (!first) return {};
      const e = normalizeEmail(first);
      return e ? { value: e } : { error: "Please enter a valid email address, like name@example.com." };
    }
    case "phone": {
      if (!first) return {};
      if (!/^[0-9+()\-.\s]{5,30}$/.test(first) || first.replace(/\D/g, "").length < 7) return { error: "Please enter a valid phone number." };
      const p = normalizePhone(first, opts.callingCode ?? undefined);
      return p ? { value: p } : { error: "Please include your country code, like +1 555 123 4567." };
    }
    case "number": {
      if (!first) return {};
      const n = Number(first.replace(/,/g, ""));
      if (!Number.isFinite(n) || Math.abs(n) >= 1e12) return { error: `“${q.label}” must be a number.` };
      if (v.integer && !Number.isInteger(n)) return { error: `“${q.label}” must be a whole number.` };
      if (v.min !== undefined && n < v.min) return { error: `“${q.label}” must be at least ${v.min}.` };
      if (v.max !== undefined && n > v.max) return { error: `“${q.label}” must be at most ${v.max}.` };
      return { value: n };
    }
    case "date": {
      if (!first) return {};
      if (!isValidDate(first)) return { error: `“${q.label}” must be a date.` };
      if (v.minDate && first < v.minDate) return { error: `“${q.label}” can't be before ${v.minDate}.` };
      if (v.maxDate && first > v.maxDate) return { error: `“${q.label}” can't be after ${v.maxDate}.` };
      return { value: first };
    }
    case "single_choice": {
      if (!first) return {};
      return (q.options ?? []).some((o) => o.value === first) ? { value: first } : { error: `Please choose one of the answers for “${q.label}”.` };
    }
    case "multiple_choice": {
      const picked: string[] = [];
      for (const raw of values) {
        const x = raw.trim();
        if (!x) continue;
        if (!(q.options ?? []).some((o) => o.value === x)) return { error: `Please choose from the answers listed for “${q.label}”.` };
        if (!picked.includes(x)) picked.push(x);
      }
      if (!picked.length) return {};
      if (v.minChoices && picked.length < v.minChoices) return { error: `Choose at least ${v.minChoices} for “${q.label}”.` };
      if (v.maxChoices && picked.length > v.maxChoices) return { error: `Choose at most ${v.maxChoices} for “${q.label}”.` };
      // Stored in the order the form lists them, whatever order the browser sent.
      return { value: (q.options ?? []).map((o) => o.value).filter((x) => picked.includes(x)) };
    }
    case "checkbox":
      return { value: values.some((x) => TICKED.has(x.trim().toLowerCase())) };
    case "hidden":
      return first ? { value: clean(first, FORM_LIMITS.hidden) } : {};
  }
}

/**
 * Validates a submission against a version: each shown question is checked and converted (required only when shown), answers to hidden
 * questions are dropped, hidden attribution fields take their value from the visit (never from what the browser claims about them),
 * at least one email or phone saved to the contact must be given when the form has one, and the consent box must be ticked when the form
 * has consent wording. Nothing is guessed: an unusable answer is an error.
 */
export function validateSubmission(input: SubmissionInput, raw: RawFields, opts: { callingCode?: string | null; visit?: Visit; selfHost?: string | null } = {}): SubmissionCheck {
  const visit = readVisit(opts.visit ?? { landing: null, referrer: null }, { selfHost: opts.selfHost });
  const byKey = new Map<string, Subject>(input.questions.map((q) => [q.key, q]));
  const errors: Record<string, string> = {};
  const answers: Answers = {};
  for (const q of input.questions) {
    if (q.type === "hidden") {
      const hv = hiddenValue(q, visit);
      if (hv !== undefined) answers[q.key] = hv;
      continue;
    }
    if (!isVisible(q, answers, byKey)) continue;
    const r = checkAnswer(q, raw.get(answerName(q.key)) ?? [], { callingCode: opts.callingCode });
    if (r.error) {
      errors[q.key] = r.error;
      continue;
    }
    const answered = isAnswered(r.value);
    if (q.required && !answered) {
      errors[q.key] = answerPrompt(q);
      continue;
    }
    if (r.value !== undefined && (answered || q.type === "checkbox")) answers[q.key] = r.value;
  }
  const identity = input.questions.filter((q) => q.map && (IDENTITY_TARGETS as readonly string[]).includes(q.map));
  const shownIdentity = identity.filter((q) => visibleKeys(input.questions, answers).has(q.key));
  if (shownIdentity.length && !shownIdentity.some((q) => isAnswered(answers[q.key])) && !shownIdentity.some((q) => errors[q.key])) {
    errors[shownIdentity[0].key] = shownIdentity.length > 1 ? "Please give an email address or a phone number so we can reply." : answerPrompt(shownIdentity[0]);
  }
  const consentText = input.consent.text.trim();
  const consentGiven = TICKED.has(firstValue(raw, "consent").toLowerCase());
  if (consentText && !consentGiven) errors.consent = "Please tick the box to agree to be contacted.";
  const marketing = input.consent.marketing.enabled && TICKED.has(firstValue(raw, "marketing").toLowerCase());
  if (Object.keys(errors).length) {
    const first = input.questions.find((q) => errors[q.key]);
    return { ok: false, errors, message: first ? errors[first.key] : errors.consent ?? Object.values(errors)[0] };
  }
  if (JSON.stringify(answers).length > FORM_LIMITS.answersChars) return { ok: false, errors: {}, message: "That's more than this form can take. Please shorten your answers." };
  return { ok: true, answers, consentGiven: consentText ? consentGiven : false, marketing, attribution: visit.attribution };
}

// ---------------------------------------------------------------------------
// Consent coverage
// ---------------------------------------------------------------------------

// Consent coverage lives in ./consent (pure, shared with the builder's checks); re-exported here for everything else.
export { consentChannels, coversEmail, coversTexting, coversWhatsapp, namedChannels, type ConsentChannel } from "@/lib/crm/forms/consent";

// ---------------------------------------------------------------------------
// Showing answers, deal names, spam
// ---------------------------------------------------------------------------

/** An answer in words, as the submissions list and deal names show it. */
export function formatAnswer(q: Pick<FormQuestion, "type" | "options"> | undefined, value: AnswerValue | undefined): string {
  if (value === undefined) return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.map((v) => q?.options?.find((o) => o.value === v)?.label ?? v).join(", ");
  if (typeof value === "number") return value.toLocaleString("en-US");
  if (q?.type === "single_choice") return q.options?.find((o) => o.value === value)?.label ?? value;
  return value;
}

/** A deal's name from its template. Placeholders without a value are left out; a name that ends up empty falls back to honest words. */
export function renderDealName(template: string, data: { firstName?: string | null; lastName?: string | null; fullName?: string | null; formName: string; answers: Answers; questions: readonly FormQuestion[] }): string {
  const byKey = new Map(data.questions.map((q) => [q.key, q]));
  const full = data.fullName?.trim() || [data.firstName, data.lastName].map((s) => s?.trim()).filter(Boolean).join(" ");
  const out = template.replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (_m, key: string) => {
    if (key === "contact.first_name") return data.firstName?.trim() ?? "";
    if (key === "contact.last_name") return data.lastName?.trim() ?? "";
    if (key === "contact.full_name") return full;
    if (key === "form.name") return data.formName;
    if (key.startsWith("answer.")) return formatAnswer(byKey.get(key.slice(7)), data.answers[key.slice(7)]).replace(/\s+/g, " ");
    return "";
  });
  const tidy = out.replace(/\s+/g, " ").replace(/^[\s\-–—:·|,]+|[\s\-–—:·|,]+$/g, "").replace(/\(\s*\)/g, "").trim().slice(0, 200);
  return tidy || `${data.formName}${full ? ` – ${full}` : ""}`.slice(0, 200);
}

const urlCount = (s: string) => (s.match(/https?:\/\/|www\./gi) ?? []).length;

/** Link markup a person filling in a form never types: HTML anchors and forum link codes. */
const LINK_MARKUP = /<a\s[^>]*href|\[url[=\]]|\[link[=\]]/i;

/**
 * Signs that a submission is automated spam rather than a person: a web address typed into a name, several links stuffed into the
 * answers, or HTML / forum link markup. Returns the reason, or null. Deliberately narrow: a real enquiry that mentions one website is
 * never caught.
 */
export function spamReason(questions: readonly FormQuestion[], answers: Answers): string | null {
  let links = 0;
  for (const q of questions) {
    const v = answers[q.key];
    if (typeof v !== "string" || q.type === "hidden") continue;
    const n = urlCount(v);
    if (n && (q.map === "contact.first_name" || q.map === "contact.last_name" || q.map === "contact.full_name")) return "A web address was entered as a name.";
    if (LINK_MARKUP.test(v)) return "The answers contain HTML or forum link markup.";
    links += n;
  }
  return links >= 3 ? "The answers contain several links." : null;
}
