"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangle, ArrowLeft, Check, CloudOff, ExternalLink, Layers, LayoutPanelLeft, Loader2, Monitor, Palette, Rocket, Save, Smartphone, SlidersHorizontal, Tablet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, Segmented } from "@/components/ui/overlays";
import { Badge } from "@/components/ui/primitives";
import { ImageLibrary } from "@/components/website/studio/image-library";
import { Inspector } from "@/components/website/studio/inspector";
import { LivePreview, type Device } from "@/components/website/studio/live-preview";
import { PublishDialog } from "@/components/website/studio/publish-dialog";
import { StructurePanel, type Selection } from "@/components/website/studio/structure-panel";
import { useStudioApi } from "@/components/website/studio/studio-api";
import { TemplatePicker } from "@/components/website/studio/template-picker";
import type { EditorEnv } from "@/components/website/studio/field-editors";
import { createDraftSaver, type DraftSaver, type SaverState } from "@/lib/website/draft-saver";
import { addPage, addSection, findSection, moveSection, movePage, removePage, removeSection, setSectionData, toggleSectionHidden, updatePage } from "@/lib/website/edit";
import type { SiteDetails } from "@/lib/website/generate";
import type { SiteContent } from "@/lib/website/schema";
import type { SectionType } from "@/lib/website/sections";
import { resolveTemplate } from "@/lib/website/templates";
import type { AssetView } from "@/server/assets/service";
import { cn } from "@/lib/utils";

export interface EditorSite {
  content: SiteContent;
  revision: number;
  templateKey: string;
  platformHost: string;
  liveHost: string | null;
  approval: "draft" | "submitted" | "approved" | "changes_requested";
  isLive: boolean;
}

type Panel = "structure" | "preview" | "edit";

function SaveStatus({ state }: { state: SaverState }) {
  const base = "inline-flex items-center gap-1.5 text-[12.5px]";
  if (state.status === "saving") return <span className={cn(base, "text-muted")} role="status"><Loader2 className="size-3.5 animate-spin" aria-hidden /> Saving…</span>;
  if (state.status === "dirty") return <span className={cn(base, "text-muted")} role="status">Unsaved changes</span>;
  if (state.status === "error")
    return <span className={cn(base, "text-warning-ink")} role="status"><CloudOff className="size-3.5" aria-hidden /> Not saved yet{state.error ? `: ${state.error}` : ""}</span>;
  if (state.status === "conflict") return <span className={cn(base, "text-danger-ink")} role="alert"><AlertTriangle className="size-3.5" aria-hidden /> Changed elsewhere</span>;
  if (state.status === "saved") return <span className={cn(base, "text-success-ink")} role="status"><Check className="size-3.5" aria-hidden /> Saved</span>;
  return <span className={cn(base, "text-muted")} role="status">All changes saved</span>;
}

/**
 * The editing workspace: outline on the left, the real site in the middle, the form for whatever is selected on the right.
 * Edits go into local state immediately and are saved to the draft by a serial autosaver that only says "Saved" once the
 * server has confirmed it. On narrow screens the three areas become three tabs.
 */
export function SiteEditor({
  site, initialAssets, details, industry, canPublish, year,
}: {
  site: EditorSite; initialAssets: AssetView[]; details: SiteDetails; industry: string; canPublish: boolean; year: number;
}) {
  const router = useRouter();
  const api = useStudioApi();
  const [content, setContent] = React.useState(site.content);
  const contentRef = React.useRef(site.content);
  const [templateKey, setTemplateKey] = React.useState(site.templateKey);
  const [assets, setAssets] = React.useState(initialAssets);
  const [pageSlug, setPageSlug] = React.useState("home");
  const [selection, setSelection] = React.useState<Selection>(null);
  const [device, setDevice] = React.useState<Device>("desktop");
  const [panel, setPanel] = React.useState<Panel>("preview");
  const [saver, setSaver] = React.useState<SaverState>({ status: "idle", error: null, revision: site.revision, savedAt: null });
  const [publishMode, setPublishMode] = React.useState<"publish" | "approval" | null>(null);
  const [picking, setPicking] = React.useState<{ current: string | null; apply: (id: string | null) => void } | null>(null);
  const [templates, setTemplates] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const saverRef = React.useRef<DraftSaver<SiteContent> | null>(null);
  // The saver tracks the revision itself from here on; a refreshed page must not replace it and drop queued edits.
  const startRevision = React.useRef(site.revision);

  React.useEffect(() => {
    const s = createDraftSaver<SiteContent>({
      revision: startRevision.current,
      onChange: setSaver,
      save: (c, revision) => api.saveDraft(c, revision),
    });
    saverRef.current = s;
    return () => {
      s.dispose();
      saverRef.current = null;
    };
  }, [api]);

  // Leaving with edits the server hasn't confirmed would lose them, so ask first.
  React.useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (saverRef.current?.hasUnsaved()) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  const apply = React.useCallback((fn: (c: SiteContent) => SiteContent) => {
    const next = fn(contentRef.current);
    if (next === contentRef.current) return;
    contentRef.current = next;
    setContent(next);
    saverRef.current?.queue(next);
  }, []);

  const flush = React.useCallback(async () => (saverRef.current ? saverRef.current.flush() : true), []);

  const page = content.pages.find((p) => p.slug === pageSlug) ?? content.pages[0];
  const resolved = resolveTemplate(templateKey);
  const env: EditorEnv = React.useMemo(
    () => ({
      assets,
      pages: content.pages.map((p) => ({ slug: p.slug, title: p.title })),
      pickImage: (current, applyId) => setPicking({ current, apply: applyId }),
    }),
    [assets, content.pages],
  );

  const businessName = content.business.name || details.businessName;
  const pickerDetails = React.useMemo(() => ({ ...details, businessName }), [details, businessName]);

  const select = (s: Selection) => {
    setSelection(s);
    if (s) setPanel("edit");
  };
  const onSelectSection = (id: string) => {
    setSelection({ kind: "section", id });
    setPanel("edit");
  };

  const addNewSection = (type: SectionType, afterId?: string) => {
    const res = addSection(contentRef.current, page.slug, type, afterId);
    if (!res) return void toast.error("That section can't be added to this page.");
    apply(() => res.content);
    setSelection({ kind: "section", id: res.id });
    setPanel("edit");
  };
  const addNewPage = (title: string) => {
    const res = addPage(contentRef.current, title);
    if (!res) return void toast.error("A website can have up to 12 pages.");
    apply(() => res.content);
    setPageSlug(res.slug);
    setSelection({ kind: "page" });
    setPanel("edit");
  };
  const deletePage = (slug: string) => {
    const next = removePage(contentRef.current, slug);
    if (!next) return;
    apply(() => next);
    if (pageSlug === slug) setPageSlug("home");
    setSelection(null);
  };
  const deleteSection = (id: string) => {
    apply((c) => removeSection(c, page.slug, id));
    if (selection?.kind === "section" && selection.id === id) setSelection(null);
  };

  const chooseTemplate = async (key: string) => {
    setBusy(true);
    if (!(await flush())) {
      setBusy(false);
      return void toast.error("Your latest changes haven't been saved yet. Wait for “Saved” and try again.");
    }
    const res = await api.changeTemplate(key, saverRef.current?.getState().revision ?? site.revision);
    setBusy(false);
    if (!res.ok) return void toast.error(res.error);
    saverRef.current?.reset(res.data.revision);
    setTemplateKey(key);
    setTemplates(false);
    toast.success("Style changed. All your words and images are kept.");
  };

  const saveVersion = async () => {
    if (!(await flush())) return void toast.error("Your latest changes haven't been saved yet.");
    const res = await api.saveVersion("");
    if (!res.ok) return void toast.error(res.error);
    toast.success(res.data.created ? `Saved as version ${res.data.version}.` : `Already saved as version ${res.data.version}.`);
  };

  const conflict = saver.status === "conflict";
  // A selected section may have been removed or replaced by a restore; treat a stale selection as none.
  const live: Selection = selection?.kind === "section" && !findSection(content, selection.id) ? null : selection;

  return (
    <div className="flex h-[calc(100dvh-8.5rem)] min-h-[560px] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-card" data-testid="site-editor">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-3 py-2.5 sm:px-4">
        <Link href="/website" className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] font-medium text-ink-2 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-primary" onClick={(e) => { if (saverRef.current?.hasUnsaved() && !window.confirm("Some changes haven't been saved yet. Leave anyway?")) e.preventDefault(); }}>
          <ArrowLeft className="size-4" aria-hidden /> Website
        </Link>
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="truncate text-[14.5px] font-semibold">Edit website</h1>
          <Badge tone="neutral">{resolved ? `${resolved.family.name} · ${resolved.variation.name}` : "Template"}</Badge>
          <SaveStatus state={saver} />
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="hidden md:block">
            <Segmented
              id="editor-device" ariaLabel="Preview width" value={device} onChange={setDevice}
              options={[
                { value: "desktop", label: <span className="inline-flex items-center gap-1.5"><Monitor className="size-3.5" aria-hidden /> Desktop</span> },
                { value: "tablet", label: <span className="inline-flex items-center gap-1.5"><Tablet className="size-3.5" aria-hidden /> Tablet</span> },
                { value: "mobile", label: <span className="inline-flex items-center gap-1.5"><Smartphone className="size-3.5" aria-hidden /> Phone</span> },
              ]}
            />
          </div>
          <Button type="button" variant="secondary" size="sm" onClick={() => setTemplates(true)} disabled={conflict}>
            <Palette className="size-3.5" /> Style
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => void saveVersion()} disabled={conflict}>
            <Save className="size-3.5" /> Save version
          </Button>
          <Button type="button" variant="brand" size="sm" onClick={() => setPublishMode(canPublish ? "publish" : "approval")} disabled={conflict}>
            <Rocket className="size-3.5" /> {canPublish ? "Publish" : "Send for approval"}
          </Button>
        </div>
      </header>

      {conflict && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 border-b border-danger/30 bg-danger-soft/60 px-4 py-3 text-[13.5px] text-danger-ink">
          <span>This website was changed in another window or by a teammate. To keep their work safe, saving has stopped, so edits you make now are not saved. Copy anything you want to keep, then reload to see the latest version.</span>
          <Button type="button" variant="danger" size="sm" onClick={() => window.location.reload()}>Reload the latest</Button>
        </div>
      )}

      <div className="border-b border-line px-3 py-2 xl:hidden">
        <Segmented
          id="editor-panel" ariaLabel="Editor area" value={panel} onChange={setPanel}
          options={[
            { value: "structure", label: <span className="inline-flex items-center gap-1.5"><Layers className="size-3.5" aria-hidden /> Pages</span> },
            { value: "preview", label: <span className="inline-flex items-center gap-1.5"><LayoutPanelLeft className="size-3.5" aria-hidden /> Preview</span> },
            { value: "edit", label: <span className="inline-flex items-center gap-1.5"><SlidersHorizontal className="size-3.5" aria-hidden /> Edit</span> },
          ]}
        />
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] xl:grid-cols-[280px_minmax(0,1fr)_380px]">
        <aside aria-label="Pages and sections" className={cn("min-h-0 border-line xl:block xl:border-r", panel === "structure" ? "block" : "hidden")}>
          <StructurePanel
            content={content} pageSlug={page.slug} selection={live} onSelect={select} onPage={setPageSlug}
            onMoveSection={(id, d) => apply((c) => moveSection(c, page.slug, id, d))} onToggleHidden={(id) => apply((c) => toggleSectionHidden(c, page.slug, id))}
            onRemoveSection={deleteSection} onAddSection={addNewSection} onAddPage={addNewPage}
            onMovePage={(slug, d) => apply((c) => movePage(c, slug, d))} onRemovePage={deletePage}
          />
        </aside>

        <section aria-label="Live preview" className={cn("scrollbar-thin min-h-0 min-w-0 overflow-auto bg-surface-3/60 p-3 sm:p-5 xl:block", panel === "preview" ? "block" : "hidden")}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 md:hidden">
            <Segmented
              id="editor-device-small" ariaLabel="Preview width" value={device} onChange={setDevice}
              options={[{ value: "desktop", label: "Desktop" }, { value: "tablet", label: "Tablet" }, { value: "mobile", label: "Phone" }]}
              size="sm"
            />
          </div>
          <LivePreview
            content={content} templateKey={templateKey} pageSlug={page.slug} assets={assets} device={device}
            selectedId={live?.kind === "section" ? live.id : null} year={year}
            onSelectSection={onSelectSection} onSelectSite={() => select({ kind: "site", group: "business" })} onNavigatePage={(slug) => { if (content.pages.some((p) => p.slug === slug)) setPageSlug(slug); }}
          />
          {site.isLive && site.liveHost && (
            <p className="mt-3 text-center text-[12.5px] text-muted">
              Your live site is at{" "}
              <a className="inline-flex items-center gap-1 font-medium text-primary-ink underline-offset-2 hover:underline" href={`https://${site.liveHost}`} target="_blank" rel="noopener noreferrer">
                {site.liveHost} <ExternalLink className="size-3" aria-hidden />
              </a>
              . Changes here stay private until you publish.
            </p>
          )}
        </section>

        <aside aria-label="Edit selected item" className={cn("scrollbar-thin min-h-0 overflow-y-auto border-line xl:block xl:border-l", panel === "edit" ? "block" : "hidden")}>
          <Inspector
            content={content} pageSlug={page.slug} selection={live} env={env} onSelect={select}
            onSection={(id, data) => apply((c) => setSectionData(c, page.slug, id, data))}
            onPage={(patch) => apply((c) => updatePage(c, page.slug, { title: String(patch.title ?? ""), navLabel: String(patch.navLabel ?? ""), showInNav: patch.showInNav === true, seoTitle: String(patch.seoTitle ?? ""), seoDescription: String(patch.seoDescription ?? "") }))}
            onSite={(next) => apply(() => next)}
          />
        </aside>
      </div>

      <ImageLibrary
        open={picking !== null} onClose={() => setPicking(null)} assets={assets} onAssetsChange={setAssets} current={picking?.current ?? null}
        onPick={(id) => { picking?.apply(id); setPicking(null); }}
      />

      <Dialog open={templates} onOpenChange={(o) => !busy && setTemplates(o)} title="Change the style" description="Your words, photos and colours stay exactly as they are. Only the look and layout change." size="xl">
        <TemplatePicker details={pickerDetails} industry={industry} current={templateKey} busy={busy} onChoose={(k) => void chooseTemplate(k)} chooseLabel="Use this style" />
      </Dialog>

      <PublishDialog
        open={publishMode !== null} onClose={() => setPublishMode(null)} mode={publishMode ?? (canPublish ? "publish" : "approval")} host={site.liveHost ?? site.platformHost} flush={flush}
        onDone={() => router.refresh()}
      />
    </div>
  );
}
