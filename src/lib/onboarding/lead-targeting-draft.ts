// Pure rules that turn what the client wrote in the questionnaire into a first set of lead-targeting rules for the Lead Hunter, so the employee is not left waiting for a form the client
// has in effect already answered. Only the client's own words are used, and only where a field of the rules means what the answer says: the areas they serve, the services they sell,
// what makes a lead worth a conversation, and a short description of the ideal customer. Nothing is guessed (no industry, country, company size or buying signal is inferred), and a
// rule the answers do not support stays empty. The result is a starting point the client edits in the Leads workspace; a profile that already exists is never replaced.
import { targetingSchema, type Targeting } from "@/lib/leads-targeting";
import type { Answers } from "./types";

const ITEM_MAX = 120;

const text = (a: Answers, id: string): string => (typeof a[id] === "string" ? (a[id] as string).trim() : "");

/** Lines, then semicolons, then (only when there were neither) commas. An entry too long to store is left out, never cut short. */
function items(value: string, limit: number): string[] {
  if (!value) return [];
  const parts = /[\n;]/.test(value) ? value.split(/[\n;]+/) : value.split(",");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of parts) {
    const part = raw.replace(/^[\s\-*•]+/, "").trim();
    if (!part || part.length > ITEM_MAX || seen.has(part.toLowerCase())) continue;
    seen.add(part.toLowerCase());
    out.push(part);
    if (out.length >= limit) break;
  }
  return out;
}

export interface LeadTargetingDraft {
  targeting: Targeting;
  /** Which answers the rules came from, for the audit trail and for saying so to the client. */
  from: string[];
}

/** The rules the answers support, or null when they support none (then nothing is saved and the Lead Hunter still waits for the client's own rules). */
export function planLeadTargeting(a: Answers): LeadTargetingDraft | null {
  const regions = items(text(a, "a.territories"), 20);
  const servicesNeeded = items(text(a, "b.services"), 15);
  const idealCustomer = text(a, "b.ideal_customer");
  const keywords = idealCustomer && idealCustomer.length <= ITEM_MAX && !/[\n;]/.test(idealCustomer) ? [idealCustomer] : [];
  const minimumCriteria = text(a, "b.qualification").slice(0, 1000);
  const from = [
    regions.length ? "a.territories" : null,
    servicesNeeded.length ? "b.services" : null,
    keywords.length ? "b.ideal_customer" : null,
    minimumCriteria ? "b.qualification" : null,
  ].filter((id): id is string => id !== null);
  if (!from.length) return null;
  return { targeting: targetingSchema.parse({ regions, servicesNeeded, keywords, minimumCriteria }), from };
}
