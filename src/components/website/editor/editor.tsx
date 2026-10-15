"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertCircle, ArrowLeft, Check, CheckCircle2, Cloud, FileText, History, Image as ImageIcon, Keyboard, Layers, Loader2, Monitor, Palette, Plus, Redo2, Save, Settings2, Smartphone, Tablet, Undo2, Eye, Send, Globe,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/overlays";
import { PublishDialog } from "@/components/website/studio/publish-dialog";
import { StudioApiProvider, createServerStudioApi, serverStudioApi, type SavedComponent, type StudioApi } from "@/components/website/studio/studio-api";
import { createDraftSaver, type DraftSaver, type SaverState } from "@/lib/website/draft-saver";
import { collectIds, findPage, isRef, referencedAssetIds, type ImageSrc, type Section, type SiteContent } from "@/lib/website/doc";
import { buildLayout, buildPreset, LAYOUT_PRESETS, newElement, SECTION_PRESETS } from "@/lib/website/editor/library";
import { canRedo, canUndo, DEVICES, initialState, reducer, type Device } from "@/lib/website/editor/state";
import {
  canInsertElement, cloneWithNewIds, describeNode, detachShared, duplicateNode, findNode, getElement, getSection, insertElement, insertSection, makeShared, moveNode, nudge, nudgeAcross, removeNode, updateSection,
} from "@/lib/website/ops";
import { cn } from "@/lib/utils";
import type { AssetView } from "@/server/assets/service";
import { Canvas, pageItemFor, type CanvasActions } from "./canvas";
import { IconButton, SelectControl } from "./controls";
import { EditorServicesContext, type EditorServices } from "./context";
import { CommentsPanel } from "./comments-panel";
import { AssistantPanel } from "./assistant-panel";
import { TemplateUpdateCard } from "./template-update-card";
import { CheckpointDialog, ConflictDialog, PreviewOverlay, SaveComponentDialog, ShortcutsDialog, VersionsDialog } from "./dialogs";
import { DragProvider, useDrag, type DragSource, type DropTarget } from "./drag";
import { Inspector } from "./inspector";
import { AddPanel, type SavedSection } from "./panel-add";
import { MediaLibrary, MediaPickerDialog } from "./panel-media";
import { DesignPanel, SettingsPanel } from "./panel-site";
import { LayersPanel, PagesPanel } from "./panel-structure";

export interface EditorSite {
  name: string;
  content: SiteContent;
  revision: number;
  templateKey: string;
  platformHost: string;
  liveHost: string | null;
  approval: "draft" | "submitted" | "approved" | "changes_requested";
  isLive: boolean;
  hasUnpublishedChanges?: boolean;
  /** Set when an agency user edits a client's site. */
  orgId?: string;
  clientName?: string;
}

export interface SiteEditorProps {
  site: EditorSite;
  initialAssets: AssetView[];
  canPublish: boolean;
  canApprove?: boolean;
  canUpload: boolean;
  /** Agency designers see a few extra controls. */
  agency?: boolean;
  backHref: string;
  api?: StudioApi;
  initialSaved?: SavedSection[];
  /** A notice shown above the editor, for example in the development preview. */
  notice?: string;
  /** The assistant tab. On unless turned off; `ai` says whether an AI provider is connected (the built-in assistant works either way). */
  assistant?: false | { ai: boolean };
  /** Editing a template in the agency's library rather than a client's website. */
  mode?: "site" | "template";
}

type LeftTab = "pages" | "add" | "layers" | "media" | "design" | "settings";
const LEFT_TABS: Array<{ id: LeftTab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: "pages", label: "Pages", icon: FileText }, { id: "add", label: "Add", icon: Plus }, { id: "layers", label: "Layers", icon: Layers },
  { id: "media", label: "Media", icon: ImageIcon }, { id: "design", label: "Design", icon: Palette }, { id: "settings", label: "Settings", icon: Settings2 },
];
const DEVICE_ICON: Record<Device, React.ComponentType<{ className?: string }>> = { desktop: Monitor, tablet: Tablet, mobile: Smartphone };

export function SiteEditor(props: SiteEditorProps) {
  const orgId = props.site.orgId;
  const api = React.useMemo(() => props.api ?? (orgId ? createServerStudioApi(orgId) : serverStudioApi), [props.api, orgId]);
  return (
    <StudioApiProvider value={api}>
      <DragProvider onAnnounce={(m) => toast(m)}>
        <EditorInner {...props} api={api} />
      </DragProvider>
    </StudioApiProvider>
  );
}

function EditorInner({ site, initialAssets, canPublish, canUpload, agency, backHref, api, initialSaved, notice, assistant, mode = "site" }: SiteEditorProps & { api: StudioApi }) {
  const router = useRouter();
  const drag = useDrag();
  const [ed, dispatch] = React.useReducer(reducer, site.content, (c) => initialState(c));
  const docRef = React.useRef(ed.doc);
  const [assets, setAssets] = React.useState(initialAssets);
  const [saved, setSaved] = React.useState<SavedSection[]>(initialSaved ?? []);
  const [leftTab, setLeftTab] = React.useState<LeftTab>("pages");
  const [addSub, setAddSub] = React.useState<"sections" | "layouts" | "elements" | "saved">("sections");
  const [zoom, setZoom] = React.useState<"fit" | number>("fit");
  const [scale, setScale] = React.useState(1);
  const [live, setLive] = React.useState("");
  const [preview, setPreview] = React.useState(false);
  const [versions, setVersions] = React.useState(false);
  const [checkpoint, setCheckpoint] = React.useState(false);
  const [shortcuts, setShortcuts] = React.useState(false);
  const [publishMode, setPublishMode] = React.useState<null | "publish" | "approval">(null);
  const [approval, setApproval] = React.useState(site.approval);
  const [isLive, setIsLive] = React.useState(site.isLive);
  const [baseUnpublished, setBaseUnpublished] = React.useState(site.hasUnpublishedChanges === true);
  const [publishedRev, setPublishedRev] = React.useState(0);
  const [componentFor, setComponentFor] = React.useState<string | null>(null);
  const [picker, setPicker] = React.useState<{ current: ImageSrc; onPick: (s: ImageSrc) => void; title?: string } | null>(null);
  const [insertAfter, setInsertAfter] = React.useState<string | null>(null);
  const [reveal, setReveal] = React.useState<{ id: string; n: number } | null>(null);
  const [closeEdit, setCloseEdit] = React.useState(0);
  const [conflictBusy, setConflictBusy] = React.useState(false);
  const [saverState, setSaverState] = React.useState<SaverState>({ status: "idle", error: null, revision: site.revision, savedAt: null });
  const [narrow, setNarrow] = React.useState(false);
  // Who else is in the editor. Not being able to take the lock puts this window in view-only mode, until the person takes over.
  const [lock, setLock] = React.useState<{ other: boolean; by: string }>({ other: false, by: "" });
  const lockOn = Boolean(api.acquireLock);
  const readOnly = lockOn && lock.other;
  const readOnlyRef = React.useRef(readOnly);
  React.useLayoutEffect(() => {
    readOnlyRef.current = readOnly;
  }, [readOnly]);
  const takeLock = React.useCallback(async (takeOver: boolean) => {
    const r = await api.acquireLock?.(takeOver);
    if (r) setLock(r.ok && r.data.held ? { other: false, by: "" } : { other: true, by: r.ok ? r.data.by ?? "Someone else" : "Someone else" });
  }, [api]);
  React.useEffect(() => {
    if (!api.acquireLock) return;
    const first = window.setTimeout(() => void takeLock(false), 0);
    const timer = window.setInterval(() => void takeLock(false), 45_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
      void api.releaseLock?.();
    };
  }, [api, takeLock]);

  const announce = React.useCallback((m: string) => {
    setLive("");
    window.setTimeout(() => setLive(m), 20);
  }, []);

  // --- Saving --------------------------------------------------------------
  const [saver] = React.useState<DraftSaver<SiteContent>>(() =>
    createDraftSaver<SiteContent>({
      revision: site.revision,
      save: async (content, revision) => {
        const res = await api.saveDraft(content, revision);
        if (res.ok && (res as { approvalReset?: boolean }).approvalReset) {
          setApproval("draft");
          toast("Your edits were saved, and the earlier approval no longer applies. Send the site for approval again when you're ready.");
        }
        return res;
      },
      onChange: setSaverState,
    }),
  );
  const skipSave = React.useRef(true);
  React.useEffect(() => {
    if (skipSave.current) {
      skipSave.current = false;
      return;
    }
    if (ed.rev === 0) return;
    saver.queue(ed.doc);
    // `ed.doc` changes exactly when `ed.rev` does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ed.rev]);
  React.useEffect(() => () => saver.dispose(), [saver]);
  React.useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (saver.hasUnsaved()) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [saver]);
  React.useEffect(() => {
    const mq = window.matchMedia("(max-width: 1023px)");
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  // --- Actions -------------------------------------------------------------
  const commit: CanvasActions["commit"] = React.useCallback((doc, o) => {
    if (readOnlyRef.current) return;
    dispatch({ type: "commit", doc, coalesce: o?.coalesce, select: o?.select, page: o?.page });
  }, []);
  const select = React.useCallback((id: string | null) => dispatch({ type: "select", id }), []);
  const doUndo = React.useCallback(() => { setCloseEdit((n) => n + 1); dispatch({ type: "undo" }); }, []);
  const doRedo = React.useCallback(() => { setCloseEdit((n) => n + 1); dispatch({ type: "redo" }); }, []);
  const page = ed.doc.pages.find((p) => p.id === ed.pageId) ?? ed.doc.pages[0];
  const unpublished = baseUnpublished || ed.rev > publishedRev;
  // Handlers read the latest document, page and selection through refs, which are brought up to date right after each render.
  const pageSlugRef = React.useRef(page.slug);
  const selRef = React.useRef(ed.selection);
  React.useLayoutEffect(() => {
    docRef.current = ed.doc;
    pageSlugRef.current = page.slug;
    selRef.current = ed.selection;
  }, [ed.doc, page.slug, ed.selection]);

  const withReveal = (id: string) => setReveal((r) => ({ id, n: (r?.n ?? 0) + 1 }));

  const actions: CanvasActions = React.useMemo(() => ({
    select,
    commit,
    nudge: (id, delta) => {
      const d = docRef.current;
      const next = nudge(d, id, delta);
      if (next === d) return announce("It can't move any further that way.");
      commit(next);
      announce(`Moved ${describeNode(next, id)} ${delta < 0 ? "earlier" : "later"}.`);
      withReveal(id);
    },
    nudgeAcross: (id, delta) => {
      const d = docRef.current;
      const next = nudgeAcross(d, id, delta);
      if (next === d) return announce("There is nowhere to move it in that direction.");
      commit(next);
      announce(`Moved ${describeNode(next, id)} into a different container.`);
      withReveal(id);
    },
    duplicate: (id) => {
      const r = duplicateNode(docRef.current, id);
      if (!r) return announce("That can't be duplicated.");
      commit(r.doc, { select: r.id });
      announce("Duplicated.");
      withReveal(r.id);
    },
    remove: (id) => {
      const d = docRef.current;
      const label = describeNode(d, id);
      const next = removeNode(d, id);
      if (next === d) return announce("That can't be removed.");
      commit(next, { select: null });
      announce(`Removed ${label}.`);
      toast(`Removed ${label}`, { action: { label: "Undo", onClick: () => doUndo() }, duration: 6000 });
    },
    toggleHidden: (id) => {
      const d = docRef.current;
      const sec = getSection(d, id);
      if (!sec) return;
      commit(updateSection(d, id, (s) => ({ ...s, hidden: !s.hidden })));
      announce(sec.hidden ? "Section is visible again." : "Section is hidden from visitors.");
    },
    addBelow: (id) => {
      setInsertAfter(id);
      setLeftTab("add");
      setAddSub("sections");
      announce("Choose a section to add below.");
    },
    selectParent: (id) => {
      const n = findNode(docRef.current, id);
      if (!n) return;
      if (n.parentId && findNode(docRef.current, n.parentId)?.kind !== "page") select(n.parentId);
      else select(null);
    },
    makeShared: (id) => {
      const r = makeShared(docRef.current, id);
      if (!r) return toast.error("That section can't be shared.");
      commit(r.doc);
      toast.success("This section is now shared: editing it changes it on every page that uses it.");
    },
    detachShared: (id) => {
      commit(detachShared(docRef.current, id));
      toast.success("This page now has its own copy.");
    },
    saveAsComponent: (id) => setComponentFor(id),
    announce,
  }), [select, commit, announce, doUndo]);

  // --- Insertion -----------------------------------------------------------
  const build = React.useCallback((d: SiteContent, source: DragSource): { kind: "section"; section: Section; place: "page" | "header" | "footer" } | { kind: "element"; el: ReturnType<typeof newElement> } | null => {
    if (source.kind === "section-preset") {
      const p = SECTION_PRESETS.find((x) => x.id === source.presetId);
      const s = p ? buildPreset(d, p) : null;
      return s && p ? { kind: "section", section: s, place: p.place } : null;
    }
    if (source.kind === "layout") {
      const l = LAYOUT_PRESETS.find((x) => x.id === source.layoutId);
      return l ? { kind: "section", section: buildLayout(d, l), place: "page" } : null;
    }
    if (source.kind === "saved") {
      const s = saved.find((x) => x.id === source.savedId);
      return s ? { kind: "section", section: cloneWithNewIds(s.section, new Set(collectIds(d))), place: "page" } : null;
    }
    if (source.kind === "element") return { kind: "element", el: newElement(d, source.type) };
    return null;
  }, [saved]);

  /** The section the current selection lives in, as an item on the current page. */
  const selectedSectionItem = React.useCallback((): string | null => {
    const d = docRef.current;
    const sel = selRef.current;
    if (!sel) return null;
    const n = findNode(d, sel);
    if (!n) return null;
    if (n.kind === "ref") return n.id;
    const secId = n.kind === "section" ? n.id : n.sectionId;
    if (!secId) return null;
    const item = pageItemFor(d, pageSlugRef.current, secId);
    return d.pages.find((p) => p.slug === pageSlugRef.current)?.items.some((i) => i.id === item) ? item : null;
  }, []);

  const insertSource = React.useCallback((source: DragSource, target?: DropTarget) => {
    const d = docRef.current;
    const pg = findPage(d, pageSlugRef.current)!;
    const built = build(d, source);
    if (!built) return void toast.error("That can't be added.");
    if (built.kind === "section") {
      if (built.place === "header" || built.place === "footer") {
        commit({ ...d, [built.place]: built.section }, { select: built.section.id });
        toast.success(`${built.place === "header" ? "Header" : "Footer"} replaced. It now appears on every page.`);
        return;
      }
      let index: number;
      if (target) index = target.index;
      else {
        const after = insertAfter ?? selectedSectionItem();
        const at = after ? pg.items.findIndex((i) => i.id === after) : -1;
        index = at >= 0 ? at + 1 : pg.items.length;
      }
      commit(insertSection(d, pg.id, index, built.section), { select: built.section.id });
      announce(`Added ${source.label}.`);
      setInsertAfter(null);
      withReveal(built.section.id);
      return;
    }
    // An element needs a column or card to go in.
    let parentId: string | null = target?.parentId ?? null;
    let index = target?.index ?? 0;
    if (!parentId) {
      const sel = selRef.current ? findNode(d, selRef.current) : null;
      const lastSection = [...pg.items].reverse().map((i) => (isRef(i) ? null : i)).find((s): s is Section => Boolean(s));
      if (sel?.kind === "column") {
        parentId = sel.id;
        index = Infinity;
      } else if (sel?.kind === "element") {
        const isContainer = ["group", "card"].includes(getElement(d, sel.id)?.type ?? "");
        if (isContainer) {
          parentId = sel.id;
          index = Infinity;
        } else {
          parentId = sel.parentId;
          index = sel.index + 1;
        }
      } else if (sel?.kind === "section") {
        parentId = getSection(d, sel.id)?.columns[0]?.id ?? null;
        index = Infinity;
      } else if (lastSection) {
        parentId = lastSection.columns[0]?.id ?? null;
        index = Infinity;
      }
    }
    if (!parentId) return void toast.error("Add a section first, then drop elements into it.");
    const check = canInsertElement(d, source.kind === "element" ? source.type : "text", parentId);
    if (!check.ok) return void toast.error(check.reason);
    const el = (built as { el: ReturnType<typeof newElement> }).el;
    commit(insertElement(d, parentId, Number.isFinite(index) ? index : 9999, el), { select: el.id });
    announce(`Added ${source.label}.`);
    withReveal(el.id);
  }, [build, commit, announce, insertAfter, selectedSectionItem]);

  // Dropping a dragged item: either move what's there, or add what came from the library.
  React.useEffect(() => {
    drag.setDropper((source, target) => {
      const d = docRef.current;
      if (source.kind === "node") {
        const next = moveNode(d, source.id, target.parentId, target.index);
        if (next === d) return announce("That didn't move anywhere new.");
        commit(next, { select: source.id });
        announce(`Moved ${source.label}.`);
        withReveal(source.id);
        return;
      }
      insertSource(source, target);
    });
    return () => drag.setDropper(null);
  }, [drag, commit, insertSource, announce]);

  // --- Assets --------------------------------------------------------------
  const assetMap = React.useMemo(() => new Map(assets.map((a) => [a.id.toLowerCase(), a])), [assets]);
  const resolveAsset = React.useCallback((id: string | null | undefined, variant?: "original" | "processed") => {
    if (!id) return null;
    const a = assetMap.get(id.toLowerCase());
    if (!a) return null;
    const useProcessed = variant === "processed" || (docRef.current.brand.logoAssetId?.toLowerCase() === a.id.toLowerCase() && docRef.current.brand.logoVariant === "processed" && a.hasProcessed);
    return { src: `${api.assetUrl(a.id)}${useProcessed ? `${api.assetUrl(a.id).includes("?") ? "&" : "?"}variant=processed` : ""}`, width: a.width, height: a.height, alt: a.altText };
  }, [assetMap, api]);
  const usedIds = React.useMemo(() => new Set(referencedAssetIds(ed.doc)), [ed.doc]);

  const services: EditorServices = React.useMemo(() => ({
    design: ed.doc.design, business: { phone: ed.doc.business.phone, email: ed.doc.business.email },
    pages: ed.doc.pages.map((p) => ({ id: p.id, slug: p.slug, title: p.title })), assets, assetUrl: api.assetUrl, device: ed.device, canUpload,
    openMedia: (o) => setPicker(o),
  }), [ed.doc.design, ed.doc.business.phone, ed.doc.business.email, ed.doc.pages, assets, api, ed.device, canUpload]);

  // --- Saving, versions, publishing ---------------------------------------
  const flush = React.useCallback(() => saver.flush(), [saver]);
  const saveNow = React.useCallback(async () => {
    const ok = await flush();
    if (ok) toast.success("All changes saved.");
    else toast.error("Your changes couldn't be saved yet. We'll keep trying.");
  }, [flush]);
  const saveCheckpoint = React.useCallback(async (note: string, source: "checkpoint" | "ai" = "checkpoint") => {
    if (!(await flush())) { toast.error("Wait for your changes to be saved, then try again."); return false; }
    const res = await api.saveVersion(note, source);
    if (!res.ok) { toast.error(res.error); return false; }
    toast.success(res.data.created ? `Saved as version ${res.data.version}.` : `Nothing has changed since version ${res.data.version}.`);
    return true;
  }, [api, flush]);
  const adoptRemote = React.useCallback((content: SiteContent, revision: number) => {
    skipSave.current = true;
    saver.reset(revision);
    dispatch({ type: "reset", doc: content });
    setCloseEdit((n) => n + 1);
  }, [saver]);
  const reloadLatest = async () => {
    setConflictBusy(true);
    const r = await api.getDraft();
    setConflictBusy(false);
    if (!r.ok) return void toast.error(r.error);
    adoptRemote(r.data.content, r.data.revision);
    toast.success("Loaded the latest saved version.");
  };
  const keepMine = async () => {
    setConflictBusy(true);
    const r = await api.getDraft();
    if (!r.ok) { setConflictBusy(false); return void toast.error(r.error); }
    saver.reset(r.data.revision);
    saver.queue(docRef.current);
    const ok = await saver.flush();
    setConflictBusy(false);
    if (ok) toast.success("Your version is saved.");
  };

  const saveComponent = async (name: string, scope: "site" | "agency") => {
    const id = componentFor;
    const sec = id ? getSection(docRef.current, id) : null;
    if (!sec) return false;
    if (api.saveComponent) {
      const res = await api.saveComponent(name, sec, scope);
      if (!res.ok) { toast.error(res.error); return false; }
      setSaved((s) => [res.data as SavedComponent, ...s]);
    } else setSaved((s) => [{ id: `local-${Date.now().toString(36)}`, name, scope: "site", section: structuredClone(sec) }, ...s]);
    toast.success(`Saved “${name}”. Find it under Add → Saved.`);
    return true;
  };

  const deleteSaved = async (s: SavedSection) => {
    const res = await api.deleteComponent?.(s.id);
    if (!res?.ok) return void toast.error(res?.error ?? "That couldn't be removed.");
    setSaved((list) => list.filter((x) => x.id !== s.id));
    toast.success(`Removed “${s.name}” from your saved sections.`);
  };

  /** Goes to an element on whichever page it lives, and selects it. */
  const jumpTo = React.useCallback((id: string) => {
    const n = findNode(docRef.current, id);
    if (!n) return;
    const home = n.home;
    if (home?.type === "page") dispatch({ type: "page", id: home.pageId });
    select(id);
    withReveal(id);
  }, [select]);

  // --- Keyboard ------------------------------------------------------------
  React.useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as Element | null;
      const typing = Boolean(t?.closest?.("input, textarea, select, [contenteditable]"));
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); void saveNow(); return; }
      if (typing) return;
      if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); }
      else if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); doRedo(); }
      else if (e.key === "?") { e.preventDefault(); setShortcuts(true); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [saveNow, doUndo, doRedo]);

  // --- Derived -------------------------------------------------------------
  const lifecycle = approval === "submitted" ? { label: "Waiting for approval", tone: "warn" } : approval === "changes_requested" ? { label: "Changes requested", tone: "warn" } : approval === "approved" ? { label: "Approved", tone: "ok" } : { label: "Draft", tone: "idle" };
  const liveLabel = isLive ? (unpublished ? "Live · unpublished changes" : "Live") : "Not live";
  const hostLabel = site.liveHost ?? site.platformHost;
  const conflict = saverState.status === "conflict";

  return (
    <EditorServicesContext.Provider value={services}>
      <div className="fixed inset-0 z-40 flex flex-col bg-bg text-ink" data-studio="">
        {notice && <p className="border-b border-warning/20 bg-warning-soft px-4 py-1.5 text-center text-[11.5px] font-medium text-warning-ink">{notice}</p>}
        {/* Toolbar */}
        <header className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-surface px-3 py-1.5">
          <Link href={backHref} onClick={async (e) => { e.preventDefault(); await flush(); router.push(backHref); }} className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12.5px] font-medium text-muted hover:bg-surface-2 hover:text-ink"><ArrowLeft className="size-4" aria-hidden /> <span className="hidden sm:inline">Exit</span></Link>
          <div className="min-w-0">
            <p className="max-w-[14rem] truncate text-[13px] font-semibold leading-tight">{site.name}</p>
            <p className="max-w-[14rem] truncate text-[10.5px] leading-tight text-muted">{site.clientName ? `${site.clientName} · ` : ""}{lifecycle.label} · {liveLabel}</p>
          </div>
          <div className="w-44 shrink-0"><SelectControl<string> label="Page" value={page.id} onChange={(id) => dispatch({ type: "page", id })} options={ed.doc.pages.map((p) => ({ value: p.id, label: p.title }))} /></div>
          <span className="flex-1" />
          <div role="radiogroup" aria-label="Preview size" className="flex rounded-lg bg-surface-3 p-0.5">
            {DEVICES.map((d) => {
              const I = DEVICE_ICON[d.id];
              return (
                <Tooltip key={d.id} content={`${d.label} · ${d.width}px`}>
                  <button type="button" role="radio" aria-checked={ed.device === d.id} aria-label={`${d.label} (${d.width}px)`} onClick={() => dispatch({ type: "device", device: d.id })} className={cn("flex h-7 w-9 items-center justify-center rounded-md transition-colors", ed.device === d.id ? "bg-surface text-primary-ink shadow-soft" : "text-muted hover:text-ink")}><I className="size-4" /></button>
                </Tooltip>
              );
            })}
          </div>
          <div className="hidden items-center gap-1 md:flex">
            <SelectControl<string> label="Zoom" value={zoom === "fit" ? "fit" : String(zoom)} onChange={(v) => setZoom(v === "fit" ? "fit" : Number(v))} options={[{ value: "fit", label: `Fit · ${Math.round(scale * 100)}%` }, { value: "1", label: "100%" }, { value: "0.75", label: "75%" }, { value: "0.5", label: "50%" }]} />
          </div>
          <span className="flex-1" />
          <IconButton label="Undo (Ctrl+Z)" onClick={doUndo} disabled={!canUndo(ed)}><Undo2 className="size-4" /></IconButton>
          <IconButton label="Redo (Ctrl+Shift+Z)" onClick={doRedo} disabled={!canRedo(ed)}><Redo2 className="size-4" /></IconButton>
          <SaveStatus state={saverState} onRetry={() => void saver.flush()} onResolve={() => undefined} />
          {mode === "site" && <Button size="sm" variant="secondary" className="!h-8 !px-2.5 !text-[12.5px]" onClick={() => setCheckpoint(true)} disabled={readOnly}><Save className="size-3.5" /> <span className="hidden lg:inline">Save version</span></Button>}
          <IconButton label="Version history" onClick={() => setVersions(true)}><History className="size-4" /></IconButton>
          <IconButton label="Keyboard shortcuts" onClick={() => setShortcuts(true)}><Keyboard className="size-4" /></IconButton>
          <Button size="sm" variant="secondary" className="!h-8 !px-2.5 !text-[12.5px]" onClick={async () => { await flush(); setPreview(true); }}><Eye className="size-3.5" /> Preview</Button>
          {canPublish ? (
            <Button size="sm" variant="brand" className="!h-8 !px-3 !text-[12.5px]" onClick={() => setPublishMode("publish")} disabled={readOnly}><Globe className="size-3.5" /> {mode === "template" ? "Publish template" : "Publish"}</Button>
          ) : (
            <Button size="sm" variant="brand" className="!h-8 !px-3 !text-[12.5px]" onClick={() => setPublishMode("approval")} disabled={readOnly}><Send className="size-3.5" /> {mode === "template" ? "Send for review" : "Send for approval"}</Button>
          )}
        </header>

        {readOnly && (
          <div role="status" className="flex flex-wrap items-center justify-between gap-3 border-b border-warning/30 bg-warning-soft px-4 py-2 text-[12.5px] text-warning-ink">
            <span><strong className="font-semibold">{lock.by}</strong> is editing this website right now. You can look around, but changes are switched off so nothing is overwritten.</span>
            <button type="button" onClick={() => void takeLock(true)} className="font-semibold underline">Take over editing</button>
          </div>
        )}
        {narrow && <p className="border-b border-line bg-primary-soft px-4 py-1.5 text-[11.5px] text-primary-ink">The visual editor works best on a laptop or larger screen. You can still edit here, but the panels are tight.</p>}

        <div className="flex min-h-0 flex-1">
          {/* Left rail + panel */}
          <nav aria-label="Editor tools" className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-line bg-surface py-2">
            {LEFT_TABS.map((t) => (
              <Tooltip key={t.id} content={t.label} side="right">
                <button type="button" aria-label={t.label} aria-pressed={leftTab === t.id} onClick={() => setLeftTab(t.id)} className={cn("flex h-11 w-11 flex-col items-center justify-center gap-0.5 rounded-xl text-[9.5px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-primary", leftTab === t.id ? "bg-primary-soft text-primary-ink" : "text-muted hover:bg-surface-2 hover:text-ink")}>
                  <t.icon className="size-[18px]" aria-hidden />{t.label}
                </button>
              </Tooltip>
            ))}
          </nav>
          <aside aria-label={`${LEFT_TABS.find((t) => t.id === leftTab)!.label} panel`} className={cn("flex min-h-0 shrink-0 flex-col border-r border-line bg-surface", narrow ? "w-60" : "w-[18.5rem]")}>
            {leftTab === "pages" && <PagesPanel doc={ed.doc} pageId={ed.pageId} setPage={(id) => dispatch({ type: "page", id })} commit={commit} announce={announce} />}
            {leftTab === "add" && <AddPanel key={addSub + String(insertAfter)} doc={ed.doc} initialSub={addSub} onInsert={(s) => insertSource(s)} saved={saved} canSave onDeleteSaved={api.deleteComponent && !readOnly ? (s) => void deleteSaved(s) : undefined} canDeleteShared={agency === true} />}
            {leftTab === "layers" && <LayersPanel doc={ed.doc} pageId={ed.pageId} selection={ed.selection} actions={actions} />}
            {leftTab === "media" && <MediaLibrary assets={assets} onAssetsChange={setAssets} usedIds={usedIds} />}
            {leftTab === "design" && <div className="min-h-0 flex-1 overflow-y-auto">{mode === "site" && <TemplateUpdateCard doc={ed.doc} commit={(d) => commit(d)} checkpoint={(note) => saveCheckpoint(note, "checkpoint")} readOnly={readOnly} />}<DesignPanel doc={ed.doc} commit={commit} /></div>}
            {leftTab === "settings" && <div className="min-h-0 flex-1 overflow-y-auto"><SettingsPanel doc={ed.doc} commit={commit} /></div>}
          </aside>

          {/* Canvas */}
          <main className="flex min-w-0 flex-1 flex-col">
            {insertAfter && (
              <div className="flex items-center justify-between gap-3 border-b border-primary/20 bg-primary-soft px-4 py-1.5 text-[12px] text-primary-ink">
                <span>Adding below <strong>{describeNode(ed.doc, insertAfter)}</strong>. Pick a section from the Add panel.</span>
                <button type="button" onClick={() => setInsertAfter(null)} className="font-medium underline">Cancel</button>
              </div>
            )}
            <Canvas doc={ed.doc} pageSlug={page.slug} device={ed.device} zoom={zoom} selection={ed.selection} resolveAsset={resolveAsset} actions={actions} onScale={setScale} closeEditSignal={closeEdit} reveal={reveal} readOnly={readOnly} />
          </main>

          {/* Right panel */}
          <aside aria-label="Settings for the selected item" className={cn("flex min-h-0 shrink-0 flex-col border-l border-line bg-surface", narrow ? "w-64" : "w-80")}>
            <RightTabs
              tabs={[
                { id: "edit", label: "Edit", node: <Inspector doc={ed.doc} selection={ed.selection} pageId={ed.pageId} device={ed.device} actions={actions} advanced={agency === true} /> },
                ...(api.listComments ? [{ id: "comments", label: "Comments", node: <CommentsPanel doc={ed.doc} selection={ed.selection} pageSlug={page.slug} active onJump={jumpTo} /> }] : []),
                ...(assistant !== false ? [{ id: "assistant", label: "Assistant", node: <AssistantPanel doc={ed.doc} pageId={ed.pageId} pageSlug={page.slug} selection={ed.selection} commit={(d) => commit(d)} undo={doUndo} checkpoint={(note) => saveCheckpoint(note, "ai")} ai={assistant?.ai === true} readOnly={readOnly} /> }] : []),
              ]}
            />
          </aside>
        </div>

        <div className="sr-only" role="status" aria-live="polite">{live}</div>

        <MediaPickerDialog open={picker !== null} onOpenChange={(o) => !o && setPicker(null)} current={picker?.current ?? null} onPick={(s) => picker?.onPick(s)} assets={assets} onAssetsChange={setAssets} usedIds={usedIds} title={picker?.title} />
        <CheckpointDialog open={checkpoint} onOpenChange={setCheckpoint} onSave={saveCheckpoint} />
        <VersionsDialog open={versions} onOpenChange={setVersions} currentDoc={ed.doc} revision={saverState.revision} resolveAsset={resolveAsset} onRestored={adoptRemote} canEdit flush={flush} />
        <ShortcutsDialog open={shortcuts} onOpenChange={setShortcuts} />
        <ConflictDialog open={conflict} onReload={() => void reloadLatest()} onKeepMine={() => void keepMine()} busy={conflictBusy} />
        <SaveComponentDialog open={componentFor !== null} onOpenChange={(o) => !o && setComponentFor(null)} defaultName={componentFor ? describeNode(ed.doc, componentFor) : "Section"} onSave={saveComponent} canShareWithAgency={agency === true} />
        {publishMode && (
          <PublishDialog open onClose={() => setPublishMode(null)} mode={publishMode} host={hostLabel} flush={flush} noun={mode === "template" ? "template" : "website"}
            onDone={() => { if (publishMode === "publish") { setIsLive(true); setBaseUnpublished(false); setPublishedRev(ed.rev); } else setApproval("submitted"); router.refresh(); }} />
        )}
        {preview && <PreviewOverlay doc={ed.doc} resolveAsset={resolveAsset} initialPage={page.slug} onClose={() => setPreview(false)} />}
      </div>
    </EditorServicesContext.Provider>
  );
}

function RightTabs({ tabs }: { tabs: Array<{ id: string; label: string; node: React.ReactNode }> }) {
  const [tab, setTab] = React.useState(tabs[0].id);
  if (tabs.length === 1) return <>{tabs[0].node}</>;
  return (
    <>
      <div className="flex border-b border-line p-1.5" role="tablist" aria-label="Right panel">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={cn("h-7 flex-1 rounded-md text-[12px] font-medium", tab === t.id ? "bg-primary-soft text-primary-ink" : "text-muted hover:text-ink")}>{t.label}</button>
        ))}
      </div>
      {tabs.map((t) => <div key={t.id} role="tabpanel" className={cn("min-h-0 flex-1 flex-col", tab === t.id ? "flex" : "hidden")}>{t.node}</div>)}
    </>
  );
}

function SaveStatus({ state, onRetry, onResolve }: { state: SaverState; onRetry: () => void; onResolve: () => void }) {
  void onResolve;
  const base = "flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium";
  if (state.status === "saving") return <span className={cn(base, "text-muted")} role="status"><Loader2 className="size-3.5 animate-spin" aria-hidden /> Saving…</span>;
  if (state.status === "dirty") return <span className={cn(base, "text-muted")} role="status"><Cloud className="size-3.5" aria-hidden /> Unsaved changes</span>;
  if (state.status === "error") return <button type="button" onClick={onRetry} className={cn(base, "bg-danger-soft text-danger-ink")} role="alert" title={state.error ?? undefined}><AlertCircle className="size-3.5" aria-hidden /> Not saved · Retry</button>;
  if (state.status === "conflict") return <span className={cn(base, "bg-warning-soft text-warning-ink")} role="alert"><AlertCircle className="size-3.5" aria-hidden /> Changed elsewhere</span>;
  return <span className={cn(base, "text-success-ink")} role="status"><CheckCircle2 className="size-3.5" aria-hidden /> {state.status === "saved" ? "Saved" : "All changes saved"}</span>;
}

export { DragProvider };
export { Check };
