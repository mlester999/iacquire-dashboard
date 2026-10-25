"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  Download,
  FileText,
  Pencil,
  Plus,
  ShieldAlert,
  Trash2,
  UploadCloud,
  Users,
} from "lucide-react";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Textarea } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { GuidedField } from "@/components/ui/guided-field";
import { Dialog } from "@/components/ui/overlays";
import { KNOWLEDGE_GUIDANCE } from "@/lib/employee-field-guidance";
import {
  archiveEmployeeKnowledgeEntryAction,
  assignKnowledgeDocumentAction,
  reprocessKnowledgeDocumentAction,
  saveEmployeeKnowledgeEntryAction,
  unassignKnowledgeDocumentAction,
} from "@/app/actions/workforce-knowledge";
import type { EmployeeKnowledgeDocument, EmployeeKnowledgeEntry, EmployeeKnowledgeView } from "@/server/workforce/knowledge";
import { cn, formatDateTime, relativeTime } from "@/lib/utils";

function size(bytes: number) {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function documentState(doc: EmployeeKnowledgeDocument) {
  if (doc.status === "processing") return { label: "Processing", tone: "primary" as const, detail: doc.processing_detail ?? "Reading the document…" };
  if (doc.status === "failed") return { label: "Could not read", tone: "danger" as const, detail: doc.processing_detail ?? "Text extraction failed. Upload a text version or try again." };
  if (doc.status === "unsupported") return { label: "Not searchable", tone: "warning" as const, detail: doc.processing_detail ?? "This file type or document can't be read automatically. OCR isn't supported." };
  if (doc.searchable) return { label: "Ready to use", tone: "success" as const, detail: doc.last_used_at ? `Last used ${relativeTime(doc.last_used_at)}` : "Included in the next conversation" };
  if (doc.risk_flags.length) return { label: "Held for review", tone: "warning" as const, detail: "May conflict with AI safety policy. It is not given to the employee until iAcquire reviews it." };
  if (doc.status !== "ready") return { label: "Not ready", tone: "neutral" as const, detail: "This file is still being processed." };
  return { label: "Stored only", tone: "neutral" as const, detail: "No readable text could be extracted, so it is stored securely for your team but not used in conversations." };
}

export function EmployeeKnowledge({
  agentId,
  agentName,
  data,
  canEdit,
  accept,
  timeZone,
}: {
  agentId: string;
  agentName: string;
  data: EmployeeKnowledgeView;
  canEdit: boolean;
  accept: string;
  timeZone: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = React.useState<EmployeeKnowledgeEntry | "new" | null>(null);
  const [archiving, setArchiving] = React.useState<EmployeeKnowledgeEntry | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [fileError, setFileError] = React.useState<string | null>(null);

  const includedEntries = new Set(data.retrieval.includedEntryIds);
  const includedDocuments = new Set(data.retrieval.includedDocumentIds);
  const shared = data.documents.filter((d) => d.agent_instance_id === null);
  const assigned = data.documents.filter((d) => d.agent_instance_id === agentId);

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-line bg-surface p-4">
          <p className="text-[12px] font-medium uppercase tracking-wide text-muted">Included next conversation</p>
          <p className="mt-1 text-[22px] font-semibold tracking-tight">{data.retrieval.includedEntryIds.length + data.retrieval.includedDocumentIds.length}</p>
          <p className="mt-0.5 text-[12px] text-muted">employee notes and reference files</p>
        </div>
        <div className="rounded-2xl border border-line bg-surface p-4">
          <p className="text-[12px] font-medium uppercase tracking-wide text-muted">Employee notes</p>
          <p className="mt-1 text-[22px] font-semibold tracking-tight">{data.entries.filter((e) => e.status === "approved").length}</p>
          <p className="mt-0.5 text-[12px] text-muted">approved and versioned</p>
        </div>
        <div className="rounded-2xl border border-line bg-surface p-4">
          <p className="text-[12px] font-medium uppercase tracking-wide text-muted">Instruction size</p>
          <p className="mt-1 text-[22px] font-semibold tracking-tight">{data.retrieval.characters.toLocaleString()}</p>
          <p className="mt-0.5 text-[12px] text-muted">characters of knowledge context</p>
        </div>
      </div>

      {data.retrieval.truncated && (
        <p className="flex items-start gap-2 rounded-xl border border-warning/25 bg-warning-soft/40 p-3 text-[12.5px] text-warning-ink">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> The knowledge budget is full. Some sources are shortened or left out of conversations. Remove or shorten lower-value knowledge to make room.
        </p>
      )}

      <div className="grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-2"><BookOpen className="size-4" /> Employee notes</CardTitle>
              <CardDescription>Facts, preferences and rules that only {agentName} should use. Each edit keeps its previous version.</CardDescription>
            </div>
            {canEdit && (
              <Button size="sm" variant="secondary" onClick={() => setEditing("new")}>
                <Plus className="size-3.5" aria-hidden /> Add note
              </Button>
            )}
          </CardHeader>
          <CardContent>
            {data.entries.length === 0 ? (
              <div className="rounded-xl border border-dashed border-line-strong p-6 text-center">
                <p className="text-[13px] font-medium">No employee notes yet</p>
                <p className="mt-1 text-[12.5px] leading-relaxed text-muted">Add a short, specific note such as approved service areas or how this employee should handle a particular request.</p>
              </div>
            ) : (
              <ul className="divide-y divide-line">
                {data.entries.map((entry) => {
                  const included = includedEntries.has(entry.id);
                  return (
                    <li key={entry.id} className="py-3">
                      <div className="flex flex-wrap items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-[13.5px] font-semibold">{entry.title}</p>
                          <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-relaxed text-muted">{entry.content}</p>
                        </div>
                        <Badge tone={entry.status === "approved" ? (included ? "success" : "warning") : "warning"}>
                          {entry.status === "approved" ? (included ? "In next run" : "Not included") : entry.status === "pending_agency_review" ? "In review" : "Not used"}
                        </Badge>
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-faint">
                        <span>v{entry.version}</span>
                        <span>Updated {formatDateTime(entry.updated_at, timeZone)}</span>
                        {entry.last_used_at && <span className="text-success-ink">Used {relativeTime(entry.last_used_at)}</span>}
                        {entry.risk_flags.length > 0 && <span className="text-warning-ink">Held for review</span>}
                        {canEdit && (
                          <span className="ml-auto flex items-center gap-1">
                            <button type="button" onClick={() => setEditing(entry)} className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 hover:bg-surface-2 hover:text-ink">
                              <Pencil className="size-3" aria-hidden /> Edit
                            </button>
                            <button type="button" onClick={() => setArchiving(entry)} className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 hover:bg-danger-soft hover:text-danger-ink">
                              <Trash2 className="size-3" aria-hidden /> Remove
                            </button>
                          </span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-2"><FileText className="size-4" /> Reference documents</CardTitle>
              <CardDescription>Upload a file for this employee, or use a shared document from the Knowledge Center. Text is extracted before use.</CardDescription>
            </div>
            {canEdit && (
              <label className={cn("inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-xl border border-line bg-surface px-3 text-[12.5px] font-medium text-ink-2 hover:bg-surface-2", uploading && "pointer-events-none opacity-60")}>
                <UploadCloud className="size-3.5" aria-hidden /> {uploading ? "Uploading…" : "Upload"}
                <input
                  type="file"
                  className="sr-only"
                  aria-label="Upload a knowledge document"
                  accept={accept}
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (!file) return;
                    setUploading(true);
                    setFileError(null);
                    const form = new FormData();
                    form.set("file", file);
                    form.set("agentId", agentId);
                    try {
                      const res = await fetch("/api/knowledge/upload", { method: "POST", body: form });
                      const body = await res.json().catch(() => ({}));
                      if (!res.ok) throw new Error(body.error ?? "The file couldn't be uploaded.");
                      if (body.status === "failed" || body.status === "unsupported") {
                        toast.warning("Document stored, but its text couldn't be read", { description: body.processingDetail ?? "Upload a text version if you need it used in conversations." });
                      } else if (body.held) {
                        toast.warning("Uploaded, but held for review", { description: "It may conflict with AI safety policy, so it is not used until iAcquire reviews it." });
                      } else {
                        toast.success("Document added", { description: "Its extracted text is now available to this employee." });
                      }
                      router.refresh();
                    } catch (err) {
                      setFileError(err instanceof Error ? err.message : "The file couldn't be uploaded.");
                    } finally {
                      setUploading(false);
                    }
                  }}
                />
              </label>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="rounded-xl border border-line bg-surface-2/60 p-3 text-[12px] leading-relaxed text-muted">
              {KNOWLEDGE_GUIDANCE.upload.description}
            </p>
            {fileError && (
              <p className="flex items-start gap-2 rounded-xl border border-danger/25 bg-danger-soft/40 p-3 text-[12.5px] text-danger-ink" role="alert">
                <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden /> {fileError}
              </p>
            )}
            <div>
              <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted">For this employee</p>
              {assigned.length === 0 ? <p className="text-[12.5px] text-muted">No documents assigned only to this employee.</p> : (
                <ul className="divide-y divide-line">
                  {assigned.map((doc) => <DocumentRow key={doc.id} doc={doc} included={includedDocuments.has(doc.id)} canEdit={canEdit} agentId={agentId} timeZone={timeZone} onChanged={() => router.refresh()} />)}
                </ul>
              )}
            </div>
            <div>
              <p className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-muted"><Users className="size-3" aria-hidden /> Shared with every employee</p>
              {shared.length === 0 ? <p className="text-[12.5px] text-muted">No shared documents yet. <Link href="/knowledge" className="text-primary hover:underline">Open Knowledge Center</Link>.</p> : (
                <ul className="divide-y divide-line">
                  {shared.map((doc) => <DocumentRow key={doc.id} doc={doc} included={includedDocuments.has(doc.id)} canEdit={canEdit} agentId={agentId} timeZone={timeZone} onChanged={() => router.refresh()} shared />)}
                </ul>
              )}
            </div>
            <p className="text-[12px] leading-relaxed text-faint">
              TXT, Markdown, CSV, selectable-text PDF and Word (.docx) files are read after extraction. Encrypted, scanned/image-only PDFs and damaged files stay downloadable but are not used; OCR isn&apos;t supported. A document is never shown as used until it is included in the run instructions.
            </p>
          </CardContent>
        </Card>
      </div>

      <NoteDialog
        key={editing === "new" ? "new" : editing?.id ?? "closed"}
        open={Boolean(editing)}
        onOpenChange={(open) => !open && setEditing(null)}
        agentId={agentId}
        entry={editing === "new" ? null : editing}
        onSaved={() => {
          setEditing(null);
          router.refresh();
        }}
      />
      <Dialog
        open={Boolean(archiving)}
        onOpenChange={(open) => !open && setArchiving(null)}
        title={`Remove “${archiving?.title ?? "this note"}”?`}
        description="The note stops being used in conversations. Its history stays in the audit record so an administrator can review what changed."
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setArchiving(null)}>Cancel</Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={async () => {
                if (!archiving) return;
                setBusy(true);
                const res = await archiveEmployeeKnowledgeEntryAction(agentId, archiving.id);
                setBusy(false);
                if (!res.ok) return toast.error(res.error);
                toast.success("Note removed");
                setArchiving(null);
                router.refresh();
              }}
            >
              Remove note
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-muted">This does not delete the employee, its conversations or any other knowledge.</p>
      </Dialog>
    </div>
  );
}

function DocumentRow({
  doc,
  included,
  canEdit,
  agentId,
  timeZone,
  shared,
  onChanged,
}: {
  doc: EmployeeKnowledgeDocument;
  included: boolean;
  canEdit: boolean;
  agentId: string;
  timeZone: string;
  shared?: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const state = documentState(doc);
  return (
    <li className="flex items-start gap-2.5 py-2.5">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-ink-2"><FileText className="size-4" aria-hidden /></span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12.5px] font-medium">{doc.filename}</p>
        <p className="text-[12px] text-muted">{size(doc.size_bytes)} · {state.detail}</p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <Badge tone={state.tone}>{state.label}</Badge>
          {doc.extraction_method === "pdf" && <Badge tone="neutral">PDF text</Badge>}
          {doc.extraction_method === "docx" && <Badge tone="neutral">Word text</Badge>}
          {included && <Badge tone="success">In next run</Badge>}
          {shared && <Badge tone="neutral">Shared</Badge>}
          <span className="text-[12px] text-faint">{formatDateTime(doc.created_at, timeZone)}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <a href={`/api/knowledge/documents/${doc.id}`} className="flex size-8 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink" aria-label={`Download ${doc.filename}`}>
          <Download className="size-3.5" aria-hidden />
        </a>
        {canEdit && ["failed", "unsupported", "processing"].includes(doc.status) && (
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const res = await reprocessKnowledgeDocumentAction(doc.id);
              setBusy(false);
              if (!res.ok) return toast.error(res.error);
              if (res.data.status === "ready") toast.success("Document text is ready");
              else toast.warning("Still not searchable", { description: res.data.processingDetail ?? "Upload a text version if you need it used in conversations." });
              onChanged();
            }}
            className="flex min-h-8 items-center rounded-lg px-2 text-[12px] font-medium text-primary hover:bg-surface-2 disabled:opacity-50"
          >
            Retry
          </button>
        )}
        {canEdit && (
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const res = shared ? await assignKnowledgeDocumentAction(agentId, doc.id) : await unassignKnowledgeDocumentAction(agentId, doc.id);
              setBusy(false);
              if (!res.ok) return toast.error(res.error);
              toast.success(shared ? "Document assigned to this employee" : "Document returned to the shared library");
              onChanged();
            }}
            className="flex min-h-8 items-center rounded-lg px-2 text-[12px] font-medium text-primary hover:bg-surface-2 disabled:opacity-50"
          >
            {shared ? "Assign" : "Share"}
          </button>
        )}
      </div>
    </li>
  );
}

function NoteDialog({
  open,
  onOpenChange,
  agentId,
  entry,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
  entry: EmployeeKnowledgeEntry | null;
  onSaved: () => void;
}) {
  const [title, setTitle] = React.useState(entry?.title ?? "");
  const [content, setContent] = React.useState(entry?.content ?? "");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    const res = await saveEmployeeKnowledgeEntryAction(agentId, { id: entry?.id ?? null, title, content });
    setSaving(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    if (res.data.status === "pending_agency_review") toast.warning("Saved for iAcquire review", { description: "It is not used until the safety review clears it." });
    else toast.success(entry ? "Note updated" : "Note added", { description: "It is included in the employee's next conversation, if the knowledge budget allows." });
    onSaved();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={entry ? "Edit employee note" : "Add employee knowledge"}
      description="Write facts or preferences this employee should know. Do not paste passwords, API keys or another company's data."
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="brand" loading={saving} disabled={!title.trim() || !content.trim()} onClick={save}>{entry ? "Save note" : "Add note"}</Button>
        </>
      }
    >
        <div className="space-y-3">
          {error && <p className="rounded-xl border border-danger/25 bg-danger-soft/40 p-3 text-[12.5px] text-danger-ink" role="alert">{error}</p>}
          <GuidedField id="knowledge-title" label="Title" guidance={KNOWLEDGE_GUIDANCE.title} required charLimit={160} valueLength={title.length}>
            <Input maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} autoFocus />
          </GuidedField>
          <GuidedField id="knowledge-content" label="What should the employee know?" guidance={KNOWLEDGE_GUIDANCE.content} required charLimit={40000} valueLength={content.length}>
            <Textarea rows={7} maxLength={40000} value={content} onChange={(event) => setContent(event.target.value)} />
          </GuidedField>
          <p className="flex items-start gap-2 rounded-xl bg-surface-2 p-3 text-[12px] leading-relaxed text-muted">
            <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden /> This knowledge is scoped to this employee in this workspace. It is never shared with another client.
          </p>
        </div>
    </Dialog>
  );
}
