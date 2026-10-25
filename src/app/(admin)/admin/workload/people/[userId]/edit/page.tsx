import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireAgency } from "@/server/tenancy/context";
import { AppError } from "@/server/errors";
import { loadPersonWorkload } from "@/server/staff-workload/view";
import { getProfile, listTimeOff } from "@/server/staff-workload/profile";
import { todayIn } from "@/lib/staff-workload/calendar";
import { ProfileEditor } from "@/components/staff-workload/profile-editor";
import { WorkloadDenied, WorkloadHeader, WorkloadOff } from "@/components/staff-workload/shell";
import { enableStaffWorkloadFormAction } from "@/app/actions/staff-workload";

export const metadata = { title: "Edit workload profile" };
export const dynamic = "force-dynamic";

export default async function EditPersonWorkloadPage({ params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  const user = await requireAgency();
  let data;
  try {
    data = await loadPersonWorkload(user, userId);
  } catch (error) {
    if (error instanceof AppError && error.code === "not_found") notFound();
    if (error instanceof AppError && error.code === "not_enabled") {
      return (
        <div className="space-y-5">
          <WorkloadHeader active="overview" showTeam={false} showSettings={user.platformRole === "agency_super_admin"} />
          <WorkloadOff canEnable={user.platformRole === "agency_super_admin"} enableAction={enableStaffWorkloadFormAction} />
        </div>
      );
    }
    if (error instanceof AppError && error.code === "forbidden") {
      return (
        <div className="space-y-5">
          <WorkloadHeader active="overview" showTeam={false} showSettings={user.platformRole === "agency_super_admin"} />
          <WorkloadDenied />
        </div>
      );
    }
    throw error;
  }
  const canManageProfile = data.caps.manage;
  const canEditTimeOff = data.caps.manage || user.id === userId;
  if (!canManageProfile && !canEditTimeOff) redirect(`/admin/workload/people/${userId}`);
  const [profile, timeOff] = await Promise.all([getProfile(user, userId), listTimeOff(user, userId)]);
  return (
    <div className="space-y-5">
      <WorkloadHeader active="overview" showTeam={data.caps.team} showSettings={user.platformRole === "agency_super_admin"} />
      <div>
        <Link href={`/admin/workload/people/${userId}`} className="inline-flex items-center gap-1.5 text-[14px] text-muted hover:text-ink">
          <ArrowLeft className="size-3.5" aria-hidden /> {data.person.name}
        </Link>
      </div>
      <ProfileEditor
        userId={userId}
        name={data.person.name}
        profile={profile}
        timeOff={timeOff}
        today={todayIn(new Date(), data.frame.timeZone)}
        canManageProfile={canManageProfile}
        canEditTimeOff={canEditTimeOff}
      />
    </div>
  );
}
