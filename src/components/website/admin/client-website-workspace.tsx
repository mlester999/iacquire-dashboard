"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Archive, ArchiveRestore, CheckCircle2, Clock, ExternalLink, Eye, GitCompare, Globe, History, MessageSquare, PencilRuler, Rocket, ShieldAlert, ShieldCheck, Undo2, UserCheck } from "lucide-react";
import { addCommentAction, requestChangesAction, resolveCommentAction, rollbackAction, setArchivedAction } from "@/app/actions/website";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, EmptyState } from "@/components/ui/primitives";
import { AvatarTile, InfoChip, StatusPill } from "@/components/ui/status";
import { PageHero } from "@/components/ui/workspace";
import { LifecycleBadge } from "@/components/website/admin/lifecycle-badge";
import { SitePreviewOverlay } from "@/components/website/admin/site-preview-overlay";
import { defaultSiteFrame, type SiteFrameSrc } from "@/components/website/admin/websites-table";
import { AreaControl } from "@/components/website/editor/controls";
import { FrameThumb } from "@/components/website/frame/frame-thumb";
import { PublishDialog } from "@/components/website/studio/publish-dialog";
import { StudioApiProvider, createServerStudioApi } from "@/components/website/studio/studio-api";
import { domainStatusLabel, domainStatusTone } from "@/components/website/portal/domain-status";
import { formatDateTime, relativeTime } from "@/lib/utils";
import type { ReviewSummary, CommentView } from "@/server/websites/review";
import type { ManagedWebsite } from "@/server/websites/admin";
import type { Preflight, PublicationView, WebsiteSummary } from "@/server/websites/service";

interface Props {
  orgId: string;
  timeZone: string;
  site: ManagedWebsite;
  summary: WebsiteSummary;
  review: ReviewSummary;
  comments: CommentView[];
  publications: PublicationView[];
  preflight: Preflight;
  perms: { edit: boolean; publish: boolean; archive: boolean; review: boolean; domains: boolean };
  frameFor?: SiteFrameSrc;
}

const APPROVAL: Record<ManagedWebsite["approval"], { tone: "neutral" | "violet" | "success" | "warning"; label: string }> = {
  draft: { tone: "neutral", label: "Not submitted" }, submitted: { tone: "violet", label: "Waiting for the owner" }, approved: { tone: "success", label: "Approved" }, changes_requested: { tone: "warning", label: "Changes requested" },
};

export function ClientWebsiteWorkspace({ orgId, timeZone, site, summary, review, comments, publications, preflight, perms, frameFor = defaultSiteFrame }: Props) {
  const router = useRouter();
  const api = React.useMemo(() => createServerStudioApi(orgId), [orgId]);
  const [preview, setPreview] = React.useState(false);
  const [publish, setPublish] = React.useState(false);
  const [changes, setChanges] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [comment, setComment] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [archive, setArchive] = React.useState(false);
  const [rollback, setRollback] = React.useState<PublicationView | null>(null);
  const open = comments.filter((c) => !c.resolvedAt);
  const done = comments.filter((c) => c.resolvedAt);

  const run = async (key: string, fn: () => Promise<{ ok: boolean; error?: string }>, success: string) => {
    setBusy(key);
    const res = await fn();
    setBusy(null);
    if (!res.ok) return void toast.error(res.error ?? "That didn't work.");
    toast.success(success);
    router.refresh();
    return true;
  };

  return (
    <div className="module-stack">
      <PageHero
        eyebrow={`Client website · ${site.orgName}`} icon={<Globe className="size-5" />} title={site.name} tone="neutral"
        description="Compare the draft with what is live, leave comments for the client, ask for changes, publish an approved version, or roll back. Every action here is recorded in the audit log."
        action={
          <>
            {perms.edit && !site.archived && <Link href={`/admin/website-studio/websites/${orgId}/edit`} className="inline-flex h-10 items-center gap-2 rounded-xl brand-gradient px-4 text-sm font-medium text-white shadow-glow hover:brightness-110"><PencilRuler className="size-4" aria-hidden /> Open the editor</Link>}
            <Button variant="secondary" onClick={() => setPreview(true)}><Eye className="size-4" /> Preview the draft</Button>
            <Link href={`/admin/clients/${orgId}/website`} className="inline-flex h-10 items-center gap-2 rounded-xl border border-line bg-surface px-4 text-sm font-medium shadow-soft hover:bg-surface-2"><ExternalLink className="size-4" aria-hidden /> Domains and purchases</Link>
          </>
        }
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          <Card>
            <CardHeader><div className="flex flex-wrap items-center justify-between gap-3"><div><CardTitle>Status</CardTitle><div className="mt-1.5"><InfoChip icon={<Globe />}>{site.templateName}</InfoChip></div></div><LifecycleBadge state={site.lifecycle} /></div></CardHeader>
            <CardContent className="space-y-4">
              <dl className="grid gap-3 sm:grid-cols-3">
                <div className="min-w-0 rounded-xl bg-surface-2 p-3.5 ring-1 ring-inset ring-line"><dt className="flex items-center gap-1.5 text-[12px] font-medium text-muted"><Clock className="size-3.5" aria-hidden /> Draft last edited</dt><dd className="mt-1.5 text-[13.5px] font-semibold text-ink">{formatDateTime(site.draftUpdatedAt, timeZone)}</dd></div>
                <div className="min-w-0 rounded-xl bg-surface-2 p-3.5 ring-1 ring-inset ring-line"><dt className="flex items-center gap-1.5 text-[12px] font-medium text-muted"><Rocket className="size-3.5" aria-hidden /> Live version</dt><dd className="mt-1.5 text-[13.5px] font-semibold text-ink">{site.published ? `#${site.published.number} · ${relativeTime(site.published.publishedAt)}` : <StatusPill tone="neutral">Nothing is live</StatusPill>}</dd></div>
                <div className="min-w-0 rounded-xl bg-surface-2 p-3.5 ring-1 ring-inset ring-line"><dt className="flex items-center gap-1.5 text-[12px] font-medium text-muted"><UserCheck className="size-3.5" aria-hidden /> Owner&apos;s approval</dt><dd className="mt-1.5"><StatusPill tone={APPROVAL[site.approval].tone}>{APPROVAL[site.approval].label}</StatusPill></dd></div>
              </dl>
              {site.approvalNote && <p className="rounded-xl border-l-2 border-primary/40 bg-surface-2 p-3 text-[13px] leading-relaxed text-ink-2"><span className="font-semibold text-ink">Owner&apos;s note: </span>{site.approvalNote}</p>}
              {site.warnings.length > 0 && <ul className="space-y-1.5">{site.warnings.map((w) => <li key={w} className="flex items-start gap-2 rounded-lg bg-warning-soft px-3 py-2 text-[13px] leading-snug text-warning-ink ring-1 ring-inset ring-warning/20"><ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden /><span className="min-w-0 break-words">{w}</span></li>)}</ul>}
              <div className="flex flex-wrap gap-2 border-t border-line pt-4">
                {perms.publish && !site.archived && <Button variant="brand" onClick={() => setPublish(true)}>Publish…</Button>}
                {perms.review && !site.archived && <Button variant="secondary" onClick={() => setChanges(true)}>Request changes</Button>}
                {perms.archive && <Button variant="secondary" onClick={() => setArchive(true)}>{site.archived ? <><ArchiveRestore className="size-4" /> Restore website</> : <><Archive className="size-4" /> Archive website</>}</Button>}
              </div>
              <p className="text-[12px] leading-relaxed text-muted">Publishing needs the business owner&apos;s approval of this exact draft (or the owner publishing it). Saving never makes anything live. {preflight.blockers.length > 0 ? `Right now ${preflight.blockers.length} thing${preflight.blockers.length === 1 ? " blocks" : "s block"} publishing.` : "Nothing is blocking publication right now."}</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>What changed since the live site</CardTitle><CardDescription>{review.hasLive ? `Comparing the draft with publication ${review.liveNumber}.` : "Nothing is live yet, so there is nothing to compare."}</CardDescription></CardHeader>
            <CardContent>
              {!review.diff ? <EmptyState compact icon={<GitCompare className="size-5" />} title="Nothing to compare yet" description="The first publication will be the first version visitors see." />
                : review.diff.changes.length === 0 ? <EmptyState compact icon={<CheckCircle2 className="size-5" />} title="The draft matches the live site" />
                : (
                  <>
                    <div className="flex flex-wrap gap-1.5"><StatusPill tone="success" size="sm">{review.diff.counts.added} added</StatusPill><StatusPill tone="danger" size="sm">{review.diff.counts.removed} removed</StatusPill><StatusPill tone="primary" size="sm">{review.diff.counts.changed} changed</StatusPill><StatusPill tone="violet" size="sm">{review.diff.counts.moved} moved</StatusPill></div>
                    <ul className="mt-2 max-h-72 list-disc space-y-1 overflow-y-auto pl-5 text-[13px] text-ink-2">{review.diff.summary.map((s, i) => <li key={i}>{s}</li>)}</ul>
                  </>
                )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Publications</CardTitle><CardDescription>Every publication is kept. A rollback publishes an earlier one again as a new version.</CardDescription></CardHeader>
            <CardContent>
              {publications.length === 0 ? <EmptyState compact icon={<History className="size-5" />} title="Not published yet" description="Publications appear here once the first version goes live." /> : (
                <ul className="-mx-2 divide-y divide-line">
                  {publications.slice(0, 8).map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl px-2 py-3 transition-colors hover:bg-surface-2/70">
                      <div className="min-w-0 space-y-0.5">
                        <p className="flex flex-wrap items-center gap-2 text-[14px] font-semibold">Publication {p.number}
                          {p.status === "live" && <StatusPill tone="success" size="sm">Live</StatusPill>}{p.status === "failed" && <StatusPill tone="danger" size="sm">Couldn&apos;t be served</StatusPill>}{p.status === "superseded" && <StatusPill tone="neutral" size="sm">Superseded</StatusPill>}{p.rolledBackTo !== null && <InfoChip icon={<Undo2 />}>Rolled back to {p.rolledBackTo}</InfoChip>}</p>
                        <p className="text-[12.5px] text-muted">{formatDateTime(p.publishedAt, timeZone)}{p.publishedByName ? ` by ${p.publishedByName}` : ""}</p>
                        {p.note && <p className="text-[13px] italic text-ink-2">“{p.note}”</p>}
                      </div>
                      {perms.publish && p.status === "superseded" && <Button size="sm" variant="secondary" className="max-sm:h-10" onClick={() => setRollback(p)}><Undo2 className="size-3.5" /> Roll back to this</Button>}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <aside className="space-y-6" aria-label="Site details">
          <Card className="overflow-hidden"><FrameThumb src={frameFor(site, true)} title={`${site.name} draft`} /></Card>
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2"><ShieldCheck className="size-4 text-muted" aria-hidden /> Domains</CardTitle></CardHeader>
            <CardContent>
              <ul className="space-y-2.5">
                {summary.domains.map((d) => (
                  <li key={d.id} className="flex flex-col gap-1.5 rounded-xl bg-surface-2 p-3 ring-1 ring-inset ring-line"><span className="flex items-center gap-1.5 text-[13px] font-medium text-ink"><Globe className="size-3.5 shrink-0 text-muted" aria-hidden /><span className="min-w-0 truncate" title={d.hostname}>{d.hostname}</span></span><span><StatusPill tone={domainStatusTone(d)}>{domainStatusLabel(d)}</StatusPill></span></li>
                ))}
                {summary.domains.length === 0 && <li><EmptyState compact icon={<Globe className="size-5" />} title="No domains" /></li>}
              </ul>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2"><MessageSquare className="size-4" aria-hidden /> Comments</CardTitle><CardDescription>Visible to the client&apos;s team in their editor.</CardDescription></CardHeader>
            <CardContent className="space-y-4">
              {perms.review && (
                <form onSubmit={(e) => { e.preventDefault(); if (comment.trim()) void run("comment", () => addCommentAction(comment, null, null, orgId), "Comment added.").then((ok) => ok && setComment("")); }} className="space-y-2">
                  <AreaControl aria-label="Add a comment" rows={3} value={comment} maxLength={2000} placeholder="Leave a note for the client's team" onChange={(e) => setComment(e.target.value)} />
                  <Button type="submit" size="sm" variant="soft" loading={busy === "comment"} disabled={!comment.trim()}>Add comment</Button>
                </form>
              )}
              {open.length === 0 && done.length === 0 && <EmptyState compact icon={<MessageSquare className="size-5" />} title="No comments yet" description="Notes you leave here are visible to the client's team." />}
              <ul className="space-y-3">
                {[...open, ...done].map((c) => (
                  <li key={c.id} className={c.resolvedAt ? "rounded-xl bg-surface-2/70 p-3 ring-1 ring-inset ring-line" : "rounded-xl bg-surface-2 p-3 ring-1 ring-inset ring-line-strong"}>
                    <div className="flex items-center gap-2"><AvatarTile name={c.authorName ?? "Someone"} size="sm" /><span className="min-w-0 truncate text-[12.5px] font-semibold text-ink">{c.authorName ?? "Someone"}</span><StatusPill tone={c.authorKind === "agency" ? "primary" : "neutral"} size="sm" dot={false}>{c.authorKind === "agency" ? "iAcquire" : "Client"}</StatusPill><span className="ml-auto shrink-0 text-[12px] text-muted">{relativeTime(c.createdAt)}</span></div>
                    <p className={c.resolvedAt ? "mt-2 break-words text-[13px] leading-relaxed text-ink-2" : "mt-2 break-words text-[13px] leading-relaxed text-ink"}>{c.body}</p>
                    <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
                      {c.resolvedAt ? <StatusPill tone="success" size="sm">Resolved</StatusPill> : <StatusPill tone="warning" size="sm">Open</StatusPill>}
                      <button type="button" onClick={() => void run(`r${c.id}`, () => resolveCommentAction(c.id, !c.resolvedAt, orgId), c.resolvedAt ? "Reopened." : "Marked resolved.")} className="inline-flex min-h-8 items-center font-medium text-primary-ink hover:underline">{c.resolvedAt ? "Reopen" : "Mark resolved"}</button>
                    </p>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </aside>
      </div>

      {preview && <SitePreviewOverlay title={`${site.name} · ${site.orgName}`} src={frameFor(site, false)} onClose={() => setPreview(false)} />}
      {publish && (
        <StudioApiProvider value={api}>
          <PublishDialog open onClose={() => setPublish(false)} mode="publish" host={site.domain?.hostname ?? summary.platformHost} onDone={() => router.refresh()} />
        </StudioApiProvider>
      )}
      <Dialog open={changes} onOpenChange={setChanges} size="sm" title="Request changes" description="The note goes to the business owner and the website returns to draft with it attached. Nothing live changes."
        footer={<><Button variant="ghost" onClick={() => setChanges(false)}>Cancel</Button><Button variant="brand" loading={busy === "changes"} disabled={note.trim().length < 3} onClick={() => void run("changes", () => requestChangesAction(note, orgId), "The owner has been asked for changes.").then((ok) => { if (ok) { setChanges(false); setNote(""); } })}>Send request</Button></>}>
        <AreaControl aria-label="What should change" rows={4} value={note} maxLength={600} placeholder="What would you like the owner to change?" onChange={(e) => setNote(e.target.value)} />
      </Dialog>
      <Dialog open={archive} onOpenChange={setArchive} size="sm" title={site.archived ? "Restore this website?" : "Archive this website?"}
        description={site.archived ? "It returns to the lists as a draft. It isn't published again until someone publishes it." : "It is taken offline and hidden from the agency's lists. Nothing is deleted, and it can be restored at any time."}
        footer={<><Button variant="ghost" onClick={() => setArchive(false)}>Cancel</Button><Button variant="brand" loading={busy === "archive"} onClick={() => void run("archive", () => setArchivedAction(!site.archived, orgId), site.archived ? "Website restored." : "Website archived.").then((ok) => ok && setArchive(false))}>{site.archived ? "Restore" : "Archive"}</Button></>} />
      <Dialog open={rollback !== null} onOpenChange={(o) => !o && setRollback(null)} size="sm" title={rollback ? `Put publication ${rollback.number} live again?` : "Roll back"}
        description="Visitors see that earlier version straight away. We check it is being served, and if it isn't, the current one stays live."
        footer={<><Button variant="ghost" onClick={() => setRollback(null)}>Cancel</Button><Button variant="brand" loading={busy === "rollback"} onClick={() => rollback && void run("rollback", () => rollbackAction(rollback.number, orgId), `Publication ${rollback.number} is live again.`).then((ok) => ok && setRollback(null))}>Put it live</Button></>} />
    </div>
  );
}
