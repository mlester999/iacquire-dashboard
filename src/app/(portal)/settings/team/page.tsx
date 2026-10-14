import { requireOrgContext } from "@/server/tenancy/context";
import { getTeam } from "@/server/settings/service";
import { TeamManager } from "@/components/settings/settings-forms";

export const metadata = { title: "Team" };

export default async function TeamPage() {
  const ctx = await requireOrgContext("team.view");
  const { members, invites } = await getTeam(ctx);
  return (
    <TeamManager
      members={JSON.parse(JSON.stringify(members))}
      invites={JSON.parse(JSON.stringify(invites))}
      myRole={ctx.role}
      myId={ctx.user.id}
      canManage={ctx.can("team.manage")}
    />
  );
}
