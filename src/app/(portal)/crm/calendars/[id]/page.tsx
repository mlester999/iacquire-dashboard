import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { CalendarDetailView } from "@/components/crm/views/calendars-settings-view";

export const metadata = { title: "Calendar" };

export default async function CalendarPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await clientCrmActor("appointments.view");
  const { id } = await params;
  return <CalendarDetailView actor={actor} scope={await scopeFor(actor, "/crm")} id={id} />;
}
