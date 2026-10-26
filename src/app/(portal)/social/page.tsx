import Link from "next/link";
import { AlertTriangle, Plus, Share2 } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { PageHero } from "@/components/ui/workspace";
import { EmptyState } from "@/components/ui/primitives";
import { anchorDay, calendarScreen, listRange, monthGrid, parseView, weekGrid } from "@/lib/social/calendar";
import { parseStatusFilter } from "@/lib/social/state";
import { listAccounts } from "@/server/social/accounts";
import { listPosts } from "@/server/social/posts";
import { livePublishingEnabled } from "@/server/social/providers";
import { CalendarView } from "@/components/social/calendar-view";

export const metadata = { title: "Social media" };

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function SocialCalendarPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await requireOrgContext("social.view");
  const sp = await searchParams;
  const tz = ctx.org.timezone || "UTC";
  const now = new Date();
  const view = parseView(one(sp.view));
  const anchor = anchorDay(one(sp.date), now, tz);
  const today = anchorDay(undefined, now, tz);
  // One status, or several separated by commas (the Performance Analyst links to "failed,needs_reconciliation"); unknown words are ignored.
  const statuses = parseStatusFilter(one(sp.status));
  // Posts outlive the account they were written for, so the calendar and its account filter know every account, disconnected ones included. The banners and the
  // New post button only look at the accounts that can still be used.
  const allAccounts = await listAccounts(ctx, { includeDisconnected: true });
  const accounts = allAccounts.filter((a) => a.status !== "disconnected");
  const accountId = allAccounts.some((a) => a.id === one(sp.account)) ? (one(sp.account) as string) : null;
  const range = view === "week" ? weekGrid(anchor, tz) : view === "list" ? listRange(anchor, tz) : monthGrid(anchor, tz);
  const posts = await listPosts(ctx, { from: range.from, to: range.to, accountId: accountId ?? undefined, statuses: statuses.length ? statuses : undefined });
  // The visible period can be empty while the workspace still has a history, so "any post at all" is asked separately, and only when it decides the screen.
  const onlyDisconnected = allAccounts.length > 0 && accounts.length === 0;
  const hasPosts = posts.length > 0 || (onlyDisconnected && (await listPosts(ctx, { limit: 1 })).length > 0);
  const screen = calendarScreen(allAccounts.map((a) => a.status), hasPosts);
  const real = accounts.filter((a) => a.adapter === "meta");
  const needAttention = accounts.filter((a) => a.status !== "connected");
  const canCreate = ctx.can("social.create") && accounts.some((a) => a.status !== "revoked");

  return (
    <div className="space-y-5">
      <PageHero
        eyebrow="Marketing" title="Social media" icon={<Share2 className="size-4" />} tone="neutral"
        description="Plan, approve and publish posts to your Facebook Page and Instagram account. Every post is reviewed by a person before it goes out, and what happened to each one is kept."
        action={canCreate ? <Link href="/social/posts/new" className="inline-flex min-h-11 items-center gap-1.5 rounded-xl brand-gradient px-4 text-[14px] font-medium text-white shadow-glow sm:min-h-10"><Plus className="size-4" aria-hidden />New post</Link> : undefined}
      />
      {needAttention.length > 0 && (
        <div role="alert" className="flex items-start gap-2.5 rounded-2xl border border-warning-ink/30 bg-warning-soft px-4 py-3 text-[14px] text-warning-ink">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>
            {needAttention.map((a) => a.name).join(", ")} {needAttention.length === 1 ? "needs" : "need"} to be reconnected, so nothing can be published to {needAttention.length === 1 ? "it" : "them"}.{" "}
            <Link href="/social/accounts" className="font-medium underline">Open accounts</Link>
          </p>
        </div>
      )}
      {screen === "calendar_without_account" && (
        <div role="status" className="flex items-start gap-2.5 rounded-2xl border border-line bg-surface-2 px-4 py-3 text-[14px] text-ink-2">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
          <p>
            No account is connected, so nothing new can be written or published. Your earlier posts are still here.{" "}
            <Link href="/social/accounts" className="font-medium text-primary-ink underline">Connect an account</Link>
          </p>
        </div>
      )}
      {real.length > 0 && !livePublishingEnabled() && (
        <div role="status" className="flex items-start gap-2.5 rounded-2xl border border-line bg-surface-2 px-4 py-3 text-[14px] text-ink-2">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
          <p>Publishing to real Facebook and Instagram accounts is switched off in this environment, so posts for them will wait here and nothing will be sent until iAcquire switches it on.</p>
        </div>
      )}
      {screen === "connect" ? (
        <EmptyState
          title="Connect an account to start"
          description="Connect your Facebook Page, and the Instagram account linked to it, to plan and publish posts. Until then you can look around, but nothing can be scheduled."
          action={<Link href="/social/accounts" className="inline-flex min-h-11 items-center rounded-xl brand-gradient px-4 text-[14px] font-medium text-white sm:min-h-10">Go to accounts</Link>}
        />
      ) : (
        <CalendarView view={view} anchor={anchor} tz={tz} today={today} posts={posts} accounts={allAccounts} accountId={accountId} statuses={statuses} canCreate={canCreate} />
      )}
    </div>
  );
}
