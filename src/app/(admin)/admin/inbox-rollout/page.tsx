import { requireAgency } from "@/server/tenancy/context";
import { listRollout } from "@/server/messaging/inbox-rollout";
import { inboxEnabled } from "@/server/messaging/inbox-switch";
import { InboxRolloutAdmin } from "@/components/admin/inbox-rollout-admin";

export const metadata = { title: "Inbox rollout" };

export default async function AdminInboxRolloutPage() {
  // Super Admin only: anyone else is sent away before anything is read.
  const user = await requireAgency("super_admin");
  const rows = await listRollout(user);
  return <InboxRolloutAdmin rows={rows} globallyOff={!inboxEnabled()} />;
}
