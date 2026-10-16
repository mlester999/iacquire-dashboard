import { notFound } from "next/navigation";
import { agencyCrmPageActor } from "@/server/crm/agency-page";
import { scopeFor } from "@/server/crm/page";
import type { Permission } from "@/lib/permissions";
import { OverviewView } from "@/components/crm/views/overview-view";
import { ContactsView } from "@/components/crm/views/contacts-view";
import { ContactView } from "@/components/crm/views/contact-view";
import { CompaniesView } from "@/components/crm/views/companies-view";
import { CompanyView } from "@/components/crm/views/company-view";
import { PipelineView } from "@/components/crm/views/pipeline-view";
import { OpportunitiesView } from "@/components/crm/views/opportunities-view";
import { OpportunityView } from "@/components/crm/views/opportunity-view";
import { TasksView } from "@/components/crm/views/tasks-view";
import { FieldsView, SmartListsView, TagsView } from "@/components/crm/views/data-model-views";
import { DataView, PermissionsView, ProviderView } from "@/components/crm/views/settings-views";

type SP = Record<string, string | string[] | undefined>;

/**
 * The agency's view of one client's CRM. It renders the same screens as the client portal, with an agency actor whose permissions come
 * from the support session (never exports, deletion or permission changes). The layout shows the session gate when there is no session.
 */
export default async function AgencyClientCrmPage({ params, searchParams }: { params: Promise<{ id: string; path?: string[] }>; searchParams: Promise<SP> }) {
  const [{ id, path = [] }, sp] = await Promise.all([params, searchParams]);
  const actor = await agencyCrmPageActor(id);
  if (!actor) return null;
  const scope = await scopeFor(actor, `/admin/clients/${id}/crm`);
  const need = (p: Permission) => {
    if (!actor.can(p)) notFound();
  };
  const [a, b, c] = path;
  if (c) notFound();
  switch (a) {
    case undefined:
      return <OverviewView actor={actor} scope={scope} />;
    case "contacts":
      need("contacts.view");
      return b ? <ContactView actor={actor} scope={scope} id={b} /> : <ContactsView actor={actor} scope={scope} searchParams={sp} />;
    case "companies":
      need("companies.view");
      return b ? <CompanyView actor={actor} scope={scope} id={b} /> : <CompaniesView actor={actor} scope={scope} searchParams={sp} />;
    case "pipelines":
      need("sales.view");
      if (b) notFound();
      return <PipelineView actor={actor} scope={scope} searchParams={sp} />;
    case "opportunities":
      need("sales.view");
      return b ? <OpportunityView actor={actor} scope={scope} id={b} /> : <OpportunitiesView actor={actor} scope={scope} searchParams={sp} />;
    case "tasks":
      if (b) notFound();
      return <TasksView actor={actor} scope={scope} searchParams={sp} />;
    case "smart-lists":
      need("contacts.view");
      return <SmartListsView actor={actor} scope={scope} />;
    case "tags":
      return <TagsView actor={actor} scope={scope} />;
    case "fields":
      return <FieldsView actor={actor} scope={scope} entityParam={typeof sp.entity === "string" ? sp.entity : undefined} />;
    case "settings":
      if (b === "provider") return <ProviderView actor={actor} scope={scope} />;
      if (b === "permissions") {
        need("team.view");
        return <PermissionsView actor={actor} scope={scope} />;
      }
      if (b === "data") {
        need("contacts.import");
        return <DataView actor={actor} scope={scope} />;
      }
      notFound();
    default:
      notFound();
  }
}
