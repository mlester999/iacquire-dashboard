import Link from "next/link";
import { AlertTriangle, ArrowRight, CheckCircle2, ClipboardCheck, FileClock, Globe, LayoutTemplate, MonitorSmartphone, PencilRuler, Plus, ServerCog, Sparkles } from "lucide-react";
import type { StudioOverview } from "@/server/websites/admin";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/primitives";
import { CoverageBar, MetricCard, PageHero, SectionLabel } from "@/components/ui/workspace";
import { ButtonLink } from "@/components/ui/button";
import { formatBytes, formatNumber, relativeTime } from "@/lib/utils";

function UsageSummary({ o }: { o: StudioOverview }) {
  if (!o.usage30d) return <p className="text-[13px] text-muted">No client websites yet, so there is no hosting usage to report.</p>;
  const u = o.usage30d;
  if (u.requests === 0 && u.bytes === 0 && u.enquiries === 0) return <p className="text-[13px] text-muted">Nothing has been served in the last 30 days. Usage appears here once sites are live and receive visits.</p>;
  return (
    <dl className="grid grid-cols-3 gap-4">
      <div><dt className="text-[12px] text-muted">Page requests</dt><dd className="mt-1 text-[22px] font-semibold tracking-tight">{formatNumber(u.requests)}</dd></div>
      <div><dt className="text-[12px] text-muted">Data served</dt><dd className="mt-1 text-[22px] font-semibold tracking-tight">{u.bytes > 0 ? formatBytes(u.bytes) : "Not measured"}</dd></div>
      <div><dt className="text-[12px] text-muted">Website enquiries</dt><dd className="mt-1 text-[22px] font-semibold tracking-tight">{formatNumber(u.enquiries)}</dd></div>
    </dl>
  );
}

/** The agency's Website Studio overview. Every figure is a count of real records; the page that loads them lives next to it. */
export function OverviewView({ o, superAdmin }: { o: StudioOverview; superAdmin: boolean }) {
  const parts = [
    { label: "Published", count: o.published, color: "#16a34a" },
    { label: "Waiting for the owner", count: o.pendingApprovals, color: "#d97706" },
    { label: "Changes requested", count: o.changesRequested, color: "#ea580c" },
    { label: "Approved, not yet live", count: o.approvedWaiting, color: "#4f6bed" },
    { label: "Drafts", count: Math.max(0, o.drafts - o.pendingApprovals - o.changesRequested - o.approvedWaiting), color: "#94a3b8" },
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
            <CardContent>{parts.length ? <CoverageBar parts={parts} label="Website status" /> : <p className="text-[13px] text-muted">No websites yet.</p>}</CardContent>
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
              <p className="flex items-center gap-2 text-[13px] text-muted"><Sparkles className="size-4" aria-hidden /> Nothing has happened yet. Activity appears here as websites are created, edited and published.</p>
            ) : (
              <ol className="divide-y divide-line">
                {o.activity.map((a, i) => (
                  <li key={`${a.at}-${i}`} className="flex items-start justify-between gap-3 py-2.5">
                    <div className="min-w-0"><p className="text-[13.5px] font-medium">{a.label}</p><p className="truncate text-[12px] text-muted">{[a.orgName, a.actor].filter(Boolean).join(" · ") || "Agency"}</p></div>
                    <time dateTime={a.at} className="shrink-0 text-[12px] text-muted">{relativeTime(a.at)}</time>
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
          <Card><CardContent className="flex items-start gap-3 pt-5 text-[13.5px] leading-relaxed text-muted"><ServerCog className="mt-0.5 size-4 shrink-0 text-faint" aria-hidden /><p>Included addresses (<code className="rounded bg-surface-3 px-1 text-ink-2">name.sites…</code>) need a wildcard DNS record and certificate for the sites domain, and a separate sites deployment. Until those exist, websites stay <strong className="font-semibold text-ink">Pending</strong> and are marked as such. See Domains and hosting for the exact records.</p></CardContent></Card>
        </section>
      )}
    </div>
  );
}
