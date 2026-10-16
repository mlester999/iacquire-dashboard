import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { CompanyView } from "@/components/crm/views/company-view";

export default async function CompanyPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await clientCrmActor("companies.view");
  const { id } = await params;
  return <CompanyView actor={actor} scope={await scopeFor(actor, "/crm")} id={id} />;
}
