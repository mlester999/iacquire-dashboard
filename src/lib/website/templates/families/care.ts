// Wellness and healthcare: calm palettes, soft arches, generous type and an appointment always close at hand.
import { art } from "../../build";
import type { Design, ElementNode } from "../../doc";
import {
  aboutSection, areasSection, contactSection, ctaSection, faqSection, gallerySection, heroCentered, heroSplit, introSection, pageTitle, processSection, servicesSection, statsSection, teamSection, testimonialsSection,
} from "../blocks";
import { footerCentered, footerColumns, headerBar, headerFloating, headerMinimal } from "../chrome";
import { compact, innerPages } from "../pages";
import { SAMPLES } from "../samples";
import type { FamilyDef, Recipe, TemplateCtx, VariationDef } from "../types";

const ICONS = ["heart", "leaf", "smile", "sprout", "stethoscope", "sun"];
const base: Partial<Design> = { scale: "regular", spacing: "airy", motion: "smooth" };

/** A small booking card for a hero: when the clinic is open and how to reach it. */
function bookingCard(ctx: TemplateCtx): ElementNode[] {
  const { b } = ctx;
  return [b.card([
    b.eyebrow(ctx.action === "book" ? "Book an appointment" : "Get in touch"),
    b.el("contactInfo", { phone: true, email: false, address: false, hours: true, layout: "stack" }),
    b.btn(ctx.primaryLabel, ctx.primaryHref, { variant: "primary", size: "l", full: true, icon: "calendar" }),
  ], { surface: "elevated", pad: "m", gap: "m" })];
}

// 1. Haven: sage and cream, an arch-shaped room, soft shapes.
const haven = (ctx: TemplateCtx): Recipe => {
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, align: "center", size: "6xl", pt: "2xl", bg: { kind: "color", color: "primarySoft" } });
  const services = servicesSection(ctx, { icons: ICONS, style: "iconCards", cols: "3", title: "Care for the whole of you", eyebrow: "Treatments", align: "center" });
  const about = aboutSection(ctx, { title: "Time to listen, and a plan that makes sense", image: art("clinic", "light", 3), frame: "arch", aspect: "4/5", reverse: true });
  const process = processSection(ctx, { style: "line", title: "What to expect", align: "center" });
  const cta = ctaSection(ctx, { style: "card", title: "Take the first step towards feeling better.", body: "Book a first appointment. There's no pressure, and we'll go at your pace." });
  return {
    design: { ...base, colors: { primary: "#4a7a64", accent: "#e3b87a", bg: "#f6f4ec", surface: "#fdfcf7", surface2: "#e9eee3", ink: "#1d2a24", muted: "#55655c", line: "#d6dfd0", dark: "#1b2e25" }, fonts: { heading: "fraunces", body: "figtree", accent: "figtree", mono: "jetbrains" }, heading: { weight: 400, ls: "tight", lh: "tight", transform: "none", emphasis: "italic" }, radius: "round", buttons: { style: "solid", caps: false, hover: "lift", weight: 600 } },
    header: headerBar(ctx, { navStyle: "underline", pad: "m" }),
    footer: footerColumns(ctx, { tone: "dark" }),
    home: compact([
      heroSplit(ctx, {
        eyebrow: ctx.has.areas ? `Welcome to ${ctx.d.areas![0]}` : "Welcome", size: "6xl", textSpan: 6, image: art("clinic", "light", 2), aspect: "4/5", frame: "arch", pt: "2xl", pb: "xl", bg: { kind: "gradient", from: "primarySoft", to: "bg", angle: 180 }, ctaVariant: ["primary", "outline"],
        decor: [{ kind: "blob", at: "tr", size: "l", color: "accent", opacity: 28 }],
      }),
      services,
      aboutSection(ctx, { title: "Time to listen, and a plan that makes sense", image: art("calm", "light", 3), frame: "arch", aspect: "4/5", reverse: true }),
      statsSection(ctx, { style: "row" }),
      processSection(ctx, { style: "line", title: "What to expect", align: "center" }),
      teamSection(ctx, { style: "circles", cols: "3", align: "center" }),
      testimonialsSection(ctx, { style: "cards" }),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "cards", align: "center" }), gallery: gallerySection(ctx, { images: [art("clinic", "light", 2), art("calm", "light", 3), art("botanical", "light", 4), art("garden", "light", 5)], layout: "grid", cols: "2", aspect: "4/3" }), cta, contact: contactSection(ctx, { style: "split", title: "Book an appointment", purpose: "appointment" }) }),
  };
};

// 2. Clinic: clean white and teal, the booking details up front.
const clinic = (ctx: TemplateCtx): Recipe => {
  const { b } = ctx;
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, size: "6xl", pt: "2xl", bg: { kind: "color", color: "surface2" } });
  const services = servicesSection(ctx, { icons: ICONS, style: "grid", cols: "3", title: "Our treatments", eyebrow: "Services" });
  const about = aboutSection(ctx, { title: "A clinic built around you", image: art("clinic", "light", 4), frame: "soft", aspect: "4/3" });
  const process = processSection(ctx, { style: "timeline", title: "Your first visit" });
  const cta = ctaSection(ctx, { style: "band", tone: "brand", title: "Book your first appointment.", body: "Online or by phone." });
  return {
    design: { ...base, spacing: "regular", colors: { primary: "#0e8c8a", accent: "#f2a65a", bg: "#ffffff", surface: "#ffffff", surface2: "#eef7f7", ink: "#0d2a2c", muted: "#4a6a6c", line: "#d4e8e8", dark: "#0a3a3b" }, fonts: { heading: "hanken", body: "hanken", accent: "hanken", mono: "jetbrains" }, heading: { weight: 700, ls: "tight", lh: "tight", transform: "none", emphasis: "accent" }, radius: "soft", buttons: { style: "solid", caps: false, hover: "lift", weight: 600 } },
    header: headerBar(ctx, { navStyle: "links", sticky: true, bg: { kind: "color", color: "surface" } }),
    footer: footerColumns(ctx, { tone: "dark" }),
    home: compact([
      heroSplit(ctx, {
        eyebrow: ctx.has.areas ? ctx.d.areas!.slice(0, 2).join(" & ") : "Health & wellbeing", size: "6xl", textSpan: 7, pt: "xl", pb: "xl", bg: { kind: "color", color: "surface2" }, ctaVariant: ["primary", "outline"], ctas: "primary",
        rightElements: bookingCard(ctx), after: [...(ctx.has.highlights ? [b.list(ctx.d.highlights!.slice(0, 3), { style: { mt: "s" } })] : [])],
      }),
      statsSection(ctx, { style: "cards" }),
      services,
      aboutSection(ctx, { title: "A clinic built around you", image: art("clinic", "light", 5), frame: "soft", aspect: "4/3", reverse: true }),
      teamSection(ctx, { style: "cards", cols: "3" }),
      processSection(ctx, { style: "timeline", title: "Your first visit" }),
      testimonialsSection(ctx, { style: "cards" }),
      areasSection(ctx, {}),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "accordion", side: true }), gallery: gallerySection(ctx, { images: [art("clinic", "light", 2), art("calm", "light", 3), art("botanical", "light", 4), art("garden", "light", 5)], layout: "grid", cols: "2", aspect: "16/10" }), cta, contact: contactSection(ctx, { style: "split", title: "Book an appointment", purpose: "appointment" }) }),
  };
};

// 3. Bloom: blush and botanicals, soft cards.
const bloom = (ctx: TemplateCtx): Recipe => {
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, align: "center", size: "6xl", pt: "2xl", bg: { kind: "image", src: art("botanical", "light", 6), overlay: { color: "bg", opacity: 25, dir: "flat" }, pos: { x: 50, y: 50 }, parallax: false } });
  const services = servicesSection(ctx, { icons: ICONS, style: "bento", title: "Gentle, effective care", eyebrow: "Services", align: "center" });
  const about = aboutSection(ctx, { title: "Care that begins with a conversation", image: art("botanical", "light", 3), frame: "soft", aspect: "4/5" });
  const process = processSection(ctx, { style: "cards", title: "How we help", align: "center" });
  const cta = ctaSection(ctx, { style: "image", title: "Come and feel the difference.", body: null, image: art("botanical", "light", 8), buttonVariant: "primary", tone: "light" });
  return {
    design: { ...base, colors: { primary: "#b5546e", accent: "#8aa68b", bg: "#fdf4f1", surface: "#fffaf8", surface2: "#f7e3de", ink: "#35202a", muted: "#6f5560", line: "#efd6d0", dark: "#35202a" }, fonts: { heading: "playfair", body: "hanken", accent: "hanken", mono: "jetbrains" }, heading: { weight: 500, ls: "tight", lh: "tight", transform: "none", emphasis: "italic" }, radius: "round", buttons: { style: "solid", caps: false, hover: "lift", weight: 600 } },
    header: headerFloating(ctx, { navStyle: "pills" }),
    footer: footerCentered(ctx, { tone: "dark" }),
    home: compact([
      heroCentered(ctx, {
        eyebrow: ctx.has.areas ? ctx.d.areas![0] : "Wellbeing studio", size: "7xl", pt: "3xl", pb: "l", bg: { kind: "image", src: art("botanical", "light", 1), overlay: { color: "bg", opacity: 30, dir: "flat" }, pos: { x: 50, y: 50 }, parallax: true }, ctaVariant: ["primary", "outline"],
        minH: "90", valign: "center",
      }),
      services,
      aboutSection(ctx, { title: "Care that begins with a conversation", image: art("calm", "light", 3), frame: "soft", aspect: "4/5" }),
      testimonialsSection(ctx, { style: "quote" }),
      gallerySection(ctx, { images: [art("botanical", "light", 2), art("calm", "light", 3), art("clinic", "light", 4)], layout: "grid", cols: "3", aspect: "4/5", title: "Inside the studio", eyebrow: "Gallery" }),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "cards", align: "center" }), gallery: gallerySection(ctx, { images: [art("botanical", "light", 2), art("calm", "light", 3), art("clinic", "light", 4), art("garden", "light", 5)], layout: "grid", cols: "2", aspect: "4/5" }), cta, contact: contactSection(ctx, { style: "stacked", title: "Book a visit", purpose: "appointment" }) }),
  };
};

// 4. Serene: centred, silent, with arches in the background and very large type.
const serene = (ctx: TemplateCtx): Recipe => {
  const { b } = ctx;
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, align: "center", size: "7xl", pt: "3xl" });
  const services = servicesSection(ctx, { icons: ICONS, style: "numbered", cols: "2", title: "What we offer", eyebrow: "Practice" });
  const about = aboutSection(ctx, { title: "A calm place to begin", image: art("calm", "light", 4), frame: "arch", aspect: "4/5", eyebrow: "About" });
  const process = processSection(ctx, { style: "timeline", title: "Your journey" });
  const cta = ctaSection(ctx, { style: "minimal", title: "Begin when you're ready.", buttonVariant: "ghost" });
  return {
    design: { ...base, spacing: "luxe", scale: "grand", colors: { primary: "#51606a", accent: "#c9a982", bg: "#f7f6f2", surface: "#ffffff", surface2: "#ecebe5", ink: "#222a2e", muted: "#5f6a70", line: "#dcdcd3", dark: "#222a2e" }, fonts: { heading: "cormorant", body: "figtree", accent: "figtree", mono: "jetbrains" }, heading: { weight: 400, ls: "tight", lh: "tight", transform: "none", emphasis: "italic" }, radius: "square", buttons: { style: "outline", caps: true, hover: "invert", weight: 500 } },
    header: headerMinimal(ctx, { navStyle: "minimal", pad: "m" }),
    footer: footerCentered(ctx),
    home: compact([
      heroCentered(ctx, {
        eyebrow: ctx.has.areas ? ctx.d.areas![0] : "Wellness", size: "8xl", pt: "3xl", pb: "2xl", minH: "90", valign: "center", ctaVariant: ["primary", "ghost"],
        below: [b.img(art("calm", "light", 2), { aspect: "21/9", frame: "none", style: { mt: "l" }, anim: "reveal" })],
      }),
      introSection(ctx, { layout: "statement", title: "Rest, movement and unhurried attention.", size: "5xl", body: ctx.lede }),
      services,
      aboutSection(ctx, { title: "A calm place to begin", image: art("calm", "light", 4), frame: "arch", aspect: "4/5", reverse: true, eyebrow: "About" }),
      processSection(ctx, { style: "timeline", title: "Your journey" }),
      testimonialsSection(ctx, { style: "quote", width: "narrow" }),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "lines", align: "center" }), gallery: gallerySection(ctx, { images: [art("calm", "light", 2), art("botanical", "light", 3), art("clinic", "light", 4), art("mountains", "light", 5)], layout: "grid", cols: "2" }), cta, contact: contactSection(ctx, { style: "stacked", title: "Book a session", purpose: "appointment" }) }),
  };
};

// 5. Family: warm yellow and cream, rounded, welcoming, with a photo collage.
const family = (ctx: TemplateCtx): Recipe => {
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, size: "6xl", pt: "2xl", bg: { kind: "color", color: "accentSoft" } });
  const services = servicesSection(ctx, { icons: ICONS, style: ctx.sample ? "imageCards" : "iconCards", images: [art("clinic", "light", 2), art("calm", "light", 3), art("garden", "light", 4), art("botanical", "light", 5), art("neighborhood", "light", 6)], cols: "3", title: "Care for every age", eyebrow: "Services" });
  const about = aboutSection(ctx, { title: "A friendly clinic for the whole family", collage: { layout: "trio", images: [art("clinic", "light", 7), art("garden", "light", 8), art("calm", "light", 9)] } });
  const process = processSection(ctx, { style: "cards", title: "Your first visit" });
  const cta = ctaSection(ctx, { style: "card", title: "New patients welcome.", body: "We'd love to meet you." });
  return {
    design: { ...base, spacing: "regular", colors: { primary: "#e08a1e", accent: "#4a9d8f", bg: "#fffaf0", surface: "#ffffff", surface2: "#fdeccc", ink: "#33260f", muted: "#6c5a37", line: "#f0dfb8", dark: "#33260f" }, fonts: { heading: "bricolage", body: "figtree", accent: "figtree", mono: "jetbrains" }, heading: { weight: 700, ls: "tight", lh: "tight", transform: "none", emphasis: "both" }, radius: "pill", buttons: { style: "solid", caps: false, hover: "lift", weight: 700 } },
    header: headerBar(ctx, { navStyle: "pills", pad: "s" }),
    footer: footerColumns(ctx, { tone: "dark" }),
    home: compact([
      heroSplit(ctx, {
        eyebrow: ctx.has.areas ? ctx.d.areas!.slice(0, 2).join(" · ") : "Family clinic", size: "7xl", textSpan: 6, pt: "xl", pb: "xl", bg: { kind: "color", color: "accentSoft" }, ctaVariant: ["primary", "outline"],
        collage: { layout: "trio", images: [art("clinic", "light", 11), art("garden", "light", 12), art("calm", "light", 13)] }, decor: [{ kind: "blob", at: "bl", size: "m", color: "accent", opacity: 28 }],
      }),
      services,
      aboutSection(ctx, { title: "A friendly clinic for the whole family", image: art("clinic", "light", 14), frame: "soft", aspect: "4/3", reverse: true }),
      teamSection(ctx, { style: "cards", cols: "3" }),
      testimonialsSection(ctx, { style: "cards" }),
      faqSection(ctx, { style: "cards", align: "center" }),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "cards", align: "center" }), gallery: gallerySection(ctx, { images: [art("clinic", "light", 2), art("garden", "light", 4), art("calm", "light", 3), art("neighborhood", "light", 6)], layout: "mosaic" }), cta, contact: contactSection(ctx, { style: "split", title: "Book an appointment", purpose: "appointment" }) }),
  };
};

const v = (id: string, name: string, description: string, tags: string[], build: (ctx: TemplateCtx) => Recipe): VariationDef => ({ id, name, description, tags, build });

export const care: FamilyDef = {
  id: "care",
  name: "Wellness & Healthcare",
  tagline: "Calming, accessible and clear about the next step.",
  description: "For clinics, therapists and wellbeing studios: soft palettes, readable type, arches and organic shapes, and an easy way to book.",
  industries: ["healthcare"],
  tags: ["wellness", "calm", "booking"],
  sample: SAMPLES.care,
  variations: [
    v("haven", "Haven", "Sage and cream, an arch-shaped room and soft shapes.", ["light", "sage", "arch"], haven),
    v("clinic", "Clinic", "Clean white and teal, with the booking details up front.", ["light", "teal", "booking"], clinic),
    v("bloom", "Bloom", "Blush and botanicals, with soft cards.", ["light", "blush", "botanical"], bloom),
    v("serene", "Serene", "Centred and silent, with very large type and a wide calm picture.", ["light", "minimal", "centred"], serene),
    v("family", "Family", "Warm yellow and cream, rounded and welcoming, with a photo collage.", ["light", "warm", "friendly"], family),
  ],
};
