import { ArrowRight, ClipboardCheck, FileCheck2, Layers, ShieldCheck, TriangleAlert, UserCheck } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/primitives";
import { MetricCard, PageHero } from "@/components/ui/workspace";
import { PreparationPanel, type JobView } from "@/components/admin/setup/preparation-panel";
import { IconTile } from "@/components/admin/setup/ui";

const STEPS = [
  { icon: FileCheck2, title: "Prepare drafts", text: "Save client-specific settings and guided manual work.", tone: "primary" },
  { icon: UserCheck, title: "Agency review", text: "Inspect the prepared records and resolve failed attempts.", tone: "violet" },
  { icon: ShieldCheck, title: "Verify readiness", text: "Required checks need actual provider evidence.", tone: "warning" },
  { icon: ClipboardCheck, title: "Approve the portal", text: "Record the final agency decision. External activation is separate.", tone: "success" },
] as const;

export function PreparationWorkspace({ orgId, jobs }: { orgId: string; jobs: JobView[] }) {
  return <div className="module-stack">
    <PageHero eyebrow="Client provisioning" title="Preparation with a clear audit trail." icon={<Layers className="size-5" />} description="Review configuration drafts, guided agency work and verification attempts. Failed operations stay visible, with their attempts preserved for the next review." aside={<div className="flex items-start gap-3.5 rounded-2xl bg-surface/80 p-4 shadow-card ring-1 ring-inset ring-line"><IconTile icon={<ShieldCheck />} tone="primary" /><div className="min-w-0"><p className="text-sm font-semibold text-ink">Readiness is a separate gate.</p><p className="mt-1 max-w-52 text-xs leading-relaxed text-muted">Prepared drafts still need required technical checks and agency approval.</p></div></div>} />
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <MetricCard label="Recorded jobs" value={jobs.length} icon={<Layers className="size-4" />} detail="This client's preparation history" />
      <MetricCard label="Prepared" value={jobs.filter(j => j.status === "succeeded").length} icon={<FileCheck2 className="size-4" />} tone="green" detail="Completed preparation operations" />
      <MetricCard label="Agency action" value={jobs.filter(j => j.status === "awaiting_admin").length} icon={<UserCheck className="size-4" />} tone="violet" detail="Guided manual steps" />
      <MetricCard label="Failed jobs" value={jobs.filter(j => j.status === "failed").length} icon={<TriangleAlert className="size-4" />} tone="amber" detail="Visible until resolved or retired" />
    </div>
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0"><PreparationPanel orgId={orgId} jobs={jobs} /></div>
      <aside className="space-y-4 xl:sticky xl:top-24">
        <Card>
          <CardHeader><div className="min-w-0"><CardTitle>How preparation works</CardTitle><CardDescription>The workflow structure below explains the review boundaries. It is not a live progress indicator.</CardDescription></div></CardHeader>
          <CardContent><ol className="relative space-y-4">{STEPS.map((step, index) => <li key={step.title} className="flex gap-3"><IconTile icon={<step.icon />} tone={step.tone} size="sm" /><div className="min-w-0"><p className="text-[13px] font-semibold text-ink"><span className="mr-2 font-mono text-[12px] font-medium tabular-nums text-muted">{String(index + 1).padStart(2, "0")}</span>{step.title}</p><p className="mt-0.5 text-xs leading-relaxed text-muted">{step.text}</p></div></li>)}</ol></CardContent>
        </Card>
        <Card>
          <CardHeader><div className="min-w-0"><CardTitle>Keep the evidence together</CardTitle><CardDescription>Task history and verified connection status remain available in the Setup Manager.</CardDescription></div></CardHeader>
          <CardContent className="grid gap-2">
            <ButtonLink href={`/admin/clients/${orgId}/setup`} variant="secondary" size="sm" className="justify-between">Open setup manager <ArrowRight className="size-3.5" /></ButtonLink>
            <ButtonLink href={`/admin/clients/${orgId}/activation`} variant="secondary" size="sm" className="justify-between">Review readiness <ArrowRight className="size-3.5" /></ButtonLink>
          </CardContent>
        </Card>
      </aside>
    </div>
  </div>;
}
