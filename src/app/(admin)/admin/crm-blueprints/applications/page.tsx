import { requireAgency } from "@/server/tenancy/context";
import { listApplications } from "@/server/crm/blueprints/library";
import { ApplicationsHistory } from "@/components/crm-blueprints/applications";
import { blueprintPermissions } from "../load";

export const metadata = { title: "Blueprint applications" };

/** Every application of a Blueprint to a client this person can reach. */
export default async function BlueprintApplicationsPage() {
  const user = await requireAgency();
  const applications = await listApplications(user);
  const can = blueprintPermissions(user);
  return <ApplicationsHistory applications={applications} canApply={can.apply} canPreview={can.design} />;
}
