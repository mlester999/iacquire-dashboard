import { requireAgency } from "@/server/tenancy/context";
import { domainsOverview } from "@/server/websites/admin";
import { env } from "@/server/env";
import { DomainsView } from "@/components/website/admin/domains-view";

export const metadata = { title: "Domains & Hosting" };

export default async function DomainsPage() {
  const user = await requireAgency();
  const o = await domainsOverview(user);
  const e = env();
  return <DomainsView o={o} timeZone={user.timezone} baseDomain={e.SITES_BASE_DOMAIN} cnameTarget={e.SITES_CNAME_TARGET || ""} />;
}
