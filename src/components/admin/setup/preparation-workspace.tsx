import Link from "next/link";
import { ArrowRight, ClipboardCheck, FileCheck2, Layers, ShieldCheck, TriangleAlert, UserCheck } from "lucide-react";
import { Card } from "@/components/ui/primitives";
import { MetricCard, PageHero } from "@/components/ui/workspace";
import { PreparationPanel, type JobView } from "@/components/admin/setup/preparation-panel";

export function PreparationWorkspace({ orgId, jobs }: { orgId: string; jobs: JobView[] }) {
  return <div className="module-stack">
    <PageHero eyebrow="Client provisioning" title="Preparation with a clear audit trail." icon={<Layers className="size-5" />} description="Review configuration drafts, guided agency work and verification attempts. Failed operations stay visible, with their attempts preserved for the next review." aside={<div className="rounded-2xl border border-primary/15 bg-surface/75 p-4"><ShieldCheck className="mb-2 size-5 text-primary" /><p className="text-sm font-semibold text-ink">Readiness is a separate gate.</p><p className="mt-1 max-w-52 text-xs leading-relaxed text-muted">Prepared drafts still need required technical checks and agency approval.</p></div>} />
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <MetricCard label="Recorded jobs" value={jobs.length} icon={<Layers className="size-4" />} detail="This client's preparation history" />
      <MetricCard label="Prepared" value={jobs.filter(j => j.status === "succeeded").length} icon={<FileCheck2 className="size-4" />} tone="green" detail="Completed preparation operations" />
      <MetricCard label="Agency action" value={jobs.filter(j => j.status === "awaiting_admin").length} icon={<UserCheck className="size-4" />} tone="violet" detail="Guided manual steps" />
      <MetricCard label="Failed jobs" value={jobs.filter(j => j.status === "failed").length} icon={<TriangleAlert className="size-4" />} tone="amber" detail="Visible until resolved or retired" />
    </div>
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-w-0"><PreparationPanel orgId={orgId} jobs={jobs} /></div>
      <aside className="space-y-4 xl:sticky xl:top-24">
        <section className="rounded-2xl border border-white/10 bg-[#11192c] p-5 text-white"><h2 className="text-sm font-semibold">How preparation works</h2><p className="mt-2 text-xs leading-relaxed text-slate-300">The workflow structure below explains the review boundaries. It is not a live progress indicator.</p><ol className="mt-5 space-y-4">{[{icon:FileCheck2,title:"Prepare drafts",text:"Save client-specific settings and guided manual work."},{icon:UserCheck,title:"Agency review",text:"Inspect the prepared records and resolve failed attempts."},{icon:ShieldCheck,title:"Verify readiness",text:"Required checks need actual provider evidence."},{icon:ClipboardCheck,title:"Approve the portal",text:"Record the final agency decision. External activation is separate."}].map((step,index)=><li key={step.title} className="flex gap-3"><span className="grid size-9 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/5 text-blue-200"><step.icon className="size-4" /></span><div><p className="text-xs font-semibold"><span className="mr-2 text-slate-400">{String(index+1).padStart(2,"0")}</span>{step.title}</p><p className="mt-1 text-xs leading-relaxed text-slate-300">{step.text}</p></div></li>)}</ol></section>
        <Card className="p-4"><h3 className="text-sm font-semibold text-ink">Keep the evidence together</h3><p className="mt-2 text-xs leading-relaxed text-muted">Task history and verified connection status remain available in the Setup Manager.</p><Link href={`/admin/clients/${orgId}/setup`} className="mt-3 inline-flex min-h-10 items-center gap-1 text-xs font-medium text-primary">Open setup manager <ArrowRight className="size-3.5" /></Link><Link href={`/admin/clients/${orgId}/activation`} className="flex min-h-10 items-center gap-1 text-xs font-medium text-primary">Review readiness <ArrowRight className="size-3.5" /></Link></Card>
      </aside>
    </div>
  </div>;
}
