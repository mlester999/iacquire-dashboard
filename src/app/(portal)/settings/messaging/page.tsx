import { requireOrgContext } from "@/server/tenancy/context";
import { getMessagingSettings } from "@/server/messaging/inbox";
import { MessagingSettings } from "@/components/settings/messaging-settings";

export const metadata = { title: "Messaging" };

export default async function MessagingSettingsPage() {
  const ctx = await requireOrgContext("inbox.view");
  const settings = await getMessagingSettings(ctx);
  return <MessagingSettings settings={settings} isOwner={ctx.role === "owner"} canConfigure={ctx.can("messaging.configure")} />;
}
