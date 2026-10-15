import { requireAgency } from "@/server/tenancy/context";
import { studioOverview } from "@/server/websites/admin";
import { OverviewView } from "@/components/website/admin/overview-view";

export const metadata = { title: "Website Studio" };

export default async function WebsiteStudioOverview() {
  const user = await requireAgency();
  const o = await studioOverview(user);
  return <OverviewView o={o} superAdmin={user.platformRole === "agency_super_admin"} />;
}
