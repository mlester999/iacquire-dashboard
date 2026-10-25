"use client";

import * as React from "react";
import { Search, SlidersHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/overlays";
import { EMPTY_GALLERY_FILTERS, INDUSTRY_FILTERS, LAYOUT_FILTERS, STYLE_FILTERS, TYPOGRAPHY_FILTERS, templateStyles, type DiscoverableTemplate, type GalleryFilters as Filters } from "@/lib/website/gallery";

const SELECT_CLASS = "h-11 rounded-xl border border-line bg-surface px-3 text-[13px] text-ink-2 outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/25";

export function GalleryFilters({ cards, value, onChange, actions }: { cards: DiscoverableTemplate[]; value: Filters; onChange: (filters: Filters) => void; actions?: React.ReactNode }) {
  const id = React.useId();
  const set = (key: keyof Filters, next: string) => onChange({ ...value, [key]: next });
  const families = [...new Map(cards.map((c) => [c.familyId, c.familyName])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const industries = INDUSTRY_FILTERS.filter((i) => cards.some((c) => c.industries.includes(i.id)));
  const styles = STYLE_FILTERS.filter((s) => s.id !== "light" && s.id !== "dark" && cards.some((c) => templateStyles(c).includes(s.id)));
  const layouts = LAYOUT_FILTERS.filter((l) => cards.some((c) => c.layout === l.id));
  const typography = TYPOGRAPHY_FILTERS.filter((t) => cards.some((c) => c.typography === t.id));
  const advanced = [value.style, value.theme, value.layout, value.typography].filter((x) => x !== "all").length;
  const fields: Array<{ key: keyof Filters; label: string; options: Array<{ id: string; label: string }> }> = [
    { key: "style", label: "Design style", options: styles },
    { key: "theme", label: "Color theme", options: [{ id: "light", label: "Light" }, { id: "dark", label: "Dark" }] },
    { key: "layout", label: "Layout", options: layouts },
    { key: "typography", label: "Heading typography", options: typography },
  ];
  const chips = [
    ...(value.q.trim() ? [{ key: "q" as const, label: `“${value.q.trim()}”` }] : []),
    ...(value.industry !== "all" ? [{ key: "industry" as const, label: INDUSTRY_FILTERS.find((i) => i.id === value.industry)?.label ?? value.industry }] : []),
    ...(value.family !== "all" ? [{ key: "family" as const, label: families.find(([key]) => key === value.family)?.[1] ?? value.family }] : []),
    ...fields.filter((f) => value[f.key] !== "all").map((f) => ({ key: f.key, label: f.options.find((o) => o.id === value[f.key])?.label ?? value[f.key] })),
  ];

  return <div className="space-y-3 rounded-2xl border border-line bg-surface/70 p-3 sm:p-4">
    <div className="flex flex-wrap items-center gap-2.5">
      <div className="relative min-w-[min(100%,15rem)] flex-1 basis-full sm:basis-auto">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
        <input type="search" aria-label="Search templates" placeholder="Find a design, industry or mood…" value={value.q} onChange={(e) => set("q", e.target.value)} className="h-11 w-full rounded-xl border border-line bg-surface pl-10 pr-3 text-[14px] text-ink placeholder:text-faint focus-visible:outline-2 focus-visible:outline-primary/40" />
      </div>
      {industries.length > 0 && <select aria-label="Industry" value={value.industry} onChange={(e) => set("industry", e.target.value)} className={`${SELECT_CLASS} min-w-36 max-w-full flex-1 sm:max-w-[13rem] sm:flex-none`}><option value="all">All industries</option>{industries.map((i) => <option key={i.id} value={i.id}>{i.label}</option>)}</select>}
      <select aria-label="Template family" value={value.family} onChange={(e) => set("family", e.target.value)} className={`${SELECT_CLASS} min-w-36 flex-1 sm:flex-none`}><option value="all">All families</option>{families.map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select>
      <Popover><PopoverTrigger asChild><Button variant="secondary" className="h-11"><SlidersHorizontal className="size-4" aria-hidden /> Filters{advanced > 0 && <span className="rounded-full bg-primary-soft px-1.5 text-primary-ink">{advanced}</span>}</Button></PopoverTrigger>
        <PopoverContent align="end" className="w-[min(22rem,calc(100vw-2rem))] p-4">
          <p className="text-[14px] font-semibold">Refine your design</p>
          <div className="mt-3 grid grid-cols-2 gap-3">{fields.filter((f) => f.options.length > 0).map((f) => <label key={f.key} htmlFor={`${id}-${f.key}`} className="flex min-w-0 flex-col gap-1.5 text-[12px] font-medium text-muted">{f.label}<select id={`${id}-${f.key}`} value={value[f.key]} onChange={(e) => set(f.key, e.target.value)} className={SELECT_CLASS}><option value="all">Any</option>{f.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select></label>)}</div>
        </PopoverContent>
      </Popover>
      <select aria-label="Sort templates" value={value.sort} onChange={(e) => set("sort", e.target.value)} className={`${SELECT_CLASS} min-w-36 flex-1 sm:flex-none`}><option value="featured">Featured first</option><option value="recent">Recently added</option><option value="updated">Recently updated</option><option value="name">Alphabetical</option></select>
      {actions}
    </div>
    {chips.length > 0 && <div role="group" className="flex flex-wrap items-center gap-1.5" aria-label="Active filters">{chips.map((chip) => <button key={chip.key} type="button" aria-label={`Remove ${chip.label} filter`} onClick={() => set(chip.key, chip.key === "q" ? "" : "all")} className="inline-flex min-h-8 items-center gap-1.5 rounded-lg bg-primary-soft px-2.5 text-[12px] font-medium text-primary-ink hover:bg-primary/15 focus-visible:outline-2 focus-visible:outline-primary">{chip.label}<X className="size-3" aria-hidden /></button>)}<button type="button" onClick={() => onChange({ ...EMPTY_GALLERY_FILTERS, sort: value.sort })} className="min-h-8 px-2 text-[12px] font-medium text-muted underline-offset-4 hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-primary">Clear filters</button></div>}
  </div>;
}
