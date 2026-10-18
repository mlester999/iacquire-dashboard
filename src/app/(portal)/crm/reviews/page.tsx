import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { ReviewsView } from "@/components/crm/views/reviews-view";

export const metadata = { title: "Reviews" };

export default async function ReviewsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await clientCrmActor("contacts.view");
  return <ReviewsView actor={actor} scope={await scopeFor(actor, "/crm")} searchParams={await searchParams} />;
}
