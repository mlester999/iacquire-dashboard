import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { CampaignView } from "@/components/crm/views/campaign-view";

export const metadata = { title: "Campaign" };

export default async function CampaignPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await clientCrmActor("campaigns.manage");
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  return <CampaignView actor={actor} scope={await scopeFor(actor, "/crm")} id={id} searchParams={sp} />;
}
