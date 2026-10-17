import { requireAgencyPermissionOrThrow } from "@/server/tenancy/context";
import { listIntegrationManager } from "@/server/integrations/manager";
import { listTenants } from "@/server/admin/tenants";
import { IntegrationsManager } from "@/components/admin/integrations-manager";
import { ensureAgencyWorkforceRegistry } from "@/server/workforce/agency-registry";
import { withUser } from "@/server/db";

export const metadata={title:"Integrations"};
export const dynamic="force-dynamic";
export default async function AgencyIntegrationsPage() {
  const user=await requireAgencyPermissionOrThrow("agency.integrations.health");
  const superAdmin=user.platformRole==="agency_super_admin";
  if(superAdmin)await ensureAgencyWorkforceRegistry(user);
  const [initial,clients]=await Promise.all([
    listIntegrationManager(user,null),
    superAdmin
      ? listTenants(user).then(rows=>rows.map(({id,name})=>({id,name})))
      : withUser(user.id,db=>db.query<{id:string;name:string}>(
          "select id,name from organizations where kind='client' and status not in ('suspended','archived') and app.user_can_access_org($1,id) order by name",
          [user.id],
        )).then(result=>result.rows),
  ]);
  return <IntegrationsManager initial={initial} orgId={null} superAdmin={superAdmin} timeZone={user.timezone} clients={clients}/>;
}
