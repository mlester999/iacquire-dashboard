import { requireOrgContext } from "@/server/tenancy/context";
import { StudioHomeView } from "@/components/automation-studio/views";

export const metadata = { title: "Automation Studio" };

export default async function AutomationStudioPage() {
  const ctx = await requireOrgContext("workflows.view");
  return <StudioHomeView ctx={ctx} />;
}
