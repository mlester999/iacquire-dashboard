"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Archive, ArchiveRestore, ArrowDownToLine, Copy, Download, Eye, FolderInput, FolderTree, Layers, MoreHorizontal, Pencil, Plus, Rocket, Search, Send, Sparkles, Star,
  TriangleAlert, Upload, Users, X,
} from "lucide-react";
import { archiveBlueprintAction, installStarterAction, unarchiveBlueprintAction, updateBlueprintDetailsAction } from "@/app/actions/crm-blueprints";
import { Button, ButtonLink } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Sheet } from "@/components/ui/overlays";
import { Badge, Card, Input, Select } from "@/components/ui/primitives";
import { MetricCard, PageHero, SectionLabel } from "@/components/ui/workspace";
import { ConfirmDialog } from "@/components/crm/ui";
import { useUrlState } from "@/components/website/gallery/use-url-state";
import { cn, formatNumber } from "@/lib/utils";
import { BLUEPRINT_SOURCE_LABELS } from "@/lib/crm/blueprints/types";
import type { BlueprintFolderView, BlueprintSummary, CapturePreview, ClientOption, StarterView } from "@/lib/crm/blueprints/views";
import {
  CompatibilityBadge, INDUSTRY_OPTIONS, ModuleChips, RequirementList, SourceBadge, StatusBadge, When, bpHref, compatibilityHint, industryLabel, useBlueprintAction,
  type BlueprintUiPermissions,
} from "@/components/crm-blueprints/shared";
import { NewBlueprintDialog, type CreateMode } from "@/components/crm-blueprints/create-dialog";
import { CaptureDialog } from "@/components/crm-blueprints/capture-dialog";
import { FoldersDialog, MoveToFolderDialog } from "@/components/crm-blueprints/folders-dialog";
import { dropParams } from "@/components/crm-blueprints/url-params";

type Collection = "all" | "native" | "ghl" | "featured" | "drafts" | "published" | "archived";
export const COLLECTIONS: Array<{ id: Collection; label: string; match: (b: BlueprintSummary) => boolean }> = [
  { id: "all", label: "All", match: (b) => b.status !== "archived" },
  { id: "native", label: "Native", match: (b) => b.status !== "archived" && b.source !== "ghl_import" },
  { id: "ghl", label: "Imported from GoHighLevel", match: (b) => b.status !== "archived" && b.source === "ghl_import" },
  { id: "featured", label: "Featured", match: (b) => b.status !== "archived" && b.featured },
  { id: "drafts", label: "Drafts", match: (b) => b.status === "draft" },
  { id: "published", label: "Published", match: (b) => b.status === "published" },
  { id: "archived", label: "Archived", match: (b) => b.status === "archived" },
];

const SORTS = [
  { id: "updated", label: "Recently updated" },
  { id: "name", label: "Name A–Z" },
  { id: "applied", label: "Most applied" },
  { id: "created", label: "Newest" },
] as const;

type UrlState = { q: string; industry: string; folder: string; sort: string; collection: string };
const URL_DEFAULTS: UrlState = { q: "", industry: "all", folder: "all", sort: "updated", collection: "all" };
/** Choosing a Blueprint for one client (?client=<orgId>) opens on what can be applied: the published ones. */
const URL_DEFAULTS_FOR_CLIENT: UrlState = { ...URL_DEFAULTS, collection: "published" };
const URL_ALLOWED = { sort: SORTS.map((s) => s.id), collection: COLLECTIONS.map((c) => c.id), industry: ["all", ...INDUSTRY_OPTIONS.map((o) => o.value)] } as const;

/** What the library search matches: name, description, key, industry, source, folder and the CRM modules. */
export function matchesSearch(b: BlueprintSummary, q: string): boolean {
  const t = q.trim().toLowerCase();
  if (!t) return true;
  return [b.name, b.description, b.key, industryLabel(b.industry), BLUEPRINT_SOURCE_LABELS[b.source], b.sourceLabel ?? "", b.folderName ?? "", ...b.modules.map((m) => m.label)]
    .some((x) => x.toLowerCase().includes(t));
}

export function sortBlueprints(list: BlueprintSummary[], sort: string): BlueprintSummary[] {
  const by = [...list];
  if (sort === "name") by.sort((a, b) => a.name.localeCompare(b.name));
  else if (sort === "applied") by.sort((a, b) => b.appliedTo - a.appliedTo || a.name.localeCompare(b.name));
  else if (sort === "created") by.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  else by.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return by;
}

export interface BlueprintLibraryProps {
  blueprints: BlueprintSummary[];
  folders: BlueprintFolderView[];
  starters: StarterView[];
  clients: ClientOption[];
  permissions: BlueprintUiPermissions;
  /** ?capture=<orgId>: opens capture for that client. */
  captureOrgId?: string | null;
  /** ?new=1: opens the New Blueprint dialog. */
  openNew?: boolean;
  /**
   * ?client=<orgId>: choosing a Blueprint to apply to that client (from the client's page). Only a client this person may apply to and can
   * reach is ever passed. The page keys the library by it, so entering or leaving this mode starts from the address again.
   */
  applyFor?: ClientOption | null;
  preview?: boolean;
  /** Design preview only: a capture preview to show without a server. */
  samplePreview?: CapturePreview | null;
}

/** The agency's CRM Blueprints & Snapshots library: collections, filters, cards, starters, folders, and the ways to create a Blueprint. */
export function BlueprintLibrary({ blueprints, folders, starters, clients, permissions, captureOrgId, openNew, applyFor, preview, samplePreview }: BlueprintLibraryProps) {
  const router = useRouter();
  const { run, busy } = useBlueprintAction(preview);
  const forClient = applyFor && permissions.apply ? applyFor : null;
  // Fixed for the life of this library (the page remounts it when ?client changes), as useUrlState expects.
  const [defaults] = React.useState(() => (forClient ? URL_DEFAULTS_FOR_CLIENT : URL_DEFAULTS));
  const [url, setUrl] = useUrlState<UrlState>(defaults, URL_ALLOWED);
  const [creating, setCreating] = React.useState<{ mode: CreateMode; blueprintId?: string; starterKey?: string } | null>(openNew && permissions.design ? { mode: "blank" } : null);
  const [capturing, setCapturing] = React.useState<boolean>(Boolean(captureOrgId && permissions.capture));
  // Only the address that opened the page preselects a client; capture opened later starts from the client list.
  const [captureFor, setCaptureFor] = React.useState<string | null>(captureOrgId ?? null);
  const [managingFolders, setManagingFolders] = React.useState(false);
  const [moving, setMoving] = React.useState<BlueprintSummary | null>(null);
  const [archiving, setArchiving] = React.useState<BlueprintSummary | null>(null);
  const [peek, setPeek] = React.useState<BlueprintSummary | null>(null);

  const collection = (COLLECTIONS.find((c) => c.id === url.collection) ?? COLLECTIONS[0]).id;
  const scope = React.useMemo(() => blueprints.filter((b) =>
    matchesSearch(b, url.q)
    && (url.industry === "all" || b.industry === url.industry)
    && (url.folder === "all" || (url.folder === "none" ? !b.folderId : b.folderId === url.folder))), [blueprints, url.q, url.industry, url.folder]);
  const list = sortBlueprints(scope.filter(COLLECTIONS.find((c) => c.id === collection)!.match), url.sort);
  const filtered = Boolean(url.q.trim()) || url.industry !== "all" || url.folder !== "all";
  const applyHrefFor = (id: string) => bpHref.apply(id, forClient?.id);
  const clear = () => setUrl({ q: "", industry: "all", folder: "all" });

  const active = blueprints.filter((b) => b.status !== "archived");
  const published = active.filter((b) => b.status === "published").length;
  // Live applications count whether or not the Blueprint was archived since: archiving never touches a client's copy.
  const applications = blueprints.reduce((n, b) => n + b.appliedTo, 0);
  const usedBlueprints = blueprints.filter((b) => b.appliedTo > 0).length;
  const fromGhl = active.filter((b) => b.source === "ghl_import").length;
  const partial = active.filter((b) => b.compatibility === "partial").length;
  const shownStarters = starters.filter((s) => (url.industry === "all" || s.industry === url.industry) && (!url.q.trim() || [s.name, s.description, industryLabel(s.industry)].some((x) => x.toLowerCase().includes(url.q.trim().toLowerCase()))));

  const archive = async (b: BlueprintSummary) => {
    if (await run(`archive-${b.id}`, () => archiveBlueprintAction(b.id), "Archived. Clients that applied it keep their own copies.")) setArchiving(null);
  };

  return (
    <div className="module-stack">
      <PageHero eyebrow="Agency CRM" icon={<Layers className="size-5" />} title="CRM Blueprints & Snapshots"
        description={<>Reusable CRM configuration (pipelines, fields, tags, Smart Lists, calendars, forms, message drafts, workflow drafts and reports) that you build once and apply to a client as their own independent copy. A Blueprint never carries contacts, conversations, appointments, credentials or anything personal.</>}
        action={<>
          {permissions.design && <Button variant="brand" onClick={() => setCreating({ mode: "blank" })}><Plus className="size-4" /> New Blueprint</Button>}
          {(permissions.importFile || permissions.importGhl) && <ButtonLink href={bpHref.import} variant="secondary"><Upload className="size-4" /> Import</ButtonLink>}
          {permissions.design && <Button variant="ghost" onClick={() => setManagingFolders(true)}><FolderTree className="size-4" /> Folders</Button>}
        </>} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard label="In the library" value={formatNumber(active.length)} detail={`${published} published · ${active.length - published} ${active.length - published === 1 ? "draft" : "drafts"}`} icon={<Layers className="size-4" />} tone="blue" />
        <MetricCard label="Applied to clients" value={formatNumber(applications)} detail={applications ? `Live in client workspaces, from ${usedBlueprints} ${usedBlueprints === 1 ? "Blueprint" : "Blueprints"}` : "No client uses a Blueprint yet"} icon={<Users className="size-4" />} tone="green" />
        <MetricCard label="From GoHighLevel" value={formatNumber(fromGhl)} detail="Converted through the official, read-only API" icon={<ArrowDownToLine className="size-4" />} tone="violet" />
        <MetricCard label="Partly converted" value={formatNumber(partial)} detail={partial ? "Rebuild or review some items before applying" : "Nothing waiting to be rebuilt"} icon={<TriangleAlert className="size-4" />} tone={partial ? "amber" : "neutral"} />
      </div>

      {forClient && <ApplyForClientBanner client={forClient} />}

      <section aria-labelledby="bp-library-heading" className="space-y-4">
        <h2 id="bp-library-heading" className="sr-only">Library</h2>
        <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-3 shadow-soft lg:flex-row lg:items-center">
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">Search Blueprints</span>
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
            <Input type="search" value={url.q} onChange={(e) => setUrl({ q: e.target.value })} placeholder="Search by name, industry, module or key" className="pl-10" />
          </label>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:flex">
            <Select aria-label="Industry" value={url.industry} onChange={(e) => setUrl({ industry: e.target.value })} className="lg:w-48">
              <option value="all">All industries</option>
              {INDUSTRY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
            <Select aria-label="Folder" value={url.folder} onChange={(e) => setUrl({ folder: e.target.value })} className="lg:w-44">
              <option value="all">All folders</option>
              <option value="none">Unfiled</option>
              {folders.map((f) => <option key={f.id} value={f.id}>{f.name} ({f.count})</option>)}
            </Select>
            <Select aria-label="Sort by" value={url.sort} onChange={(e) => setUrl({ sort: e.target.value })} className="lg:w-44">
              {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </Select>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div role="group" aria-label="Collection" className="scrollbar-thin flex max-w-full gap-1 overflow-x-auto rounded-xl border border-line bg-surface p-1">
            {COLLECTIONS.map((c) => {
              const n = scope.filter(c.match).length;
              const on = collection === c.id;
              return (
                <button key={c.id} type="button" aria-pressed={on} onClick={() => setUrl({ collection: c.id })}
                  className={cn("inline-flex min-h-11 shrink-0 items-center gap-2 rounded-lg px-3 text-[12.5px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-primary sm:min-h-9", on ? "bg-primary-soft text-primary-ink" : "text-muted hover:bg-surface-2 hover:text-ink")}>
                  {c.id === "featured" && <Star className="size-3.5" aria-hidden />}{c.label}
                  <span className={cn("rounded-md px-1.5 py-0.5 text-[10px] tabular-nums", on ? "bg-primary/10" : "bg-surface-3")}>{n}</span>
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-3">
            {filtered && <button type="button" onClick={clear} className="inline-flex min-h-11 items-center gap-1 text-[12.5px] font-medium text-primary-ink hover:underline sm:min-h-0"><X className="size-3.5" aria-hidden /> Clear filters</button>}
            <p role="status" className="text-[12px] text-muted">{list.length} {list.length === 1 ? "Blueprint" : "Blueprints"}{filtered ? " match" : ""}</p>
          </div>
        </div>

        {list.length === 0 ? (
          <Card className="border-dashed px-6 py-12 text-center">
            <Layers className="mx-auto size-8 text-faint" aria-hidden />
            <p className="mt-3 text-[16px] font-semibold text-ink">{blueprints.length ? "Nothing in this view" : "Your library is empty"}</p>
            <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-muted">
              {blueprints.length ? "No Blueprint matches this collection and these filters." : "Create a Blueprint from scratch, add one of the iAcquire starters below, capture one from a client's CRM, or import from GoHighLevel or a package file."}
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {blueprints.length ? <Button variant="secondary" onClick={() => setUrl({ q: "", industry: "all", folder: "all", collection: "all" })}>Show everything</Button>
                : permissions.design && <Button variant="brand" onClick={() => setCreating({ mode: "blank" })}><Plus className="size-4" /> New Blueprint</Button>}
            </div>
          </Card>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Blueprints">
            {list.map((b) => (
              <li key={b.id}>
                <BlueprintCard b={b} permissions={permissions} busy={busy} forClient={forClient} applyHref={applyHrefFor(b.id)}
                  onPreview={() => setPeek(b)}
                  onDuplicate={() => setCreating({ mode: "duplicate", blueprintId: b.id })}
                  onMove={() => setMoving(b)}
                  onArchive={() => setArchiving(b)}
                  onRestore={() => void run(`restore-${b.id}`, () => unarchiveBlueprintAction(b.id), "Restored to the library.")}
                  onFeature={() => void run(`feature-${b.id}`, () => updateBlueprintDetailsAction(b.id, { featured: !b.featured }), b.featured ? "No longer featured." : "Featured in the library.")}
                  onPublish={() => router.push(`${bpHref.detail(b.id, "versions")}&publish=1`)} />
              </li>
            ))}
          </ul>
        )}
        <p className="text-[12px] leading-relaxed text-muted">Applying a Blueprint gives the client their own copy. Editing, publishing, archiving or deleting a folder here never changes a client&apos;s CRM; clients see a newer version only when you review and apply it for them.</p>
      </section>

      <section aria-label="iAcquire starters">
        <SectionLabel title="iAcquire starters" count={shownStarters.length}
          description="Original starting points for common industries: pipeline stages, contact fields, tags, Smart Lists, appointment types, forms, message drafts, workflow drafts and report presets. Adding one puts a published copy in your library (super admins), or start an editable draft from it; nothing reaches a client and no outbound sequence is switched on." />
        {shownStarters.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line-strong px-4 py-6 text-center text-[13px] text-muted">{starters.length ? "No starter matches these filters." : "No starters are available in this environment."}</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="iAcquire starters">
            {shownStarters.map((s) => (
              <li key={s.key}>
                <Card className="flex h-full flex-col gap-3 rounded-[18px] p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-[10.5px] font-semibold uppercase tracking-[.12em] text-muted">{industryLabel(s.industry)}</p>
                      <h3 className="mt-1 text-[15px] font-semibold tracking-tight text-ink">{s.name}</h3>
                    </div>
                    <Sparkles className="size-4 shrink-0 text-primary" aria-hidden />
                  </div>
                  <p className="line-clamp-2 text-[12.5px] leading-relaxed text-muted">{s.description}</p>
                  <ModuleChips modules={s.modules} max={4} />
                  <p className="text-[11.5px] text-muted">{s.totalAssets} {s.totalAssets === 1 ? "asset" : "assets"} · {s.requirements.length} setup {s.requirements.length === 1 ? "step" : "steps"} per client</p>
                  <div className="mt-auto border-t border-line pt-3">
                    {s.installedId ? (
                      <ButtonLink href={bpHref.detail(s.installedId)} size="sm" variant="secondary">In your library · Open</ButtonLink>
                    ) : permissions.publish ? (
                      <Button size="sm" variant="soft" loading={busy(`starter-${s.key}`)} aria-label={`Add to library: ${s.name}`}
                        onClick={() => void run(`starter-${s.key}`, () => installStarterAction(s.key), "Added to your library as a published Blueprint.")}>
                        <Plus className="size-3.5" /> Add to library
                      </Button>
                    ) : permissions.design ? (
                      // Adding a starter publishes it, which is for super admins; anyone who designs can start an editable draft from it.
                      <Button size="sm" variant="soft" aria-label={`Start a draft from it: ${s.name}`} onClick={() => setCreating({ mode: "starter", starterKey: s.key })}>
                        <Plus className="size-3.5" /> Start a draft from it
                      </Button>
                    ) : <p className="text-[12px] text-muted">Your role can&apos;t add starters.</p>}
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      <NewBlueprintDialog open={Boolean(creating)} onOpenChange={(o) => { if (!o) { setCreating(null); dropParams("new"); } }} initial={creating ?? undefined} blueprints={blueprints} starters={starters} folders={folders}
        permissions={permissions} preview={preview} onCapture={() => { setCreating(null); setCapturing(true); }} />
      <CaptureDialog open={capturing} onOpenChange={(o) => { setCapturing(o); if (!o) { setCaptureFor(null); dropParams("capture"); } }} clients={clients} initialOrgId={captureFor} initialPreview={samplePreview} preview={preview} />
      <FoldersDialog open={managingFolders} onOpenChange={setManagingFolders} folders={folders} preview={preview} />
      <MoveToFolderDialog blueprint={moving} folders={folders} onClose={() => setMoving(null)} preview={preview} />
      <ConfirmDialog open={Boolean(archiving)} onOpenChange={(o) => !o && setArchiving(null)} title={archiving ? `Archive “${archiving.name}”?` : "Archive"}
        description="It leaves the library's active collections and can't be applied to another client. Clients that already applied it keep their own copies, and nothing in their CRM changes. You can restore it from Archived."
        confirmLabel="Archive" danger loading={archiving ? busy(`archive-${archiving.id}`) : false} onConfirm={() => archiving && void archive(archiving)} />
      <PreviewSheet b={peek} permissions={permissions} applyHref={peek ? applyHrefFor(peek.id) : bpHref.library} forClient={forClient} onClose={() => setPeek(null)} />
    </div>
  );
}

/** The live version of a Blueprint already in this client's CRM, if any. */
export function appliedVersionFor(client: ClientOption | null | undefined, blueprintId: string): number | null {
  return client?.appliedBlueprints.find((a) => a.blueprintId === blueprintId)?.version ?? null;
}

/** Shown while choosing a Blueprint for one client (?client=<orgId>): who it is for, what applying does, and how to stop. */
function ApplyForClientBanner({ client }: { client: ClientOption }) {
  const ghl = client.crmMode === "ghl";
  return (
    <section aria-labelledby="bp-for-client" className="flex flex-col gap-3 rounded-2xl border border-primary/25 bg-primary-soft px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h2 id="bp-for-client" className="flex items-center gap-2 text-[14px] font-semibold text-ink"><Send className="size-4 text-primary" aria-hidden /> Choosing a Blueprint for {client.name}</h2>
        <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
          {ghl
            ? `${client.name} uses GoHighLevel as its CRM, so a Blueprint can't be applied to it. Blueprints apply to iAcquire Native CRM only; switch its CRM provider first.`
            : `Pick a published Blueprint. Applying starts with a preview of every change to ${client.name}'s CRM, and nothing changes until you confirm.${client.crmMode === "hybrid" ? " Sections GoHighLevel owns for this client are left out." : ""}`}
        </p>
        {client.appliedBlueprints.length > 0 && (
          <p className="mt-1 text-[12px] text-muted">Already applied: {client.appliedBlueprints.map((a) => `${a.name} (version ${a.version})`).join(", ")}.</p>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <ButtonLink href={bpHref.client(client.id)} size="sm" variant="secondary">Back to {client.name}</ButtonLink>
        <ButtonLink href={bpHref.library} size="sm" variant="ghost" aria-label={`Whole library: stop choosing a Blueprint for ${client.name}`}><X className="size-3.5" /> Whole library</ButtonLink>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------

function BlueprintCard({ b, permissions, busy, forClient, applyHref, onPreview, onDuplicate, onMove, onArchive, onRestore, onFeature, onPublish }: {
  b: BlueprintSummary;
  permissions: BlueprintUiPermissions;
  busy: (key: string) => boolean;
  forClient: ClientOption | null;
  applyHref: string;
  onPreview: () => void;
  onDuplicate: () => void;
  onMove: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onFeature: () => void;
  onPublish: () => void;
}) {
  const titleId = `bp-card-${b.id}`;
  const archived = b.status === "archived";
  const canApply = permissions.apply && b.status === "published" && b.currentVersion !== null && forClient?.crmMode !== "ghl";
  // Staff who design can run the dry run but not apply: they get a link to the read-only preview instead.
  const canPreview = !permissions.apply && permissions.design && b.status === "published" && b.currentVersion !== null && forClient?.crmMode !== "ghl";
  const appliedHere = appliedVersionFor(forClient, b.id);
  const update = appliedHere !== null && b.currentVersion !== null && b.currentVersion > appliedHere;
  // The banner names the client, so the button stays short; its accessible name says who it is for.
  const applyLabel = update ? "Review update" : "Apply";
  const applyName = forClient ? `${update ? "Review the update of" : "Apply"} ${b.name} for ${forClient.name}` : `Apply ${b.name} to a client`;
  return (
    <Card className={cn("group flex h-full flex-col overflow-hidden rounded-[20px] transition-[border-color,box-shadow] duration-200 hover:border-line-strong hover:shadow-md focus-within:border-primary/50 motion-reduce:transition-none", archived && "opacity-80")}>
      <article aria-labelledby={titleId} className="flex flex-1 flex-col gap-3 p-5">
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 truncate text-[10.5px] font-semibold uppercase tracking-[.12em] text-muted">{industryLabel(b.industry)}{b.folderName ? ` · ${b.folderName}` : ""}</p>
          <div className="flex shrink-0 items-center gap-1.5">
            {b.featured && <span className="inline-flex items-center gap-1 rounded-full bg-inverse px-2 py-0.5 text-[10.5px] font-semibold text-bg"><Star className="size-3 fill-current" aria-hidden />Featured</span>}
            <SourceBadge source={b.source} />
          </div>
        </div>
        <div className="min-w-0">
          <h3 id={titleId} className="text-[18px] font-semibold leading-snug tracking-tight text-ink">
            <Link href={bpHref.detail(b.id)} className="rounded-sm outline-none hover:underline focus-visible:outline-2 focus-visible:outline-primary">{b.name}</Link>
          </h3>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
            <StatusBadge status={b.status} />
            <span className="tabular-nums">{b.currentVersion ? `Version ${b.currentVersion}` : "Never published"}</span>
            {b.hasUnpublishedChanges && b.currentVersion && <span className="font-medium text-warning-ink">· Unpublished changes</span>}
          </div>
        </div>
        <p className="line-clamp-2 text-[12.5px] leading-relaxed text-muted">{b.description || "No description yet."}</p>
        <ModuleChips modules={b.modules} max={5} />
        <div className="flex flex-wrap items-center gap-2">
          <CompatibilityBadge value={b.compatibility} notes={b.compatibilityNotes} />
          {b.compatibilityNotes[0] && <span className="text-[11.5px] text-muted">{b.compatibilityNotes.slice(0, 2).join(" · ")}</span>}
        </div>
        {forClient && appliedHere !== null && (
          <p className="text-[12px] font-medium text-success-ink">{forClient.name} has version {appliedHere}{update ? `; version ${b.currentVersion} is available to review` : ""}.</p>
        )}
        <p className="flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-muted">
          <span>{b.appliedTo ? `Applied to ${b.appliedTo} ${b.appliedTo === 1 ? "client" : "clients"}` : "Not applied yet"}</span>
          <span>{b.totalAssets} {b.totalAssets === 1 ? "asset" : "assets"}</span>
          <When iso={b.updatedAt} prefix="Updated" />
        </p>
        <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-line pt-4">
          <Button size="sm" variant="secondary" onClick={onPreview} aria-label={`Preview ${b.name}`}><Eye className="size-3.5" /> Preview</Button>
          {permissions.design && !archived && <ButtonLink href={bpHref.edit(b.id)} size="sm" variant="soft" aria-label={`Edit ${b.name}`}><Pencil className="size-3.5" /> Edit</ButtonLink>}
          {canApply && <ButtonLink href={applyHref} size="sm" variant="primary" aria-label={applyName}><Send className="size-3.5" /> {applyLabel}</ButtonLink>}
          {canPreview && <ButtonLink href={applyHref} size="sm" variant="soft" aria-label={`Preview applying ${b.name} to a client`}>Preview applying</ButtonLink>}
          <Menu>
            <MenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label={`More actions for ${b.name}`} className="ml-auto"><MoreHorizontal className="size-4" /></Button></MenuTrigger>
            <MenuContent align="end">
              <MenuItem asChild><Link href={bpHref.detail(b.id)}><Layers className="size-3.5" /> Open details</Link></MenuItem>
              {permissions.design && !archived && <MenuItem onSelect={onDuplicate}><Copy className="size-3.5" /> Duplicate</MenuItem>}
              {permissions.publish && !archived && <MenuItem onSelect={onPublish}><Rocket className="size-3.5" /> {b.currentVersion ? "Publish a new version" : "Publish"}</MenuItem>}
              {permissions.export && b.currentVersion && <MenuItem asChild><a href={bpHref.exportFile(b.id, b.currentVersion)} download><Download className="size-3.5" /> Export version {b.currentVersion}</a></MenuItem>}
              {permissions.design && !archived && <MenuItem onSelect={onMove}><FolderInput className="size-3.5" /> Move to folder</MenuItem>}
              {permissions.publish && !archived && <MenuItem onSelect={onFeature} disabled={busy(`feature-${b.id}`)}><Star className="size-3.5" /> {b.featured ? "Remove from featured" : "Feature"}</MenuItem>}
              {permissions.design && <MenuSeparator />}
              {permissions.design && !archived && <MenuItem destructive onSelect={onArchive}><Archive className="size-3.5" /> Archive</MenuItem>}
              {permissions.design && archived && <MenuItem onSelect={onRestore} disabled={busy(`restore-${b.id}`)}><ArchiveRestore className="size-3.5" /> Restore</MenuItem>}
            </MenuContent>
          </Menu>
        </div>
      </article>
    </Card>
  );
}

/** The quick look a card's Preview opens: what's inside, what each client must still do, and where to go next. */
function PreviewSheet({ b, permissions, applyHref, forClient, onClose }: {
  b: BlueprintSummary | null; permissions: BlueprintUiPermissions; applyHref: string; forClient: ClientOption | null; onClose: () => void;
}) {
  return (
    <Sheet open={Boolean(b)} onOpenChange={(o) => !o && onClose()} title={b?.name ?? "Blueprint"} description={b ? `${industryLabel(b.industry)} · ${BLUEPRINT_SOURCE_LABELS[b.source]}` : undefined}>
      {b && (
        <div className="space-y-5 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={b.status} />
            <Badge tone="outline">{b.currentVersion ? `Version ${b.currentVersion}` : "Never published"}</Badge>
            <CompatibilityBadge value={b.compatibility} notes={b.compatibilityNotes} />
          </div>
          {b.description && <p className="text-[13px] leading-relaxed text-ink-2">{b.description}</p>}
          <section aria-labelledby="bp-peek-modules">
            <h3 id="bp-peek-modules" className="mb-2 text-[13px] font-semibold text-ink">What&apos;s inside</h3>
            {b.modules.length ? (
              <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
                {b.modules.map((m) => <li key={m.section} className="flex items-center justify-between px-4 py-2 text-[13px]"><span className="text-ink-2">{m.label}</span><span className="font-semibold tabular-nums text-ink">{m.count}</span></li>)}
              </ul>
            ) : <p className="text-[13px] text-muted">No CRM assets yet.</p>}
          </section>
          <section aria-labelledby="bp-peek-compat">
            <h3 id="bp-peek-compat" className="mb-1 text-[13px] font-semibold text-ink">Compatibility</h3>
            <p className="text-[12.5px] leading-relaxed text-muted">{compatibilityHint(b.compatibility)}</p>
            {b.compatibilityNotes.length > 0 && <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[12.5px] text-ink-2">{b.compatibilityNotes.map((n) => <li key={n}>{n}</li>)}</ul>}
          </section>
          <section aria-labelledby="bp-peek-reqs">
            <h3 id="bp-peek-reqs" className="mb-2 text-[13px] font-semibold text-ink">Each client still has to</h3>
            <RequirementList keys={b.requirements} compact />
          </section>
          <p className="text-[12px] text-muted">{b.appliedTo ? `Live in ${b.appliedTo} client ${b.appliedTo === 1 ? "workspace" : "workspaces"}.` : "Not applied to any client yet."} <When iso={b.updatedAt} prefix="Updated" />.</p>
          <div className="flex flex-wrap gap-2 border-t border-line pt-4">
            <ButtonLink href={bpHref.detail(b.id)} variant="primary" size="sm">Open Blueprint</ButtonLink>
            {permissions.design && b.status !== "archived" && <ButtonLink href={bpHref.edit(b.id)} variant="secondary" size="sm"><Pencil className="size-3.5" /> Edit draft</ButtonLink>}
            {permissions.apply && b.status === "published" && forClient?.crmMode !== "ghl" && (
              <ButtonLink href={applyHref} variant="secondary" size="sm"><Send className="size-3.5" /> {forClient ? `Apply to ${forClient.name}` : "Apply to client"}</ButtonLink>
            )}
            {!permissions.apply && permissions.design && b.status === "published" && b.currentVersion !== null && forClient?.crmMode !== "ghl" && (
              <ButtonLink href={applyHref} variant="secondary" size="sm"><Eye className="size-3.5" /> Preview applying</ButtonLink>
            )}
          </div>
        </div>
      )}
    </Sheet>
  );
}
