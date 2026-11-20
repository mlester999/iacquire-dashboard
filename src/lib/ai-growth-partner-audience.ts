import type { BusinessBrain, BusinessBrainFact } from "@/lib/ai-growth-partner";
import type { KnowledgeSectionKey } from "@/lib/webchat/rules";

// Who a Business Brain fact may be shown to.
//
// The Brain holds everything the Growth Partner knows about the business, and most of it is for the owner and the Partner only: the targets the Partner works to, the budget that
// qualifies a lead, who to escalate to, how it should behave. A customer-facing reply (an email, text or WhatsApp answer to a customer) must be written from the part the business
// has made public, never from the whole Brain. Facts live in immutable JSON snapshots, so the audience is an optional field on the fact that is resolved when it is read:
//   * a fact that names its audience keeps it;
//   * a fact that does not is internal, EXCEPT a confirmed fact in one of the few slots listed below, which a customer would be told anyway (the business name, what it sells,
//     its approved prices and hours, its public policies, its tone).
// Older snapshots carry no audience, so they read exactly as they always did for the owner and as "internal unless whitelisted" for customers. Nothing here is a migration.

export const FACT_AUDIENCES = ["internal", "customer_safe"] as const;
export type FactAudience = (typeof FACT_AUDIENCES)[number];

/**
 * The Brain slots ("section.key") a confirmed fact is customer-safe in by default. Everything else is internal: every salesKnowledge, acquisitionStrategy, employeeGoals,
 * employeeBehavior and productOperations slot, every idealCustomers slot (the budget and the disqualifiers decide who the business serves, not what it says), every escalation or
 * handoff slot, the pricing policy and discount rules (as opposed to the approved prices themselves), and the background, positioning and differentiators narrative.
 */
export const DEFAULT_CUSTOMER_SAFE_SLOTS: ReadonlySet<string> = new Set([
  "businessIdentity.companyName",
  "businessIdentity.industry",
  "businessIdentity.website",
  "businessIdentity.contactEmail",
  "businessIdentity.contactPhone",
  "businessIdentity.locations",
  "businessIdentity.serviceAreas",
  "productsServicesOffers.products",
  "productsServicesOffers.services",
  "productsServicesOffers.approvedDescriptions",
  "productsServicesOffers.pricing",
  "productsServicesOffers.guarantees",
  "productsServicesOffers.consultationOffers",
  "businessOperations.operatingHours",
  "businessOperations.timeZone",
  "policies.cancellation",
  "policies.rescheduling",
  "policies.refunds",
  "policies.privacy",
  "brandCommunication.tone",
  "brandCommunication.language",
]);

/** A fact the Partner may rely on: the client said it or it was verified. A draft, an unknown, a historical value or a superseded one is never shown to anyone as fact. */
export const isConfirmedFactState = (state: BusinessBrainFact["state"]): boolean => state === "verified" || state === "client_confirmed";

/** The audience of one fact: the one it names, otherwise customer-safe only for a confirmed fact in a default slot, otherwise internal. */
export function resolveFactAudience(section: string, key: string, fact: Pick<BusinessBrainFact, "audience" | "state">): FactAudience {
  if (fact.audience) return fact.audience;
  return DEFAULT_CUSTOMER_SAFE_SLOTS.has(`${section}.${key}`) && isConfirmedFactState(fact.state) ? "customer_safe" : "internal";
}

export interface AudienceFact {
  section: string;
  key: string;
  fact: BusinessBrainFact;
}

/** Every fact a customer may be told: confirmed AND customer-safe. Deterministic: the Brain's section order, then the order the facts were saved in. */
export function customerSafeFacts(brain: BusinessBrain): AudienceFact[] {
  const out: AudienceFact[] = [];
  for (const [section, facts] of Object.entries(brain.sections)) {
    for (const [key, fact] of Object.entries(facts)) {
      if (!isConfirmedFactState(fact.state)) continue;
      if (resolveFactAudience(section, key, fact) !== "customer_safe") continue;
      out.push({ section, key, fact });
    }
  }
  return out;
}

/** A fact's value as plain text (a list becomes one line per item, an object one "name: value" line per entry). Empty when there is nothing to say. */
export function factValueText(value: unknown, depth = 0): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (depth >= 6) return "";
  if (Array.isArray(value)) return value.map((item) => factValueText(item, depth + 1)).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([name, item]) => {
        const text = factValueText(item, depth + 1);
        return text ? `${name}: ${text}` : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

const GROUNDING_MAX_CHARS = 16_000;

/**
 * The facts as quoted text, one "section.key: value" entry each. This is what a reply's claims are checked against, so it carries every customer-safe fact whole and in plain words:
 * a fact that does not fit the cap is left out, which can only make the check stricter.
 */
export function customerSafeFactsText(facts: readonly AudienceFact[], maxChars = GROUNDING_MAX_CHARS): string {
  const lines: string[] = [];
  let used = 0;
  for (const { section, key, fact } of facts) {
    const text = factValueText(fact.value);
    if (!text) continue;
    const line = `${section}.${key}: ${text}`;
    if (used + line.length + 1 > maxChars) continue;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

/**
 * The public sections of the website assistant a slot belongs to. The website chat only ever sees the sections its owner exposed (prices are a deliberate opt-in), so a
 * customer-safe Brain fact reaches it only through the section it belongs to and only when that section is exposed. A fact marked customer-safe in a slot not listed here is for
 * email, text and WhatsApp replies only: nobody told the website which public section it belongs to.
 */
export const BRAIN_SLOT_WIDGET_SECTION: Readonly<Record<string, KnowledgeSectionKey>> = {
  "businessIdentity.companyName": "business_description",
  "businessIdentity.industry": "business_description",
  "businessIdentity.website": "business_description",
  "businessIdentity.contactEmail": "business_description",
  "businessIdentity.contactPhone": "business_description",
  "businessIdentity.locations": "business_description",
  "businessIdentity.serviceAreas": "business_description",
  "productsServicesOffers.products": "products_services",
  "productsServicesOffers.services": "products_services",
  "productsServicesOffers.approvedDescriptions": "products_services",
  "productsServicesOffers.guarantees": "products_services",
  "productsServicesOffers.consultationOffers": "products_services",
  "productsServicesOffers.pricing": "approved_pricing",
  "businessOperations.operatingHours": "business_hours",
  "businessOperations.timeZone": "business_hours",
  "policies.cancellation": "policies",
  "policies.rescheduling": "policies",
  "policies.refunds": "policies",
  "policies.privacy": "policies",
  "brandCommunication.tone": "brand_voice",
  "brandCommunication.language": "brand_voice",
};

/** The customer-safe facts the website assistant may use: only those whose public section the widget exposes. */
export function customerSafeFactsForSections(brain: BusinessBrain, exposed: readonly KnowledgeSectionKey[]): Array<AudienceFact & { widgetSection: KnowledgeSectionKey }> {
  const out: Array<AudienceFact & { widgetSection: KnowledgeSectionKey }> = [];
  for (const entry of customerSafeFacts(brain)) {
    const widgetSection = BRAIN_SLOT_WIDGET_SECTION[`${entry.section}.${entry.key}`];
    if (widgetSection && exposed.includes(widgetSection)) out.push({ ...entry, widgetSection });
  }
  return out;
}

const CONFIG_TITLE = /^# iAcquire client configuration \([^\r\n]+\)$/m;
const ACTIVE_BRAIN_START = "## Active Business Brain (version ";
const BRAIN_CONTEXT_END = "</client_context>";

/**
 * The smallest Growth Partner configuration suitable for a customer reply. The stored profile also contains internal role instructions, tool labels, workspace facts and free-form
 * preferences; retaining only its fixed tone, length and language lines prevents those fields from bypassing the per-fact Business Brain audience.
 */
export function customerReplyHead(compiled: string): string {
  const title = CONFIG_TITLE.exec(compiled)?.[0] ?? "# iAcquire customer reply";
  const styleHeading = "## How to communicate";
  const styleStart = compiled.indexOf(styleHeading);
  const styleLines: string[] = [];
  if (styleStart !== -1) {
    for (const line of compiled.slice(styleStart + styleHeading.length).split(/\r?\n/)) {
      if (/^##\s/.test(line)) break;
      if (/^- (?:Tone|Reply length|Language): /.test(line)) styleLines.push(line);
    }
  }

  const brainStart = compiled.indexOf(ACTIVE_BRAIN_START);
  const brainContextEnd = brainStart === -1 ? -1 : compiled.indexOf(BRAIN_CONTEXT_END, brainStart);
  const brain = brainContextEnd === -1 ? "" : compiled.slice(brainStart, brainContextEnd + BRAIN_CONTEXT_END.length);

  return [
    title,
    "You are the AI Growth Partner writing to a customer. Use only the customer-safe facts below and this conversation; do not rely on internal employee context.",
    ...(styleLines.length ? ["## Customer reply style", ...styleLines] : []),
    ...(brain ? ["", brain] : []),
  ].join("\n");
}
