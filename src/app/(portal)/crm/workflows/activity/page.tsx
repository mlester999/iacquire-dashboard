import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { WorkflowActivityView } from "@/components/crm/views/workflows-view";

export const metadata = { title: "Workflow activity" };

export default async function WorkflowActivityPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await clientCrmActor("workflows.view");
  return <WorkflowActivityView actor={actor} scope={await scopeFor(actor, "/crm")} searchParams={await searchParams} />;
}
