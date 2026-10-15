// A small, typed toolkit for composing website documents in code. Templates, the section library and the editor's "add" menus all build
// their nodes with it, so every node is created through one path and always has the shape the schema expects.
import { elementDefaults, type ElementType, type IconName } from "./catalog";
import {
  LAYOUT_DEFAULTS, NO_ANIM, NO_BG, type Anim, type Bg, type Column, type Decor, type ElementNode, type Hide, type ImageSrc, type Layout, type NodeStyle, type Responsive, type Section,
} from "./doc";

export type Style = NodeStyle;
export interface ElOpts {
  style?: NodeStyle;
  anim?: Partial<Anim> | string;
  hide?: Hide;
  r?: Responsive;
  /** An explicit id, for nodes other things refer to (anchors, shared sections). */
  id?: string;
}

const PREFIX: Record<ElementType, string> = {
  heading: "hd", text: "tx", image: "im", button: "bt", group: "gr", card: "cd", icon: "ic", divider: "dv", spacer: "sp", badge: "bd", list: "ls", services: "sv", steps: "st",
  faq: "fq", testimonials: "tm", stats: "sa", logos: "lg", team: "tn", pricing: "pr", gallery: "gl", collage: "cl", video: "vd", contactInfo: "ci", social: "so", nav: "nv", logo: "lo",
  form: "fm", map: "mp", marquee: "mq",
};

const anim = (a: ElOpts["anim"]): Anim | undefined => {
  if (!a) return undefined;
  if (typeof a === "string") return { ...NO_ANIM, preset: a as Anim["preset"] };
  return { ...NO_ANIM, ...a };
};

export function createBuilder(prefix = "") {
  let n = 0;
  const id = (p: string) => `${prefix}${p}${(++n).toString(36)}`;

  const el = (type: ElementType, props: Record<string, unknown> = {}, o: ElOpts = {}, children?: ElementNode[]): ElementNode => {
    const node: ElementNode = { id: o.id ?? id(PREFIX[type]), type, props: { ...elementDefaults(type), ...props } };
    if (o.style) node.style = o.style;
    const a = anim(o.anim);
    if (a) node.anim = a;
    if (o.hide) node.hide = o.hide;
    if (o.r) node.r = o.r;
    if (children) node.children = children;
    return node;
  };

  const b = {
    id,
    el,
    heading: (text: string, o: ElOpts & { level?: 1 | 2 | 3 | 4 } = {}) => el("heading", { text, level: String(o.level ?? 2) }, o),
    h1: (text: string, o: ElOpts = {}) => el("heading", { text, level: "1" }, { ...o, style: { size: "6xl", ...(o.style ?? {}) } }),
    h2: (text: string, o: ElOpts = {}) => el("heading", { text, level: "2" }, { ...o, style: { size: "4xl", ...(o.style ?? {}) } }),
    h3: (text: string, o: ElOpts = {}) => el("heading", { text, level: "3" }, o),
    eyebrow: (text: string, o: ElOpts = {}) => el("text", { text, role: "eyebrow" }, o),
    lede: (text: string, o: ElOpts = {}) => el("text", { text, role: "lede" }, o),
    body: (text: string, o: ElOpts = {}) => el("text", { text, role: "body" }, o),
    small: (text: string, o: ElOpts = {}) => el("text", { text, role: "small" }, o),
    quote: (text: string, o: ElOpts = {}) => el("text", { text, role: "quote" }, o),
    btn: (label: string, href: string, o: ElOpts & { variant?: string; size?: "s" | "m" | "l"; icon?: string; full?: boolean; track?: string } = {}) =>
      el("button", { link: { label, href }, variant: o.variant ?? "primary", size: o.size ?? "m", icon: o.icon ?? "none", fullWidth: o.full === true, track: o.track ?? "" }, o),
    img: (src: ImageSrc, o: ElOpts & { alt?: string; aspect?: string; frame?: string; fit?: string; posX?: number; posY?: number; overlay?: string; priority?: boolean; caption?: string } = {}) =>
      el("image", { src, alt: o.alt ?? "", aspect: o.aspect ?? "4/3", frame: o.frame ?? "none", fit: o.fit ?? "cover", posX: o.posX ?? 50, posY: o.posY ?? 50, overlay: o.overlay ?? "0", priority: o.priority === true, caption: o.caption ?? "" }, o),
    icon: (name: IconName, o: ElOpts & { size?: string; shape?: string; tone?: string } = {}) => el("icon", { name, size: o.size ?? "m", shape: o.shape ?? "soft", tone: o.tone ?? "primary" }, o),
    divider: (o: ElOpts & { variant?: string; width?: string } = {}) => el("divider", { style: o.variant ?? "line", width: o.width ?? "full" }, o),
    spacer: (size: string, o: ElOpts = {}) => el("spacer", { size }, o),
    badge: (text: string, o: ElOpts & { variant?: string; icon?: string } = {}) => el("badge", { text, style: o.variant ?? "pill", icon: o.icon ?? "sparkles" }, o),
    list: (items: string[], o: ElOpts & { variant?: string; cols?: string } = {}) => el("list", { items, style: o.variant ?? "check", cols: o.cols ?? "1" }, o),
    group: (children: ElementNode[], o: ElOpts & { dir?: "row" | "col"; gap?: string; wrap?: boolean; justify?: string; items?: string } = {}) =>
      el("group", { dir: o.dir ?? "row", gap: o.gap ?? "s", wrap: o.wrap !== false, justify: o.justify ?? "start", items: o.items ?? "center" }, o, children),
    card: (children: ElementNode[], o: ElOpts & { surface?: string; pad?: string; gap?: string; hover?: string; align?: string } = {}) =>
      el("card", { surface: o.surface ?? "outlined", pad: o.pad ?? "m", gap: o.gap ?? "s", hover: o.hover ?? "none", align: o.align ?? "start" }, o, children),

    // Column and section assembly
    col: (span: number, elements: ElementNode[], o: Partial<Omit<Column, "id" | "span" | "elements">> & { id?: string } = {}): Column => ({
      id: o.id ?? id("c"), span, gap: o.gap ?? "s", pad: o.pad ?? "0", surface: o.surface ?? "none", ...o, elements,
    }),
    section: (o: { id?: string; name?: string; tone?: Section["tone"]; bg?: Bg; layout?: Partial<Layout>; decor?: Decor[]; anim?: Partial<Anim> | string; r?: Responsive; hidden?: boolean }, columns: Column[]): Section => ({
      id: o.id ?? id("s"), type: "section", name: o.name ?? "", hidden: o.hidden === true, tone: o.tone ?? "auto", bg: o.bg ?? NO_BG,
      layout: { ...LAYOUT_DEFAULTS, ...(o.layout ?? {}) }, decor: o.decor ?? [], anim: anim(o.anim) ?? NO_ANIM, ...(o.r ? { r: o.r } : {}), columns,
    }),
  };
  return b;
}
export type Builder = ReturnType<typeof createBuilder>;

export const art = (scene: string, tone: "auto" | "warm" | "cool" | "dark" | "light" = "auto", seed = 0): ImageSrc => ({ kind: "art", scene: scene as never, tone, seed });
export const asset = (id: string): ImageSrc => ({ kind: "asset", id });
