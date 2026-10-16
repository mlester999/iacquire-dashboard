import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { OpportunitiesView } from "@/components/crm/views/opportunities-view";

export const metadata = { title: "Opportunities" };

export default async function OpportunitiesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await clientCrmActor("sales.view");
  return <OpportunitiesView actor={actor} scope={await scopeFor(actor, "/crm")} searchParams={await searchParams} />;
}
