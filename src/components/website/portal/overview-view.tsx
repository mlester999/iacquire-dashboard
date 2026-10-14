import Link from "next/link";
import { ArrowRight, CheckCircle2, Globe, Inbox, ShieldAlert, TriangleAlert } from "lucide-react";
import type { Preflight, WebsiteSummary } from "@/server/websites/service";
import type { SubmissionView } from "@/server/websites/forms";
import { ApprovalPanel, OverviewActions } from "@/components/website/portal/overview-actions";
import { domainStatusLabel, domainStatusTone } from "@/components/website/portal/domain-status";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/primitives";
import { PageHero } from "@/components/ui/workspace";
import { resolveTemplate } from "@/lib/website/templates";
import { formatDateTime, relativeTime } from "@/lib/utils";

const APPROVAL_COPY = {
  draft: "No review needed yet.",
  submitted: "A draft is waiting for the owner's review.",
  approved: "The latest draft is approved and ready to publish.",
  changes_requested: "The owner asked for changes.",
} as const;

export interface OverviewPermissions { canEdit: boolean; canPublish: boolean; canApprove: boolean }

/** The website overview: status, readiness, domains and recent enquiries. Plain props in, so it can be reviewed with sample data. */
export function OverviewView({ site, pf, enquiries, timeZone, perms }: { site: WebsiteSummary; pf: Preflight; enquiries: SubmissionView[]; timeZone: string; perms: OverviewPermissions }) {
  const tpl = resolveTemplate(site.templateKey);
  const primary = site.domains.find((d) => d.isPrimary) ?? null;
  const liveHost = site.published ? (primary && primary.status === "active" ? primary.hostname : site.platformHost) : site.platformHost;
  const pub = site.published;

  const state = !pub
    ? { tone: "neutral" as const, label: "Not published", text: "Your website is private. Visitors can't see it until you publish." }
    : pub.health === "healthy"
      ? { tone: "success" as const, label: "Live", text: `Confirmed reachable at ${liveHost}.` }
      : pub.health === "unhealthy"
        ? { tone: "danger" as const, label: "Needs attention", text: pub.healthDetail ?? "We couldn't confirm that your site is being served." }
        : { tone: "warning" as const, label: "Published, not yet confirmed", text: pub.healthDetail ?? "It's published, but we haven't confirmed it can be reached yet." };

  return (
    <div className="space-y-6">
      <PageHero
        eyebrow="Website" title={site.name || "Your website"} icon={<Globe className="size-4" />} tone="neutral"
        description={<>Built in the <strong className="font-semibold">{tpl ? `${tpl.family.name} · ${tpl.variation.name}` : "chosen"}</strong> style. {pub ? `Version ${pub.number} was published ${relativeTime(pub.publishedAt)}.` : "Nothing is published yet."}</>}
        action={<OverviewActions canEdit={perms.canEdit} canPublish={perms.canPublish} isLive={pub !== null} host={liveHost} />}
      />

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-col items-stretch gap-0">
            <div className="flex items-center justify-between gap-3">
              <CardTitle>Status</CardTitle>
              <Badge tone={state.tone}>{state.label}</Badge>
            </div>
            <CardDescription>{state.text}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-[13.5px]">
            {site.hasUnpublishedChanges && (
              <p className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning-soft/60 p-3 text-warning-ink">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> You have edits that aren&apos;t live yet. Publish to show them to visitors.
              </p>
            )}
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
              <dt className="text-muted">Address</dt>
              <dd className="min-w-0 break-words font-medium">{liveHost}</dd>
              <dt className="text-muted">Draft last edited</dt>
              <dd>{formatDateTime(site.draftUpdatedAt, timeZone)}</dd>
              {pub && (<><dt className="text-muted">Last published</dt><dd>{formatDateTime(pub.publishedAt, timeZone)}</dd></>)}
              {pub?.healthCheckedAt && (<><dt className="text-muted">Last checked</dt><dd>{relativeTime(pub.healthCheckedAt)}</dd></>)}
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-col items-stretch gap-0">
            <div className="flex items-center justify-between gap-3">
              <CardTitle>Ready to publish?</CardTitle>
              {pf.blockers.length === 0 ? <Badge tone="success"><CheckCircle2 className="size-3" aria-hidden /> Nothing blocking</Badge> : <Badge tone="danger"><ShieldAlert className="size-3" aria-hidden /> {pf.blockers.length} to fix</Badge>}
            </div>
            <CardDescription>{APPROVAL_COPY[site.approval.status]}{site.approval.note ? ` “${site.approval.note}”` : ""}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {pf.blockers.length > 0 && (
              <ul className="space-y-1.5 text-[13.5px]">
                {pf.blockers.slice(0, 4).map((b, i) => (
                  <li key={`${b.code}-${i}`} className="flex gap-2"><span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-danger" /><span>{b.message} <span className="text-muted">({b.where})</span></span></li>
                ))}
                {pf.blockers.length > 4 && <li className="text-muted">…and {pf.blockers.length - 4} more.</li>}
              </ul>
            )}
            {pf.needsAcknowledgement.length > 0 && (
              <p className="text-[13px] text-muted">{pf.needsAcknowledgement.length} claim{pf.needsAcknowledgement.length === 1 ? "" : "s"} on your site will need your confirmation when you publish.</p>
            )}
            {site.approval.status === "submitted" && <ApprovalPanel canDecide={perms.canApprove} />}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-col items-stretch gap-0">
            <div className="flex items-center justify-between gap-3">
              <CardTitle>Domains</CardTitle>
              <Link href="/website/domains" className="inline-flex items-center gap-1 text-[13px] font-medium text-primary-ink hover:underline">Manage <ArrowRight className="size-3.5" aria-hidden /></Link>
            </div>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-line">
              {site.domains.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-3 py-2.5 text-[13.5px]">
                  <span className="min-w-0 truncate font-medium">{d.hostname}{d.isPrimary ? <span className="ml-2 text-[12px] font-normal text-muted">main</span> : null}</span>
                  <Badge tone={domainStatusTone(d)}>{domainStatusLabel(d)}</Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-col items-stretch gap-0">
            <div className="flex items-center justify-between gap-3">
              <CardTitle>Recent enquiries</CardTitle>
              <Link href="/website/leads" className="inline-flex items-center gap-1 text-[13px] font-medium text-primary-ink hover:underline">See all <ArrowRight className="size-3.5" aria-hidden /></Link>
            </div>
          </CardHeader>
          <CardContent>
            {enquiries.length === 0 ? (
              <p className="flex items-center gap-2 text-[13.5px] text-muted"><Inbox className="size-4" aria-hidden /> Nothing yet. Enquiries from your website appear here and in your contacts.</p>
            ) : (
              <ul className="divide-y divide-line">
                {enquiries.map((e) => (
                  <li key={e.id} className="py-2.5 text-[13.5px]">
                    <p className="flex items-center justify-between gap-3"><span className="min-w-0 truncate font-medium">{e.name}</span><span className="shrink-0 text-[12px] text-muted">{relativeTime(e.createdAt)}</span></p>
                    <p className="mt-0.5 line-clamp-1 text-muted">{e.message || "No message"}</p>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
