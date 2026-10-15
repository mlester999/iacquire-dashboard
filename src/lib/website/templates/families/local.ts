// Local services: built to turn a visit into a phone call or an enquiry. The way to get in touch is always within reach.
import { art } from "../../build";
import type { Design, ElementNode } from "../../doc";
import {
  aboutSection, areasSection, badgeRow, contactSection, ctaSection, faqSection, gallerySection, heroFull, heroSplit, introSection, pageTitle, processSection, servicesSection, statsSection, testimonialsSection, wordBand,
} from "../blocks";
import { footerCentered, footerColumns, headerBar, headerCentered, headerFloating } from "../chrome";
import { compact, innerPages } from "../pages";
import { SAMPLES } from "../samples";
import type { FamilyDef, Recipe, TemplateCtx, VariationDef } from "../types";

const ICONS = ["wrench", "droplets", "hammer", "zap", "home", "clock"];
const base: Partial<Design> = { scale: "regular", spacing: "regular", motion: "smooth" };

/** An enquiry card that sits in a hero, so a visitor can reach out without scrolling. */
function quickForm(ctx: TemplateCtx, title = "Get a free quote"): ElementNode[] {
  const { b } = ctx;
  return [b.card([
    b.heading(title, { level: 3, style: { size: "2xl" } }),
    b.small("Tell us what you need and we'll call you back, usually the same day."),
    b.el("form", { purpose: "lead", submitLabel: ctx.action === "book" ? "Request appointment" : "Request my quote", layout: "plain", phone: "optional", message: "optional", service: ctx.d.services.length >= 2 ? "optional" : "hidden", services: ctx.d.services.slice(0, 12).map((s) => s.title.slice(0, 60)), helper: "" }),
  ], { surface: "elevated", pad: "m", gap: "s" })];
}

const callBar = (ctx: TemplateCtx) => (ctx.phoneLink ? [ctx.b.btn(ctx.phoneLink.label, ctx.phoneLink.href, { variant: "light", size: "l", icon: "phone" })] : []);

// 1. Corner: a split hero with the quote form on the right, trust points under the headline.
const corner = (ctx: TemplateCtx): Recipe => {
  const { b } = ctx;
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, size: "6xl", pt: "2xl", bg: { kind: "color", color: "primarySoft" } });
  const services = servicesSection(ctx, { icons: ICONS, style: "iconCards", cols: "3", title: "What we do", eyebrow: "Services", align: "center" });
  const about = aboutSection(ctx, { title: "Local, honest and easy to deal with", image: art("neighborhood", "light", 3), frame: "soft", aspect: "4/3" });
  const process = processSection(ctx, { style: "cards", title: "How it works", align: "center" });
  const cta = ctaSection(ctx, { style: "band", tone: "brand", title: ctx.action === "call" ? "Need help? Call now." : "Ready to get started?", body: "Free, clear quotes. No pressure." });
  return {
    design: { ...base, colors: { primary: "#0b5fff", accent: "#ff8a1f", bg: "#f7f9fc", surface: "#ffffff", surface2: "#e8eef8", ink: "#0f1b33", muted: "#4a5873", line: "#d5def0", dark: "#0b1f4d" }, fonts: { heading: "figtree", body: "figtree", accent: "figtree", mono: "jetbrains" }, heading: { weight: 800, ls: "tight", lh: "tight", transform: "none", emphasis: "accent" }, radius: "round", buttons: { style: "solid", caps: false, hover: "lift", weight: 700 } },
    header: headerBar(ctx, { navStyle: "links", sticky: true, bg: { kind: "color", color: "surface" }, ctaVariant: "accent" }),
    footer: footerColumns(ctx, { tone: "dark" }),
    home: compact([
      heroSplit(ctx, {
        eyebrow: ctx.has.areas ? `Serving ${ctx.d.areas!.slice(0, 3).join(", ")}` : "Local specialists", size: "6xl", textSpan: 7, pt: "xl", pb: "xl", bg: { kind: "color", color: "primarySoft" }, ctaVariant: ["primary", "outline"], ctas: "primary",
        rightElements: quickForm(ctx), after: [...(ctx.has.highlights ? [b.list(ctx.d.highlights!.slice(0, 3), { style: { mt: "s" } })] : [])],
        decor: [{ kind: "dots", at: "tr", size: "m", color: "primary", opacity: 30 }],
      }),
      badgeRow(ctx, { bg: { kind: "color", color: "surface" } }),
      services,
      processSection(ctx, { style: "cards", title: "How it works", align: "center" }),
      statsSection(ctx, { style: "cards" }),
      testimonialsSection(ctx, { style: "cards" }),
      areasSection(ctx, {}),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "cards", align: "center" }), gallery: gallerySection(ctx, { images: [art("workshop", "warm", 1), art("neighborhood", "light", 2), art("storefront", "warm", 3), art("townhouse", "light", 4)], layout: "grid", cols: "2", aspect: "16/10" }), cta, contact: contactSection(ctx, { style: "split", title: "Get a free quote", purpose: "lead" }) }),
  };
};

// 2. Dispatch: dark and urgent, the phone number first.
const dispatch = (ctx: TemplateCtx): Recipe => {
  const { b } = ctx;
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, size: "7xl", pt: "2xl", tone: "dark", bg: { kind: "color", color: "dark" } });
  const services = servicesSection(ctx, { icons: ICONS, style: "grid", cols: "3", title: "Everything we fix, fit and service", eyebrow: "Services" });
  const about = aboutSection(ctx, { title: "A small team you can trust in your home", image: art("workshop", "warm", 2), frame: "soft", aspect: "4/3" });
  const process = processSection(ctx, { style: "line", title: "From call to done", align: "center" });
  const cta = ctaSection(ctx, { style: "split", tone: "dark", title: "Something wrong? Call us now.", body: null, buttonVariant: "accent" });
  return {
    design: { ...base, mode: "dark", scale: "grand", colors: { primary: "#ff7a1a", accent: "#ffd166", bg: "#0f1218", surface: "#171c25", surface2: "#1f2531", ink: "#f4f6fa", muted: "#a6afc0", line: "#2a3242", dark: "#0a0d12" }, fonts: { heading: "barlow", body: "albert", accent: "albert", mono: "jetbrains" }, heading: { weight: 800, ls: "normal", lh: "none", transform: "uppercase", emphasis: "accent" }, radius: "soft", buttons: { style: "solid", caps: true, hover: "lift", weight: 700 } },
    header: headerBar(ctx, { tone: "dark", navStyle: "minimal", sticky: true, bg: { kind: "color", color: "dark" } }),
    footer: footerColumns(ctx, { tone: "dark" }),
    home: compact([
      heroFull(ctx, {
        image: art("workshop", "warm", 1), tone: "dark", align: "start", valign: "center", size: "7xl", minH: "90", overlay: { opacity: 70, dir: "left" }, eyebrow: ctx.has.areas ? `Local to ${ctx.d.areas!.slice(0, 2).join(" & ")}` : "Local specialists", ctaVariant: ["primary", "outline"], ctas: "primary",
        after: [...(ctx.phoneLink ? [b.group([b.badge("Emergencies: call any time", { variant: "dot" })], { style: { mt: "s" } })] : [])],
      }),
      badgeRow(ctx, { tone: "dark" }),
      services,
      processSection(ctx, { style: "line", title: "From call to done", align: "center" }),
      statsSection(ctx, { style: "big", tone: "dark" }),
      testimonialsSection(ctx, { style: "wall" }),
      areasSection(ctx, { tone: "dark" }),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "columns", align: "center" }), gallery: gallerySection(ctx, { images: [art("workshop", "warm", 1), art("neighborhood", "warm", 2), art("storefront", "warm", 3)], layout: "grid", cols: "3", aspect: "4/3" }), cta, contact: contactSection(ctx, { style: "split", title: "Call or send a message", purpose: "lead" }) }),
  };
};

// 3. Crew: a hero with a photograph, image cards for each service and a sticky call button.
const crew = (ctx: TemplateCtx): Recipe => {
  const { b } = ctx;
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, size: "6xl", pt: "2xl", image: art("neighborhood", "warm", 4), tone: "dark" });
  const services = servicesSection(ctx, { icons: ICONS, style: ctx.sample ? "imageCards" : "iconCards", images: [art("workshop", "warm", 2), art("neighborhood", "light", 3), art("storefront", "warm", 4), art("townhouse", "light", 5), art("garden", "light", 6), art("interior", "warm", 7)], cols: "3", title: "Work we do", eyebrow: "Services" });
  const about = aboutSection(ctx, { title: "Your neighbours in the trade", collage: { layout: "trio", images: [art("workshop", "warm", 5), art("neighborhood", "light", 6), art("storefront", "warm", 7)] } });
  const process = processSection(ctx, { style: "timeline", title: "How a job goes" });
  const cta = ctaSection(ctx, { style: "image", title: "Tell us about the job.", body: null, image: art("neighborhood", "warm", 8), buttonVariant: "primary" });
  return {
    design: { ...base, colors: { primary: "#128a5e", accent: "#f5a623", bg: "#f8faf6", surface: "#ffffff", surface2: "#e7f0e9", ink: "#12261c", muted: "#4a6254", line: "#d3e2d8", dark: "#0b2a1c" }, fonts: { heading: "outfit", body: "albert", accent: "albert", mono: "jetbrains" }, heading: { weight: 700, ls: "tight", lh: "tight", transform: "none", emphasis: "accent" }, radius: "round", buttons: { style: "solid", caps: false, hover: "lift", weight: 700 } },
    header: headerFloating(ctx, { navStyle: "pills", cta: true }),
    footer: footerColumns(ctx, { tone: "dark" }),
    home: compact([
      heroSplit(ctx, {
        eyebrow: ctx.has.areas ? ctx.d.areas!.slice(0, 3).join(" · ") : "Local trades", size: "7xl", textSpan: 6, pt: "3xl", pb: "xl", bg: { kind: "color", color: "bg" }, ctaVariant: ["primary", "outline"],
        collage: { layout: "trio", images: [art("workshop", "warm", 8), art("neighborhood", "light", 9), art("storefront", "warm", 10)] },
        decor: [{ kind: "blob", at: "br", size: "l", color: "accent", opacity: 26 }],
      }),
      wordBand(ctx, { style: "badge", tone: "light", speed: "slow" }),
      services,
      about,
      processSection(ctx, { style: "timeline", title: "How a job goes" }),
      testimonialsSection(ctx, { style: "cards" }),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "cards", align: "center" }), gallery: gallerySection(ctx, { images: [art("workshop", "warm", 1), art("neighborhood", "light", 2), art("storefront", "warm", 3), art("garden", "light", 4)], layout: "masonry", cols: "2" }), cta, contact: contactSection(ctx, { style: "split", title: "Get in touch", purpose: "lead" }) }),
  };
};

// 4. Neighbor: pastel, rounded and warm, with an arch-shaped picture.
const neighbor = (ctx: TemplateCtx): Recipe => {
  const { b } = ctx;
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, align: "center", size: "6xl", pt: "2xl", bg: { kind: "color", color: "primarySoft" } });
  const services = servicesSection(ctx, { icons: ICONS, style: "bento", title: "We've got you covered", eyebrow: "Services", align: "center" });
  const about = aboutSection(ctx, { title: "Friendly faces, fair prices", image: art("neighborhood", "light", 6), frame: "arch", aspect: "4/5", reverse: true });
  const process = processSection(ctx, { style: "numbered", title: "Easy as one, two, three", align: "center" });
  const cta = ctaSection(ctx, { style: "card", title: "Let's get it sorted.", body: "Call or message. We'll find a time that suits you." });
  return {
    design: { ...base, colors: { primary: "#e0613d", accent: "#2a9d8f", bg: "#fff8f2", surface: "#ffffff", surface2: "#ffe9db", ink: "#2b1a14", muted: "#6a5249", line: "#f0d8c9", dark: "#2b1a14" }, fonts: { heading: "jakarta", body: "albert", accent: "albert", mono: "jetbrains" }, heading: { weight: 700, ls: "tight", lh: "tight", transform: "none", emphasis: "both" }, radius: "pill", buttons: { style: "solid", caps: false, hover: "lift", weight: 700 } },
    header: headerCentered(ctx, { navStyle: "pills" }),
    footer: footerCentered(ctx, { tone: "dark" }),
    home: compact([
      b.section({ id: "hero", name: "Hero", bg: { kind: "color", color: "primarySoft" }, layout: { pt: "xl", pb: "xl", width: "wide", gap: "xl", valign: "center" }, decor: [{ kind: "blob", at: "tr", size: "l", color: "accent", opacity: 30 }, { kind: "dots", at: "bl", size: "m", color: "primary", opacity: 40 }] }, [
        b.col(6, [
          b.badge(ctx.has.areas ? `Your local team in ${ctx.d.areas![0]}` : "Your local team", { variant: "outline" }),
          b.h1(ctx.headline, { style: { size: "7xl", lh: "none" }, anim: { preset: "up", delay: 80 } }),
          b.lede(ctx.lede || "Friendly, reliable help close to home.", { style: { w: "m", color: "ink" } }),
          b.group([b.btn(ctx.primaryLabel, ctx.primaryHref, { size: "l", icon: "arrow-right" }), ...(ctx.phoneLink && ctx.action !== "call" ? [b.btn(ctx.phoneLink.label, ctx.phoneLink.href, { variant: "outline", size: "l", icon: "phone" })] : [])], { gap: "s" }),
        ], { gap: "m", r: { t: { span: 12 } } }),
        b.col(6, [b.img(art("neighborhood", "light", 5), { aspect: "4/5", frame: "arch", priority: true, anim: { preset: "scale", delay: 120 } })], { valign: "center", r: { t: { span: 12 } } }),
      ]),
      services,
      processSection(ctx, { style: "numbered", title: "Easy as one, two, three", align: "center" }),
      testimonialsSection(ctx, { style: "cards" }),
      areasSection(ctx, {}),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "cards", align: "center" }), gallery: gallerySection(ctx, { images: [art("neighborhood", "light", 5), art("workshop", "warm", 2), art("storefront", "light", 3), art("garden", "light", 4)], layout: "grid", cols: "2" }), cta, contact: contactSection(ctx, { style: "stacked", title: "Say hello", purpose: "lead" }) }),
  };
};

// 5. Rapid: speed first, a stacked headline, an orange call to action.
const rapid = (ctx: TemplateCtx): Recipe => {
  const { b } = ctx;
  const title = (t: string, lede?: string) => pageTitle(ctx, { title: t, lede, eyebrow: ctx.name, size: "8xl", pt: "2xl", tone: "dark", bg: { kind: "color", color: "dark" } });
  const services = servicesSection(ctx, { icons: ICONS, style: "numbered", cols: "3", title: "Services", eyebrow: "01" });
  const about = aboutSection(ctx, { title: "Quick, careful, clear", image: art("workshop", "warm", 4), frame: "none", aspect: "4/3" });
  const process = processSection(ctx, { style: "numbered", title: "Three steps", eyebrow: "02" });
  const cta = ctaSection(ctx, { style: "band", tone: "brand", title: "Get it fixed today.", body: null, buttonVariant: "dark" });
  return {
    design: { ...base, scale: "display", colors: { primary: "#ff5a1f", accent: "#111111", bg: "#ffffff", surface: "#ffffff", surface2: "#f3f1ec", ink: "#111111", muted: "#4d4a44", line: "#dedad0", dark: "#111111" }, fonts: { heading: "barlow", body: "albert", accent: "albert", mono: "jetbrains" }, heading: { weight: 800, ls: "tight", lh: "none", transform: "uppercase", emphasis: "accent" }, radius: "square", buttons: { style: "solid", caps: true, hover: "invert", weight: 800 } },
    header: headerBar(ctx, { navStyle: "minimal", sticky: true, bg: { kind: "color", color: "surface" } }),
    footer: footerColumns(ctx, { tone: "dark" }),
    home: compact([
      b.section({ id: "hero", name: "Hero", layout: { pt: "xl", pb: "m", width: "wide", gap: "m", valign: "start" } }, [
        b.col(12, [
          b.badge(ctx.has.areas ? ctx.d.areas!.slice(0, 3).join(" · ") : "Local", { variant: "outline" }),
          b.h1(ctx.headline, { style: { size: "8xl", lh: "none" }, anim: { preset: "up", delay: 60 } }),
        ], { gap: "m" }),
        b.col(5, [b.lede(ctx.lede || "Fast, tidy work with a clear quote first.", { style: { color: "ink" } }), b.group([b.btn(ctx.primaryLabel, ctx.primaryHref, { size: "l", icon: "arrow-right" }), ...callBar(ctx).map((x) => ({ ...x, props: { ...x.props, variant: "dark" } }))], { gap: "s", style: { mt: "s" } })], { gap: "m", valign: "start" }),
        b.col(7, [b.img(art("workshop", "warm", 6), { aspect: "16/10", frame: "none", priority: true, anim: { preset: "reveal", delay: 140 } })], { valign: "start" }),
      ]),
      wordBand(ctx, { style: "text", tone: "dark", size: "3xl", speed: "fast" }),
      services,
      statsSection(ctx, { style: "lines" }),
      testimonialsSection(ctx, { style: "quote" }),
      areasSection(ctx, {}),
      cta,
    ]),
    ...innerPages(ctx, { title, services, about, process, faq: faqSection(ctx, { style: "lines", side: true }), gallery: gallerySection(ctx, { images: [art("workshop", "warm", 6), art("neighborhood", "light", 2), art("storefront", "warm", 3)], layout: "grid", cols: "3" }), cta, contact: contactSection(ctx, { style: "split", title: "Get a quote", purpose: "lead" }) }),
  };
};

const v = (id: string, name: string, description: string, tags: string[], build: (ctx: TemplateCtx) => Recipe): VariationDef => ({ id, name, description, tags, build });

export const local: FamilyDef = {
  id: "local",
  name: "Local Services",
  tagline: "Conversion-focused, with trust and contact always in reach.",
  description: "For trades and local businesses: a quote form or phone button in the first screen, clear services and where you work.",
  industries: ["home_services", "local_services"],
  tags: ["local", "conversion", "trades"],
  sample: SAMPLES.local,
  variations: [
    v("corner", "Corner", "A split hero with a quote form on the right and trust points beneath the headline.", ["light", "form", "blue"], corner),
    v("dispatch", "Dispatch", "Dark and urgent, with the phone number first.", ["dark", "urgent", "orange"], dispatch),
    v("crew", "Crew", "A floating bar, a photo collage and image cards for each service.", ["light", "green", "photographic"], crew),
    v("neighbor", "Neighbor", "Pastel, rounded and warm, with an arch-shaped picture.", ["light", "friendly", "pastel"], neighbor),
    v("rapid", "Rapid", "Speed first: a stacked headline and a sharp orange call to action.", ["light", "bold", "orange"], rapid),
  ],
};
