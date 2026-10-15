// What an owner can add to a page: finished sections (heroes, services, galleries, pricing, FAQs, footers…), blank layouts, and single
// elements. Sections are built by the same functions the templates use, from the facts already on the site, so an added section matches
// the site's own design and is edited exactly like any other. Anything the owner must write themselves (a customer quote, a price,
// a person's name) starts as a [bracketed prompt]; the publish check refuses to go live until it has been replaced.
import { art, createBuilder } from "../build";
import { ELEMENT_DEFS, elementDefaults, GROUP_ORDER, type ElementType } from "../catalog";
import { collectIds, eachElement, type Column, type ElementNode, type Section, type SiteContent } from "../doc";
import { cloneWithNewIds, newId } from "../ops";
import { makeCtx } from "../templates/compose";
import * as B from "../templates/blocks";
import * as C from "../templates/chrome";
import type { SiteDetails, TemplateCtx } from "../templates/types";

export type SectionCategory =
  | "Hero" | "Introduction" | "Services" | "About" | "Benefits" | "Process" | "Gallery" | "Team" | "Testimonials" | "Numbers" | "Pricing" | "FAQ"
  | "Contact" | "Call to action" | "Lead capture" | "Logos" | "Header" | "Footer" | "Text";

export const SECTION_CATEGORIES: SectionCategory[] = [
  "Hero", "Introduction", "Services", "About", "Benefits", "Process", "Gallery", "Team", "Testimonials", "Numbers", "Pricing", "FAQ", "Contact", "Lead capture", "Call to action", "Logos", "Text", "Header", "Footer",
];

export interface SectionPreset {
  id: string;
  label: string;
  category: SectionCategory;
  description: string;
  /** Where it goes: on the page, or as the site-wide header or footer. */
  place: "page" | "header" | "footer";
  build: (ctx: TemplateCtx) => Section | null;
}

const P = (s: string) => `[${s}]`;

/** The facts on the site, shaped for the section builders, with bracketed prompts where the owner has to supply something. */
export function libraryContext(doc: SiteContent, idPrefix = "z"): TemplateCtx {
  const services: string[] = [];
  const faqs: Array<{ question: string; answer: string }> = [];
  eachElement(doc, (e) => {
    if (e.type === "services" && !services.length) for (const it of (e.props.items as Array<{ title: string }>) ?? []) if (it.title) services.push(it.title);
    if (e.type === "faq" && !faqs.length) for (const it of (e.props.items as Array<{ q: string; a: string }>) ?? []) if (it.q && it.a) faqs.push({ question: it.q, answer: it.a });
  });
  const details: SiteDetails = {
    businessName: doc.business.name, industry: "other", tagline: doc.business.tagline, description: doc.seo.description || doc.business.tagline || P("Say in a sentence what you do and who it is for."),
    services: (services.length ? services : [P("Service one"), P("Service two"), P("Service three")]).slice(0, 6).map((title) => ({ title })),
    phone: doc.business.phone, email: doc.business.email, address: doc.business.address, hours: doc.business.hours, areas: doc.business.areas,
    pages: ["home", "about", "services", "faq", "gallery", "contact"],
    faqs: faqs.length ? faqs : [{ question: P("A question customers ask"), answer: P("Your answer") }, { question: P("Another question"), answer: P("Your answer") }, { question: P("One more"), answer: P("Your answer") }],
    aboutText: doc.seo.description || P("Tell visitors who you are and what it is like to work with you."),
    primaryAction: "enquire",
    stats: [{ value: P("00"), label: P("What it measures") }, { value: P("00"), label: P("What it measures") }, { value: P("00"), label: P("What it measures") }],
    testimonials: [{ quote: P("What a customer said, in their own words"), author: P("Customer name") }, { quote: P("What a customer said, in their own words"), author: P("Customer name") }, { quote: P("What a customer said, in their own words"), author: P("Customer name") }],
    team: [{ name: P("Name"), role: P("Role"), bio: P("A short bio") }, { name: P("Name"), role: P("Role"), bio: P("A short bio") }, { name: P("Name"), role: P("Role"), bio: P("A short bio") }],
    steps: [{ title: P("First step"), text: P("What happens") }, { title: P("Second step"), text: P("What happens") }, { title: P("Third step"), text: P("What happens") }],
    pricing: [{ name: P("Plan"), price: P("Price"), period: "", text: P("Who it is for"), features: [P("What is included"), P("What is included")], featured: false }, { name: P("Plan"), price: P("Price"), period: "", text: P("Who it is for"), features: [P("What is included"), P("What is included")], featured: true }],
    highlights: [P("Highlight"), P("Highlight"), P("Highlight")],
  };
  const ctx = makeCtx(details, { sample: true, idPrefix });
  // The headline of a new hero is the owner's own tagline or business name, never a bracketed prompt.
  return ctx;
}

const ICONS = ["sparkles", "check", "star", "heart", "shield", "clock"];
const IMG = (...scenes: string[]) => scenes.map((s, i) => art(s, "auto", i + 1));

/** Benefits in a row of icon cards. */
function benefits(ctx: TemplateCtx, style: "cards" | "plain" | "numbered"): Section {
  const { b } = ctx;
  const items = [0, 1, 2].map((i) => ({ title: P(`Benefit ${i + 1}`), text: P("Say what it means for the customer"), icon: ICONS[i], image: null, link: { label: "", href: "" } }));
  return b.section({ id: b.id("benefits"), name: "Benefits", layout: { pt: "2xl", pb: "2xl", width: "wide", gap: "xl", valign: "start" } }, [
    b.col(12, [...B.sectionHead(ctx, { eyebrow: P("Why choose us"), title: P("The reasons customers stay"), align: "center" }), b.el("services", { style: style === "cards" ? "iconCards" : style === "numbered" ? "numbered" : "list", cols: "3", items }, { anim: "up" })], { gap: "l" }),
  ]);
}

/** A short enquiry form on a tinted band. */
function leadCapture(ctx: TemplateCtx, style: "band" | "side"): Section {
  const { b } = ctx;
  const form = b.el("form", { purpose: "lead", submitLabel: "Send", layout: "card", phone: "optional", message: "hidden", service: "hidden", services: [], helper: "" }, { anim: "up" });
  if (style === "side") {
    return b.section({ id: b.id("lead"), name: "Lead capture", tone: "brand", layout: { pt: "2xl", pb: "2xl", width: "wide", gap: "xl", valign: "center" } }, [
      b.col(6, [b.eyebrow(P("Free")), b.h2(P("Offer something worth leaving an email for"), { style: { size: "4xl" } }), b.lede(P("Say what they get and what happens next."), { style: { w: "m", color: "onPrimary" } })], { gap: "m" }),
      b.col(6, [form]),
    ]);
  }
  return b.section({ id: b.id("lead"), name: "Lead capture", layout: { pt: "xl", pb: "xl", width: "narrow" } }, [
    b.col(12, [b.card([b.h2(P("Get a quick reply"), { style: { size: "3xl", align: "center" } }), b.body(P("Leave your details and we will be in touch."), { style: { align: "center" } }), form], { surface: "tinted", pad: "xl", gap: "m" })]),
  ]);
}

/** A plain text section: a heading and a paragraph. */
function textBlock(ctx: TemplateCtx, layout: "single" | "two"): Section {
  const { b } = ctx;
  if (layout === "two") {
    return b.section({ id: b.id("text"), name: "Text", layout: { pt: "xl", pb: "xl", width: "wide", gap: "xl", valign: "start" } }, [
      b.col(6, [b.h2(P("Heading"), { style: { size: "4xl" } }), b.body(P("Write something helpful here."))], { gap: "s" }),
      b.col(6, [b.body(P("Write something helpful here."))], { gap: "s" }),
    ]);
  }
  return b.section({ id: b.id("text"), name: "Text", layout: { pt: "xl", pb: "xl", width: "narrow" } }, [b.col(12, [b.h2(P("Heading"), { style: { size: "4xl" } }), b.body(P("Write something helpful here."))], { gap: "s" })]);
}

/** A video section. */
function videoBlock(ctx: TemplateCtx): Section {
  const { b } = ctx;
  return b.section({ id: b.id("video"), name: "Video", layout: { pt: "xl", pb: "xl", width: "regular" } }, [b.col(12, [...B.sectionHead(ctx, { title: P("See it in action"), align: "center" }), b.el("video", { provider: "youtube", videoId: "", poster: null, title: "", aspect: "16/9" })], { gap: "m" })]);
}

export const SECTION_PRESETS: SectionPreset[] = [
  // Heroes
  { id: "hero-full", label: "Full-screen image", category: "Hero", place: "page", description: "A full-bleed picture with the headline set low and to the left.", build: (c) => B.heroFull(c, { image: art("villa", "warm") }) },
  { id: "hero-full-centered", label: "Centred over image", category: "Hero", place: "page", description: "Headline centred over a darkened picture.", build: (c) => B.heroFull(c, { image: art("terrace", "warm"), align: "center", valign: "center", overlay: { opacity: 62, dir: "flat" } }) },
  { id: "hero-split", label: "Text and image", category: "Hero", place: "page", description: "Words on one side, a framed picture on the other.", build: (c) => B.heroSplit(c, { image: art("interior", "light"), frame: "soft" }) },
  { id: "hero-split-arch", label: "Split with arch frame", category: "Hero", place: "page", description: "A tall arched picture beside the headline.", build: (c) => B.heroSplit(c, { image: art("garden", "warm"), frame: "arch", reverse: true, tone: "brand" }) },
  { id: "hero-centered", label: "Centred statement", category: "Hero", place: "page", description: "A large centred headline, with room to breathe.", build: (c) => B.heroCentered(c, {}) },
  { id: "hero-editorial", label: "Editorial pair", category: "Hero", place: "page", description: "Two overlapping pictures with a magazine-style headline.", build: (c) => B.heroEditorial(c, { images: [art("townhouse", "warm"), art("interior", "light")] as [never, never] }) },
  // Introduction
  { id: "intro-two", label: "Two-column intro", category: "Introduction", place: "page", description: "A heading on the left and a lead-in on the right.", build: (c) => B.introSection(c, { layout: "two", eyebrow: "Welcome" }) },
  { id: "intro-statement", label: "Big statement", category: "Introduction", place: "page", description: "One large centred paragraph that sets the tone.", build: (c) => B.introSection(c, { layout: "statement", eyebrow: "Our approach" }) },
  { id: "words", label: "Scrolling words", category: "Introduction", place: "page", description: "A slow band of your service names or areas.", build: (c) => B.wordBand(c, { style: "outline", size: "5xl", words: c.d.services.map((s) => s.title) }) },
  // Services
  { id: "svc-cards", label: "Service cards", category: "Services", place: "page", description: "Your services as clean cards.", build: (c) => B.servicesSection(c, { style: "grid", cols: "3", icons: ICONS, title: "What we do" }) },
  { id: "svc-icons", label: "Icon cards", category: "Services", place: "page", description: "Each service with an icon on top.", build: (c) => B.servicesSection(c, { style: "iconCards", cols: "3", icons: ICONS, title: "What we do", align: "center" }) },
  { id: "svc-image", label: "Image cards", category: "Services", place: "page", description: "Picture-led service cards.", build: (c) => B.servicesSection(c, { style: "imageCards", cols: "3", icons: ICONS, images: IMG("interior", "garden", "terrace"), title: "What we do" }) },
  { id: "svc-bento", label: "Bento grid", category: "Services", place: "page", description: "An asymmetric grid with one large feature.", build: (c) => B.servicesSection(c, { style: "bento", icons: ICONS, images: IMG("villa", "interior", "garden", "terrace"), title: "What we do" }) },
  { id: "svc-rows", label: "Numbered rows", category: "Services", place: "page", description: "Services listed as large numbered rows.", build: (c) => B.servicesSection(c, { style: "numbered", icons: ICONS, layout: "side", title: "What we do" }) },
  { id: "svc-alt", label: "Alternating", category: "Services", place: "page", description: "Services with pictures that alternate sides.", build: (c) => B.servicesSection(c, { style: "alternating", icons: ICONS, images: IMG("interior", "garden", "terrace"), title: "What we do" }) },
  // About
  { id: "about-split", label: "About: text and photo", category: "About", place: "page", description: "Your story beside a photograph.", build: (c) => B.aboutSection(c, { image: art("interior", "light") }) },
  { id: "about-collage", label: "About: image collage", category: "About", place: "page", description: "Your story with three staggered pictures.", build: (c) => B.aboutSection(c, { collage: { layout: "trio", images: IMG("interior", "garden", "townhouse") }, reverse: true }) },
  // Benefits
  { id: "benefits-cards", label: "Benefits: cards", category: "Benefits", place: "page", description: "Three reasons to choose you, as cards.", build: (c) => benefits(c, "cards") },
  { id: "benefits-numbered", label: "Benefits: numbered", category: "Benefits", place: "page", description: "Three reasons with large numbers.", build: (c) => benefits(c, "numbered") },
  // Process
  { id: "process-timeline", label: "Process timeline", category: "Process", place: "page", description: "Steps from first contact to done.", build: (c) => B.processSection(c, { style: "timeline" }) },
  { id: "process-cards", label: "Process cards", category: "Process", place: "page", description: "Each step as a card.", build: (c) => B.processSection(c, { style: "cards" }) },
  { id: "process-side", label: "Process, side heading", category: "Process", place: "page", description: "Numbered steps beside a heading.", build: (c) => B.processSection(c, { style: "numbered", side: true }) },
  // Gallery
  { id: "gallery-grid", label: "Gallery grid", category: "Gallery", place: "page", description: "A tidy grid of your photos.", build: (c) => B.gallerySection(c, { images: IMG("villa", "interior", "garden", "terrace", "townhouse", "neighborhood"), cols: "3" }) },
  { id: "gallery-masonry", label: "Masonry gallery", category: "Gallery", place: "page", description: "Photos of different shapes, packed together.", build: (c) => B.gallerySection(c, { images: IMG("villa", "interior", "garden", "terrace", "townhouse", "neighborhood"), layout: "masonry", cols: "3" }) },
  { id: "gallery-mosaic", label: "Property mosaic", category: "Gallery", place: "page", description: "One large feature image with smaller ones around it.", build: (c) => B.gallerySection(c, { images: IMG("villa", "interior", "garden", "terrace", "townhouse"), layout: "mosaic", cols: "3", title: "Featured work" }) },
  { id: "gallery-strip", label: "Scrolling strip", category: "Gallery", place: "page", description: "A row of photos that scrolls sideways.", build: (c) => B.gallerySection(c, { images: IMG("villa", "interior", "garden", "terrace", "townhouse"), layout: "strip", width: "full" }) },
  // Team
  { id: "team-cards", label: "Team cards", category: "Team", place: "page", description: "The people customers will meet.", build: (c) => B.teamSection(c, { style: "cards", cols: "3" }) },
  { id: "team-circles", label: "Team: round photos", category: "Team", place: "page", description: "Friendly round portraits.", build: (c) => B.teamSection(c, { style: "circles", cols: "3" }) },
  // Testimonials
  { id: "testi-cards", label: "Testimonial cards", category: "Testimonials", place: "page", description: "Real customer words, as cards. You confirm each is genuine.", build: (c) => B.testimonialsSection(c, { style: "cards" }) },
  { id: "testi-quote", label: "Large quote", category: "Testimonials", place: "page", description: "One quote, big.", build: (c) => B.testimonialsSection(c, { style: "quote", width: "narrow" }) },
  // Numbers
  { id: "stats-row", label: "Numbers row", category: "Numbers", place: "page", description: "A few figures you can prove.", build: (c) => B.statsSection(c, { style: "row" }) },
  { id: "stats-big", label: "Large numbers", category: "Numbers", place: "page", description: "Big, bold figures.", build: (c) => B.statsSection(c, { style: "big", head: true, title: "In numbers", eyebrow: "At a glance" }) },
  // Pricing
  { id: "pricing", label: "Pricing plans", category: "Pricing", place: "page", description: "Plans side by side, with one highlighted. Use only approved prices.", build: (c) => B.pricingSection(c, {}) },
  // FAQ
  { id: "faq-accordion", label: "FAQ accordion", category: "FAQ", place: "page", description: "Questions that open and close.", build: (c) => B.faqSection(c, { style: "accordion" }) },
  { id: "faq-side", label: "FAQ, side heading", category: "FAQ", place: "page", description: "Heading on the left, answers on the right.", build: (c) => B.faqSection(c, { style: "lines", side: true }) },
  { id: "faq-cards", label: "FAQ cards", category: "FAQ", place: "page", description: "Each answer in its own card.", build: (c) => B.faqSection(c, { style: "cards" }) },
  // Contact and lead capture
  { id: "contact-split", label: "Contact: form and details", category: "Contact", place: "page", description: "Your details beside an enquiry form.", build: (c) => B.contactSection(c, { style: "split" }) },
  { id: "contact-map", label: "Contact with location", category: "Contact", place: "page", description: "Details, a form and a link to your address on a map.", build: (c) => B.contactSection(c, { style: "map" }) },
  { id: "contact-stacked", label: "Contact: simple", category: "Contact", place: "page", description: "A centred form with your details below.", build: (c) => B.contactSection(c, { style: "stacked" }) },
  { id: "lead-band", label: "Quick lead form", category: "Lead capture", place: "page", description: "A short form on a tinted card.", build: (c) => leadCapture(c, "band") },
  { id: "lead-side", label: "Offer with form", category: "Lead capture", place: "page", description: "An offer on one side and the form on the other.", build: (c) => leadCapture(c, "side") },
  // Calls to action
  { id: "cta-band", label: "Call to action band", category: "Call to action", place: "page", description: "A coloured band with one clear next step.", build: (c) => B.ctaSection(c, { style: "band" }) },
  { id: "cta-card", label: "Call to action card", category: "Call to action", place: "page", description: "A tinted card, centred.", build: (c) => B.ctaSection(c, { style: "card" }) },
  { id: "cta-image", label: "Call to action over image", category: "Call to action", place: "page", description: "A full-width picture with a clear button.", build: (c) => B.ctaSection(c, { style: "image" }) },
  { id: "cta-split", label: "Call to action, split", category: "Call to action", place: "page", description: "Words on the left, buttons on the right.", build: (c) => B.ctaSection(c, { style: "split" }) },
  // Logos, text, video
  { id: "logos", label: "Logo strip", category: "Logos", place: "page", description: "Partners or accreditations you really hold.", build: (c) => { const s = B.logosStrip(c, { names: [P("Name"), P("Name"), P("Name"), P("Name")], label: P("Trusted by") }); return s; } },
  { id: "text-single", label: "Heading and text", category: "Text", place: "page", description: "A simple, readable block of writing.", build: (c) => textBlock(c, "single") },
  { id: "text-two", label: "Two columns of text", category: "Text", place: "page", description: "Two side-by-side paragraphs.", build: (c) => textBlock(c, "two") },
  { id: "video", label: "Video", category: "Text", place: "page", description: "A video that loads only when someone presses play.", build: (c) => videoBlock(c) },
  // Headers and footers
  { id: "header-bar", label: "Header: logo and links", category: "Header", place: "header", description: "Logo left, links and a button right.", build: (c) => C.headerBar(c, { sticky: true }) },
  { id: "header-split", label: "Header: centred logo", category: "Header", place: "header", description: "Links, a centred logo and a button.", build: (c) => C.headerSplit(c, {}) },
  { id: "header-centered", label: "Header: stacked", category: "Header", place: "header", description: "Logo above, links below.", build: (c) => C.headerCentered(c, {}) },
  { id: "header-floating", label: "Header: floating pill", category: "Header", place: "header", description: "A rounded bar over the top of the first section.", build: (c) => C.headerFloating(c, {}) },
  { id: "header-minimal", label: "Header: minimal", category: "Header", place: "header", description: "Just a logo and a menu.", build: (c) => C.headerMinimal(c, {}) },
  { id: "footer-columns", label: "Footer: columns", category: "Footer", place: "footer", description: "Logo, links and contact details.", build: (c) => C.footerColumns(c, {}) },
  { id: "footer-centered", label: "Footer: centred", category: "Footer", place: "footer", description: "Everything centred, with social links.", build: (c) => C.footerCentered(c, {}) },
  { id: "footer-minimal", label: "Footer: one line", category: "Footer", place: "footer", description: "A single quiet line.", build: (c) => C.footerMinimal(c, {}) },
  { id: "footer-big", label: "Footer: big wordmark", category: "Footer", place: "footer", description: "Your name, huge, across the bottom.", build: (c) => C.footerBig(c, {}) },
];

export const presetsByCategory = (): Array<{ category: SectionCategory; presets: SectionPreset[] }> =>
  SECTION_CATEGORIES.map((category) => ({ category, presets: SECTION_PRESETS.filter((p) => p.category === category) })).filter((g) => g.presets.length);

/** Builds a preset for this site with ids that cannot collide with anything already in it. */
export function buildPreset(doc: SiteContent, preset: SectionPreset): Section | null {
  const section = preset.build(libraryContext(doc, "z"));
  if (!section) return null;
  // Headers and footers keep their fixed ids; everything else is renamed so adding the same block twice never collides.
  const used = new Set(collectIds(doc));
  const copy = cloneWithNewIds(section, used);
  return preset.place === "page" ? copy : { ...copy, id: preset.place };
}

// ---------------------------------------------------------------------------
// Blank layouts
// ---------------------------------------------------------------------------

export interface LayoutPreset {
  id: string;
  label: string;
  spans: number[];
}
export const LAYOUT_PRESETS: LayoutPreset[] = [
  { id: "one", label: "One column", spans: [12] },
  { id: "two", label: "Two equal columns", spans: [6, 6] },
  { id: "left", label: "Wide left, narrow right", spans: [8, 4] },
  { id: "right", label: "Narrow left, wide right", spans: [4, 8] },
  { id: "three", label: "Three columns", spans: [4, 4, 4] },
  { id: "feature", label: "One large, two small", spans: [6, 3, 3] },
  { id: "four", label: "Four columns", spans: [3, 3, 3, 3] },
];

export function buildLayout(doc: SiteContent, layout: LayoutPreset): Section {
  const b = createBuilder("y");
  const cols: Column[] = layout.spans.map((span) => b.col(span, [b.h3(P("Heading")), b.body(P("Write something helpful here."))], { gap: "s" }));
  const sec = b.section({ name: "Layout", layout: { pt: "xl", pb: "xl", width: "wide", gap: "l", valign: "start" } }, cols);
  return cloneWithNewIds(sec, new Set(collectIds(doc)));
}

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

/** What a freshly added element says: a prompt in brackets where the owner must write something. */
const STARTER: Partial<Record<ElementType, Record<string, unknown>>> = {
  heading: { text: P("Your headline"), level: "2" },
  text: { text: P("Write something helpful here."), role: "body" },
  button: { link: { label: P("Button label"), href: "/contact" }, variant: "primary", size: "m", icon: "arrow-right" },
  badge: { text: P("Label"), style: "pill" },
  list: { items: [P("First point"), P("Second point"), P("Third point")], style: "check", cols: "1" },
  services: { style: "grid", cols: "3", items: [0, 1, 2].map((i) => ({ title: P(`Service ${i + 1}`), text: P("A short description"), icon: ICONS[i], image: null, link: { label: "", href: "" } })) },
  steps: { style: "timeline", items: [0, 1, 2].map((i) => ({ title: P(`Step ${i + 1}`), text: P("What happens") })) },
  faq: { style: "accordion", openFirst: true, items: [{ q: P("A question customers ask"), a: P("Your answer") }, { q: P("Another question"), a: P("Your answer") }] },
  testimonials: { style: "cards", items: [{ quote: P("What a customer said, in their own words"), author: P("Customer name"), role: "", avatar: null, confirmedReal: false }] },
  stats: { style: "row", countUp: true, items: [0, 1, 2].map(() => ({ value: P("00"), prefix: "", suffix: "", label: P("What it measures") })) },
  logos: { style: "row", grayscale: true, items: [0, 1, 2, 3].map(() => ({ name: P("Name"), image: null })) },
  team: { style: "cards", cols: "3", members: [0, 1, 2].map(() => ({ name: P("Name"), role: P("Role"), photo: null, bio: "" })) },
  pricing: { note: "", plans: [{ name: P("Plan"), price: P("Price"), period: "", text: P("Who it is for"), features: [P("What is included")], cta: { label: "Get started", href: "/contact" }, featured: false }] },
  gallery: { layout: "grid", cols: "3", aspect: "4/3", gap: "s", items: [0, 1, 2].map(() => ({ src: null, alt: "", caption: "" })) },
  collage: { layout: "trio", items: [0, 1, 2].map(() => ({ src: null, alt: "" })) },
  marquee: { items: [P("Word"), P("Word"), P("Word")], speed: "normal", style: "text" },
};

export interface ElementPreset {
  type: ElementType;
  label: string;
  group: (typeof GROUP_ORDER)[number];
  description: string;
}
export const ELEMENT_PRESETS: ElementPreset[] = (Object.values(ELEMENT_DEFS) as Array<(typeof ELEMENT_DEFS)[ElementType]>)
  .filter((d) => d.addable)
  .map((d) => ({ type: d.type, label: d.label, group: d.group, description: d.description }));

export const elementPresetGroups = () => GROUP_ORDER.map((group) => ({ group, items: ELEMENT_PRESETS.filter((e) => e.group === group) })).filter((g) => g.items.length);

/** A new element with a unique id and starter content. */
export function newElement(doc: SiteContent | Set<string>, type: ElementType): ElementNode {
  const used = doc instanceof Set ? doc : new Set(collectIds(doc));
  const prefix = ({ heading: "hd", text: "tx", image: "im", button: "bt", group: "gr", card: "cd" } as Record<string, string>)[type] ?? type.slice(0, 2);
  const node: ElementNode = { id: newId(used, prefix), type, props: { ...elementDefaults(type), ...(STARTER[type] ?? {}) } };
  if (type === "group" || type === "card") {
    node.children = [];
    if (type === "card") node.children.push({ id: newId(used, "hd"), type: "heading", props: { ...elementDefaults("heading"), text: P("Card heading"), level: "3" } }, { id: newId(used, "tx"), type: "text", props: { ...elementDefaults("text"), text: P("A short description"), role: "body" } });
  }
  return node;
}

// ---------------------------------------------------------------------------
// New pages
// ---------------------------------------------------------------------------

export type PageStarterKind = "blank" | "landing" | "about" | "services" | "faq" | "contact" | "thanks";
export const PAGE_STARTERS: Array<{ id: PageStarterKind; label: string; description: string; kind: "page" | "landing" | "thanks" }> = [
  { id: "blank", label: "Blank page", description: "A title and a block of text to start from.", kind: "page" },
  { id: "landing", label: "Landing page", description: "A focused page: headline, benefits, a form and one clear action.", kind: "landing" },
  { id: "about", label: "About", description: "Your story, with a call to action.", kind: "page" },
  { id: "services", label: "Services", description: "Your services in full, then a way to get in touch.", kind: "page" },
  { id: "faq", label: "FAQ", description: "Questions and answers.", kind: "page" },
  { id: "contact", label: "Contact", description: "Your details and an enquiry form.", kind: "page" },
  { id: "thanks", label: "Thank-you page", description: "Shown after someone sends an enquiry.", kind: "thanks" },
];

/** The sections a new page starts with, with ids that cannot collide with anything already in the site. */
export function pageStarter(doc: SiteContent, kind: PageStarterKind, title: string): Section[] {
  const ctx = libraryContext(doc, "z");
  const preset = (id: string) => SECTION_PRESETS.find((p) => p.id === id)!.build(ctx);
  const head = (t: string, lede?: string) => B.pageTitle(ctx, { title: t, lede, tone: undefined, eyebrow: undefined });
  const raw: Array<Section | null> = (() => {
    switch (kind) {
      case "landing": return [preset("hero-split"), preset("benefits-cards"), preset("lead-side"), preset("cta-band")];
      case "about": return [head(title, P("A line about your story")), preset("about-split"), preset("cta-card")];
      case "services": return [head(title, P("What you offer, in a sentence")), preset("svc-icons"), preset("process-timeline"), preset("cta-band")];
      case "faq": return [head(title, P("Answers to the questions we hear most")), preset("faq-accordion")];
      case "contact": return [head(title, P("How to reach you")), preset("contact-split")];
      case "thanks": return [B.pageTitle(ctx, { title: "Thank you", lede: P("Say what happens next"), align: "center" })];
      default: return [head(title), textBlock(ctx, "single")];
    }
  })();
  const used = new Set(collectIds(doc));
  return raw.filter((s): s is Section => Boolean(s)).map((s) => cloneWithNewIds(s, used));
}
