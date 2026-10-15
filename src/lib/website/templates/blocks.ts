// The section library: finished, designed sections that a template assembles into pages and that an owner can add from the editor.
// Each block is a function from the business's facts (and a few style options) to an ordinary section, so once it is on a page it is
// edited exactly like anything the owner built by hand.
import { art, type ElOpts } from "../build";
import type { ElementType } from "../catalog";
import type { Bg, Decor, ElementNode, ImageSrc, Section } from "../doc";
import type { TemplateCtx } from "./types";

const pick = <T,>(sample: T, real: T, ctx: TemplateCtx): T => (ctx.sample ? sample : real);
export { pick };

export type Tone = Section["tone"];

/** Whether the services have their own descriptions, which decides how much a services layout has to say. */
export const svcItems = (ctx: TemplateCtx, icons: string[], images?: ImageSrc[]) =>
  ctx.d.services.slice(0, 12).map((s, i) => ({ title: s.title, text: s.description ?? "", icon: icons[i % icons.length], image: images ? (images[i % images.length] ?? null) : null, link: { label: "", href: "" } }));

// ---------------------------------------------------------------------------
// Heroes
// ---------------------------------------------------------------------------

export interface HeroOpts {
  id?: string;
  image?: ImageSrc;
  tone?: Tone;
  bg?: Bg;
  eyebrow?: string | null;
  title?: string;
  lede?: string | null;
  size?: "5xl" | "6xl" | "7xl" | "8xl";
  align?: "start" | "center";
  valign?: "start" | "center" | "end";
  minH?: "auto" | "60" | "75" | "90" | "100";
  overlay?: { color?: "dark" | "ink" | "primary" | "bg"; opacity?: number; dir?: "flat" | "bottom" | "top" | "left" | "right" | "vignette" };
  imagePos?: { x: number; y: number };
  width?: "regular" | "wide" | "full" | "narrow";
  pt?: "xl" | "2xl" | "3xl";
  pb?: "l" | "xl" | "2xl";
  ctas?: "both" | "primary" | "none";
  ctaVariant?: [string, string];
  headingStyle?: ElOpts["style"];
  ledeStyle?: ElOpts["style"];
  decor?: Decor[];
  /** Extra elements placed after the buttons. */
  after?: ElementNode[];
  parallax?: boolean;
  anim?: boolean;
}

const heroCopy = (ctx: TemplateCtx, o: HeroOpts) => ({
  eyebrow: o.eyebrow === undefined ? (ctx.has.areas ? `Serving ${ctx.d.areas!.slice(0, 2).join(" and ")}` : null) : o.eyebrow,
  title: o.title ?? ctx.headline,
  lede: o.lede === undefined ? ctx.lede || null : o.lede,
});

export const heroButtons = (ctx: TemplateCtx, o: HeroOpts, light = false, center = false) => {
  const { b } = ctx;
  if (o.ctas === "none") return [];
  const [v1, v2] = o.ctaVariant ?? (light ? ["light", "outline"] : ["primary", "outline"]);
  const out = [b.btn(ctx.primaryLabel, ctx.primaryHref, { variant: v1, size: "l", icon: "arrow-right" })];
  if (o.ctas !== "primary" && ctx.secondary) out.push(b.btn(ctx.secondary.label, ctx.secondary.href, { variant: v2, size: "l" }));
  return [b.group(out, { gap: "s", justify: center ? "center" : "start", style: { mt: "s" }, anim: o.anim === false ? undefined : { preset: "up", delay: 300 } })];
};

/** A full-screen image with the headline set low and to the left. */
export function heroFull(ctx: TemplateCtx, o: HeroOpts = {}): Section {
  const { b } = ctx;
  const c = heroCopy(ctx, o);
  const center = o.align === "center";
  const dark = (o.tone ?? "dark") === "dark";
  return b.section(
    {
      id: o.id ?? b.id("hero"), name: "Hero", tone: o.tone ?? "dark", decor: o.decor,
      bg: o.bg ?? { kind: "image", src: o.image ?? art("villa", "warm"), overlay: { color: o.overlay?.color ?? "dark", opacity: o.overlay?.opacity ?? 58, dir: o.overlay?.dir ?? "bottom" }, pos: o.imagePos ?? { x: 50, y: 55 }, parallax: o.parallax === true },
      layout: { minH: o.minH ?? "90", valign: o.valign ?? "end", pt: o.pt ?? "3xl", pb: o.pb ?? "xl", width: o.width ?? "wide" },
    },
    [
      b.col(center ? 12 : 8, [
        ...(c.eyebrow ? [b.eyebrow(c.eyebrow, { style: { color: dark ? "onDark" : undefined, ...(center ? { align: "center" as const } : {}) }, anim: o.anim === false ? undefined : "fade" })] : []),
        b.h1(c.title, { style: { size: o.size ?? "7xl", ...(center ? { align: "center" as const } : {}), ...(o.headingStyle ?? {}) }, anim: o.anim === false ? undefined : { preset: "up", delay: 100 } }),
        ...(c.lede ? [b.lede(c.lede, { style: { w: "m", ...(dark ? { color: "onDark" as const } : {}), ...(center ? { align: "center" as const } : {}), ...(o.ledeStyle ?? {}) }, anim: o.anim === false ? undefined : { preset: "up", delay: 200 } })] : []),
        ...heroButtons(ctx, o, dark, center),
        ...(o.after ?? []),
      ], { gap: "m", ...(center ? { align: "center" as const } : {}) }),
    ],
  );
}

export interface SplitOpts extends HeroOpts {
  reverse?: boolean;
  frame?: string;
  aspect?: string;
  rightElements?: ElementNode[];
  badges?: string[];
  textSpan?: number;
  gap?: "m" | "l" | "xl";
  imageFirstOnMobile?: boolean;
  collage?: { layout: string; images: ImageSrc[] };
}

/** Text on one side, a picture on the other. */
export function heroSplit(ctx: TemplateCtx, o: SplitOpts = {}): Section {
  const { b } = ctx;
  const c = heroCopy(ctx, o);
  const dark = o.tone === "dark";
  const text = o.textSpan ?? 6;
  const right =
    o.rightElements ??
    (o.collage
      ? [b.el("collage", { layout: o.collage.layout, items: o.collage.images.map((src) => ({ src, alt: "" })) }, { anim: "scale" })]
      : [b.img(o.image ?? art("interior", "light"), { aspect: o.aspect ?? "4/5", frame: o.frame ?? "soft", priority: true, anim: { preset: "reveal", delay: 150 } })]);
  const textCol = b.col(text, [
    ...(c.eyebrow ? [b.eyebrow(c.eyebrow, { anim: "fade" })] : []),
    b.h1(c.title, { style: { size: o.size ?? "6xl", ...(o.headingStyle ?? {}) }, anim: { preset: "up", delay: 100 } }),
    ...(c.lede ? [b.lede(c.lede, { style: { w: "m", ...(o.ledeStyle ?? {}) }, anim: { preset: "up", delay: 200 } })] : []),
    ...heroButtons(ctx, o, dark && false),
    ...(o.badges?.length ? [b.group(o.badges.map((t) => b.badge(t, { variant: "outline" })), { gap: "xs", style: { mt: "s" } })] : []),
    ...(o.after ?? []),
  ], { gap: "m" });
  const imgCol = b.col(12 - text, right, { valign: "center" });
  const cols = o.reverse ? [imgCol, textCol] : [textCol, imgCol];
  return b.section(
    {
      id: o.id ?? b.id("hero"), name: "Hero", tone: o.tone, bg: o.bg, decor: o.decor,
      layout: { minH: o.minH ?? "auto", valign: o.valign ?? "center", pt: o.pt ?? "2xl", pb: o.pb ?? "xl", width: o.width ?? "wide", gap: o.gap ?? "xl", reverse: o.imageFirstOnMobile === true },
    },
    cols,
  );
}

export interface CenteredOpts extends HeroOpts {
  badge?: string | null;
  below?: ElementNode[];
  titleWidth?: "m" | "l";
}

/** A centred statement, optionally with a picture or a collage beneath it. */
export function heroCentered(ctx: TemplateCtx, o: CenteredOpts = {}): Section {
  const { b } = ctx;
  const c = heroCopy(ctx, o);
  const dark = o.tone === "dark";
  return b.section(
    {
      id: o.id ?? b.id("hero"), name: "Hero", tone: o.tone, bg: o.bg, decor: o.decor,
      layout: { minH: o.minH ?? "auto", valign: o.valign ?? "center", pt: o.pt ?? "2xl", pb: o.pb ?? "xl", width: o.width ?? "regular", gap: "l" },
    },
    [
      b.col(12, [
        ...(o.badge ? [b.badge(o.badge, { variant: "outline", style: { align: "center" }, anim: "fade" })] : c.eyebrow ? [b.eyebrow(c.eyebrow, { style: { align: "center" }, anim: "fade" })] : []),
        b.h1(c.title, { style: { size: o.size ?? "7xl", align: "center", w: o.titleWidth === "m" ? "l" : undefined, ...(o.headingStyle ?? {}) }, anim: { preset: "up", delay: 80 } }),
        ...(c.lede ? [b.lede(c.lede, { style: { align: "center", w: "m", ...(dark ? { color: "onDark" as const } : {}), ...(o.ledeStyle ?? {}) }, anim: { preset: "up", delay: 180 } })] : []),
        ...(o.ctas === "none" ? [] : [b.group(heroButtons(ctx, o, dark).flatMap((g) => g.children ?? []), { gap: "s", justify: "center", style: { mt: "s" }, anim: { preset: "up", delay: 260 } })]),
        ...(o.below ?? []),
      ], { gap: "m", align: "center" }),
    ],
  );
}

/** A masthead-style hero: a huge headline across the page, then a row with images and a short paragraph. */
export function heroEditorial(ctx: TemplateCtx, o: HeroOpts & { images: [ImageSrc, ImageSrc]; captions?: [string, string]; note?: string }): Section {
  const { b } = ctx;
  const c = heroCopy(ctx, o);
  return b.section(
    { id: o.id ?? b.id("hero"), name: "Hero", tone: o.tone, bg: o.bg, decor: o.decor, layout: { pt: o.pt ?? "2xl", pb: o.pb ?? "xl", width: o.width ?? "wide", gap: "m", valign: "start" } },
    [
      b.col(12, [
        ...(c.eyebrow ? [b.eyebrow(c.eyebrow, { style: { align: "center" }, anim: "fade" })] : []),
        b.h1(c.title, { style: { size: o.size ?? "8xl", align: "center", lh: "none", ls: "tighter", ...(o.headingStyle ?? {}) }, anim: { preset: "up", delay: 80 } }),
        b.divider({ variant: "ornament", style: { mt: "m", mb: "s" } }),
      ], { gap: "s", align: "center" }),
      b.col(4, [b.img(o.images[0], { aspect: "3/4", frame: "none", caption: o.captions?.[0] ?? "", anim: { preset: "reveal", delay: 120 } })], { valign: "start", r: { m: { span: 6 } } }),
      b.col(4, [
        ...(c.lede ? [b.lede(c.lede, { style: { align: "center" } })] : []),
        ...(o.note ? [b.small(o.note, { style: { align: "center" } })] : []),
        ...heroButtons(ctx, { ...o, ctas: o.ctas ?? "both" }, false).map((g) => ({ ...g, props: { ...g.props, justify: "center" } })),
      ], { gap: "m", valign: "center", align: "center", r: { m: { span: 12 }, t: { span: 12 } } }),
      b.col(4, [b.img(o.images[1], { aspect: "3/4", frame: "none", caption: o.captions?.[1] ?? "", anim: { preset: "reveal", delay: 240 } })], { valign: "end", r: { m: { span: 6 } } }),
    ].map((col, i) => (i === 3 ? { ...col, r: { ...(col.r ?? {}), m: { span: 6 } } } : col)),
  );
}

// ---------------------------------------------------------------------------
// Content sections
// ---------------------------------------------------------------------------

export interface HeadOpts {
  eyebrow?: string | null;
  title?: string;
  lede?: string | null;
  align?: "start" | "center";
  size?: "3xl" | "4xl" | "5xl" | "6xl";
  tone?: Tone;
}

/** The standard introduction to a section: a small label, a heading, a line of context. */
export function sectionHead(ctx: TemplateCtx, o: HeadOpts, anim = true): ElementNode[] {
  const { b } = ctx;
  const center = o.align === "center";
  const st = center ? { align: "center" as const } : {};
  return [
    ...(o.eyebrow ? [b.eyebrow(o.eyebrow, { style: st, anim: anim ? "fade" : undefined })] : []),
    ...(o.title ? [b.h2(o.title, { style: { size: o.size ?? "4xl", ...st, ...(center ? { w: "l" as const } : {}) }, anim: anim ? { preset: "up", delay: 60 } : undefined })] : []),
    ...(o.lede ? [b.lede(o.lede, { style: { ...st, w: "m" }, anim: anim ? { preset: "up", delay: 120 } : undefined })] : []),
  ];
}

export interface ServicesOpts extends HeadOpts {
  id?: string;
  style?: "grid" | "iconCards" | "imageCards" | "bento" | "rows" | "numbered" | "alternating" | "list";
  cols?: "2" | "3" | "4";
  icons: string[];
  images?: ImageSrc[];
  bg?: Bg;
  layout?: "stacked" | "side";
  pt?: "l" | "xl" | "2xl";
  pb?: "l" | "xl" | "2xl";
  width?: "regular" | "wide";
  link?: { label: string; href: string } | null;
  decor?: Decor[];
}

export function servicesSection(ctx: TemplateCtx, o: ServicesOpts): Section | null {
  if (!ctx.has.services) return null;
  const { b } = ctx;
  const items = svcItems(ctx, o.icons, o.images);
  const el = b.el("services", { style: o.style ?? "grid", cols: o.cols ?? "3", items }, { anim: { preset: "up", delay: 100 } });
  const head = sectionHead(ctx, { eyebrow: "What we do", title: "Services", ...o });
  const link = o.link ? [b.btn(o.link.label, o.link.href, { variant: "ghost", icon: "arrow-right", style: { mt: "s" } })] : [];
  const cols =
    o.layout === "side"
      ? [b.col(4, [...head, ...link], { gap: "s", valign: "start" }), b.col(8, [el], { valign: "start" })]
      : [b.col(12, [...head, el, ...link], { gap: "l" })];
  return b.section({ id: o.id ?? b.id("services"), name: "Services", tone: o.tone, bg: o.bg, decor: o.decor, layout: { pt: o.pt ?? "2xl", pb: o.pb ?? "2xl", width: o.width ?? "wide", gap: "xl", valign: "start" } }, cols);
}

export interface AboutOpts extends HeadOpts {
  id?: string;
  image?: ImageSrc;
  frame?: string;
  aspect?: string;
  reverse?: boolean;
  points?: boolean;
  bg?: Bg;
  button?: boolean;
  collage?: { layout: string; images: ImageSrc[] };
  pt?: "l" | "xl" | "2xl";
  pb?: "l" | "xl" | "2xl";
  width?: "regular" | "wide";
}

export function aboutSection(ctx: TemplateCtx, o: AboutOpts = {}): Section | null {
  if (!ctx.has.about) return null;
  const { b } = ctx;
  const body = ctx.d.aboutText || ctx.d.description || "";
  const media = o.collage
    ? b.el("collage", { layout: o.collage.layout, items: o.collage.images.map((src) => ({ src, alt: "" })) }, { anim: "scale" })
    : b.img(o.image ?? art("interior", "light"), { aspect: o.aspect ?? "4/5", frame: o.frame ?? "soft", anim: { preset: "reveal" } });
  const textCol = b.col(6, [
    ...sectionHead(ctx, { eyebrow: `About ${ctx.name}`, title: ctx.has.about ? undefined : undefined, ...o }),
    b.body(body, { anim: { preset: "up", delay: 100 } }),
    ...(ctx.has.highlights && o.points !== false ? [b.list(ctx.d.highlights!.slice(0, 5), { anim: { preset: "up", delay: 160 } })] : []),
    ...(o.button !== false ? [b.btn("Get in touch", "/contact", { variant: "ghost", icon: "arrow-right", style: { mt: "s" } })] : []),
  ], { gap: "m" });
  const mediaCol = b.col(6, [media], { valign: "center" });
  return b.section({ id: o.id ?? b.id("about"), name: "About", tone: o.tone, bg: o.bg, layout: { pt: o.pt ?? "2xl", pb: o.pb ?? "2xl", width: o.width ?? "wide", gap: "xl", valign: "center" } }, o.reverse ? [mediaCol, textCol] : [textCol, mediaCol]);
}

export interface StatsOpts extends HeadOpts {
  id?: string;
  style?: "row" | "cards" | "big" | "lines";
  bg?: Bg;
  pt?: "m" | "l" | "xl";
  pb?: "m" | "l" | "xl";
  head?: boolean;
}

export function statsSection(ctx: TemplateCtx, o: StatsOpts = {}): Section | null {
  if (!ctx.has.stats) return null;
  const { b } = ctx;
  const items = ctx.d.stats!.slice(0, 4).map((s) => ({ value: s.value, prefix: "", suffix: s.suffix ?? "", label: s.label }));
  return b.section({ id: o.id ?? b.id("stats"), name: "Numbers", tone: o.tone, bg: o.bg, layout: { pt: o.pt ?? "xl", pb: o.pb ?? "xl", width: "wide" } }, [
    b.col(12, [...(o.head ? sectionHead(ctx, o) : []), b.el("stats", { style: o.style ?? "row", items, countUp: true }, { anim: "up" })], { gap: "l" }),
  ]);
}

export interface TestiOpts extends HeadOpts {
  id?: string;
  style?: "cards" | "quote" | "wall" | "slider";
  bg?: Bg;
  pt?: "l" | "xl" | "2xl";
  pb?: "l" | "xl" | "2xl";
  width?: "narrow" | "regular" | "wide";
}

export function testimonialsSection(ctx: TemplateCtx, o: TestiOpts = {}): Section | null {
  if (!ctx.has.testimonials) return null;
  const { b } = ctx;
  const items = ctx.d.testimonials!.slice(0, 6).map((t) => ({ quote: t.quote, author: t.author, role: t.role ?? "", avatar: null, confirmedReal: false }));
  return b.section({ id: o.id ?? b.id("testimonials"), name: "Testimonials", tone: o.tone, bg: o.bg, layout: { pt: o.pt ?? "2xl", pb: o.pb ?? "2xl", width: o.width ?? "wide" } }, [
    b.col(12, [...sectionHead(ctx, { eyebrow: "Kind words", title: "What clients say", align: "center", ...o }), b.el("testimonials", { style: o.style ?? "cards", items }, { anim: "up" })], { gap: "l" }),
  ]);
}

export interface ProcessOpts extends HeadOpts {
  id?: string;
  style?: "timeline" | "cards" | "numbered" | "line" | "vertical";
  bg?: Bg;
  side?: boolean;
  pt?: "l" | "xl" | "2xl";
  pb?: "l" | "xl" | "2xl";
}

export function processSection(ctx: TemplateCtx, o: ProcessOpts = {}): Section | null {
  if (!ctx.has.steps) return null;
  const { b } = ctx;
  const steps = ctx.d.steps!.slice(0, 6).map((s) => ({ title: s.title, text: s.text }));
  const el = b.el("steps", { style: o.style ?? "timeline", items: steps }, { anim: "up" });
  const head = sectionHead(ctx, { eyebrow: "How it works", title: "A clear path from first call to done", ...o });
  const cols = o.side ? [b.col(4, head, { gap: "s", valign: "start" }), b.col(8, [el], { valign: "start" })] : [b.col(12, [...head, el], { gap: "xl" })];
  return b.section({ id: o.id ?? b.id("process"), name: "Process", tone: o.tone, bg: o.bg, layout: { pt: o.pt ?? "2xl", pb: o.pb ?? "2xl", width: "wide", gap: "xl", valign: "start" } }, cols);
}

export interface FaqOpts extends HeadOpts {
  id?: string;
  style?: "accordion" | "columns" | "cards" | "lines";
  bg?: Bg;
  side?: boolean;
  pt?: "l" | "xl" | "2xl";
  pb?: "l" | "xl" | "2xl";
}

export function faqSection(ctx: TemplateCtx, o: FaqOpts = {}): Section | null {
  if (!ctx.has.faqs) return null;
  const { b } = ctx;
  const items = ctx.d.faqs!.slice(0, 20).map((f) => ({ q: f.question, a: f.answer }));
  const el = b.el("faq", { style: o.style ?? "accordion", items, openFirst: true }, { anim: "up" });
  const head = sectionHead(ctx, { eyebrow: "Questions", title: "Questions we're often asked", ...o });
  const cols = o.side ? [b.col(4, head, { gap: "s", valign: "start" }), b.col(8, [el], { valign: "start" })] : [b.col(12, [...head, el], { gap: "l" })];
  return b.section({ id: o.id ?? b.id("faq"), name: "FAQ", tone: o.tone, bg: o.bg, layout: { pt: o.pt ?? "2xl", pb: o.pb ?? "2xl", width: o.side ? "wide" : "regular", gap: "xl", valign: "start" } }, cols);
}

export interface GalleryOpts extends HeadOpts {
  id?: string;
  layout?: "grid" | "masonry" | "mosaic" | "strip";
  cols?: "2" | "3" | "4";
  aspect?: string;
  gap?: string;
  images: ImageSrc[];
  captions?: string[];
  bg?: Bg;
  width?: "regular" | "wide" | "full";
  pt?: "l" | "xl" | "2xl";
  pb?: "l" | "xl" | "2xl";
  button?: { label: string; href: string };
}

export function gallerySection(ctx: TemplateCtx, o: GalleryOpts): Section | null {
  const { b } = ctx;
  const real = (ctx.d.galleryAssetIds ?? []).slice(0, 12);
  const items = real.length
    ? real.map((id) => ({ src: { kind: "asset" as const, id }, alt: "", caption: "" }))
    : ctx.sample
      ? o.images.map((src, i) => ({ src, alt: "", caption: o.captions?.[i] ?? "" }))
      : [];
  if (!items.length) return null;
  const head = sectionHead(ctx, { eyebrow: "Our work", title: "A look at what we do", ...o });
  return b.section({ id: o.id ?? b.id("gallery"), name: "Gallery", tone: o.tone, bg: o.bg, layout: { pt: o.pt ?? "2xl", pb: o.pb ?? "2xl", width: o.width ?? "wide", gap: "l", valign: "start" } }, [
    b.col(12, [...head, b.el("gallery", { layout: o.layout ?? "grid", cols: o.cols ?? "3", aspect: o.aspect ?? "4/3", gap: o.gap ?? "s", items }, { anim: "up" }), ...(o.button ? [b.btn(o.button.label, o.button.href, { variant: "ghost", icon: "arrow-right" })] : [])], { gap: "l" }),
  ]);
}

export interface CtaOpts {
  id?: string;
  style?: "band" | "card" | "split" | "minimal" | "image" | "centered";
  tone?: Tone;
  bg?: Bg;
  title?: string;
  body?: string | null;
  image?: ImageSrc;
  eyebrow?: string | null;
  decor?: Decor[];
  buttonVariant?: string;
  pt?: "l" | "xl" | "2xl";
  pb?: "l" | "xl" | "2xl";
  width?: "narrow" | "regular" | "wide";
}

/** A closing call to action in one of several shapes. */
export function ctaSection(ctx: TemplateCtx, o: CtaOpts = {}): Section {
  const { b } = ctx;
  const title = o.title ?? (ctx.action === "book" ? "Ready to book?" : ctx.action === "call" ? "Need it sorted? Give us a call." : "Ready when you are.");
  const body = o.body === undefined ? "Tell us what you need and we'll get back to you." : o.body;
  const style = o.style ?? "band";
  const buttons = (variant: string, center = false) => b.group([b.btn(ctx.primaryLabel, ctx.primaryHref, { variant, size: "l", icon: "arrow-right" }), ...(ctx.phoneLink && ctx.action !== "call" ? [b.btn(ctx.phoneLink.label, ctx.phoneLink.href, { variant: "outline", size: "l", icon: "phone" })] : [])], { gap: "s", justify: center ? "center" : "start" });
  const base = { id: o.id ?? b.id("cta"), name: "Call to action", decor: o.decor };
  switch (style) {
    case "card":
      return b.section({ ...base, tone: o.tone, bg: o.bg, layout: { pt: o.pt ?? "xl", pb: o.pb ?? "xl", width: o.width ?? "wide" } }, [
        b.col(12, [b.card([
          ...(o.eyebrow ? [b.eyebrow(o.eyebrow, { style: { align: "center" } })] : []),
          b.h2(title, { style: { size: "5xl", align: "center", w: "l" } }), ...(body ? [b.lede(body, { style: { align: "center", w: "m" } })] : []), buttons(o.buttonVariant ?? "primary", true),
        ], { surface: "tinted", pad: "xl", gap: "m", align: "center" })]),
      ]);
    case "split":
      return b.section({ ...base, tone: o.tone, bg: o.bg, layout: { pt: o.pt ?? "xl", pb: o.pb ?? "xl", width: o.width ?? "wide", gap: "l" } }, [
        b.col(8, [b.h2(title, { style: { size: "5xl" } }), ...(body ? [b.lede(body, { style: { w: "m" } })] : [])], { gap: "s" }),
        b.col(4, [buttons(o.buttonVariant ?? "primary")], { valign: "center" }),
      ]);
    case "minimal":
      return b.section({ ...base, tone: o.tone, bg: o.bg, layout: { pt: o.pt ?? "2xl", pb: o.pb ?? "2xl", width: o.width ?? "narrow" } }, [
        b.col(12, [b.heading(title, { level: 2, style: { size: "5xl", align: "center", w: "l" } }), buttons(o.buttonVariant ?? "ghost", true)], { gap: "m", align: "center" }),
      ]);
    case "image":
      return b.section({
        ...base, tone: o.tone ?? "dark",
        bg: o.bg ?? { kind: "image", src: o.image ?? art("interior", "warm"), overlay: { color: "dark", opacity: 60, dir: "flat" }, pos: { x: 50, y: 50 }, parallax: true },
        layout: { pt: o.pt ?? "3xl", pb: o.pb ?? "3xl", width: o.width ?? "regular", minH: "60" },
      }, [b.col(12, [...(o.eyebrow ? [b.eyebrow(o.eyebrow, { style: { align: "center", color: "onDark" } })] : []), b.h2(title, { style: { size: "6xl", align: "center", w: "l" }, anim: "up" }), ...(body ? [b.lede(body, { style: { align: "center", w: "m", color: "onDark" } })] : []), buttons(o.buttonVariant ?? "light", true)], { gap: "m", align: "center" })]);
    case "centered":
      return b.section({ ...base, tone: o.tone, bg: o.bg, layout: { pt: o.pt ?? "2xl", pb: o.pb ?? "2xl", width: o.width ?? "regular" } }, [
        b.col(12, [...(o.eyebrow ? [b.eyebrow(o.eyebrow, { style: { align: "center" } })] : []), b.h2(title, { style: { size: "5xl", align: "center", w: "l" } }), ...(body ? [b.lede(body, { style: { align: "center", w: "m" } })] : []), buttons(o.buttonVariant ?? "primary", true)], { gap: "m", align: "center" }),
      ]);
    default:
      return b.section({ ...base, tone: o.tone ?? "brand", bg: o.bg, layout: { pt: o.pt ?? "xl", pb: o.pb ?? "xl", width: o.width ?? "wide", gap: "l" } }, [
        b.col(8, [b.h2(title, { style: { size: "4xl" } }), ...(body ? [b.lede(body, { style: { w: "m", color: "onPrimary" } })] : [])], { gap: "s" }),
        b.col(4, [buttons(o.buttonVariant ?? "light")], { valign: "center", r: { t: { valign: "start" } } }),
      ]);
  }
}

export interface ContactOpts extends HeadOpts {
  id?: string;
  style?: "split" | "card" | "stacked" | "map";
  bg?: Bg;
  purpose?: "contact" | "consultation" | "lead" | "appointment";
  submitLabel?: string;
  pt?: "l" | "xl" | "2xl";
  pb?: "l" | "xl" | "2xl";
}

export function contactSection(ctx: TemplateCtx, o: ContactOpts = {}): Section {
  const { b } = ctx;
  const booking = ctx.action === "book";
  const title = o.title ?? (booking ? "Request an appointment" : "Get in touch");
  const lede = o.lede === undefined ? (booking ? "Tell us when suits you. We'll confirm availability with you before anything is booked." : "Tell us what you need and we'll get back to you.") : o.lede;
  const form = b.el("form", { purpose: o.purpose ?? (booking ? "appointment" : "contact"), submitLabel: o.submitLabel ?? (booking ? "Request appointment" : "Send message"), layout: o.style === "stacked" ? "plain" : "card", phone: "optional", message: "required", service: ctx.d.services.length >= 2 ? "optional" : "hidden", services: ctx.d.services.slice(0, 12).map((s) => s.title.slice(0, 60)), helper: "" }, { anim: "up" });
  const details: ElementNode[] = [
    b.el("contactInfo", { phone: true, email: true, address: true, hours: true, layout: "stack" }),
    ...(ctx.has.address && o.style === "map" ? [b.el("map", { address: "", style: "card", label: "Open in maps" })] : []),
  ];
  const head = sectionHead(ctx, { eyebrow: o.eyebrow === undefined ? "Contact" : o.eyebrow, title, lede, align: o.style === "stacked" ? "center" : "start", size: "4xl" });
  if (o.style === "stacked") {
    return b.section({ id: o.id ?? b.id("contact"), name: "Contact", tone: o.tone, bg: o.bg, layout: { pt: o.pt ?? "2xl", pb: o.pb ?? "2xl", width: "narrow" } }, [b.col(12, [...head, form, b.divider({ style: { mt: "m" } }), ...details], { gap: "m" })]);
  }
  return b.section({ id: o.id ?? b.id("contact"), name: "Contact", tone: o.tone, bg: o.bg, layout: { pt: o.pt ?? "2xl", pb: o.pb ?? "2xl", width: "wide", gap: "xl", valign: "start" } }, [
    b.col(5, [...head, ...details], { gap: "m", valign: "start" }),
    b.col(7, [form], { valign: "start" }),
  ]);
}

/** A title bar for an inner page (About, Services, Contact). */
export function pageTitle(ctx: TemplateCtx, o: { title: string; lede?: string; eyebrow?: string; tone?: Tone; bg?: Bg; align?: "start" | "center"; size?: "5xl" | "6xl" | "7xl" | "8xl"; pt?: "xl" | "2xl" | "3xl"; image?: ImageSrc; id?: string }): Section {
  const { b } = ctx;
  const center = o.align === "center";
  const head: ElementNode[] = [
    ...(o.eyebrow ? [b.eyebrow(o.eyebrow, { style: center ? { align: "center" } : undefined, anim: "fade" })] : []),
    b.h1(o.title, { style: { size: o.size ?? "6xl", ...(center ? { align: "center" as const } : {}) }, anim: { preset: "up", delay: 60 } }),
    ...(o.lede ? [b.lede(o.lede, { style: { w: "m", ...(center ? { align: "center" as const } : {}) }, anim: { preset: "up", delay: 140 } })] : []),
  ];
  return b.section({ id: o.id ?? b.id("title"), name: "Page title", tone: o.tone, bg: o.bg ?? (o.image ? { kind: "image", src: o.image, overlay: { color: "dark", opacity: 55, dir: "bottom" }, pos: { x: 50, y: 50 }, parallax: false } : undefined), layout: { pt: o.pt ?? "3xl", pb: "xl", width: center ? "regular" : "wide", valign: "end" } }, [b.col(center ? 12 : 9, head, { gap: "m", ...(center ? { align: "center" as const } : {}) })]);
}

/** Wraps a handful of elements as a plain full-width section (for custom page content the templates don't cover). */
export function plainSection(ctx: TemplateCtx, id: string, elements: ElementNode[], o: { tone?: Tone; bg?: Bg; width?: "narrow" | "regular" | "wide"; pt?: "l" | "xl" | "2xl"; pb?: "l" | "xl" | "2xl" } = {}): Section {
  return ctx.b.section({ id, name: id, tone: o.tone, bg: o.bg, layout: { pt: o.pt ?? "xl", pb: o.pb ?? "xl", width: o.width ?? "regular" } }, [ctx.b.col(12, elements, { gap: "m" })]);
}

export const elementOf = (ctx: TemplateCtx, type: ElementType, props: Record<string, unknown>, o?: ElOpts) => ctx.b.el(type, props, o);

// ---------------------------------------------------------------------------
// Smaller blocks
// ---------------------------------------------------------------------------

export interface IntroOpts {
  id?: string;
  layout?: "two" | "statement" | "side";
  eyebrow?: string | null;
  title?: string;
  body?: string | null;
  button?: { label: string; href: string } | null;
  tone?: Tone;
  bg?: Bg;
  size?: "4xl" | "5xl" | "6xl" | "7xl";
  pt?: "l" | "xl" | "2xl";
  pb?: "l" | "xl" | "2xl";
  width?: "narrow" | "regular" | "wide";
}

/** A short statement that opens a page: two columns, or one large centred paragraph. */
export function introSection(ctx: TemplateCtx, o: IntroOpts = {}): Section {
  const { b } = ctx;
  const body = o.body === undefined ? ctx.lede : o.body;
  const btn = o.button ? [b.btn(o.button.label, o.button.href, { variant: "ghost", icon: "arrow-right", style: { mt: "s" } })] : [];
  if (o.layout === "statement") {
    return b.section({ id: o.id ?? b.id("intro"), name: "Introduction", tone: o.tone, bg: o.bg, layout: { pt: o.pt ?? "2xl", pb: o.pb ?? "2xl", width: o.width ?? "regular" } }, [
      b.col(12, [
        ...(o.eyebrow ? [b.eyebrow(o.eyebrow, { style: { align: "center" } })] : []),
        b.heading(o.title ?? ctx.headline, { level: 2, style: { size: o.size ?? "5xl", align: "center", lh: "snug", w: "l" }, anim: "up" }),
        ...(body ? [b.lede(body, { style: { align: "center", w: "m" } })] : []),
        ...btn.map((x) => ({ ...x, style: { ...(x.style ?? {}), align: "center" as const } })),
      ], { gap: "m", align: "center" }),
    ]);
  }
  return b.section({ id: o.id ?? b.id("intro"), name: "Introduction", tone: o.tone, bg: o.bg, layout: { pt: o.pt ?? "2xl", pb: o.pb ?? "xl", width: o.width ?? "wide", gap: "xl", valign: "start" } }, [
    b.col(5, [...(o.eyebrow ? [b.eyebrow(o.eyebrow)] : []), b.h2(o.title ?? ctx.headline, { style: { size: o.size ?? "5xl" }, anim: "up" })], { gap: "m" }),
    b.col(7, [...(body ? [b.lede(body, { style: { color: "ink" }, anim: "up" })] : []), ...btn], { gap: "m" }),
  ]);
}

/** A slow band of words: the owner's service names or areas, so it never says anything they didn't. */
export function wordBand(ctx: TemplateCtx, o: { id?: string; style?: "text" | "outline" | "badge"; speed?: "slow" | "normal" | "fast"; tone?: Tone; bg?: Bg; size?: "2xl" | "3xl" | "4xl" | "5xl" | "6xl" | "7xl" | "8xl"; words?: string[]; pt?: "s" | "m" | "l"; pb?: "s" | "m" | "l" } = {}): Section | null {
  const words = o.words ?? (ctx.d.marquee?.length ? ctx.d.marquee : ctx.has.areas ? ctx.d.areas! : ctx.d.services.map((s) => s.title));
  if (!words.length) return null;
  const { b } = ctx;
  return b.section({ id: o.id ?? b.id("words"), name: "Word band", tone: o.tone, bg: o.bg, layout: { pt: o.pt ?? "m", pb: o.pb ?? "m", width: "full", gutter: false } }, [
    b.col(12, [b.el("marquee", { items: words.slice(0, 10), speed: o.speed ?? "normal", style: o.style ?? "text" }, { style: { size: o.size ?? "4xl" } })]),
  ]);
}

/** Short facts about the business as a row of small badges. */
export function badgeRow(ctx: TemplateCtx, o: { id?: string; tone?: Tone; bg?: Bg; align?: "start" | "center"; items?: string[] } = {}): Section | null {
  const items = o.items ?? (ctx.has.highlights ? ctx.d.highlights! : []);
  if (!items.length) return null;
  const { b } = ctx;
  return b.section({ id: o.id ?? b.id("badges"), name: "Highlights", tone: o.tone, bg: o.bg, layout: { pt: "m", pb: "m", width: "wide" } }, [
    b.col(12, [b.group(items.slice(0, 5).map((t) => b.badge(t, { variant: "dot" })), { gap: "s", justify: o.align === "start" ? "start" : "center" })]),
  ]);
}

/** Where the business works, as a quiet list of places. */
export function areasSection(ctx: TemplateCtx, o: { id?: string; tone?: Tone; bg?: Bg; title?: string; eyebrow?: string } = {}): Section | null {
  if (!ctx.has.areas) return null;
  const { b } = ctx;
  return b.section({ id: o.id ?? b.id("areas"), name: "Areas", tone: o.tone, bg: o.bg, layout: { pt: "xl", pb: "xl", width: "wide", gap: "l", valign: "start" } }, [
    b.col(4, [b.eyebrow(o.eyebrow ?? "Where we work"), b.h2(o.title ?? "Local to you", { style: { size: "3xl" } })], { gap: "s" }),
    b.col(8, [b.group(ctx.d.areas!.slice(0, 16).map((a) => b.badge(a, { variant: "outline" })), { gap: "xs" })]),
  ]);
}

/** Team members as a section (sample content only; a real team is added by the owner). */
export function teamSection(ctx: TemplateCtx, o: HeadOpts & { id?: string; style?: "cards" | "minimal" | "circles"; cols?: "2" | "3" | "4"; bg?: Bg; images?: ImageSrc[] } = {}): Section | null {
  if (!ctx.has.team) return null;
  const { b } = ctx;
  const members = ctx.d.team!.slice(0, 8).map((m, i) => ({ name: m.name, role: m.role, photo: o.images ? o.images[i % o.images.length] : art("portrait", "light", i + 1), bio: m.bio ?? "" }));
  return b.section({ id: o.id ?? b.id("team"), name: "Team", tone: o.tone, bg: o.bg, layout: { pt: "2xl", pb: "2xl", width: "wide" } }, [
    b.col(12, [...sectionHead(ctx, { eyebrow: "The team", title: "The people you'll work with", ...o }), b.el("team", { style: o.style ?? "cards", cols: o.cols ?? "3", members }, { anim: "up" })], { gap: "l", align: o.align === "center" ? "center" : undefined }),
  ]);
}

/** Pricing plans as a section (sample content only). */
export function pricingSection(ctx: TemplateCtx, o: HeadOpts & { id?: string; bg?: Bg } = {}): Section | null {
  if (!ctx.has.pricing) return null;
  const { b } = ctx;
  const plans = ctx.d.pricing!.slice(0, 4).map((p) => ({ name: p.name, price: p.price, period: p.period ?? "", text: p.text ?? "", features: p.features, cta: { label: ctx.primaryLabel, href: ctx.primaryHref }, featured: p.featured === true }));
  return b.section({ id: o.id ?? b.id("pricing"), name: "Pricing", tone: o.tone, bg: o.bg, layout: { pt: "2xl", pb: "2xl", width: "wide" } }, [
    b.col(12, [...sectionHead(ctx, { eyebrow: "Pricing", title: "Simple, honest pricing", align: "center", ...o }), b.el("pricing", { plans, note: "" }, { anim: "up" })], { gap: "l", align: "center" }),
  ]);
}

/** A section holding one video, with a short introduction. */
export function logosStrip(ctx: TemplateCtx, o: { id?: string; tone?: Tone; bg?: Bg; names: string[]; style?: "row" | "grid" | "marquee"; label?: string }): Section | null {
  if (!ctx.sample) return null;
  const { b } = ctx;
  return b.section({ id: o.id ?? b.id("logos"), name: "Logos", tone: o.tone, bg: o.bg, layout: { pt: "l", pb: "l", width: "wide" } }, [
    b.col(12, [b.small(o.label ?? "Trusted by (sample names)", { style: { align: "center" } }), b.el("logos", { style: o.style ?? "row", grayscale: true, items: o.names.map((name) => ({ name, image: null })) }, { anim: "fade" })], { gap: "m" }),
  ]);
}
