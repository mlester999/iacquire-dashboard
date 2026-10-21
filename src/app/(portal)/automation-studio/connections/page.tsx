import { requireOrgContext } from "@/server/tenancy/context";
import { ConnectionsView } from "@/components/automation-studio/views";

export const metadata = { title: "Connections" };

export default async function ConnectionsPage() {
  const ctx = await requireOrgContext("workflows.view");
  return <ConnectionsView ctx={ctx} />;
}
