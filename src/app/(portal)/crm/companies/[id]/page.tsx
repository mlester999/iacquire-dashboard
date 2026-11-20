import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { CompanyView } from "@/components/crm/views/company-view";

export default async function CompanyPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const actor = await clientCrmActor("companies.view");
  const [{ id }, { tab }] = await Promise.all([params, searchParams]);
  return <CompanyView actor={actor} scope={await scopeFor(actor, "/crm")} id={id} initialTab={tab === "tasks" ? "tasks" : "activity"} />;
}
