import { notFound } from "next/navigation";
import { requireAgency } from "@/server/tenancy/context";
import { getBlueprint, listApplications, listUpdateCandidates } from "@/server/crm/blueprints/library";
import { BlueprintDetailView } from "@/components/crm-blueprints/detail";
import { blueprintPermissions, isUuid, orNote, orNotFound } from "../load";

export const metadata = { title: "Blueprint" };

/** One Blueprint: overview, asset inspector, versions, applications and technical details. `?tab=` picks a tab; `?publish=1` opens publishing. */
export default async function BlueprintPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ publish?: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const user = await requireAgency();
  const { publish } = await searchParams;
  const blueprint = await orNotFound(() => getBlueprint(user, id));
  const [applications, candidates] = await Promise.all([
    orNote(() => listApplications(user, { blueprintId: id }), []),
    blueprint.currentVersion ? orNote(() => listUpdateCandidates(user, id), []) : Promise.resolve({ value: [], note: null }),
  ]);
  return (
    <BlueprintDetailView blueprint={blueprint} applications={applications.value} updateCandidates={candidates.value} permissions={blueprintPermissions(user)} openPublish={publish === "1"}
      timeZone={user.timezone} />
  );
}
