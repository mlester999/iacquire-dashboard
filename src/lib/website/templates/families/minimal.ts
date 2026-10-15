// Elegant minimal: whitespace, quiet type, small precise details and a single well-chosen picture at a time.
import { art } from "../../build";
import type { Design } from "../../doc";
import {
  aboutSection, contactSection, ctaSection, faqSection, gallerySection, heroCentered, introSection, pageTitle, processSection, servicesSection, statsSection, testimonialsSection,
} from "../blocks";
import { footerCentered, footerColumns, footerMinimal, headerBar, headerCentered, headerMinimal, headerSplit } from "../chrome";
import { compact, innerPages } from "../pages";
import { SAMPLES } from "../samples";
import type { FamilyDef, Recipe, TemplateCtx, VariationDef } from "../types";

const ICONS = ["leaf", "gem", "palette", "home"];
const base: Partial<Design> = { scale: "grand", spacing: "luxe", motion: "subtle", radius: "square", shadow: "none" };

const paper = { primary: "#26231f", accent: "#8a8f6a", bg: "#fbfaf7", surface: "#ffffff", surface2: "#f1eee7", ink: "#1c1a17", muted: "#6a655c", line: "#e4dfd3", dark: "#1c1a17" };

// 1. Quiet: a sentence, a small picture, nothing else.
const quiet = (ctx: TemplateCtx): Recipe => {
  const { b } = ctx;
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, size: "7xl", pt: "2xl" });
  const services = servicesSection(ctx, { icons: ICONS, style: "list", title: "Things we make", eyebrow: "Range", layout: "side" });
  const about = aboutSection(ctx, { title: "Made in small runs", image: art("botanical", "light", 2), frame: "none", aspect: "4/5", eyebrow: "About" });
  const process = processSection(ctx, { style: "numbered", title: "How it is made" });
  const cta = ctaSection(ctx, { style: "minimal", title: "Visit the studio, or write to us.", buttonVariant: "ghost" });
  return {
    design: { ...base, colors: paper, fonts: { heading: "instrument", body: "inter", accent: "dmmono", mono: "dmmono" }, heading: { weight: 400, ls: "tight", lh: "snug", transform: "none", emphasis: "italic" }, buttons: { style: "outline", caps: false, hover: "invert", weight: 500 } },
    header: headerMinimal(ctx, { navStyle: "minimal", pad: "m" }),
    footer: footerMinimal(ctx),
    home: compact([
      b.section({ id: "hero", name: "Hero", layout: { pt: "2xl", pb: "xl", width: "wide", gap: "xl", valign: "end" } }, [
        b.col(8, [
          b.eyebrow(ctx.has.areas ? ctx.d.areas![0] : "Studio", { anim: "fade" }),
          b.h1(ctx.headline, { style: { size: "7xl", lh: "none" }, anim: { preset: "up", delay: 80 } }),
          b.lede(ctx.lede || "Everyday things, made with care.", { style: { w: "m" } }),
          b.btn(ctx.primaryLabel, ctx.primaryHref, { variant: "ghost", icon: "arrow-right", style: { mt: "s" } }),
        ], { gap: "m", r: { t: { span: 12 } } }),
        b.col(4, [b.img(art("botanical", "light", 1), { aspect: "4/5", frame: "none", priority: true, anim: { preset: "reveal", delay: 140 } })], { valign: "end", r: { t: { span: 6 }, m: { span: 12 } } }),
      ]),
      introSection(ctx, { layout: "statement", eyebrow: "A closer look", title: "Useful forms, considered slowly.", body: null, size: "4xl", pt: "l", pb: "l" }),
      services,
      about,
      testimonialsSection(ctx, { style: "quote", width: "narrow" }),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "lines", side: true }), gallery: gallerySection(ctx, { images: [art("botanical", "light", 1), art("calm", "light", 2), art("desk", "light", 3), art("clinic", "light", 4)], layout: "grid", cols: "2", aspect: "4/5" }), cta, contact: contactSection(ctx, { style: "stacked", title: "Write to us" }) }),
  };
};

// 2. Frame: centred, a single wide picture in a thin frame.
const frame = (ctx: TemplateCtx): Recipe => {
  const { b } = ctx;
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, size: "7xl", align: "center", pt: "2xl" });
  const services = servicesSection(ctx, { icons: ICONS, style: "numbered", cols: "2", title: "The range", eyebrow: "Collections", align: "center" });
  const about = aboutSection(ctx, { title: "A small, patient studio", image: art("desk", "light", 2), frame: "offset", aspect: "4/3", reverse: true });
  const process = processSection(ctx, { style: "line", title: "Made by hand", align: "center" });
  const cta = ctaSection(ctx, { style: "centered", title: "Commission a piece.", body: null });
  return {
    design: { ...base, colors: { ...paper, accent: "#a0795a" }, fonts: { heading: "newsreader", body: "dmsans", accent: "dmsans", mono: "dmmono" }, heading: { weight: 300, ls: "tight", lh: "tight", transform: "none", emphasis: "italic" }, buttons: { style: "solid", caps: false, hover: "lift", weight: 500 } },
    header: headerCentered(ctx, { navStyle: "minimal" }),
    footer: footerCentered(ctx),
    home: compact([
      heroCentered(ctx, {
        eyebrow: "Handmade goods", size: "7xl", pt: "xl", pb: "l", ctaVariant: ["primary", "ghost"],
        below: [b.img(art("desk", "light", 1), { aspect: "21/9", frame: "offset", style: { mt: "l" }, anim: "reveal" })],
      }),
      introSection(ctx, { layout: "statement", title: "Fewer things, made better.", body: ctx.lede, size: "5xl" }),
      services,
      about,
      gallerySection(ctx, { images: [art("botanical", "light", 3), art("calm", "light", 4), art("desk", "light", 5)], layout: "grid", cols: "3", aspect: "4/5", title: "From the studio", eyebrow: "Journal" }),
      testimonialsSection(ctx, { style: "quote" }),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "lines", align: "center" }), gallery: gallerySection(ctx, { images: [art("botanical", "light", 3), art("calm", "light", 4), art("desk", "light", 5), art("clinic", "light", 6)], layout: "masonry", cols: "2" }), cta, contact: contactSection(ctx, { style: "stacked", title: "Get in touch" }) }),
  };
};

// 3. Index: a numbered, table-like layout where the type does the work.
const index = (ctx: TemplateCtx): Recipe => {
  const { b } = ctx;
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: "— " + ctx.name, size: "8xl", pt: "2xl" });
  const services = servicesSection(ctx, { icons: ICONS, style: "rows", layout: "side", title: "Index", eyebrow: "01 — Range" });
  const about = aboutSection(ctx, { title: "About", image: art("calm", "light", 5), frame: "none", aspect: "1/1", eyebrow: "02 — Studio" });
  const process = processSection(ctx, { style: "vertical", side: true, title: "Process", eyebrow: "03" });
  const cta = ctaSection(ctx, { style: "split", title: "Enquiries", body: null, buttonVariant: "outline" });
  return {
    design: { ...base, colors: { ...paper, accent: "#3f5b4a", bg: "#ffffff", surface2: "#f3f3f1" }, fonts: { heading: "inter", body: "inter", accent: "dmmono", mono: "dmmono" }, heading: { weight: 500, ls: "tighter", lh: "none", transform: "none", emphasis: "accent" }, buttons: { style: "outline", caps: false, hover: "invert", weight: 500 } },
    header: headerSplit(ctx, { navStyle: "minimal", pad: "m" }),
    footer: footerMinimal(ctx),
    home: compact([
      b.section({ id: "hero", name: "Hero", layout: { pt: "xl", pb: "xl", width: "wide", gap: "l", valign: "start" } }, [
        b.col(12, [b.h1(ctx.headline, { style: { size: "8xl", lh: "none", ls: "tighter" }, anim: { preset: "up", delay: 60 } })], { gap: "m" }),
        b.col(4, [b.eyebrow("(01) About"), b.body(ctx.lede || "A small studio.", { style: { w: "s" } })], { gap: "s", valign: "start" }),
        b.col(4, [b.eyebrow("(02) Visit"), b.body((ctx.d.address || "By appointment").replace(/\n/g, ", "), { style: { w: "s" } })], { gap: "s", valign: "start" }),
        b.col(4, [b.eyebrow("(03) Say hello"), b.btn(ctx.primaryLabel, ctx.primaryHref, { variant: "ghost", icon: "arrow-up-right" })], { gap: "s", valign: "start" }),
        b.col(12, [b.img(art("calm", "light", 2), { aspect: "21/9", frame: "none", style: { mt: "l" }, anim: "reveal" })]),
      ]),
      services,
      statsSection(ctx, { style: "lines" }),
      about,
      gallerySection(ctx, { images: [art("botanical", "light", 6), art("desk", "light", 7), art("calm", "light", 8), art("clinic", "light", 9)], layout: "mosaic", title: "Selected", eyebrow: "04 — Work" }),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "lines", side: true }), gallery: gallerySection(ctx, { images: [art("botanical", "light", 6), art("desk", "light", 7), art("calm", "light", 8), art("clinic", "light", 9)], layout: "mosaic" }), cta, contact: contactSection(ctx, { style: "split", title: "Contact" }) }),
  };
};

// 4. Paper: warm paper, serif body copy and side-by-side columns.
const paperV = (ctx: TemplateCtx): Recipe => {
  const { b } = ctx;
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, size: "6xl", pt: "2xl", bg: { kind: "color", color: "surface2" } });
  const services = servicesSection(ctx, { icons: ICONS, style: "grid", cols: "2", title: "What we offer", eyebrow: "Services" });
  const about = aboutSection(ctx, { title: "Our story", image: art("clinic", "light", 3), frame: "soft", aspect: "4/3", eyebrow: "About" });
  const process = processSection(ctx, { style: "timeline", title: "How it's made" });
  const cta = ctaSection(ctx, { style: "card", title: "Come and visit.", body: ctx.d.address ? ctx.d.address.replace(/\n/g, ", ") : null });
  return {
    design: { ...base, spacing: "airy", colors: { ...paper, primary: "#3a3026", accent: "#a8744f", bg: "#f5efe4", surface: "#fbf7ef", surface2: "#ebe2d0", line: "#d9ccb4" }, fonts: { heading: "lora", body: "lora", accent: "inter", mono: "dmmono" }, heading: { weight: 500, ls: "tight", lh: "snug", transform: "none", emphasis: "italic" }, radius: "soft", buttons: { style: "solid", caps: false, hover: "lift", weight: 500 } },
    header: headerBar(ctx, { navStyle: "underline", pad: "m" }),
    footer: footerColumns(ctx, { tone: "dark" }),
    home: compact([
      b.section({ id: "hero", name: "Hero", bg: { kind: "color", color: "surface2" }, layout: { pt: "2xl", pb: "2xl", width: "wide", gap: "xl", valign: "center" } }, [
        b.col(6, [b.img(art("clinic", "light", 2), { aspect: "4/5", frame: "soft", priority: true, anim: { preset: "reveal" } })], { valign: "center", r: { t: { span: 12 } } }),
        b.col(6, [
          b.eyebrow(ctx.has.areas ? ctx.d.areas![0] : "Studio & shop", { anim: "fade" }),
          b.h1(ctx.headline, { style: { size: "6xl" }, anim: { preset: "up", delay: 80 } }),
          b.lede(ctx.lede || "Well-made things for everyday life.", { style: { w: "m" } }),
          b.group([b.btn(ctx.primaryLabel, ctx.primaryHref, { size: "l" })], { gap: "s" }),
        ], { gap: "m", valign: "center", r: { t: { span: 12 } } }),
      ]),
      services,
      about,
      testimonialsSection(ctx, { style: "cards" }),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "accordion", side: true }), gallery: gallerySection(ctx, { images: [art("clinic", "light", 3), art("botanical", "light", 4), art("desk", "light", 5), art("calm", "light", 6)], layout: "grid", cols: "2", aspect: "4/3" }), cta, contact: contactSection(ctx, { style: "split", title: "Visit or write" }) }),
  };
};

// 5. Mono: monospaced labels, a hairline grid and a botanical plate.
const mono = (ctx: TemplateCtx): Recipe => {
  const { b } = ctx;
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: `/${ctx.name}`, size: "6xl", pt: "2xl", bg: { kind: "pattern", pattern: "grid", color: "line", opacity: 100, base: "bg" } });
  const services = servicesSection(ctx, { icons: ICONS, style: "numbered", cols: "3", title: "Catalogue", eyebrow: "/01" });
  const about = aboutSection(ctx, { title: "Notes on the studio", image: art("botanical", "light", 4), frame: "none", aspect: "4/5", eyebrow: "/02" });
  const process = processSection(ctx, { style: "numbered", title: "Method", eyebrow: "/03" });
  const cta = ctaSection(ctx, { style: "band", tone: "dark", title: "Order or enquire.", body: null, buttonVariant: "light" });
  return {
    design: { ...base, spacing: "regular", colors: { ...paper, accent: "#4a6b52", bg: "#fdfdfb", surface2: "#f2f3ee" }, fonts: { heading: "dmsans", body: "dmsans", accent: "dmmono", mono: "dmmono" }, heading: { weight: 500, ls: "tighter", lh: "none", transform: "none", emphasis: "accent" }, buttons: { style: "outline", caps: true, hover: "invert", weight: 500 } },
    header: headerBar(ctx, { navStyle: "minimal", pad: "m" }),
    footer: footerColumns(ctx, { tone: "dark" }),
    home: compact([
      b.section({ id: "hero", name: "Hero", bg: { kind: "pattern", pattern: "grid", color: "line", opacity: 100, base: "bg" }, layout: { pt: "xl", pb: "xl", width: "wide", gap: "l", valign: "center", minH: "75" } }, [
        b.col(7, [
          b.eyebrow("/ Studio — open by appointment", { anim: "fade" }),
          b.h1(ctx.headline, { style: { size: "7xl", lh: "none" }, anim: { preset: "up", delay: 80 } }),
          b.lede(ctx.lede || "Objects for quiet rooms.", { style: { w: "m" } }),
          b.btn(ctx.primaryLabel, ctx.primaryHref, { size: "l", icon: "arrow-up-right" }),
        ], { gap: "m", valign: "center", r: { t: { span: 12 } } }),
        b.col(5, [b.img(art("botanical", "light", 5), { aspect: "4/5", frame: "none", priority: true, caption: "Plate 01 — Botanical study", anim: { preset: "reveal", delay: 140 } })], { valign: "center", r: { t: { span: 12 } } }),
      ]),
      process,
      services,
      about,
      statsSection(ctx, { style: "lines" }),
      testimonialsSection(ctx, { style: "quote" }),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "lines", side: true }), gallery: gallerySection(ctx, { images: [art("botanical", "light", 4), art("calm", "light", 5), art("desk", "light", 6), art("clinic", "light", 7)], layout: "grid", cols: "2", aspect: "4/5" }), cta, contact: contactSection(ctx, { style: "split", title: "Contact" }) }),
  };
};

const v = (id: string, name: string, description: string, tags: string[], build: (ctx: TemplateCtx) => Recipe): VariationDef => ({ id, name, description, tags, build });

export const minimal: FamilyDef = {
  id: "minimal",
  name: "Elegant Minimal",
  tagline: "Beautiful whitespace, refined detail, one picture at a time.",
  description: "For makers, studios and small brands: very little on the page, all of it considered.",
  industries: ["other", "ecommerce"],
  tags: ["minimal", "quiet", "whitespace"],
  sample: SAMPLES.minimal,
  variations: [
    v("quiet", "Quiet", "A sentence, a small picture and a lot of white.", ["light", "text-led", "airy"], quiet),
    v("frame", "Frame", "Centred, with a single wide picture in a thin offset frame.", ["light", "centred", "framed"], frame),
    v("index", "Index", "A numbered, table-like layout where the type does the work.", ["light", "typographic", "grid"], index),
    v("paper", "Paper", "Warm paper, serif body text and side-by-side columns.", ["light", "warm", "serif"], paperV),
    v("mono", "Mono", "Monospaced labels over a hairline grid, with a botanical plate.", ["light", "technical", "grid"], mono),
  ],
};
