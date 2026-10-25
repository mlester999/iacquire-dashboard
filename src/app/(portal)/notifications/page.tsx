import { requireOrgContext } from "@/server/tenancy/context";
import { hiddenKinds, listNotifications } from "@/server/notifications";
import { NotificationList } from "@/components/notifications/notification-list";
import { PageHero } from "@/components/ui/workspace";
import { Bell, BellDot } from "lucide-react";
import { InfoChip, StatusPill } from "@/components/ui/status";
import { IconTile } from "@/components/settings/panel";
import { currentTime } from "@/lib/utils";

export const metadata = { title: "Notifications" };
export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const ctx = await requireOrgContext();
  const { items, unread, hasMore, nextBefore, nextBeforeId } = await listNotifications(ctx.user.id, {
    limit: 50,
    hidden: await hiddenKinds(ctx.user.id, ctx.org.orgId),
    orgId: ctx.org.orgId,
  });
  const attention = items.filter((item) => !item.read_at && (item.severity === "warning" || item.severity === "critical")).length;
  return (
    <div className="space-y-6">
      <PageHero
        tone="neutral"
        eyebrow="Your activity inbox"
        title="The updates that keep you in the loop."
        description="Configuration reviews, support replies, setup milestones and connection issues—all from saved notifications in your workspace."
        icon={<Bell />}
        aside={
          <div className="rounded-2xl border border-line bg-surface/80 p-5 shadow-soft">
            <div className="flex items-center gap-3.5">
              <IconTile icon={<BellDot />} tone={unread ? "primary" : "success"} size="lg" />
              <div>
                <p className="text-[32px] font-semibold leading-none tracking-[-0.04em] tabular-nums text-ink">{unread}</p>
                <p className="mt-1.5 text-[13px] text-muted">unread {unread === 1 ? "update" : "updates"}</p>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-1.5">
              {attention > 0 ? <StatusPill tone="warning">{attention} need attention</StatusPill> : <StatusPill tone="success">Nothing urgent</StatusPill>}
              <InfoChip>{hasMore ? `${items.length}+` : items.length} latest</InfoChip>
            </div>
          </div>
        }
      />
      <NotificationList
        items={JSON.parse(JSON.stringify(items))}
        timeZone={ctx.org.timezone}
        initialNow={currentTime()}
        hasMore={hasMore}
        nextBefore={nextBefore}
        nextBeforeId={nextBeforeId}
        description="Everything here is saved to your workspace. The timestamp pill shows the workspace time zone on hover."
      />
    </div>
  );
}
