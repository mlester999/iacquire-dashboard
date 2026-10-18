import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { CalendarsSettingsView } from "@/components/crm/views/calendars-settings-view";

export const metadata = { title: "Calendars & types" };

export default async function CalendarsPage() {
  const actor = await clientCrmActor("appointments.view");
  return <CalendarsSettingsView actor={actor} scope={await scopeFor(actor, "/crm")} />;
}
