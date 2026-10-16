import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { ProviderView } from "@/components/crm/views/settings-views";

export const metadata = { title: "CRM Provider" };

export default async function Page() {
  const actor = await clientCrmActor("crm.view");
  return <ProviderView actor={actor} scope={await scopeFor(actor, "/crm")} />;
}
