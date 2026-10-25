"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Briefcase, Check, CircleDollarSign, EyeOff, FileText, FolderPlus, History, ListChecks, Pencil, Plus, Settings2, Star, Search, LayoutGrid, List, MoreHorizontal, Workflow, Bot, Code2, Clock, Layers, Tags } from "lucide-react";
import { motion,useReducedMotion } from "motion/react";
import { EmptyState, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { Dialog,Menu,MenuTrigger,MenuContent,MenuItem,MenuSeparator } from "@/components/ui/overlays";
import { CoverageBar, MetricCard, PageHero, SectionLabel } from "@/components/ui/workspace";
import { InfoChip, StatusPill, type StatusTone } from "@/components/ui/status";
import { TechnologyPill } from "@/components/projects/visuals";
import { useRunner } from "@/components/projects/common";
import { priceHistoryAction, saveCategoryAction, saveServiceAction, setServiceFlagsAction } from "@/app/(admin)/admin/services/actions";
import { MARKETPLACE_FILTERS, formatDelivery, formatMoney, formatPrice, type PriceType, type ServiceAvailability, type ServiceKind, type ServiceView } from "@/lib/projects";
import type { AdminCategory } from "@/server/catalog/service";
import { cn, formatDateTime, pluralize } from "@/lib/utils";

const lines = (v: string) => v.split("\n").map((x) => x.trim()).filter(Boolean);
const commas = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);
const dollars = (v: string) => {
  const n = Number.parseFloat(v.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
const slugify = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
const FILTER_TAGS = MARKETPLACE_FILTERS.filter((f) => f.id !== "all");

const AVAILABILITY: Record<ServiceAvailability, { label: string; tone: StatusTone }> = {
  available: { label: "Available", tone: "success" },
  coming_soon: { label: "Coming soon", tone: "primary" },
  unavailable: { label: "Unavailable", tone: "neutral" },
};

/** A titled group inside a long editor dialog: icon tile, heading and a one-line hint, then its fields. */
export function FormSection({ icon, title, description, children }: { icon: React.ReactNode; title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4 sm:col-span-2 [&:not(:first-child)]:mt-3">
      <header className="flex items-center gap-3 border-b border-line pb-3">
        <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary-ink [&>svg]:size-4">
          {icon}
        </span>
        <div className="min-w-0">
          <h3 className="text-[14px] font-semibold tracking-tight text-ink">{title}</h3>
          {description && <p className="text-[12px] leading-snug text-muted">{description}</p>}
        </div>
      </header>
      <div className="grid gap-4 sm:grid-cols-2">{children}</div>
    </section>
  );
}

/** A checkbox presented as a labelled row, so on/off settings are easy to find, hit and scan. */
export function CheckRow({ checked, onChange, title, description, disabled, hint, className }: { checked: boolean; onChange: (checked: boolean) => void; title: React.ReactNode; description?: React.ReactNode; disabled?: boolean; hint?: string; className?: string }) {
  return (
    <label
      title={hint}
      className={cn(
        "flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border p-3 transition has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary",
        checked ? "border-primary/35 bg-primary-soft/50" : "border-line bg-surface hover:bg-surface-2",
        disabled && "pointer-events-none opacity-60",
        className,
      )}
    >
      <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-primary" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="min-w-0">
        <span className="block text-[14px] font-medium leading-snug text-ink">{title}</span>
        {description && <span className="mt-0.5 block text-[12px] leading-relaxed text-muted">{description}</span>}
      </span>
    </label>
  );
}

/** A selectable pill for multi-choice lists. The tick keeps the selected state readable without colour. */
export function ChoiceChip({ checked, onChange, children, disabled, title }: { checked: boolean; onChange: () => void; children: React.ReactNode; disabled?: boolean; title?: string }) {
  return (
    <label
      title={title}
      className={cn(
        disabled && "pointer-events-none opacity-55",
        "inline-flex min-h-10 cursor-pointer items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-medium transition has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary sm:min-h-9",
        checked ? "border-primary/40 bg-primary-soft text-primary-ink" : "border-line-strong bg-surface text-ink-2 hover:bg-surface-2",
      )}
    >
      <input type="checkbox" className="sr-only" checked={checked} disabled={disabled} onChange={onChange} />
      {checked && <Check aria-hidden className="size-3.5" />}
      {children}
    </label>
  );
}

/** A filter tab with a count bubble, the same tab pattern as the Clients page. */
export function FilterTab({ active, onClick, count, children }: { active: boolean; onClick: () => void; count?: number; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn("inline-flex min-h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-3.5 text-[13px] font-medium transition sm:min-h-9", active ? "bg-ink text-surface shadow-soft" : "text-muted hover:bg-surface-2 hover:text-ink")}
    >
      {children}
      {count !== undefined && <span className={cn("inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[12px] font-semibold tabular-nums", active ? "bg-surface/20 text-surface" : "bg-surface-3 text-ink-2")}>{count}</span>}
    </button>
  );
}

interface FormState {
  id?: string;
  categoryId: string;
  slug: string;
  kind: ServiceKind;
  name: string;
  tagline: string;
  description: string;
  problemSolved: string;
  accomplishes: string;
  deliverables: string;
  exclusions: string;
  optionalUpgrades: string;
  platforms: string;
  useCases: string;
  tags: string[];
  keywords: string;
  deliveryMin: string;
  deliveryMax: string;
  availability: ServiceAvailability;
  featured: boolean;
  requiresQuote: boolean;
  visible: boolean;
  coreOverlapNote: string;
  sortOrder: string;
  allowance: string;
  priceType: PriceType;
  priceMin: string;
  priceMax: string;
  priceNote: string;
  portfolioSlugs: string[];
}

function blank(categoryId: string): FormState {
  return { categoryId, slug: "", kind: "ready_system", name: "", tagline: "", description: "", problemSolved: "", accomplishes: "", deliverables: "", exclusions: "", optionalUpgrades: "", platforms: "", useCases: "", tags: [], keywords: "", deliveryMin: "", deliveryMax: "", availability: "available", featured: false, requiresQuote: true, visible: true, coreOverlapNote: "", sortOrder: "100", allowance: "4", priceType: "range", priceMin: "", priceMax: "", priceNote: "", portfolioSlugs: [] };
}

function fromService(s: ServiceView): FormState {
  return {
    id: s.id,
    categoryId: s.categoryId,
    slug: s.slug,
    kind: s.kind,
    name: s.name,
    tagline: s.tagline,
    description: s.description,
    problemSolved: s.problemSolved,
    accomplishes: s.accomplishes.join("\n"),
    deliverables: s.deliverables.join("\n"),
    exclusions: s.exclusions.join("\n"),
    optionalUpgrades: s.optionalUpgrades.join("\n"),
    platforms: s.platforms.join(", "),
    useCases: s.useCases.join("\n"),
    tags: s.tags,
    keywords: s.keywords.join(", "),
    deliveryMin: s.deliveryMinDays ? String(s.deliveryMinDays) : "",
    deliveryMax: s.deliveryMaxDays ? String(s.deliveryMaxDays) : "",
    availability: s.availability,
    featured: s.featured,
    requiresQuote: s.requiresQuote,
    visible: s.visible,
    coreOverlapNote: s.coreOverlapNote ?? "",
    sortOrder: String(s.sortOrder),
    allowance: String(s.monthlyRequestAllowance ?? 4),
    priceType: s.price?.type ?? "custom_quote",
    priceMin: s.price?.minCents != null ? String(s.price.minCents / 100) : "",
    priceMax: s.price?.maxCents != null ? String(s.price.maxCents / 100) : "",
    priceNote: s.price?.note ?? "",
    portfolioSlugs: s.portfolio.map((p) => p.slug),
  };
}

export function ServiceCatalogAdmin({ services, categories, portfolio }: { services: ServiceView[]; categories: AdminCategory[]; portfolio: Array<{ slug: string; title: string }> }) {
  const router = useRouter();
  const { run } = useRunner();
  const [form, setForm] = React.useState<FormState | null>(null);
  const [catForm, setCatForm] = React.useState<CategoryForm | null>(null);
  const reduce=useReducedMotion();const [query,setQuery]=React.useState("");const [category,setCategory]=React.useState("all");const [availability,setAvailability]=React.useState("all");const [layout,setLayout]=React.useState<"grid"|"list">("grid");
  const [history, setHistory] = React.useState<{ service: ServiceView; rows: Array<{ version: number; type: PriceType; minCents: number | null; maxCents: number | null; note: string | null; source: string; at: string; by: string | null }> } | null>(null);

  async function flag(s: ServiceView, flags: { visible?: boolean; featured?: boolean; availability?: ServiceAvailability }) {
    const ok = await run(`${s.id}:flag`, () => setServiceFlagsAction(s.id, flags), "Saved");
    if (ok !== null) router.refresh();
  }
  async function openHistory(s: ServiceView) {
    const rows = await run(`${s.id}:hist`, () => priceHistoryAction(s.id));
    if (rows) setHistory({ service: s, rows });
  }
  const shown=services.filter(s=>(category==="all"||s.categoryId===category)&&(availability==="all"||availability==="hidden"&&!s.visible||s.availability===availability)&&(!query.trim()||`${s.name} ${s.tagline} ${s.platforms.join(" ")} ${s.categoryName}`.toLowerCase().includes(query.trim().toLowerCase())));
  const mix={available:services.filter(s=>s.visible&&s.availability==="available").length,soon:services.filter(s=>s.visible&&s.availability==="coming_soon").length,unavailable:services.filter(s=>s.visible&&s.availability==="unavailable").length,hidden:services.filter(s=>!s.visible).length};

  return (
    <div className="space-y-5">
      <PageHero
        icon={<Layers aria-hidden />}
        eyebrow="Agency services / Catalog management"
        title="Service catalog."
        description="The right service. The right scope. Keep offers clear, availability current and every pricing change traceable."
        action={<><Button variant="secondary" onClick={()=>setCatForm({name:"",description:"",tier:"ready_to_use",sortOrder:100,visible:true})}><FolderPlus className="size-4"/> Add category</Button><Button variant="primary" onClick={()=>setForm(blank(categories[0]?.id??""))}><Plus className="size-4"/>Add service</Button></>}
        aside={<div className="rounded-2xl border border-line bg-surface p-4 shadow-card"><div className="mb-3 flex items-baseline justify-between gap-3"><p className="text-[12px] font-semibold uppercase tracking-[.14em] text-muted">Catalog at a glance</p><p className="text-[12px] font-medium text-ink-2">{pluralize(services.length,"service")}</p></div><CoverageBar label="Service availability" parts={[{label:"Available",count:mix.available,color:"var(--success)"},{label:"Coming soon",count:mix.soon,color:"var(--primary)"},{label:"Unavailable",count:mix.unavailable,color:"var(--faint)"},{label:"Hidden",count:mix.hidden,color:"var(--warning)"}]}/></div>}
      />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4"><MetricCard className="!p-3 sm:!p-4 [&>p]:!mt-2 [&_.metric-value]:!text-[26px] [&>div:last-child]:hidden sm:[&>div:last-child]:block" label="Catalog services" value={services.length} detail={`${categories.length} configured categories`} icon={<Layers className="size-4"/>} tone="blue"/><MetricCard className="!p-3 sm:!p-4 [&>p]:!mt-2 [&_.metric-value]:!text-[26px] [&>div:last-child]:hidden sm:[&>div:last-child]:block" label="Available offers" value={services.filter(s=>s.visible&&s.availability==="available").length} detail="Visible and accepting requests" icon={<Workflow className="size-4"/>} tone="green"/><MetricCard className="!p-3 sm:!p-4 [&>p]:!mt-2 [&_.metric-value]:!text-[26px] [&>div:last-child]:hidden sm:[&>div:last-child]:block" label="Featured services" value={services.filter(s=>s.featured).length} detail="Curated offers in the catalog" icon={<Star className="size-4"/>} tone="amber"/><MetricCard className="!p-3 sm:!p-4 [&>p]:!mt-2 [&_.metric-value]:!text-[26px] [&>div:last-child]:hidden sm:[&>div:last-child]:block" label="Hidden services" value={services.filter(s=>!s.visible).length} detail="Kept out of client browsing" icon={<EyeOff className="size-4"/>} tone="neutral"/></div>
      <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft"><div className="relative scrollbar-thin flex gap-1 overflow-x-auto border-b border-line px-3 py-2"><FilterTab active={category==="all"} onClick={()=>setCategory("all")} count={services.length}>All services</FilterTab>{categories.map(c=><FilterTab key={c.id} active={category===c.id} onClick={()=>setCategory(c.id)} count={services.filter(s=>s.categoryId===c.id).length}>{c.name}</FilterTab>)}</div><div className="flex flex-wrap items-center gap-3 p-3"><div className="relative min-w-0 flex-1 basis-48"><Search className="pointer-events-none absolute left-3 top-3.5 size-4 text-muted sm:top-3" aria-hidden/><Input aria-label="Search service catalog" placeholder="Search services, platforms or categories…" className="pl-9" value={query} onChange={e=>setQuery(e.target.value)}/></div><Select aria-label="Filter service availability" value={availability} onChange={e=>setAvailability(e.target.value)} className="w-40"><option value="all">All availability</option><option value="available">Available</option><option value="coming_soon">Coming soon</option><option value="unavailable">Unavailable</option><option value="hidden">Hidden</option></Select><div className="flex gap-0.5 rounded-xl border border-line bg-surface-2 p-0.5"><Button size="icon-sm" variant={layout==="grid"?"secondary":"ghost"} aria-label="Grid view" aria-pressed={layout==="grid"} onClick={()=>setLayout("grid")}><LayoutGrid className="size-4"/></Button><Button size="icon-sm" variant={layout==="list"?"secondary":"ghost"} aria-label="List view" aria-pressed={layout==="list"} onClick={()=>setLayout("list")}><List className="size-4"/></Button></div></div></div>
      {category!=="all"&&(()=>{const c=categories.find(c=>c.id===category);return c?<SectionLabel title={c.name} description={c.description} action={<Button size="sm" variant="ghost" onClick={()=>setCatForm(c)}><Pencil className="size-3.5"/>Edit category</Button>}/>:null;})()}
      <p className="px-1 text-[12px] text-muted" aria-live="polite">{pluralize(shown.length,"service")} shown · custom projects are always quoted separately</p>
      <motion.ul layout={!reduce} className={layout==="grid"?"grid gap-4 md:grid-cols-2 xl:grid-cols-3":"space-y-2"}>{shown.map((s,i)=>{const Icon=s.kind==="custom_build"?Code2:s.tags.includes("ai-agents")?Bot:Workflow;const av=AVAILABILITY[s.availability];const grid=layout==="grid";
        const pills=<><StatusPill tone={av.tone} size="sm">{av.label}</StatusPill>{s.featured&&<StatusPill tone="warning" size="sm" icon={<Star className="size-3 fill-current" aria-hidden/>}>Featured</StatusPill>}{!s.visible&&<StatusPill tone="neutral" size="sm" icon={<EyeOff className="size-3" aria-hidden/>}>Hidden</StatusPill>}</>;
        const menu=<Menu><MenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`Actions for ${s.name}`}><MoreHorizontal className="size-4"/></Button></MenuTrigger><MenuContent>{grid&&<MenuItem onSelect={()=>setForm(fromService(s))}><Pencil className="size-3.5"/>Edit service</MenuItem>}<MenuItem onSelect={()=>void flag(s,{featured:!s.featured})}><Star className="size-3.5"/>{s.featured?"Unfeature":"Feature"}</MenuItem><MenuItem onSelect={()=>void openHistory(s)}><History className="size-3.5"/>Pricing history</MenuItem><MenuSeparator/><MenuItem onSelect={()=>void flag(s,{visible:!s.visible})}><EyeOff className="size-3.5"/>{s.visible?"Hide from clients":"Show to clients"}</MenuItem></MenuContent></Menu>;
        return <motion.li key={s.id} layout={!reduce} initial={false} animate={{opacity:1,y:0}} transition={{duration:.2,delay:i*.015}} className={cn("group relative min-w-0 rounded-2xl border bg-surface shadow-soft transition hover:border-line-strong hover:shadow-card",grid?"flex flex-col p-4":"grid gap-3 p-4 sm:grid-cols-[42px_minmax(0,1fr)_170px_auto] sm:items-center",s.visible?"border-line":"border-dashed border-line-strong bg-surface-2/50")}>
          <div className={cn("flex items-start justify-between gap-2",grid&&"mb-3")}><span className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl border",s.kind==="custom_build"?"border-violet/15 bg-violet-soft text-violet-ink":"border-primary/15 bg-primary-soft text-primary-ink")}><Icon className="size-5" aria-hidden/></span>{grid&&<div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">{pills}{menu}</div>}</div>
          <div className="min-w-0"><div className="mb-2 flex flex-wrap items-center gap-1.5"><InfoChip icon={<Tags aria-hidden/>}>{s.categoryName}</InfoChip>{!grid&&pills}</div><h3 className="text-[15px] font-semibold leading-snug tracking-tight text-ink">{s.name}</h3><p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-muted">{s.tagline||s.description}</p>{grid&&<div className="mt-3 flex min-h-6 flex-wrap gap-1.5">{s.platforms.slice(0,4).map(p=><TechnologyPill name={p} key={p}/>)}</div>}</div>
          <div className={cn(grid?"mt-4 border-t border-line pt-3":"")}><p className="text-[18px] font-semibold tabular-nums tracking-tight text-ink">{formatPrice(s.price)}</p><div className="mt-2 flex flex-wrap gap-1.5"><InfoChip icon={<Clock aria-hidden/>}>{formatDelivery(s.deliveryMinDays,s.deliveryMaxDays)||"Scope based delivery"}</InfoChip>{s.portfolio.length>0&&<InfoChip icon={<Briefcase aria-hidden/>}>{s.portfolio.length} portfolio {s.portfolio.length===1?"project":"projects"}</InfoChip>}</div></div>
          <div className={cn("flex items-end gap-2",grid&&"mt-auto pt-4")}><div className={cn("min-w-0",grid?"flex-1":"w-40")}><label htmlFor={`av-${s.id}`} className="mb-1 block text-[12px] font-medium text-muted">Availability</label><Select id={`av-${s.id}`} value={s.availability} onChange={e=>void flag(s,{availability:e.target.value as ServiceAvailability})} className="text-[14px] sm:h-9"><option value="available">Available</option><option value="coming_soon">Coming soon</option><option value="unavailable">Unavailable</option></Select></div><Button size="sm" variant="secondary" aria-label={`Edit ${s.name}`} className="sm:h-9" onClick={()=>setForm(fromService(s))}><Pencil className="size-3.5"/>Edit</Button>{!grid&&menu}</div>
        </motion.li>;})}</motion.ul>
      {!shown.length&&<div className="rounded-2xl border border-dashed border-line-strong bg-surface"><EmptyState icon={<Search className="size-5"/>} title="No services match this view" description="Try another category, availability state or search term." action={<Button size="sm" variant="secondary" onClick={()=>{setQuery("");setCategory("all");setAvailability("all");}}>Clear filters</Button>}/></div>}
      <p className="flex items-start gap-2.5 rounded-xl border border-line bg-surface-2/60 px-3.5 py-3 text-[12px] leading-relaxed text-muted"><CircleDollarSign className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden/>Hidden services disappear from clients immediately. Coming-soon and unavailable offers remain visible but cannot be requested. The core $1,499 setup and optional $299/month maintenance prices are unchanged; included package services are not charged again.</p>
      {catForm && <CategoryEditor initial={catForm} onClose={() => setCatForm(null)} onSaved={() => { setCatForm(null); router.refresh(); }} />}
      {form && <ServiceEditor initial={form} categories={categories} portfolio={portfolio} onClose={() => setForm(null)} onSaved={() => { setForm(null); router.refresh(); }} />}

      <Dialog open={!!history} onOpenChange={(o) => !o && setHistory(null)} title={`Price history · ${history?.service.name ?? ""}`} description="Every change is kept. Earlier prices are never edited." footer={<Button variant="secondary" onClick={() => setHistory(null)}>Close</Button>}>
        <ul className="space-y-2">
          {history?.rows.map((r) => (
            <li key={r.version} className="rounded-xl border border-line bg-surface p-3.5 text-[14px]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="grid h-6 min-w-8 place-items-center rounded-md bg-surface-2 px-1.5 text-[12px] font-semibold tabular-nums text-ink-2 ring-1 ring-inset ring-line">v{r.version}</span>
                <p className="text-[15px] font-semibold tabular-nums tracking-tight text-ink">{formatPrice({ type: r.type, minCents: r.minCents, maxCents: r.maxCents, currency: "USD", note: null })}</p>
                {r.version === history.rows[0].version && <StatusPill tone="success" size="sm">Current</StatusPill>}
                <span className="ml-auto"><InfoChip icon={<Clock aria-hidden />}>{formatDateTime(r.at)}</InfoChip></span>
              </div>
              <p className="mt-2 text-muted">{r.source === "founder_portfolio" ? "Imported from the founder's published pricing" : `Set by ${r.by ?? "an agency admin"}`}</p>
              {r.note && <p className="mt-1 text-[13px] leading-relaxed text-muted">{r.note}</p>}
            </li>
          ))}
        </ul>
      </Dialog>
    </div>
  );
}

function ServiceEditor({ initial, categories, portfolio, onClose, onSaved }: { initial: FormState; categories: AdminCategory[]; portfolio: Array<{ slug: string; title: string }>; onClose: () => void; onSaved: () => void }) {
  const { run, isPending } = useRunner();
  const [f, setF] = React.useState(initial);
  const [slugTouched, setSlugTouched] = React.useState(Boolean(initial.id));
  const [error, setError] = React.useState<string | null>(null);
  const text = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const toggle = (k: "tags" | "portfolioSlugs", v: string) => setF({ ...f, [k]: f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v] });
  const range = f.priceType === "range";

  async function save() {
    setError(null);
    const min = dollars(f.priceMin);
    const max = dollars(f.priceMax);
    const res = await run("save", () =>
      saveServiceAction({
        ...(f.id ? { id: f.id } : {}),
        categoryId: f.categoryId,
        slug: f.slug,
        kind: f.kind,
        name: f.name,
        tagline: f.tagline,
        description: f.description,
        problemSolved: f.problemSolved,
        accomplishes: lines(f.accomplishes),
        deliverables: lines(f.deliverables),
        exclusions: lines(f.exclusions),
        optionalUpgrades: lines(f.optionalUpgrades),
        platforms: commas(f.platforms),
        useCases: lines(f.useCases),
        tags: f.tags as Array<(typeof FILTER_TAGS)[number]["id"]>,
        keywords: commas(f.keywords),
        deliveryMinDays: f.deliveryMin ? Number(f.deliveryMin) : null,
        deliveryMaxDays: f.deliveryMax ? Number(f.deliveryMax) : null,
        availability: f.availability,
        featured: f.featured,
        requiresQuote: f.requiresQuote,
        visible: f.visible,
        coreOverlapNote: f.coreOverlapNote || null,
        sortOrder: Number(f.sortOrder) || 0,
        ...(f.kind === "maintenance_plan" ? { monthlyRequestAllowance: Number(f.allowance) || 0 } : {}),
        price: { type: f.priceType, minCents: f.priceType === "custom_quote" ? null : min, maxCents: range ? max : null, note: f.priceNote || null },
        portfolioSlugs: f.portfolioSlugs,
      }),
      "Service saved",
    );
    if (res) onSaved();
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="xl"
      title={f.id ? `Edit ${initial.name}` : "Add a service"}
      description="Changes appear to clients as soon as you save. Changing the price records a new price version."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="brand" loading={isPending("save")} disabled={f.name.trim().length < 2 || f.slug.trim().length < 2 || !f.categoryId} onClick={() => void save()}>
            Save service
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <FormSection icon={<FileText />} title="Basics" description="What the service is called and how clients read about it.">
          <Field label="Name" htmlFor="sv-name">
            <Input
              id="sv-name"
              value={f.name}
              maxLength={120}
              onChange={(e) => setF({ ...f, name: e.target.value, ...(slugTouched ? {} : { slug: slugify(e.target.value) }) })}
            />
          </Field>
          <Field label="Web address name" htmlFor="sv-slug" hint="Lowercase letters, numbers and dashes.">
            <Input id="sv-slug" value={f.slug} maxLength={80} onChange={(e) => { setSlugTouched(true); setF({ ...f, slug: e.target.value }); }} />
          </Field>
          <Field label="Category" htmlFor="sv-cat">
            <Select id="sv-cat" value={f.categoryId} onChange={text("categoryId")}>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Type" htmlFor="sv-kind">
            <Select id="sv-kind" value={f.kind} onChange={text("kind")}>
              <option value="ready_system">Ready-to-use system</option>
              <option value="custom_build">Custom build</option>
              <option value="maintenance_plan">Maintenance plan (not in the marketplace)</option>
            </Select>
          </Field>
          <Field label="Short description" htmlFor="sv-tag" className="sm:col-span-2">
            <Input id="sv-tag" value={f.tagline} maxLength={300} onChange={text("tagline")} />
          </Field>
          <Field label="Longer description" htmlFor="sv-desc" optional className="sm:col-span-2" hint="Shown in the service details window. Leave blank to reuse the short description.">
            <Textarea id="sv-desc" rows={3} value={f.description} maxLength={2000} onChange={text("description")} />
          </Field>
          <Field label="The problem it solves" htmlFor="sv-prob" className="sm:col-span-2">
            <Textarea id="sv-prob" rows={2} value={f.problemSolved} maxLength={600} onChange={text("problemSolved")} />
          </Field>
        </FormSection>

        <FormSection icon={<CircleDollarSign />} title="Pricing and delivery" description="Every price change is recorded as a new version.">
          <div className="grid gap-4 sm:col-span-2 sm:grid-cols-4">
            <Field label="Price type" htmlFor="sv-pt" className="sm:col-span-1">
              <Select id="sv-pt" value={f.priceType} onChange={text("priceType")}>
                <option value="range">Range (min – max)</option>
                <option value="starting_at">Starting at</option>
                <option value="monthly">Monthly</option>
                <option value="custom_quote">Custom quote only</option>
              </Select>
            </Field>
            {f.priceType !== "custom_quote" && (
              <Field label={range ? "From (USD)" : "Price (USD)"} htmlFor="sv-pmin">
                <Input id="sv-pmin" inputMode="decimal" value={f.priceMin} onChange={text("priceMin")} />
              </Field>
            )}
            {range && (
              <Field label="To (USD)" htmlFor="sv-pmax">
                <Input id="sv-pmax" inputMode="decimal" value={f.priceMax} onChange={text("priceMax")} />
              </Field>
            )}
            <Field label="Note shown with the price" htmlFor="sv-pn" className="sm:col-span-4" optional>
              <Input id="sv-pn" value={f.priceNote} maxLength={300} onChange={text("priceNote")} />
            </Field>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-surface-2 px-3.5 py-2.5 text-[13px] text-muted sm:col-span-4">
              Preview
              <strong className="text-[14px] font-semibold tabular-nums text-ink">{formatPrice({ type: f.priceType, minCents: dollars(f.priceMin), maxCents: range ? dollars(f.priceMax) : null, currency: "USD", note: null })}</strong>
              {f.priceMin && dollars(f.priceMin) !== null ? <span>({formatMoney(dollars(f.priceMin))} minimum)</span> : null}
            </p>
          </div>
          <Field label="Earliest delivery (days)" htmlFor="sv-d1" optional>
            <Input id="sv-d1" type="number" min={1} value={f.deliveryMin} onChange={text("deliveryMin")} />
          </Field>
          <Field label="Latest delivery (days)" htmlFor="sv-d2" optional hint="14 days or more is shown as weeks when it divides evenly.">
            <Input id="sv-d2" type="number" min={1} value={f.deliveryMax} onChange={text("deliveryMax")} />
          </Field>
        </FormSection>

        <FormSection icon={<ListChecks />} title="Scope and content" description="One item per line unless a hint says comma separated.">
          <Field label="What it can accomplish" htmlFor="sv-acc" hint="One per line.">
            <Textarea id="sv-acc" rows={4} value={f.accomplishes} onChange={text("accomplishes")} />
          </Field>
          <Field label="Included deliverables" htmlFor="sv-del" hint="One per line.">
            <Textarea id="sv-del" rows={4} value={f.deliverables} onChange={text("deliverables")} />
          </Field>
          <Field label="Example use cases" htmlFor="sv-use" hint="One per line.">
            <Textarea id="sv-use" rows={3} value={f.useCases} onChange={text("useCases")} />
          </Field>
          <Field label="Optional upgrades" htmlFor="sv-upg" hint="One per line.">
            <Textarea id="sv-upg" rows={3} value={f.optionalUpgrades} onChange={text("optionalUpgrades")} />
          </Field>
          <Field label="Not included" htmlFor="sv-exc" hint="One per line.">
            <Textarea id="sv-exc" rows={3} value={f.exclusions} onChange={text("exclusions")} />
          </Field>
          <Field label="Platforms supported" htmlFor="sv-plat" hint="Comma separated.">
            <Textarea id="sv-plat" rows={3} value={f.platforms} onChange={text("platforms")} />
          </Field>
          <Field label="Note when it overlaps the core package" htmlFor="sv-ov" optional className="sm:col-span-2" hint="For example: standard AI employees are already included and never an add-on.">
            <Textarea id="sv-ov" rows={2} value={f.coreOverlapNote} maxLength={500} onChange={text("coreOverlapNote")} />
          </Field>
        </FormSection>

        <FormSection icon={<Tags />} title="Discovery" description="How clients find this service and which work backs it up.">
          <Field label="Request-form keywords" htmlFor="sv-kw" hint="Comma separated. Used to suggest this service from what a client types." className="sm:col-span-2">
            <Textarea id="sv-kw" rows={2} value={f.keywords} onChange={text("keywords")} />
          </Field>
          <fieldset className="sm:col-span-2">
            <legend className="mb-2 text-[14px] font-medium text-ink-2">Marketplace filters</legend>
            <div className="flex flex-wrap gap-2">
              {FILTER_TAGS.map((t) => (
                <ChoiceChip key={t.id} checked={f.tags.includes(t.id)} onChange={() => toggle("tags", t.id)}>
                  {t.label}
                </ChoiceChip>
              ))}
            </div>
          </fieldset>
          <fieldset className="sm:col-span-2">
            <legend className="mb-2 text-[14px] font-medium text-ink-2">Related portfolio projects</legend>
            <div className="flex flex-wrap gap-2">
              {portfolio.map((p) => (
                <ChoiceChip key={p.slug} checked={f.portfolioSlugs.includes(p.slug)} onChange={() => toggle("portfolioSlugs", p.slug)}>
                  {p.title.split(":")[0]}
                </ChoiceChip>
              ))}
              {portfolio.length === 0 && <p className="text-[13px] text-muted">Import the founder portfolio first (Portfolio page).</p>}
            </div>
          </fieldset>
        </FormSection>

        <FormSection icon={<Settings2 />} title="Availability and visibility" description="Control whether clients can see and request this service.">
          <Field label="Availability" htmlFor="sv-av">
            <Select id="sv-av" value={f.availability} onChange={text("availability")}>
              <option value="available">Available</option>
              <option value="coming_soon">Coming soon</option>
              <option value="unavailable">Unavailable</option>
            </Select>
          </Field>
          <Field label="Sort order" htmlFor="sv-so" hint="Lower comes first.">
            <Input id="sv-so" type="number" min={0} value={f.sortOrder} onChange={text("sortOrder")} />
          </Field>
          {f.kind === "maintenance_plan" && (
            <Field label="Requests per month" htmlFor="sv-al" hint="Monthly allowance for managed requests.">
              <Input id="sv-al" type="number" min={0} value={f.allowance} onChange={text("allowance")} />
            </Field>
          )}
          <div className="grid gap-2.5 sm:col-span-2 sm:grid-cols-3">
            <CheckRow checked={f.visible} onChange={(v) => setF({ ...f, visible: v })} title="Visible to clients" description="Hidden services disappear from the catalog." />
            <CheckRow checked={f.featured} onChange={(v) => setF({ ...f, featured: v })} title="Featured" description="Highlighted in the marketplace." />
            <CheckRow checked={f.requiresQuote} onChange={(v) => setF({ ...f, requiresQuote: v })} title="Requires a custom quote" description="Clients request a quote first." />
          </div>
        </FormSection>
        {error && <p role="alert" className="rounded-xl bg-danger-soft px-3.5 py-2.5 text-[14px] text-danger-ink sm:col-span-2">{error}</p>}
      </div>
    </Dialog>
  );
}

interface CategoryForm {
  id?: string;
  name: string;
  description: string;
  tier: string;
  sortOrder: number;
  visible: boolean;
}

function CategoryEditor({ initial, onClose, onSaved }: { initial: CategoryForm; onClose: () => void; onSaved: () => void }) {
  const { run, isPending } = useRunner();
  const [f, setF] = React.useState({ name: initial.name, description: initial.description, tier: initial.tier, sortOrder: String(initial.sortOrder), visible: initial.visible });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={initial.id ? `Edit category · ${initial.name}` : "Add a category"}
      description="Categories group services in the marketplace. Hiding a category hides all its services from clients."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="brand"
            loading={isPending("cat")}
            disabled={f.name.trim().length < 2}
            onClick={async () => {
              const r = await run("cat", () => saveCategoryAction({ ...(initial.id ? { id: initial.id } : {}), name: f.name, description: f.description, tier: f.tier as "ready_to_use" | "custom" | "maintenance", sortOrder: Number(f.sortOrder) || 0, visible: f.visible }), "Category saved");
              if (r) onSaved();
            }}
          >
            Save category
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" htmlFor="cat-name">
          <Input id="cat-name" value={f.name} maxLength={80} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="Description" htmlFor="cat-desc" optional>
          <Textarea id="cat-desc" rows={2} value={f.description} maxLength={600} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Kind" htmlFor="cat-tier">
            <Select id="cat-tier" value={f.tier} onChange={(e) => setF({ ...f, tier: e.target.value })}>
              <option value="ready_to_use">Ready-to-use</option>
              <option value="custom">Custom build (quoted)</option>
              <option value="maintenance">Maintenance</option>
            </Select>
          </Field>
          <Field label="Sort order" htmlFor="cat-sort" hint="Lower comes first.">
            <Input id="cat-sort" type="number" min={0} value={f.sortOrder} onChange={(e) => setF({ ...f, sortOrder: e.target.value })} />
          </Field>
        </div>
        <CheckRow checked={f.visible} onChange={(v) => setF({ ...f, visible: v })} title="Visible to clients" description="A hidden category hides all of its services from clients." />
      </div>
    </Dialog>
  );
}



