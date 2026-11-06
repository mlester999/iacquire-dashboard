// The business profile has two editors: the onboarding questionnaire and Settings > Business profile. Both write the same columns (src/server/settings/service.ts
// writeBusinessProfile), so they must not undo each other. These are the pure rules for that:
//   - what the questionnaire answers say about the business (deriveProfile);
//   - which of those facts a re-submission may write: only the ones whose answers changed since the last submission (the snapshot kept on onboarding_responses), so a
//     later Settings edit is not silently reverted by an unrelated change of answers;
//   - what a Settings edit means for the answers, so the questionnaire shows the same facts and nobody is asked twice (answerPatchesFor).
// The messaging settings (reply hours, opening hours, follow-up style) and the company-wide AI preferences are two more places with a second editor, and follow the same rules
// (the sections below the profile ones). Last, what a re-submission says about what it did and did not apply (buildOutcomeNotes).
// No I/O, no node modules: the screens import the same file.
import { WEEKDAYS, type BusinessHours } from "@/lib/messaging";
import { INDUSTRY_OPTIONS, QUESTION_BY_ID } from "./definitions";
import { toLegacyData, toMessagingPreferences, validateAnswer } from "./engine";
import type { AnswerValue, Answers } from "./types";

export const PROFILE_KEYS = ["name", "industry", "website", "region", "timezone", "description", "services", "idealCustomers", "brandColor"] as const;
export type ProfileKey = (typeof PROFILE_KEYS)[number];
export type ProfileValues = Record<ProfileKey, string>;

/** The longest each fact may be once stored: the columns of organizations and company_profiles. */
export const PROFILE_LIMITS: Record<ProfileKey, number> = {
  name: 120, industry: 120, website: 300, region: 1000, timezone: 64, description: 4000, services: 4000, idealCustomers: 4000, brandColor: 7,
};

/** Which questionnaire answers each fact comes from. The region and the ideal customers are the join of two answers each (src/lib/onboarding/engine.ts toLegacyData). */
export const PROFILE_ANSWERS: Record<ProfileKey, readonly string[]> = {
  name: ["a.business_name"],
  industry: ["a.industry"],
  website: ["a.website"],
  region: ["a.territories", "a.location"],
  timezone: ["a.timezone"],
  description: ["a.description"],
  services: ["b.services"],
  idealCustomers: ["b.ideal_customer", "a.target_customers"],
  brandColor: ["e.brand_colors"],
};

/** A blank time zone or colour in the questionnaire means "keep what the workspace has", never "clear it". */
const KEEP_WHEN_BLANK: ReadonlySet<ProfileKey> = new Set(["timezone", "brandColor"]);

/** What the confirmed answers say about the business, as the same strings onboarding has always written. */
export function deriveProfile(a: Answers): ProfileValues {
  const b = toLegacyData(a, []).business;
  const tz = a["a.timezone"];
  const colors = a["e.brand_colors"] as { primary?: string } | undefined;
  return {
    name: b.companyName,
    industry: b.industry,
    website: b.website,
    region: b.operatingArea,
    timezone: typeof tz === "string" ? tz : "",
    description: b.description,
    services: b.services,
    idealCustomers: b.idealCustomers,
    brandColor: typeof colors?.primary === "string" ? colors.primary : "",
  };
}

// ---------------------------------------------------------------------------
// The snapshot of the last submission
// ---------------------------------------------------------------------------

export interface ProfileSnapshot {
  version: 1;
  /** The derived value of each fact when it was last known to be applied. A fact missing here is unknown, and counts as changed. */
  fields: Partial<ProfileValues>;
  /** The moment up to which answer edits are known to be reflected in the live workspace: the last submission, or a later Settings edit with nothing waiting. */
  appliedThrough: string | null;
  /** The same, for the messaging values. A snapshot written before they were kept has none: a re-submission then falls back to the answers' edit times (baselineOf). */
  messaging?: Partial<MessagingValues>;
  /** The same, for the company-wide AI preferences. */
  prefs?: Partial<PreferenceValues>;
}

export function buildSnapshot(derived: ProfileValues, at: Date, extra: { messaging?: MessagingValues; prefs?: PreferenceValues } = {}): ProfileSnapshot {
  return { version: 1, fields: { ...derived }, appliedThrough: at.toISOString(), ...(extra.messaging ? { messaging: { ...extra.messaging } } : {}), ...(extra.prefs ? { prefs: { ...extra.prefs } } : {}) };
}

function stringsOf<K extends string>(raw: unknown, keys: readonly K[]): Partial<Record<K, string>> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Partial<Record<K, string>> = {};
  for (const key of keys) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v === "string") out[key] = v;
  }
  return out;
}

/** Reads a stored snapshot. Anything that is not exactly what buildSnapshot writes reads as no snapshot, so a bad row can only make a re-submission cautious. */
export function parseProfileSnapshot(raw: unknown): ProfileSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.version !== 1 || !o.fields || typeof o.fields !== "object" || Array.isArray(o.fields)) return null;
  const fields: Partial<ProfileValues> = {};
  for (const key of PROFILE_KEYS) {
    const v = (o.fields as Record<string, unknown>)[key];
    if (typeof v === "string") fields[key] = v;
  }
  const at = typeof o.appliedThrough === "string" && Number.isFinite(Date.parse(o.appliedThrough)) ? new Date(o.appliedThrough).toISOString() : null;
  const messaging = stringsOf(o.messaging, MESSAGING_KEYS);
  const prefs = stringsOf(o.prefs, PREFERENCE_KEYS);
  return { version: 1, fields, appliedThrough: at, ...(messaging ? { messaging } : {}), ...(prefs ? { prefs } : {}) };
}

/**
 * The baseline of a workspace that was submitted before snapshots existed: a fact counts as unchanged unless one of its answers was edited AFTER the submission.
 * `answerTimes` are the answers' last-edit times (milliseconds); an edit at the same instant as the submission is part of it.
 */
export function legacyBaseline(derived: ProfileValues, answerTimes: Record<string, number>, submittedAt: number): Partial<ProfileValues> {
  const out: Partial<ProfileValues> = {};
  for (const key of PROFILE_KEYS) if (!PROFILE_ANSWERS[key].some((id) => (answerTimes[id] ?? 0) > submittedAt)) out[key] = derived[key];
  return out;
}

/**
 * The facts a submission may write. With no baseline (the first submission) every fact the answers give; with one, only the facts whose derived value differs from it.
 * A blank time zone or colour is never written (the workspace keeps its own).
 */
export function fieldsToWrite(derived: ProfileValues, baseline: Partial<ProfileValues> | null): Partial<ProfileValues> {
  const out: Partial<ProfileValues> = {};
  for (const key of PROFILE_KEYS) {
    if (KEEP_WHEN_BLANK.has(key) && derived[key] === "") continue;
    if (baseline && baseline[key] === derived[key]) continue;
    out[key] = derived[key];
  }
  return out;
}

// ---------------------------------------------------------------------------
// A Settings edit, seen from the questionnaire
// ---------------------------------------------------------------------------

const industryValue = (text: string): string | null => {
  const t = text.trim().toLowerCase();
  return INDUSTRY_OPTIONS.find((o) => o.label.toLowerCase() === t || o.value === t)?.value ?? null;
};

/**
 * The answers a Settings edit of these facts corresponds to. An answer is only set when the Settings text can be that answer exactly: a text that is longer than the
 * question allows, an industry that is none of the listed ones, a web address or time zone that does not validate are left out (the live profile keeps what Settings
 * wrote, and the snapshot rule stops a re-submission from undoing it). Every value goes through the same validation as a typed answer.
 */
export function answerPatchesFor(changed: readonly ProfileKey[], values: ProfileValues, current: Answers): Array<{ id: string; value: AnswerValue }> {
  const out: Array<{ id: string; value: AnswerValue }> = [];
  const put = (id: string, raw: AnswerValue) => {
    const q = QUESTION_BY_ID[id];
    const k = q.kind;
    if ((k.type === "text" || k.type === "longtext") && typeof raw === "string" && raw.trim().length > k.max) return;
    const checked = validateAnswer(q, raw, current);
    if (checked.ok) out.push({ id, value: checked.value });
  };
  for (const key of changed) {
    const v = values[key];
    switch (key) {
      case "name": put("a.business_name", v); break;
      case "industry": {
        const option = industryValue(v);
        if (option) put("a.industry", option);
        break;
      }
      case "website": put("a.website", v); break;
      case "region": put("a.territories", v); break;
      case "timezone": put("a.timezone", v); break;
      case "description": put("a.description", v); break;
      case "services": put("b.services", v); break;
      case "idealCustomers": put("b.ideal_customer", v); break;
      case "brandColor": {
        const accent = (current["e.brand_colors"] as { accent?: string } | undefined)?.accent ?? "";
        put("e.brand_colors", { primary: v, accent });
        break;
      }
    }
  }
  return out;
}

/**
 * The snapshot after a Settings edit: the changed facts now stand for what the answers say, so a re-submission with those answers writes nothing and the Settings text
 * survives. `advanceTo` moves the applied-through moment forward when nothing else was waiting in the questionnaire (null leaves it where it was).
 */
export function snapshotAfterSettings(prior: ProfileSnapshot | null, after: ProfileValues, changed: readonly ProfileKey[], opts: { advanceTo: Date | null }): ProfileSnapshot {
  const fields: Partial<ProfileValues> = { ...(prior?.fields ?? {}) };
  for (const key of changed) fields[key] = after[key];
  return {
    version: 1,
    fields,
    appliedThrough: opts.advanceTo ? opts.advanceTo.toISOString() : prior?.appliedThrough ?? null,
    ...(prior?.messaging ? { messaging: prior.messaging } : {}),
    ...(prior?.prefs ? { prefs: prior.prefs } : {}),
  };
}

// ---------------------------------------------------------------------------
// Messaging settings and company-wide AI preferences: the same two-editor rule
// ---------------------------------------------------------------------------

export const MESSAGING_KEYS = ["hours", "replyHours", "followup"] as const;
export type MessagingKey = (typeof MESSAGING_KEYS)[number];
export type MessagingValues = Record<MessagingKey, string>;

/** Which questionnaire answers each messaging value comes from (opening hours, "when may your AI reply", follow-up style). */
export const MESSAGING_ANSWERS: Record<MessagingKey, readonly string[]> = { hours: ["a.hours"], replyHours: ["c.response_hours"], followup: ["d.followup"] };

export const PREFERENCE_KEYS = ["tone", "replyLength", "language", "companyRules", "neverPromise", "escalateWhen"] as const;
export type PreferenceKey = (typeof PREFERENCE_KEYS)[number];
export type PreferenceValues = Record<PreferenceKey, string>;

/** The never-promise and hand-off preferences are joined from more than one answer (the topics and situations picked from lists), so a change to any of them counts. */
export const PREFERENCE_ANSWERS: Record<PreferenceKey, readonly string[]> = {
  tone: ["c.tone"],
  replyLength: ["c.reply_length"],
  language: ["c.language"],
  companyRules: ["c.company_rules"],
  neverPromise: ["c.never_promise", "c.sensitive_topics"],
  escalateWhen: ["c.human_escalation", "d.handoff_rules"],
};

/** Opening hours as one comparable string: the weekdays in a fixed order, no days that hold no range. Empty when nothing is set. */
export function hoursKey(hours: BusinessHours | null | undefined): string {
  if (!hours) return "";
  const days = WEEKDAYS.filter((day) => hours[day]?.length).map((day) => [day, hours[day]]);
  return days.length ? JSON.stringify(days) : "";
}

/** What the answers say about the messaging settings, as the strings a snapshot keeps (the same reading onboarding writes into messaging_settings). */
export function deriveMessaging(a: Answers): MessagingValues {
  const p = toMessagingPreferences(a);
  return { hours: hoursKey(p.businessHours), replyHours: p.replyBusinessHoursOnly ? "business_hours" : "always", followup: p.followupPreset };
}

/** What the answers say about the company-wide AI preferences, as onboarding writes them into ai_preferences. */
export function derivePreferences(a: Answers): PreferenceValues {
  const c = toLegacyData(a, []).communication;
  return { tone: c.tone, replyLength: c.replyLength, language: c.language, companyRules: c.companyRules, neverPromise: c.neverPromise, escalateWhen: c.escalateWhen };
}

/**
 * What a submission already applied, key by key: the value the last snapshot kept, or for a key the snapshot does not hold (a workspace submitted before it was kept, or a
 * snapshot that a Settings edit created) the value the answers say now when none of its answers was edited after the submission.
 */
export function baselineOf<K extends string>(
  keys: readonly K[],
  answerIds: Record<K, readonly string[]>,
  derived: Record<K, string>,
  stored: Partial<Record<K, string>> | undefined,
  answerTimes: Record<string, number>,
  submittedAt: number,
): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  for (const key of keys) {
    const kept = stored?.[key];
    if (typeof kept === "string") out[key] = kept;
    else if (!answerIds[key].some((id) => (answerTimes[id] ?? 0) > submittedAt)) out[key] = derived[key];
  }
  return out;
}

/** The keys a submission may write: all of them on the first submission (no baseline), afterwards only those whose answers changed since the baseline. */
export function keysToWrite<K extends string>(keys: readonly K[], derived: Record<K, string>, baseline: Partial<Record<K, string>> | null): K[] {
  return keys.filter((key) => !baseline || baseline[key] !== derived[key]);
}

type AnswerPatch<K extends string> = { id: string; value: AnswerValue; key: K };

/** One answer, set only when the value is exactly what that question accepts (a longer text, or an option that does not exist, is left out). */
function patcher(current: Answers) {
  return <K extends string>(out: Array<AnswerPatch<K>>, key: K, id: string, raw: AnswerValue) => {
    const q = QUESTION_BY_ID[id];
    const k = q.kind;
    if ((k.type === "text" || k.type === "longtext") && typeof raw === "string" && raw.trim().length > k.max) return;
    const checked = validateAnswer(q, raw, current);
    if (checked.ok) out.push({ id, value: checked.value, key });
  };
}

/**
 * The answers a Settings > Messaging edit corresponds to. Only what the edit named; a custom follow-up schedule has no answer and is left to the settings alone (the snapshot
 * rule then stops a re-submission from undoing it).
 */
export function messagingAnswerPatches(input: { businessHours?: BusinessHours; replyBusinessHoursOnly?: boolean; followUpPreset?: string }, current: Answers): Array<AnswerPatch<MessagingKey>> {
  const out: Array<AnswerPatch<MessagingKey>> = [];
  const put = patcher(current);
  if (input.businessHours !== undefined) put(out, "hours", "a.hours", input.businessHours);
  if (input.replyBusinessHoursOnly !== undefined) put(out, "replyHours", "c.response_hours", input.replyBusinessHoursOnly ? "business_hours" : "always");
  if (input.followUpPreset !== undefined && ["gentle", "balanced", "persistent", "off"].includes(input.followUpPreset)) put(out, "followup", "d.followup", input.followUpPreset);
  return out;
}

/** What the never-promise answer is once the line the topics add is taken off a text written in Settings (the answers join that line on by themselves). */
function neverPromiseAnswer(text: string, current: Answers): string {
  const joined = toLegacyData({ ...current, "c.never_promise": "" }, []).communication.neverPromise;
  const topics = joined.trim();
  const t = text.trim();
  if (!topics) return t;
  if (t === topics) return "";
  if (t.endsWith(topics)) return t.slice(0, t.length - topics.length).trim();
  return t;
}

/**
 * The answers a Settings > AI preferences edit of these preferences corresponds to. The hand-off preference is built from picked situations and cannot be written back, so it has
 * no answer. A value that is not exactly one of the question's options or limits is left out.
 */
export function preferenceAnswerPatches(changed: readonly PreferenceKey[], values: PreferenceValues, current: Answers): Array<AnswerPatch<PreferenceKey>> {
  const out: Array<AnswerPatch<PreferenceKey>> = [];
  const put = patcher(current);
  for (const key of changed) {
    switch (key) {
      case "tone": put(out, key, "c.tone", values.tone); break;
      case "replyLength": put(out, key, "c.reply_length", values.replyLength); break;
      case "language": put(out, key, "c.language", values.language); break;
      case "companyRules": put(out, key, "c.company_rules", values.companyRules); break;
      case "neverPromise": put(out, key, "c.never_promise", neverPromiseAnswer(values.neverPromise, current)); break;
      case "escalateWhen": break;
    }
  }
  return out;
}

/** The snapshot after a Settings edit of messaging values or preferences: those keys now stand for what the answers say. */
export function snapshotWithExtras(
  prior: ProfileSnapshot,
  extra: { messaging?: Partial<MessagingValues>; prefs?: Partial<PreferenceValues> },
  opts: { advanceTo: Date | null },
): ProfileSnapshot {
  const messaging = { ...(prior.messaging ?? {}), ...(extra.messaging ?? {}) };
  const prefs = { ...(prior.prefs ?? {}), ...(extra.prefs ?? {}) };
  return {
    ...prior,
    appliedThrough: opts.advanceTo ? opts.advanceTo.toISOString() : prior.appliedThrough,
    ...(Object.keys(messaging).length ? { messaging } : {}),
    ...(Object.keys(prefs).length ? { prefs } : {}),
  };
}

// ---------------------------------------------------------------------------
// What a Settings save says it did to the employees
// ---------------------------------------------------------------------------

/** The sentence about the employees after a business-information save, never reporting a version that is waiting for review as applied. Empty when nothing was said. */
export function employeeUpdateMessage(r: { updated: number; held: number; failed?: boolean }): string {
  const parts: string[] = [];
  if (r.updated > 0) parts.push(`${r.updated} retained profile${r.updated === 1 ? "" : "s"} updated.`);
  if (r.held > 0) parts.push(`${r.held} profile update${r.held === 1 ? " is" : "s are"} waiting for iAcquire's review.`);
  if (r.failed) parts.push("Your retained profiles could not be updated yet. They keep their current settings until the update succeeds.");
  return parts.join(" ");
}

/** The sentence after a company-wide apply, with the unified partner distinguished from retained profiles. */
export function aiPreferencesApplyMessage(r: {
  updated: number; held: number; keptOwn: number; blocked: number;
  growthPartnerUpdated?: boolean; growthPartnerHeld?: boolean; growthPartnerKeptOwn?: boolean; growthPartnerBlocked?: boolean;
}): string {
  const parts: string[] = [];
  const target = (count: number, includesPartner = false) => {
    const profiles = count - Number(includesPartner);
    if (includesPartner && profiles > 0) return `your AI Growth Partner and ${profiles} retained profile${profiles === 1 ? "" : "s"}`;
    if (includesPartner) return "your AI Growth Partner";
    return `${count} retained profile${count === 1 ? "" : "s"}`;
  };
  if (r.updated > 0) parts.push(`Applied to ${target(r.updated, r.growthPartnerUpdated)}.`);
  if (r.held > 0) parts.push(r.growthPartnerHeld
    ? r.held === 1
      ? "An update for your AI Growth Partner is waiting for iAcquire's review."
      : `Updates for ${target(r.held, true)} are waiting for iAcquire's review.`
    : `${r.held} update${r.held === 1 ? " is" : "s are"} waiting for iAcquire's review.`);
  if (r.keptOwn > 0) parts.push(r.growthPartnerKeptOwn
    ? `Some wording was kept on ${target(r.keptOwn, true)}.`
    : `${r.keptOwn} retained profile${r.keptOwn === 1 ? " kept its" : "s kept their"} own wording for some fields.`);
  if (r.blocked > 0) parts.push(r.growthPartnerBlocked
    ? `Could not update ${target(r.blocked, true)}.`
    : `${r.blocked} retained profile${r.blocked === 1 ? "" : "s"} could not be updated.`);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// What a re-submission did and did not apply
// ---------------------------------------------------------------------------

export interface OutcomeNote {
  key: string;
  message: string;
}

const SECTION_LABELS: Record<string, string> = {
  business_description: "Business description",
  products_services: "Products and services",
  faq: "FAQ",
  approved_pricing: "Pricing",
  business_hours: "Business hours",
  policies: "Policies",
  customer_service: "Customer service",
  brand_voice: "Brand voice",
  escalation: "Hand-offs",
};
const FACT_LABELS: Record<ProfileKey, string> = {
  name: "company name", industry: "industry", website: "website", region: "where you operate", timezone: "time zone", description: "business description",
  services: "products and services", idealCustomers: "ideal customers", brandColor: "brand colour",
};
const MESSAGING_LABELS: Record<MessagingKey, string> = { hours: "opening hours", replyHours: "reply hours", followup: "follow-up style" };
const PREFERENCE_LABELS: Record<PreferenceKey, string> = {
  tone: "tone", replyLength: "reply length", language: "language", companyRules: "company rules", neverPromise: "never promise", escalateWhen: "when to ask a human",
};

const list = (labels: string[]) => (labels.length < 3 ? labels.join(" and ") : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`);

/**
 * The plain-words notes for a submission: what was kept as someone wrote it, what is waiting for review, what was left alone and why, and what was already as the answers say.
 * Pure. A first submission has nothing to keep or compare, so it says only what is waiting or skipped.
 */
export function buildOutcomeNotes(i: {
  reSubmission: boolean;
  /** Nothing had changed since the last submission, so nothing was done. */
  quiet?: boolean;
  knowledgeKept: readonly string[];
  employees: ReadonlyArray<{ configStatus: string }>;
  scheduling: { state: string; reason?: string; drift?: readonly string[] };
  wantsAppointments: boolean;
  targetingKept: boolean;
  /** Facts, messaging values and preferences a submission did not write because their answers had not changed, although what the workspace holds now differs from the answers. */
  leftAsEdited: { profile: readonly ProfileKey[]; messaging: readonly MessagingKey[]; preferences: readonly PreferenceKey[] };
}): OutcomeNote[] {
  const notes: OutcomeNote[] = [];
  if (i.quiet) return [{ key: "nothing.changed", message: "Nothing changed since your last submission, so nothing was updated." }];
  if (i.knowledgeKept.length) {
    const names = i.knowledgeKept.map((s) => SECTION_LABELS[s] ?? s.replaceAll("_", " "));
    notes.push({ key: "knowledge.kept", message: `We kept your own wording in ${list(names)}.` });
  }
  const held = i.employees.filter((e) => e.configStatus === "pending_agency_review").length;
  if (held) notes.push({ key: "employees.held", message: `${held} employee update${held === 1 ? " is" : "s are"} waiting for iAcquire's review. Until then, ${held === 1 ? "that employee keeps" : "those employees keep"} the setup already approved.` });
  const unchanged = i.employees.filter((e) => e.configStatus === "unchanged").length;
  if (i.reSubmission && unchanged && unchanged < i.employees.length) notes.push({ key: "employees.unchanged", message: `${unchanged} employee${unchanged === 1 ? " was" : "s were"} already set up as your answers say.` });
  if (i.wantsAppointments && i.scheduling.state === "skipped" && i.scheduling.reason) notes.push({ key: "scheduling.skipped", message: i.scheduling.reason });
  if (i.scheduling.drift?.length) {
    const shown = i.scheduling.drift.slice(0, 3);
    const more = i.scheduling.drift.length - shown.length;
    notes.push({ key: "scheduling.drift", message: `${shown.join(" ")}${more > 0 ? ` ${more} more difference${more === 1 ? "" : "s"}.` : ""} Your live calendar was not changed: update it in Calendars & Types.` });
  }
  if (i.reSubmission && i.targetingKept) notes.push({ key: "targeting.kept", message: "Your lead targeting was left as it is." });
  if (i.leftAsEdited.profile.length) notes.push({ key: "profile.kept", message: `Left as edited in Settings: ${list(i.leftAsEdited.profile.map((k) => FACT_LABELS[k]))}.` });
  if (i.leftAsEdited.messaging.length) notes.push({ key: "messaging.kept", message: `Left as set in Messaging settings: ${list(i.leftAsEdited.messaging.map((k) => MESSAGING_LABELS[k]))}.` });
  if (i.leftAsEdited.preferences.length) notes.push({ key: "preferences.kept", message: `Left as set in AI preferences: ${list(i.leftAsEdited.preferences.map((k) => PREFERENCE_LABELS[k]))}.` });
  return notes;
}
