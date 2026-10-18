import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { CrmAppointmentsView } from "@/components/crm/views/crm-appointments-view";

export const metadata = { title: "Appointments" };

export default async function CrmAppointmentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await clientCrmActor("appointments.view");
  return <CrmAppointmentsView actor={actor} scope={await scopeFor(actor, "/crm")} searchParams={await searchParams} />;
}
