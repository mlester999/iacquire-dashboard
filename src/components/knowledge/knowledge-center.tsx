"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { BookOpen, CalendarDays, CheckCircle2, ChevronDown, Clock, Download, FileText, FolderOpen, HardDrive, Search, ShieldAlert, Trash2, UploadCloud, UserRound, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, EmptyState, Input, Textarea } from "@/components/ui/primitives";
import { PageHero, DataToolbar, CoverageBar } from "@/components/ui/workspace";
import { InfoChip, StatusPill } from "@/components/ui/status";
import { FilterTabs, IconTile, Notice, Panel, type PanelTone } from "@/components/settings/panel";
import { Dialog } from "@/components/ui/overlays";
import { saveKnowledgeAction } from "@/app/actions/knowledge";
import { cn, formatDate, formatDateTime, relativeTime } from "@/lib/utils";

interface Section {
  key: string;
  label: string;
  hint: string;
  content: string;
  version: number;
  updatedAt: string | null;
  appliedAt: string | null;
  held: boolean;
  updatedBy: string | null;
}

interface Doc {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  status: string;
  created_at: string;
  applied_at: string | null;
  has_text: boolean;
  uploaded_by_name: string | null;
}

function size(n: number) {
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

type Filter = "all" | "missing" | "review";

export function KnowledgeCenter({ sections, documents, canEdit, accept, timeZone }: { sections: Section[]; documents: Doc[]; canEdit: boolean; accept: string; timeZone: string }) {
  const filled = sections.filter((s) => s.content.trim()).length;
  const lastApplied = sections.map((s) => s.appliedAt).filter(Boolean).sort().pop() ?? null;
  const missing = sections.length - filled;
  const inReview = sections.filter((s) => s.held).length;
  const pct = sections.length ? Math.round((filled / sections.length) * 100) : 0;
  const [search, setSearch] = React.useState("");
  const [filter, setFilter] = React.useState<Filter>("all");
  const visible = sections.filter((s) => (filter === "all" || (filter === "missing" && !s.content.trim()) || (filter === "review" && s.held)) && `${s.label} ${s.hint} ${s.content}`.toLowerCase().includes(search.toLowerCase()));
  return (
    <div className="module-stack space-y-6">
      <PageHero
        eyebrow="Your business memory"
        title="Give your AI team the context to get it right."
        description="Brief your employees as you would a trusted teammate. Keep approved business facts, preferences and private reference documents together."
        icon={<BookOpen />}
        aside={
          <div className="rounded-2xl border border-line bg-surface/80 p-5 shadow-soft">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Business memory</p>
              <StatusPill tone={pct === 100 ? "success" : pct > 0 ? "primary" : "neutral"}>{pct}% supplied</StatusPill>
            </div>
            <p className="mt-2.5 text-[13px] font-semibold text-ink">
              {filled} of {sections.length} knowledge sections supplied
            </p>
            <div className="mt-3">
              <CoverageBar label="Business knowledge completeness" parts={[{ label: "Supplied", count: filled, color: "var(--primary)" }, { label: "Missing", count: sections.length - filled, color: "var(--surface-3)" }]} />
            </div>
            <div className="mt-3.5">
              <InfoChip icon={<Clock aria-hidden />}>{lastApplied ? `Last applied ${relativeTime(lastApplied)}` : "No application timestamp recorded"}</InfoChip>
            </div>
          </div>
        }
      />
      <DataToolbar>
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <Input aria-label="Search business knowledge" placeholder="Find a section or business fact…" className="rounded-full pl-10 pr-9" value={search} onChange={(e) => setSearch(e.target.value)} />
          {search && (
            <button type="button" aria-label="Clear search" onClick={() => setSearch("")} className="absolute right-1.5 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-full text-muted hover:bg-surface-3 hover:text-ink">
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <FilterTabs
          label="Filter knowledge sections"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All sections", count: sections.length },
            { value: "missing", label: "Needs information", count: missing },
            { value: "review", label: "In review", count: inReview },
          ]}
        />
      </DataToolbar>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="space-y-3 xl:col-span-2">
          {sections.map((s, i) => (
            <div key={s.key} hidden={!visible.some((v) => v.key === s.key)}>
              <SectionEditor section={s} canEdit={canEdit} timeZone={timeZone} defaultOpen={i === 0 || (!s.content && i < 3)} />
            </div>
          ))}
          {!visible.length && (
            <Card>
              <EmptyState
                compact
                icon={<Search className="size-5" />}
                title="No sections match this view"
                description="Try another search or show every section."
                action={
                  <Button
                    variant="soft"
                    size="sm"
                    onClick={() => {
                      setFilter("all");
                      setSearch("");
                    }}
                  >
                    Show all sections
                  </Button>
                }
              />
            </Card>
          )}
        </div>
        <Documents documents={documents} canEdit={canEdit} accept={accept} timeZone={timeZone} />
      </div>
    </div>
  );
}

function SectionEditor({ section, canEdit, timeZone, defaultOpen }: { section: Section; canEdit: boolean; timeZone: string; defaultOpen: boolean }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(defaultOpen);
  const [value, setValue] = React.useState(section.content);
  const [saving, setSaving] = React.useState(false);
  const dirty = value !== section.content;
  const supplied = Boolean(section.content);
  return (
    <Card className={cn("overflow-hidden transition", open && "shadow-float")}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="management-row flex w-full items-center gap-3.5 px-4 py-4 text-left sm:px-5">
        <IconTile icon={supplied ? <CheckCircle2 /> : <FileText />} tone={section.held ? "violet" : supplied ? "success" : "neutral"} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
            <span className="text-[14.5px] font-semibold leading-snug text-ink">{section.label}</span>
            {section.held ? <StatusPill tone="violet" size="sm" icon={<ShieldAlert className="size-3" aria-hidden />}>In review</StatusPill> : supplied ? <StatusPill tone="success" size="sm">Supplied</StatusPill> : <StatusPill tone="neutral" size="sm">Needs information</StatusPill>}
          </span>
          <span className="mt-0.5 block truncate text-[12.5px] text-muted">{supplied ? section.content.slice(0, 90) : section.hint}</span>
        </span>
        {section.appliedAt && !section.held && (
          <InfoChip className="hidden sm:inline-flex" icon={<Clock aria-hidden />}>
            Applied {relativeTime(section.appliedAt)}
          </InfoChip>
        )}
        <ChevronDown className={cn("size-4 shrink-0 text-muted transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22 }} className="overflow-hidden">
            <div className="space-y-3 border-t border-line px-4 pb-5 pt-4 sm:px-5">
              <p className="text-[12.5px] leading-relaxed text-muted">{section.hint}</p>
              <label htmlFor={`k-${section.key}`} className="sr-only">
                {section.label}
              </label>
              <Textarea id={`k-${section.key}`} rows={6} maxLength={12000} value={value} disabled={!canEdit} onChange={(e) => setValue(e.target.value)} />
              {section.held && (
                <Notice tone="violet" icon={<ShieldAlert />} title="Waiting for a quick review">
                  This update is waiting for a quick iAcquire review because it may conflict with AI safety rules. Your AI team keeps using the previous approved knowledge until then.
                </Notice>
              )}
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2.5">
                <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                  {section.updatedAt ? (
                    <>
                      <InfoChip className="tabular-nums">v{section.version}</InfoChip>
                      <InfoChip icon={<UserRound aria-hidden />}>{section.updatedBy ?? "Someone"}</InfoChip>
                      <InfoChip icon={<CalendarDays aria-hidden />}>{formatDateTime(section.updatedAt, timeZone)}</InfoChip>
                    </>
                  ) : (
                    <InfoChip icon={<Clock aria-hidden />}>Not written yet</InfoChip>
                  )}
                  {canEdit && <span className="px-1 text-[11.5px] tabular-nums text-faint">{value.length.toLocaleString("en-US")} / 12,000</span>}
                </span>
                {canEdit && (
                  <div className="flex items-center gap-2">
                    {dirty && <StatusPill tone="warning" size="sm">Unsaved changes</StatusPill>}
                    {dirty && (
                      <Button size="sm" variant="ghost" onClick={() => setValue(section.content)}>
                        Discard
                      </Button>
                    )}
                    <Button
                      size="sm"
                      disabled={!dirty}
                      loading={saving}
                      onClick={async () => {
                        setSaving(true);
                        const res = await saveKnowledgeAction(section.key, value);
                        setSaving(false);
                        if (!res.ok) return toast.error(res.error);
                        if (res.data.held) toast.warning("Saved for review", { description: "iAcquire will review this before your AI team uses it." });
                        else toast.success(`${section.label} saved`, { description: "AI employees use it from their next message." });
                        router.refresh();
                      }}
                    >
                      Save
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  );
}

/** Which kind of file it is, from its name, so a list of documents can be told apart at a glance. */
function fileKind(filename: string, mime: string): { label: string; tone: PanelTone } {
  const ext = (filename.split(".").pop() ?? "").toLowerCase();
  if (ext === "pdf" || mime === "application/pdf") return { label: "PDF", tone: "violet" };
  if (ext === "doc" || ext === "docx") return { label: "DOC", tone: "primary" };
  if (ext === "csv" || ext === "xls" || ext === "xlsx") return { label: "CSV", tone: "success" };
  if (ext === "md") return { label: "MD", tone: "neutral" };
  return { label: ext && ext.length <= 4 ? ext.toUpperCase() : "TXT", tone: "neutral" };
}

function Documents({ documents, canEdit, accept, timeZone }: { documents: Doc[]; canEdit: boolean; accept: string; timeZone: string }) {
  const router = useRouter();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [drag, setDrag] = React.useState(false);
  const [uploading, setUploading] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<Doc | null>(null);

  const upload = async (file: File) => {
    if (file.size > 10 * 1024 * 1024) return toast.error("Files can be up to 10 MB.");
    setUploading(file.name);
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await fetch("/api/knowledge/upload", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Upload failed.");
      toast.success(`${data.filename} uploaded`, { description: data.held ? "Held for iAcquire review before AI use." : undefined });
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(null);
    }
  };

  return (
    <>
      <Panel
        className="self-start"
        icon={<FolderOpen />}
        tone="violet"
        title={
          <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            Reference documents
            {documents.length > 0 && <InfoChip>{documents.length} {documents.length === 1 ? "file" : "files"}</InfoChip>}
          </span>
        }
        description="Private to your workspace. PDF, Word, text, Markdown or CSV up to 10 MB."
        bodyClassName="space-y-4"
      >
        {canEdit && (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              const f = e.dataTransfer.files[0];
              if (f) void upload(f);
            }}
            className={cn("flex flex-col items-center rounded-2xl border-2 border-dashed px-4 py-6 text-center transition", drag ? "border-primary bg-primary-soft/50" : "border-line-strong bg-surface-2/40")}
          >
            <IconTile icon={<UploadCloud />} tone="primary" />
            <p className="mt-3 text-[13.5px] font-medium text-ink">{uploading ? `Uploading ${uploading}…` : "Drop a file here"}</p>
            <p className="text-[12px] text-muted">or</p>
            <Button size="sm" variant="secondary" className="mt-2" loading={Boolean(uploading)} onClick={() => inputRef.current?.click()}>
              Choose file
            </Button>
            <input
              ref={inputRef}
              type="file"
              accept={accept}
              className="sr-only"
              aria-label="Upload a reference document"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f);
                e.target.value = "";
              }}
            />
          </div>
        )}
        {documents.length === 0 ? (
          <EmptyState compact icon={<FileText className="size-5" />} title="No documents yet" description={canEdit ? "Upload price lists, handbooks or FAQs your AI team should know about." : "Documents your team uploads will appear here."} />
        ) : (
          <ul className="-mx-2 divide-y divide-line">
            {documents.map((d) => {
              const kind = fileKind(d.filename, d.mime_type);
              const readable = d.has_text && d.applied_at;
              return (
                <li key={d.id} className="grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 px-2 py-3">
                  <span aria-hidden className={cn("grid size-10 place-items-center rounded-xl text-[10.5px] font-bold tracking-wide ring-1 ring-inset", kind.tone === "violet" ? "bg-violet-soft text-violet-ink ring-violet/15" : kind.tone === "primary" ? "bg-primary-soft text-primary-ink ring-primary/15" : kind.tone === "success" ? "bg-success-soft text-success-ink ring-success/15" : "bg-surface-2 text-ink-2 ring-line-strong")}>
                    {kind.label}
                  </span>
                  <p className="min-w-0 self-center break-words text-[13.5px] font-medium leading-snug text-ink [overflow-wrap:anywhere] line-clamp-2" title={d.filename}>
                    {d.filename}
                  </p>
                  <div className="flex shrink-0 items-center self-center">
                    <a href={`/api/knowledge/documents/${d.id}`} className="grid size-10 place-items-center rounded-xl text-muted transition hover:bg-surface-2 hover:text-ink sm:size-9" aria-label={`Download ${d.filename}`}>
                      <Download className="size-4" />
                    </a>
                    {canEdit && (
                      <button type="button" onClick={() => setConfirm(d)} className="grid size-10 place-items-center rounded-xl text-muted transition hover:bg-danger-soft hover:text-danger-ink sm:size-9" aria-label={`Delete ${d.filename}`}>
                        <Trash2 className="size-4" />
                      </button>
                    )}
                  </div>
                  <div className="col-start-2 col-end-4 flex flex-wrap items-center gap-1.5">
                    {readable ? <StatusPill size="sm" tone="success">Readable by your AI team</StatusPill> : d.has_text ? <StatusPill size="sm" tone="violet">Held for review</StatusPill> : <StatusPill size="sm" tone="neutral">Stored for your team</StatusPill>}
                    <InfoChip icon={<HardDrive aria-hidden />}>{size(d.size_bytes)}</InfoChip>
                    <InfoChip icon={<CalendarDays aria-hidden />}>
                      <span title={formatDateTime(d.created_at, timeZone)}>{formatDate(d.created_at, timeZone)}</span>
                    </InfoChip>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <Notice tone="neutral" icon={<FileText />}>
          <span className="text-[12.5px]">Text-based files (TXT, MD, CSV) are read by your AI team. PDF and Word files are stored securely for reference; ask iAcquire if you need their contents used by AI employees.</span>
        </Notice>
      </Panel>
      <Dialog
        open={Boolean(confirm)}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Delete ${confirm?.filename}?`}
        description="The file is removed from storage and your AI team stops using it."
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                if (!confirm) return;
                const res = await fetch(`/api/knowledge/documents/${confirm.id}`, { method: "DELETE" });
                if (!res.ok) return toast.error((await res.json().catch(() => ({}))).error ?? "Couldn't delete.");
                toast.success("Document deleted");
                setConfirm(null);
                router.refresh();
              }}
            >
              Delete
            </Button>
          </>
        }
      />
    </>
  );
}
