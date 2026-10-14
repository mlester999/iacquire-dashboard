import { requireOrgContext } from "@/server/tenancy/context";
import { hiddenKinds, listNotifications } from "@/server/notifications";
import { NotificationList } from "@/components/notifications/notification-list";
import { PageHero } from "@/components/ui/workspace";
import { Bell } from "lucide-react";

export const metadata = { title: "Notifications" };

export default async function NotificationsPage() {
  const ctx = await requireOrgContext();
  const { items } = await listNotifications(ctx.user.id, 100, await hiddenKinds(ctx.user.id, ctx.org.orgId));
  return (
    <div className="space-y-6">
      <PageHero tone="neutral" eyebrow="Your activity inbox" title="The updates that keep you in the loop." description="Setup milestones, team decisions, support replies and connection issues—all from saved notifications in your workspace." icon={<Bell />} aside={<div className="rounded-xl border border-line bg-primary-soft px-5 py-4"><p className="text-3xl font-semibold text-primary-ink">{items.filter((i) => !i.read_at).length}</p><p className="mt-1 text-xs text-muted">unread updates in this view</p></div>} />
      <NotificationList items={JSON.parse(JSON.stringify(items))} timeZone={ctx.org.timezone} />
    </div>
  );
}
