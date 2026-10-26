import { requireAgency } from "@/server/tenancy/context";
import { loadStaffMessageSettings, staffMessagesEnabled } from "@/server/staff-messages/settings";
import { SettingsPanel } from "@/components/staff-messages/settings-panel";

export const metadata = { title: "Messages settings" };
export const dynamic = "force-dynamic";

/** Super Admin only: anyone else is sent away before anything is read. The actions behind the controls check the role again from the database. */
export default async function MessagesSettingsPage() {
  await requireAgency("super_admin");
  const [enabled, settings] = await Promise.all([staffMessagesEnabled(), loadStaffMessageSettings()]);
  return <SettingsPanel enabled={enabled} retentionDays={settings.retentionDays} />;
}
