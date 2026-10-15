"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Archive, ArchiveRestore, CheckCircle2, ExternalLink, Eye, Globe, MessageSquare, PencilRuler, ShieldAlert, Undo2 } from "lucide-react";
import { addCommentAction, requestChangesAction, resolveCommentAction, rollbackAction, setArchivedAction } from "@/app/actions/website";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/primitives";
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
  perms: { edit: boolean; publish: boolean; review: boolean; domains: boolean };
  frameFor?: SiteFrameSrc;
}

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
            <CardHeader><div className="flex flex-wrap items-center justify-between gap-3"><div><CardTitle>Status</CardTitle><CardDescription>{site.templateName}</CardDescription></div><LifecycleBadge state={site.lifecycle} /></div></CardHeader>
            <CardContent className="space-y-4">
              <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-3 text-[13px]">
                <div><dt className="text-muted">Draft last edited</dt><dd className="font-medium">{formatDateTime(site.draftUpdatedAt, timeZone)}</dd></div>
                <div><dt className="text-muted">Live version</dt><dd className="font-medium">{site.published ? `#${site.published.number} · ${relativeTime(site.published.publishedAt)}` : "Nothing is live"}</dd></div>
                <div><dt className="text-muted">Owner&apos;s approval</dt><dd className="font-medium capitalize">{site.approval.replace("_", " ")}</dd></div>
              </dl>
              {site.approvalNote && <p className="rounded-xl bg-surface-2 p-3 text-[13px] leading-relaxed text-ink-2"><span className="font-semibold">Note: </span>{site.approvalNote}</p>}
              {site.warnings.length > 0 && <ul className="space-y-1.5">{site.warnings.map((w) => <li key={w} className="flex items-start gap-2 text-[13px] text-warning-ink"><ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />{w}</li>)}</ul>}
              <div className="flex flex-wrap gap-2 border-t border-line pt-4">
                {perms.publish && !site.archived && <Button variant="brand" onClick={() => setPublish(true)}>Publish…</Button>}
                {perms.review && !site.archived && <Button variant="secondary" onClick={() => setChanges(true)}>Request changes</Button>}
                {perms.publish && <Button variant="ghost" onClick={() => setArchive(true)}>{site.archived ? <><ArchiveRestore className="size-4" /> Restore website</> : <><Archive className="size-4" /> Archive website</>}</Button>}
              </div>
              <p className="text-[12px] leading-relaxed text-muted">Publishing needs the business owner&apos;s approval of this exact draft (or the owner publishing it). Saving never makes anything live. {preflight.blockers.length > 0 ? `Right now ${preflight.blockers.length} thing${preflight.blockers.length === 1 ? " blocks" : "s block"} publishing.` : "Nothing is blocking publication right now."}</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>What changed since the live site</CardTitle><CardDescription>{review.hasLive ? `Comparing the draft with publication ${review.liveNumber}.` : "Nothing is live yet, so there is nothing to compare."}</CardDescription></CardHeader>
            <CardContent>
              {!review.diff ? <p className="text-[13px] text-muted">The first publication will be the first version visitors see.</p>
                : review.diff.changes.length === 0 ? <p className="flex items-center gap-2 text-[13.5px] text-success-ink"><CheckCircle2 className="size-4" aria-hidden /> The draft matches the live site.</p>
                : (
                  <>
                    <p className="text-[12.5px] text-muted">{review.diff.counts.added} added · {review.diff.counts.removed} removed · {review.diff.counts.changed} changed · {review.diff.counts.moved} moved</p>
                    <ul className="mt-2 max-h-72 list-disc space-y-1 overflow-y-auto pl-5 text-[13px] text-ink-2">{review.diff.summary.map((s, i) => <li key={i}>{s}</li>)}</ul>
                  </>
                )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Publications</CardTitle><CardDescription>Every publication is kept. A rollback publishes an earlier one again as a new version.</CardDescription></CardHeader>
            <CardContent>
              {publications.length === 0 ? <p className="text-[13px] text-muted">Not published yet.</p> : (
                <ul className="divide-y divide-line">
                  {publications.slice(0, 8).map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                      <div className="min-w-0 space-y-0.5">
                        <p className="flex flex-wrap items-center gap-2 text-[14px] font-semibold">Publication {p.number}
                          {p.status === "live" && <Badge tone="success">Live</Badge>}{p.status === "failed" && <Badge tone="danger">Couldn&apos;t be served</Badge>}{p.rolledBackTo !== null && <Badge>Rolled back to {p.rolledBackTo}</Badge>}</p>
                        <p className="text-[12.5px] text-muted">{formatDateTime(p.publishedAt, timeZone)}{p.publishedByName ? ` by ${p.publishedByName}` : ""}</p>
                        {p.note && <p className="text-[13px] text-ink-2">“{p.note}”</p>}
                      </div>
                      {perms.publish && p.status === "superseded" && <Button size="sm" variant="secondary" onClick={() => setRollback(p)}><Undo2 className="size-3.5" /> Roll back to this</Button>}
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
            <CardHeader><CardTitle>Domains</CardTitle></CardHeader>
            <CardContent>
              <ul className="space-y-2.5">
                {summary.domains.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 text-[13px]"><span className="min-w-0 truncate font-medium">{d.hostname}</span><Badge tone={domainStatusTone(d)}>{domainStatusLabel(d)}</Badge></li>
                ))}
                {summary.domains.length === 0 && <li className="text-[13px] text-muted">No domains.</li>}
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
              {open.length === 0 && done.length === 0 && <p className="text-[13px] text-muted">No comments yet.</p>}
              <ul className="space-y-3">
                {[...open, ...done].map((c) => (
                  <li key={c.id} className={c.resolvedAt ? "rounded-lg bg-surface-2 p-2" : undefined}>
                    <p className="text-[13px] leading-relaxed">{c.body}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[11.5px] text-muted">
                      <span>{c.authorName ?? "Someone"} · {c.authorKind === "agency" ? "iAcquire" : "Client"} · {relativeTime(c.createdAt)}</span>
                      <button type="button" onClick={() => void run(`r${c.id}`, () => resolveCommentAction(c.id, !c.resolvedAt, orgId), c.resolvedAt ? "Reopened." : "Marked resolved.")} className="font-medium text-primary-ink hover:underline">{c.resolvedAt ? "Reopen" : "Mark resolved"}</button>
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
