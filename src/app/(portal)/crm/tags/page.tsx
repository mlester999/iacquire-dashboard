import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { TagsView } from "@/components/crm/views/data-model-views";

export const metadata = { title: "Tags & Segments" };

export default async function TagsPage() {
  const actor = await clientCrmActor("crm.view");
  return <TagsView actor={actor} scope={await scopeFor(actor, "/crm")} />;
}
