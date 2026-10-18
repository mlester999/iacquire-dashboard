import { notFound } from "next/navigation";
import { requireAgency } from "@/server/tenancy/context";
import { getApplication } from "@/server/crm/blueprints/apply";
import { ApplicationDetailView } from "@/components/crm-blueprints/applications";
import { blueprintPermissions, isUuid, orNotFound } from "../../../load";

export const metadata = { title: "Blueprint application" };

/** One application of a Blueprint to one client: every item and its outcome, the setup still open, and rolling it back. */
export default async function BlueprintApplicationPage({ params }: { params: Promise<{ orgId: string; applicationId: string }> }) {
  const { orgId, applicationId } = await params;
  if (!isUuid(orgId) || !isUuid(applicationId)) notFound();
  const user = await requireAgency();
  const application = await orNotFound(() => getApplication(user, orgId, applicationId));
  const can = blueprintPermissions(user);
  // Staff who design can preview a newer version for this client (the dry run), not apply it.
  return <ApplicationDetailView application={application} canApply={can.apply} canPreview={can.design} timeZone={user.timezone} />;
}
