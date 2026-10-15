// The template gallery's data: every template as a card that can be searched, filtered and sorted. Pure data, so the server, the client and the
// tests all agree on it. Built-in designs come from the catalog; the agency's own templates (stored in the database) join the same list.

export interface IndustryFilter {
  id: string;
  label: string;
  families: string[];
}
export const INDUSTRY_FILTERS: IndustryFilter[] = [
  { id: "real-estate", label: "Real estate & architecture", families: ["meridian"] },
  { id: "healthcare", label: "Healthcare & wellness", families: ["care"] },
  { id: "home-services", label: "Home & local services", families: ["local"] },
  { id: "professional", label: "Professional & financial", families: ["corp"] },
  { id: "consulting", label: "Consulting & agencies", families: ["agency", "bold"] },
  { id: "technology", label: "Technology & software", families: ["tech"] },
  { id: "hospitality", label: "Hospitality & lifestyle", families: ["host"] },
  { id: "boutique", label: "Boutique, retail & creative", families: ["luxe", "minimal", "bold"] },
];

export interface StyleFilter {
  id: string;
  label: string;
  tags: string[];
}
export const STYLE_FILTERS: StyleFilter[] = [
  { id: "light", label: "Light", tags: ["light"] },
  { id: "dark", label: "Dark", tags: ["dark"] },
  { id: "editorial", label: "Editorial & serif", tags: ["editorial", "serif", "classic", "typographic"] },
  { id: "bold", label: "Bold & colourful", tags: ["bold", "loud", "colourful", "neon", "orange", "violet", "energetic", "urgent"] },
  { id: "playful", label: "Soft & playful", tags: ["playful", "friendly", "pastel", "soft", "warm", "feminine", "blush"] },
  { id: "minimal", label: "Minimal & airy", tags: ["minimal", "airy", "quiet", "calm", "text-led", "whitespace", "restrained"] },
  { id: "photographic", label: "Photography-led", tags: ["photography", "photographic", "immersive", "arch"] },
  { id: "technical", label: "Technical & gradient", tags: ["technical", "gradient", "grid", "bento", "rings", "mesh"] },
];

export interface GalleryCard {
  key: string;
  source: "builtin" | "custom";
  familyId: string;
  familyName: string;
  familyTagline: string;
  name: string;
  description: string;
  tags: string[];
  industries: string[];
  styles: string[];
  featured: boolean;
  mode: "light" | "dark";
  /** ISO date the template was added, for "recently added". Null when unknown. */
  addedAt: string | null;
  updatedAt?: string | null;
  version?: number;
  revision?: number;
  thumbnail?: import("./thumbnail-contract").TemplateThumbnail;
  layout?: string;
  typography?: string;
  pages: Array<{ slug: string; title: string }>;
}

export type GallerySort = "featured" | "name" | "recent" | "updated";

export const LAYOUT_FILTERS = [{ id: "immersive", label: "Immersive hero" }, { id: "split", label: "Split composition" }, { id: "centered", label: "Centered" }, { id: "stacked", label: "Stacked" }];
export const TYPOGRAPHY_FILTERS = [{ id: "serif", label: "Editorial serif" }, { id: "sans", label: "Clean sans serif" }, { id: "display", label: "Expressive display" }, { id: "mono", label: "Monospaced" }];

export interface GalleryFilters {
  q: string;
  industry: string;
  family: string;
  style: string;
  theme: string;
  layout: string;
  typography: string;
  sort: GallerySort;
}
export const EMPTY_GALLERY_FILTERS: GalleryFilters = { q: "", industry: "all", family: "all", style: "all", theme: "all", layout: "all", typography: "all", sort: "featured" };

/** Shared discovery fields. Counts and results always use the same permission-scoped input. */
export interface DiscoverableTemplate {
  key: string; name: string; description: string; familyId: string; familyName: string; familyTagline?: string;
  industries: string[]; tags: string[]; styles?: string[]; featured: boolean; mode: string;
  addedAt?: string | null; updatedAt?: string | null; layout?: string; typography?: string;
}

export function templateIndustries(card: DiscoverableTemplate): string[] {
  return card.industries;
}

export function templateStyles(card: DiscoverableTemplate): string[] {
  return card.styles ?? STYLE_FILTERS.filter((s) => s.tags.some((t) => card.tags.includes(t))).map((s) => s.id);
}

export function hasGalleryFilters(filters: GalleryFilters): boolean {
  return Boolean(filters.q.trim()) || [filters.industry, filters.family, filters.style, filters.theme, filters.layout, filters.typography].some((value) => value !== "all");
}

export function discoverTemplates<T extends DiscoverableTemplate>(cards: T[], o: Partial<GalleryFilters> & { preferIndustry?: string } = {}): T[] {
  const words = (o.q ?? "").trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const chosen = (value: string | undefined) => Boolean(value && value !== "all");
  const out = cards.filter((c) => {
    const industries = templateIndustries(c);
    if (chosen(o.industry) && !industries.includes(o.industry!)) return false;
    if (chosen(o.family) && c.familyId !== o.family) return false;
    if (chosen(o.style) && !templateStyles(c).includes(o.style!)) return false;
    if (chosen(o.theme) && c.mode !== o.theme) return false;
    if (chosen(o.layout) && c.layout !== o.layout) return false;
    if (chosen(o.typography) && c.typography !== o.typography) return false;
    const industryNames = INDUSTRY_FILTERS.filter((i) => industries.includes(i.id)).map((i) => i.label).join(" ");
    const haystack = `${c.name} ${c.familyName} ${c.familyTagline ?? ""} ${c.description} ${industryNames} ${industries.join(" ")} ${c.tags.join(" ")}`.toLocaleLowerCase();
    return words.every((word) => haystack.includes(word));
  });
  const byName = (a: T, b: T) => a.name.localeCompare(b.name) || a.familyName.localeCompare(b.familyName) || a.key.localeCompare(b.key);
  const rank = (c: T) => o.preferIndustry && templateIndustries(c).includes(o.preferIndustry) ? 0 : 1;
  switch (o.sort ?? "featured") {
    case "name": return out.sort(byName);
    case "recent": return out.sort((a, b) => (b.addedAt ?? "").localeCompare(a.addedAt ?? "") || byName(a, b));
    case "updated": return out.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || byName(a, b));
    default: return out.sort((a, b) => Number(b.featured) - Number(a.featured) || rank(a) - rank(b) || byName(a, b));
  }
}

export function filterCards(cards: GalleryCard[], o: Partial<GalleryFilters> & { preferIndustry?: string }): GalleryCard[] {
  return discoverTemplates(cards, o);
}

/** The industry filter that best matches an onboarding industry, so a business sees its own sector first. */
export function industryFilterFor(onboardingIndustry: string): string | undefined {
  const map: Record<string, string> = { real_estate: "real-estate", healthcare: "healthcare", home_services: "home-services", local_services: "home-services", legal_finance: "professional", consulting: "consulting", agency: "consulting", ecommerce: "boutique" };
  return map[onboardingIndustry];
}
