// Architecture and real estate. Photography-led, unhurried, with a strong sense of place.
import { art } from "../../build";
import type { Design, PageItem } from "../../doc";
import {
  aboutSection, contactSection, ctaSection, faqSection, gallerySection, heroEditorial, heroCentered, heroFull, heroSplit, pageTitle, processSection, servicesSection, statsSection, testimonialsSection, pick,
} from "../blocks";
import { footerBig, footerCentered, footerColumns, headerBar, headerCentered, headerFloating, headerMinimal, headerSplit } from "../chrome";
import { SAMPLES } from "../samples";
import { compact, innerPages } from "../pages";
import type { FamilyDef, Recipe, TemplateCtx, VariationDef } from "../types";

const ICONS = ["key", "home", "chart", "building", "compass", "handshake"];

const designBase: Partial<Design> = { scale: "grand", spacing: "airy", motion: "smooth" };

// ---------------------------------------------------------------------------
// 1. Estate: classic, warm and unhurried, with a full-width photograph.
// ---------------------------------------------------------------------------
const estate = (ctx: TemplateCtx): Recipe => {
  const { b } = ctx;
  const imgs = [art("townhouse", "warm", 1), art("interior", "warm", 2), art("garden", "warm", 3), art("facade", "warm", 4), art("villa", "light", 5)];
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, tone: "dark", image: art("villa", "warm", 7), size: "7xl", pt: "3xl" });
  const services = servicesSection(ctx, { icons: ICONS, style: ctx.sample ? "alternating" : "rows", images: [imgs[1], imgs[2], imgs[0], imgs[3], imgs[4]], title: "Considered service, start to finish", eyebrow: "What we do", width: "wide" });
  const about = aboutSection(ctx, { title: "A small studio with long memories", image: art("interior", "warm", 9), frame: "arch", aspect: "4/5", reverse: true });
  const cta = ctaSection(ctx, { style: "image", title: "Let's find the place that feels like yours.", body: "Speak to someone who knows the streets, the sellers and the stories.", image: art("garden", "warm", 11), eyebrow: "Start a conversation" });
  const faq = faqSection(ctx, { side: true, title: "Good questions, plainly answered" });
  const gallery = gallerySection(ctx, { images: imgs, captions: ["The terrace house", "Morning light", "The garden path", "Quiet lines", "Dusk on the hill"], layout: "mosaic", cols: "3", title: "Homes we've loved", eyebrow: "Recent work" });
  const process = processSection(ctx, { style: "timeline", title: "From first conversation to the keys" });
  const contact = contactSection(ctx, { style: "split", title: "Come and talk to us", eyebrow: "Contact" });
  return {
    design: {
      ...designBase,
      colors: { primary: "#1f3a2e", accent: "#b08d57", bg: "#f7f3ec", surface: "#fffdf9", surface2: "#efe9de", ink: "#1a1815", muted: "#5b554b", line: "#ddd5c6", dark: "#14110f" },
      fonts: { heading: "cormorant", body: "jost", accent: "jost", mono: "jetbrains" },
      heading: { weight: 500, ls: "tight", lh: "tight", transform: "none", emphasis: "italic" }, radius: "square", buttons: { style: "solid", caps: true, hover: "lift", weight: 500 },
    },
    header: headerBar(ctx, { tone: "dark", float: true, navStyle: "underline", pad: "m" }),
    footer: footerColumns(ctx, { tone: "dark" }),
    home: compact([
      heroFull(ctx, { image: art("villa", "warm", 1), eyebrow: ctx.has.areas ? `Residential sales & lettings · ${ctx.d.areas![0]}` : "Residential sales & lettings", size: "7xl", ctaVariant: ["light", "outline"], parallax: true }),
      b.section({ id: "intro", name: "Introduction", layout: { pt: "2xl", pb: "xl", width: "wide", gap: "xl", valign: "start" } }, [
        b.col(5, [b.eyebrow("Our approach"), b.h2("A quieter way to buy and sell a home.", { style: { size: "5xl" }, anim: "up" })], { gap: "m" }),
        b.col(7, [b.lede(ctx.lede || "We guide buyers, sellers and landlords with patience, plain talk and an eye for what makes a place worth coming home to.", { style: { color: "ink" }, anim: "up" }), b.btn("About the studio", "/about", { variant: "ghost", icon: "arrow-right" })], { gap: "m" }),
      ]),
      gallerySection(ctx, { images: imgs, captions: ["The terrace house", "Morning light", "The garden path", "Quiet lines", "Dusk on the hill"], layout: "mosaic", title: "Homes we've loved", eyebrow: "Recent work", width: "wide" }),
      services,
      statsSection(ctx, { style: "lines", tone: "dark", pt: "xl", pb: "xl" }),
      testimonialsSection(ctx, { style: "quote", width: "regular" }),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq, gallery, cta, contact }),
  };
};

// ---------------------------------------------------------------------------
// 2. Skyline: dark, modern and architectural.
// ---------------------------------------------------------------------------
const skyline = (ctx: TemplateCtx): Recipe => {
  const { b } = ctx;
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, tone: "dark", bg: { kind: "pattern", pattern: "grid", color: "line", opacity: 70 }, size: "7xl", pt: "3xl" });
  const services = servicesSection(ctx, { icons: ICONS, style: "bento", title: "Everything a move needs", eyebrow: "Services", layout: "stacked", cols: "3" });
  const cta = ctaSection(ctx, { style: "split", tone: "brand", title: "Ready to make a move?", body: "A short call is all it takes to start." });
  const about = aboutSection(ctx, { title: "Built on local knowledge", image: art("skyline", "dark", 3), frame: "notch", aspect: "4/5" });
  const process = processSection(ctx, { style: "cards", title: "How it works" });
  return {
    design: {
      ...designBase, mode: "dark", spacing: "regular",
      colors: { primary: "#d98c4f", accent: "#7aa2c7", bg: "#0e1116", surface: "#151a22", surface2: "#1c232d", ink: "#eef1f5", muted: "#9aa4b2", line: "#262e3a", dark: "#090b0f" },
      fonts: { heading: "barlow", body: "manrope", accent: "manrope", mono: "jetbrains" },
      heading: { weight: 700, ls: "wide", lh: "none", transform: "uppercase", emphasis: "accent" }, radius: "soft", buttons: { style: "solid", caps: true, hover: "shine", weight: 700 },
    },
    header: headerFloating(ctx, { tone: "dark", navStyle: "pills", bg: { kind: "color", color: "surface" } }),
    footer: footerBig(ctx, { tone: "dark" }),
    home: compact([
      heroSplit(ctx, {
        tone: "dark", reverse: true, image: art("skyline", "dark", 4), aspect: "4/5", frame: "notch", size: "7xl", pt: "3xl", minH: "90", textSpan: 7, eyebrow: ctx.has.areas ? ctx.d.areas!.slice(0, 3).join("  /  ") : "Residential",
        bg: { kind: "pattern", pattern: "grid", color: "line", opacity: 55, base: "bg" }, ctaVariant: ["primary", "outline"],
        headingStyle: { ls: "normal", lh: "none" }, badges: pick(["Sales", "Lettings", "Valuations"], [], ctx),
      }),
      b.section({ id: "areas", name: "Areas", tone: "dark", layout: { pt: "m", pb: "m", width: "full" }, bg: { kind: "color", color: "surface" } }, [b.col(12, [b.el("marquee", { items: ctx.d.areas?.length ? ctx.d.areas : ctx.d.services.map((s) => s.title), speed: "normal", style: "text" }, { style: { size: "3xl" } })])]),
      services,
      statsSection(ctx, { style: "big", head: true, title: "The city, by the numbers", eyebrow: "In figures" }),
      gallerySection(ctx, { images: [art("skyline", "cool", 6), art("facade", "dark", 7), art("villa", "dark", 8), art("townhouse", "cool", 9)], layout: "strip", aspect: "4/3", title: "Recently listed", eyebrow: "Portfolio", width: "full" }),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "cards", side: true }), gallery: gallerySection(ctx, { images: [art("skyline", "cool", 6), art("facade", "dark", 7), art("villa", "dark", 8), art("townhouse", "cool", 9)], layout: "masonry", cols: "3" }), cta, contact: contactSection(ctx, { style: "split", title: "Talk to us" }) }),
  };
};

// ---------------------------------------------------------------------------
// 3. Harbor: light, calm and coastal, centred and friendly.
// ---------------------------------------------------------------------------
const harbor = (ctx: TemplateCtx): Recipe => {
  const { b } = ctx;
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, align: "center", size: "6xl", pt: "2xl", bg: { kind: "gradient", from: "primarySoft", to: "bg", angle: 180 } });
  const services = servicesSection(ctx, { icons: ICONS, style: "iconCards", title: "Help with every step", eyebrow: "What we do", align: "center", cols: "3" });
  const cta = ctaSection(ctx, { style: "card", title: "Start with a friendly conversation.", body: "No pressure and no jargon. Just a chat about what you have in mind." });
  const about = aboutSection(ctx, { title: "Local, independent, and easy to talk to", collage: { layout: "arch", images: [art("garden", "light", 3), art("villa", "light", 4)] } });
  const process = processSection(ctx, { style: "line", title: "How it works", align: "center" });
  return {
    design: {
      ...designBase, spacing: "regular", scale: "regular",
      colors: { primary: "#16324f", accent: "#d9a66b", bg: "#f5f9fb", surface: "#ffffff", surface2: "#e6eff4", ink: "#12263a", muted: "#4e6379", line: "#d3e0e9", dark: "#0f2236" },
      fonts: { heading: "fraunces", body: "figtree", accent: "figtree", mono: "jetbrains" },
      heading: { weight: 400, ls: "tight", lh: "tight", transform: "none", emphasis: "italic" }, radius: "round", buttons: { style: "solid", caps: false, hover: "lift", weight: 600 },
    },
    header: headerCentered(ctx, { navStyle: "underline" }),
    footer: footerCentered(ctx, { tone: "light" }),
    home: compact([
      heroCentered(ctx, {
        eyebrow: ctx.has.areas ? `Homes in ${ctx.d.areas!.slice(0, 2).join(" & ")}` : "Residential property", size: "7xl", pt: "xl", pb: "l", bg: { kind: "gradient", from: "primarySoft", to: "bg", angle: 180 },
        below: [b.el("collage", { layout: "arch", items: [{ src: art("garden", "light", 3), alt: "" }, { src: art("villa", "light", 4), alt: "" }] }, { anim: "scale", style: { mt: "m" } })],
        ctaVariant: ["primary", "outline"],
      }),
      services,
      aboutSection(ctx, { title: "Local, independent and easy to talk to", image: art("interior", "light", 5), frame: "arch", aspect: "4/5", pt: "xl" }),
      processSection(ctx, { style: "line", title: "How it works", align: "center" }),
      testimonialsSection(ctx, { style: "cards" }),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "cards", align: "center" }), gallery: gallerySection(ctx, { images: [art("garden", "light", 3), art("villa", "light", 4), art("interior", "light", 5), art("townhouse", "light", 6)], layout: "grid", cols: "2", aspect: "4/3" }), cta, contact: contactSection(ctx, { style: "stacked", title: "Say hello" }) }),
  };
};

// ---------------------------------------------------------------------------
// 4. Heritage: editorial and traditional.
// ---------------------------------------------------------------------------
const heritage = (ctx: TemplateCtx): Recipe => {
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, align: "center", size: "7xl", pt: "2xl" });
  const services = servicesSection(ctx, { icons: ICONS, style: "numbered", title: "What we do", eyebrow: "Our services", cols: "2" });
  const cta = ctaSection(ctx, { style: "minimal", title: "Visit us, or write to us.", buttonVariant: "ghost" });
  const about = aboutSection(ctx, { title: "A practice built on trust", image: art("townhouse", "warm", 3), frame: "none", aspect: "3/4", eyebrow: "Our story" });
  const process = processSection(ctx, { style: "vertical", title: "How we work", side: true });
  return {
    design: {
      ...designBase, spacing: "airy",
      colors: { primary: "#6b1f2a", accent: "#a88a4a", bg: "#f6efe4", surface: "#fbf6ee", surface2: "#ece2d1", ink: "#231a14", muted: "#5d5043", line: "#d9cbb4", dark: "#1d1411" },
      fonts: { heading: "playfair", body: "lora", accent: "lora", mono: "jetbrains" },
      heading: { weight: 700, ls: "tight", lh: "tight", transform: "none", emphasis: "italic" }, radius: "square", buttons: { style: "outline", caps: true, hover: "invert", weight: 500 },
    },
    header: headerSplit(ctx, { navStyle: "minimal", pad: "m" }),
    footer: footerCentered(ctx, { tone: "dark" }),
    home: compact([
      heroEditorial(ctx, { images: [art("townhouse", "warm", 2), art("garden", "warm", 3)], captions: ["Plate I. The townhouse", "Plate II. The garden"], size: "8xl", eyebrow: `${ctx.name}`, note: ctx.has.areas ? `Serving ${ctx.d.areas!.slice(0, 3).join(", ")}` : undefined, ctaVariant: ["primary", "outline"] }),
      services,
      aboutSection(ctx, { title: "A practice built on trust", image: art("interior", "warm", 4), frame: "none", aspect: "3/4", eyebrow: "Our story", reverse: true }),
      testimonialsSection(ctx, { style: "wall", tone: "dark" }),
      processSection(ctx, { style: "vertical", title: "How we work", side: true }),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "lines", align: "center", side: false }), gallery: gallerySection(ctx, { images: [art("townhouse", "warm", 2), art("garden", "warm", 3), art("interior", "warm", 4), art("facade", "warm", 5)], layout: "grid", cols: "2", aspect: "3/4" }), cta, contact: contactSection(ctx, { style: "split" }) }),
  };
};

// ---------------------------------------------------------------------------
// 5. Metro: compact, city-sharp and confident.
// ---------------------------------------------------------------------------
const metro = (ctx: TemplateCtx): Recipe => {
  const { b } = ctx;
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, size: "7xl", pt: "2xl" });
  const services = servicesSection(ctx, { icons: ICONS, style: "list", title: "Services", eyebrow: "01 / What we do", layout: "side" });
  const cta = ctaSection(ctx, { style: "split", tone: "dark", title: "Make an enquiry in under a minute.", body: null });
  const about = aboutSection(ctx, { title: "Sharp on the details", image: art("cityblocks", "light", 3), frame: "none", aspect: "1/1", eyebrow: "02 / About" });
  const process = processSection(ctx, { style: "numbered", title: "How it works", eyebrow: "03 / Process" });
  return {
    design: {
      ...designBase, spacing: "regular", scale: "display",
      colors: { primary: "#111111", accent: "#ff5a1f", bg: "#ffffff", surface: "#ffffff", surface2: "#f3f3f1", ink: "#0b0b0b", muted: "#55575b", line: "#dcdcd8", dark: "#0b0b0b" },
      fonts: { heading: "archivo", body: "inter", accent: "jetbrains", mono: "jetbrains" },
      heading: { weight: 800, ls: "tighter", lh: "none", transform: "uppercase", emphasis: "accent" }, radius: "square", buttons: { style: "solid", caps: true, hover: "invert", weight: 700 },
    },
    header: headerMinimal(ctx, { navStyle: "minimal", pad: "m" }),
    footer: footerBig(ctx, { tone: "light" }),
    home: compact([
      b.section({ id: "hero", name: "Hero", layout: { pt: "xl", pb: "m", width: "wide", gap: "m", valign: "start" } }, [
        b.col(12, [
          b.eyebrow(ctx.has.areas ? ctx.d.areas!.slice(0, 3).join(" · ") : "Residential", { anim: "fade" }),
          b.h1(ctx.headline, { style: { size: "8xl" }, anim: { preset: "up", delay: 80 } }),
        ], { gap: "m" }),
        b.col(4, [b.lede(ctx.lede || "Honest advice on buying, selling and letting.", { style: { color: "ink" } }), b.group([b.btn(ctx.primaryLabel, ctx.primaryHref, { size: "l", icon: "arrow-right" })], { style: { mt: "s" } })], { gap: "m", valign: "start" }),
        b.col(8, [b.img(art("cityblocks", "light", 5), { aspect: "16/10", frame: "none", priority: true, anim: { preset: "reveal", delay: 140 } })], { valign: "start" }),
      ]),
      b.section({ id: "areas", name: "Areas", tone: "dark", layout: { pt: "m", pb: "m", width: "full" } }, [b.col(12, [b.el("marquee", { items: ctx.d.areas?.length ? ctx.d.areas : ctx.d.services.map((s) => s.title), speed: "fast", style: "outline" }, { style: { size: "4xl" } })])]),
      services,
      gallerySection(ctx, { images: [art("cityblocks", "light", 6), art("facade", "light", 7), art("skyline", "light", 8), art("townhouse", "light", 9), art("villa", "light", 10), art("interior", "light", 11)], layout: "masonry", cols: "3", title: "Recent lettings and sales", eyebrow: "04 / Work" }),
      statsSection(ctx, { style: "cards", tone: "light" }),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "lines", side: true }), gallery: gallerySection(ctx, { images: [art("cityblocks", "light", 6), art("facade", "light", 7), art("skyline", "light", 8), art("townhouse", "light", 9)], layout: "mosaic" }), cta, contact: contactSection(ctx, { style: "split" }) }),
  };
};

const v = (id: string, name: string, description: string, tags: string[], build: (ctx: TemplateCtx) => Recipe): VariationDef => ({ id, name, description, tags, build });

export const meridian: FamilyDef = {
  id: "meridian",
  name: "Architecture & Real Estate",
  tagline: "Image-led and elegant, for property.",
  description: "Large photography, distinctive image treatments and unhurried storytelling for agents, architects and developers.",
  industries: ["real_estate"],
  tags: ["property", "photography", "premium"],
  sample: SAMPLES.meridian,
  variations: [
    v("estate", "Estate", "Classic and unhurried, with a full-width photograph and warm brass details.", ["light", "classic", "photography"], estate),
    v("skyline", "Skyline", "Dark, modern and architectural, with condensed capitals and a notched frame.", ["dark", "modern", "bold"], skyline),
    v("harbor", "Harbor", "Light and coastal, centred and friendly, with arch-shaped images.", ["light", "calm", "friendly"], harbor),
    v("heritage", "Heritage", "Editorial and traditional: a magazine masthead, oxblood and gold.", ["light", "editorial", "classic"], heritage),
    v("metro", "Metro", "Compact and city-sharp, with giant capitals, a marquee and a stark grid.", ["light", "bold", "urban"], metro),
  ],
};
