import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { CompaniesView } from "@/components/crm/views/companies-view";

export const metadata = { title: "Companies" };

export default async function CompaniesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await clientCrmActor("companies.view");
  return <CompaniesView actor={actor} scope={await scopeFor(actor, "/crm")} searchParams={await searchParams} />;
}
