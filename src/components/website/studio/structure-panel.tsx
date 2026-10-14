"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, Eye, EyeOff, FileText, Home, LayoutTemplate, Plus, Settings2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { Input } from "@/components/ui/primitives";
import { LIMITS, type SiteContent } from "@/lib/website/schema";
import { SECTION_DEFS, type SectionType } from "@/lib/website/sections";
import { sectionTypesAvailable } from "@/lib/website/edit";
import { cn } from "@/lib/utils";

export type Selection = { kind: "section"; id: string } | { kind: "page" } | { kind: "site"; group: string } | null;

function sectionTitle(type: SectionType, data: Record<string, unknown>): string {
  const heading = data.headline ?? data.heading;
  return typeof heading === "string" && heading.trim() ? heading.trim() : SECTION_DEFS[type].label;
}

/**
 * Pages and sections as an outline. Everything here is reachable by keyboard: select with Enter, move with the arrow
 * buttons, hide or delete with the row actions. Dragging is deliberately not required.
 */
export function StructurePanel({
  content, pageSlug, selection, onSelect, onPage, onMoveSection, onToggleHidden, onRemoveSection, onAddSection, onAddPage, onMovePage, onRemovePage,
}: {
  content: SiteContent; pageSlug: string; selection: Selection; onSelect: (s: Selection) => void; onPage: (slug: string) => void;
  onMoveSection: (id: string, d: -1 | 1) => void; onToggleHidden: (id: string) => void; onRemoveSection: (id: string) => void;
  onAddSection: (type: SectionType, afterId?: string) => void; onAddPage: (title: string) => void; onMovePage: (slug: string, d: -1 | 1) => void; onRemovePage: (slug: string) => void;
}) {
  const page = content.pages.find((p) => p.slug === pageSlug) ?? content.pages[0];
  const [adding, setAdding] = React.useState<{ after?: string } | null>(null);
  const [newPage, setNewPage] = React.useState(false);
  const [title, setTitle] = React.useState("");
  const [confirmDelete, setConfirmDelete] = React.useState<{ kind: "section" | "page"; id: string; label: string } | null>(null);
  const available = sectionTypesAvailable(page);
  const atLimit = page.sections.length >= LIMITS.sectionsPerPage;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <section aria-labelledby="sp-pages" className="border-b border-line px-3 pb-3 pt-3">
        <div className="mb-2 flex items-center justify-between">
          <h2 id="sp-pages" className="text-[12px] font-semibold uppercase tracking-wider text-muted">
            Pages
          </h2>
          <Button type="button" variant="ghost" size="sm" disabled={content.pages.length >= LIMITS.pages} onClick={() => { setTitle(""); setNewPage(true); }}>
            <Plus className="size-3.5" /> Add page
          </Button>
        </div>
        <ul className="space-y-0.5">
          {content.pages.map((p, i) => {
            const current = p.slug === page.slug;
            return (
              <li key={p.slug} className={cn("group flex items-center gap-1 rounded-lg pr-1", current ? "bg-primary-soft" : "hover:bg-surface-2")}>
                <button type="button" onClick={() => { onPage(p.slug); onSelect({ kind: "page" }); }} aria-current={current ? "page" : undefined} className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-left text-[13.5px] font-medium focus-visible:outline-2 focus-visible:outline-primary">
                  {p.slug === "home" ? <Home className="size-3.5 shrink-0 text-muted" aria-hidden /> : <FileText className="size-3.5 shrink-0 text-muted" aria-hidden />}
                  <span className="truncate">{p.title}</span>
                  {!p.showInNav && <span className="shrink-0 rounded bg-surface-3 px-1 text-[10.5px] font-semibold text-ink-2">hidden in menu</span>}
                </button>
                {p.slug !== "home" && (
                  <span className="flex shrink-0 opacity-100 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
                    <RowButton label={`Move ${p.title} up`} disabled={i <= 1} onClick={() => onMovePage(p.slug, -1)}><ArrowUp className="size-3.5" /></RowButton>
                    <RowButton label={`Move ${p.title} down`} disabled={i >= content.pages.length - 1} onClick={() => onMovePage(p.slug, 1)}><ArrowDown className="size-3.5" /></RowButton>
                    <RowButton label={`Delete ${p.title}`} onClick={() => setConfirmDelete({ kind: "page", id: p.slug, label: p.title })}><Trash2 className="size-3.5" /></RowButton>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="sp-sections" className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div className="mb-2 flex items-center justify-between">
          <h2 id="sp-sections" className="text-[12px] font-semibold uppercase tracking-wider text-muted">
            On this page
          </h2>
          <span className="text-[12px] tabular-nums text-muted">{page.sections.length}/{LIMITS.sectionsPerPage}</span>
        </div>
        <ol className="space-y-1">
          {page.sections.map((s, i) => {
            const selected = selection?.kind === "section" && selection.id === s.id;
            const label = sectionTitle(s.type, s.data as Record<string, unknown>);
            return (
              <li key={s.id} className={cn("rounded-xl border", selected ? "border-primary bg-primary-soft" : "border-line bg-surface hover:border-line-strong", s.hidden && "opacity-70")}>
                <button type="button" onClick={() => onSelect({ kind: "section", id: s.id })} aria-pressed={selected} className="flex w-full min-w-0 items-center gap-2 rounded-xl px-3 py-2.5 text-left focus-visible:outline-2 focus-visible:outline-primary">
                  <LayoutTemplate className="size-3.5 shrink-0 text-muted" aria-hidden />
                  <span className="min-w-0">
                    <span className="block truncate text-[13.5px] font-medium">{label}</span>
                    <span className="block truncate text-[11.5px] text-muted">
                      {SECTION_DEFS[s.type].label}
                      {s.hidden ? " · hidden from visitors" : ""}
                    </span>
                  </span>
                </button>
                {selected && (
                  <div role="toolbar" aria-label={`Actions for ${label}`} className="flex flex-wrap gap-1 border-t border-primary/20 px-2 py-1.5">
                    <ToolButton label={`Move ${label} up`} text="Up" disabled={i === 0} onClick={() => onMoveSection(s.id, -1)}><ArrowUp className="size-3.5" /></ToolButton>
                    <ToolButton label={`Move ${label} down`} text="Down" disabled={i === page.sections.length - 1} onClick={() => onMoveSection(s.id, 1)}><ArrowDown className="size-3.5" /></ToolButton>
                    <ToolButton label={s.hidden ? `Show ${label}` : `Hide ${label}`} text={s.hidden ? "Show" : "Hide"} onClick={() => onToggleHidden(s.id)}>{s.hidden ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}</ToolButton>
                    <ToolButton label={`Delete ${label}`} text="Delete" onClick={() => setConfirmDelete({ kind: "section", id: s.id, label })}><Trash2 className="size-3.5" /></ToolButton>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
        <Button type="button" variant="secondary" size="sm" className="mt-3 w-full" disabled={atLimit || available.length === 0} onClick={() => setAdding({ after: selection?.kind === "section" ? selection.id : undefined })}>
          <Plus className="size-3.5" /> Add a section
        </Button>
        {atLimit && <p className="mt-2 text-[12px] text-muted">This page has the most sections it can hold.</p>}

        <div className="mt-5 border-t border-line pt-3">
          <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-muted">Whole site</h2>
          <button type="button" onClick={() => onSelect({ kind: "site", group: "business" })} aria-pressed={selection?.kind === "site"} className={cn("flex w-full items-center gap-2 rounded-xl border px-3 py-2.5 text-left text-[13.5px] font-medium focus-visible:outline-2 focus-visible:outline-primary", selection?.kind === "site" ? "border-primary bg-primary-soft" : "border-line bg-surface hover:border-line-strong")}>
            <Settings2 className="size-3.5 text-muted" aria-hidden /> Business, brand and settings
          </button>
        </div>
      </section>

      <Dialog
        open={adding !== null}
        onOpenChange={(o) => !o && setAdding(null)}
        title="Add a section"
        description="Choose what to add. It goes after the section you have selected, and you can move it anywhere."
        size="lg"
      >
        <ul className="grid gap-2 sm:grid-cols-2">
          {available.map((t) => (
            <li key={t}>
              <button type="button" onClick={() => { onAddSection(t, adding?.after); setAdding(null); }} className="block h-full w-full rounded-xl border border-line bg-surface p-3 text-left transition hover:border-primary focus-visible:outline-2 focus-visible:outline-primary">
                <span className="block text-[14px] font-semibold">{SECTION_DEFS[t].label}</span>
                <span className="mt-0.5 block text-[12.5px] leading-snug text-muted">{SECTION_DEFS[t].description}</span>
              </button>
            </li>
          ))}
        </ul>
      </Dialog>

      <Dialog
        open={newPage}
        onOpenChange={setNewPage}
        title="Add a page"
        description="It starts with a text section. You can add more once it exists."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setNewPage(false)}>Cancel</Button>
            <Button variant="brand" disabled={!title.trim()} onClick={() => { onAddPage(title); setNewPage(false); }}>Add page</Button>
          </>
        }
      >
        <label htmlFor="new-page-title" className="mb-1.5 block text-[13px] font-medium text-ink-2">Page name</label>
        <Input id="new-page-title" value={title} maxLength={60} placeholder="For example: Pricing" onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && title.trim()) { onAddPage(title); setNewPage(false); } }} autoFocus />
      </Dialog>

      <Dialog
        open={confirmDelete !== null}
        onOpenChange={(o) => !o && setConfirmDelete(null)}
        title={confirmDelete?.kind === "page" ? "Delete this page?" : "Delete this section?"}
        description={confirmDelete ? `“${confirmDelete.label}” will be removed from your draft. Nothing changes on your live site until you publish, and earlier versions can always be restored.` : undefined}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>Keep it</Button>
            <Button variant="danger" onClick={() => { if (confirmDelete) (confirmDelete.kind === "page" ? onRemovePage : onRemoveSection)(confirmDelete.id); setConfirmDelete(null); }}>Delete</Button>
          </>
        }
      />
    </div>
  );
}

function RowButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick} className="grid size-9 place-items-center rounded-lg text-muted transition hover:bg-surface-3 hover:text-ink focus-visible:outline-2 focus-visible:outline-primary disabled:pointer-events-none disabled:opacity-30 sm:size-7">
      {children}
    </button>
  );
}

function ToolButton({ label, text, onClick, disabled, children }: { label: string; text: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} disabled={disabled} onClick={onClick} className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-medium text-ink-2 transition hover:bg-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-primary disabled:pointer-events-none disabled:opacity-35 sm:h-8">
      {children}
      {text}
    </button>
  );
}
