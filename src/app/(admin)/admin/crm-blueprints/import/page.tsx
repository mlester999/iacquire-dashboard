import { requireAgency } from "@/server/tenancy/context";
import { listGhlSources } from "@/server/crm/blueprints/ghl";
import { ImportCenter } from "@/components/crm-blueprints/import-center";
import { blueprintPermissions, orNote } from "../load";

export const metadata = { title: "Import a Blueprint" };

/** Import into the library: GoHighLevel (official read-only API; super admins) or an iAcquire package file. */
export default async function BlueprintImportPage() {
  const user = await requireAgency();
  const permissions = blueprintPermissions(user);
  const sources = permissions.importGhl ? await orNote(() => listGhlSources(user), []) : { value: [], note: null };
  return <ImportCenter sources={sources.value} sourcesError={sources.note} canImportGhl={permissions.importGhl} canImportFile={permissions.importFile} />;
}
