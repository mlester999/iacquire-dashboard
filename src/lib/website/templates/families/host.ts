// Modern hospitality and lifestyle: immersive photography, refined navigation and a sense of occasion.
import { art } from "../../build";
import type { Design } from "../../doc";
import {
  aboutSection, contactSection, ctaSection, faqSection, gallerySection, heroCentered, heroFull, heroSplit, introSection, pageTitle, processSection, servicesSection, statsSection, testimonialsSection, wordBand,
} from "../blocks";
import { footerCentered, footerColumns, footerMinimal, headerBar, headerCentered, headerFloating, headerMinimal, headerSplit } from "../chrome";
import { compact, innerPages } from "../pages";
import { SAMPLES } from "../samples";
import type { FamilyDef, Recipe, TemplateCtx, VariationDef } from "../types";

const ICONS = ["utensils", "wine", "coffee", "sun", "gem", "flame"];
const base: Partial<Design> = { scale: "grand", spacing: "airy", motion: "smooth" };

// 1. Terrace: an evening scene filling the screen, the logo centred above it.
const terrace = (ctx: TemplateCtx): Recipe => {
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, align: "center", size: "7xl", pt: "3xl", tone: "dark", image: art("terrace", "warm", 4) });
  const services = servicesSection(ctx, { icons: ICONS, style: ctx.sample ? "imageCards" : "iconCards", images: [art("table", "dark", 2), art("terrace", "warm", 3), art("interior", "warm", 4), art("garden", "warm", 5)], cols: "2", title: "Ways to spend an evening", eyebrow: "Dining" });
  const about = aboutSection(ctx, { title: "A table by the water", image: art("terrace", "warm", 6), frame: "none", aspect: "4/3", reverse: true });
  const process = processSection(ctx, { style: "line", title: "Your evening", align: "center" });
  const cta = ctaSection(ctx, { style: "image", title: "Reserve your table.", body: null, image: art("terrace", "warm", 7), buttonVariant: "light" });
  return {
    design: { ...base, colors: { primary: "#c8704a", accent: "#e8c48a", bg: "#17110d", surface: "#211812", surface2: "#2b2018", ink: "#f4eadb", muted: "#b4a58f", line: "#3a2d22", dark: "#0f0a07" }, mode: "dark", fonts: { heading: "playfair", body: "jost", accent: "jost", mono: "jetbrains" }, heading: { weight: 500, ls: "tight", lh: "tight", transform: "none", emphasis: "italic" }, radius: "square", buttons: { style: "outline", caps: true, hover: "invert", weight: 500 } },
    header: headerCentered(ctx, { tone: "dark", float: true, navStyle: "minimal", bg: { kind: "none" } }),
    footer: footerCentered(ctx, { tone: "dark" }),
    home: compact([
      heroFull(ctx, { image: art("terrace", "warm", 1), align: "center", valign: "center", size: "8xl", eyebrow: ctx.has.areas ? ctx.d.areas![0] : "Restaurant & bar", overlay: { opacity: 45, dir: "flat" }, ctaVariant: ["light", "outline"], minH: "100", pt: "3xl", headingStyle: { w: "l" } }),
      introSection(ctx, { layout: "statement", title: "Dinner as the light goes.", body: ctx.lede, eyebrow: "Welcome", size: "5xl" }),
      services,
      gallerySection(ctx, { images: [art("table", "dark", 3), art("terrace", "warm", 4), art("interior", "warm", 5), art("garden", "warm", 6)], layout: "strip", aspect: "4/5", title: "At the table", eyebrow: "Gallery", width: "full" }),
      statsSection(ctx, { style: "row", tone: "dark" }),
      testimonialsSection(ctx, { style: "quote" }),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "lines", align: "center" }), gallery: gallerySection(ctx, { images: [art("table", "dark", 3), art("terrace", "warm", 4), art("interior", "warm", 5), art("garden", "warm", 6)], layout: "mosaic" }), cta, contact: contactSection(ctx, { style: "split", title: "Reserve a table", purpose: "appointment" }) }),
  };
};

// 2. Cellar: deep wine and gold, a menu-like list, candlelight.
const cellar = (ctx: TemplateCtx): Recipe => {
  const { b } = ctx;
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, size: "7xl", pt: "2xl", tone: "dark", bg: { kind: "color", color: "dark" } });
  const services = servicesSection(ctx, { icons: ICONS, style: "list", title: "From the kitchen", eyebrow: "The menu", layout: "side" });
  const about = aboutSection(ctx, { title: "Cooked slowly, served simply", image: art("table", "dark", 3), frame: "none", aspect: "4/3" });
  const process = processSection(ctx, { style: "vertical", title: "The evening", side: true });
  const cta = ctaSection(ctx, { style: "split", tone: "dark", title: "Join us for dinner.", body: null, buttonVariant: "primary" });
  return {
    design: { ...base, mode: "dark", colors: { primary: "#c9a45c", accent: "#9b2d3f", bg: "#170b0e", surface: "#211015", surface2: "#2b161b", ink: "#f3e8dc", muted: "#b49b8c", line: "#3b2229", dark: "#0e0507" }, fonts: { heading: "cormorant", body: "jost", accent: "jost", mono: "jetbrains" }, heading: { weight: 500, ls: "tight", lh: "tight", transform: "none", emphasis: "italic" }, radius: "square", buttons: { style: "outline", caps: true, hover: "invert", weight: 500 } },
    header: headerBar(ctx, { tone: "dark", navStyle: "minimal", pad: "m" }),
    footer: footerColumns(ctx, { tone: "dark" }),
    home: compact([
      heroSplit(ctx, {
        tone: "dark", eyebrow: ctx.has.areas ? ctx.d.areas![0] : "Wine room & kitchen", size: "8xl", textSpan: 6, image: art("table", "dark", 1), aspect: "4/5", frame: "none", pt: "2xl", pb: "xl", minH: "90", ctaVariant: ["primary", "outline"],
        decor: [{ kind: "orb", at: "tr", size: "l", color: "primary", opacity: 16 }],
      }),
      introSection(ctx, { layout: "statement", title: "Candlelight, good bread and a long list of wines.", size: "5xl", body: ctx.lede }),
      services,
      gallerySection(ctx, { images: [art("table", "dark", 4), art("terrace", "dark", 5), art("interior", "dark", 6), art("clinic", "dark", 7), art("garden", "dark", 8)], layout: "mosaic", title: "The room", eyebrow: "Gallery", width: "wide" }),
      testimonialsSection(ctx, { style: "quote" }),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "lines", side: true }), gallery: gallerySection(ctx, { images: [art("table", "dark", 4), art("terrace", "dark", 5), art("interior", "dark", 6), art("garden", "dark", 8)], layout: "grid", cols: "2" }), cta, contact: contactSection(ctx, { style: "split", title: "Reserve a table", purpose: "appointment" }) }),
  };
};

// 3. Bistro: cream and terracotta, a friendly centred hero with overlapping images.
const bistro = (ctx: TemplateCtx): Recipe => {
  const { b } = ctx;
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, align: "center", size: "6xl", pt: "2xl", bg: { kind: "color", color: "surface2" } });
  const services = servicesSection(ctx, { icons: ICONS, style: "rows", layout: "side", title: "Throughout the day", eyebrow: "Menus" });
  const about = aboutSection(ctx, { title: "A neighbourhood table", collage: { layout: "duo", images: [art("table", "warm", 5), art("terrace", "warm", 6)] } });
  const process = processSection(ctx, { style: "cards", title: "How it works", align: "center" });
  const cta = ctaSection(ctx, { style: "card", title: "Come hungry.", body: ctx.d.hours ? ctx.d.hours.replace(/\n/g, " · ") : null });
  return {
    design: { ...base, spacing: "regular", scale: "regular", colors: { primary: "#c0562f", accent: "#7b8a4a", bg: "#faf3e6", surface: "#fffaf0", surface2: "#f0e3cc", ink: "#2f1f14", muted: "#6e5a46", line: "#e3d3b8", dark: "#2f1f14" }, fonts: { heading: "fraunces", body: "figtree", accent: "figtree", mono: "jetbrains" }, heading: { weight: 500, ls: "tight", lh: "tight", transform: "none", emphasis: "italic" }, radius: "round", buttons: { style: "solid", caps: false, hover: "lift", weight: 600 } },
    header: headerFloating(ctx, { navStyle: "pills" }),
    footer: footerColumns(ctx, { tone: "dark" }),
    home: compact([
      heroCentered(ctx, {
        eyebrow: ctx.has.areas ? ctx.d.areas![0] : "Café & kitchen", size: "7xl", pt: "3xl", pb: "l", bg: { kind: "color", color: "surface2" }, ctaVariant: ["primary", "outline"],
        below: [b.el("collage", { layout: "duo", items: [{ src: art("table", "warm", 2), alt: "" }, { src: art("terrace", "warm", 3), alt: "" }] }, { anim: "scale", style: { mt: "m" } })],
        decor: [{ kind: "blob", at: "tl", size: "l", color: "accent", opacity: 22 }],
      }),
      services,
      aboutSection(ctx, { title: "A neighbourhood table", image: art("interior", "warm", 7), frame: "arch", aspect: "4/5", reverse: true }),
      wordBand(ctx, { style: "text", tone: "dark", size: "3xl" }),
      testimonialsSection(ctx, { style: "cards" }),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "cards", align: "center" }), gallery: gallerySection(ctx, { images: [art("table", "warm", 2), art("terrace", "warm", 3), art("interior", "warm", 4), art("garden", "warm", 5)], layout: "grid", cols: "2" }), cta, contact: contactSection(ctx, { style: "stacked", title: "Book a table", purpose: "appointment" }) }),
  };
};

// 4. Resort: airy and bright, a wide seascape, bento experiences.
const resort = (ctx: TemplateCtx): Recipe => {
  const { b } = ctx;
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, align: "center", size: "7xl", pt: "3xl", tone: "dark", image: art("terrace", "cool", 3) });
  const services = servicesSection(ctx, { icons: ICONS, style: "bento", title: "Experiences", eyebrow: "Stay & dine", align: "center" });
  const about = aboutSection(ctx, { title: "Slow days by the sea", image: art("terrace", "light", 4), frame: "soft", aspect: "4/3" });
  const process = processSection(ctx, { style: "numbered", title: "Your stay", align: "center" });
  const cta = ctaSection(ctx, { style: "card", title: "Plan your visit.", body: "Reserve online or call us." });
  return {
    design: { ...base, colors: { primary: "#1f6f8b", accent: "#e9b872", bg: "#f6fafb", surface: "#ffffff", surface2: "#e5f0f3", ink: "#10303c", muted: "#4d6b76", line: "#d3e4ea", dark: "#0b3445" }, fonts: { heading: "newsreader", body: "figtree", accent: "figtree", mono: "jetbrains" }, heading: { weight: 400, ls: "tight", lh: "tight", transform: "none", emphasis: "italic" }, radius: "soft", buttons: { style: "solid", caps: false, hover: "lift", weight: 600 } },
    header: headerBar(ctx, { tone: "dark", float: true, navStyle: "underline", pad: "m" }),
    footer: footerColumns(ctx, { tone: "dark" }),
    home: compact([
      heroFull(ctx, { image: art("terrace", "cool", 1), align: "center", valign: "center", size: "7xl", eyebrow: ctx.has.areas ? ctx.d.areas![0] : "Seafront dining", overlay: { opacity: 28, dir: "bottom" }, ctaVariant: ["light", "outline"], minH: "100", pt: "3xl", headingStyle: { w: "l" } }),
      introSection(ctx, { layout: "statement", title: "Salt air, long lunches and the best seat on the harbour.", size: "5xl", body: ctx.lede }),
      services,
      aboutSection(ctx, { title: "Slow days by the sea", image: art("terrace", "light", 5), frame: "soft", aspect: "4/3", reverse: true }),
      gallerySection(ctx, { images: [art("terrace", "light", 6), art("table", "warm", 7), art("garden", "light", 8), art("interior", "light", 9)], layout: "masonry", cols: "3", title: "Around the house", eyebrow: "Gallery" }),
      testimonialsSection(ctx, { style: "cards" }),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "accordion", side: true }), gallery: gallerySection(ctx, { images: [art("terrace", "light", 6), art("table", "warm", 7), art("garden", "light", 8), art("interior", "light", 9)], layout: "grid", cols: "2" }), cta, contact: contactSection(ctx, { style: "split", title: "Plan your visit", purpose: "appointment" }) }),
  };
};

// 5. Studio: boutique lifestyle in monochrome with one olive accent.
const studio = (ctx: TemplateCtx): Recipe => {
  const { b } = ctx;
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, size: "8xl", pt: "2xl" });
  const services = servicesSection(ctx, { icons: ICONS, style: "numbered", cols: "2", title: "Offerings", eyebrow: "01" });
  const about = aboutSection(ctx, { title: "Slow food, honest drinks", image: art("table", "light", 8), frame: "none", aspect: "4/5", eyebrow: "02" });
  const process = processSection(ctx, { style: "numbered", title: "Visit", eyebrow: "03" });
  const cta = ctaSection(ctx, { style: "split", tone: "dark", title: "See you soon.", body: null, buttonVariant: "light" });
  return {
    design: { ...base, spacing: "regular", colors: { primary: "#171717", accent: "#6b7a3d", bg: "#f7f7f4", surface: "#ffffff", surface2: "#ecece6", ink: "#161616", muted: "#5f5f5a", line: "#dcdcd4", dark: "#161616" }, fonts: { heading: "instrument", body: "hanken", accent: "dmmono", mono: "dmmono" }, heading: { weight: 400, ls: "tight", lh: "none", transform: "none", emphasis: "italic" }, radius: "square", buttons: { style: "solid", caps: true, hover: "invert", weight: 500 } },
    header: headerSplit(ctx, { navStyle: "minimal", pad: "m" }),
    footer: footerMinimal(ctx, { tone: "dark" }),
    home: compact([
      b.section({ id: "hero", name: "Hero", layout: { pt: "xl", pb: "xl", width: "wide", gap: "l", valign: "end", minH: "90" } }, [
        b.col(7, [
          b.eyebrow(ctx.has.areas ? ctx.d.areas![0] : "Café · Bar · Shop", { anim: "fade" }),
          b.h1(ctx.headline, { style: { size: "8xl", lh: "none" }, anim: { preset: "up", delay: 80 } }),
          b.group([b.btn(ctx.primaryLabel, ctx.primaryHref, { size: "l", icon: "arrow-right" })], { gap: "s" }),
        ], { gap: "m", valign: "end", r: { t: { span: 12 } } }),
        b.col(5, [b.img(art("table", "light", 5), { aspect: "4/5", frame: "none", priority: true, anim: { preset: "reveal", delay: 140 } })], { valign: "end", r: { t: { span: 12 } } }),
      ]),
      services,
      about,
      gallerySection(ctx, { images: [art("table", "light", 6), art("terrace", "light", 7), art("garden", "light", 8)], layout: "grid", cols: "3", aspect: "4/5", title: "Inside", eyebrow: "04" }),
      testimonialsSection(ctx, { style: "quote" }),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "lines", side: true }), gallery: gallerySection(ctx, { images: [art("table", "light", 6), art("terrace", "light", 7), art("garden", "light", 8), art("interior", "light", 9)], layout: "mosaic" }), cta, contact: contactSection(ctx, { style: "split", title: "Visit", purpose: "appointment" }) }),
  };
};

const v = (id: string, name: string, description: string, tags: string[], build: (ctx: TemplateCtx) => Recipe): VariationDef => ({ id, name, description, tags, build });

export const host: FamilyDef = {
  id: "host",
  name: "Hospitality & Lifestyle",
  tagline: "Immersive photography and a sense of occasion.",
  description: "For restaurants, bars, cafés and boutique stays: full-screen scenes, refined navigation and layouts built around the experience.",
  industries: ["local_services"],
  tags: ["hospitality", "restaurant", "immersive"],
  sample: SAMPLES.host,
  variations: [
    v("terrace", "Terrace", "An evening scene filling the screen, the logo centred above it.", ["dark", "immersive", "centred"], terrace),
    v("cellar", "Cellar", "Deep wine and gold, a menu-like list and candlelight.", ["dark", "wine", "gold"], cellar),
    v("bistro", "Bistro", "Cream and terracotta, with a friendly hero and overlapping photographs.", ["light", "warm", "friendly"], bistro),
    v("resort", "Resort", "Airy and bright, with a wide seascape and bento experiences.", ["light", "blue", "airy"], resort),
    v("studio", "Studio", "Boutique lifestyle in monochrome with a single olive accent.", ["light", "monochrome", "editorial"], studio),
  ],
};
