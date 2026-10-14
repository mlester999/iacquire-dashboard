import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAgency } from "@/server/tenancy/context";
import { getPreparationJobs, OPERATION_LABEL } from "@/server/setup/jobs";
import { PreparationPanel } from "@/components/admin/setup/preparation-panel";

export const metadata = { title: "Client provisioning preparation" };
export default async function ProvisioningPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const user = await requireAgency();
  const { jobs, attempts, retirements } = await getPreparationJobs(user, id);
  return <div className="space-y-5"><Link href={`/admin/clients/${id}/setup`} className="text-sm text-muted hover:text-ink">← Client setup</Link><div><h1 className="text-2xl font-semibold text-ink">Client provisioning preparation</h1><p className="mt-2 text-sm text-muted">Review preparation jobs, retry failures and record retirement decisions for this workspace.</p></div><PreparationPanel orgId={id} jobs={jobs.map((j) => {
    const retirement = retirements.find((r) => r.target_id === j.id);
    return { id: j.id, operation: j.operation, label: OPERATION_LABEL[j.operation], status: j.status, attempts: j.attempt_count, maxAttempts: j.max_attempts, detail: j.last_error, retryAt: j.next_retry_at ? new Date(j.next_retry_at).toISOString() : null, updatedAt: new Date(j.updated_at).toISOString(), retirement: retirement ? { reason: retirement.metadata.reason, supersededBy: retirement.metadata.supersededBy, at: new Date(retirement.created_at).toISOString() } : null, history: attempts.filter((a) => a.job_id === j.id).map((a) => ({ number: a.attempt_number, status: a.status, error: a.error_summary, startedAt: new Date(a.started_at).toISOString(), finishedAt: a.finished_at ? new Date(a.finished_at).toISOString() : null })) };
  })} /></div>;
}
