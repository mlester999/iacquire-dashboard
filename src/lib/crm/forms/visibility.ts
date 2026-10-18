// Conditional visibility for native forms: whether a question is shown for the answers given above it. Kept apart from the rest of the
// form rules (and free of anything but types and ./visit), so the small browser enhancement on hosted pages and websites ships only this.
import type { AnswerValue, Answers, Condition, HiddenSource, QuestionType, Visibility } from "@/lib/crm/forms/spec";
import { hiddenAnswers, type Visit } from "@/lib/crm/forms/visit";

export interface VisibilitySubject {
  key: string;
  type: QuestionType;
}

export interface WithVisibility extends VisibilitySubject {
  visibleWhen?: Visibility | null;
}

export const isAnswered = (v: AnswerValue | undefined): boolean => v !== undefined && v !== "" && v !== false && !(Array.isArray(v) && v.length === 0);

/** Whether one condition holds for the answers given so far. A question that isn't shown counts as not answered. */
export function conditionHolds(c: Condition, subject: VisibilitySubject | undefined, answers: Answers): boolean {
  const v = answers[c.question];
  if (c.op === "is_set") return isAnswered(v);
  if (c.op === "is_not_set") return !isAnswered(v);
  if (v === undefined || !subject) return c.op === "not_equals";
  const want = (c.value ?? "").trim();
  if (c.op === "contains") {
    if (Array.isArray(v)) return v.includes(want);
    return String(v).toLowerCase().includes(want.toLowerCase());
  }
  let equal: boolean;
  if (Array.isArray(v)) equal = v.length === 1 && v[0] === want;
  else if (typeof v === "boolean") equal = String(v) === want;
  else if (typeof v === "number") equal = want !== "" && Number(want) === v;
  else if (subject.type === "single_choice") equal = v === want;
  else equal = v.trim().toLowerCase() === want.toLowerCase();
  return c.op === "equals" ? equal : !equal;
}

/** Whether a question is shown, given the answers to the questions above it. */
export function isVisible(q: WithVisibility, answers: Answers, byKey: ReadonlyMap<string, VisibilitySubject>): boolean {
  const rule = q.visibleWhen;
  if (!rule || !rule.conditions.length) return true;
  const results = rule.conditions.map((c) => conditionHolds(c, byKey.get(c.question), answers));
  return rule.match === "any" ? results.some(Boolean) : results.every(Boolean);
}

/** Which questions are shown for these answers, in order (each question only sees the answers of shown questions above it). */
export function visibleKeys(questions: readonly WithVisibility[], answers: Answers): Set<string> {
  const byKey = new Map<string, VisibilitySubject>(questions.map((q) => [q.key, q]));
  const shown = new Set<string>();
  const seen: Answers = {};
  for (const q of questions) {
    if (isVisible(q, seen, byKey)) {
      shown.add(q.key);
      if (answers[q.key] !== undefined) seen[q.key] = answers[q.key];
    }
  }
  return shown;
}

const TICKED = new Set(["yes", "on", "true", "1"]);

/**
 * Answers as a browser holds them while someone is typing, read loosely (no validation): enough to decide what to show. The server
 * always validates properly when the form is sent.
 */
export function looseAnswers(questions: readonly VisibilitySubject[], read: (name: string) => string[]): Answers {
  const out: Answers = {};
  for (const q of questions) {
    const values = read(`q.${q.key}`).map((v) => v.trim()).filter(Boolean);
    if (q.type === "checkbox") out[q.key] = values.some((v) => TICKED.has(v.toLowerCase()));
    else if (q.type === "multiple_choice") {
      if (values.length) out[q.key] = values;
    } else if (q.type === "number") {
      const n = values[0] ? Number(values[0].replace(/,/g, "")) : NaN;
      if (Number.isFinite(n)) out[q.key] = n;
    } else if (values[0]) out[q.key] = values[0];
  }
  return out;
}

/**
 * Which questions a browser shows: the answers typed so far plus the values hidden attribution fields take from the visit, worked out from
 * the same landing page and referrer the form posts (`visit`) and the page's own host, exactly as the server does when the answers arrive.
 * So a question that depends on, say, the link's utm_source shows exactly when the server will ask for it.
 */
export function shownQuestions(
  questions: readonly WithVisibility[],
  hidden: ReadonlyArray<VisibilitySubject & { source?: HiddenSource }>,
  read: (name: string) => string[],
  visit: Visit,
  selfHost: string | null,
): Set<string> {
  const answers: Answers = { ...looseAnswers(questions, read), ...hiddenAnswers(hidden, visit, { selfHost }) };
  // Hidden fields have no conditions and conditions only look at questions above them, so listing them first changes nothing else.
  return visibleKeys([...hidden, ...questions], answers);
}

/** "Shown when …" in words, for the builder and for a page that can't hide questions (no script). */
export function describeVisibility(rule: Visibility | null | undefined, labelOf: (key: string) => { label: string; options?: Array<{ value: string; label: string }> } | undefined): string | null {
  if (!rule || !rule.conditions.length) return null;
  const parts = rule.conditions.map((c) => {
    const q = labelOf(c.question);
    const name = q ? `“${q.label}”` : "an earlier answer";
    const value = c.value === undefined ? "" : q?.options?.find((o) => o.value === c.value)?.label ?? (c.value === "true" ? "ticked" : c.value === "false" ? "not ticked" : c.value);
    switch (c.op) {
      case "equals": return `${name} is “${value}”`;
      case "not_equals": return `${name} is not “${value}”`;
      case "contains": return `${name} includes “${value}”`;
      case "is_set": return `${name} is answered`;
      case "is_not_set": return `${name} is not answered`;
    }
  });
  return parts.join(rule.match === "any" ? " or " : " and ");
}
