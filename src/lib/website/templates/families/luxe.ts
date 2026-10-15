// Luxury editorial: elegant serif type, large photography, hairline rules and a great deal of room.
import { art } from "../../build";
import type { Design } from "../../doc";
import {
  aboutSection, contactSection, ctaSection, faqSection, gallerySection, heroCentered, heroFull, heroSplit, introSection, pageTitle, processSection, servicesSection, statsSection, testimonialsSection, pick,
} from "../blocks";
import { footerCentered, footerColumns, footerMinimal, headerBar, headerCentered, headerFloating, headerMinimal } from "../chrome";
import { compact, innerPages } from "../pages";
import { SAMPLES } from "../samples";
import type { FamilyDef, Recipe, TemplateCtx, VariationDef } from "../types";

const ICONS = ["sparkles", "gem", "palette", "compass", "home", "handshake"];
const base: Partial<Design> = { scale: "grand", spacing: "airy", motion: "smooth", radius: "square" };

const ivory = { primary: "#2e2a24", accent: "#b89458", bg: "#f6f1e8", surface: "#fbf8f1", surface2: "#ece4d5", ink: "#1b1713", muted: "#5e564a", line: "#ddd2bd", dark: "#14110e" };

// 1. Maison: the logo centred, a full-bleed room, a single italic sentence.
const maison = (ctx: TemplateCtx): Recipe => {
  // The header floats over the first section, in light text, so every page opens on a dark picture, not just the home page.
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, align: "center", size: "7xl", pt: "2xl", tone: "dark", image: art("interior", "warm", 9) });
  const services = servicesSection(ctx, { icons: ICONS, style: "numbered", cols: "2", title: "Our work", eyebrow: "Disciplines" });
  const about = aboutSection(ctx, { title: "A studio that works slowly, on purpose", image: art("interior", "warm", 3), frame: "arch", aspect: "4/5", reverse: true });
  const process = processSection(ctx, { style: "vertical", side: true, title: "How we work" });
  const cta = ctaSection(ctx, { style: "minimal", title: "Begin with a conversation.", buttonVariant: "ghost" });
  return {
    design: { ...base, colors: ivory, fonts: { heading: "cormorant", body: "jost", accent: "jost", mono: "jetbrains" }, heading: { weight: 400, ls: "tight", lh: "tight", transform: "none", emphasis: "italic" }, buttons: { style: "outline", caps: true, hover: "invert", weight: 500 } },
    header: headerCentered(ctx, { navStyle: "minimal", tone: "dark", float: true, bg: { kind: "none" } }),
    footer: footerCentered(ctx, { tone: "dark" }),
    home: compact([
      heroFull(ctx, { image: art("interior", "warm", 0), eyebrow: ctx.has.areas ? ctx.d.areas!.slice(0, 3).join("  ·  ") : "Interior architecture", size: "7xl", align: "center", valign: "center", ctaVariant: ["light", "outline"], overlay: { opacity: 52, dir: "flat" }, headingStyle: { w: "full", lh: "none" }, pt: "3xl" }),
      introSection(ctx, { layout: "statement", eyebrow: "The studio", title: "We make rooms that grow quieter and more beautiful with time.", body: ctx.lede, size: "5xl" }),
      services,
      gallerySection(ctx, { images: [art("interior", "warm", 2), art("calm", "warm"), art("terrace", "warm", 1), art("garden", "warm", 2)], layout: "strip", aspect: "4/5", title: "Recent commissions", eyebrow: "Selected work", width: "full" }),
      process,
      testimonialsSection(ctx, { style: "quote", width: "regular" }),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "lines", align: "center" }), gallery: gallerySection(ctx, { images: [art("interior", "warm", 2), art("calm", "warm"), art("terrace", "warm", 1), art("garden", "warm", 2)], layout: "grid", cols: "2", aspect: "4/5" }), cta, contact: contactSection(ctx, { style: "stacked", title: "Write to us" }) }),
  };
};

// 2. Atelier: type on the left, a tall arched photograph on the right, vertical rhythm.
const atelier = (ctx: TemplateCtx): Recipe => {
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, size: "7xl", pt: "2xl", tone: "light", bg: { kind: "color", color: "surface2" } });
  const services = servicesSection(ctx, { icons: ICONS, style: "rows", layout: "side", title: "What we make", eyebrow: "Services" });
  const about = aboutSection(ctx, { title: "Made by hand, slowly", collage: { layout: "tall", images: [art("calm", "light", 2), art("botanical", "light", 3), art("interior", "light", 4)] }, eyebrow: "The atelier" });
  const process = processSection(ctx, { style: "timeline", title: "From sketch to installation" });
  const cta = ctaSection(ctx, { style: "split", tone: "dark", title: "Let's talk about your space.", body: null, buttonVariant: "light" });
  return {
    design: { ...base, colors: { ...ivory, primary: "#3c3328", accent: "#a47c48" }, fonts: { heading: "instrument", body: "hanken", accent: "hanken", mono: "jetbrains" }, heading: { weight: 400, ls: "tight", lh: "none", transform: "none", emphasis: "italic" }, buttons: { style: "solid", caps: false, hover: "lift", weight: 500 }, radius: "soft" },
    header: headerBar(ctx, { navStyle: "underline", pad: "m" }),
    footer: footerColumns(ctx, { tone: "dark" }),
    home: compact([
      heroSplit(ctx, {
        eyebrow: ctx.has.areas ? ctx.d.areas!.slice(0, 2).join(" and ") : "Design atelier", size: "8xl", textSpan: 7, image: art("clinic", "warm", 2), aspect: "3/4", frame: "arch", pt: "2xl", pb: "2xl",
        headingStyle: { lh: "none", ls: "tighter" }, ctaVariant: ["primary", "ghost"], collage: pick({ layout: "arch", images: [art("interior", "warm", 5), art("calm", "warm", 1)] }, undefined, ctx),
      }),
      introSection(ctx, { layout: "two", eyebrow: "Philosophy", title: "Fewer things, better made.", size: "5xl" }),
      services,
      about,
      statsSection(ctx, { style: "lines", tone: "dark" }),
      testimonialsSection(ctx, { style: "quote", width: "regular" }),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "accordion", side: true }), gallery: gallerySection(ctx, { images: [art("interior", "light", 2), art("calm", "light"), art("botanical", "light", 1), art("clinic", "light", 3)], layout: "masonry", cols: "2" }), cta, contact: contactSection(ctx, { style: "split", title: "Visit the atelier" }) }),
  };
};

// 3. Noir: a dark room with gold, one monumental heading and a stack of photographs.
const noir = (ctx: TemplateCtx): Recipe => {
  const { b } = ctx;
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, align: "center", size: "7xl", pt: "2xl" });
  const services = servicesSection(ctx, { icons: ICONS, style: "list", title: "The work", eyebrow: "Services", layout: "side" });
  const about = aboutSection(ctx, { title: "Particular, by design", image: art("table", "dark", 2), frame: "none", aspect: "4/5", eyebrow: "About" });
  const process = processSection(ctx, { style: "line", title: "How we begin", align: "center" });
  const cta = ctaSection(ctx, { style: "card", title: "Commissions begin with a visit.", body: "We take on only a few projects at a time." });
  return {
    design: { ...base, mode: "dark", colors: { primary: "#c9a45c", accent: "#d9b97a", bg: "#0e0d0c", surface: "#161412", surface2: "#1d1a17", ink: "#f1ebe0", muted: "#a39a8a", line: "#2c2823", dark: "#080706" }, fonts: { heading: "bodoni", body: "jost", accent: "jost", mono: "jetbrains" }, heading: { weight: 400, ls: "tight", lh: "tight", transform: "none", emphasis: "italic" }, buttons: { style: "outline", caps: true, hover: "invert", weight: 500 } },
    header: headerMinimal(ctx, { navStyle: "minimal", pad: "m" }),
    footer: footerMinimal(ctx, { tone: "dark" }),
    home: compact([
      heroCentered(ctx, {
        eyebrow: "Private commissions", size: "8xl", pt: "2xl", pb: "xl", minH: "90", valign: "center", ctaVariant: ["primary", "outline"],
        bg: { kind: "gradient", from: "bg", via: "surface", to: "bg", angle: 180 },
        below: [b.el("collage", { layout: "stack", items: [{ src: art("table", "dark", 1), alt: "" }, { src: art("interior", "dark", 2), alt: "" }, { src: art("clinic", "dark", 3), alt: "" }] }, { anim: "scale", style: { mt: "m" } })],
        decor: [{ kind: "orb", at: "tr", size: "xl", color: "primary", opacity: 14 }],
      }),
      introSection(ctx, { layout: "statement", title: "Quiet, particular and made to last.", body: null, size: "6xl" }),
      about,
      services,
      statsSection(ctx, { style: "big", tone: "dark" }),
      gallerySection(ctx, { images: [art("table", "dark", 3), art("interior", "dark", 4), art("terrace", "dark", 2), art("clinic", "dark", 5)], layout: "mosaic", title: "From the studio", eyebrow: "Work", width: "wide" }),
      testimonialsSection(ctx, { style: "quote" }),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "lines", align: "center" }), gallery: gallerySection(ctx, { images: [art("table", "dark", 3), art("interior", "dark", 4), art("terrace", "dark", 2), art("clinic", "dark", 5)], layout: "grid", cols: "2" }), cta, contact: contactSection(ctx, { style: "stacked", title: "Request a visit" }) }),
  };
};

// 4. Gallery: asymmetry, an oversized headline that overlaps a tall photograph, a vertical label.
const gallery = (ctx: TemplateCtx): Recipe => {
  const { b } = ctx;
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, size: "8xl", pt: "2xl" });
  const services = servicesSection(ctx, { icons: ICONS, style: "alternating", images: [art("interior", "light", 1), art("calm", "light", 2), art("terrace", "light", 3), art("garden", "light", 4)], title: "Four ways we work", eyebrow: "Services" });
  const about = aboutSection(ctx, { title: "An independent practice", image: art("garden", "light", 5), frame: "offset", aspect: "4/5", reverse: true });
  const process = processSection(ctx, { style: "numbered", title: "Our method", eyebrow: "Process" });
  const cta = ctaSection(ctx, { style: "image", title: "Tell us about the room.", body: null, image: art("interior", "warm", 6), eyebrow: "Commission us" });
  return {
    design: { ...base, colors: { ...ivory, primary: "#2c3a2f", accent: "#b0894f" }, fonts: { heading: "fraunces", body: "dmsans", accent: "dmsans", mono: "dmmono" }, heading: { weight: 300, ls: "tighter", lh: "none", transform: "none", emphasis: "both" }, buttons: { style: "solid", caps: false, hover: "lift", weight: 500 } },
    header: headerMinimal(ctx, { navStyle: "underline", pad: "m", sticky: true }),
    footer: footerColumns(ctx, { tone: "dark" }),
    home: compact([
      b.section({ id: "hero", name: "Hero", layout: { pt: "xl", pb: "xl", width: "wide", gap: "m", valign: "center", minH: "90" } }, [
        b.col(8, [
          b.eyebrow(ctx.has.areas ? ctx.d.areas!.slice(0, 3).join(" / ") : "Interior design", { anim: "fade" }),
          b.h1(ctx.headline, { style: { size: "8xl", lh: "none", ls: "tighter", mb: "m" }, anim: { preset: "up", delay: 80 } }),
          b.group([b.btn(ctx.primaryLabel, ctx.primaryHref, { size: "l", icon: "arrow-right" }), ...(ctx.secondary ? [b.btn(ctx.secondary.label, ctx.secondary.href, { variant: "ghost" })] : [])], { gap: "m" }),
        ], { gap: "m", valign: "center", r: { m: { span: 12 } } }),
        b.col(4, [b.img(art("clinic", "warm", 4), { aspect: "3/4", frame: "arch", priority: true, anim: { preset: "reveal", delay: 140 }, style: { rotate: 2 } })], { valign: "center", r: { m: { span: 12 } } }),
        b.col(7, [b.lede(ctx.lede || "A small studio designing rooms to live in.", { style: { color: "ink" } })], { valign: "start", r: { m: { span: 12 } } }),
        b.col(5, [b.small(ctx.d.address?.replace(/\n/g, ", ") || "By appointment")], { valign: "start", r: { m: { span: 12 } } }),
      ]),
      gallerySection(ctx, { images: [art("interior", "light", 7), art("calm", "light", 3), art("botanical", "light", 4), art("terrace", "light", 5), art("garden", "light", 6)], layout: "masonry", cols: "3", title: "Selected rooms", eyebrow: "Gallery" }),
      services,
      about,
      testimonialsSection(ctx, { style: "slider" }),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "columns", align: "center" }), gallery: gallerySection(ctx, { images: [art("interior", "light", 7), art("calm", "light", 3), art("botanical", "light", 4), art("terrace", "light", 5)], layout: "mosaic" }), cta, contact: contactSection(ctx, { style: "split", title: "Come and see us" }) }),
  };
};

// 5. Salon: blush and rose, a floating pill header, overlapping photographs.
const salon = (ctx: TemplateCtx): Recipe => {
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, align: "center", size: "7xl", pt: "3xl", bg: { kind: "gradient", from: "primarySoft", to: "bg", angle: 180 } });
  const services = servicesSection(ctx, { icons: ICONS, style: "iconCards", cols: "3", title: "Everything for the home", eyebrow: "Services", align: "center" });
  const about = aboutSection(ctx, { title: "Soft materials, strong ideas", collage: { layout: "duo", images: [art("calm", "light", 4), art("interior", "light", 8)] }, eyebrow: "About" });
  const process = processSection(ctx, { style: "cards", title: "How a project unfolds", align: "center" });
  const cta = ctaSection(ctx, { style: "card", title: "Let's make something lovely.", body: "Book a first conversation. It's relaxed, and there's no obligation." });
  return {
    design: { ...base, spacing: "regular", colors: { primary: "#7a3b4a", accent: "#c79a6b", bg: "#faf1ee", surface: "#fffaf8", surface2: "#f3e2dc", ink: "#2a1a1d", muted: "#6c5559", line: "#e6cfc9", dark: "#2a1a1d" }, fonts: { heading: "playfair", body: "figtree", accent: "figtree", mono: "jetbrains" }, heading: { weight: 500, ls: "tight", lh: "tight", transform: "none", emphasis: "italic" }, radius: "round", buttons: { style: "solid", caps: false, hover: "lift", weight: 600 } },
    header: headerFloating(ctx, { navStyle: "pills" }),
    footer: footerColumns(ctx, { tone: "dark" }),
    home: compact([
      heroCentered(ctx, {
        eyebrow: "Interior design studio", size: "7xl", pt: "3xl", pb: "l", bg: { kind: "gradient", from: "primarySoft", to: "bg", angle: 180 },
        below: [ctx.b.el("collage", { layout: "duo", items: [{ src: art("calm", "light", 1), alt: "" }, { src: art("interior", "light", 9), alt: "" }] }, { anim: "scale", style: { mt: "m" } })], ctaVariant: ["primary", "outline"],
        decor: [{ kind: "blob", at: "tl", size: "l", color: "accent", opacity: 18 }],
      }),
      services,
      processSection(ctx, { style: "cards", title: "How a project unfolds", align: "center" }),
      about,
      testimonialsSection(ctx, { style: "cards" }),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "cards", align: "center" }), gallery: gallerySection(ctx, { images: [art("calm", "light", 1), art("interior", "light", 9), art("botanical", "light", 2), art("clinic", "light", 3)], layout: "grid", cols: "2", aspect: "4/3" }), cta, contact: contactSection(ctx, { style: "split", title: "Say hello" }) }),
  };
};

const v = (id: string, name: string, description: string, tags: string[], build: (ctx: TemplateCtx) => Recipe): VariationDef => ({ id, name, description, tags, build });

export const luxe: FamilyDef = {
  id: "luxe",
  name: "Luxury Editorial",
  tagline: "Elegant serif type, generous space, large photography.",
  description: "For studios, boutiques and private practices that sell taste: hairline rules, italic emphasis and unhurried, magazine-like layouts.",
  industries: ["other"],
  tags: ["luxury", "editorial", "serif"],
  sample: SAMPLES.luxe,
  variations: [
    v("maison", "Maison", "The logo centred above a full-bleed room, with one italic sentence.", ["light", "centred", "serif"], maison),
    v("atelier", "Atelier", "Type on the left, a tall arched photograph on the right.", ["light", "split", "arch"], atelier),
    v("noir", "Noir", "A dark room with gold, one monumental heading and stacked photographs.", ["dark", "gold", "dramatic"], noir),
    v("gallery", "Gallery", "Asymmetric: an oversized headline beside a tilted arch, with generous margins.", ["light", "asymmetric", "editorial"], gallery),
    v("salon", "Salon", "Blush and rose, a floating pill header and overlapping photographs.", ["light", "soft", "feminine"], salon),
  ],
};
