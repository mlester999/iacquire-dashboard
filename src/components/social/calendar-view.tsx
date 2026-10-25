import Link from "next/link";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { CALENDAR_VIEWS, formatDay, formatTime, formatWhen, groupByDay, listRange, monthGrid, neighbours, weekGrid, type CalendarView } from "@/lib/social/calendar";
import { POST_STATUSES, STATUS_LABELS, type PostStatus } from "@/lib/social/state";
import type { PostView } from "@/server/social/posts";
import type { AccountView } from "@/server/social/accounts";
import { PlatformMark, StatusBadge, STATUS_EDGE, platformName } from "@/components/social/status";

// The content calendar: a month, a week or an agenda, every post on the day it was or will be published IN THE CLIENT'S TIME ZONE. Every post is a link to its
// own page. Nothing on this screen changes anything, so it renders on the server and works without scripts.

export interface CalendarProps {
  view: CalendarView;
  anchor: string;
  tz: string;
  today: string;
  posts: PostView[];
  /** Every account the workspace has had, disconnected ones included: their posts are still on the calendar and can still be filtered to. */
  accounts: AccountView[];
  accountId: string | null;
  /** The statuses being shown. Empty is any status; several come from a link such as the Performance Analyst's "failed or could not be confirmed". */
  statuses: PostStatus[];
  canCreate: boolean;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const snippet = (p: PostView) => (p.caption.trim() ? p.caption.trim().replace(/\s+/g, " ") : p.media.length ? `(${p.kind})` : "(empty)");

function Chip({ p, tz, compact }: { p: PostView; tz: string; compact?: boolean }) {
  const at = p.publishedAt ?? p.scheduledAt;
  return (
    <Link
      href={`/social/posts/${p.id}`}
      className={cn("block min-h-9 rounded-lg border border-line border-l-4 bg-surface px-2 py-1 text-left text-[12px] leading-snug hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-primary", STATUS_EDGE[p.status])}
    >
      <span className="flex items-center gap-1.5">
        <PlatformMark platform={p.platform} className="size-5 text-[12px]" />
        <span className="font-medium text-ink">{at ? formatTime(at, tz) : "No time"}</span>
        <span className="sr-only">{platformName(p.platform)}, {STATUS_LABELS[p.status]}</span>
        {p.origin === "ai" && <span className="rounded bg-violet-soft px-1 text-[12px] font-semibold text-violet-ink">AI</span>}
      </span>
      <span className={cn("mt-0.5 block text-ink-2", compact ? "truncate" : "line-clamp-2")}>{snippet(p)}</span>
      {!compact && <span className="mt-1 block text-[12px] text-muted">{STATUS_LABELS[p.status]}</span>}
    </Link>
  );
}

export function CalendarView(props: CalendarProps) {
  const { view, anchor, tz, today, posts, accounts, accountId, statuses, canCreate } = props;
  const grid = view === "week" ? weekGrid(anchor, tz) : view === "list" ? listRange(anchor, tz) : monthGrid(anchor, tz);
  const byDay = groupByDay(posts, tz);
  const nb = neighbours(view, anchor);
  const statusValue = statuses.join(",");
  const href = (over: { view?: CalendarView; date?: string }) => {
    const q = new URLSearchParams();
    q.set("view", over.view ?? view);
    q.set("date", over.date ?? anchor);
    if (accountId) q.set("account", accountId);
    if (statusValue) q.set("status", statusValue);
    return `/social?${q.toString()}`;
  };
  // A day in the past cannot be scheduled for, so it is not carried into the composer.
  const newPostHref = (d: string) => (d >= today ? `/social/posts/new?date=${d}` : "/social/posts/new");
  const pill = (active: boolean) => cn("inline-flex min-h-11 items-center rounded-xl px-3 text-[14px] font-medium focus-visible:outline-2 focus-visible:outline-primary sm:min-h-9", active ? "bg-primary-soft text-primary-ink" : "text-ink-2 hover:bg-surface-2");
  const arrow = "inline-flex size-11 items-center justify-center rounded-xl border border-line text-ink-2 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-primary sm:size-9";
  const days = grid.weeks.flat().filter((d) => view !== "list" || grid.inMonth(d));
  const withPosts = days.filter((d) => byDay.get(d)?.length);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <Link href={href({ date: nb.prev })} className={arrow} aria-label={view === "week" ? "Previous week" : "Previous month"}><ChevronLeft className="size-4" aria-hidden /></Link>
          <h2 className="min-w-40 text-center text-[16px] font-semibold text-ink" aria-live="polite">{grid.label}</h2>
          <Link href={href({ date: nb.next })} className={arrow} aria-label={view === "week" ? "Next week" : "Next month"}><ChevronRight className="size-4" aria-hidden /></Link>
          <Link href={href({ date: today })} className={pill(false)}>Today</Link>
        </div>
        <nav aria-label="Calendar view" className="flex gap-1">
          {CALENDAR_VIEWS.map((v) => <Link key={v} href={href({ view: v })} aria-current={v === view ? "page" : undefined} className={pill(v === view)}>{v[0].toUpperCase() + v.slice(1)}</Link>)}
        </nav>
      </div>

      <form method="get" action="/social" className="flex flex-wrap items-end gap-3" aria-label="Filter the calendar">
        <input type="hidden" name="view" value={view} />
        <input type="hidden" name="date" value={anchor} />
        {/* Native selects are as wide as their longest option, so a long Page name must be able to shrink to the phone's width instead of pushing the form out. */}
        <label className="w-full min-w-0 max-w-full text-[13px] text-muted sm:w-auto">
          <span className="mb-1 block">Account</span>
          <select name="account" defaultValue={accountId ?? ""} className="h-11 w-full min-w-0 max-w-full rounded-xl border border-line-strong bg-surface px-3 text-[14px] text-ink sm:h-9 sm:w-auto sm:max-w-sm sm:text-[14px]">
            <option value="">All accounts</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({platformName(a.platform)}){a.status === "disconnected" ? " (disconnected)" : ""}</option>)}
          </select>
        </label>
        <label className="w-full min-w-0 max-w-full text-[13px] text-muted sm:w-auto">
          <span className="mb-1 block">Status</span>
          <select name="status" defaultValue={statusValue} className="h-11 w-full min-w-0 max-w-full rounded-xl border border-line-strong bg-surface px-3 text-[14px] text-ink sm:h-9 sm:w-auto sm:max-w-sm sm:text-[14px]">
            <option value="">Any status</option>
            {/* A link can ask for several statuses at once; applying the form again keeps them unless another is chosen. */}
            {statuses.length > 1 && <option value={statusValue}>{statuses.map((s) => STATUS_LABELS[s]).join(", ")}</option>}
            {POST_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
          </select>
        </label>
        <Button type="submit" variant="secondary" size="sm">Apply</Button>
        {(accountId || statuses.length > 0) && <Link href={`/social?view=${view}&date=${anchor}`} className="inline-flex min-h-11 items-center text-[14px] font-medium text-primary-ink underline sm:min-h-9">Clear filters</Link>}
        <p className="ml-auto text-[12px] text-muted">Times are shown in {tz.replace(/_/g, " ")}.</p>
      </form>

      {posts.length === 0 && (
        <EmptyState
          compact title={statuses.length > 0 || accountId ? "No posts match these filters" : "Nothing planned in this period"}
          description="Drafts, scheduled posts, posts waiting for approval, failed posts and published posts all appear here."
          action={canCreate ? <Link href={newPostHref(anchor)} className="inline-flex min-h-11 items-center gap-1.5 rounded-xl brand-gradient px-4 text-[14px] font-medium text-white sm:min-h-9"><Plus className="size-4" aria-hidden />New post</Link> : undefined}
        />
      )}

      {view === "month" && (
        <>
          <div className="hidden overflow-x-auto sm:block" role="region" aria-label={`${grid.label} calendar`} tabIndex={0}>
            <table className="w-full min-w-[760px] table-fixed border-separate border-spacing-0 text-left">
              <caption className="sr-only">Posts by day for {grid.label}</caption>
              <thead>
                <tr>{WEEKDAYS.map((d) => <th key={d} scope="col" className="border-b border-line px-2 py-1.5 text-[12px] font-medium text-muted">{d}</th>)}</tr>
              </thead>
              <tbody>
                {grid.weeks.map((week) => (
                  <tr key={week[0]}>
                    {week.map((d) => {
                      const list = byDay.get(d) ?? [];
                      return (
                        <td key={d} className={cn("h-32 border-b border-r border-line p-1.5 align-top first:border-l", !grid.inMonth(d) && "bg-surface-2/60")}>
                          <div className="mb-1 flex items-center justify-between">
                            <Link href={href({ view: "week", date: d })} className={cn("inline-flex size-6 items-center justify-center rounded-full text-[12px] hover:bg-surface-2", d === today ? "bg-primary text-primary-on" : grid.inMonth(d) ? "text-ink" : "text-faint")} aria-label={`Week of ${formatDay(d)}`}>{Number(d.slice(8))}</Link>
                            {canCreate && grid.inMonth(d) && d >= today && <Link href={`/social/posts/new?date=${d}`} className="inline-flex size-6 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-ink" aria-label={`New post on ${formatDay(d)}`}><Plus className="size-3.5" aria-hidden /></Link>}
                          </div>
                          <div className="space-y-1">
                            {list.slice(0, 3).map((p) => <Chip key={p.id} p={p} tz={tz} compact />)}
                            {list.length > 3 && <Link href={href({ view: "week", date: d })} className="block px-1 text-[12px] font-medium text-primary-ink underline">{list.length - 3} more</Link>}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="sm:hidden"><Agenda days={withPosts} byDay={byDay} tz={tz} empty="No posts this month." /></div>
        </>
      )}

      {view === "week" && (
        <div className="grid gap-3 sm:grid-cols-7">
          {grid.weeks[0].map((d) => {
            const list = byDay.get(d) ?? [];
            return (
              <section key={d} aria-label={formatDay(d)} className={cn("rounded-2xl border border-line p-2.5", d === today && "border-primary")}>
                <h3 className="mb-2 flex items-center justify-between text-[13px] font-semibold text-ink">
                  <span>{WEEKDAYS[new Date(`${d}T12:00:00Z`).getUTCDay()]} {Number(d.slice(8))}</span>
                  {canCreate && d >= today && <Link href={`/social/posts/new?date=${d}`} className="inline-flex size-7 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-ink" aria-label={`New post on ${formatDay(d)}`}><Plus className="size-3.5" aria-hidden /></Link>}
                </h3>
                <div className="space-y-1.5">{list.length ? list.map((p) => <Chip key={p.id} p={p} tz={tz} />) : <p className="text-[12px] text-faint">Nothing</p>}</div>
              </section>
            );
          })}
        </div>
      )}

      {view === "list" && <Agenda days={withPosts} byDay={byDay} tz={tz} empty="No posts this month." detailed />}
    </div>
  );
}

function Agenda({ days, byDay, tz, empty, detailed }: { days: string[]; byDay: Map<string, PostView[]>; tz: string; empty: string; detailed?: boolean }) {
  if (!days.length) return <p className="text-[14px] text-muted">{empty}</p>;
  return (
    <div className="space-y-5">
      {days.map((d) => (
        <section key={d} aria-label={formatDay(d)}>
          <h3 className="mb-2 text-[14px] font-semibold text-ink">{formatDay(d)}</h3>
          <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
            {(byDay.get(d) ?? []).map((p) => (
              <li key={p.id}>
                <Link href={`/social/posts/${p.id}`} className="flex min-h-14 items-start gap-3 px-3 py-2.5 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-primary">
                  <PlatformMark platform={p.platform} className="mt-0.5" />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 text-[13px] text-muted">
                      <span className="font-medium text-ink">{formatWhen(p.publishedAt ?? p.scheduledAt ?? p.createdAt, tz)}</span>
                      <span>{p.accountName}</span>
                      {p.origin === "ai" && <span className="rounded bg-violet-soft px-1 text-[12px] font-semibold text-violet-ink">AI draft</span>}
                    </span>
                    <span className={cn("mt-0.5 block text-[14px] text-ink-2", detailed ? "line-clamp-2" : "truncate")}>{snippet(p)}</span>
                    {p.failureMessage && p.status === "failed" && <span className="mt-0.5 block text-[12px] text-danger-ink">{p.failureMessage}</span>}
                  </span>
                  <StatusBadge status={p.status} providerPostId={p.providerPostId} className="shrink-0" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
