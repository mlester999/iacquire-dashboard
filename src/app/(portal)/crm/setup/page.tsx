import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { CrmSetupView } from "@/components/setup/crm-setup-view";

export const metadata = { title: "Setup guide" };

export default async function CrmSetupGuidePage() {
  const actor = await clientCrmActor("crm.view");
  return <CrmSetupView actor={actor} scope={await scopeFor(actor, "/crm")} />;
}
