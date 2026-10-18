import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { DataView } from "@/components/crm/views/settings-views";

export const metadata = { title: "Imports & Exports" };

export default async function Page() {
  // Anyone who can open the CRM may preview the GoHighLevel migration here; DataView and the import and export services check their own permissions.
  const actor = await clientCrmActor("crm.view");
  return <DataView actor={actor} scope={await scopeFor(actor, "/crm")} />;
}
