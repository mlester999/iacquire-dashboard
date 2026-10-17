import { requireAgency } from "@/server/tenancy/context";
import { listAgencyAgents } from "@/server/admin/queries";
import { AgencyWorkforceManager } from "@/components/admin/agency-workforce-manager";
import { withSystem } from "@/server/db";
import { listHermesGateways } from "@/server/integrations/hermes/gateways";

export const metadata = { title: "Internal Workforce" };

export default async function AdminWorkforcePage() {
  const user = await requireAgency("super_admin");
  const [agents, gateways] = await Promise.all([
    listAgencyAgents(user),
    withSystem(listHermesGateways),
  ]);
  return <AgencyWorkforceManager agents={agents} gateways={gateways} canManage timeZone={user.timezone} />;
}
