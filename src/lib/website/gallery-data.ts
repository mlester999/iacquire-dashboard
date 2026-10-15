// The built-in designs as gallery cards. Server-side: it knows every template, which the browser never needs to.
import { INDUSTRY_FILTERS, STYLE_FILTERS, type GalleryCard } from "./gallery";
import { FAMILIES, sampleSite, templateKey } from "./templates";

/** One design from each family leads the gallery until the agency chooses its own featured set. */
const DEFAULT_FEATURED = new Set(["meridian.estate", "luxe.maison", "tech.nova", "bold.riot", "minimal.quiet", "care.haven", "host.terrace", "agency.thesis", "local.corner", "corp.charter", "meridian.skyline", "luxe.noir"]);

export function builtInCards(opts: { featured?: Set<string>; hidden?: Set<string>; added?: Map<string, string> } = {}): GalleryCard[] {
  const featured = opts.featured ?? DEFAULT_FEATURED;
  const cards: GalleryCard[] = [];
  for (const f of FAMILIES) {
    for (const v of f.variations) {
      const key = templateKey(f.id, v.id);
      if (opts.hidden?.has(key)) continue;
      const tags = [...new Set([...v.tags, ...f.tags])];
      cards.push({
        key, source: "builtin", familyId: f.id, familyName: f.name, familyTagline: f.tagline, name: v.name, description: v.description, tags: v.tags,
        industries: INDUSTRY_FILTERS.filter((i) => i.families.includes(f.id)).map((i) => i.id),
        styles: STYLE_FILTERS.filter((s) => s.tags.some((t) => tags.includes(t))).map((s) => s.id),
        featured: featured.has(key), mode: v.tags.includes("dark") ? "dark" : "light", addedAt: opts.added?.get(key) ?? null, pages: sampleSite(key).pages.map((p) => ({ slug: p.slug, title: p.navLabel || p.title })),
      });
    }
  }
  return cards;
}

