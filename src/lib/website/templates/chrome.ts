// Headers and footers. A header is a section like any other, so an owner edits it the same way as the rest of the page.
import { art } from "../build";
import type { Bg, Decor, Section } from "../doc";
import type { TemplateCtx } from "./types";

export interface HeaderOpts {
  tone?: Section["tone"];
  bg?: Bg;
  sticky?: boolean;
  float?: boolean;
  inset?: boolean;
  navStyle?: "links" | "pills" | "underline" | "minimal";
  cta?: boolean;
  ctaVariant?: string;
  width?: "regular" | "wide" | "full";
  size?: "s" | "m" | "l";
  pad?: "xs" | "s" | "m";
  tagline?: boolean;
}

const ctaLink = (ctx: TemplateCtx) => ({ label: ctx.primaryLabel, href: ctx.primaryHref });

/** Logo on the left, links and a button on the right. */
export function headerBar(ctx: TemplateCtx, o: HeaderOpts = {}): Section {
  const { b } = ctx;
  return b.section(
    { id: "header", name: "Header", tone: o.tone, bg: o.bg, layout: { pt: o.pad ?? "s", pb: o.pad ?? "s", width: o.width ?? "wide", sticky: o.sticky ?? false, float: o.float ?? false, inset: o.inset ?? false, valign: "center", gap: "s", stack: "never" } },
    [
      b.col(5, [b.el("logo", { variant: "auto", size: o.size ?? "m", tagline: o.tagline === true })]),
      b.col(7, [b.group([b.el("nav", { style: o.navStyle ?? "links", showCta: o.cta !== false, cta: ctaLink(ctx), align: "end" })], { justify: "end", wrap: false })], { valign: "center" }),
    ],
  );
}

/** Links on the left, the logo in the middle, a button on the right. */
export function headerSplit(ctx: TemplateCtx, o: HeaderOpts = {}): Section {
  const { b } = ctx;
  return b.section(
    { id: "header", name: "Header", tone: o.tone, bg: o.bg, layout: { pt: o.pad ?? "s", pb: o.pad ?? "s", width: o.width ?? "wide", sticky: o.sticky ?? false, float: o.float ?? false, inset: o.inset ?? false, valign: "center", gap: "s", stack: "never" } },
    [
      b.col(4, [b.el("nav", { style: o.navStyle ?? "minimal", showCta: false, align: "start" })], { valign: "center", r: { m: { span: 3 } } }),
      b.col(4, [b.el("logo", { variant: "auto", size: o.size ?? "m" }, { style: { align: "center" } })], { valign: "center", r: { m: { span: 5 } } }),
      b.col(4, [b.group([b.btn(ctx.primaryLabel, ctx.primaryHref, { variant: o.ctaVariant ?? "outline", size: "s" })], { justify: "end" })], { valign: "center", r: { m: { span: 4 } } }),
    ],
  );
}

/** The logo centred, with links beneath it. */
export function headerCentered(ctx: TemplateCtx, o: HeaderOpts = {}): Section {
  const { b } = ctx;
  return b.section(
    { id: "header", name: "Header", tone: o.tone, bg: o.bg, layout: { pt: o.pad ?? "m", pb: o.pad ?? "s", width: o.width ?? "wide", sticky: o.sticky ?? false, float: o.float ?? false, inset: o.inset ?? false, valign: "center", gap: "xs", stack: "never" } },
    [
      b.col(12, [
        b.el("logo", { variant: "auto", size: o.size ?? "l" }, { style: { align: "center" } }),
        b.el("nav", { style: o.navStyle ?? "minimal", showCta: false, align: "center" }),
      ], { gap: "s" }),
    ],
  );
}

/** A floating pill: a rounded bar that sits over the top of the first section. */
export function headerFloating(ctx: TemplateCtx, o: HeaderOpts = {}): Section {
  const { b } = ctx;
  return b.section(
    {
      id: "header", name: "Header", tone: o.tone ?? "light", bg: o.bg ?? { kind: "color", color: "surface" },
      layout: { pt: "xs", pb: "xs", width: "regular", float: true, inset: true, valign: "center", gap: "s", stack: "never" },
    },
    [
      b.col(4, [b.el("logo", { variant: "auto", size: "s" })], { valign: "center" }),
      b.col(8, [b.group([b.el("nav", { style: o.navStyle ?? "pills", showCta: o.cta !== false, cta: ctaLink(ctx), align: "end" })], { justify: "end", wrap: false })], { valign: "center" }),
    ],
  );
}

/** Just a logo and a menu, for pages that want nothing in the way. */
export function headerMinimal(ctx: TemplateCtx, o: HeaderOpts = {}): Section {
  const { b } = ctx;
  return b.section(
    { id: "header", name: "Header", tone: o.tone, bg: o.bg, layout: { pt: o.pad ?? "m", pb: o.pad ?? "m", width: o.width ?? "wide", sticky: o.sticky ?? false, float: o.float ?? false, valign: "center", gap: "s", stack: "never" } },
    [
      b.col(6, [b.el("logo", { variant: "auto", size: o.size ?? "m" })], { valign: "center" }),
      b.col(6, [b.group([b.el("nav", { style: o.navStyle ?? "minimal", showCta: false, align: "end" })], { justify: "end", wrap: false })], { valign: "center" }),
    ],
  );
}

// ---------------------------------------------------------------------------
// Footers
// ---------------------------------------------------------------------------

export interface FooterOpts {
  tone?: Section["tone"];
  bg?: Bg;
  decor?: Decor[];
  note?: string;
  big?: boolean;
  columns?: 3 | 4;
}

const legal = (ctx: TemplateCtx, note?: string) => note ?? `© ${new Date().getUTCFullYear()} ${ctx.name}. All rights reserved.`;

/** Logo and a line about the business, then links, contact details and social links. */
export function footerColumns(ctx: TemplateCtx, o: FooterOpts = {}): Section {
  const { b } = ctx;
  return b.section(
    { id: "footer", name: "Footer", tone: o.tone ?? "dark", bg: o.bg, decor: o.decor, layout: { pt: "xl", pb: "m", width: "wide", valign: "start", gap: "l" } },
    [
      b.col(4, [b.el("logo", { variant: "auto", size: "m" }), ...(ctx.d.tagline ? [b.body(ctx.d.tagline, { style: { color: "muted", w: "s" } })] : []), b.el("social", { style: "icons", size: "m" })], { gap: "m" }),
      b.col(3, [b.eyebrow("Explore"), b.el("nav", { style: "links", showCta: false, align: "start" })], { gap: "s", r: { m: { span: 6 } } }),
      b.col(5, [b.eyebrow("Get in touch"), b.el("contactInfo", { phone: true, email: true, address: true, hours: false, layout: "stack" })], { gap: "s" }),
      b.col(12, [b.divider({ style: { mt: "m" } }), b.small(legal(ctx, o.note))], { gap: "s" }),
    ],
  );
}

/** Everything centred: logo, links, a line of small print. */
export function footerCentered(ctx: TemplateCtx, o: FooterOpts = {}): Section {
  const { b } = ctx;
  return b.section(
    { id: "footer", name: "Footer", tone: o.tone, bg: o.bg, decor: o.decor, layout: { pt: "xl", pb: "m", width: "regular", valign: "start", gap: "m" } },
    [
      b.col(12, [
        b.el("logo", { variant: "auto", size: "l" }, { style: { align: "center" } }),
        b.el("nav", { style: "minimal", showCta: false, align: "center" }),
        b.el("social", { style: "icons", size: "m" }, { style: { align: "center" } }),
        b.divider({ width: "m", style: { align: "center", mt: "s" } }),
        b.small(legal(ctx, o.note), { style: { align: "center" } }),
      ], { gap: "m", align: "center" }),
    ],
  );
}

/** One quiet line. */
export function footerMinimal(ctx: TemplateCtx, o: FooterOpts = {}): Section {
  const { b } = ctx;
  return b.section(
    { id: "footer", name: "Footer", tone: o.tone, bg: o.bg, layout: { pt: "l", pb: "l", width: "wide", valign: "center", gap: "s" } },
    [
      b.col(6, [b.small(legal(ctx, o.note))], { valign: "center" }),
      b.col(6, [b.group([b.el("nav", { style: "minimal", showCta: false, align: "end" }, { hide: { m: true } }), b.el("social", { style: "plain", size: "s" })], { justify: "end", gap: "m" })], { valign: "center" }),
    ],
  );
}

/** A huge wordmark across the bottom, with details above it. */
export function footerBig(ctx: TemplateCtx, o: FooterOpts = {}): Section {
  const { b } = ctx;
  return b.section(
    { id: "footer", name: "Footer", tone: o.tone ?? "dark", bg: o.bg, decor: o.decor, layout: { pt: "xl", pb: "m", width: "wide", valign: "start", gap: "l" } },
    [
      b.col(4, [b.eyebrow("Contact"), b.el("contactInfo", { phone: true, email: true, address: false, hours: false, layout: "stack" })], { gap: "s" }),
      b.col(4, [b.eyebrow("Explore"), b.el("nav", { style: "links", showCta: false, align: "start" })], { gap: "s" }),
      b.col(4, [b.eyebrow("Follow"), b.el("social", { style: "links", size: "m" })], { gap: "s" }),
      b.col(12, [b.heading(ctx.name, { level: 2, style: { size: "8xl", ls: "tighter", lh: "none", color: "ink", mt: "l" } }), b.divider({ style: { mt: "s" } }), b.small(legal(ctx, o.note))], { gap: "s" }),
    ],
  );
}

export { art };
