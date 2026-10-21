import { requireOrgContext } from "@/server/tenancy/context";
import { StudioWorkflowView } from "@/components/automation-studio/views";

export const metadata = { title: "Automation" };

export default async function AutomationStudioWorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireOrgContext("workflows.view");
  const { id } = await params;
  return <StudioWorkflowView ctx={ctx} id={id} />;
}
