import Link from "next/link";
import { Activity, AlertTriangle, ArrowRight, BarChart3, CheckCircle2, ClipboardCheck, FileClock, Globe, LayoutTemplate, MonitorSmartphone, PencilRuler, Plus, ServerCog } from "lucide-react";
import type { StudioOverview } from "@/server/websites/admin";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState } from "@/components/ui/primitives";
import { AvatarTile, InfoChip, StatusPill } from "@/components/ui/status";
import { CoverageBar, MetricCard, PageHero, SectionLabel } from "@/components/ui/workspace";
import { ButtonLink } from "@/components/ui/button";
import { formatBytes, formatNumber, relativeTime } from "@/lib/utils";

function UsageSummary({ o }: { o: StudioOverview }) {
  if (!o.usage30d) return <EmptyState compact icon={<BarChart3 className="size-5" />} title="No hosting usage yet" description="There are no client websites yet, so there is nothing to report." />;
  const u = o.usage30d;
  if (u.requests === 0 && u.bytes === 0 && u.enquiries === 0) return <EmptyState compact icon={<BarChart3 className="size-5" />} title="Nothing served in 30 days" description="Usage appears here once sites are live and receive visits." />;
  return (
    <dl className="grid gap-3 sm:grid-cols-3">
      {[["Page requests", formatNumber(u.requests)], ["Data served", u.bytes > 0 ? formatBytes(u.bytes) : "Not measured"], ["Website enquiries", formatNumber(u.enquiries)]].map(([k, v]) => (
        <div key={k} className="rounded-xl bg-surface-2 p-3.5 ring-1 ring-inset ring-line"><dt className="text-[12px] font-medium text-muted">{k}</dt><dd className="mt-1 text-[22px] font-semibold tabular-nums tracking-tight text-ink">{v}</dd></div>
      ))}
    </dl>
  );
}

/** The agency's Website Studio overview. Every figure is a count of real records; the page that loads them lives next to it. */
export function OverviewView({ o, superAdmin }: { o: StudioOverview; superAdmin: boolean }) {
  const parts = [
    { label: "Published", count: o.published, color: "var(--success)" },
    { label: "Waiting for the owner", count: o.pendingApprovals, color: "var(--warning)" },
    { label: "Changes requested", count: o.changesRequested, color: "var(--danger)" },
    { label: "Approved, not yet live", count: o.approvedWaiting, color: "var(--primary)" },
    { label: "Drafts", count: Math.max(0, o.drafts - o.pendingApprovals - o.changesRequested - o.approvedWaiting), color: "var(--faint)" },
  ].filter((p) => p.count > 0);
  return (
    <div className="module-stack">
      <PageHero
        eyebrow="Website Studio" icon={<MonitorSmartphone className="size-5" />} title="Every client website, from first draft to live."
        description="Build and refine client websites, maintain the template library, review changes, and keep domains and hosting healthy. Everything below is counted from real records."
        action={
          <>
            <ButtonLink href="/admin/website-studio/websites" variant="brand"><Plus className="size-4" /> Create a website</ButtonLink>
            <ButtonLink href="/admin/website-studio/templates" variant="secondary"><LayoutTemplate className="size-4" /> Browse templates</ButtonLink>
            <ButtonLink href="/admin/website-studio/websites" variant="secondary"><Globe className="size-4" /> Manage client websites</ButtonLink>
            <ButtonLink href="/admin/website-studio/templates?new=1" variant="secondary"><PencilRuler className="size-4" /> Open Template Designer</ButtonLink>
            <ButtonLink href="/admin/website-studio/reviews" variant="secondary"><ClipboardCheck className="size-4" /> Review pending changes</ButtonLink>
          </>
        }
      />
      <section aria-label="Totals" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Managed websites" value={o.total} detail={o.clientsWithoutSite > 0 ? `${o.clientsWithoutSite} client${o.clientsWithoutSite === 1 ? "" : "s"} without one yet` : "Every active client has a website"} icon={<Globe className="size-4" />} href="/admin/website-studio/websites" />
        <MetricCard label="Published" value={o.published} detail={o.unhealthy > 0 ? `${o.unhealthy} not answering` : o.published > 0 ? "All answering their health check" : "None live yet"} icon={<CheckCircle2 className="size-4" />} tone="green" href="/admin/website-studio/websites" />
        <MetricCard label="Drafts" value={o.drafts} detail={`${o.pendingApprovals} waiting for owner approval`} icon={<FileClock className="size-4" />} tone="amber" href="/admin/website-studio/reviews" />
        <MetricCard label="Needs attention" value={o.domainsNeedingAttention + o.failedPublications} detail={`${o.domainsNeedingAttention} domain${o.domainsNeedingAttention === 1 ? "" : "s"} · ${o.failedPublications} failed publication${o.failedPublications === 1 ? "" : "s"}`} icon={<AlertTriangle className="size-4" />} tone={o.domainsNeedingAttention + o.failedPublications > 0 ? "amber" : "neutral"} href="/admin/website-studio/domains" />
      </section>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle>Where every website stands</CardTitle><CardDescription>One bar, built from the status of each website.</CardDescription></CardHeader>
            <CardContent>{parts.length ? <CoverageBar parts={parts} label="Website status" /> : <EmptyState compact icon={<Globe className="size-5" />} title="No websites yet" />}</CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Hosting, last 30 days</CardTitle><CardDescription>Requests and enquiries across the websites you manage.</CardDescription></CardHeader>
            <CardContent><UsageSummary o={o} /><Link href="/admin/website-studio/domains" className="mt-4 inline-flex items-center gap-1 text-[13px] font-medium text-primary-ink hover:underline">Domains and hosting <ArrowRight className="size-3.5" aria-hidden /></Link></CardContent>
          </Card>
        </div>
        <Card>
          <CardHeader><CardTitle>Recent activity</CardTitle><CardDescription>The latest website events across your clients.</CardDescription></CardHeader>
          <CardContent>
            {o.activity.length === 0 ? (
              <EmptyState compact icon={<Activity className="size-5" />} title="Nothing has happened yet" description="Activity appears here as websites are created, edited and published." />
            ) : (
              <ol className="-mx-2 divide-y divide-line">
                {o.activity.map((a, i) => (
                  <li key={`${a.at}-${i}`} className="flex items-start gap-3 rounded-xl px-2 py-2.5 transition-colors hover:bg-surface-2/70">
                    <AvatarTile name={a.orgName ?? a.actor ?? "Agency"} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[13.5px] font-medium text-ink">{a.label}</p>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {a.orgName && <InfoChip>{a.orgName}</InfoChip>}
                        <InfoChip>{a.actor ?? "Agency"}</InfoChip>
                      </div>
                    </div>
                    <time dateTime={a.at} className="shrink-0 pt-0.5 text-[12px] tabular-nums text-muted">{relativeTime(a.at)}</time>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      </div>
      {superAdmin && (
        <section aria-label="Setup" className="space-y-3">
          <SectionLabel title="Hosting setup" description="What has to exist outside this application before a website can be served on its own address." />
          <Card><CardContent className="flex items-start gap-3 pt-5 text-[13.5px] leading-relaxed text-muted"><span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-surface-2 text-ink-2 ring-1 ring-inset ring-line-strong" aria-hidden><ServerCog className="size-4" /></span><p>Included addresses (<code className="rounded bg-surface-3 px-1 text-ink-2">name.sites…</code>) need a wildcard DNS record and certificate for the sites domain, and a separate sites deployment. Until those exist, websites stay <StatusPill tone="warning" size="sm" className="mx-0.5 align-middle">Pending</StatusPill> and are marked as such. See Domains and hosting for the exact records.</p></CardContent></Card>
        </section>
      )}
    </div>
  );
}
