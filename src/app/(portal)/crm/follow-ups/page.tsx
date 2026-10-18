import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { FollowUpsView } from "@/components/crm/views/followups-view";

export const metadata = { title: "Follow-up sequences" };

export default async function FollowUpSequencesPage() {
  const actor = await clientCrmActor("inbox.view");
  return <FollowUpsView actor={actor} scope={await scopeFor(actor, "/crm")} />;
}
