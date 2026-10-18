import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { CustomValuesView } from "@/components/crm/views/custom-values-view";

export const metadata = { title: "Configuration Values" };

export default async function ConfigurationValuesPage() {
  const actor = await clientCrmActor("crm.view");
  return <CustomValuesView actor={actor} scope={await scopeFor(actor, "/crm")} />;
}
