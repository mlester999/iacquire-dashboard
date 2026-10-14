import { requireOrgContext } from "@/server/tenancy/context";
import { getMaintenanceOverview } from "@/server/maintenance/service";
import { MaintenancePanel } from "@/components/projects/maintenance-panel";

export const metadata = { title: "Managed maintenance" };

export default async function MaintenancePage() {
  const ctx = await requireOrgContext("maintenance.view");
  const overview = await getMaintenanceOverview(ctx);
  return (
    <div className="space-y-6">
      <div>
        <p className="mb-1 text-xs font-semibold uppercase tracking-[.12em] text-primary">Optional</p>
        <h2 className="text-[26px] font-semibold tracking-[-0.02em]">Managed maintenance</h2>
        <p className="mt-1 max-w-2xl text-[14px] text-muted">Hands-on upkeep for your live iAcquire system. It&apos;s never required to use what you already have, and nothing here enrolls you automatically.</p>
      </div>
      <MaintenancePanel overview={overview} timeZone={ctx.org.timezone} canManagePlan={ctx.can("maintenance.manage_plan")} canRequest={ctx.can("maintenance.request")} />
    </div>
  );
}
