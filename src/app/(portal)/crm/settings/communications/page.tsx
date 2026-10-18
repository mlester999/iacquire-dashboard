import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { CommunicationsView } from "@/components/crm/views/communications-view";

export const metadata = { title: "Communication settings" };

export default async function CommunicationSettingsPage() {
  const actor = await clientCrmActor("inbox.view");
  return <CommunicationsView actor={actor} scope={await scopeFor(actor, "/crm")} />;
}
