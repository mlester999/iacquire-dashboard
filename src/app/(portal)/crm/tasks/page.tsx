import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { TasksView } from "@/components/crm/views/tasks-view";

export const metadata = { title: "Tasks" };

export default async function TasksPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await clientCrmActor("crm.view");
  return <TasksView actor={actor} scope={await scopeFor(actor, "/crm")} searchParams={await searchParams} />;
}
