"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { BookOpen, Check, Clock3, Eye, FileText, ShieldCheck, X } from "lucide-react";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import {
  importGrowthPartnerLegacyKnowledgeAction,
  previewGrowthPartnerLegacyKnowledgeAction,
  reviewGrowthPartnerLegacyKnowledgeAction,
} from "@/app/actions/ai-growth-partner";
import type {
  GrowthPartnerLegacyKnowledgeCandidate,
  GrowthPartnerLegacyKnowledgeImport,
  GrowthPartnerLegacyKnowledgeReview,
  GrowthPartnerLegacyKnowledgeStatus,
} from "@/server/ai-growth-partner/legacy-knowledge";

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date) : "Date unavailable";
}

function statusTone(status: GrowthPartnerLegacyKnowledgeStatus): "neutral" | "success" | "warning" {
  return status === "approved" ? "success" : status === "pending_review" ? "warning" : "neutral";
}

function statusLabel(status: GrowthPartnerLegacyKnowledgeStatus) {
  return status === "pending_review" ? "Needs review" : status === "approved" ? "Approved for Partner context" : "Not shared with Partner";
}

export function GrowthPartnerLegacyKnowledgeReview({ data }: { data: GrowthPartnerLegacyKnowledgeReview }) {
  const router = useRouter();
  const [preview, setPreview] = React.useState<{ key: string; title: string; content: string; status: string } | null>(null);
  const [busyKey, setBusyKey] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);

  async function previewCandidate(candidate: GrowthPartnerLegacyKnowledgeCandidate) {
    const key = `candidate:${candidate.sourceType}:${candidate.sourceId}`;
    setBusyKey(key);
    setError(null);
    setMessage(null);
    try {
      const result = await previewGrowthPartnerLegacyKnowledgeAction({ kind: "candidate", sourceType: candidate.sourceType, sourceId: candidate.sourceId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPreview({ key, ...result.data });
    } catch {
      setError("The source could not be loaded. Refresh and try again.");
    } finally {
      setBusyKey(null);
    }
  }

  async function previewImport(item: GrowthPartnerLegacyKnowledgeImport) {
    const key = `import:${item.id}`;
    setBusyKey(key);
    setError(null);
    setMessage(null);
    try {
      const result = await previewGrowthPartnerLegacyKnowledgeAction({ kind: "import", importId: item.id });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPreview({ key, ...result.data });
    } catch {
      setError("The saved snapshot could not be loaded. Refresh and try again.");
    } finally {
      setBusyKey(null);
    }
  }

  async function importCandidate(candidate: GrowthPartnerLegacyKnowledgeCandidate) {
    const key = `candidate:${candidate.sourceType}:${candidate.sourceId}`;
    setBusyKey(key);
    setError(null);
    setMessage(null);
    try {
      const result = await importGrowthPartnerLegacyKnowledgeAction({
        sources: [{ sourceType: candidate.sourceType, sourceId: candidate.sourceId, sourceVersion: candidate.sourceVersion }],
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPreview(null);
      setMessage(result.data.imported ? "Saved as a review-only snapshot. The original profile record is unchanged." : "That exact source version is already in the review history.");
      router.refresh();
    } catch {
      setError("The source could not be added to the review queue. Try again.");
    } finally {
      setBusyKey(null);
    }
  }

  async function decide(item: GrowthPartnerLegacyKnowledgeImport, status: "approved" | "rejected") {
    const key = `decision:${item.id}`;
    setBusyKey(key);
    setError(null);
    setMessage(null);
    try {
      const result = await reviewGrowthPartnerLegacyKnowledgeAction({ importId: item.id, status });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMessage(status === "approved"
        ? "Approved. This snapshot is available to the Growth Partner when its runtime is used."
        : "Removed from the Growth Partner context. The saved snapshot remains in review history.");
      if (preview?.key === `import:${item.id}`) setPreview(null);
      router.refresh();
    } catch {
      setError("That review decision could not be saved. Refresh and try again.");
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <Card className="border border-line bg-surface shadow-soft">
      <CardHeader className="items-start">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-violet-soft text-violet-ink"><BookOpen className="size-5" aria-hidden /></div>
        <div className="min-w-0 flex-1">
          <CardTitle>Retained profile knowledge</CardTitle>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">Bring approved notes and released reference excerpts into the unified Partner&apos;s review queue. Source records remain in place.</p>
        </div>
        <Badge tone={data.imports.some((item) => item.status === "pending_review") ? "warning" : "neutral"}>
          {data.imports.filter((item) => item.status === "pending_review").length} to review
        </Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-start gap-2 rounded-lg border border-primary/15 bg-primary-soft/25 px-3 py-2.5 text-[12px] leading-relaxed text-ink-2">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
          <p>Only approved, risk-free notes and released, risk-free documents are eligible. Imported snapshots stay out of Partner context until approved. At runtime, the 24 most recently reviewed snapshots can be considered within the existing knowledge limits. Rejected snapshots and source records are retained.</p>
        </div>

        {error && <p role="alert" className="rounded-lg border border-danger/20 bg-danger-soft px-3 py-2 text-[13px] text-danger-ink">{error}</p>}
        {message && <p role="status" className="rounded-lg border border-success/20 bg-success-soft px-3 py-2 text-[13px] text-success-ink">{message}</p>}

        {data.candidates.length > 0 ? (
          <div className="space-y-2">
            <h3 className="text-[13px] font-semibold text-ink">Available source records ({data.candidates.length})</h3>
            {data.candidates.map((candidate) => {
              const key = `candidate:${candidate.sourceType}:${candidate.sourceId}`;
              const isPreview = preview?.key === key;
              return (
                <div key={key} className="rounded-xl border border-line bg-surface-2/35 p-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-[13px] font-medium text-ink">{candidate.title}</p>
                      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
                        <span>{candidate.roleLabel}</span><span aria-hidden>·</span>
                        <span>{candidate.sourceType === "employee_note" ? "Approved profile note" : "Released reference excerpt"}</span><span aria-hidden>·</span>
                        <span>{dateLabel(candidate.updatedAt)}</span>
                      </p>
                      <p className="mt-2 line-clamp-2 break-words text-[12px] leading-relaxed text-muted">{candidate.preview}</p>
                    </div>
                    <Button type="button" variant="secondary" size="sm" loading={busyKey === key} onClick={() => void previewCandidate(candidate)}>
                      <Eye className="size-3.5" aria-hidden /> Preview
                    </Button>
                  </div>
                  {isPreview && (
                    <div className="mt-3 space-y-3 rounded-lg border border-line bg-surface p-3">
                      <div className="flex items-center gap-2 text-[12px] font-medium text-ink-2"><FileText className="size-4 text-primary" aria-hidden />Source preview</div>
                      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-2/60 p-3 text-[12px] leading-relaxed text-ink-2">{preview.content}</pre>
                      {candidate.sourceType === "reference_document" && <p className="text-[12px] leading-relaxed text-muted">This matches the first 3,000 characters used as a reference excerpt. The original document stays unchanged.</p>}
                      <div className="flex flex-wrap gap-2">
                        <Button type="button" size="sm" loading={busyKey === key} onClick={() => void importCandidate(candidate)}>
                          Add to review queue
                        </Button>
                        <Button type="button" variant="ghost" size="sm" disabled={busyKey === key} onClick={() => setPreview(null)}>Close preview</Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="rounded-lg border border-line bg-surface-2/40 px-3 py-3 text-[13px] leading-relaxed text-muted">No additional eligible source records are waiting. Pending, held, rejected, and unprocessed records remain in their original workspace locations.</p>
        )}

        {data.imports.length > 0 && (
          <div className="space-y-2 border-t border-line pt-4">
            <div className="flex items-center gap-2"><Clock3 className="size-4 text-muted" aria-hidden /><h3 className="text-[13px] font-semibold text-ink">Review history ({data.imports.length})</h3></div>
            {data.imports.map((item) => {
              const key = `import:${item.id}`;
              const isPreview = preview?.key === key;
              return (
                <div key={item.id} className="rounded-xl border border-line bg-surface-2/35 p-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-[13px] font-medium text-ink">{item.title}</p>
                      <p className="mt-1 text-[12px] text-muted">{item.roleLabel} · {item.sourceType === "employee_note" ? "Profile note" : "Reference excerpt"} · Added {dateLabel(item.createdAt)}</p>
                    </div>
                    <Badge tone={statusTone(item.status)}>{statusLabel(item.status)}</Badge>
                    <Button type="button" variant="secondary" size="sm" loading={busyKey === key} onClick={() => void previewImport(item)}>
                      <Eye className="size-3.5" aria-hidden /> Review
                    </Button>
                  </div>
                  {isPreview && (
                    <div className="mt-3 space-y-3 rounded-lg border border-line bg-surface p-3">
                      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-2/60 p-3 text-[12px] leading-relaxed text-ink-2">{preview.content}</pre>
                      {item.status !== "pending_review" && <p className="text-[12px] leading-relaxed text-muted">This saved decision can be changed. Rejected snapshots are not sent to the Partner.</p>}
                      <div className="flex flex-wrap gap-2">
                        {item.status !== "approved" && <Button type="button" size="sm" loading={busyKey === `decision:${item.id}`} onClick={() => void decide(item, "approved")}><Check className="size-3.5" aria-hidden /> Approve for Partner</Button>}
                        {item.status !== "rejected" && <Button type="button" variant="secondary" size="sm" loading={busyKey === `decision:${item.id}`} onClick={() => void decide(item, "rejected")}><X className="size-3.5" aria-hidden /> Keep out of Partner context</Button>}
                        {item.status === "pending_review" && <span className="self-center text-[12px] text-muted">Review each snapshot before approval.</span>}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
