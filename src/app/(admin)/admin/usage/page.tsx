import { requireAgency } from "@/server/tenancy/context";
import { listUsageByTenant } from "@/server/admin/queries";
import { UsageWorkspace } from "@/components/admin/operations-workspaces";
import { FairUseAdmin } from "@/components/admin/fair-use-admin";
import { fleetFairUse, listPolicies } from "@/server/fairuse/service";
import { listReviews } from "@/server/inactivity/service";

export const metadata = { title: "Usage & costs" };

export default async function AdminUsagePage() {
  const user = await requireAgency();
  const [rows, fleet, policies, reviews] = await Promise.all([listUsageByTenant(user), fleetFairUse(user), listPolicies(user), listReviews(user)]);
  return (
    <div className="space-y-10">
      <UsageWorkspace rows={rows} />
      <FairUseAdmin
        fleet={fleet}
        policies={policies}
        reviews={JSON.parse(JSON.stringify(reviews))}
        clients={rows.map((r) => ({ id: r.org_id, name: r.org_name }))}
        canManage={user.platformRole === "agency_super_admin"}
      />
    </div>
  );
}
