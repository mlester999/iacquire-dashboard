import { requireOrgContext } from "@/server/tenancy/context";
import { getNotificationPrefs, NOTIFICATION_GROUPS } from "@/server/settings/service";
import { NotificationPrefsForm } from "@/components/settings/settings-forms";
import { env } from "@/server/env";

export const metadata = { title: "Notification settings" };

export default async function NotificationSettingsPage() {
  const ctx = await requireOrgContext();
  const prefs = await getNotificationPrefs(ctx);
  // Email is only offered when the agency has connected a real provider.
  const emailAvailable = env().EMAIL_PROVIDER === "resend" && Boolean(env().RESEND_API_KEY);
  return <NotificationPrefsForm groups={NOTIFICATION_GROUPS.map(({ key, label, description }) => ({ key, label, description }))} prefs={prefs} emailAvailable={emailAvailable} />;
}
