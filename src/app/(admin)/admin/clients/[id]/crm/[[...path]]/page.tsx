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
import { CalendarView } from "@/components/crm/views/calendar-view";
import { CrmAppointmentsView } from "@/components/crm/views/crm-appointments-view";
import { CalendarDetailView, CalendarsSettingsView } from "@/components/crm/views/calendars-settings-view";
import { AvailabilityView } from "@/components/crm/views/availability-view";
import { BookingPagesView } from "@/components/crm/views/booking-pages-view";
import { CalendarConnectionsView } from "@/components/crm/views/calendar-connections-view";
import { TemplatesView } from "@/components/crm/views/templates-view";
import { CommunicationsView } from "@/components/crm/views/communications-view";
import { WorkflowActivityView, WorkflowsView } from "@/components/crm/views/workflows-view";
import { WorkflowRunView, WorkflowView } from "@/components/crm/views/workflow-view";
import { FollowUpsView } from "@/components/crm/views/followups-view";
import { ReviewsView } from "@/components/crm/views/reviews-view";
import { CallsView } from "@/components/crm/views/calls-view";
import { AssignmentView } from "@/components/crm/views/assignment-view";
import { CustomValuesView } from "@/components/crm/views/custom-values-view";
import { ReportsView } from "@/components/crm/views/reports-view";
import { CampaignsView } from "@/components/crm/views/campaigns-view";
import { CampaignView } from "@/components/crm/views/campaign-view";
import { FormsView } from "@/components/crm/views/forms-view";
import { FormView } from "@/components/crm/views/form-view";
import { BlueprintsView } from "@/components/crm/views/blueprints-view";
import { CrmSetupView } from "@/components/setup/crm-setup-view";

type SP = Record<string, string | string[] | undefined>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const [a, b, c, d, e] = path;
  // Two segments everywhere, except a workflow run: workflows/<id>/runs/<runId>.
  if (a === "workflows" ? e || (c && (c !== "runs" || !d)) : c) notFound();
  switch (a) {
    case undefined:
      return <OverviewView actor={actor} scope={scope} />;
    case "setup":
      need("crm.view");
      if (b) notFound();
      return <CrmSetupView actor={actor} scope={scope} />;
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
    case "calendar":
      need("appointments.view");
      if (b) notFound();
      return <CalendarView actor={actor} scope={scope} searchParams={sp} />;
    case "appointments":
      need("appointments.view");
      if (b) notFound();
      return <CrmAppointmentsView actor={actor} scope={scope} searchParams={sp} />;
    case "calendars":
      need("appointments.view");
      if (b && !UUID.test(b)) notFound();
      return b ? <CalendarDetailView actor={actor} scope={scope} searchParams={sp} id={b} /> : <CalendarsSettingsView actor={actor} scope={scope} searchParams={sp} />;
    case "availability":
      need("appointments.view");
      if (b) notFound();
      return <AvailabilityView actor={actor} scope={scope} searchParams={sp} />;
    case "booking-pages":
      need("appointments.view");
      if (b) notFound();
      return <BookingPagesView actor={actor} scope={scope} searchParams={sp} />;
    case "calendar-connections":
      need("appointments.view");
      if (b) notFound();
      return <CalendarConnectionsView actor={actor} scope={scope} searchParams={sp} />;
    case "templates":
      need("inbox.view");
      if (b) notFound();
      return <TemplatesView actor={actor} scope={scope} searchParams={sp} />;
    case "workflows":
      need("workflows.view");
      if (!b) return <WorkflowsView actor={actor} scope={scope} searchParams={sp} />;
      if (b === "activity") {
        if (c) notFound();
        return <WorkflowActivityView actor={actor} scope={scope} searchParams={sp} />;
      }
      if (!UUID.test(b) || (d && !UUID.test(d))) notFound();
      return d ? <WorkflowRunView actor={actor} scope={scope} workflowId={b} runId={d} /> : <WorkflowView actor={actor} scope={scope} id={b} searchParams={sp} />;
    case "follow-ups":
      need("inbox.view");
      if (b) notFound();
      return <FollowUpsView actor={actor} scope={scope} />;
    case "forms":
      need("crm.view");
      if (b && !UUID.test(b)) notFound();
      return b ? <FormView actor={actor} scope={scope} id={b} searchParams={sp} /> : <FormsView actor={actor} scope={scope} />;
    case "reviews":
      need("contacts.view");
      if (b) notFound();
      return <ReviewsView actor={actor} scope={scope} searchParams={sp} />;
    case "calls":
      need("calls.view");
      if (b) notFound();
      return <CallsView actor={actor} scope={scope} searchParams={sp} />;
    case "campaigns":
      // Campaigns stay with the client: support sessions don't include them, so this is only reachable if that ever changes.
      need("campaigns.manage");
      if (b && !UUID.test(b)) notFound();
      return b ? <CampaignView actor={actor} scope={scope} id={b} searchParams={sp} /> : <CampaignsView actor={actor} scope={scope} searchParams={sp} />;
    case "reports":
      need("analytics.view");
      if (b) notFound();
      return <ReportsView actor={actor} scope={scope} searchParams={sp} />;
    case "settings":
      if (b === "provider") return <ProviderView actor={actor} scope={scope} />;
      if (b === "assignment") {
        need("crm.view");
        return <AssignmentView actor={actor} scope={scope} searchParams={sp} />;
      }
      if (b === "communications") {
        need("inbox.view");
        return <CommunicationsView actor={actor} scope={scope} />;
      }
      if (b === "permissions") {
        need("team.view");
        return <PermissionsView actor={actor} scope={scope} />;
      }
      if (b === "data") {
        // Anyone who can open the CRM may preview the GoHighLevel migration; the history, CSV imports and exports check their own permissions.
        need("crm.view");
        return <DataView actor={actor} scope={scope} />;
      }
      if (b === "values") {
        need("crm.view");
        return <CustomValuesView actor={actor} scope={scope} />;
      }
      if (b === "blueprints") {
        need("crm.view");
        return <BlueprintsView actor={actor} scope={scope} />;
      }
      notFound();
    default:
      notFound();
  }
}
