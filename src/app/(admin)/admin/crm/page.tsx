import { requireAgency } from "@/server/tenancy/context";
import { agencyCrmPortfolio } from "@/server/crm/agency";
import { AgencyCrmPortfolio } from "@/components/crm/agency-portfolio";

export const metadata = { title: "Client CRMs" };

export default async function AgencyCrmPage() {
  const user = await requireAgency();
  const rows = await agencyCrmPortfolio(user);
  return <AgencyCrmPortfolio rows={rows} />;
}
