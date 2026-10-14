// Builds a first draft of a website from facts the business owner has already given us. It composes and
// arranges; it does not invent. No testimonials, awards, statistics, certifications, years in business or
// prices are ever created here. Anything the owner didn't provide is simply left out.
import type { IconName, SectionType } from "./sections";
import { newSection, parseContent, type SiteContent, type SitePage, type SiteSection } from "./schema";
import { DEFAULT_TEMPLATE_KEY, resolveTemplate } from "./templates";

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
}

const ICONS_BY_INDUSTRY: Record<string, IconName[]> = {
  real_estate: ["home", "key", "building", "map-pin", "users", "file-text"],
  healthcare: ["stethoscope", "heart", "smile", "shield", "calendar", "users"],
  home_services: ["wrench", "hammer", "home", "zap", "droplets", "paintbrush"],
  agency: ["sparkles", "chart", "lightbulb", "camera", "users", "briefcase"],
  consulting: ["briefcase", "chart", "users", "lightbulb", "file-text", "thumbs-up"],
  legal_finance: ["scale", "briefcase", "shield", "file-text", "users", "chart"],
  local_services: ["star", "check", "sparkles", "thumbs-up", "users", "heart"],
  ecommerce: ["truck", "star", "thumbs-up", "sparkles", "shield", "heart"],
  other: ["star", "check", "sparkles", "thumbs-up", "lightbulb", "users"],
};
const iconFor = (industry: string, i: number): IconName => {
  const set = ICONS_BY_INDUSTRY[industry] ?? ICONS_BY_INDUSTRY.other;
  return set[i % set.length];
};

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

/** Turns a free-text list ("Roof repair, gutters and inspections") into service names. Never makes any up. */
export function splitServices(text: string): string[] {
  return text
    .split(/\n|;|,|[.!?](?=\s)|\band\b|•|·/i)
    .map((s) => s.replace(/^[-–—*\d.)\s]+/, "").replace(/[.!?\s]+$/, "").trim())
    .filter((s) => s.length >= 3 && s.length <= 60)
    .filter((s, i, a) => a.findIndex((x) => x.toLowerCase() === s.toLowerCase()) === i)
    .slice(0, 8);
}

const nextId = (type: SectionType, n: Map<string, number>) => {
  const k = (n.get(type) ?? 0) + 1;
  n.set(type, k);
  return `${type.toLowerCase()}-${k}`;
};

export function generateSiteContent(details: SiteDetails, templateKey: string = DEFAULT_TEMPLATE_KEY): SiteContent {
  const template = resolveTemplate(templateKey) ?? resolveTemplate(DEFAULT_TEMPLATE_KEY)!;
  const name = details.businessName.trim() || "Your business";
  const wanted = new Set(details.pages ?? ["home", "about", "services", "contact"]);
  const services = details.services.filter((s) => s.title.trim());
  const faqs = (details.faqs ?? []).filter((f) => f.question && f.answer);
  const areas = (details.areas ?? []).filter(Boolean);
  const action = details.primaryAction ?? (details.industry === "home_services" ? "call" : "enquire");
  const area = areas[0];
  const ids = new Map<string, number>();

  const headline =
    details.tagline?.trim() ||
    (services.length ? `${services.slice(0, 2).map((s) => s.title).join(" and ")}${area ? ` in ${area}` : ""}` : name);
  // Details come from several places (onboarding answers, the company profile); anything that isn't a valid number or address is left out
  // rather than failing the whole draft.
  const phone = (() => {
    const t = (details.phone ?? "").replace(/[\s().-]/g, "");
    return /^\+[1-9][0-9]{6,14}$/.test(t) ? t : "";
  })();
  const email = (() => {
    const t = (details.email ?? "").trim().toLowerCase();
    return t.length <= 320 && /^[^\s@<>()[\]\\,;:]+@[^\s@<>()[\]\\,;:]+\.[^\s@<>()[\]\\,;:]{2,}$/.test(t) ? t : "";
  })();
  const phoneLink = phone ? { label: "Call us", href: `tel:${phone}` } : null;
  const enquire = { label: action === "book" ? "Request an appointment" : "Get in touch", href: "/contact" };
  const primary = action === "call" && phoneLink ? phoneLink : enquire;
  const secondary = services.length && wanted.has("services") ? { label: "See what we do", href: "/services" } : phoneLink && primary !== phoneLink ? phoneLink : { label: "", href: "" };

  const section = (type: SectionType, data: Record<string, unknown>): SiteSection => {
    const base = newSection(type, nextId(type, ids));
    return { ...base, data: { ...base.data, ...data } };
  };

  const heroSection = section("hero", {
    eyebrow: area ? clip(`Serving ${areas.slice(0, 2).join(" and ")}`, 60) : "",
    headline: clip(headline, 120),
    subheadline: clip(details.description?.trim() ?? "", 320),
    primaryCta: primary,
    secondaryCta: secondary,
    image: details.heroImageId ?? null,
  });
  const servicesSection = (cap?: number) =>
    section("services", {
      heading: "What we do",
      intro: "",
      items: services.slice(0, cap ?? 12).map((s, i) => ({ title: clip(s.title, 80), description: clip(s.description ?? "", 260), icon: iconFor(details.industry, i), link: { label: "", href: "" } })),
    });
  const aboutBody = (details.aboutText ?? details.description ?? "").trim();
  const aboutSection = () => section("about", { heading: `About ${name}`, body: clip(aboutBody, 1600), image: details.aboutImageId ?? null });
  const faqSection = () => section("faq", { heading: "Questions we're often asked", items: faqs.slice(0, 20).map((f) => ({ question: clip(f.question, 160), answer: clip(f.answer, 600) })) });
  const gallerySection = () => section("gallery", { heading: "Our work", images: (details.galleryAssetIds ?? []).slice(0, 12).map((image) => ({ image, caption: "" })) });
  const areasSection = () => section("areas", { heading: "Where we work", areas: areas.slice(0, 30).map((a) => clip(a, 60)) });
  const ctaSection = () =>
    section("cta", {
      heading: action === "book" ? "Ready to book?" : "Ready to get started?",
      body: "Tell us what you need and we'll get back to you.",
      button: primary,
      secondary: { label: "", href: "" },
    });
  const contactSection = () =>
    section("contact", {
      heading: action === "book" ? "Request an appointment" : "Get in touch",
      intro: action === "book" ? "Tell us when suits you. We'll confirm availability with you before anything is booked." : "Tell us what you need and we'll get back to you.",
      showDetails: true,
      showForm: true,
      submitLabel: action === "book" ? "Request appointment" : "Send message",
    });

  // Home follows the template's own composition, skipping anything the owner hasn't given us content for.
  const homeSections: SiteSection[] = [];
  for (const type of template.spec.home) {
    if (type === "hero") homeSections.push(heroSection);
    else if (type === "services" && services.length) homeSections.push(servicesSection(wanted.has("services") ? 6 : 12));
    else if (type === "about" && aboutBody && !wanted.has("about")) homeSections.push(aboutSection());
    else if (type === "about" && aboutBody && wanted.has("about")) homeSections.push(section("about", { heading: `About ${name}`, body: clip(aboutBody, 480), image: details.aboutImageId ?? null }));
    else if (type === "faq" && faqs.length && !wanted.has("faq")) homeSections.push(faqSection());
    else if (type === "gallery" && details.galleryAssetIds?.length) homeSections.push(gallerySection());
    else if (type === "cta") homeSections.push(ctaSection());
    else if (type === "contact" && !wanted.has("contact")) homeSections.push(contactSection());
  }
  if (areas.length && !homeSections.some((s) => s.type === "areas")) {
    const at = homeSections.findIndex((s) => s.type === "cta");
    homeSections.splice(at === -1 ? homeSections.length : at, 0, areasSection());
  }

  const pages: SitePage[] = [{ slug: "home", title: name, navLabel: "Home", showInNav: true, seoTitle: "", seoDescription: "", sections: homeSections }];
  const addPage = (slug: string, title: string, sections: SiteSection[], seoDescription = "") => {
    if (sections.length) pages.push({ slug, title, navLabel: title, showInNav: true, seoTitle: "", seoDescription, sections });
  };
  if (wanted.has("about") && aboutBody) addPage("about", "About", [aboutSection()]);
  if (wanted.has("services") && services.length) addPage("services", "Services", [servicesSection(), ctaSection()]);
  if (wanted.has("faq") && faqs.length) addPage("faq", "FAQ", [faqSection()]);
  if (wanted.has("gallery") && details.galleryAssetIds?.length) addPage("gallery", "Gallery", [gallerySection()]);
  pages.push({ slug: "contact", title: action === "book" ? "Book" : "Contact", navLabel: action === "book" ? "Book" : "Contact", showInNav: true, seoTitle: "", seoDescription: "", sections: [contactSection()] });

  const parsed = parseContent({
    schemaVersion: 1,
    isSample: false,
    business: { name, tagline: clip(details.tagline ?? "", 140), phone, email, address: clip(details.address ?? "", 200), hours: clip(details.hours ?? "", 300) },
    brand: { primary: details.primary ?? "#2c5bff", accent: details.accent ?? "#12c9a5", logoAssetId: details.logoAssetId ?? null, logoVariant: "original" },
    seo: { title: clip(details.tagline ? `${name} | ${details.tagline}` : name, 70), description: clip((details.description ?? "").replace(/\s+/g, " "), 160), ogImageAssetId: null, noindex: false },
    social: {},
    form: { enabled: true, fields: { phone: "optional", message: "required", service: services.length >= 2 ? "optional" : "hidden" }, services: services.map((s) => clip(s.title, 60)).slice(0, 12), marketingOptIn: false },
    footer: { note: "", poweredBy: false },
    pages,
  });
  if (!parsed.ok) throw new Error(`Generated content was invalid: ${parsed.error} (${parsed.path})`);
  return parsed.content;
}

// ---------------------------------------------------------------------------
// Sample content for browsing templates. Clearly sample, and unpublishable.
// ---------------------------------------------------------------------------

const SAMPLE_BY_INDUSTRY: Record<string, { name: string; tagline: string; services: string[]; area: string }> = {
  real_estate: { name: "Your Realty", tagline: "Find a place that fits your life", services: ["Buying a home", "Selling your property", "Rentals and lettings", "Property valuations", "Investment advice", "Relocation support"], area: "Your city" },
  healthcare: { name: "Your Clinic", tagline: "Care that fits around you", services: ["Check-ups", "Treatments", "Emergency appointments", "Family care", "Preventive care", "Consultations"], area: "Your area" },
  home_services: { name: "Your Home Services", tagline: "Reliable work, clear quotes", services: ["Repairs", "Installations", "Inspections", "Maintenance plans", "Emergency call-outs", "Free quotes"], area: "Your area" },
  agency: { name: "Your Agency", tagline: "Work that moves your business forward", services: ["Strategy", "Design", "Websites", "Campaigns", "Content", "Reporting"], area: "Worldwide" },
  consulting: { name: "Your Consultancy", tagline: "Clear advice for confident decisions", services: ["Advisory", "Workshops", "Reviews", "Coaching", "Projects", "Training"], area: "Online and in person" },
  legal_finance: { name: "Your Practice", tagline: "Straightforward advice you can rely on", services: ["Consultations", "Planning", "Representation", "Reviews", "Filings", "Ongoing support"], area: "Your region" },
  local_services: { name: "Your Local Business", tagline: "Friendly service, right around the corner", services: ["Our main service", "Packages", "Gift cards", "Memberships", "Classes", "Walk-ins"], area: "Your neighbourhood" },
  ecommerce: { name: "Your Shop", tagline: "Good things, delivered", services: ["New arrivals", "Best-selling lines", "Gift ideas", "Delivery", "Returns", "Custom orders"], area: "Nationwide" },
  other: { name: "Your Business", tagline: "What you do, in a sentence", services: ["Service one", "Service two", "Service three", "Service four", "Service five", "Service six"], area: "Your area" },
};

export function sampleContent(industry: string, templateKey: string = DEFAULT_TEMPLATE_KEY): SiteContent {
  const s = SAMPLE_BY_INDUSTRY[industry] ?? SAMPLE_BY_INDUSTRY.other;
  const content = generateSiteContent(
    {
      businessName: s.name, industry, tagline: s.tagline,
      description: "A short description of what you do and who you help appears here. You'll replace this with your own words.",
      services: s.services.map((title) => ({ title, description: "A line or two describing this service, written by you." })),
      phone: "+15125550100", email: "hello@example.com", address: "123 Example Street", hours: "Mon–Fri 9:00–17:00", areas: [s.area, "Nearby suburbs"],
      pages: ["home", "about", "services", "faq", "contact"],
      faqs: [{ question: "A question your customers often ask?", answer: "Your answer goes here, in your own words." }],
      aboutText: "Tell your story here: who you are, what you care about and why customers choose you.",
    },
    templateKey,
  );
  const home = content.pages[0];
  // A single, clearly fictional testimonial so the layout is visible when browsing. The live site can never show it.
  const at = home.sections.findIndex((x) => x.type === "cta");
  home.sections.splice(at === -1 ? home.sections.length : at, 0, {
    ...newSection("testimonials", "testimonials-1"),
    data: { heading: "What customers say", items: [{ quote: "A real customer's words about working with you will appear here.", author: "Sample customer", role: "", confirmedReal: false }] },
  });
  return { ...content, isSample: true };
}

