import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { WorkflowRunView } from "@/components/crm/views/workflow-view";

export const metadata = { title: "Workflow run" };

export default async function WorkflowRunPage({ params }: { params: Promise<{ id: string; runId: string }> }) {
  const actor = await clientCrmActor("workflows.view");
  const { id, runId } = await params;
  return <WorkflowRunView actor={actor} scope={await scopeFor(actor, "/crm")} workflowId={id} runId={runId} />;
}
