import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { AppError } from "@/server/errors";
import { zonedDate } from "@/lib/calendars/slots";
import { isUuid } from "@/lib/social/address";
import { composerDay, formatDay, scheduleSuggestion } from "@/lib/social/calendar";
import { PLATFORM_LIMITS } from "@/lib/social/rules";
import { approvalRequired, approveBlockedReason, isEditable } from "@/lib/social/state";
import { listAccounts } from "@/server/social/accounts";
import { getMediaPolicy, listMedia } from "@/server/social/media";
import { getPostDetail } from "@/server/social/posts";
import { livePublishingEnabled } from "@/server/social/providers";
import { getSocialSettings, listCampaigns } from "@/server/social/settings";
import { PostComposer } from "@/components/social/composer";
import { PostActions } from "@/components/social/post-actions";
import { PostHistory } from "@/components/social/post-history";
import { PlatformMark } from "@/components/social/status";

export const metadata = { title: "Social post" };

const dayAfterNow = (tz: string) => zonedDate(Date.now() + 86_400_000, tz);

export default async function SocialPostPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ date?: string | string[] }> }) {
  const ctx = await requireOrgContext("social.view");
  const { id } = await params;
  const sp = await searchParams;
  // The column is a uuid: an address that only looks like one (36 hex digits and dashes) would make the database raise instead of the page saying "not found".
  if (!isUuid(id)) notFound();
  let detail;
  try {
    detail = await getPostDetail(ctx, id);
  } catch (e) {
    if (e instanceof AppError && e.code === "not_found") notFound();
    throw e;
  }
  const { post, events, job } = detail;
  const tz = ctx.org.timezone || "UTC";
  const [accounts, campaigns, media, policy, settings] = await Promise.all([listAccounts(ctx, { includeDisconnected: true }), listCampaigns(ctx), listMedia(ctx), getMediaPolicy(ctx), getSocialSettings(ctx)]);
  const account = accounts.find((a) => a.id === post.accountId);
  const isAuthor = post.authorId === ctx.user.id;
  const can = { create: ctx.can("social.create"), approve: ctx.can("social.approve"), publish: ctx.can("social.publish"), edit: ctx.can("social.create") && (isAuthor || ctx.can("social.approve") || ctx.can("social.publish")) };
  const needsApproval = approvalRequired({ origin: post.origin, authorCanPublish: isAuthor && can.publish, approvalForPublishers: settings.approvalForPublishers });
  const tomorrow = dayAfterNow(tz);
  // The day chosen on the calendar starts the schedule box (checked again here: it is only an address). It never schedules anything.
  const chosenDay = post.scheduledAt ? null : composerDay(Array.isArray(sp.date) ? sp.date[0] : sp.date, new Date(), tz);
  const suggestion = chosenDay ? scheduleSuggestion(chosenDay, new Date(), tz) : null;
  const test = account?.adapter === "simulated";
  const liveBlocked = account?.adapter === "meta" && !livePublishingEnabled();
  const approveBlock = approveBlockedReason({ canApprove: can.approve, isAuthor, approvalForPublishers: settings.approvalForPublishers });
  const unresolved = post.status === "needs_reconciliation" || (post.status === "failed" && post.failureCode === "unknown_outcome");
  // A post waiting for its next try can still be changed until the try starts; the server refuses one that may already have been sent.
  const waiting = post.status === "publishing" && job?.status === "queued";
  const readOnly = !can.edit || (!isEditable(post.status) && !waiting) || unresolved;

  return (
    <div className="space-y-5">
      <div>
        <Link href="/social" className="inline-flex min-h-11 items-center gap-1.5 text-[14px] font-medium text-muted hover:text-ink sm:min-h-8"><ArrowLeft className="size-4" aria-hidden />Calendar</Link>
        <h1 className="mt-1 flex items-center gap-2 text-[22px] font-semibold tracking-tight text-ink"><PlatformMark platform={post.platform} className="size-7 text-[12px]" />{post.accountName}</h1>
        <p className="mt-1 text-[14px] text-muted">Written by {post.authorName ?? (post.origin === "ai" ? "AI" : "a teammate")}{post.campaignName ? ` · Campaign: ${post.campaignName}` : ""}{post.trackingCode && post.linkUrl && settings.trackingLinks && PLATFORM_LIMITS[post.platform].clickableLinks ? ` · Tracking code ${post.trackingCode}` : ""}</p>
      </div>
      <PostActions
        post={post} job={job} tz={tz} can={can} needsApproval={needsApproval} defaultWhen={suggestion ?? `${tomorrow}T09:00`} defaultWhenDay={suggestion && chosenDay ? formatDay(chosenDay) : null}
        accountReady={account?.status === "connected"} liveBlocked={liveBlocked} testAccount={test} approveBlock={approveBlock}
      />
      <PostComposer
        mode="edit" accounts={accounts} campaigns={campaigns} media={media} initial={post} readOnly={readOnly} trackingLinks={settings.trackingLinks}
        mediaNote={policy.managedUploadAllowed || media.length ? null : policy.summary}
      />
      <PostHistory events={events} tz={tz} />
    </div>
  );
}
