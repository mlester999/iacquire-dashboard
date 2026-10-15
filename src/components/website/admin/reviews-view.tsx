import Link from "next/link";
import { AlertTriangle, CheckCircle2, ClipboardCheck, MessageSquare, Rocket } from "lucide-react";
import type { ManagedWebsite } from "@/server/websites/admin";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/primitives";
import { PageHero } from "@/components/ui/workspace";
import { LifecycleBadge } from "@/components/website/admin/lifecycle-badge";
import { relativeTime } from "@/lib/utils";

function Queue({ title, description, empty, sites, icon, action }: { title: string; description: string; empty: string; sites: ManagedWebsite[]; icon: React.ReactNode; action: string }) {
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2">{icon} {title} <span className="text-[13px] font-normal text-muted">· {sites.length}</span></CardTitle><CardDescription>{description}</CardDescription></CardHeader>
      <CardContent>
        {sites.length === 0 ? <p className="text-[13px] text-muted">{empty}</p> : (
          <ul className="divide-y divide-line">
            {sites.map((s) => (
              <li key={s.websiteId} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate text-[14px] font-semibold">{s.orgName}</p>
                  <p className="truncate text-[12.5px] text-muted">{s.name} · edited {relativeTime(s.draftUpdatedAt)}{s.openComments > 0 ? ` · ${s.openComments} open comment${s.openComments === 1 ? "" : "s"}` : ""}</p>
                  {s.approvalNote && <p className="mt-0.5 truncate text-[12.5px] text-ink-2">“{s.approvalNote}”</p>}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <LifecycleBadge state={s.lifecycle} />
                  <Link href={`/admin/website-studio/websites/${s.orgId}`} className="inline-flex h-8 items-center rounded-xl border border-line bg-surface px-3 text-[13px] font-medium text-ink-2 hover:bg-surface-2">{action}</Link>
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
      <PageHero eyebrow="Website Studio" icon={<ClipboardCheck className="size-5" />} title="Reviews & Publishing"
        description="Where each website is on its way to going live: waiting for the owner, needing changes, approved and ready, or in trouble. Publishing always needs the owner's approval of the exact draft." />
      <div className="grid gap-6 xl:grid-cols-2">
        <Queue title="Waiting for the owner" description="Sent for approval. The owner reviews the preview and approves it or asks for changes." empty="Nothing is waiting for an owner." sites={q.waiting} icon={<ClipboardCheck className="size-4 text-warning-ink" aria-hidden />} action="Review" />
        <Queue title="Approved, ready to publish" description="The owner approved this exact draft. A super admin (or the owner) can publish it." empty="Nothing approved is waiting." sites={q.approved} icon={<Rocket className="size-4 text-primary" aria-hidden />} action="Open" />
        <Queue title="Changes requested" description="Sent back to the client's team with a note." empty="No website is waiting on changes." sites={q.changes} icon={<CheckCircle2 className="size-4 text-muted" aria-hidden />} action="Open" />
        <Queue title="Needs attention" description="A publication that couldn't be served, or a live site that isn't answering its health check." empty="Every live site is healthy." sites={q.failed} icon={<AlertTriangle className="size-4 text-danger" aria-hidden />} action="Investigate" />
      </div>
      <Queue title="Open comments" description="Notes on a website that nobody has resolved yet." empty="No unresolved comments." sites={q.comments} icon={<MessageSquare className="size-4 text-muted" aria-hidden />} action="Open" />
    </div>
  );
}
