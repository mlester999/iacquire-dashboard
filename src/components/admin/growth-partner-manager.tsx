import Link from "next/link";
import { ArrowUpRight, Brain, Clock3, Sparkles, TriangleAlert } from "lucide-react";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui/primitives";
import { MetricCard, PageHero } from "@/components/ui/workspace";
import { relativeTime } from "@/lib/utils";
import type { listGrowthPartners } from "@/server/admin/queries";

type Partner = Awaited<ReturnType<typeof listGrowthPartners>>[number];

function statusTone(partner: Partner) {
  if (partner.status === "configured") return "success" as const;
  if (partner.status === "paused" || partner.status === "migration_required" || partner.status === "needs_attention") return "warning" as const;
  return "neutral" as const;
}

function statusLabel(partner: Partner) {
  return partner.status.replaceAll("_", " ");
}

export function GrowthPartnerManager({ partners }: { partners: Partner[] }) {
  const configured = partners.filter((partner) => partner.status === "configured").length;
  const migrationReview = partners.filter((partner) => partner.status === "migration_required").length;
  const failedJobs = partners.reduce((total, partner) => total + partner.failed_work_jobs_30d, 0);
  return (
    <section className="space-y-4" aria-label="Client Growth Partner operations">
      <PageHero
        tone="dark"
        eyebrow="Agency operations"
        title="AI Growth Partner Operations"
        description="Review readiness and work failures across the clients you manage. Open a workspace to check its capabilities, integrations, approvals and migration status."
        icon={<Sparkles className="size-4" />}
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <MetricCard label="Configured Partners" value={configured} detail={`Of ${partners.length} client Partner identities`} icon={<Sparkles className="size-4" />} tone="green" />
        <MetricCard label="Migration review" value={migrationReview} detail="Workspaces with previous profiles to review" icon={<Brain className="size-4" />} tone="violet" />
        <MetricCard label="Failed work jobs" value={failedJobs} detail="Recorded in the last 30 days" icon={<TriangleAlert className="size-4" />} tone={failedJobs ? "amber" : "neutral"} />
      </div>
      <h2 className="text-[17px] font-semibold tracking-tight text-ink">Client Partner status</h2>
      {partners.length === 0 ? (
        <Card><CardContent className="py-6 text-sm text-muted">No client Growth Partner identities have been created yet.</CardContent></Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {partners.map((partner) => (
            <Card key={partner.id} className="overflow-hidden">
              <CardHeader className="items-start">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary-ink"><Sparkles className="size-5" aria-hidden /></span>
                <div className="min-w-0 flex-1">
                  <CardTitle className="break-words">{partner.org_name}</CardTitle>
                  <Badge className="mt-2" tone={statusTone(partner)}>{statusLabel(partner)}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <dl className="grid grid-cols-2 gap-3 text-[13px]">
                  <div><dt className="text-muted">Business Brain</dt><dd className="mt-1 font-medium">{partner.current_version ? `Active v${partner.current_version}` : partner.latest_version ? `Draft v${partner.latest_version}` : "Not prepared"}</dd></div>
                  <div><dt className="text-muted">Runs · 30 days</dt><dd className="mt-1 font-medium">{partner.runs_30d}{partner.failed_30d ? ` · ${partner.failed_30d} failed` : ""}{partner.active_run ? " · Active run" : ""}</dd></div>
                  <div><dt className="text-muted">Work job failures · 30 days</dt><dd className="mt-1 font-medium">{partner.failed_work_jobs_30d}</dd></div>
                  <div><dt className="text-muted">Approval execution failures · 30 days</dt><dd className="mt-1 font-medium">{partner.failed_approval_executions_30d}</dd></div>
                  <div className="col-span-2"><dt className="text-muted">Hermes profile</dt><dd className="mt-1 break-all font-mono text-[12px]">{partner.hermes_profile ?? "Not connected"}</dd></div>
                </dl>
                {partner.last_health_detail && <p className="line-clamp-2 rounded-lg bg-surface-2 px-3 py-2 text-[12px] text-ink-2">{partner.last_health_detail}</p>}
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3 text-[12px] text-muted">
                  <span className="flex items-center gap-1.5" suppressHydrationWarning><Clock3 className="size-3" />{partner.last_message_at ? `Conversation ${relativeTime(partner.last_message_at)}` : "No conversation activity"}</span>
                  <Link href={`/admin/clients/${partner.org_id}?tab=workforce`} className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-lg font-medium text-primary">Client status <ArrowUpRight className="size-3.5" /></Link>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
