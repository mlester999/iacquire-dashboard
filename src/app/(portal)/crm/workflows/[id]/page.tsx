import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { WorkflowView } from "@/components/crm/views/workflow-view";

export const metadata = { title: "Workflow" };

export default async function WorkflowPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await clientCrmActor("workflows.view");
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  return <WorkflowView actor={actor} scope={await scopeFor(actor, "/crm")} id={id} searchParams={sp} />;
}
