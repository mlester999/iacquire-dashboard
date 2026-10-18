import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { WorkflowsView } from "@/components/crm/views/workflows-view";

export const metadata = { title: "Workflows" };

export default async function WorkflowsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await clientCrmActor("workflows.view");
  return <WorkflowsView actor={actor} scope={await scopeFor(actor, "/crm")} searchParams={await searchParams} />;
}
