import Link from "next/link";
import { ArrowUpRight, Clock3, Sparkles } from "lucide-react";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/primitives";
import { relativeTime } from "@/lib/utils";
import type { listGrowthPartners } from "@/server/admin/queries";

type Partner = Awaited<ReturnType<typeof listGrowthPartners>>[number];

function statusTone(partner: Partner) {
  if (partner.active_run) return "primary" as const;
  if (partner.status === "configured" && partner.runtime_status === "online") return "success" as const;
  if (partner.status === "paused" || partner.runtime_status === "offline" || partner.runtime_status === "error") return "warning" as const;
  return "neutral" as const;
}

function statusLabel(partner: Partner) {
  if (partner.active_run) return "Working";
  if (!partner.runtime_agent_instance_id) return partner.status.replaceAll("_", " ");
  if (!partner.enabled) return "Disabled";
  return partner.runtime_status?.replaceAll("_", " ") ?? partner.status.replaceAll("_", " ");
}

export function GrowthPartnerManager({ partners }: { partners: Partner[] }) {
  return (
    <section className="space-y-4" aria-labelledby="growth-partners-title">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="growth-partners-title" className="text-lg font-semibold tracking-tight">AI Growth Partners</h2>
          <p className="mt-1 text-sm text-muted">One tenant-scoped runtime per client. This view contains health and workload status only.</p>
        </div>
        <p className="text-sm text-muted">{partners.length} partner identities</p>
      </div>
      {partners.length === 0 ? (
        <Card><CardContent className="py-6 text-sm text-muted">No client Growth Partner identities have been created yet.</CardContent></Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {partners.map((partner) => (
            <Card key={partner.id} className="overflow-hidden">
              <CardHeader className="items-center">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary-ink"><Sparkles className="size-5" aria-hidden /></span>
                <div className="min-w-0 flex-1">
                  <CardTitle className="truncate">{partner.org_name}</CardTitle>
                  <CardDescription>AI Growth Partner</CardDescription>
                </div>
                <Badge tone={statusTone(partner)}>{statusLabel(partner)}</Badge>
              </CardHeader>
              <CardContent className="space-y-3">
                <dl className="grid grid-cols-2 gap-3 text-[13px]">
                  <div><dt className="text-muted">Business Brain</dt><dd className="mt-1 font-medium">{partner.current_version ? `Active v${partner.current_version}` : partner.latest_version ? `Draft v${partner.latest_version}` : "Not prepared"}</dd></div>
                  <div><dt className="text-muted">Runs · 30 days</dt><dd className="mt-1 font-medium">{partner.runs_30d}{partner.failed_30d ? ` · ${partner.failed_30d} failed` : ""}</dd></div>
                  <div className="col-span-2"><dt className="text-muted">Hermes profile</dt><dd className="mt-1 truncate font-mono text-[12px]">{partner.hermes_profile ?? "Not connected"}</dd></div>
                </dl>
                {partner.last_health_detail && <p className="line-clamp-2 rounded-lg bg-surface-2 px-3 py-2 text-[12px] text-ink-2">{partner.last_health_detail}</p>}
                <div className="flex items-center justify-between gap-3 border-t border-line pt-3 text-[12px] text-muted">
                  <span className="flex items-center gap-1.5" suppressHydrationWarning><Clock3 className="size-3" />{partner.last_message_at ? `Conversation ${relativeTime(partner.last_message_at)}` : "No conversation activity"}</span>
                  <Link href={`/admin/clients/${partner.org_id}?tab=workforce`} className="inline-flex shrink-0 items-center gap-1 font-medium text-primary">Client status <ArrowUpRight className="size-3.5" /></Link>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
