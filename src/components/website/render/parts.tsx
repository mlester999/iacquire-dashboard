// Small building blocks shared by every element: inline text, images, editable text and common attributes.
import * as React from "react";
import { artKind } from "@/lib/website/art-keys";
import type { ElementNode, ImageSrc } from "@/lib/website/doc";
import { isExternalHref } from "@/lib/website/doc";
import { parseInline, paragraphs, type Inline } from "@/lib/website/markup";
import { Art } from "./art";
import { SafeImage } from "./safe-image";
import { nodeAttrs, type RenderCtx } from "./ctx";
import { templateImageUrl } from "@/lib/website/template-image-assets";

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

function nodes(list: Inline[], keyBase = ""): React.ReactNode[] {
  return list.map((n, i) => {
    const key = `${keyBase}${i}`;
    switch (n.t) {
      case "text": return <React.Fragment key={key}>{n.v}</React.Fragment>;
      case "br": return <br key={key} />;
      case "b": return <strong key={key}>{nodes(n.c, `${key}.`)}</strong>;
      case "i": return <em key={key}>{nodes(n.c, `${key}.`)}</em>;
      case "a": return <a key={key} href={n.href} {...(isExternalHref(n.href) ? { rel: "noopener noreferrer" } : {})}>{nodes(n.c, `${key}.`)}</a>;
    }
  });
}
export const Inline_ = ({ src }: { src: string }) => <>{nodes(parseInline(src))}</>;

interface TxtProps {
  ctx: RenderCtx;
  id: string;
  /** Where this text lives inside the node's props, for example "text" or "items.2.title". */
  path: string;
  value: string;
  as?: React.ElementType;
  className?: string;
  multiline?: boolean;
  /** Attributes that belong on the outermost tag (the node's id, classes, animation). */
  rootProps?: Record<string, unknown>;
  placeholder?: string;
  /** Plain text with no marks (labels, names). */
  plain?: boolean;
}

/** Text that is simply drawn on a live page and typed into in place inside the editor. */
export function Txt({ ctx, id, path, value, as: Tag = "span", className, multiline, rootProps, placeholder, plain }: TxtProps) {
  if (ctx.edit) {
    const E = ctx.edit.Text;
    return <E nodeId={id} path={path} value={value} as={Tag} className={className} multiline={multiline} rootProps={rootProps} placeholder={placeholder} plain={plain} />;
  }
  const cn = [className, rootProps?.className].filter(Boolean).join(" ") || undefined;
  return <Tag {...rootProps} className={cn}>{plain ? value : <Inline_ src={value} />}</Tag>;
}

/** Body copy: blank lines separate paragraphs. In the editor the whole block is one editable field. */
export function Paras({ ctx, id, path, value, className, rootProps, placeholder }: { ctx: RenderCtx; id: string; path: string; value: string; className?: string; rootProps?: Record<string, unknown>; placeholder?: string }) {
  if (ctx.edit) return <Txt ctx={ctx} id={id} path={path} value={value} as="div" className={className} multiline rootProps={rootProps} placeholder={placeholder} />;
  const list = paragraphs(value);
  const cn = [className, rootProps?.className].filter(Boolean).join(" ") || undefined;
  return (
    <div {...rootProps} className={cn}>
      {list.map((t, i) => (
        <p key={i}><Inline_ src={t} /></p>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Common attributes
// ---------------------------------------------------------------------------

export function hasRules(el: ElementNode): boolean {
  return Boolean(el.style || el.r || (el.hide && (el.hide.d || el.hide.t || el.hide.m)) || el.type === "group" || el.type === "card");
}

/** Class names, node attributes and animation settings for an element's outermost tag. */
export function rootProps(el: ElementNode, ctx: RenderCtx, cls: string, index?: number): Record<string, unknown> {
  const anim = el.anim && el.anim.preset !== "none" ? el.anim : null;
  const style: Record<string, string | number> = {};
  if (anim) style["--d"] = `${anim.delay + (index !== undefined ? index * 90 : 0)}ms`;
  const out: Record<string, unknown> = {
    className: ["iq-el", cls, hasRules(el) ? `x-${el.id}` : ""].filter(Boolean).join(" "),
    ...nodeAttrs(ctx, el.id, el.type),
  };
  if (el.style?.hover && el.style.hover !== "none") out["data-hover"] = el.style.hover;
  if (anim) {
    out["data-anim"] = anim.preset;
    out["data-speed"] = anim.speed;
  }
  if (Object.keys(style).length) out.style = style;
  return out;
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

export interface ImageOpts {
  src: ImageSrc;
  alt?: string;
  fit?: "cover" | "contain";
  posX?: number;
  posY?: number;
  className?: string;
  priority?: boolean;
  /** The size the image is drawn at, for the browser's choice of file. */
  sizes?: string;
  /** What to draw when there is nothing to show (editor and previews only). */
  placeholder?: string;
}

export function ImageEl({ ctx, o }: { ctx: RenderCtx; o: ImageOpts }) {
  const { src, alt = "", fit = "cover", posX = 50, posY = 50, className, priority, sizes, placeholder } = o;
  if (src && src.kind === "art") {
    return <Art scene={src.scene} tone={src.tone} seed={src.seed} posX={posX} posY={posY} className={["iq-art", className].filter(Boolean).join(" ")} />;
  }
  if (src && src.kind === "template") {
    const url = templateImageUrl(src.id);
    return <SafeImage key={url} src={url} alt={alt} width={1440} height={860} loading={priority ? "eager" : "lazy"} decoding="async" fetchPriority={priority ? "high" : undefined} sizes={sizes} className={["iq-photo", className].filter(Boolean).join(" ")} style={{ objectFit: fit, objectPosition: `${posX}% ${posY}%` }} />;
  }
  if (src && src.kind === "asset") {
    const a = ctx.resolveAsset(src.id);
    if (a) {
      const fallbackSrc = src.default ? templateImageUrl(src.default.id) : undefined;
      return (
        <SafeImage key={`${a.src}:${fallbackSrc ?? ""}`} src={a.src} fallbackSrc={fallbackSrc} srcSet={a.srcSet} width={a.width ?? undefined} height={a.height ?? undefined} alt={alt || a.alt || ""}
          loading={priority ? "eager" : "lazy"} decoding="async" fetchPriority={priority ? "high" : undefined} sizes={a.srcSet ? (sizes ?? "100vw") : sizes}
          className={["iq-photo", className].filter(Boolean).join(" ")}
          style={{ objectFit: fit, objectPosition: `${posX}% ${posY}%` }}
        />
      );
    }
    if (src.default) {
      const url = templateImageUrl(src.default.id);
      return <SafeImage key={url} src={url} alt={alt} width={1440} height={860} loading={priority ? "eager" : "lazy"} decoding="async" fetchPriority={priority ? "high" : undefined} sizes={sizes} className={["iq-photo", className].filter(Boolean).join(" ")} style={{ objectFit: fit, objectPosition: `${posX}% ${posY}%` }} />;
    }
  }
  if (ctx.mode !== "edit") return null;
  return <div className={["iq-ph", className].filter(Boolean).join(" ")} role="img" aria-label={placeholder ?? "Image placeholder"}><span>{placeholder ?? "Add an image"}</span></div>;
}

/** Whether an image source will draw anything on a live page. */
export function imageShows(ctx: RenderCtx, src: ImageSrc): boolean {
  if (!src) return false;
  if (src.kind === "art" || src.kind === "template") return true;
  return ctx.resolveAsset(src.id) !== null || Boolean(src.default);
}

export const isIllustration = (src: ImageSrc) => Boolean(src && src.kind === "art" && artKind(src.scene) === "illustration");
export const isTemplateStarter = (src: ImageSrc) => Boolean(src && src.kind === "template");

/** An image used as a background fills its parent and is never announced. */
export function BgImage({ ctx, src, posX, posY, parallax, strength = 100 }: { ctx: RenderCtx; src: ImageSrc; posX: number; posY: number; parallax: boolean; strength?: number }) {
  if (!imageShows(ctx, src)) return null;
  return (
    <div className="iq-bgimg" aria-hidden data-parallax={parallax ? "" : undefined} {...(isIllustration(src) ? { "data-illustration": "" } : {})} {...(isTemplateStarter(src) ? { "data-starter-image": "" } : {})} style={{ opacity: strength / 100 }}>
      <ImageEl ctx={ctx} o={{ src, alt: "", posX, posY, className: "iq-fill", sizes: "100vw" }} />
    </div>
  );
}

export const pad2 = (n: number) => String(n).padStart(2, "0");
export const telHref = (v: string) => `tel:${v.replace(/[^\d+]/g, "")}`;
export function displayPhone(raw: string): string {
  const e164 = raw.replace(/[^\d+]/g, "");
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164.replace(/^(\+\d{1,3})(\d+)$/, (_, cc: string, rest: string) => `${cc} ${rest.replace(/(\d{3})(?=\d)/g, "$1 ")}`);
}
