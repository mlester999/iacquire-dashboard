import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { OverviewView } from "@/components/crm/views/overview-view";

export const metadata = { title: "CRM" };

export default async function CrmOverviewPage() {
  const actor = await clientCrmActor("crm.view");
  return <OverviewView actor={actor} scope={await scopeFor(actor, "/crm")} />;
}
