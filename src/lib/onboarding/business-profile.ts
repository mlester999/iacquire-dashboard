// The business profile has two editors: the onboarding questionnaire and Settings > Business profile. Both write the same columns (src/server/settings/service.ts
// writeBusinessProfile), so they must not undo each other. These are the pure rules for that:
//   - what the questionnaire answers say about the business (deriveProfile);
//   - which of those facts a re-submission may write: only the ones whose answers changed since the last submission (the snapshot kept on onboarding_responses), so a
//     later Settings edit is not silently reverted by an unrelated change of answers;
//   - what a Settings edit means for the answers, so the questionnaire shows the same facts and nobody is asked twice (answerPatchesFor).
// No I/O, no node modules: the screens import the same file.
import { INDUSTRY_OPTIONS, QUESTION_BY_ID } from "./definitions";
import { toLegacyData, validateAnswer } from "./engine";
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
}

export function buildSnapshot(derived: ProfileValues, at: Date): ProfileSnapshot {
  return { version: 1, fields: { ...derived }, appliedThrough: at.toISOString() };
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
  return { version: 1, fields, appliedThrough: at };
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
  return { version: 1, fields, appliedThrough: opts.advanceTo ? opts.advanceTo.toISOString() : prior?.appliedThrough ?? null };
}
