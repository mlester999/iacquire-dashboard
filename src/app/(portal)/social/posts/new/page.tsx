import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { composerDay } from "@/lib/social/calendar";
import { listAccounts } from "@/server/social/accounts";
import { listMedia, getMediaPolicy } from "@/server/social/media";
import { getSocialSettings, listCampaigns } from "@/server/social/settings";
import { PostComposer } from "@/components/social/composer";
import { AiHelper } from "@/components/social/ai-helper";

export const metadata = { title: "New social post" };

export default async function NewSocialPostPage({ searchParams }: { searchParams: Promise<{ account?: string; date?: string }> }) {
  const ctx = await requireOrgContext("social.create");
  const sp = await searchParams;
  const [accounts, campaigns, media, policy, settings] = await Promise.all([listAccounts(ctx), listCampaigns(ctx), listMedia(ctx), getMediaPolicy(ctx), getSocialSettings(ctx)]);
  const usable = accounts.filter((a) => a.status !== "revoked");
  // The day chosen on the calendar: a real day that is today or later in the workspace's zone, or nothing. It starts the schedule box on the next screen and
  // schedules nothing by itself.
  const day = composerDay(sp.date, new Date(), ctx.org.timezone || "UTC");
  // A preselected account that is not one of this workspace's usable accounts is ignored rather than leaving the composer with no account.
  const defaultAccountId = usable.find((a) => a.id === sp.account)?.id;
  return (
    <div className="space-y-5">
      <div>
        <Link href={day ? `/social?date=${day}` : "/social"} className="inline-flex min-h-11 items-center gap-1.5 text-[13px] font-medium text-muted hover:text-ink sm:min-h-8"><ArrowLeft className="size-4" aria-hidden />Calendar</Link>
        <h1 className="mt-1 text-[22px] font-semibold tracking-tight text-ink">New post</h1>
        <p className="mt-1 text-[13.5px] text-muted">Write it, check how it will look, then send it for approval. Nothing is published until it has been approved and scheduled.</p>
      </div>
      {usable.length === 0 ? (
        <p className="rounded-2xl border border-line bg-surface-2 px-4 py-3 text-[13.5px] text-ink-2">Connect an account first. <Link href="/social/accounts" className="font-medium text-primary-ink underline">Go to accounts</Link></p>
      ) : (
        <>
          <AiHelper accounts={usable} campaigns={campaigns} enabled={settings.aiDraftsEnabled} defaultAccountId={defaultAccountId} scheduleDay={day} />
          <PostComposer mode="create" accounts={usable} campaigns={campaigns} media={media} defaultAccountId={defaultAccountId} trackingLinks={settings.trackingLinks} mediaNote={policy.managedUploadAllowed || media.length ? null : policy.summary} scheduleDay={day} />
        </>
      )}
    </div>
  );
}
