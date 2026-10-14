import { requireAgency } from "@/server/tenancy/context";
import { agencyTeamView } from "@/server/admin/team";
import { TeamManagement } from "@/components/admin/team-management";

export const metadata = { title: "Agency team" };

export default async function AgencyTeamPage() {
  const user = await requireAgency("super_admin");
  return <TeamManagement data={await agencyTeamView(user)} timeZone={user.timezone} />;
}
