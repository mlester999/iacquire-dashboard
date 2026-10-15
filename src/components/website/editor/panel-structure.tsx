"use client";

import * as React from "react";
import {
  ArrowDown, ArrowUp, ChevronRight, Columns2, Copy, CornerLeftUp, CornerRightDown, EyeOff, FileText, Globe, Home, Image as ImageIcon, LayoutPanelTop, Link2, ListTree, MoreHorizontal, MousePointerClick, PanelBottom, PanelTop,
  Plus, Rows3, Square, Trash2, Type,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/overlays";
import { ELEMENT_DEFS, type ElementType } from "@/lib/website/catalog";
import { LIMITS, isRef, type ElementNode, type Section, type SiteContent } from "@/lib/website/doc";
import { PAGE_STARTERS, pageStarter, type PageStarterKind } from "@/lib/website/editor/library";
import { addPage, describeNode, duplicatePage, movePage, removeNode, setHomePage, updatePage } from "@/lib/website/ops";
import { cn } from "@/lib/utils";
import type { CanvasActions } from "./canvas";
import { IconButton, Row, SelectControl, TextControl } from "./controls";
import { useResetOnOpen } from "./hooks";

type Commit = CanvasActions["commit"];

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export function PagesPanel({ doc, pageId, setPage, commit, announce, onAfterAdd }: { doc: SiteContent; pageId: string; setPage: (id: string) => void; commit: Commit; announce: (m: string) => void; onAfterAdd?: () => void }) {
  const [adding, setAdding] = React.useState(false);
  const [renaming, setRenaming] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<string | null>(null);
  const atLimit = doc.pages.length >= LIMITS.pages;
  const target = doc.pages.find((p) => p.id === confirm);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-4 pb-2 pt-3">
        <p className="text-[11px] font-semibold uppercase tracking-[.1em] text-muted">Pages · {doc.pages.length}</p>
        <Button size="sm" variant="soft" className="!h-7 !px-2.5 !text-[12px]" disabled={atLimit} onClick={() => setAdding(true)}><Plus className="size-3.5" /> Add page</Button>
      </div>
      <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-4" aria-label="Pages">
        {doc.pages.map((p, i) => {
          const home = p.slug === "home";
          const current = p.id === pageId;
          return (
            <li key={p.id}>
              <div className={cn("group flex items-center gap-1 rounded-xl pr-1 transition-colors", current ? "bg-primary-soft" : "hover:bg-surface-2")}>
                {renaming === p.id ? (
                  <input
                    autoFocus aria-label="Page name" defaultValue={p.title} maxLength={60} className="m-1 h-8 min-w-0 flex-1 rounded-lg border border-primary bg-surface px-2 text-[13px]"
                    onBlur={(e) => { const t = e.target.value.trim(); if (t && t !== p.title) commit(updatePage(doc, p.id, { title: t })); setRenaming(null); }}
                    onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setRenaming(null); }}
                  />
                ) : (
                  <button type="button" onClick={() => setPage(p.id)} onDoubleClick={() => setRenaming(p.id)} aria-current={current ? "page" : undefined} className="flex min-h-10 min-w-0 flex-1 items-center gap-2 px-2.5 text-left">
                    {home ? <Home className="size-3.5 shrink-0 text-primary" aria-label="Home page" /> : p.kind === "thanks" ? <Link2 className="size-3.5 shrink-0 text-muted" aria-label="Thank-you page" /> : p.kind === "landing" ? <LayoutPanelTop className="size-3.5 shrink-0 text-muted" aria-label="Landing page" /> : <FileText className="size-3.5 shrink-0 text-muted" aria-hidden />}
                    <span className="min-w-0 flex-1">
                      <span className={cn("block truncate text-[13px]", current ? "font-semibold text-primary-ink" : "font-medium text-ink")}>{p.title}</span>
                      <span className="block truncate text-[11px] text-muted">/{home ? "" : p.slug}{!p.showInNav && " · hidden from menu"}</span>
                    </span>
                  </button>
                )}
                <Menu>
                  <MenuTrigger asChild>
                    <button type="button" aria-label={`Options for ${p.title}`} className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted opacity-70 hover:bg-surface-3 hover:text-ink group-hover:opacity-100 focus-visible:opacity-100"><MoreHorizontal className="size-4" /></button>
                  </MenuTrigger>
                  <MenuContent align="end">
                    <MenuItem onSelect={() => setRenaming(p.id)}>Rename</MenuItem>
                    <MenuItem onSelect={() => { const r = duplicatePage(doc, p.id); if (r) { commit(r.doc, { select: null }); setPage(r.id); announce(`Duplicated ${p.title}.`); } }} disabled={atLimit}>Duplicate</MenuItem>
                    <MenuItem onSelect={() => { commit(updatePage(doc, p.id, { showInNav: !p.showInNav })); announce(p.showInNav ? `${p.title} is hidden from the menu.` : `${p.title} is in the menu.`); }}>{p.showInNav ? "Hide from the menu" : "Show in the menu"}</MenuItem>
                    {!home && p.kind !== "thanks" && <MenuItem onSelect={() => { commit(setHomePage(doc, p.id)); announce(`${p.title} is now the home page.`); }}>Make this the home page</MenuItem>}
                    <MenuItem onSelect={() => commit(movePage(doc, p.id, -1))} disabled={i === 0}>Move up in the menu</MenuItem>
                    <MenuItem onSelect={() => commit(movePage(doc, p.id, 1))} disabled={i === doc.pages.length - 1}>Move down in the menu</MenuItem>
                    {!home && <><MenuSeparator /><MenuItem destructive onSelect={() => setConfirm(p.id)}>Delete page…</MenuItem></>}
                  </MenuContent>
                </Menu>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="border-t border-line px-4 py-2 text-[11px] leading-relaxed text-muted">Double-click a page to rename it. The menu follows the order shown here.</p>
      <AddPageDialog open={adding} onOpenChange={setAdding} doc={doc} onCreate={(title, kind, starter) => {
        const items = pageStarter(doc, starter, title);
        const added = addPage(doc, title, items, kind);
        if (!added) return;
        commit(added.doc, { select: null, page: added.id });
        announce(`Added the page ${title}.`);
        onAfterAdd?.();
      }} />
      <Dialog
        open={Boolean(target)} onOpenChange={(o) => !o && setConfirm(null)} size="sm" title={target ? `Delete “${target.title}”?` : "Delete page"}
        description="The page and everything on it will be removed from your draft. You can undo this straight away, and earlier versions are kept in history. Links to it will need a new destination."
        footer={<><Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button><Button variant="danger" onClick={() => { if (target) { commit(removeNode(doc, target.id), { select: null }); announce(`Deleted ${target.title}.`); } setConfirm(null); }}>Delete page</Button></>}
      />
    </div>
  );
}

function AddPageDialog({ open, onOpenChange, doc, onCreate }: { open: boolean; onOpenChange: (o: boolean) => void; doc: SiteContent; onCreate: (title: string, kind: "page" | "landing" | "thanks", starter: PageStarterKind) => void }) {
  const [title, setTitle] = React.useState("");
  const [starter, setStarter] = React.useState<PageStarterKind>("blank");
  useResetOnOpen(open, () => {
    setTitle("");
    setStarter("blank");
  });
  const def = PAGE_STARTERS.find((s) => s.id === starter)!;
  const taken = doc.pages.some((p) => p.title.toLowerCase() === title.trim().toLowerCase());
  const create = () => {
    const t = title.trim() || (starter === "thanks" ? "Thank you" : def.label);
    onCreate(t, def.kind, starter);
    onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="md" title="Add a page" description="Start from a ready-made layout, then change anything."
      footer={<><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="brand" onClick={create}>Add page</Button></>}>
      <div className="space-y-4">
        <Row label="Page name" htmlFor="np-title">
          <TextControl id="np-title" autoFocus value={title} maxLength={60} placeholder={starter === "thanks" ? "Thank you" : def.label} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") create(); }} />
          {taken && <p className="text-[11px] text-muted">You already have a page with that name. The address will be made unique.</p>}
        </Row>
        <div role="radiogroup" aria-label="Start from" className="grid gap-2 sm:grid-cols-2">
          {PAGE_STARTERS.map((s) => (
            <button key={s.id} type="button" role="radio" aria-checked={starter === s.id} onClick={() => setStarter(s.id)} className={cn("rounded-xl border p-3 text-left transition-colors", starter === s.id ? "border-primary bg-primary-soft" : "border-line hover:border-line-strong")}>
              <span className="block text-[13px] font-semibold">{s.label}</span>
              <span className="mt-0.5 block text-[12px] leading-snug text-muted">{s.description}</span>
            </button>
          ))}
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

const ELEMENT_ICON: Partial<Record<ElementType, React.ComponentType<{ className?: string }>>> = {
  heading: Type, text: Type, button: MousePointerClick, image: ImageIcon, gallery: ImageIcon, collage: ImageIcon, card: Square, group: Rows3, form: FileText, nav: ListTree, logo: Globe,
};

interface Row {
  id: string;
  depth: number;
  label: string;
  kind: "header" | "footer" | "section" | "column" | "element" | "ref";
  icon: React.ComponentType<{ className?: string }>;
  hidden: boolean;
  hasChildren: boolean;
  /** The id to act on (the page's item for a shared section). */
  actOn: string;
}

function rowsFor(doc: SiteContent, pageId: string, collapsed: Set<string>): Row[] {
  const out: Row[] = [];
  const page = doc.pages.find((p) => p.id === pageId);
  const el = (e: ElementNode, depth: number) => {
    const kids = e.children ?? [];
    out.push({ id: e.id, depth, label: describeNode(doc, e.id), kind: "element", icon: ELEMENT_ICON[e.type] ?? Square, hidden: Boolean(e.hide?.d && e.hide?.t && e.hide?.m), hasChildren: kids.length > 0, actOn: e.id });
    if (kids.length && !collapsed.has(e.id)) kids.forEach((k) => el(k, depth + 1));
  };
  const sec = (s: Section, depth: number, kind: Row["kind"], actOn: string, shared?: boolean) => {
    out.push({ id: s.id, depth, label: `${describeNode(doc, s.id)}${shared ? " (shared)" : ""}`, kind, icon: kind === "header" ? PanelTop : kind === "footer" ? PanelBottom : Columns2, hidden: s.hidden, hasChildren: s.columns.length > 0, actOn });
    if (collapsed.has(s.id)) return;
    s.columns.forEach((c) => {
      out.push({ id: c.id, depth: depth + 1, label: `Column ${s.columns.indexOf(c) + 1}`, kind: "column", icon: Square, hidden: false, hasChildren: c.elements.length > 0, actOn: c.id });
      if (!collapsed.has(c.id)) c.elements.forEach((e) => el(e, depth + 2));
    });
  };
  if (doc.header) sec(doc.header, 0, "header", doc.header.id);
  for (const item of page?.items ?? []) {
    if (isRef(item)) {
      const g = doc.globals[item.ref];
      if (g) sec(g, 0, "section", item.id, true);
    } else sec(item, 0, "section", item.id);
  }
  if (doc.footer) sec(doc.footer, 0, "footer", doc.footer.id);
  return out;
}

export function LayersPanel({ doc, pageId, selection, actions }: { doc: SiteContent; pageId: string; selection: string | null; actions: CanvasActions }) {
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());
  const rows = React.useMemo(() => rowsFor(doc, pageId, collapsed), [doc, pageId, collapsed]);
  const toggle = (id: string) => setCollapsed((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  // Make sure the selected item is visible in the tree.
  const listRef = React.useRef<HTMLUListElement>(null);
  React.useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selection]);
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const r = rows[i];
    if (e.key === "ArrowDown") { e.preventDefault(); (listRef.current?.querySelectorAll<HTMLElement>("[role=treeitem]")[i + 1])?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); (listRef.current?.querySelectorAll<HTMLElement>("[role=treeitem]")[i - 1])?.focus(); }
    else if (e.key === "ArrowRight" && r.hasChildren && collapsed.has(r.id)) { e.preventDefault(); toggle(r.id); }
    else if (e.key === "ArrowLeft" && r.hasChildren && !collapsed.has(r.id)) { e.preventDefault(); toggle(r.id); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); actions.select(r.id); }
    else if (e.altKey && e.key === "ArrowUp" && r.kind !== "header" && r.kind !== "footer") { e.preventDefault(); actions.nudge(r.actOn, -1); }
    else if (e.altKey && e.key === "ArrowDown" && r.kind !== "header" && r.kind !== "footer") { e.preventDefault(); actions.nudge(r.actOn, 1); }
    else if (e.key === "Delete") { e.preventDefault(); actions.remove(r.actOn); }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="px-4 pb-2 pt-3 text-[11px] font-semibold uppercase tracking-[.1em] text-muted">Layers</p>
      <ul ref={listRef} role="tree" aria-label="Everything on this page" className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {rows.map((r, i) => {
          const on = r.id === selection;
          const movable = r.kind !== "header" && r.kind !== "footer";
          return (
            <li key={`${r.id}-${i}`} role="none">
              <div role="treeitem" aria-selected={on} aria-level={r.depth + 1} tabIndex={0} onKeyDown={(e) => onKey(e, i)} onClick={() => actions.select(r.id)}
                className={cn("group flex h-8 cursor-default items-center gap-1 rounded-lg pr-1 text-[12.5px] outline-none focus-visible:ring-2 focus-visible:ring-primary", on ? "bg-primary-soft text-primary-ink" : "text-ink-2 hover:bg-surface-2")} style={{ paddingLeft: 4 + r.depth * 14 }}>
                {r.hasChildren ? (
                  <button type="button" tabIndex={-1} aria-label={collapsed.has(r.id) ? "Expand" : "Collapse"} onClick={(e) => { e.stopPropagation(); toggle(r.id); }} className="flex size-5 shrink-0 items-center justify-center rounded hover:bg-surface-3"><ChevronRight className={cn("size-3 transition-transform", !collapsed.has(r.id) && "rotate-90")} /></button>
                ) : <span className="size-5 shrink-0" />}
                <r.icon className="size-3.5 shrink-0 opacity-70" />
                <span className={cn("min-w-0 flex-1 truncate", r.hidden && "opacity-50 line-through")}>{r.label}</span>
                {r.hidden && <EyeOff className="size-3 shrink-0 opacity-60" aria-label="Hidden" />}
                {on && movable && (
                  <span className="flex shrink-0">
                    <IconButton label="Move up" onClick={(e) => { e.stopPropagation(); actions.nudge(r.actOn, -1); }} className="size-6"><ArrowUp className="size-3" /></IconButton>
                    <IconButton label="Move down" onClick={(e) => { e.stopPropagation(); actions.nudge(r.actOn, 1); }} className="size-6"><ArrowDown className="size-3" /></IconButton>
                    {r.kind === "element" && <IconButton label="Move out of its container" onClick={(e) => { e.stopPropagation(); actions.nudgeAcross(r.actOn, -1); }} className="size-6"><CornerLeftUp className="size-3" /></IconButton>}
                    {r.kind === "element" && <IconButton label="Move into the next container" onClick={(e) => { e.stopPropagation(); actions.nudgeAcross(r.actOn, 1); }} className="size-6"><CornerRightDown className="size-3" /></IconButton>}
                    <IconButton label="Duplicate" onClick={(e) => { e.stopPropagation(); actions.duplicate(r.actOn); }} className="size-6"><Copy className="size-3" /></IconButton>
                    <IconButton label="Delete" onClick={(e) => { e.stopPropagation(); actions.remove(r.actOn); }} className="size-6"><Trash2 className="size-3" /></IconButton>
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="border-t border-line px-4 py-2 text-[11px] leading-relaxed text-muted">Arrow keys move between layers. Alt + ↑ ↓ reorders the selected one.</p>
    </div>
  );
}

export { ELEMENT_DEFS, SelectControl };
