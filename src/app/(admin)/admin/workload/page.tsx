import { requireAgency } from "@/server/tenancy/context";
import { loadWorkloadHome } from "@/server/staff-workload/overview";
import { WorkloadHomeView } from "@/components/staff-workload/home";
import { WorkloadHeader } from "@/components/staff-workload/shell";
import { enableStaffWorkloadFormAction } from "@/app/actions/staff-workload";

export const metadata = { title: "Staff workload" };
export const dynamic = "force-dynamic";

/** The agency team's workload overview. The page itself decides nothing: the service returns the team view, the person's own view, or the honest reason there is nothing. */
export default async function WorkloadPage() {
  const user = await requireAgency();
  const data = await loadWorkloadHome(user);
  return (
    <div className="space-y-5">
      <WorkloadHeader active="overview" showTeam={data.kind === "team"} showSettings={user.platformRole === "agency_super_admin"} />
      <WorkloadHomeView data={data} enableAction={enableStaffWorkloadFormAction} />
    </div>
  );
}
