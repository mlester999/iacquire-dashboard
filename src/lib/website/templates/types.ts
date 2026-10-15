// What a template needs to build a site, and what it returns.
import type { Builder } from "../build";
import type { Design, Page, PageItem, Section, SiteContent } from "../doc";

/** Facts about a business, gathered from onboarding. Templates compose and arrange them; they never invent claims. */
export interface SiteDetails {
  businessName: string;
  industry: string;
  tagline?: string;
  description?: string;
  /** One entry per service. Descriptions are optional and only ever the owner's own words. */
  services: Array<{ title: string; description?: string }>;
  phone?: string;
  email?: string;
  address?: string;
  hours?: string;
  areas?: string[];
  primary?: string;
  accent?: string;
  /** Pages the owner wants, from the onboarding page list. Home and Contact always exist. */
  pages?: string[];
  /** Confirmed FAQs only: AI-suggested text must have been approved by the owner before it gets here. */
  faqs?: Array<{ question: string; answer: string }>;
  aboutText?: string;
  logoAssetId?: string | null;
  heroImageId?: string | null;
  aboutImageId?: string | null;
  galleryAssetIds?: string[];
  /** Whether the visitor's main action is to phone, or to send an enquiry. */
  primaryAction?: "call" | "enquire" | "book";
  /** Figures and quotes exist only in sample content, which can never be published. */
  stats?: Array<{ value: string; suffix?: string; label: string }>;
  testimonials?: Array<{ quote: string; author: string; role?: string }>;
  team?: Array<{ name: string; role: string; bio?: string }>;
  steps?: Array<{ title: string; text: string }>;
  pricing?: Array<{ name: string; price: string; period?: string; text?: string; features: string[]; featured?: boolean }>;
  highlights?: string[];
  /** Words for a scrolling band (sample content only, or the owner's service names). */
  marquee?: string[];
}

export interface Has {
  services: boolean;
  about: boolean;
  faqs: boolean;
  areas: boolean;
  gallery: boolean;
  stats: boolean;
  testimonials: boolean;
  team: boolean;
  steps: boolean;
  pricing: boolean;
  phone: boolean;
  email: boolean;
  address: boolean;
  hours: boolean;
  logo: boolean;
  highlights: boolean;
}

export interface TemplateCtx {
  b: Builder;
  d: SiteDetails;
  has: Has;
  sample: boolean;
  name: string;
  /** The text of the headline: the owner's tagline, or something drawn from their services and area. */
  headline: string;
  lede: string;
  primaryHref: string;
  primaryLabel: string;
  secondary: { label: string; href: string } | null;
  phoneLink: { label: string; href: string } | null;
  /** The pages that exist besides home and contact. */
  pages: Set<"about" | "services" | "faq" | "gallery">;
  action: "call" | "enquire" | "book";
}

/** What a variation builds: its design tokens, shared header and footer, and the sections of each page. */
export interface Recipe {
  design: Partial<Design>;
  header: Section | null;
  footer: Section | null;
  home: PageItem[];
  about?: PageItem[];
  services?: PageItem[];
  faq?: PageItem[];
  gallery?: PageItem[];
  contact: PageItem[];
  /** Section ids that should be shared across pages (such as a closing call to action). */
  globals?: Record<string, Section>;
}

export interface VariationDef {
  id: string;
  name: string;
  description: string;
  /** Style words for search and filters, such as "dark", "editorial" or "playful". */
  tags: string[];
  build: (ctx: TemplateCtx) => Recipe;
}

export interface FamilyDef {
  id: string;
  name: string;
  tagline: string;
  description: string;
  /** Onboarding industries this family was designed for (every family can be used for any business). */
  industries: string[];
  tags: string[];
  /** The sample business shown while browsing this family. */
  sample: SiteDetails;
  variations: VariationDef[];
}

export type { Page, SiteContent };
