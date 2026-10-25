"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Archive, CheckCircle2, Clock, Download, FileText, History, Loader2, RotateCcw, ShieldAlert, UploadCloud } from "lucide-react";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/status";
import { archiveAqiKnowledgeDocumentAction, createAqiKnowledgeEntryFromDocumentAction, restoreAqiKnowledgeVersionAction, reviewAqiKnowledgeAction } from "@/app/actions/aqi";
import { cn, formatDateTime } from "@/lib/utils";
import type { AqiKnowledgeDocumentView, AqiKnowledgeReviewRow, AqiKnowledgeVersionView } from "@/server/aqi/knowledge-documents";

const FRESHNESS_TONE = { up_to_date: "success", review_due: "warning", needs_attention: "danger", archived: "neutral" } as const;

export function AqiKnowledgeReview({ documents, review, versions }: { documents: AqiKnowledgeDocumentView[]; review: AqiKnowledgeReviewRow[]; versions: AqiKnowledgeVersionView[] }) {
  const router = useRouter();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = React.useState(false);
  const [uploadError, setUploadError] = React.useState<string | null>(null);
  const [lastUpload, setLastUpload] = React.useState<{ document: AqiKnowledgeDocumentView; preview: string | null } | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<Record<string, string>>({});
  const [linking, setLinking] = React.useState<AqiKnowledgeDocumentView | null>(null);
  const [linkDraft, setLinkDraft] = React.useState({ title: "", category: "Platform overview", routePrefix: "" });
  const [historyFor, setHistoryFor] = React.useState<string | null>(null);
  const [compare, setCompare] = React.useState<{ entry: AqiKnowledgeReviewRow; version: AqiKnowledgeVersionView } | null>(null);

  const due = review.filter((entry) => entry.freshness === "review_due").length;
  const attention = review.filter((entry) => entry.freshness === "needs_attention").length;
  const fresh = review.filter((entry) => entry.freshness === "up_to_date").length;

  async function upload(file: File) {
    setUploading(true);
    setUploadError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/aqi/knowledge/documents", { method: "POST", body: form });
      const data = (await res.json().catch(() => ({}))) as { document?: AqiKnowledgeDocumentView; extractedPreview?: string | null; error?: string };
      if (!res.ok || !data.document) throw new Error(data.error ?? "The document could not be uploaded.");
      setLastUpload({ document: data.document, preview: data.extractedPreview ?? null });
      toast.success(data.document.extractionStatus === "ready" ? "Document extracted — review it before creating knowledge" : "Document stored, but no readable text was found");
      router.refresh();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "The document could not be uploaded.");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function reviewEntry(entry: AqiKnowledgeReviewRow, action: "review" | "publish" | "archive") {
    if (busy) return;
    setBusy(`${entry.id}:${action}`);
    const result = await reviewAqiKnowledgeAction(entry.id, { action, note: note[entry.id] ?? null });
    setBusy(null);
    if (!result.ok) return toast.error(result.error);
    toast.success(action === "review" ? "Marked as reviewed" : action === "publish" ? "Knowledge published" : "Knowledge archived");
    router.refresh();
  }

  async function restore(entry: AqiKnowledgeReviewRow, version: AqiKnowledgeVersionView) {
    if (busy) return;
    if (!window.confirm(`Restore version ${version.version} as a new draft? The current content is preserved in history.`)) return;
    setBusy(`${entry.id}:restore:${version.id}`);
    const result = await restoreAqiKnowledgeVersionAction(entry.id, version.id);
    setBusy(null);
    if (!result.ok) return toast.error(result.error);
    toast.success(`Version ${version.version} restored as draft v${result.data.version}`, { description: "Review it before publishing." });
    setCompare(null);
    router.refresh();
  }

  async function archiveDocument(document: AqiKnowledgeDocumentView) {
    if (busy) return;
    setBusy(`doc:${document.id}`);
    const result = await archiveAqiKnowledgeDocumentAction(document.id);
    setBusy(null);
    if (!result.ok) return toast.error(result.error);
    toast.success("Document archived");
    router.refresh();
  }

  async function createEntry() {
    if (!linking || busy) return;
    if (!linkDraft.title.trim()) return toast.error("Add a title for the knowledge entry.");
    setBusy(`link:${linking.id}`);
    const result = await createAqiKnowledgeEntryFromDocumentAction({
      documentId: linking.id,
      title: linkDraft.title,
      category: linkDraft.category.trim() || "Platform overview",
      routePrefix: linkDraft.routePrefix || null,
      roles: [],
    });
    setBusy(null);
    if (!result.ok) return toast.error(result.error);
    toast.success("Draft knowledge entry created", { description: "Edit it in Platform knowledge and publish only after review." });
    setLinking(null);
    setLinkDraft({ title: "", category: "Platform overview", routePrefix: "" });
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Knowledge documents</CardTitle>
              <CardDescription>PDF, DOCX, TXT, Markdown or CSV up to 10 MB. Files are private, validated by their real signature and extracted on the server. Nothing is published automatically.</CardDescription>
            </div>
            <Button size="sm" variant="brand" data-aqi-target="admin.aqi.knowledge-document" loading={uploading} onClick={() => inputRef.current?.click()}><UploadCloud className="size-3.5" /> Upload</Button>
          </CardHeader>
          <CardContent className="space-y-2">
            <input
              ref={inputRef}
              type="file"
              accept=".pdf,.docx,.txt,.md,.csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown,text/csv"
              className="sr-only"
              aria-label="Upload a platform knowledge document"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void upload(file);
              }}
            />
            {uploadError && <p role="alert" className="rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-[12px] text-danger-ink">{uploadError}</p>}
            {uploading && <p className="flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2 text-[12px] text-muted"><Loader2 className="size-3.5 animate-spin text-primary" /> Validating and extracting…</p>}
            {lastUpload && (
              <div className="rounded-xl border border-line bg-surface-2/50 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <FileText className="size-4 text-primary" />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{lastUpload.document.filename}</span>
                  <StatusPill size="sm" tone={lastUpload.document.extractionStatus === "ready" ? "success" : "warning"}>{lastUpload.document.extractionStatus}</StatusPill>
                </div>
                {lastUpload.document.extractionDetail && <p className="mt-1 text-[12px] text-warning-ink">{lastUpload.document.extractionDetail}</p>}
                {lastUpload.document.riskFlags.length > 0 && <p className="mt-1 flex items-start gap-1.5 text-[12px] text-warning-ink"><ShieldAlert className="mt-0.5 size-3.5 shrink-0" /> Content flags: {lastUpload.document.riskFlags.join(", ")}. Extracted text is treated as untrusted evidence.</p>}
                {lastUpload.preview && <p className="mt-2 line-clamp-5 whitespace-pre-wrap rounded-lg bg-surface p-2 text-[12px] leading-relaxed text-muted">{lastUpload.preview}</p>}
                {lastUpload.document.extractionStatus === "ready" && (
                  <Button size="sm" variant="secondary" className="mt-2" onClick={() => { setLinking(lastUpload.document); setLinkDraft({ title: lastUpload.document.filename.replace(/\.[a-z0-9]+$/i, "").slice(0, 160), category: "Platform overview", routePrefix: "" }); }}>
                    Create a draft entry
                  </Button>
                )}
              </div>
            )}
            <ul className="space-y-1.5">
              {documents.length === 0 && <li className="rounded-xl border border-dashed border-line-strong p-3 text-[12px] text-muted">No documents uploaded yet.</li>}
              {documents.map((document) => (
                <li key={document.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-line px-3 py-2">
                  <FileText className="size-3.5 shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{document.filename}</span>
                  <Badge tone={document.extractionStatus === "ready" ? "success" : "warning"}>{document.extractionStatus}</Badge>
                  <span className="text-[12px] text-muted">{document.extractedChars ? `${document.extractedChars.toLocaleString()} chars` : "no text"}</span>
                  {document.knowledgeEntryId ? <Badge tone="primary">linked</Badge> : document.extractionStatus === "ready" ? (
                    <Button size="sm" variant="ghost" onClick={() => { setLinking(document); setLinkDraft({ title: document.filename.replace(/\.[a-z0-9]+$/i, "").slice(0, 160), category: "Platform overview", routePrefix: "" }); }}>Create entry</Button>
                  ) : null}
                  <a href={`/api/aqi/knowledge/documents/${document.id}`} className="inline-flex size-8 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink" aria-label={`Download ${document.filename}`}><Download className="size-3.5" /></a>
                  <button type="button" onClick={() => void archiveDocument(document)} disabled={busy === `doc:${document.id}`} className="inline-flex size-8 items-center justify-center rounded-lg text-muted hover:bg-danger-soft hover:text-danger-ink" aria-label={`Archive ${document.filename}`}><Archive className="size-3.5" /></button>
                </li>
              ))}
            </ul>
            {linking && (
              <div className="rounded-xl border border-primary/25 bg-primary-soft/40 p-3">
                <p className="text-[12px] font-semibold text-primary-ink">Create a draft from “{linking.filename}”</p>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <Field label="Title" htmlFor="link-title"><Input id="link-title" maxLength={160} value={linkDraft.title} onChange={(e) => setLinkDraft({ ...linkDraft, title: e.target.value })} /></Field>
                  <Field label="Category" htmlFor="link-cat"><Input id="link-cat" maxLength={60} value={linkDraft.category} onChange={(e) => setLinkDraft({ ...linkDraft, category: e.target.value })} /></Field>
                  <Field label="Route (optional)" htmlFor="link-route"><Input id="link-route" placeholder="/crm/contacts" value={linkDraft.routePrefix} onChange={(e) => setLinkDraft({ ...linkDraft, routePrefix: e.target.value })} /></Field>
                </div>
                <div className="mt-2 flex gap-1.5">
                  <Button size="sm" variant="brand" loading={busy === `link:${linking.id}`} onClick={() => void createEntry()}>Create draft</Button>
                  <Button size="sm" variant="ghost" onClick={() => setLinking(null)}>Cancel</Button>
                </div>
                <p className="mt-1.5 text-[12px] text-muted">The extracted text is the draft body. Review and edit it before publishing.</p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Freshness review</CardTitle>
              <CardDescription>Based on real review timestamps and configured intervals, not a model confidence score.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="grid grid-cols-3 gap-2">
            <Metric label="Up to date" value={fresh} tone="success" />
            <Metric label="Review due" value={due} tone="warning" />
            <Metric label="Needs attention" value={attention} tone="danger" />
            <div className="col-span-3 rounded-xl bg-surface-2 p-2.5 text-[12px] leading-relaxed text-muted">Review marks an entry as checked and schedules the next review. Publishing also refreshes the review date. Archiving keeps the history.</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Platform knowledge entries</CardTitle>
            <CardDescription>Every entry shows its real source, review state and freshness. A published entry appears in AQi retrieval only when its route and role visibility match the person.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {review.map((entry) => {
            const entryVersions = versions.filter((version) => version.entryId === entry.id);
            return (
            <div key={entry.id} className="rounded-xl border border-line p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-[13px] font-semibold text-ink">
                    <span className="truncate">{entry.title}</span>
                    <StatusPill size="sm" tone={FRESHNESS_TONE[entry.freshness]}>{entry.freshness.replaceAll("_", " ")}</StatusPill>
                    <Badge tone={entry.status === "published" ? "success" : entry.status === "draft" ? "warning" : "neutral"}>{entry.status}</Badge>
                  </p>
                  <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-muted">
                    <span>{entry.category}</span><span aria-hidden>·</span><span>{entry.sourceKind === "document" ? `Document: ${entry.sourceFilename ?? "linked file"}` : entry.source}</span>
                    {entry.routePrefix && <><span aria-hidden>·</span><span>{entry.routePrefix}</span></>}
                    {entry.roles.length > 0 && <><span aria-hidden>·</span><span>Roles: {entry.roles.join(", ")}</span></>}
                  </p>
                  <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-muted">
                    <span className="inline-flex items-center gap-1"><Clock className="size-3" /> Reviewed {entry.lastReviewedAt ? formatDateTime(entry.lastReviewedAt) : "never"}</span>
                    <span>Next review {formatDateTime(entry.reviewDueAt)}</span>
                    {entry.daysOverdue > 0 && <span className="font-medium text-danger-ink">{entry.daysOverdue}d overdue</span>}
                    {entry.updatedBy && <span>Updated by {entry.updatedBy}</span>}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm" variant="secondary" loading={busy === `${entry.id}:review`} onClick={() => void reviewEntry(entry, "review")}><CheckCircle2 className="size-3.5" /> Mark reviewed</Button>
                  {entry.status !== "published" && <Button size="sm" variant="brand" loading={busy === `${entry.id}:publish`} onClick={() => void reviewEntry(entry, "publish")}>Publish</Button>}
                  {entry.status !== "archived" && <Button size="sm" variant="ghost" loading={busy === `${entry.id}:archive`} onClick={() => void reviewEntry(entry, "archive")}><Archive className="size-3.5" /> Archive</Button>}
                </div>
              </div>
              <Input className="mt-2 h-8 text-[12px]" aria-label={`Review note for ${entry.title}`} placeholder="Optional review note (why it changed or was checked)" maxLength={500} value={note[entry.id] ?? ""} onChange={(e) => setNote({ ...note, [entry.id]: e.target.value })} />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button size="sm" variant="ghost" onClick={() => setHistoryFor(historyFor === entry.id ? null : entry.id)} aria-expanded={historyFor === entry.id}>
                  <History className="size-3.5" /> Version history ({entryVersions.length})
                </Button>
                {entryVersions.length === 0 && <span className="text-[12px] text-muted">History starts with the next edit; earlier versions were not stored.</span>}
              </div>
              {historyFor === entry.id && entryVersions.length > 0 && (
                <div className="mt-2 space-y-1.5 rounded-xl border border-line bg-surface-2/50 p-2.5">
                  {entryVersions.map((version) => (
                    <div key={version.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface px-2.5 py-2">
                      <div className="min-w-0">
                        <p className="text-[12px] font-medium text-ink">v{version.version} · {version.title} <Badge tone={version.status === "published" ? "success" : version.status === "draft" ? "warning" : "neutral"}>{version.status}</Badge></p>
                        <p className="mt-0.5 text-[12px] text-muted">{formatDateTime(version.createdAt)}{version.createdBy ? ` · ${version.createdBy}` : ""}{version.changeNote ? ` · ${version.changeNote}` : ""}</p>
                      </div>
                      <div className="flex gap-1.5">
                        <Button size="sm" variant="ghost" onClick={() => setCompare(compare?.version.id === version.id ? null : { entry, version })}>Compare</Button>
                        <Button size="sm" variant="secondary" loading={busy === `${entry.id}:restore:${version.id}`} onClick={() => void restore(entry, version)}><RotateCcw className="size-3.5" /> Restore as draft</Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {compare && compare.entry.id === entry.id && (
                <div className="mt-2 grid gap-2 rounded-xl border border-primary/25 bg-primary-soft/30 p-2.5 sm:grid-cols-2">
                  <div>
                    <p className="text-[12px] font-semibold uppercase tracking-wide text-muted">Restored version v{compare.version.version}</p>
                    <pre className="scrollbar-thin mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-surface p-2 text-[12px] leading-relaxed text-ink-2">{compare.version.body}</pre>
                  </div>
                  <div>
                    <p className="text-[12px] font-semibold uppercase tracking-wide text-muted">Current live content (v{entry.version})</p>
                    <pre className="scrollbar-thin mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-surface p-2 text-[12px] leading-relaxed text-ink-2">{entry.body}</pre>
                  </div>
                  <p className="text-[12px] text-muted sm:col-span-2">Restoring creates a new draft and keeps both versions. Nothing is published automatically.</p>
                </div>
              )}
            </div>
            );
          })}
          {review.length === 0 && <p className="rounded-xl border border-dashed border-line-strong p-3 text-[12px] text-muted">No platform knowledge entries yet.</p>}
        </CardContent>
      </Card>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone: "success" | "warning" | "danger" }) {
  return (
    <div className={cn("rounded-xl border px-2.5 py-2", tone === "success" ? "border-success/25 bg-success-soft/50" : tone === "warning" ? "border-warning/25 bg-warning-soft/50" : "border-danger/25 bg-danger-soft/50")}>
      <p className="text-[12px] font-semibold uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-0.5 text-[20px] font-semibold tabular-nums text-ink">{value}</p>
    </div>
  );
}
