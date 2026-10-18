import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { AiToolsView } from "@/components/crm/views/ai-tools-view";

export const metadata = { title: "AI Employee Tools" };

export default async function Page() {
  const actor = await clientCrmActor("activity.view");
  return <AiToolsView actor={actor} scope={await scopeFor(actor, "/crm")} />;
}
