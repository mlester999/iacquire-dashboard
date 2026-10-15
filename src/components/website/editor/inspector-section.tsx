"use client";

import * as React from "react";
import { Plus, X } from "lucide-react";
import { SPACES, spaceOptions } from "@/lib/website/catalog";
import { ANIM_PRESETS, type Anim, type Bg, type Column, type Decor, type Override, type Section } from "@/lib/website/doc";
import { LIMITS, NO_ANIM, NO_BG } from "@/lib/website/doc";
import { setColumnCount, updateSection } from "@/lib/website/ops";
import { ColorControl, Group, NumberControl, Row, Seg, SelectControl, TextControl, Toggle } from "./controls";
import { useServices } from "./context";
import { FieldEditor } from "./fields";
import { FocalPoint } from "./focal-point";
import type { ImageSrc } from "@/lib/website/doc";

type Patch = (fn: (s: Section) => Section, coalesce?: string) => void;

const TONES = [
  { value: "auto", label: "Auto" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }, { value: "brand", label: "Brand" }, { value: "accent", label: "Accent" },
] as const;
const sizeLabel = (s: string) => (s === "0" ? "None" : s.toUpperCase());

// ---------------------------------------------------------------------------
// Background
// ---------------------------------------------------------------------------

const BG_KINDS = [
  { value: "none", label: "None" }, { value: "color", label: "Colour" }, { value: "gradient", label: "Gradient" }, { value: "image", label: "Image" }, { value: "mesh", label: "Mesh" }, { value: "pattern", label: "Pattern" },
] as const;

function bgFor(kind: Bg["kind"], prev: Bg): Bg {
  if (kind === prev.kind) return prev;
  switch (kind) {
    case "none": return NO_BG;
    case "color": return { kind, color: "surface2" };
    case "gradient": return { kind, from: "primary", to: "accent", angle: 135 };
    case "image": return { kind, src: { kind: "art", scene: "mesh", tone: "auto", seed: 0 }, overlay: { color: "dark", opacity: 40, dir: "flat" }, pos: { x: 50, y: 50 }, parallax: false };
    case "mesh": return { kind, colors: ["primary", "accent"], seed: 3, base: "dark" };
    case "pattern": return { kind, pattern: "grid", color: "line", opacity: 60 };
  }
}

export function BackgroundEditor({ bg, onChange, label = "Background" }: { bg: Bg; onChange: (b: Bg) => void; label?: string }) {
  const { design, assetUrl } = useServices();
  return (
    <div className="space-y-3">
      <Seg label={`${label} type`} value={bg.kind} options={BG_KINDS.map((k) => ({ ...k }))} onChange={(k) => onChange(bgFor(k, bg))} size="sm" />
      {bg.kind === "color" && <Row label="Colour"><ColorControl label="Background colour" design={design} value={bg.color} allowNone={false} onChange={(c) => c && onChange({ ...bg, color: c })} /></Row>}
      {bg.kind === "gradient" && (
        <>
          <Row label="From"><ColorControl label="Gradient start" design={design} value={bg.from} allowNone={false} onChange={(c) => c && onChange({ ...bg, from: c })} /></Row>
          <Row label="To"><ColorControl label="Gradient end" design={design} value={bg.to} allowNone={false} onChange={(c) => c && onChange({ ...bg, to: c })} /></Row>
          <Row label="Angle"><NumberControl label="Gradient angle" value={bg.angle} min={0} max={360} step={5} unit="°" onChange={(v) => onChange({ ...bg, angle: v })} /></Row>
        </>
      )}
      {bg.kind === "image" && (
        <>
          <FieldEditor scope="bg" spec={{ key: "src", label: "Image", type: "image" }} value={bg.src} onChange={(v) => onChange({ ...bg, src: v as ImageSrc })} />
          <Row label="Overlay colour"><ColorControl label="Overlay colour" design={design} value={bg.overlay.color} allowNone={false} onChange={(c) => c && onChange({ ...bg, overlay: { ...bg.overlay, color: c } })} /></Row>
          <Row label="Overlay strength"><NumberControl label="Overlay strength" value={bg.overlay.opacity} min={0} max={95} unit="%" onChange={(v) => onChange({ ...bg, overlay: { ...bg.overlay, opacity: v } })} /></Row>
          <Row label="Overlay direction">
            <SelectControl label="Overlay direction" value={bg.overlay.dir} onChange={(v) => onChange({ ...bg, overlay: { ...bg.overlay, dir: v } })}
              options={[{ value: "flat", label: "Even" }, { value: "bottom", label: "Darker at the bottom" }, { value: "top", label: "Darker at the top" }, { value: "left", label: "Darker on the left" }, { value: "right", label: "Darker on the right" }, { value: "vignette", label: "Vignette" }]} />
          </Row>
          {bg.src?.kind === "asset" && <Row label="Focal point"><FocalPoint label="Background focal point" url={assetUrl(bg.src.id)} x={bg.pos.x} y={bg.pos.y} onChange={(x, y) => onChange({ ...bg, pos: { x, y } })} /></Row>}
          <Row label="Focus: left to right"><NumberControl label="Focus horizontal" value={bg.pos.x} min={0} max={100} unit="%" onChange={(v) => onChange({ ...bg, pos: { ...bg.pos, x: v } })} /></Row>
          <Row label="Focus: top to bottom"><NumberControl label="Focus vertical" value={bg.pos.y} min={0} max={100} unit="%" onChange={(v) => onChange({ ...bg, pos: { ...bg.pos, y: v } })} /></Row>
          <Toggle label="Gentle parallax" hint="The picture drifts slowly as visitors scroll. It is switched off for anyone who prefers reduced motion." checked={bg.parallax} onChange={(v) => onChange({ ...bg, parallax: v })} />
        </>
      )}
      {bg.kind === "mesh" && (
        <>
          {bg.colors.map((c, i) => (
            <Row key={i} label={`Colour ${i + 1}`}>
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1"><ColorControl label={`Mesh colour ${i + 1}`} design={design} value={c} allowNone={false} onChange={(v) => v && onChange({ ...bg, colors: bg.colors.map((x, k) => (k === i ? v : x)) })} /></div>
                {bg.colors.length > 2 && <button type="button" aria-label={`Remove colour ${i + 1}`} onClick={() => onChange({ ...bg, colors: bg.colors.filter((_, k) => k !== i) })} className="mt-1 flex size-6 items-center justify-center rounded hover:bg-surface-3"><X className="size-3.5" /></button>}
              </div>
            </Row>
          ))}
          {bg.colors.length < 4 && <button type="button" onClick={() => onChange({ ...bg, colors: [...bg.colors, "primarySoft"] })} className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[12px] font-medium text-primary-ink hover:bg-primary-soft"><Plus className="size-3.5" /> Add a colour</button>}
          <Row label="Base"><ColorControl label="Mesh base colour" design={design} value={bg.base} allowNone={false} onChange={(c) => c && onChange({ ...bg, base: c })} /></Row>
          <Row label="Shuffle"><NumberControl label="Mesh variation" value={bg.seed} min={0} max={99} onChange={(v) => onChange({ ...bg, seed: v })} /></Row>
        </>
      )}
      {bg.kind === "pattern" && (
        <>
          <Row label="Pattern"><SelectControl label="Pattern" value={bg.pattern} onChange={(v) => onChange({ ...bg, pattern: v })} options={(["grid", "dots", "lines", "diagonal", "waves", "topo", "noise"] as const).map((p) => ({ value: p, label: p[0].toUpperCase() + p.slice(1) }))} /></Row>
          <Row label="Pattern colour"><ColorControl label="Pattern colour" design={design} value={bg.color} allowNone={false} onChange={(c) => c && onChange({ ...bg, color: c })} /></Row>
          <Row label="Behind it"><ColorControl label="Pattern base colour" design={design} value={bg.base} onChange={(c) => onChange({ ...bg, base: c })} /></Row>
          <Row label="Strength"><NumberControl label="Pattern strength" value={bg.opacity} min={4} max={100} unit="%" onChange={(v) => onChange({ ...bg, opacity: v })} /></Row>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Decoration
// ---------------------------------------------------------------------------

const DECOR_KINDS: Decor["kind"][] = ["blob", "ring", "grid", "dots", "arc", "orb", "plus", "line"];

function DecorEditor({ decor, onChange }: { decor: Decor[]; onChange: (d: Decor[]) => void }) {
  const { design } = useServices();
  return (
    <div className="space-y-3">
      {decor.map((d, i) => (
        <div key={i} className="space-y-2 rounded-xl border border-line bg-surface-2/50 p-2.5">
          <div className="flex items-center gap-2">
            <SelectControl label={`Shape ${i + 1}`} value={d.kind} onChange={(v) => onChange(decor.map((x, k) => (k === i ? { ...x, kind: v } : x)))} options={DECOR_KINDS.map((k) => ({ value: k, label: k[0].toUpperCase() + k.slice(1) }))} />
            <button type="button" aria-label={`Remove shape ${i + 1}`} onClick={() => onChange(decor.filter((_, k) => k !== i))} className="flex size-8 shrink-0 items-center justify-center rounded-lg hover:bg-surface-3"><X className="size-3.5" /></button>
          </div>
          <Row label="Position"><SelectControl label="Shape position" value={d.at} onChange={(v) => onChange(decor.map((x, k) => (k === i ? { ...x, at: v } : x)))} options={[{ value: "tl", label: "Top left" }, { value: "tr", label: "Top right" }, { value: "bl", label: "Bottom left" }, { value: "br", label: "Bottom right" }, { value: "c", label: "Centre" }, { value: "l", label: "Left" }, { value: "r", label: "Right" }]} /></Row>
          <Row label="Size"><Seg label="Shape size" value={d.size} onChange={(v) => onChange(decor.map((x, k) => (k === i ? { ...x, size: v } : x)))} options={[{ value: "s", label: "S" }, { value: "m", label: "M" }, { value: "l", label: "L" }, { value: "xl", label: "XL" }]} /></Row>
          <Row label="Colour"><ColorControl label="Shape colour" design={design} value={d.color} allowNone={false} onChange={(c) => c && onChange(decor.map((x, k) => (k === i ? { ...x, color: c } : x)))} /></Row>
          <Row label="Opacity"><NumberControl label="Shape opacity" value={d.opacity} min={4} max={100} unit="%" onChange={(v) => onChange(decor.map((x, k) => (k === i ? { ...x, opacity: v } : x)))} /></Row>
        </div>
      ))}
      {decor.length < 4 && <button type="button" onClick={() => onChange([...decor, { kind: "blob", at: "tr", size: "m", color: "primary", opacity: 20 }])} className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[12px] font-medium text-primary-ink hover:bg-primary-soft"><Plus className="size-3.5" /> Add a decorative shape</button>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------

const ANIM_LABEL: Record<(typeof ANIM_PRESETS)[number], string> = {
  none: "None", fade: "Fade in", up: "Slide up", down: "Slide down", left: "Slide from left", right: "Slide from right", scale: "Grow in", blur: "Focus in", reveal: "Image reveal", zoom: "Zoom settle",
};

export function AnimationEditor({ anim, onChange, stagger }: { anim: Anim | undefined; onChange: (a: Anim) => void; stagger?: boolean }) {
  const a = anim ?? NO_ANIM;
  return (
    <div className="space-y-3">
      <Row label="Entrance"><SelectControl label="Entrance animation" value={a.preset} onChange={(v) => onChange({ ...a, preset: v })} options={ANIM_PRESETS.map((p) => ({ value: p, label: ANIM_LABEL[p] }))} /></Row>
      {a.preset !== "none" && (
        <>
          <Row label="Speed"><Seg label="Animation speed" value={a.speed} onChange={(v) => onChange({ ...a, speed: v })} options={[{ value: "fast", label: "Fast" }, { value: "normal", label: "Normal" }, { value: "slow", label: "Slow" }]} /></Row>
          <Row label="Delay"><NumberControl label="Animation delay" value={a.delay} min={0} max={1500} step={50} unit="ms" onChange={(v) => onChange({ ...a, delay: v })} /></Row>
          {stagger && <Toggle label="Stagger the items" hint="Items inside appear one after another." checked={a.stagger} onChange={(v) => onChange({ ...a, stagger: v })} />}
          <p className="text-[11px] leading-relaxed text-muted">Plays once, when it scrolls into view. Skipped for visitors who ask their device for reduced motion.</p>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Responsive overrides
// ---------------------------------------------------------------------------

function SectionResponsive({ sec, patch }: { sec: Section; patch: Patch }) {
  const [screen, setScreen] = React.useState<"t" | "m">("m");
  const o: Override = sec.r?.[screen] ?? {};
  const set = (p: Partial<Override>) =>
    patch((s) => {
      const cur = { ...(s.r?.[screen] ?? {}), ...p };
      for (const k of Object.keys(cur) as Array<keyof Override>) if (cur[k] === undefined) delete cur[k];
      const r = { ...(s.r ?? {}) };
      if (Object.keys(cur).length) r[screen] = cur;
      else delete r[screen];
      const { r: _drop, ...rest } = s;
      void _drop;
      return Object.keys(r).length ? { ...rest, r } : (rest as Section);
    });
  return (
    <div className="space-y-3">
      <Seg label="Screen" value={screen} onChange={setScreen} options={[{ value: "t", label: "Tablet" }, { value: "m", label: "Phone" }]} />
      <Row label="Top space" onReset={o.pt ? () => set({ pt: undefined }) : undefined}><SelectControl label="Top space" value={o.pt} placeholder="Same as desktop" options={SPACES.map((s) => ({ value: s, label: sizeLabel(s) }))} onChange={(v) => set({ pt: v })} /></Row>
      <Row label="Bottom space" onReset={o.pb ? () => set({ pb: undefined }) : undefined}><SelectControl label="Bottom space" value={o.pb} placeholder="Same as desktop" options={SPACES.map((s) => ({ value: s, label: sizeLabel(s) }))} onChange={(v) => set({ pb: v })} /></Row>
      <Row label="Minimum height" onReset={o.minH ? () => set({ minH: undefined }) : undefined}><SelectControl label="Minimum height" value={o.minH} placeholder="Same as desktop" options={[{ value: "auto", label: "Fit the content" }, { value: "40", label: "40% of the screen" }, { value: "60", label: "60%" }, { value: "75", label: "75%" }, { value: "90", label: "90%" }, { value: "100", label: "Full screen" }]} onChange={(v) => set({ minH: v })} /></Row>
      <Row label="Gap between columns" onReset={o.gap ? () => set({ gap: undefined }) : undefined}><SelectControl label="Gap between columns" value={o.gap} placeholder="Same as desktop" options={SPACES.map((s) => ({ value: s, label: sizeLabel(s) }))} onChange={(v) => set({ gap: v })} /></Row>
      <Row label="Vertical alignment" onReset={o.valign ? () => set({ valign: undefined }) : undefined}><SelectControl label="Vertical alignment" value={o.valign} placeholder="Same as desktop" options={[{ value: "start", label: "Top" }, { value: "center", label: "Middle" }, { value: "end", label: "Bottom" }, { value: "stretch", label: "Stretch" }]} onChange={(v) => set({ valign: v })} /></Row>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The section inspector
// ---------------------------------------------------------------------------

export function SectionInspector({ sec, role, shared, patch, onColumns, readOnlyNote }: { sec: Section; role: "section" | "header" | "footer"; shared: boolean; patch: Patch; onColumns: (count: number) => void; readOnlyNote?: string }) {
  const l = sec.layout;
  const setLayout = (p: Partial<typeof l>, key = "layout") => patch((s) => ({ ...s, layout: { ...s.layout, ...p } }), `${key}:${sec.id}`);
  return (
    <>
      {readOnlyNote && <p className="mx-4 mt-3 rounded-lg bg-surface-3 p-2.5 text-[11.5px] leading-relaxed text-muted">{readOnlyNote}</p>}
      {shared && <p className="mx-4 mt-3 rounded-lg bg-primary-soft p-2.5 text-[11.5px] leading-relaxed text-primary-ink">This section is shared: a change here appears on every page that uses it, and nowhere else.</p>}
      <Group title="Section">
        <Row label="Name" htmlFor={`sn-${sec.id}`}><TextControl id={`sn-${sec.id}`} value={sec.name} maxLength={40} placeholder="For your own reference" onChange={(e) => patch((s) => ({ ...s, name: e.target.value }), `name:${sec.id}`)} /></Row>
        <Row label="Colour mood" hint="Auto follows the site. Dark, Brand and Accent re-colour text and buttons inside so they stay readable."><Seg label="Colour mood" value={sec.tone} options={TONES.map((t) => ({ ...t }))} onChange={(v) => patch((s) => ({ ...s, tone: v }))} size="sm" /></Row>
        {role === "section" && <Toggle label="Hide this section" hint="It stays here, but visitors don't see it." checked={sec.hidden} onChange={(v) => patch((s) => ({ ...s, hidden: v }))} />}
      </Group>
      <Group title="Layout">
        <Row label="Columns"><Seg label="Columns" value={String(Math.min(sec.columns.length, 4))} onChange={(v) => onColumns(Number(v))} options={["1", "2", "3", "4"].map((n) => ({ value: n, label: n }))} /></Row>
        {sec.columns.length >= LIMITS.columnsPerSection && <p className="text-[11px] text-muted">A section holds up to {LIMITS.columnsPerSection} columns.</p>}
        <Row label="Content width"><Seg label="Content width" value={l.width} onChange={(v) => setLayout({ width: v })} options={[{ value: "narrow", label: "Narrow" }, { value: "regular", label: "Regular" }, { value: "wide", label: "Wide" }, { value: "full", label: "Full" }]} size="sm" /></Row>
        <Row label="Minimum height"><SelectControl label="Minimum height" value={l.minH} onChange={(v) => setLayout({ minH: v })} options={[{ value: "auto", label: "Fit the content" }, { value: "40", label: "40% of the screen" }, { value: "60", label: "60%" }, { value: "75", label: "75%" }, { value: "90", label: "90%" }, { value: "100", label: "Full screen" }]} /></Row>
        <Row label="Vertical alignment"><Seg label="Vertical alignment" value={l.valign} onChange={(v) => setLayout({ valign: v })} options={[{ value: "start", label: "Top" }, { value: "center", label: "Middle" }, { value: "end", label: "Bottom" }, { value: "stretch", label: "Stretch" }]} size="sm" /></Row>
        <Row label="Space above"><SelectControl label="Space above" value={l.pt} onChange={(v) => setLayout({ pt: v })} options={SPACES.map((s) => ({ value: s, label: sizeLabel(s) }))} /></Row>
        <Row label="Space below"><SelectControl label="Space below" value={l.pb} onChange={(v) => setLayout({ pb: v })} options={SPACES.map((s) => ({ value: s, label: sizeLabel(s) }))} /></Row>
        <Row label="Gap between columns"><SelectControl label="Gap between columns" value={l.gap} onChange={(v) => setLayout({ gap: v })} options={spaceOptions.map((o) => ({ value: o.value as (typeof SPACES)[number], label: o.label }))} /></Row>
        <Row label="Columns stack" hint="Where side-by-side columns become one under another."><Seg label="Columns stack" value={l.stack} onChange={(v) => setLayout({ stack: v })} options={[{ value: "mobile", label: "On phones" }, { value: "tablet", label: "Tablet down" }, { value: "never", label: "Never" }]} size="sm" /></Row>
        <Toggle label="Reverse order when stacked" checked={l.reverse} onChange={(v) => setLayout({ reverse: v })} />
        <Toggle label="Padding at the sides" checked={l.gutter} onChange={(v) => setLayout({ gutter: v })} />
        <Toggle label="Set in as a rounded panel" checked={l.inset} onChange={(v) => setLayout({ inset: v })} />
        {role === "header" && (
          <>
            <Toggle label="Stay at the top while scrolling" checked={l.sticky} onChange={(v) => setLayout({ sticky: v })} />
            <Toggle label="Float over the first section" hint="The header sits on top of the picture below it." checked={l.float} onChange={(v) => setLayout({ float: v })} />
          </>
        )}
      </Group>
      <Group title="Background" defaultOpen={sec.bg.kind !== "none"}>
        <BackgroundEditor bg={sec.bg} onChange={(b) => patch((s) => ({ ...s, bg: b }), `bg:${sec.id}`)} />
      </Group>
      <Group title="Decoration" defaultOpen={false}>
        <DecorEditor decor={sec.decor} onChange={(d) => patch((s) => ({ ...s, decor: d }))} />
      </Group>
      <Group title="Motion" defaultOpen={false}>
        <AnimationEditor anim={sec.anim} onChange={(a) => patch((s) => ({ ...s, anim: a }), `anim:${sec.id}`)} stagger />
      </Group>
      <Group title="Tablet and phone" defaultOpen={false} hint="Change how this section looks on smaller screens only.">
        <SectionResponsive sec={sec} patch={patch} />
      </Group>
    </>
  );
}

export { updateSection, setColumnCount };
export type { Column };
