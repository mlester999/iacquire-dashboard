"use client";

import * as React from "react";
import {
  AlignLeft, BarChart3, ChevronDown, Columns3, Cpu, FileText, HelpCircle, Image as ImageIcon, LayoutGrid, List, ListChecks, Mail, MapPin, MessageSquareQuote, MousePointerClick, Navigation, Play, Quote, Search, Share2, Sparkles,
  Square, Tag, Type, Users, Minus, MoveVertical, Rows3, Smile, Star, Wallet,
} from "lucide-react";
import { SiteRenderer } from "@/components/website/render/site-renderer";
import type { ElementType } from "@/lib/website/catalog";
import type { SiteContent, Section } from "@/lib/website/doc";
import { buildLayout, buildPreset, elementPresetGroups, LAYOUT_PRESETS, presetsByCategory, SECTION_PRESETS, type SectionPreset } from "@/lib/website/editor/library";
import { cn } from "@/lib/utils";
import { TextControl } from "./controls";
import { useDrag, type DragSource } from "./drag";

export interface SavedSection {
  id: string;
  name: string;
  scope: "site" | "agency";
  section: Section;
}

export const ELEMENT_ICONS: Partial<Record<ElementType, React.ComponentType<{ className?: string }>>> = {
  heading: Type, text: AlignLeft, image: ImageIcon, button: MousePointerClick, group: Rows3, card: Square, icon: Star, divider: Minus, spacer: MoveVertical, badge: Tag, list: ListChecks,
  services: LayoutGrid, steps: List, faq: HelpCircle, testimonials: Quote, stats: BarChart3, logos: Cpu, team: Users, pricing: Wallet, gallery: ImageIcon, collage: Columns3, video: Play,
  contactInfo: MapPin, social: Share2, nav: Navigation, logo: Smile, form: Mail, map: MapPin, marquee: MessageSquareQuote,
};

// ---------------------------------------------------------------------------
// A miniature of a section, drawn by the real renderer and scaled to fit
// ---------------------------------------------------------------------------

const VIRTUAL = 1100;

export function ScaledPreview({ content, scope, maxHeight = 132, pageSlug = "home" }: { content: SiteContent; scope: string; maxHeight?: number; pageSlug?: string }) {
  const outer = React.useRef<HTMLDivElement>(null);
  const inner = React.useRef<HTMLDivElement>(null);
  const [scale, setScale] = React.useState(0.24);
  const [h, setH] = React.useState(maxHeight);
  React.useEffect(() => {
    const o = outer.current;
    const i = inner.current;
    if (!o || !i) return;
    const measure = () => {
      const s = o.clientWidth / VIRTUAL;
      setScale(s);
      setH(Math.min(maxHeight, Math.max(36, i.offsetHeight * s)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(o);
    ro.observe(i);
    return () => ro.disconnect();
  }, [maxHeight]);
  return (
    <div ref={outer} className="relative w-full overflow-hidden bg-white" style={{ height: h }} aria-hidden>
      <div ref={inner} className="pointer-events-none absolute left-0 top-0 origin-top-left" style={{ width: VIRTUAL, transform: `scale(${scale})` }}>
        <SiteRenderer content={content} pageSlug={pageSlug} resolveAsset={() => null} mode="preview" formAction={null} hrefFor={() => "#"} embedded viewportHeight={760} scope={scope} />
      </div>
    </div>
  );
}

/** Mounts its preview only once it scrolls into view, so a long list stays light. */
function LazyPreview({ build, scope, base }: { build: () => Section | null; scope: string; base: SiteContent }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [seen, setSeen] = React.useState(false);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => { if (e[0].isIntersecting) { setSeen(true); io.disconnect(); } }, { rootMargin: "120px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const content = React.useMemo(() => {
    if (!seen) return null;
    const section = build();
    if (!section) return null;
    const isHeader = section.id === "header";
    const isFooter = section.id === "footer";
    return {
      ...base, header: isHeader ? section : null, footer: isFooter ? section : null, globals: {},
      pages: [{ id: "pg-pv", slug: "home", title: "Preview", kind: "page" as const, navLabel: "", showInNav: false, seoTitle: "", seoDescription: "", ogImage: null, noindex: true, items: isHeader || isFooter ? [] : [section] }],
    } satisfies SiteContent;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seen, base]);
  return <div ref={ref} className="min-h-9 overflow-hidden rounded-t-[10px] bg-surface-3">{content && <ScaledPreview content={content} scope={scope} />}</div>;
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

type Sub = "sections" | "layouts" | "elements" | "saved";

export function AddPanel({
  doc, onInsert, saved, canSave, initialSub, onDeleteSaved, canDeleteShared = false,
}: { doc: SiteContent; onInsert: (source: DragSource) => void; saved: SavedSection[]; canSave: boolean; initialSub?: Sub; onDeleteSaved?: (s: SavedSection) => void; canDeleteShared?: boolean }) {
  const [removing, setRemoving] = React.useState<string | null>(null);
  const [sub, setSub] = React.useState<Sub>(initialSub ?? "sections");
  const [q, setQ] = React.useState("");
  const drag = useDrag();
  const [open, setOpen] = React.useState<Set<string>>(new Set(["Hero"]));
  // Previews follow the site's look and facts, but not every keystroke.
  const [base, setBase] = React.useState(doc);
  React.useEffect(() => {
    const t = window.setTimeout(() => setBase(doc), 700);
    return () => window.clearTimeout(t);
    // Previews follow the site's look and facts, so only those restart the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.design, doc.business, doc.seo.description]);

  const matches = (label: string, description: string, category: string) => !q.trim() || `${label} ${description} ${category}`.toLowerCase().includes(q.toLowerCase());
  const groups = presetsByCategory().map((g) => ({ ...g, presets: g.presets.filter((p) => matches(p.label, p.description, g.category)) })).filter((g) => g.presets.length);
  const press = (source: DragSource) => (e: React.PointerEvent) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    drag.start(source, e);
  };
  const click = (source: DragSource) => () => {
    if (drag.justDragged()) return;
    onInsert(source);
  };
  const preset = (p: SectionPreset) => (
    <li key={p.id}>
      <button type="button" onPointerDown={press({ kind: "section-preset", presetId: p.id, label: p.label })} onClick={click({ kind: "section-preset", presetId: p.id, label: p.label })} style={{ touchAction: "pan-y" }}
        className="group block w-full overflow-hidden rounded-xl border border-line bg-surface text-left shadow-soft transition hover:border-primary hover:shadow-md focus-visible:outline-2 focus-visible:outline-primary" aria-label={`Add ${p.label}. ${p.description}`}>
        <LazyPreview build={() => buildPreset(base, p)} scope={`pv-${p.id}`} base={base} />
        <span className="block px-2.5 py-2">
          <span className="block truncate text-[12.5px] font-semibold">{p.label}</span>
          <span className="mt-0.5 line-clamp-2 block text-[11px] leading-snug text-muted">{p.description}</span>
        </span>
      </button>
    </li>
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-2 px-4 pb-2 pt-3">
        <div className="flex rounded-lg bg-surface-3 p-0.5" role="tablist" aria-label="What to add">
          {([["sections", "Sections"], ["layouts", "Layouts"], ["elements", "Elements"], ["saved", "Saved"]] as const).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={sub === id} onClick={() => setSub(id)} className={cn("h-7 flex-1 rounded-md text-[12px] font-medium transition-colors", sub === id ? "bg-surface text-ink shadow-soft" : "text-muted hover:text-ink")}>{label}</button>
          ))}
        </div>
        {(sub === "sections" || sub === "elements") && (
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" aria-hidden />
            <TextControl aria-label={`Search ${sub}`} placeholder={`Search ${sub}`} value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
          </div>
        )}
        <p className="text-[11px] leading-relaxed text-muted">Click to add, or drag onto the page. Sections go after the one you have selected.</p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        {sub === "sections" && (
          <div className="space-y-2">
            {groups.map((g) => {
              const isOpen = Boolean(q.trim()) || open.has(g.category);
              return (
                <section key={g.category}>
                  <button type="button" aria-expanded={isOpen} onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(g.category)) n.delete(g.category); else n.add(g.category); return n; })} className="flex min-h-8 w-full items-center justify-between rounded-lg px-1.5 text-left text-[12px] font-semibold text-ink-2 hover:bg-surface-2">
                    <span>{g.category} <span className="font-normal text-muted">· {g.presets.length}</span></span>
                    <ChevronDown className={cn("size-3.5 text-muted transition-transform", !isOpen && "-rotate-90")} aria-hidden />
                  </button>
                  {isOpen && <ul className="mt-1.5 grid gap-2.5 pb-2">{g.presets.map(preset)}</ul>}
                </section>
              );
            })}
            {!groups.length && <p className="py-8 text-center text-[12px] text-muted">Nothing matches “{q}”.</p>}
          </div>
        )}
        {sub === "layouts" && (
          <ul className="grid gap-2 pt-1">
            {LAYOUT_PRESETS.map((l) => (
              <li key={l.id}>
                <button type="button" onPointerDown={press({ kind: "layout", layoutId: l.id, label: l.label })} onClick={click({ kind: "layout", layoutId: l.id, label: l.label })} style={{ touchAction: "pan-y" }}
                  className="flex w-full items-center gap-3 rounded-xl border border-line bg-surface p-2.5 text-left hover:border-primary focus-visible:outline-2 focus-visible:outline-primary" aria-label={`Add a section with ${l.label.toLowerCase()}`}>
                  <span className="flex h-9 w-20 shrink-0 gap-1 rounded-md bg-surface-3 p-1" aria-hidden>{l.spans.map((s, i) => <span key={i} className="rounded-[3px] bg-primary/30" style={{ flex: s }} />)}</span>
                  <span className="text-[12.5px] font-medium">{l.label}</span>
                </button>
              </li>
            ))}
            <li className="pt-1 text-[11px] leading-relaxed text-muted">A layout is an empty arrangement of columns. Drop elements into them, or change the columns later.</li>
          </ul>
        )}
        {sub === "elements" && (
          <div className="space-y-3 pt-1">
            {elementPresetGroups().map((g) => {
              const items = g.items.filter((e) => matches(e.label, e.description, g.group));
              if (!items.length) return null;
              return (
                <section key={g.group}>
                  <p className="px-1.5 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted">{g.group}</p>
                  <ul className="grid grid-cols-2 gap-1.5">
                    {items.map((e) => {
                      const I = ELEMENT_ICONS[e.type] ?? Sparkles;
                      return (
                        <li key={e.type}>
                          <button type="button" onPointerDown={press({ kind: "element", type: e.type, label: e.label })} onClick={click({ kind: "element", type: e.type, label: e.label })} style={{ touchAction: "pan-y" }} title={e.description} aria-label={`Add ${e.label}. ${e.description}`}
                            className="flex h-14 w-full flex-col items-center justify-center gap-1 rounded-xl border border-line bg-surface text-[11.5px] font-medium text-ink-2 hover:border-primary hover:text-ink focus-visible:outline-2 focus-visible:outline-primary">
                            <I className="size-4 text-primary" /><span className="max-w-full truncate px-1">{e.label}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
        {sub === "saved" && (
          <div className="space-y-2 pt-1">
            {saved.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-line-strong px-5 py-8 text-center">
                <FileText className="mx-auto size-7 text-faint" aria-hidden />
                <p className="mt-2 text-[13px] font-medium">No saved components yet</p>
                <p className="mt-1 text-[12px] leading-relaxed text-muted">{canSave ? "Select a section, open its “more” menu and choose “Save as a component” to reuse it on other pages." : "Components saved by your team or the agency will appear here."}</p>
              </div>
            ) : (
              <ul className="grid gap-2.5">
                {saved.map((s) => {
                  const source: DragSource = { kind: "saved", savedId: s.id, label: s.name };
                  return (
                    <li key={s.id}>
                      <button type="button" onPointerDown={press(source)} onClick={click(source)} style={{ touchAction: "pan-y" }} className="block w-full overflow-hidden rounded-xl border border-line bg-surface text-left shadow-soft hover:border-primary focus-visible:outline-2 focus-visible:outline-primary" aria-label={`Add ${s.name}`}>
                        <LazyPreview build={() => s.section} scope={`sv-${s.id}`} base={base} />
                        <span className="flex items-center justify-between px-2.5 py-2"><span className="truncate text-[12.5px] font-semibold">{s.name}</span><span className="rounded bg-surface-3 px-1.5 py-px text-[10px] font-medium text-muted">{s.scope === "agency" ? "From iAcquire" : "Yours"}</span></span>
                      </button>
                      {onDeleteSaved && (s.scope === "site" || canDeleteShared) && (
                        <div className="mt-1 flex justify-end">
                          {removing === s.id ? (
                            <span className="flex items-center gap-2 text-[11.5px]">
                              <span className="text-muted">Pages already using it keep their copy.</span>
                              <button type="button" onClick={() => { setRemoving(null); onDeleteSaved(s); }} className="rounded-md bg-danger-soft px-2 py-0.5 font-medium text-danger-ink">Remove</button>
                              <button type="button" onClick={() => setRemoving(null)} className="font-medium text-muted hover:text-ink">Keep</button>
                            </span>
                          ) : (
                            <button type="button" onClick={() => setRemoving(s.id)} className="text-[11.5px] font-medium text-muted hover:text-danger-ink" aria-label={`Remove saved section ${s.name}`}>Remove from my sections</button>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export { SECTION_PRESETS, buildLayout };
