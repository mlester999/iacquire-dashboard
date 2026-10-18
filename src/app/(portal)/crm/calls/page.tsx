import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { CallsView } from "@/components/crm/views/calls-view";

export const metadata = { title: "Calls" };

export default async function CallsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await clientCrmActor("calls.view");
  return <CallsView actor={actor} scope={await scopeFor(actor, "/crm")} searchParams={await searchParams} />;
}
