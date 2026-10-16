import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { DataView } from "@/components/crm/views/settings-views";

export const metadata = { title: "Imports & Exports" };

export default async function Page() {
  const actor = await clientCrmActor("contacts.import");
  return <DataView actor={actor} scope={await scopeFor(actor, "/crm")} />;
}
