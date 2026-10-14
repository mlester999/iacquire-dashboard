import { requireAgency } from "@/server/tenancy/context";
import { listAgencyMaintenance } from "@/server/maintenance/service";
import { AdminPageHeader } from "@/components/admin/admin-shell";
import { MaintenanceAdmin } from "@/components/admin/maintenance-admin";

export const metadata = { title: "Maintenance" };

export default async function AdminMaintenancePage() {
  const user = await requireAgency();
  const data = await listAgencyMaintenance(user);
  return (
    <div>
      <AdminPageHeader title="Managed maintenance" description="Optional plans and requests from clients you work with. Nothing here charges a client; billing is handled outside the portal." />
      <MaintenanceAdmin subscriptions={data.subscriptions} requests={data.requests} />
    </div>
  );
}
