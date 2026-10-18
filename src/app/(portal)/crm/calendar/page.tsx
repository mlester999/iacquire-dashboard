import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { CalendarView } from "@/components/crm/views/calendar-view";

export const metadata = { title: "Calendar" };

export default async function CalendarPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await clientCrmActor("appointments.view");
  return <CalendarView actor={actor} scope={await scopeFor(actor, "/crm")} searchParams={await searchParams} />;
}
