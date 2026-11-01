// Starter Blueprints bring configuration values (service area, address, opening hours ...) that every business must fill in before the message templates that use them can be sent.
// A few of them are things the client already told us in the questionnaire, so they are filled from those answers instead of asking twice. Pure: no I/O.
//
// The rule that keeps this safe is that only the client's own words are used, and only for the keys listed in PREFILL below. Nothing is ever invented, and nothing that carries a
// promise is filled on the client's behalf: web links, licence and registration numbers, regulatory statements, payment, warranty and refund terms stay empty and stay on the
// setup checklist for the client to write. A value that already has text is never planned, so a value the client edited is never overwritten.
import { formatHours } from "@/lib/onboarding/engine";
import { validateBusinessHours } from "@/lib/messaging";
import { CUSTOM_VALUE_LIMITS } from "@/lib/crm/custom-values";
import type { Answers } from "@/lib/onboarding/types";

export interface PrefillValue {
  key: string;
  label: string;
  type: string;
  /** What the workspace holds now. Only an empty value is ever filled. */
  value: string;
}

export interface PrefillItem {
  key: string;
  value: string;
  /** The questionnaire answer it came from, for the audit trail. */
  from: string;
}

type Source = { answer: string; text: (a: Answers) => string };

const text = (id: string) => (a: Answers): string => (typeof a[id] === "string" ? (a[id] as string) : "");
const hours = (a: Answers): string => {
  const valid = validateBusinessHours(a["a.hours"]);
  return valid ? formatHours(valid) : "";
};

const LOCATION: Source = { answer: "a.location", text: text("a.location") };

/** The only keys that are ever filled, and the answer each one comes from. */
const PREFILL: Readonly<Record<string, Source>> = Object.freeze({
  service_area: { answer: "a.territories", text: text("a.territories") },
  business_address: LOCATION,
  office_address: LOCATION,
  clinic_address: LOCATION,
  salon_address: LOCATION,
  workshop_address: LOCATION,
  restaurant_address: LOCATION,
  opening_hours: { answer: "a.hours", text: hours },
  cancellation_policy: { answer: "d.appt_cancellation", text: text("d.appt_cancellation") },
  brokerage_name: { answer: "a.business_name", text: text("a.business_name") },
});

/** Kept as a second fence, in case a key is ever added to PREFILL by mistake: nothing that reads like a link, a licence, a regulation or a commercial term is filled. */
const NEVER = /link|url|licen[cs]e|registration|regulat|payment|warranty|refund|terms|fees|upload|portal|intake/i;

/** The keys this module may fill (for tests and for the checklist's wording). */
export const PREFILLABLE_KEYS: readonly string[] = Object.freeze(Object.keys(PREFILL));

/** Plain text a configuration value can hold: control characters removed, no template tokens, within the value limit. Empty when nothing usable is left. */
function usable(raw: string): string {
  const cleaned = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\r\n?/g, "\n").trim();
  if (!cleaned || cleaned.includes("{{") || cleaned.includes("}}")) return "";
  return cleaned.slice(0, CUSTOM_VALUE_LIMITS.value).trim();
}

/**
 * What to write into the workspace's configuration values: the empty text values whose key is listed above and whose answer the client gave. Never a web address, number, phone,
 * email or colour value, never a key the NEVER list matches, never a value that already has text.
 */
export function planConfigValuePrefill(answers: Answers, values: readonly PrefillValue[]): PrefillItem[] {
  const out: PrefillItem[] = [];
  for (const v of values) {
    if (v.type !== "text" || v.value.trim() !== "") continue;
    if (!Object.prototype.hasOwnProperty.call(PREFILL, v.key) || NEVER.test(v.key)) continue;
    const source = PREFILL[v.key];
    const value = usable(source.text(answers));
    if (value) out.push({ key: v.key, value, from: source.answer });
  }
  return out;
}
