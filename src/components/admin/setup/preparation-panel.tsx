"use client";
import * as React from "react";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Archive, CheckCircle2, Clock, Hourglass, Layers, Loader2, RefreshCw, RotateCw, ShieldCheck, TriangleAlert, UserCheck } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState, Select, Textarea } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/overlays";
import { Button } from "@/components/ui/button";
import { InfoChip, StatusPill, type StatusTone } from "@/components/ui/status";
import { Callout, IconTile } from "@/components/admin/setup/ui";
import { formatDate, formatDateTime } from "@/lib/utils";
import { prepareClientAction, retryPreparationAction, retirePreparationAction } from "@/app/(admin)/admin/provisioning-actions";
import type { PreparationOperation } from "@/server/setup/jobs";

const OPERATIONS: Array<{ key: PreparationOperation; label: string }> = [
  { key: "prepare_ai_configuration", label: "Prepare AI configuration drafts" },
  { key: "prepare_automation_configuration", label: "Prepare safe automation configuration" },
  { key: "manual_ghl_mapping", label: "Prepare manual CRM mapping task" },
  { key: "manual_hermes_profiles", label: "Prepare dedicated profile runbook" },
  { key: "verify_integrations", label: "Verify configured integrations" },
];
export interface JobView {
  id: string; operation: PreparationOperation; label: string; status: string; attempts: number; maxAttempts: number;
  detail: string | null; retryAt: string | null; updatedAt: string;
  history: Array<{ number: number; status: string; startedAt: string; finishedAt: string | null; error: string | null }>;
  retirement: { reason: string; at: string; supersededBy: string | null } | null;
}
const STATUS: Record<string, { label: string; tone: StatusTone; icon: React.ReactNode }> = {
  queued: { label: "Queued", tone: "neutral", icon: <Hourglass /> },
  running: { label: "Running", tone: "primary", icon: <Loader2 className="animate-spin [animation-duration:2.6s] motion-reduce:animate-none" /> },
  awaiting_admin: { label: "Agency action needed", tone: "warning", icon: <UserCheck /> },
  succeeded: { label: "Prepared", tone: "success", icon: <CheckCircle2 /> },
  failed: { label: "Failed — review required", tone: "danger", icon: <TriangleAlert /> },
  cancelled: { label: "Retired", tone: "neutral", icon: <Archive /> },
};
/** Preparation times are shown in the agency's own zone, in the same format as the rest of the portal. */
const TZ = "Asia/Singapore";
export function PreparationPanel({ orgId, jobs }: { orgId: string; jobs: JobView[] }) {
  const [operation, setOperation] = useState<PreparationOperation>("prepare_ai_configuration");
  const [pending, start] = useTransition();
  const [retiring, setRetiring] = useState<JobView | null>(null);
  const [reason, setReason] = useState("");
  const [supersededBy, setSupersededBy] = useState("");
  const router = useRouter();
  const run = (job?: JobView) => start(async () => {
    const result = job ? await retryPreparationAction(orgId, job.id) : await prepareClientAction(orgId, operation, `agency:${crypto.randomUUID()}`);
    if (!result.ok) toast.error(result.error); else toast.success("Preparation history updated.");
    router.refresh();
  });
  const retire = () => {
    if (!retiring) return;
    start(async () => {
      const result = await retirePreparationAction(orgId, retiring.id, { reason, ...(supersededBy ? { supersededBy } : {}) });
      if (!result.ok) toast.error(result.error);
      else { toast.success("Job retired. Its attempts and audit history are preserved."); setRetiring(null); }
      router.refresh();
    });
  };
  return <Card>
    <CardHeader><div className="flex min-w-0 items-start gap-3"><IconTile icon={<Layers />} tone="primary" /><div className="min-w-0"><CardTitle>Provisioning preparation</CardTitle><CardDescription>Persistent preparation jobs and attempts for this client. Provider readiness is verified separately.</CardDescription></div></div>{jobs.length > 0 && <InfoChip>{jobs.length} {jobs.length === 1 ? "job" : "jobs"}</InfoChip>}</CardHeader>
    <CardContent>
      <Callout tone="primary" icon={<ShieldCheck />} className="mb-4">Drafts and validation only. Remote profiles, CRM writes, messaging and workflow activation require separate authorization.</Callout>
      <div className="mb-5 flex flex-col gap-2 sm:flex-row"><label className="min-w-0 flex-1"><span className="sr-only">Preparation operation</span><Select value={operation} onChange={(e) => setOperation(e.target.value as PreparationOperation)}>{OPERATIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}</Select></label><Button disabled={pending} onClick={() => run()}>Prepare / verify</Button></div>
      {jobs.length === 0 && <EmptyState compact icon={<Layers className="size-5" />} title="No preparation jobs yet" description="Company onboarding will queue the initial preparation steps." />}
      <div className="space-y-3">{jobs.map((job) => { const st = STATUS[job.status] ?? { label: job.status.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()), tone: "neutral" as const, icon: <Layers /> }; const open = ["queued", "failed", "awaiting_admin", "running"].includes(job.status); return <section key={job.id} className={`min-w-0 rounded-xl border p-4 transition-colors ${job.status === "failed" ? "border-danger/25 bg-danger-soft/10" : "border-line hover:border-line-strong"}`}>
        <div className="flex flex-wrap items-start gap-3"><IconTile icon={st.icon} tone={st.tone} size="sm" /><div className="min-w-0 flex-1 basis-44"><h3 className="text-sm font-semibold text-ink">{job.label}</h3><div className="mt-1.5 flex flex-wrap items-center gap-1.5"><InfoChip icon={<RotateCw />} className="h-5 text-[12px]">Attempt {job.attempts} of {job.maxAttempts}</InfoChip><InfoChip icon={<Clock />} className="h-5 text-[12px]"><time dateTime={job.updatedAt}>Updated {formatDate(job.updatedAt, TZ)}</time></InfoChip></div></div><StatusPill tone={st.tone} className="ml-11 sm:ml-0">{st.label}</StatusPill></div>
        {job.detail && <Callout tone={job.status === "failed" ? "danger" : "neutral"} className="mt-3 text-[13px]">{job.detail}</Callout>}
        {job.status === "failed" && job.attempts >= job.maxAttempts && <Callout tone="warning" icon={<TriangleAlert />} className="mt-2 px-3 py-2 text-[12.5px]">Retry limit reached. Review the attempts and retire this job with a reason before preparing a replacement.</Callout>}
        {job.retryAt && <Callout tone="neutral" icon={<Clock />} className="mt-2 px-3 py-2 text-[12.5px]">Retry available after <time dateTime={job.retryAt}>{formatDateTime(job.retryAt, TZ)} SGT</time>.</Callout>}
        {open && <div className="mt-3 flex flex-wrap gap-2"><Button variant="secondary" size="sm" disabled={pending || (job.status !== "running" && job.attempts >= job.maxAttempts)} onClick={() => run(job)}><RefreshCw className="size-3.5" />{job.status === "queued" ? "Start" : job.status === "running" ? "Recover expired attempt" : "Retry / review"}</Button><Button variant="outline" size="sm" disabled={pending} onClick={() => { setReason(""); setSupersededBy(""); setRetiring(job); }}>Review retirement</Button></div>}
        {job.history.length > 0 && <details className="group mt-3 rounded-lg bg-surface-2/50 px-3 py-2 text-xs text-muted ring-1 ring-inset ring-line"><summary className="flex min-h-8 cursor-pointer list-none items-center justify-between gap-2 font-medium text-ink-2 [&::-webkit-details-marker]:hidden">Attempt history<InfoChip className="h-5 text-[12px] font-normal">{job.history.length} {job.history.length === 1 ? "attempt" : "attempts"}</InfoChip></summary><ol className="mt-2 space-y-2 border-t border-line pt-2">{job.history.map((a) => <li key={a.number} className="break-words"><div className="flex flex-wrap items-center gap-2"><span className="font-mono text-[12px] tabular-nums text-ink-2">#{a.number}</span><StatusPill status={a.status} size="sm" /><time className="text-[12px]" dateTime={a.startedAt}>{formatDateTime(a.startedAt, TZ)}</time></div>{a.error && <p className="mt-1 text-[12px] leading-relaxed">{a.error}</p>}</li>)}</ol></details>}
        {job.retirement && <Callout tone="neutral" icon={<Archive />} className="mt-3 px-3 py-2 text-[12.5px]"><p>Retired <time dateTime={job.retirement.at}>{formatDateTime(job.retirement.at, TZ)}</time>: {job.retirement.reason}</p>{job.retirement.supersededBy && <p className="mt-1 break-all">Superseded by prepared job {job.retirement.supersededBy}.</p>}</Callout>}
      </section>; })}</div>
      <Dialog open={Boolean(retiring)} onOpenChange={(open) => { if (!open && !pending) setRetiring(null); }} title="Retire preparation job" description={retiring?.label} footer={<><Button variant="secondary" disabled={pending} onClick={() => setRetiring(null)}>Keep job</Button><Button disabled={pending || reason.trim().length < 10} onClick={retire}>Retire job</Button></>}>
        <p className="mb-4 text-sm text-muted">Retirement records an agency decision and preserves every attempt. Required setup tasks and verified provider checks still need to pass. A worker with a live lease must finish or expire first.</p>
        <label className="block text-sm font-medium text-ink">Reason<Textarea className="mt-2" value={reason} maxLength={450} onChange={(e) => setReason(e.target.value)} placeholder="Explain why this operation is being cancelled or replaced." /></label>
        <label className="mt-4 block text-sm font-medium text-ink">Prepared replacement (optional)<Select className="mt-2" value={supersededBy} onChange={(e) => setSupersededBy(e.target.value)}><option value="">No replacement yet</option>{jobs.filter((j) => j.operation === retiring?.operation && j.status === "succeeded" && j.id !== retiring?.id).map((j) => <option key={j.id} value={j.id}>{j.label} · {formatDateTime(j.updatedAt, TZ)}</option>)}</Select></label>
      </Dialog>
    </CardContent>
  </Card>;
}
