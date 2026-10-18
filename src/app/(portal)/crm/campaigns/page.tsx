import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { CampaignsView } from "@/components/crm/views/campaigns-view";

export const metadata = { title: "Campaigns" };

export default async function CampaignsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await clientCrmActor("campaigns.manage");
  return <CampaignsView actor={actor} scope={await scopeFor(actor, "/crm")} searchParams={await searchParams} />;
}
