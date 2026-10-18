import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { FormsView } from "@/components/crm/views/forms-view";

export const metadata = { title: "Forms & surveys" };

export default async function FormsPage() {
  const actor = await clientCrmActor("crm.view");
  return <FormsView actor={actor} scope={await scopeFor(actor, "/crm")} />;
}
