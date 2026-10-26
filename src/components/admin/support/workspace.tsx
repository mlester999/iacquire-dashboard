"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowUpRight, Building2, Flame, Keyboard, LifeBuoy, MessageSquare, PencilRuler, ThumbsUp, TriangleAlert } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { Card, EmptyState } from "@/components/ui/primitives";
import { InfoChip, StatusPill } from "@/components/ui/status";
import { QueuePane } from "@/components/admin/support/queue-pane";
import { ThreadPane } from "@/components/admin/support/thread-pane";
import { DetailsPane } from "@/components/admin/support/details-pane";
import { queueHref, type QueueQuery } from "@/components/admin/support/meta";
import { markReadAction } from "@/app/actions/support-agency";
import { REQUEST_TYPE_LABELS, categoryLabel, statusLabelForAgency, type FeedbackStage, FEEDBACK_STAGE_LABELS } from "@/lib/support/lifecycle";
import { cn, formatDateTime, sentenceCase } from "@/lib/utils";
import type { AgencyRequestDetail } from "@/server/support/agency";
import type { AgencyListItem, AgencyViewCounts } from "@/server/support/types";
import type { FilterOptions } from "@/server/support/directory";

const TYPE_ICON = { support: LifeBuoy, issue: TriangleAlert, feedback: ThumbsUp, change: PencilRuler } as const;

export interface WorkspaceList { items: AgencyListItem[]; total: number; page: number; pageSize: number; counts: AgencyViewCounts }

/**
 * The Requests Management Center. On a wide screen: the queue on the left, the conversation in the middle, the request's details and
 * controls on the right. On a tablet the details move under the conversation; on a phone the queue and the request are separate screens
 * with a back link. The open request refreshes itself while this tab is visible, and the queue follows.
 */
export function AgencyWorkspace({ list, query, options, initialDetail, timeZone, meId, layout }: {
  list: WorkspaceList | null;
  query: QueueQuery;
  options: FilterOptions | null;
  initialDetail: AgencyRequestDetail | null;
  timeZone: string;
  meId: string;
  layout: "split" | "detail";
}) {
  const router = useRouter();
  const [detail, setDetail] = React.useState(initialDetail);
  const [focusReply, setFocusReply] = React.useState(0);
  // A new server render (a different request, or a refresh) replaces what is shown; between renders the polling below keeps it current.
  const [seenInitial, setSeenInitial] = React.useState(initialDetail);
  if (initialDetail !== seenInitial) {
    setSeenInitial(initialDetail);
    setDetail(initialDetail);
  }
  const id = detail?.ticket.id ?? null;
  const known = React.useRef(detail?.messages.length ?? 0);

  const refresh = React.useCallback(async () => {
    if (!id) return null;
    try {
      const res = await fetch(`/api/support/${id}/thread?as=agency`, { cache: "no-store" });
      if (!res.ok) return null;
      const next = (await res.json()) as AgencyRequestDetail;
      setDetail(next);
      return next;
    } catch {
      return null;
    }
  }, [id]);

  const changed = React.useCallback(async () => {
    await refresh();
    router.refresh();
  }, [refresh, router]);

  // The team opening a request counts as reading it; so does a new client message arriving while it is open.
  React.useEffect(() => {
    if (!id) return;
    known.current = detail?.messages.length ?? 0;
    void markReadAction(id);
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => {
    const n = detail?.messages.length ?? 0;
    if (id && n > known.current && document.visibilityState === "visible") void markReadAction(id);
    known.current = n;
  }, [detail?.messages.length, id]);

  // Stay current while visible: the open request every 15 seconds, the queue every 45.
  React.useEffect(() => {
    let tick = 0;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      tick += 1;
      void refresh();
      if (tick % 3 === 0) router.refresh();
    }, 15_000);
    const onVisible = () => { if (document.visibilityState === "visible") { void refresh(); router.refresh(); } };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [refresh, router]);

  // "r" brings the cursor to the reply box.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.key !== "r" || !id) return;
      e.preventDefault();
      setFocusReply((n) => n + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [id]);

  const t = detail?.ticket;
  const Icon = t ? TYPE_ICON[t.requestType] : MessageSquare;
  const header = detail && t && (
    <Card className="p-4 sm:p-5">
      {layout === "split" && <Link href={queueHref(query, { ticket: "" })} className="mb-3 inline-flex min-h-10 items-center gap-1.5 text-[14px] font-medium text-ink-2 hover:text-ink xl:hidden"><ArrowLeft className="size-3.5" aria-hidden /> Back to requests</Link>}
      <div className="flex flex-wrap items-center gap-1.5">
        <Icon className="size-4 text-muted" aria-hidden />
        <InfoChip className="font-mono">{t.ref}</InfoChip>
        <StatusPill status={t.priority}>{sentenceCase(t.priority)} priority</StatusPill>
        <StatusPill status={t.status}>{t.requestType === "feedback" && t.feedbackStage ? FEEDBACK_STAGE_LABELS[t.feedbackStage as FeedbackStage].label : statusLabelForAgency(t.status)}</StatusPill>
        {t.escalated && <StatusPill tone="danger" icon={<Flame className="size-3" aria-hidden />}>Escalated</StatusPill>}
      </div>
      <h2 className="mt-3 break-words text-xl font-semibold tracking-tight text-ink">{t.subject}</h2>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <InfoChip icon={<Building2 aria-hidden />}>{t.orgName}</InfoChip>
          <InfoChip>{REQUEST_TYPE_LABELS[t.requestType].label} · {categoryLabel(t.category)}</InfoChip>
          <span className="text-[12px] text-muted">Opened {formatDateTime(t.createdAt, timeZone)}</span>
        </div>
        {layout === "split" && <ButtonLink href={`/admin/support/${t.id}`} variant="secondary" size="sm">Full page<ArrowUpRight className="size-3.5" aria-hidden /></ButtonLink>}
      </div>
    </Card>
  );

  const thread = detail && (
    <div className="min-w-0 space-y-4">
      {header}
      <ThreadPane key={detail.ticket.id} detail={detail} timeZone={timeZone} onChanged={changed} focusReply={focusReply} />
    </div>
  );
  const details = detail && <DetailsPane key={detail.ticket.id} detail={detail} timeZone={timeZone} meId={meId} onChanged={changed} />;

  // A request with a reply box gives the floating AQi launcher a reason to sit above it on a phone. The stylesheet reads this attribute; no page layout is duplicated.
  const hasDetail = Boolean(detail);
  React.useEffect(() => {
    if (!hasDetail) return;
    document.body.dataset.aqiComposer = "true";
    return () => {
      delete document.body.dataset.aqiComposer;
    };
  }, [hasDetail]);

  if (layout === "detail") {
    return thread && details ? (
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">{thread}<aside aria-label="Request details">{details}</aside></div>
    ) : null;
  }

  const hasSelection = hasDetail;
  return (
    <div>
      <div className={cn("grid items-start gap-4", "md:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[360px_minmax(0,1fr)_330px]")}>
        {list && options && (
          <div className={cn("min-w-0", hasSelection && "hidden md:block", "xl:sticky xl:top-4 xl:max-h-[calc(100dvh-2rem)] xl:overflow-hidden")}>
            <QueuePane items={list.items} total={list.total} page={list.page} pageSize={list.pageSize} counts={list.counts} query={query} options={options} selectedId={id}
              className="xl:max-h-[calc(100dvh-2rem)]" />
          </div>
        )}
        {hasSelection ? (
          <>
            {thread}
            <aside aria-label="Request details" className="min-w-0 md:col-span-2 xl:sticky xl:top-4 xl:col-span-1 xl:max-h-[calc(100dvh-2rem)] xl:overflow-y-auto xl:pr-1">{details}</aside>
          </>
        ) : (
          <div className="hidden min-w-0 md:block xl:col-span-2">
            <Card>
              <EmptyState icon={<MessageSquare className="size-5" />} title={list && list.items.length ? "Choose a request" : "Nothing here yet"}
                description={list && list.items.length ? "Select a request to read the conversation and work on it. Use j and k to move through the list." : "When clients send requests, they appear in the queue with their workspace, priority and full conversation."} />
            </Card>
          </div>
        )}
      </div>
      <details className="mt-4 text-[12px] text-muted">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-lg px-1 py-1 hover:text-ink focus-visible:outline-2 focus-visible:outline-primary"><Keyboard className="size-3.5" aria-hidden /> Keyboard shortcuts</summary>
        <ul className="mt-2 grid gap-1 sm:grid-cols-2 lg:grid-cols-4">
          <li><kbd className="rounded border border-line bg-surface-2 px-1.5 font-mono text-[12px]">/</kbd> search the queue</li>
          <li><kbd className="rounded border border-line bg-surface-2 px-1.5 font-mono text-[12px]">j</kbd> / <kbd className="rounded border border-line bg-surface-2 px-1.5 font-mono text-[12px]">k</kbd> next / previous request</li>
          <li><kbd className="rounded border border-line bg-surface-2 px-1.5 font-mono text-[12px]">r</kbd> write a reply</li>
          <li><kbd className="rounded border border-line bg-surface-2 px-1.5 font-mono text-[12px]">Ctrl</kbd>/<kbd className="rounded border border-line bg-surface-2 px-1.5 font-mono text-[12px]">⌘</kbd> + <kbd className="rounded border border-line bg-surface-2 px-1.5 font-mono text-[12px]">Enter</kbd> send</li>
        </ul>
      </details>
    </div>
  );
}
