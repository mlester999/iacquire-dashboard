import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { SmartListsView } from "@/components/crm/views/data-model-views";

export const metadata = { title: "Smart Lists" };

export default async function SmartListsPage() {
  const actor = await clientCrmActor("contacts.view");
  return <SmartListsView actor={actor} scope={await scopeFor(actor, "/crm")} />;
}
