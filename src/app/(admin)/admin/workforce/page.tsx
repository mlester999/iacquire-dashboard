import { requireAgency } from "@/server/tenancy/context";
import { listAllAgents } from "@/server/admin/queries";
import { WorkforceManager } from "@/components/admin/workforce-manager";

export const metadata = { title: "AI Workforce" };

export default async function AdminWorkforcePage() {
  const user = await requireAgency();
  const agents = await listAllAgents(user);
  return <WorkforceManager agents={agents} />;
}
