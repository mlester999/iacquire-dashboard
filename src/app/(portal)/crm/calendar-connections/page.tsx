import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { CalendarConnectionsView } from "@/components/crm/views/calendar-connections-view";

export const metadata = { title: "Calendar Connections" };

export default async function CalendarConnectionsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await clientCrmActor("appointments.view");
  return <CalendarConnectionsView actor={actor} scope={await scopeFor(actor, "/crm")} searchParams={await searchParams} />;
}
