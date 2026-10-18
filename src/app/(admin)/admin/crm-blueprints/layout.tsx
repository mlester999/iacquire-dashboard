import { notFound } from "next/navigation";
import { requireAgency } from "@/server/tenancy/context";
import { canDoBlueprint } from "@/server/crm/blueprints/access";
import { BlueprintNav } from "@/components/crm-blueprints/nav";

/** CRM Blueprints & Snapshots: the agency's library of reusable CRM configuration, its imports, and where it is applied. Agency only. */
export default async function CrmBlueprintsLayout({ children }: { children: React.ReactNode }) {
  const user = await requireAgency();
  if (!canDoBlueprint(user, "list")) notFound();
  return (
    <div className="space-y-5">
      <BlueprintNav />
      {children}
    </div>
  );
}
