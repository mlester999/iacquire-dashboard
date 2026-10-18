import { notFound } from "next/navigation";
import { requireAgency } from "@/server/tenancy/context";
import { getImport } from "@/server/crm/blueprints/library";
import { ImportDetailView } from "@/components/crm-blueprints/imports";
import { blueprintPermissions, isUuid, orNotFound } from "../../load";

export const metadata = { title: "Conversion preview" };

/** One import's conversion preview: totals, every item, limitations, validation, and saving the chosen assets as a draft Blueprint. */
export default async function BlueprintImportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const user = await requireAgency();
  const detail = await orNotFound(() => getImport(user, id));
  return <ImportDetailView detail={detail} canDesign={blueprintPermissions(user).design} timeZone={user.timezone} />;
}
