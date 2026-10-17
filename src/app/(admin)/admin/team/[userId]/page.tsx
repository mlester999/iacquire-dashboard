import { notFound } from "next/navigation";
import { requireAgency } from "@/server/tenancy/context";
import { agencyTeamMemberView } from "@/server/admin/team";
import { AgencyTeamMemberDetails } from "@/components/admin/agency-team-member-details";

export const metadata = { title: "Team member access" };

export default async function AgencyTeamMemberPage({ params }: { params: Promise<{ userId: string }> }) {
  const user = await requireAgency("super_admin");
  const { userId } = await params;
  const { view: data, member } = await agencyTeamMemberView(user, userId);
  if (!member) notFound();
  return <AgencyTeamMemberDetails key={`${member.id}:${member.revision}`} data={data} memberId={member.id} timeZone={user.timezone} />;
}
