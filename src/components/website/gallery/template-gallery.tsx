"use client";

import * as React from "react";
import { Check, Eye, LayoutGrid, List, Sparkles, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/primitives";
import { InfoChip } from "@/components/ui/status";
import { EMPTY_GALLERY_FILTERS, INDUSTRY_FILTERS, filterCards, type GalleryCard, type GalleryFilters as FilterState } from "@/lib/website/gallery";
import { GalleryFilters } from "./gallery-filters";
import { useUrlState } from "./use-url-state";
import { PreviewShell } from "@/components/website/frame/preview-shell";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Thumbnail: the real renderer, in an isolated frame, scaled to fit
// ---------------------------------------------------------------------------

export { TemplateThumb } from "./template-thumbnail";
import { TemplateThumb } from "./template-thumbnail";

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

function Tags({ card, limit = 3 }: { card: GalleryCard; limit?: number }) {
  return (
    <ul className="flex flex-wrap gap-1" aria-label="Style">
      <li className={cn("rounded-full px-2 py-0.5 text-[12px] font-semibold", card.mode === "dark" ? "bg-ink text-surface" : "bg-surface-3 text-ink-2")}>{card.mode === "dark" ? "Dark" : "Light"}</li>
      {card.tags.filter((t) => t !== "light" && t !== "dark").slice(0, limit - 1).map((t) => <li key={t} className="rounded-full bg-surface-3 px-2 py-0.5 text-[12px] font-medium capitalize text-ink-2">{t}</li>)}
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
  priority?: boolean;
}

function Card({ card, frameBase, selected, view, onPreview, onSelect, chooseLabel, canChoose, extra, priority }: CardProps) {
  const list = view === "list";
  return (
    <article
      aria-label={`${card.familyName}: ${card.name}`}
      className={cn(
        "group relative overflow-hidden rounded-[20px] border bg-surface transition-[border-color,box-shadow] duration-200 motion-reduce:transition-none focus-within:border-primary/50",
        list ? "grid grid-cols-1 sm:grid-cols-[minmax(0,20rem)_1fr]" : "flex flex-col",
        selected ? "border-primary shadow-[0_0_0_3px_color-mix(in_srgb,var(--primary)_28%,transparent),0_18px_40px_-20px_rgb(16_24_40/.35)]" : "border-line shadow-soft hover:border-line-strong hover:shadow-md",
      )}
    >
      <div className="relative">
        <button type="button" onClick={onPreview} aria-label={`Preview ${card.name}`} className="block w-full cursor-zoom-in text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary">
          <TemplateThumb card={card} frameBase={frameBase} priority={priority} />
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-ink/0 opacity-0 transition group-hover:bg-ink/25 group-hover:opacity-100">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink shadow-lg"><Eye className="size-3.5" aria-hidden /> Preview</span>
          </span>
        </button>
        {card.featured && <span className="absolute left-2.5 top-2.5 inline-flex items-center gap-1 rounded-full bg-ink/85 px-2 py-1 text-[12px] font-semibold text-white backdrop-blur"><Star className="size-3 fill-current" aria-hidden /> Featured</span>}
        {selected && <span className="absolute right-2.5 top-2.5 flex size-7 items-center justify-center rounded-full bg-primary text-white shadow-lg" role="img" aria-label="Selected"><Check className="size-4" /></span>}
      </div>
      <div className={cn("flex min-w-0 flex-1 flex-col gap-3 p-5", list && "sm:p-6")}>
        <div className="min-w-0">
          <p className="truncate text-[12px] font-semibold uppercase tracking-[.12em] text-muted">{card.familyName}</p>
          <h2 className="mt-1 truncate text-[20px] font-semibold tracking-tight">{card.name}</h2>
        </div>
        <p className={cn("text-[14px] leading-relaxed text-muted", list ? "line-clamp-3" : "line-clamp-2")}>{card.description}</p>
        {card.industries.length > 0 && <div className="flex flex-wrap gap-1.5">{card.industries.map((id) => INDUSTRY_FILTERS.find((i) => i.id === id)?.label).filter(Boolean).slice(0, 2).map((label) => <InfoChip key={label}>{label}</InfoChip>)}</div>}
        <Tags card={card} />
        <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-line pt-4">
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

export function TemplatePreview({ card, frameBase, onClose, onChoose, chooseLabel, canChoose, selected }: { card: GalleryCard; frameBase: string; onClose: () => void; onChoose: () => void; chooseLabel: string; canChoose: boolean; selected: boolean }) {
  const [page, setPage] = React.useState("home");
  return <PreviewShell title={card.name} subtitle={card.familyName} src={`${frameBase}?key=${encodeURIComponent(card.key)}&p=${page}`} onClose={onClose}
    pages={card.pages} page={page} onPageChange={setPage} actions={canChoose ? <Button variant="brand" size="sm" onClick={onChoose}>{selected ? "Use this template" : chooseLabel}</Button> : undefined} />;
}
// ---------------------------------------------------------------------------
// The gallery
// ---------------------------------------------------------------------------

// The view the reader chose lives in the address (see useUrlState), so returning from a preview, an editor or a refresh keeps it.
type GalleryUrlState = { [K in keyof FilterState]: string } & { collection: string; view: string };
const URL_DEFAULTS: GalleryUrlState = { ...EMPTY_GALLERY_FILTERS, collection: "all", view: "grid" };
const URL_ALLOWED = { sort: ["featured", "name", "recent", "updated"], theme: ["all", "light", "dark"], collection: ["all", "featured"], view: ["grid", "list"] } as const;

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
  const [url, setUrl] = useUrlState<GalleryUrlState>(URL_DEFAULTS, URL_ALLOWED);
  const filters = React.useMemo<FilterState>(() => ({ q: url.q, industry: url.industry, family: url.family, style: url.style, theme: url.theme, layout: url.layout, typography: url.typography, sort: url.sort as FilterState["sort"] }), [url]);
  const collection = url.collection as "all" | "featured";
  const view = url.view as "grid" | "list";
  const setFilters = (next: FilterState) => setUrl(next);
  const setCollection = (next: "all" | "featured") => setUrl({ collection: next });
  const setView = (next: "grid" | "list") => setUrl({ view: next });
  const [preview, setPreview] = React.useState<string | null>(null);
  const [localSel, setLocalSel] = React.useState<string | null>(null);
  const sel = selectedKey !== undefined ? selectedKey : localSel;
  const select = (k: string | null) => (onSelect ? onSelect(k) : setLocalSel(k));
  const canChoose = Boolean(onChoose);
  const scope = React.useMemo(() => filterCards(cards, { ...filters, preferIndustry }), [cards, filters, preferIndustry]);
  const featuredCount = scope.filter((c) => c.featured).length;
  const list = collection === "featured" ? scope.filter((c) => c.featured) : scope;
  const previewCard = cards.find((c) => c.key === preview) ?? null;
  const mount = (c: GalleryCard, index: number) => <Card key={c.key} card={c} frameBase={frameBase} view={view} selected={sel === c.key} onPreview={() => setPreview(c.key)} onSelect={() => select(sel === c.key ? null : c.key)} chooseLabel={chooseLabel} canChoose={canChoose} extra={cardExtra?.(c)} priority={index < 3} />;
  const clear = () => { setFilters({ ...EMPTY_GALLERY_FILTERS }); setCollection("all"); };

  return (
    <div className="space-y-5">
      <GalleryFilters cards={cards} value={filters} onChange={setFilters} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="Template collection" className="flex rounded-xl border border-line bg-surface p-1">
          {([{ id: "all", label: "All templates", count: scope.length }, { id: "featured", label: "Featured", count: featuredCount }] as const).map((item) => <button key={item.id} type="button" aria-pressed={collection === item.id} onClick={() => setCollection(item.id)} className={cn("inline-flex min-h-10 items-center gap-2 rounded-lg px-3.5 text-[14px] font-medium focus-visible:outline-2 focus-visible:outline-primary", collection === item.id ? "bg-primary-soft text-primary-ink" : "text-muted hover:bg-surface-2 hover:text-ink")}>{item.id === "featured" && <Star className="size-3.5" aria-hidden />}{item.label}<span className={cn("rounded-md px-1.5 py-0.5 text-[12px] tabular-nums", collection === item.id ? "bg-primary/10" : "bg-surface-3")}>{item.count}</span></button>)}
        </div>
        <div className="flex items-center gap-3">
          <p className="text-[12px] text-muted" role="status">{list.length} design{list.length === 1 ? "" : "s"}</p>
          <div role="group" aria-label="Gallery layout" className="flex rounded-xl border border-line bg-surface p-0.5">
            {([["grid", "Grid", LayoutGrid], ["list", "List", List]] as const).map(([id, label, Icon]) => <button key={id} type="button" aria-pressed={view === id} aria-label={`${label} view`} onClick={() => setView(id)} className={cn("flex size-10 items-center justify-center rounded-[10px] focus-visible:outline-2 focus-visible:outline-primary", view === id ? "bg-primary-soft text-primary-ink" : "text-muted hover:text-ink")}><Icon className="size-4" aria-hidden /></button>)}
          </div>
        </div>
      </div>
      {list.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line-strong">
          <EmptyState
            icon={<Sparkles className="size-5" />} title="No designs match"
            description={collection === "featured" && featuredCount === 0 ? "No featured designs match these filters. Explore the full collection for your next starting point." : "No designs match these filters. Try another industry, family or search term."}
            action={<Button variant="secondary" onClick={clear}>Clear filters</Button>}
          />
          {emptyHint}
        </div>
      ) : <section aria-label="Template results" className={cn("grid gap-5", view === "grid" ? "sm:grid-cols-2 xl:grid-cols-3" : "grid-cols-1")}>{list.map(mount)}</section>}

      {previewCard && <TemplatePreview card={previewCard} frameBase={frameBase} onClose={() => setPreview(null)} onChoose={() => { select(previewCard.key); setPreview(null); }} chooseLabel={chooseLabel} canChoose={canChoose} selected={sel === previewCard.key} />}

      {canChoose && sel && (
        <div className="sticky bottom-4 z-30 mx-auto flex max-w-2xl flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface/95 p-3 sm:pl-5 shadow-[0_18px_50px_-18px_rgb(16_24_40/.3)] backdrop-blur" role="region" aria-label="Your selection">
          <p className="flex min-w-0 items-center gap-2 text-[14px]"><span className="inline-flex h-6 shrink-0 items-center rounded-full bg-primary-soft px-2.5 text-[12px] font-medium text-primary-ink ring-1 ring-inset ring-primary/20">Selected</span><strong className="min-w-0 truncate font-semibold">{cards.find((c) => c.key === sel)?.name}</strong></p>
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
