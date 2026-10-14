import { requireAgency } from "@/server/tenancy/context";
import { listUsageByTenant } from "@/server/admin/queries";
import { UsageWorkspace } from "@/components/admin/operations-workspaces";
export const metadata = { title: "Usage & costs" };
export default async function AdminUsagePage() {
  const user = await requireAgency();
  return <UsageWorkspace rows={await listUsageByTenant(user)} />;
}
