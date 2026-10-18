import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { AvailabilityView } from "@/components/crm/views/availability-view";

export const metadata = { title: "Availability" };

export default async function AvailabilityPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await clientCrmActor("appointments.view");
  return <AvailabilityView actor={actor} scope={await scopeFor(actor, "/crm")} searchParams={await searchParams} />;
}
