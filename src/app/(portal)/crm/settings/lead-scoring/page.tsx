import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { LeadScoringView } from "@/components/crm/views/lead-scoring-view";

export const metadata = { title: "Lead scoring" };

export default async function LeadScoringPage() {
  const actor = await clientCrmActor("contacts.view");
  return <LeadScoringView actor={actor} scope={await scopeFor(actor, "/crm")} />;
}
