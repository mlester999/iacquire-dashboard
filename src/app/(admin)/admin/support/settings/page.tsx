import { requireAgency } from "@/server/tenancy/context";
import { loadAgencySupportCaps } from "@/server/support/access";
import { loadSupportSettingsFresh, listNotificationRules } from "@/server/support/settings";
import { SupportSubnav } from "@/components/admin/support/subnav";
import { SettingsForm } from "@/components/admin/support/settings-form";
import { env } from "@/server/env";

export const metadata = { title: "Request settings" };

export default async function SupportSettingsPage() {
  const user = await requireAgency();
  const [caps, settings, rules] = await Promise.all([loadAgencySupportCaps(user.id), loadSupportSettingsFresh(), listNotificationRules(user)]);
  // loadSupportSettingsFresh above, not the cached read: the form must show, and carry the revision of, what is saved right now.
  return (
    <div className="module-stack">
      <div className="min-w-0">
        <p className="text-[12px] font-semibold uppercase tracking-wide text-muted">Agency client care</p>
        <h1 className="mt-1 text-[26px] font-semibold tracking-[-0.04em] text-ink">Request settings</h1>
        <p className="mt-1 max-w-2xl text-[14px] leading-relaxed text-muted">Response expectations, support hours, how updates are delivered, and the limits on files and reopening.</p>
      </div>
      <SupportSubnav active="settings" caps={caps} />
      <SettingsForm settings={settings} rules={rules.map((r) => ({ event: r.event, mode: r.mode }))} emailMode={env().EMAIL_PROVIDER} canEdit={caps["agency.support.settings"]} />
    </div>
  );
}
