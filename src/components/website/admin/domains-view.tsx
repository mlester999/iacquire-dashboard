import Link from "next/link";
import { AlertTriangle, CheckCircle2, Globe, Server } from "lucide-react";
import type { domainsOverview } from "@/server/websites/admin";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/primitives";
import { PageHero } from "@/components/ui/workspace";
import { domainStatusLabel, domainStatusTone } from "@/components/website/portal/domain-status";
import { formatBytes, formatDate, formatNumber, relativeTime } from "@/lib/utils";

export type DomainsOverview = Awaited<ReturnType<typeof domainsOverview>>;

/** Included addresses, customers' own domains and hosting usage. Nothing here changes DNS: it reports and explains. */
export function DomainsView({ o, timeZone, baseDomain, cnameTarget }: { o: DomainsOverview; timeZone: string; baseDomain: string; cnameTarget: string }) {
  const attention = o.domains.filter((d) => d.needsAttention);
  return (
    <div className="module-stack">
      <PageHero eyebrow="Website Studio" icon={<Globe className="size-5" />} title="Domains & Hosting"
        description="Included addresses, customers' own domains, and how each is verified, routed and secured. A domain is only called connected once the live check has passed." />
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Server className="size-4" aria-hidden /> Hosting setup</CardTitle><CardDescription>What must exist outside this application before a website answers on its own address. Nothing here changes DNS for you.</CardDescription></CardHeader>
        <CardContent className="space-y-3 text-[13.5px] leading-relaxed text-ink-2">
          <p>Included addresses look like <code className="rounded bg-surface-3 px-1.5 py-0.5 text-[12.5px]">clientname.{baseDomain}</code>. They work only when the sites domain has these records and a certificate:</p>
          <ul className="list-disc space-y-1 pl-5 text-[13px]">
            <li><strong className="font-semibold text-ink">Wildcard DNS</strong>: <code className="rounded bg-surface-3 px-1">*.{baseDomain}</code> pointing at the sites deployment.</li>
            <li><strong className="font-semibold text-ink">A wildcard certificate</strong> for <code className="rounded bg-surface-3 px-1">*.{baseDomain}</code>.</li>
            <li><strong className="font-semibold text-ink">A CNAME target for customers&apos; own domains</strong>: <code className="rounded bg-surface-3 px-1">{cnameTarget || "(not configured)"}</code>, plus a TXT record <code className="rounded bg-surface-3 px-1">_iacquire-verify</code> to prove ownership.</li>
          </ul>
          <p className="text-[12.5px] text-muted">Until those exist, websites stay <strong className="font-semibold">Pending</strong>: we never report a site as live without confirming it answers.</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2">{attention.length > 0 ? <AlertTriangle className="size-4 text-warning-ink" aria-hidden /> : <CheckCircle2 className="size-4 text-success-ink" aria-hidden />} Needs attention <span className="text-[13px] font-normal text-muted">· {attention.length}</span></CardTitle></CardHeader>
        <CardContent>
          {attention.length === 0 ? <p className="text-[13px] text-muted">Every domain is verified and answering.</p> : (
            <ul className="divide-y divide-line">
              {attention.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0"><p className="truncate text-[14px] font-semibold">{d.hostname}</p><p className="truncate text-[12.5px] text-muted">{d.orgName} · {d.why}</p></div>
                  <div className="flex shrink-0 items-center gap-2"><Badge tone={domainStatusTone(d)}>{domainStatusLabel(d)}</Badge><Link href={`/admin/clients/${d.orgId}/website`} className="inline-flex h-8 items-center rounded-xl border border-line bg-surface px-3 text-[13px] font-medium text-ink-2 hover:bg-surface-2">Troubleshoot</Link></div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>All domains · {o.domains.length}</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          {o.domains.length === 0 ? <p className="text-[13px] text-muted">No domains yet. Each website gets an included address when it is created.</p> : (
            <table className="w-full min-w-[40rem] text-left text-[13px]">
              <thead><tr className="border-b border-line text-[11.5px] uppercase tracking-wider text-muted"><th className="py-2 pr-3 font-semibold">Domain</th><th className="py-2 pr-3 font-semibold">Client</th><th className="py-2 pr-3 font-semibold">Status</th><th className="py-2 pr-3 font-semibold">Certificate</th><th className="py-2 pr-3 font-semibold">Last checked</th><th className="py-2 font-semibold">Renews</th></tr></thead>
              <tbody className="divide-y divide-line">
                {o.domains.map((d) => (
                  <tr key={d.id}>
                    <td className="py-2.5 pr-3 font-medium">{d.hostname}{d.isPrimary && <span className="ml-1.5 text-[11px] font-normal text-muted">primary</span>}</td>
                    <td className="py-2.5 pr-3 text-muted">{d.orgName}</td>
                    <td className="py-2.5 pr-3"><Badge tone={domainStatusTone(d)}>{domainStatusLabel(d)}</Badge></td>
                    <td className="py-2.5 pr-3 capitalize text-muted">{d.sslStatus}</td>
                    <td className="py-2.5 pr-3 text-muted">{d.checkedAt ? relativeTime(d.checkedAt) : "Never"}</td>
                    <td className="py-2.5 text-muted">{d.renewsAt ? formatDate(d.renewsAt, timeZone) : d.kind === "platform" ? "Included" : "Not recorded"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Hosting usage, last 30 days</CardTitle><CardDescription>Counted from the sites runtime. Response sizes are measured at the CDN, so “data served” stays at zero until that is connected.</CardDescription></CardHeader>
        <CardContent className="overflow-x-auto">
          {o.usage.length === 0 ? <p className="text-[13px] text-muted">Nothing has been served in the last 30 days.</p> : (
            <table className="w-full min-w-[28rem] text-left text-[13px]">
              <thead><tr className="border-b border-line text-[11.5px] uppercase tracking-wider text-muted"><th className="py-2 pr-3 font-semibold">Client</th><th className="py-2 pr-3 text-right font-semibold">Requests</th><th className="py-2 pr-3 text-right font-semibold">Data</th><th className="py-2 text-right font-semibold">Enquiries</th></tr></thead>
              <tbody className="divide-y divide-line">{o.usage.map((u) => <tr key={u.orgId}><td className="py-2.5 pr-3 font-medium">{u.orgName}</td><td className="py-2.5 pr-3 text-right tabular-nums">{formatNumber(u.requests)}</td><td className="py-2.5 pr-3 text-right tabular-nums">{u.bytes > 0 ? formatBytes(u.bytes) : "Not measured"}</td><td className="py-2.5 text-right tabular-nums">{formatNumber(u.enquiries)}</td></tr>)}</tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
