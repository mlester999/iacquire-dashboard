import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { SourcesView } from "@/components/crm/views/sources-view";

export const metadata = { title: "Lead sources and ROI" };

export default async function LeadSourcesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await clientCrmActor("analytics.view");
  return <SourcesView actor={actor} scope={await scopeFor(actor, "/crm")} searchParams={await searchParams} />;
}
