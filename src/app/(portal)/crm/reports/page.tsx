import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { ReportsView } from "@/components/crm/views/reports-view";

export const metadata = { title: "Reports" };

export default async function CrmReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await clientCrmActor("analytics.view");
  return <ReportsView actor={actor} scope={await scopeFor(actor, "/crm")} searchParams={await searchParams} />;
}
