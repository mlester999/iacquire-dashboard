"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { EyeOff, FolderPlus, History, Pencil, Plus, Star,Search,LayoutGrid,List,MoreHorizontal,Workflow,Bot,Code2,Clock,Layers } from "lucide-react";
import { motion,useReducedMotion } from "motion/react";
import { Badge, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { Dialog,Menu,MenuTrigger,MenuContent,MenuItem,MenuSeparator } from "@/components/ui/overlays";
import { MetricCard,SectionLabel } from "@/components/ui/workspace";
import { TechnologyPill } from "@/components/projects/visuals";
import { useRunner } from "@/components/projects/common";
import { priceHistoryAction, saveCategoryAction, saveServiceAction, setServiceFlagsAction } from "@/app/(admin)/admin/services/actions";
import { MARKETPLACE_FILTERS, formatDelivery, formatMoney, formatPrice, type PriceType, type ServiceAvailability, type ServiceKind, type ServiceView } from "@/lib/projects";
import type { AdminCategory } from "@/server/catalog/service";
import { cn, formatDateTime } from "@/lib/utils";

const lines = (v: string) => v.split("\n").map((x) => x.trim()).filter(Boolean);
const commas = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);
const dollars = (v: string) => {
  const n = Number.parseFloat(v.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
const slugify = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
const FILTER_TAGS = MARKETPLACE_FILTERS.filter((f) => f.id !== "all");

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

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-[10px] font-semibold uppercase tracking-[.16em] text-primary">Agency services / Catalog management</p><h2 className="mt-1.5 text-[25px] font-semibold tracking-tight">The right service. The right scope.</h2><p className="mt-1 text-xs text-muted">Keep offers clear, availability current and every pricing change traceable.</p></div><div className="flex gap-2"><Button variant="secondary" onClick={()=>setCatForm({name:"",description:"",tier:"ready_to_use",sortOrder:100,visible:true})}><FolderPlus className="size-4"/> Add category</Button><Button variant="primary" onClick={()=>setForm(blank(categories[0]?.id??""))}><Plus className="size-4"/>Add service</Button></div></div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4"><MetricCard className="!p-4 [&>p]:!mt-2 [&_.metric-value]:!text-[26px]" label="Catalog services" value={services.length} detail={`${categories.length} configured categories`} icon={<Layers className="size-4"/>} tone="blue"/><MetricCard className="!p-4 [&>p]:!mt-2 [&_.metric-value]:!text-[26px]" label="Available offers" value={services.filter(s=>s.visible&&s.availability==="available").length} detail="Visible and accepting requests" icon={<Workflow className="size-4"/>} tone="green"/><MetricCard className="!p-4 [&>p]:!mt-2 [&_.metric-value]:!text-[26px]" label="Featured services" value={services.filter(s=>s.featured).length} detail="Curated offers in the catalog" icon={<Star className="size-4"/>} tone="amber"/><MetricCard className="!p-4 [&>p]:!mt-2 [&_.metric-value]:!text-[26px]" label="Hidden services" value={services.filter(s=>!s.visible).length} detail="Kept out of client browsing" icon={<EyeOff className="size-4"/>} tone="neutral"/></div>
      <div className="overflow-hidden rounded-2xl border border-line bg-surface"><div className="scrollbar-thin flex gap-1 overflow-x-auto border-b border-line px-3 py-2"><button onClick={()=>setCategory("all")} aria-pressed={category==="all"} className={cn("shrink-0 rounded-lg px-3 py-2 text-xs font-medium",category==="all"?"bg-primary-soft text-primary-ink":"text-muted hover:bg-surface-2")}>All services <span className="ml-1 text-[10px] opacity-70">{services.length}</span></button>{categories.map(c=><button key={c.id} onClick={()=>setCategory(c.id)} aria-pressed={category===c.id} className={cn("shrink-0 rounded-lg px-3 py-2 text-xs font-medium",category===c.id?"bg-primary-soft text-primary-ink":"text-muted hover:bg-surface-2")}>{c.name}<span className="ml-1 text-[10px] opacity-70">{services.filter(s=>s.categoryId===c.id).length}</span></button>)}</div><div className="flex flex-wrap items-center gap-3 p-3"><div className="relative min-w-0 flex-1 basis-48"><Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted" aria-hidden/><Input aria-label="Search service catalog" placeholder="Search services, platforms or categories…" className="pl-9" value={query} onChange={e=>setQuery(e.target.value)}/></div><Select aria-label="Filter service availability" value={availability} onChange={e=>setAvailability(e.target.value)} className="w-40"><option value="all">All availability</option><option value="available">Available</option><option value="coming_soon">Coming soon</option><option value="unavailable">Unavailable</option><option value="hidden">Hidden</option></Select><div className="flex gap-0.5 rounded-lg border border-line p-0.5"><Button size="icon-sm" variant={layout==="grid"?"soft":"ghost"} aria-label="Grid view" aria-pressed={layout==="grid"} onClick={()=>setLayout("grid")}><LayoutGrid className="size-4"/></Button><Button size="icon-sm" variant={layout==="list"?"soft":"ghost"} aria-label="List view" aria-pressed={layout==="list"} onClick={()=>setLayout("list")}><List className="size-4"/></Button></div></div></div>
      {category!=="all"&&(()=>{const c=categories.find(c=>c.id===category);return c?<SectionLabel title={c.name} description={c.description} action={<Button size="sm" variant="ghost" onClick={()=>setCatForm(c)}><Pencil className="size-3.5"/>Edit category</Button>}/>:null;})()}
      <p className="text-[11px] text-muted" aria-live="polite">{shown.length} service{shown.length===1?"":"s"} shown · custom projects are always quoted separately</p>
      <motion.ul layout={!reduce} className={layout==="grid"?"grid gap-4 md:grid-cols-2 xl:grid-cols-3":"space-y-2"}>{shown.map((s,i)=>{const Icon=s.kind==="custom_build"?Code2:s.tags.includes("ai-agents")?Bot:Workflow;return <motion.li key={s.id} layout={!reduce} initial={reduce?false:{opacity:0,y:6}} animate={{opacity:1,y:0}} transition={{duration:.2,delay:i*.015}} className={cn("group relative min-w-0 rounded-2xl border border-line bg-surface shadow-soft transition hover:border-line-strong hover:shadow-card",layout==="grid"?"flex flex-col p-4":"grid gap-3 p-4 sm:grid-cols-[42px_minmax(0,1fr)_150px_auto] sm:items-center",!s.visible&&"bg-surface-2/50")}><div className={cn("flex items-start justify-between",layout==="grid"&&"mb-3")}><span className={cn("flex size-10 items-center justify-center rounded-xl border",s.kind==="custom_build"?"border-violet/15 bg-violet-soft text-violet-ink":"border-primary/15 bg-primary-soft text-primary-ink")}><Icon className="size-5" aria-hidden/></span>{layout==="grid"&&<Menu><MenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`Actions for ${s.name}`}><MoreHorizontal className="size-4"/></Button></MenuTrigger><MenuContent><MenuItem onSelect={()=>setForm(fromService(s))}><Pencil className="size-3.5"/>Edit service</MenuItem><MenuItem onSelect={()=>void flag(s,{featured:!s.featured})}><Star className="size-3.5"/>{s.featured?"Unfeature":"Feature"}</MenuItem><MenuItem onSelect={()=>void openHistory(s)}><History className="size-3.5"/>Pricing history</MenuItem><MenuSeparator/><MenuItem onSelect={()=>void flag(s,{visible:!s.visible})}><EyeOff className="size-3.5"/>{s.visible?"Hide from clients":"Show to clients"}</MenuItem></MenuContent></Menu>}</div><div className="min-w-0"><div className="mb-1.5 flex flex-wrap items-center gap-1.5"><span className="text-[10px] font-medium text-muted">{s.categoryName}</span>{s.featured&&<span className="inline-flex items-center gap-1 text-[10px] font-semibold text-warning-ink"><Star className="size-3 fill-current"/>Featured</span>}{!s.visible&&<Badge tone="neutral">Hidden</Badge>}</div><h3 className="text-[15px] font-semibold leading-snug tracking-tight">{s.name}</h3><p className="mt-1.5 line-clamp-2 text-[12px] leading-relaxed text-muted">{s.tagline||s.description}</p>{layout==="grid"&&<div className="mt-3 flex min-h-6 flex-wrap gap-1.5">{s.platforms.slice(0,4).map(p=><TechnologyPill name={p} key={p}/>)}</div>}</div><div className={cn(layout==="grid"?"mt-4 border-t border-line pt-3":"")}><p className="text-[17px] font-semibold tabular-nums tracking-tight">{formatPrice(s.price)}</p><p className="mt-1 flex items-center gap-1.5 text-[10.5px] text-muted"><Clock className="size-3"/>{formatDelivery(s.deliveryMinDays,s.deliveryMaxDays)||"Scope based delivery"}</p>{s.portfolio.length>0&&<p className="mt-1 text-[10.5px] text-muted">{s.portfolio.length} related portfolio {s.portfolio.length===1?"project":"projects"}</p>}</div><div className={cn("flex items-center gap-2",layout==="grid"&&"mt-auto pt-4")}><Select aria-label={`Availability of ${s.name}`} value={s.availability} onChange={e=>void flag(s,{availability:e.target.value as ServiceAvailability})} className={cn("text-xs",layout==="grid"?"w-full":"w-36")}><option value="available">Available</option><option value="coming_soon">Coming soon</option><option value="unavailable">Unavailable</option></Select><Button size="icon-sm" variant="secondary" aria-label={`Edit ${s.name}`} onClick={()=>setForm(fromService(s))}><Pencil className="size-3.5"/></Button>{layout==="list"&&<Menu><MenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`Actions for ${s.name}`}><MoreHorizontal className="size-4"/></Button></MenuTrigger><MenuContent><MenuItem onSelect={()=>void flag(s,{featured:!s.featured})}><Star className="size-3.5"/>{s.featured?"Unfeature":"Feature"}</MenuItem><MenuItem onSelect={()=>void openHistory(s)}><History className="size-3.5"/>Pricing history</MenuItem><MenuSeparator/><MenuItem onSelect={()=>void flag(s,{visible:!s.visible})}><EyeOff className="size-3.5"/>{s.visible?"Hide from clients":"Show to clients"}</MenuItem></MenuContent></Menu>}</div></motion.li>;})}</motion.ul>
      {!shown.length&&<div className="rounded-2xl border border-dashed border-line-strong bg-surface p-8 text-center"><Search className="mx-auto size-7 text-muted"/><h3 className="mt-3 text-sm font-semibold">No services match this view</h3><p className="mt-1 text-xs text-muted">Try another category, availability state or search.</p><Button size="sm" variant="secondary" className="mt-4" onClick={()=>{setQuery("");setCategory("all");setAvailability("all");}}>Clear filters</Button></div>}
      <p className="rounded-xl bg-surface-2 p-3 text-[11px] leading-relaxed text-muted">Hidden services disappear from clients immediately. Coming-soon and unavailable offers remain visible but cannot be requested. The core $1,499 setup and optional $299/month maintenance prices are unchanged; included package services are not charged again.</p>
      {catForm && <CategoryEditor initial={catForm} onClose={() => setCatForm(null)} onSaved={() => { setCatForm(null); router.refresh(); }} />}
      {form && <ServiceEditor initial={form} categories={categories} portfolio={portfolio} onClose={() => setForm(null)} onSaved={() => { setForm(null); router.refresh(); }} />}

      <Dialog open={!!history} onOpenChange={(o) => !o && setHistory(null)} title={`Price history · ${history?.service.name ?? ""}`} description="Every change is kept. Earlier prices are never edited." footer={<Button variant="secondary" onClick={() => setHistory(null)}>Close</Button>}>
        <ul className="space-y-2">
          {history?.rows.map((r) => (
            <li key={r.version} className="rounded-xl border border-line p-3 text-[13px]">
              <p className="font-medium tabular-nums">
                v{r.version} · {formatPrice({ type: r.type, minCents: r.minCents, maxCents: r.maxCents, currency: "USD", note: null })}
                {r.version === history.rows[0].version && <Badge tone="success" className="ml-2">Current</Badge>}
              </p>
              <p className="mt-0.5 text-muted">
                {r.source === "founder_portfolio" ? "Imported from the founder's published pricing" : `Set by ${r.by ?? "an agency admin"}`} · {formatDateTime(r.at)}
              </p>
              {r.note && <p className="mt-0.5 text-[12px] text-faint">{r.note}</p>}
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

        <fieldset className="grid gap-4 rounded-2xl border border-line p-4 sm:col-span-2 sm:grid-cols-4">
          <legend className="px-2 text-[12px] font-semibold uppercase tracking-[.08em] text-muted">Price</legend>
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
          <p className="text-[12px] text-muted sm:col-span-4">
            Preview: <strong>{formatPrice({ type: f.priceType, minCents: dollars(f.priceMin), maxCents: range ? dollars(f.priceMax) : null, currency: "USD", note: null })}</strong>
            {f.priceMin && dollars(f.priceMin) !== null ? ` (${formatMoney(dollars(f.priceMin))} minimum)` : ""}
          </p>
        </fieldset>

        <Field label="Earliest delivery (days)" htmlFor="sv-d1" optional>
          <Input id="sv-d1" type="number" min={1} value={f.deliveryMin} onChange={text("deliveryMin")} />
        </Field>
        <Field label="Latest delivery (days)" htmlFor="sv-d2" optional hint="14 days or more is shown as weeks when it divides evenly.">
          <Input id="sv-d2" type="number" min={1} value={f.deliveryMax} onChange={text("deliveryMax")} />
        </Field>
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
        <Field label="Request-form keywords" htmlFor="sv-kw" hint="Comma separated. Used to suggest this service from what a client types." className="sm:col-span-2">
          <Textarea id="sv-kw" rows={2} value={f.keywords} onChange={text("keywords")} />
        </Field>
        <Field label="Note when it overlaps the core package" htmlFor="sv-ov" optional className="sm:col-span-2" hint="For example: standard AI employees are already included and never an add-on.">
          <Textarea id="sv-ov" rows={2} value={f.coreOverlapNote} maxLength={500} onChange={text("coreOverlapNote")} />
        </Field>

        <fieldset className="sm:col-span-2">
          <legend className="mb-2 text-[13px] font-medium">Marketplace filters</legend>
          <div className="flex flex-wrap gap-2">
            {FILTER_TAGS.map((t) => (
              <label key={t.id} className={cn("cursor-pointer rounded-full border px-3 py-1 text-[12.5px] transition", f.tags.includes(t.id) ? "border-primary bg-primary-soft text-primary-ink" : "border-line text-muted")}>
                <input type="checkbox" className="sr-only" checked={f.tags.includes(t.id)} onChange={() => toggle("tags", t.id)} />
                {t.label}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="sm:col-span-2">
          <legend className="mb-2 text-[13px] font-medium">Related portfolio projects</legend>
          <div className="flex flex-wrap gap-2">
            {portfolio.map((p) => (
              <label key={p.slug} className={cn("cursor-pointer rounded-full border px-3 py-1 text-[12.5px] transition", f.portfolioSlugs.includes(p.slug) ? "border-primary bg-primary-soft text-primary-ink" : "border-line text-muted")}>
                <input type="checkbox" className="sr-only" checked={f.portfolioSlugs.includes(p.slug)} onChange={() => toggle("portfolioSlugs", p.slug)} />
                {p.title.split(":")[0]}
              </label>
            ))}
            {portfolio.length === 0 && <p className="text-[12.5px] text-muted">Import the founder portfolio first (Portfolio page).</p>}
          </div>
        </fieldset>

        <div className="grid gap-3 sm:col-span-2 sm:grid-cols-4">
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
          <div className="space-y-2 pt-1 text-[13px]">
            {(
              [
                ["visible", "Visible to clients"],
                ["featured", "Featured"],
                ["requiresQuote", "Requires a custom quote"],
              ] as const
            ).map(([k, label]) => (
              <label key={k} className="flex items-center gap-2">
                <input type="checkbox" checked={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.checked })} /> {label}
              </label>
            ))}
          </div>
        </div>
        {error && <p role="alert" className="text-[13px] text-danger sm:col-span-2">{error}</p>}
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
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={f.visible} onChange={(e) => setF({ ...f, visible: e.target.checked })} /> Visible to clients
        </label>
      </div>
    </Dialog>
  );
}



