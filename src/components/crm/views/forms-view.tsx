import { auditSupportView, type CrmActor } from "@/server/crm/actor";
import type { CrmScope } from "@/server/crm/page";
import { getFormBuilderOptions, listForms } from "@/server/crm/forms/definitions";
import { FormsList } from "@/components/crm/forms/forms-list";

/**
 * Native forms and surveys. Everyone with CRM access can see the forms (the row-level security rule); submission counts follow the
 * contacts rule; owners and managers build and publish ("Build forms"). An agency write session can prepare forms; a read session looks.
 */
export async function FormsView({ actor, scope }: { actor: CrmActor; scope: CrmScope }) {
  const [forms, options] = await Promise.all([listForms(actor, { status: "all" }), getFormBuilderOptions(actor)]);
  await auditSupportView(actor, "forms");
  return (
    <FormsList
      scope={scope}
      forms={JSON.parse(JSON.stringify(forms))}
      canManage={actor.can("forms.manage") && !scope.readOnly}
      contactsProblem={options.contactsProblem}
      orgSlug={options.orgSlug}
      canSeeSubmissions={actor.can("contacts.view")}
    />
  );
}
