import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { ContactsView } from "@/components/crm/views/contacts-view";

export const metadata = { title: "Contacts" };

export default async function ContactsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await clientCrmActor("contacts.view");
  return <ContactsView actor={actor} scope={await scopeFor(actor, "/crm")} searchParams={await searchParams} />;
}
