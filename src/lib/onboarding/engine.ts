// Pure rules for the adaptive questionnaire: what is visible, what is valid, how far along someone is,
// and what the answers mean for the rest of the platform. No I/O so it runs the same in the browser
// (instant feedback) and on the server (the authority).
import { AGENT_BY_KEY, AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { LANGUAGES, TONES, type OnboardingData, type Tone, type ReplyLength } from "@/lib/agent-settings";
import { normalizeEmail, normalizePhone, validateBusinessHours, type BusinessHours, WEEKDAYS } from "@/lib/messaging";
import { INDUSTRY_OPTIONS, QUESTIONS, QUESTION_BY_ID, QUESTIONNAIRE_VERSION, questionOptions, wantsAppointments, wantsWebsite, channelsOf } from "./definitions";
import { ONBOARDING_SECTIONS, type AnswerValue, type Answers, type QuestionDef, type SectionId, type StoredAnswer, type StoredAnswers } from "./types";

export { QUESTIONNAIRE_VERSION };

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^#[0-9a-fA-F]{6}$/;

const clean = (s: string, max: number) => s.replace(CONTROL, "").replace(/\r\n?/g, "\n").trim().slice(0, max);

export function isValidTimeZone(tz: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz.length > 0 && tz.length <= 64;
  } catch {
    return false;
  }
}

export function normalizeWebsite(raw: string): string | null {
  const value = raw.trim();
  if (!value) return "";
  try {
    const u = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    if (!u.hostname.includes(".") || u.username || u.password) return null;
    return `${u.protocol}//${u.host}${u.pathname === "/" ? "" : u.pathname}`.slice(0, 300);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Visibility and ordering
// ---------------------------------------------------------------------------

export function visibleQuestions(answers: Answers): QuestionDef[] {
  return QUESTIONS.filter((q) => !q.show || q.show(answers));
}

export function answersOf(stored: StoredAnswers): Answers {
  const out: Answers = {};
  for (const [id, a] of Object.entries(stored)) if (!a.skipped && a.value !== null && a.value !== undefined) out[id] = a.value;
  return out;
}

/**
 * Saved answers restricted to questions that are visible given the other answers. A later answer can hide an
 * earlier question (booking switched off, for example); its saved value is kept in case the user changes their
 * mind, but it must not count toward progress or flow into any configuration.
 */
export function effectiveStored(stored: StoredAnswers): StoredAnswers {
  let current = stored;
  for (let i = 0; i < 5; i += 1) {
    const visible = new Set(visibleQuestions(answersOf(current)).map((q) => q.id));
    const next: StoredAnswers = {};
    for (const [id, a] of Object.entries(current)) if (visible.has(id) || !QUESTION_BY_ID[id]) next[id] = a;
    if (Object.keys(next).length === Object.keys(current).length) return next;
    current = next;
  }
  return current;
}

export const effectiveAnswers = (stored: StoredAnswers): Answers => answersOf(effectiveStored(stored));

// ---------------------------------------------------------------------------
// Validation (one function per kind, shared by browser and server)
// ---------------------------------------------------------------------------

export type Validation = { ok: true; value: AnswerValue } | { ok: false; error: string };
const fail = (error: string): Validation => ({ ok: false, error });

export function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as object).length === 0;
  return false;
}

export function validateAnswer(q: QuestionDef, raw: unknown, answers: Answers = {}): Validation {
  const k = q.kind;
  switch (k.type) {
    case "text":
    case "longtext": {
      if (typeof raw !== "string") return fail("Enter some text.");
      return { ok: true, value: clean(raw, k.max) };
    }
    case "email": {
      if (typeof raw !== "string") return fail("Enter an email address.");
      if (!raw.trim()) return { ok: true, value: "" };
      const email = normalizeEmail(raw);
      return email ? { ok: true, value: email } : fail("That email address doesn't look right.");
    }
    case "phone": {
      if (typeof raw !== "string") return fail("Enter a phone number.");
      if (!raw.trim()) return { ok: true, value: "" };
      const phone = normalizePhone(raw);
      return phone ? { ok: true, value: phone } : fail("Include the country code, for example +1 512 555 0100.");
    }
    case "url": {
      if (typeof raw !== "string") return fail("Enter a web address.");
      const site = normalizeWebsite(raw);
      return site === null ? fail("That website address doesn't look right.") : { ok: true, value: site };
    }
    case "timezone": {
      if (typeof raw !== "string" || !isValidTimeZone(raw.trim())) return fail("Choose a valid time zone.");
      return { ok: true, value: raw.trim() };
    }
    case "choice": {
      if (typeof raw !== "string") return fail("Choose an option.");
      if (raw === "") return { ok: true, value: "" };
      return questionOptions(q, answers).some((o) => o.value === raw) ? { ok: true, value: raw } : fail("Choose one of the options.");
    }
    case "multi": {
      if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string")) return fail("Choose from the options.");
      const allowed = new Set(questionOptions(q, answers).map((o) => o.value));
      const values = [...new Set(raw as string[])];
      if (values.some((v) => !allowed.has(v))) return fail("Choose from the options.");
      if (k.max && values.length > k.max) return fail(`Choose up to ${k.max}.`);
      return { ok: true, value: values };
    }
    case "yesno":
      return typeof raw === "boolean" ? { ok: true, value: raw } : fail("Choose yes or no.");
    case "hours": {
      if (raw === null || raw === undefined || (typeof raw === "object" && !Object.keys(raw as object).length)) return { ok: true, value: {} };
      const hours = validateBusinessHours(raw);
      return hours ? { ok: true, value: hours as Record<string, unknown> } : fail("Check the opening times: each range needs a start before its end.");
    }
    case "list": {
      if (!Array.isArray(raw)) return fail("Add at least one row, or skip this question.");
      if (raw.length > k.maxRows) return fail(`Add up to ${k.maxRows}.`);
      const rows: Array<Record<string, string>> = [];
      for (const item of raw) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) return fail("Check the entries.");
        const row: Record<string, string> = {};
        for (const f of k.fields) {
          const v = (item as Record<string, unknown>)[f.key];
          const text = typeof v === "string" || typeof v === "number" ? String(v) : "";
          if (f.type === "email") {
            if (!text.trim()) row[f.key] = "";
            else {
              const email = normalizeEmail(text);
              if (!email) return fail(`"${text.trim().slice(0, 40)}" isn't a valid email address.`);
              row[f.key] = email;
            }
          } else if (f.type === "select") {
            if (text && !f.options?.some((o) => o.value === text)) return fail("Choose one of the options.");
            row[f.key] = text;
          } else if (f.type === "number") {
            const n = Number(text);
            if (text.trim() && (!Number.isInteger(n) || n < 1 || n > 1440)) return fail("Use a whole number of minutes between 1 and 1440.");
            row[f.key] = text.trim();
          } else {
            row[f.key] = clean(text, f.max ?? 300);
          }
        }
        if (k.fields.every((f) => !row[f.key])) continue; // fully blank rows are dropped, not stored
        const missing = k.fields.find((f) => f.required && !row[f.key]);
        if (missing) return fail(`Fill in "${missing.label}" or remove the row.`);
        rows.push(row);
      }
      return { ok: true, value: rows };
    }
    case "color": {
      const v = raw as { primary?: unknown; accent?: unknown } | null;
      if (!v || typeof v !== "object") return fail("Choose your colours.");
      const primary = typeof v.primary === "string" ? v.primary : "";
      const accent = typeof v.accent === "string" ? v.accent : "";
      if ((primary && !HEX.test(primary)) || (accent && !HEX.test(accent))) return fail("Use hex colours like #2C5BFF.");
      return { ok: true, value: { primary: primary.toLowerCase(), accent: accent.toLowerCase() } };
    }
    case "files": {
      if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string" || !UUID.test(v))) return fail("Upload a file first.");
      if (raw.length > k.max) return fail(`Add up to ${k.max} files.`);
      return { ok: true, value: [...new Set(raw as string[])] };
    }
    case "review":
      return typeof raw === "boolean" ? { ok: true, value: raw } : fail("Confirm to approve your setup.");
  }
}

// ---------------------------------------------------------------------------
// Progress and resume
// ---------------------------------------------------------------------------

export type QuestionState = "answered" | "skipped" | "needs_confirmation" | "outstanding";

export function questionState(q: QuestionDef, stored: StoredAnswer | undefined): QuestionState {
  if (!stored) return "outstanding";
  // Approval only counts while it is a "yes"; changing an answer withdraws it.
  if (q.kind.type === "review") return stored.value === true ? "answered" : "outstanding";
  if (stored.skipped) return q.required ? "outstanding" : "skipped";
  if (isEmptyValue(stored.value)) return "outstanding";
  if (stored.needsConfirmation) return "needs_confirmation";
  return "answered";
}

export interface SectionProgress {
  id: SectionId;
  total: number;
  done: number;
  requiredOutstanding: number;
}
export interface Progress {
  total: number;
  done: number;
  percent: number;
  sections: SectionProgress[];
  requiredOutstanding: string[];
  needsConfirmation: string[];
}

export function computeProgress(storedAll: StoredAnswers): Progress {
  const stored = effectiveStored(storedAll);
  const answers = answersOf(stored);
  const visible = visibleQuestions(answers).filter((q) => q.kind.type !== "review");
  const sections = new Map<SectionId, SectionProgress>(ONBOARDING_SECTIONS.map((s) => [s.id, { id: s.id, total: 0, done: 0, requiredOutstanding: 0 }]));
  const requiredOutstanding: string[] = [];
  const needsConfirmation: string[] = [];
  let done = 0;
  for (const q of visible) {
    const state = questionState(q, stored[q.id]);
    const sec = sections.get(q.section)!;
    sec.total += 1;
    if (state === "answered" || state === "skipped") {
      sec.done += 1;
      done += 1;
    }
    if (state === "needs_confirmation") needsConfirmation.push(q.id);
    if (q.required && state !== "answered") {
      sec.requiredOutstanding += 1;
      requiredOutstanding.push(q.id);
    }
  }
  const total = visible.length;
  return { total, done, percent: total ? Math.round((done / total) * 100) : 0, sections: [...sections.values()], requiredOutstanding, needsConfirmation };
}

/** Picks where to resume. The saved question may have become hidden by a later answer; never strand the user. */
export function resolveCurrentQuestion(stored: StoredAnswers, savedId: string | null | undefined): string {
  const visible = visibleQuestions(effectiveAnswers(stored));
  if (savedId && visible.some((q) => q.id === savedId)) return savedId;
  if (savedId && QUESTION_BY_ID[savedId]) {
    const at = QUESTIONS.findIndex((q) => q.id === savedId);
    const later = QUESTIONS.slice(at + 1).find((q) => visible.includes(q));
    if (later) return later.id;
  }
  const open = visible.find((q) => q.kind.type !== "review" && questionState(q, stored[q.id]) === "outstanding" && q.required);
  // Everything required is answered (a prefilled or earlier setup): continue at the review rather than question one.
  return (open ?? visible.find((q) => q.kind.type === "review") ?? visible[0]).id;
}

export function neighbour(stored: StoredAnswers, currentId: string, direction: 1 | -1): string | null {
  const visible = visibleQuestions(effectiveAnswers(stored));
  const i = visible.findIndex((q) => q.id === currentId);
  const next = visible[i + direction];
  return next ? next.id : null;
}

export interface SubmitCheck {
  canSubmit: boolean;
  blockers: string[];
}

export function submitCheck(stored: StoredAnswers): SubmitCheck {
  const progress = computeProgress(stored);
  const blockers: string[] = [];
  for (const id of progress.requiredOutstanding) {
    if (id === "f.review") continue;
    blockers.push(`Answer: ${QUESTION_BY_ID[id]?.reviewLabel ?? QUESTION_BY_ID[id]?.title ?? id}`);
  }
  for (const id of progress.needsConfirmation) blockers.push(`Check the AI-suggested answer: ${QUESTION_BY_ID[id]?.reviewLabel ?? id}`);
  if (stored["f.review"]?.value !== true) blockers.push("Confirm that you approve this setup");
  return { canSubmit: blockers.length === 0, blockers };
}

// ---------------------------------------------------------------------------
// Presenting answers in plain language
// ---------------------------------------------------------------------------

export function formatHours(hours: BusinessHours | Record<string, unknown> | undefined): string {
  if (!hours) return "";
  const labels: Record<string, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
  const parts: string[] = [];
  for (const day of ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const) {
    const ranges = (hours as BusinessHours)[day];
    if (ranges?.length) parts.push(`${labels[day]} ${ranges.map(([a, b]) => `${a}–${b}`).join(", ")}`);
  }
  return parts.join("; ");
}

export function describeValue(q: QuestionDef, value: AnswerValue | undefined, answers: Answers = {}): string {
  if (value === null || value === undefined || isEmptyValue(value)) return "";
  switch (q.kind.type) {
    case "choice":
      return questionOptions(q, answers).find((o) => o.value === value)?.label ?? String(value);
    case "multi": {
      const options = questionOptions(q, answers);
      return (value as string[]).map((v) => options.find((o) => o.value === v)?.label ?? v).join(", ");
    }
    case "yesno":
      return value ? "Yes" : "No";
    case "hours":
      return formatHours(value as BusinessHours) || "Not set";
    case "list": {
      const k = q.kind;
      return (value as Array<Record<string, string>>)
        .map((row) =>
          k.fields
            .map((f) => (f.type === "select" ? f.options?.find((o) => o.value === row[f.key])?.label ?? row[f.key] : f.key === "minutes" ? `${row[f.key]} min` : row[f.key]))
            .filter(Boolean)
            .join(" · "),
        )
        .join("\n");
    }
    case "color": {
      const c = value as { primary: string; accent: string };
      return [c.primary && `Primary ${c.primary}`, c.accent && `Accent ${c.accent}`].filter(Boolean).join(", ");
    }
    case "files":
      return `${(value as string[]).length} file${(value as string[]).length === 1 ? "" : "s"} uploaded`;
    case "review":
      return value === true ? "Approved" : "";
    default:
      return String(value);
  }
}

// ---------------------------------------------------------------------------
// Bridge to the platform: legacy onboarding shape consumed by the configuration compiler
// ---------------------------------------------------------------------------

const s = (a: Answers, id: string): string => (typeof a[id] === "string" ? (a[id] as string) : "");
const list = (a: Answers, id: string): string[] => (Array.isArray(a[id]) ? (a[id] as string[]) : []);
const rows = (a: Answers, id: string): Array<Record<string, string>> => (Array.isArray(a[id]) ? (a[id] as Array<Record<string, string>>) : []);
const labelFor = (id: string, value: string, a: Answers) => questionOptions(QUESTION_BY_ID[id], a).find((o) => o.value === value)?.label ?? value;
const labelsFor = (id: string, a: Answers) => list(a, id).map((v) => labelFor(id, v, a));
const joinParts = (parts: Array<string | false | null | undefined>, sep = "\n\n") => parts.filter((p): p is string => Boolean(p && p.trim())).join(sep);

export function industryLabel(a: Answers): string {
  return INDUSTRY_OPTIONS.find((o) => o.value === s(a, "a.industry"))?.label ?? "";
}

/** Only confirmed answers feed approved knowledge; AI-suggested text must be checked first. */
export function confirmedAnswers(storedAll: StoredAnswers): Answers {
  const out: Answers = {};
  for (const [id, a] of Object.entries(effectiveStored(storedAll))) {
    if (a.skipped || a.needsConfirmation || a.value === null || a.value === undefined) continue;
    out[id] = a.value;
  }
  return out;
}

const appointmentLines = (a: Answers) =>
  rows(a, "d.appt_types").map((r) => `${r.name} (${r.minutes} min, ${labelFor_list("d.appt_types", "mode", r.mode)})`);
function labelFor_list(qid: string, fieldKey: string, value: string): string {
  const k = QUESTION_BY_ID[qid]?.kind;
  if (k?.type !== "list") return value;
  return k.fields.find((f) => f.key === fieldKey)?.options?.find((o) => o.value === value)?.label.toLowerCase() ?? value;
}

export function toRoleAnswers(a: Answers): Record<AgentRoleKey, Record<string, string>> {
  const goals = labelsFor("b.goals", a).join(", ");
  const hours = formatHours(a["d.appt_availability"] as BusinessHours) || formatHours(a["a.hours"] as BusinessHours);
  const out = {} as Record<AgentRoleKey, Record<string, string>>;
  for (const role of AGENT_ROLE_KEYS) out[role] = {};
  out.operations_manager.priorities = joinParts([goals && `Main goals: ${goals}.`, s(a, "c.company_rules")], " ");
  out.operations_manager.approval_rules = joinParts([a["c.ai_behavior"] && `Preferred autonomy: ${labelFor("c.ai_behavior", s(a, "c.ai_behavior"), a)}.`, s(a, "d.handoff_rules")], " ");
  out.lead_hunter.targets = joinParts([s(a, "b.ideal_customer"), s(a, "b.ag_target_clients"), s(a, "a.target_customers")], " ");
  out.lead_hunter.qualification = joinParts([s(a, "b.qualification"), s(a, "a.territories") && `Service areas: ${s(a, "a.territories")}`], " ");
  out.appointment_setter.meeting_types = appointmentLines(a).join("; ") || (wantsAppointments(a) ? "" : "Appointment booking is not enabled; hand booking requests to a person.");
  out.appointment_setter.hours = joinParts([hours && `Bookable ${hours}.`, a["d.appt_notice"] && `Minimum notice: ${labelFor("d.appt_notice", s(a, "d.appt_notice"), a)}.`, s(a, "d.appt_cancellation")], " ");
  out.sales_assistant.offers = joinParts([s(a, "b.services"), s(a, "d.pricing_info")], " ");
  out.sales_assistant.approach = joinParts([s(a, "d.sales_process"), a["d.followup"] && `Follow-up style: ${labelFor("d.followup", s(a, "d.followup"), a)}.`, a["d.discount_rules"] && `Discounts: ${labelFor("d.discount_rules", s(a, "d.discount_rules"), a)}.`], " ");
  out.crm_manager.important_info = s(a, "d.handoff_requirements");
  out.crm_manager.stages = joinParts([a["b.sales_model"] && `Sales model: ${labelFor("b.sales_model", s(a, "b.sales_model"), a)}.`, s(a, "d.sales_process")], " ");
  out.performance_analyst.results = joinParts([goals && `Goals: ${goals}.`, a["b.lead_target"] && `Monthly lead target: ${labelFor("b.lead_target", s(a, "b.lead_target"), a)}.`], " ");
  out.performance_analyst.metrics = "Leads, qualified leads, appointments booked, response time and conversions from recorded data.";
  for (const role of AGENT_ROLE_KEYS) {
    for (const key of Object.keys(out[role])) {
      const allowed = AGENT_BY_KEY[role].questions.some((q) => q.id === key);
      if (!allowed || !out[role][key].trim()) delete out[role][key];
    }
  }
  return out;
}

/** Maps the flat answers onto the structure the configuration compiler already understands. */
export function toLegacyData(a: Answers, enabledRoles: AgentRoleKey[]): OnboardingData {
  const tone = TONES.includes(s(a, "c.tone") as Tone) ? (s(a, "c.tone") as Tone) : "friendly";
  const replyLength = (["concise", "balanced", "detailed"] as const).includes(s(a, "c.reply_length") as ReplyLength) ? (s(a, "c.reply_length") as ReplyLength) : "concise";
  const language = (LANGUAGES as readonly string[]).includes(s(a, "c.language")) ? (s(a, "c.language") as (typeof LANGUAGES)[number]) : "English";
  const topics = labelsFor("c.sensitive_topics", a);
  const escalations = labelsFor("c.human_escalation", a).map((l) => l.toLowerCase());
  const answers = toRoleAnswers(a);
  return {
    business: {
      companyName: s(a, "a.business_name"),
      description: s(a, "a.description"),
      industry: industryLabel(a),
      website: s(a, "a.website"),
      operatingArea: joinParts([s(a, "a.territories"), s(a, "a.location")], " · "),
      services: s(a, "b.services"),
      idealCustomers: joinParts([s(a, "b.ideal_customer"), s(a, "a.target_customers")], "\n"),
    },
    goals: { selected: list(a, "b.goals"), other: s(a, "b.goal_other") },
    communication: {
      tone,
      replyLength,
      language,
      companyRules: s(a, "c.company_rules"),
      neverPromise: joinParts([s(a, "c.never_promise"), topics.length ? `Never answer without a person: ${topics.join(", ")}.` : ""], " "),
      escalateWhen: joinParts([escalations.length ? `Hand off when ${escalations.join(", ")}.` : "", s(a, "d.handoff_rules")], " ").slice(0, 600),
    },
    workforce: { selected: enabledRoles, answers: Object.fromEntries(enabledRoles.map((r) => [r, answers[r]])) },
  };
}

/** Knowledge Center sections seeded from confirmed answers. Existing text written there is never overwritten. */
export function toKnowledgeSections(a: Answers): Array<{ section: string; content: string }> {
  const faqs = rows(a, "e.faqs").map((r) => `Q: ${r.question}\nA: ${r.answer}`).join("\n\n");
  const pricing = a["d.pricing_policy"] === "never" ? "Do not share prices. Hand pricing questions to a person." : joinParts([s(a, "d.pricing_info"), a["d.discount_rules"] && `Discounts: ${labelFor("d.discount_rules", s(a, "d.discount_rules"), a)}.`], " ");
  const out = [
    { section: "business_description", content: s(a, "a.description") },
    { section: "products_services", content: joinParts([s(a, "b.services"), s(a, "e.products")]) },
    { section: "faq", content: faqs },
    { section: "approved_pricing", content: pricing },
    { section: "business_hours", content: joinParts([formatHours(a["a.hours"] as BusinessHours), s(a, "a.timezone") && `Time zone: ${s(a, "a.timezone")}`], " · ") },
    { section: "policies", content: joinParts([s(a, "e.policies"), s(a, "d.appt_cancellation")]) },
    { section: "customer_service", content: joinParts([s(a, "e.support_info"), s(a, "a.contact_phone") && `Phone: ${s(a, "a.contact_phone")}`, s(a, "a.contact_email") && `Email: ${s(a, "a.contact_email")}`], "\n") },
    { section: "brand_voice", content: joinParts([a["c.tone"] && `Tone: ${labelFor("c.tone", s(a, "c.tone"), a)}.`, s(a, "c.company_rules")], " ") },
    { section: "escalation", content: joinParts([labelsFor("c.human_escalation", a).length ? `Hand off to a person when: ${labelsFor("c.human_escalation", a).join(", ")}.` : "", s(a, "d.handoff_rules")], " ") },
  ];
  return out.filter((x) => x.content.trim()).map((x) => ({ section: x.section, content: x.content.slice(0, 12000) }));
}

/** Operating preferences copied into messaging settings. These configure; they never enable sending. */
export function toMessagingPreferences(a: Answers): { businessHours: BusinessHours | null; replyBusinessHoursOnly: boolean; followupPreset: "gentle" | "balanced" | "persistent" | "off" } {
  const hours = validateBusinessHours(a["a.hours"]);
  const preset = s(a, "d.followup");
  return {
    businessHours: hours && Object.keys(hours).length ? hours : null,
    replyBusinessHoursOnly: s(a, "c.response_hours") === "business_hours",
    followupPreset: preset === "gentle" || preset === "persistent" || preset === "off" ? preset : "balanced",
  };
}

// ---------------------------------------------------------------------------
// Review model
// ---------------------------------------------------------------------------

/** Real, verified facts about the workspace's connections, supplied by the server. */
export interface ConnectionFacts {
  crmLinked: boolean;
  aiEmployeesVerified: number;
  aiEmployeesTotal: number;
  automationMapped: boolean;
  channels: Record<"sms" | "whatsapp" | "email", { enabled: boolean; registration: string }>;
  calendarConnected: boolean;
  websiteDomainVerified: boolean;
  invitedStaff: number;
}

export interface ReviewRow {
  questionId: string;
  label: string;
  value: string;
  required: boolean;
  state: QuestionState;
  source: StoredAnswer["source"] | null;
}
export interface ReviewModel {
  sections: Array<{ id: SectionId; title: string; rows: ReviewRow[] }>;
  employees: Array<{ role: AgentRoleKey; name: string; tagline: string; configuredFrom: string[]; gaps: string[] }>;
  messaging: Array<{ label: string; value: string }>;
  permissions: string[];
  missingConnections: Array<{ key: string; label: string; why: string }>;
  humanTasks: Array<{ key: string; label: string; owner: "you" | "iacquire" }>;
  blockers: string[];
  canSubmit: boolean;
}

export function buildReviewModel(storedAll: StoredAnswers, facts: ConnectionFacts, enabledRoles: AgentRoleKey[]): ReviewModel {
  const stored = effectiveStored(storedAll);
  const a = answersOf(stored);
  const visible = visibleQuestions(a);
  const sections = ONBOARDING_SECTIONS.filter((sec) => sec.id !== "F").map((sec) => ({
    id: sec.id,
    title: sec.title,
    rows: visible
      .filter((q) => q.section === sec.id)
      .map((q) => {
        const st = stored[q.id];
        return {
          questionId: q.id,
          label: q.reviewLabel ?? q.title,
          value: st && !st.skipped ? describeValue(q, st.value, a) : "",
          required: Boolean(q.required),
          state: questionState(q, st),
          source: st?.source ?? null,
        } satisfies ReviewRow;
      }),
  }));

  const roleAnswers = toRoleAnswers(confirmedAnswers(stored));
  const employees = enabledRoles.map((role) => {
    const configuredFrom = Object.keys(roleAnswers[role]).map((id) => AGENT_BY_KEY[role].questions.find((q) => q.id === id)?.label ?? id);
    const gaps: string[] = [];
    if (role === "appointment_setter" && !wantsAppointments(a)) gaps.push("Booking is off, so booking requests go to a person.");
    if (role === "appointment_setter" && wantsAppointments(a) && !rows(a, "d.appt_types").length) gaps.push("No appointment types yet — it can't offer bookings until you add some.");
    if (role === "sales_assistant" && !s(a, "d.pricing_info") && a["d.pricing_policy"] !== "never") gaps.push("No approved prices, so it will pass pricing questions to a person.");
    if (role === "lead_hunter" && !s(a, "b.ideal_customer")) gaps.push("No ideal-customer description, so research stays broad.");
    return { role, name: AGENT_BY_KEY[role].name, tagline: AGENT_BY_KEY[role].tagline, configuredFrom, gaps };
  });

  const wanted = channelsOf(a);
  const messaging = [
    { label: "Channels you want", value: wanted.length ? wanted.map((c) => ({ sms: "SMS", whatsapp: "WhatsApp", email: "Email" }[c] ?? c)).join(", ") : "None yet" },
    { label: "Replies", value: s(a, "c.response_hours") === "business_hours" ? "Business hours only" : "Any time, within quiet hours" },
    { label: "Customer-facing identity", value: "Every message identifies itself as an AI assistant for your business." },
    { label: "Follow-ups", value: a["d.followup"] ? labelFor("d.followup", s(a, "d.followup"), a) : "Balanced (default)" },
    { label: "Opt-outs", value: "STOP and similar replies stop messaging immediately, on every channel." },
    { label: "Automatic replies", value: "Off until you switch them on and each channel's sender is verified." },
  ];

  const permissions = [
    "Read and update contacts, pipelines and opportunities in your CRM location, once iAcquire has linked and verified it.",
    "Read your appointment calendar to offer real availability. Nothing is booked from a guessed time.",
    "Reply to customers as an AI assistant only on channels you enable, and only after you turn automatic replies on.",
    "Create staff hand-offs. Your owner is notified first; other eligible staff are informed.",
    ...(wantsWebsite(a) ? ["Prepare a website draft. Nothing is published until you approve it."] : []),
    ...(wanted.length ? ["Use prepaid service credits for metered messages and AI usage, within the spending limit you set."] : []),
  ];

  const missingConnections: ReviewModel["missingConnections"] = [];
  if (!facts.crmLinked) missingConnections.push({ key: "crm", label: "CRM location not linked", why: "iAcquire links your CRM location after you submit. Contacts and pipelines sync only after it is verified." });
  if (facts.aiEmployeesVerified < facts.aiEmployeesTotal) missingConnections.push({ key: "ai", label: `AI employees not yet online (${facts.aiEmployeesVerified}/${facts.aiEmployeesTotal})`, why: "Each employee goes online only after a live connection check passes." });
  if (!facts.automationMapped) missingConnections.push({ key: "automation", label: "Automation not set up", why: "iAcquire connects approved workflows to your workspace. They stay inactive until tested." });
  for (const ch of wanted as Array<"sms" | "whatsapp" | "email">) {
    if (ch in facts.channels && !facts.channels[ch].enabled) {
      missingConnections.push({ key: `channel:${ch}`, label: `${{ sms: "SMS", whatsapp: "WhatsApp", email: "Email" }[ch]} sender not verified`, why: ch === "email" ? "Verify your sending address or domain before email can be sent." : "A registered, verified sender is required before messages can be sent." });
    }
  }
  if (wantsAppointments(a) && !facts.calendarConnected) missingConnections.push({ key: "calendar", label: "Calendar not connected", why: "Connect a calendar so appointment times come from real availability." });

  const humanTasks: ReviewModel["humanTasks"] = [];
  const team = rows(a, "d.team");
  if (team.length && facts.invitedStaff < team.length) humanTasks.push({ key: "invite", label: `Review and send invitations to ${team.length} team member${team.length === 1 ? "" : "s"}`, owner: "you" });
  if (!a["e.logo"] || isEmptyValue(a["e.logo"])) humanTasks.push({ key: "logo", label: "Upload your logo (optional, helps your website and pages)", owner: "you" });
  if (wanted.length) humanTasks.push({ key: "senders", label: "Approve any sender registration or number fees we disclose", owner: "you" });
  if (wantsWebsite(a)) humanTasks.push({ key: "website", label: "Review and approve your website draft before it is published", owner: "you" });
  humanTasks.push({ key: "crm", label: "Link your CRM location and apply the iAcquire master snapshot", owner: "iacquire" });
  humanTasks.push({ key: "profiles", label: "Create and verify your six AI employees", owner: "iacquire" });
  humanTasks.push({ key: "test", label: "Run safe tests before anything customer-facing is activated", owner: "iacquire" });

  const check = submitCheck(storedAll);
  return { sections, employees, messaging, permissions, missingConnections, humanTasks, blockers: check.blockers, canSubmit: check.canSubmit };
}

// ---------------------------------------------------------------------------
// Prefill from what the workspace already knows (previous onboarding or profile)
// ---------------------------------------------------------------------------

export function legacyToAnswers(data: Partial<OnboardingData> | null | undefined): Answers {
  const out: Answers = {};
  const b = data?.business;
  if (b?.companyName) out["a.business_name"] = b.companyName;
  if (b?.description) out["a.description"] = b.description;
  const industry = INDUSTRY_OPTIONS.find((o) => o.label.toLowerCase() === (b?.industry ?? "").toLowerCase())?.value;
  if (industry) out["a.industry"] = industry;
  if (b?.website) out["a.website"] = b.website;
  if (b?.operatingArea) out["a.territories"] = b.operatingArea;
  if (b?.services) out["b.services"] = b.services;
  if (b?.idealCustomers) out["b.ideal_customer"] = b.idealCustomers;
  if (data?.goals?.selected?.length) out["b.goals"] = data.goals.selected;
  if (data?.goals?.other) out["b.goal_other"] = data.goals.other;
  const c = data?.communication;
  if (c) {
    if (c.tone) out["c.tone"] = c.tone;
    if (c.replyLength) out["c.reply_length"] = c.replyLength;
    if (c.language) out["c.language"] = c.language;
    if (c.companyRules) out["c.company_rules"] = c.companyRules;
    if (c.neverPromise) out["c.never_promise"] = c.neverPromise;
  }
  return out;
}

export { WEEKDAYS };
