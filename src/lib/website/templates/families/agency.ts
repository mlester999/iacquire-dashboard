// Consulting and agencies: a strong point of view, confident statements and case-study-style presentation.
import { art } from "../../build";
import type { Design } from "../../doc";
import {
  aboutSection, contactSection, ctaSection, faqSection, gallerySection, heroCentered, heroSplit, introSection, logosStrip, pageTitle, pricingSection, processSection, servicesSection, statsSection, teamSection, testimonialsSection, wordBand,
} from "../blocks";
import { footerBig, footerCentered, footerColumns, footerMinimal, headerBar, headerCentered, headerMinimal, headerSplit } from "../chrome";
import { compact, innerPages } from "../pages";
import { SAMPLES } from "../samples";
import type { FamilyDef, Recipe, TemplateCtx, VariationDef } from "../types";

const ICONS = ["target", "compass", "trending-up", "layers", "handshake", "lightbulb"];
const base: Partial<Design> = { scale: "grand", spacing: "regular", motion: "smooth" };
const NAMES = ["Northgate", "Brightwater", "Calder & Sons", "Pemberton", "Vale Capital", "Harlow"];

// 1. Thesis: one enormous statement, a word band of capabilities and numbers.
const thesis = (ctx: TemplateCtx): Recipe => {
  const { b } = ctx;
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, size: "8xl", pt: "2xl" });
  const services = servicesSection(ctx, { icons: ICONS, style: "numbered", cols: "3", title: "What we do", eyebrow: "Capabilities" });
  const about = aboutSection(ctx, { title: "A small team with a clear view", image: art("rings", "light", 3), frame: "none", aspect: "1/1", eyebrow: "About" });
  const process = processSection(ctx, { style: "numbered", title: "How we work", eyebrow: "Approach" });
  const cta = ctaSection(ctx, { style: "split", tone: "dark", title: "Have a problem worth solving?", body: null, buttonVariant: "light" });
  return {
    design: { ...base, colors: { primary: "#1a1a1a", accent: "#ff5b36", bg: "#f6f3ee", surface: "#fffdf9", surface2: "#ebe6dc", ink: "#171717", muted: "#5d5a54", line: "#d9d3c5", dark: "#171717" }, fonts: { heading: "instrument", body: "inter", accent: "dmmono", mono: "dmmono" }, heading: { weight: 400, ls: "tighter", lh: "none", transform: "none", emphasis: "accent" }, radius: "square", buttons: { style: "solid", caps: false, hover: "invert", weight: 500 } },
    header: headerBar(ctx, { navStyle: "minimal", pad: "m" }),
    footer: footerBig(ctx, { tone: "dark" }),
    home: compact([
      b.section({ id: "hero", name: "Hero", layout: { pt: "2xl", pb: "l", width: "wide", gap: "m", valign: "start" } }, [
        b.col(12, [
          b.eyebrow(ctx.has.areas ? ctx.d.areas!.slice(0, 2).join(" · ") : "Strategy & operations", { anim: "fade" }),
          b.h1(ctx.headline, { style: { size: "8xl", lh: "none", ls: "tighter" }, anim: { preset: "up", delay: 60 } }),
        ], { gap: "m" }),
        b.col(5, [b.lede(ctx.lede || "We help leadership teams decide, then deliver.", { style: { color: "ink" } })], { valign: "start" }),
        b.col(7, [b.group([b.btn(ctx.primaryLabel, ctx.primaryHref, { size: "l", icon: "arrow-right" }), ...(ctx.secondary ? [b.btn(ctx.secondary.label, ctx.secondary.href, { variant: "outline", size: "l" })] : [])], { gap: "s" })], { valign: "start" }),
      ]),
      wordBand(ctx, { style: "outline", size: "6xl", tone: "dark", speed: "slow", pt: "m", pb: "m" }),
      services,
      statsSection(ctx, { style: "big" }),
      logosStrip(ctx, { names: NAMES, style: "row" }),
      about,
      testimonialsSection(ctx, { style: "quote" }),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "lines", side: true }), gallery: gallerySection(ctx, { images: [art("rings", "light", 3), art("shapes", "light", 4), art("mountains", "light", 5), art("cityblocks", "light", 6)], layout: "mosaic" }), cta, contact: contactSection(ctx, { style: "split", title: "Start a conversation", purpose: "consultation" }) }),
  };
};

// 2. Works: case-study cards with a picture and a result for each service.
const works = (ctx: TemplateCtx): Recipe => {
  const { b } = ctx;
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, size: "7xl", pt: "2xl", tone: "dark", bg: { kind: "gradient", from: "dark", to: "primary", angle: 160 } });
  const services = servicesSection(ctx, { icons: ICONS, style: ctx.sample ? "imageCards" : "iconCards", images: [art("mountains", "cool", 2), art("rings", "dark", 3), art("shapes", "light", 4), art("grid3d", "dark", 5), art("cityblocks", "light", 6)], cols: "3", title: "Selected engagements", eyebrow: "Work" });
  const about = aboutSection(ctx, { title: "Specialists, not generalists", image: art("mountains", "cool", 7), frame: "soft", aspect: "4/3", reverse: true });
  const process = processSection(ctx, { style: "cards", title: "Our method" });
  const cta = ctaSection(ctx, { style: "image", title: "Let's look at your challenge.", body: null, image: art("mountains", "dark", 8), buttonVariant: "light" });
  return {
    design: { ...base, colors: { primary: "#243b6b", accent: "#f2b441", bg: "#f7f8fb", surface: "#ffffff", surface2: "#e9edf5", ink: "#111a30", muted: "#515b75", line: "#d6dcea", dark: "#0c1530" }, fonts: { heading: "fraunces", body: "dmsans", accent: "dmsans", mono: "jetbrains" }, heading: { weight: 400, ls: "tight", lh: "tight", transform: "none", emphasis: "italic" }, radius: "soft", buttons: { style: "solid", caps: false, hover: "lift", weight: 600 } },
    header: headerBar(ctx, { navStyle: "underline", pad: "m", sticky: true, bg: { kind: "color", color: "bg" } }),
    footer: footerColumns(ctx, { tone: "dark" }),
    home: compact([
      heroSplit(ctx, {
        eyebrow: ctx.has.areas ? ctx.d.areas!.slice(0, 2).join(" · ") : "Advisory", size: "7xl", textSpan: 7, image: art("mountains", "cool", 1), aspect: "4/5", frame: "soft", pt: "2xl", pb: "xl", ctaVariant: ["primary", "outline"],
        bg: { kind: "gradient", from: "bg", to: "surface2", angle: 160 },
      }),
      logosStrip(ctx, { names: NAMES, style: "row" }),
      services,
      statsSection(ctx, { style: "lines" }),
      teamSection(ctx, { style: "cards", cols: "3" }),
      testimonialsSection(ctx, { style: "cards" }),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "accordion", side: true }), gallery: gallerySection(ctx, { images: [art("mountains", "cool", 2), art("rings", "dark", 3), art("shapes", "light", 4), art("grid3d", "dark", 5)], layout: "grid", cols: "2", aspect: "16/10" }), cta, contact: contactSection(ctx, { style: "split", title: "Start a conversation", purpose: "consultation" }) }),
  };
};

// 3. Method: process first, with a large ring graphic and engagement models.
const method = (ctx: TemplateCtx): Recipe => {
  const { b } = ctx;
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, size: "7xl", pt: "2xl", tone: "dark", image: art("rings", "dark", 4) });
  const services = servicesSection(ctx, { icons: ICONS, style: "rows", layout: "side", title: "Ways to work together", eyebrow: "Engagements" });
  const about = aboutSection(ctx, { title: "Built for decisions", image: art("rings", "dark", 5), frame: "circle", aspect: "1/1" });
  const process = processSection(ctx, { style: "vertical", side: true, title: "Four phases" });
  const cta = ctaSection(ctx, { style: "band", tone: "brand", title: "Ready to begin?", body: "A short intro call is the best place to start." });
  return {
    design: { ...base, mode: "dark", colors: { primary: "#7c5cff", accent: "#2ee6a6", bg: "#0b0b14", surface: "#13132a", surface2: "#1b1b38", ink: "#f0f0fa", muted: "#9d9dc0", line: "#27274b", dark: "#06060e" }, fonts: { heading: "sora", body: "inter", accent: "dmmono", mono: "dmmono" }, heading: { weight: 600, ls: "tighter", lh: "tight", transform: "none", emphasis: "accent" }, radius: "round", buttons: { style: "gradient", caps: false, hover: "shine", weight: 600 } },
    header: headerBar(ctx, { tone: "dark", navStyle: "pills", pad: "m" }),
    footer: footerColumns(ctx, { tone: "dark" }),
    home: compact([
      heroSplit(ctx, {
        tone: "dark", eyebrow: "Strategy · Operations · Change", size: "7xl", textSpan: 7, pt: "2xl", minH: "90", bg: { kind: "image", src: art("rings", "dark", 2), overlay: { color: "dark", opacity: 18, dir: "left" }, pos: { x: 85, y: 50 }, parallax: false }, ctaVariant: ["primary", "outline"], rightElements: [],
      }),
      introSection(ctx, { layout: "statement", title: "Four phases. One team. Decisions that stay made.", size: "5xl", body: ctx.lede }),
      processSection(ctx, { style: "timeline", title: "How an engagement runs", align: "center" }),
      services,
      statsSection(ctx, { style: "cards", tone: "dark" }),
      pricingSection(ctx, { title: "Engagement models", eyebrow: "Ways to engage" }),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "cards", align: "center" }), gallery: gallerySection(ctx, { images: [art("rings", "dark", 1), art("grid3d", "dark", 2), art("mesh", "dark", 3), art("waves", "dark", 4)], layout: "grid", cols: "2" }), cta, contact: contactSection(ctx, { style: "split", title: "Book an intro call", purpose: "consultation" }) }),
  };
};

// 4. Counsel: serif, advisory, restrained. Words first.
const counsel = (ctx: TemplateCtx): Recipe => {
  const { b } = ctx;
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, align: "center", size: "7xl", pt: "2xl" });
  const services = servicesSection(ctx, { icons: ICONS, style: "list", title: "Where we advise", eyebrow: "Practice", layout: "side" });
  const about = aboutSection(ctx, { title: "Advice you can act on", image: art("townhouse", "light", 3), frame: "none", aspect: "3/4" });
  const process = processSection(ctx, { style: "line", title: "How we work", align: "center" });
  const cta = ctaSection(ctx, { style: "minimal", title: "Write to us, or telephone.", buttonVariant: "ghost" });
  return {
    design: { ...base, spacing: "airy", colors: { primary: "#233a2f", accent: "#a98245", bg: "#f8f5ee", surface: "#fdfaf3", surface2: "#ede7d8", ink: "#1d1a15", muted: "#5d574c", line: "#dbd2bd", dark: "#1d1a15" }, fonts: { heading: "lora", body: "inter", accent: "inter", mono: "jetbrains" }, heading: { weight: 500, ls: "tight", lh: "snug", transform: "none", emphasis: "italic" }, radius: "square", buttons: { style: "outline", caps: true, hover: "invert", weight: 500 } },
    header: headerSplit(ctx, { navStyle: "minimal", pad: "m" }),
    footer: footerCentered(ctx, { tone: "dark" }),
    home: compact([
      heroCentered(ctx, {
        eyebrow: ctx.has.areas ? ctx.d.areas!.slice(0, 2).join(" · ") : "Advisory", size: "7xl", pt: "3xl", pb: "2xl", minH: "75", valign: "center", ctaVariant: ["primary", "ghost"],
      }),
      introSection(ctx, { layout: "statement", title: "Clear thinking, in plain English.", size: "5xl", body: ctx.lede }),
      services,
      statsSection(ctx, { style: "lines" }),
      teamSection(ctx, { style: "circles", cols: "3", align: "center" }),
      testimonialsSection(ctx, { style: "quote" }),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "lines", align: "center" }), gallery: gallerySection(ctx, { images: [art("townhouse", "light", 3), art("facade", "light", 4), art("garden", "light", 5), art("mountains", "light", 6)], layout: "grid", cols: "2", aspect: "3/4" }), cta, contact: contactSection(ctx, { style: "stacked", title: "Get in touch", purpose: "consultation" }) }),
  };
};

// 5. Launch: a growth agency, bright and energetic, numbers up front.
const launch = (ctx: TemplateCtx): Recipe => {
  const { b } = ctx;
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, size: "7xl", pt: "2xl", tone: "dark", bg: { kind: "mesh", colors: ["primary", "accent"], seed: 5, base: "dark" } });
  const services = servicesSection(ctx, { icons: ICONS, style: "bento", title: "Growth, end to end", eyebrow: "Services", align: "center" });
  const about = aboutSection(ctx, { title: "Operators who like numbers", image: art("mesh", "dark", 4), frame: "soft", aspect: "4/3" });
  const process = processSection(ctx, { style: "cards", title: "The first 90 days", align: "center" });
  const cta = ctaSection(ctx, { style: "image", title: "Let's find your next 10x.", body: null, image: art("mesh", "dark", 9), buttonVariant: "light" });
  return {
    design: { ...base, scale: "display", colors: { primary: "#5b3df5", accent: "#c5ff3d", bg: "#fbfaff", surface: "#ffffff", surface2: "#efecff", ink: "#12102a", muted: "#58557a", line: "#e0dbfa", dark: "#100c33" }, fonts: { heading: "bricolage", body: "dmsans", accent: "dmmono", mono: "dmmono" }, heading: { weight: 700, ls: "tighter", lh: "none", transform: "none", emphasis: "both" }, radius: "round", buttons: { style: "solid", caps: false, hover: "lift", weight: 700 } },
    header: headerBar(ctx, { navStyle: "pills", pad: "m" }),
    footer: footerBig(ctx, { tone: "dark" }),
    home: compact([
      heroCentered(ctx, {
        tone: "dark", badge: "Performance marketing & product growth", size: "8xl", pt: "2xl", pb: "xl", minH: "90", valign: "center", ctaVariant: ["light", "outline"], bg: { kind: "mesh", colors: ["primary", "accent", "primary"], seed: 7, base: "dark" },
        decor: [{ kind: "grid", at: "c", size: "xl", color: "line", opacity: 25 }],
      }),
      statsSection(ctx, { style: "big", tone: "dark", bg: { kind: "color", color: "dark" } }),
      logosStrip(ctx, { names: NAMES, style: "marquee" }),
      services,
      processSection(ctx, { style: "cards", title: "The first 90 days", align: "center" }),
      testimonialsSection(ctx, { style: "wall" }),
      pricingSection(ctx, {}),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "cards", align: "center" }), gallery: gallerySection(ctx, { images: [art("mesh", "dark", 1), art("shapes", "light", 2), art("rings", "dark", 3), art("waves", "dark", 4)], layout: "masonry", cols: "2" }), cta, contact: contactSection(ctx, { style: "stacked", title: "Book a growth call", purpose: "consultation" }) }),
  };
};

const v = (id: string, name: string, description: string, tags: string[], build: (ctx: TemplateCtx) => Recipe): VariationDef => ({ id, name, description, tags, build });

export const agency: FamilyDef = {
  id: "agency",
  name: "Consulting & Agencies",
  tagline: "A strong point of view and confident, editorial presentation.",
  description: "For consultancies and agencies: a value proposition that does the talking, case-study layouts and decisive calls to action.",
  industries: ["consulting", "agency"],
  tags: ["consulting", "agency", "statement"],
  sample: SAMPLES.agency,
  variations: [
    v("thesis", "Thesis", "One enormous statement, a band of capabilities and big numbers.", ["light", "typographic", "orange"], thesis),
    v("works", "Works", "Case-study cards and a landscape image beside the promise.", ["light", "navy", "cards"], works),
    v("method", "Method", "Process first, with a large ring graphic and engagement models.", ["dark", "violet", "process"], method),
    v("counsel", "Counsel", "Serif, advisory and restrained. Words first.", ["light", "serif", "restrained"], counsel),
    v("launch", "Launch", "A growth agency: bright, energetic, numbers up front.", ["light", "violet", "energetic"], launch),
  ],
};
