// Industries as the agency picks them for a client. organizations.industry has always stored a label ("Real Estate"), so the label stays
// what is saved; the Blueprint industry key is only derived from it to sort and filter the Blueprints offered. Pure.
import { BLUEPRINT_INDUSTRIES, BLUEPRINT_INDUSTRY_LABELS, type BlueprintIndustry } from "@/lib/crm/blueprints/types";

/** The labels offered in the industry select, in the library's order ("Other" last). */
export const INDUSTRY_OPTIONS: Array<{ key: BlueprintIndustry; label: string }> = BLUEPRINT_INDUSTRIES.map((key) => ({ key, label: BLUEPRINT_INDUSTRY_LABELS[key] }));

/** "Real Estate" → "real_estate". A label typed before the select existed matches case-insensitively; anything else matches nothing. */
export function industryKeyForLabel(label: string | null | undefined): BlueprintIndustry | null {
  const v = (label ?? "").trim().toLowerCase();
  if (!v) return null;
  return INDUSTRY_OPTIONS.find((o) => o.label.toLowerCase() === v || o.key === v)?.key ?? null;
}

interface Ranked {
  name: string;
  industry: BlueprintIndustry;
  featured?: boolean;
}

/**
 * Orders Blueprints for a client's industry: that industry's first, then general-purpose ones (general services, other), then the rest;
 * featured before the others within a group, then by name. With no industry chosen, featured first, then by name.
 */
export function rankForIndustry<T extends Ranked>(items: readonly T[], industry: BlueprintIndustry | null): T[] {
  const group = (i: T) => (industry && i.industry === industry ? 0 : i.industry === "general_services" || i.industry === "other" ? 1 : 2);
  return [...items].sort((a, b) => (industry ? group(a) - group(b) : 0) || Number(!!b.featured) - Number(!!a.featured) || a.name.localeCompare(b.name));
}

/** Whether an item is a match for the chosen industry (the dialog labels these "Matches <industry>"). */
export function matchesIndustry(item: { industry: BlueprintIndustry }, industry: BlueprintIndustry | null): boolean {
  return industry !== null && item.industry === industry;
}
