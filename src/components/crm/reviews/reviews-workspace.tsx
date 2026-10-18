"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, Ban, Info, Lock, MessageSquareHeart, MousePointerClick, Send, ShieldCheck, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/primitives";
import { Pagination, PageTitle, ReadOnlyNotice } from "@/components/crm/ui";
import { cn } from "@/lib/utils";
import type { CrmScope } from "@/server/crm/page";
import type { FeedbackFilter, FeedbackView, RequestFilter, ReviewDestinationView, ReviewRequestView, ReviewStats, ReviewTemplateOption } from "@/server/crm/reviews";
import { DestinationsPanel } from "@/components/crm/reviews/destinations-panel";
import { RequestReviewDialog } from "@/components/crm/reviews/request-dialog";
import { FeedbackList, RatingStars, RequestsList } from "@/components/crm/reviews/review-lists";

export type ReviewsTab = "overview" | "requests" | "feedback";

type Page<T> = { rows: T[]; total: number; page: number; pageSize: number };

const REQUEST_FILTER_LABELS: Record<RequestFilter, string> = { all: "All", waiting: "Waiting to send", sent: "Sent", opened: "Opened", feedback: "Gave feedback", clicked: "Opened a review site", failed: "Not sent" };
const FEEDBACK_FILTER_LABELS: Record<FeedbackFilter, string> = { open: "Needs follow-up", low: "Low ratings", all: "All" };

export interface ReviewsWorkspaceProps {
  scope: CrmScope;
  tab: ReviewsTab;
  days: number;
  stats: ReviewStats;
  destinations: ReviewDestinationView[];
  templates: ReviewTemplateOption[];
  requests: Page<ReviewRequestView> | null;
  feedback: Page<FeedbackView> | null;
  requestFilter: RequestFilter;
  feedbackFilter: FeedbackFilter;
  canManageLinks: boolean;
  canSend: boolean;
  canFollowUp: boolean;
  contactsLinked: boolean;
  limits: { cooldownDays: number; linkDays: number; escalateAtOrBelow: number; maxActive: number; maxTotal: number };
  initialContact: { id: string; name: string } | null;
}

const pct = (n: number, of: number) => (of > 0 ? `${Math.round((n / of) * 100)}%` : "–");

function Stat({ icon: Icon, label, value, detail }: { icon: typeof Send; label: string; value: React.ReactNode; detail?: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-2xl border border-line bg-surface p-4">
      <p className="flex items-center gap-2 text-[12.5px] font-medium text-muted"><Icon className="size-4 shrink-0" aria-hidden />{label}</p>
      <p className="mt-2 text-[26px] font-semibold leading-none tracking-[-0.03em] text-ink tabular-nums">{value}</p>
      {detail && <p className="mt-2 text-[12px] leading-relaxed text-muted">{detail}</p>}
    </div>
  );
}

function Chips<V extends string>({ label, value, options, hrefFor }: { label: string; value: V; options: Record<V, string>; hrefFor: (v: V) => string }) {
  return (
    <nav aria-label={label} className="scrollbar-thin -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
      {(Object.keys(options) as V[]).map((k) => (
        <Link
          key={k}
          href={hrefFor(k)}
          aria-current={k === value ? "page" : undefined}
          className={cn(
            "inline-flex min-h-11 shrink-0 items-center rounded-xl border px-3 text-[13px] font-medium transition-colors sm:min-h-9",
            k === value ? "border-primary/25 bg-primary-soft text-primary-ink" : "border-line bg-surface text-ink-2 hover:bg-surface-2",
          )}
        >
          {options[k]}
        </Link>
      ))}
    </nav>
  );
}

/** CRM → Reviews. The rules behind every number and button are in src/server/crm/reviews.ts. */
export function ReviewsWorkspace(p: ReviewsWorkspaceProps) {
  const { scope, tab, days, stats } = p;
  const [asking, setAsking] = React.useState(Boolean(p.initialContact) && p.canSend);
  const href = (q: { tab?: ReviewsTab; days?: number; filter?: string; page?: number }) => {
    const sp = new URLSearchParams();
    const t = q.tab ?? tab;
    if (t !== "overview") sp.set("tab", t);
    const d = q.days ?? days;
    if (d !== 30) sp.set("days", String(d));
    if (q.filter) sp.set("filter", q.filter);
    if (q.page && q.page > 1) sp.set("page", String(q.page));
    const s = sp.toString();
    return `${scope.base}/reviews${s ? `?${s}` : ""}`;
  };
  const activeLinks = p.destinations.filter((d) => d.active).length;
  const sendBlocked = !activeLinks ? "Add a public review link first." : !p.templates.length ? "Approve a review request template first." : null;
  const r = stats.requests;

  return (
    <div className="space-y-6">
      <PageTitle
        title="Reviews"
        description="Ask customers how it went. Everyone you ask gets the same public review links; what they tell you privately stays with your team."
        actions={p.canSend ? (
          <Button onClick={() => setAsking(true)} disabled={Boolean(sendBlocked)} title={sendBlocked ?? undefined}><Send className="size-4" aria-hidden />Request a review</Button>
        ) : undefined}
      />
      {!p.canSend && <ReadOnlyNotice>{scope.agency ? "Review requests and review links are the client's own: an iAcquire support session can look, not send or change them." : "Owners and managers send review requests and manage the review links."}</ReadOnlyNotice>}
      {p.canSend && sendBlocked && (
        <p className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning-soft px-4 py-3 text-[13px] leading-relaxed text-warning-ink">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            {!activeLinks ? "Requests can't be sent until there is at least one public review link below. " : ""}
            {!p.templates.length ? <>A request uses an approved service template that contains <span className="font-mono text-[12px]">{"{{review.link}}"}</span>. <Link href={`${scope.base}/templates`} className="font-medium underline">Write one in Templates</Link>.</> : null}
          </span>
        </p>
      )}

      <section aria-labelledby="reviews-numbers" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="reviews-numbers" className="text-[15px] font-semibold text-ink">Last {days === 365 ? "12 months" : `${days} days`}</h2>
          <Chips label="Period" value={String(days) as "7" | "30" | "90" | "365"} options={{ "7": "7 days", "30": "30 days", "90": "90 days", "365": "12 months" }} hrefFor={(d) => href({ days: Number(d), filter: tab === "overview" ? undefined : tab === "requests" ? p.requestFilter : p.feedbackFilter })} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Stat icon={Send} label="Requests sent" value={r.sent} detail={`${r.created} created${r.waiting ? `, ${r.waiting} waiting to send` : ""}${r.failed ? `, ${r.failed} not sent` : ""}`} />
          <Stat icon={Info} label="Opened" value={r.opened} detail={`${pct(r.opened, r.sent)} of those sent. Can include email security scanners.`} />
          <Stat icon={MousePointerClick} label="Opened a review site" value={r.clicked} detail={`${pct(r.clicked, r.sent)} of those sent. Review sites don't say who actually posted a review.`} />
          <Stat
            icon={MessageSquareHeart}
            label="Private feedback"
            value={stats.feedback.count}
            detail={stats.feedback.rated ? <>Average {stats.feedback.average?.toFixed(1)} of 5 from {stats.feedback.rated} rating{stats.feedback.rated === 1 ? "" : "s"}{stats.feedback.low ? `, ${stats.feedback.low} low` : ""}. Not public reviews.</> : "No ratings yet. Private, never published."}
          />
        </div>
        {stats.clicksByPlatform.length > 0 && (
          <p className="text-[12.5px] text-muted">
            Review sites opened: {stats.clicksByPlatform.map((c) => `${c.label} ${c.clicks}`).join(" · ")}
          </p>
        )}
      </section>

      <nav aria-label="Reviews sections" className="flex gap-1 border-b border-line">
        {([["overview", "Overview"], ["requests", "Requests"], ["feedback", "Private feedback"]] as const).map(([k, label]) => (
          <Link
            key={k}
            href={href({ tab: k })}
            aria-current={tab === k ? "page" : undefined}
            className={cn("-mb-px inline-flex min-h-11 items-center border-b-2 px-3 text-[13.5px] font-medium transition-colors", tab === k ? "border-primary text-ink" : "border-transparent text-muted hover:text-ink")}
          >
            {label}
            {k === "feedback" && stats.feedback.open > 0 && <Badge tone="primary" className="ml-2">{stats.feedback.open}</Badge>}
          </Link>
        ))}
      </nav>

      {tab === "overview" && (
        <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="min-w-0 space-y-5">
            <DestinationsPanel scope={scope} destinations={p.destinations} canManage={p.canManageLinks && !scope.readOnly} maxActive={p.limits.maxActive} maxTotal={p.limits.maxTotal} />
            <section aria-labelledby="recent-requests" className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h2 id="recent-requests" className="text-[15px] font-semibold text-ink">Recent requests</h2>
                {(p.requests?.total ?? 0) > 0 && <Link href={href({ tab: "requests" })} className="text-[13px] font-medium text-primary hover:underline">See all {p.requests?.total}</Link>}
              </div>
              <RequestsList scope={scope} rows={p.requests?.rows ?? []} canCancel={p.canSend && !scope.readOnly} contactsLinked={p.contactsLinked} emptyText="Nobody has been asked for a review yet." />
            </section>
            <section aria-labelledby="open-feedback" className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h2 id="open-feedback" className="text-[15px] font-semibold text-ink">Feedback that needs a follow-up</h2>
                {(p.feedback?.total ?? 0) > 0 && <Link href={href({ tab: "feedback" })} className="text-[13px] font-medium text-primary hover:underline">See all {p.feedback?.total}</Link>}
              </div>
              <FeedbackList scope={scope} rows={p.feedback?.rows ?? []} canFollowUp={p.canFollowUp} contactsLinked={p.contactsLinked} emptyText="Nothing waiting. New and escalated feedback appears here." />
            </section>
          </div>
          <aside className="min-w-0 space-y-4">
            <Card className="p-4 sm:p-5">
              <h2 className="flex items-center gap-2 text-[14.5px] font-semibold text-ink"><ShieldCheck className="size-4 text-primary" aria-hidden />How requests work</h2>
              <ul className="mt-3 space-y-2 text-[13px] leading-relaxed text-ink-2">
                <li>Every customer you ask sees the same public review links, whatever rating they give you privately.</li>
                <li>Sent only to customers who agreed to messages on that channel, never to anyone who opted out, outside quiet hours and within your message credits.</li>
                <li>One request per customer every {p.limits.cooldownDays} days. Their link takes feedback for {p.limits.linkDays} days.</li>
                <li>A rating of {p.limits.escalateAtOrBelow} or less creates a follow-up task for the customer&apos;s owner and tells the owner and managers. It never changes what the customer sees.</li>
                <li>iAcquire never writes, posts or counts public reviews.</li>
              </ul>
            </Card>
            <Card className="p-4 sm:p-5">
              <div className="flex items-start justify-between gap-3">
                <h2 className="flex items-center gap-2 text-[14.5px] font-semibold text-ink"><Star className="size-4 text-muted" aria-hidden />Google reviews in iAcquire</h2>
                <Badge tone="warning"><Ban className="size-3" aria-hidden />Blocked</Badge>
              </div>
              <p className="mt-2 text-[13px] leading-relaxed text-muted">
                Showing or replying to your Google reviews here needs Google&apos;s approved Business Profile API access for iAcquire, and your business location connected to it. That isn&apos;t set up, so iAcquire doesn&apos;t read, show or count Google reviews. Your Google review link above works as usual.
              </p>
            </Card>
            <Card className="p-4 sm:p-5">
              <h2 className="flex items-center gap-2 text-[14.5px] font-semibold text-ink"><Lock className="size-4 text-muted" aria-hidden />Private ratings</h2>
              {stats.feedback.rated ? (
                <ul className="mt-3 space-y-1.5" aria-label="Private ratings by score">
                  {([5, 4, 3, 2, 1] as const).map((n) => (
                    <li key={n} className="flex items-center justify-between gap-3 text-[13px]">
                      <RatingStars rating={n} />
                      <span className="tabular-nums text-ink-2">{stats.feedback.byRating[n]}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-[13px] text-muted">No private ratings in this period.</p>
              )}
            </Card>
          </aside>
        </div>
      )}

      {tab === "requests" && p.requests && (
        <section aria-label="Review requests" className="space-y-4">
          <Chips label="Filter requests" value={p.requestFilter} options={REQUEST_FILTER_LABELS} hrefFor={(f) => href({ filter: f === "all" ? undefined : f })} />
          <RequestsList scope={scope} rows={p.requests.rows} canCancel={p.canSend && !scope.readOnly} contactsLinked={p.contactsLinked} />
          <Pagination page={p.requests.page} pageSize={p.requests.pageSize} total={p.requests.total} hrefFor={(n) => href({ filter: p.requestFilter === "all" ? undefined : p.requestFilter, page: n })} />
        </section>
      )}

      {tab === "feedback" && p.feedback && (
        <section aria-label="Private feedback" className="space-y-4">
          <Chips label="Filter feedback" value={p.feedbackFilter} options={FEEDBACK_FILTER_LABELS} hrefFor={(f) => href({ filter: f })} />
          <FeedbackList scope={scope} rows={p.feedback.rows} canFollowUp={p.canFollowUp} contactsLinked={p.contactsLinked} />
          <Pagination page={p.feedback.page} pageSize={p.feedback.pageSize} total={p.feedback.total} hrefFor={(n) => href({ filter: p.feedbackFilter, page: n })} />
        </section>
      )}

      {p.canSend && (
        <RequestReviewDialog scope={scope} open={asking} onOpenChange={setAsking} templates={p.templates} initialContact={p.initialContact} cooldownDays={p.limits.cooldownDays} />
      )}
    </div>
  );
}
