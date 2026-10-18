import { clientCrmActor, scopeFor } from "@/server/crm/page";
import { FormView } from "@/components/crm/views/form-view";

export const metadata = { title: "Form" };

export default async function FormPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await clientCrmActor("crm.view");
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  return <FormView actor={actor} scope={await scopeFor(actor, "/crm")} id={id} searchParams={sp} />;
}
