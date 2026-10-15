"use client";

import * as React from "react";
import { Check, Eye, LayoutGrid, List, Monitor, Search, Smartphone, Sparkles, Star, Tablet, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { INDUSTRY_FILTERS, STYLE_FILTERS, filterCards, type GalleryCard, type GallerySort } from "@/lib/website/gallery";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Thumbnail: the real renderer, in an isolated frame, scaled to fit
// ---------------------------------------------------------------------------

const FRAME_W = 1280;
const FRAME_H = 800;

/** A still of the top of a template's home page. The frame loads only when it scrolls into view. */
export function TemplateThumb({ card, frameBase, className }: { card: Pick<GalleryCard, "key" | "name">; frameBase: string; className?: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [scale, setScale] = React.useState(0.25);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setScale(el.clientWidth / FRAME_W);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} className={cn("relative aspect-[16/10] w-full overflow-hidden bg-surface-3", className)}>
      <iframe
        title={`${card.name} template, home page`} src={`${frameBase}?key=${encodeURIComponent(card.key)}&thumb=1`} loading="lazy" tabIndex={-1} aria-hidden scrolling="no"
        className="absolute left-0 top-0 origin-top-left border-0 bg-white" style={{ width: FRAME_W, height: FRAME_H, transform: `scale(${scale})`, pointerEvents: "none" }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

function Tags({ card, limit = 3 }: { card: GalleryCard; limit?: number }) {
  return (
    <ul className="flex flex-wrap gap-1" aria-label="Style">
      <li className={cn("rounded-full px-2 py-0.5 text-[10.5px] font-semibold", card.mode === "dark" ? "bg-ink text-surface" : "bg-surface-3 text-ink-2")}>{card.mode === "dark" ? "Dark" : "Light"}</li>
      {card.tags.filter((t) => t !== "light" && t !== "dark").slice(0, limit - 1).map((t) => <li key={t} className="rounded-full bg-surface-3 px-2 py-0.5 text-[10.5px] font-medium capitalize text-muted">{t}</li>)}
    </ul>
  );
}

interface CardProps {
  card: GalleryCard;
  frameBase: string;
  selected: boolean;
  view: "grid" | "list";
  onPreview: () => void;
  onSelect: () => void;
  chooseLabel: string;
  canChoose: boolean;
  extra?: React.ReactNode;
}

function Card({ card, frameBase, selected, view, onPreview, onSelect, chooseLabel, canChoose, extra }: CardProps) {
  const list = view === "list";
  return (
    <article
      aria-label={`${card.familyName}: ${card.name}`}
      className={cn(
        "group relative overflow-hidden rounded-[22px] border bg-surface transition-all duration-200",
        list ? "grid grid-cols-[minmax(0,15rem)_1fr] sm:grid-cols-[minmax(0,20rem)_1fr]" : "flex flex-col",
        selected ? "border-primary shadow-[0_0_0_3px_color-mix(in_srgb,var(--primary)_28%,transparent),0_18px_40px_-20px_rgb(16_24_40/.35)]" : "border-line shadow-soft hover:-translate-y-0.5 hover:border-line-strong hover:shadow-[0_18px_44px_-22px_rgb(16_24_40/.38)]",
      )}
    >
      <div className="relative">
        <button type="button" onClick={onPreview} aria-label={`Preview ${card.name}`} className="block w-full cursor-zoom-in text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary">
          <TemplateThumb card={card} frameBase={frameBase} />
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-ink/0 opacity-0 transition group-hover:bg-ink/25 group-hover:opacity-100">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink shadow-lg"><Eye className="size-3.5" aria-hidden /> Preview</span>
          </span>
        </button>
        {card.featured && <span className="absolute left-2.5 top-2.5 inline-flex items-center gap-1 rounded-full bg-ink/85 px-2 py-1 text-[10.5px] font-semibold text-white backdrop-blur"><Star className="size-3 fill-current" aria-hidden /> Featured</span>}
        {selected && <span className="absolute right-2.5 top-2.5 flex size-7 items-center justify-center rounded-full bg-primary text-white shadow-lg" role="img" aria-label="Selected"><Check className="size-4" /></span>}
      </div>
      <div className={cn("flex min-w-0 flex-1 flex-col gap-2.5 p-4", list && "sm:p-5")}>
        <div className="min-w-0">
          <p className="truncate text-[10.5px] font-semibold uppercase tracking-[.12em] text-muted">{card.familyName}</p>
          <h3 className="mt-0.5 truncate text-[17px] font-semibold tracking-tight">{card.name}</h3>
        </div>
        <p className={cn("text-[13px] leading-relaxed text-muted", list ? "line-clamp-3" : "line-clamp-2")}>{card.description}</p>
        <Tags card={card} />
        <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
          <Button size="sm" variant="secondary" onClick={onPreview}><Eye className="size-3.5" /> Preview</Button>
          {canChoose && <Button size="sm" variant={selected ? "brand" : "soft"} aria-pressed={selected} onClick={onSelect}>{selected ? <><Check className="size-3.5" /> Selected</> : chooseLabel}</Button>}
          {extra}
        </div>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Full-page preview
// ---------------------------------------------------------------------------

const DEVICES = [{ id: "desktop", label: "Desktop", width: 1440, icon: Monitor }, { id: "tablet", label: "Tablet", width: 768, icon: Tablet }, { id: "mobile", label: "Phone", width: 390, icon: Smartphone }] as const;

export function TemplatePreview({ card, frameBase, onClose, onChoose, chooseLabel, canChoose, selected }: { card: GalleryCard; frameBase: string; onClose: () => void; onChoose: () => void; chooseLabel: string; canChoose: boolean; selected: boolean }) {
  const [device, setDevice] = React.useState<(typeof DEVICES)[number]["id"]>("desktop");
  const [page, setPage] = React.useState("home");
  const wrap = React.useRef<HTMLDivElement>(null);
  const [w, setW] = React.useState(1200);
  const closeRef = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    closeRef.current?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", key);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  React.useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const d = DEVICES.find((x) => x.id === device)!;
  const width = Math.min(d.width, Math.max(320, w - 32));
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#12151c]" role="dialog" aria-modal="true" aria-label={`Preview of ${card.name}`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-white/10 bg-[#0c0f15] px-4 py-2.5 text-white">
        <div className="min-w-0">
          <p className="truncate text-[14px] font-semibold">{card.name} <span className="font-normal text-white/55">· {card.familyName}</span></p>
          <p className="text-[11px] text-white/55">A fictional business with sample content. Your own details are used when you create your website.</p>
        </div>
        <div role="radiogroup" aria-label="Device" className="ml-auto flex rounded-lg bg-white/10 p-0.5">
          {DEVICES.map((x) => (
            <button key={x.id} type="button" role="radio" aria-checked={device === x.id} onClick={() => setDevice(x.id)} className={cn("flex h-8 items-center gap-1.5 rounded-md px-3 text-[12px] font-medium", device === x.id ? "bg-white text-[#0c0f15]" : "text-white/70 hover:text-white")}>
              <x.icon className="size-3.5" aria-hidden />{x.label}<span className="hidden text-[10.5px] opacity-60 md:inline">{x.width}</span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {canChoose && <Button variant="brand" size="sm" onClick={onChoose}>{selected ? "Use this template" : chooseLabel}</Button>}
          <button ref={closeRef} type="button" onClick={onClose} className="flex h-8 items-center gap-1.5 rounded-lg bg-white/10 px-3 text-[12.5px] font-medium hover:bg-white/20"><X className="size-4" aria-hidden /> Close</button>
        </div>
      </div>
      <nav aria-label="Pages in this template" className="scrollbar-thin flex gap-1 overflow-x-auto border-b border-white/10 bg-[#0c0f15] px-4 py-1.5">
        {card.pages.map((p) => (
          <button key={p.slug} type="button" aria-current={page === p.slug ? "page" : undefined} onClick={() => setPage(p.slug)} className={cn("h-7 shrink-0 rounded-md px-3 text-[12px] font-medium", page === p.slug ? "bg-white/15 text-white" : "text-white/60 hover:text-white")}>{p.title}</button>
        ))}
      </nav>
      <div ref={wrap} className="min-h-0 flex-1 overflow-auto p-4">
        <iframe
          key={`${device}-${page}`} title={`${card.name}: ${card.pages.find((p) => p.slug === page)?.title ?? "page"}`} src={`${frameBase}?key=${encodeURIComponent(card.key)}&p=${page}`}
          className="mx-auto block h-full min-h-[24rem] rounded-xl border-0 bg-white shadow-2xl" style={{ width }}
          onLoad={(e) => {
            // Following a link inside the preview moves the tab with it.
            try {
              const slug = new URL((e.currentTarget.contentWindow as Window).location.href).searchParams.get("p");
              if (slug && slug !== page) setPage(slug);
            } catch { /* a navigation we can't read: leave the tab alone */ }
          }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The gallery
// ---------------------------------------------------------------------------

export interface TemplateGalleryProps {
  cards: GalleryCard[];
  frameBase: string;
  onChoose?: (key: string) => void;
  chooseLabel?: string;
  /** The industry filter to lead with (the business's own sector). */
  preferIndustry?: string;
  selectedKey?: string | null;
  onSelect?: (key: string | null) => void;
  /** Extra controls on each card (the agency's feature, hide and edit actions). */
  cardExtra?: (card: GalleryCard) => React.ReactNode;
  emptyHint?: React.ReactNode;
}

export function TemplateGallery({ cards, frameBase, onChoose, chooseLabel = "Use this template", preferIndustry, selectedKey, onSelect, cardExtra, emptyHint }: TemplateGalleryProps) {
  const [q, setQ] = React.useState("");
  const [industry, setIndustry] = React.useState<string>("all");
  const [style, setStyle] = React.useState<string>("all");
  const [sort, setSort] = React.useState<GallerySort>("featured");
  const [view, setView] = React.useState<"grid" | "list">("grid");
  const [preview, setPreview] = React.useState<string | null>(null);
  const [localSel, setLocalSel] = React.useState<string | null>(null);
  const sel = selectedKey !== undefined ? selectedKey : localSel;
  const select = (k: string | null) => (onSelect ? onSelect(k) : setLocalSel(k));
  const canChoose = Boolean(onChoose);
  const filtering = q.trim() !== "" || industry !== "all" || style !== "all";
  const list = React.useMemo(() => filterCards(cards, { q, industry, style, sort, preferIndustry }), [cards, q, industry, style, sort, preferIndustry]);
  const featured = list.filter((c) => c.featured);
  const rest = list.filter((c) => !c.featured);
  const previewCard = cards.find((c) => c.key === preview) ?? null;
  const industries = INDUSTRY_FILTERS.filter((i) => cards.some((c) => c.industries.includes(i.id)));
  const mount = (c: GalleryCard) => <Card key={c.key} card={c} frameBase={frameBase} view={view} selected={sel === c.key} onPreview={() => setPreview(c.key)} onSelect={() => select(sel === c.key ? null : c.key)} chooseLabel={chooseLabel} canChoose={canChoose} extra={cardExtra?.(c)} />;
  const grid = (items: GalleryCard[]) => <div className={cn("grid gap-5", view === "grid" ? "sm:grid-cols-2 xl:grid-cols-3" : "grid-cols-1")}>{items.map(mount)}</div>;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[14rem] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
            <input type="search" aria-label="Search templates" placeholder="Search by name, style or mood" value={q} onChange={(e) => setQ(e.target.value)} className="h-11 w-full rounded-xl border border-line bg-surface pl-10 pr-3 text-[14px] shadow-soft placeholder:text-faint focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-primary/30" />
          </div>
          <label className="sr-only" htmlFor="gal-style">Style</label>
          <select id="gal-style" value={style} onChange={(e) => setStyle(e.target.value)} className="h-11 rounded-xl border border-line bg-surface px-3 text-[13px] shadow-soft">
            <option value="all">Any style</option>
            {STYLE_FILTERS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
          <label className="sr-only" htmlFor="gal-sort">Sort</label>
          <select id="gal-sort" value={sort} onChange={(e) => setSort(e.target.value as GallerySort)} className="h-11 rounded-xl border border-line bg-surface px-3 text-[13px] shadow-soft">
            <option value="featured">Featured first</option><option value="name">Name</option><option value="recent">Recently added</option>
          </select>
          <div role="radiogroup" aria-label="Layout" className="flex rounded-xl border border-line bg-surface p-0.5 shadow-soft">
            {([["grid", "Grid", LayoutGrid], ["list", "List", List]] as const).map(([id, label, Icon]) => (
              <button key={id} type="button" role="radio" aria-checked={view === id} aria-label={`${label} view`} onClick={() => setView(id)} className={cn("flex size-10 items-center justify-center rounded-[10px]", view === id ? "bg-primary-soft text-primary-ink" : "text-muted hover:text-ink")}><Icon className="size-4" /></button>
            ))}
          </div>
        </div>
        <div className="scrollbar-thin -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="group" aria-label="Industry">
          {[{ id: "all", label: `All designs · ${cards.length}` }, ...industries.map((i) => ({ id: i.id, label: i.label }))].map((i) => (
            <button key={i.id} type="button" aria-pressed={industry === i.id} onClick={() => setIndustry(i.id)} className={cn("h-9 shrink-0 rounded-full border px-3.5 text-[13px] font-medium transition-colors", industry === i.id ? "border-primary bg-primary text-white" : "border-line bg-surface text-ink-2 hover:border-line-strong")}>{i.label}</button>
          ))}
        </div>
      </div>

      {list.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-line-strong px-6 py-16 text-center">
          <Sparkles className="mx-auto size-8 text-faint" aria-hidden />
          <p className="mt-3 text-[15px] font-semibold">No designs match that</p>
          <p className="mt-1 text-[13px] text-muted">Try a different word, or clear the filters.</p>
          <Button className="mt-4" variant="secondary" onClick={() => { setQ(""); setIndustry("all"); setStyle("all"); }}>Clear filters</Button>
          {emptyHint}
        </div>
      ) : filtering ? (
        <section aria-label="Results" className="space-y-3">
          <p className="text-[13px] text-muted" role="status">{list.length} design{list.length === 1 ? "" : "s"}</p>
          {grid(list)}
        </section>
      ) : (
        <>
          {featured.length > 0 && (
            <section aria-labelledby="gal-featured" className="space-y-3">
              <h2 id="gal-featured" className="flex items-center gap-2 text-[18px] font-semibold tracking-tight"><Star className="size-4 fill-primary text-primary" aria-hidden /> Featured designs</h2>
              {grid(featured)}
            </section>
          )}
          {rest.length > 0 && (
            <section aria-labelledby="gal-all" className="space-y-3">
              <h2 id="gal-all" className="text-[18px] font-semibold tracking-tight">All designs <span className="text-[14px] font-normal text-muted">· {rest.length} more</span></h2>
              {grid(rest)}
            </section>
          )}
        </>
      )}

      {previewCard && <TemplatePreview card={previewCard} frameBase={frameBase} onClose={() => setPreview(null)} onChoose={() => { select(previewCard.key); setPreview(null); }} chooseLabel={chooseLabel} canChoose={canChoose} selected={sel === previewCard.key} />}

      {canChoose && sel && (
        <div className="sticky bottom-4 z-30 mx-auto flex max-w-2xl items-center justify-between gap-3 rounded-2xl border border-line bg-surface/95 p-3 pl-5 shadow-[0_18px_50px_-18px_rgb(16_24_40/.5)] backdrop-blur" role="region" aria-label="Your selection">
          <p className="min-w-0 truncate text-[13.5px]"><span className="text-muted">Selected:</span> <strong className="font-semibold">{cards.find((c) => c.key === sel)?.familyName} · {cards.find((c) => c.key === sel)?.name}</strong></p>
          <div className="flex shrink-0 gap-2">
            <Button variant="ghost" size="sm" onClick={() => select(null)}>Clear</Button>
            <Button variant="secondary" size="sm" onClick={() => setPreview(sel)}><Eye className="size-3.5" /> Preview</Button>
            <Button variant="brand" size="sm" onClick={() => onChoose?.(sel)}>{chooseLabel}</Button>
          </div>
        </div>
      )}
    </div>
  );
}
