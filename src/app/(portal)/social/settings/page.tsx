import { Settings } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { getSocialSettings, listCampaigns } from "@/server/social/settings";
import { SettingsPanel } from "@/components/social/settings-panel";

export const metadata = { title: "Social media settings" };

export default async function SocialSettingsPage() {
  const ctx = await requireOrgContext("social.view");
  const [settings, campaigns] = await Promise.all([getSocialSettings(ctx), listCampaigns(ctx)]);
  return (
    <div className="space-y-5">
      <header>
        <h1 className="flex items-center gap-2 text-[22px] font-semibold tracking-tight text-ink"><Settings className="size-5 text-muted" aria-hidden />Settings</h1>
        <p className="mt-1 max-w-2xl text-[13.5px] text-muted">Who has to approve posts, what the AI may do, and how links are tagged.</p>
      </header>
      <SettingsPanel settings={settings} campaigns={campaigns} canEdit={ctx.can("social.settings")} canCampaign={ctx.can("social.create")} />
    </div>
  );
}
