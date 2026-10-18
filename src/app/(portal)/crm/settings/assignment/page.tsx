import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { AssignmentView } from "@/components/crm/views/assignment-view";

export const metadata = { title: "Lead assignment" };

export default async function LeadAssignmentPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await clientCrmActor("contacts.assign");
  return <AssignmentView actor={actor} scope={await scopeFor(actor, "/crm")} searchParams={await searchParams} />;
}
