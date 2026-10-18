import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { TemplatesView } from "@/components/crm/views/templates-view";

export const metadata = { title: "Message templates" };

export default async function TemplatesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await clientCrmActor("inbox.view");
  return <TemplatesView actor={actor} scope={await scopeFor(actor, "/crm")} searchParams={await searchParams} />;
}
