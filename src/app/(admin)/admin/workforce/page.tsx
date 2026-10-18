import { requireAgency } from "@/server/tenancy/context";
import { listAgencyAgents, listAllAgents } from "@/server/admin/queries";
import { WorkforceManager } from "@/components/admin/workforce-manager";
import { AgencyWorkforceManager } from "@/components/admin/agency-workforce-manager";
import { withSystem } from "@/server/db";
import { listHermesGateways } from "@/server/integrations/hermes/gateways";
import { ensureAgencyWorkspace } from "@/server/workforce/agency";

export const metadata = { title: "AI Workforce" };

export default async function AdminWorkforcePage() {
  const user = await requireAgency();
  if (user.platformRole === "agency_super_admin") await ensureAgencyWorkspace(user).catch(() => null);
  const [agents, agencyAgents, gateways, agencyTimezoneRows] = await Promise.all([
    listAllAgents(user),
    listAgencyAgents(user),
    user.platformRole === "agency_super_admin" ? withSystem(listHermesGateways) : Promise.resolve([]),
    withSystem((db) => db.query<{ timezone: string }>("select timezone from organizations where kind='agency' order by created_at limit 1")),
  ]);
  return <div className="module-stack">{user.platformRole === "agency_super_admin" && <AgencyWorkforceManager agents={agencyAgents} gateways={gateways} canManage timeZone={agencyTimezoneRows.rows[0]?.timezone ?? "UTC"} />}<WorkforceManager agents={agents} /></div>;
}
