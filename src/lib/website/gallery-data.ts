// The built-in designs as gallery cards. Server-side: it knows every template, which the browser never needs to.
import { INDUSTRY_FILTERS, STYLE_FILTERS, type GalleryCard } from "./gallery";
import { FAMILIES, sampleSite, templateKey } from "./templates";
import { contentFacets } from "./gallery-facets";
export { contentFacets } from "./gallery-facets";
import { canonicalThumbnail } from "@/server/websites/thumbnails";

export function builtInCards(opts: { featured?: Set<string>; hidden?: Set<string>; added?: Map<string, string> } = {}): GalleryCard[] {
  // Featured is an agency decision persisted in website_templates, never an implicit catalog default.
  const featured = opts.featured ?? new Set<string>();
  const cards: GalleryCard[] = [];
  for (const f of FAMILIES) {
    for (const v of f.variations) {
      const key = templateKey(f.id, v.id);
      if (opts.hidden?.has(key)) continue;
      const tags = [...new Set([...v.tags, ...f.tags])];
      const content = sampleSite(key);
      cards.push({
        key, source: "builtin", familyId: f.id, familyName: f.name, familyTagline: f.tagline, name: v.name, description: v.description, tags: v.tags,
        industries: INDUSTRY_FILTERS.filter((i) => i.families.includes(f.id)).map((i) => i.id),
        styles: STYLE_FILTERS.filter((s) => s.tags.some((t) => tags.includes(t))).map((s) => s.id),
        featured: featured.has(key), mode: content.design.mode, addedAt: opts.added?.get(key) ?? null,
        version: content.origin?.version ?? 1, thumbnail: canonicalThumbnail(key, content), ...contentFacets(content), pages: content.pages.map((p) => ({ slug: p.slug, title: p.navLabel || p.title })),
      });
    }
  }
  return cards;
}

