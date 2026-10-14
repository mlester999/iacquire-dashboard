"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { BookOpen, CheckCircle2, ChevronDown, Clock, Download, FileText, Search, ShieldAlert, Trash2, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Textarea } from "@/components/ui/primitives";
import { PageHero, DataToolbar, CoverageBar } from "@/components/ui/workspace";
import { Dialog } from "@/components/ui/overlays";
import { saveKnowledgeAction } from "@/app/actions/knowledge";
import { cn, formatDateTime, relativeTime } from "@/lib/utils";

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

export function KnowledgeCenter({ sections, documents, canEdit, accept, timeZone }: { sections: Section[]; documents: Doc[]; canEdit: boolean; accept: string; timeZone: string }) {
  const filled = sections.filter((s) => s.content.trim()).length;
  const lastApplied = sections.map((s) => s.appliedAt).filter(Boolean).sort().pop() ?? null;
  const [search, setSearch] = React.useState("");
  const [filter, setFilter] = React.useState("all");
  const visible = sections.filter((s) => (filter === "all" || filter === "missing" && !s.content.trim() || filter === "review" && s.held) && `${s.label} ${s.hint} ${s.content}`.toLowerCase().includes(search.toLowerCase()));
  return (
    <div className="module-stack space-y-6">
      <PageHero eyebrow="Your business memory" title="Give your AI team the context to get it right." description="Brief your employees as you would a trusted teammate. Keep approved business facts, preferences and private reference documents together." icon={<BookOpen />} aside={<div className="rounded-2xl border border-line bg-surface/80 p-5"><p className="text-xs font-semibold">{filled} of {sections.length} knowledge sections supplied</p><div className="mt-3"><CoverageBar label="Business knowledge completeness" parts={[{label:"Supplied",count:filled,color:"var(--primary)"},{label:"Missing",count:sections.length-filled,color:"var(--surface-3)"}]} /></div><p className="mt-3 text-[11px] text-muted">{lastApplied ? `Last applied ${relativeTime(lastApplied)}` : "No application timestamp recorded"}</p></div>} />
      <DataToolbar><div className="relative w-full max-w-sm"><Search className="absolute left-3 top-3 size-4 text-muted" /><Input aria-label="Search business knowledge" placeholder="Find a section or business fact…" className="pl-10" value={search} onChange={(e) => setSearch(e.target.value)} /></div><div className="flex flex-wrap gap-1">{[{key:"all",label:"All sections"},{key:"missing",label:"Needs information"},{key:"review",label:"In review"}].map((f) => <Button key={f.key} size="sm" variant={filter === f.key ? "soft" : "ghost"} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>{f.label}</Button>)}</div></DataToolbar>
      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-3 xl:col-span-2">
          {sections.map((s, i) => (
            <div key={s.key} hidden={!visible.some((v) => v.key === s.key)}><SectionEditor section={s} canEdit={canEdit} timeZone={timeZone} defaultOpen={i === 0 || (!s.content && i < 3)} /></div>
          ))}
          {!visible.length && <Card className="p-6 text-center"><p className="text-sm font-semibold">No sections match this view.</p><Button variant="soft" size="sm" className="mt-3" onClick={() => { setFilter("all"); setSearch(""); }}>Show all sections</Button></Card>}
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
  return (
    <Card className={cn("overflow-hidden transition", open && "shadow-float")}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-3 px-5 py-4 text-left">
        <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", section.content ? "bg-success-soft text-success-ink" : "bg-surface-2 text-faint")}>
          {section.content ? <CheckCircle2 className="size-4" /> : <FileText className="size-4" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[14.5px] font-semibold">{section.label}</span>
          <span className="block truncate text-[12.5px] text-muted">{section.content ? section.content.slice(0, 90) : section.hint}</span>
        </span>
        {section.held ? (
          <Badge tone="warning">
            <ShieldAlert className="size-3" /> In review
          </Badge>
        ) : section.appliedAt ? (
          <span className="hidden text-[11.5px] text-faint sm:block">Applied {relativeTime(section.appliedAt)}</span>
        ) : null}
        <ChevronDown className={cn("size-4 shrink-0 text-muted transition-transform", open && "rotate-180")} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22 }} className="overflow-hidden">
            <div className="space-y-3 border-t border-line px-5 pb-5 pt-4">
              <p className="text-[12.5px] text-muted">{section.hint}</p>
              <label htmlFor={`k-${section.key}`} className="sr-only">
                {section.label}
              </label>
              <Textarea id={`k-${section.key}`} rows={6} maxLength={12000} value={value} disabled={!canEdit} onChange={(e) => setValue(e.target.value)} />
              {section.held && <p className="rounded-xl bg-warning-soft px-3 py-2 text-[12.5px] text-warning-ink">This update is waiting for a quick iAcquire review because it may conflict with AI safety rules. Your AI team keeps using the previous approved knowledge until then.</p>}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-[12px] text-faint">
                  <Clock className="size-3.5" />
                  {section.updatedAt ? `v${section.version} · ${section.updatedBy ?? "Someone"} · ${formatDateTime(section.updatedAt, timeZone)}` : "Not written yet"}
                </span>
                {canEdit && (
                  <div className="flex gap-2">
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
    <Card className="self-start">
      <CardHeader>
        <div>
          <CardTitle>Reference documents</CardTitle>
          <CardDescription>Private to your workspace. PDF, Word, text, Markdown or CSV up to 10 MB.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
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
            className={cn("flex flex-col items-center rounded-2xl border-2 border-dashed px-4 py-7 text-center transition", drag ? "border-primary bg-primary-soft/40" : "border-line")}
          >
            <UploadCloud className="size-7 text-primary" />
            <p className="mt-2 text-[13.5px] font-medium">{uploading ? `Uploading ${uploading}…` : "Drop a file here"}</p>
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
          <p className="py-4 text-center text-[13px] text-muted">No documents yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {documents.map((d) => (
              <li key={d.id} className="flex items-center gap-3 py-2.5">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-ink-2">
                  <FileText className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium">{d.filename}</p>
                  <p className="text-[11.5px] text-muted">
                    {size(d.size_bytes)} · {d.has_text && d.applied_at ? "Readable by your AI team" : d.has_text ? "Held for review" : "Stored for your team"} · {formatDateTime(d.created_at, timeZone)}
                  </p>
                </div>
                <a href={`/api/knowledge/documents/${d.id}`} className="flex size-8 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink" aria-label={`Download ${d.filename}`}>
                  <Download className="size-4" />
                </a>
                {canEdit && (
                  <button type="button" onClick={() => setConfirm(d)} className="flex size-8 items-center justify-center rounded-lg text-muted hover:bg-danger-soft hover:text-danger-ink" aria-label={`Delete ${d.filename}`}>
                    <Trash2 className="size-4" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="text-[11.5px] leading-relaxed text-faint">Text-based files (TXT, MD, CSV) are read by your AI team. PDF and Word files are stored securely for reference; ask iAcquire if you need their contents used by AI employees.</p>
      </CardContent>
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
    </Card>
  );
}
