import { requireAgency } from "@/server/tenancy/context";
import { listNotifications } from "@/server/notifications";
import { AdminPageHeader } from "@/components/admin/admin-shell";
import { NotificationList } from "@/components/notifications/notification-list";
import { currentTime } from "@/lib/utils";

export const metadata = { title: "Notifications" };
export const dynamic = "force-dynamic";

/**
 * The agency-side notification centre. It uses the same saved notifications and the same action as
 * the client bell, so a Super Admin sees the review requests, support tickets, onboarding failures
 * and operational alerts that `notifyAgency` already wrote for them — never a client's private feed.
 */
export default async function AdminNotificationsPage() {
  const user = await requireAgency();
  const { items, hasMore, nextBefore, nextBeforeId } = await listNotifications(user.id, { limit: 50 });
  return (
    <div className="module-stack">
      <AdminPageHeader
        title="Notifications"
        description="Review requests, support, onboarding and operational alerts for the clients in your agency scope. The same saved events power the notification bell in every workspace."
      />
      <NotificationList
        items={JSON.parse(JSON.stringify(items))}
        timeZone={user.timezone}
        initialNow={currentTime()}
        hasMore={hasMore}
        nextBefore={nextBefore}
        nextBeforeId={nextBeforeId}
        description={
          user.platformRole === "agency_super_admin"
            ? "Agency-wide view. Client-specific destinations still enforce tenant access when opened."
            : "Scoped to the clients assigned to your agency account. Opening a client destination re-checks that access."
        }
      />
    </div>
  );
}
