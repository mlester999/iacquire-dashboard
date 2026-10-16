import { requireAgency } from "@/server/tenancy/context";
import { listAgencyAgents, listAllAgents } from "@/server/admin/queries";
import { WorkforceManager } from "@/components/admin/workforce-manager";
import { AgencyWorkforceManager } from "@/components/admin/agency-workforce-manager";
import { withSystem } from "@/server/db";
import { listHermesGateways } from "@/server/integrations/hermes/gateways";

export const metadata = { title: "AI Workforce" };

export default async function AdminWorkforcePage() {
  const user = await requireAgency();
  const [agents, agencyAgents, gateways] = await Promise.all([
    listAllAgents(user),
    listAgencyAgents(user),
    user.platformRole === "agency_super_admin" ? withSystem(listHermesGateways) : Promise.resolve([]),
  ]);
  return <div className="module-stack">{user.platformRole === "agency_super_admin" && <AgencyWorkforceManager agents={agencyAgents} gateways={gateways} canManage />}<WorkforceManager agents={agents} /></div>;
}
