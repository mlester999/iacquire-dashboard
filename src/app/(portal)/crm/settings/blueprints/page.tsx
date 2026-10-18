import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { BlueprintsView } from "@/components/crm/views/blueprints-view";

export const metadata = { title: "Blueprints & setup" };

export default async function BlueprintsSetupPage() {
  const actor = await clientCrmActor("crm.view");
  return <BlueprintsView actor={actor} scope={await scopeFor(actor, "/crm")} />;
}
