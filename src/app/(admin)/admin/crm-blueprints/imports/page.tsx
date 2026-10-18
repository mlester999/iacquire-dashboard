import { requireAgency } from "@/server/tenancy/context";
import { listImports } from "@/server/crm/blueprints/library";
import { ImportsHistory } from "@/components/crm-blueprints/imports";
import { blueprintPermissions } from "../load";

export const metadata = { title: "Import history" };

export default async function BlueprintImportsPage() {
  const user = await requireAgency();
  const permissions = blueprintPermissions(user);
  const imports = await listImports(user);
  return <ImportsHistory imports={imports} canImport={permissions.importFile || permissions.importGhl} />;
}
