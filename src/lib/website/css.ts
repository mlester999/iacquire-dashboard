// Turns a site's design tokens and each node's validated style into CSS. Nothing here reads free-form text: every value comes from a
// fixed vocabulary or a validated hex colour, so the stylesheet cannot carry anything an owner typed. Responsive rules use container
// queries on the site's own root, so a narrow editor frame, a thumbnail and a real phone all break at exactly the same widths.
import { contrast, ensureContrast, ensureContrastAll, mix, readableOn } from "./color";
import { SPACES } from "./catalog";
import type { Bg, Column, ColorRef, Design, ElementNode, NodeStyle, Override, Section, SiteContent, SitePage } from "./doc";
import { resolveItem } from "./doc";
import { FONTS, type FontKey } from "./font-keys";

export const BREAKPOINT = { tablet: 1023, mobile: 639 } as const;
const Q_TABLET = `@container (max-width:${BREAKPOINT.tablet}px)`;
const Q_MOBILE = `@container (max-width:${BREAKPOINT.mobile}px)`;
const Q_DESKTOP_ONLY = `@container (min-width:${BREAKPOINT.tablet + 1}px)`;
const Q_TABLET_ONLY = `@container (min-width:${BREAKPOINT.mobile + 1}px) and (max-width:${BREAKPOINT.tablet}px)`;

// ---------------------------------------------------------------------------
// Scales
// ---------------------------------------------------------------------------

const SPACE_VALUE: Record<(typeof SPACES)[number], string> = {
  "0": "0px",
  xs: ".5rem",
  s: "1rem",
  m: "1.75rem",
  l: "clamp(2rem,4.6cqw,3.5rem)",
  xl: "clamp(2.75rem,6.4cqw,5.25rem)",
  "2xl": "clamp(3.75rem,9.2cqw,7.75rem)",
  "3xl": "clamp(5rem,13.5cqw,11rem)",
};
const SPACING_FACTOR: Record<Design["spacing"], number> = { tight: 0.78, regular: 1, airy: 1.16, luxe: 1.38 };
const SIZE_VALUE: Record<string, string> = {
  xs: ".75rem",
  s: ".875rem",
  base: "1rem",
  lg: "1.125rem",
  xl: "clamp(1.15rem,1.2cqw + .85rem,1.35rem)",
  "2xl": "clamp(1.35rem,2cqw + .8rem,1.75rem)",
  "3xl": "clamp(1.55rem,3cqw + .75rem,2.3rem)",
  "4xl": "clamp(1.85rem,4.2cqw + .6rem,3rem)",
  "5xl": "clamp(2.1rem,5.6cqw + .55rem,3.9rem)",
  "6xl": "clamp(2.4rem,7.2cqw + .5rem,5rem)",
  "7xl": "clamp(2.65rem,9.4cqw + .4rem,6.5rem)",
  "8xl": "clamp(2.9rem,12.5cqw,8.5rem)",
};
const SCALE_FACTOR: Record<Design["scale"], number> = { compact: 0.88, regular: 1, grand: 1.12, display: 1.28 };
const LS: Record<string, string> = { tighter: "-.045em", tight: "-.022em", normal: "0", wide: ".04em", wider: ".1em", widest: ".2em" };
const LH: Record<string, string> = { none: "1", tight: "1.08", snug: "1.25", normal: "1.5", relaxed: "1.7" };
const WIDTH: Record<string, string> = { auto: "none", full: "100%", fit: "fit-content", xs: "20rem", s: "28rem", m: "40rem", l: "52rem", prose: "62ch" };
const RADIUS_NODE: Record<string, string> = { none: "0", s: "6px", m: "12px", l: "20px", xl: "32px", full: "9999px" };
const SHADOW_NODE: Record<string, string> = { none: "none", s: "var(--sh-s)", m: "var(--sh-m)", l: "var(--sh-l)" };
const MIN_H: Record<string, string> = { auto: "0px", "40": "calc(var(--vh) * .4)", "60": "calc(var(--vh) * .6)", "75": "calc(var(--vh) * .75)", "90": "calc(var(--vh) * .9)", "100": "var(--vh)" };
const VALIGN: Record<string, string> = { start: "start", center: "center", end: "end", stretch: "stretch" };
const ALIGN_SELF: Record<string, string> = { start: "flex-start", center: "center", end: "flex-end" };
const SECTION_WIDTH: Record<Design["width"], Record<string, string>> = {
  narrow: { narrow: "42rem", regular: "62rem", wide: "74rem", full: "none" },
  regular: { narrow: "46rem", regular: "72rem", wide: "84rem", full: "none" },
  wide: { narrow: "50rem", regular: "80rem", wide: "92rem", full: "none" },
};
const space = (s: string) => `var(--sp-${s})`;

// ---------------------------------------------------------------------------
// Colour references
// ---------------------------------------------------------------------------

/** A colour used as a fill (a background, a border, a shape). */
export function fillColor(ref: ColorRef): string {
  switch (ref) {
    case "primary": return "var(--p)";
    case "accent": return "var(--a)";
    case "bg": return "var(--bg)";
    case "surface": return "var(--surface)";
    case "surface2": return "var(--surface2)";
    case "ink": return "var(--ink)";
    case "muted": return "var(--muted)";
    case "line": return "var(--line)";
    case "dark": return "var(--c-dark)";
    case "light": return "#ffffff";
    case "primarySoft": return "var(--p-soft)";
    case "accentSoft": return "var(--a-soft)";
    case "onPrimary": return "var(--on-p)";
    case "onDark": return "var(--c-on-dark)";
    default: return ref;
  }
}
/** A colour used for text: brand colours are swapped for the readable shade on the surface they sit on. */
export function textColor(ref: ColorRef): string {
  if (ref === "primary") return "var(--p-text)";
  if (ref === "accent") return "var(--a-text)";
  return fillColor(ref);
}

// ---------------------------------------------------------------------------
// Palettes
// ---------------------------------------------------------------------------

interface PaletteSet {
  bg: string; surface: string; surface2: string; ink: string; muted: string; line: string;
  /** Brand colours as drawn on this surface. */
  p: string; onP: string; pText: string; pSoft: string; a: string; onA: string; aText: string; aSoft: string; dark: boolean;
}

function build(bg: string, surface: string, surface2: string, ink: string, muted: string, line: string, primary: string, accent: string): PaletteSet {
  const isDark = luminanceOf(bg) < 0.25;
  const p = isDark ? ensureContrast(primary, bg, 3) : primary;
  const a = isDark ? ensureContrast(accent, bg, 3) : accent;
  return {
    bg, surface, surface2, ink, muted: ensureContrast(muted, bg, 4.5), line,
    p, onP: readableOn(p), pText: ensureContrastAll(primary, [bg, surface, surface2], 4.5), pSoft: mix(bg, primary, isDark ? 0.22 : 0.1),
    a, onA: readableOn(a), aText: ensureContrastAll(accent, [bg, surface, surface2], 4.5), aSoft: mix(bg, accent, isDark ? 0.22 : 0.12), dark: isDark,
  };
}
const luminanceOf = (hex: string) => {
  const [r, g, b] = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map((h) => parseInt(h, 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};

export function paletteFor(design: Design, tone: Section["tone"]): PaletteSet {
  const c = design.colors;
  const lightSet = () =>
    design.mode === "light"
      ? build(c.bg, c.surface, c.surface2, c.ink, c.muted, c.line, c.primary, c.accent)
      : build("#faf8f4", "#ffffff", "#f1ede5", "#15171d", "#585f6b", "#e3ddd2", c.primary, c.accent);
  const darkSet = () => {
    if (design.mode === "dark") return build(c.bg, c.surface, c.surface2, c.ink, c.muted, c.line, c.primary, c.accent);
    const bg = c.dark;
    const on = mix("#ffffff", bg, 0.05);
    return build(bg, mix(bg, "#ffffff", 0.06), mix(bg, "#ffffff", 0.1), on, mix(on, bg, 0.32), mix(bg, "#ffffff", 0.17), c.primary, c.accent);
  };
  switch (tone) {
    case "dark": return darkSet();
    case "light": return lightSet();
    case "brand": {
      const bg = c.primary;
      const on = readableOn(bg);
      const light = on === "#ffffff";
      const set = build(bg, mix(bg, light ? "#ffffff" : "#000000", 0.1), mix(bg, light ? "#ffffff" : "#000000", 0.18), on, mix(on, bg, 0.22), mix(bg, on, 0.28), on, c.accent);
      return { ...set, p: on, onP: bg, pText: on, pSoft: mix(bg, on, 0.14), a: c.accent, onA: readableOn(c.accent) };
    }
    case "accent": {
      const bg = c.accent;
      const on = readableOn(bg);
      const light = on === "#ffffff";
      const set = build(bg, mix(bg, light ? "#ffffff" : "#000000", 0.1), mix(bg, light ? "#ffffff" : "#000000", 0.18), on, mix(on, bg, 0.22), mix(bg, on, 0.28), on, c.primary);
      return { ...set, p: on, onP: bg, pText: on, pSoft: mix(bg, on, 0.14), a: c.primary, onA: readableOn(c.primary) };
    }
    default: return design.mode === "dark" ? darkSet() : lightSet();
  }
}

function paletteVars(p: PaletteSet): string {
  return `--bg:${p.bg};--surface:${p.surface};--surface2:${p.surface2};--ink:${p.ink};--muted:${p.muted};--line:${p.line};--p:${p.p};--on-p:${p.onP};--p-text:${p.pText};--p-soft:${p.pSoft};--a:${p.a};--on-a:${p.onA};--a-text:${p.aText};--a-soft:${p.aSoft};`;
}

// ---------------------------------------------------------------------------
// Root rules
// ---------------------------------------------------------------------------

const RADIUS_BASE: Record<Design["radius"], [string, string, string]> = { square: ["2px", "4px", "2px"], soft: ["10px", "16px", "10px"], round: ["18px", "28px", "14px"], pill: ["24px", "36px", "9999px"] };
const SHADOW_SETS: Record<Design["shadow"], [string, string, string]> = {
  none: ["none", "none", "none"],
  soft: ["0 1px 2px rgb(16 24 40 / .05),0 4px 14px -6px rgb(16 24 40 / .12)", "0 2px 4px rgb(16 24 40 / .05),0 14px 32px -14px rgb(16 24 40 / .2)", "0 4px 8px rgb(16 24 40 / .06),0 30px 60px -24px rgb(16 24 40 / .28)"],
  crisp: ["0 1px 0 rgb(16 24 40 / .08)", "0 2px 0 rgb(16 24 40 / .1),0 10px 20px -12px rgb(16 24 40 / .2)", "0 3px 0 rgb(16 24 40 / .12),0 22px 40px -20px rgb(16 24 40 / .3)"],
  dramatic: ["0 2px 6px rgb(0 0 0 / .1),0 10px 24px -8px rgb(0 0 0 / .25)", "0 6px 14px rgb(0 0 0 / .12),0 28px 50px -16px rgb(0 0 0 / .4)", "0 12px 24px rgb(0 0 0 / .14),0 50px 90px -24px rgb(0 0 0 / .5)"],
};

const fontVar = (k: string) => `var(${FONTS[k as FontKey].variable}),${FONTS[k as FontKey].fallback}`;

/** The CSS custom properties for a site's design. They sit on the site's root element. */
export function rootCss(design: Design): string {
  const base = paletteFor(design, "auto");
  const r = RADIUS_BASE[design.radius];
  const sh = SHADOW_SETS[design.shadow];
  const sp = SPACING_FACTOR[design.spacing];
  const ts = SCALE_FACTOR[design.scale];
  const c = design.colors;
  const sizes = Object.entries(SIZE_VALUE).map(([k, v]) => `--fs-${k}:${v};`).join("");
  const spaces = SPACES.map((s) => `--sp-${s}:${s === "0" ? "0px" : `calc(${SPACE_VALUE[s]} * ${sp})`};`).join("");
  const hw = design.heading;
  const dark = paletteFor(design, "dark");
  return (
    `.iq-site{${paletteVars(base)}` +
    `--c-dark:${dark.bg};--c-on-dark:${dark.ink};--c-primary:${c.primary};--c-accent:${c.accent};` +
    `--f-h:${fontVar(design.fonts.heading)};--f-b:${fontVar(design.fonts.body)};--f-a:${fontVar(design.fonts.accent)};--f-m:${fontVar(design.fonts.mono)};` +
    `--hw:${hw.weight};--hls:${LS[hw.ls]};--hlh:${LH[hw.lh]};--htt:${hw.transform};--ts:${ts};` +
    `--r:${r[0]};--r-lg:${r[1]};--r-btn:${r[2]};--sh-s:${sh[0]};--sh-m:${sh[1]};--sh-l:${sh[2]};` +
    `--bw:${design.buttons.weight};--gut:clamp(1.25rem,4.6cqw,3.25rem);${sizes}${spaces}}` +
    (["dark", "light", "brand", "accent"] as const).map((t) => `.iq-site [data-tone="${t}"]{${paletteVars(paletteFor(design, t))}}`).join("")
  );
}

// ---------------------------------------------------------------------------
// Declarations for a node's own style
// ---------------------------------------------------------------------------

const sizeValue = (s: string) => {
  const big = ["3xl", "4xl", "5xl", "6xl", "7xl", "8xl"].includes(s);
  return big ? `calc(var(--fs-${s}) * var(--ts))` : `var(--fs-${s})`;
};

/** CSS declarations for the style keys that may be set on any node. */
export function styleDecls(st: Partial<NodeStyle> & Partial<Override>, opts: { box?: boolean } = {}): string {
  const d: string[] = [];
  if (st.mt) d.push(`margin-top:${space(st.mt)}`);
  if (st.mb) d.push(`margin-bottom:${space(st.mb)}`);
  if (st.pt) d.push(`padding-top:${space(st.pt)}`);
  if (st.pb) d.push(`padding-bottom:${space(st.pb)}`);
  if (st.align) {
    d.push(`text-align:${st.align === "start" ? "left" : st.align === "end" ? "right" : "center"}`);
    d.push(`align-self:${ALIGN_SELF[st.align]}`);
    if (st.align === "center" && !st.w) d.push("margin-inline:auto");
  }
  if (st.w) {
    d.push(`max-width:${WIDTH[st.w]}`);
    if (st.w === "full") d.push("width:100%");
    if (st.w !== "auto" && st.w !== "full" && st.align === "center") d.push("margin-inline:auto");
    if (st.w !== "auto" && st.w !== "full" && st.align === "end") d.push("margin-inline-start:auto");
  }
  if (st.size) d.push(`font-size:${sizeValue(st.size)}`);
  if (st.weight) d.push(`font-weight:${st.weight}`);
  if (st.font) d.push(`font-family:var(--f-${st.font === "heading" ? "h" : st.font === "body" ? "b" : st.font === "accent" ? "a" : "m"})`);
  if (st.ls) d.push(`letter-spacing:${LS[st.ls]}`);
  if (st.lh) d.push(`line-height:${LH[st.lh]}`);
  if (st.transform) d.push(`text-transform:${st.transform}`);
  if (st.italic !== undefined) d.push(`font-style:${st.italic ? "italic" : "normal"}`);
  if (st.color) d.push(`color:${textColor(st.color)}`);
  if (opts.box !== false) {
    if (st.bg) d.push(`background-color:${fillColor(st.bg)}`);
    if (st.radius) d.push(`border-radius:${RADIUS_NODE[st.radius]}`);
    if (st.border && st.border !== "none") d.push(`border:${st.border === "thin" ? 1 : 3}px solid ${st.borderColor ? fillColor(st.borderColor) : "var(--line)"}`);
    if (st.shadow) d.push(`box-shadow:${SHADOW_NODE[st.shadow]}`);
    if (st.opacity !== undefined) d.push(`opacity:${st.opacity / 100}`);
    if (st.rotate) d.push(`rotate:${st.rotate}deg`);
  }
  return d.join(";");
}

// ---------------------------------------------------------------------------
// Per-node rules
// ---------------------------------------------------------------------------

interface Out {
  base: string[];
  tablet: string[];
  mobile: string[];
  desktopOnly: string[];
  tabletOnly: string[];
}
const rule = (sel: string, decls: string) => (decls ? `${sel}{${decls}}` : "");
const cls = (id: string) => `.x-${id}`;

function pushHide(out: Out, id: string, hide?: { d?: boolean; t?: boolean; m?: boolean }) {
  if (!hide) return;
  const s = `${cls(id)}{display:none!important}`;
  if (hide.d) out.desktopOnly.push(s);
  if (hide.t) out.tabletOnly.push(s);
  if (hide.m) out.mobile.push(s);
}

function elementRules(el: ElementNode, out: Out) {
  const sel = cls(el.id);
  if (el.style) out.base.push(rule(sel, styleDecls(el.style)));
  if (el.r?.t) out.tablet.push(rule(sel, styleDecls(el.r.t, { box: false })));
  if (el.r?.m) out.mobile.push(rule(sel, styleDecls(el.r.m, { box: false })));
  // Group direction can change per screen: a row of buttons that stacks on a phone.
  if (el.type === "group") {
    if (el.r?.t?.dir) out.tablet.push(rule(sel, `flex-direction:${el.r.t.dir === "col" ? "column" : "row"}`));
    if (el.r?.m?.dir) out.mobile.push(rule(sel, `flex-direction:${el.r.m.dir === "col" ? "column" : "row"}`));
  }
  if (el.r?.t?.cols) out.tablet.push(rule(sel, `--cols:${el.r.t.cols}`));
  if (el.r?.m?.cols) out.mobile.push(rule(sel, `--cols:${el.r.m.cols}`));
  pushHide(out, el.id, el.hide);
  el.children?.forEach((k) => elementRules(k, out));
}

function columnRules(col: Column, index: number, count: number, sec: Section, out: Out) {
  const sel = cls(col.id);
  const stack = sec.layout.stack;
  const desktop = col.span;
  const tablet = col.r?.t?.span ?? (stack === "tablet" ? 12 : desktop);
  const mobile = col.r?.m?.span ?? (stack === "never" ? tablet : 12);
  const decl = [`grid-column:span ${desktop}`];
  if (col.valign) decl.push(`align-self:${VALIGN[col.valign]}`);
  if (col.align) decl.push(`text-align:${col.align === "start" ? "left" : col.align === "end" ? "right" : "center"}`);
  decl.push(`--cg:${space(col.gap)}`, `--cp:${space(col.pad)}`);
  if (col.bg) decl.push(`background-color:${fillColor(col.bg)}`);
  if (col.radius) decl.push(`border-radius:${RADIUS_NODE[col.radius]}`);
  if (sec.layout.reverse && stack === "never") decl.push(`order:${count - 1 - index}`);
  out.base.push(rule(sel, decl.join(";")));
  const t: string[] = [];
  const m: string[] = [];
  if (tablet !== desktop) t.push(`grid-column:span ${tablet}`);
  if (mobile !== tablet) m.push(`grid-column:span ${mobile}`);
  // When columns stack, "reverse" shows them last-first.
  if (sec.layout.reverse && stack === "tablet") t.push(`order:${count - 1 - index}`);
  if (sec.layout.reverse && stack === "mobile") m.push(`order:${count - 1 - index}`);
  if (col.r?.t?.order !== undefined) t.push(`order:${col.r.t.order}`);
  if (col.r?.m?.order !== undefined) m.push(`order:${col.r.m.order}`);
  if (col.r?.t?.valign) t.push(`align-self:${VALIGN[col.r.t.valign]}`);
  if (col.r?.m?.valign) m.push(`align-self:${VALIGN[col.r.m.valign]}`);
  if (col.r?.t?.gap) t.push(`--cg:${space(col.r.t.gap)}`);
  if (col.r?.m?.gap) m.push(`--cg:${space(col.r.m.gap)}`);
  if (col.r?.t?.pt || col.r?.t?.pb) t.push(`--cp:${space(col.r.t.pt ?? col.pad)}`);
  if (col.r?.m?.pt || col.r?.m?.pb) m.push(`--cp:${space(col.r.m.pt ?? col.pad)}`);
  out.tablet.push(rule(sel, t.join(";")));
  out.mobile.push(rule(sel, m.join(";")));
  pushHide(out, col.id, col.hide);
  col.elements.forEach((e) => elementRules(e, out));
}

function sectionRules(sec: Section, design: Design, out: Out) {
  const sel = cls(sec.id);
  const l = sec.layout;
  const decl = [
    `--w:${SECTION_WIDTH[design.width][l.width]}`, `--pt:${space(l.pt)}`, `--pb:${space(l.pb)}`, `--mh:${MIN_H[l.minH]}`, `--gap:${space(l.gap)}`, `--va:${VALIGN[l.valign]}`,
    `--gut-x:${l.gutter ? "var(--gut)" : "0px"}`,
  ];
  out.base.push(rule(sel, decl.join(";")));
  const screen = (o: Out["tablet"], r: NonNullable<Section["r"]>["t"]) => {
    if (!r) return;
    const d: string[] = [];
    if (r.pt) d.push(`--pt:${space(r.pt)}`);
    if (r.pb) d.push(`--pb:${space(r.pb)}`);
    if (r.minH) d.push(`--mh:${MIN_H[r.minH]}`);
    if (r.gap) d.push(`--gap:${space(r.gap)}`);
    if (r.valign) d.push(`--va:${VALIGN[r.valign]}`);
    o.push(rule(sel, d.join(";")));
  };
  screen(out.tablet, sec.r?.t);
  screen(out.mobile, sec.r?.m);
  sec.columns.forEach((c, i) => columnRules(c, i, sec.columns.length, sec, out));
}

/** The stylesheet for one rendered page: design tokens plus a rule for each node that departs from its defaults. */
export function siteCss(content: SiteContent, page: SitePage, extra: { header?: boolean; footer?: boolean } = {}): string {
  const out: Out = { base: [], tablet: [], mobile: [], desktopOnly: [], tabletOnly: [] };
  const design = content.design;
  if (content.header && extra.header !== false) sectionRules(content.header, design, out);
  if (content.footer && extra.footer !== false) sectionRules(content.footer, design, out);
  for (const item of page.items) {
    const s = resolveItem(content, item);
    if (s) sectionRules(s, design, out);
  }
  const block = (q: string, list: string[]) => {
    const body = list.filter(Boolean).join("");
    return body ? `${q}{${body}}` : "";
  };
  return [
    rootCss(design),
    out.base.filter(Boolean).join(""),
    block(Q_TABLET, out.tablet),
    block(Q_MOBILE, out.mobile),
    block(Q_DESKTOP_ONLY, out.desktopOnly),
    block(Q_TABLET_ONLY, out.tabletOnly),
  ].join("");
}

// ---------------------------------------------------------------------------
// Backgrounds (used by the section renderer)
// ---------------------------------------------------------------------------

/** A tiny deterministic generator, so a "mesh" background looks the same every time it is drawn. */
function seeded(seed: number) {
  let s = (seed + 1) * 2654435761;
  return () => {
    s = (s ^ (s << 13)) >>> 0;
    s = (s ^ (s >>> 17)) >>> 0;
    s = (s ^ (s << 5)) >>> 0;
    return (s % 10000) / 10000;
  };
}

/** The CSS `background` value for gradient, mesh and pattern backgrounds. Colours are references, never raw input. */
export function bgCss(bg: Bg): { background?: string; backgroundColor?: string; backgroundSize?: string } {
  switch (bg.kind) {
    case "color": return { backgroundColor: fillColor(bg.color) };
    case "gradient": {
      const stops = [fillColor(bg.from), ...(bg.via ? [fillColor(bg.via)] : []), fillColor(bg.to)].join(",");
      return { background: `linear-gradient(${bg.angle}deg,${stops})` };
    }
    case "mesh": {
      const rnd = seeded(bg.seed);
      const layers = bg.colors.map((c, i) => {
        const x = Math.round(10 + rnd() * 80);
        const y = Math.round(10 + rnd() * 80);
        const spread = 44 + Math.round(rnd() * 22);
        return `radial-gradient(${60 + i * 4}% ${spread + 16}% at ${x}% ${y}%,${fillColor(c)} 0,transparent ${spread + 18}%)`;
      });
      return { background: `${layers.join(",")},${fillColor(bg.base)}` };
    }
    case "pattern": {
      const col = `color-mix(in srgb,${fillColor(bg.color)} ${bg.opacity}%,transparent)`;
      const base = bg.base ? fillColor(bg.base) : "transparent";
      switch (bg.pattern) {
        case "grid": return { background: `linear-gradient(${col} 1px,transparent 1px),linear-gradient(90deg,${col} 1px,transparent 1px),${base}`, backgroundSize: "44px 44px" };
        case "dots": return { background: `radial-gradient(${col} 1.4px,transparent 1.6px),${base}`, backgroundSize: "26px 26px" };
        case "lines": return { background: `repeating-linear-gradient(0deg,${col} 0 1px,transparent 1px 34px),${base}` };
        case "diagonal": return { background: `repeating-linear-gradient(135deg,${col} 0 1px,transparent 1px 22px),${base}` };
        case "noise": return { background: `${base}` };
        case "waves": return { background: `radial-gradient(120% 60% at 50% 100%,${col} 0,transparent 60%),radial-gradient(80% 40% at 10% 0,${col} 0,transparent 60%),${base}` };
        case "topo": return { background: `repeating-radial-gradient(ellipse at 20% 120%,transparent 0 22px,${col} 22px 23px),${base}` };
      }
    }
    // falls through for "none" and "image", which draw their own layers.
    default: return {};
  }
}

/** An overlay gradient for image backgrounds, so text stays readable on a photograph. */
export function overlayCss(o: { color: ColorRef; opacity: number; dir: "flat" | "bottom" | "top" | "left" | "right" | "vignette" }): string {
  const c = fillColor(o.color);
  const a = o.opacity;
  const solid = `color-mix(in srgb,${c} ${a}%,transparent)`;
  const none = "transparent";
  switch (o.dir) {
    case "flat": return solid;
    case "bottom": return `linear-gradient(to top,${solid} 0,${`color-mix(in srgb,${c} ${Math.round(a * 0.25)}%,transparent)`} 65%,${none} 100%)`;
    case "top": return `linear-gradient(to bottom,${solid} 0,${`color-mix(in srgb,${c} ${Math.round(a * 0.25)}%,transparent)`} 65%,${none} 100%)`;
    case "left": return `linear-gradient(to right,${solid} 0,${`color-mix(in srgb,${c} ${Math.round(a * 0.3)}%,transparent)`} 60%,${none} 100%)`;
    case "right": return `linear-gradient(to left,${solid} 0,${`color-mix(in srgb,${c} ${Math.round(a * 0.3)}%,transparent)`} 60%,${none} 100%)`;
    case "vignette": return `radial-gradient(ellipse at center,${none} 35%,${solid} 130%)`;
  }
}

/** Display names for fonts and the like are kept out of CSS entirely: only the variable names above are ever emitted. */
export const fontLabel = (k: FontKey) => FONTS[k].label;
