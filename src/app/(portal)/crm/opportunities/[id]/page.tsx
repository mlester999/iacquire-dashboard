import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { OpportunityView } from "@/components/crm/views/opportunity-view";

export default async function OpportunityPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await clientCrmActor("sales.view");
  const { id } = await params;
  return <OpportunityView actor={actor} scope={await scopeFor(actor, "/crm")} id={id} />;
}
