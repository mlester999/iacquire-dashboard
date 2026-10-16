import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { requireAgency } from "@/server/tenancy/context";
import { getPreparationJobs, OPERATION_LABEL } from "@/server/setup/jobs";
import { PreparationWorkspace } from "@/components/admin/setup/preparation-workspace";

export const metadata = { title: "Client provisioning preparation" };
export default async function ProvisioningPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const user = await requireAgency();
  const { jobs, attempts, retirements } = await getPreparationJobs(user, id);
  return <div className="space-y-5"><Link href={`/admin/clients/${id}/setup`} className="inline-flex min-h-10 items-center gap-1.5 text-[13px] font-medium text-muted transition-colors hover:text-ink"><ArrowLeft className="size-3.5" /> Client setup</Link><PreparationWorkspace orgId={id} jobs={jobs.map((j) => {
    const retirement = retirements.find((r) => r.target_id === j.id);
    return { id: j.id, operation: j.operation, label: OPERATION_LABEL[j.operation], status: j.status, attempts: j.attempt_count, maxAttempts: j.max_attempts, detail: j.last_error, retryAt: j.next_retry_at ? new Date(j.next_retry_at).toISOString() : null, updatedAt: new Date(j.updated_at).toISOString(), retirement: retirement ? { reason: retirement.metadata.reason, supersededBy: retirement.metadata.supersededBy, at: new Date(retirement.created_at).toISOString() } : null, history: attempts.filter((a) => a.job_id === j.id).map((a) => ({ number: a.attempt_number, status: a.status, error: a.error_summary, startedAt: new Date(a.started_at).toISOString(), finishedAt: a.finished_at ? new Date(a.finished_at).toISOString() : null })) };
  })} /></div>;
}
