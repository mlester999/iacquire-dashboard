// Shared building blocks for the site renderer. Pure server components: no client JavaScript, no portal tokens.
// Responsive behaviour uses container queries (@2xl, @3xl, @4xl), so a narrow preview frame and a real phone
// lay out identically, and the published page matches the preview exactly.
import * as React from "react";
import {
  BarChart3, Briefcase, Building2, Calendar, Camera, Check, FileText, Hammer, Heart, Home, Key, Leaf, Lightbulb, Mail, MapPin, Paintbrush, Phone,
  Scale, Shield, Smile, Sparkles, Star, Stethoscope, ThumbsUp, Truck, Users, Wrench, Zap, Droplets, Clock, type LucideIcon,
} from "lucide-react";
import { isExternalHref, type SiteContent, type SitePage } from "@/lib/website/schema";
import type { IconName } from "@/lib/website/sections";
import type { DesignSpec } from "@/lib/website/templates";

export interface ResolvedAsset {
  src: string;
  width: number | null;
  height: number | null;
  alt: string;
}

export interface RenderContext {
  content: SiteContent;
  spec: DesignSpec;
  templateKey: string;
  page: SitePage;
  resolveAsset: (id: string | null | undefined, variant?: "original" | "processed") => ResolvedAsset | null;
  mode: "published" | "preview";
  /** Where the enquiry form posts. Null in preview, where the form is shown but switched off. */
  formAction: string | null;
  formToken: string;
  hrefFor: (slug: string) => string;
  /** The section that owns the page's single h1. */
  h1SectionId: string | null;
  /** Drawn inside another page (editor preview, thumbnails), so it adds no landmarks of its own. */
  embedded: boolean;
}

const ICON_MAP: Record<IconName, LucideIcon> = {
  wrench: Wrench, home: Home, heart: Heart, shield: Shield, clock: Clock, star: Star, "map-pin": MapPin, phone: Phone, mail: Mail, calendar: Calendar,
  check: Check, sparkles: Sparkles, users: Users, briefcase: Briefcase, hammer: Hammer, leaf: Leaf, zap: Zap, droplets: Droplets, key: Key,
  stethoscope: Stethoscope, smile: Smile, scale: Scale, chart: BarChart3, building: Building2, truck: Truck, paintbrush: Paintbrush, camera: Camera,
  lightbulb: Lightbulb, "thumbs-up": ThumbsUp, "file-text": FileText,
};
export function Icon({ name, className }: { name: string; className?: string }) {
  const Cmp = ICON_MAP[name as IconName] ?? Sparkles;
  return <Cmp className={className} aria-hidden strokeWidth={1.8} />;
}

// ---------------------------------------------------------------------------
// Class maps keyed by the design spec. Every class is a literal so Tailwind can find it.
// ---------------------------------------------------------------------------

export const SECTION_PAD: Record<DesignSpec["density"], string> = {
  airy: "py-16 @3xl:py-24",
  regular: "py-12 @3xl:py-[4.5rem]",
  compact: "py-9 @3xl:py-12",
};
export const GAP: Record<DesignSpec["density"], string> = { airy: "gap-8 @3xl:gap-12", regular: "gap-6 @3xl:gap-8", compact: "gap-4 @3xl:gap-6" };
export const RADIUS = "rounded-[var(--s-r)]";
export const RADIUS_LG = "rounded-[var(--s-r-lg)]";
export const BTN_RADIUS = "rounded-[var(--s-r-btn)]";

export const CARD: Record<DesignSpec["surface"], string> = {
  flat: "bg-[var(--s-surface-2)]",
  outlined: "bg-[var(--s-surface)] border border-[var(--s-line)]",
  elevated: "bg-[var(--s-surface)] shadow-[var(--s-shadow)]",
  tinted: "bg-[var(--s-primary-soft)]",
};

export const H_FONT = "[font-family:var(--s-font-h)] [font-weight:var(--s-weight)] [letter-spacing:var(--s-track)] text-[color:var(--s-ink)] text-balance";
const upper = (spec: DesignSpec) => (spec.type.upper ? "uppercase" : "");

export function Heading({ level, ctx, size = "h2", className = "", children, id }: { level: 1 | 2 | 3; ctx: RenderContext; size?: "h1" | "h2" | "h3"; className?: string; children: React.ReactNode; id?: string }) {
  const Tag = (`h${level}` as unknown) as "h1" | "h2" | "h3";
  const sizeClass = size === "h1" ? "text-[length:var(--s-h1)] leading-[1.04]" : size === "h2" ? "text-[length:var(--s-h2)] leading-[1.12]" : "text-[length:var(--s-h3)] leading-snug";
  return (
    <Tag id={id} className={`${H_FONT} ${sizeClass} ${upper(ctx.spec)} ${className}`}>
      {children}
    </Tag>
  );
}

/** A section's main heading is an h1 only when it owns the page's single h1. */
export const headingLevel = (ctx: RenderContext, sectionId: string): 1 | 2 => (ctx.h1SectionId === sectionId ? 1 : 2);

/**
 * The level for headings of items inside a section (a service, a step, a plan). Directly below the section's own heading,
 * except where that heading is the page's h1 (items are then h2) or where the section has no heading (items are h2 too),
 * so the outline never skips a level.
 */
export const itemLevel = (ctx: RenderContext, sectionId: string, heading: string): 2 | 3 => (headingLevel(ctx, sectionId) === 1 || !heading ? 2 : 3);

export function Eyebrow({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  if (!children) return null;
  return <p className={`text-[0.78rem] font-semibold uppercase tracking-[0.14em] text-[color:var(--s-primary-text)] ${className}`}>{children}</p>;
}

export function Lede({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  if (!children) return null;
  return <p className={`whitespace-pre-line text-[1.05rem] leading-relaxed text-[color:var(--s-muted)] text-pretty ${className}`}>{children}</p>;
}

type Link = { label: string; href: string };
export const hasLink = (l: Link | undefined | null): l is Link => Boolean(l && l.label && l.href);

export function Anchor({ ctx, href, className, children, ...rest }: { ctx: RenderContext; href: string; className?: string; children: React.ReactNode } & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  const external = isExternalHref(href);
  const resolved = href.startsWith("/") ? ctx.hrefFor(href === "/" ? "home" : href.slice(1).split("#")[0]) + (href.includes("#") ? `#${href.split("#")[1]}` : "") : href;
  return (
    <a href={resolved} className={className} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})} {...rest}>
      {children}
    </a>
  );
}

const BTN_BASE = "inline-flex min-h-11 items-center justify-center gap-2 px-5 py-2.5 text-[0.95rem] font-semibold no-underline motion-safe:transition-[transform,filter,background-color] motion-safe:duration-150 hover:brightness-110 active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--s-primary-text)]";
export function ButtonLink({ ctx, link, variant = "primary", className = "" }: { ctx: RenderContext; link: Link | undefined; variant?: "primary" | "secondary" | "accent" | "onDark" | "onPrimary"; className?: string }) {
  if (!hasLink(link)) return null;
  const styles = {
    primary: "bg-[var(--s-primary)] text-[color:var(--s-on-primary)]",
    accent: "bg-[var(--s-accent)] text-[color:var(--s-on-accent)]",
    secondary: "border border-[color:var(--s-line)] bg-[var(--s-surface)] text-[color:var(--s-ink)] hover:bg-[var(--s-surface-2)]",
    onDark: "bg-white text-[#0b0d14]",
    onPrimary: "bg-[var(--s-on-primary)] text-[color:var(--s-primary)]",
  }[variant];
  return (
    <Anchor ctx={ctx} href={link.href} className={`${BTN_BASE} ${BTN_RADIUS} ${styles} ${className}`}>
      {link.label}
    </Anchor>
  );
}

export function SiteImage({ asset, className = "", sizes, eager = false, decorative = false }: { asset: ResolvedAsset | null; className?: string; sizes?: string; eager?: boolean; decorative?: boolean }) {
  if (!asset) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- user images are served from our own, already-optimized endpoint
    <img
      src={asset.src}
      alt={decorative ? "" : asset.alt}
      width={asset.width ?? undefined}
      height={asset.height ?? undefined}
      sizes={sizes}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      className={className}
    />
  );
}

// ---------------------------------------------------------------------------
// Section shell: rhythm, density and inverted bands
// ---------------------------------------------------------------------------

export type Band = "base" | "alt" | "inverse";

/** Which background a section gets, given its position and the template's rhythm. */
export function bandFor(spec: DesignSpec, index: number): Band {
  if (spec.rhythm === "uniform") return "base";
  if (spec.rhythm === "alternate") return index % 2 === 1 ? "alt" : "base";
  return index % 4 === 3 ? "inverse" : index % 2 === 1 ? "alt" : "base";
}

const INVERSE_VARS = {
  "--s-ink": "var(--s-on-dark)",
  "--s-muted": "var(--s-on-dark-muted)",
  "--s-primary-text": "var(--s-on-dark-accent)",
  "--s-surface": "color-mix(in srgb, var(--s-dark) 86%, white)",
  "--s-surface-2": "color-mix(in srgb, var(--s-dark) 92%, white)",
  "--s-line": "color-mix(in srgb, var(--s-dark) 80%, white)",
  "--s-primary-soft": "color-mix(in srgb, var(--s-dark) 80%, var(--s-primary))",
} as React.CSSProperties;

export function SectionShell({ ctx, id, band, className = "", children, bleed = false, label }: { ctx: RenderContext; id: string; band: Band; className?: string; children: React.ReactNode; bleed?: boolean; label?: string }) {
  const bg = band === "alt" ? "bg-[var(--s-surface-2)]" : band === "inverse" ? "bg-[var(--s-dark)]" : "bg-[var(--s-bg)]";
  return (
    <section id={id} aria-label={label} className={`relative overflow-hidden ${bg} ${bleed ? "" : SECTION_PAD[ctx.spec.density]} ${className}`} style={band === "inverse" ? INVERSE_VARS : undefined}>
      {children}
    </section>
  );
}

export function Wrap({ children, className = "", narrow = false }: { children: React.ReactNode; className?: string; narrow?: boolean }) {
  return <div className={`relative mx-auto w-full ${narrow ? "max-w-3xl" : "max-w-6xl"} px-5 @3xl:px-8 ${className}`}>{children}</div>;
}

export function SectionHead({ ctx, id, heading, intro, align = "left", eyebrow }: { ctx: RenderContext; id: string; heading: string; intro?: string; align?: "left" | "center"; eyebrow?: string }) {
  if (!heading && !intro) return null;
  const level = headingLevel(ctx, id);
  return (
    <div className={`mb-8 max-w-2xl @3xl:mb-12 ${align === "center" ? "mx-auto text-center" : ""}`}>
      <Eyebrow className="mb-3">{eyebrow}</Eyebrow>
      {heading && (
        <Heading level={level} ctx={ctx} size={level === 1 ? "h1" : "h2"}>
          {heading}
        </Heading>
      )}
      <Lede className="mt-4">{intro}</Lede>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Decoration behind heroes and bands. Always aria-hidden and non-interactive.
// ---------------------------------------------------------------------------

export function Decor({ kind }: { kind: DesignSpec["decor"] }) {
  const base = "pointer-events-none absolute inset-0";
  switch (kind) {
    case "blobs":
      return (
        <div aria-hidden className={base}>
          <div className="absolute -right-24 -top-24 size-[26rem] rounded-full bg-[var(--s-primary)] opacity-[0.14] blur-3xl" />
          <div className="absolute -bottom-32 -left-20 size-[22rem] rounded-full bg-[var(--s-accent)] opacity-[0.16] blur-3xl" />
        </div>
      );
    case "grid":
      return <div aria-hidden className={`${base} opacity-[0.07] [background-image:linear-gradient(var(--s-ink)_1px,transparent_1px),linear-gradient(90deg,var(--s-ink)_1px,transparent_1px)] [background-size:44px_44px]`} />;
    case "lines":
      return <div aria-hidden className={`${base} opacity-[0.06] [background-image:repeating-linear-gradient(135deg,var(--s-ink)_0_1px,transparent_1px_22px)]`} />;
    case "dots":
      return <div aria-hidden className={`${base} opacity-[0.12] [background-image:radial-gradient(var(--s-primary)_1.3px,transparent_1.3px)] [background-size:22px_22px]`} />;
    case "waves":
      return (
        <svg aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-24 w-full text-[color:var(--s-primary)] opacity-[0.1]" viewBox="0 0 1440 120" preserveAspectRatio="none">
          <path fill="currentColor" d="M0 64c120 28 240 40 360 24s240-64 360-64 240 40 360 56 240 0 360-24v64H0Z" />
        </svg>
      );
    default:
      return null;
  }
}

/** A branded gradient used wherever a section would otherwise need a photo the owner has not uploaded. */
export const BRAND_GRADIENT = "bg-[linear-gradient(135deg,var(--s-primary),color-mix(in_srgb,var(--s-primary)_55%,var(--s-dark)))]";
