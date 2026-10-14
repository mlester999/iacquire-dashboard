// Ten template families, five variations each, all interpreted by ONE renderer. A variation is not a colour swap:
// it chooses different layouts for the header, hero, services, about, FAQ, call to action and footer, a different
// typographic voice, section rhythm, density, corner style and surface treatment. Colours always come from the
// owner's brand, never from the template.
import type { SectionType } from "./sections";

export type FontKey = "sans" | "serif" | "rounded" | "condensed" | "humanist" | "slab" | "mono";

export interface DesignSpec {
  header: "bar" | "centered" | "split" | "floating" | "minimal";
  hero: "split" | "splitReverse" | "centered" | "fullbleed" | "editorial" | "stacked" | "overlayCard" | "framed";
  services: "grid" | "rows" | "iconCards" | "bento" | "alternating" | "numbered";
  about: "split" | "centered" | "story" | "statsRow";
  process: "steps" | "timeline" | "cards";
  testimonials: "cards" | "quote" | "wall";
  faq: "accordion" | "columns" | "cards";
  cta: "band" | "card" | "split" | "minimal";
  gallery: "grid" | "masonry" | "strip";
  contact: "split" | "card" | "stacked";
  footer: "columns" | "centered" | "minimal" | "dark";
  density: "airy" | "regular" | "compact";
  radius: "square" | "soft" | "round" | "pill";
  surface: "flat" | "outlined" | "elevated" | "tinted";
  tone: "white" | "warm" | "cool" | "tinted" | "dark";
  rhythm: "uniform" | "alternate" | "bands";
  decor: "none" | "blobs" | "grid" | "lines" | "dots" | "waves";
  type: { heading: FontKey; body: FontKey; scale: "compact" | "regular" | "grand"; upper: boolean; weight: "medium" | "bold" | "black"; tracking: "tight" | "normal" | "wide" };
  /** Section order on the home page. Sections without content are skipped by the generator. */
  home: SectionType[];
}

export interface Variation {
  id: string;
  name: string;
  description: string;
  overrides: Partial<Omit<DesignSpec, "type">> & { type?: Partial<DesignSpec["type"]> };
}
export interface Family {
  id: string;
  name: string;
  tagline: string;
  /** Onboarding industries this family was designed for (every family can be used for any business). */
  industries: string[];
  base: DesignSpec;
  variations: Variation[];
}

const T = (heading: FontKey, body: FontKey, scale: DesignSpec["type"]["scale"], weight: DesignSpec["type"]["weight"], tracking: DesignSpec["type"]["tracking"], upper = false): DesignSpec["type"] => ({ heading, body, scale, weight, tracking, upper });
const v = (id: string, name: string, description: string, overrides: Variation["overrides"]): Variation => ({ id, name, description, overrides });

const HOME_SERVICE_FIRST: SectionType[] = ["hero", "stats", "services", "process", "about", "testimonials", "faq", "cta", "contact"];
const HOME_STORY_FIRST: SectionType[] = ["hero", "about", "services", "testimonials", "gallery", "faq", "cta", "contact"];

export const FAMILIES: Family[] = [
  {
    id: "meridian", name: "Meridian", tagline: "Image-led and elegant, for property.", industries: ["real_estate"],
    base: { header: "bar", hero: "fullbleed", services: "alternating", about: "split", process: "timeline", testimonials: "quote", faq: "accordion", cta: "band", gallery: "masonry", contact: "split", footer: "columns", density: "airy", radius: "soft", surface: "elevated", tone: "warm", rhythm: "alternate", decor: "none", type: T("serif", "sans", "grand", "medium", "tight"), home: ["hero", "gallery", "services", "about", "testimonials", "faq", "cta", "contact"] },
    variations: [
      v("estate", "Estate", "Classic and unhurried, with a full-width photograph.", {}),
      v("skyline", "Skyline", "Dark, modern and architectural.", { tone: "dark", header: "floating", hero: "split", services: "bento", gallery: "strip", surface: "outlined", decor: "lines", type: { heading: "sans", weight: "bold", tracking: "wide", upper: true, scale: "regular" } }),
      v("harbor", "Harbor", "Light and calm, centred and friendly.", { tone: "cool", header: "centered", hero: "centered", services: "iconCards", about: "centered", cta: "card", surface: "tinted", radius: "round", type: { heading: "rounded", weight: "bold", scale: "regular" } }),
      v("heritage", "Heritage", "Editorial and traditional, serif throughout.", { tone: "white", header: "split", hero: "editorial", services: "rows", about: "story", process: "steps", testimonials: "wall", faq: "columns", cta: "card", gallery: "strip", footer: "centered", radius: "square", surface: "flat", rhythm: "uniform", decor: "dots", type: { weight: "bold", scale: "regular", tracking: "normal" } }),
      v("metro", "Metro", "Compact, city-sharp and confident.", { tone: "tinted", header: "minimal", hero: "stacked", services: "numbered", process: "cards", cta: "split", gallery: "grid", density: "compact", radius: "pill", rhythm: "bands", decor: "grid", type: { heading: "condensed", weight: "black", upper: true, tracking: "normal", scale: "grand" } }),
    ],
  },
  {
    id: "haven", name: "Haven", tagline: "Calm and reassuring, for care.", industries: ["healthcare"],
    base: { header: "bar", hero: "split", services: "iconCards", about: "split", process: "steps", testimonials: "cards", faq: "accordion", cta: "card", gallery: "grid", contact: "split", footer: "columns", density: "regular", radius: "round", surface: "tinted", tone: "cool", rhythm: "alternate", decor: "blobs", type: T("humanist", "humanist", "regular", "bold", "normal"), home: HOME_SERVICE_FIRST },
    variations: [
      v("calm", "Calm", "Soft shapes and plenty of space.", {}),
      v("clinic", "Clinic", "Clean, clinical and efficient.", { tone: "white", header: "split", hero: "splitReverse", services: "grid", testimonials: "quote", faq: "columns", footer: "dark", surface: "outlined", radius: "soft", decor: "none", rhythm: "uniform", cta: "band", type: { heading: "sans", body: "sans", weight: "bold" } }),
      v("family", "Family", "Warm and welcoming, rounded and friendly.", { tone: "warm", header: "centered", hero: "centered", services: "bento", about: "centered", faq: "cards", radius: "pill", surface: "elevated", decor: "dots", type: { heading: "rounded", body: "rounded", weight: "bold" } }),
      v("carepoint", "Care Point", "Practical, with the booking step up front.", { header: "floating", hero: "overlayCard", services: "rows", process: "cards", testimonials: "wall", cta: "split", density: "compact", footer: "dark", decor: "grid", tone: "tinted", surface: "flat", type: { heading: "sans", scale: "compact" } }),
      v("serene", "Serene", "Quiet and spacious, one idea at a time.", { header: "minimal", hero: "editorial", services: "numbered", about: "story", process: "timeline", testimonials: "quote", cta: "minimal", faq: "columns", contact: "stacked", gallery: "strip", density: "airy", radius: "square", surface: "outlined", rhythm: "uniform", decor: "waves", tone: "white", footer: "centered", type: { heading: "serif", weight: "medium", scale: "grand" } }),
    ],
  },
  {
    id: "forge", name: "Forge", tagline: "Bold and practical, for the trades.", industries: ["home_services"],
    base: { header: "split", hero: "overlayCard", services: "grid", about: "statsRow", process: "steps", testimonials: "cards", faq: "accordion", cta: "band", gallery: "grid", contact: "card", footer: "dark", density: "regular", radius: "soft", surface: "elevated", tone: "white", rhythm: "bands", decor: "none", type: T("condensed", "sans", "grand", "black", "normal", true), home: HOME_SERVICE_FIRST },
    variations: [
      v("foreman", "Foreman", "Big phone number, big promise of a quote.", {}),
      v("rapid", "Rapid", "Speed-first, with a stacked headline.", { header: "bar", hero: "stacked", services: "numbered", about: "split", cta: "card", surface: "outlined", tone: "cool", rhythm: "alternate", decor: "lines", type: { heading: "sans", weight: "black", scale: "regular" } }),
      v("craft", "Craft", "Workmanlike and warm, with a serif touch.", { header: "centered", hero: "split", services: "alternating", about: "story", process: "timeline", testimonials: "quote", footer: "columns", tone: "warm", radius: "square", surface: "flat", decor: "dots", type: { heading: "slab", body: "serif", upper: false, weight: "bold", scale: "regular" } }),
      v("hearth", "Hearth", "Homely, rounded and reassuring.", { header: "bar", hero: "splitReverse", services: "iconCards", process: "cards", faq: "cards", cta: "split", footer: "centered", tone: "tinted", radius: "round", surface: "tinted", rhythm: "alternate", decor: "blobs", type: { heading: "rounded", body: "rounded", upper: false, weight: "bold", scale: "regular" } }),
      v("torque", "Torque", "Dark, industrial and high-contrast.", { header: "floating", hero: "fullbleed", services: "bento", about: "split", testimonials: "wall", gallery: "strip", faq: "columns", tone: "dark", surface: "outlined", radius: "square", density: "compact", rhythm: "uniform", decor: "grid", type: { tracking: "wide" } }),
    ],
  },
  {
    id: "atlas", name: "Atlas", tagline: "Editorial and credible, for advisors.", industries: ["consulting", "legal_finance"],
    base: { header: "split", hero: "editorial", services: "rows", about: "story", process: "timeline", testimonials: "quote", faq: "columns", cta: "minimal", gallery: "grid", contact: "stacked", footer: "centered", density: "airy", radius: "square", surface: "flat", tone: "white", rhythm: "uniform", decor: "none", type: T("serif", "sans", "grand", "medium", "tight"), home: HOME_STORY_FIRST },
    variations: [
      v("advisor", "Advisor", "Understated authority.", {}),
      v("sage", "Sage", "Warm paper tones and a thoughtful pace.", { tone: "warm", header: "centered", hero: "centered", services: "numbered", about: "centered", cta: "card", surface: "outlined", rhythm: "alternate", decor: "lines", type: { weight: "bold", scale: "regular" } }),
      v("brief", "Brief", "Short, structured and to the point.", { tone: "cool", header: "bar", hero: "framed", services: "grid", about: "statsRow", process: "steps", testimonials: "cards", faq: "accordion", cta: "band", gallery: "masonry", contact: "card", footer: "columns", density: "compact", radius: "soft", surface: "elevated", rhythm: "bands", type: { heading: "sans", weight: "bold", scale: "regular" } }),
      v("compass", "Compass", "Confident, with a clear direction.", { tone: "tinted", header: "floating", hero: "splitReverse", services: "iconCards", about: "split", process: "cards", cta: "split", footer: "dark", radius: "round", surface: "tinted", rhythm: "alternate", decor: "dots", type: { heading: "humanist", body: "humanist", weight: "bold", scale: "regular" } }),
      v("quill", "Quill", "Literary and generous with whitespace.", { tone: "white", header: "minimal", hero: "stacked", services: "alternating", about: "story", testimonials: "wall", faq: "cards", cta: "minimal", gallery: "masonry", footer: "minimal", density: "airy", radius: "pill", surface: "flat", decor: "waves", type: { weight: "medium", scale: "grand", upper: false } }),
    ],
  },
  {
    id: "pulse", name: "Pulse", tagline: "High-energy and modern, for agencies.", industries: ["agency"],
    base: { header: "floating", hero: "stacked", services: "bento", about: "statsRow", process: "cards", testimonials: "wall", faq: "cards", cta: "split", gallery: "masonry", contact: "card", footer: "dark", density: "regular", radius: "round", surface: "outlined", tone: "dark", rhythm: "uniform", decor: "grid", type: T("sans", "sans", "grand", "black", "tight"), home: ["hero", "services", "stats", "process", "gallery", "testimonials", "cta", "contact"] },
    variations: [
      v("neon", "Neon", "Dark and electric.", {}),
      v("studio", "Studio", "Light, airy and design-led.", { tone: "white", header: "bar", hero: "editorial", services: "numbered", about: "story", cta: "card", footer: "columns", radius: "soft", surface: "flat", rhythm: "alternate", decor: "none", density: "airy", type: { weight: "bold", scale: "grand", tracking: "tight" } }),
      v("signal", "Signal", "Punchy, with a loud call to action.", { tone: "tinted", header: "centered", hero: "overlayCard", services: "grid", process: "steps", testimonials: "cards", cta: "band", contact: "stacked", footer: "centered", radius: "square", surface: "elevated", rhythm: "bands", decor: "dots", type: { heading: "condensed", upper: true, tracking: "normal" } }),
      v("mono", "Mono", "Technical and minimal, with a monospaced voice.", { tone: "cool", header: "minimal", hero: "framed", services: "rows", about: "centered", process: "timeline", faq: "columns", cta: "minimal", gallery: "grid", footer: "minimal", density: "compact", radius: "square", surface: "outlined", decor: "dots", type: { heading: "mono", body: "sans", weight: "bold", scale: "regular", tracking: "normal" } }),
      v("kinetic", "Kinetic", "Rounded, playful and full of motion cues.", { tone: "warm", header: "centered", hero: "splitReverse", services: "iconCards", about: "split", process: "steps", testimonials: "quote", faq: "accordion", cta: "split", gallery: "strip", radius: "pill", surface: "elevated", rhythm: "alternate", decor: "blobs", type: { heading: "rounded", body: "rounded", weight: "black", scale: "regular", upper: false } }),
    ],
  },
  {
    id: "local", name: "Local", tagline: "Friendly and neighbourly, for local services.", industries: ["local_services"],
    base: { header: "bar", hero: "split", services: "iconCards", about: "split", process: "steps", testimonials: "cards", faq: "accordion", cta: "band", gallery: "grid", contact: "split", footer: "columns", density: "regular", radius: "soft", surface: "elevated", tone: "warm", rhythm: "alternate", decor: "dots", type: T("humanist", "humanist", "regular", "bold", "normal"), home: ["hero", "services", "about", "stats", "testimonials", "gallery", "faq", "cta", "contact"] },
    variations: [
      v("corner", "Corner Shop", "Warm, welcoming and easy to scan.", { hero: "splitReverse", process: "timeline", faq: "cards" }),
      v("mainstreet", "Main Street", "Classic storefront character.", { header: "centered", hero: "centered", services: "rows", about: "centered", faq: "columns", footer: "centered", tone: "white", radius: "square", surface: "outlined", rhythm: "uniform", decor: "lines", type: { heading: "slab", scale: "regular" } }),
      v("neighbor", "Neighbor", "Chatty and bright.", { header: "floating", hero: "overlayCard", services: "bento", process: "cards", testimonials: "wall", cta: "card", tone: "tinted", radius: "round", surface: "tinted", decor: "blobs", type: { heading: "rounded", body: "rounded" } }),
      v("opendoor", "Open Door", "Simple, direct and quick to act on.", { header: "split", hero: "stacked", services: "grid", about: "statsRow", process: "timeline", testimonials: "quote", faq: "cards", cta: "split", footer: "dark", tone: "cool", density: "compact", radius: "pill", surface: "flat", rhythm: "bands", decor: "none", type: { heading: "sans", weight: "black", scale: "grand" } }),
      v("block", "The Block", "Bold blocks of colour and type.", { header: "minimal", hero: "splitReverse", services: "numbered", about: "story", testimonials: "cards", faq: "accordion", cta: "minimal", gallery: "masonry", footer: "minimal", tone: "white", radius: "square", surface: "elevated", rhythm: "alternate", decor: "grid", type: { heading: "condensed", upper: true, weight: "black", scale: "grand" } }),
    ],
  },
  {
    id: "ledger", name: "Ledger", tagline: "Structured and trustworthy, for professional firms.", industries: ["legal_finance", "consulting"],
    base: { header: "bar", hero: "split", services: "grid", about: "statsRow", process: "steps", testimonials: "quote", faq: "accordion", cta: "band", gallery: "grid", contact: "split", footer: "columns", density: "regular", radius: "soft", surface: "outlined", tone: "cool", rhythm: "alternate", decor: "none", type: T("serif", "sans", "regular", "bold", "normal"), home: HOME_SERVICE_FIRST },
    variations: [
      v("counsel", "Counsel", "Formal and dependable.", { contact: "card", gallery: "masonry", decor: "lines" }),
      v("charter", "Charter", "Understated, with a strong grid.", { header: "split", hero: "framed", services: "numbered", about: "split", testimonials: "cards", cta: "card", tone: "white", radius: "square", surface: "flat", rhythm: "uniform", decor: "lines", type: { heading: "sans", weight: "bold", tracking: "tight" } }),
      v("principal", "Principal", "Dark navy authority.", { header: "floating", hero: "fullbleed", services: "rows", about: "story", process: "timeline", testimonials: "wall", faq: "columns", cta: "split", footer: "dark", tone: "dark", radius: "soft", surface: "outlined", decor: "grid", type: { heading: "serif", weight: "medium", scale: "grand" } }),
      v("prime", "Prime", "Modern and approachable.", { header: "centered", hero: "centered", services: "iconCards", about: "centered", process: "cards", faq: "cards", cta: "minimal", footer: "centered", tone: "tinted", radius: "round", surface: "tinted", density: "airy", decor: "blobs", type: { heading: "humanist", body: "humanist", weight: "bold" } }),
      v("docket", "Docket", "Dense, orderly and efficient.", { header: "minimal", hero: "stacked", services: "alternating", about: "statsRow", process: "steps", testimonials: "quote", faq: "accordion", cta: "band", gallery: "strip", footer: "minimal", tone: "warm", density: "compact", radius: "pill", surface: "elevated", rhythm: "bands", decor: "dots", type: { heading: "slab", upper: true, tracking: "wide", scale: "compact" } }),
    ],
  },
  {
    id: "bloom", name: "Bloom", tagline: "Airy and gentle, for wellness and beauty.", industries: ["healthcare", "local_services"],
    base: { header: "centered", hero: "centered", services: "bento", about: "story", process: "timeline", testimonials: "quote", faq: "cards", cta: "card", gallery: "masonry", contact: "stacked", footer: "centered", density: "airy", radius: "pill", surface: "tinted", tone: "warm", rhythm: "alternate", decor: "blobs", type: T("serif", "rounded", "grand", "medium", "normal"), home: HOME_STORY_FIRST },
    variations: [
      v("petal", "Petal", "Soft and floral in feeling.", {}),
      v("glow", "Glow", "Bright, rounded and fresh.", { header: "bar", hero: "split", services: "iconCards", about: "split", process: "steps", testimonials: "cards", faq: "accordion", cta: "split", footer: "columns", tone: "cool", radius: "round", surface: "elevated", decor: "dots", type: { heading: "rounded", weight: "bold", scale: "regular" } }),
      v("gardenfresh", "Sage Garden", "Natural, with deep greens and generous margins.", { header: "split", hero: "splitReverse", services: "alternating", about: "centered", process: "cards", testimonials: "wall", cta: "band", footer: "dark", tone: "tinted", radius: "soft", surface: "flat", rhythm: "bands", decor: "waves", type: { heading: "serif", weight: "bold", scale: "regular" } }),
      v("ritual", "Ritual", "Minimal and ceremonial.", { header: "minimal", hero: "editorial", services: "numbered", about: "story", process: "timeline", faq: "columns", cta: "minimal", gallery: "strip", footer: "minimal", tone: "white", radius: "square", surface: "flat", rhythm: "uniform", decor: "lines", type: { heading: "serif", upper: true, tracking: "wide", scale: "regular", weight: "medium" } }),
      v("pebble", "Pebble", "Smooth shapes and a playful grid.", { header: "floating", hero: "overlayCard", services: "grid", about: "statsRow", testimonials: "cards", faq: "accordion", cta: "split", gallery: "grid", footer: "columns", density: "regular", radius: "round", surface: "outlined", decor: "none", type: { heading: "humanist", body: "humanist", weight: "bold", scale: "regular" } }),
    ],
  },
  {
    id: "summit", name: "Summit", tagline: "Clean and versatile, for any business.", industries: ["ecommerce", "other", "consulting"],
    base: { header: "bar", hero: "split", services: "grid", about: "split", process: "steps", testimonials: "cards", faq: "accordion", cta: "band", gallery: "grid", contact: "split", footer: "columns", density: "regular", radius: "soft", surface: "elevated", tone: "white", rhythm: "alternate", decor: "none", type: T("sans", "sans", "regular", "bold", "tight"), home: HOME_SERVICE_FIRST },
    variations: [
      v("peak", "Peak", "Clean and balanced: a safe, strong default.", {}),
      v("ridge", "Ridge", "Sharper edges and a dark footer.", { header: "split", hero: "splitReverse", services: "rows", about: "statsRow", process: "cards", testimonials: "quote", cta: "split", footer: "dark", tone: "cool", radius: "square", surface: "outlined", rhythm: "bands", decor: "lines" }),
      v("base", "Basecamp", "Friendly and rounded.", { header: "centered", hero: "splitReverse", services: "iconCards", about: "centered", process: "timeline", testimonials: "wall", faq: "cards", cta: "card", contact: "card", gallery: "masonry", footer: "columns", tone: "tinted", radius: "round", surface: "tinted", density: "airy", decor: "blobs", type: { heading: "rounded", body: "rounded" } }),
      v("trail", "Trail", "Compact and editorial.", { header: "minimal", hero: "editorial", services: "numbered", about: "story", faq: "columns", cta: "minimal", gallery: "masonry", footer: "minimal", tone: "warm", density: "compact", radius: "pill", surface: "flat", rhythm: "uniform", decor: "dots", type: { heading: "serif", weight: "medium", scale: "grand" } }),
      v("crest", "Crest", "Dark, confident and high-contrast.", { header: "floating", hero: "overlayCard", services: "bento", about: "split", process: "steps", testimonials: "cards", faq: "accordion", cta: "band", footer: "dark", tone: "dark", radius: "soft", surface: "outlined", rhythm: "uniform", decor: "grid", type: { weight: "black", tracking: "tight", scale: "grand" } }),
    ],
  },
  {
    id: "canvas", name: "Canvas", tagline: "Gallery-first, for creative work and showcases.", industries: ["other", "agency", "ecommerce"],
    base: { header: "minimal", hero: "framed", services: "numbered", about: "story", process: "cards", testimonials: "quote", faq: "columns", cta: "minimal", gallery: "masonry", contact: "stacked", footer: "minimal", density: "airy", radius: "square", surface: "flat", tone: "white", rhythm: "uniform", decor: "none", type: T("sans", "sans", "grand", "medium", "tight"), home: ["hero", "gallery", "services", "about", "testimonials", "cta", "contact"] },
    variations: [
      v("gallery", "Gallery", "Let the work speak.", {}),
      v("frame", "Frame", "Bordered, deliberate and museum-like.", { header: "split", hero: "framed", services: "alternating", about: "centered", process: "steps", testimonials: "wall", faq: "accordion", cta: "split", gallery: "grid", footer: "dark", tone: "cool", surface: "outlined", rhythm: "alternate", decor: "grid", type: { heading: "slab", scale: "regular", weight: "bold" } }),
      v("collage", "Collage", "Layered, playful and image-heavy.", { header: "floating", hero: "overlayCard", services: "bento", about: "split", process: "steps", testimonials: "wall", faq: "cards", cta: "split", gallery: "strip", footer: "columns", tone: "tinted", radius: "round", surface: "elevated", decor: "blobs", density: "regular", type: { heading: "rounded", weight: "bold", scale: "regular" } }),
      v("folio", "Folio", "Dark portfolio with large type.", { header: "split", hero: "editorial", services: "alternating", about: "statsRow", process: "timeline", testimonials: "cards", cta: "band", footer: "dark", tone: "dark", radius: "soft", surface: "outlined", rhythm: "bands", decor: "grid", type: { heading: "condensed", upper: true, weight: "black", scale: "grand", tracking: "normal" } }),
      v("showcase", "Showcase", "Bright and energetic, ready for a launch.", { header: "bar", hero: "splitReverse", services: "grid", about: "split", process: "steps", testimonials: "quote", faq: "accordion", cta: "split", gallery: "grid", footer: "columns", tone: "cool", radius: "pill", surface: "tinted", rhythm: "alternate", decor: "dots", density: "regular", type: { heading: "humanist", body: "humanist", weight: "bold", scale: "regular" } }),
    ],
  },
];

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

export const TEMPLATE_KEY = /^[a-z]+\.[a-z]+$/;
export const templateKey = (family: string, variation: string) => `${family}.${variation}`;

export function resolveTemplate(key: string): { family: Family; variation: Variation; spec: DesignSpec; key: string } | null {
  if (!TEMPLATE_KEY.test(key)) return null;
  const [familyId, variationId] = key.split(".");
  const family = FAMILIES.find((f) => f.id === familyId);
  const variation = family?.variations.find((x) => x.id === variationId);
  if (!family || !variation) return null;
  const { type, ...rest } = variation.overrides;
  return { family, variation, key, spec: { ...family.base, ...rest, type: { ...family.base.type, ...type } } };
}

export const ALL_TEMPLATE_KEYS = FAMILIES.flatMap((f) => f.variations.map((x) => templateKey(f.id, x.id)));
export const DEFAULT_TEMPLATE_KEY = "summit.peak";

/** Families recommended for an onboarding industry, best match first. Every family stays available. */
export function familiesForIndustry(industry: string): Family[] {
  const rank = (f: Family) => (f.industries.indexOf(industry) === -1 ? 99 : f.industries.indexOf(industry));
  return [...FAMILIES].sort((a, b) => rank(a) - rank(b));
}

/** The attributes that make two variations look and read differently. Used to prove variations are genuinely distinct. */
export function designSignature(spec: DesignSpec): string[] {
  return [
    spec.header, spec.hero, spec.services, spec.about, spec.process, spec.testimonials, spec.faq, spec.cta, spec.gallery, spec.contact, spec.footer,
    spec.density, spec.radius, spec.surface, spec.tone, spec.rhythm, spec.decor,
    spec.type.heading, spec.type.body, spec.type.scale, String(spec.type.upper), spec.type.weight, spec.type.tracking,
  ];
}
