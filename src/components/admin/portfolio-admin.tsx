"use client";

import * as React from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Bot, Briefcase, CheckCircle2, Clock3, Code2, Download, ExternalLink, EyeOff, Globe, ImageOff, Images, Layers, Pencil, Rocket, Search, ShieldCheck, Star, Tags, Trash2, Upload, Workflow } from "lucide-react";
import { motion,useReducedMotion } from "motion/react";
import { TechnologyPill } from "@/components/projects/visuals";
import { EmptyState, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { CoverageBar, MetricCard, PageHero } from "@/components/ui/workspace";
import { InfoChip, StatusPill, type StatusTone } from "@/components/ui/status";
import { CheckRow, ChoiceChip, FilterTab } from "@/components/admin/service-catalog-admin";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { useRunner } from "@/components/projects/common";
import { deleteAssetAction, importAssetAction, reviewPortfolioAction, runImportAction, savePortfolioAction, updateAssetAction } from "@/app/(admin)/admin/portfolio/actions";
import { PORTFOLIO_STATUS_LABEL, portfolioTitle, sectionsToText, textToSections, type PortfolioStatus } from "@/lib/projects";
import type { AdminPortfolioRow } from "@/server/portfolio/service";
import { cn, pluralize } from "@/lib/utils";

const lines = (v: string) => v.split("\n").map((x) => x.trim()).filter(Boolean);
const commas = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);

type Dlg = { kind: "edit" | "review" | "images"; id: string } | null;

const BUILD_TONE: Record<PortfolioStatus, StatusTone> = { built: "primary", in_development: "violet", built_locally: "violet", planned: "neutral" };

/** Token-based stand-in for a cover image, labelled honestly as missing media. Works in both themes. */
function CoverPlaceholder({ technologies }: { technologies: string[] }) {
  const tech = technologies.join(" ").toLowerCase();
  const Icon = /n8n|zapier|make|ghl/.test(tech) ? Workflow : /ai|gpt|rag|agent/.test(tech) ? Bot : /shopify|web|liquid/.test(tech) ? Globe : Code2;
  return (
    <div className="relative flex aspect-[16/10] flex-col items-center justify-center gap-3 overflow-hidden bg-gradient-to-br from-primary-soft via-surface-2 to-violet-soft">
      <div aria-hidden className="absolute inset-0 opacity-60 [background-image:linear-gradient(var(--line)_1px,transparent_1px),linear-gradient(90deg,var(--line)_1px,transparent_1px)] [background-size:28px_28px]" />
      <span className="relative grid size-14 place-items-center rounded-2xl border border-line-strong bg-surface text-primary-ink shadow-card">
        <Icon className="size-6" aria-hidden />
      </span>
      <span className="relative inline-flex items-center gap-1.5 rounded-full bg-surface/90 px-2.5 py-1 text-[11.5px] font-medium text-ink-2 ring-1 ring-inset ring-line-strong">
        <ImageOff className="size-3" aria-hidden />
        No screenshot yet
      </span>
    </div>
  );
}

export function PortfolioAdmin({ projects, services }: { projects: AdminPortfolioRow[]; services: Array<{ slug: string; name: string }> }) {
  const router=useRouter();const {run,isPending}=useRunner();const reduce=useReducedMotion();const [dlg,setDlg]=React.useState<Dlg>(null);const [filter,setFilter]=React.useState("all");const [query,setQuery]=React.useState("");
  const active=dlg?projects.find(p=>p.id===dlg.id):undefined;const pending=projects.filter(p=>p.reviewState==="pending_review").length;const published=projects.filter(p=>p.visible).length;const needsMedia=projects.filter(p=>!p.assets.some(a=>a.stored)).length;
  const counts={all:projects.length,review:pending,published,hidden:projects.filter(p=>!p.visible).length,media:needsMedia};
  const shown=projects.filter(p=>(filter==="all"||filter==="published"&&p.visible||filter==="review"&&p.reviewState==="pending_review"||filter==="hidden"&&!p.visible||filter==="media"&&!p.assets.some(a=>a.stored))&&(!query.trim()||`${p.title} ${p.categories.join(" ")} ${p.technologies.join(" ")}`.toLowerCase().includes(query.trim().toLowerCase())));
  async function importNow(){const r=await run("import",()=>runImportAction());if(r){toast.success(`Import finished: ${r.created} new, ${r.refreshed} refreshed, ${r.untouched} already approved (left untouched).`);router.refresh();}}
  return <div className="space-y-5">
    <PageHero
      icon={<Images aria-hidden />}
      eyebrow="Founder portfolio / Content studio"
      title="Good work deserves a great showcase."
      description="Curate the founder’s projects, prepare their visual story and review what clients will see. Nothing reaches clients without your review."
      action={<Button variant="primary" loading={isPending("import")} onClick={()=>void importNow()}><Download className="size-4"/>Import verified content</Button>}
      aside={<div className="rounded-2xl border border-line bg-surface p-4 shadow-card"><div className="mb-3 flex items-baseline justify-between gap-3"><p className="text-[11px] font-semibold uppercase tracking-[.14em] text-muted">Showcase at a glance</p><p className="text-[12px] font-medium text-ink-2">{pluralize(projects.length,"project")}</p></div><CoverageBar label="Portfolio review state" parts={[{label:"Published",count:published,color:"var(--success)"},{label:"Pending review",count:pending,color:"var(--warning)"},{label:"Hidden",count:Math.max(0,projects.length-published-pending),color:"var(--faint)"}]}/></div>}
    />
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4"><MetricCard className="!p-3 sm:!p-4 [&>p]:!mt-2 [&_.metric-value]:!text-[26px] [&>div:last-child]:hidden sm:[&>div:last-child]:block" label="Portfolio projects" value={projects.length} detail="Founder work in the showcase" icon={<Briefcase className="size-4"/>} tone="blue"/><MetricCard className="!p-3 sm:!p-4 [&>p]:!mt-2 [&_.metric-value]:!text-[26px] [&>div:last-child]:hidden sm:[&>div:last-child]:block" label="Published" value={published} detail="Visible to signed-in clients" icon={<CheckCircle2 className="size-4"/>} tone="green"/><MetricCard className="!p-3 sm:!p-4 [&>p]:!mt-2 [&_.metric-value]:!text-[26px] [&>div:last-child]:hidden sm:[&>div:last-child]:block" label="Pending review" value={pending} detail="Waiting for a disclosure check" icon={<Clock3 className="size-4"/>} tone="amber"/><MetricCard className="!p-3 sm:!p-4 [&>p]:!mt-2 [&_.metric-value]:!text-[26px] [&>div:last-child]:hidden sm:[&>div:last-child]:block" label="Needs images" value={needsMedia} detail="No stored screenshot yet" icon={<ImageOff className="size-4"/>} tone="neutral"/></div>
    <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-2.5 shadow-soft lg:flex-row lg:items-center lg:justify-between"><div className="relative scrollbar-thin flex gap-1 overflow-x-auto">{[{id:"all",label:"All work"},{id:"review",label:"Review queue"},{id:"published",label:"Published"},{id:"hidden",label:"Hidden"},{id:"media",label:"Needs images"}].map(f=><FilterTab key={f.id} active={filter===f.id} onClick={()=>setFilter(f.id)} count={counts[f.id as keyof typeof counts]}>{f.label}</FilterTab>)}</div><div className="relative lg:w-72"><Search className="pointer-events-none absolute left-3 top-3.5 size-4 text-muted sm:top-3" aria-hidden/><Input aria-label="Search portfolio projects" placeholder="Search projects or technology…" className="pl-9" value={query} onChange={e=>setQuery(e.target.value)}/></div></div>
    <motion.ul layout={!reduce} className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{shown.map((p,i)=>{const cover=p.assets.find(a=>a.stored&&a.kind==="cover")??p.assets.find(a=>a.stored);const storedCount=p.assets.filter(a=>a.stored).length;return <motion.li key={p.id} layout={!reduce} initial={false} animate={{opacity:1,y:0}} transition={{duration:.2,delay:i*.025}} className="group flex min-w-0 flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-soft transition motion-safe:hover:-translate-y-1 hover:border-line-strong hover:shadow-card">
      <button onClick={()=>setDlg({kind:"images",id:p.id})} aria-label={`Manage images for ${p.title}`} className="relative block overflow-hidden border-b border-line text-left">{cover?<div className="relative aspect-[16/10] bg-surface-2"><Image src={`/api/portfolio/assets/${cover.id}?v=thumb`} alt={cover.alt||p.title} fill unoptimized sizes="(min-width:1280px) 390px,50vw" className="object-cover object-top transition-transform duration-500 group-hover:scale-[1.03]"/></div>:<CoverPlaceholder technologies={p.technologies}/>}<span aria-hidden className="absolute bottom-3 right-3 grid size-8 place-items-center rounded-lg bg-surface/90 text-ink-2 shadow-soft ring-1 ring-inset ring-line-strong backdrop-blur-sm transition group-hover:text-primary"><Images className="size-4"/></span>{p.featured&&<span className="absolute left-3 top-3 inline-flex h-6 items-center gap-1.5 rounded-full bg-surface/90 px-2.5 text-[11.5px] font-semibold text-warning-ink shadow-soft ring-1 ring-inset ring-warning/30 backdrop-blur-sm"><Star className="size-3 fill-current" aria-hidden/>Featured</span>}</button>
      <div className="flex flex-1 flex-col p-4"><div className="flex flex-wrap items-center gap-1.5">{p.visible?<StatusPill tone="success" icon={<CheckCircle2 className="size-3" aria-hidden/>}>Published</StatusPill>:p.reviewState==="approved"?<StatusPill tone="neutral" icon={<EyeOff className="size-3" aria-hidden/>}>Hidden</StatusPill>:<StatusPill tone="warning" icon={<Clock3 className="size-3" aria-hidden/>}>Pending review</StatusPill>}<StatusPill tone={BUILD_TONE[p.status]}>{p.statusLabel||PORTFOLIO_STATUS_LABEL[p.status]}</StatusPill></div><h3 className="mt-3 line-clamp-2 text-[16px] font-semibold leading-snug tracking-tight text-ink" title={p.title}>{p.title}</h3><p className="mt-1.5 line-clamp-3 text-[12.5px] leading-relaxed text-muted">{p.summary}</p><div className="mt-3 flex flex-wrap gap-1.5">{p.technologies.slice(0,4).map(t=><TechnologyPill name={t} key={t}/>)}</div><div className="mt-3 flex flex-wrap gap-1.5">{storedCount?<InfoChip icon={<Images aria-hidden/>}>{pluralize(storedCount,"stored image")}</InfoChip>:<StatusPill tone="warning" size="sm" icon={<ImageOff className="size-3" aria-hidden/>}>No stored images</StatusPill>}<InfoChip icon={<Layers aria-hidden/>}>{pluralize(p.serviceSlugs.length,"related service")}</InfoChip></div><div className="mt-auto flex items-center gap-2 border-t border-line pt-3 mt-4"><Button size="sm" variant={p.visible?"secondary":"primary"} className="flex-1" onClick={()=>setDlg({kind:"review",id:p.id})}><Rocket className="size-3.5"/>{p.visible?"Visibility":"Review & publish"}</Button><Button size="sm" variant="secondary" aria-label={`Edit ${p.title}`} onClick={()=>setDlg({kind:"edit",id:p.id})}><Pencil className="size-3.5"/>Edit</Button><Button size="icon-sm" variant="ghost" aria-label={`Images for ${p.title}`} title="Manage images" onClick={()=>setDlg({kind:"images",id:p.id})}><Images className="size-4"/></Button></div></div></motion.li>;})}</motion.ul>
    {!shown.length&&<div className="rounded-2xl border border-dashed border-line-strong bg-surface"><EmptyState icon={projects.length?<Search className="size-5"/>:<Images className="size-5"/>} title={projects.length?"No projects match this view":"Your showcase is ready for its first story"} description={projects.length?"Choose a different review state or adjust your search.":"Import the founder’s verified portfolio for review, then add permitted screenshots and publish each project intentionally."} action={projects.length?<Button variant="secondary" onClick={()=>{setQuery("");setFilter("all");}}>Clear filters</Button>:<Button variant="primary" loading={isPending("import")} onClick={()=>void importNow()}><Download className="size-4"/> Import verified content</Button>}/></div>}
    <p className="flex items-start gap-2.5 rounded-xl border border-line bg-surface-2/60 px-3.5 py-3 text-[12px] leading-relaxed text-muted"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden/>Imported projects remain hidden pending disclosure review. Uploaded images also require individual publication permission; adding media never publishes a project.</p>
    {active&&dlg?.kind==="edit"&&<EditDialog project={active} services={services} onClose={()=>setDlg(null)} onSaved={()=>{setDlg(null);router.refresh();}}/>}
    {active&&dlg?.kind==="review"&&<ReviewDialog project={active} onClose={()=>setDlg(null)} onDone={()=>{setDlg(null);router.refresh();}}/>}
    {active&&dlg?.kind==="images"&&<ImagesDialog project={active} onClose={()=>setDlg(null)}/>}
  </div>;
}
function ReviewDialog({ project: p, onClose, onDone }: { project: AdminPortfolioRow; onClose: () => void; onDone: () => void }) {
  const { run, isPending } = useRunner();
  const [confirmed, setConfirmed] = React.useState(p.disclosureConfirmed);
  const shownAs = portfolioTitle({ title: p.title, anonymizedTitle: p.anonymizedTitle, clientNamePublic: p.clientNamePublic });
  const apply = async (action: "approve_and_publish" | "hide" | "unapprove", msg: string) => {
    const ok = await run("review", () => reviewPortfolioAction(p.id, action, confirmed), msg);
    if (ok !== null) onDone();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={p.visible ? "Visibility" : "Review & publish"} description={p.title} footer={<Button variant="secondary" onClick={onClose}>Close</Button>}>
      <div className="space-y-4">
        <dl className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface-2/40 text-[13px]">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 px-4 py-3">
            <dt className="text-muted">Clients would see</dt>
            <dd className="flex min-w-0 flex-wrap items-center justify-end gap-2 font-medium text-ink">
              <span className="min-w-0 break-words">“{shownAs}”</span>
              <InfoChip icon={<Tags aria-hidden />}>{p.clientNamePublic ? "Real project name" : "Anonymized title"}</InfoChip>
            </dd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 px-4 py-3">
            <dt className="text-muted">Status label</dt>
            <dd>
              <StatusPill tone={BUILD_TONE[p.status]}>{p.statusLabel || PORTFOLIO_STATUS_LABEL[p.status]}</StatusPill>
            </dd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 px-4 py-3">
            <dt className="text-muted">Published images</dt>
            <dd>
              <InfoChip icon={<Images aria-hidden />}>{pluralize(p.assets.filter((a) => a.published).length, "image")}</InfoChip>
            </dd>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 px-4 py-3">
            <dt className="text-muted">Label shown</dt>
            <dd className="font-medium text-ink">“{p.attribution}”</dd>
          </div>
        </dl>
        {p.privacyNote && (
          <div className="flex gap-2.5 rounded-xl bg-warning-soft px-3.5 py-3 text-[13px] leading-relaxed text-warning-ink">
            <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p>
              <strong className="font-semibold">Privacy note on the project.</strong> {p.privacyNote}
            </p>
          </div>
        )}
        {p.sourceUrl && (
          <a href={p.sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-10 items-center gap-1.5 rounded-xl border border-line bg-surface px-3.5 text-[13px] font-medium text-primary-ink shadow-soft transition hover:bg-surface-2">
            Compare with the source page <ExternalLink className="size-3.5" aria-hidden />
          </a>
        )}
        <CheckRow
          checked={confirmed}
          onChange={setConfirmed}
          title="Disclosure confirmed"
          description="I've reviewed this project and confirm that public disclosure of its name, details and any published screenshots is permitted. I haven't added any results that aren't true."
        />
        <div className="flex flex-wrap gap-2">
          <Button variant="brand" loading={isPending("review")} disabled={!confirmed} onClick={() => void apply("approve_and_publish", p.visible ? "Updated" : "Published to clients")}>
            {p.visible ? "Re-confirm & keep published" : "Approve & publish"}
          </Button>
          {p.visible && (
            <Button variant="secondary" loading={isPending("review")} onClick={() => void apply("hide", "Hidden from clients")}>
              Hide from clients
            </Button>
          )}
          {p.reviewState === "approved" && (
            <Button variant="ghost" loading={isPending("review")} onClick={() => void apply("unapprove", "Sent back to review")}>
              Send back to review
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function ImagesDialog({ project: p, onClose }: { project: AdminPortfolioRow; onClose: () => void }) {
  const router = useRouter();
  const { run, isPending } = useRunner();
  const [alt, setAlt] = React.useState("");
  const [caption, setCaption] = React.useState("");
  const [kind, setKind] = React.useState<"screenshot" | "cover">("screenshot");
  const [busy, setBusy] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  async function upload(file: File | undefined) {
    if (!file) return;
    if (alt.trim().length < 3) {
      toast.error("Describe the image first (alt text) so it's accessible.");
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    setBusy(true);
    try {
      const body = new FormData();
      body.set("file", file);
      body.set("alt", alt);
      body.set("caption", caption);
      body.set("kind", kind);
      const res = await fetch(`/api/admin/portfolio/${p.id}/assets`, { method: "POST", body });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "That image couldn't be saved.");
      toast.success("Image uploaded and optimized");
      setAlt("");
      setCaption("");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That image couldn't be saved.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }
  const update = async (id: string, changes: Parameters<typeof updateAssetAction>[1], msg?: string) => {
    const ok = await run(id, () => updateAssetAction(id, changes), msg);
    if (ok !== null) router.refresh();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} size="xl" title={`Images · ${p.title}`} description="Uploads are converted to WebP and stored privately. A published image is visible to signed-in clients once the project itself is published." footer={<Button variant="secondary" onClick={onClose}>Done</Button>}>
      <div className="space-y-5">
        <div className="grid gap-3 rounded-2xl bg-surface-2/60 p-4 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end">
          <Field label="Alt text (required)" htmlFor="pa-alt" hint="Describe what's shown.">
            <Input id="pa-alt" value={alt} maxLength={300} onChange={(e) => setAlt(e.target.value)} />
          </Field>
          <Field label="Caption" htmlFor="pa-cap" optional>
            <Input id="pa-cap" value={caption} maxLength={300} onChange={(e) => setCaption(e.target.value)} />
          </Field>
          <Field label="Use as" htmlFor="pa-kind">
            <Select id="pa-kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="screenshot">Screenshot</option>
              <option value="cover">Cover image</option>
            </Select>
          </Field>
          <label className={cn("inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-xl border border-line bg-surface px-4 text-sm font-medium text-ink shadow-soft transition hover:bg-surface-2 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary sm:h-10", busy && "pointer-events-none opacity-60")}>
            <Upload className="size-4" /> {busy ? "Uploading…" : "Upload image"}
            <input ref={fileRef} type="file" accept=".png,.jpg,.jpeg,.webp" className="sr-only" onChange={(e) => void upload(e.target.files?.[0])} />
          </label>
        </div>

        {p.assets.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-line-strong bg-surface"><EmptyState compact icon={<ImageOff className="size-5" />} title="No images yet" description="Describe the image above, then upload a permitted screenshot. Adding media never publishes the project." /></div>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {p.assets.map((a) => (
              <li key={a.id} className="overflow-hidden rounded-2xl border border-line bg-surface">
                <div className="relative aspect-[16/10] border-b border-line bg-surface-2">
                  <Image src={`/api/portfolio/assets/${a.id}?v=thumb`} alt={a.alt || "Portfolio image"} fill unoptimized sizes="320px" className="object-cover object-top" />
                </div>
                <div className="space-y-3 p-3.5 text-[12.5px]">
                  <div className="flex flex-wrap gap-1.5">
                    <StatusPill tone={a.stored ? "success" : "neutral"} size="sm">{a.stored ? "Stored" : "Source link"}</StatusPill>
                    {a.kind === "cover" && <StatusPill tone="primary" size="sm">Cover</StatusPill>}
                  </div>
                  <p className="line-clamp-2 leading-relaxed text-muted" title={a.alt || undefined}>{a.alt || "No alt text"}</p>
                  <div className="flex flex-wrap gap-1.5">
                    <ChoiceChip checked={a.published} disabled={!a.stored} title={a.stored ? undefined : "Import a copy or upload your own screenshot before publishing"} onChange={() => void update(a.id, { published: !a.published }, !a.published ? "Published" : "Unpublished")}>Published</ChoiceChip>
                    <ChoiceChip checked={a.anonymized} onChange={() => void update(a.id, { anonymized: !a.anonymized })}>Anonymized</ChoiceChip>
                    <ChoiceChip checked={a.kind === "cover"} onChange={() => void update(a.id, { kind: a.kind === "cover" ? "screenshot" : "cover" })}>Cover</ChoiceChip>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {!a.stored && a.sourceUrl && (
                      <Button size="sm" variant="secondary" loading={isPending(`imp-${a.id}`)} onClick={async () => { const ok = await run(`imp-${a.id}`, () => importAssetAction(a.id), "Imported and optimized"); if (ok !== null) router.refresh(); }}>
                        <Download className="size-3.5" /> Import copy
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" loading={isPending(`del-${a.id}`)} onClick={async () => { const ok = await run(`del-${a.id}`, () => deleteAssetAction(a.id), "Image removed"); if (ok !== null) router.refresh(); }}>
                      <Trash2 className="size-3.5" /> Remove
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="flex items-start gap-2.5 rounded-xl border border-line bg-surface-2/60 px-3.5 py-3 text-[12px] leading-relaxed text-muted"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />Images marked “Source link” are previews of the founder&apos;s public site and can&apos;t be published. Use “Import copy” to store an optimized private copy, or upload your own screenshots, then publish. Anonymize or crop anything private first.</p>
      </div>
    </Dialog>
  );
}

function EditDialog({ project: p, services, onClose, onSaved }: { project: AdminPortfolioRow; services: Array<{ slug: string; name: string }>; onClose: () => void; onSaved: () => void }) {
  const { run, isPending } = useRunner();
  const [f, setF] = React.useState(() => ({
    title: p.title,
    anonymizedTitle: p.anonymizedTitle ?? "",
    clientNamePublic: p.clientNamePublic,
    summary: p.summary,
    problem: p.problem,
    solution: p.solution,
    publishedOutcome: p.publishedOutcome ?? "",
    technologies: p.technologies.join(", "),
    categories: p.categories.join(", "),
    status: p.status as PortfolioStatus,
    statusLabel: p.statusLabel ?? "",
    liveDemoUrl: p.liveDemoUrl ?? "",
    featured: p.featured,
    sortOrder: String(p.sortOrder),
    privacyNote: p.privacyNote ?? "",
    limitations: p.limitations.join("\n"),
    sections: sectionsToText(p.sections),
    serviceSlugs: p.serviceSlugs,
  }));
  const text = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  async function save() {
    const res = await run("save", () =>
      savePortfolioAction({
        id: p.id,
        slug: p.slug,
        title: f.title,
        anonymizedTitle: f.anonymizedTitle || null,
        clientNamePublic: f.clientNamePublic,
        summary: f.summary,
        problem: f.problem,
        solution: f.solution,
        publishedOutcome: f.publishedOutcome || null,
        sections: textToSections(f.sections),
        limitations: lines(f.limitations),
        privacyNote: f.privacyNote || null,
        technologies: commas(f.technologies),
        categories: commas(f.categories),
        status: f.status,
        statusLabel: f.statusLabel || null,
        liveDemoUrl: f.liveDemoUrl || null,
        attribution: p.attribution,
        featured: f.featured,
        sortOrder: Number(f.sortOrder) || 0,
        serviceSlugs: f.serviceSlugs,
      }),
      "Saved",
    );
    if (res) onSaved();
  }
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="xl"
      title={`Edit · ${p.title}`}
      description="Editing never publishes. Use Review & publish for that."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="brand" loading={isPending("save")} disabled={f.title.trim().length < 2} onClick={() => void save()}>
            Save changes
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Real project title" htmlFor="pe-title" className="sm:col-span-2">
          <Input id="pe-title" value={f.title} maxLength={200} onChange={text("title")} />
        </Field>
        <Field label="Anonymized title" htmlFor="pe-anon" hint="Shown instead of the real title when the name isn't public.">
          <Input id="pe-anon" value={f.anonymizedTitle} maxLength={200} onChange={text("anonymizedTitle")} />
        </Field>
        <label className="flex items-center gap-2 self-end pb-2 text-[13px]">
          <input type="checkbox" checked={f.clientNamePublic} onChange={(e) => setF({ ...f, clientNamePublic: e.target.checked })} /> The client / project name may be shown publicly
        </label>
        <Field label="Summary" htmlFor="pe-sum" className="sm:col-span-2">
          <Textarea id="pe-sum" rows={3} value={f.summary} maxLength={1200} onChange={text("summary")} />
        </Field>
        <Field label="Problem addressed" htmlFor="pe-prob">
          <Textarea id="pe-prob" rows={5} value={f.problem} maxLength={4000} onChange={text("problem")} />
        </Field>
        <Field label="Solution delivered" htmlFor="pe-sol">
          <Textarea id="pe-sol" rows={5} value={f.solution} maxLength={4000} onChange={text("solution")} />
        </Field>
        <Field label="What it delivers (as published)" htmlFor="pe-out" className="sm:col-span-2" hint="A description, not a measurement. Don't add numbers you can't back up.">
          <Input id="pe-out" value={f.publishedOutcome} maxLength={600} onChange={text("publishedOutcome")} />
        </Field>
        <Field label="Technologies" htmlFor="pe-tech" hint="Comma separated.">
          <Input id="pe-tech" value={f.technologies} onChange={text("technologies")} />
        </Field>
        <Field label="Categories" htmlFor="pe-cat" hint="Comma separated. Used for the gallery filters.">
          <Input id="pe-cat" value={f.categories} onChange={text("categories")} />
        </Field>
        <Field label="Status" htmlFor="pe-status">
          <Select id="pe-status" value={f.status} onChange={text("status")}>
            {(Object.keys(PORTFOLIO_STATUS_LABEL) as PortfolioStatus[]).map((s) => (
              <option key={s} value={s}>
                {PORTFOLIO_STATUS_LABEL[s]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Status label shown" htmlFor="pe-sl" optional hint="Keep it true to the source, e.g. “In development”.">
          <Input id="pe-sl" value={f.statusLabel} maxLength={60} onChange={text("statusLabel")} />
        </Field>
        <Field label="Live demo link (https only)" htmlFor="pe-live" optional>
          <Input id="pe-live" type="url" value={f.liveDemoUrl} onChange={text("liveDemoUrl")} />
        </Field>
        <Field label="Sort order" htmlFor="pe-sort" hint="Lower comes first.">
          <Input id="pe-sort" type="number" min={0} value={f.sortOrder} onChange={text("sortOrder")} />
        </Field>
        <Field label="Privacy note" htmlFor="pe-priv" optional className="sm:col-span-2">
          <Textarea id="pe-priv" rows={2} value={f.privacyNote} maxLength={600} onChange={text("privacyNote")} />
        </Field>
        <Field label="What this case study does not claim" htmlFor="pe-lim" hint="One per line." className="sm:col-span-2">
          <Textarea id="pe-lim" rows={3} value={f.limitations} onChange={text("limitations")} />
        </Field>
        <Field label="Case study sections" htmlFor="pe-sec" className="sm:col-span-2" hint="Start each section with “## Heading”, then a paragraph, then “- bullet” lines.">
          <Textarea id="pe-sec" rows={12} className="font-mono text-[12.5px]" value={f.sections} onChange={text("sections")} />
        </Field>
        <fieldset className="sm:col-span-2">
          <legend className="mb-2 text-[13px] font-medium">Related services</legend>
          <div className="flex flex-wrap gap-2">
            {services.map((s) => (
              <label key={s.slug} className={cn("cursor-pointer rounded-full border px-3 py-1 text-[12.5px] transition", f.serviceSlugs.includes(s.slug) ? "border-primary bg-primary-soft text-primary-ink" : "border-line text-muted")}>
                <input type="checkbox" className="sr-only" checked={f.serviceSlugs.includes(s.slug)} onChange={() => setF({ ...f, serviceSlugs: f.serviceSlugs.includes(s.slug) ? f.serviceSlugs.filter((x) => x !== s.slug) : [...f.serviceSlugs, s.slug] })} />
                {s.name}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="flex items-center gap-2 text-[13px] sm:col-span-2">
          <input type="checkbox" checked={f.featured} onChange={(e) => setF({ ...f, featured: e.target.checked })} /> Featured project
        </label>
      </div>
    </Dialog>
  );
}


