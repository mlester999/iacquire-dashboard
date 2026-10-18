import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { DeveloperView } from "@/components/crm/views/developer-view";

export const metadata = { title: "API & Webhooks" };

export default async function ApiWebhooksPage() {
  const actor = await clientCrmActor("crm.api.manage");
  return <DeveloperView actor={actor} scope={await scopeFor(actor, "/crm")} />;
}
