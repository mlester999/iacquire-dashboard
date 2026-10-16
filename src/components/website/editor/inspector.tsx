"use client";

import * as React from "react";
import { AlignCenter, AlignLeft, AlignRight, ChevronRight, Copy, FileText, Sparkles, Trash2 } from "lucide-react";
import { ELEMENT_ICONS } from "./panel-add";
import { Icon } from "@/components/website/render/icons";
import { ELEMENT_DEFS, SPACES, type ElementType } from "@/lib/website/catalog";
import {
  LETTER_SPACINGS, LINE_HEIGHTS, SIZES, WIDTHS, isRef, type Column, type ElementNode, type ImageSrc, type NodeStyle, type Override, type Page, type Section, type SiteContent,
} from "@/lib/website/doc";
import type { Device } from "@/lib/website/editor/state";
import { ancestors, describeNode, findNode, getColumn, getElement, getPage, getSection, newId, patchProps, setColumnCount, setHide, setProp, setResponsive, setStyle, updateColumn, updateElement, updatePage, updateSection } from "@/lib/website/ops";
import { collectIds } from "@/lib/website/doc";
import { cn } from "@/lib/utils";
import type { CanvasActions } from "./canvas";
import { ColorControl, Group, IconButton, NumberControl, Row, Seg, SelectControl, TextControl, AreaControl, Toggle } from "./controls";
import { useServices } from "./context";
import { useDraft } from "./hooks";
import { FieldEditor, showField } from "./fields";
import { FocalPoint } from "./focal-point";
import { templateImageUrl } from "@/lib/website/template-image-assets";
import { FONTS, FONT_KEYS, type FontKey } from "@/lib/website/font-keys";
import { AdvancedGroup } from "./inspector-advanced";
import { AnimationEditor, SectionInspector } from "./inspector-section";

export interface InspectorProps {
  doc: SiteContent;
  selection: string | null;
  pageId: string;
  device: Device;
  actions: CanvasActions;
  /** Agency designers see a few extra, advanced controls. */
  advanced: boolean;
}

const OVERRIDABLE = new Set(["mt", "mb", "pt", "pb", "align", "w", "size", "ls", "lh"]);
const sizeLabel = (s: string) => (s === "0" ? "None" : s.toUpperCase());
const SIZE_LABEL: Record<string, string> = { xs: "Extra small", s: "Small", base: "Normal", lg: "Large", xl: "XL", "2xl": "2XL", "3xl": "3XL", "4xl": "4XL", "5xl": "5XL", "6xl": "6XL", "7xl": "7XL", "8xl": "8XL (huge)" };
const WIDTH_LABEL: Record<string, string> = { auto: "Automatic", full: "Full width", fit: "Fit the content", xs: "Extra narrow", s: "Narrow", m: "Medium", l: "Wide", prose: "Reading width" };

// ---------------------------------------------------------------------------
// Style target: where a style control reads and writes, depending on the device being edited
// ---------------------------------------------------------------------------

function useStyleTarget(doc: SiteContent, id: string, device: Device, commit: CanvasActions["commit"]) {
  const el = getElement(doc, id);
  const screen = device === "tablet" ? "t" : device === "mobile" ? "m" : null;
  const base = (el?.style ?? {}) as Record<string, unknown>;
  const ov = (screen ? el?.r?.[screen] ?? {} : {}) as Record<string, unknown>;
  const perScreen = (k: string) => screen !== null && OVERRIDABLE.has(k);
  return {
    screen,
    get: <T,>(k: string): T | undefined => (perScreen(k) && k in ov ? (ov[k] as T) : (base[k] as T | undefined)),
    inherited: (k: string) => perScreen(k) && !(k in ov) && k in base,
    custom: (k: string) => (perScreen(k) ? k in ov : k in base),
    allScreens: (k: string) => screen !== null && !OVERRIDABLE.has(k),
    set: (k: string, v: unknown) => {
      const next = perScreen(k) ? setResponsive(doc, id, screen!, { [k]: v } as Partial<Override>) : setStyle(doc, id, { [k]: v } as Partial<NodeStyle>);
      commit(next, { coalesce: `style:${id}:${k}:${screen ?? "d"}` });
    },
  };
}

// ---------------------------------------------------------------------------
// Which style controls make sense for which element
// ---------------------------------------------------------------------------

type StyleGroup = "type" | "color" | "spacing" | "width" | "box" | "media" | "hover";
const TEXTY: StyleGroup[] = ["type", "color", "spacing", "width", "box"];
const BLOCK: StyleGroup[] = ["spacing", "width", "color", "box"];
const STYLE_GROUPS: Record<ElementType, StyleGroup[]> = {
  heading: TEXTY, text: TEXTY, list: TEXTY, badge: ["color", "spacing", "box"], marquee: TEXTY, contactInfo: TEXTY, social: ["color", "spacing"],
  button: ["type", "color", "spacing", "width", "box", "hover"], icon: ["color", "spacing"], divider: ["color", "spacing", "width"], spacer: [],
  image: ["spacing", "width", "media", "hover"], gallery: ["spacing", "width", "media"], collage: ["spacing", "width", "media"], video: ["spacing", "width", "media"], logo: ["spacing"], map: ["spacing", "width", "box"],
  group: ["spacing", "width", "box"], card: ["spacing", "width", "box", "hover"],
  services: BLOCK, steps: BLOCK, faq: BLOCK, testimonials: BLOCK, stats: BLOCK, logos: BLOCK, team: BLOCK, pricing: BLOCK, nav: ["spacing", "color"], form: BLOCK,
};

function StyleControls({ doc, id, type, device, actions }: { doc: SiteContent; id: string; type: ElementType; device: Device; actions: CanvasActions }) {
  const { design } = useServices();
  const t = useStyleTarget(doc, id, device, actions.commit);
  const groups = STYLE_GROUPS[type];
  const tag = (k: string) => (t.allScreens(k) ? "All screens" : t.inherited(k) ? "From desktop" : undefined);
  const reset = (k: string) => (t.custom(k) ? () => t.set(k, undefined) : undefined);
  const sel = <T extends string>(k: string, label: string, options: Array<{ value: T; label: string }>) => (
    <Row label={label} tag={tag(k)} onReset={reset(k)}>
      <SelectControl label={label} value={t.get<T>(k)} options={options} onChange={(v) => t.set(k, v)} />
    </Row>
  );
  return (
    <>
      {t.screen && <p className="mx-4 mt-3 rounded-lg bg-primary-soft p-2.5 text-[11.5px] leading-relaxed text-primary-ink">Editing for {device === "tablet" ? "tablets" : "phones"}. Size, spacing, alignment and width can differ here; everything else applies to all screens.</p>}
      {groups.includes("type") && (
        <Group title="Text">
          <Row label="Font" tag={tag("font")} onReset={reset("font")}>
            <SelectControl label="Font family" value={t.get<string>("font")} onChange={(v) => t.set("font", v)} options={[
              ...(["heading", "body", "accent", "mono"] as const).map((role) => ({ value: role, label: `${role[0].toUpperCase() + role.slice(1)} style · ${FONTS[design.fonts[role] as FontKey].label}` })),
              ...FONT_KEYS.map((key) => ({ value: key, label: FONTS[key].label })),
            ]} />
          </Row>
          {sel("size", "Size", SIZES.map((s) => ({ value: s, label: SIZE_LABEL[s] })))}
          <Row label="Weight" tag={tag("weight")} onReset={reset("weight")}>
            <SelectControl label="Weight" value={t.get<number>("weight")?.toString()} onChange={(v) => t.set("weight", Number(v))} options={[100, 200, 300, 400, 500, 600, 700, 800, 900].map((w) => ({ value: String(w), label: `${w}${w === 400 ? " · Regular" : w === 700 ? " · Bold" : ""}` }))} />
          </Row>
          {sel("lh", "Line height", LINE_HEIGHTS.map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) })))}
          {sel("ls", "Letter spacing", LETTER_SPACINGS.map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) })))}
          <Row label="Alignment" tag={tag("align")} onReset={reset("align")}>
            <Seg label="Alignment" value={t.get<string>("align")} onChange={(v) => t.set("align", v)} options={[{ value: "start", label: "Left", icon: <AlignLeft className="size-3.5" /> }, { value: "center", label: "Centre", icon: <AlignCenter className="size-3.5" /> }, { value: "end", label: "Right", icon: <AlignRight className="size-3.5" /> }]} />
          </Row>
          <Row label="Capitals" tag={tag("transform")} onReset={reset("transform")}>
            <Seg label="Capitals" value={t.get<string>("transform")} onChange={(v) => t.set("transform", v)} options={[{ value: "none", label: "Normal" }, { value: "uppercase", label: "ALL CAPS" }]} />
          </Row>
          <Toggle label="Italic" checked={t.get<boolean>("italic") === true} onChange={(v) => t.set("italic", v ? true : undefined)} />
        </Group>
      )}
      {groups.includes("color") && (
        <Group title="Colour">
          <Row label="Text colour" tag={tag("color")} onReset={reset("color")}>
            <ColorControl label="Text colour" design={design} value={t.get("color")} onChange={(c) => t.set("color", c)} />
          </Row>
        </Group>
      )}
      {(groups.includes("spacing") || groups.includes("width")) && (
        <Group title="Spacing and size">
          {groups.includes("width") && sel("w", "Width", WIDTHS.map((s) => ({ value: s, label: WIDTH_LABEL[s] })))}
          {!groups.includes("type") && (
            <Row label="Alignment" tag={tag("align")} onReset={reset("align")}>
              <Seg label="Alignment" value={t.get<string>("align")} onChange={(v) => t.set("align", v)} options={[{ value: "start", label: "Left", icon: <AlignLeft className="size-3.5" /> }, { value: "center", label: "Centre", icon: <AlignCenter className="size-3.5" /> }, { value: "end", label: "Right", icon: <AlignRight className="size-3.5" /> }]} />
            </Row>
          )}
          <div className="grid grid-cols-2 gap-3">
            {sel("mt", "Space above", SPACES.map((s) => ({ value: s, label: sizeLabel(s) })))}
            {sel("mb", "Space below", SPACES.map((s) => ({ value: s, label: sizeLabel(s) })))}
            {sel("pt", "Padding above", SPACES.map((s) => ({ value: s, label: sizeLabel(s) })))}
            {sel("pb", "Padding below", SPACES.map((s) => ({ value: s, label: sizeLabel(s) })))}
          </div>
        </Group>
      )}
      {groups.includes("box") && (
        <Group title="Box" defaultOpen={false}>
          <Row label="Background" tag={tag("bg")} onReset={reset("bg")}><ColorControl label="Background" design={design} value={t.get("bg")} onChange={(c) => t.set("bg", c)} /></Row>
          {sel("radius", "Corners", [{ value: "none", label: "Square" }, { value: "s", label: "Slightly rounded" }, { value: "m", label: "Rounded" }, { value: "l", label: "Very rounded" }, { value: "xl", label: "Extra rounded" }, { value: "full", label: "Pill" }])}
          <Row label="Border" tag={tag("border")} onReset={reset("border")}>
            <Seg label="Border" value={t.get<string>("border")} onChange={(v) => t.set("border", v)} options={[{ value: "none", label: "None" }, { value: "thin", label: "Thin" }, { value: "thick", label: "Thick" }]} />
          </Row>
          {t.get<string>("border") && t.get<string>("border") !== "none" && <Row label="Border colour" tag={tag("borderColor")} onReset={reset("borderColor")}><ColorControl label="Border colour" design={design} value={t.get("borderColor")} onChange={(c) => t.set("borderColor", c)} /></Row>}
          <Row label="Shadow" tag={tag("shadow")} onReset={reset("shadow")}>
            <Seg label="Shadow" value={t.get<string>("shadow")} onChange={(v) => t.set("shadow", v)} options={[{ value: "none", label: "None" }, { value: "s", label: "S" }, { value: "m", label: "M" }, { value: "l", label: "L" }]} />
          </Row>
        </Group>
      )}
      {groups.includes("media") && (
        <Group title="Picture style" defaultOpen={false}>
          {sel("radius", "Corners", [{ value: "none", label: "Square" }, { value: "s", label: "Slightly rounded" }, { value: "m", label: "Rounded" }, { value: "l", label: "Very rounded" }, { value: "xl", label: "Extra rounded" }, { value: "full", label: "Round" }])}
          <Row label="Shadow" tag={tag("shadow")} onReset={reset("shadow")}>
            <Seg label="Shadow" value={t.get<string>("shadow")} onChange={(v) => t.set("shadow", v)} options={[{ value: "none", label: "None" }, { value: "s", label: "S" }, { value: "m", label: "M" }, { value: "l", label: "L" }]} />
          </Row>
          <Row label="Opacity" tag={tag("opacity")} onReset={reset("opacity")}><NumberControl label="Opacity" value={t.get<number>("opacity") ?? 100} min={10} max={100} unit="%" onChange={(v) => t.set("opacity", v === 100 ? undefined : v)} /></Row>
          <Row label="Tilt" tag={tag("rotate")} onReset={reset("rotate")}><NumberControl label="Tilt" value={t.get<number>("rotate") ?? 0} min={-12} max={12} unit="°" onChange={(v) => t.set("rotate", v === 0 ? undefined : v)} /></Row>
        </Group>
      )}
      {groups.includes("hover") && (
        <Group title="Hover" defaultOpen={false} hint="What happens when a visitor points at it.">
          <Row label="Effect" tag={tag("hover")} onReset={reset("hover")}>
            <Seg label="Hover effect" value={t.get<string>("hover") ?? "none"} onChange={(v) => t.set("hover", v === "none" ? undefined : v)} options={[{ value: "none", label: "None" }, { value: "lift", label: "Lift" }, { value: "scale", label: "Grow" }, { value: "glow", label: "Glow" }, { value: "underline", label: "Line" }]} size="sm" />
          </Row>
        </Group>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Responsive tab for an element
// ---------------------------------------------------------------------------

function ElementResponsive({ el, doc, actions }: { el: ElementNode; doc: SiteContent; actions: CanvasActions }) {
  const [screen, setScreen] = React.useState<"t" | "m">("m");
  const def = ELEMENT_DEFS[el.type];
  const o = (el.r?.[screen] ?? {}) as Override;
  const hide = el.hide ?? {};
  const hasCols = def.fields.some((f) => f.key === "cols");
  const customCount = (el.r?.t ? Object.keys(el.r.t).length : 0) + (el.r?.m ? Object.keys(el.r.m).length : 0);
  const set = (p: Partial<Override>) => actions.commit(setResponsive(doc, el.id, screen, p), { coalesce: `resp:${el.id}:${screen}` });
  return (
    <>
      <Group title="Show on">
        {([["d", "Desktop"], ["t", "Tablet"], ["m", "Phone"]] as const).map(([k, label]) => (
          <Toggle key={k} label={label} checked={hide[k] !== true} onChange={(v) => actions.commit(setHide(doc, el.id, k, !v))} />
        ))}
        <p className="text-[11px] leading-relaxed text-muted">Hidden items stay on the page, dimmed, while you edit. Visitors on that screen won&apos;t see them.</p>
      </Group>
      <Group title="Per-screen settings">
        <Seg label="Screen" value={screen} onChange={setScreen} options={[{ value: "t", label: "Tablet" }, { value: "m", label: "Phone" }]} />
        {el.type === "group" && (
          <Row label="Direction" onReset={o.dir ? () => set({ dir: undefined }) : undefined}>
            <Seg label="Direction" value={o.dir} onChange={(v) => set({ dir: v })} options={[{ value: "row", label: "Side by side" }, { value: "col", label: "Stacked" }]} />
          </Row>
        )}
        {hasCols && (
          <Row label="Columns" onReset={o.cols ? () => set({ cols: undefined }) : undefined}>
            <Seg label="Columns" value={o.cols} onChange={(v) => set({ cols: v })} options={["1", "2", "3", "4"].map((n) => ({ value: n as "1", label: n }))} />
          </Row>
        )}
        <p className="text-[11.5px] leading-relaxed text-muted">Text size, spacing, width and alignment for this screen are in the Style tab: switch the device at the top of the editor, then change them.</p>
        {customCount > 0 && (
          <button type="button" onClick={() => actions.commit(clearOverrides(doc, el.id))} className="inline-flex h-7 items-center rounded-lg px-2 text-[12px] font-medium text-danger-ink hover:bg-danger-soft">Reset all tablet and phone changes ({customCount})</button>
        )}
      </Group>
    </>
  );
}

function clearOverrides(doc: SiteContent, id: string): SiteContent {
  const a = setResponsive(doc, id, "t", Object.fromEntries(Object.keys(getElement(doc, id)?.r?.t ?? {}).map((k) => [k, undefined])) as Partial<Override>);
  return setResponsive(a, id, "m", Object.fromEntries(Object.keys(getElement(a, id)?.r?.m ?? {}).map((k) => [k, undefined])) as Partial<Override>);
}

// ---------------------------------------------------------------------------
// Element inspector
// ---------------------------------------------------------------------------

type Tab = "content" | "style" | "motion" | "responsive";

function ElementInspector({ el, doc, device, actions }: { el: ElementNode; doc: SiteContent; device: Device; actions: CanvasActions }) {
  const def = ELEMENT_DEFS[el.type];
  const [tab, setTab] = React.useState<Tab>("content");
  const set = (key: string, value: unknown) => actions.commit(setProp(doc, el.id, key, value), { coalesce: `prop:${el.id}:${key}` });
  const { assetUrl } = useServices();
  const imageSrc = el.type === "image" ? (el.props.src as ImageSrc) : null;
  const focalUrl = imageSrc?.kind === "asset" ? assetUrl(imageSrc.id) : imageSrc?.kind === "template" ? templateImageUrl(imageSrc.id) : null;
  return (
    <>
      <div className="flex items-center justify-between gap-2 px-4 pb-1 pt-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary-ink ring-1 ring-inset ring-primary/15">{(() => { const I = ELEMENT_ICONS[el.type] ?? Sparkles; return <I className="size-[18px]" />; })()}</span>
          <div className="min-w-0">
            <p className="truncate text-[14px] font-semibold tracking-tight">{def.label}</p>
            <p className="truncate text-[11.5px] text-muted" title={def.description}>{def.description}</p>
          </div>
        </div>
        <div className="flex shrink-0">
          <IconButton label="Duplicate" onClick={() => actions.duplicate(el.id)}><Copy className="size-3.5" /></IconButton>
          <IconButton label="Delete" onClick={() => actions.remove(el.id)}><Trash2 className="size-3.5" /></IconButton>
        </div>
      </div>
      <div className="px-4 pb-1 pt-2">
        <Seg label="Settings group" value={tab} onChange={setTab} options={[{ value: "content", label: "Content" }, { value: "style", label: "Style" }, { value: "motion", label: "Motion" }, { value: "responsive", label: "Screens" }]} />
      </div>
      {tab === "content" && (
        <Group title="Content">
          {def.fields.filter((f) => showField(f, el.props)).map((f) => (
            <React.Fragment key={f.key}>
              <FieldEditor spec={f} scope={`el-${el.id}`} value={el.props[f.key]} onChange={(v) => set(f.key, v)} />
              {el.type === "image" && f.key === "fit" && focalUrl && (
                <Row label="Focal point">
                  <FocalPoint label="Image focal point" url={focalUrl} x={typeof el.props.posX === "number" ? el.props.posX : 50} y={typeof el.props.posY === "number" ? el.props.posY : 50}
                    onChange={(x, y) => actions.commit(patchProps(doc, el.id, { posX: x, posY: y }), { coalesce: `prop:${el.id}:focal` })} />
                </Row>
              )}
            </React.Fragment>
          ))}
          {def.fields.length === 0 && <p className="text-[12px] text-muted">Nothing to set here.</p>}
        </Group>
      )}
      {tab === "style" && <StyleControls doc={doc} id={el.id} type={el.type} device={device} actions={actions} />}
      {tab === "motion" && (
        <Group title="Entrance animation" hint="How this appears when the visitor scrolls to it.">
          <AnimationEditor anim={el.anim} stagger={Boolean(el.children?.length)} onChange={(a) => actions.commit(setAnim(doc, el.id, a), { coalesce: `anim:${el.id}` })} />
        </Group>
      )}
      {tab === "responsive" && <ElementResponsive el={el} doc={doc} actions={actions} />}
    </>
  );
}

function setAnim(doc: SiteContent, id: string, anim: NonNullable<ElementNode["anim"]>): SiteContent {
  return updateElement(doc, id, (e) => {
    const { anim: _drop, ...rest } = e;
    void _drop;
    return anim.preset === "none" ? (rest as ElementNode) : { ...rest, anim };
  });
}

// ---------------------------------------------------------------------------
// Column inspector
// ---------------------------------------------------------------------------

function ColumnInspector({ col, doc, actions }: { col: Column; doc: SiteContent; actions: CanvasActions }) {
  const { design } = useServices();
  const [screen, setScreen] = React.useState<"t" | "m">("m");
  const patch = (fn: (c: Column) => Column, coalesce?: string) => actions.commit(updateColumn(doc, col.id, fn), coalesce ? { coalesce: `${coalesce}:${col.id}` } : undefined);
  const o = (col.r?.[screen] ?? {}) as Override;
  const setO = (p: Partial<Override>) =>
    patch((c) => {
      const cur = { ...(c.r?.[screen] ?? {}), ...p } as Record<string, unknown>;
      for (const k of Object.keys(cur)) if (cur[k] === undefined) delete cur[k];
      const r = { ...(c.r ?? {}) };
      if (Object.keys(cur).length) r[screen] = cur as Override;
      else delete r[screen];
      const { r: _drop, ...rest } = c;
      void _drop;
      return Object.keys(r).length ? { ...rest, r } : (rest as Column);
    }, "colr");
  const hide = col.hide ?? {};
  const node = findNode(doc, col.id);
  const sec = node?.sectionId ? getSection(doc, node.sectionId) : null;
  return (
    <>
      <div className="flex items-center justify-between gap-2 px-4 pb-1 pt-3">
        <div className="min-w-0"><p className="truncate text-[14px] font-semibold tracking-tight">Column {((node?.index ?? 0) + 1).toString()}</p><p className="text-[11.5px] text-muted">A column holds elements side by side with others.</p></div>
        <div className="flex shrink-0">
          <IconButton label="Duplicate column" onClick={() => actions.duplicate(col.id)}><Copy className="size-3.5" /></IconButton>
          <IconButton label="Delete column" onClick={() => actions.remove(col.id)}><Trash2 className="size-3.5" /></IconButton>
        </div>
      </div>
      <Group title="Width and alignment">
        <Row label={`Width: ${col.span} of 12`}><NumberControl label="Column width" value={col.span} min={1} max={12} onChange={(v) => patch((c) => ({ ...c, span: v }), "span")} /></Row>
        <Row label="Vertical alignment" onReset={col.valign ? () => patch((c) => ({ ...c, valign: undefined })) : undefined}><Seg label="Vertical alignment" value={col.valign} onChange={(v) => patch((c) => ({ ...c, valign: v }))} options={[{ value: "start", label: "Top" }, { value: "center", label: "Middle" }, { value: "end", label: "Bottom" }, { value: "stretch", label: "Stretch" }]} size="sm" /></Row>
        <Row label="Text alignment" onReset={col.align ? () => patch((c) => ({ ...c, align: undefined })) : undefined}><Seg label="Text alignment" value={col.align} onChange={(v) => patch((c) => ({ ...c, align: v }))} options={[{ value: "start", label: "Left", icon: <AlignLeft className="size-3.5" /> }, { value: "center", label: "Centre", icon: <AlignCenter className="size-3.5" /> }, { value: "end", label: "Right", icon: <AlignRight className="size-3.5" /> }]} /></Row>
        <Row label="Gap between items"><SelectControl label="Gap between items" value={col.gap} onChange={(v) => patch((c) => ({ ...c, gap: v }))} options={SPACES.map((s) => ({ value: s, label: sizeLabel(s) }))} /></Row>
        <Row label="Padding inside"><SelectControl label="Padding inside" value={col.pad} onChange={(v) => patch((c) => ({ ...c, pad: v }))} options={SPACES.map((s) => ({ value: s, label: sizeLabel(s) }))} /></Row>
      </Group>
      <Group title="Look">
        <Row label="Surface"><SelectControl label="Surface" value={col.surface} onChange={(v) => patch((c) => ({ ...c, surface: v }))} options={[{ value: "none", label: "None" }, { value: "flat", label: "Flat" }, { value: "outlined", label: "Outlined" }, { value: "elevated", label: "Raised" }, { value: "tinted", label: "Tinted" }, { value: "glass", label: "Glass" }, { value: "dark", label: "Dark" }, { value: "brand", label: "Brand colour" }]} /></Row>
        <Row label="Background colour" onReset={col.bg ? () => patch((c) => ({ ...c, bg: undefined })) : undefined}><ColorControl label="Column background" design={design} value={col.bg} onChange={(c) => patch((x) => ({ ...x, bg: c }))} /></Row>
        <Row label="Corners" onReset={col.radius ? () => patch((c) => ({ ...c, radius: undefined })) : undefined}><SelectControl label="Corners" value={col.radius} placeholder="Default" onChange={(v) => patch((c) => ({ ...c, radius: v }))} options={[{ value: "none", label: "Square" }, { value: "s", label: "Slightly rounded" }, { value: "m", label: "Rounded" }, { value: "l", label: "Very rounded" }, { value: "xl", label: "Extra rounded" }, { value: "full", label: "Pill" }]} /></Row>
      </Group>
      <Group title="Tablet and phone" defaultOpen={false} hint="Columns stack on small screens according to the section's setting. Change this one on its own here.">
        <Seg label="Screen" value={screen} onChange={setScreen} options={[{ value: "t", label: "Tablet" }, { value: "m", label: "Phone" }]} />
        <Row label={`Width: ${o.span ?? "default"}`} onReset={o.span ? () => setO({ span: undefined }) : undefined}><NumberControl label="Column width on this screen" value={o.span ?? (screen === "t" ? (sec?.layout.stack === "tablet" || sec?.layout.stack === "mobile" ? 12 : col.span) : 12)} min={1} max={12} onChange={(v) => setO({ span: v })} /></Row>
        <Row label="Order" hint="Where it sits when columns are stacked. Lower numbers come first." onReset={o.order !== undefined ? () => setO({ order: undefined }) : undefined}><NumberControl label="Order on this screen" value={o.order ?? 0} min={-6} max={12} onChange={(v) => setO({ order: v })} /></Row>
        <Toggle label="Show on desktop" checked={hide.d !== true} onChange={(v) => patch((c) => ({ ...c, hide: { ...(c.hide ?? {}), d: v ? undefined : true } }))} />
        <Toggle label="Show on tablet" checked={hide.t !== true} onChange={(v) => patch((c) => ({ ...c, hide: { ...(c.hide ?? {}), t: v ? undefined : true } }))} />
        <Toggle label="Show on phone" checked={hide.m !== true} onChange={(v) => patch((c) => ({ ...c, hide: { ...(c.hide ?? {}), m: v ? undefined : true } }))} />
      </Group>
    </>
  );
}

// ---------------------------------------------------------------------------
// Page settings
// ---------------------------------------------------------------------------

function SlugControl({ page, doc, onCommit }: { page: Page; doc: SiteContent; onCommit: (slug: string) => void }) {
  const [v, setV] = useDraft(page.slug);
  const isHome = page.slug === "home";
  const clash = v !== page.slug && doc.pages.some((p) => p.id !== page.id && p.slug === v);
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1">
        <span className="text-[12px] text-muted">/</span>
        <TextControl aria-label="Page address" value={isHome ? "" : v} disabled={isHome} placeholder={isHome ? "(home page)" : "page-address"} maxLength={40} aria-invalid={clash}
          onChange={(e) => setV(e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, "-"))} onBlur={() => v && v !== page.slug && onCommit(v)} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
      </div>
      {clash && <p role="alert" className="text-[11px] text-danger-ink">Another page already uses that address. A unique one will be chosen.</p>}
    </div>
  );
}

function PageInspector({ page, doc, actions }: { page: Page; doc: SiteContent; actions: CanvasActions }) {
  const set = (patch: Partial<Omit<Page, "id" | "items">>, coalesce?: string) => actions.commit(updatePage(doc, page.id, patch), coalesce ? { coalesce: `page:${page.id}:${coalesce}` } : undefined);
  const title = page.seoTitle || (page.slug === "home" ? doc.seo.title || doc.business.name : `${page.title} | ${doc.business.name}`);
  const desc = page.seoDescription || doc.seo.description;
  const sample = `https://${doc.business.name.toLowerCase().replace(/[^a-z0-9]+/g, "") || "yourbusiness"}.com${page.slug === "home" ? "" : `/${page.slug}`}`;
  return (
    <>
      <div className="flex items-start gap-2.5 px-4 pb-1 pt-3"><span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary-ink ring-1 ring-inset ring-primary/15"><FileText className="size-[18px]" /></span><div className="min-w-0"><p className="text-[14px] font-semibold tracking-tight">Page settings</p><p className="text-[11.5px] leading-snug text-muted">Select anything on the page to edit it. Nothing selected shows this page.</p></div></div>
      <Group title="Page">
        <Row label="Page name" htmlFor="pg-title"><TextControl id="pg-title" value={page.title} maxLength={60} onChange={(e) => set({ title: e.target.value }, "title")} /></Row>
        <Row label="Page address"><SlugControl page={page} doc={doc} onCommit={(slug) => set({ slug })} /></Row>
        <Row label="Page type">
          <SelectControl label="Page type" value={page.kind} onChange={(v) => set({ kind: v, ...(v === "thanks" ? { showInNav: false, noindex: true } : {}) })} options={[{ value: "page", label: "Page" }, { value: "landing", label: "Landing page" }, { value: "thanks", label: "Thank-you page" }]} />
        </Row>
        <Row label="Menu label" htmlFor="pg-nav"><TextControl id="pg-nav" value={page.navLabel} maxLength={30} placeholder={page.title} onChange={(e) => set({ navLabel: e.target.value }, "nav")} /></Row>
        <Toggle label="Show in the menu" checked={page.showInNav} onChange={(v) => set({ showInNav: v })} />
      </Group>
      <Group title="Search and sharing" hint="How this page appears in search results.">
        <div className="rounded-xl border border-line bg-surface p-3">
          <p className="truncate text-[11px] text-muted">{sample}</p>
          <p className="mt-0.5 line-clamp-2 text-[14px] font-medium leading-snug text-[#1a0dab] dark:text-[#8ab4f8]">{title}</p>
          <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-muted">{desc || "Add a description so search engines can describe this page."}</p>
        </div>
        <Row label="Search title" htmlFor="pg-st"><TextControl id="pg-st" value={page.seoTitle} maxLength={70} placeholder={title} onChange={(e) => set({ seoTitle: e.target.value }, "st")} /></Row>
        <Row label="Search description" htmlFor="pg-sd"><AreaControl id="pg-sd" rows={3} value={page.seoDescription} maxLength={160} placeholder={doc.seo.description} onChange={(e) => set({ seoDescription: e.target.value }, "sd")} /></Row>
        <FieldEditor scope="pg" spec={{ key: "ogImage", label: "Sharing image", type: "image", hint: "Shown when someone shares this page." }} value={page.ogImage} onChange={(v) => set({ ogImage: v as Page["ogImage"] })} />
        <Toggle label="Ask search engines not to list this page" checked={page.noindex} onChange={(v) => set({ noindex: v })} />
      </Group>
    </>
  );
}

// ---------------------------------------------------------------------------
// Breadcrumb
// ---------------------------------------------------------------------------

function Crumbs({ doc, selection, actions }: { doc: SiteContent; selection: string; actions: CanvasActions }) {
  const chain = ancestors(doc, selection).filter((n) => n.kind !== "page");
  return (
    <nav aria-label="Where this sits" className="scrollbar-thin flex items-center gap-0.5 overflow-x-auto border-b border-line px-3 py-2 text-[11.5px]">
      <button type="button" onClick={() => actions.select(null)} className="shrink-0 rounded px-1.5 py-0.5 text-muted hover:bg-surface-3 hover:text-ink">Page</button>
      {chain.map((n, i) => (
        <React.Fragment key={n.id}>
          <ChevronRight className="size-3 shrink-0 text-faint" aria-hidden />
          <button type="button" aria-current={i === chain.length - 1 ? "true" : undefined} onClick={() => actions.select(n.id)} className={cn("max-w-[8rem] shrink-0 truncate rounded px-1.5 py-0.5 hover:bg-surface-3", i === chain.length - 1 ? "bg-primary-soft font-medium text-primary-ink" : "text-muted hover:text-ink")}>
            {describeNode(doc, n.id)}
          </button>
        </React.Fragment>
      ))}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// The inspector
// ---------------------------------------------------------------------------

export function Inspector({ doc, selection, pageId, device, actions, advanced }: InspectorProps) {
  const node = selection ? findNode(doc, selection) : null;
  const page = getPage(doc, pageId) ?? doc.pages[0];
  if (!node || !selection) return <div className="min-h-0 flex-1 overflow-y-auto"><PageInspector page={page} doc={doc} actions={actions} /></div>;

  let body: React.ReactNode = null;
  if (node.kind === "element") {
    const el = getElement(doc, selection);
    body = el ? <ElementInspector key={el.id} el={el} doc={doc} device={device} actions={actions} /> : null;
  } else if (node.kind === "column") {
    const col = getColumn(doc, selection);
    body = col ? <ColumnInspector col={col} doc={doc} actions={actions} /> : null;
  } else if (node.kind === "section" || node.kind === "ref") {
    const sec = node.kind === "ref" ? null : getSection(doc, selection);
    if (sec) {
      const role = node.home?.type === "header" ? "header" : node.home?.type === "footer" ? "footer" : "section";
      const shared = node.home?.type === "global";
      const usedOn = shared ? doc.pages.filter((p) => p.items.some((i) => isRef(i) && doc.globals[i.ref]?.id === sec.id)).length : 0;
      body = (
        <SectionInspector
          key={sec.id} sec={sec} role={role} shared={shared}
          readOnlyNote={role === "header" || role === "footer" ? `The ${role} appears on every page.` : shared ? `Used on ${usedOn} page${usedOn === 1 ? "" : "s"}.` : undefined}
          patch={(fn, coalesce) => actions.commit(updateSection(doc, sec.id, fn), coalesce ? { coalesce } : undefined)}
          onColumns={(count) => {
            const used = new Set(collectIds(doc));
            actions.commit(setColumnCount(doc, sec.id, count, () => ({ id: newId(used, "c"), span: 12, gap: "s", pad: "0", surface: "none", elements: [] })));
          }}
        />
      );
    }
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Crumbs doc={doc} selection={selection} actions={actions} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {body ?? <p className="p-4 text-[12.5px] text-muted">That item is no longer on the page.</p>}
        {advanced && body && (node.kind === "section" || node.kind === "element") && (
          <AdvancedGroup key={selection} doc={doc} id={selection} onReplaceSection={(s) => actions.commit(updateSection(doc, selection, (old) => ({ ...s, id: old.id })))} />
        )}
      </div>
    </div>
  );
}

export { Icon };
export type { Section };
