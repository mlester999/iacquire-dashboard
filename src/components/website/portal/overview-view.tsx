import * as React from "react";
import Link from "next/link";
import { ArrowRight, CheckCircle2, Clock, Globe, Inbox, Link2, Rocket, ShieldAlert, Star, TriangleAlert, Activity } from "lucide-react";
import type { Preflight, WebsiteSummary } from "@/server/websites/service";
import type { SubmissionView } from "@/server/websites/forms";
import { ApprovalPanel, OverviewActions } from "@/components/website/portal/overview-actions";
import { domainStatusLabel, domainStatusTone } from "@/components/website/portal/domain-status";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState } from "@/components/ui/primitives";
import { AvatarTile, InfoChip, StatusPill } from "@/components/ui/status";
import { PageHero } from "@/components/ui/workspace";
import { resolveTemplate } from "@/lib/website/templates";
import { formatDateTime, relativeTime } from "@/lib/utils";

const APPROVAL_COPY = {
  draft: "No review needed yet.",
  submitted: "A draft is waiting for the owner's review.",
  approved: "The latest draft is approved and ready to publish.",
  changes_requested: "The owner asked for changes.",
} as const;

function IconTile({ children, tone = "primary" }: { children: React.ReactNode; tone?: "primary" | "success" | "warning" | "danger" | "neutral" }) {
  const t = { primary: "bg-primary-soft text-primary-ink", success: "bg-success-soft text-success-ink", warning: "bg-warning-soft text-warning-ink", danger: "bg-danger-soft text-danger-ink", neutral: "bg-surface-2 text-ink-2" }[tone];
  return <span aria-hidden className={`grid size-9 shrink-0 place-items-center rounded-xl ring-1 ring-inset ring-line ${t}`}>{children}</span>;
}

function Fact({ label, children, wide }: { label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={`min-w-0 rounded-xl bg-surface-2/70 px-3 py-2.5 ring-1 ring-inset ring-line ${wide ? "sm:col-span-2" : ""}`}>
      <dt className="text-[12px] font-semibold uppercase tracking-[.12em] text-muted">{label}</dt>
      <dd className="mt-1 min-w-0 break-words text-[13.5px] font-medium text-ink">{children}</dd>
    </div>
  );
}

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
        target="website.hero"
        eyebrow="Website" title={site.name || "Your website"} icon={<Globe className="size-4" />} tone="neutral"
        description={<>Built in the <strong className="font-semibold">{tpl ? `${tpl.family.name} · ${tpl.variation.name}` : "chosen"}</strong> style. {pub ? `Version ${pub.number} was published ${relativeTime(pub.publishedAt)}.` : "Nothing is published yet."}</>}
        action={<OverviewActions canEdit={perms.canEdit} canPublish={perms.canPublish} isLive={pub !== null} host={liveHost} />}
      />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-col items-stretch gap-0">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <IconTile tone={state.tone}><Activity className="size-4" /></IconTile>
                <CardTitle>Status</CardTitle>
              </div>
              <StatusPill tone={state.tone}>{state.label}</StatusPill>
            </div>
            <CardDescription className="mt-3">{state.text}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-[13.5px]">
            {site.hasUnpublishedChanges && (
              <p className="flex items-start gap-2 rounded-xl bg-warning-soft p-3 text-warning-ink ring-1 ring-inset ring-warning/25">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> You have edits that aren&apos;t live yet. Publish to show them to visitors.
              </p>
            )}
            <dl className="grid gap-2.5 sm:grid-cols-2">
              <Fact label="Address" wide>{liveHost}</Fact>
              <Fact label="Draft last edited">{formatDateTime(site.draftUpdatedAt, timeZone)}</Fact>
              {pub && <Fact label="Last published">{formatDateTime(pub.publishedAt, timeZone)}</Fact>}
              {pub?.healthCheckedAt && <Fact label="Last checked">{relativeTime(pub.healthCheckedAt)}</Fact>}
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-col items-stretch gap-0">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <IconTile tone={pf.blockers.length === 0 ? "success" : "danger"}><Rocket className="size-4" /></IconTile>
                <CardTitle>Ready to publish?</CardTitle>
              </div>
              {pf.blockers.length === 0 ? <StatusPill tone="success" icon={<CheckCircle2 className="size-3" aria-hidden />}>Nothing blocking</StatusPill> : <StatusPill tone="danger" icon={<ShieldAlert className="size-3" aria-hidden />}>{pf.blockers.length} to fix</StatusPill>}
            </div>
            <CardDescription className="mt-3">{APPROVAL_COPY[site.approval.status]}{site.approval.note ? ` “${site.approval.note}”` : ""}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {pf.blockers.length > 0 && (
              <ul className="space-y-2 text-[13.5px]">
                {pf.blockers.slice(0, 4).map((b, i) => (
                  <li key={`${b.code}-${i}`} className="flex items-start gap-2.5 rounded-xl bg-danger-soft/70 p-3 ring-1 ring-inset ring-danger/20"><ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-danger-ink" /><span className="min-w-0">{b.message} <InfoChip className="ml-1 align-middle">{b.where}</InfoChip></span></li>
                ))}
                {pf.blockers.length > 4 && <li><InfoChip>+{pf.blockers.length - 4} more</InfoChip></li>}
              </ul>
            )}
            {pf.needsAcknowledgement.length > 0 && (
              <p className="flex items-start gap-2 rounded-xl bg-surface-2/70 p-3 text-[13px] text-ink-2 ring-1 ring-inset ring-line"><TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning-ink" /> {pf.needsAcknowledgement.length} claim{pf.needsAcknowledgement.length === 1 ? "" : "s"} on your site will need your confirmation when you publish.</p>
            )}
            {pf.blockers.length === 0 && pf.needsAcknowledgement.length === 0 && site.approval.status !== "submitted" && (
              <p className="flex items-center gap-2 rounded-xl bg-success-soft/70 p-3 text-[13px] text-success-ink ring-1 ring-inset ring-success/20"><CheckCircle2 aria-hidden className="size-4 shrink-0" /> Everything checks out. Publish whenever you&apos;re ready.</p>
            )}
            {site.approval.status === "submitted" && <ApprovalPanel canDecide={perms.canApprove} />}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-col items-stretch gap-0">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3"><IconTile><Link2 className="size-4" /></IconTile><CardTitle>Domains</CardTitle></div>
              <Link href="/website/domains" className="inline-flex h-9 items-center gap-1 rounded-lg bg-primary-soft px-3 text-[13px] font-medium text-primary-ink ring-1 ring-inset ring-primary/20 transition hover:brightness-95">Manage <ArrowRight className="size-3.5" aria-hidden /></Link>
            </div>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-line">
              {site.domains.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-3 py-2.5 text-[13.5px]">
                  <span className="flex min-w-0 items-center gap-2.5">
                    <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-2 text-muted ring-1 ring-inset ring-line"><Globe className="size-3.5" /></span>
                    <span className="min-w-0">
                      <span className="block truncate font-medium" title={d.hostname}>{d.hostname}</span>
                      {d.isPrimary && <InfoChip className="mt-0.5 h-5 text-[12px]" icon={<Star />}>Main address</InfoChip>}
                    </span>
                  </span>
                  <StatusPill tone={domainStatusTone(d)}>{domainStatusLabel(d)}</StatusPill>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-col items-stretch gap-0">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3"><IconTile><Inbox className="size-4" /></IconTile><CardTitle>Recent enquiries</CardTitle></div>
              <Link href="/website/leads" className="inline-flex h-9 items-center gap-1 rounded-lg bg-primary-soft px-3 text-[13px] font-medium text-primary-ink ring-1 ring-inset ring-primary/20 transition hover:brightness-95">See all <ArrowRight className="size-3.5" aria-hidden /></Link>
            </div>
          </CardHeader>
          <CardContent>
            {enquiries.length === 0 ? (
              <EmptyState icon={<Inbox className="size-5" />} title="No enquiries yet" description="Enquiries from your website appear here and in your contacts." />
            ) : (
              <ul className="divide-y divide-line">
                {enquiries.map((e) => (
                  <li key={e.id} className="flex items-start gap-3 py-2.5 text-[13.5px]">
                    <AvatarTile name={e.name} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center justify-between gap-3"><span className="min-w-0 truncate font-medium" title={e.name}>{e.name}</span><InfoChip className="shrink-0" icon={<Clock />}>{relativeTime(e.createdAt)}</InfoChip></p>
                      <p className="mt-0.5 line-clamp-1 text-muted" title={e.message || undefined}>{e.message || "No message"}</p>
                    </div>
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
