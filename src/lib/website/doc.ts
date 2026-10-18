// The website document model. A site is plain, length-limited data: pages made of sections, sections made of columns, columns made of
// elements, plus design tokens. There is no HTML, script, free-form CSS or URL scheme beyond a short allowlist anywhere in it, so a
// published site cannot carry anything executable by construction, and every style value comes from a fixed vocabulary.
import { z } from "zod";
import { ART_KEYS, ART_TONES } from "./art-keys";
import { TEMPLATE_IMAGE_IDS } from "./template-image-assets";
import { ELEMENT_DEFS, ELEMENT_TYPES, CONTAINER_TYPES, MAX_CONTAINER_DEPTH, ICONS, SPACES, type ElementType, type FieldSpec } from "./catalog";
import { FONT_KEYS, type FontKey } from "./font-keys";

export const CONTENT_SCHEMA_VERSION = 2;
/** totalBytes stays under the database's 300 KB cap on a stored document, so an oversized save is refused with a clear message instead of a database error. */
export const LIMITS = { pages: 24, sectionsPerPage: 40, columnsPerSection: 6, elementsPerColumn: 40, childrenPerContainer: 16, totalBytes: 240_000, globals: 20 } as const;
/** Paths the site runtime itself uses; a page can never take one of these slugs. */
export const RESERVED_SLUGS = new Set(["api", "admin", "_next", "__iaq", "assets", "_a", "sitemap", "robots", "favicon", "thanks", "static", "login"]);

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
export const tidy = (s: string) => s.replace(CONTROL, "").replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
const HEX = /^#[0-9a-fA-F]{6}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const NODE_ID = /^[a-z][a-z0-9-]{1,31}$/;
const E164 = /^\+[1-9][0-9]{6,14}$/;

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/** Returns a safe, normalized href or null. Only internal paths, anchors, https/http, mailto and tel pass. */
export function safeHref(raw: string): string | null {
  const v = raw.trim();
  if (v === "") return "";
  if (v.length > 300 || /[\u0000-\u001F\u007F\s]/.test(v)) return null;
  if (v.startsWith("#")) return /^#[A-Za-z0-9_-]{1,60}$/.test(v) ? v : null;
  if (v.startsWith("/")) return /^\/(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)?(?:#[A-Za-z0-9_-]{1,60})?$/.test(v) ? v : null;
  if (/^mailto:/i.test(v)) return /^mailto:[^\s@<>()[\]\\,;:]+@[^\s@<>()[\]\\,;:]+\.[^\s@<>()[\]\\,;:]{2,}$/i.test(v) ? v : null;
  if (/^tel:/i.test(v)) return /^tel:\+?[0-9][0-9().-]{4,24}$/i.test(v) ? v : null;
  if (/^https?:\/\//i.test(v)) {
    try {
      const u = new URL(v);
      if (u.username || u.password || !u.hostname.includes(".")) return null;
      return u.toString();
    } catch {
      return null;
    }
  }
  return null;
}
export const isExternalHref = (href: string) => /^https?:\/\//i.test(href);

// ---------------------------------------------------------------------------
// Vocabulary: every value a style can take
// ---------------------------------------------------------------------------

export const COLOR_TOKENS = ["primary", "accent", "bg", "surface", "surface2", "ink", "muted", "line", "dark", "light", "primarySoft", "accentSoft", "onPrimary", "onDark"] as const;
export type ColorToken = (typeof COLOR_TOKENS)[number];
export const SIZES = ["xs", "s", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl", "8xl"] as const;
export type Size = (typeof SIZES)[number];
export const LETTER_SPACINGS = ["tighter", "tight", "normal", "wide", "wider", "widest"] as const;
export const LINE_HEIGHTS = ["none", "tight", "snug", "normal", "relaxed"] as const;
export const WIDTHS = ["auto", "full", "fit", "xs", "s", "m", "l", "prose"] as const;
export const ANIM_PRESETS = ["none", "fade", "up", "down", "left", "right", "scale", "blur", "reveal", "zoom"] as const;
export const SCREENS = ["d", "t", "m"] as const;

const colorRef = z.union([z.enum(COLOR_TOKENS), z.string().regex(HEX, "Use a colour like #2C5BFF.").transform((v) => v.toLowerCase())]);
export type ColorRef = z.output<typeof colorRef>;
const space = z.enum(SPACES);
const text = (max: number) => z.string().max(max, `Keep this to ${max} characters or fewer.`).transform(tidy);
const textOr = (max: number) => text(max).default("");

const hrefSchema = z.string().default("").transform((v, ctx) => {
  const ok = safeHref(v);
  if (ok === null) {
    ctx.addIssue({ code: "custom", message: "Use a web address (https://…), an email (mailto:), a phone (tel:), a page (/about) or an anchor (#contact)." });
    return z.NEVER;
  }
  return ok;
});
const linkSchema = z.object({ label: textOr(60), href: hrefSchema }).default({ label: "", href: "" });

// Images are an owner's upload, a generated template starter, or built-in artwork.
const templateImageRef = z.object({ kind: z.literal("template"), id: z.enum(TEMPLATE_IMAGE_IDS), label: z.string().max(80).default("Starter image") });
const imageSrc = z
  .union([
    z.null(),
    templateImageRef,
    z.object({ kind: z.literal("asset"), id: z.string().regex(UUID, "Choose an image from your library."), default: templateImageRef.optional() }),
    z.object({ kind: z.literal("art"), scene: z.enum(ART_KEYS), tone: z.enum(ART_TONES).default("auto"), seed: z.number().int().min(0).max(999).default(0), default: templateImageRef.optional() }),
  ])
  .default(null);
export type ImageSrc = z.output<typeof imageSrc>;

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styleSchema = z.object({
  mt: space.optional(), mb: space.optional(), pt: space.optional(), pb: space.optional(),
  align: z.enum(["start", "center", "end"]).optional(),
  w: z.enum(WIDTHS).optional(),
  size: z.enum(SIZES).optional(),
  weight: z.number().int().min(100).max(900).optional(),
  font: z.enum(["heading", "body", "accent", "mono", ...FONT_KEYS]).optional(),
  ls: z.enum(LETTER_SPACINGS).optional(),
  lh: z.enum(LINE_HEIGHTS).optional(),
  transform: z.enum(["none", "uppercase"]).optional(),
  italic: z.boolean().optional(),
  color: colorRef.optional(),
  bg: colorRef.optional(),
  radius: z.enum(["none", "s", "m", "l", "xl", "full"]).optional(),
  border: z.enum(["none", "thin", "thick"]).optional(),
  borderColor: colorRef.optional(),
  shadow: z.enum(["none", "s", "m", "l"]).optional(),
  opacity: z.number().int().min(10).max(100).optional(),
  rotate: z.number().int().min(-12).max(12).optional(),
  hover: z.enum(["none", "lift", "scale", "glow", "underline"]).optional(),
});
export type NodeStyle = z.output<typeof styleSchema>;

/** The few properties that can differ on a tablet or a phone. */
const overrideSchema = z.object({
  mt: space.optional(), mb: space.optional(), pt: space.optional(), pb: space.optional(),
  align: z.enum(["start", "center", "end"]).optional(),
  w: z.enum(WIDTHS).optional(),
  size: z.enum(SIZES).optional(),
  ls: z.enum(LETTER_SPACINGS).optional(),
  lh: z.enum(LINE_HEIGHTS).optional(),
  span: z.number().int().min(1).max(12).optional(),
  order: z.number().int().min(-6).max(12).optional(),
  minH: z.enum(["auto", "40", "60", "75", "90", "100"]).optional(),
  gap: space.optional(),
  valign: z.enum(["start", "center", "end", "stretch"]).optional(),
  stack: z.enum(["mobile", "tablet", "never"]).optional(),
  cols: z.enum(["1", "2", "3", "4"]).optional(),
  dir: z.enum(["row", "col"]).optional(),
});
export type Override = z.output<typeof overrideSchema>;
const responsive = z.object({ t: overrideSchema.optional(), m: overrideSchema.optional() });
export type Responsive = z.output<typeof responsive>;

const hideSchema = z.object({ d: z.boolean().optional(), t: z.boolean().optional(), m: z.boolean().optional() });
export type Hide = z.output<typeof hideSchema>;

export const animSchema = z.object({
  preset: z.enum(ANIM_PRESETS).default("none"),
  delay: z.number().int().min(0).max(1500).default(0),
  speed: z.enum(["fast", "normal", "slow"]).default("normal"),
  stagger: z.boolean().default(false),
});
export type Anim = z.output<typeof animSchema>;
export const NO_ANIM: Anim = { preset: "none", delay: 0, speed: "normal", stagger: false };

// ---------------------------------------------------------------------------
// Backgrounds and decoration
// ---------------------------------------------------------------------------

const bgBaseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("color"), color: colorRef }),
  z.object({ kind: z.literal("gradient"), from: colorRef, to: colorRef, via: colorRef.optional(), angle: z.number().int().min(0).max(360).default(135) }),
  z.object({ kind: z.literal("mesh"), colors: z.array(colorRef).min(2).max(4), seed: z.number().int().min(0).max(99).default(0), base: colorRef.default("dark") }),
  z.object({ kind: z.literal("pattern"), pattern: z.enum(["grid", "dots", "lines", "diagonal", "noise", "waves", "topo"]), color: colorRef.default("line"), base: colorRef.optional(), opacity: z.number().int().min(4).max(100).default(60) }),
]);
const bgSchema = z.union([
  bgBaseSchema,
  z.object({
    kind: z.literal("image"),
    src: imageSrc,
    overlay: z.object({ color: colorRef.default("dark"), opacity: z.number().int().min(0).max(95).default(40), dir: z.enum(["flat", "bottom", "top", "left", "right", "vignette"]).default("flat") }).default({ color: "dark", opacity: 40, dir: "flat" }),
    pos: z.object({ x: z.number().int().min(0).max(100).default(50), y: z.number().int().min(0).max(100).default(50) }).default({ x: 50, y: 50 }),
    parallax: z.boolean().default(false),
    /** An optional color or pattern layer beneath a photo, used when a photo is added to a text-led hero. */
    base: bgBaseSchema.optional(),
    /** Photo strength over the underlying design layer. */
    strength: z.number().int().min(10).max(100).optional(),
  }),
]);
export type Bg = z.output<typeof bgSchema>;
export const NO_BG: Bg = { kind: "none" };

const decorSchema = z.object({
  kind: z.enum(["blob", "ring", "grid", "dots", "arc", "orb", "plus", "line"]),
  at: z.enum(["tl", "tr", "bl", "br", "c", "l", "r"]).default("tr"),
  size: z.enum(["s", "m", "l", "xl"]).default("m"),
  color: colorRef.default("primary"),
  opacity: z.number().int().min(4).max(100).default(20),
});
export type Decor = z.output<typeof decorSchema>;

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

export interface ElementNode {
  id: string;
  type: ElementType;
  props: Record<string, unknown>;
  style?: NodeStyle;
  hide?: Hide;
  anim?: Anim;
  r?: Responsive;
  /** Present on containers only. */
  children?: ElementNode[];
}

const columnShape = z.object({
  id: z.string().regex(NODE_ID, "Each column needs a short id."),
  span: z.number().int().min(1).max(12).default(12),
  valign: z.enum(["start", "center", "end", "stretch"]).optional(),
  align: z.enum(["start", "center", "end"]).optional(),
  gap: space.default("s"),
  pad: space.default("0"),
  surface: z.enum(["none", "flat", "outlined", "elevated", "tinted", "glass", "dark", "brand"]).default("none"),
  radius: z.enum(["none", "s", "m", "l", "xl", "full"]).optional(),
  bg: colorRef.optional(),
  hide: hideSchema.optional(),
  r: responsive.optional(),
  elements: z.array(z.unknown()).default([]),
});
export interface Column extends Omit<z.output<typeof columnShape>, "elements"> {
  elements: ElementNode[];
}

const layoutSchema = z.object({
  width: z.enum(["narrow", "regular", "wide", "full"]).default("regular"),
  pt: space.default("xl"),
  pb: space.default("xl"),
  gutter: z.boolean().default(true),
  minH: z.enum(["auto", "40", "60", "75", "90", "100"]).default("auto"),
  valign: z.enum(["start", "center", "end", "stretch"]).default("center"),
  gap: space.default("l"),
  stack: z.enum(["mobile", "tablet", "never"]).default("mobile"),
  reverse: z.boolean().default(false),
  /** Header only: stays at the top while scrolling. */
  sticky: z.boolean().default(false),
  /** Header only: sits over the section below it instead of pushing it down. */
  float: z.boolean().default(false),
  /** Draws the section as a rounded panel set in from the page edges. */
  inset: z.boolean().default(false),
  /** A line around a panel, or above and below a full-width section. */
  border: z.enum(["none", "thin", "bold"]).default("none"),
  /** The shadow cast by the section. It shows best on a panel. */
  shadow: z.enum(["none", "s", "m", "l"]).default("none"),
});
export type Layout = z.output<typeof layoutSchema>;
export const LAYOUT_DEFAULTS: Layout = layoutSchema.parse({});

const sectionShape = z.object({
  id: z.string().regex(NODE_ID, "Each section needs a short id."),
  type: z.literal("section"),
  name: textOr(40),
  hidden: z.boolean().default(false),
  /** Hidden on particular screens only. `hidden` hides it everywhere. */
  hide: hideSchema.optional(),
  tone: z.enum(["auto", "light", "dark", "brand", "accent"]).default("auto"),
  bg: bgSchema.default(NO_BG),
  layout: layoutSchema.default(() => layoutSchema.parse({})),
  decor: z.array(decorSchema).max(4).default([]),
  anim: animSchema.default(NO_ANIM),
  r: responsive.optional(),
  columns: z.array(z.unknown()).max(LIMITS.columnsPerSection, `A section can hold up to ${LIMITS.columnsPerSection} columns.`).default([]),
});
export interface Section extends Omit<z.output<typeof sectionShape>, "columns"> {
  columns: Column[];
}
/** A page item that points at a shared, site-wide section. Editing the shared section changes it on every page that uses it. */
export interface SectionRef {
  id: string;
  type: "ref";
  ref: string;
}
export type PageItem = Section | SectionRef;
export const isRef = (i: PageItem): i is SectionRef => i.type === "ref";

// ---------------------------------------------------------------------------
// Validation of the tree
// ---------------------------------------------------------------------------

type Ctx = z.RefinementCtx;
const issue = (ctx: Ctx, message: string, path: PropertyKey[]) => ctx.addIssue({ code: "custom", message, path });

function fieldSchema(f: FieldSpec): z.ZodTypeAny {
  switch (f.type) {
    case "text":
    case "longtext":
    case "markup": return textOr(f.max);
    case "link": return linkSchema;
    case "href": return hrefSchema;
    case "image": return imageSrc;
    case "select": return z.enum(f.options.map((o) => o.value) as [string, ...string[]]).default(f.options[0].value);
    case "toggle": return z.boolean().default(false);
    case "number": return z.number().min(f.min).max(f.max).default(f.min);
    case "color": return colorRef.default("primary");
    case "icon": return z.enum(ICONS).default("sparkles");
    case "textlist": return z.array(textOr(f.itemMax)).max(f.max, `Add up to ${f.max}.`).default([]).transform((a) => a.filter(Boolean));
    case "list": return z.array(objectSchema(f.item)).max(f.max, `Add up to ${f.max}.`).default([]);
    case "calendarRef": return slugRef("Choose a calendar from the list.");
    case "bookingTypeRef": return slugRef("Choose an appointment type from the list.");
    case "formRef": return formKeyRef;
  }
}
/** A calendar or appointment type named by its slug ("" for the default). Slugs, not ids, keep templates portable between workspaces. */
const slugRef = (message: string) => z.string().max(60, message).default("").transform((v) => v.trim()).refine((v) => v === "" || SLUG.test(v), message);
/**
 * A native CRM form named by its key (crm_forms.key); empty or absent means the built-in enquiry form. A key, not an id, keeps templates
 * portable. It has no default, so content without one (every template, every site saved before) parses to exactly what it was.
 */
const FORM_KEY = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const formKeyRef = z.string().max(60, "Choose a form from the list.").transform((v) => v.trim()).refine((v) => v === "" || FORM_KEY.test(v), "Choose a form from the list.").optional();
const objectSchema = (fields: FieldSpec[]) => z.object(Object.fromEntries(fields.map((f) => [f.key, fieldSchema(f)])));
const propSchemas = Object.fromEntries(ELEMENT_TYPES.map((t) => [t, objectSchema(ELEMENT_DEFS[t].fields)])) as Record<ElementType, z.ZodObject>;

const elementEnvelope = z.object({
  id: z.string().regex(NODE_ID, "Each element needs a short id."),
  type: z.enum(ELEMENT_TYPES),
  props: z.record(z.string(), z.unknown()).default({}),
  style: styleSchema.optional(),
  hide: hideSchema.optional(),
  anim: animSchema.optional(),
  r: responsive.optional(),
  children: z.array(z.unknown()).optional(),
});

function parseElement(raw: unknown, depth: number, ctx: Ctx, path: PropertyKey[]): ElementNode | null {
  const env = elementEnvelope.safeParse(raw);
  if (!env.success) {
    for (const i of env.error.issues) issue(ctx, i.message, [...path, ...i.path]);
    return null;
  }
  const e = env.data;
  const props = propSchemas[e.type].safeParse(e.props);
  if (!props.success) {
    for (const i of props.error.issues) issue(ctx, i.message, [...path, "props", ...i.path]);
    return null;
  }
  const out: ElementNode = { id: e.id, type: e.type, props: props.data as Record<string, unknown> };
  if (e.style && Object.keys(e.style).length) out.style = e.style;
  if (e.hide && Object.keys(e.hide).length) out.hide = e.hide;
  if (e.anim && e.anim.preset !== "none") out.anim = e.anim;
  if (e.r && (e.r.t || e.r.m)) out.r = e.r;
  if (CONTAINER_TYPES.includes(e.type)) {
    const kids = e.children ?? [];
    if (depth > MAX_CONTAINER_DEPTH) {
      issue(ctx, "Cards and rows can be nested up to three levels deep.", path);
      return null;
    }
    if (kids.length > LIMITS.childrenPerContainer) issue(ctx, `A ${ELEMENT_DEFS[e.type].label.toLowerCase()} can hold up to ${LIMITS.childrenPerContainer} items.`, [...path, "children"]);
    out.children = [];
    kids.forEach((k, i) => {
      const parsed = parseElement(k, depth + 1, ctx, [...path, "children", i]);
      if (parsed) out.children!.push(parsed);
    });
  } else if (e.children?.length) {
    issue(ctx, `${ELEMENT_DEFS[e.type].label} can't hold other elements.`, [...path, "children"]);
  }
  return out;
}

const columnSchema = columnShape.transform((c, ctx) => {
  const { elements: rawElements, ...rest } = c;
  if (rawElements.length > LIMITS.elementsPerColumn) issue(ctx, `A column can hold up to ${LIMITS.elementsPerColumn} items.`, ["elements"]);
  const elements: ElementNode[] = [];
  rawElements.forEach((e, i) => {
    const p = parseElement(e, 1, ctx, ["elements", i]);
    if (p) elements.push(p);
  });
  return { ...rest, elements } as Column;
});

const sectionSchema = sectionShape.transform((s, ctx) => {
  const { columns: rawColumns, ...rest } = s;
  const columns: Column[] = [];
  rawColumns.forEach((c, i) => {
    const parsed = columnSchema.safeParse(c);
    if (!parsed.success) for (const x of parsed.error.issues) issue(ctx, x.message, ["columns", i, ...x.path]);
    else columns.push(parsed.data);
  });
  return { ...rest, columns } as Section;
});

/** Checks one section on its own (for example a saved component) against the same rules as a section inside a page. */
export function parseSection(raw: unknown): { ok: true; section: Section } | { ok: false; error: string } {
  const r = sectionSchema.safeParse(raw);
  return r.success ? { ok: true, section: r.data } : { ok: false, error: r.error.issues[0]?.message ?? "That section isn't valid." };
}

const refSchema = z.object({ id: z.string().regex(NODE_ID), type: z.literal("ref"), ref: z.string().regex(NODE_ID) });
/** A page item is either a shared-section reference or a section. They are told apart by `type` so a mistake inside a section is reported where it is. */
const pageItemSchema = z.unknown().transform((raw, ctx): PageItem => {
  const isRefLike = typeof raw === "object" && raw !== null && (raw as { type?: unknown }).type === "ref";
  const parsed = isRefLike ? refSchema.safeParse(raw) : sectionSchema.safeParse(raw);
  if (!parsed.success) {
    for (const i of parsed.error.issues) ctx.addIssue({ code: "custom", message: i.message, path: i.path });
    return z.NEVER;
  }
  return parsed.data as PageItem;
});

const pageSchema = z.object({
  id: z.string().regex(NODE_ID, "Each page needs a short id."),
  slug: z.string().regex(SLUG, "A page address can use lowercase letters, numbers and hyphens.").max(40),
  title: text(60).refine((v) => v.length > 0, "Give the page a title."),
  kind: z.enum(["page", "landing", "thanks"]).default("page"),
  navLabel: textOr(30),
  showInNav: z.boolean().default(true),
  seoTitle: textOr(70),
  seoDescription: textOr(160),
  ogImage: imageSrc,
  noindex: z.boolean().default(false),
  items: z.array(pageItemSchema).max(LIMITS.sectionsPerPage, `A page can hold up to ${LIMITS.sectionsPerPage} sections.`),
});
export type Page = z.output<typeof pageSchema>;

// ---------------------------------------------------------------------------
// Design
// ---------------------------------------------------------------------------

const hex = z.string().regex(HEX, "Use a colour like #2C5BFF.").transform((v) => v.toLowerCase());
export const designSchema = z.object({
  mode: z.enum(["light", "dark"]).default("light"),
  colors: z.object({
    primary: hex.default("#2c5bff"), accent: hex.default("#12c9a5"), bg: hex.default("#ffffff"), surface: hex.default("#ffffff"), surface2: hex.default("#f5f6f8"),
    ink: hex.default("#0f1419"), muted: hex.default("#4b5563"), line: hex.default("#e3e6eb"), dark: hex.default("#0e1320"),
  }).default({ primary: "#2c5bff", accent: "#12c9a5", bg: "#ffffff", surface: "#ffffff", surface2: "#f5f6f8", ink: "#0f1419", muted: "#4b5563", line: "#e3e6eb", dark: "#0e1320" }),
  fonts: z.object({ heading: z.enum(FONT_KEYS as [FontKey, ...FontKey[]]).default("inter"), body: z.enum(FONT_KEYS as [FontKey, ...FontKey[]]).default("inter"), accent: z.enum(FONT_KEYS as [FontKey, ...FontKey[]]).default("inter"), mono: z.enum(FONT_KEYS as [FontKey, ...FontKey[]]).default("jetbrains") })
    .default({ heading: "inter", body: "inter", accent: "inter", mono: "jetbrains" }),
  heading: z.object({
    weight: z.number().int().min(100).max(900).default(700),
    ls: z.enum(LETTER_SPACINGS).default("tight"),
    lh: z.enum(LINE_HEIGHTS).default("tight"),
    transform: z.enum(["none", "uppercase"]).default("none"),
    /** How *emphasised* words in a heading are drawn. */
    emphasis: z.enum(["italic", "accent", "both", "underline"]).default("italic"),
  }).default({ weight: 700, ls: "tight", lh: "tight", transform: "none", emphasis: "italic" }),
  scale: z.enum(["compact", "regular", "grand", "display"]).default("regular"),
  radius: z.enum(["square", "soft", "round", "pill"]).default("soft"),
  buttons: z.object({
    style: z.enum(["solid", "outline", "gradient", "glass", "soft"]).default("solid"),
    caps: z.boolean().default(false),
    hover: z.enum(["lift", "shine", "invert", "none"]).default("lift"),
    weight: z.number().int().min(400).max(800).default(600),
  }).default({ style: "solid", caps: false, hover: "lift", weight: 600 }),
  width: z.enum(["narrow", "regular", "wide"]).default("regular"),
  spacing: z.enum(["tight", "regular", "airy", "luxe"]).default("regular"),
  shadow: z.enum(["none", "soft", "crisp", "dramatic"]).default("soft"),
  links: z.enum(["underline", "plain", "accent"]).default("underline"),
  motion: z.enum(["none", "subtle", "smooth", "dramatic"]).default("smooth"),
  grain: z.boolean().default(false),
});
export type Design = z.output<typeof designSchema>;

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

const fieldMode = z.enum(["required", "optional", "hidden"]);
const socialUrl = (hosts: string[]) =>
  z.string().default("").transform((v, ctx) => {
    const t = v.trim();
    if (!t) return "";
    try {
      const u = new URL(t);
      if (u.protocol === "https:" && hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`)) && !u.username) return u.toString();
    } catch {
      /* fall through */
    }
    ctx.addIssue({ code: "custom", message: `Use your ${hosts[0]} page address (https://…).` });
    return z.NEVER;
  });

export const contentShape = z.object({
  schemaVersion: z.literal(CONTENT_SCHEMA_VERSION).default(CONTENT_SCHEMA_VERSION),
  /** Marks the example content shown while browsing templates. Sample content can never be published. */
  isSample: z.boolean().default(false),
  /** Which template this site began as. Informational: editing the template never changes the site. */
  origin: z.object({ key: z.string().max(60).default(""), templateId: z.string().regex(UUID).nullable().default(null), version: z.number().int().min(0).default(0) }).default({ key: "", templateId: null, version: 0 }),
  business: z.object({
    name: text(120).refine((v) => v.length >= 2, "Add your business name."),
    tagline: textOr(140),
    phone: z.string().default("").transform((v, ctx) => {
      const t = v.replace(/[\s().-]/g, "");
      if (!t) return "";
      if (!E164.test(t)) {
        ctx.addIssue({ code: "custom", message: "Enter the phone number with its country code, like +1 512 555 0100." });
        return z.NEVER;
      }
      return t;
    }),
    email: z.string().default("").transform((v, ctx) => {
      const t = v.trim().toLowerCase();
      if (!t) return "";
      if (t.length > 320 || !/^[^\s@<>()[\]\\,;:]+@[^\s@<>()[\]\\,;:]+\.[^\s@<>()[\]\\,;:]{2,}$/.test(t)) {
        ctx.addIssue({ code: "custom", message: "That email address doesn't look right." });
        return z.NEVER;
      }
      return t;
    }),
    address: textOr(200),
    hours: textOr(300),
    areas: z.array(text(60)).max(30).default([]).transform((a) => a.filter(Boolean)),
  }),
  brand: z.object({ logoAssetId: z.union([z.string().regex(UUID, "Choose an image from your library."), z.null()]).default(null), logoVariant: z.enum(["original", "processed"]).default("original") }).default({ logoAssetId: null, logoVariant: "original" }),
  design: designSchema.default(() => designSchema.parse({})),
  seo: z.object({ title: textOr(70), description: textOr(160), ogImage: imageSrc, noindex: z.boolean().default(false) }).default({ title: "", description: "", ogImage: null, noindex: false }),
  social: z.object({
    facebook: socialUrl(["facebook.com"]), instagram: socialUrl(["instagram.com"]), linkedin: socialUrl(["linkedin.com"]),
    x: socialUrl(["x.com", "twitter.com"]), youtube: socialUrl(["youtube.com"]), tiktok: socialUrl(["tiktok.com"]),
  }).default({ facebook: "", instagram: "", linkedin: "", x: "", youtube: "", tiktok: "" }),
  form: z.object({
    enabled: z.boolean().default(true),
    fields: z.object({ phone: fieldMode.default("optional"), message: fieldMode.default("required"), service: fieldMode.default("hidden") }).default({ phone: "optional", message: "required", service: "hidden" }),
    services: z.array(text(60)).max(12).default([]).transform((a) => a.filter(Boolean)),
    successMessage: textOr(200).transform((v) => v || "Thanks. We've received your message and will be in touch."),
    consentText: textOr(240).transform((v) => v || "I agree to be contacted about my enquiry."),
    marketingOptIn: z.boolean().default(false),
    marketingText: textOr(240).transform((v) => v || "Send me occasional updates and offers."),
  }).default(() => ({ enabled: true, fields: { phone: "optional" as const, message: "required" as const, service: "hidden" as const }, services: [], successMessage: "Thanks. We've received your message and will be in touch.", consentText: "I agree to be contacted about my enquiry.", marketingOptIn: false, marketingText: "Send me occasional updates and offers." })),
  header: sectionSchema.nullable().default(null),
  footer: sectionSchema.nullable().default(null),
  /** Shared sections, referenced from any page. */
  globals: z.record(z.string().regex(NODE_ID), sectionSchema).default({}),
  pages: z.array(pageSchema).min(1, "A website needs at least one page.").max(LIMITS.pages, `A website can have up to ${LIMITS.pages} pages.`),
});

export type SiteContent = z.output<typeof contentShape>;
export type SitePage = Page;

// ---------------------------------------------------------------------------
// Validation entry point
// ---------------------------------------------------------------------------

export type ContentResult = { ok: true; content: SiteContent } | { ok: false; error: string; path: string };

const pathLabel = (path: PropertyKey[]) => path.map((p) => (typeof p === "number" ? `#${p + 1}` : String(p))).join(" › ");

/** Every node id in a document, in order. */
export function collectIds(c: SiteContent): string[] {
  const ids: string[] = [];
  const el = (e: ElementNode) => {
    ids.push(e.id);
    e.children?.forEach(el);
  };
  const sec = (s: Section) => {
    ids.push(s.id);
    s.columns.forEach((col) => {
      ids.push(col.id);
      col.elements.forEach(el);
    });
  };
  if (c.header) sec(c.header);
  if (c.footer) sec(c.footer);
  Object.values(c.globals).forEach(sec);
  for (const p of c.pages) {
    ids.push(p.id);
    p.items.forEach((i) => (isRef(i) ? ids.push(i.id) : sec(i)));
  }
  return ids;
}

/** Parses and normalizes arbitrary input into a valid document, or explains the first problem in plain language. Older (version 1) content is upgraded first. */
export function parseContent(input: unknown, upgrade?: (legacy: unknown) => unknown): ContentResult {
  const size = (() => {
    try {
      return JSON.stringify(input)?.length ?? 0;
    } catch {
      return Infinity;
    }
  })();
  if (size > LIMITS.totalBytes) return { ok: false, error: "This site is too large. Remove some content or images.", path: "" };
  let source = input;
  if (isLegacy(input)) {
    if (!upgrade) return { ok: false, error: "This site was saved in an older format.", path: "" };
    source = upgrade(input);
  }
  const parsed = contentShape.safeParse(source);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return { ok: false, error: i.message, path: pathLabel(i.path) };
  }
  const content = parsed.data;
  const slugs = new Set<string>();
  for (const [i, page] of content.pages.entries()) {
    if (RESERVED_SLUGS.has(page.slug)) return { ok: false, error: `"${page.slug}" is reserved. Choose a different page address.`, path: `pages › #${i + 1} › slug` };
    if (slugs.has(page.slug)) return { ok: false, error: `Two pages use the address "${page.slug}".`, path: `pages › #${i + 1} › slug` };
    slugs.add(page.slug);
    for (const [j, item] of page.items.entries()) {
      if (isRef(item) && !content.globals[item.ref]) return { ok: false, error: "A page uses a shared section that no longer exists.", path: `pages › #${i + 1} › items › #${j + 1}` };
    }
  }
  if (!slugs.has("home")) return { ok: false, error: "Your site needs a home page.", path: "pages" };
  const seen = new Set<string>();
  for (const id of collectIds(content)) {
    if (seen.has(id)) return { ok: false, error: "Two items share the same id.", path: id };
    seen.add(id);
  }
  return { ok: true, content };
}

export function isLegacy(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  const v = (input as { schemaVersion?: unknown }).schemaVersion;
  return v === 1 || (v === undefined && Array.isArray((input as { pages?: Array<{ sections?: unknown }> }).pages) && Boolean((input as { pages: Array<{ sections?: unknown }> }).pages[0]?.sections));
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export const homePage = (c: SiteContent): SitePage => c.pages.find((p) => p.slug === "home") ?? c.pages[0];
export const pagePath = (slug: string) => (slug === "home" ? "/" : `/${slug}`);
export const findPage = (c: SiteContent, slug: string) => c.pages.find((p) => p.slug === slug) ?? null;

/** The section a page item draws: itself, or the shared section it points at. */
export const resolveItem = (c: SiteContent, item: PageItem): Section | null => (isRef(item) ? (c.globals[item.ref] ?? null) : item);

export function eachElement(c: SiteContent, visit: (e: ElementNode, where: string) => void) {
  const walk = (list: ElementNode[], where: string) =>
    list.forEach((e) => {
      visit(e, where);
      if (e.children) walk(e.children, where);
    });
  const sec = (s: Section, where: string) => s.columns.forEach((col) => walk(col.elements, where));
  if (c.header) sec(c.header, "Header");
  if (c.footer) sec(c.footer, "Footer");
  Object.entries(c.globals).forEach(([id, s]) => sec(s, s.name ? `Shared section “${s.name}”` : `Shared section ${id}`));
  for (const p of c.pages) p.items.forEach((i) => !isRef(i) && sec(i, p.title));
}

const uuidOf = (src: ImageSrc): string | null => (src && src.kind === "asset" ? src.id.toLowerCase() : null);

/** Every uploaded image a site references, so a publication copies exactly those and nothing else. Built-in artwork needs no copy. */
export function referencedAssetIds(c: SiteContent): string[] {
  const ids = new Set<string>();
  const add = (src: ImageSrc) => {
    const id = uuidOf(src);
    if (id) ids.add(id);
  };
  const addProps = (fields: FieldSpec[], data: unknown) => {
    if (!data || typeof data !== "object") return;
    const rec = data as Record<string, unknown>;
    for (const f of fields) {
      const v = rec[f.key];
      if (f.type === "image") add(v as ImageSrc);
      else if (f.type === "list" && Array.isArray(v)) for (const row of v) addProps(f.item, row);
    }
  };
  if (c.brand.logoAssetId) ids.add(c.brand.logoAssetId.toLowerCase());
  add(c.seo.ogImage);
  for (const p of c.pages) add(p.ogImage);
  const secBg = (s: Section) => {
    if (s.bg.kind === "image") add(s.bg.src);
  };
  if (c.header) secBg(c.header);
  if (c.footer) secBg(c.footer);
  Object.values(c.globals).forEach(secBg);
  for (const p of c.pages) p.items.forEach((i) => !isRef(i) && secBg(i));
  eachElement(c, (e) => addProps(ELEMENT_DEFS[e.type].fields, e.props));
  return [...ids];
}

/** Whether any built-in illustration (a stand-in for a photograph) is still in use. Used to stop a site going live with pictures that aren't the owner's. */
export function illustrationScenes(c: SiteContent, kindOf: (scene: string) => "illustration" | "decorative"): Array<{ where: string; scene: string }> {
  const found: Array<{ where: string; scene: string }> = [];
  const check = (src: ImageSrc, where: string) => {
    if (src && src.kind === "art" && kindOf(src.scene) === "illustration") found.push({ where, scene: src.scene });
  };
  const addProps = (fields: FieldSpec[], data: unknown, where: string) => {
    if (!data || typeof data !== "object") return;
    const rec = data as Record<string, unknown>;
    for (const f of fields) {
      const v = rec[f.key];
      if (f.type === "image") check(v as ImageSrc, where);
      else if (f.type === "list" && Array.isArray(v)) for (const row of v) addProps(f.item, row, where);
    }
  };
  const secBg = (s: Section, where: string) => {
    if (s.bg.kind === "image") check(s.bg.src, where);
  };
  if (c.header) secBg(c.header, "Header");
  if (c.footer) secBg(c.footer, "Footer");
  for (const p of c.pages) p.items.forEach((i) => !isRef(i) && secBg(i, p.title));
  eachElement(c, (e, where) => addProps(ELEMENT_DEFS[e.type].fields, e.props, where));
  return found;
}
