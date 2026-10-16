import { clientCrmActor } from "@/server/crm/page";
import { AccessView } from "@/components/crm/views/settings-views";

export const metadata = { title: "Support Access" };

export default async function Page() {
  const actor = await clientCrmActor("activity.view");
  return <AccessView actor={actor} />;
}
