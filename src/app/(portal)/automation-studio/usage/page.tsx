import { requireOrgContext } from "@/server/tenancy/context";
import { UsageView } from "@/components/automation-studio/views";

export const metadata = { title: "Usage and plan" };

export default async function UsagePage() {
  const ctx = await requireOrgContext("workflows.view");
  return <UsageView ctx={ctx} />;
}
