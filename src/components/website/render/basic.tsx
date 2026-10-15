import * as React from "react";
import { isExternalHref } from "@/lib/website/doc";
import type { ImageSrc } from "@/lib/website/doc";
import { Icon } from "./icons";
import { ImageEl, imageShows, isIllustration, Paras, rootProps, Txt } from "./parts";
import type { ElementProps } from "./ctx";

type S = (v: unknown) => string;
const s: S = (v) => (typeof v === "string" ? v : "");
const n = (v: unknown, d = 0) => (typeof v === "number" ? v : d);

export function Heading({ el, ctx, p, index }: ElementProps & { index?: number }) {
  let level = Math.min(4, Math.max(1, parseInt(s(p.level) || "2", 10) || 2));
  if (level === 1 && el.id !== ctx.h1Id) level = 2;
  const Tag = `h${level}` as "h1";
  return <Txt ctx={ctx} id={el.id} path="text" value={s(p.text)} as={Tag} className="iq-h" multiline rootProps={{ ...rootProps(el, ctx, "iq-heading", index), "data-lvl": String(level) }} placeholder="Heading" />;
}

export function TextEl({ el, ctx, p, index }: ElementProps & { index?: number }) {
  const role = s(p.role) || "body";
  const value = s(p.text);
  if (ctx.mode === "published" && !value.trim()) return null;
  const root = rootProps(el, ctx, `iq-t iq-${role}`, index);
  if (role === "eyebrow" || role === "caption" || role === "small") return <Txt ctx={ctx} id={el.id} path="text" value={value} as="p" rootProps={root} multiline placeholder="Text" />;
  if (role === "quote") return <Txt ctx={ctx} id={el.id} path="text" value={value} as="blockquote" rootProps={root} multiline placeholder="Quote" />;
  return <Paras ctx={ctx} id={el.id} path="text" value={value} rootProps={root} placeholder="Write something here" />;
}

export function ImageNode({ el, ctx, p, index }: ElementProps & { index?: number }) {
  const src = p.src as ImageSrc;
  if (ctx.mode === "published" && !imageShows(ctx, src)) return null;
  const aspect = s(p.aspect) || "4/3";
  const frame = s(p.frame) || "none";
  const caption = s(p.caption);
  const overlay = parseInt(s(p.overlay) || "0", 10);
  const root = rootProps(el, ctx, "iq-img", index);
  return (
    <figure {...root} data-frame={frame} data-aspect={aspect} {...(isIllustration(src) ? { "data-illustration": "" } : {})}>
      <div className="iq-img-in">
        <ImageEl ctx={ctx} o={{ src, alt: s(p.alt), fit: s(p.fit) === "contain" ? "contain" : "cover", posX: n(p.posX, 50), posY: n(p.posY, 50), priority: p.priority === true, sizes: "(max-width: 768px) 100vw, 50vw", className: "iq-fill" }} />
        {overlay > 0 && <span className="iq-tint" aria-hidden style={{ opacity: overlay / 100 }} />}
      </div>
      {(caption || ctx.edit) && <Txt ctx={ctx} id={el.id} path="caption" value={caption} as="figcaption" className="iq-cap" plain placeholder="Caption" />}
    </figure>
  );
}

const ARROWS = new Set(["arrow-right", "arrow-up-right"]);

export function ButtonEl({ el, ctx, p, index }: ElementProps & { index?: number }) {
  const link = (p.link ?? { label: "", href: "" }) as { label: string; href: string };
  if (ctx.mode === "published" && !link.label.trim()) return null;
  const variant = s(p.variant) || "primary";
  const size = s(p.size) || "m";
  const icon = s(p.icon) || "none";
  const external = isExternalHref(link.href);
  const root = {
    ...rootProps(el, ctx, "iq-btn", index),
    "data-v": variant,
    "data-s": size,
    ...(p.fullWidth === true ? { "data-full": "" } : {}),
    ...(s(p.track) ? { "data-track": s(p.track) } : {}),
  };
  const inner = (
    <>
      {icon !== "none" && !ARROWS.has(icon) && <Icon name={icon} className="iq-btn-ic" />}
      <Txt ctx={ctx} id={el.id} path="link.label" value={link.label} className="iq-btn-l" plain placeholder="Button" />
      {ARROWS.has(icon) && <Icon name={icon} className="iq-btn-ic iq-btn-arrow" />}
    </>
  );
  const href = link.href || "#";
  return (
    <a {...root} href={href} {...(external ? { rel: "noopener noreferrer" } : {})}>
      {inner}
    </a>
  );
}

export function IconEl({ el, ctx, p, index }: ElementProps & { index?: number }) {
  return (
    <span {...rootProps(el, ctx, "iq-icon", index)} data-size={s(p.size) || "m"} data-shape={s(p.shape) || "soft"} data-tone={s(p.tone) || "primary"}>
      <Icon name={s(p.name) || "sparkles"} />
    </span>
  );
}

export function Divider({ el, ctx, p, index }: ElementProps & { index?: number }) {
  const style = s(p.style) || "line";
  const root = { ...rootProps(el, ctx, "iq-hr", index), "data-style": style, "data-w": s(p.width) || "full" };
  if (style === "ornament") {
    return (
      <div {...root} role="separator">
        <span aria-hidden />
        <svg viewBox="0 0 24 24" aria-hidden width="14" height="14"><path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4L12 2z" fill="currentColor" /></svg>
        <span aria-hidden />
      </div>
    );
  }
  return <hr {...root} />;
}

export function Spacer({ el, ctx, p, index }: ElementProps & { index?: number }) {
  return <div {...rootProps(el, ctx, "iq-spacer", index)} aria-hidden style={{ height: `var(--sp-${s(p.size) || "m"})` }} />;
}

export function Badge({ el, ctx, p, index }: ElementProps & { index?: number }) {
  const text = s(p.text);
  if (ctx.mode === "published" && !text.trim()) return null;
  const style = s(p.style) || "pill";
  return (
    <span {...rootProps(el, ctx, "iq-badge", index)} data-style={style}>
      {style === "dot" && <i className="iq-dot" aria-hidden />}
      {style !== "dot" && style !== "plain" && s(p.icon) && s(p.icon) !== "sparkles" ? <Icon name={s(p.icon)} className="iq-badge-ic" /> : null}
      <Txt ctx={ctx} id={el.id} path="text" value={text} plain placeholder="Badge" />
    </span>
  );
}

export function ListEl({ el, ctx, p, index }: ElementProps & { index?: number }) {
  const items = (Array.isArray(p.items) ? p.items : []) as string[];
  if (!items.length) return ctx.mode === "published" ? null : <div {...rootProps(el, ctx, "iq-empty-el", index)}>Feature list: add points in the panel</div>;
  const style = s(p.style) || "check";
  const Tag = style === "number" ? "ol" : "ul";
  return (
    <Tag {...rootProps(el, ctx, "iq-list", index)} data-style={style} data-cols={s(p.cols) || "1"}>
      {items.map((t, i) => (
        <li key={i}>
          {style === "check" && <Icon name="check" className="iq-li-ic" strokeWidth={2.4} />}
          <Txt ctx={ctx} id={el.id} path={`items.${i}`} value={t} placeholder="Point" />
        </li>
      ))}
    </Tag>
  );
}
