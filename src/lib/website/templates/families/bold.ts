// Bold creative: oversized type, hard colour, scrolling words, tilted images and stickers.
import { art } from "../../build";
import type { Design } from "../../doc";
import {
  aboutSection, contactSection, ctaSection, faqSection, gallerySection, heroCentered, heroSplit, introSection, pageTitle, processSection, servicesSection, statsSection, testimonialsSection, wordBand,
} from "../blocks";
import { footerBig, footerCentered, footerColumns, footerMinimal, headerBar, headerCentered, headerMinimal } from "../chrome";
import { compact, innerPages } from "../pages";
import { SAMPLES } from "../samples";
import type { FamilyDef, Recipe, TemplateCtx, VariationDef } from "../types";

const ICONS = ["paintbrush", "camera", "pen-tool", "rocket", "sparkles", "lightbulb"];
const base: Partial<Design> = { scale: "display", spacing: "regular", motion: "dramatic" };
const WORDS = ["Identity", "Campaigns", "Film", "Digital", "Packaging"];

const warm = { primary: "#ff4d2e", accent: "#ffd23f", bg: "#f4f0e6", surface: "#fffdf7", surface2: "#ebe5d5", ink: "#111111", muted: "#4f4c45", line: "#d9d2bf", dark: "#111111" };

// 1. Riot: huge capitals, a marquee, a tilted image and a sticker.
const riot = (ctx: TemplateCtx): Recipe => {
  const { b } = ctx;
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, size: "8xl", pt: "2xl" });
  const services = servicesSection(ctx, { icons: ICONS, style: "numbered", cols: "3", title: "What we make", eyebrow: "Services" });
  const about = aboutSection(ctx, { title: "Independent and proud of it", image: art("shapes", "light", 3), frame: "tilt", aspect: "1/1", reverse: true });
  const process = processSection(ctx, { style: "numbered", title: "How it goes", eyebrow: "Process" });
  const cta = ctaSection(ctx, { style: "band", tone: "brand", title: "Make some noise with us.", body: null, buttonVariant: "dark" });
  return {
    design: { ...base, colors: warm, fonts: { heading: "bricolage", body: "dmsans", accent: "jetbrains", mono: "jetbrains" }, heading: { weight: 800, ls: "tighter", lh: "none", transform: "uppercase", emphasis: "accent" }, radius: "soft", buttons: { style: "solid", caps: true, hover: "lift", weight: 800 } },
    header: headerBar(ctx, { navStyle: "minimal", pad: "m" }),
    footer: footerBig(ctx, { tone: "dark" }),
    home: compact([
      b.section({ id: "hero", name: "Hero", layout: { pt: "xl", pb: "m", width: "wide", gap: "m", valign: "start" }, decor: [{ kind: "plus", at: "tr", size: "m", color: "ink", opacity: 60 }] }, [
        b.col(12, [
          b.group([b.badge(ctx.has.areas ? ctx.d.areas!.slice(0, 2).join(" + ") : "Independent studio", { variant: "outline" }), b.badge("Open for projects", { variant: "dot" })], { gap: "xs" }),
          b.h1(ctx.headline, { style: { size: "8xl", lh: "none" }, anim: { preset: "up", delay: 60 } }),
        ], { gap: "m" }),
        b.col(5, [b.lede(ctx.lede || "We make brands people remember.", { style: { color: "ink" } }), b.group([b.btn(ctx.primaryLabel, ctx.primaryHref, { size: "l", icon: "arrow-right" }), ...(ctx.secondary ? [b.btn(ctx.secondary.label, ctx.secondary.href, { variant: "outline", size: "l" })] : [])], { gap: "s", style: { mt: "s" } })], { gap: "m", valign: "start" }),
        b.col(7, [b.img(art("shapes", "light", 2), { aspect: "16/10", frame: "tilt", priority: true, anim: { preset: "scale", delay: 120 } })], { valign: "start" }),
      ]),
      wordBand(ctx, { style: "outline", size: "7xl", words: ctx.sample ? WORDS : undefined, tone: "dark", speed: "fast", pt: "m", pb: "m" }),
      services,
      statsSection(ctx, { style: "big", tone: "brand" }),
      gallerySection(ctx, { images: [art("shapes", "light", 4), art("cityblocks", "light", 5), art("rings", "light", 6), art("mesh", "light", 7)], layout: "masonry", title: "Recent noise", eyebrow: "Work" }),
      testimonialsSection(ctx, { style: "wall" }),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "lines", side: true }), gallery: gallerySection(ctx, { images: [art("shapes", "light", 4), art("cityblocks", "light", 5), art("rings", "light", 6), art("mesh", "light", 7)], layout: "mosaic" }), cta, contact: contactSection(ctx, { style: "split", title: "Tell us everything" }) }),
  };
};

// 2. Pop: colour blocks in yellow and coral, rounded everything, pill buttons.
const pop = (ctx: TemplateCtx): Recipe => {
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, size: "8xl", pt: "2xl", tone: "accent", bg: { kind: "color", color: "accent" } });
  const services = servicesSection(ctx, { icons: ICONS, style: "bento", title: "Five ways to get noticed", eyebrow: "Services" });
  const about = aboutSection(ctx, { title: "A small studio with a big voice", image: art("shapes", "light", 8), frame: "soft", aspect: "4/3" });
  const process = processSection(ctx, { style: "cards", title: "How we work" });
  const cta = ctaSection(ctx, { style: "card", title: "Got a project? Let's play.", body: "Tell us what you're making." });
  return {
    design: { ...base, spacing: "regular", colors: { ...warm, primary: "#ff5d73", accent: "#ffd23f", bg: "#fff7e6", surface: "#ffffff", surface2: "#ffecc2" }, fonts: { heading: "syne", body: "dmsans", accent: "dmsans", mono: "jetbrains" }, heading: { weight: 800, ls: "tight", lh: "none", transform: "none", emphasis: "underline" }, radius: "pill", buttons: { style: "solid", caps: false, hover: "lift", weight: 700 } },
    header: headerBar(ctx, { navStyle: "pills", pad: "m" }),
    footer: footerColumns(ctx, { tone: "dark" }),
    home: compact([
      heroSplit(ctx, {
        tone: "accent", eyebrow: "Creative studio", size: "8xl", textSpan: 7, pt: "2xl", minH: "90", bg: { kind: "color", color: "accent" }, ctaVariant: ["dark", "outline"],
        collage: { layout: "stack", images: [art("shapes", "light", 3), art("rings", "light", 4), art("mesh", "light", 5)] },
        decor: [{ kind: "blob", at: "bl", size: "l", color: "primary", opacity: 60 }, { kind: "ring", at: "tr", size: "m", color: "ink", opacity: 50 }],
      }),
      wordBand(ctx, { style: "badge", words: ctx.sample ? WORDS : undefined, tone: "light" }),
      introSection(ctx, { layout: "statement", title: "We make brands that bounce.", size: "6xl", body: ctx.lede }),
      services,
      statsSection(ctx, { style: "cards" }),
      testimonialsSection(ctx, { style: "cards" }),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "cards", align: "center" }), gallery: gallerySection(ctx, { images: [art("shapes", "light", 4), art("rings", "light", 6), art("mesh", "light", 7), art("cityblocks", "light", 5)], layout: "grid", cols: "2" }), cta, contact: contactSection(ctx, { style: "stacked", title: "Say hi" }) }),
  };
};

// 3. Brutal: heavy outlines, monospaced labels and a flat, graphic grid.
const brutal = (ctx: TemplateCtx): Recipe => {
  const { b } = ctx;
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: `/ ${ctx.name}`, size: "7xl", pt: "2xl" });
  const services = servicesSection(ctx, { icons: ICONS, style: "grid", cols: "3", title: "Services", eyebrow: "01" });
  const about = aboutSection(ctx, { title: "About the studio", image: art("cityblocks", "light", 2), frame: "none", aspect: "4/3", eyebrow: "02" });
  const process = processSection(ctx, { style: "cards", title: "Process", eyebrow: "03" });
  const cta = ctaSection(ctx, { style: "split", tone: "dark", title: "Start a project.", body: null, buttonVariant: "accent" });
  return {
    design: { ...base, colors: { ...warm, primary: "#111111", accent: "#c6ff3d", bg: "#ffffff", surface: "#ffffff", surface2: "#f1f1ee" }, fonts: { heading: "archivo", body: "dmsans", accent: "dmmono", mono: "dmmono" }, heading: { weight: 800, ls: "tighter", lh: "none", transform: "uppercase", emphasis: "underline" }, radius: "square", shadow: "crisp", buttons: { style: "solid", caps: true, hover: "invert", weight: 700 } },
    header: headerMinimal(ctx, { navStyle: "minimal", pad: "m" }),
    footer: footerMinimal(ctx, { tone: "dark" }),
    home: compact([
      b.section({ id: "hero", name: "Hero", layout: { pt: "l", pb: "xl", width: "wide", gap: "m", valign: "stretch" } }, [
        b.col(8, [
          b.badge("Creative studio — open for work", { variant: "outline" }),
          b.h1(ctx.headline, { style: { size: "8xl", lh: "none" }, anim: { preset: "up", delay: 80 } }),
          b.lede(ctx.lede || "Identity, motion and digital design.", { style: { color: "ink" } }),
          b.group([b.btn(ctx.primaryLabel, ctx.primaryHref, { size: "l", icon: "arrow-up-right" }), ...(ctx.secondary ? [b.btn(ctx.secondary.label, ctx.secondary.href, { variant: "outline", size: "l" })] : [])], { gap: "s" }),
        ], { gap: "m", valign: "center", r: { t: { span: 12 } } }),
        b.col(4, [b.card([b.img(art("cityblocks", "light", 9), { aspect: "3/4", frame: "none" }), b.small("Fig. 01 / Selected work")], { surface: "outlined", pad: "s", gap: "xs", style: { border: "thick", borderColor: "ink", shadow: "l" } })], { valign: "center", r: { t: { span: 12 } } }),
      ]),
      wordBand(ctx, { style: "text", words: ctx.sample ? WORDS : undefined, tone: "dark", size: "3xl", speed: "normal" }),
      services,
      statsSection(ctx, { style: "lines" }),
      gallerySection(ctx, { images: [art("cityblocks", "light", 3), art("shapes", "light", 4), art("rings", "light", 5), art("streets", "light", 6)], layout: "grid", cols: "4", aspect: "1/1", title: "Selected work", eyebrow: "04" }),
      testimonialsSection(ctx, { style: "quote" }),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "lines", side: true }), gallery: gallerySection(ctx, { images: [art("cityblocks", "light", 3), art("shapes", "light", 4), art("rings", "light", 5), art("streets", "light", 6)], layout: "grid", cols: "2", aspect: "1/1" }), cta, contact: contactSection(ctx, { style: "split", title: "Contact" }) }),
  };
};

// 4. Kinetic: dark with a neon accent, a giant outlined marquee and rolling type.
const kinetic = (ctx: TemplateCtx): Recipe => {
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, size: "8xl", pt: "2xl", tone: "dark" });
  const services = servicesSection(ctx, { icons: ICONS, style: "rows", title: "Capabilities", eyebrow: "What we do", layout: "side" });
  const about = aboutSection(ctx, { title: "Motion first, always", image: art("mesh", "dark", 6), frame: "soft", aspect: "4/3" });
  const process = processSection(ctx, { style: "line", title: "Our rhythm" });
  const cta = ctaSection(ctx, { style: "image", title: "Let's move something.", body: null, image: art("mesh", "dark", 4), buttonVariant: "primary" });
  return {
    design: { ...base, mode: "dark", colors: { primary: "#c6ff3d", accent: "#ff4fd8", bg: "#0a0a0f", surface: "#13131b", surface2: "#1b1b26", ink: "#f3f3f7", muted: "#9a9ab0", line: "#272735", dark: "#050508" }, fonts: { heading: "unbounded", body: "dmsans", accent: "dmmono", mono: "dmmono" }, heading: { weight: 700, ls: "tighter", lh: "none", transform: "uppercase", emphasis: "accent" }, radius: "pill", buttons: { style: "solid", caps: true, hover: "shine", weight: 700 } },
    header: headerBar(ctx, { tone: "dark", navStyle: "pills", pad: "m" }),
    footer: footerColumns(ctx, { tone: "dark" }),
    home: compact([
      heroCentered(ctx, {
        tone: "dark", badge: "Studio / Motion / Brand", size: "7xl", pt: "2xl", pb: "l", minH: "90", valign: "center", ctaVariant: ["primary", "outline"], bg: { kind: "mesh", colors: ["primary", "accent"], seed: 8, base: "bg" },
        decor: [{ kind: "grid", at: "c", size: "xl", color: "line", opacity: 30 }],
      }),
      wordBand(ctx, { style: "outline", size: "8xl", words: ctx.sample ? WORDS : undefined, tone: "dark", speed: "slow", pt: "m", pb: "l" }),
      services,
      statsSection(ctx, { style: "big", tone: "dark" }),
      gallerySection(ctx, { images: [art("mesh", "dark", 1), art("rings", "dark", 2), art("grid3d", "dark", 3), art("shapes", "dark", 4)], layout: "strip", aspect: "4/5", title: "In motion", eyebrow: "Reel", width: "full" }),
      testimonialsSection(ctx, { style: "slider" }),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "columns", align: "center" }), gallery: gallerySection(ctx, { images: [art("mesh", "dark", 1), art("rings", "dark", 2), art("grid3d", "dark", 3), art("shapes", "dark", 4)], layout: "masonry", cols: "2" }), cta, contact: contactSection(ctx, { style: "split", title: "Hit us up" }) }),
  };
};

// 5. Collage: pastel blocks and scattered, overlapping images.
const collage = (ctx: TemplateCtx): Recipe => {
  const { b } = ctx;
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, align: "center", size: "8xl", pt: "2xl", bg: { kind: "color", color: "primarySoft" } });
  const services = servicesSection(ctx, { icons: ICONS, style: "iconCards", cols: "3", title: "Things we love making", eyebrow: "Services", align: "center" });
  const about = aboutSection(ctx, { title: "Some people, a lot of ideas", collage: { layout: "duo", images: [art("shapes", "light", 2), art("rings", "light", 3)] } });
  const process = processSection(ctx, { style: "cards", title: "How we play", align: "center" });
  const cta = ctaSection(ctx, { style: "centered", title: "Come make something with us.", body: null });
  return {
    design: { ...base, spacing: "regular", scale: "grand", colors: { primary: "#5b5bff", accent: "#ff8fb1", bg: "#fdf6ff", surface: "#ffffff", surface2: "#f2e6ff", ink: "#1a1330", muted: "#5d5578", line: "#e4d6f5", dark: "#1a1330" }, fonts: { heading: "bricolage", body: "figtree", accent: "figtree", mono: "jetbrains" }, heading: { weight: 700, ls: "tighter", lh: "none", transform: "none", emphasis: "both" }, radius: "round", buttons: { style: "solid", caps: false, hover: "lift", weight: 700 } },
    header: headerCentered(ctx, { navStyle: "pills" }),
    footer: footerCentered(ctx, { tone: "dark" }),
    home: compact([
      b.section({ id: "hero", name: "Hero", bg: { kind: "color", color: "primarySoft" }, layout: { pt: "xl", pb: "xl", width: "wide", gap: "l", valign: "center", minH: "75" }, decor: [{ kind: "blob", at: "tr", size: "l", color: "accent", opacity: 40 }, { kind: "dots", at: "bl", size: "m", color: "primary", opacity: 35 }] }, [
        b.col(6, [
          b.badge(ctx.has.areas ? ctx.d.areas!.slice(0, 2).join(" · ") : "Creative studio", { variant: "outline" }),
          b.h1(ctx.headline, { style: { size: "7xl", lh: "none" }, anim: { preset: "up", delay: 80 } }),
          b.lede(ctx.lede || "Brands, campaigns and films.", { style: { color: "ink" } }),
          b.group([b.btn(ctx.primaryLabel, ctx.primaryHref, { size: "l", icon: "arrow-right" })], { gap: "s" }),
        ], { gap: "m", r: { t: { span: 12 } } }),
        b.col(6, [b.el("collage", { layout: "trio", items: [{ src: art("shapes", "light", 5), alt: "" }, { src: art("rings", "light", 6), alt: "" }, { src: art("mesh", "light", 7), alt: "" }] }, { anim: "scale" })], { valign: "center", r: { t: { span: 12 } } }),
      ]),
      services,
      about,
      statsSection(ctx, { style: "cards" }),
      testimonialsSection(ctx, { style: "cards" }),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "cards", align: "center" }), gallery: gallerySection(ctx, { images: [art("shapes", "light", 4), art("rings", "light", 6), art("mesh", "light", 7), art("cityblocks", "light", 5)], layout: "mosaic" }), cta, contact: contactSection(ctx, { style: "stacked", title: "Say hello" }) }),
  };
};

const v = (id: string, name: string, description: string, tags: string[], build: (ctx: TemplateCtx) => Recipe): VariationDef => ({ id, name, description, tags, build });

export const bold: FamilyDef = {
  id: "bold",
  name: "Bold Creative",
  tagline: "Distinctive compositions, strong contrast, motion.",
  description: "For studios, makers and brands that want to be remembered: oversized type, hard colour and expressive layouts.",
  industries: ["agency"],
  tags: ["creative", "bold", "colourful"],
  sample: SAMPLES.bold,
  variations: [
    v("riot", "Riot", "Huge capitals, a marquee, a tilted picture and a sticker.", ["light", "loud", "typographic"], riot),
    v("pop", "Pop", "Colour blocks in yellow and coral, with rounded everything.", ["light", "colourful", "playful"], pop),
    v("brutal", "Brutal", "Heavy outlines, monospaced labels and a flat graphic grid.", ["light", "graphic", "stark"], brutal),
    v("kinetic", "Kinetic", "Dark with a neon accent and a giant outlined marquee.", ["dark", "neon", "motion"], kinetic),
    v("collage", "Collage", "Pastel blocks with scattered, overlapping pictures.", ["light", "pastel", "playful"], collage),
  ],
};
