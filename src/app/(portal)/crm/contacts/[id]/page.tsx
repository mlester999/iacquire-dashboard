import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { ContactView } from "@/components/crm/views/contact-view";

export default async function ContactPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await clientCrmActor("contacts.view");
  const { id } = await params;
  return <ContactView actor={actor} scope={await scopeFor(actor, "/crm")} id={id} />;
}
