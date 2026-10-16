import Link from "next/link";
import { AlertTriangle, ArrowRight, CheckCircle2, ClipboardCheck, Clock, MessageSquare, Rocket, ShieldCheck, Undo2 } from "lucide-react";
import type { ManagedWebsite } from "@/server/websites/admin";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState } from "@/components/ui/primitives";
import { AvatarTile, InfoChip } from "@/components/ui/status";
import { PageHero } from "@/components/ui/workspace";
import { LifecycleBadge } from "@/components/website/admin/lifecycle-badge";
import { cn, relativeTime } from "@/lib/utils";

type QueueTone = "warning" | "primary" | "danger" | "neutral" | "violet";
const TILE: Record<QueueTone, string> = {
  warning: "bg-warning-soft text-warning-ink ring-warning/25", primary: "bg-primary-soft text-primary-ink ring-primary/20", danger: "bg-danger-soft text-danger-ink ring-danger/20",
  neutral: "bg-surface-2 text-ink-2 ring-line-strong", violet: "bg-violet-soft text-violet-ink ring-violet/20",
};

function Queue({ title, description, empty, emptyIcon, sites, icon, tone, action, className }: { title: string; description: string; empty: string; emptyIcon: React.ReactNode; sites: ManagedWebsite[]; icon: React.ReactNode; tone: QueueTone; action: string; className?: string }) {
  return (
    <Card className={cn("flex h-full flex-col", className)}>
      <CardHeader>
        <div className="flex items-start gap-3">
          <span className={cn("grid size-9 shrink-0 place-items-center rounded-[10px] ring-1 ring-inset", TILE[tone])} aria-hidden>{icon}</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2"><CardTitle>{title}</CardTitle><span className="rounded-md bg-surface-3 px-2 py-0.5 text-xs font-semibold tabular-nums text-ink-2" aria-label={`${sites.length} websites`}>{sites.length}</span></div>
            <CardDescription>{description}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex-1">
        {sites.length === 0 ? <EmptyState compact icon={emptyIcon} title={empty} /> : (
          <ul className="-mx-2 divide-y divide-line">
            {sites.map((s) => (
              <li key={s.websiteId} className="group flex flex-wrap items-start gap-3 rounded-xl px-2 py-3 transition-colors hover:bg-surface-2/70">
                <AvatarTile name={s.orgName} />
                <div className="min-w-0 flex-1 basis-48">
                  <p className="truncate text-[14px] font-semibold text-ink" title={s.orgName}>{s.orgName}</p>
                  <p className="truncate text-[12.5px] text-muted" title={s.name}>{s.name}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <InfoChip icon={<Clock className="size-3" />}>Edited {relativeTime(s.draftUpdatedAt)}</InfoChip>
                    {s.openComments > 0 && <InfoChip icon={<MessageSquare className="size-3" />}>{s.openComments} open comment{s.openComments === 1 ? "" : "s"}</InfoChip>}
                  </div>
                  {s.approvalNote && <p className="mt-2 rounded-lg border-l-2 border-primary/40 bg-surface-2 px-2.5 py-1.5 text-[12.5px] italic leading-relaxed text-ink-2" title={s.approvalNote}>“{s.approvalNote}”</p>}
                </div>
                <div className="flex shrink-0 items-center gap-2 sm:self-center">
                  <LifecycleBadge state={s.lifecycle} />
                  <Link href={`/admin/website-studio/websites/${s.orgId}`} className="inline-flex h-10 items-center gap-1 rounded-xl border border-line bg-surface px-3 text-[13px] font-medium text-ink-2 shadow-soft transition-colors hover:border-line-strong hover:bg-surface-2 hover:text-ink">{action}<ArrowRight className="size-3.5" aria-hidden /></Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export interface ReviewQueues { waiting: ManagedWebsite[]; changes: ManagedWebsite[]; approved: ManagedWebsite[]; failed: ManagedWebsite[]; comments: ManagedWebsite[] }

/** Where each website is on its way to going live. */
export function ReviewsView({ q }: { q: ReviewQueues }) {
  return (
    <div className="module-stack">
      <PageHero eyebrow="Website Studio" icon={<ClipboardCheck className="size-5" />} title="Reviews and publishing"
        description="Where each website is on its way to going live: waiting for the owner, needing changes, approved and ready, or in trouble. Publishing always needs the owner's approval of the exact draft." />
      <div className="grid gap-6 xl:grid-cols-2">
        <Queue title="Waiting for the owner" description="Sent for approval. The owner reviews the preview and approves it or asks for changes." empty="Nothing is waiting for an owner" emptyIcon={<CheckCircle2 className="size-5" />} sites={q.waiting} tone="warning" icon={<ClipboardCheck className="size-4" />} action="Review" />
        <Queue title="Approved, ready to publish" description="The owner approved this exact draft. A super admin (or the owner) can publish it." empty="Nothing approved is waiting" emptyIcon={<Rocket className="size-5" />} sites={q.approved} tone="primary" icon={<Rocket className="size-4" />} action="Open" />
        <Queue title="Changes requested" description="Sent back to the client's team with a note." empty="No website is waiting on changes" emptyIcon={<Undo2 className="size-5" />} sites={q.changes} tone="warning" icon={<Undo2 className="size-4" />} action="Open" />
        <Queue title="Needs attention" description="A publication that couldn't be served, or a live site that isn't answering its health check." empty="Every live site is healthy" emptyIcon={<ShieldCheck className="size-5" />} sites={q.failed} tone="danger" icon={<AlertTriangle className="size-4" />} action="Investigate" />
      </div>
      <Queue title="Open comments" description="Notes on a website that nobody has resolved yet." empty="No unresolved comments" emptyIcon={<MessageSquare className="size-5" />} sites={q.comments} tone="neutral" icon={<MessageSquare className="size-4" />} action="Open" />
    </div>
  );
}
