// Modern technology: strong type, gradient meshes, glass cards, bento grids and a little engineering detail.
import { art } from "../../build";
import type { Design, ElementNode } from "../../doc";
import {
  aboutSection, contactSection, ctaSection, faqSection, gallerySection, heroCentered, heroSplit, introSection, logosStrip, pageTitle, pricingSection, processSection, servicesSection, statsSection, teamSection, testimonialsSection, wordBand,
} from "../blocks";
import { footerBig, footerColumns, footerMinimal, headerBar, headerFloating, headerMinimal } from "../chrome";
import { compact, innerPages } from "../pages";
import { SAMPLES } from "../samples";
import type { FamilyDef, Recipe, TemplateCtx, VariationDef } from "../types";

const ICONS = ["zap", "layers", "cpu", "lock", "chart", "globe"];
const base: Partial<Design> = { scale: "grand", spacing: "regular", motion: "smooth" };
const NAMES = ["Northwind", "Acme & Co", "Helio", "Brightpath", "Orbital", "Kestrel"];

const dark = { primary: "#7c83ff", accent: "#35d0ba", bg: "#080a14", surface: "#10142a", surface2: "#171c38", ink: "#eef0fb", muted: "#9aa1c2", line: "#242a4d", dark: "#05060d" };
const light = { primary: "#4f46e5", accent: "#0ea5a4", bg: "#fbfbfe", surface: "#ffffff", surface2: "#f1f2fa", ink: "#0f1226", muted: "#565b7a", line: "#e1e3f2", dark: "#0b0e22" };

/** A small "product" made of cards, so a hero can show what the software feels like without a screenshot. */
function productCards(ctx: TemplateCtx, kind: "dashboard" | "inbox" | "terminal"): ElementNode[] {
  const { b } = ctx;
  if (kind === "terminal") {
    return [b.card([
      b.group([b.badge("live", { variant: "dot" }), b.small("lattice — workspace")], { gap: "xs" }),
      b.el("list", { items: ["12 new messages routed", "3 appointments confirmed", "Reminder sent to 24 customers", "Follow-up queued for 09:00"], style: "check", cols: "1" }, { style: { font: "mono", size: "s" } }),
    ], { surface: "glass", pad: "m", gap: "s" })];
  }
  const stat = (value: string, label: string) => b.card([b.el("stats", { style: "row", items: [{ value, prefix: "", suffix: "", label }], countUp: false })], { surface: "glass", pad: "m", gap: "xs" });
  return [
    b.card([
      b.group([b.badge("Today", { variant: "outline" }), b.small("Team overview")], { gap: "xs" }),
      b.group([stat("128", "Messages answered"), stat("31", "Bookings made"), stat("2.4m", "Average reply")], { gap: "s", wrap: true }),
      b.el("marquee", { items: ["Inbox", "Scheduling", "Reminders", "Billing"], speed: "slow", style: "badge" }),
    ], { surface: "glass", pad: "m", gap: "s" }),
  ];
}

// 1. Nova: a dark mesh, a centred promise and a glass dashboard.
const nova = (ctx: TemplateCtx): Recipe => {
  const { b } = ctx;
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, align: "center", size: "7xl", pt: "3xl", bg: { kind: "mesh", colors: ["primary", "accent"], seed: 3, base: "bg" } });
  const services = servicesSection(ctx, { icons: ICONS, style: "bento", title: "One workspace. Every customer touchpoint.", eyebrow: "Platform", align: "center" });
  const about = aboutSection(ctx, { title: "Built by people who ran service businesses", image: art("grid3d", "dark", 2), frame: "soft", aspect: "4/3" });
  const process = processSection(ctx, { style: "cards", title: "Live in a day", align: "center" });
  const cta = ctaSection(ctx, { style: "card", title: "See it with your own customers.", body: "A short walkthrough, tailored to how you work." });
  return {
    design: { ...base, mode: "dark", colors: dark, fonts: { heading: "sora", body: "inter", accent: "jetbrains", mono: "jetbrains" }, heading: { weight: 600, ls: "tighter", lh: "tight", transform: "none", emphasis: "accent" }, radius: "round", buttons: { style: "gradient", caps: false, hover: "shine", weight: 600 }, grain: true },
    header: headerFloating(ctx, { tone: "dark", navStyle: "pills", bg: { kind: "color", color: "surface" } }),
    footer: footerBig(ctx, { tone: "dark" }),
    home: compact([
      heroCentered(ctx, {
        badge: "New: automations for appointments", size: "7xl", pt: "3xl", pb: "l", tone: "dark", bg: { kind: "mesh", colors: ["primary", "accent", "primary"], seed: 5, base: "bg" }, ctaVariant: ["primary", "outline"],
        below: productCards(ctx, "dashboard").map((c) => ({ ...c, style: { mt: "l" }, anim: { preset: "up" as const, delay: 300, speed: "normal" as const, stagger: false } })),
        decor: [{ kind: "grid", at: "c", size: "xl", color: "line", opacity: 40 }],
      }),
      logosStrip(ctx, { names: NAMES, style: "marquee", tone: "dark" }),
      services,
      statsSection(ctx, { style: "cards", head: true, title: "Results teams see in the first month", eyebrow: "Impact", align: "center" }),
      processSection(ctx, { style: "line", title: "From connect to live in a day", align: "center" }),
      pricingSection(ctx, {}),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "cards", align: "center" }), gallery: gallerySection(ctx, { images: [art("grid3d", "dark", 1), art("mesh", "dark", 2), art("rings", "dark", 3), art("waves", "dark", 4)], layout: "grid", cols: "2", aspect: "16/10" }), cta, contact: contactSection(ctx, { style: "split", title: "Talk to us", purpose: "consultation" }) }),
  };
};

// 2. Lattice: light, a dotted grid, a split hero with product cards and a bento of features.
const lattice = (ctx: TemplateCtx): Recipe => {
  const { b } = ctx;
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, size: "7xl", pt: "3xl", bg: { kind: "pattern", pattern: "dots", color: "line", opacity: 100, base: "bg" } });
  const services = servicesSection(ctx, { icons: ICONS, style: "bento", title: "Everything in one calm place", eyebrow: "Features", layout: "stacked" });
  const about = aboutSection(ctx, { title: "A small team that listens", image: art("mesh", "light", 4), frame: "soft", aspect: "4/3", reverse: true });
  const process = processSection(ctx, { style: "timeline", title: "Getting started" });
  const cta = ctaSection(ctx, { style: "band", tone: "dark", title: "Start with one team.", body: "Switch on a pilot, see the difference, then roll it out.", buttonVariant: "primary" });
  return {
    design: { ...base, colors: light, fonts: { heading: "grotesk", body: "inter", accent: "jetbrains", mono: "jetbrains" }, heading: { weight: 600, ls: "tighter", lh: "tight", transform: "none", emphasis: "accent" }, radius: "soft", buttons: { style: "solid", caps: false, hover: "lift", weight: 600 } },
    header: headerBar(ctx, { navStyle: "links", sticky: true, bg: { kind: "color", color: "bg" } }),
    footer: footerColumns(ctx, { tone: "dark" }),
    home: compact([
      heroSplit(ctx, {
        eyebrow: "Workspace for service teams", size: "6xl", textSpan: 6, pt: "2xl", bg: { kind: "pattern", pattern: "dots", color: "line", opacity: 100, base: "bg" }, ctaVariant: ["primary", "outline"],
        rightElements: productCards(ctx, "dashboard"), decor: [{ kind: "orb", at: "tr", size: "l", color: "primary", opacity: 22 }],
      }),
      logosStrip(ctx, { names: NAMES, style: "row" }),
      services,
      statsSection(ctx, { style: "big", head: true, title: "Numbers that move", eyebrow: "Results" }),
      processSection(ctx, { style: "timeline", title: "Getting started" }),
      testimonialsSection(ctx, { style: "cards" }),
      pricingSection(ctx, {}),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "accordion", side: true }), gallery: gallerySection(ctx, { images: [art("mesh", "light", 1), art("waves", "light", 2), art("rings", "light", 3), art("grid3d", "light", 4)], layout: "mosaic" }), cta, contact: contactSection(ctx, { style: "split", title: "Talk to us", purpose: "consultation" }) }),
  };
};

// 3. Vector: a split hero over a gradient, with a terminal card and a stack of numbers.
const vector = (ctx: TemplateCtx): Recipe => {
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, size: "7xl", pt: "2xl", tone: "dark", bg: { kind: "gradient", from: "dark", to: "primary", angle: 150 } });
  const services = servicesSection(ctx, { icons: ICONS, style: "rows", title: "What it does", eyebrow: "Capabilities", layout: "side" });
  const about = aboutSection(ctx, { title: "Engineered for calm", image: art("rings", "dark", 5), frame: "soft", aspect: "4/3" });
  const process = processSection(ctx, { style: "vertical", title: "Rollout", side: true });
  const cta = ctaSection(ctx, { style: "split", tone: "dark", title: "Ready to simplify the week?", body: null, buttonVariant: "accent" });
  return {
    design: { ...base, mode: "dark", colors: { ...dark, primary: "#4c6fff", accent: "#6ee7b7", bg: "#070b1a", surface: "#0e1430", surface2: "#151d44", dark: "#050816" }, fonts: { heading: "grotesk", body: "inter", accent: "dmmono", mono: "dmmono" }, heading: { weight: 700, ls: "tight", lh: "tight", transform: "none", emphasis: "accent" }, radius: "soft", buttons: { style: "solid", caps: false, hover: "lift", weight: 600 } },
    header: headerMinimal(ctx, { tone: "dark", navStyle: "minimal" }),
    footer: footerMinimal(ctx, { tone: "dark" }),
    home: compact([
      heroSplit(ctx, {
        tone: "dark", eyebrow: "Operating system for service teams", size: "7xl", textSpan: 7, pt: "2xl", minH: "90", bg: { kind: "gradient", from: "bg", to: "primary", angle: 160 }, ctaVariant: ["accent", "outline"],
        rightElements: productCards(ctx, "terminal"), badges: ["Inbox", "Calendar", "Billing"],
        decor: [{ kind: "ring", at: "br", size: "l", color: "accent", opacity: 18 }],
      }),
      logosStrip(ctx, { names: NAMES, style: "grid", tone: "dark" }),
      services,
      statsSection(ctx, { style: "lines", tone: "dark" }),
      gallerySection(ctx, { images: [art("grid3d", "dark", 5), art("rings", "dark", 6), art("mesh", "dark", 7)], layout: "strip", aspect: "16/10", title: "A closer look", eyebrow: "Product", width: "full" }),
      testimonialsSection(ctx, { style: "quote" }),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "lines", side: true }), gallery: gallerySection(ctx, { images: [art("grid3d", "dark", 5), art("rings", "dark", 6), art("mesh", "dark", 7), art("waves", "dark", 8)], layout: "grid", cols: "2" }), cta, contact: contactSection(ctx, { style: "split", title: "Request a demo", purpose: "consultation" }) }),
  };
};

// 4. Signal: a bright gradient, an integrations marquee and loud pricing.
const signal = (ctx: TemplateCtx): Recipe => {
  const { b } = ctx;
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, align: "center", size: "7xl", pt: "3xl", tone: "dark", bg: { kind: "gradient", from: "primary", via: "accent", to: "dark", angle: 140 } });
  const services = servicesSection(ctx, { icons: ICONS, style: "iconCards", title: "Features that earn their place", eyebrow: "Product", align: "center" });
  const about = aboutSection(ctx, { title: "Made for busy teams", image: art("shapes", "dark", 2), frame: "soft", aspect: "1/1" });
  const process = processSection(ctx, { style: "numbered", title: "Three steps", align: "center" });
  const cta = ctaSection(ctx, { style: "image", title: "Ready in a day, loved for years.", body: null, image: art("mesh", "dark", 8), buttonVariant: "light" });
  return {
    design: { ...base, spacing: "regular", scale: "display", colors: { ...light, primary: "#6d28d9", accent: "#f472b6", dark: "#14072e" }, fonts: { heading: "urbanist", body: "inter", accent: "jetbrains", mono: "jetbrains" }, heading: { weight: 700, ls: "tighter", lh: "none", transform: "none", emphasis: "both" }, radius: "round", buttons: { style: "gradient", caps: false, hover: "shine", weight: 700 } },
    header: headerBar(ctx, { navStyle: "pills", pad: "s" }),
    footer: footerBig(ctx, { tone: "dark" }),
    home: compact([
      heroCentered(ctx, {
        badge: "Now with smart scheduling", size: "8xl", pt: "2xl", pb: "l", tone: "dark", bg: { kind: "gradient", from: "primary", via: "accent", to: "dark", angle: 140 }, ctaVariant: ["light", "outline"],
        below: [ctx.b.img(art("mesh", "dark", 11), { aspect: "21/9", frame: "soft", style: { mt: "l" }, anim: "reveal" })],
        decor: [{ kind: "orb", at: "tl", size: "l", color: "accent", opacity: 40 }],
      }),
      wordBand(ctx, { style: "text", size: "5xl", words: ["Inbox", "Calendar", "Reminders", "Invoices", "Reports"], speed: "normal" }),
      services,
      statsSection(ctx, { style: "big" }),
      processSection(ctx, { style: "numbered", title: "Three steps", align: "center" }),
      testimonialsSection(ctx, { style: "wall" }),
      pricingSection(ctx, {}),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "cards", align: "center" }), gallery: gallerySection(ctx, { images: [art("mesh", "dark", 1), art("shapes", "dark", 2), art("rings", "dark", 3), art("waves", "dark", 4)], layout: "masonry", cols: "2" }), cta, contact: contactSection(ctx, { style: "stacked", title: "Say hello", purpose: "consultation" }) }),
  };
};

// 5. Orbit: rings and a timeline, text on the left with a large graphic on the right.
const orbit = (ctx: TemplateCtx): Recipe => {
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, size: "7xl", pt: "2xl", tone: "dark", bg: { kind: "image", src: art("rings", "dark", 3), overlay: { color: "dark", opacity: 30, dir: "flat" }, pos: { x: 50, y: 50 }, parallax: false } });
  const services = servicesSection(ctx, { icons: ICONS, style: "numbered", cols: "3", title: "The toolkit", eyebrow: "What's inside" });
  const about = aboutSection(ctx, { title: "A team in orbit around your customers", image: art("rings", "dark", 6), frame: "circle", aspect: "1/1", reverse: true });
  const process = processSection(ctx, { style: "timeline", title: "How adoption works" });
  const cta = ctaSection(ctx, { style: "image", title: "Put your customers at the centre.", body: null, image: art("rings", "dark", 9), buttonVariant: "primary" });
  return {
    design: { ...base, mode: "dark", colors: { ...dark, primary: "#8b5cf6", accent: "#22d3ee", bg: "#06070f" }, fonts: { heading: "outfit", body: "inter", accent: "jetbrains", mono: "jetbrains" }, heading: { weight: 600, ls: "tight", lh: "tight", transform: "none", emphasis: "accent" }, radius: "round", buttons: { style: "solid", caps: false, hover: "lift", weight: 600 } },
    header: headerBar(ctx, { tone: "dark", navStyle: "underline", pad: "s" }),
    footer: footerColumns(ctx, { tone: "dark" }),
    home: compact([
      heroSplit(ctx, {
        tone: "dark", eyebrow: "Customer operations", size: "7xl", textSpan: 6, minH: "90", pt: "2xl", bg: { kind: "image", src: art("rings", "dark", 2), overlay: { color: "dark", opacity: 20, dir: "left" }, pos: { x: 80, y: 50 }, parallax: false }, ctaVariant: ["primary", "outline"],
        rightElements: [], badges: ["Inbox", "Scheduling", "Billing"],
      }),
      introSection(ctx, { layout: "statement", title: "Every conversation, booking and payment in one orbit.", body: ctx.lede, size: "5xl" }),
      services,
      processSection(ctx, { style: "timeline", title: "How adoption works" }),
      statsSection(ctx, { style: "row", tone: "dark" }),
      teamSection(ctx, { style: "circles", cols: "3", tone: "dark", align: "center" }),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "columns", align: "center" }), gallery: gallerySection(ctx, { images: [art("rings", "dark", 1), art("grid3d", "dark", 2), art("mesh", "dark", 3), art("waves", "dark", 4)], layout: "grid", cols: "2" }), cta, contact: contactSection(ctx, { style: "split", title: "Talk to us", purpose: "consultation" }) }),
  };
};

const v = (id: string, name: string, description: string, tags: string[], build: (ctx: TemplateCtx) => Recipe): VariationDef => ({ id, name, description, tags, build });

export const tech: FamilyDef = {
  id: "tech",
  name: "Modern Technology",
  tagline: "Strong type, sophisticated gradients, layered cards.",
  description: "For software, platforms and technical services: dark meshes, glass panels, bento grids and subtle engineering detail.",
  industries: ["agency"],
  tags: ["technology", "gradient", "modern"],
  sample: SAMPLES.tech,
  variations: [
    v("nova", "Nova", "A dark mesh, a centred promise and a glass dashboard.", ["dark", "gradient", "centred"], nova),
    v("lattice", "Lattice", "Light with a dotted grid, a split hero and a bento of features.", ["light", "grid", "bento"], lattice),
    v("vector", "Vector", "A split hero over a blue gradient, with a terminal-style card.", ["dark", "split", "technical"], vector),
    v("signal", "Signal", "A bright gradient, an integrations marquee and bold pricing.", ["light", "colourful", "bold"], signal),
    v("orbit", "Orbit", "Concentric rings and a timeline, with the graphic given room.", ["dark", "rings", "split"], orbit),
  ],
};
