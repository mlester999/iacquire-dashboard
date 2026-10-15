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
  pages: Array<{ slug: string; title: string }>;
}

export type GallerySort = "featured" | "name" | "recent";

export function filterCards(cards: GalleryCard[], o: { q?: string; industry?: string; style?: string; sort?: GallerySort; preferIndustry?: string }): GalleryCard[] {
  const q = (o.q ?? "").trim().toLowerCase();
  const out = cards.filter((c) => {
    if (o.industry && o.industry !== "all" && !c.industries.includes(o.industry)) return false;
    if (o.style && o.style !== "all" && !c.styles.includes(o.style)) return false;
    if (!q) return true;
    return `${c.name} ${c.familyName} ${c.familyTagline} ${c.description} ${c.tags.join(" ")}`.toLowerCase().includes(q);
  });
  const rank = (c: GalleryCard) => (o.preferIndustry && c.industries.includes(o.preferIndustry) ? 0 : 1);
  const byName = (a: GalleryCard, b: GalleryCard) => `${a.familyName} ${a.name}`.localeCompare(`${b.familyName} ${b.name}`);
  switch (o.sort ?? "featured") {
    case "name": return out.sort(byName);
    case "recent": return out.sort((a, b) => (b.addedAt ?? "").localeCompare(a.addedAt ?? "") || byName(a, b));
    default: return out.sort((a, b) => rank(a) - rank(b) || Number(b.featured) - Number(a.featured) || byName(a, b));
  }
}

/** The industry filter that best matches an onboarding industry, so a business sees its own sector first. */
export function industryFilterFor(onboardingIndustry: string): string | undefined {
  const map: Record<string, string> = { real_estate: "real-estate", healthcare: "healthcare", home_services: "home-services", local_services: "home-services", legal_finance: "professional", consulting: "consulting", agency: "consulting", ecommerce: "boutique" };
  return map[onboardingIndustry];
}
