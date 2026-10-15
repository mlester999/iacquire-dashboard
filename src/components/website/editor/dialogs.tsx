"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2, Eye, GitCompare, History, Loader2, Monitor, RotateCcw, Smartphone, Tablet, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { SiteRenderer } from "@/components/website/render/site-renderer";
import type { RenderCtx } from "@/components/website/render/ctx";
import { useStudioApi, type VersionContent } from "@/components/website/studio/studio-api";
import type { SiteContent } from "@/lib/website/doc";
import { diffDocs, type DocDiff } from "@/lib/website/editor/diff";
import { DEVICES, type Device } from "@/lib/website/editor/state";
import { formatDateTime, relativeTime } from "@/lib/utils";
import { cn } from "@/lib/utils";
import type { VersionView } from "@/server/websites/service";
import { Row, SelectControl, TextControl } from "./controls";
import { useResetOnOpen } from "./hooks";

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

const DEVICE_ICON: Record<Device, React.ComponentType<{ className?: string }>> = { desktop: Monitor, tablet: Tablet, mobile: Smartphone };

/**
 * The site as a visitor would see it: real animations, hover and navigation, at a real device width. Links to other websites are switched off so
 * the preview can never carry anyone out of the editor.
 */
export function PreviewOverlay({
  doc, resolveAsset, onClose, title = "Preview", initialPage, subtitle, actions,
}: { doc: SiteContent; resolveAsset: RenderCtx["resolveAsset"]; onClose: () => void; title?: string; initialPage?: string; subtitle?: string; actions?: React.ReactNode }) {
  const [device, setDevice] = React.useState<Device>("desktop");
  const [page, setPage] = React.useState(initialPage && doc.pages.some((p) => p.slug === initialPage) ? initialPage : "home");
  const scroller = React.useRef<HTMLDivElement>(null);
  const [h, setH] = React.useState(800);
  const [w, setW] = React.useState(1200);
  const closeRef = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    closeRef.current?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  React.useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { setH(el.clientHeight); setW(el.clientWidth); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const target = DEVICES.find((d) => d.id === device)!.width;
  const width = device === "desktop" ? Math.min(w, 1440) : Math.min(target, w - 24);
  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("#__page:")) {
      e.preventDefault();
      setPage(href.slice(8));
      scroller.current?.scrollTo({ top: 0 });
    } else if (/^https?:/i.test(href)) {
      e.preventDefault();
      toast("Links to other websites are switched off in preview.");
    } else if (href.startsWith("tel:") || href.startsWith("mailto:")) e.preventDefault();
  };
  return (
    <div className="fixed inset-0 z-[55] flex flex-col bg-[#14171f]" role="dialog" aria-modal="true" aria-label={title}>
      <div className="flex flex-wrap items-center gap-3 border-b border-white/10 bg-[#0e1118] px-4 py-2 text-white">
        <p className="mr-2 flex items-center gap-2 text-[13px] font-semibold"><Eye className="size-4 text-[#9ebcff]" aria-hidden /> {title}{subtitle && <span className="font-normal text-white/60">· {subtitle}</span>}</p>
        <div role="radiogroup" aria-label="Device" className="flex rounded-lg bg-white/10 p-0.5">
          {DEVICES.map((d) => {
            const I = DEVICE_ICON[d.id];
            return <button key={d.id} type="button" role="radio" aria-checked={device === d.id} onClick={() => setDevice(d.id)} className={cn("flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium", device === d.id ? "bg-white text-[#0e1118]" : "text-white/70 hover:text-white")}><I className="size-3.5" />{d.label}<span className="hidden text-white/50 sm:inline">{d.width}</span></button>;
          })}
        </div>
        <SelectControl<string> label="Page" value={page} onChange={(v) => { setPage(v); scroller.current?.scrollTo({ top: 0 }); }} options={doc.pages.map((p) => ({ value: p.slug, label: p.title }))} />
        <span className="flex-1" />
        <span className="hidden text-[11.5px] text-white/55 md:inline">Sample behaviour: the enquiry form is switched off here.</span>
        {actions}
        <button ref={closeRef} type="button" onClick={onClose} className="flex h-8 items-center gap-1.5 rounded-lg bg-white/10 px-3 text-[12.5px] font-medium hover:bg-white/20"><X className="size-4" /> Close <kbd className="hidden rounded bg-white/15 px-1 text-[10px] sm:inline">Esc</kbd></button>
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-auto p-3 sm:p-6" onClick={onClick}>
        <div className="mx-auto overflow-hidden rounded-xl bg-white shadow-2xl" style={{ width }}>
          <SiteRenderer key={`${device}-${page}`} content={doc} pageSlug={page} resolveAsset={resolveAsset} mode="preview" formAction={null} hrefFor={(s) => `#__page:${s}`} embedded viewportHeight={Math.round(h - 48)} scope="preview" />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Named checkpoint
// ---------------------------------------------------------------------------

export function CheckpointDialog({ open, onOpenChange, onSave }: { open: boolean; onOpenChange: (o: boolean) => void; onSave: (note: string) => Promise<boolean> }) {
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  useResetOnOpen(open, () => setNote(""));
  const save = async () => {
    setBusy(true);
    const ok = await onSave(note.trim());
    setBusy(false);
    if (ok) onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="sm" title="Save a version" description="Keeps an exact copy of your draft that you can come back to. It doesn't change your live site."
      footer={<><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="brand" loading={busy} onClick={() => void save()}>Save version</Button></>}>
      <Row label="Name it (optional)" htmlFor="cp-note"><TextControl id="cp-note" autoFocus value={note} maxLength={300} placeholder="For example: before the spring campaign" onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void save(); }} /></Row>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Version history
// ---------------------------------------------------------------------------

const SOURCE: Record<string, string> = { generated: "Written for you", editor: "Saved", checkpoint: "Named version", submit: "Sent for review", publish: "Published", rollback: "Rolled back", ai: "Assistant change", restore: "Restored", template: "New template" };

export function VersionsDialog({
  open, onOpenChange, currentDoc, revision, resolveAsset, onRestored, canEdit, flush,
}: { open: boolean; onOpenChange: (o: boolean) => void; currentDoc: SiteContent; revision: number; resolveAsset: RenderCtx["resolveAsset"]; onRestored: (content: SiteContent, revision: number) => void; canEdit: boolean; flush: () => Promise<boolean> }) {
  const api = useStudioApi();
  const [list, setList] = React.useState<VersionView[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [view, setView] = React.useState<{ v: VersionView; content: VersionContent } | null>(null);
  const [diff, setDiff] = React.useState<{ v: VersionView; diff: DocDiff } | null>(null);
  const [confirm, setConfirm] = React.useState<VersionView | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  useResetOnOpen(open, () => {
    setList(null);
    setError(null);
    setDiff(null);
  });
  React.useEffect(() => {
    if (!open) return;
    let live = true;
    void api.listVersions().then((r) => {
      if (!live) return;
      if (r.ok) setList(r.data);
      else setError(r.error);
    });
    return () => { live = false; };
  }, [open, api]);

  const load = async (v: VersionView) => {
    setBusy(v.id);
    const r = await api.previewVersion(v.id);
    setBusy(null);
    if (!r.ok) {
      toast.error(r.error);
      return null;
    }
    return r.data;
  };
  const compare = async (v: VersionView) => {
    const c = await load(v);
    if (c) setDiff({ v, diff: diffDocs(c.content, currentDoc) });
  };
  const preview = async (v: VersionView) => {
    const c = await load(v);
    if (c) setView({ v, content: c });
  };
  const restore = async (v: VersionView) => {
    setBusy(v.id);
    // Everything typed so far is saved first, so restoring can never swallow work.
    if (!(await flush())) {
      setBusy(null);
      return void toast.error("Your latest changes haven’t been saved yet. Wait for “Saved” and try again.");
    }
    const latest = await api.getDraft();
    const rev = latest.ok ? latest.data.revision : revision;
    const res = await api.restoreVersion(v.id, rev);
    if (!res.ok) {
      setBusy(null);
      return void toast.error(res.error);
    }
    const draft = await api.getDraft();
    setBusy(null);
    if (!draft.ok) return void toast.error(draft.error);
    setConfirm(null);
    setView(null);
    onOpenChange(false);
    onRestored(draft.data.content, draft.data.revision);
    toast.success(`Version ${v.version} is back in your draft. What was there before is saved too.`);
  };

  return (
    <>
      <Dialog open={open && !view} onOpenChange={onOpenChange} size="lg" title="Version history" description="Every named version, every time you sent the site for review, and every publication. Restoring never loses your current draft; it&apos;s saved first.">
        {error && <p role="alert" className="rounded-xl border border-danger/30 bg-danger-soft/50 p-3 text-[13px] text-danger-ink">{error}</p>}
        {!list && !error && <p className="flex items-center gap-2 text-[13.5px] text-muted" role="status"><Loader2 className="size-4 animate-spin" aria-hidden /> Loading versions…</p>}
        {list && list.length === 0 && <p className="flex items-center gap-2 text-[13.5px] text-muted"><History className="size-4" aria-hidden /> No versions yet. Use “Save version” whenever you like a draft.</p>}
        {list && list.length > 0 && (
          <ul className="divide-y divide-line">
            {list.map((v) => (
              <li key={v.id} className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0 space-y-0.5">
                    <p className="flex flex-wrap items-center gap-2 text-[14px] font-semibold">Version {v.version}
                      <span className="rounded-full bg-surface-3 px-2 py-px text-[11px] font-medium text-muted">{SOURCE[v.source] ?? "Saved"}</span>
                      {v.isLive && <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-px text-[11px] font-medium text-success-ink"><CheckCircle2 className="size-3" aria-hidden /> Live</span>}
                    </p>
                    <p className="text-[12.5px] text-muted">{relativeTime(v.createdAt)} · {formatDateTime(v.createdAt, "UTC")}{v.createdByName ? ` · ${v.createdByName}` : ""}</p>
                    {v.note && <p className="text-[13px] text-ink-2">“{v.note}”</p>}
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    <Button size="sm" variant="secondary" loading={busy === v.id} onClick={() => void preview(v)}><Eye className="size-3.5" /> Preview</Button>
                    <Button size="sm" variant="ghost" onClick={() => void compare(v)}><GitCompare className="size-3.5" /> Compare</Button>
                    {canEdit && <Button size="sm" variant="ghost" onClick={() => setConfirm(v)}><RotateCcw className="size-3.5" /> Restore</Button>}
                  </div>
                </div>
                {diff?.v.id === v.id && (
                  <div className="mt-3 rounded-xl border border-line bg-surface-2/60 p-3">
                    <p className="text-[12.5px] font-semibold">What would change if you went back to version {v.version}</p>
                    {diff.diff.changes.length === 0 ? <p className="mt-1 text-[12.5px] text-muted">Nothing: your draft already matches this version.</p> : (
                      <>
                        <p className="mt-0.5 text-[11.5px] text-muted">{diff.diff.counts.added} added · {diff.diff.counts.removed} removed · {diff.diff.counts.changed} changed · {diff.diff.counts.moved} moved. (Compared with your current draft, from this version&apos;s point of view.)</p>
                        <ul className="mt-2 max-h-48 list-disc space-y-0.5 overflow-y-auto pl-5 text-[12.5px] text-ink-2">{diff.diff.summary.map((s, i) => <li key={i}>{s}</li>)}</ul>
                      </>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Dialog>
      {view && (
        <PreviewOverlay doc={view.content.content} resolveAsset={resolveAsset} onClose={() => setView(null)} title={`Version ${view.v.version}`} subtitle={`${SOURCE[view.v.source] ?? "Saved"} · ${relativeTime(view.v.createdAt)}`}
          actions={canEdit ? <button type="button" onClick={() => setConfirm(view.v)} className="flex h-8 items-center gap-1.5 rounded-lg bg-[#3b5bdb] px-3 text-[12.5px] font-medium text-white hover:bg-[#4c6ae0]"><RotateCcw className="size-3.5" /> Restore this version</button> : undefined} />
      )}
      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)} size="sm" title={confirm ? `Restore version ${confirm.version}?` : "Restore"}
        description="It replaces your current draft. Your current draft is saved as its own version first, and your live site doesn't change until you publish."
        footer={<><Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button><Button variant="brand" loading={busy !== null} onClick={() => confirm && void restore(confirm)}>Restore</Button></>} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Conflict
// ---------------------------------------------------------------------------

export function ConflictDialog({ open, onReload, onKeepMine, busy }: { open: boolean; onReload: () => void; onKeepMine: () => void; busy: boolean }) {
  return (
    <Dialog open={open} onOpenChange={() => undefined} size="md" title="This website changed somewhere else"
      description="Someone else (or another window of yours) saved changes after you opened it. We stopped saving so nothing is overwritten without your say-so."
      footer={<><Button variant="secondary" loading={busy} onClick={onKeepMine}>Keep my version</Button><Button variant="brand" loading={busy} onClick={onReload}>Load the latest</Button></>}>
      <div className="space-y-3 text-[13.5px] leading-relaxed text-ink-2">
        <p className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning-soft/60 p-3 text-warning-ink"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> Your last unsaved edits are still on screen.</p>
        <p><strong className="font-semibold text-ink">Load the latest</strong> replaces what you see with the saved site. Your unsaved edits are discarded.</p>
        <p><strong className="font-semibold text-ink">Keep my version</strong> saves what you see now as the draft. The other person&apos;s changes stay in version history, but your draft is what carries on.</p>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Save as component
// ---------------------------------------------------------------------------

export function SaveComponentDialog({ open, onOpenChange, defaultName, onSave, canShareWithAgency }: { open: boolean; onOpenChange: (o: boolean) => void; defaultName: string; onSave: (name: string, scope: "site" | "agency") => Promise<boolean>; canShareWithAgency: boolean }) {
  const [name, setName] = React.useState(defaultName);
  const [scope, setScope] = React.useState<"site" | "agency">("site");
  const [busy, setBusy] = React.useState(false);
  useResetOnOpen(open, () => {
    setName(defaultName);
    setScope("site");
  });
  const save = async () => {
    setBusy(true);
    const ok = await onSave(name.trim() || defaultName, scope);
    setBusy(false);
    if (ok) onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="sm" title="Save as a component" description="Reuse this section on other pages. Each time you add it you get an independent copy, so changing one never changes another."
      footer={<><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="brand" loading={busy} onClick={() => void save()}>Save component</Button></>}>
      <div className="space-y-4">
        <Row label="Name" htmlFor="sc-name"><TextControl id="sc-name" autoFocus value={name} maxLength={60} onChange={(e) => setName(e.target.value)} /></Row>
        {canShareWithAgency && (
          <Row label="Who can use it" hint="Components shared with all clients appear in every client's editor. They are copied in, never linked, so they can't change anyone's site afterwards.">
            <SelectControl label="Who can use it" value={scope} onChange={setScope} options={[{ value: "site", label: "Only this website" }, { value: "agency", label: "All iAcquire client websites" }]} />
          </Row>
        )}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Shortcuts
// ---------------------------------------------------------------------------

const SHORTCUTS: Array<[string, string]> = [
  ["Click", "Select the item under the pointer (the innermost one)"], ["Click again, double-click or Enter", "Edit text on the page"], ["Esc", "Stop editing, or select the item that contains this one"],
  ["Ctrl/⌘ + Z", "Undo"], ["Ctrl/⌘ + Shift + Z or Ctrl + Y", "Redo"], ["Ctrl/⌘ + S", "Save now"], ["Ctrl/⌘ + D", "Duplicate"], ["Delete", "Remove the selected item"],
  ["Alt + ↑ ↓", "Move the selected item earlier or later"], ["Alt + ← →", "Move out of, or into, the neighbouring container"], ["Ctrl/⌘ + B / I", "Bold / emphasis while editing text"], ["?", "Show this list"],
];
export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="md" title="Keyboard shortcuts" description="Everything you can do with a mouse can be done from the keyboard too.">
      <dl className="divide-y divide-line">
        {SHORTCUTS.map(([k, d]) => (
          <div key={k} className="flex items-start justify-between gap-4 py-2"><dt className="shrink-0 rounded-md bg-surface-3 px-2 py-0.5 text-[12px] font-medium">{k}</dt><dd className="text-right text-[13px] text-ink-2">{d}</dd></div>
        ))}
      </dl>
    </Dialog>
  );
}
