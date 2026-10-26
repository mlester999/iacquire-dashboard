import { requireAgency } from "@/server/tenancy/context";
import { listAgencyMaintenance } from "@/server/maintenance/service";
import { MaintenanceAdmin } from "@/components/admin/maintenance-admin";
import { withSystem } from "@/server/db";
import { recurringAvailability } from "@/server/maintenance/agreement-read";

export const metadata = { title: "Maintenance" };

export default async function AdminMaintenancePage() {
  const user = await requireAgency();
  const data = await listAgencyMaintenance(user);
  const availability = await withSystem((db) => recurringAvailability(db));
  return (
    <div>
      <MaintenanceAdmin subscriptions={data.subscriptions} requests={data.requests} recurring={{ state: availability, canManage: user.platformRole === "agency_super_admin" }} />
    </div>
  );
}
