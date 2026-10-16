import { requireOrgContext } from "@/server/tenancy/context";
import { hiddenKinds, listNotifications } from "@/server/notifications";
import { NotificationList } from "@/components/notifications/notification-list";
import { PageHero } from "@/components/ui/workspace";
import { Bell, BellDot } from "lucide-react";
import { InfoChip, StatusPill } from "@/components/ui/status";
import { IconTile } from "@/components/settings/panel";

export const metadata = { title: "Notifications" };

export default async function NotificationsPage() {
  const ctx = await requireOrgContext();
  const { items } = await listNotifications(ctx.user.id, 100, await hiddenKinds(ctx.user.id, ctx.org.orgId));
  const unread = items.filter((i) => !i.read_at);
  const attention = unread.filter((i) => i.severity === "warning" || i.severity === "critical").length;
  return (
    <div className="space-y-6">
      <PageHero
        tone="neutral"
        eyebrow="Your activity inbox"
        title="The updates that keep you in the loop."
        description="Setup milestones, team decisions, support replies and connection issues—all from saved notifications in your workspace."
        icon={<Bell />}
        aside={
          <div className="rounded-2xl border border-line bg-surface/80 p-5 shadow-soft">
            <div className="flex items-center gap-3.5">
              <IconTile icon={<BellDot />} tone={unread.length ? "primary" : "success"} size="lg" />
              <div>
                <p className="text-[32px] font-semibold leading-none tracking-[-0.04em] tabular-nums text-ink">{unread.length}</p>
                <p className="mt-1.5 text-[12.5px] text-muted">unread {unread.length === 1 ? "update" : "updates"} in this view</p>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-1.5">
              {attention > 0 ? <StatusPill tone="warning">{attention} unread need attention</StatusPill> : <StatusPill tone="success">Nothing urgent</StatusPill>}
              <InfoChip>{items.length} in total</InfoChip>
            </div>
          </div>
        }
      />
      <NotificationList items={JSON.parse(JSON.stringify(items))} timeZone={ctx.org.timezone} />
    </div>
  );
}
