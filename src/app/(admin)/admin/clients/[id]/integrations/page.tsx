import { notFound } from "next/navigation";
import { requireAgency,requireAgencyOrgAccessOrThrow } from "@/server/tenancy/context";
import { listIntegrationManager } from "@/server/integrations/manager";
import { withUser } from "@/server/db";
import { IntegrationsManager } from "@/components/admin/integrations-manager";

export const metadata={title:"Client integrations"};
export const dynamic="force-dynamic";
export default async function ClientIntegrationsPage({params,searchParams}:{params:Promise<{id:string}>;searchParams:Promise<{connect?:string}>}) {
  const {id}=await params;const {connect}=await searchParams;if(!/^[0-9a-f-]{36}$/i.test(id))notFound();
  const user=await requireAgency();await requireAgencyOrgAccessOrThrow(id);
  const {rows}=await withUser(user.id,db=>db.query<{name:string}>("select name from organizations where id=$1 and kind='client'",[id]));
  if(!rows[0])notFound();
  const superAdmin=user.platformRole==="agency_super_admin";
  return <IntegrationsManager initial={await listIntegrationManager(user,id)} orgId={id} companyName={rows[0].name} superAdmin={superAdmin} timeZone={user.timezone} autoConnect={superAdmin&&(connect==="ghl"||connect==="hermes")?connect:undefined}/>;
}
