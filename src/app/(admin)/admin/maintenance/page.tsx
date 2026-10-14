import { requireAgency } from "@/server/tenancy/context";
import { listAgencyMaintenance } from "@/server/maintenance/service";
import { MaintenanceAdmin } from "@/components/admin/maintenance-admin";

export const metadata = { title: "Maintenance" };

export default async function AdminMaintenancePage() {
  const user = await requireAgency();
  const data = await listAgencyMaintenance(user);
  return (
    <div>
      <MaintenanceAdmin subscriptions={data.subscriptions} requests={data.requests} />
    </div>
  );
}
