// Which iAcquire starter Blueprint fits the industry a client chose in the onboarding questionnaire. Pure: no I/O, so the same table serves the automatic CRM setup, the
// launch panel's wording and the tests.
//
// The questionnaire's industries (src/lib/onboarding/definitions.ts, keyed by VALUE: the stored label on the organization is for people, never for matching) and the starters
// (one per Blueprint industry) do not line up one to one, so every questionnaire value is mapped by hand and says how good the fit is:
//   matched   a starter written for exactly this kind of business
//   closest   the nearest starter there is (no retail starter exists, for example); the client is told which one they got
//   fallback  nothing in the answer says what the business is, so the general services starter is used
// Starter keys are never typed here: they are read from STARTER_BLUEPRINTS by industry, so renaming a starter cannot leave a dead key behind.
import { STARTER_BLUEPRINTS } from "@/lib/crm/blueprints/starters";
import type { BlueprintIndustry } from "@/lib/crm/blueprints/types";

export type IndustryMapReason = "matched" | "closest" | "fallback";

export interface IndustryMapping {
  /** The starter's `blueprint.key`, which is what the library installs it under. */
  starterKey: string;
  industry: BlueprintIndustry;
  reason: IndustryMapReason;
  /** Plain words for the client: why this starter. */
  note: string;
}

const FALLBACK_INDUSTRY: BlueprintIndustry = "general_services";

/** The starter written for an industry. Null only if the library lost it, which a test pins. */
function starterFor(industry: BlueprintIndustry): string | null {
  return STARTER_BLUEPRINTS.find((s) => s.blueprint.industry === industry)?.blueprint.key ?? null;
}

interface Row {
  industry: BlueprintIndustry;
  reason: Exclude<IndustryMapReason, "fallback">;
  note: string;
}

/** Every questionnaire industry value and the starter it gets. A test walks INDUSTRY_OPTIONS, so an option added without a row here fails it. */
const BY_QUESTIONNAIRE_VALUE: Readonly<Record<string, Row>> = Object.freeze({
  real_estate: { industry: "real_estate", reason: "matched", note: "We used the Real Estate setup." },
  healthcare: { industry: "healthcare_wellness", reason: "matched", note: "We used the Healthcare and Wellness setup." },
  home_services: { industry: "home_services", reason: "matched", note: "We used the Home Services setup." },
  consulting: { industry: "consulting", reason: "matched", note: "We used the Consulting setup." },
  agency: { industry: "consulting", reason: "closest", note: "We used the Consulting setup, the closest fit for an agency: discovery calls, proposals and engagements." },
  legal_finance: { industry: "professional_services", reason: "matched", note: "We used the Professional Services setup." },
  ecommerce: { industry: FALLBACK_INDUSTRY, reason: "closest", note: "We used the General Services setup. There is no retail setup yet, so you can add your own stages and fields." },
  // Decided by the follow-up question below (`a.local_kind`, asked only of a local service business); this row is what one that skipped it, or chose "something else", gets.
  local_services: { industry: FALLBACK_INDUSTRY, reason: "closest", note: "We used the General Services setup. Answer \"What kind of local business is it?\" in your company information and we can match it better." },
});

/** The follow-up answer for a local service business (`a.local_kind`), by its stored value. "other" has no starter of its own. */
const BY_LOCAL_KIND: Readonly<Record<string, Row>> = Object.freeze({
  beauty: { industry: "beauty_salons", reason: "matched", note: "We used the Beauty and Salons setup." },
  auto: { industry: "automotive", reason: "matched", note: "We used the Automotive Services setup." },
  education: { industry: "education_coaching", reason: "matched", note: "We used the Education and Coaching setup." },
  food: { industry: "restaurants", reason: "matched", note: "We used the Restaurants setup." },
});

/** The questionnaire industry values that have a row of their own, for the test that keeps this table in step with the questionnaire. */
export const MAPPED_INDUSTRY_VALUES: readonly string[] = Object.freeze(Object.keys(BY_QUESTIONNAIRE_VALUE));

/** The follow-up values that have a row of their own. */
export const MAPPED_LOCAL_KINDS: readonly string[] = Object.freeze(Object.keys(BY_LOCAL_KIND));

const own = (table: Readonly<Record<string, Row>>, key: string | null | undefined): Row | null =>
  typeof key === "string" && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null;

/**
 * The starter for a questionnaire industry value (and, for a local service business, its follow-up answer). Total: a value nobody mapped, an empty value and "other" all give the
 * general services starter with reason "fallback", never an error and never a starter that does not exist.
 */
export function starterKeyForIndustry(value: string | null | undefined, extra: { localKind?: string | null } = {}): IndustryMapping {
  const key = typeof value === "string" ? value.trim() : "";
  const base = own(BY_QUESTIONNAIRE_VALUE, key);
  const row = (key === "local_services" ? own(BY_LOCAL_KIND, extra.localKind?.trim()) : null) ?? base;
  if (row) {
    const starterKey = starterFor(row.industry);
    if (starterKey) return { starterKey, industry: row.industry, reason: row.reason, note: row.note };
  }
  const fallbackKey = starterFor(FALLBACK_INDUSTRY);
  if (!fallbackKey) throw new Error("The General Services starter is missing from the starter library.");
  return { starterKey: fallbackKey, industry: FALLBACK_INDUSTRY, reason: "fallback", note: "We used the General Services setup because your industry is not one of the ready-made setups. You can change it in your CRM." };
}
