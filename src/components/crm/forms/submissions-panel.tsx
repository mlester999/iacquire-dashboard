"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronDown, Globe, Inbox, Link2, RotateCcw, ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState } from "@/components/ui/primitives";
import { Pagination, ReadOnlyNotice, useCrmAction } from "@/components/crm/ui";
import { markSubmissionSpamAction, retryFormSubmissionAction } from "@/app/actions/crm-forms";
import { SUBMISSION_STATUS_LABELS, SubmissionStatusBadge } from "@/components/crm/forms/parts";
import { cn, formatDateTime } from "@/lib/utils";
import type { CrmScope } from "@/server/crm/page";
import type { FormSubmissionView, SubmissionPage, SubmissionStatus } from "@/components/crm/forms/types";

const FILTERS: Array<SubmissionStatus | "all"> = ["all", "received", "processed", "failed", "spam"];
const SOURCE_LABELS: Record<FormSubmissionView["source"], string> = { website: "Website", hosted: "Form page", api: "API", import: "Import" };

/** The submissions of one form, newest first: answers, attribution, the consent recorded, and what processing did. */
export function SubmissionsPanel({ scope, page, status, hrefFor, canSee }: { scope: CrmScope; page: SubmissionPage | null; status: SubmissionStatus | "all"; hrefFor: (q: { status?: string; page?: number }) => string; canSee: boolean }) {
  if (!canSee || !page) return <ReadOnlyNotice>Submissions contain people&apos;s details, so seeing them needs permission to see contacts.</ReadOnlyNotice>;
  const total = Object.values(page.counts).reduce((a, b) => a + b, 0);
  const canEdit = Boolean(scope.can["contacts.edit"]) && !scope.readOnly;
  return (
    <div className="space-y-4">
      <nav aria-label="Filter submissions" className="flex flex-wrap gap-1.5">
        {FILTERS.map((f) => {
          const n = f === "all" ? total : page.counts[f];
          const active = status === f;
          return (
            <Link key={f} href={hrefFor({ status: f === "all" ? undefined : f })} aria-current={active ? "page" : undefined} className={cn("inline-flex min-h-11 items-center gap-1.5 rounded-xl border px-3 text-[13px] font-medium transition-colors sm:min-h-9", active ? "border-primary/25 bg-primary-soft text-primary-ink" : "border-line bg-surface text-ink-2 hover:bg-surface-2")}>
              {f === "all" ? "All" : SUBMISSION_STATUS_LABELS[f]}
              <span className="rounded-full bg-surface-3 px-1.5 text-[12px] font-semibold tabular-nums text-ink-2">{n}</span>
            </Link>
          );
        })}
      </nav>
      {!page.rows.length ? (
        <Card>
          <EmptyState compact icon={<Inbox className="size-5" aria-hidden />} title={total ? "Nothing here" : "No submissions yet"} description={total ? "No submission has this status." : "Answers appear here as soon as someone sends the form. They're turned into contacts within a minute or two."} />
        </Card>
      ) : (
        <ul className="space-y-2">
          {page.rows.map((s) => <SubmissionRow key={s.id} s={s} scope={scope} canEdit={canEdit} />)}
        </ul>
      )}
      <Pagination page={page.page} pageSize={page.pageSize} total={page.total} hrefFor={(p) => hrefFor({ status: status === "all" ? undefined : status, page: p })} />
    </div>
  );
}

function SubmissionRow({ s, scope, canEdit }: { s: FormSubmissionView; scope: CrmScope; canEdit: boolean }) {
  const { run, busy } = useCrmAction();
  const [open, setOpen] = React.useState(false);
  const visible = s.answers.filter((a) => !a.hidden);
  const preview = visible.slice(0, 2).map((a) => a.text).filter(Boolean).join(" · ");
  const bodyId = `sub-${s.id}`;
  return (
    <li>
      <Card className="overflow-hidden">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls={bodyId} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2/60">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[13.5px] font-medium text-ink">{s.contact?.name ?? (preview || "Answers received")}</span>
              <SubmissionStatusBadge status={s.status} />
              <Badge tone="outline">{s.source === "website" ? <Globe className="size-3" aria-hidden /> : <Link2 className="size-3" aria-hidden />}{SOURCE_LABELS[s.source]}</Badge>
            </div>
            <p className="mt-0.5 truncate text-[12px] text-muted">{formatDateTime(s.createdAt, scope.timezone)} · version {s.version}{s.contact && preview ? ` · ${preview}` : ""}</p>
          </div>
          <ChevronDown className={cn("size-4 shrink-0 text-muted transition-transform", open && "rotate-180")} aria-hidden />
        </button>
        {open && (
          <div id={bodyId} className="space-y-4 border-t border-line px-4 py-4">
            {s.note && <p className={cn("rounded-xl px-3 py-2 text-[12.5px] leading-relaxed", s.status === "failed" ? "bg-danger-soft text-danger-ink" : "bg-surface-2 text-ink-2")}>{s.note}</p>}
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              {visible.map((a) => (
                <div key={a.key} className="min-w-0">
                  <dt className="text-[12px] font-medium text-muted">{a.label}</dt>
                  <dd className="mt-0.5 whitespace-pre-line break-words text-[13.5px] text-ink">{a.text || <span className="text-faint">No answer</span>}</dd>
                </div>
              ))}
            </dl>
            {(s.attribution.length > 0 || s.answers.some((a) => a.hidden)) && (
              <div>
                <h4 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-muted">Where they came from</h4>
                <dl className="mt-1.5 grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
                  {s.attribution.map((x) => <div key={x.key} className="min-w-0 text-[12.5px]"><dt className="inline text-muted">{x.label}: </dt><dd className="inline break-all text-ink-2">{x.value}</dd></div>)}
                  {s.answers.filter((a) => a.hidden).map((a) => <div key={a.key} className="min-w-0 text-[12.5px]"><dt className="inline text-muted">{a.label}: </dt><dd className="inline break-all text-ink-2">{a.text}</dd></div>)}
                </dl>
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl bg-surface-2/70 px-3 py-2.5 text-[12.5px] leading-relaxed">
                <p className="font-medium text-ink-2">Consent recorded</p>
                <p className="mt-0.5 text-muted">{s.consentText ? `“${s.consentText}”` : "No consent wording on this form."}</p>
                <p className="mt-1 text-muted">Marketing opt-in: {s.marketingOptIn ? <>ticked{s.marketingText ? ` (“${s.marketingText}”)` : ""}</> : "not ticked"}</p>
              </div>
              <div className="rounded-xl bg-surface-2/70 px-3 py-2.5 text-[12.5px] leading-relaxed">
                <p className="font-medium text-ink-2">In the CRM</p>
                <p className="mt-0.5 text-muted">Contact: {s.contact ? <Link href={`${scope.base}/contacts/${s.contact.id}`} className="font-medium text-primary-ink hover:underline">{s.contact.name}</Link> : s.status === "received" ? "being added" : "none"}</p>
                <p className="text-muted">Deal: {s.opportunity ? <Link href={`${scope.base}/opportunities/${s.opportunity.id}`} className="font-medium text-primary-ink hover:underline">{s.opportunity.name}</Link> : "none"}</p>
                {s.processedAt && <p className="text-muted">Processed {formatDateTime(s.processedAt, scope.timezone)}</p>}
              </div>
            </div>
            {canEdit && (
              <div className="flex flex-wrap gap-2">
                {s.status === "failed" && <Button size="sm" variant="secondary" loading={busy("retry")} onClick={() => void run("retry", () => retryFormSubmissionAction(scope.orgId, s.id), "Queued to be added again.")}><RotateCcw className="size-3.5" aria-hidden />Try again</Button>}
                {s.status !== "spam" ? (
                  <Button size="sm" variant="ghost" loading={busy("spam")} onClick={() => void run("spam", () => markSubmissionSpamAction(scope.orgId, s.id, true), "Marked as spam.")}><ShieldAlert className="size-3.5" aria-hidden />Mark as spam</Button>
                ) : (
                  <Button size="sm" variant="secondary" loading={busy("spam")} onClick={() => void run("spam", () => markSubmissionSpamAction(scope.orgId, s.id, false), s.contact ? "Restored." : "Restored. It will be added like any other submission.")}><ShieldCheck className="size-3.5" aria-hidden />Not spam</Button>
                )}
              </div>
            )}
          </div>
        )}
      </Card>
    </li>
  );
}
