import { redirect } from "next/navigation";
import { requireAgency } from "@/server/tenancy/context";
import { prospectsCapabilities } from "@/server/demo/access";
import { getDemoSettings } from "@/server/demo/settings";
import { demoDeploymentEnabled, demoPublicDisabled } from "@/server/demo/switch";
import { DemoSettingsForm } from "@/components/demo/admin/settings-form";

export const metadata = { title: "Demo settings" };
export const dynamic = "force-dynamic";

export default async function DemoSettingsPage() {
  const user = await requireAgency();
  const caps = await prospectsCapabilities(user);
  if (!caps.view) redirect("/admin");
  const stored = await getDemoSettings(user);
  // Keyed by the version, so a page that was refreshed after someone else's save starts again from the new values.
  return <DemoSettingsForm key={stored.version} settings={stored.settings} version={stored.version} env={{ environment: demoDeploymentEnabled(), emergencyStop: demoPublicDisabled() }} canManage={caps.manage} />;
}
