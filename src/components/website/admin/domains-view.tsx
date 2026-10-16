import Link from "next/link";
import { AlertTriangle, ArrowRight, BarChart3, CheckCircle2, Globe, KeyRound, Lock, Server, ShieldCheck, Waypoints } from "lucide-react";
import type { domainsOverview } from "@/server/websites/admin";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState } from "@/components/ui/primitives";
import { AvatarTile, InfoChip, StatusPill } from "@/components/ui/status";
import { PageHero } from "@/components/ui/workspace";
import { domainStatusLabel, domainStatusTone } from "@/components/website/portal/domain-status";
import { formatBytes, formatDate, formatNumber, relativeTime } from "@/lib/utils";

export type DomainsOverview = Awaited<ReturnType<typeof domainsOverview>>;

/** Included addresses, customers' own domains and hosting usage. Nothing here changes DNS: it reports and explains. */
export function DomainsView({ o, timeZone, baseDomain, cnameTarget }: { o: DomainsOverview; timeZone: string; baseDomain: string; cnameTarget: string }) {
  const attention = o.domains.filter((d) => d.needsAttention);
  return (
    <div className="module-stack">
      <PageHero eyebrow="Website Studio" icon={<Globe className="size-5" />} title="Domains and hosting"
        description="Included addresses, customers' own domains, and how each is verified, routed and secured. A domain is only called connected once the live check has passed." />
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Server className="size-4" aria-hidden /> Hosting setup</CardTitle><CardDescription>What must exist outside this application before a website answers on its own address. Nothing here changes DNS for you.</CardDescription></CardHeader>
        <CardContent className="space-y-4 text-[13.5px] leading-relaxed text-ink-2">
          <p>Included addresses look like <code className="rounded bg-surface-3 px-1.5 py-0.5 text-[12.5px]">clientname.{baseDomain}</code>. They work only when the sites domain has these records and a certificate:</p>
          <ul className="grid gap-3 lg:grid-cols-3">
            {[
              { icon: <Waypoints className="size-4" />, title: "Wildcard DNS", body: <><code className="break-words rounded bg-surface-3 px-1">*.{baseDomain}</code> pointing at the sites deployment.</> },
              { icon: <Lock className="size-4" />, title: "Wildcard certificate", body: <>A certificate covering <code className="break-words rounded bg-surface-3 px-1">*.{baseDomain}</code>.</> },
              { icon: <KeyRound className="size-4" />, title: "CNAME for customer domains", body: <>Target <code className="break-words rounded bg-surface-3 px-1">{cnameTarget || "(not configured)"}</code>, plus a TXT record <code className="rounded bg-surface-3 px-1">_iacquire-verify</code> to prove ownership.</> },
            ].map((r) => (
              <li key={r.title} className="flex items-start gap-3 rounded-xl bg-surface-2 p-3.5 ring-1 ring-inset ring-line">
                <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-primary-soft text-primary-ink ring-1 ring-inset ring-primary/20" aria-hidden>{r.icon}</span>
                <div className="min-w-0"><p className="text-[13.5px] font-semibold text-ink">{r.title}</p><p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-2">{r.body}</p></div>
              </li>
            ))}
          </ul>
          <p className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-muted">Until those exist, websites stay <StatusPill tone="warning" size="sm">Pending</StatusPill> We never report a site as live without confirming it answers.</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2.5"><span className={attention.length > 0 ? "grid size-8 place-items-center rounded-[10px] bg-warning-soft text-warning-ink ring-1 ring-inset ring-warning/25" : "grid size-8 place-items-center rounded-[10px] bg-success-soft text-success-ink ring-1 ring-inset ring-success/20"} aria-hidden>{attention.length > 0 ? <AlertTriangle className="size-4" /> : <CheckCircle2 className="size-4" />}</span> Needs attention <span className="rounded-md bg-surface-3 px-2 py-0.5 text-xs font-semibold tabular-nums text-ink-2">{attention.length}</span></CardTitle></CardHeader>
        <CardContent>
          {attention.length === 0 ? <EmptyState compact icon={<ShieldCheck className="size-5" />} title="Every domain is verified and answering" /> : (
            <ul className="divide-y divide-line">
              {attention.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center gap-3 py-3">
                  <AvatarTile name={d.orgName} />
                  <div className="min-w-0 flex-1 basis-56">
                    <p className="truncate text-[14px] font-semibold text-ink" title={d.hostname}>{d.hostname}</p>
                    <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-muted"><span className="font-medium text-ink-2">{d.orgName}</span> · {d.why}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2"><StatusPill tone={domainStatusTone(d)}>{domainStatusLabel(d)}</StatusPill><Link href={`/admin/clients/${d.orgId}/website`} className="inline-flex h-10 items-center gap-1 rounded-xl border border-line bg-surface px-3 text-[13px] font-medium text-ink-2 shadow-soft transition-colors hover:border-line-strong hover:bg-surface-2 hover:text-ink">Troubleshoot<ArrowRight className="size-3.5" aria-hidden /></Link></div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2.5"><span className="grid size-8 place-items-center rounded-[10px] bg-primary-soft text-primary-ink ring-1 ring-inset ring-primary/20" aria-hidden><Globe className="size-4" /></span> All domains <span className="rounded-md bg-surface-3 px-2 py-0.5 text-xs font-semibold tabular-nums text-ink-2">{o.domains.length}</span></CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          {o.domains.length === 0 ? <EmptyState compact icon={<Globe className="size-5" />} title="No domains yet" description="Each website gets an included address when it is created." /> : (
            <table className="w-full min-w-[46rem] text-left text-[13px]">
              <thead><tr className="border-b border-line bg-surface-2/60 text-[11.5px] uppercase tracking-wider text-muted"><th scope="col" className="rounded-tl-lg px-3 py-2.5 font-semibold">Domain</th><th scope="col" className="px-3 py-2.5 font-semibold">Client</th><th scope="col" className="px-3 py-2.5 font-semibold">Status</th><th scope="col" className="px-3 py-2.5 font-semibold">Certificate</th><th scope="col" className="whitespace-nowrap px-3 py-2.5 font-semibold">Last checked</th><th scope="col" className="rounded-tr-lg px-3 py-2.5 font-semibold">Renews</th></tr></thead>
              <tbody className="divide-y divide-line">
                {o.domains.map((d) => (
                  <tr key={d.id} className="transition-colors hover:bg-surface-2/60">
                    <td className="px-3 py-3"><div className="flex items-center gap-2"><span className="max-w-[22rem] truncate font-medium text-ink" title={d.hostname}>{d.hostname}</span>{d.isPrimary && <InfoChip>Primary</InfoChip>}</div></td>
                    <td className="px-3 py-3"><div className="flex min-w-0 items-center gap-2"><AvatarTile name={d.orgName} size="sm" /><span className="truncate text-ink-2" title={d.orgName}>{d.orgName}</span></div></td>
                    <td className="px-3 py-3"><StatusPill tone={domainStatusTone(d)}>{domainStatusLabel(d)}</StatusPill></td>
                    <td className="px-3 py-3"><StatusPill status={d.sslStatus} size="sm" /></td>
                    <td className="whitespace-nowrap px-3 py-3 text-ink-2">{d.checkedAt ? relativeTime(d.checkedAt) : <span className="text-muted">Never</span>}</td>
                    <td className="whitespace-nowrap px-3 py-3 text-ink-2">{d.renewsAt ? formatDate(d.renewsAt, timeZone) : <span className="text-muted">{d.kind === "platform" ? "Included" : "Not recorded"}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2.5"><span className="grid size-8 place-items-center rounded-[10px] bg-primary-soft text-primary-ink ring-1 ring-inset ring-primary/20" aria-hidden><BarChart3 className="size-4" /></span> Hosting usage, last 30 days</CardTitle><CardDescription>Counted from the sites runtime. Response sizes are measured at the CDN, so “data served” stays at zero until that is connected.</CardDescription></CardHeader>
        <CardContent className="overflow-x-auto">
          {o.usage.length === 0 ? <EmptyState compact icon={<BarChart3 className="size-5" />} title="Nothing served in 30 days" /> : (
            <table className="w-full min-w-[28rem] text-left text-[13px]">
              <thead><tr className="border-b border-line bg-surface-2/60 text-[11.5px] uppercase tracking-wider text-muted"><th scope="col" className="px-3 py-2.5 font-semibold">Client</th><th scope="col" className="px-3 py-2.5 text-right font-semibold">Requests</th><th scope="col" className="px-3 py-2.5 text-right font-semibold">Data</th><th scope="col" className="px-3 py-2.5 text-right font-semibold">Enquiries</th></tr></thead>
              <tbody className="divide-y divide-line">{o.usage.map((u) => <tr key={u.orgId} className="transition-colors hover:bg-surface-2/60"><td className="px-3 py-3"><div className="flex items-center gap-2"><AvatarTile name={u.orgName} size="sm" /><span className="font-medium text-ink">{u.orgName}</span></div></td><td className="px-3 py-3 text-right tabular-nums">{formatNumber(u.requests)}</td><td className="px-3 py-3 text-right tabular-nums">{u.bytes > 0 ? formatBytes(u.bytes) : <span className="text-muted">Not measured</span>}</td><td className="px-3 py-3 text-right tabular-nums">{formatNumber(u.enquiries)}</td></tr>)}</tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
