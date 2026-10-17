import { requireAgency } from "@/server/tenancy/context";
import { listIntegrationManager } from "@/server/integrations/manager";
import { listTenants } from "@/server/admin/tenants";
import { IntegrationsManager } from "@/components/admin/integrations-manager";
import { ensureAgencyWorkforceRegistry } from "@/server/workforce/agency-registry";

export const metadata={title:"Integrations"};
export const dynamic="force-dynamic";
export default async function AgencyIntegrationsPage() {
  const user=await requireAgency("super_admin");
  await ensureAgencyWorkforceRegistry(user);
  const [initial,clients]=await Promise.all([listIntegrationManager(user,null),listTenants(user)]);
  return <IntegrationsManager initial={initial} orgId={null} superAdmin timeZone={user.timezone} clients={clients.map(c=>({id:c.id,name:c.name}))}/>;
}
