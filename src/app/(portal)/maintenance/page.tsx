import { requireOrgContext } from "@/server/tenancy/context";
import { getMaintenanceOverview } from "@/server/maintenance/service";
import { Wrench } from "lucide-react";
import { PageHero } from "@/components/ui/workspace";
import { MaintenancePanel } from "@/components/projects/maintenance-panel";

export const metadata = { title: "Managed maintenance" };

export default async function MaintenancePage() {
  const ctx = await requireOrgContext("maintenance.view");
  const overview = await getMaintenanceOverview(ctx);
  return (
    <div className="space-y-6">
      <PageHero icon={<Wrench className="size-4" />} eyebrow="Optional" title="Managed maintenance" description="Hands-on upkeep for your live iAcquire system. It's never required to use what you already have, and nothing here enrolls you automatically." />
      <MaintenancePanel overview={overview} timeZone={ctx.org.timezone} canManagePlan={ctx.can("maintenance.manage_plan")} canRequest={ctx.can("maintenance.request")} />
    </div>
  );
}
