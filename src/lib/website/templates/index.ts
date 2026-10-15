// The built-in template collection: ten design families, five variations each, all composed from the same section library and drawn by one renderer.
import type { SiteContent } from "../doc";
import { assemble, makeCtx } from "./compose";
import { agency } from "./families/agency";
import { bold } from "./families/bold";
import { care } from "./families/care";
import { corp } from "./families/corp";
import { host } from "./families/host";
import { local } from "./families/local";
import { luxe } from "./families/luxe";
import { meridian } from "./families/meridian";
import { minimal } from "./families/minimal";
import { tech } from "./families/tech";
import { SAMPLES } from "./samples";
import type { FamilyDef, SiteDetails, VariationDef } from "./types";

export type { FamilyDef, SiteDetails, VariationDef } from "./types";

export const FAMILIES: FamilyDef[] = [luxe, tech, bold, corp, minimal, local, care, meridian, host, agency];

export const TEMPLATE_KEY = /^[a-z][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/;
export const templateKey = (family: string, variation: string) => `${family}.${variation}`;
export const DEFAULT_TEMPLATE_KEY = "meridian.estate";

export interface ResolvedTemplate {
  key: string;
  family: FamilyDef;
  variation: VariationDef;
}

export function resolveTemplate(key: string): ResolvedTemplate | null {
  if (!TEMPLATE_KEY.test(key)) return null;
  const [familyId, variationId] = key.split(".");
  const family = FAMILIES.find((f) => f.id === familyId);
  const variation = family?.variations.find((x) => x.id === variationId);
  return family && variation ? { key, family, variation } : null;
}

export const ALL_TEMPLATE_KEYS = (): string[] => FAMILIES.flatMap((f) => f.variations.map((x) => templateKey(f.id, x.id)));

/** Builds a website from a template and a business's facts. Only what the owner provided is used; nothing is invented. */
export function buildSite(key: string, details: SiteDetails, opts: { sample?: boolean; idPrefix?: string } = {}): SiteContent {
  const t = resolveTemplate(key) ?? resolveTemplate(DEFAULT_TEMPLATE_KEY)!;
  const ctx = makeCtx(details, { sample: opts.sample === true, idPrefix: opts.idPrefix });
  return assemble(ctx, t.variation.build(ctx), { key: t.key, family: t.family, variation: t.variation });
}

const SAMPLE_CACHE = new Map<string, SiteContent>();

/**
 * The template shown with its family's fictional business, clearly marked as sample content. Documents are never changed in place, so one
 * built copy per template is shared by every request.
 */
export function sampleSite(key: string): SiteContent {
  const t = resolveTemplate(key) ?? resolveTemplate(DEFAULT_TEMPLATE_KEY)!;
  const hit = SAMPLE_CACHE.get(t.key);
  if (hit) return hit;
  const built = buildSite(t.key, t.family.sample ?? SAMPLES.meridian, { sample: true });
  SAMPLE_CACHE.set(t.key, built);
  return built;
}

/** Families recommended for an onboarding industry, best match first. Every family stays available. */
export function familiesForIndustry(industry: string): FamilyDef[] {
  const rank = (f: FamilyDef) => (f.industries.indexOf(industry) === -1 ? 99 : f.industries.indexOf(industry));
  return [...FAMILIES].sort((a, b) => rank(a) - rank(b));
}
