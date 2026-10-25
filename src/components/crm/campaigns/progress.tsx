"use client";

import * as React from "react";
import Link from "next/link";
import { ListFilter, MessagesSquare, ShieldCheck } from "lucide-react";
import { Badge, Card, EmptyState, ProgressBar } from "@/components/ui/primitives";
import { Pagination } from "@/components/crm/ui";
import { describeFilter, useFilterFields, type FilterOptions } from "@/components/crm/filter-builder";
import { CHANNEL_LABELS, type Channel } from "@/lib/messaging";
import { parseFilter } from "@/lib/crm/filters";
import { cn, formatDateTime, relativeTime } from "@/lib/utils";
import type { CrmScope } from "@/server/crm/page";
import type { CampaignDetail, RecipientFilter, RecipientPage } from "@/server/crm/campaigns";
import { APPROVAL_STATE, Fingerprint, RECIPIENT_STATUS, handedOver, money, reasonLabel } from "@/components/crm/campaigns/parts";

const n = (v: number) => v.toLocaleString("en-US");

function Stat({ label, value, tone, hint }: { label: string; value: number; tone?: "danger" | "warning" | "success"; hint?: string }) {
  return (
    <div className={cn("rounded-2xl border px-4 py-3", tone === "danger" && value ? "border-danger/25 bg-danger-soft" : tone === "warning" && value ? "border-warning/30 bg-warning-soft" : "border-line bg-surface")} title={hint}>
      <dt className="text-[12px] font-medium text-muted">{label}</dt>
      <dd className={cn("mt-0.5 text-[20px] font-semibold tabular-nums", tone === "danger" && value ? "text-danger-ink" : tone === "success" && value ? "text-success-ink" : "text-ink")}>{n(value)}</dd>
    </div>
  );
}

/** How far a started campaign got: counts by outcome, why people were left out, and why messages weren't delivered. */
export function CampaignProgress({ campaign, timezone }: { campaign: CampaignDetail; timezone: string }) {
  const c = campaign.counts;
  const done = handedOver(c) + c.excluded;
  const pct = c.total ? (done / c.total) * 100 : 0;
  const notYet = c.pending + c.queued;
  const reasons = Object.entries(c.reasons).sort((a, b) => b[1] - a[1]);
  const failures = Object.entries(c.failures).sort((a, b) => b[1] - a[1]);
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="text-[15px] font-semibold text-ink">Progress</h3>
          <p className="mt-0.5 text-[12.5px] text-muted">
            {campaign.startedAt ? <>Started {formatDateTime(campaign.startedAt, timezone)}</> : "Not started"}
            {campaign.completedAt && <> · {campaign.status === "cancelled" ? "Cancelled" : "Finished"} {formatDateTime(campaign.completedAt, timezone)}</>}
          </p>
        </div>
        <p className="text-[12.5px] tabular-nums text-muted">{Math.round(pct)}% handled</p>
      </div>
      <ProgressBar className="mt-3" value={pct} tone={campaign.status === "paused" ? "warning" : campaign.status === "completed" ? "success" : "primary"} label="Share of recipients handled" />
      <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Recipients" value={c.total} hint="Everyone on the list when it started." />
        <Stat label="Sent" value={c.sent + c.delivered + c.unsubscribed} hint="Handed to the provider." />
        <Stat label="Delivered" value={c.delivered} tone="success" hint="Only when the provider confirmed delivery." />
        <Stat label="Not delivered" value={c.failed + c.bounced} tone="danger" />
        <Stat label="Unsubscribed" value={c.unsubscribed} tone="warning" hint="Withdrew marketing consent after it was sent." />
        <Stat label="Left out" value={c.excluded} hint="The send rules left them out, with the reason below." />
        <Stat label="Not yet" value={notYet} hint="Waiting for their turn or queued to leave." />
        <Stat label="Waiting for a better time" value={c.waiting} hint="Quiet hours, business hours or spacing between messages." />
      </dl>
      {(reasons.length > 0 || failures.length > 0) && (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {reasons.length > 0 && (
            <div>
              <p className="text-[12px] font-semibold uppercase tracking-wider text-faint">Why people were left out</p>
              <ul className="mt-1.5 space-y-1 text-[12.5px]">
                {reasons.map(([r, v]) => <li key={r} className="flex justify-between gap-3"><span className="text-ink-2">{reasonLabel(r, campaign.channel)}</span><span className="tabular-nums text-muted">{n(v)}</span></li>)}
              </ul>
            </div>
          )}
          {failures.length > 0 && (
            <div>
              <p className="text-[12px] font-semibold uppercase tracking-wider text-faint">Why messages weren&apos;t delivered</p>
              <ul className="mt-1.5 space-y-1 text-[12.5px]">
                {failures.map(([r, v]) => <li key={r} className="flex justify-between gap-3"><span className="text-ink-2">{reasonLabel(r, campaign.channel)}</span><span className="tabular-nums text-muted">{n(v)}</span></li>)}
              </ul>
            </div>
          )}
        </div>
      )}
      <p className="mt-4 text-[12px] leading-relaxed text-muted">Delivery, bounces and unsubscribes come from the provider&apos;s own reports and your contacts&apos; consent history, and update every minute or so.</p>
    </Card>
  );
}

/** The approved campaign as it was approved: the exact wording, the audience, schedule, pace, the estimate at approval, and who decided. */
export function CampaignSummary({ scope, campaign, filterOptions, listFilter }: { scope: CrmScope; campaign: CampaignDetail; filterOptions: FilterOptions; listFilter: unknown }) {
  const fields = useFilterFields("contact", filterOptions);
  let filterText = "";
  try {
    filterText = listFilter ? describeFilter(parseFilter(listFilter), fields, filterOptions) : "";
  } catch {
    filterText = "";
  }
  const e = campaign.estimate;
  const a = campaign.approvalInfo;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="p-5">
        <h3 className="text-[15px] font-semibold text-ink">The message</h3>
        {campaign.message ? (
          <div className="mt-2 rounded-2xl border border-line bg-surface-2/60 p-3">
            <p className="mb-1.5 text-[12px] font-semibold uppercase tracking-wider text-faint">{campaign.message.name} · v{campaign.message.version} · exact wording</p>
            {campaign.message.subject && <p className="text-[13px] font-medium text-ink">{campaign.message.subject}</p>}
            <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-2">{campaign.message.body}</p>
            <p className="mt-1.5 text-[12px] text-muted">Placeholders such as {"{{contact.first_name}}"} are filled in for each person; someone missing a detail it uses is left out.</p>
          </div>
        ) : <p className="mt-2 text-[12.5px] text-muted">No message chosen.</p>}
      </Card>
      <Card className="p-5">
        <h3 className="text-[15px] font-semibold text-ink">Audience and schedule</h3>
        <dl className="mt-2 grid gap-x-3 gap-y-1.5 text-[13px] sm:grid-cols-[max-content_minmax(0,1fr)]">
          <dt className="text-muted">Channel</dt><dd className="text-ink">{CHANNEL_LABELS[campaign.channel as Channel]}</dd>
          <dt className="text-muted">Smart List</dt>
          <dd className="min-w-0 text-ink">
            {campaign.list ? <>{campaign.list.name}{filterText && <span className="block text-[12.5px] text-muted">Matches: {filterText}</span>}</> : "None"}
            {campaign.startedAt && <span className="block text-[12.5px] text-muted">Read once when sending started; later changes to the list don&apos;t change who it goes to.</span>}
          </dd>
          <dt className="text-muted">Starts</dt><dd className="text-ink">{campaign.scheduledAt ? formatDateTime(campaign.scheduledAt, scope.timezone) : "As soon as it was approved"}</dd>
          <dt className="text-muted">Pace</dt><dd className="text-ink">At most {campaign.ratePerMinute} a minute</dd>
          {e && (
            <>
              <dt className="text-muted">At approval</dt>
              <dd className="text-ink">{n(e.eligible)} of {n(e.total)} could receive it · {e.costMicros !== null ? `about ${money(e.costMicros)} at the published rate` : "price not published"}</dd>
            </>
          )}
        </dl>
        <div className="mt-4 rounded-2xl border border-line p-3">
          <p className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-ink"><ShieldCheck className="size-4 text-muted" aria-hidden />{APPROVAL_STATE[campaign.approval].label}<Fingerprint hash={campaign.approvedHash ?? a?.fingerprint} /></p>
          {a && (
            <p className="mt-1 text-[12.5px] text-muted" suppressHydrationWarning>
              {a.requestedByName ? `Requested by ${a.requestedByName}` : "Requested"} {relativeTime(a.requestedAt)}
              {a.decidedAt ? ` · decided by ${a.decidedByName ?? "the owner"} ${relativeTime(a.decidedAt)}` : ""}
            </p>
          )}
          {a?.note && <p className="mt-1 text-[12.5px] text-ink-2">“{a.note}”</p>}
        </div>
      </Card>
    </div>
  );
}

const LOG_FILTERS: Array<{ value: RecipientFilter; label: string }> = [
  { value: "all", label: "Everyone" },
  { value: "delivered", label: "Delivered" },
  { value: "sent", label: "Sent" },
  { value: "queued", label: "Queued" },
  { value: "pending", label: "Not yet" },
  { value: "failed", label: "Not delivered" },
  { value: "bounced", label: "Bounced" },
  { value: "unsubscribed", label: "Unsubscribed" },
  { value: "excluded", label: "Left out" },
];

/** Each recipient's outcome, newest change first. Names only for people the viewer may open; links to the conversation when they can see it. */
export function DeliveryLog({ scope, campaign, page, filter }: { scope: CrmScope; campaign: CampaignDetail; page: RecipientPage; filter: RecipientFilter }) {
  const base = `${scope.base}/campaigns/${campaign.id}`;
  const href = (f: RecipientFilter, p = 1) => `${base}?${new URLSearchParams({ ...(f !== "all" ? { log: f } : {}), ...(p > 1 ? { page: String(p) } : {}) }).toString()}#delivery-log`;
  const canContacts = !!scope.can["contacts.view"];
  return (
    <section id="delivery-log" aria-labelledby="delivery-log-title" className="scroll-mt-24">
      <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3 id="delivery-log-title" className="text-[15px] font-semibold text-ink">Delivery log</h3>
          <p className="text-[12.5px] text-muted">{canContacts ? "Each person's outcome, newest change first." : "Outcomes only: your access doesn't include contact details."}</p>
        </div>
      </div>
      <nav aria-label="Filter the delivery log" className="relative scrollbar-thin -mx-1 mb-3 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {LOG_FILTERS.map((f) => (
          <Link key={f.value} href={href(f.value)} aria-current={filter === f.value ? "page" : undefined} scroll={false}
            className={cn("inline-flex min-h-11 shrink-0 items-center rounded-xl border px-3 text-[12.5px] font-medium sm:min-h-8", filter === f.value ? "border-primary/25 bg-primary-soft text-primary-ink" : "border-line bg-surface text-ink-2 hover:bg-surface-2")}>
            {f.label}
          </Link>
        ))}
      </nav>
      <Card className="overflow-hidden p-0">
        {!page.rows.length ? (
          <EmptyState compact icon={<ListFilter className="size-5" />} title={filter === "all" ? "No recipients yet" : "Nobody here"} description={filter === "all" ? "Recipients are read from the Smart List when sending starts." : "No recipient has this outcome."} />
        ) : (
          <>
            <div aria-hidden className="hidden grid-cols-[minmax(0,1fr)_130px_minmax(0,1.2fr)_120px] gap-3 border-b border-line bg-surface-2/60 px-4 py-2 text-[12px] font-semibold uppercase tracking-wider text-faint md:grid">
              <span>{canContacts ? "Contact" : "Recipient"}</span><span>Outcome</span><span>Detail</span><span>Updated</span>
            </div>
            <ul className="divide-y divide-line">
              {page.rows.map((r) => {
                const s = RECIPIENT_STATUS[r.status];
                return (
                  <li key={r.contactId} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-4 py-2.5 text-[13px] md:grid-cols-[minmax(0,1fr)_130px_minmax(0,1.2fr)_120px] md:items-center">
                    <div className="min-w-0">
                      {r.name !== null ? (
                        r.name === "Removed contact" ? <span className="text-muted">Removed contact</span> : <Link href={`${scope.base}/contacts/${r.contactId}`} className="font-medium text-ink hover:underline">{r.name}</Link>
                      ) : <span className="text-muted">A recipient</span>}
                      {r.conversationId && !scope.agency && (
                        <Link href={`/inbox?conversation=${r.conversationId}`} className="ml-2 inline-flex items-center gap-1 text-[12px] text-primary hover:underline"><MessagesSquare className="size-3" aria-hidden />Conversation</Link>
                      )}
                    </div>
                    <div className="row-start-1 md:row-auto"><Badge tone={s.tone}>{s.label}</Badge></div>
                    <p className="col-span-2 text-[12.5px] text-muted md:col-span-1">
                      {r.reason ? reasonLabel(r.reason, campaign.channel) : r.status === "delivered" ? "The provider confirmed delivery." : r.status === "sent" ? "Handed to the provider." : r.status === "queued" ? "Queued to leave." : ""}
                      {r.waitUntil && <> until {formatDateTime(r.waitUntil, scope.timezone)}</>}
                    </p>
                    <p className="col-span-2 text-[12px] text-faint md:col-span-1" suppressHydrationWarning>{relativeTime(r.updatedAt)}</p>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Card>
      <div className="mt-3"><Pagination page={page.page} pageSize={page.pageSize} total={page.total} hrefFor={(p) => href(filter, p)} /></div>
    </section>
  );
}
