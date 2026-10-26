import { requireAgency } from "@/server/tenancy/context";
import { AppError } from "@/server/errors";
import { loadMyWorkload, type MyWorkload } from "@/server/staff-workload/view";
import { MyWorkloadView } from "@/components/staff-workload/home";
import { WorkloadDenied, WorkloadHeader, WorkloadOff } from "@/components/staff-workload/shell";
import { enableStaffWorkloadFormAction } from "@/app/actions/staff-workload";

export const metadata = { title: "My workload" };
export const dynamic = "force-dynamic";

export default async function MyWorkloadPage() {
  const user = await requireAgency();
  let mine: MyWorkload | null = null;
  let off = false;
  try {
    mine = await loadMyWorkload(user);
  } catch (error) {
    if (error instanceof AppError && error.code === "not_enabled") off = true;
    else if (error instanceof AppError && error.code === "forbidden") return <Denied user={user} />;
    else throw error;
  }
  if (off) {
    return (
      <div className="space-y-5">
        <WorkloadHeader active="me" showTeam={false} showSettings={user.platformRole === "agency_super_admin"} />
        <WorkloadOff canEnable={user.platformRole === "agency_super_admin"} enableAction={enableStaffWorkloadFormAction} />
      </div>
    );
  }
  if (!mine) return <Denied user={user} />;
  return (
    <div className="space-y-5">
      <WorkloadHeader active="me" showTeam={mine.caps.team} showSettings={user.platformRole === "agency_super_admin"} />
      <MyWorkloadView mine={mine} />
    </div>
  );
}

function Denied({ user }: { user: { platformRole: string } }) {
  return (
    <div className="space-y-5">
      <WorkloadHeader active="me" showTeam={false} showSettings={user.platformRole === "agency_super_admin"} />
      <WorkloadDenied />
    </div>
  );
}
