"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowLeft, CircleCheck, Copy, Pause, Pencil, Play, RefreshCw, Send, ShieldCheck, Undo2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState, Field, Input } from "@/components/ui/primitives";
import { ConfirmDialog, Pagination, useCrmAction } from "@/components/crm/ui";
import { BatchFormDialog, statusTone } from "@/components/reputation/batches-panel";
import {
  approveBatchAction, cancelBatchAction, duplicateBatchAction, pauseBatchAction, requestBatchApprovalAction, resumeBatchAction, returnBatchAction,
} from "@/app/actions/reputation";
import { draftFromBatch } from "@/lib/reputation/batch-form";
import {
  BATCH_STATUS_LABELS, ITEM_STATUS_LABELS, PERSON_FILTERS, PERSON_FILTER_LABELS, PREVIEW_REASONS, durationWords, isEditableStatus, reasonLabel,
  type BatchPersonView, type BatchPreview, type BatchView, type PersonFilter,
} from "@/lib/reputation/batches";
import { cn } from "@/lib/utils";
import { CHANNEL_LABELS } from "@/lib/messaging";
import type { CrmScope } from "@/server/crm/page";
import type { ReviewTemplateOption } from "@/server/crm/reviews";
import type { BatchBuilderOptions } from "@/server/reputation/batches";

type Page<T> = { rows: T[]; total: number; page: number; pageSize: number };

const num = (n: number) => n.toLocaleString("en-US");
const people = (n: number) => `${num(n)} ${n === 1 ? "person" : "people"}`;

function Tile({ label, value, detail }: { label: string; value: React.ReactNode; detail?: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-2xl border border-line bg-surface p-4">
      <p className="text-[12.5px] font-medium text-muted">{label}</p>
      <p className="mt-2 text-[24px] font-semibold leading-none tracking-[-0.03em] text-ink tabular-nums">{value}</p>
      {detail && <p className="mt-2 text-[12px] leading-relaxed text-muted">{detail}</p>}
    </div>
  );
}

const DELIVERY_TEXT: Record<NonNullable<BatchPersonView["delivery"]>, string> = {
  waiting: "Message waiting to send", sent: "Message sent", opened: "Opened their link", failed: "Message didn't go", withdrawn: "Withdrawn before it was sent",
};

/** What the owner is shown before approving: who would be asked, who would not and why, the message, and what stops it if anything does. */
function PreviewCard({ preview, batch }: { preview: BatchPreview; batch: BatchView }) {
  const a = preview.audience;
  const left = PREVIEW_REASONS.filter((r) => (a.excluded[r] ?? 0) > 0);
  return (
    <Card className="space-y-4 p-4 sm:p-5">
      <div>
        <h3 className="text-[15px] font-semibold text-ink">Who would be asked</h3>
        <p className="mt-1 text-[13px] leading-relaxed text-muted">
          Checked just now against the same rules each request passes. Everyone is checked again, one by one, at the moment they are asked, so this can change a little before the batch finishes.
        </p>
      </div>
      {preview.problems.length > 0 && (
        <div role="alert" className="space-y-1.5 rounded-xl border border-warning/30 bg-warning-soft px-4 py-3 text-[13px] leading-relaxed text-warning-ink">
          <p className="flex items-center gap-2 font-medium"><AlertTriangle className="size-4 shrink-0" aria-hidden />It can&apos;t be approved yet</p>
          <ul className="list-disc space-y-1 pl-6">{preview.problems.map((p) => <li key={p}>{p}</li>)}</ul>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        <Tile label="Would be asked" value={num(a.eligible)} detail={a.eligible ? `${durationWords(preview.minutes)} at up to ${batch.ratePerMinute} a minute, then each message waits for quiet hours and business hours.` : undefined} />
        <Tile label="Left out" value={num(a.total - a.eligible)} detail={a.tooLarge ? `More than ${num(a.total)} people match.` : undefined} />
        <Tile label="Matched the dates" value={a.tooLarge ? `${num(a.total)}+` : num(a.total)} detail="Everyone a completed service was recorded for." />
      </div>
      {left.length > 0 && (
        <div>
          <h4 className="text-[13.5px] font-semibold text-ink">Why people are left out</h4>
          <ul className="mt-2 space-y-1.5" aria-label="Reasons people are left out">
            {left.map((r) => (
              <li key={r} className="flex items-center justify-between gap-3 rounded-xl bg-surface-2/70 px-3 py-2 text-[13px]">
                <span className="text-ink-2">{reasonLabel(r)}</span>
                <span className="tabular-nums font-medium text-ink">{num(a.excluded[r] ?? 0)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {(preview.sample.eligible.length > 0 || preview.sample.excluded.length > 0) && (
        <div className="grid gap-4 sm:grid-cols-2">
          {preview.sample.eligible.length > 0 && (
            <div>
              <h4 className="text-[13.5px] font-semibold text-ink">First in line</h4>
              <ul className="mt-2 space-y-1 text-[13px] text-ink-2">{preview.sample.eligible.map((p) => <li key={p.id}>{p.name}</li>)}</ul>
            </div>
          )}
          {preview.sample.excluded.length > 0 && (
            <div>
              <h4 className="text-[13.5px] font-semibold text-ink">Some who are left out</h4>
              <ul className="mt-2 space-y-1 text-[13px] text-ink-2">{preview.sample.excluded.map((p) => <li key={p.id}>{p.name}<span className="text-muted"> · {reasonLabel(p.reason)}</span></li>)}</ul>
            </div>
          )}
        </div>
      )}
      {preview.message && (
        <div className="space-y-1.5 rounded-2xl border border-line bg-surface-2/50 p-3">
          <p className="text-[12px] font-medium text-muted">What {preview.message.forName} would receive by {CHANNEL_LABELS[preview.channel]} (each customer gets their own link)</p>
          {preview.message.subject && <p className="text-[13px] font-medium text-ink">{preview.message.subject}</p>}
          <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-2">{preview.message.body}</p>
        </div>
      )}
    </Card>
  );
}

/**
 * One batch: what it is for, the preview and the approval while it is being prepared, then how far it got. Preparing and pausing are for owners and managers of the client's own
 * workspace; approving is the owner's alone.
 */
export function BatchDetail({ scope, batch, preview, people: peoplePage, peopleFilter, canPrepare, canApprove, enabled, templates, options, surveysEnabled, today, backHref, peopleHref }: {
  scope: CrmScope;
  batch: BatchView;
  preview: BatchPreview | null;
  people: Page<BatchPersonView> | null;
  peopleFilter: PersonFilter;
  canPrepare: boolean;
  canApprove: boolean;
  enabled: boolean;
  templates: ReviewTemplateOption[];
  options: BatchBuilderOptions;
  surveysEnabled: boolean;
  today: string;
  backHref: string;
  peopleHref: (q: { filter?: PersonFilter; page?: number }) => string;
}) {
  const { run, busy } = useCrmAction();
  const router = useRouter();
  const [editing, setEditing] = React.useState(false);
  const [confirm, setConfirm] = React.useState<null | "approve" | "cancel" | "return">(null);
  const [note, setNote] = React.useState("");
  const noteId = React.useId();
  const s = batch.status;
  const c = batch.counts;
  const editable = isEditableStatus(s);
  const live = s === "approved" || s === "sending";
  const ready = Boolean(preview?.canApprove && preview.fingerprint);
  const handled = c.total - c.pending;

  const approve = async () => {
    if (!preview?.fingerprint) return;
    const ok = await run("approve", () => approveBatchAction(scope.orgId, batch.id, preview.fingerprint!), (r) => `Approved. ${people(r.eligible)} will be asked, ${durationWords(r.minutes)} once it starts.`);
    if (ok) setConfirm(null);
  };

  return (
    <div className="space-y-5">
      <Link href={backHref} className="inline-flex min-h-11 items-center gap-1.5 text-[13px] font-medium text-primary hover:underline sm:min-h-9"><ArrowLeft className="size-4" aria-hidden />All batches</Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="min-w-0 text-[18px] font-semibold tracking-[-0.01em] text-ink">{batch.name}</h2>
            <Badge tone={statusTone(s)}>{BATCH_STATUS_LABELS[s]}</Badge>
          </div>
          <p className="mt-1 max-w-2xl text-[13.5px] leading-relaxed text-ink-2">{batch.criteriaText}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canPrepare && editable && enabled && <Button variant="secondary" size="sm" onClick={() => setEditing(true)}><Pencil className="size-4" aria-hidden />Change</Button>}
          {canPrepare && editable && enabled && !canApprove && s === "draft" && (
            <Button size="sm" disabled={!ready} loading={busy("request")} onClick={() => preview?.fingerprint && run("request", () => requestBatchApprovalAction(scope.orgId, batch.id, preview.fingerprint!), "Sent to the owner for approval.")}>
              <Send className="size-4" aria-hidden />Ask the owner to approve
            </Button>
          )}
          {canApprove && editable && enabled && <Button size="sm" disabled={!ready} onClick={() => setConfirm("approve")}><ShieldCheck className="size-4" aria-hidden />Approve and start</Button>}
          {canApprove && s === "awaiting_approval" && <Button variant="secondary" size="sm" onClick={() => setConfirm("return")}><Undo2 className="size-4" aria-hidden />Send back</Button>}
          {canPrepare && live && <Button variant="secondary" size="sm" loading={busy("pause")} onClick={() => run("pause", () => pauseBatchAction(scope.orgId, batch.id), "Paused. Nothing more is asked, and messages not yet sent are held.")}><Pause className="size-4" aria-hidden />Pause</Button>}
          {canPrepare && s === "paused" && enabled && <Button size="sm" loading={busy("resume")} onClick={() => run("resume", () => resumeBatchAction(scope.orgId, batch.id), "Resumed. The approval is checked again before anyone is asked.")}><Play className="size-4" aria-hidden />Resume</Button>}
          {canPrepare && !["completed", "cancelled", "stopped"].includes(s) && <Button variant="ghost" size="sm" onClick={() => setConfirm("cancel")}><XCircle className="size-4" aria-hidden />{editable ? "Discard" : "Cancel batch"}</Button>}
          {canPrepare && enabled && ["completed", "cancelled", "stopped"].includes(s) && (
            <Button variant="secondary" size="sm" loading={busy("copy")} onClick={async () => {
              const copy = await run("copy", () => duplicateBatchAction(scope.orgId, batch.id), "Copied as a new draft.");
              if (copy) router.push(`${scope.base}/reviews?tab=batches&batch=${copy.id}`);
            }}><Copy className="size-4" aria-hidden />Copy as a new draft</Button>
          )}
        </div>
      </div>

      {!enabled && <p role="status" className="rounded-xl border border-line bg-surface-2/60 px-4 py-3 text-[13px] leading-relaxed text-ink-2">Batches are switched off for this workspace, so this one is not being worked on. You can still look at it, pause it or cancel it.</p>}
      {c.notice && (
        <p role={s === "stopped" || s === "paused" ? "alert" : "status"} className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning-soft px-4 py-3 text-[13px] leading-relaxed text-warning-ink">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /><span>{c.notice.detail}</span>
        </p>
      )}
      {s === "awaiting_approval" && <p role="status" className="rounded-xl border border-line bg-surface-2/60 px-4 py-3 text-[13px] leading-relaxed text-ink-2">Waiting for the owner{batch.requestedByName ? `, asked by ${batch.requestedByName}` : ""}. Nothing is sent until they approve.</p>}
      {s === "approved" && <p role="status" className="rounded-xl border border-line bg-surface-2/60 px-4 py-3 text-[13px] leading-relaxed text-ink-2">Approved{batch.approvedByName ? ` by ${batch.approvedByName}` : ""}. It starts the next time the scheduler runs; the scheduler isn&apos;t something you can start from here.</p>}

      <Card className="p-4 sm:p-5">
        <h3 className="text-[15px] font-semibold text-ink">About this batch</h3>
        <dl className="mt-3 grid gap-x-6 gap-y-3 text-[13px] sm:grid-cols-2">
          <div><dt className="text-muted">Message</dt><dd className="mt-0.5 text-ink">{batch.template ? batch.template.name : "The template is no longer available"}</dd></div>
          <div><dt className="text-muted">Goes by</dt><dd className="mt-0.5 text-ink">{CHANNEL_LABELS[batch.channel]}, to customers who agreed to service messages there</dd></div>
          <div><dt className="text-muted">Sends</dt><dd className="mt-0.5 text-ink">{batch.kind === "survey" ? `A short survey (${batch.scale === "nps10" ? "0 to 10" : "1 to 5"}) with the public review links` : "A review request with the public review links"}</dd></div>
          <div><dt className="text-muted">Pace</dt><dd className="mt-0.5 text-ink">Up to {batch.ratePerMinute} a minute</dd></div>
          <div><dt className="text-muted">Made by</dt><dd className="mt-0.5 text-ink">{batch.createdByName ?? "A teammate"}</dd></div>
          <div><dt className="text-muted">Approved</dt><dd className="mt-0.5 text-ink">{batch.approvedAt ? `${batch.approvedByName ?? "The owner"}, ${new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: scope.timezone }).format(new Date(batch.approvedAt))}` : "Not yet"}</dd></div>
        </dl>
        <p className="mt-4 text-[12.5px] leading-relaxed text-muted">
          The owner&apos;s approval covers the message&apos;s approved wording, who it is for, the channel and the pace. If any of that changes, the batch stops instead of sending something the owner didn&apos;t see. A person on your team can hold a customer back from automatic messages; those customers are counted as left out, never asked.
        </p>
      </Card>

      {editable && preview && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="sr-only">Preview</h3>
            <Button variant="ghost" size="sm" onClick={() => router.refresh()}><RefreshCw className="size-4" aria-hidden />Check again</Button>
          </div>
          <PreviewCard preview={preview} batch={batch} />
        </div>
      )}

      {c.total > 0 && (
        <section aria-label="Progress" className="space-y-3">
          <h3 className="text-[15px] font-semibold text-ink">How it is going</h3>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Tile label="Asked" value={num(c.queued)} detail={batch.results.sent ? `${num(batch.results.sent)} sent${batch.results.opened ? `, ${num(batch.results.opened)} opened` : ""}${batch.results.undelivered ? `, ${num(batch.results.undelivered)} didn't go` : ""}` : "Messages queued so far."} />
            <Tile label="Waiting" value={num(c.pending)} detail={s === "sending" ? "Asked a few at a time." : undefined} />
            <Tile label="Left out" value={num(c.excluded)} detail="By the send rules or a person's hold." />
            <Tile label="Not sent" value={num(c.failed)} detail={c.failed ? "See the list below for why." : undefined} />
          </div>
          <div
            role="progressbar"
            aria-label="People handled"
            aria-valuemin={0}
            aria-valuemax={c.total}
            aria-valuenow={handled}
            className="h-2 overflow-hidden rounded-full bg-surface-2"
          >
            <div className={cn("h-full rounded-full bg-primary transition-[width]")} style={{ width: `${c.total ? Math.round((handled / c.total) * 100) : 0}%` }} />
          </div>
          {Object.keys(c.reasons).length > 0 && (
            <ul className="flex flex-wrap gap-2" aria-label="Why people were left out or not sent">
              {Object.entries(c.reasons).sort((x, y) => y[1] - x[1]).map(([r, n]) => <li key={r}><Badge tone="outline">{reasonLabel(r)}: {num(n)}</Badge></li>)}
            </ul>
          )}
        </section>
      )}

      {peoplePage && c.total > 0 && (
        <section aria-label="People in this batch" className="space-y-3">
          <h3 className="text-[15px] font-semibold text-ink">People</h3>
          <nav aria-label="Filter people" className="relative scrollbar-thin -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
            {PERSON_FILTERS.map((f) => (
              <Link
                key={f}
                href={peopleHref({ filter: f })}
                aria-current={f === peopleFilter ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-11 shrink-0 items-center rounded-xl border px-3 text-[13px] font-medium transition-colors sm:min-h-9",
                  f === peopleFilter ? "border-primary/25 bg-primary-soft text-primary-ink" : "border-line bg-surface text-ink-2 hover:bg-surface-2",
                )}
              >
                {PERSON_FILTER_LABELS[f]}
              </Link>
            ))}
          </nav>
          {peoplePage.rows.length === 0 ? (
            <EmptyState compact icon={<CircleCheck className="size-5" />} title="Nobody here" description="No one in this batch matches that filter." />
          ) : (
            <ul className="divide-y divide-line rounded-xl border border-line" aria-label="People">
              {peoplePage.rows.map((p) => (
                <li key={p.contactId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                  <div className="min-w-0">
                    {scope.base ? <Link href={`${scope.base}/contacts/${p.contactId}`} className="truncate text-[13.5px] font-medium text-ink hover:underline">{p.name}</Link> : <span className="truncate text-[13.5px] font-medium text-ink">{p.name}</span>}
                    {p.reasonText && <p className="text-[12.5px] text-muted">{p.reasonText}</p>}
                    {p.delivery && <p className="text-[12.5px] text-muted">{DELIVERY_TEXT[p.delivery]}</p>}
                  </div>
                  <Badge tone={p.status === "queued" ? "success" : p.status === "failed" ? "danger" : p.status === "excluded" ? "neutral" : "primary"}>{ITEM_STATUS_LABELS[p.status]}</Badge>
                </li>
              ))}
            </ul>
          )}
          <Pagination page={peoplePage.page} pageSize={peoplePage.pageSize} total={peoplePage.total} hrefFor={(n) => peopleHref({ filter: peopleFilter, page: n })} />
        </section>
      )}

      {canPrepare && enabled && editable && (
        <BatchFormDialog
          key={`${batch.id}:${batch.updatedAt}:${editing}`}
          scope={scope}
          open={editing}
          onOpenChange={setEditing}
          templates={templates}
          options={options}
          surveysEnabled={surveysEnabled}
          today={today}
          initial={draftFromBatch(batch, today)}
          editing={{ id: batch.id, updatedAt: batch.updatedAt }}
        />
      )}

      <ConfirmDialog
        open={confirm === "approve"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Approve and start this batch?"
        description={preview ? `${people(preview.audience.eligible)} would be asked by ${CHANNEL_LABELS[preview.channel]}, at up to ${batch.ratePerMinute} a minute (${durationWords(preview.minutes)}), using exactly the wording you were shown.` : undefined}
        confirmLabel="Approve and start"
        loading={busy("approve")}
        onConfirm={approve}
      >
        <ul className="list-disc space-y-1.5 pl-5 text-[13px] leading-relaxed text-ink-2">
          <li>Each customer is checked again when they are asked: consent, opt-outs, the 30-day limit, quiet hours and your message credits.</li>
          <li>If the message, the dates, the channel or the pace changes, the batch stops instead of sending something you didn&apos;t see.</li>
          <li>The approval lapses after 14 days if the batch hasn&apos;t finished. You can pause or cancel it at any time.</li>
        </ul>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === "cancel"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={editable ? "Discard this batch?" : "Cancel this batch?"}
        description={editable ? "Nothing has been sent. The batch is thrown away." : "Nobody else is asked, and messages that haven't been sent yet are stopped. Messages already sent stay sent."}
        confirmLabel={editable ? "Discard" : "Cancel batch"}
        danger
        loading={busy("cancel")}
        onConfirm={async () => {
          if (await run("cancel", () => cancelBatchAction(scope.orgId, batch.id), editable ? "Batch discarded." : "Batch cancelled.")) setConfirm(null);
        }}
      />
      <ConfirmDialog
        open={confirm === "return"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Send this batch back?"
        description="It goes back to a draft and nothing is sent. Tell the person who prepared it what to change."
        confirmLabel="Send back"
        loading={busy("return")}
        onConfirm={async () => {
          if (await run("return", () => returnBatchAction(scope.orgId, batch.id, note.trim() || null), "Sent back.")) {
            setConfirm(null);
            setNote("");
          }
        }}
      >
        <Field label="Note" htmlFor={noteId} optional>
          <Input id={noteId} maxLength={300} value={note} className="text-[16px] sm:text-[14px]" onChange={(e) => setNote(e.target.value)} />
        </Field>
      </ConfirmDialog>
    </div>
  );
}
