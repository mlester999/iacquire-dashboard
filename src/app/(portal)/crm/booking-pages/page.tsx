import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { BookingPagesView } from "@/components/crm/views/booking-pages-view";

export const metadata = { title: "Booking pages" };

export default async function BookingPagesPage() {
  const actor = await clientCrmActor("appointments.view");
  return <BookingPagesView actor={actor} scope={await scopeFor(actor, "/crm")} />;
}
