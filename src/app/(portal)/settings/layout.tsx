import { requireOrgContext } from "@/server/tenancy/context";
import { SettingsNav } from "@/components/settings/settings-nav";
import { PageHero } from "@/components/ui/workspace";
import { Settings } from "lucide-react";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireOrgContext();
  return (
    <div className="space-y-6">
      <PageHero tone="neutral" eyebrow="Workspace preferences" title="Make iAcquire work the way you do." description="Manage your business profile, team access, AI preferences and account security. Your permissions determine what you can change." icon={<Settings />} />
      <div className="grid min-w-0 gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        <div className="min-w-0 self-start lg:sticky lg:top-24"><SettingsNav permissions={ctx.permissions} /></div>
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
