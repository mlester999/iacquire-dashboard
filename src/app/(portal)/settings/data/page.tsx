import { requireOrgContext } from "@/server/tenancy/context";
import { getOffboardingForOwner } from "@/server/offboarding/service";
import { DataPanel } from "@/components/offboarding/data-panel";

export const metadata = { title: "Your data" };
export const dynamic = "force-dynamic";

export default async function YourDataPage() {
  const ctx = await requireOrgContext("offboarding.view");
  const view = await getOffboardingForOwner(ctx);
  return <DataPanel orgName={ctx.org.name} view={view ? JSON.parse(JSON.stringify(view)) : null} canRequest={ctx.can("offboarding.request")} canExport={ctx.can("data.export")} />;
}
