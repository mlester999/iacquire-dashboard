import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { PipelineView } from "@/components/crm/views/pipeline-view";

export const metadata = { title: "Pipelines" };

export default async function PipelinesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await clientCrmActor("sales.view");
  return <PipelineView actor={actor} scope={await scopeFor(actor, "/crm")} searchParams={await searchParams} />;
}
