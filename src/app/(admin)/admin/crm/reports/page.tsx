import { requireAgency } from "@/server/tenancy/context";
import { agencyCrmOperations } from "@/server/crm/reports/agency";
import { AgencyOpsReport } from "@/components/crm/agency-reports/agency-ops-report";

export const metadata = { title: "CRM operations" };
export const dynamic = "force-dynamic";

export default async function AgencyCrmReportsPage() {
  const user = await requireAgency();
  const summary = await agencyCrmOperations(user);
  return <AgencyOpsReport summary={summary} superAdmin={user.platformRole === "agency_super_admin"} />;
}
