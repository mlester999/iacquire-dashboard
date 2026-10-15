// Professional corporate: credible, structured and calm. A strong grid, clear hierarchy, evidence in plain sight.
import { art } from "../../build";
import type { Design } from "../../doc";
import {
  aboutSection, areasSection, contactSection, ctaSection, faqSection, gallerySection, heroFull, heroSplit, introSection, logosStrip, pageTitle, processSection, servicesSection, statsSection, teamSection, testimonialsSection,
} from "../blocks";
import { footerCentered, footerColumns, headerBar, headerCentered, headerSplit } from "../chrome";
import { compact, innerPages } from "../pages";
import { SAMPLES } from "../samples";
import type { FamilyDef, Recipe, TemplateCtx, VariationDef } from "../types";

const ICONS = ["briefcase", "scale", "shield", "chart", "file-text", "handshake"];
const base: Partial<Design> = { scale: "regular", spacing: "regular", motion: "subtle" };
const NAMES = ["Harlow Group", "Brightwater", "Calder & Sons", "Northgate", "Pemberton", "Vale Capital"];

const navy = { primary: "#12355b", accent: "#c8963e", bg: "#f6f8fb", surface: "#ffffff", surface2: "#e9eef5", ink: "#0f1c2e", muted: "#4a5a70", line: "#d5deea", dark: "#0b2239" };

// 1. Charter: a split hero with the key points, a stats band and a clean services grid.
const charter = (ctx: TemplateCtx): Recipe => {
  const { b } = ctx;
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, size: "6xl", pt: "2xl", tone: "dark", bg: { kind: "gradient", from: "dark", to: "primary", angle: 150 } });
  const services = servicesSection(ctx, { icons: ICONS, style: "grid", cols: "3", title: "How we can help", eyebrow: "Services", align: "start" });
  const about = aboutSection(ctx, { title: "A partnership you can rely on", image: art("facade", "cool", 2), frame: "soft", aspect: "4/5", eyebrow: "About the firm" });
  const process = processSection(ctx, { style: "timeline", title: "How an engagement works" });
  const cta = ctaSection(ctx, { style: "band", title: "Speak to a partner.", body: "A short, no-obligation conversation to see how we can help." });
  return {
    design: { ...base, colors: navy, fonts: { heading: "newsreader", body: "inter", accent: "inter", mono: "jetbrains" }, heading: { weight: 500, ls: "tight", lh: "tight", transform: "none", emphasis: "italic" }, radius: "soft", buttons: { style: "solid", caps: false, hover: "lift", weight: 600 } },
    header: headerBar(ctx, { navStyle: "underline", sticky: true, bg: { kind: "color", color: "surface" } }),
    footer: footerColumns(ctx, { tone: "dark" }),
    home: compact([
      heroSplit(ctx, {
        eyebrow: ctx.has.areas ? `Advisers across ${ctx.d.areas![0]}` : "Independent advisers", size: "6xl", textSpan: 7, image: art("facade", "cool", 1), aspect: "4/5", frame: "soft", pt: "2xl", pb: "xl",
        bg: { kind: "gradient", from: "bg", to: "surface2", angle: 160 }, ctaVariant: ["primary", "outline"], after: ctx.has.highlights ? [b.list(ctx.d.highlights!.slice(0, 3), { style: { mt: "s" } })] : [],
      }),
      logosStrip(ctx, { names: NAMES, style: "row", label: "Trusted by owner-managed businesses (sample names)" }),
      statsSection(ctx, { style: "cards", tone: "light" }),
      services,
      aboutSection(ctx, { title: "A partnership you can rely on", image: art("skyline", "cool", 2), frame: "soft", aspect: "4/3", reverse: true, eyebrow: "About the firm" }),
      processSection(ctx, { style: "timeline", title: "How an engagement works" }),
      testimonialsSection(ctx, { style: "cards" }),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "accordion", side: true }), gallery: gallerySection(ctx, { images: [art("facade", "cool", 1), art("skyline", "cool", 2), art("cityblocks", "light", 3), art("mountains", "cool", 4)], layout: "grid", cols: "2", aspect: "16/10" }), cta, contact: contactSection(ctx, { style: "split", title: "Contact the firm", purpose: "consultation" }) }),
  };
};

// 2. Summit: a dark navy full-bleed hero with the credentials overlaid.
const summit = (ctx: TemplateCtx): Recipe => {
  const { b } = ctx;
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, size: "7xl", pt: "3xl", tone: "dark", image: art("skyline", "dark", 3) });
  const services = servicesSection(ctx, { icons: ICONS, style: "iconCards", cols: "3", title: "Areas of practice", eyebrow: "What we do" });
  const about = aboutSection(ctx, { title: "Experience that shows", image: art("skyline", "cool", 4), frame: "none", aspect: "4/3" });
  const process = processSection(ctx, { style: "cards", title: "Our approach", align: "center" });
  const cta = ctaSection(ctx, { style: "image", title: "Let's discuss your situation.", body: null, image: art("skyline", "dark", 5), eyebrow: "Get in touch" });
  return {
    design: { ...base, colors: { ...navy, primary: "#1a4f8a", bg: "#f5f7fa" }, fonts: { heading: "playfair", body: "inter", accent: "inter", mono: "jetbrains" }, heading: { weight: 600, ls: "tight", lh: "tight", transform: "none", emphasis: "italic" }, radius: "square", buttons: { style: "solid", caps: true, hover: "invert", weight: 600 } },
    header: headerBar(ctx, { tone: "dark", float: true, navStyle: "minimal", pad: "m" }),
    footer: footerColumns(ctx, { tone: "dark" }),
    home: compact([
      heroFull(ctx, { image: art("skyline", "dark", 1), eyebrow: ctx.has.areas ? `${ctx.d.areas![0]} · Established practice` : "Established practice", size: "7xl", overlay: { opacity: 62, dir: "left" }, align: "start", valign: "center", ctaVariant: ["primary", "outline"], minH: "90",
        after: ctx.has.stats ? [b.el("stats", { style: "lines", items: ctx.d.stats!.slice(0, 3).map((s) => ({ value: s.value, prefix: "", suffix: s.suffix ?? "", label: s.label })), countUp: false }, { style: { mt: "l" } })] : [] }),
      introSection(ctx, { layout: "two", eyebrow: "The firm", title: "Considered advice, delivered personally.", size: "4xl" }),
      services,
      teamSection(ctx, { style: "cards", cols: "3" }),
      testimonialsSection(ctx, { style: "quote", tone: "dark" }),
      processSection(ctx, { style: "cards", title: "Our approach", align: "center" }),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "cards", align: "center" }), gallery: gallerySection(ctx, { images: [art("skyline", "cool", 1), art("facade", "cool", 2), art("cityblocks", "light", 3), art("mountains", "cool", 4)], layout: "masonry", cols: "2" }), cta, contact: contactSection(ctx, { style: "split", title: "Arrange a consultation", purpose: "consultation" }) }),
  };
};

// 3. Ledger: left-aligned and orderly, with a sidebar contact card.
const ledger = (ctx: TemplateCtx): Recipe => {
  const { b } = ctx;
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, size: "6xl", pt: "2xl", bg: { kind: "color", color: "surface2" } });
  const services = servicesSection(ctx, { icons: ICONS, style: "rows", layout: "side", title: "Practice areas", eyebrow: "Services" });
  const about = aboutSection(ctx, { title: "Our principles", image: art("facade", "light", 3), frame: "none", aspect: "4/3", eyebrow: "About" });
  const process = processSection(ctx, { style: "vertical", side: true, title: "What to expect" });
  const cta = ctaSection(ctx, { style: "split", tone: "dark", title: "Book an introductory call.", body: null, buttonVariant: "accent" });
  return {
    design: { ...base, colors: { ...navy, primary: "#244a6d", accent: "#b9893d", bg: "#ffffff", surface: "#ffffff", surface2: "#f1f4f8" }, fonts: { heading: "lora", body: "inter", accent: "inter", mono: "jetbrains" }, heading: { weight: 600, ls: "tight", lh: "tight", transform: "none", emphasis: "italic" }, radius: "square", buttons: { style: "solid", caps: false, hover: "lift", weight: 600 } },
    header: headerBar(ctx, { navStyle: "links", pad: "m" }),
    footer: footerColumns(ctx, { tone: "dark" }),
    home: compact([
      b.section({ id: "hero", name: "Hero", bg: { kind: "color", color: "surface2" }, layout: { pt: "2xl", pb: "2xl", width: "wide", gap: "xl", valign: "center" } }, [
        b.col(8, [
          b.eyebrow(ctx.has.areas ? `Serving ${ctx.d.areas!.slice(0, 2).join(" and ")}` : "Professional advisers", { anim: "fade" }),
          b.h1(ctx.headline, { style: { size: "6xl" }, anim: { preset: "up", delay: 80 } }),
          b.lede(ctx.lede || "Clear, practical advice from a small team.", { style: { w: "m" } }),
          b.group([b.btn(ctx.primaryLabel, ctx.primaryHref, { size: "l", icon: "arrow-right" })], { gap: "s" }),
        ], { gap: "m", valign: "center", r: { t: { span: 12 } } }),
        b.col(4, [b.card([
          b.eyebrow("Contact the firm"),
          b.el("contactInfo", { phone: true, email: true, address: false, hours: true, layout: "stack" }),
          b.btn("Request a call back", "/contact", { variant: "primary", full: true }),
        ], { surface: "elevated", pad: "m", gap: "m" })], { valign: "center", r: { t: { span: 12 } } }),
      ]),
      statsSection(ctx, { style: "lines" }),
      services,
      about,
      teamSection(ctx, { style: "minimal", cols: "3" }),
      testimonialsSection(ctx, { style: "quote" }),
      areasSection(ctx, {}),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "accordion", side: true }), gallery: gallerySection(ctx, { images: [art("facade", "light", 3), art("skyline", "light", 2), art("cityblocks", "light", 4), art("mountains", "light", 5)], layout: "grid", cols: "2" }), cta, contact: contactSection(ctx, { style: "split", title: "Contact the firm", purpose: "consultation" }) }),
  };
};

// 4. Atlas: a wide landscape band, a centred promise and three pillars.
const atlas = (ctx: TemplateCtx): Recipe => {
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, align: "center", size: "6xl", pt: "2xl", tone: "dark", image: art("mountains", "cool", 3) });
  const services = servicesSection(ctx, { icons: ICONS, style: "iconCards", cols: "3", title: "Three pillars of the practice", eyebrow: "What we do", align: "center" });
  const about = aboutSection(ctx, { title: "Perspective, not just process", image: art("mountains", "light", 2), frame: "soft", aspect: "4/3", reverse: true });
  const process = processSection(ctx, { style: "line", title: "How we work with you", align: "center" });
  const cta = ctaSection(ctx, { style: "card", title: "Take the first step.", body: "A confidential conversation, with no obligation." });
  return {
    design: { ...base, colors: { ...navy, primary: "#1d4d4f", accent: "#d19a4a", bg: "#f7f8f6", surface2: "#e8eeea", dark: "#0d2a2b" }, fonts: { heading: "fraunces", body: "hanken", accent: "hanken", mono: "jetbrains" }, heading: { weight: 400, ls: "tight", lh: "tight", transform: "none", emphasis: "italic" }, radius: "soft", buttons: { style: "solid", caps: false, hover: "lift", weight: 600 } },
    header: headerCentered(ctx, { navStyle: "underline" }),
    footer: footerCentered(ctx, { tone: "dark" }),
    home: compact([
      heroFull(ctx, { image: art("mountains", "cool", 1), tone: "dark", align: "center", valign: "center", size: "6xl", eyebrow: ctx.has.areas ? ctx.d.areas!.slice(0, 3).join(" · ") : "Advisory practice", overlay: { opacity: 38, dir: "flat" }, minH: "75", ctaVariant: ["primary", "outline"], pt: "3xl", headingStyle: { w: "l" } }),
      services,
      statsSection(ctx, { style: "lines", tone: "dark" }),
      aboutSection(ctx, { title: "Perspective, not just process", image: art("mountains", "light", 2), frame: "soft", aspect: "4/3", reverse: true }),
      teamSection(ctx, { style: "circles", cols: "3", align: "center" }),
      testimonialsSection(ctx, { style: "cards" }),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "cards", align: "center" }), gallery: gallerySection(ctx, { images: [art("mountains", "cool", 1), art("mountains", "light", 2), art("skyline", "cool", 3), art("facade", "cool", 4)], layout: "grid", cols: "2", aspect: "16/10" }), cta, contact: contactSection(ctx, { style: "stacked", title: "Begin a conversation", purpose: "consultation" }) }),
  };
};

// 5. Forum: editorial, with a credentials list and quiet, bookish detail.
const forum = (ctx: TemplateCtx): Recipe => {
  const { b } = ctx;
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, align: "center", size: "7xl", pt: "2xl" });
  const services = servicesSection(ctx, { icons: ICONS, style: "numbered", cols: "2", title: "What we advise on", eyebrow: "Services" });
  const about = aboutSection(ctx, { title: "A firm with a long memory", image: art("townhouse", "light", 3), frame: "none", aspect: "3/4", eyebrow: "Our story" });
  const process = processSection(ctx, { style: "numbered", title: "How we work" });
  const cta = ctaSection(ctx, { style: "minimal", title: "Write to us, or call.", buttonVariant: "ghost" });
  return {
    design: { ...base, spacing: "airy", colors: { ...navy, primary: "#5a1f2b", accent: "#b9893d", bg: "#f8f4ec", surface: "#fdfaf3", surface2: "#eee6d6", ink: "#1f1a16", muted: "#5b5249", line: "#d9cdb6", dark: "#1f1a16" }, fonts: { heading: "playfair", body: "lora", accent: "inter", mono: "jetbrains" }, heading: { weight: 600, ls: "tight", lh: "tight", transform: "none", emphasis: "italic" }, radius: "square", buttons: { style: "outline", caps: true, hover: "invert", weight: 500 } },
    header: headerSplit(ctx, { navStyle: "minimal", pad: "m" }),
    footer: footerCentered(ctx, { tone: "dark" }),
    home: compact([
      b.section({ id: "hero", name: "Hero", layout: { pt: "2xl", pb: "xl", width: "wide", gap: "xl", valign: "center" } }, [
        b.col(7, [
          b.eyebrow(ctx.has.areas ? ctx.d.areas!.slice(0, 2).join(" · ") : "Est. in practice", { anim: "fade" }),
          b.h1(ctx.headline, { style: { size: "7xl", lh: "none" }, anim: { preset: "up", delay: 80 } }),
          b.lede(ctx.lede || "Advice that ages well.", { style: { w: "m" } }),
          b.group([b.btn(ctx.primaryLabel, ctx.primaryHref, { size: "l", variant: "primary", icon: "arrow-right" })], { gap: "s" }),
        ], { gap: "m", valign: "center", r: { t: { span: 12 } } }),
        b.col(5, [b.img(art("townhouse", "light", 4), { aspect: "3/4", frame: "none", caption: "Our offices", priority: true, anim: { preset: "reveal", delay: 140 } })], { valign: "center", r: { t: { span: 12 } } }),
      ]),
      b.section({ id: "cred", name: "Credentials", tone: "dark", layout: { pt: "l", pb: "l", width: "wide", gap: "l" } }, [
        b.col(12, [b.el("list", { items: ctx.has.highlights ? ctx.d.highlights! : ctx.d.services.slice(0, 3).map((s) => s.title), style: "dash", cols: "3" })]),
      ]),
      services,
      about,
      teamSection(ctx, { style: "circles", cols: "3" }),
      testimonialsSection(ctx, { style: "quote" }),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "lines", align: "center" }), gallery: gallerySection(ctx, { images: [art("townhouse", "light", 3), art("facade", "light", 2), art("skyline", "light", 4), art("garden", "light", 5)], layout: "grid", cols: "2", aspect: "3/4" }), cta, contact: contactSection(ctx, { style: "split", title: "Contact the firm", purpose: "consultation" }) }),
  };
};

const v = (id: string, name: string, description: string, tags: string[], build: (ctx: TemplateCtx) => Recipe): VariationDef => ({ id, name, description, tags, build });

export const corp: FamilyDef = {
  id: "corp",
  name: "Professional Corporate",
  tagline: "Clear credibility and structured information.",
  description: "For advisers, firms and established businesses: strong grids, evidence in plain sight and a calm, authoritative tone.",
  industries: ["legal_finance", "consulting"],
  tags: ["corporate", "trust", "structured"],
  sample: SAMPLES.corp,
  variations: [
    v("charter", "Charter", "A split hero with the key points, a stats band and a clean services grid.", ["light", "split", "navy"], charter),
    v("summit", "Summit", "A full-bleed skyline with the credentials laid over it.", ["dark", "photographic", "navy"], summit),
    v("ledger", "Ledger", "Orderly and left-aligned, with a sidebar contact card.", ["light", "structured", "sidebar"], ledger),
    v("atlas", "Atlas", "A wide landscape, a centred promise and three pillars.", ["light", "centred", "calm"], atlas),
    v("forum", "Forum", "Editorial and bookish, with a credentials list and circular portraits.", ["light", "editorial", "serif"], forum),
  ],
};
