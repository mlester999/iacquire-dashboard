"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Layers, RefreshCw, ShieldCheck } from "lucide-react";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Select, Textarea } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/overlays";
import { Button } from "@/components/ui/button";
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
const STATUS: Record<string, string> = { queued: "Queued", running: "Running", awaiting_admin: "Agency action needed", succeeded: "Prepared", failed: "Failed — review required", cancelled: "Retired" };
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
    <CardHeader><div><CardTitle className="flex items-center gap-2"><Layers className="size-4 text-primary" /> Provisioning preparation</CardTitle><CardDescription>Persistent preparation jobs and attempts for this client. Provider readiness is verified separately.</CardDescription></div></CardHeader>
    <CardContent>
      <p className="mb-4 flex items-start gap-2 rounded-xl bg-primary-soft p-3 text-[13px] text-primary-ink"><ShieldCheck className="mt-0.5 size-4 shrink-0" /> Drafts and validation only. Remote profiles, CRM writes, messaging and workflow activation require separate authorization.</p>
      <div className="mb-5 flex flex-col gap-2 sm:flex-row"><label className="min-w-0 flex-1"><span className="sr-only">Preparation operation</span><Select value={operation} onChange={(e) => setOperation(e.target.value as PreparationOperation)}>{OPERATIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}</Select></label><Button disabled={pending} onClick={() => run()}>Prepare / verify</Button></div>
      {jobs.length === 0 && <p className="py-5 text-sm text-muted">No preparation jobs yet. Company onboarding will queue the initial preparation steps.</p>}
      <div className="space-y-3">{jobs.map((job) => <section key={job.id} className="min-w-0 rounded-xl border border-line p-4">
        <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-sm font-semibold text-ink">{job.label}</h3><Badge tone={job.status === "failed" ? "danger" : job.status === "succeeded" ? "success" : "neutral"}>{STATUS[job.status] ?? job.status}</Badge></div>
        {job.detail && <p className="mt-2 break-words text-[13px] leading-relaxed text-muted">{job.detail}</p>}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-muted">Attempt {job.attempts} of {job.maxAttempts} · Updated <time dateTime={job.updatedAt}>{new Date(job.updatedAt).toLocaleDateString("en-SG", { timeZone: "Asia/Singapore" })}</time></p>{["queued", "failed", "awaiting_admin", "running"].includes(job.status) && <div className="flex flex-wrap gap-2"><Button variant="secondary" size="sm" disabled={pending || (job.status !== "running" && job.attempts >= job.maxAttempts)} onClick={() => run(job)}><RefreshCw className="size-3.5" />{job.status === "queued" ? "Start" : job.status === "running" ? "Recover expired attempt" : "Retry / review"}</Button><Button variant="ghost" size="sm" disabled={pending} onClick={() => { setReason(""); setSupersededBy(""); setRetiring(job); }}>Review retirement</Button></div>}</div>
        {job.status === "failed" && job.attempts >= job.maxAttempts && <p className="mt-2 text-xs text-warning-ink">Retry limit reached. Review the attempts and retire this job with a reason before preparing a replacement.</p>}
        {job.retryAt && <p className="mt-2 text-xs text-muted">Retry available after <time dateTime={job.retryAt}>{new Date(job.retryAt).toLocaleString("en-SG", { timeZone: "Asia/Singapore" })} SGT</time>.</p>}
        {job.history.length > 0 && <details className="mt-3 text-xs text-muted"><summary className="cursor-pointer py-1">Attempt history</summary><ol className="mt-2 space-y-2">{job.history.map((a) => <li key={a.number} className="break-words">#{a.number} · {a.status} · <time dateTime={a.startedAt}>{new Date(a.startedAt).toLocaleString("en-SG", { timeZone: "Asia/Singapore" })}</time>{a.error && <p className="mt-1">{a.error}</p>}</li>)}</ol></details>}
        {job.retirement && <div className="mt-3 border-t border-line pt-3 text-xs text-muted"><p>Retired <time dateTime={job.retirement.at}>{new Date(job.retirement.at).toLocaleString("en-SG", { timeZone: "Asia/Singapore" })}</time>: {job.retirement.reason}</p>{job.retirement.supersededBy && <p className="mt-1 break-all">Superseded by prepared job {job.retirement.supersededBy}.</p>}</div>}
      </section>)}</div>
      <Dialog open={Boolean(retiring)} onOpenChange={(open) => { if (!open && !pending) setRetiring(null); }} title="Retire preparation job" description={retiring?.label} footer={<><Button variant="secondary" disabled={pending} onClick={() => setRetiring(null)}>Keep job</Button><Button disabled={pending || reason.trim().length < 10} onClick={retire}>Retire job</Button></>}>
        <p className="mb-4 text-sm text-muted">Retirement records an agency decision and preserves every attempt. Required setup tasks and verified provider checks still need to pass. A worker with a live lease must finish or expire first.</p>
        <label className="block text-sm font-medium text-ink">Reason<Textarea className="mt-2" value={reason} maxLength={450} onChange={(e) => setReason(e.target.value)} placeholder="Explain why this operation is being cancelled or replaced." /></label>
        <label className="mt-4 block text-sm font-medium text-ink">Prepared replacement (optional)<Select className="mt-2" value={supersededBy} onChange={(e) => setSupersededBy(e.target.value)}><option value="">No replacement yet</option>{jobs.filter((j) => j.operation === retiring?.operation && j.status === "succeeded" && j.id !== retiring?.id).map((j) => <option key={j.id} value={j.id}>{j.label} · {new Date(j.updatedAt).toLocaleString("en-SG", { timeZone: "Asia/Singapore" })}</option>)}</Select></label>
      </Dialog>
    </CardContent>
  </Card>;
}
