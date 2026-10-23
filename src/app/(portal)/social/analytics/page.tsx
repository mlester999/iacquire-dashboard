import Link from "next/link";
import { BarChart3 } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { EmptyState } from "@/components/ui/primitives";
import { formatWhen } from "@/lib/social/calendar";
import { socialOverview } from "@/server/social/analytics";
import { PlatformMark } from "@/components/social/status";
import { cn } from "@/lib/utils";

export const metadata = { title: "Social analytics" };

const RANGES = [7, 30, 90] as const;
const METRIC_LABELS: Record<string, string> = { likes: "Likes", comments: "Comments", shares: "Shares" };

/** The report window ends a minute from now, so a post published while the page loads is counted. */
const windowEnd = () => new Date(Date.now() + 60_000);

export default async function SocialAnalyticsPage({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  const ctx = await requireOrgContext("social.view");
  const sp = await searchParams;
  const days = RANGES.find((r) => String(r) === sp.range) ?? 30;
  const tz = ctx.org.timezone || "UTC";
  const endsAt = windowEnd();
  const o = await socialOverview(ctx, { startsAt: new Date(endsAt.getTime() - days * 86_400_000), endsAt });
  const keys = Object.keys(o.engagement.totals).sort();
  const pill = (active: boolean) => cn("inline-flex min-h-11 items-center rounded-xl px-3 text-[13px] font-medium focus-visible:outline-2 focus-visible:outline-primary sm:min-h-9", active ? "bg-primary-soft text-primary-ink" : "text-ink-2 hover:bg-surface-2");
  const stat = (label: string, n: number) => (
    <div className="rounded-2xl border border-line bg-surface p-3"><p className="text-[12px] text-muted">{label}</p><p className="text-[22px] font-semibold tabular-nums text-ink">{n}</p></div>
  );
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-[22px] font-semibold tracking-tight text-ink"><BarChart3 className="size-5 text-muted" aria-hidden />Analytics</h1>
          <p className="mt-1 max-w-2xl text-[13.5px] text-muted">What publishing achieved, from records that exist. Numbers appear only where the platform returned them.</p>
        </div>
        <nav aria-label="Period" className="flex gap-1">{RANGES.map((r) => <Link key={r} href={`/social/analytics?range=${r}`} aria-current={days === r ? "page" : undefined} className={pill(days === r)}>{r} days</Link>)}</nav>
      </header>

      <section aria-label="Totals" className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {stat("Published", o.counts.published)}
        {stat("Scheduled", o.counts.scheduled)}
        {stat("Waiting for approval", o.counts.awaitingApproval)}
        {stat("Failed or unconfirmed", o.counts.failed)}
        {stat("Drafts", o.counts.drafts)}
      </section>

      <section aria-label="Engagement" className="space-y-2 rounded-2xl border border-line bg-surface p-4">
        <h2 className="text-[15px] font-semibold text-ink">Engagement the platforms returned</h2>
        {keys.length === 0 ? (
          <p className="text-[13.5px] text-ink-2">{o.engagement.publishedPosts ? "The platforms have not returned any numbers for these posts yet. That is not the same as zero: numbers are read a few times a day once a post is published." : "No posts were published in this period."}</p>
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {keys.map((k) => <div key={k} className="rounded-xl bg-surface-2 p-3"><dt className="text-[12px] text-muted">{METRIC_LABELS[k] ?? k}</dt><dd className="text-[20px] font-semibold tabular-nums text-ink">{o.engagement.totals[k]}</dd></div>)}
            </dl>
            <p className="text-[12.5px] text-muted">From {o.engagement.postsWithData} of {o.engagement.publishedPosts} published posts{o.engagement.lastSyncAt ? `; last read ${formatWhen(o.engagement.lastSyncAt, tz)}` : ""}.</p>
          </>
        )}
      </section>

      <section aria-label="Leads from posts" className="space-y-2 rounded-2xl border border-line bg-surface p-4">
        <h2 className="text-[15px] font-semibold text-ink">Leads that arrived through a post&apos;s link</h2>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {[["Leads", o.leads.total], ["Qualified", o.leads.qualified], ["With an appointment", o.leads.appointments], ["With a deal", o.leads.opportunities], ["With a won deal", o.leads.wonCount]].map(([l, n]) => (
            <div key={l as string} className="rounded-xl bg-surface-2 p-3"><dt className="text-[12px] text-muted">{l}</dt><dd className="text-[20px] font-semibold tabular-nums text-ink">{n}</dd></div>
          ))}
        </dl>
        <p className="text-[12.5px] text-muted">Counted only where a lead&apos;s own recorded visit carried the post&apos;s tracking code. <Link href="/crm/reports/sources" className="font-medium text-primary-ink underline">See all lead sources</Link></p>
      </section>

      <section aria-label="Posts" className="space-y-2">
        <h2 className="text-[15px] font-semibold text-ink">Published posts</h2>
        {o.posts.length === 0 ? (
          <EmptyState compact title="No posts were published in this period" description="Published posts, with what the platform returned and the leads their links brought, appear here." />
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-line" role="region" aria-label="Published posts" tabIndex={0}>
            <table className="w-full min-w-[720px] text-left text-[13px]">
              <caption className="sr-only">Published posts with the engagement the platform returned and the leads tied to each</caption>
              <thead className="bg-surface-2 text-[12px] text-muted"><tr>{["Post", "Published", ...keys.map((k) => METRIC_LABELS[k] ?? k), "Leads", "Qualified", "Appointments"].map((h) => <th key={h} scope="col" className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
              <tbody>
                {o.posts.map((p) => (
                  <tr key={p.postId} className="border-t border-line align-top">
                    <th scope="row" className="max-w-[320px] px-3 py-2 font-normal">
                      <Link href={`/social/posts/${p.postId}`} className="flex items-start gap-2 hover:underline"><PlatformMark platform={p.platform} className="mt-0.5" /><span className="line-clamp-2 text-ink">{p.caption || "(picture or video)"}</span></Link>
                    </th>
                    <td className="px-3 py-2 text-ink-2">{formatWhen(p.publishedAt, tz)}</td>
                    {keys.map((k) => <td key={k} className="px-3 py-2 tabular-nums">{p.metrics && k in p.metrics ? p.metrics[k] : <span className="text-muted">No numbers</span>}</td>)}
                    <td className="px-3 py-2 tabular-nums">{p.leads}</td>
                    <td className="px-3 py-2 tabular-nums">{p.qualified}</td>
                    <td className="px-3 py-2 tabular-nums">{p.appointments}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <ul className="space-y-1 text-[12.5px] text-muted">{o.notes.map((n) => <li key={n}>{n}</li>)}</ul>
    </div>
  );
}
