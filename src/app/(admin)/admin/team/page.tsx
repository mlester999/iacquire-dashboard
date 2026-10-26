import { requireAgency } from "@/server/tenancy/context";
import { agencyTeamView } from "@/server/admin/team";
import { getClientContentPolicy } from "@/server/admin/client-content-policy";
import { TeamManagement } from "@/components/admin/team-management";
import { ClientContentPolicyCard } from "@/components/admin/client-content-policy-card";

export const metadata = { title: "Agency team" };

export default async function AgencyTeamPage() {
  const user = await requireAgency("super_admin");
  const [data, policy] = await Promise.all([agencyTeamView(user), getClientContentPolicy()]);
  return (
    <div className="space-y-6">
      <ClientContentPolicyCard initial={policy} timeZone={user.timezone} />
      <TeamManagement data={data} timeZone={user.timezone} />
    </div>
  );
}
