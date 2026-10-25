"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Archive, Copy, Eye, EyeOff, History, LayoutTemplate, MoreHorizontal, Pencil, PencilRuler, Plus, Rocket, Send, Sparkles, Star } from "lucide-react";
import {
  createTemplateAction, duplicateTemplateAction, listTemplateVersionsAction, restoreTemplateVersionAction, setTemplateStatusAction, updateTemplateMetaAction,
} from "@/app/actions/website-admin";
import { Button } from "@/components/ui/button";
import { Dialog, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/overlays";
import { Card, EmptyState } from "@/components/ui/primitives";
import { InfoChip, RelativeTime, StatusPill, type StatusTone } from "@/components/ui/status";
import { AreaControl, Row, SelectControl, TextControl } from "@/components/website/editor/controls";
import { useResetOnOpen } from "@/components/website/editor/hooks";
import { TemplateThumb } from "@/components/website/gallery/template-thumbnail";
import { GalleryFilters } from "@/components/website/gallery/gallery-filters";
import { useUrlState } from "@/components/website/gallery/use-url-state";
import { SitePreviewOverlay } from "@/components/website/admin/site-preview-overlay";
import { EMPTY_GALLERY_FILTERS, INDUSTRY_FILTERS, discoverTemplates, type GalleryFilters as FilterState } from "@/lib/website/gallery";
import { relativeTime } from "@/lib/utils";
import { cn } from "@/lib/utils";
import type { TemplateStatus, TemplateView } from "@/server/websites/templates";

type Tab = "all" | "featured" | "published" | "working" | "hidden" | "archived";
const TABS: Array<{ id: Tab; label: string; match: (t: TemplateView) => boolean }> = [
  { id: "all", label: "All templates", match: () => true }, { id: "featured", label: "Featured", match: (t) => t.featured }, { id: "published", label: "Published", match: (t) => t.status === "published" },
  { id: "working", label: "Drafts & review", match: (t) => t.status === "draft" || t.status === "in_review" }, { id: "hidden", label: "Hidden", match: (t) => t.status === "hidden" }, { id: "archived", label: "Archived", match: (t) => t.status === "archived" },
];
const STATUS_LABEL: Record<TemplateStatus, string> = { draft: "Draft", in_review: "In review", published: "Published", hidden: "Hidden", archived: "Archived" };
const STATUS_TONE: Record<TemplateStatus, StatusTone> = { draft: "neutral", in_review: "violet", published: "success", hidden: "neutral", archived: "neutral" };

// The collection and filters the agency chose live in the address, so returning from the Template Designer or a refresh keeps the same view.
type LibraryUrlState = { [K in keyof FilterState]: string } & { collection: string };
const URL_DEFAULTS: LibraryUrlState = { ...EMPTY_GALLERY_FILTERS, collection: "all" };
const URL_ALLOWED = { sort: ["featured", "name", "recent", "updated"], theme: ["all", "light", "dark"], collection: TABS.map((t) => t.id) } as const;

interface Props {
  templates: TemplateView[];
  canPublish: boolean;
  openNew?: boolean;
  /** Where template pictures are drawn from. The design preview supplies a sample frame that needs no sign-in. */
  frameBase?: string;
}

export function LibraryAdmin({ templates, canPublish, openNew, frameBase = "/frame/template" }: Props) {
  const router = useRouter();
  const [url, setUrl] = useUrlState<LibraryUrlState>(URL_DEFAULTS, URL_ALLOWED);
  const tab = url.collection as Tab;
  const setTab = (next: Tab) => setUrl({ collection: next });
  const filters = React.useMemo<FilterState>(() => ({ q: url.q, industry: url.industry, family: url.family, style: url.style, theme: url.theme, layout: url.layout, typography: url.typography, sort: url.sort as FilterState["sort"] }), [url]);
  const setFilters = (next: FilterState) => setUrl(next);
  const [creating, setCreating] = React.useState(Boolean(openNew));
  const [editing, setEditing] = React.useState<TemplateView | null>(null);
  const [history, setHistory] = React.useState<TemplateView | null>(null);
  const [preview, setPreview] = React.useState<TemplateView | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const scope = React.useMemo(() => discoverTemplates(templates, filters), [templates, filters]);
  const list = scope.filter((t) => TABS.find((x) => x.id === tab)!.match(t));

  const run = async (key: string, fn: () => Promise<{ ok: boolean; error?: string }>, success: string) => {
    setBusy(key);
    try {
      const res = await fn();
      if (!res.ok) return void toast.error(res.error ?? "That didn't work.");
      toast.success(success);
      router.refresh();
    } catch {
      toast.error("We couldn't save that change. Please try again.");
    } finally {
      setBusy(null);
    }
  };
  const frameSrc = (t: TemplateView, thumb: boolean) => `${frameBase}?key=${encodeURIComponent(t.key)}${thumb ? "&thumb=1" : ""}${t.kind === "custom" ? "&draft=1" : ""}`;

  return (
    <div className="space-y-5">
      <GalleryFilters cards={templates} value={filters} onChange={setFilters} actions={<Button variant="brand" className="h-11" onClick={() => setCreating(true)}><Plus className="size-4" /> New template</Button>} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="Template collection" className="relative scrollbar-thin flex max-w-full gap-1 overflow-x-auto rounded-xl border border-line bg-surface p-1">
          {TABS.map((t) => {
            const n = scope.filter(t.match).length;
            return <button key={t.id} type="button" aria-pressed={tab === t.id} onClick={() => setTab(t.id)} className={cn("inline-flex min-h-10 shrink-0 items-center gap-2 rounded-lg px-3 text-[13px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-primary", tab === t.id ? "bg-primary-soft text-primary-ink" : "text-muted hover:bg-surface-2 hover:text-ink")}>{t.id === "featured" && <Star className="size-3.5" aria-hidden />}{t.label}<span className={cn("rounded-md px-1.5 py-0.5 text-[12px] tabular-nums", tab === t.id ? "bg-primary/10" : "bg-surface-3")}>{n}</span></button>;
          })}
        </div>
        <p role="status" className="text-[12px] text-muted">{list.length} template{list.length === 1 ? "" : "s"} <span className="text-faint">· counts match your filters</span></p>
      </div>

      {list.length === 0 ? (
        <Card className="border-dashed"><EmptyState icon={<LayoutTemplate className="size-5" />} title="No templates match" description="No templates match this collection and these filters. Try another collection or clear your filters." action={<Button variant="secondary" onClick={() => { setFilters({ ...EMPTY_GALLERY_FILTERS }); setTab("all"); }}>Clear filters</Button>} /></Card>
      ) : (
        <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3" aria-label="Templates">
          {list.map((t, index) => (
            <li key={t.key} className="min-w-0">
              <Card className="group flex h-full flex-col overflow-hidden rounded-[20px] transition-[border-color,box-shadow] duration-200 hover:border-line-strong hover:shadow-md motion-reduce:transition-none focus-within:border-primary/50">
                <div className="relative">
                  <button type="button" aria-label={`Preview ${t.name}`} onClick={() => setPreview(t)} className="block w-full cursor-zoom-in overflow-hidden border-b border-line bg-surface-2 text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary">
                    <TemplateThumb card={t} frameBase={frameBase} priority={index < 3} draft={t.kind === "custom"} />
                  </button>
                  <div className="absolute left-2.5 top-2.5 flex flex-wrap gap-1.5">
                    {t.featured && <span className="inline-flex h-6 items-center gap-1 rounded-full bg-ink/85 px-2.5 text-[12px] font-semibold text-white shadow-soft backdrop-blur"><Star className="size-3 fill-current" aria-hidden /> Featured</span>}
                    {t.kind === "custom" && <span className="inline-flex h-6 items-center gap-1 rounded-full bg-primary px-2.5 text-[12px] font-semibold text-white shadow-soft"><Sparkles className="size-3" aria-hidden /> Agency design</span>}
                  </div>
                </div>
                <div className="flex flex-1 flex-col gap-3 p-5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0"><p className="truncate text-[12px] font-semibold uppercase tracking-[.12em] text-muted" title={t.familyName}>{t.familyName}</p><h2 className="mt-1 truncate text-[19px] font-semibold tracking-tight" title={t.name}>{t.name}</h2></div>
                    <StatusPill tone={STATUS_TONE[t.status]}>{STATUS_LABEL[t.status]}</StatusPill>
                  </div>
                  <p className="line-clamp-2 text-[13px] leading-relaxed text-muted" title={t.description || undefined}>{t.description || "No description yet."}</p>
                  {t.unpublishedChanges && <div><StatusPill tone="warning" size="sm">Changes awaiting publication</StatusPill></div>}
                  {(t.industries.length > 0 || t.tags.length > 0) && (
                    <ul className="flex flex-wrap gap-1.5" aria-label="Industries and tags">
                      {t.industries.map((id) => INDUSTRY_FILTERS.find((i) => i.id === id)?.label).filter(Boolean).slice(0, 2).map((x) => <li key={x} className="max-w-full"><span className="inline-flex h-6 max-w-full items-center rounded-lg bg-primary-soft px-2 text-[12px] font-medium text-primary-ink ring-1 ring-inset ring-primary/15"><span className="truncate">{x}</span></span></li>)}
                      {t.tags.slice(0, 3).map((x) => <li key={x} className="max-w-full"><InfoChip className="capitalize">{x}</InfoChip></li>)}
                    </ul>
                  )}
                  <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-line pt-4">
                    <Button size="sm" variant="secondary" className="max-sm:h-10" onClick={() => setPreview(t)}><Eye className="size-3.5" /> Preview</Button>
                    {t.kind === "custom" && t.id && <Link href={`/admin/website-studio/templates/${t.id}`} className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-primary-soft px-3 text-[14px] font-medium text-primary-ink hover:bg-primary/15 sm:h-8"><PencilRuler className="size-3.5" aria-hidden /> Customize</Link>}
                    {t.kind === "builtin" && <Button size="sm" variant="soft" className="max-sm:h-10" loading={busy === `dup-${t.key}`} onClick={() => void run(`dup-${t.key}`, async () => { const r = await duplicateTemplateAction(t.key); if (r.ok) router.push(`/admin/website-studio/templates/${r.data.id}`); return r; }, "Created an editable copy.")}><Copy className="size-3.5" /> Customize</Button>}
                    <Menu>
                      <MenuTrigger asChild><Button size="sm" variant="ghost" className="ml-auto max-sm:h-10" aria-label={`More for ${t.name}`}><MoreHorizontal className="size-4" /> More</Button></MenuTrigger>
                      <MenuContent align="end">
                        <MenuItem onSelect={() => setEditing(t)}><Pencil className="mr-2 size-3.5" /> Edit details</MenuItem>
                        <MenuItem onSelect={() => void run(`dup-${t.key}`, async () => { const r = await duplicateTemplateAction(t.key); if (r.ok) router.push(`/admin/website-studio/templates/${r.data.id}`); return r; }, "Duplicated as a draft.")}><Copy className="mr-2 size-3.5" /> Duplicate</MenuItem>
                        {t.kind === "custom" && <MenuItem onSelect={() => setHistory(t)}><History className="mr-2 size-3.5" /> Version history</MenuItem>}
                        {t.kind === "custom" && t.status === "draft" && <MenuItem onSelect={() => void run(`rev-${t.key}`, () => setTemplateStatusAction(t.key, "in_review"), "Sent for review.")}><Send className="mr-2 size-3.5" /> Send for review</MenuItem>}
                        <MenuSeparator />
                        {canPublish && t.kind === "custom" && t.status !== "published" && <MenuItem onSelect={() => void run(`pub-${t.key}`, () => setTemplateStatusAction(t.key, "published"), "Published to the client library.")}><Rocket className="mr-2 size-3.5" /> Publish to clients</MenuItem>}
                        {canPublish && t.kind === "custom" && t.status === "published" && t.unpublishedChanges && <MenuItem onSelect={() => void run(`pub-${t.key}`, () => setTemplateStatusAction(t.key, "published"), "Published the latest changes.")}><Rocket className="mr-2 size-3.5" /> Publish latest changes</MenuItem>}
                        {canPublish && <MenuItem onSelect={() => void run(`feat-${t.key}`, () => updateTemplateMetaAction(t.key, { featured: !t.featured }), t.featured ? "No longer featured." : "Featured.")}><Star className="mr-2 size-3.5" /> {t.featured ? "Remove from featured" : "Feature"}</MenuItem>}
                        {canPublish && (t.status === "published" ? <MenuItem onSelect={() => void run(`hide-${t.key}`, () => setTemplateStatusAction(t.key, "hidden"), "Hidden from clients.")}><EyeOff className="mr-2 size-3.5" /> Hide from clients</MenuItem> : t.status === "hidden" && (t.kind === "builtin" || t.unpublishedChanges === false) ? <MenuItem onSelect={() => void run(`show-${t.key}`, () => setTemplateStatusAction(t.key, "published"), "Visible to clients again.")}><Eye className="mr-2 size-3.5" /> Show to clients</MenuItem> : null)}
                        {canPublish && t.status !== "archived" && <MenuItem destructive onSelect={() => void run(`arc-${t.key}`, () => setTemplateStatusAction(t.key, "archived"), "Archived.")}><Archive className="mr-2 size-3.5" /> Archive</MenuItem>}
                        {canPublish && t.status === "archived" && <MenuItem onSelect={() => void run(`un-${t.key}`, () => setTemplateStatusAction(t.key, t.kind === "builtin" ? "published" : "draft"), "Restored.")}>Restore</MenuItem>}
                      </MenuContent>
                    </Menu>
                  </div>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
      <p className="text-[12px] leading-relaxed text-muted">A template is a starting point. When a client picks one, their website gets its own copy, so changing, hiding or archiving a template never changes a website that already exists.</p>

      <CreateDialog open={creating} onOpenChange={setCreating} templates={templates} onCreated={(id) => router.push(`/admin/website-studio/templates/${id}`)} />
      {editing && <EditDialog t={editing} showUsage={canPublish} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); router.refresh(); }} />}
      {history && <HistoryDialog t={history} onClose={() => setHistory(null)} onRestored={() => { setHistory(null); router.refresh(); }} />}
      {preview && <SitePreviewOverlay title={`${preview.familyName} · ${preview.name}`} note={preview.kind === "custom" ? "Working copy" : "Template preview"} src={frameSrc(preview, false)} onClose={() => setPreview(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------

function CreateDialog({ open, onOpenChange, templates, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; templates: TemplateView[]; onCreated: (id: string) => void }) {
  const [name, setName] = React.useState("");
  const [from, setFrom] = React.useState("blank");
  const [busy, setBusy] = React.useState(false);
  useResetOnOpen(open, () => {
    setName("");
    setFrom("blank");
  });
  const create = async () => {
    setBusy(true);
    const src = templates.find((t) => t.key === from);
    const res = await createTemplateAction({ name, from: from === "blank" ? { kind: "blank" } : src?.kind === "custom" ? { kind: "custom", key: from } : { kind: "builtin", key: from }, industries: src?.industries, tags: src?.tags.slice(0, 6) });
    setBusy(false);
    if (!res.ok) return void toast.error(res.error);
    onOpenChange(false);
    onCreated(res.data.id);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="md" title="New template" description="Start from a blank page, or from any existing design, then change everything in the Template Designer. It stays a draft until a super admin publishes it."
      footer={<><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="brand" loading={busy} disabled={name.trim().length < 2} onClick={() => void create()}>Create and open the designer</Button></>}>
      <div className="space-y-4">
        <Row label="Name" htmlFor="nt-name"><TextControl id="nt-name" autoFocus value={name} maxLength={80} placeholder="For example: Coastal Realty" onChange={(e) => setName(e.target.value)} /></Row>
        <Row label="Start from">
          <SelectControl<string> label="Start from" value={from} onChange={setFrom} options={[{ value: "blank", label: "A blank page" }, ...templates.filter((t) => t.status !== "archived").map((t) => ({ value: t.key, label: `${t.familyName} · ${t.name}` }))]} />
        </Row>
      </div>
    </Dialog>
  );
}

function EditDialog({ t, showUsage, onClose, onSaved }: { t: TemplateView; /** Usage is counted across every client, so only someone who can see every client is shown it. */ showUsage: boolean; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = React.useState(t.name);
  const [description, setDescription] = React.useState(t.description);
  const [industries, setIndustries] = React.useState(t.industries);
  const [tags, setTags] = React.useState(t.tags.join(", "));
  const [busy, setBusy] = React.useState(false);
  const save = async () => {
    setBusy(true);
    const res = await updateTemplateMetaAction(t.key, { ...(t.kind === "custom" ? { name, description } : {}), industries, tags: tags.split(",").map((x) => x.trim()).filter(Boolean) });
    if (!res.ok) {
      setBusy(false);
      return void toast.error(res.error);
    }
    setBusy(false);
    toast.success("Saved.");
    onSaved();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} size="md" title={`Details: ${t.name}`} description={t.kind === "builtin" ? "Built-in designs keep their name and description. You can tag them and choose which industries they're shown for." : "How this template appears in the library."}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="brand" loading={busy} onClick={() => void save()}>Save</Button></>}>
      <div className="space-y-4">
        <dl className="grid grid-cols-2 gap-x-5 gap-y-3 rounded-xl border border-line bg-surface-2 p-4 text-[12px]">
          <div><dt className="text-muted">Publication</dt><dd className="mt-1.5 flex flex-wrap gap-1.5"><StatusPill tone={STATUS_TONE[t.status]} size="sm">{STATUS_LABEL[t.status]}</StatusPill>{t.featured && <StatusPill tone="primary" size="sm" icon={<Star className="size-3 fill-current" />}>Featured</StatusPill>}</dd></div>
          <div><dt className="text-muted">Current version</dt><dd className="mt-1 font-medium">{t.version || "Unpublished"}</dd></div>
          {showUsage && <div><dt className="text-muted">Websites started from it</dt><dd className="mt-1 font-medium">{t.sitesUsing} <span className="font-normal text-muted">across all clients</span></dd></div>}
          <div><dt className="text-muted">Last updated</dt><dd className="mt-1 font-medium">{t.updatedAt ? relativeTime(t.updatedAt) : "Built-in collection"}{t.updatedByName ? ` by ${t.updatedByName}` : ""}</dd></div>
          <div className="col-span-2"><dt className="text-muted">Template reference</dt><dd className="mt-1.5"><code className="block break-all rounded-lg bg-surface px-2 py-1.5 font-mono text-[12px] text-ink-2 ring-1 ring-inset ring-line">{t.key}</code></dd></div>
        </dl>
        {t.kind === "custom" && <Row label="Name" htmlFor="ed-name"><TextControl id="ed-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} /></Row>}
        {t.kind === "custom" && <Row label="Short description" htmlFor="ed-desc"><AreaControl id="ed-desc" rows={2} value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} /></Row>}
        <Row label="Industries">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Industries">
            {INDUSTRY_FILTERS.map((i) => (
              <button key={i.id} type="button" aria-pressed={industries.includes(i.id)} onClick={() => setIndustries((c) => (c.includes(i.id) ? c.filter((x) => x !== i.id) : [...c, i.id]))} className={cn("h-10 rounded-full border px-3.5 text-[12px] font-medium transition-colors sm:h-8", industries.includes(i.id) ? "border-primary bg-primary text-white" : "border-line bg-surface text-ink-2 hover:border-line-strong hover:bg-surface-2")}>{i.label}</button>
            ))}
          </div>
        </Row>
        <Row label="Tags" hint="Comma separated, for search and filters." htmlFor="ed-tags"><TextControl id="ed-tags" value={tags} maxLength={200} placeholder="luxury, serif, coastal" onChange={(e) => setTags(e.target.value)} /></Row>
        <p className="rounded-xl bg-surface-2 p-3 text-[12px] leading-relaxed text-muted">The card thumbnail is generated from the website preview so clients see the same design when they open it.</p>
      </div>
    </Dialog>
  );
}

function HistoryDialog({ t, onClose, onRestored }: { t: TemplateView; onClose: () => void; onRestored: () => void }) {
  const [list, setList] = React.useState<Array<{ version: number; note: string | null; createdAt: string; createdByName: string | null }> | null>(null);
  const [busy, setBusy] = React.useState<number | null>(null);
  React.useEffect(() => {
    let live = true;
    if (t.id) void listTemplateVersionsAction(t.id).then((r) => { if (live && r.ok) setList(r.data); });
    return () => { live = false; };
  }, [t.id]);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} size="md" title={`Versions of ${t.name}`} description="Each publication is kept. Restoring one puts it into the working copy; it isn't offered to clients until it is published again.">
      {!list ? <p className="py-6 text-center text-[14px] text-muted" role="status">Loading versions…</p> : list.length === 0 ? <EmptyState compact icon={<History className="size-5" />} title="Not published yet" description="There are no versions until this template is published." /> : (
        <ul className="divide-y divide-line">
          {list.map((v) => (
            <li key={v.version} className="flex items-center justify-between gap-3 py-3">
              <div><p className="text-[14px] font-semibold">Version {v.version}</p><div className="mt-1 flex flex-wrap gap-1.5"><InfoChip><RelativeTime value={v.createdAt} /></InfoChip>{v.createdByName && <InfoChip>{v.createdByName}</InfoChip>}</div>{v.note && <p className="mt-1.5 text-[13px] italic text-ink-2">“{v.note}”</p>}</div>
              <Button size="sm" variant="secondary" loading={busy === v.version} onClick={async () => { setBusy(v.version); const r = await restoreTemplateVersionAction(t.id!, v.version); setBusy(null); if (!r.ok) return void toast.error(r.error); toast.success(`Version ${v.version} is back in the working copy.`); onRestored(); }}>Restore to working copy</Button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
