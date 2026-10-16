import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { PermissionsView } from "@/components/crm/views/settings-views";

export const metadata = { title: "Team & Permissions" };

export default async function Page() {
  const actor = await clientCrmActor("team.view");
  return <PermissionsView actor={actor} scope={await scopeFor(actor, "/crm")} />;
}
