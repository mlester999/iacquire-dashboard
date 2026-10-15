import * as React from "react";
import { bgCss, fillColor, overlayCss } from "@/lib/website/css";
import type { Bg, Column, Decor, Section } from "@/lib/website/doc";
import { renderElement } from "./elements";
import { nodeAttrs, type RenderCtx } from "./ctx";
import { BgImage } from "./parts";

function Decoration({ d }: { d: Decor }) {
  const style = { "--dc": fillColor(d.color), opacity: d.opacity / 100 } as React.CSSProperties;
  return (
    <span className="iq-decor-i" data-kind={d.kind} data-at={d.at} data-size={d.size} style={style}>
      {d.kind === "blob" && (
        <svg viewBox="0 0 200 200" aria-hidden><path fill="currentColor" d="M44.7,-58.9C57.6,-49.1,67.4,-34.9,72.2,-18.9C77,-2.9,76.8,14.9,69.3,28.6C61.8,42.3,47,52,31.7,59.9C16.4,67.8,0.6,73.9,-15.8,72.3C-32.2,70.7,-49.2,61.4,-60.5,47.4C-71.8,33.4,-77.4,14.7,-75.3,-2.2C-73.2,-19.1,-63.4,-34.2,-50.7,-44.2C-38,-54.2,-22.3,-59.1,-5.7,-52.6C10.9,-46.1,31.8,-68.7,44.7,-58.9Z" transform="translate(100 100)" /></svg>
      )}
      {d.kind === "plus" && <svg viewBox="0 0 24 24" aria-hidden><path d="M12 3v18M3 12h18" stroke="currentColor" strokeWidth="1.2" fill="none" /></svg>}
      {d.kind === "arc" && <svg viewBox="0 0 100 100" aria-hidden><path d="M0 100A100 100 0 0 1 100 0" stroke="currentColor" strokeWidth="1" fill="none" /><path d="M0 100A70 70 0 0 1 70 30" stroke="currentColor" strokeWidth="1" fill="none" /><path d="M0 100A40 40 0 0 1 40 60" stroke="currentColor" strokeWidth="1" fill="none" /></svg>}
      {d.kind === "line" && <svg viewBox="0 0 100 100" aria-hidden preserveAspectRatio="none"><path d="M0 100L100 0M20 100L100 20M40 100L100 40M60 100L100 60M80 100L100 80" stroke="currentColor" strokeWidth=".6" fill="none" /></svg>}
    </span>
  );
}

function Backdrop({ bg, ctx }: { bg: Bg; ctx: RenderCtx }) {
  if (bg.kind === "none") return null;
  if (bg.kind === "image") {
    return (
      <div className="iq-bg" aria-hidden>
        <BgImage ctx={ctx} src={bg.src} posX={bg.pos.x} posY={bg.pos.y} parallax={bg.parallax} />
        <div className="iq-ov" style={{ background: overlayCss(bg.overlay) }} />
      </div>
    );
  }
  const css = bgCss(bg);
  return <div className="iq-bg" aria-hidden style={{ ...css, ...(bg.kind === "pattern" && bg.pattern === "noise" ? {} : {}) }} data-bg={bg.kind} data-pattern={bg.kind === "pattern" ? bg.pattern : undefined} />;
}

function ColumnView({ col, ctx }: { col: Column; ctx: RenderCtx }) {
  const stagger = false;
  return (
    <div className={`iq-col x-${col.id}`} data-surface={col.surface !== "none" ? col.surface : undefined} {...nodeAttrs(ctx, col.id, "column")}>
      {col.elements.map((e, i) => renderElement(e, ctx, stagger ? i : undefined))}
      {ctx.edit && col.elements.length === 0 && <div className="iq-empty-slot" data-empty="column">Drop elements here</div>}
    </div>
  );
}

export function SectionView({ sec, ctx, role, shared }: { sec: Section; ctx: RenderCtx; role?: "header" | "footer"; shared?: string }) {
  const Tag = role === "header" ? "header" : role === "footer" ? "footer" : "section";
  const l = sec.layout;
  const cls = ["iq-sec", role ? `iq-${role}` : "", l.inset ? "iq-inset" : "", l.sticky ? "iq-sticky" : "", l.float ? "iq-float" : "", `x-${sec.id}`].filter(Boolean).join(" ");
  const anim = sec.anim.preset !== "none" ? { "data-anim": sec.anim.preset, "data-speed": sec.anim.speed, style: { "--d": `${sec.anim.delay}ms` } as React.CSSProperties, ...(sec.anim.stagger ? { "data-stagger": "" } : {}) } : {};
  return (
    <Tag className={cls} id={sec.id} data-tone={sec.tone === "auto" ? undefined : sec.tone} data-bgkind={sec.bg.kind} {...nodeAttrs(ctx, sec.id, role ?? "section")} {...(shared ? { "data-shared": shared } : {})} {...(sec.hidden ? { "data-hidden": "" } : {})}>
      <Backdrop bg={sec.bg} ctx={ctx} />
      {sec.decor.length > 0 && <div className="iq-decor" aria-hidden>{sec.decor.map((d, i) => <Decoration key={i} d={d} />)}</div>}
      <div className="iq-wrap" {...anim}>
        <div className="iq-grid" data-stack={l.stack}>
          {sec.columns.map((c) => <ColumnView key={c.id} col={c} ctx={ctx} />)}
        </div>
      </div>
      {ctx.edit && sec.columns.length === 0 && <div className="iq-empty-slot iq-empty-sec" data-empty="section">Empty section. Add a layout from the Sections tab.</div>}
    </Tag>
  );
}
