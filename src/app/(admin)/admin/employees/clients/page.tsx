import { requireAgency } from "@/server/tenancy/context";
import { listClientWorkforceSummaries } from "@/server/workforce/agency-registry";
import { ClientWorkforcesManager } from "@/components/admin/client-workforces-manager";

export const metadata = { title: "Client Workforces" };

export default async function ClientWorkforcesPage() {
  const user = await requireAgency();
  const clients = await listClientWorkforceSummaries(user);
  return <ClientWorkforcesManager clients={clients} timeZone={user.timezone} />;
}
