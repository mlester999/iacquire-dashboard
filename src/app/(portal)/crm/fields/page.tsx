import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { FieldsView } from "@/components/crm/views/data-model-views";

export const metadata = { title: "Custom Fields" };

export default async function FieldsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await clientCrmActor("crm.view");
  const sp = await searchParams;
  return <FieldsView actor={actor} scope={await scopeFor(actor, "/crm")} entityParam={typeof sp.entity === "string" ? sp.entity : undefined} />;
}
